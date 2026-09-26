from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    model_validator,
)


AgentId = Literal["haiku", "sonnet", "opus"]
JobTaskType = Literal["research", "writing", "checking"]
IncidentTaskType = Literal["diagnose", "remediate", "verify"]
TaskType = Literal["research", "writing", "checking", "diagnose", "remediate", "verify"]
ALL_TASK_TYPES = ["research", "writing", "checking", "diagnose", "remediate", "verify"]
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
ActionName = Literal[
    "set_db_pool_size",
    "restart_service",
    "rollback_config",
    "restart_db",
    "failover_db",
    "route_traffic",
    "apply_rate_limit",
    "block_ips",
]
# The single parameter each action takes (None = no parameter).
ACTION_PARAMS: dict[str, str | None] = {
    "set_db_pool_size": "value",
    "restart_service": None,
    "rollback_config": None,
    "restart_db": "region",
    "failover_db": "region",
    "route_traffic": "region",
    "apply_rate_limit": "value",
    "block_ips": "ips",
}
VALUE_RANGES = {"set_db_pool_size": (1, 100), "apply_rate_limit": (1, 10000)}
Domain = Literal["database", "networking", "security", "payments", "generalist"]
DOMAINS = ["database", "networking", "security", "payments", "generalist"]
ScenarioId = Literal["payments_pool", "ams_db_outage", "auth_attack", "network_partition"]
SCENARIO_IDS = ["payments_pool", "ams_db_outage", "auth_attack", "network_partition"]
Region = Literal["ams", "fra", "iad", "sin"]
Severity = Literal["SEV-1", "SEV-2", "SEV-3"]
REP_KEYS = ["research", "writing", "checking"] + [
    f"{domain}.{task_type}" for domain in DOMAINS for task_type in ("diagnose", "remediate", "verify")
]
Probability = Annotated[float, Field(ge=0, le=1)]
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


def _check_rep_keys(values: dict[str, float]) -> dict[str, float]:
    if list(values) != REP_KEYS:
        raise ValueError("reputation keys must be REP_KEYS in order")
    return values


TaskReputation = Annotated[dict[str, float], AfterValidator(_check_rep_keys)]


class Reputation(ContractModel):
    haiku: TaskReputation
    sonnet: TaskReputation
    opus: TaskReputation


class ScenarioInfo(ContractModel):
    scenario_id: ScenarioId
    name: str
    service: str
    region: Region
    source_system: str
    alert: str
    allowed_actions: Annotated[list[ActionName], Field(min_length=1)]


class SpecialistInfo(ContractModel):
    specialist_id: str
    domain: Domain
    agent_id: AgentId
    label: str

    @model_validator(mode="after")
    def validate_id(self) -> "SpecialistInfo":
        if self.specialist_id != f"{self.domain}.{self.agent_id}":
            raise ValueError("specialist_id must be domain.agent_id")
        return self


class HelloConfig(ContractModel):
    price_weight: float
    rep_init: float
    rep_alpha: float
    task_types: list[TaskType]
    rep_keys: list[str]
    domains: list[Domain]
    specialists: Annotated[list[SpecialistInfo], Field(min_length=1)]
    scenarios: Annotated[list[ScenarioInfo], Field(min_length=1)]
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
        if self.config.task_types != ALL_TASK_TYPES:
            raise ValueError("task_types must contain the frozen task types in order")
        if self.config.rep_keys != REP_KEYS or self.config.domains != DOMAINS:
            raise ValueError("rep_keys and domains must match the frozen lists")
        if [s.scenario_id for s in self.config.scenarios] != SCENARIO_IDS:
            raise ValueError("scenarios must list every scenario id in order")
        return self


class SplitTask(ContractModel):
    task_id: TaskId
    type: JobTaskType
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
    domain: Domain | None

    @model_validator(mode="after")
    def validate_domain(self) -> "TaskPostedData":
        if (self.type in {"diagnose", "remediate", "verify"}) != (self.domain is not None):
            raise ValueError("incident tasks carry a domain; job tasks do not")
        return self


class BidData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    ok: StrictBool
    error: str | None
    predicted_output_tokens: NonNegativeInt | None
    est_input_tokens: NonNegativeInt | None
    predicted_cost_usd: NonNegativeFloat | None
    promised_quality: Annotated[int, Field(ge=1, le=10)] | None
    confidence: Probability | None
    eta_ms: NonNegativeInt | None
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
            self.promised_quality,
            self.confidence,
            self.eta_ms,
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


