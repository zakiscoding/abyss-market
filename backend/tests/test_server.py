from __future__ import annotations

import importlib
import json

from fastapi.testclient import TestClient

from abyss.contract import validate_stream


def _server(monkeypatch, tmp_path, delay: str = "0"):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", delay)
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("ABYSS_REP_PATH", str(tmp_path / "reputation.json"))
    import abyss.server

    return importlib.reload(abyss.server)


def _receive_through_final(websocket, first: dict) -> list[dict]:
    events = [first]
    while events[-1]["type"] != "final":
        events.append(websocket.receive_json())
    return events


def test_health(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        assert client.get("/health").json() == {"ok": True}


def test_websocket_runs_valid_stream(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            hello = websocket.receive_json()
            assert hello["type"] == "hello"
            websocket.send_json(
                {
                    "type": "start_job",
                    "job": "Explain why the sky is blue in 80 words, then fact-check it.",
                }
            )
            events = _receive_through_final(websocket, hello)

    validate_stream(events)


def test_second_start_is_rejected_while_first_finishes(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path, delay="0.01")
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            hello = websocket.receive_json()
            message = {
                "type": "start_job",
                "job": "Explain why the sky is blue in 80 words, then fact-check it.",
            }
            websocket.send_json(message)
            websocket.send_json(message)
            events = _receive_through_final(websocket, hello)

    errors = [event for event in events if event["type"] == "error"]
    assert any("already running" in event["data"]["message"] for event in errors)
    assert events[-1]["type"] == "final"
    validate_stream(events)


def test_reset_sends_fresh_hello(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    server.reputation.update("haiku", "research", grade=5, promised=10)

    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            first = websocket.receive_json()
            assert first["data"]["reputation"]["haiku"]["research"] == 0.85
            websocket.send_json({"type": "reset"})
            reset = websocket.receive_json()

    assert reset["type"] == "hello"
    assert all(
        value == 1.0
        for task_types in reset["data"]["reputation"].values()
        for value in task_types.values()
    )


def _receive_until(websocket, kind: str, events: list[dict]) -> list[dict]:
    while not events or events[-1]["type"] != kind:
        events.append(websocket.receive_json())
    return events


def test_incident_over_websocket_waits_for_approval(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            events = [websocket.receive_json()]
            websocket.send_json({"type": "reset_incident"})
            _receive_until(websocket, "incident_status", events)
            assert events[-1]["data"]["status"] == "healthy"
            assert events[-1]["job_id"] is None

            websocket.send_json({"type": "start_incident"})
            _receive_until(websocket, "approval_required", events)
            assert not any(e["type"] == "service_restored" for e in events)
            websocket.send_json({"type": "approve_repair"})
            _receive_until(websocket, "final", events)

    validate_stream(events)
    sandbox = [e["data"]["passed"] for e in events if e["type"] == "sandbox_result"]
    assert sandbox == [False, True]
    assert events[-2]["type"] == "service_restored"


def test_approve_without_pending_repair_is_rejected(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "approve_repair"})
            error = websocket.receive_json()
    assert error["type"] == "error"
    assert "awaiting approval" in error["data"]["message"]


def test_reset_incident_cancels_and_can_repeat(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
            for _ in range(2):
                websocket.send_json({"type": "start_incident"})
                _receive_until(websocket, "approval_required", [])
                websocket.send_json({"type": "reset_incident"})
                event = websocket.receive_json()
                while not (event["type"] == "incident_status" and event["data"]["status"] == "healthy"):
                    event = websocket.receive_json()
                assert event["data"]["telemetry"]["db_pool_size"] == 20


def test_bad_json_and_unknown_type_return_errors(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
            websocket.send_text("not json")
            assert websocket.receive_json()["type"] == "error"
            websocket.send_text(json.dumps({"type": "unknown"}))
            assert websocket.receive_json()["type"] == "error"
