from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AgentSpec:
    agent_id: str
    display_name: str
    model: str
    color: str


AGENTS = [
    AgentSpec("haiku", "Haiku 4.5", "claude-haiku-4-5", "#4fb3a9"),
    AgentSpec("sonnet", "Sonnet 5", "claude-sonnet-5", "#e8a33d"),
    AgentSpec("opus", "Opus 5", "claude-opus-5", "#8e6cc9"),
]

PRICES: dict[str, tuple[float, float]] = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-opus-5": (5.0, 25.0),
}
SUPPORTS_EFFORT: set[str] = {"claude-sonnet-5", "claude-opus-5"}
TASK_TYPES: list[str] = ["research", "writing", "checking"]
INCIDENT_TASK_TYPES: list[str] = ["diagnose", "remediate", "verify"]
ALL_TASK_TYPES: list[str] = TASK_TYPES + INCIDENT_TASK_TYPES
# Nominal output speed, used only to turn a bid's token estimate into an ETA.
TOKENS_PER_SEC: dict[str, float] = {
    "claude-haiku-4-5": 150.0,
    "claude-sonnet-5": 80.0,
    "claude-opus-5": 50.0,
}
MAX_REPAIR_ATTEMPTS = 3

# Specialist markets. A specialist is a domain role powered by one of the AGENTS'
# models; reputation for incident work is tracked per agent, domain and task type.
DOMAINS: list[str] = ["database", "networking", "security", "payments", "generalist"]
DOMAIN_LABELS: dict[str, str] = {
    "database": "Database Specialist",
    "networking": "Networking Specialist",
    "security": "Security Specialist",
    "payments": "Payments Specialist",
    "generalist": "Generalist",
}
SPECIALIST_MODELS: dict[str, list[str]] = {domain: ["haiku", "sonnet", "opus"] for domain in DOMAINS}
REP_KEYS: list[str] = TASK_TYPES + [
    f"{domain}.{task_type}" for domain in DOMAINS for task_type in INCIDENT_TASK_TYPES
]


def rep_key(task_type: str, domain: str | None = None) -> str:
    return f"{domain}.{task_type}" if domain else task_type


def specialists() -> list[dict]:
    names = {agent.agent_id: agent.agent_id.title() for agent in AGENTS}
    return [
        {
            "specialist_id": f"{domain}.{agent_id}",
            "domain": domain,
            "agent_id": agent_id,
            "label": f"{DOMAIN_LABELS[domain]} · {names[agent_id]}",
        }
        for domain in DOMAINS
        for agent_id in SPECIALIST_MODELS[domain]
    ]

PRICE_WEIGHT = float(os.getenv("ABYSS_PRICE_WEIGHT", "1.0"))
REP_INIT = 1.0
REP_ALPHA = 0.3
REP_MIN = 0.0
REP_MAX = 2.0
MAX_TASKS = 5
WORK_EFFORT = "medium"
BID_EFFORT = "low"
REVIEW_EFFORT = "low"
SPLIT_EFFORT = "low"

ORCHESTRATOR_MODEL = "claude-sonnet-5"
REVIEWER_MODEL = "claude-sonnet-5"
REPO_ROOT = Path(__file__).resolve().parents[2]


def real_models() -> bool:
    return os.getenv("ABYSS_REAL_MODELS") == "1"


def fake_llm() -> bool:
    return os.getenv("ABYSS_FAKE_LLM") == "1"


def fake_delay() -> float:
    return float(os.getenv("ABYSS_FAKE_DELAY", "0.3"))


def ledger_path() -> Path:
    override = os.getenv("ABYSS_LEDGER_PATH")
    return Path(override) if override is not None else REPO_ROOT / "runs" / "ledger.jsonl"


def rep_path() -> Path:
    override = os.getenv("ABYSS_REP_PATH")
    return Path(override) if override is not None else REPO_ROOT / "runs" / "reputation.json"


def resolve_model(nominal: str) -> str:
    if real_models():
        return nominal
    return "claude-haiku-4-5"