def _check_rep_key(rep_key: str, task_type: str) -> None:
    if rep_key not in REP_KEYS or rep_key.split(".")[-1] != task_type:
        raise ValueError("rep_key must be a REP_KEYS entry for task_type")


class RepUpdateData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    task_type: TaskType
    rep_key: str
    old: float
    new: float
    ratio: float

    @model_validator(mode="after")
    def validate_rep_key(self) -> "RepUpdateData":
        _check_rep_key(self.rep_key, self.task_type)
        return self


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


class Metric(ContractModel):
    key: str
    label: str
    value: float
    unit: Literal["ratio", "ms", "per_min", "count", "s"]
    ok: StrictBool

    @model_validator(mode="after")
    def validate_ratio(self) -> "Metric":
        if self.unit == "ratio" and not 0 <= self.value <= 1:
            raise ValueError("ratio metrics must be between 0 and 1")
        return self


Telemetry = Annotated[list[Metric], Field(min_length=1)]


class ConfigChange(ContractModel):
    change_id: str
    key: str
    old: str
    new: str
    author: str
    minutes_ago: NonNegativeInt


class IncidentStatusData(ContractModel):
    status: IncidentState
    scenario_id: ScenarioId
    service: str
    region: Region
    severity: Severity | None
    summary: str
    telemetry: Telemetry
    logs: list[str]
    config_changes: list[ConfigChange]


class Responder(ContractModel):
    responder_id: str
    name: str
    role: str
    selected: StrictBool
    score: float
    matched_skills: list[str]
    available: StrictBool
    workload: NonNegativeInt
    reason: str


class Briefings(ContractModel):
    engineering: str
    support: str
    commander: str
    leadership: str


class RespondersSelectedData(ContractModel):
    required_skills: list[str]
    responders: Annotated[list[Responder], Field(min_length=1)]
    briefings: Briefings


IPv4 = Annotated[str, Field(pattern=r"^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$")]


class RemediationAction(ContractModel):
    action: ActionName
    value: StrictInt | None
    region: Region | None
    ips: Annotated[list[IPv4], Field(min_length=1, max_length=16)] | None

    @model_validator(mode="after")
    def validate_params(self) -> "RemediationAction":
        param = ACTION_PARAMS[self.action]
        for key in ("value", "region", "ips"):
            if (getattr(self, key) is not None) != (key == param):
                raise ValueError(f"{self.action} takes {param or 'no parameter'}")
        if param == "value":
            low, high = VALUE_RANGES[self.action]
            if not low <= self.value <= high:
                raise ValueError(f"{self.action} value must be {low}-{high}")
        return self


PlanSteps = Annotated[list[RemediationAction], Field(min_length=1, max_length=4)]


class RemediationProposedData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    attempt: Annotated[int, Field(ge=1)]
    steps: Annotated[list[RemediationAction], Field(max_length=4)]
    accepted: StrictBool
    reason: Annotated[str, Field(max_length=200)]

    @model_validator(mode="after")
    def validate_accepted(self) -> "RemediationProposedData":
        if self.accepted != bool(self.steps):
            raise ValueError("accepted proposals carry steps; rejected ones do not")
        return self


class Check(ContractModel):
    name: str
    passed: StrictBool
    detail: str


class SandboxResultData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    attempt: Annotated[int, Field(ge=1)]
    steps: Annotated[list[RemediationAction], Field(max_length=4)]
    passed: StrictBool
    checks: Annotated[list[Check], Field(min_length=1)]
    telemetry: Telemetry

    @model_validator(mode="after")
    def validate_passed(self) -> "SandboxResultData":
        if self.passed != all(check.passed for check in self.checks):
            raise ValueError("passed must equal every check passing")
        if self.passed and not self.steps:
            raise ValueError("a passing sandbox run requires steps")
        return self


class IncidentPackage(ContractModel):
    service: str
    region: Region
    source_system: str
    alert: str
    breached: list[Metric]
    log_excerpt: Annotated[list[str], Field(max_length=4)]
    recent_changes: list[ConfigChange]


class IncidentReceivedData(ContractModel):
    scenario_id: ScenarioId
    name: str
    service: str
    region: Region
    source_system: str
    alert: str
    allowed_actions: Annotated[list[ActionName], Field(min_length=1)]
    package: IncidentPackage
    package_tokens_est: NonNegativeInt
    full_context_tokens_est: NonNegativeInt


