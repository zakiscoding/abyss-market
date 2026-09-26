from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator


AgentId = Literal["haiku", "sonnet", "opus"]
TaskType = Literal["research", "writing", "checking", "diagnose", "remediate", "verify"]
TASK_TYPE_ORDER = ["research", "writing", "checking", "diagnose", "remediate", "verify"]
IncidentState = Literal[
    "healthy",
    "outage",
    "investigating",
    "repairing",
    "awaiting_approval",
    "recovering",
    "restored",
    "failed",
]
ActionName = Literal["set_db_pool_size", "restart_service", "rollback_config"]
Purpose = Literal["split", "bid", "work", "review"]
JobId = Annotated[str, Field(pattern=r"^j_[0-9a-f]{8}$")]
TaskId = Annotated[str, Field(pattern=r"^t[1-9][0-9]*$")]
NonNegativeInt = Annotated[int, Field(ge=0)]
NonNegativeFloat = Annotated[float, Field(ge=0)]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Usage(ContractModel):
    model: str
    input_tokens: NonNegativeInt
    output_tokens: NonNegativeInt
    cost_usd: NonNegativeFloat
    duration_ms: NonNegativeInt


class Agent(ContractModel):
    agent_id: AgentId
    display_name: str
    model: str
    color: Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]


class TaskReputation(ContractModel):
    research: float
    writing: float
    checking: float
    diagnose: float
    remediate: float
    verify: float


class Reputation(ContractModel):
    haiku: TaskReputation
    sonnet: TaskReputation
    opus: TaskReputation


class HelloConfig(ContractModel):
    price_weight: float
    rep_init: float
    rep_alpha: float
    task_types: list[TaskType]
    real_models: StrictBool
    fake_llm: StrictBool
    orchestrator_model: str
    reviewer_model: str


class HelloData(ContractModel):
    agents: list[Agent]
    reputation: Reputation
    config: HelloConfig

    @model_validator(mode="after")
    def validate_agent_order(self) -> "HelloData":
        if [agent.agent_id for agent in self.agents] != ["haiku", "sonnet", "opus"]:
            raise ValueError("agents must be in frozen stall order")
        if self.config.task_types != TASK_TYPE_ORDER:
            raise ValueError("task_types must contain the frozen task types in order")
        return self


class SplitTask(ContractModel):
    task_id: TaskId
    type: TaskType
    title: str
    brief: str
    depends_on: list[TaskId]


class JobSplitData(ContractModel):
    job_text: str
    tasks: Annotated[list[SplitTask], Field(min_length=2, max_length=5)]
    price_weight: float
    usage: Usage


class TaskPostedData(ContractModel):
    task_id: TaskId
    type: TaskType
    title: str
    brief: str
    depends_on: list[TaskId]
    index: NonNegativeInt
    total: Annotated[int, Field(gt=0)]
    est_input_tokens: NonNegativeInt


class BidData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    ok: StrictBool
    error: str | None
    predicted_output_tokens: NonNegativeInt | None
    est_input_tokens: NonNegativeInt | None
    predicted_cost_usd: NonNegativeFloat | None
    eta_ms: NonNegativeInt | None
    promised_quality: Annotated[int, Field(ge=1, le=10)] | None
    pitch: Annotated[str, Field(max_length=80)] | None
    reputation: float | None
    score: float | None
    usage: Usage | None

    @model_validator(mode="after")
    def validate_success_fields(self) -> "BidData":
        result_fields = (
            self.predicted_output_tokens,
            self.est_input_tokens,
            self.predicted_cost_usd,
            self.eta_ms,
            self.promised_quality,
            self.pitch,
            self.reputation,
            self.score,
            self.usage,
        )
        if self.ok:
            if self.error is not None or any(value is None for value in result_fields):
                raise ValueError("successful bids require every bid field and error=null")
        elif self.error is None or any(value is not None for value in result_fields):
            raise ValueError("failed bids require error and null bid fields")
        return self


class WonData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    mode: Literal["auction", "fixed"]
    score: float | None
    runner_up_agent_id: AgentId | None
    runner_up_score: float | None
    scores: dict[AgentId, float]
    price_weight: float

    @model_validator(mode="after")
    def validate_mode_fields(self) -> "WonData":
        if (self.runner_up_agent_id is None) != (self.runner_up_score is None):
            raise ValueError("runner-up agent and score must both be null or both be set")
        if self.mode == "fixed":
            if (
                self.score is not None
                or self.runner_up_agent_id is not None
                or self.scores
            ):
                raise ValueError("fixed wins require null scores and scores={}")
        elif self.score is None or self.agent_id not in self.scores:
            raise ValueError("auction wins require a winner score")
        return self


class WorkingData(ContractModel):
    task_id: TaskId
    agent_id: AgentId


class DoneData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    output: str
    predicted_output_tokens: NonNegativeInt | None
    predicted_cost_usd: NonNegativeFloat | None
    usage: Usage


class GradedData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    grade: Annotated[int, Field(ge=1, le=10)]
    promised_quality: Annotated[int, Field(ge=1, le=10)] | None
    rationale: Annotated[str, Field(max_length=200)]
    usage: Usage


class RepUpdateData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    task_type: TaskType
    old: float
    new: float
    ratio: float


class PurposeStats(ContractModel):
    cost_usd: NonNegativeFloat
    calls: NonNegativeInt


class PurposeBreakdown(ContractModel):
    split: PurposeStats
    bid: PurposeStats
    work: PurposeStats
    review: PurposeStats


class AgentStats(ContractModel):
    cost_usd: NonNegativeFloat
    input_tokens: NonNegativeInt
    output_tokens: NonNegativeInt
    calls: NonNegativeInt
    tasks_won: NonNegativeInt


class AgentBreakdown(ContractModel):
    haiku: AgentStats
    sonnet: AgentStats
    opus: AgentStats


class StatsData(ContractModel):
    total_cost_usd: NonNegativeFloat
    input_tokens: NonNegativeInt
    output_tokens: NonNegativeInt
    calls: NonNegativeInt
    by_purpose: PurposeBreakdown
    by_agent: AgentBreakdown


class FinalTask(ContractModel):
    task_id: TaskId
    type: TaskType
    agent_id: AgentId | None
    grade: Annotated[int, Field(ge=1, le=10)] | None
    promised_quality: Annotated[int, Field(ge=1, le=10)] | None
    cost_usd: NonNegativeFloat


class FinalData(ContractModel):
    status: Literal["ok", "partial", "error"]
    deliverable_task_id: TaskId | None
    deliverable: str | None
    tasks: list[FinalTask]
    total_cost_usd: NonNegativeFloat
    mean_grade: Annotated[float, Field(ge=1, le=10)] | None
    duration_ms: NonNegativeInt

    @model_validator(mode="after")
    def validate_deliverable_fields(self) -> "FinalData":
        if (self.deliverable_task_id is None) != (self.deliverable is None):
            raise ValueError("deliverable id and text must both be null or both be set")
        return self


class ErrorData(ContractModel):
    message: str
    task_id: TaskId | None
    fatal: StrictBool


# ---------------------------------------------------------------- MAYDAY (v1.1)

Fraction = Annotated[float, Field(ge=0, le=1)]
AttemptNo = Annotated[int, Field(ge=1)]


class Telemetry(ContractModel):
    db_pool_size: NonNegativeInt
    db_pool_in_use: NonNegativeInt
    db_waiting: NonNegativeInt
    p95_latency_ms: NonNegativeInt
    error_rate: Fraction
    payment_success_rate: Fraction
    requests_per_min: NonNegativeInt
    timeouts_per_min: NonNegativeInt


class LogLine(ContractModel):
    level: Literal["INFO", "WARN", "ERROR"]
    source: str
    message: str


class ConfigChange(ContractModel):
    key: str
    old: str
    new: str
    author: str
    minutes_ago: NonNegativeInt


class IncidentStatusData(ContractModel):
    status: IncidentState
    service: str
    severity: Literal["SEV-1", "SEV-2", "SEV-3"] | None
    headline: str
    telemetry: Telemetry
    logs: list[LogLine]
    config_changes: list[ConfigChange]


class Responder(ContractModel):
    responder_id: str
    name: str
    role: str
    skills: list[str]
    available: StrictBool
    workload: NonNegativeInt
    score: float
    selected: StrictBool
    reason: str


class Briefings(ContractModel):
    engineering: str
    support: str
    commander: str
    leadership: str


class RespondersSelectedData(ContractModel):
    severity: Literal["SEV-1", "SEV-2", "SEV-3"]
    required_skills: list[str]
    responders: list[Responder]
    briefings: Briefings


class RemediationAction(ContractModel):
    action: ActionName
    value: Annotated[int, Field(ge=1, le=50)] | None

    @model_validator(mode="after")
    def validate_value(self) -> "RemediationAction":
        if (self.action == "set_db_pool_size") != (self.value is not None):
            raise ValueError("only set_db_pool_size takes a value, and it requires one")
        return self


class RemediationProposedData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    attempt: AttemptNo
    raw: Annotated[str, Field(max_length=300)]
    valid: StrictBool
    action: RemediationAction | None
    rejection: str | None

    @model_validator(mode="after")
    def validate_verdict(self) -> "RemediationProposedData":
        if self.valid != (self.action is not None) or self.valid == (self.rejection is not None):
            raise ValueError("valid proposals need an action; invalid ones need a rejection")
        return self


class Check(ContractModel):
    name: str
    passed: StrictBool
    detail: str


class SandboxResultData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    attempt: AttemptNo
    action: RemediationAction | None
    passed: StrictBool
    checks: list[Check]
    telemetry: Telemetry

    @model_validator(mode="after")
    def validate_passed(self) -> "SandboxResultData":
        if self.passed != (bool(self.checks) and all(check.passed for check in self.checks)):
            raise ValueError("passed must equal every check passing")
        return self


class ApprovalRequiredData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    attempt: AttemptNo
    action: RemediationAction
    summary: str
    approvers: list[str]


class GradeSummary(ContractModel):
    task_id: TaskId
    type: TaskType
    agent_id: AgentId
    grade: Annotated[int, Field(ge=1, le=10)]
    promised_quality: Annotated[int, Field(ge=1, le=10)] | None


