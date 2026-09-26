from __future__ import annotations

import json
import threading

from abyss.ledger import Ledger, cost_usd


def _record_fixture_usage(ledger: Ledger, events: list[dict]) -> None:
    purposes = {
        "job_split": "split",
        "bid": "bid",
        "done": "work",
        "graded": "review",
    }
    for event in events:
        purpose = purposes.get(event["type"])
        if purpose is None:
            continue
        data = event["data"]
        usage = data["usage"]
        ledger.record(
            task_id=data.get("task_id"),
            agent_id=data.get("agent_id") if purpose in {"bid", "work"} else None,
            purpose=purpose,
            model=usage["model"],
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            cache_read_input_tokens=0,
            cache_creation_input_tokens=0,
            cost_usd=usage["cost_usd"],
            ok=True,
            stop_reason="end_turn",
            error=None,
            duration_ms=usage["duration_ms"],
        )


def test_cost_usd() -> None:
    assert cost_usd("claude-opus-5", 350, 180) == 0.00625


def test_fixture_stats(fixture_events: list[dict]) -> None:
    ledger = Ledger("j_7f3a91c2", None)
    _record_fixture_usage(ledger, fixture_events)
    tasks_won = {"haiku": 0, "sonnet": 0, "opus": 0}
    for event in fixture_events:
        if event["type"] == "won":
            tasks_won[event["data"]["agent_id"]] += 1
    expected = [
        event["data"] for event in fixture_events if event["type"] == "stats"
    ][-1]
    assert ledger.stats(tasks_won) == expected


def test_record_appends_one_jsonl_line(tmp_path) -> None:
    path = tmp_path / "ledger.jsonl"
    ledger = Ledger("j_deadbeef", path)
    fields = {
        "task_id": "t1",
        "agent_id": "haiku",
        "purpose": "work",
        "model": "claude-haiku-4-5",
        "input_tokens": 10,
        "output_tokens": 20,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cost_usd": cost_usd("claude-haiku-4-5", 10, 20),
        "ok": True,
        "stop_reason": "end_turn",
        "error": None,
        "duration_ms": 100,
    }
    first = ledger.record(**fields)
    second = ledger.record(**fields)

    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert [json.loads(line)["id"] for line in lines] == ["c_0001", "c_0002"]
    assert [first.id, second.id] == ["c_0001", "c_0002"]
    assert len(ledger.entries()) == 2


def _fields() -> dict:
    return {
        "task_id": "t1",
        "agent_id": "haiku",
        "purpose": "work",
        "model": "claude-haiku-4-5",
        "input_tokens": 10,
        "output_tokens": 20,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cost_usd": 0.0001,
        "ok": False,
        "stop_reason": None,
        "error": "provider said sk-ant-SECRETVALUE Authorization: Bearer abcdefghijklmnop",
        "duration_ms": 5,
    }


def test_ledger_does_not_store_secrets(tmp_path) -> None:
    path = tmp_path / "ledger.jsonl"
    Ledger("j_00000000", path).record(**_fields())
    text = path.read_text(encoding="utf-8")
    assert "SECRETVALUE" not in text
    assert "abcdefghijklmnop" not in text
    assert json.loads(text)["error"]


def test_concurrent_appends_keep_complete_json_lines(tmp_path) -> None:
    path = tmp_path / "ledger.jsonl"
    ledger = Ledger("j_abc12345", path)
    fields = _fields()

    def work() -> None:
        for _ in range(25):
            ledger.record(**fields)

    threads = [threading.Thread(target=work) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 100
    assert len(ledger.entries()) == 100
    ids = [json.loads(line)["id"] for line in lines]
    assert len(set(ids)) == 100
    assert "SECRETVALUE" not in path.read_text(encoding="utf-8")


def test_separate_ledgers_do_not_interleave_one_file(tmp_path) -> None:
    path = tmp_path / "ledger.jsonl"
    fields = _fields()

    def work(index: int) -> None:
        ledger = Ledger(f"j_{index:08d}", path)
        for _ in range(20):
            ledger.record(**fields)

    threads = [threading.Thread(target=work, args=(index,)) for index in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 100
    for line in lines:
        parsed = json.loads(line)
        assert parsed["ok"] is False
        assert "SECRETVALUE" not in line
