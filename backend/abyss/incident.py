"""Deterministic incident simulation core.

No AI output is ever executed here. A remediation is parsed into a short plan of
typed actions, each validated against the active scenario's allowlist, and
applied as plain data to an in-memory model of the service. Telemetry, logs and
health checks are derived from that model, so every run is reproducible.
"""
from __future__ import annotations

import copy
import ipaddress
import json
import re

REGIONS = ("ams", "fra", "iad", "sin")
MAX_PLAN_STEPS = 4
MAX_BLOCKED_IPS = 16

# Each action takes exactly one kind of parameter, or none.
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
ACTION_SIGNATURES = {
    "set_db_pool_size": '{"action": "set_db_pool_size", "value": <integer 1-100>}',
    "restart_service": '{"action": "restart_service"}',
    "rollback_config": '{"action": "rollback_config"}',
    "restart_db": '{"action": "restart_db", "region": "<region>"}',
    "failover_db": '{"action": "failover_db", "region": "<region>"}',
    "route_traffic": '{"action": "route_traffic", "region": "<region>"}',
    "apply_rate_limit": '{"action": "apply_rate_limit", "value": <logins per IP per minute, 1-10000>}',
    "block_ips": '{"action": "block_ips", "ips": ["<IPv4>", ...]}',
}
PARAM_KEYS = ("value", "region", "ips")


class ActionRejected(ValueError):
    pass


def action(name: str, *, value: int | None = None, region: str | None = None,
           ips: list[str] | None = None) -> dict:
    return {"action": name, "value": value, "region": region, "ips": ips}


def parse_action(raw: object, allowed: tuple[str, ...] | list[str]) -> dict:
    """Return a normalized action dict or raise ActionRejected."""
    if not isinstance(raw, dict):
        raise ActionRejected("each step must be a JSON object")
    name = raw.get("action")
    if name not in ACTION_PARAMS:
        raise ActionRejected(f"action {name!r} is not a known action")
    if name not in allowed:
        raise ActionRejected(f"{name} is not allowed for this incident")
    extra = set(raw) - {"action", *PARAM_KEYS}
    if extra:
        raise ActionRejected(f"{name} has unexpected keys: {', '.join(sorted(extra))}")
    param = ACTION_PARAMS[name]
    for key in PARAM_KEYS:
        if key != param and raw.get(key) is not None:
            raise ActionRejected(f"{name} does not take {key}")
    if param is None:
        return action(name)
    value = raw.get(param)
    if value is None:
        raise ActionRejected(f"{name} requires {param}")
    if param == "value":
        low, high = VALUE_RANGES[name]
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ActionRejected(f"{name} value must be an integer from {low} to {high}")
        return action(name, value=value)
    if param == "region":
        if value not in REGIONS:
            raise ActionRejected(f"region must be one of {', '.join(REGIONS)}")
        return action(name, region=value)
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_BLOCKED_IPS:
        raise ActionRejected(f"ips must be a list of 1 to {MAX_BLOCKED_IPS} IPv4 addresses")
    for ip in value:
        if not isinstance(ip, str):
            raise ActionRejected("ips must be IPv4 address strings")
        try:
            ipaddress.IPv4Address(ip)
        except ValueError:
            raise ActionRejected(f"{ip!r} is not an IPv4 address") from None
    if len(set(value)) != len(value):
        raise ActionRejected("ips must not repeat")
    return action(name, ips=list(value))


def parse_plan(raw: str | dict | list, allowed: tuple[str, ...] | list[str]) -> list[dict]:
    """Parse model output into 1..MAX_PLAN_STEPS allowlisted actions."""
    obj = _json_value(raw) if isinstance(raw, str) else raw
    if isinstance(obj, dict) and "steps" in obj:
        if set(obj) != {"steps"}:
            raise ActionRejected("a plan object may only contain steps")
        steps = obj["steps"]
    elif isinstance(obj, dict):
        steps = [obj]
    else:
        raise ActionRejected("remediation must be a JSON object")
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_PLAN_STEPS:
        raise ActionRejected(f"a plan needs 1 to {MAX_PLAN_STEPS} steps")
    parsed = [parse_action(step, allowed) for step in steps]
    if len({json.dumps(step, sort_keys=True) for step in parsed}) != len(parsed):
        raise ActionRejected("a plan must not repeat a step")
    return parsed


def _json_value(text: str) -> object:
    stripped = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL)
    if fenced:
        stripped = fenced.group(1)
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        start, end = stripped.find("{"), stripped.rfind("}")
        if start < 0 or end < start:
            raise ActionRejected("remediation is not JSON") from None
        try:
            return json.loads(stripped[start : end + 1])
        except json.JSONDecodeError:
            raise ActionRejected("remediation is not JSON") from None


def describe_action(step: dict) -> str:
    name = step["action"]
    if step.get("value") is not None:
        return f"{name}({step['value']})"
    if step.get("region") is not None:
        return f"{name}({step['region']})"
    if step.get("ips"):
        extra = f", +{len(step['ips']) - 1}" if len(step["ips"]) > 1 else ""
        return f"{name}({step['ips'][0]}{extra})"
    return name


def describe_plan(steps: list[dict]) -> str:
    return " + ".join(describe_action(step) for step in steps)


def metric(key: str, label: str, value: float, unit: str, ok: bool) -> dict:
    return {"key": key, "label": label, "value": value, "unit": unit, "ok": ok}


def check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": passed, "detail": detail}


class Scenario:
    """One simulated incident. Subclasses hold plain state and derive everything else."""

    scenario_id: str = ""
    name: str = ""
    service: str = ""
    region: str = ""
    source_system: str = ""
    alert: str = ""
    allowed_actions: tuple[str, ...] = ()
    # Fake-LLM scripts: a plausible wrong first plan, then the fix.
    decoy_plan: list[dict] = []
    fix_plan: list[dict] = []
    fake_diagnosis: str = ""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.changes: list[dict] = []
        self.broken = False
        self._reset_state()

    def break_production(self) -> None:
        self.broken = True
        self._break()

    def telemetry(self) -> list[dict]:
        raise NotImplementedError

    def health_checks(self) -> list[dict]:
        raise NotImplementedError

    def logs(self) -> list[str]:
        raise NotImplementedError

    def briefings(self, severity: str, team: str) -> dict:
        raise NotImplementedError

    def healthy(self) -> bool:
        return all(item["passed"] for item in self.health_checks())

    def apply(self, steps: list[dict]) -> None:
        for step in steps:
            self._apply_step(parse_action(step, self.allowed_actions))

    def sandbox(self, steps: list[dict]) -> tuple[bool, list[dict], list[dict]]:
        """Try a plan on a copy of the service; production is untouched."""
        clone = copy.deepcopy(self)
        clone.apply(steps)
        checks = [check("allowlisted plan", True, describe_plan(steps))]
        checks += clone.health_checks()
        return all(item["passed"] for item in checks), checks, clone.telemetry()

    def catalog(self) -> dict:
        return {
            "scenario_id": self.scenario_id,
            "name": self.name,
            "service": self.service,
            "region": self.region,
            "source_system": self.source_system,
            "alert": self.alert,
        }

    def _record_change(self, key: str, old: str, new: str) -> None:
        self.changes.append({
            "change_id": f"chg-{len(self.changes) + 1}",
            "key": key,
            "old": old,
            "new": new,
            "author": "mayday",
            "minutes_ago": 0,
        })

    def _reset_state(self) -> None:
        raise NotImplementedError

    def _break(self) -> None:
        raise NotImplementedError

    def _apply_step(self, step: dict) -> None:
        raise NotImplementedError
