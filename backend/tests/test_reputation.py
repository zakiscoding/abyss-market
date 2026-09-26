from __future__ import annotations

import json

from abyss.config import AGENTS, REP_KEYS
from abyss.reputation import ReputationStore


def test_fixture_reputation_updates(fixture_events: list[dict]) -> None:
    store = ReputationStore()
    rep_updates = [
        event["data"] for event in fixture_events if event["type"] == "rep_update"
    ]
    graded = {
        event["data"]["task_id"]: event["data"]
        for event in fixture_events
        if event["type"] == "graded"
    }

    for expected in rep_updates:
        review = graded[expected["task_id"]]
        actual = store.update(
            expected["agent_id"],
            expected["task_type"],
            review["grade"],
            review["promised_quality"],
        )
        assert actual == (expected["old"], expected["new"], expected["ratio"])


def test_persistence_round_trip_and_reset(tmp_path) -> None:
    path = tmp_path / "reputation.json"
    store = ReputationStore(path)
    store.update("haiku", "research", grade=5, promised=10)

    loaded = ReputationStore(path)
    assert loaded.snapshot() == store.snapshot()
    assert loaded.get("haiku", "research") == 0.85

    loaded.reset()
    reset = ReputationStore(path)
    assert reset.snapshot() == {
        agent.agent_id: {key: 1.0 for key in REP_KEYS}
        for agent in AGENTS
    }


def test_old_files_gain_domain_keys_and_drop_retired_ones(tmp_path) -> None:
    path = tmp_path / "reputation.json"
    path.write_text(json.dumps({"haiku": {"research": 0.5, "remediate": 0.2}}), encoding="utf-8")
    store = ReputationStore(path)
    assert store.get("haiku", "research") == 0.5
    assert store.get("haiku", "database.remediate") == 1.0
    assert list(store.snapshot()["haiku"]) == REP_KEYS
