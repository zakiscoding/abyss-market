"""MAYDAY: run a simulated incident through the Commander and the Abyss market.

Incident received -> Commander classifies -> the domain's specialists are
dispatched -> diagnose, remediate and verify auctions (the same auction, work
call, reputation update, ledger and events as a job) -> every remediation plan is
parsed into allowlisted actions and tested on a sandbox copy -> plan steps are
assigned to their human owners -> production changes only after approval.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from . import commander, config, prompts
from .agents import bid_prompt, build_work_prompt, est_input_tokens
from .events import EventStream, new_job_id
from .incident import ACTION_SIGNATURES, REGIONS, ActionRejected, Scenario, describe_action, describe_plan, parse_plan
from .ledger import Ledger, cost_usd
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
from .responders import assign, customer_impact, owner_domain, required_skills, select_responders

Grader = Callable[[str, str], Awaitable[tuple[int, str, dict]]]
ROUTING_METHOD = (
    "Estimate: for each auction, every skipped specialist x the bid prompt it would have "
    "received (characters / 4), plus the raw incident context the Commander did not read, "
    "priced at each model's input rate. Actual figures come from the ledger."
)


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


def healthy_status(sim: Scenario) -> dict:
    return _status_data(sim, "healthy", "All systems operational.", None)


def _status_data(sim: Scenario, status: str, summary: str, severity: str | None) -> dict:
    return {
        "status": status,
        "scenario_id": sim.scenario_id,
        "service": sim.service,
        "region": sim.region,
        "severity": None if status in {"healthy", "restored"} else severity,
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


def _billing_model(model: str) -> str:
    # Fake calls are priced at the nominal model; real calls at the resolved one.
    return model if config.fake_llm() else config.resolve_model(model)


class IncidentRun:
    def __init__(
        self,
        *,
        stream: EventStream,
        llm: LLM,
        rep: ReputationStore,
        sim: Scenario,
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
        self.job_fields: dict = {}
        self.task_count = 0
        self.domain = "generalist"
        self.severity: str | None = None
        self.agent_names: dict[str, str] = {}
        self.responders: list[dict] = []
        self.registered = 0
        self.eligible = 0
        self.auctions = 0
        self.repair_attempts = 0
        self.skipped_tokens = 0
        self.skipped_cost = 0.0
        self.package_tokens = 0
        self.full_tokens = 0

    async def status(self, status: str, summary: str) -> None:
        await self.stream.emit("incident_status", _status_data(self.sim, status, summary, self.severity))

    async def run(self, job_id: str | None = None) -> dict:
        job_id = job_id or new_job_id()
        self.stream.start_job(job_id)
        self.ledger = Ledger(job_id, config.ledger_path())
        sim = self.sim

        sim.break_production()
        outage_ms = self.stream.elapsed_ms()
        package = commander.incident_package(sim)
        self.package_tokens = commander.package_tokens(package)
        self.full_tokens = commander.full_context_tokens(sim)
        await self.stream.emit("incident_received", {
            **sim.catalog(),
            "package": package,
            "package_tokens_est": self.package_tokens,
            "full_context_tokens_est": self.full_tokens,
        })
        await self.status("outage", sim.alert)

        decision = await commander.classify(self.llm, self.ledger, package)
        self.domain, self.severity = decision["domain"], decision["severity"]
        impact = customer_impact(sim.telemetry())
        required = required_skills(self.domain, decision["secondary_domains"], self.severity, impact)
        await self.stream.emit("commander_classified", {
            "scenario_id": sim.scenario_id,
            "domain": self.domain,
            "secondary_domains": decision["secondary_domains"],
            "severity": self.severity,
            "required_specialties": required,
            "rationale": decision["rationale"],
            "source": decision["source"],
            "fallback_reason": decision["fallback_reason"],
            "usage": decision["usage"],
        })
        dispatch = commander.dispatch(self.domain)
        await self.stream.emit("specialists_dispatched", dispatch)
        self.registered, self.eligible = dispatch["registered"], dispatch["eligible"]
        self.agent_names = {s["agent_id"]: s["label"] for s in dispatch["specialists"] if s["dispatched"]}

        self.responders = select_responders(required, self.severity)
        team = ", ".join(r["name"] for r in self.responders if r["selected"])
        await self.stream.emit("responders_selected", {
            "required_skills": required,
            "responders": self.responders,
            "briefings": sim.briefings(self.severity, team),
        })
        self.job_fields = {
            "scenario_id": sim.scenario_id,
            "service": sim.service,
            "region": sim.region,
            "severity": self.severity,
            "source": sim.source_system,
            "domain": self.domain,
            "secondary": ", ".join(decision["secondary_domains"]) or "none",
            "rationale": decision["rationale"],
            "telemetry": json.dumps(sim.telemetry(), sort_keys=True),
            "changes": json.dumps(sim.changes, sort_keys=True),
            "logs": "\n".join(sim.logs()),
        }
        self.job_text = self._job_text(self.domain)

        await self.status("investigating", f"{config.DOMAIN_LABELS[self.domain]}s are bidding to diagnose.")
        diagnosis_task = self._task("diagnose", f"Diagnose the {sim.service} incident",
                                    prompts.DIAGNOSE_BRIEF.format(service=sim.service), [])
        diagnosis = await self.market_task(diagnosis_task, {}, self._review_grader(diagnosis_task))
        if diagnosis is None:
            return await self.fail("Diagnosis failed: no specialist completed it.")

        await self.status("repairing", f"{config.DOMAIN_LABELS[self.domain]}s are bidding to repair.")
        failed: list[str] = []
        passing: tuple[TaskSpec, TaskOutcome, dict] | None = None
        for attempt in range(1, config.MAX_REPAIR_ATTEMPTS + 1):
            self.repair_attempts = attempt
            task = self._task(
                "remediate",
                f"Repair attempt {attempt}",
                prompts.REMEDIATE_BRIEF.format(
                    service=sim.service,
                    regions=", ".join(REGIONS),
                    actions="\n".join(ACTION_SIGNATURES[name] for name in sim.allowed_actions),
                    previous="; ".join(failed) or "none",
                ),
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
            if sandbox.get("steps"):
                failed.append(f"{describe_plan(sandbox['steps'])} failed the sandbox")
            elif sandbox:
                failed.append("an invalid plan was rejected")
        if passing is None:
            return await self.fail(f"No remediation plan passed the sandbox after {self.repair_attempts} attempts.")

        repair_task, repair, sandbox = passing
        steps = sandbox["steps"]
        plan_text = describe_plan(steps)
        await self.stream.emit("remediation_plan_created", {
            "task_id": repair_task.task_id,
            "agent_id": repair.agent_id,
            "attempt": sandbox["attempt"],
            "steps": [
                {"index": i, "action": step, "description": describe_action(step), "owner_domain": owner_domain(step)}
                for i, step in enumerate(steps)
            ],
            "summary": f"{plan_text} passed all {len(sandbox['checks'])} sandbox checks.",
            "confidence": repair.confidence,
        })
        assignments, approvers = assign(steps, self.severity, self.responders, customer_impact(sim.telemetry()))
        await self.stream.emit("human_assignments_created", {
            "task_id": repair_task.task_id,
            "assignments": assignments,
            "required_approvers": approvers,
        })
        await self.status("awaiting_approval", f"{plan_text} passed the sandbox. Waiting for {', '.join(approvers)}.")
        self.control.awaiting_approval = True
        await self.stream.emit("approval_required", {
            "task_id": repair_task.task_id,
            "agent_id": repair.agent_id,
            "attempt": sandbox["attempt"],
            "steps": steps,
            "summary": f"Deploy {plan_text} to production. All sandbox checks passed.",
            "approvers": approvers,
        })
        await self.control.approval.wait()
        self.control.awaiting_approval = False
        await self.stream.emit("approval_granted", {
            "task_id": repair_task.task_id,
            "approved": [item["assignment_id"] for item in assignments if item["approval_required"]],
            "approved_by": approvers,
        })

        sim.apply(steps)
        await self.status("recovering", f"Deploying {plan_text} and verifying production.")
        verify_task = self._task(
            "verify",
            "Verify production recovery",
            prompts.VERIFY_BRIEF.format(
                service=sim.service, plan=plan_text, telemetry=json.dumps(sim.telemetry(), sort_keys=True)
            ),
            [repair_task.task_id],
        )
        verification = sim.health_checks()
        verified = await self.market_task(
            verify_task, {repair_task.task_id: repair.output}, self._checks_grader(verification)
        )
        if verified is None or not sim.healthy():
            return await self.fail("Production verification failed after deployment.")

        await self.status("restored", f"{sim.service} restored and verified.")
        await self.stream.emit("service_restored", {
            "scenario_id": sim.scenario_id,
            "domain": self.domain,
            "mttr_ms": self.stream.elapsed_ms() - outage_ms,
            "total_cost_usd": self.ledger.total_cost(),
            "repair_attempts": sandbox["attempt"],
            "failed_attempts": sandbox["attempt"] - 1,
            "steps": steps,
            "confidence": repair.confidence,
            "approved_by": approvers,
            "verification": verification,
            "grades": self.final_tasks,
            "rep_changes": self.rep_changes,
            "telemetry": sim.telemetry(),
        })
        await self.routing_stats()
        return await self.finish("ok", diagnosis_task, diagnosis.output)

    def _job_text(self, domain: str) -> str:
        return prompts.INCIDENT_JOB.format(specialist=config.DOMAIN_LABELS[domain], **self.job_fields)

    def _task(self, type_: str, title: str, brief: str, depends_on: list[str]) -> TaskSpec:
        self.task_count += 1
        return TaskSpec(f"t{self.task_count}", type_, title, brief, depends_on)

    def _count_skipped(self, task: TaskSpec, dep_outputs: dict[str, str]) -> None:
        """Estimate what broadcasting this auction to every other specialist would have sent."""
        agents = {agent.agent_id: agent for agent in config.AGENTS}
        dep_sizes = {task_id: len(output) for task_id, output in dep_outputs.items()}
        for item in config.specialists():
            if item["domain"] == self.domain:
                continue
            agent = agents[item["agent_id"]]
            reputation = self.rep.get(agent.agent_id, config.rep_key(task.type, item["domain"]))
            system, user = bid_prompt(agent, self._job_text(item["domain"]), task, dep_sizes, reputation, item["label"])
            tokens = est_input_tokens(system, user)
            self.skipped_tokens += tokens
            self.skipped_cost += cost_usd(_billing_model(agent.model), tokens, 0)

    async def market_task(
        self, task: TaskSpec, dep_outputs: dict[str, str], grader: Grader
    ) -> TaskOutcome | None:
        assert self.ledger is not None
        system, user = build_work_prompt(self.job_text, task, dep_outputs)
        estimated_input = est_input_tokens(system, user)
        index = self.task_count - 1
        key = config.rep_key(task.type, self.domain)
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
            "domain": self.domain,
        })
        self.auctions += 1
        self._count_skipped(task, dep_outputs)
        auction = await _run_auction(
            self.stream, self.llm, self.ledger, self.rep, self.job_text, task,
            dep_outputs, estimated_input, self.price_weight, self.tasks_won,
            rep_key=key, agent_names=self.agent_names,
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
        old, new, ratio = self.rep.update(winner.agent_id, key, grade, promised)
        await self.stream.emit("rep_update", {
            "task_id": task.task_id,
            "agent_id": winner.agent_id,
            "task_type": task.type,
            "rep_key": key,
            "old": old,
            "new": new,
            "ratio": ratio,
        })
        self.rep_changes.append({
            "agent_id": winner.agent_id, "task_type": task.type, "rep_key": key, "old": old, "new": new,
        })
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
                steps = parse_plan(output, self.sim.allowed_actions)
                reason = f"{describe_plan(steps)} uses only allowlisted actions."
            except ActionRejected as exc:
                steps, reason = [], f"Rejected: {exc}"
            await self.stream.emit("remediation_proposed", {
                "task_id": task.task_id,
                "agent_id": agent_id,
                "attempt": attempt,
                "steps": steps,
                "accepted": bool(steps),
                "reason": reason[:200],
            })
            if not steps:
                checks = [{"name": "allowlisted plan", "passed": False, "detail": reason[:120]}]
                passed, telemetry = False, self.sim.telemetry()
            else:
                passed, checks, telemetry = self.sim.sandbox(steps)
            result.update({"task_id": task.task_id, "attempt": attempt, "steps": steps,
                           "passed": passed, "checks": checks})
            await self.stream.emit("sandbox_result", {
                "task_id": task.task_id,
                "agent_id": agent_id,
                "attempt": attempt,
                "steps": steps,
                "passed": passed,
                "checks": checks,
                "telemetry": telemetry,
            })
            grade_value, rationale = _grade_from_checks(checks)
            verdict = "Sandbox passed." if passed else "Sandbox rejected the plan."
            return grade_value, f"{verdict} {rationale}"[:200], _check_usage()
        return grade

    def _checks_grader(self, checks: list[dict]) -> Grader:
        async def grade(agent_id: str, output: str) -> tuple[int, str, dict]:
            grade_value, rationale = _grade_from_checks(checks)
            return grade_value, f"Production health checks: {rationale}"[:200], _check_usage()
        return grade

    async def routing_stats(self) -> None:
        assert self.ledger is not None
        stats = self.ledger.stats(self.tasks_won)
        context_saved = max(0, self.full_tokens - self.package_tokens)
        context_cost = cost_usd(_billing_model(config.ORCHESTRATOR_MODEL), context_saved, 0)
        await self.stream.emit("routing_stats", {
            "domain": self.domain,
            "registered_specialists": self.registered,
            "eligible_specialists": self.eligible,
            "auctions": self.auctions,
            "models_contacted": self.eligible * self.auctions,
            "models_skipped": (self.registered - self.eligible) * self.auctions,
            "actual_input_tokens": stats["input_tokens"],
            "actual_output_tokens": stats["output_tokens"],
            "actual_cost_usd": stats["total_cost_usd"],
            "actual_calls": stats["calls"],
            "commander_package_tokens_est": self.package_tokens,
            "full_context_tokens_est": self.full_tokens,
            "avoided_input_tokens_est": self.skipped_tokens + context_saved,
            "avoided_cost_usd_est": round(self.skipped_cost + context_cost, 6),
            "method": ROUTING_METHOD,
        })

    async def fail(self, reason: str) -> dict:
        owners = [
            r["name"] for r in self.responders
            if r["selected"] and ({"incident_command"} | set(required_skills(self.domain, [], None, False)))
            & set(r["matched_skills"])
        ]
        await self.stream.emit("incident_escalated", {
            "reason": reason[:200],
            "attempts": self.repair_attempts,
            "escalated_to": owners or ["Zak"],
        })
        await self.status("failed", f"Escalated to humans: {reason}")
        await self.routing_stats()
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
    sim: Scenario,
    control: IncidentControl,
    price_weight: float = config.PRICE_WEIGHT,
    job_id: str | None = None,
) -> dict:
    run = IncidentRun(stream=stream, llm=llm, rep=rep, sim=sim, control=control, price_weight=price_weight)
    return await run.run(job_id)
