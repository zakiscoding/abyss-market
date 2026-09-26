from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass

from . import config
from .agents import build_work_prompt, do_work, est_input_tokens, request_bid
from .events import EventStream, new_job_id
from .ledger import Ledger
from .llm import LLM, LLMError
from .orchestrator import TaskSpec, split_job
from .reputation import ReputationStore
from .reviewer import review
from .scoring import (
    ScoredBid,
    clamp_bid,
    clamp_confidence,
    eta_ms,
    pick_winner,
    predicted_cost,
    score_bid,
)


@dataclass
class JobResult:
    job_id: str
    status: str
    deliverable: str | None
    ledger: Ledger
    final: dict


async def run_job(
    job_text: str,
    *,
    stream: EventStream,
    llm: LLM,
    rep: ReputationStore,
    price_weight: float = config.PRICE_WEIGHT,
    fixed_agent_id: str | None = None,
    tasks: list[TaskSpec] | None = None,
) -> JobResult:
    job_id = new_job_id()
    stream.start_job(job_id)
    started = time.monotonic()
    ledger = Ledger(job_id, config.ledger_path())
    tasks_won = {agent.agent_id: 0 for agent in config.AGENTS}

    try:
        task_specs, split_usage = await _get_tasks(llm, ledger, job_text, tasks)
    except LLMError as exc:
        await stream.emit(
            "error", {"message": str(exc), "task_id": None, "fatal": True}
        )
        final = _final_data(
            status="error",
            tasks=[],
            completed=[],
            grades=[],
            ledger=ledger,
            started=started,
        )
        await stream.emit("final", final)
        return JobResult(job_id, "error", None, ledger, final)

    await stream.emit(
        "job_split",
        {
            "job_text": job_text,
            "tasks": [asdict(task) for task in task_specs],
            "price_weight": price_weight,
            "usage": split_usage,
        },
    )
    await stream.emit("stats", ledger.stats(tasks_won))

    agents = {agent.agent_id: agent for agent in config.AGENTS}
    if fixed_agent_id is not None and fixed_agent_id not in agents:
        raise ValueError(f"unknown fixed agent {fixed_agent_id!r}")

    outputs: dict[str, str] = {}
    completed: list[tuple[TaskSpec, str]] = []
    grades: list[int] = []
    final_tasks: list[dict] = []
    task_failed = False

    for index, task in enumerate(task_specs):
        dep_outputs = {
            task_id: outputs[task_id]
            for task_id in task.depends_on
            if task_id in outputs
        }
        system, user = build_work_prompt(job_text, task, dep_outputs)
        estimated_input = est_input_tokens(system, user)
        await stream.emit(
            "task_posted",
            {
                "task_id": task.task_id,
                "type": task.type,
                "title": task.title,
                "brief": task.brief,
                "depends_on": task.depends_on,
                "index": index,
                "total": len(task_specs),
                "est_input_tokens": estimated_input,
            },
        )

        if fixed_agent_id is None:
            auction = await _run_auction(
                stream,
                llm,
                ledger,
                rep,
                job_text,
                task,
                dep_outputs,
                estimated_input,
                price_weight,
                tasks_won,
            )
            if auction is None:
                task_failed = True
                final_tasks.append(_final_task(task, None, None, None, ledger))
                continue
            winner, promised_quality, predicted_tokens, predicted_price, _ = auction
        else:
            winner = agents[fixed_agent_id]
            promised_quality = None
            predicted_tokens = None
            predicted_price = None
            tasks_won[winner.agent_id] += 1
            await stream.emit(
                "won",
                {
                    "task_id": task.task_id,
                    "agent_id": winner.agent_id,
                    "mode": "fixed",
                    "score": None,
                    "runner_up_agent_id": None,
                    "runner_up_score": None,
                    "scores": {},
                    "price_weight": price_weight,
                },
            )
            await stream.emit("stats", ledger.stats(tasks_won))

        await stream.emit(
            "working", {"task_id": task.task_id, "agent_id": winner.agent_id}
        )
        try:
            output, work_usage = await _work_with_retry(
                llm, ledger, winner, job_text, task, dep_outputs
            )
        except LLMError as exc:
            task_failed = True
            await _task_error(stream, ledger, tasks_won, task.task_id, str(exc))
            final_tasks.append(
                _final_task(
                    task, winner.agent_id, None, promised_quality, ledger
                )
            )
            continue

        outputs[task.task_id] = output
        completed.append((task, output))
        await stream.emit(
            "done",
            {
                "task_id": task.task_id,
                "agent_id": winner.agent_id,
                "output": output,
                "predicted_output_tokens": predicted_tokens,
                "predicted_cost_usd": predicted_price,
                "usage": work_usage,
            },
        )

        try:
            grade, rationale, review_usage = await _review_with_retry(
                llm, ledger, job_text, task, dep_outputs, output
            )
        except LLMError as exc:
            task_failed = True
            await _task_error(stream, ledger, tasks_won, task.task_id, str(exc))
            final_tasks.append(
                _final_task(
                    task, winner.agent_id, None, promised_quality, ledger
                )
            )
            continue

        grades.append(grade)
        await stream.emit(
            "graded",
            {
                "task_id": task.task_id,
                "agent_id": winner.agent_id,
                "grade": grade,
                "promised_quality": promised_quality,
                "rationale": rationale,
                "usage": review_usage,
            },
        )

        if promised_quality is not None:
            old, new, ratio = rep.update(
                winner.agent_id, task.type, grade, promised_quality
            )
            await stream.emit(
                "rep_update",
                {
                    "task_id": task.task_id,
                    "agent_id": winner.agent_id,
                    "task_type": task.type,
                    "old": old,
                    "new": new,
                    "ratio": ratio,
                },
            )
        await stream.emit("stats", ledger.stats(tasks_won))
        final_tasks.append(
            _final_task(task, winner.agent_id, grade, promised_quality, ledger)
        )

    status = "partial" if task_failed else "ok"
    final = _final_data(
        status=status,
        tasks=final_tasks,
        completed=completed,
        grades=grades,
        ledger=ledger,
        started=started,
    )
    await stream.emit("final", final)
    return JobResult(job_id, status, final["deliverable"], ledger, final)


