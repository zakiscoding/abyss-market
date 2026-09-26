"""MAYDAY: run a Payments API incident through the Abyss market.

Diagnose, remediate, and verify are ordinary market tasks: the same auction,
work call, reputation update, ledger, and events as a job. Remediation output is
only ever parsed into an allowlisted action, tested on a sandbox copy of the
service, and applied to production after a human approves it.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from . import config, prompts
from .agents import build_work_prompt, est_input_tokens
from .events import EventStream, new_job_id
from .incident import SERVICE, ActionRejected, PaymentsSimulator, describe_action, parse_action
from .ledger import Ledger
from .llm import LLM, LLMError
from .market import (
    _final_task,
    _review_with_retry,
    _run_auction,
    _task_error,
    _work_with_retry,
)
from .orchestrator import TaskSpec
from .reputation import ReputationStore
from .responders import briefings, select_responders

SEVERITY = "SEV-1"
Grader = Callable[[str, str], Awaitable[tuple[int, str, dict]]]


@dataclass
class IncidentControl:
    approval: asyncio.Event = field(default_factory=asyncio.Event)
    awaiting_approval: bool = False


@dataclass
class TaskOutcome:
    agent_id: str
    output: str
    grade: int
    confidence: float


def healthy_status(sim: PaymentsSimulator) -> dict:
    return _status_data(sim, "healthy", "All systems operational.")


def _status_data(sim: PaymentsSimulator, status: str, summary: str) -> dict:
    return {
        "status": status,
        "service": SERVICE,
        "severity": None if status in {"healthy", "restored"} else SEVERITY,
        "summary": summary,
        "telemetry": sim.telemetry(),
        "logs": sim.logs(),
        "config_changes": [dict(change) for change in sim.changes],
    }


def _check_usage(duration_ms: int = 0) -> dict:
    return {
        "model": "deterministic-checks",
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "duration_ms": duration_ms,
    }


def _grade_from_checks(checks: list[dict]) -> tuple[int, str]:
    passed = sum(check["passed"] for check in checks)
    failed = [check["name"] for check in checks if not check["passed"]]
    grade = max(1, round(10 * passed / len(checks)))
    rationale = f"{passed}/{len(checks)} checks passed."
    if failed:
        rationale += f" Failed: {', '.join(failed)}."
    return grade, rationale[:200]


class IncidentRun:
    def __init__(
        self,
        *,
        stream: EventStream,
        llm: LLM,
        rep: ReputationStore,
        sim: PaymentsSimulator,
        control: IncidentControl,
        price_weight: float,
    ) -> None:
        self.stream = stream
        self.llm = llm
        self.rep = rep
        self.sim = sim
        self.control = control
        self.price_weight = price_weight
        self.ledger: Ledger | None = None
        self.tasks_won = {agent.agent_id: 0 for agent in config.AGENTS}
        self.final_tasks: list[dict] = []
        self.rep_changes: list[dict] = []
        self.grades: list[int] = []
        self.job_text = ""
        self.task_count = 0

    async def status(self, status: str, summary: str) -> None:
        await self.stream.emit("incident_status", _status_data(self.sim, status, summary))

    async def run(self, job_id: str | None = None) -> dict:
        job_id = job_id or new_job_id()
        self.stream.start_job(job_id)
        self.ledger = Ledger(job_id, config.ledger_path())

        self.sim.break_production()
        outage_ms = self.stream.elapsed_ms()
        await self.status("outage", "Payments API is returning HTTP 500s.")
        telemetry = self.sim.telemetry()
        required, responders = select_responders(telemetry, self.sim.changes, SEVERITY)
        await self.stream.emit("responders_selected", {
            "required_skills": required,
            "responders": responders,
            "briefings": briefings(telemetry, self.sim.changes, SEVERITY, responders),
        })
        self.job_text = prompts.INCIDENT_JOB.format(
            service=SERVICE,
            severity=SEVERITY,
            telemetry=json.dumps(telemetry, sort_keys=True),
            changes=json.dumps(self.sim.changes, sort_keys=True),
            logs="\n".join(self.sim.logs()),
        )

        await self.status("investigating", "AI responders are bidding to diagnose the outage.")
        diagnosis_task = self._task("diagnose", "Diagnose the payments outage", prompts.DIAGNOSE_BRIEF, [])
        diagnosis = await self.market_task(diagnosis_task, {}, self._review_grader(diagnosis_task))
        if diagnosis is None:
            return await self.fail("Diagnosis failed: no responder completed it.")

        await self.status("repairing", "AI responders are bidding to repair the outage.")
        failed: list[str] = []
        passing: tuple[TaskSpec, TaskOutcome, dict] | None = None
        for attempt in range(1, config.MAX_REPAIR_ATTEMPTS + 1):
            task = self._task(
                "remediate",
                f"Repair attempt {attempt}",
                prompts.REMEDIATE_BRIEF.format(previous="; ".join(failed) or "none"),
                [diagnosis_task.task_id],
            )
            sandbox: dict = {}
            outcome = await self.market_task(
                task,
                {diagnosis_task.task_id: diagnosis.output},
                self._repair_grader(task, attempt, sandbox),
            )
            if outcome is not None and sandbox.get("passed"):
                passing = (task, outcome, sandbox)
                break
            if sandbox.get("action"):
                failed.append(f"{describe_action(sandbox['action'])} failed the sandbox")
            elif sandbox:
                failed.append("an invalid action was rejected")
        if passing is None:
            return await self.fail("No repair passed the sandbox.")

        repair_task, repair, sandbox = passing
        action = sandbox["action"]
        approvers = [r["name"] for r in responders if r["selected"] and
                     {"incident_command", "database"} & set(r["matched_skills"])]
        await self.status("awaiting_approval", f"{describe_action(action)} passed the sandbox. Waiting for human approval.")
        self.control.awaiting_approval = True
        await self.stream.emit("approval_required", {
            "task_id": repair_task.task_id,
            "agent_id": repair.agent_id,
            "attempt": sandbox["attempt"],
            "action": action,
            "summary": f"Deploy {describe_action(action)} to production. All sandbox checks passed.",
            "approvers": approvers,
        })
        await self.control.approval.wait()
        self.control.awaiting_approval = False

        self.sim.apply(action)
        await self.status("recovering", f"Deploying {describe_action(action)} and verifying production.")
        verify_task = self._task(
            "verify",
            "Verify production recovery",
            prompts.VERIFY_BRIEF.format(
                action=describe_action(action), telemetry=json.dumps(self.sim.telemetry(), sort_keys=True)
            ),
            [repair_task.task_id],
        )
        verification = self.sim.health_checks()
        verified = await self.market_task(
            verify_task, {repair_task.task_id: repair.output}, self._checks_grader(verification)
        )
        if verified is None or not self.sim.healthy():
            return await self.fail("Production verification failed.")

        await self.status("restored", "Payments API restored and verified.")
        commander = next(r["name"] for r in responders if r["role"] == "Incident Commander")
        await self.stream.emit("service_restored", {
            "mttr_ms": self.stream.elapsed_ms() - outage_ms,
            "total_cost_usd": self.ledger.total_cost(),
            "repair_attempts": sandbox["attempt"],
            "failed_attempts": sandbox["attempt"] - 1,
            "action": action,
            "confidence": repair.confidence,
            "approved_by": commander,
            "verification": verification,
            "grades": self.final_tasks,
            "rep_changes": self.rep_changes,
            "telemetry": self.sim.telemetry(),
        })
        return await self.finish("ok", diagnosis_task, diagnosis.output)

    def _task(self, type_: str, title: str, brief: str, depends_on: list[str]) -> TaskSpec:
        self.task_count += 1
        return TaskSpec(f"t{self.task_count}", type_, title, brief, depends_on)

    async def market_task(
        self, task: TaskSpec, dep_outputs: dict[str, str], grader: Grader
    ) -> TaskOutcome | None:
        assert self.ledger is not None
        system, user = build_work_prompt(self.job_text, task, dep_outputs)
        estimated_input = est_input_tokens(system, user)
        index = self.task_count - 1
        await self.stream.emit("task_posted", {
            "task_id": task.task_id,
            "type": task.type,
            "title": task.title,
            "brief": task.brief,
            "depends_on": task.depends_on,
            "index": index,
            # Planned remaining steps: remediate and verify after a diagnosis.
            "total": index + {"diagnose": 3, "remediate": 2, "verify": 1}[task.type],
            "est_input_tokens": estimated_input,
        })
        auction = await _run_auction(
            self.stream, self.llm, self.ledger, self.rep, self.job_text, task,
            dep_outputs, estimated_input, self.price_weight, self.tasks_won,
        )
        if auction is None:
            self.final_tasks.append(_final_task(task, None, None, None, self.ledger))
            return None
        winner, promised, predicted_tokens, predicted_price, confidence = auction

        await self.stream.emit("working", {"task_id": task.task_id, "agent_id": winner.agent_id})
        try:
            output, usage = await _work_with_retry(self.llm, self.ledger, winner, self.job_text, task, dep_outputs)
        except LLMError as exc:
            await _task_error(self.stream, self.ledger, self.tasks_won, task.task_id, str(exc))
            self.final_tasks.append(_final_task(task, winner.agent_id, None, promised, self.ledger))
            return None
        await self.stream.emit("done", {
            "task_id": task.task_id,
            "agent_id": winner.agent_id,
            "output": output,
            "predicted_output_tokens": predicted_tokens,
            "predicted_cost_usd": predicted_price,
            "usage": usage,
        })

        try:
            grade, rationale, review_usage = await grader(winner.agent_id, output)
        except LLMError as exc:
            await _task_error(self.stream, self.ledger, self.tasks_won, task.task_id, str(exc))
            self.final_tasks.append(_final_task(task, winner.agent_id, None, promised, self.ledger))
            return None
        self.grades.append(grade)
        await self.stream.emit("graded", {
            "task_id": task.task_id,
            "agent_id": winner.agent_id,
            "grade": grade,
            "promised_quality": promised,
            "rationale": rationale,
            "usage": review_usage,
        })
        old, new, ratio = self.rep.update(winner.agent_id, task.type, grade, promised)
        await self.stream.emit("rep_update", {
            "task_id": task.task_id,
            "agent_id": winner.agent_id,
            "task_type": task.type,
            "old": old,
            "new": new,
            "ratio": ratio,
        })
        self.rep_changes.append({"agent_id": winner.agent_id, "task_type": task.type, "old": old, "new": new})
        await self.stream.emit("stats", self.ledger.stats(self.tasks_won))
        self.final_tasks.append(_final_task(task, winner.agent_id, grade, promised, self.ledger))
        return TaskOutcome(winner.agent_id, output, grade, confidence)

    def _review_grader(self, task: TaskSpec) -> Grader:
        async def grade(agent_id: str, output: str) -> tuple[int, str, dict]:
            assert self.ledger is not None
            return await _review_with_retry(self.llm, self.ledger, self.job_text, task, {}, output)
        return grade

    def _repair_grader(self, task: TaskSpec, attempt: int, result: dict) -> Grader:
        async def grade(agent_id: str, output: str) -> tuple[int, str, dict]:
            try:
                action: dict | None = parse_action(output)
                reason = f"{describe_action(action)} is on the allowlist."
            except ActionRejected as exc:
                action, reason = None, f"Rejected: {exc}"
            await self.stream.emit("remediation_proposed", {
                "task_id": task.task_id,
                "agent_id": agent_id,
                "attempt": attempt,
                "action": action,
                "accepted": action is not None,
                "reason": reason[:200],
            })
            if action is None:
                checks = [{"name": "allowlisted action", "passed": False, "detail": reason[:120]}]
                passed, telemetry = False, self.sim.telemetry()
            else:
                passed, checks, telemetry = self.sim.sandbox(action)
            result.update({"task_id": task.task_id, "attempt": attempt, "action": action, "passed": passed})
            await self.stream.emit("sandbox_result", {
                "task_id": task.task_id,
                "agent_id": agent_id,
                "attempt": attempt,
                "action": action,
                "passed": passed,
                "checks": checks,
                "telemetry": telemetry,
            })
            grade_value, rationale = _grade_from_checks(checks)
            verdict = "Sandbox passed." if passed else "Sandbox rejected the repair."
            return grade_value, f"{verdict} {rationale}"[:200], _check_usage()
        return grade

    def _checks_grader(self, checks: list[dict]) -> Grader:
        async def grade(agent_id: str, output: str) -> tuple[int, str, dict]:
            grade_value, rationale = _grade_from_checks(checks)
            return grade_value, f"Production health checks: {rationale}"[:200], _check_usage()
        return grade

    async def fail(self, summary: str) -> dict:
        await self.status("failed", summary)
        return await self.finish("error", None, None)

    async def finish(self, status: str, deliverable_task: TaskSpec | None, deliverable: str | None) -> dict:
        assert self.ledger is not None
        final = {
            "status": status,
            "deliverable_task_id": deliverable_task.task_id if deliverable_task else None,
            "deliverable": deliverable,
            "tasks": self.final_tasks,
            "total_cost_usd": self.ledger.total_cost(),
            "mean_grade": round(sum(self.grades) / len(self.grades), 2) if self.grades else None,
            "duration_ms": self.stream.elapsed_ms(),
        }
        await self.stream.emit("final", final)
        return final


async def run_incident(
    *,
    stream: EventStream,
    llm: LLM,
    rep: ReputationStore,
    sim: PaymentsSimulator,
    control: IncidentControl,
    price_weight: float = config.PRICE_WEIGHT,
    job_id: str | None = None,
) -> dict:
    run = IncidentRun(stream=stream, llm=llm, rep=rep, sim=sim, control=control, price_weight=price_weight)
    return await run.run(job_id)
