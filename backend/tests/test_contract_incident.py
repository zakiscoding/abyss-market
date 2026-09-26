from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from abyss.contract import validate_event, validate_stream

FIXTURE = Path(__file__).parents[2] / "fixtures" / "mayday_run.json"


@pytest.fixture
def events() -> list[dict]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _renumber(events: list[dict]) -> list[dict]:
    for seq, event in enumerate(events):
        event["seq"] = seq
    return events


def _index(events: list[dict], kind: str, nth: int = 0) -> int:
    return [i for i, e in enumerate(events) if e["type"] == kind][nth]


def test_mayday_fixture_is_valid(events) -> None:
    validate_stream(events)
    kinds = [e["type"] for e in events]
    for kind in ("incident_status", "responders_selected", "remediation_proposed",
                 "sandbox_result", "approval_required", "service_restored"):
        assert kind in kinds
    statuses = [e["data"]["status"] for e in events if e["type"] == "incident_status"]
    assert statuses == ["healthy", "outage", "investigating", "repairing",
                        "awaiting_approval", "recovering", "restored"]
    assert [e["data"]["passed"] for e in events if e["type"] == "sandbox_result"] == [False, True]


def test_every_new_event_key_is_required(events) -> None:
    for kind in ("incident_status", "responders_selected", "remediation_proposed",
                 "sandbox_result", "approval_required", "service_restored"):
        event = events[_index(events, kind)]
        for key in event["data"]:
            broken = deepcopy(event)
            del broken["data"][key]
            with pytest.raises(Exception):
                validate_event(broken)


def test_recovering_without_approval_fails(events) -> None:
    del events[_index(events, "approval_required")]
    with pytest.raises(ValueError):
        validate_stream(_renumber(events))


def test_restored_without_service_restored_fails(events) -> None:
    del events[_index(events, "service_restored")]
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
    approval["action"] = rejected["action"]
    with pytest.raises(ValueError):
        validate_stream(events)


def test_sandbox_passed_must_match_checks(events) -> None:
    event = events[_index(events, "sandbox_result", 0)]
    event["data"]["passed"] = True
    with pytest.raises(Exception):
        validate_event(event)


@pytest.mark.parametrize("action", [
    {"action": "exec", "value": None},
    {"action": "restart_service", "value": 3},
    {"action": "set_db_pool_size", "value": None},
])
def test_non_allowlisted_actions_fail_the_contract(events, action) -> None:
    event = events[_index(events, "remediation_proposed", 0)]
    event["data"]["action"] = action
    with pytest.raises(Exception):
        validate_event(event)


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
