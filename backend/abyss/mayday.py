"""MAYDAY incident workflow: the Abyss market applied to an outage.

diagnose -> remediate (sandboxed, retried) -> human approval -> verify.
Each step is an ordinary market task: the three agents bid, the auction picks a
winner, reputation learns from the grade. Diagnosis is graded by the blind
reviewer; remediation and verification are graded by deterministic checks.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from . import config, prompts
from .agents import build_work_prompt, est_input_tokens
from .events import EventStream, new_job_id
from .incident import (
    SERVICE,
    ActionRejected,
    PaymentsSimulator,
    checks_grade,
    describe_action,
    parse_action,
)
from .ledger import Ledger
from .llm import LLM, LLMError
from .market import (
    JobResult,
    _final_data,
    _final_task,
    _review_with_retry,
    _run_auction,
    _task_error,
    _work_with_retry,
)
from .orchestrator import TaskSpec
from .reputation import ReputationStore
from .responders import select_responders

CHECK_USAGE = {
    "model": "deterministic-checks",
    "input_tokens": 0,
    "output_tokens": 0,
    "cost_usd": 0.0,
    "duration_ms": 0,
}


@dataclass
class IncidentSession:
    """Per-connection incident state shared between the workflow and the server."""

    sim: PaymentsSimulator = field(default_factory=PaymentsSimulator)
    approval: asyncio.Event = field(default_factory=asyncio.Event)
    awaiting_approval: bool = False
    approver: str | None = None


# grade_fn(task, winner_id, output) -> (grade, rationale, usage)
Grader = Callable[[TaskSpec, str, str], Awaitable[tuple[int, str, dict]]]


@dataclass
class _Run:
    stream: EventStream
    llm: LLM
    rep: ReputationStore
    ledger: Ledger
    job_text: str
    price_weight: float
    tasks_won: dict[str, int]
    outputs: dict[str, str] = field(default_factory=dict)
    completed: list[tuple[TaskSpec, str]] = field(default_factory=list)
    final_tasks: list[dict] = field(default_factory=list)
    grades: list[dict] = field(default_factory=list)
    rep_changes: list[dict] = field(default_factory=list)


@dataclass
class _TaskOutcome:
    agent_id: str
    promised_quality: int
    output: str
    grade: int


async def status(stream: EventStream, sim: PaymentsSimulator, state: str, severity: str | None, headline: str, *, job_id=...) -> None:
    await stream.emit(
        "incident_status",
        {
            "status": state,
            "service": SERVICE,
            "severity": severity,
            "headline": headline,
            "telemetry": sim.telemetry(),
            "logs": sim.logs(),
            "config_changes": sim.config_changes(),
        },
        job_id=job_id,
    )


async def emit_healthy(stream: EventStream, sim: PaymentsSimulator) -> None:
    await status(stream, sim, "healthy", None, "Payments API operating normally", job_id=None)


def incident_context(sim: PaymentsSimulator) -> str:
    t = sim.telemetry()
    logs = "\n".join(f"[{l['level']}] {l['source']}: {l['message']}" for l in sim.logs())
    changes = "\n".join(
        f"- {c['key']}: {c['old']} -> {c['new']} by {c['author']} ({c['minutes_ago']} min ago)"
        for c in sim.config_changes()
    ) or "(none)"
    return (
        f"Production incident on {SERVICE}.\n"
        f"Metrics: p95 {t['p95_latency_ms']}ms, error rate {t['error_rate'] * 100:.1f}%, "
        f"payment success {t['payment_success_rate'] * 100:.1f}%, "
        f"DB pool {t['db_pool_in_use']}/{t['db_pool_size']} in use with {t['db_waiting']} waiting, "
        f"{t['timeouts_per_min']} connection timeouts/min.\n"
        f"Recent config changes:\n{changes}\n"
        f"Logs:\n{logs}"
    )


async def run_incident(
    *,
    stream: EventStream,
    llm: LLM,
    rep: ReputationStore,
    session: IncidentSession,
    price_weight: float = config.PRICE_WEIGHT,
) -> JobResult:
    sim = session.sim
    job_id = new_job_id()
    stream.start_job(job_id)
    started = time.monotonic()
    session.approval.clear()
    session.awaiting_approval = False
    ledger = Ledger(job_id, config.ledger_path())

    sim.break_production()
    team = select_responders(sim.telemetry(), sim.config_changes())
    severity = team["severity"]
    t = sim.telemetry()
    await status(
        stream, sim, "outage", severity,
        f"{severity}: Payments API failing {t['error_rate'] * 100:.0f}% of requests",
    )
    await stream.emit("responders_selected", team)
    await status(stream, sim, "investigating", severity, "AI market diagnosing the outage")

    run = _Run(
        stream=stream,
        llm=llm,
        rep=rep,
        ledger=ledger,
        job_text=incident_context(sim),
        price_weight=price_weight,
        tasks_won={agent.agent_id: 0 for agent in config.AGENTS},
    )

    async def fail(reason: str) -> JobResult:
        await status(stream, sim, "failed", severity, reason)
        final = _final_data(
            status="partial", tasks=run.final_tasks, completed=run.completed,
            grades=[g["grade"] for g in run.grades], ledger=ledger, started=started,
        )
        await stream.emit("final", final)
        return JobResult(job_id, "partial", final["deliverable"], ledger, final)

    diagnose = TaskSpec(
        "t1", "diagnose", "Diagnose the Payments API outage",
        "Find the root cause of the failing payments from the metrics, logs and config changes.",
        [],
    )
    diagnosis = await _run_task(run, diagnose, 0, 3, _reviewer(run))
    if diagnosis is None:
        return await fail("Diagnosis failed; escalating to humans")
    await status(stream, sim, "repairing", severity, "Remediation bids open; repairs run in a sandbox first")

    failed: list[str] = []
    winning: tuple[TaskSpec, _TaskOutcome, dict] | None = None
    for attempt in range(1, config.MAX_REPAIR_ATTEMPTS + 1):
        index = attempt
        brief = "Propose one allowlisted remediation for the diagnosed root cause. " + (
            prompts.NO_FAILED_ATTEMPTS
            if not failed
            else "Previous failed attempts: " + "; ".join(failed)
        )
        task = TaskSpec(f"t{index + 1}", "remediate", f"Repair attempt {attempt}", brief, ["t1"])
        sandbox_state: dict = {}
        outcome = await _run_task(run, task, index, index + 2, _sandbox_grader(run, sim, attempt, sandbox_state))
        if outcome is None:
            return await fail("Remediation market failed; escalating to humans")
        if sandbox_state.get("passed"):
            winning = (task, outcome, sandbox_state["action"])
            break
        failed.append(sandbox_state["summary"])
    if winning is None:
        return await fail("No repair passed the sandbox; escalating to humans")

    task, outcome, action = winning
    approvers = [r["name"] for r in team["responders"] if r["selected"] and r["role"] == "Incident Commander"]
    await status(stream, sim, "awaiting_approval", severity, f"{describe_action(action)} passed the sandbox; awaiting human approval")
    await stream.emit(
        "approval_required",
        {
            "task_id": task.task_id,
            "agent_id": outcome.agent_id,
            "attempt": len(failed) + 1,
            "action": action,
            "summary": (
                f"{describe_action(action)} passed all sandbox checks after "
                f"{len(failed)} rejected attempt{'s' if len(failed) != 1 else ''}. Deploy to production?"
            ),
            "approvers": approvers,
        },
    )
    session.awaiting_approval = True
    try:
        await session.approval.wait()
    finally:
        session.awaiting_approval = False
    approved_by = session.approver or (approvers[0] if approvers else "human")

    sim.apply(action)
    await status(stream, sim, "recovering", severity, f"{approved_by} approved {describe_action(action)}; verifying production")

    verify_index = len(failed) + 2
    verify = TaskSpec(
        f"t{verify_index + 1}", "verify", "Verify production recovery",
        "Confirm the Payments API is healthy after the approved repair.",
        [task.task_id],
    )
    checks = sim.health_checks()
    verified = await _run_task(run, verify, verify_index, verify_index + 1, _checks_grader(checks, "Production"))
    if verified is None or not all(check["passed"] for check in checks):
        return await fail("Production verification failed after the repair")

    final_grades = [g["grade"] for g in run.grades]
    await stream.emit(
        "service_restored",
        {
            "mttr_ms": round((time.monotonic() - started) * 1000),
            "total_cost_usd": ledger.total_cost(),
            "repair_attempts": len(failed) + 1,
            "failed_attempts": len(failed),
            "confidence": round(outcome.promised_quality / 10, 2),
            "mean_grade": round(sum(final_grades) / len(final_grades), 2),
            "approved_by": approved_by,
            "action": action,
            "grades": run.grades,
            "rep_changes": run.rep_changes,
            "verification": checks,
            "telemetry": sim.telemetry(),
        },
    )
    await status(stream, sim, "restored", None, "Payments API restored")
    final = _final_data(
        status="ok", tasks=run.final_tasks, completed=run.completed,
        grades=final_grades, ledger=ledger, started=started,
    )
    await stream.emit("final", final)
    return JobResult(job_id, "ok", final["deliverable"], ledger, final)


async def _run_task(run: _Run, task: TaskSpec, index: int, total: int, grade: Grader) -> _TaskOutcome | None:
    """One market round for an incident task, mirroring market.run_job's loop body."""
    stream, ledger = run.stream, run.ledger
    deps = {tid: run.outputs[tid] for tid in task.depends_on if tid in run.outputs}
    system, user = build_work_prompt(run.job_text, task, deps)
    estimated = est_input_tokens(system, user)
    await stream.emit(
        "task_posted",
        {
            "task_id": task.task_id, "type": task.type, "title": task.title,
            "brief": task.brief, "depends_on": task.depends_on,
            "index": index, "total": total, "est_input_tokens": estimated,
        },
    )
    auction = await _run_auction(
        stream, run.llm, ledger, run.rep, run.job_text, task, deps,
        estimated, run.price_weight, run.tasks_won,
    )
    if auction is None:
        run.final_tasks.append(_final_task(task, None, None, None, ledger))
        return None
    winner, promised, predicted_tokens, predicted_price = auction

    await stream.emit("working", {"task_id": task.task_id, "agent_id": winner.agent_id})
    try:
        output, usage = await _work_with_retry(run.llm, ledger, winner, run.job_text, task, deps)
    except LLMError as exc:
        await _task_error(stream, ledger, run.tasks_won, task.task_id, str(exc))
        run.final_tasks.append(_final_task(task, winner.agent_id, None, promised, ledger))
        return None
    run.outputs[task.task_id] = output
    run.completed.append((task, output))
    await stream.emit(
        "done",
        {
            "task_id": task.task_id, "agent_id": winner.agent_id, "output": output,
            "predicted_output_tokens": predicted_tokens,
            "predicted_cost_usd": predicted_price, "usage": usage,
        },
    )

    try:
        score, rationale, review_usage = await grade(task, winner.agent_id, output)
    except LLMError as exc:
        await _task_error(stream, ledger, run.tasks_won, task.task_id, str(exc))
        run.final_tasks.append(_final_task(task, winner.agent_id, None, promised, ledger))
        return None
    await stream.emit(
        "graded",
        {
            "task_id": task.task_id, "agent_id": winner.agent_id, "grade": score,
            "promised_quality": promised, "rationale": rationale[:200], "usage": review_usage,
        },
    )
    old, new, ratio = run.rep.update(winner.agent_id, task.type, score, promised)
    await stream.emit(
        "rep_update",
        {
            "task_id": task.task_id, "agent_id": winner.agent_id, "task_type": task.type,
            "old": old, "new": new, "ratio": ratio,
        },
    )
    await stream.emit("stats", ledger.stats(run.tasks_won))
    run.final_tasks.append(_final_task(task, winner.agent_id, score, promised, ledger))
    run.grades.append(
        {"task_id": task.task_id, "type": task.type, "agent_id": winner.agent_id,
         "grade": score, "promised_quality": promised}
    )
    run.rep_changes.append(
        {"task_id": task.task_id, "agent_id": winner.agent_id, "task_type": task.type,
         "old": old, "new": new}
    )
    return _TaskOutcome(winner.agent_id, promised, output, score)


