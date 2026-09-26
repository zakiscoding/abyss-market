"""The MAYDAY AI Commander.

It reads a compressed incident package (not the full context), classifies the
domain and severity, and decides which specialist market receives the full
incident. Deterministic rules always run: they are the fallback when a model
call fails or returns invalid data, and severity can never drop below them.
The Commander only routes work; it never produces or executes remediation.
"""
from __future__ import annotations

import json
import logging

from . import config, prompts, safety
from .agents import est_input_tokens
from .incident import Scenario
from .ledger import Ledger
from .llm import LLM, LLMError

logger = logging.getLogger(__name__)

LOG_EXCERPT_LINES = 4
SEVERITY_RANK = {"SEV-3": 0, "SEV-2": 1, "SEV-1": 2}
# The deterministic winner conflicts strongly when it leads by this many points
# and is at least twice the model domain's score.
STRONG_LEAD = 4

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


def package_from_prompt(user: str) -> dict:
    """Read the incident package JSON out of a commander user message."""
    start = user.find("{")
    end = user.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("incident package missing")
    loaded = json.loads(user[start : end + 1])
    if not isinstance(loaded, dict):
        raise ValueError("incident package must be an object")
    return loaded


def _commander_user(package: dict) -> str:
    # The model sees a redacted copy. Callers keep the original package for scoring.
    safe = safety.for_model(package)
    body = prompts.COMMANDER_USER.format(package=json.dumps(safe, sort_keys=True))
    return safety.cap_context(body)


def _ranked_domains(scores: dict[str, int]) -> list[str]:
    return sorted(
        (domain for domain in scores if scores[domain] > 0),
        key=lambda domain: (-scores[domain], config.DOMAINS.index(domain)),
    )


def domain_supported(domain: str, scores: dict[str, int]) -> bool:
    """A specialist domain needs a positive score. Generalist is only supported when none do."""
    if domain == "generalist":
        return not _ranked_domains(scores)
    return scores.get(domain, 0) > 0


def conflicts_strongly(domain: str, scores: dict[str, int]) -> bool:
    ranked = _ranked_domains(scores)
    if not ranked:
        return domain != "generalist"
    winner = ranked[0]
    if domain == winner:
        return False
    if domain == "generalist" or domain not in scores:
        return True
    model_score = scores[domain]
    winner_score = scores[winner]
    return winner_score >= model_score * 2 and winner_score - model_score >= STRONG_LEAD


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
    ranked = _ranked_domains(scores)
    domain = ranked[0] if ranked else "generalist"
    secondary = ranked[1:3]
    severity, why = rules_severity(package)
    evidence = ", ".join(f"{d} {scores[d]}" for d in ranked) or "no domain signals"
    rationale = f"Signal scores: {evidence}. {severity} because {why}."
    return {"domain": domain, "secondary_domains": secondary, "severity": severity, "rationale": rationale[:300]}


def apply_domain_guardrails(decision: dict, package: dict, usage: dict | None) -> dict:
    """Keep a model domain only when deterministic evidence supports it."""
    scores = domain_scores(package)
    rules = rules_classify(package)
    domain = decision["domain"]
    if domain == "generalist" and _ranked_domains(scores):
        reason = f"rejected generalist: evidence supports {rules['domain']}"
        return {**rules, "source": "rules", "fallback_reason": reason[:200], "usage": usage}
    if not domain_supported(domain, scores):
        reason = f"rejected model domain {domain}: no supporting evidence"
        return {**rules, "source": "rules", "fallback_reason": reason[:200], "usage": usage}
    if conflicts_strongly(domain, scores):
        reason = f"rejected model domain {domain}: conflicts with evidence for {rules['domain']}"
        return {**rules, "source": "rules", "fallback_reason": reason[:200], "usage": usage}

    notes: list[str] = []
    secondary: list[str] = []
    for item in decision["secondary_domains"]:
        if item == domain or item in secondary or scores.get(item, 0) <= 0:
            continue
        secondary.append(item)
    secondary = secondary[:2]
    if secondary != decision["secondary_domains"]:
        notes.append("unsupported secondary domains removed")

    severity = decision["severity"]
    rationale = decision["rationale"]
    if SEVERITY_RANK[severity] < SEVERITY_RANK[rules["severity"]]:
        severity = rules["severity"]
        rationale = f"{rationale} Severity raised to {rules['severity']} by rules."[:300]
        notes.append(f"severity raised to {rules['severity']}")
    return {
        "domain": domain,
        "secondary_domains": secondary,
        "severity": severity,
        "rationale": rationale,
        "source": "model",
        "fallback_reason": "; ".join(notes)[:200] if notes else None,
        "usage": usage,
    }


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
    """Return the commander_classified fields (without required_specialties).

    Domain scores are always computed from the original package. The model only
    sees a redacted copy, and a domain with no evidence cannot win.
    """
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
        logger.error("commander model failed: %s", safety.redact_text(str(exc), limit=safety.MAX_ERROR))
        return {**rules, "source": "rules", "fallback_reason": "commander model failed", "usage": None}
    try:
        decision = _validated(result.data)
    except ValueError as exc:
        reason = safety.redact_text(f"invalid commander output: {exc}", limit=safety.MAX_ERROR)
        return {**rules, "source": "rules", "fallback_reason": reason, "usage": result.usage}
    return apply_domain_guardrails(decision, package, result.usage)


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
            f"Only the {eligible} {config.DOMAIN_LABELS[domain]} specialist routes receive the full "
            f"incident; {len(specialists) - eligible} other specialist routes are skipped. "
            f"The routes share {len(config.AGENTS)} underlying models."
        ),
    }
