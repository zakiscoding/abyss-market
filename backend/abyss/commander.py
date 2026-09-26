"""The MAYDAY AI Commander.

It reads a compressed incident package (not the full context), classifies the
domain and severity, and decides which specialist market receives the full
incident. Deterministic rules always run: they are the fallback when a model
call fails or returns invalid data, and severity can never drop below them.
The Commander only routes work; it never produces or executes remediation.
"""
from __future__ import annotations

import json

from . import config, prompts
from .agents import est_input_tokens
from .incident import Scenario
from .ledger import Ledger
from .llm import LLM, LLMError

LOG_EXCERPT_LINES = 4
SEVERITY_RANK = {"SEV-3": 0, "SEV-2": 1, "SEV-1": 2}

# Evidence that points at each specialist domain. Breached metric keys count
# double, a recent change under a domain's config prefix counts triple.
SIGNALS: dict[str, dict[str, tuple[str, ...]]] = {
    "database": {
        "metrics": ("db_", "replica_"),
        "words": ("postgres", "database", "db pool", "db connection", "replica", "pg-"),
        "changes": ("db.",),
    },
    "networking": {
        "metrics": ("reachability", "packet_loss"),
        "words": ("packet loss", "partition", "unreachable from", "timed out", "edge ", "routed"),
        "changes": ("transit.", "traffic.", "dns."),
    },
    "security": {
        "metrics": ("login", "malicious"),
        "words": ("credential", "brute", "malicious", "suspicious", "failed logins", "waf"),
        "changes": ("auth.", "waf."),
    },
    "payments": {
        "metrics": ("payment",),
        "words": ("payment",),
        "changes": ("payments.",),
    },
}


def incident_package(sim: Scenario) -> dict:
    return {
        "service": sim.service,
        "region": sim.region,
        "source_system": sim.source_system,
        "alert": sim.alert,
        "breached": [item for item in sim.telemetry() if not item["ok"]],
        "log_excerpt": sim.logs()[:LOG_EXCERPT_LINES],
        "recent_changes": [dict(change) for change in sim.changes],
    }


def package_tokens(package: dict) -> int:
    return est_input_tokens(prompts.COMMANDER_SYSTEM, _commander_user(package))


def full_context_tokens(sim: Scenario) -> int:
    """What classifying from the complete incident state would have cost to read."""
    full = {
        "service": sim.service,
        "region": sim.region,
        "source_system": sim.source_system,
        "alert": sim.alert,
        "telemetry": sim.telemetry(),
        "logs": sim.logs(),
        "changes": sim.changes,
        "health_checks": sim.health_checks(),
        "allowed_actions": list(sim.allowed_actions),
    }
    return est_input_tokens(prompts.COMMANDER_SYSTEM, prompts.COMMANDER_USER.format(package=json.dumps(full, sort_keys=True)))


def _commander_user(package: dict) -> str:
    return prompts.COMMANDER_USER.format(package=json.dumps(package, sort_keys=True))


def domain_scores(package: dict) -> dict[str, int]:
    text = " ".join([package["service"], package["alert"], *package["log_excerpt"]]).lower()
    scores = {}
    for domain, signals in SIGNALS.items():
        metrics = sum(any(token in item["key"] for token in signals["metrics"]) for item in package["breached"])
        words = sum(word in text for word in signals["words"])
        changes = sum(any(change["key"].startswith(p) for p in signals["changes"]) for change in package["recent_changes"])
        scores[domain] = 2 * metrics + words + 3 * changes
    return scores


def rules_severity(package: dict) -> tuple[str, str]:
    for item in package["breached"]:
        if item["unit"] != "ratio":
            continue
        if "error" in item["key"] and item["value"] >= 0.2:
            return "SEV-1", f"{item['label']} is {item['value']:.0%}"
        if ("success" in item["key"] or "reachability" in item["key"]) and item["value"] < 0.8:
            return "SEV-1", f"{item['label']} is {item['value']:.0%}"
    if package["breached"]:
        return "SEV-2", f"{len(package['breached'])} health targets breached, no majority outage"
    return "SEV-3", "no health target breached"


def rules_classify(package: dict) -> dict:
    scores = domain_scores(package)
    ranked = sorted((d for d in scores if scores[d] > 0), key=lambda d: (-scores[d], config.DOMAINS.index(d)))
    domain = ranked[0] if ranked else "generalist"
    secondary = ranked[1:3]
    severity, why = rules_severity(package)
    evidence = ", ".join(f"{d} {scores[d]}" for d in ranked) or "no domain signals"
    rationale = f"Signal scores: {evidence}. {severity} because {why}."
    return {"domain": domain, "secondary_domains": secondary, "severity": severity, "rationale": rationale[:300]}


def _validated(data: object) -> dict:
    if not isinstance(data, dict) or set(data) != {"domain", "secondary_domains", "severity", "rationale"}:
        raise ValueError("expected domain, secondary_domains, severity and rationale")
    domain, secondary = data["domain"], data["secondary_domains"]
    if domain not in config.DOMAINS:
        raise ValueError(f"unknown domain {domain!r}")
    if not isinstance(secondary, list) or any(d not in config.DOMAINS for d in secondary):
        raise ValueError("secondary_domains must list known domains")
    if data["severity"] not in SEVERITY_RANK:
        raise ValueError(f"unknown severity {data['severity']!r}")
    if not isinstance(data["rationale"], str) or not data["rationale"].strip():
        raise ValueError("rationale must be a non-empty string")
    unique = [d for i, d in enumerate(secondary) if d != domain and d not in secondary[:i]]
    return {
        "domain": domain,
        "secondary_domains": unique[:2],
        "severity": data["severity"],
        "rationale": data["rationale"].strip()[:300],
    }


async def classify(llm: LLM, ledger: Ledger, package: dict) -> dict:
    """Return the commander_classified fields (without required_specialties)."""
    rules = rules_classify(package)
    try:
        result = await llm.call(
            ledger=ledger,
            purpose="split",
            nominal_model=config.ORCHESTRATOR_MODEL,
            system=prompts.COMMANDER_SYSTEM,
            user=_commander_user(package),
            max_tokens=1024,
            effort=config.SPLIT_EFFORT,
            schema=prompts.COMMANDER_SCHEMA,
        )
    except LLMError as exc:
        return {**rules, "source": "rules", "fallback_reason": f"commander model failed: {exc}"[:200], "usage": None}
    try:
        decision = _validated(result.data)
    except ValueError as exc:
        return {**rules, "source": "rules", "fallback_reason": f"invalid commander output: {exc}"[:200],
                "usage": result.usage}
    if SEVERITY_RANK[decision["severity"]] < SEVERITY_RANK[rules["severity"]]:
        decision["severity"] = rules["severity"]
        decision["rationale"] = f"{decision['rationale']} Severity raised to {rules['severity']} by rules."[:300]
    return {**decision, "source": "model", "fallback_reason": None, "usage": result.usage}


def dispatch(domain: str) -> dict:
    registry = config.specialists()
    specialists = [{**item, "dispatched": item["domain"] == domain} for item in registry]
    eligible = sum(item["dispatched"] for item in specialists)
    return {
        "domain": domain,
        "registered": len(specialists),
        "eligible": eligible,
        "specialists": specialists,
        "reason": (
            f"Only the {eligible} {config.DOMAIN_LABELS[domain]} models receive the full incident; "
            f"{len(specialists) - eligible} other specialists are skipped."
        ),
    }