def _reviewer(run: _Run) -> Grader:
    async def grade(task: TaskSpec, agent_id: str, output: str) -> tuple[int, str, dict]:
        deps = {tid: run.outputs[tid] for tid in task.depends_on if tid in run.outputs}
        return await _review_with_retry(run.llm, run.ledger, run.job_text, task, deps, output)

    return grade


def _checks_grader(checks: list[dict], label: str) -> Grader:
    async def grade(task: TaskSpec, agent_id: str, output: str) -> tuple[int, str, dict]:
        passed = sum(check["passed"] for check in checks)
        return checks_grade(checks), f"{label}: {passed}/{len(checks)} health checks passed", CHECK_USAGE

    return grade


def _sandbox_grader(run: _Run, sim: PaymentsSimulator, attempt: int, result: dict) -> Grader:
    async def grade(task: TaskSpec, agent_id: str, output: str) -> tuple[int, str, dict]:
        try:
            action = parse_action(output)
            rejection = None
        except ActionRejected as exc:
            action, rejection = None, str(exc)
        await run.stream.emit(
            "remediation_proposed",
            {
                "task_id": task.task_id, "agent_id": agent_id, "attempt": attempt,
                "raw": output[:300], "valid": action is not None,
                "action": action, "rejection": rejection,
            },
        )
        if action is None:
            passed = False
            checks = [{"name": "allowlist", "passed": False, "detail": rejection}]
            telemetry = sim.telemetry()
            summary = f"rejected proposal ({rejection})"
        else:
            passed, checks, telemetry = sim.sandbox(action)
            failing = [check["name"] for check in checks if not check["passed"]]
            summary = describe_action(action) + (
                f" (sandbox failed: {', '.join(failing)})" if failing else ""
            )
        await run.stream.emit(
            "sandbox_result",
            {
                "task_id": task.task_id, "agent_id": agent_id, "attempt": attempt,
                "action": action, "passed": passed, "checks": checks, "telemetry": telemetry,
            },
        )
        result.update(passed=passed, action=action, summary=summary)
        ok = sum(check["passed"] for check in checks)
        return checks_grade(checks), f"Sandbox: {ok}/{len(checks)} checks passed", CHECK_USAGE

    return grade
