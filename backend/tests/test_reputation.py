from __future__ import annotations

from abyss.config import AGENTS, ALL_TASK_TYPES
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
        agent.agent_id: {task_type: 1.0 for task_type in ALL_TASK_TYPES}
        for agent in AGENTS
    }
