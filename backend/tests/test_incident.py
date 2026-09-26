from __future__ import annotations

import pytest

from abyss.contract import IncidentStatusData, SandboxResultData
from abyss.incident import ActionRejected, action, parse_action, parse_plan
from abyss.mayday import healthy_status
from abyss.scenarios import SCENARIO_IDS, SCENARIOS, create

ALL_ACTIONS = tuple(
    "set_db_pool_size restart_service rollback_config restart_db failover_db route_traffic "
    "apply_rate_limit block_ips".split()
)
POOL_20 = action("set_db_pool_size", value=20)
RESTART = action("restart_service")
ROLLBACK = action("rollback_config")


def _metric(sim, key: str) -> dict:
    return next(item for item in sim.telemetry() if item["key"] == key)


def _broken(scenario_id: str):
    sim = create(scenario_id)
    sim.break_production()
    return sim


@pytest.mark.parametrize("scenario_id", SCENARIO_IDS)
def test_every_scenario_starts_healthy_and_breaks_deterministically(scenario_id) -> None:
    sim = create(scenario_id)
    assert sim.healthy() and all(item["ok"] for item in sim.telemetry())
    IncidentStatusData.model_validate(healthy_status(sim))
    a, b = _broken(scenario_id), _broken(scenario_id)
    assert not a.healthy()
    assert any(not item["ok"] for item in a.telemetry())
    assert a.telemetry() == b.telemetry() and a.logs() == b.logs()


@pytest.mark.parametrize("scenario_id", SCENARIO_IDS)
def test_fake_scripts_fail_then_pass_the_sandbox(scenario_id) -> None:
    sim = _broken(scenario_id)
    cls = SCENARIOS[scenario_id]
    before = sim.telemetry()
    decoy_passed, _, _ = sim.sandbox(cls.decoy_plan)
    fix_passed, checks, telemetry = sim.sandbox(cls.fix_plan)
    assert decoy_passed is False and fix_passed is True
    assert sim.telemetry() == before, "the sandbox must never touch production"
    SandboxResultData.model_validate({
        "task_id": "t2", "agent_id": "haiku", "attempt": 1, "steps": cls.fix_plan,
        "passed": fix_passed, "checks": checks, "telemetry": telemetry,
    })


@pytest.mark.parametrize("scenario_id", SCENARIO_IDS)
def test_apply_fix_restores_and_reset_is_repeatable(scenario_id) -> None:
    sim = create(scenario_id)
    for _ in range(2):
        sim.break_production()
        sim.apply(SCENARIOS[scenario_id].decoy_plan)
        assert not sim.healthy()
        sim.apply(SCENARIOS[scenario_id].fix_plan)
        assert sim.healthy()
        sim.reset()
        assert sim.healthy() and sim.changes == []


def test_payments_pool_symptoms_and_outcomes() -> None:
    sim = _broken("payments_pool")
    assert _metric(sim, "db_pool_size")["value"] == 2
    assert _metric(sim, "error_rate")["value"] > 0.3
    assert sim.changes[0]["change_id"] == "cfg-2291"
    logs = "\n".join(sim.logs())
    assert "HTTP 500" in logs and "TimeoutError" in logs and "cfg-2291" in logs
    for plan, should_pass in [
        ([RESTART], False),
        ([action("set_db_pool_size", value=10)], False),
        ([POOL_20], True),
        ([ROLLBACK], True),
    ]:
        assert sim.sandbox(plan)[0] is should_pass


def test_amsterdam_needs_failover_and_traffic_move() -> None:
    sim = _broken("ams_db_outage")
    assert _metric(sim, "db_primary_reachable")["value"] == 0
    assert _metric(sim, "replica_lag_s")["value"] == 2.0
    cases = [
        ([action("restart_db", region="ams")], False),
        ([action("restart_service")], False),
        ([action("failover_db", region="fra")], False),  # EU traffic still crosses regions
        ([action("route_traffic", region="fra")], False),  # primary still dead
        ([action("failover_db", region="iad"), action("route_traffic", region="iad")], False),  # no replica
        ([action("failover_db", region="fra"), action("route_traffic", region="fra")], True),
    ]
    for plan, should_pass in cases:
        passed, checks, _ = sim.sandbox(plan)
        assert passed is should_pass, (plan, checks)


