"""Deterministic Payments API simulator.

No AI output is ever executed here. A remediation is parsed into one of three
allowlisted actions and applied as plain data to an in-memory model whose
telemetry is derived from the database connection pool size.
"""
from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field

SERVICE = "payments-api"
HEALTHY_POOL_SIZE = 20
BROKEN_POOL_SIZE = 2
PEAK_CONNECTIONS = 18
REQUESTS_PER_MIN = 1200
PAYMENT_SHARE = 0.5
BASE_P95_MS = 120
SATURATION_P95_MS = 4800
BASE_ERROR_RATE = 0.002
SATURATION_ERROR_RATE = 0.6
MAX_ERROR_RATE = 0.01
MAX_P95_MS = 300
MIN_PAYMENT_SUCCESS = 0.99

ALLOWED_ACTIONS = ("set_db_pool_size", "restart_service", "rollback_config")
POOL_KEY = "db.pool.max_size"
BAD_CHANGE = {
    "change_id": "cfg-2291",
    "key": POOL_KEY,
    "old": str(HEALTHY_POOL_SIZE),
    "new": str(BROKEN_POOL_SIZE),
    "author": "deploy-bot",
    "minutes_ago": 4,
}


class ActionRejected(ValueError):
    pass


def parse_action(raw: str | dict) -> dict:
    """Return {"action", "value"} for an allowlisted action or raise ActionRejected."""
    obj = _json_object(raw) if isinstance(raw, str) else raw
    if not isinstance(obj, dict):
        raise ActionRejected("remediation must be a JSON object")
    action = obj.get("action")
    if action not in ALLOWED_ACTIONS:
        raise ActionRejected(f"action {action!r} is not on the allowlist")
    if action == "set_db_pool_size":
        if set(obj) != {"action", "value"}:
            raise ActionRejected("set_db_pool_size takes exactly one integer value")
        value = obj["value"]
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100:
            raise ActionRejected("value must be an integer from 1 to 100")
        return {"action": action, "value": value}
    if set(obj) != {"action"}:
        raise ActionRejected(f"{action} takes no parameters")
    return {"action": action, "value": None}


def _json_object(text: str) -> object:
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


def describe_action(action: dict) -> str:
    if action["action"] == "set_db_pool_size":
        return f"set_db_pool_size({action['value']})"
    return action["action"]


@dataclass
class PaymentsSimulator:
    pool_size: int = HEALTHY_POOL_SIZE
    restarts: int = 0
    changes: list[dict] = field(default_factory=list)

    def reset(self) -> None:
        self.pool_size = HEALTHY_POOL_SIZE
        self.restarts = 0
        self.changes = []

    def break_production(self) -> None:
        self.pool_size = BROKEN_POOL_SIZE
        self.changes.append(dict(BAD_CHANGE))

    def telemetry(self) -> dict:
        in_use = min(self.pool_size, PEAK_CONNECTIONS)
        shortfall = 1 - in_use / PEAK_CONNECTIONS
        error_rate = round(BASE_ERROR_RATE + shortfall * SATURATION_ERROR_RATE, 4)
        return {
            "db_pool_size": self.pool_size,
            "db_connections_in_use": in_use,
            "p95_latency_ms": round(BASE_P95_MS + shortfall * SATURATION_P95_MS),
            "error_rate": error_rate,
            "payment_success_rate": round(1 - error_rate, 4),
            "requests_per_min": REQUESTS_PER_MIN,
            "timeouts_per_min": round(REQUESTS_PER_MIN * shortfall * SATURATION_ERROR_RATE),
            "failed_payments_per_min": round(REQUESTS_PER_MIN * PAYMENT_SHARE * error_rate),
        }

    def health_checks(self) -> list[dict]:
        t = self.telemetry()
        return [
            _check("error rate", t["error_rate"] <= MAX_ERROR_RATE,
                   f"{t['error_rate']:.1%} (limit {MAX_ERROR_RATE:.0%})"),
            _check("p95 latency", t["p95_latency_ms"] <= MAX_P95_MS,
                   f"{t['p95_latency_ms']} ms (limit {MAX_P95_MS} ms)"),
            _check("payment success", t["payment_success_rate"] >= MIN_PAYMENT_SUCCESS,
                   f"{t['payment_success_rate']:.1%} (min {MIN_PAYMENT_SUCCESS:.0%})"),
            _check("connection timeouts", t["timeouts_per_min"] == 0,
                   f"{t['timeouts_per_min']}/min"),
        ]

    def healthy(self) -> bool:
        return all(check["passed"] for check in self.health_checks())

    def apply(self, action: dict) -> None:
        action = parse_action({k: v for k, v in action.items() if not (k == "value" and v is None)})
        if action["action"] == "set_db_pool_size":
            self.changes.append({
                "change_id": f"cfg-{2292 + len(self.changes)}",
                "key": POOL_KEY,
                "old": str(self.pool_size),
                "new": str(action["value"]),
                "author": "mayday",
                "minutes_ago": 0,
            })
            self.pool_size = action["value"]
        elif action["action"] == "restart_service":
            # A restart re-reads the same config, so a bad pool size survives it.
            self.restarts += 1
        elif action["action"] == "rollback_config" and self.changes:
            last = self.changes.pop()
            if last["key"] == POOL_KEY:
                self.pool_size = int(last["old"])

    def sandbox(self, action: dict) -> tuple[bool, list[dict], dict]:
        """Try an action on a copy of the service; production is untouched."""
        clone = copy.deepcopy(self)
        clone.apply(action)
        checks = [_check("allowlisted action", True, describe_action(action))]
        checks += clone.health_checks()
        return all(check["passed"] for check in checks), checks, clone.telemetry()

    def logs(self) -> list[str]:
        t = self.telemetry()
        if self.healthy():
            return [
                f"INFO  {SERVICE} p95={t['p95_latency_ms']}ms errors={t['error_rate']:.1%} "
                f"pool={t['db_connections_in_use']}/{t['db_pool_size']}",
                f"INFO  payments processed {round(REQUESTS_PER_MIN * PAYMENT_SHARE)}/min",
            ]
        lines = [
            f"ERROR {SERVICE} HTTP 500 POST /v1/payments: "
            f"TimeoutError acquiring DB connection after 5000ms",
            f"WARN  db pool exhausted: {t['db_connections_in_use']}/{t['db_pool_size']} "
            f"in use, {PEAK_CONNECTIONS - t['db_connections_in_use']} requests waiting",
            f"ERROR {t['failed_payments_per_min']} payments failed in the last minute",
            f"WARN  p95 latency {t['p95_latency_ms']}ms (SLO {MAX_P95_MS}ms)",
        ]
        for change in self.changes:
            lines.append(
                f"INFO  config {change['change_id']} by {change['author']}: "
                f"{change['key']} {change['old']} -> {change['new']}"
            )
        return lines


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": passed, "detail": detail}
