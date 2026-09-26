from __future__ import annotations

import asyncio
import importlib
import json
import time

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

            websocket.send_json({"type": "start_incident", "scenario_id": "ams_db_outage"})
            _receive_until(websocket, "approval_required", events)
            assert not any(e["type"] == "service_restored" for e in events)
            websocket.send_json({"type": "approve_repair"})
            _receive_until(websocket, "final", events)

    validate_stream(events)
    sandbox = [e["data"]["passed"] for e in events if e["type"] == "sandbox_result"]
    assert sandbox == [False, True]
    classified = next(e["data"] for e in events if e["type"] == "commander_classified")
    assert classified["domain"] == "database"
    assert [e["type"] for e in events[-3:]] == ["service_restored", "routing_stats", "final"]


def test_unknown_scenario_is_rejected(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            hello = websocket.receive_json()
            assert [s["scenario_id"] for s in hello["data"]["config"]["scenarios"]] == [
                "payments_pool", "ams_db_outage", "auth_attack", "network_partition",
            ]
            websocket.send_json({"type": "start_incident", "scenario_id": "rm -rf"})
            error = websocket.receive_json()
    assert error["type"] == "error" and "scenario_id" in error["data"]["message"]


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
            for scenario_id in ("payments_pool", "network_partition"):
                websocket.send_json({"type": "start_incident", "scenario_id": scenario_id})
                _receive_until(websocket, "approval_required", [])
                websocket.send_json({"type": "reset_incident"})
                event = websocket.receive_json()
                while not (event["type"] == "incident_status" and event["data"]["status"] == "healthy"):
                    event = websocket.receive_json()
                assert event["data"]["scenario_id"] == scenario_id
                assert all(item["ok"] for item in event["data"]["telemetry"])


def test_ready_reports_fake_mode_without_secrets(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-SECRETVALUE")
    with TestClient(server.app) as client:
        ready = client.get("/ready")
        health = client.get("/health")
    assert health.json() == {"ok": True}
    assert ready.status_code == 200
    body = ready.json()
    assert body["ok"] is True
    assert body["checks"] == {
        "initialized": True,
        "scenarios": True,
        "reputation": True,
        "config": True,
        "provider": True,
    }
    assert "SECRETVALUE" not in ready.text


def test_ready_rejects_real_mode_without_provider_key(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    monkeypatch.setenv("ABYSS_FAKE_LLM", "0")
    monkeypatch.setenv("ABYSS_REAL_MODELS", "1")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with TestClient(server.app) as client:
        ready = client.get("/ready")
    assert ready.status_code == 503
    assert ready.json()["ok"] is False
    assert ready.json()["checks"]["provider"] is False
    assert "sk-" not in ready.text


def test_ready_rejects_unreadable_reputation(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    (tmp_path / "reputation.json").write_text("{", encoding="utf-8")
    with TestClient(server.app) as client:
        ready = client.get("/ready")
    assert ready.status_code == 503
    assert ready.json()["checks"]["reputation"] is False
    assert "Traceback" not in ready.text


def test_internal_crash_is_generic_and_connection_survives(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)

    async def boom(*args, **kwargs):
        raise RuntimeError("sk-ant-SECRETVALUE C:\\secret\\prompt.txt ignore previous instructions")

    monkeypatch.setattr(server, "run_job", boom)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "start_job", "job": "Explain why the sky is blue."})
            error = websocket.receive_json()
            assert error["type"] == "error" and error["data"]["fatal"] is True
            assert error["data"]["message"].startswith("internal error (")
            assert "SECRETVALUE" not in error["data"]["message"]
            assert "prompt.txt" not in error["data"]["message"]
            websocket.send_text("not json")
            follow = websocket.receive_json()
            assert follow["type"] == "error" and follow["data"]["fatal"] is False
        assert client.get("/health").json() == {"ok": True}


def test_oversized_websocket_message_is_nonfatal(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
            websocket.send_text("x" * (server.MAX_CLIENT_MESSAGE_CHARS + 1))
            error = websocket.receive_json()
            assert error["type"] == "error" and "maximum size" in error["data"]["message"]
            assert error["data"]["fatal"] is False
            websocket.send_text(json.dumps({"type": "unknown"}))
            follow = websocket.receive_json()
            assert follow["type"] == "error" and follow["data"]["fatal"] is False


def test_disconnect_cancels_the_running_task(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    state = {"started": False, "cancelled": False}

    async def hang(**kwargs):
        state["started"] = True
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise

    monkeypatch.setattr(server, "run_incident", hang)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "start_incident", "scenario_id": "ams_db_outage"})
            for _ in range(50):
                if state["started"]:
                    break
                time.sleep(0.01)
            assert state["started"]
    assert state["cancelled"]
    with TestClient(server.app) as client:
        assert client.get("/ready").status_code == 200


def test_reset_while_awaiting_approval_rejects_a_later_approve(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            events = [websocket.receive_json()]
            websocket.send_json({"type": "start_incident", "scenario_id": "ams_db_outage"})
            _receive_until(websocket, "approval_required", events)
            websocket.send_json({"type": "reset_incident"})
            event = websocket.receive_json()
            while not (event["type"] == "incident_status" and event["data"]["status"] == "healthy"):
                event = websocket.receive_json()
            websocket.send_json({"type": "approve_repair"})
            error = websocket.receive_json()
    assert error["type"] == "error"
    assert "awaiting approval" in error["data"]["message"]
    assert not any(item["type"] == "service_restored" for item in events)


def test_bad_json_and_unknown_type_return_errors(monkeypatch, tmp_path) -> None:
    server = _server(monkeypatch, tmp_path)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws") as websocket:
            websocket.receive_json()
            websocket.send_text("not json")
            assert websocket.receive_json()["type"] == "error"
            websocket.send_text(json.dumps({"type": "unknown"}))
            assert websocket.receive_json()["type"] == "error"
