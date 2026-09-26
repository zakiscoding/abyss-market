from __future__ import annotations

import asyncio

import pytest

from abyss.contract import validate_stream
from abyss.events import EventStream
from abyss.llm import LLM
from abyss.mayday import IncidentSession, emit_healthy, run_incident
from abyss.reputation import ReputationStore


@pytest.fixture
def fake_env(monkeypatch, tmp_path):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))
    monkeypatch.setenv("ABYSS_REP_PATH", str(tmp_path / "reputation.json"))


async def _run(auto_approve: bool = True):
    events: list[dict] = []
    session = IncidentSession()

    async def sink(event: dict) -> None:
        events.append(event)
        if auto_approve and event["type"] == "approval_required":
            session.approver = "Zak"
            session.approval.set()

    stream = EventStream(sink)
    rep = ReputationStore(None)
    await stream.hello(rep)
    await emit_healthy(stream, session.sim)
    result = await run_incident(stream=stream, llm=LLM(), rep=rep, session=session)
    return events, result, session, rep


def test_incident_runs_end_to_end_and_validates(fake_env) -> None:
    events, result, session, _ = asyncio.run(_run())
    validate_stream(events)
    assert result.status == "ok"
    assert session.sim.healthy

    statuses = [e["data"]["status"] for e in events if e["type"] == "incident_status"]
    assert statuses == [
        "healthy", "outage", "investigating", "repairing",
        "awaiting_approval", "recovering", "restored",
    ]
    types = [e["data"]["type"] for e in events if e["type"] == "task_posted"]
    assert types == ["diagnose", "remediate", "remediate", "verify"]
    assert all(
        sum(1 for e in events if e["type"] == "bid" and e["data"]["task_id"] == tid) == 3
        for tid in ("t1", "t2", "t3", "t4")
    )


def test_first_repair_fails_sandbox_second_passes(fake_env) -> None:
    events, *_ = asyncio.run(_run())
    sandboxes = [e["data"] for e in events if e["type"] == "sandbox_result"]
    assert [s["passed"] for s in sandboxes] == [False, True]
    assert sandboxes[0]["action"]["action"] == "restart_service"
    assert sandboxes[1]["action"] == {"action": "set_db_pool_size", "value": 20}
    approval = next(e for e in events if e["type"] == "approval_required")
    assert approval["data"]["approvers"] == ["Zak"]
    assert events.index(approval) > events.index(
        next(e for e in events if e["type"] == "sandbox_result" and e["data"]["passed"])
    )


def test_metrics_are_calculated(fake_env) -> None:
    events, result, _, _ = asyncio.run(_run())
    restored = next(e["data"] for e in events if e["type"] == "service_restored")
    final = events[-1]["data"]
    assert restored["total_cost_usd"] == result.ledger.total_cost() == final["total_cost_usd"]
    assert restored["repair_attempts"] == 2 and restored["failed_attempts"] == 1
    grades = [e["data"]["grade"] for e in events if e["type"] == "graded"]
    assert restored["mean_grade"] == round(sum(grades) / len(grades), 2)
    reps = [e["data"] for e in events if e["type"] == "rep_update"]
    assert [(r["old"], r["new"]) for r in restored["rep_changes"]] == [(r["old"], r["new"]) for r in reps]
    assert all(check["passed"] for check in restored["verification"])
    assert restored["approved_by"] == "Zak"


def test_failed_repair_lowers_remediation_reputation(fake_env) -> None:
    events, _, _, rep = asyncio.run(_run())
    first = next(e["data"] for e in events if e["type"] == "rep_update" and e["data"]["task_id"] == "t2")
    assert first["task_type"] == "remediate"
    assert first["new"] < first["old"]
    assert rep.get("haiku", "research") == 1.0


def test_workflow_waits_for_human_approval(fake_env) -> None:
    async def scenario():
        events: list[dict] = []
        session = IncidentSession()

        async def sink(event: dict) -> None:
            events.append(event)

        stream = EventStream(sink)
        rep = ReputationStore(None)
        await stream.hello(rep)
        task = asyncio.create_task(run_incident(stream=stream, llm=LLM(), rep=rep, session=session))
        while not session.awaiting_approval:
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
        assert events[-1]["type"] == "approval_required"
        assert not session.sim.healthy
        session.approval.set()
        await task
        return events, session

    events, session = asyncio.run(scenario())
    assert session.sim.healthy
    assert events[-1]["data"]["status"] == "ok"
