"""Deterministic human paging and step ownership. No LLM decides who approves what."""
from __future__ import annotations

from .incident import describe_action

ROSTER = [
    {"responder_id": "zak", "name": "Zak", "role": "Incident Commander",
     "skills": {"incident_command", "communication"}, "available": True, "workload": 1},
    {"responder_id": "maya", "name": "Maya", "role": "Database Engineer",
     "skills": {"database", "connection_pooling", "postgres"}, "available": True, "workload": 2},
    {"responder_id": "alex", "name": "Alex", "role": "Backend Engineer",
     "skills": {"payments_api", "backend", "deploys"}, "available": True, "workload": 1},
    {"responder_id": "riley", "name": "Riley", "role": "Network Engineer",
     "skills": {"networking", "routing", "cdn"}, "available": True, "workload": 1},
    {"responder_id": "sam", "name": "Sam", "role": "Security Engineer",
     "skills": {"security", "auth", "access_control"}, "available": True, "workload": 0},
    {"responder_id": "jordan", "name": "Jordan", "role": "Customer Support Lead",
     "skills": {"customer_comms", "support"}, "available": True, "workload": 3},
]
DOMAIN_SKILLS = {
    "database": ["database", "postgres"],
    "networking": ["networking", "routing"],
    "security": ["security", "auth"],
    "payments": ["payments_api", "backend"],
    "generalist": ["backend", "deploys"],
}
# Which specialty owns each production action, and the skills that may approve it
# (first match wins, so a network change falls back to a backend engineer).
ACTION_OWNERS = {
    "set_db_pool_size": ("database", ["database"]),
    "restart_db": ("database", ["database"]),
    "failover_db": ("database", ["database"]),
    "route_traffic": ("networking", ["networking", "backend"]),
    "apply_rate_limit": ("security", ["security"]),
    "block_ips": ("security", ["security"]),
    "restart_service": ("generalist", ["backend"]),
    "rollback_config": ("generalist", ["backend"]),
}
CUSTOMER_METRIC_TOKENS = ("error", "success", "reachability")


def customer_impact(telemetry: list[dict]) -> bool:
    return any(not item["ok"] and any(t in item["key"] for t in CUSTOMER_METRIC_TOKENS) for item in telemetry)


def required_skills(domain: str, secondary: list[str], severity: str | None, impact: bool) -> list[str]:
    skills: list[str] = []
    if severity == "SEV-1":
        skills.append("incident_command")
    for area in [domain, *secondary]:
        skills += [skill for skill in DOMAIN_SKILLS[area] if skill not in skills]
    if impact:
        skills += ["customer_comms", "support"]
    return skills


def select_responders(required: list[str], severity: str | None) -> list[dict]:
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
    return responders


def owner_domain(step: dict) -> str:
    return ACTION_OWNERS[step["action"]][0]


def _owner(step: dict) -> dict:
    for skill in ACTION_OWNERS[step["action"]][1]:
        for person in ROSTER:
            if person["available"] and skill in person["skills"]:
                return person
    return ROSTER[0]


def assign(steps: list[dict], severity: str | None, responders: list[dict], impact: bool) -> tuple[list[dict], list[str]]:
    """One approval per plan step from its owner, SEV-1 sign-off, and a customer update."""
    paged = {r["responder_id"] for r in responders if r["selected"]}
    items: list[dict] = []

    def add(step_index, step, description, person, reason, approval):
        items.append({
            "assignment_id": f"a{len(items) + 1}",
            "step_index": step_index,
            "action": step,
            "description": description,
            "responder_id": person["responder_id"],
            "name": person["name"],
            "role": person["role"],
            "reason": reason,
            "approval_required": approval,
            "status": "pending" if approval else "notify",
        })

    for index, step in enumerate(steps):
        person = _owner(step)
        reason = f"{person['role']} owns {owner_domain(step)} changes."
        if person["responder_id"] not in paged:
            reason += " Paged for this step."
        add(index, step, f"Execute {describe_action(step)}", person, reason, True)
    if severity == "SEV-1":
        commander = next(p for p in ROSTER if "incident_command" in p["skills"])
        add(None, None, "Final go/no-go for a SEV-1 production change", commander,
            "SEV-1 changes need the Incident Commander's sign-off.", True)
    if impact:
        support = next(p for p in ROSTER if "customer_comms" in p["skills"])
        add(None, None, "Send the customer update", support,
            "Customers are affected; support owns communication.", False)

    approvers: list[str] = []
    for item in items:
        if item["approval_required"] and item["name"] not in approvers:
            approvers.append(item["name"])
    return items, approvers
