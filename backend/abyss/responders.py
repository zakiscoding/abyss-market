"""Deterministic human rescue-team selection for MAYDAY."""
from __future__ import annotations

from dataclasses import dataclass

from .incident import DEMAND, POOL_KEY, SERVICE


@dataclass(frozen=True)
class Person:
    responder_id: str
    name: str
    role: str
    skills: tuple[str, ...]
    available: bool
    workload: int


ROSTER = [
    Person("zak", "Zak", "Incident Commander", ("incident-command", "communication"), True, 1),
    Person("maya", "Maya", "Database Engineer", ("database", "connection-pooling", "postgres"), True, 1),
    Person("alex", "Alex", "Backend Engineer", ("payments-api", "backend", "deploys"), True, 2),
    Person("sam", "Sam", "Security Engineer", ("security", "auth", "secrets"), True, 0),
    Person("jordan", "Jordan", "Customer Support", ("customer-comms", "status-page"), True, 1),
]
SKILL_POINTS = 10
COMMAND_BONUS = 5
WORKLOAD_PENALTY = 2


def severity_for(telemetry: dict) -> str:
    if telemetry["payment_success_rate"] < 0.5:
        return "SEV-1"
    if telemetry["error_rate"] > 0.01:
        return "SEV-2"
    return "SEV-3"


def required_skills(telemetry: dict, config_changes: list[dict], severity: str) -> list[str]:
    skills: list[str] = []
    if severity == "SEV-1":
        skills.append("incident-command")
    if telemetry["db_waiting"] > 0 or any(c["key"] == POOL_KEY for c in config_changes):
        skills += ["database", "connection-pooling"]
    if telemetry["error_rate"] > 0.01:
        skills.append("payments-api")
    if telemetry["payment_success_rate"] < 0.99:
        skills.append("customer-comms")
    return skills


def select_responders(telemetry: dict, config_changes: list[dict]) -> dict:
    severity = severity_for(telemetry)
    needed = required_skills(telemetry, config_changes, severity)
    responders = []
    for person in ROSTER:
        matched = [skill for skill in person.skills if skill in needed]
        score = SKILL_POINTS * len(matched) - WORKLOAD_PENALTY * person.workload
        if "incident-command" in matched:
            score += COMMAND_BONUS
        selected = person.available and bool(matched) and score > 0
        if not person.available:
            reason = "Unavailable (off shift)."
        elif not matched:
            reason = f"No {', '.join(person.skills[:2])} signals in the evidence; stays on standby."
        else:
            reason = f"Matches {', '.join(matched)}; current workload {person.workload}."
        responders.append(
            {
                "responder_id": person.responder_id,
                "name": person.name,
                "role": person.role,
                "skills": list(person.skills),
                "available": person.available,
                "workload": person.workload,
                "score": float(score),
                "selected": selected,
                "reason": reason,
            }
        )
    return {
        "severity": severity,
        "required_skills": needed,
        "responders": responders,
        "briefings": briefings(telemetry, config_changes, severity),
    }


def briefings(telemetry: dict, config_changes: list[dict], severity: str) -> dict:
    t = telemetry
    failed_per_min = round(t["requests_per_min"] * t["error_rate"])
    change = next((c for c in reversed(config_changes) if c["key"] == POOL_KEY), None)
    change_text = (
        f"{change['key']} changed {change['old']} -> {change['new']} by {change['author']} "
        f"{change['minutes_ago']} min before the alert"
        if change
        else "no recent config change"
    )
    return {
        "engineering": (
            f"{SERVICE}: pool {t['db_pool_in_use']}/{t['db_pool_size']} in use, {t['db_waiting']} waiting "
            f"(needs {DEMAND}); p95 {t['p95_latency_ms']}ms; {t['timeouts_per_min']} timeouts/min. "
            f"Evidence: {change_text}."
        ),
        "support": (
            f"Card payments are failing for about {t['error_rate'] * 100:.0f}% of customers "
            f"({failed_per_min}/min). Post a status-page notice; no customer action is needed."
        ),
        "commander": (
            f"{severity} declared. AI diagnosis, then sandboxed repair; you approve before anything "
            f"touches production. Suspect: {change_text}."
        ),
        "leadership": (
            f"Checkout is down for {t['error_rate'] * 100:.0f}% of payments ({failed_per_min} failed "
            f"payments/min). Team engaged; fix will be tested before release."
        ),
    }
