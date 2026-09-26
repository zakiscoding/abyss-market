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


def _receive_until(websocket, events: list[dict], event_type: str) -> dict:
    while True:
        event = websocket.receive_json()
        events.append(event)
        if event["type"] == event_type:
            return event


def test_incident_flow_over_websocket(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            events = [websocket.receive_json()]
            websocket.send_json({"type": "reset_incident"})
            healthy = _receive_until(websocket, events, "incident_status")
            assert healthy["data"]["status"] == "healthy" and healthy["job_id"] is None

            websocket.send_json({"type": "approve_repair"})
            error = _receive_until(websocket, events, "error")
            assert "awaiting approval" in error["data"]["message"]
            events.remove(error)

            websocket.send_json({"type": "start_incident"})
            _receive_until(websocket, events, "approval_required")
            websocket.send_json({"type": "approve_repair"})
            _receive_until(websocket, events, "final")

            websocket.send_json({"type": "reset_incident"})
            again = websocket.receive_json()

    validate_stream(events)
    assert events[-1]["data"]["status"] == "ok"
    assert again["type"] == "incident_status" and again["data"]["status"] == "healthy"


def test_reset_incident_cancels_a_waiting_incident(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "start_incident"})
            _receive_until(websocket, [], "approval_required")
            websocket.send_json({"type": "reset_incident"})
            healthy = websocket.receive_json()
            assert healthy["data"]["status"] == "healthy"
            websocket.send_json({"type": "start_incident"})
            outage = websocket.receive_json()
            assert outage["data"]["status"] == "outage"


def test_bad_json_and_unknown_type_return_errors(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
            websocket.send_text("not json")
            assert websocket.receive_json()["type"] == "error"
            websocket.send_text(json.dumps({"type": "unknown"}))
            assert websocket.receive_json()["type"] == "error"
