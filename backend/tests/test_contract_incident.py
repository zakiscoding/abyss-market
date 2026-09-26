from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from abyss.contract import validate_event, validate_stream
from abyss.scenarios import SCENARIO_IDS

FIXTURES = Path(__file__).parents[2] / "fixtures"
NEW_EVENTS = (
    "incident_status", "incident_received", "commander_classified", "specialists_dispatched",
    "responders_selected", "remediation_proposed", "sandbox_result", "remediation_plan_created",
    "human_assignments_created", "approval_required", "approval_granted", "service_restored",
    "routing_stats",
)


def _load(scenario_id: str) -> list[dict]:
    return json.loads((FIXTURES / f"incident_{scenario_id}.json").read_text(encoding="utf-8"))


@pytest.fixture
def events() -> list[dict]:
    return _load("ams_db_outage")


def _renumber(events: list[dict]) -> list[dict]:
    for seq, event in enumerate(events):
        event["seq"] = seq
    return events


def _index(events: list[dict], kind: str, nth: int = 0) -> int:
    return [i for i, e in enumerate(events) if e["type"] == kind][nth]


@pytest.mark.parametrize("scenario_id", SCENARIO_IDS)
def test_every_incident_fixture_is_valid(scenario_id) -> None:
    events = _load(scenario_id)
    validate_stream(events)
    kinds = [e["type"] for e in events]
    for kind in NEW_EVENTS:
        assert kind in kinds
    statuses = [e["data"]["status"] for e in events if e["type"] == "incident_status"]
    assert statuses == ["healthy", "outage", "investigating", "repairing",
                        "awaiting_approval", "recovering", "restored"]
    assert [e["data"]["passed"] for e in events if e["type"] == "sandbox_result"] == [False, True]
    assert {e["data"]["scenario_id"] for e in events if e["type"] == "incident_status"} == {scenario_id}
    assert kinds[-2:] == ["routing_stats", "final"]


def test_every_new_event_key_is_required(events) -> None:
    for kind in NEW_EVENTS:
        event = events[_index(events, kind)]
        for key in event["data"]:
            broken = deepcopy(event)
            del broken["data"][key]
            with pytest.raises(Exception):
                validate_event(broken)


@pytest.mark.parametrize("kind", [
    "approval_required", "approval_granted", "human_assignments_created",
    "remediation_plan_created", "commander_classified", "specialists_dispatched",
    "incident_received", "routing_stats", "service_restored",
])
def test_removing_a_required_stage_fails(events, kind) -> None:
    del events[_index(events, kind)]
    with pytest.raises(ValueError):
        validate_stream(_renumber(events))


def test_skipping_the_sandbox_fails(events) -> None:
    del events[_index(events, "sandbox_result", 1)]
    with pytest.raises(ValueError):
        validate_stream(_renumber(events))


def test_approving_the_rejected_repair_fails(events) -> None:
    rejected = events[_index(events, "sandbox_result", 0)]["data"]
    approval = events[_index(events, "approval_required")]["data"]
    approval["task_id"] = rejected["task_id"]
    approval["steps"] = rejected["steps"]
    with pytest.raises(ValueError):
        validate_stream(events)


def test_sandbox_passed_must_match_checks(events) -> None:
    event = events[_index(events, "sandbox_result", 0)]
    event["data"]["passed"] = True
    with pytest.raises(Exception):
        validate_event(event)


@pytest.mark.parametrize("step", [
    {"action": "exec", "value": None, "region": None, "ips": None},
    {"action": "restart_db", "value": 3, "region": "ams", "ips": None},
    {"action": "restart_db", "value": None, "region": "mars", "ips": None},
    {"action": "block_ips", "value": None, "region": None, "ips": ["not-an-ip"]},
    {"action": "set_db_pool_size", "value": None, "region": None, "ips": None},
    {"action": "set_db_pool_size", "value": 1000, "region": None, "ips": None},
    {"action": "restart_db", "region": "ams"},
])
def test_non_allowlisted_actions_fail_the_contract(events, step) -> None:
    event = events[_index(events, "remediation_proposed", 0)]
    event["data"]["steps"] = [step]
    with pytest.raises(Exception):
        validate_event(event)


def test_more_than_four_plan_steps_fail(events) -> None:
    event = events[_index(events, "remediation_proposed", 0)]
    event["data"]["steps"] = event["data"]["steps"] * 5
    with pytest.raises(Exception):
        validate_event(event)


def test_rep_key_must_match_the_classified_domain(events) -> None:
    event = events[_index(events, "rep_update")]
    event["data"]["rep_key"] = "security.diagnose"
    with pytest.raises(ValueError):
        validate_stream(events)


def test_unknown_rep_key_fails(events) -> None:
    event = events[_index(events, "rep_update")]
    event["data"]["rep_key"] = "database.exec"
    with pytest.raises(Exception):
        validate_event(event)


def test_task_domain_must_match_the_commander(events) -> None:
    events[_index(events, "task_posted")]["data"]["domain"] = "payments"
    with pytest.raises(ValueError):
        validate_stream(events)


def test_approvers_must_match_the_assignments(events) -> None:
    events[_index(events, "approval_required")]["data"]["approvers"] = ["Maya"]
    with pytest.raises(ValueError):
        validate_stream(events)


def test_routing_counts_must_add_up(events) -> None:
    event = events[_index(events, "routing_stats")]
    event["data"]["models_skipped"] += 1
    with pytest.raises(Exception):
        validate_stream(events)


def test_only_healthy_status_may_be_jobless(events) -> None:
    event = deepcopy(events[_index(events, "incident_status", 1)])
    event["job_id"] = None
    with pytest.raises(ValueError):
        validate_event(event)


def test_verify_before_repair_fails(events) -> None:
    posted = events[_index(events, "task_posted", 1)]
    posted["data"]["type"] = "verify"
    with pytest.raises(ValueError):
        validate_stream(events)