def test_auth_attack_needs_rate_limit_and_blocklist() -> None:
    sim = _broken("auth_attack")
    attackers = list(sim.ATTACKERS)
    assert _metric(sim, "failed_logins_per_min")["value"] > 40000
    cases = [
        ([action("restart_service")], False),
        ([action("restart_db", region="iad")], False),
        ([action("block_ips", ips=attackers)], False),
        ([action("apply_rate_limit", value=20)], False),
        ([action("apply_rate_limit", value=2), action("block_ips", ips=attackers)], False),  # locks out users
        ([action("apply_rate_limit", value=20), action("block_ips", ips=[*attackers, "10.0.0.8"])], False),
        ([action("apply_rate_limit", value=20), action("block_ips", ips=attackers)], True),
    ]
    for plan, should_pass in cases:
        passed, checks, _ = sim.sandbox(plan)
        assert passed is should_pass, (plan, checks)


def test_network_partition_needs_reroute_to_a_reachable_origin() -> None:
    sim = _broken("network_partition")
    assert _metric(sim, "origin_health")["ok"] is True
    assert _metric(sim, "apac_reachability")["value"] < 0.1
    cases = [
        ([action("restart_service")], False),
        ([action("restart_db", region="fra")], False),
        ([action("failover_db", region="iad")], False),
        ([action("route_traffic", region="ams")], False),  # behind the same partition
        ([action("route_traffic", region="sin")], False),  # no origin there
        ([action("route_traffic", region="iad")], True),
    ]
    for plan, should_pass in cases:
        passed, checks, _ = sim.sandbox(plan)
        assert passed is should_pass, (plan, checks)


@pytest.mark.parametrize(
    "raw, expected",
    [
        ('{"action":"set_db_pool_size","value":20}', [POOL_20]),
        ('```json\n{"steps": [{"action": "restart_service"}]}\n```', [RESTART]),
        ('Proposed fix: {"action":"rollback_config"}', [ROLLBACK]),
        ('{"steps":[{"action":"failover_db","region":"fra"},{"action":"route_traffic","region":"fra"}]}',
         [action("failover_db", region="fra"), action("route_traffic", region="fra")]),
        ({"steps": [{"action": "block_ips", "ips": ["203.0.113.24"]}]}, [action("block_ips", ips=["203.0.113.24"])]),
        ({"action": "rollback_config", "value": None}, [ROLLBACK]),
    ],
)
def test_parse_plan_accepts_typed_allowlisted_steps(raw, expected) -> None:
    assert parse_plan(raw, ALL_ACTIONS) == expected


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
        '{"action":"failover_db","region":"mars"}',
        '{"action":"route_traffic"}',
        '{"action":"block_ips","ips":["not-an-ip"]}',
        '{"action":"block_ips","ips":"203.0.113.24"}',
        '{"action":"block_ips","ips":[]}',
        '{"steps":[]}',
        '{"steps":[{"action":"restart_service"},{"action":"restart_service"}]}',
        '{"steps":[{"action":"restart_service"}],"shell":"reboot"}',
        '{"steps":[{"action":"restart_service"},{"action":"rollback_config"},{"action":"restart_db","region":"ams"},'
        '{"action":"failover_db","region":"fra"},{"action":"route_traffic","region":"fra"}]}',
        '["restart_service"]',
        "",
    ],
)
def test_parse_plan_rejects_everything_else(raw) -> None:
    with pytest.raises(ActionRejected):
        parse_plan(raw, ALL_ACTIONS)


def test_scenario_allowlists_are_enforced() -> None:
    with pytest.raises(ActionRejected, match="not allowed"):
        parse_plan('{"action": "set_db_pool_size", "value": 20}', SCENARIOS["auth_attack"].allowed_actions)
    sim = _broken("network_partition")
    with pytest.raises(ActionRejected):
        sim.apply([action("block_ips", ips=["203.0.113.24"])])
    with pytest.raises(ActionRejected):
        parse_action({"action": "set_db_pool_size", "value": 20}, ("restart_service",))
