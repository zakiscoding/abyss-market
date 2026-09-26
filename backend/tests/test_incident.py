from __future__ import annotations

import pytest

from abyss.contract import SandboxResultData, Telemetry
from abyss.incident import (
    HEALTHY_POOL_SIZE,
    ActionRejected,
    PaymentsSimulator,
    parse_action,
)

POOL_20 = {"action": "set_db_pool_size", "value": 20}
RESTART = {"action": "restart_service", "value": None}
ROLLBACK = {"action": "rollback_config", "value": None}


def test_starts_healthy() -> None:
    sim = PaymentsSimulator()
    t = sim.telemetry()
    Telemetry.model_validate(t)
    assert t["db_pool_size"] == HEALTHY_POOL_SIZE
    assert t["error_rate"] < 0.01
    assert t["p95_latency_ms"] < 300
    assert t["timeouts_per_min"] == 0
    assert t["payment_success_rate"] >= 0.99
    assert sim.healthy()
    assert sim.changes == []


def test_break_production_shows_symptoms() -> None:
    sim = PaymentsSimulator()
    sim.break_production()
    t = sim.telemetry()
    assert t["db_pool_size"] == 2
    assert t["error_rate"] > 0.3
    assert t["p95_latency_ms"] > 1000
    assert t["timeouts_per_min"] > 0
    assert t["failed_payments_per_min"] > 0
    assert not sim.healthy()
    assert sim.changes[0]["change_id"] == "cfg-2291"
    logs = "\n".join(sim.logs())
    assert "HTTP 500" in logs and "TimeoutError" in logs and "cfg-2291" in logs


def test_telemetry_is_deterministic() -> None:
    a, b = PaymentsSimulator(), PaymentsSimulator()
    a.break_production()
    b.break_production()
    assert a.telemetry() == b.telemetry()
    assert a.logs() == b.logs()


@pytest.mark.parametrize(
    "raw, expected",
    [
        ('{"action":"set_db_pool_size","value":20}', POOL_20),
        ('```json\n{"action": "restart_service"}\n```', RESTART),
        ('Proposed fix: {"action":"rollback_config"}', ROLLBACK),
        ({"action": "set_db_pool_size", "value": 5}, {"action": "set_db_pool_size", "value": 5}),
    ],
)
def test_parse_action_accepts_allowlist(raw, expected) -> None:
    assert parse_action(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "rm -rf /",
        '{"action":"exec","value":"rm -rf /"}',
        '{"action":"set_db_pool_size"}',
        '{"action":"set_db_pool_size","value":"20"}',
        '{"action":"set_db_pool_size","value":true}',
        '{"action":"set_db_pool_size","value":0}',
        '{"action":"set_db_pool_size","value":500}',
        '{"action":"set_db_pool_size","value":20,"cmd":"ls"}',
        '{"action":"restart_service","value":1}',
        '{"action":"rollback_config","value":null}',
        '["restart_service"]',
        "",
    ],
)
def test_parse_action_rejects_everything_else(raw) -> None:
    with pytest.raises(ActionRejected):
        parse_action(raw)


def test_sandbox_never_touches_production() -> None:
    sim = PaymentsSimulator()
    sim.break_production()
    before = sim.telemetry()
    passed, checks, telemetry = sim.sandbox(POOL_20)
    assert passed
    assert telemetry["db_pool_size"] == 20
    assert sim.telemetry() == before


@pytest.mark.parametrize(
    "action, should_pass",
    [
        (RESTART, False),
        ({"action": "set_db_pool_size", "value": 10}, False),
        (POOL_20, True),
        (ROLLBACK, True),
    ],
)
def test_sandbox_outcomes(action, should_pass) -> None:
    sim = PaymentsSimulator()
    sim.break_production()
    passed, checks, telemetry = sim.sandbox(action)
    assert passed is should_pass
    SandboxResultData.model_validate({
        "task_id": "t2", "agent_id": "haiku", "attempt": 1, "action": action,
        "passed": passed, "checks": checks, "telemetry": telemetry,
    })


def test_correct_repair_restores_and_reset_is_repeatable() -> None:
    sim = PaymentsSimulator()
    for _ in range(3):
        sim.break_production()
        sim.apply(RESTART)
        assert not sim.healthy()
        sim.apply(POOL_20)
        assert sim.healthy()
        sim.reset()
        assert sim.healthy() and sim.changes == []