class CommanderClassifiedData(ContractModel):
    scenario_id: ScenarioId
    domain: Domain
    secondary_domains: list[Domain]
    severity: Severity
    required_specialties: Annotated[list[str], Field(min_length=1)]
    rationale: Annotated[str, Field(max_length=300)]
    source: Literal["model", "rules"]
    fallback_reason: str | None
    usage: Usage | None

    @model_validator(mode="after")
    def validate_source(self) -> "CommanderClassifiedData":
        if (self.source == "rules") != (self.fallback_reason is not None):
            raise ValueError("rules classifications carry a fallback_reason; model ones do not")
        if self.source == "model" and self.usage is None:
            raise ValueError("model classifications carry usage")
        if self.domain in self.secondary_domains:
            raise ValueError("the primary domain cannot also be secondary")
        return self


class DispatchedSpecialist(SpecialistInfo):
    dispatched: StrictBool


class SpecialistsDispatchedData(ContractModel):
    domain: Domain
    registered: Annotated[int, Field(ge=1)]
    eligible: Annotated[int, Field(ge=1)]
    specialists: Annotated[list[DispatchedSpecialist], Field(min_length=1)]
    reason: str

    @model_validator(mode="after")
    def validate_counts(self) -> "SpecialistsDispatchedData":
        dispatched = [s for s in self.specialists if s.dispatched]
        if self.registered != len(self.specialists) or self.eligible != len(dispatched):
            raise ValueError("registered and eligible must count the specialist list")
        if any(s.domain != self.domain for s in dispatched):
            raise ValueError("only specialists of the classified domain may be dispatched")
        if sorted(s.agent_id for s in dispatched) != sorted({s.agent_id for s in dispatched}):
            raise ValueError("each model may be dispatched once")
        return self


class PlanStep(ContractModel):
    index: NonNegativeInt
    action: RemediationAction
    description: str
    owner_domain: Domain


class RemediationPlanData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    attempt: Annotated[int, Field(ge=1)]
    steps: Annotated[list[PlanStep], Field(min_length=1, max_length=4)]
    summary: str
    confidence: Probability

    @model_validator(mode="after")
    def validate_indices(self) -> "RemediationPlanData":
        if [step.index for step in self.steps] != list(range(len(self.steps))):
            raise ValueError("plan step indices must be 0..n-1")
        return self


class Assignment(ContractModel):
    assignment_id: Annotated[str, Field(pattern=r"^a[1-9][0-9]*$")]
    step_index: NonNegativeInt | None
    action: RemediationAction | None
    description: str
    responder_id: str
    name: str
    role: str
    reason: str
    approval_required: StrictBool
    status: Literal["pending", "notify"]

    @model_validator(mode="after")
    def validate_fields(self) -> "Assignment":
        if (self.step_index is None) != (self.action is None):
            raise ValueError("step assignments carry both step_index and action")
        if self.approval_required != (self.status == "pending"):
            raise ValueError("approval assignments start pending; others are notify")
        return self


class HumanAssignmentsData(ContractModel):
    task_id: TaskId
    assignments: Annotated[list[Assignment], Field(min_length=1)]
    required_approvers: Annotated[list[str], Field(min_length=1)]

    @model_validator(mode="after")
    def validate_approvers(self) -> "HumanAssignmentsData":
        names: list[str] = []
        for item in self.assignments:
            if item.approval_required and item.name not in names:
                names.append(item.name)
        if names != self.required_approvers:
            raise ValueError("required_approvers must list approval assignees in order")
        ids = [item.assignment_id for item in self.assignments]
        if ids != [f"a{i}" for i in range(1, len(ids) + 1)]:
            raise ValueError("assignment ids must be a1..aN")
        return self


class ApprovalRequiredData(ContractModel):
    task_id: TaskId
    agent_id: AgentId
    attempt: Annotated[int, Field(ge=1)]
    steps: PlanSteps
    summary: str
    approvers: Annotated[list[str], Field(min_length=1)]


class ApprovalGrantedData(ContractModel):
    task_id: TaskId
    approved: Annotated[list[str], Field(min_length=1)]
    approved_by: Annotated[list[str], Field(min_length=1)]


class IncidentEscalatedData(ContractModel):
    reason: Annotated[str, Field(max_length=200)]
    attempts: NonNegativeInt
    escalated_to: Annotated[list[str], Field(min_length=1)]


