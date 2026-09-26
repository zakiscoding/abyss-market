"""Deterministic Payments API simulator for MAYDAY.

Nothing here executes model output. A remediation is a JSON object that must
parse into one of three allowlisted actions; the simulator then applies it to a
copy of the service state (the sandbox) or, after human approval, to production.
Every metric is derived from the service state, so the numbers are consistent
wherever they are shown.
"""
from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field

SERVICE = "payments-api"
HEALTHY_POOL = 20
BROKEN_POOL = 2
# Concurrent DB connections the Payments API needs at REQUESTS_PER_MIN.
DEMAND = 14
REQUESTS_PER_MIN = 1200
BASE_P95_MS = 118
ACQUIRE_TIMEOUT_MS = 3000
BASE_ERROR_RATE = 0.002
MIN_POOL, MAX_POOL = 1, 50

P95_LIMIT_MS = 300
ERROR_RATE_LIMIT = 0.01
SUCCESS_RATE_FLOOR = 0.99

ALLOWED_ACTIONS = ("set_db_pool_size", "restart_service", "rollback_config")
POOL_KEY = "db.pool.max_size"


class ActionRejected(ValueError):
    pass


def parse_action(raw: str | dict) -> dict:
    """Strictly parse a remediation. Returns {"action", "value"} or raises."""
    if isinstance(raw, str):
        text = raw.strip()
        fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
        if fenced:
            text = fenced.group(1)
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ActionRejected("remediation is not a JSON object") from exc
    else:
        data = raw
    if not isinstance(data, dict):
        raise ActionRejected("remediation is not a JSON object")
    action = data.get("action")
    if action not in ALLOWED_ACTIONS:
        raise ActionRejected(f"action {action!r} is not on the allowlist")
    if action == "set_db_pool_size":
        if set(data) != {"action", "value"}:
            raise ActionRejected("set_db_pool_size takes exactly one 'value'")
        value = data["value"]
        if isinstance(value, bool) or not isinstance(value, int):
            raise ActionRejected("value must be an integer")
        if not MIN_POOL <= value <= MAX_POOL:
            raise ActionRejected(f"value must be between {MIN_POOL} and {MAX_POOL}")
        return {"action": action, "value": value}
    if set(data) != {"action"}:
        raise ActionRejected(f"{action} takes no parameters")
    return {"action": action, "value": None}


def describe_action(action: dict) -> str:
    if action["action"] == "set_db_pool_size":
        return f"set_db_pool_size({action['value']})"
    return action["action"]


def telemetry_for(pool: int) -> dict:
    in_use = min(pool, DEMAND)
    waiting = max(0, DEMAND - pool)
    served = min(1.0, pool / DEMAND)
    error_rate = round(max(BASE_ERROR_RATE, 1 - served), 4)
    if waiting:
        p95 = BASE_P95_MS + ACQUIRE_TIMEOUT_MS
    else:
        p95 = BASE_P95_MS + round(40 * in_use / pool)
    return {
        "db_pool_size": pool,
        "db_pool_in_use": in_use,
        "db_waiting": waiting,
        "p95_latency_ms": p95,
        "error_rate": error_rate,
        "payment_success_rate": round(1 - error_rate, 4),
        "requests_per_min": REQUESTS_PER_MIN,
        "timeouts_per_min": round(REQUESTS_PER_MIN * (1 - served)),
    }


def health_checks(telemetry: dict) -> list[dict]:
    t = telemetry
    return [
        {
            "name": "db_pool_capacity",
            "passed": t["db_waiting"] == 0,
            "detail": f"{t['db_pool_size']} connections for {DEMAND} concurrent requests",
        },
        {
            "name": "p95_latency",
            "passed": t["p95_latency_ms"] <= P95_LIMIT_MS,
            "detail": f"p95 {t['p95_latency_ms']}ms (limit {P95_LIMIT_MS}ms)",
        },
        {
            "name": "error_rate",
            "passed": t["error_rate"] <= ERROR_RATE_LIMIT,
            "detail": f"{t['error_rate'] * 100:.1f}% errors (limit {ERROR_RATE_LIMIT * 100:.0f}%)",
        },
        {
            "name": "payment_success",
            "passed": t["payment_success_rate"] >= SUCCESS_RATE_FLOOR,
            "detail": f"{t['payment_success_rate'] * 100:.1f}% payments succeed (floor {SUCCESS_RATE_FLOOR * 100:.0f}%)",
        },
        {
            "name": "connection_timeouts",
            "passed": t["timeouts_per_min"] == 0,
            "detail": f"{t['timeouts_per_min']} timeouts/min",
        },
    ]


