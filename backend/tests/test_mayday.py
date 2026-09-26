from __future__ import annotations

import asyncio

import pytest

from abyss.contract import validate_stream
from abyss.events import EventStream
from abyss.incident import PaymentsSimulator
from abyss.llm import LLM
from abyss.mayday import IncidentControl, run_incident
from abyss.reputation import ReputationStore
from abyss.responders import briefings, select_responders


@pytest.fixture
def fake_env(monkeypatch, tmp_path):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))


async def _run(approve: bool = True):
    events: list[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)

    stream = EventStream(sink)
    rep = ReputationStore()
    sim = PaymentsSimulator()
    control = IncidentControl()
    await stream.hello(rep)
    task = asyncio.create_task(
        run_incident(stream=stream, llm=LLM(), rep=rep, sim=sim, control=control)
    )
    for _ in range(500):
        if control.awaiting_approval or task.done():
            break
        await asyncio.sleep(0.001)
    paused = {
        "awaiting": control.awaiting_approval,
        "sim_healthy": sim.healthy(),
        "types": [e["type"] for e in events],
    }
    if approve:
        control.approval.set()
        await task
    else:
        task.cancel()
    return events, paused, rep, sim


def _of(events, kind):
    return [e for e in events if e["type"] == kind]


def test_incident_runs_full_valid_sequence(fake_env) -> None:
    events, paused, rep, sim = asyncio.run(_run())
    validate_stream(events)

    statuses = [e["data"]["status"] for e in _of(events, "incident_status")]
    assert statuses == [
        "outage", "investigating", "repairing", "awaiting_approval", "recovering", "restored",
    ]
    types = [e["data"]["type"] for e in _of(events, "task_posted")]
    assert types == ["diagnose", "remediate", "remediate", "verify"]
    assert all(len([b for b in _of(events, "bid") if b["data"]["task_id"] == t]) == 3
               for t in ("t1", "t2", "t3", "t4"))

    sandbox = _of(events, "sandbox_result")
    assert [s["data"]["action"]["action"] for s in sandbox] == ["restart_service", "set_db_pool_size"]
    assert [s["data"]["passed"] for s in sandbox] == [False, True]
    assert sim.healthy()
    assert events[-1]["type"] == "final" and events[-1]["data"]["status"] == "ok"


def test_workflow_pauses_for_human_approval(fake_env) -> None:
    events, paused, rep, sim = asyncio.run(_run(approve=False))
    assert paused["awaiting"] is True
    assert paused["sim_healthy"] is False
    assert paused["types"][-1] == "approval_required"
    assert "service_restored" not in paused["types"]


def test_restored_metrics_are_calculated(fake_env) -> None:
    events, _, rep, _ = asyncio.run(_run())
    restored = _of(events, "service_restored")[0]["data"]
    final = events[-1]["data"]
    stats = _of(events, "stats")[-1]["data"]
    assert restored["total_cost_usd"] == final["total_cost_usd"] == stats["total_cost_usd"]
    assert restored["repair_attempts"] == 2 and restored["failed_attempts"] == 1
    assert restored["action"] == {"action": "set_db_pool_size", "value": 20}
    assert all(check["passed"] for check in restored["verification"])
    assert restored["approved_by"] == "Zak"
    outage_t = _of(events, "incident_status")[0]["t"]
    restored_t = _of(events, "incident_status")[-1]["t"]
    assert restored["mttr_ms"] >= restored_t - outage_t - 5
    winning_bid = next(
        b["data"] for b in _of(events, "bid")
        if b["data"]["task_id"] == "t3" and b["data"]["agent_id"] == _of(events, "won")[2]["data"]["agent_id"]
    )
    assert restored["confidence"] == winning_bid["confidence"]

    failed_repair = _of(events, "rep_update")[1]["data"]
    assert failed_repair["task_type"] == "remediate" and failed_repair["new"] < failed_repair["old"]
    assert rep.get(failed_repair["agent_id"], "research") == 1.0


def test_responder_selection_matches_db_incident() -> None:
    sim = PaymentsSimulator()
    sim.break_production()
    required, responders = select_responders(sim.telemetry(), sim.changes, "SEV-1")
    selected = {r["name"]: r["role"] for r in responders if r["selected"]}
    assert selected == {
        "Zak": "Incident Commander",
        "Maya": "Database Engineer",
        "Alex": "Backend Engineer",
        "Jordan": "Customer Support Lead",
    }
    sam = next(r for r in responders if r["name"] == "Sam")
    assert not sam["selected"] and sam["reason"]

    notes = briefings(sim.telemetry(), sim.changes, "SEV-1", responders)
    assert "cfg-2291" in notes["engineering"] and "timeouts" in notes["engineering"]
    assert "checkouts" in notes["support"] and "cfg" not in notes["support"]
    assert "approve" in notes["commander"]
    assert "$" in notes["leadership"]


def test_healthy_service_pages_nobody() -> None:
    sim = PaymentsSimulator()
    _, responders = select_responders(sim.telemetry(), sim.changes, None)
    assert not any(r["selected"] for r in responders)