async def _get_tasks(
    llm: LLM,
    ledger: Ledger,
    job_text: str,
    tasks: list[TaskSpec] | None,
) -> tuple[list[TaskSpec], dict]:
    if tasks is not None:
        return tasks, {
            "model": config.ORCHESTRATOR_MODEL,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_usd": 0.0,
            "duration_ms": 0,
        }
    return await split_job(llm, ledger, job_text)


async def _run_auction(
    stream: EventStream,
    llm: LLM,
    ledger: Ledger,
    rep: ReputationStore,
    job_text: str,
    task: TaskSpec,
    dep_outputs: dict[str, str],
    estimated_input: int,
    price_weight: float,
    tasks_won: dict[str, int],
) -> tuple[config.AgentSpec, int, int, float, float] | None:
    dep_sizes = {task_id: len(output) for task_id, output in dep_outputs.items()}
    confidences: dict[str, float] = {}
    calls = [
        request_bid(
            llm,
            ledger,
            agent,
            job_text,
            task,
            dep_sizes,
            rep.get(agent.agent_id, task.type),
        )
        for agent in config.AGENTS
    ]
    results = await asyncio.gather(*calls, return_exceptions=True)
    scored: list[ScoredBid] = []
    agents = {agent.agent_id: agent for agent in config.AGENTS}

    for agent, result in zip(config.AGENTS, results):
        if isinstance(result, BaseException):
            await stream.emit(
                "bid",
                {
                    "task_id": task.task_id,
                    "agent_id": agent.agent_id,
                    "ok": False,
                    "error": str(result),
                    "predicted_output_tokens": None,
                    "est_input_tokens": None,
                    "predicted_cost_usd": None,
                    "promised_quality": None,
                    "confidence": None,
                    "eta_ms": None,
                    "pitch": None,
                    "reputation": None,
                    "score": None,
                    "usage": None,
                },
            )
            continue

        raw, usage = result
        tokens, quality, pitch = clamp_bid(raw)
        price = predicted_cost(agent.model, estimated_input, tokens)
        reputation = rep.get(agent.agent_id, task.type)
        score = score_bid(quality, reputation, price, price_weight)
        confidences[agent.agent_id] = clamp_confidence(raw)
        bid = ScoredBid(
            agent_id=agent.agent_id,
            promised_quality=quality,
            predicted_output_tokens=tokens,
            est_input_tokens=estimated_input,
            predicted_cost_usd=price,
            reputation=reputation,
            score=score,
        )
        scored.append(bid)
        await stream.emit(
            "bid",
            {
                "task_id": task.task_id,
                "agent_id": agent.agent_id,
                "ok": True,
                "error": None,
                "predicted_output_tokens": tokens,
                "est_input_tokens": estimated_input,
                "predicted_cost_usd": price,
                "promised_quality": quality,
                "confidence": confidences[agent.agent_id],
                "eta_ms": eta_ms(agent.model, tokens),
                "pitch": pitch,
                "reputation": reputation,
                "score": score,
                "usage": usage,
            },
        )

    if not scored:
        await _task_error(
            stream, ledger, tasks_won, task.task_id, "all bids failed"
        )
        return None

    winner_bid, runner_up = pick_winner(scored)
    tasks_won[winner_bid.agent_id] += 1
    await stream.emit(
        "won",
        {
            "task_id": task.task_id,
            "agent_id": winner_bid.agent_id,
            "mode": "auction",
            "score": winner_bid.score,
            "runner_up_agent_id": runner_up.agent_id if runner_up else None,
            "runner_up_score": runner_up.score if runner_up else None,
            "scores": {bid.agent_id: bid.score for bid in scored},
            "price_weight": price_weight,
        },
    )
    await stream.emit("stats", ledger.stats(tasks_won))
    return (
        agents[winner_bid.agent_id],
        winner_bid.promised_quality,
        winner_bid.predicted_output_tokens,
        winner_bid.predicted_cost_usd,
        confidences[winner_bid.agent_id],
    )