class RoutingStatsData(ContractModel):
    domain: Domain
    registered_specialists: Annotated[int, Field(ge=1)]
    eligible_specialists: Annotated[int, Field(ge=1)]
    auctions: NonNegativeInt
    models_contacted: NonNegativeInt
    models_skipped: NonNegativeInt
    actual_input_tokens: NonNegativeInt
    actual_output_tokens: NonNegativeInt
    actual_cost_usd: NonNegativeFloat
    actual_calls: NonNegativeInt
    commander_package_tokens_est: NonNegativeInt
    full_context_tokens_est: NonNegativeInt
    avoided_input_tokens_est: NonNegativeInt
    avoided_cost_usd_est: NonNegativeFloat
    method: str

    @model_validator(mode="after")
    def validate_counts(self) -> "RoutingStatsData":
        if self.models_contacted != self.eligible_specialists * self.auctions:
            raise ValueError("models_contacted must be eligible_specialists x auctions")
        skipped = (self.registered_specialists - self.eligible_specialists) * self.auctions
        if self.models_skipped != skipped:
            raise ValueError("models_skipped must be (registered - eligible) x auctions")
        return self


class RepChange(ContractModel):
    agent_id: AgentId
    task_type: TaskType
    rep_key: str
    old: float
    new: float

    @model_validator(mode="after")
    def validate_rep_key(self) -> "RepChange":
        _check_rep_key(self.rep_key, self.task_type)
        return self


class ServiceRestoredData(ContractModel):
    scenario_id: ScenarioId
    domain: Domain
    mttr_ms: NonNegativeInt
    total_cost_usd: NonNegativeFloat
    repair_attempts: Annotated[int, Field(ge=1)]
    failed_attempts: NonNegativeInt
    steps: PlanSteps
    confidence: Probability
    approved_by: Annotated[list[str], Field(min_length=1)]
    verification: Annotated[list[Check], Field(min_length=1)]
    grades: list["FinalTask"]
    rep_changes: list[RepChange]
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
    "incident_received": IncidentReceivedData,
    "commander_classified": CommanderClassifiedData,
    "specialists_dispatched": SpecialistsDispatchedData,
    "remediation_plan_created": RemediationPlanData,
    "human_assignments_created": HumanAssignmentsData,
    "approval_granted": ApprovalGrantedData,
    "incident_escalated": IncidentEscalatedData,
    "routing_stats": RoutingStatsData,
}

# Events that must open an incident, in this order.
INCIDENT_PREAMBLE = [
    "incident_received",
    "incident_status",
    "commander_classified",
    "specialists_dispatched",
    "responders_selected",
]
INCIDENT_LEVEL_EVENTS = {
    "incident_status",
    "responders_selected",
    "approval_required",
    "service_restored",
    "remediation_plan_created",
    "human_assignments_created",
    "approval_granted",
    "incident_escalated",
    "routing_stats",
}
REPAIR_EVENTS = {"remediation_proposed", "sandbox_result"}
STATUS_NEXT: dict[str, set[str]] = {
    "outage": {"investigating", "failed"},
    "investigating": {"repairing", "failed"},
    "repairing": {"awaiting_approval", "failed"},
    "awaiting_approval": {"recovering", "failed"},
    "recovering": {"restored", "failed"},
}
TASK_PHASE = {"diagnose": "investigating", "remediate": "repairing", "verify": "recovering"}


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
        domain = task.get("domain")
        expected_key = f"{domain}.{task['type']}" if domain else task["type"]
        if rep_update["rep_key"] != expected_key:
            raise ValueError(f"task {task_id} rep_update must use rep_key {expected_key!r}")
        cursor += 1

    if cursor == len(non_errors) or non_errors[cursor]["type"] != "stats":
        raise ValueError(f"task {task_id} successful result must end with stats")
    cursor += 1
    if cursor != len(non_errors):
        raise ValueError(f"unexpected {non_errors[cursor]['type']} after task {task_id}")
    return False


def _validate_repair_events(segment: list[dict], task_id: str, completed: bool) -> dict | None:
    """Remediate tasks put remediation_proposed then sandbox_result between done and graded."""
    types = [ev["type"] for ev in segment if ev["type"] != "error"]
    repairs = [ev for ev in segment if ev["type"] in REPAIR_EVENTS]
    if not completed:
        if repairs:
            raise ValueError(f"task {task_id} has repair events without done")
        return None
    if [ev["type"] for ev in repairs] != ["remediation_proposed", "sandbox_result"]:
        raise ValueError(f"task {task_id} needs remediation_proposed then sandbox_result")
    done_at = types.index("done")
    if types[done_at + 1 : done_at + 3] != ["remediation_proposed", "sandbox_result"]:
        raise ValueError(f"task {task_id} repair events must follow done")
    proposed, sandbox = repairs[0]["data"], repairs[1]["data"]
    for key in ("task_id", "agent_id", "attempt", "steps"):
        if proposed[key] != sandbox[key]:
            raise ValueError(f"task {task_id} sandbox_result {key} differs from the proposal")
    return sandbox


def _validate_incident(job_id: str, events: list[dict]) -> None:
    non_errors = [ev for ev in events if ev["type"] != "error"]
    if non_errors[-1]["type"] != "final":
        raise ValueError(f"final must be the last event for incident {job_id}")
    preamble = non_errors[: len(INCIDENT_PREAMBLE)]
    if [ev["type"] for ev in preamble] != INCIDENT_PREAMBLE:
        raise ValueError(f"incident {job_id} must open with {', '.join(INCIDENT_PREAMBLE)}")
    received, outage, classified, dispatched, _ = preamble
    if outage["data"]["status"] != "outage":
        raise ValueError(f"incident {job_id} must start with incident_status outage")
    scenario = received["data"]["scenario_id"]
    if outage["data"]["scenario_id"] != scenario or classified["data"]["scenario_id"] != scenario:
        raise ValueError("incident events must share one scenario_id")
    domain = classified["data"]["domain"]
    if dispatched["data"]["domain"] != domain:
        raise ValueError("specialists_dispatched must use the classified domain")
    dispatched_agents = sorted(s["agent_id"] for s in dispatched["data"]["specialists"] if s["dispatched"])
    if dispatched_agents != ["haiku", "opus", "sonnet"]:
        raise ValueError("each incident auction needs one dispatched specialist per model")

    status = "outage"
    task_types: list[str] = []
    passed_sandbox: dict | None = None
    plan: dict | None = None
    assignments: dict | None = None
    approval: dict | None = None
    granted: dict | None = None
    restored_event: dict | None = None
    escalated = False
    routing: dict | None = None
    once_only = {"incident_received", "commander_classified", "specialists_dispatched", "responders_selected"}
    body = events[events.index(preamble[-1]) + 1 : events.index(non_errors[-1])]
    index = 0
    while index < len(body):
        ev = body[index]
        kind = ev["type"]
        data = ev["data"]
        if routing is not None and kind != "error":
            raise ValueError("routing_stats must be the last event before final")
        if escalated and status != "failed" and kind not in {"incident_status", "error"}:
            raise ValueError("incident_escalated must be followed by incident_status failed")
        if kind in once_only:
            raise ValueError(f"{kind} may only appear once, at the start of the incident")
        if kind == "incident_status":
            new_status = data["status"]
            if data["scenario_id"] != scenario:
                raise ValueError("incident events must share one scenario_id")
            if new_status not in STATUS_NEXT.get(status, set()):
                raise ValueError(f"incident status cannot go from {status} to {new_status}")
            if new_status == "awaiting_approval" and assignments is None:
                raise ValueError("awaiting_approval requires human_assignments_created")
            if new_status == "recovering" and granted is None:
                raise ValueError("recovering requires approval_granted")
            if new_status == "failed" and not escalated:
                raise ValueError("failed requires incident_escalated first")
            status = new_status
        elif kind == "remediation_plan_created":
            if status != "repairing" or passed_sandbox is None or plan is not None:
                raise ValueError("remediation_plan_created must follow a passing sandbox run")
            same_run = all(data[key] == passed_sandbox[key] for key in ("task_id", "agent_id", "attempt"))
            if not same_run or [step["action"] for step in data["steps"]] != passed_sandbox["steps"]:
                raise ValueError("remediation_plan_created must describe the passing repair")
            plan = data
        elif kind == "human_assignments_created":
            if plan is None or assignments is not None or status != "repairing":
                raise ValueError("human_assignments_created must follow remediation_plan_created")
            if data["task_id"] != plan["task_id"]:
                raise ValueError("human_assignments_created must reference the plan")
            step_items = [item for item in data["assignments"] if item["step_index"] is not None]
            if [(item["step_index"], item["action"]) for item in step_items] != [
                (step["index"], step["action"]) for step in plan["steps"]
            ]:
                raise ValueError("every plan step needs exactly one assignment, in order")
            if not all(item["approval_required"] for item in step_items):
                raise ValueError("every plan step requires human approval")
            assignments = data
        elif kind == "approval_required":
            if status != "awaiting_approval" or approval is not None or assignments is None:
                raise ValueError("approval_required must follow a passing sandbox run")
            if data["task_id"] != passed_sandbox["task_id"] or data["steps"] != passed_sandbox["steps"]:
                raise ValueError("approval_required must reference the passing repair")
            if data["approvers"] != assignments["required_approvers"]:
                raise ValueError("approval_required approvers must match the assignments")
            approval = data
        elif kind == "approval_granted":
            if approval is None or granted is not None or status != "awaiting_approval":
                raise ValueError("approval_granted must follow approval_required")
            required = [item["assignment_id"] for item in assignments["assignments"] if item["approval_required"]]
            if data["task_id"] != approval["task_id"] or data["approved"] != required:
                raise ValueError("approval_granted must approve every required assignment")
            if data["approved_by"] != assignments["required_approvers"]:
                raise ValueError("approval_granted approved_by must match the required approvers")
            granted = data
        elif kind == "service_restored":
            if status != "restored" or restored_event is not None:
                raise ValueError("service_restored must follow incident_status restored")
            if data["steps"] != passed_sandbox["steps"] or data["scenario_id"] != scenario or data["domain"] != domain:
                raise ValueError("service_restored must describe the approved repair")
            if data["approved_by"] != granted["approved_by"]:
                raise ValueError("service_restored approved_by must match approval_granted")
            restored_event = ev
        elif kind == "incident_escalated":
            if escalated or status in {"restored", "failed"}:
                raise ValueError("incident_escalated may appear once, before failure")
            escalated = True
        elif kind == "routing_stats":
            if status not in {"restored", "failed"} or (status == "restored" and restored_event is None):
                raise ValueError("routing_stats must follow the incident outcome")
            if data["domain"] != domain or data["auctions"] != len(task_types):
                raise ValueError("routing_stats must match the domain and number of auctions")
            routing = data
        elif kind == "task_posted":
            end = index + 1
            while end < len(body) and body[end]["type"] not in INCIDENT_LEVEL_EVENTS | {"task_posted"}:
                end += 1
            segment = body[index:end]
            posted = data
            task_id, task_type = posted["task_id"], posted["type"]
            if task_id != f"t{len(task_types) + 1}":
                raise ValueError("incident task_ids must be t1..tN in execution order")
            if TASK_PHASE.get(task_type) != status:
                raise ValueError(f"{task_type} task {task_id} posted while incident is {status}")
            if posted["domain"] != domain:
                raise ValueError(f"task {task_id} must be posted to the {domain} market")
            if not task_types and task_type != "diagnose":
                raise ValueError("the first incident task must be diagnose")
            if task_type == "remediate" and plan is not None:
                raise ValueError("no repair may be auctioned after a plan passed")
            core = [candidate for candidate in segment if candidate["type"] not in REPAIR_EVENTS]
            failed = _validate_task_segment(core, posted, posted["index"], posted["total"])
            if task_type == "remediate":
                sandbox = _validate_repair_events(segment, task_id, not failed)
                if sandbox is not None and sandbox["passed"]:
                    passed_sandbox = sandbox
            elif any(candidate["type"] in REPAIR_EVENTS for candidate in segment):
                raise ValueError(f"{task_type} task {task_id} cannot carry repair events")
            task_types.append(task_type)
            index = end
            continue
        elif kind not in {"error", "stats"}:
            raise ValueError(f"unexpected {kind} outside an incident task")
        index += 1

    if routing is None:
        raise ValueError("routing_stats must precede final")
    final_status = non_errors[-1]["data"]["status"]
    if status == "restored":
        if restored_event is None or "verify" not in task_types:
            raise ValueError("a restored incident requires verify and service_restored")
        if final_status != "ok":
            raise ValueError("a restored incident requires final.status='ok'")
    elif status != "failed" or final_status != "error":
        raise ValueError("an unrestored incident must end failed with final.status='error'")


def _validate_job(job_id: str, events: list[dict]) -> None:
    if events[-1]["type"] != "final":
        raise ValueError(f"final must be the last event for job {job_id}")

    non_errors = [ev for ev in events if ev["type"] != "error"]
    if non_errors and non_errors[0]["type"] == "incident_received":
        _validate_incident(job_id, events)
        return
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