class RepChange(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    task_type: TaskType
    old: float
    new: float


class ServiceRestoredData(ContractModel):
    mttr_ms: NonNegativeInt
    total_cost_usd: NonNegativeFloat
    repair_attempts: AttemptNo
    failed_attempts: NonNegativeInt
    confidence: Fraction
    mean_grade: Annotated[float, Field(ge=1, le=10)]
    approved_by: str
    action: RemediationAction
    grades: list[GradeSummary]
    rep_changes: list[RepChange]
    verification: list[Check]
    telemetry: Telemetry


class Envelope(ContractModel):
    v: Literal[1]
    seq: NonNegativeInt
    t: NonNegativeInt
    job_id: JobId | None
    type: str
    data: dict[str, Any]


DATA_MODELS: dict[str, type[ContractModel]] = {
    "hello": HelloData,
    "job_split": JobSplitData,
    "task_posted": TaskPostedData,
    "bid": BidData,
    "won": WonData,
    "working": WorkingData,
    "done": DoneData,
    "graded": GradedData,
    "rep_update": RepUpdateData,
    "stats": StatsData,
    "final": FinalData,
    "error": ErrorData,
    "incident_status": IncidentStatusData,
    "responders_selected": RespondersSelectedData,
    "remediation_proposed": RemediationProposedData,
    "sandbox_result": SandboxResultData,
    "approval_required": ApprovalRequiredData,
    "service_restored": ServiceRestoredData,
}
INCIDENT_EVENTS = {
    "incident_status",
    "responders_selected",
    "remediation_proposed",
    "sandbox_result",
    "approval_required",
    "service_restored",
}
# Allowed incident_status transitions within one incident job.
INCIDENT_TRANSITIONS: dict[str, set[str]] = {
    "outage": {"investigating", "failed"},
    "investigating": {"repairing", "failed"},
    "repairing": {"awaiting_approval", "failed"},
    "awaiting_approval": {"recovering", "failed"},
    "recovering": {"restored", "failed"},
    "restored": set(),
    "failed": set(),
}


def validate_event(ev: dict) -> None:
    envelope = Envelope.model_validate(ev)
    data_model = DATA_MODELS.get(envelope.type)
    if data_model is None:
        raise ValueError(f"unknown event type {envelope.type!r}")
    data_model.model_validate(envelope.data)

    if envelope.type == "hello":
        if envelope.job_id is not None or envelope.t != 0:
            raise ValueError("hello requires job_id=null and t=0")
    elif envelope.type == "incident_status" and envelope.job_id is None:
        if envelope.data["status"] != "healthy":
            raise ValueError("only a healthy incident_status may have job_id=null")
    elif envelope.type != "error" and envelope.job_id is None:
        raise ValueError(f"{envelope.type} requires a job_id")
    elif envelope.type == "incident_status" and envelope.data["status"] == "healthy":
        raise ValueError("a healthy incident_status must have job_id=null")


def _task_id(ev: dict) -> str | None:
    return ev["data"].get("task_id")


def _failure_error_after(segment: list[dict], event: dict, task_id: str) -> bool:
    event_index = next(
        index for index, candidate in enumerate(segment) if candidate is event
    )
    return any(
        candidate["type"] == "error"
        and _task_id(candidate) == task_id
        and not candidate["data"]["fatal"]
        for candidate in segment[event_index + 1 : -1]
    )


def _check_task_identity(events: list[dict], task_id: str) -> None:
    for ev in events:
        if ev["type"] not in {"stats", "error"} and _task_id(ev) != task_id:
            raise ValueError(
                f"{ev['type']} for {_task_id(ev)!r} appears in task {task_id!r} sequence"
            )


def _validate_task_segment(segment: list[dict], task: dict, index: int, total: int) -> bool:
    task_id = task["task_id"]
    if not segment or segment[-1]["type"] != "stats":
        raise ValueError(f"task {task_id} segment must end with stats")
    non_errors = [ev for ev in segment if ev["type"] != "error"]
    _check_task_identity(non_errors, task_id)

    posted = non_errors[0]
    if posted["type"] != "task_posted":
        raise ValueError(f"task {task_id} must start with task_posted")
    posted_data = posted["data"]
    expected_posted = {
        "task_id": task_id,
        "type": task["type"],
        "title": task["title"],
        "brief": task["brief"],
        "depends_on": task["depends_on"],
        "index": index,
        "total": total,
    }
    for key, value in expected_posted.items():
        if posted_data[key] != value:
            raise ValueError(f"task_posted {key} does not match job_split for {task_id}")

    cursor = 1
    bids: list[dict] = []
    while cursor < len(non_errors) and non_errors[cursor]["type"] == "bid":
        bids.append(non_errors[cursor])
        cursor += 1

    if bids:
        agents = [bid["data"]["agent_id"] for bid in bids]
        if len(bids) != 3 or set(agents) != {"haiku", "sonnet", "opus"}:
            raise ValueError(f"task {task_id} must receive one bid from each agent")

    if cursor == len(non_errors) - 1 and non_errors[cursor]["type"] == "stats":
        if (
            not bids
            or any(bid["data"]["ok"] for bid in bids)
            or not _failure_error_after(segment, bids[-1], task_id)
        ):
            raise ValueError(f"task {task_id} ended before won without all bids failing")
        return True

    won = non_errors[cursor]
    if won["type"] != "won":
        raise ValueError(f"task {task_id} expected won after bidding")
    mode = won["data"]["mode"]
    if (mode == "auction" and len(bids) != 3) or (mode == "fixed" and bids):
        raise ValueError(f"task {task_id} bid count does not match won.mode")
    winner = won["data"]["agent_id"]
    cursor += 1

    expected_tail = ["stats", "working", "done", "graded"]
    for expected_type in expected_tail:
        ev = non_errors[cursor]
        if ev["type"] == "stats" and expected_type in {"done", "graded"}:
            previous = non_errors[cursor - 1]
            if _failure_error_after(segment, previous, task_id):
                return True
        if ev["type"] != expected_type:
            raise ValueError(
                f"task {task_id} expected {expected_type}, got {ev['type']}"
            )
        if expected_type in {"working", "done", "graded"}:
            if ev["data"]["agent_id"] != winner:
                raise ValueError(f"task {task_id} winner changed during execution")
        if expected_type == "graded":
            promised_quality = ev["data"]["promised_quality"]
            if (mode == "fixed") != (promised_quality is None):
                raise ValueError(
                    f"task {task_id} graded.promised_quality does not match won.mode"
                )
        cursor += 1

    if mode == "auction":
        if cursor == len(non_errors) or non_errors[cursor]["type"] != "rep_update":
            raise ValueError(f"task {task_id} auction result requires rep_update")
        rep_update = non_errors[cursor]["data"]
        if rep_update["agent_id"] != winner or rep_update["task_type"] != task["type"]:
            raise ValueError(f"task {task_id} rep_update does not match its winner and type")
        cursor += 1

    if cursor == len(non_errors) or non_errors[cursor]["type"] != "stats":
        raise ValueError(f"task {task_id} successful result must end with stats")
    cursor += 1
    if cursor != len(non_errors):
        raise ValueError(f"unexpected {non_errors[cursor]['type']} after task {task_id}")
    return False


def _validate_job(job_id: str, events: list[dict]) -> None:
    if events[-1]["type"] != "final":
        raise ValueError(f"final must be the last event for job {job_id}")
    if any(ev["type"] in INCIDENT_EVENTS for ev in events):
        raise ValueError(f"job {job_id} mixes incident events into a normal job")
    for ev in events:
        if ev["type"] == "job_split" and any(
            task["type"] in INCIDENT_TASK_TYPES for task in ev["data"]["tasks"]
        ):
            raise ValueError("job_split may only use research, writing and checking")

    non_errors = [ev for ev in events if ev["type"] != "error"]
    split_events = [ev for ev in non_errors if ev["type"] == "job_split"]
    if not split_events:
        fatal_errors = [ev for ev in events if ev["type"] == "error" and ev["data"]["fatal"]]
        if len(non_errors) != 1 or non_errors[0]["type"] != "final" or not fatal_errors:
            raise ValueError(f"job {job_id} has no job_split")
        if non_errors[0]["data"]["status"] != "error":
            raise ValueError("a split failure requires final.status='error'")
        return
    if len(split_events) != 1 or non_errors[0]["type"] != "job_split":
        raise ValueError(f"job {job_id} must start with exactly one job_split")
    if len(non_errors) < 3 or non_errors[1]["type"] != "stats":
        raise ValueError("job_split must be followed by stats")

    split_tasks = non_errors[0]["data"]["tasks"]
    task_ids = [task["task_id"] for task in split_tasks]
    expected_ids = [f"t{i}" for i in range(1, len(split_tasks) + 1)]
    if task_ids != expected_ids:
        raise ValueError("job_split task_ids must be t1..tN in execution order")
    seen: set[str] = set()
    for task in split_tasks:
        if any(dependency not in seen for dependency in task["depends_on"]):
            raise ValueError(f"{task['task_id']} depends_on must reference earlier tasks")
        seen.add(task["task_id"])

    body = non_errors[2:-1]
    posted_positions = [
        position for position, ev in enumerate(body) if ev["type"] == "task_posted"
    ]
    if len(posted_positions) != len(split_tasks):
        raise ValueError("each split task must have exactly one task_posted event")
    if posted_positions and posted_positions[0] != 0:
        raise ValueError("unexpected event between initial stats and first task_posted")

    task_failed = False
    original_body = events[events.index(non_errors[2]) : events.index(non_errors[-1])]
    original_posted_positions = [
        position
        for position, ev in enumerate(original_body)
        if ev["type"] == "task_posted"
    ]
    for index, task in enumerate(split_tasks):
        start = original_posted_positions[index]
        end = (
            original_posted_positions[index + 1]
            if index + 1 < len(original_posted_positions)
            else len(original_body)
        )
        segment = original_body[start:end]
        task_failed |= _validate_task_segment(segment, task, index, len(split_tasks))

    final_status = non_errors[-1]["data"]["status"]
    expected_status = "partial" if task_failed else "ok"
    if final_status != expected_status:
        raise ValueError(
            f"final.status must be {expected_status!r} for this task outcome"
        )


INCIDENT_TASK_TYPES = {"diagnose", "remediate", "verify"}


def _position(events: list[dict], event: dict) -> int:
    return next(index for index, candidate in enumerate(events) if candidate is event)


def _validate_incident(job_id: str, events: list[dict]) -> None:
    """An incident job: outage -> diagnose -> remediate+ (sandboxed) -> approval
    -> verify -> restored. Each task reuses the normal task-segment grammar;
    incident events are checked for order around it."""
    if events[-1]["type"] != "final":
        raise ValueError(f"final must be the last event for incident {job_id}")
    statuses = [ev for ev in events if ev["type"] == "incident_status"]
    if statuses[0]["data"]["status"] != "outage":
        raise ValueError("an incident must start with incident_status 'outage'")
    for previous, current in zip(statuses, statuses[1:]):
        if current["data"]["status"] not in INCIDENT_TRANSITIONS[previous["data"]["status"]]:
            raise ValueError(
                f"incident_status cannot go from {previous['data']['status']!r} "
                f"to {current['data']['status']!r}"
            )

    body = events[:-1]
    posted_positions = [i for i, ev in enumerate(body) if ev["type"] == "task_posted"]
    before_tasks = body[: posted_positions[0]] if posted_positions else body
    if any(ev["type"] not in {"incident_status", "responders_selected", "error"} for ev in before_tasks):
        raise ValueError("only incident_status and responders_selected may precede the first task")

    task_failed = False
    types: list[str] = []
    for n, start in enumerate(posted_positions):
        end = posted_positions[n + 1] if n + 1 < len(posted_positions) else len(body)
        segment = body[start:end]
        posted = segment[0]["data"]
        if posted["type"] not in INCIDENT_TASK_TYPES:
            raise ValueError(f"incident task {posted['task_id']} has non-incident type")
        if posted["task_id"] != f"t{n + 1}" or posted["index"] != n:
            raise ValueError("incident task ids must be t1..tN in order")
        types.append(posted["type"])
        core = [ev for ev in segment if ev["type"] not in INCIDENT_EVENTS]
        task_failed |= _validate_task_segment(core, posted, posted["index"], posted["total"])
        _validate_incident_task(segment, posted)

    if types:
        remediations = types[1 : len(types) - (types[-1] == "verify")]
        if types[0] != "diagnose" or any(t != "remediate" for t in remediations):
            raise ValueError("incident tasks must be diagnose, remediate..., then verify")

    approvals = [ev for ev in body if ev["type"] == "approval_required"]
    if len(approvals) > 1:
        raise ValueError("an incident has at most one approval_required")
    passed = [ev for ev in body if ev["type"] == "sandbox_result" and ev["data"]["passed"]]
    if approvals:
        approval = approvals[0]
        match = [ev for ev in passed if ev["data"]["task_id"] == approval["data"]["task_id"]]
        if not match or _position(body, match[0]) > _position(body, approval):
            raise ValueError("approval_required needs an earlier passing sandbox_result")
    if types and types[-1] == "verify":
        verify_at = posted_positions[-1]
        recovering = [ev for ev in statuses if ev["data"]["status"] == "recovering"]
        if not approvals or _position(body, approvals[0]) > verify_at:
            raise ValueError("verify may only run after approval_required")
        if not recovering or _position(body, recovering[0]) > verify_at:
            raise ValueError("verify may only run while recovering")

    restored = [ev for ev in body if ev["type"] == "service_restored"]
    status = events[-1]["data"]["status"]
    if restored:
        if len(restored) != 1 or not types or types[-1] != "verify":
            raise ValueError("service_restored requires exactly one verify task")
        after = body[_position(body, restored[0]) + 1 :]
        if [ev["data"]["status"] for ev in after if ev["type"] == "incident_status"] != ["restored"]:
            raise ValueError("service_restored must be followed by incident_status 'restored'")
        if status != "ok" or task_failed:
            raise ValueError("a restored incident requires final.status='ok'")
    else:
        if statuses[-1]["data"]["status"] == "restored":
            raise ValueError("an incident cannot be restored without service_restored")
        if status == "ok":
            raise ValueError("an unrestored incident cannot have final.status='ok'")


def _validate_incident_task(segment: list[dict], posted: dict) -> None:
    task_id = posted["task_id"]
    kinds = [ev["type"] for ev in segment]
    for ev in segment:
        if ev["type"] in {"remediation_proposed", "sandbox_result", "approval_required"}:
            if ev["data"]["task_id"] != task_id:
                raise ValueError(f"{ev['type']} for another task appears in {task_id}")
    if posted["type"] != "remediate":
        if "remediation_proposed" in kinds or "sandbox_result" in kinds:
            raise ValueError(f"{posted['type']} task {task_id} cannot propose repairs")
        return
    if "graded" not in kinds:
        return
    order = [kinds.index(kind) if kind in kinds else -1 for kind in
             ("done", "remediation_proposed", "sandbox_result", "graded")]
    if -1 in order or order != sorted(order):
        raise ValueError(f"remediate task {task_id} must be done -> proposed -> sandbox -> graded")
    proposal = segment[order[1]]["data"]
    sandbox = segment[order[2]]["data"]
    if sandbox["passed"] and not proposal["valid"]:
        raise ValueError(f"task {task_id} passed the sandbox with a rejected proposal")
    if sandbox["action"] != proposal["action"] or sandbox["attempt"] != proposal["attempt"]:
        raise ValueError(f"task {task_id} sandbox_result does not match its proposal")


def validate_stream(events: list[dict]) -> None:
    if not events:
        raise ValueError("event stream is empty")
    for index, ev in enumerate(events):
        try:
            validate_event(ev)
        except Exception as exc:
            raise ValueError(f"event {index}: {exc}") from exc

    if events[0]["type"] != "hello" or events[0]["seq"] != 0:
        raise ValueError("stream must start with hello at seq 0")
    if events[-1]["type"] != "final":
        raise ValueError("final must be the last event")
    for previous, current in zip(events, events[1:]):
        if current["seq"] <= previous["seq"]:
            raise ValueError("seq must be strictly increasing")

    jobs: dict[str, list[dict]] = {}
    for ev in events:
        if ev["job_id"] is not None:
            jobs.setdefault(ev["job_id"], []).append(ev)
    if not jobs:
        raise ValueError("stream contains no job")
    for job_id, job_events in jobs.items():
        if job_events[0]["type"] == "incident_status":
            _validate_incident(job_id, job_events)
        else:
            _validate_job(job_id, job_events)


def _first_error(exc: Exception) -> str:
    errors = getattr(exc, "errors", None)
    if callable(errors):
        first = errors()[0]
        location = ".".join(str(part) for part in first["loc"])
        return f"{location}: {first['msg']}"
    return str(exc).splitlines()[0]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate an Abyss event recording")
    parser.add_argument("file", type=Path)
    args = parser.parse_args(argv)
    try:
        events = json.loads(args.file.read_text(encoding="utf-8"))
        if not isinstance(events, list):
            raise ValueError("recording root must be a JSON array")
        validate_stream(events)
    except Exception as exc:
        print(f"ERROR {_first_error(exc)}", file=sys.stderr)
        return 1
    print(f"OK {len(events)} events")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