async def _work_with_retry(
    llm: LLM,
    ledger: Ledger,
    agent: config.AgentSpec,
    job_text: str,
    task: TaskSpec,
    dep_outputs: dict[str, str],
) -> tuple[str, dict]:
    for attempt in range(2):
        try:
            return await do_work(llm, ledger, agent, job_text, task, dep_outputs)
        except LLMError:
            if attempt == 1:
                raise
    raise AssertionError("unreachable")


async def _review_with_retry(
    llm: LLM,
    ledger: Ledger,
    job_text: str,
    task: TaskSpec,
    dep_outputs: dict[str, str],
    output: str,
) -> tuple[int, str, dict]:
    for attempt in range(2):
        try:
            return await review(llm, ledger, job_text, task, dep_outputs, output)
        except LLMError:
            if attempt == 1:
                raise
    raise AssertionError("unreachable")


async def _task_error(
    stream: EventStream,
    ledger: Ledger,
    tasks_won: dict[str, int],
    task_id: str,
    message: str,
) -> None:
    await stream.emit(
        "error", {"message": message, "task_id": task_id, "fatal": False}
    )
    await stream.emit("stats", ledger.stats(tasks_won))


def _final_task(
    task: TaskSpec,
    agent_id: str | None,
    grade: int | None,
    promised_quality: int | None,
    ledger: Ledger,
) -> dict:
    return {
        "task_id": task.task_id,
        "type": task.type,
        "agent_id": agent_id,
        "grade": grade,
        "promised_quality": promised_quality,
        "cost_usd": ledger.task_cost(task.task_id),
    }


def _final_data(
    *,
    status: str,
    tasks: list[dict],
    completed: list[tuple[TaskSpec, str]],
    grades: list[int],
    ledger: Ledger,
    started: float,
) -> dict:
    deliverable_task: tuple[TaskSpec, str] | None = None
    writing = [item for item in completed if item[0].type == "writing"]
    if writing:
        deliverable_task = writing[-1]
    elif completed:
        deliverable_task = completed[-1]
    return {
        "status": status,
        "deliverable_task_id": (
            deliverable_task[0].task_id if deliverable_task else None
        ),
        "deliverable": deliverable_task[1] if deliverable_task else None,
        "tasks": tasks,
        "total_cost_usd": ledger.total_cost(),
        "mean_grade": round(sum(grades) / len(grades), 2) if grades else None,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }
