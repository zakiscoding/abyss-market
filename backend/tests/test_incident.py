from __future__ import annotations

import pytest

from abyss.incident import (
    BROKEN_POOL,
    HEALTHY_POOL,
    ActionRejected,
    PaymentsSimulator,
    checks_grade,
    parse_action,
)


def test_starts_healthy() -> None:
    sim = PaymentsSimulator()
    t = sim.telemetry()
    assert t["db_pool_size"] == HEALTHY_POOL
    assert t["error_rate"] < 0.01
    assert t["p95_latency_ms"] < 300
    assert t["payment_success_rate"] > 0.99
    assert t["timeouts_per_min"] == 0
    assert sim.healthy
    assert sim.config_changes() == []


def test_break_production_shows_symptoms() -> None:
    sim = PaymentsSimulator()
    sim.break_production()
    t = sim.telemetry()
    assert t["db_pool_size"] == BROKEN_POOL
    assert t["error_rate"] > 0.5
    assert t["p95_latency_ms"] > 3000
    assert t["timeouts_per_min"] > 0
    assert t["payment_success_rate"] < 0.5
    assert not sim.healthy
    change = sim.config_changes()[-1]
    assert (change["key"], change["old"], change["new"]) == ("db.pool.max_size", "20", "2")
    levels = {line["level"] for line in sim.logs()}
    assert {"INFO", "WARN", "ERROR"} <= levels
    assert any("500" in line["message"] for line in sim.logs())


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('{"action":"set_db_pool_size","value":20}', {"action": "set_db_pool_size", "value": 20}),
        ('{"action":"restart_service"}', {"action": "restart_service", "value": None}),
        ('```json\n{"action":"rollback_config"}\n```', {"action": "rollback_config", "value": None}),
    ],
)
def test_parse_allowed_actions(raw: str, expected: dict) -> None:
    assert parse_action(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "rm -rf /",
        '{"action":"exec","value":"rm -rf /"}',
        '{"action":"set_db_pool_size"}',
        '{"action":"set_db_pool_size","value":"20"}',
        '{"action":"set_db_pool_size","value":true}',
        '{"action":"set_db_pool_size","value":500}',
        '{"action":"set_db_pool_size","value":20,"cmd":"x"}',
        '{"action":"restart_service","value":1}',
        '["restart_service"]',
        "Sure! Restart the service.",
    ],
)
def test_parse_rejects_everything_else(raw: str) -> None:
    with pytest.raises(ActionRejected):
        parse_action(raw)


def test_wrong_repairs_fail_in_sandbox_and_leave_production_alone() -> None:
    sim = PaymentsSimulator()
    sim.break_production()
    for action in ({"action": "restart_service", "value": None},
                   {"action": "set_db_pool_size", "value": 5}):
        passed, checks, telemetry = sim.sandbox(action)
        assert not passed
        assert not all(check["passed"] for check in checks)
        assert sim.telemetry()["db_pool_size"] == BROKEN_POOL


def test_correct_repairs_pass_sandbox_then_restore_production() -> None:
    sim = PaymentsSimulator()
    sim.break_production()
    passed, checks, telemetry = sim.sandbox({"action": "rollback_config", "value": None})
    assert passed and telemetry["db_pool_size"] == HEALTHY_POOL
    passed, _, _ = sim.sandbox({"action": "set_db_pool_size", "value": 20})
    assert passed
    assert not sim.healthy
    sim.apply({"action": "set_db_pool_size", "value": 20})
    assert sim.healthy


def test_checks_are_deterministic_and_grade_by_share() -> None:
    a, b = PaymentsSimulator(), PaymentsSimulator()
    a.break_production()
    b.break_production()
    assert a.health_checks() == b.health_checks()
    assert checks_grade(a.health_checks()) < 5
    assert checks_grade(PaymentsSimulator().health_checks()) == 10


def test_reset_returns_to_healthy() -> None:
    sim = PaymentsSimulator()
    sim.break_production()
    sim.reset()
    assert sim.healthy and sim.config_changes() == []
