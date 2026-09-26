from __future__ import annotations

from copy import deepcopy

import pytest

from abyss.contract import validate_stream


FAILED_BID_FIELDS = (
    "predicted_output_tokens",
    "est_input_tokens",
    "predicted_cost_usd",
    "promised_quality",
    "confidence",
    "eta_ms",
    "pitch",
    "reputation",
    "score",
    "usage",
)


def _renumber(events: list[dict]) -> None:
    for seq, event in enumerate(events):
        event["seq"] = seq


def _task_bounds(events: list[dict], task_id: str) -> tuple[int, int]:
    start = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "task_posted" and event["data"]["task_id"] == task_id
    )
    end = next(
        index
        for index, event in enumerate(events[start + 1 :], start + 1)
        if event["type"] in {"task_posted", "final"}
    )
    return start, end


def _replace_task_segment(events: list[dict], task_id: str, segment: list[dict]) -> None:
    start, end = _task_bounds(events, task_id)
    events[start:end] = segment
    _renumber(events)


def _make_bid_fail(bid: dict) -> None:
    bid["data"]["ok"] = False
    bid["data"]["error"] = "bid failed"
    for field in FAILED_BID_FIELDS:
        bid["data"][field] = None


def _error_event(reference: dict, task_id: str | None, fatal: bool = False) -> dict:
    return {
        "v": 1,
        "seq": 0,
        "t": reference["t"],
        "job_id": reference["job_id"],
        "type": "error",
        "data": {
            "message": "call failed",
            "task_id": task_id,
            "fatal": fatal,
        },
    }


def _mark_task_failed(events: list[dict], task_id: str, no_winner: bool = False) -> None:
    final = events[-1]["data"]
    final["status"] = "partial"
    final["mean_grade"] = 9.0
    task = next(task for task in final["tasks"] if task["task_id"] == task_id)
    task["grade"] = None
    if no_winner:
        task["agent_id"] = None
        task["promised_quality"] = None


def _all_bids_fail_run(fixture_events: list[dict]) -> list[dict]:
    changed = deepcopy(fixture_events)
    start, end = _task_bounds(changed, "t1")
    original = changed[start:end]
    posted = original[0]
    bids = [event for event in original if event["type"] == "bid"]
    for bid in bids:
        _make_bid_fail(bid)
    segment = [
        posted,
        *bids,
        _error_event(bids[-1], "t1"),
        original[-1],
    ]
    _replace_task_segment(changed, "t1", segment)
    _mark_task_failed(changed, "t1", no_winner=True)
    return changed


def test_fixture_passes(fixture_events: list[dict]) -> None:
    validate_stream(fixture_events)


def test_one_failed_bid_allows_auction_to_continue(fixture_events: list[dict]) -> None:
    changed = deepcopy(fixture_events)
    bid = next(
        event
        for event in changed
        if event["type"] == "bid"
        and event["data"]["task_id"] == "t1"
        and event["data"]["agent_id"] == "opus"
    )
    _make_bid_fail(bid)
    won = next(
        event
        for event in changed
        if event["type"] == "won" and event["data"]["task_id"] == "t1"
    )
    del won["data"]["scores"]["opus"]

    validate_stream(changed)


def test_all_failed_bids_end_with_error_stats_and_partial(
    fixture_events: list[dict],
) -> None:
    validate_stream(_all_bids_fail_run(fixture_events))


def test_work_failure_ends_with_error_stats_and_partial(
    fixture_events: list[dict],
) -> None:
    changed = deepcopy(fixture_events)
    start, end = _task_bounds(changed, "t1")
    original = changed[start:end]
    working_index = next(
        index for index, event in enumerate(original) if event["type"] == "working"
    )
    segment = [
        *original[: working_index + 1],
        _error_event(original[working_index], "t1"),
        original[-1],
    ]
    _replace_task_segment(changed, "t1", segment)
    _mark_task_failed(changed, "t1")

    validate_stream(changed)


def test_review_failure_ends_with_error_stats_and_partial(
    fixture_events: list[dict],
) -> None:
    changed = deepcopy(fixture_events)
    start, end = _task_bounds(changed, "t1")
    original = changed[start:end]
    done_index = next(
        index for index, event in enumerate(original) if event["type"] == "done"
    )
    segment = [
        *original[: done_index + 1],
        _error_event(original[done_index], "t1"),
        original[-1],
    ]
    _replace_task_segment(changed, "t1", segment)
    _mark_task_failed(changed, "t1")

    validate_stream(changed)


def test_split_failure_is_valid(fixture_events: list[dict]) -> None:
    hello = deepcopy(fixture_events[0])
    final = deepcopy(fixture_events[-1])
    error = _error_event(final, None, fatal=True)
    error["t"] = 0
    final["data"].update(
        status="error",
        deliverable_task_id=None,
        deliverable=None,
        tasks=[],
        total_cost_usd=0.0,
        mean_grade=None,
    )
    events = [hello, error, final]
    _renumber(events)

    validate_stream(events)


def test_fixed_mode_has_no_bids_or_reputation_update(
    fixture_events: list[dict],
) -> None:
    changed = deepcopy(fixture_events)
    start, end = _task_bounds(changed, "t1")
    segment = [
        event
        for event in changed[start:end]
        if event["type"] not in {"bid", "rep_update"}
    ]
    won = next(event for event in segment if event["type"] == "won")
    won["data"].update(
        mode="fixed",
        score=None,
        runner_up_agent_id=None,
        runner_up_score=None,
        scores={},
    )
    done = next(event for event in segment if event["type"] == "done")
    done["data"]["predicted_output_tokens"] = None
    done["data"]["predicted_cost_usd"] = None
    graded = next(event for event in segment if event["type"] == "graded")
    graded["data"]["promised_quality"] = None
    _replace_task_segment(changed, "t1", segment)
    final_task = next(
        task for task in changed[-1]["data"]["tasks"] if task["task_id"] == "t1"
    )
    final_task["promised_quality"] = None

    validate_stream(changed)


def test_ok_status_with_failed_task_fails(fixture_events: list[dict]) -> None:
    changed = _all_bids_fail_run(fixture_events)
    changed[-1]["data"]["status"] = "ok"

    with pytest.raises(ValueError):
        validate_stream(changed)


def test_every_data_key_is_required(fixture_events: list[dict]) -> None:
    for event_index, event in enumerate(fixture_events):
        for key in event["data"]:
            changed = deepcopy(fixture_events)
            del changed[event_index]["data"][key]
            with pytest.raises(Exception):
                validate_stream(changed)


def test_unknown_data_key_fails(fixture_events: list[dict]) -> None:
    for event_index in range(len(fixture_events)):
        changed = deepcopy(fixture_events)
        changed[event_index]["data"]["unknown"] = "not allowed"
        with pytest.raises(Exception):
            validate_stream(changed)


def test_won_before_last_bid_fails(fixture_events: list[dict]) -> None:
    changed = deepcopy(fixture_events)
    bid_index = next(
        index
        for index, event in enumerate(changed)
        if event["type"] == "bid" and event["data"]["task_id"] == "t1"
    )
    won_index = next(
        index
        for index, event in enumerate(changed)
        if event["type"] == "won" and event["data"]["task_id"] == "t1"
    )
    changed[bid_index], changed[won_index] = changed[won_index], changed[bid_index]
    for seq, event in enumerate(changed):
        event["seq"] = seq

    with pytest.raises(Exception):
        validate_stream(changed)