def checks_grade(checks: list[dict]) -> int:
    """A 1-10 grade from the share of checks that pass."""
    passed = sum(check["passed"] for check in checks)
    return max(1, round(10 * passed / len(checks)))


@dataclass
class ServiceState:
    pool: int = HEALTHY_POOL
    config_changes: list[dict] = field(default_factory=list)
    restarts: int = 0

    def apply(self, action: dict) -> None:
        name = action["action"]
        if name == "set_db_pool_size":
            self._change_pool(action["value"], "mayday-remediation")
        elif name == "rollback_config":
            last = next(
                (c for c in reversed(self.config_changes) if c["key"] == POOL_KEY), None
            )
            if last is not None:
                self._change_pool(int(last["old"]), "mayday-rollback")
        elif name == "restart_service":
            # A restart drops in-flight requests but keeps the configured pool.
            self.restarts += 1
        else:
            raise ActionRejected(f"action {name!r} is not on the allowlist")

    def _change_pool(self, value: int, author: str, minutes_ago: int = 0) -> None:
        self.config_changes.append(
            {
                "key": POOL_KEY,
                "old": str(self.pool),
                "new": str(value),
                "author": author,
                "minutes_ago": minutes_ago,
            }
        )
        self.pool = value


class PaymentsSimulator:
    def __init__(self) -> None:
        self.state = ServiceState()

    def reset(self) -> None:
        self.state = ServiceState()

    @property
    def healthy(self) -> bool:
        return all(check["passed"] for check in self.health_checks())

    def break_production(self) -> None:
        self.state._change_pool(BROKEN_POOL, "deploy-bot (PR #4812)", minutes_ago=3)

    def telemetry(self) -> dict:
        return telemetry_for(self.state.pool)

    def health_checks(self) -> list[dict]:
        return health_checks(self.telemetry())

    def config_changes(self) -> list[dict]:
        return [dict(change) for change in self.state.config_changes]

    def logs(self) -> list[dict]:
        t = self.telemetry()
        if t["db_waiting"] == 0:
            return [
                _log("INFO", SERVICE, f"POST /v1/payments 200 p95={t['p95_latency_ms']}ms"),
                _log("INFO", "db-pool", f"{t['db_pool_in_use']}/{t['db_pool_size']} connections in use"),
                _log("INFO", "checkout", f"{t['payment_success_rate'] * 100:.1f}% payments succeeding"),
            ]
        lines = [
            _log("INFO", "config-service", f"applied {c['key']} {c['old']} -> {c['new']} by {c['author']}")
            for c in self.state.config_changes
        ]
        failed = round(t["requests_per_min"] * t["error_rate"])
        return lines + [
            _log("WARN", "db-pool", f"pool exhausted: {t['db_pool_in_use']}/{t['db_pool_size']} in use, {t['db_waiting']} waiting"),
            _log("ERROR", SERVICE, f"POST /v1/payments 500 connection not available after {ACQUIRE_TIMEOUT_MS}ms"),
            _log("ERROR", SERVICE, f"{t['timeouts_per_min']} connection timeouts in the last minute"),
            _log("ERROR", "checkout", f"{failed} payments/min failing ({t['error_rate'] * 100:.1f}%)"),
        ]

    def sandbox(self, action: dict) -> tuple[bool, list[dict], dict]:
        """Try an action on a copy of production. Production is untouched."""
        trial = copy.deepcopy(self.state)
        trial.apply(action)
        telemetry = telemetry_for(trial.pool)
        checks = health_checks(telemetry)
        return all(check["passed"] for check in checks), checks, telemetry

    def apply(self, action: dict) -> None:
        self.state.apply(action)


def _log(level: str, source: str, message: str) -> dict:
    return {"level": level, "source": source, "message": message}
