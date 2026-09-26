"""Deterministic human rescue-team selection and audience-specific briefings."""
from __future__ import annotations

from .incident import MAX_ERROR_RATE, SERVICE

# Assumed average checkout value, used only to express failed payments in dollars.
AVG_ORDER_USD = 42

ROSTER = [
    {"responder_id": "zak", "name": "Zak", "role": "Incident Commander",
     "skills": {"incident_command", "communication"}, "available": True, "workload": 1},
    {"responder_id": "maya", "name": "Maya", "role": "Database Engineer",
     "skills": {"database", "connection_pooling", "postgres"}, "available": True, "workload": 2},
    {"responder_id": "alex", "name": "Alex", "role": "Backend Engineer",
     "skills": {"payments_api", "backend", "deploys"}, "available": True, "workload": 1},
    {"responder_id": "sam", "name": "Sam", "role": "Security Engineer",
     "skills": {"security", "auth", "access_control"}, "available": True, "workload": 0},
    {"responder_id": "jordan", "name": "Jordan", "role": "Customer Support Lead",
     "skills": {"customer_comms", "support"}, "available": True, "workload": 3},
]


def required_skills(telemetry: dict, changes: list[dict], severity: str | None) -> list[str]:
    skills: list[str] = []
    if severity == "SEV-1":
        skills.append("incident_command")
    if telemetry["timeouts_per_min"] > 0 or any(c["key"].startswith("db.") for c in changes):
        skills += ["database", "connection_pooling"]
    if telemetry["error_rate"] > MAX_ERROR_RATE:
        skills.append("payments_api")
    if telemetry["failed_payments_per_min"] > 0:
        skills.append("customer_comms")
    return skills


def select_responders(
    telemetry: dict, changes: list[dict], severity: str | None
) -> tuple[list[str], list[dict]]:
    required = required_skills(telemetry, changes, severity)
    # A SEV-1 pages anyone with one matching skill; lower severities need two.
    threshold = 1 if severity == "SEV-1" else 2
    responders = []
    for person in ROSTER:
        matched = sorted(person["skills"] & set(required))
        score = len(matched) * 10 - person["workload"] * 2
        selected = person["available"] and len(matched) >= threshold
        if not person["available"]:
            reason = "Unavailable right now."
        elif not matched:
            reason = f"No {'/'.join(sorted(person['skills']))} signal in this incident."
        elif not selected:
            reason = f"Only {len(matched)} matching skill for a {severity}."
        else:
            reason = f"Matches {', '.join(matched)}; {person['workload']} open tickets."
        responders.append({
            "responder_id": person["responder_id"],
            "name": person["name"],
            "role": person["role"],
            "selected": selected,
            "score": score,
            "matched_skills": matched,
            "available": person["available"],
            "workload": person["workload"],
            "reason": reason,
        })
    return required, responders


def briefings(
    telemetry: dict, changes: list[dict], severity: str | None, responders: list[dict]
) -> dict:
    team = ", ".join(r["name"] for r in responders if r["selected"])
    failing = 1 - telemetry["payment_success_rate"]
    change = changes[-1] if changes else None
    change_text = (
        f"{change['change_id']} by {change['author']} set {change['key']} "
        f"{change['old']} -> {change['new']} {change['minutes_ago']} min before alerts"
        if change else "no recent config change"
    )
    at_risk = telemetry["failed_payments_per_min"] * AVG_ORDER_USD
    return {
        "engineering": (
            f"{telemetry['db_connections_in_use']}/{telemetry['db_pool_size']} DB connections in use, "
            f"{telemetry['timeouts_per_min']}/min connection timeouts, p95 {telemetry['p95_latency_ms']} ms, "
            f"HTTP 500 rate {telemetry['error_rate']:.1%}. Suspect: {change_text}."
        ),
        "support": (
            f"About {failing:.0%} of checkouts are failing ({telemetry['failed_payments_per_min']}/min). "
            "Tell customers payments are degraded, a fix is being tested, and to retry shortly."
        ),
        "commander": (
            f"{severity} on {SERVICE}. Team: {team}. Timeline: {change_text}; alerts fired; "
            "AI diagnosis and repair auctions running. Your decision: approve a sandbox-tested repair."
        ),
        "leadership": (
            f"Payments are {failing:.0%} degraded: about {telemetry['failed_payments_per_min']} "
            f"failed checkouts per minute, roughly ${at_risk:,}/min in revenue at risk."
        ),
    }
