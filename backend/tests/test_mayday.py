from __future__ import annotations

import asyncio
import json

import pytest

from abyss import config, mayday
from abyss.contract import validate_stream
from abyss.events import EventStream
from abyss.incident import ProductionApplyError, Scenario, action, plan_fingerprint
from abyss.llm import LLM
from abyss.mayday import IncidentControl, avoided_cost_usd, avoided_input_tokens, routing_method, run_incident, specialist_route_counts
from abyss.reputation import ReputationStore
from abyss.responders import assign, customer_impact, required_skills, select_responders
from abyss.scenarios import SCENARIO_IDS, SCENARIOS, create

EXPECTED = {
    "payments_pool": {
        "domain": "database", "severity": "SEV-1",
        "paged": {"Zak", "Maya", "Alex", "Jordan"}, "approvers": ["Maya", "Zak"],
        "fix": ["set_db_pool_size"], "decoy": ["restart_service"],
    },
    "ams_db_outage": {
        "domain": "database", "severity": "SEV-1",
        "paged": {"Zak", "Maya", "Riley", "Jordan"}, "approvers": ["Maya", "Riley", "Zak"],
        "fix": ["failover_db", "route_traffic"], "decoy": ["restart_db"],
    },
    "auth_attack": {
        "domain": "security", "severity": "SEV-2",
        "paged": {"Sam", "Jordan"}, "approvers": ["Sam"],
        "fix": ["apply_rate_limit", "block_ips"], "decoy": ["restart_service"],
    },
    "network_partition": {
        "domain": "networking", "severity": "SEV-1",
        "paged": {"Zak", "Riley", "Jordan"}, "approvers": ["Riley", "Zak"],
        "fix": ["route_traffic"], "decoy": ["restart_service"],
    },
}


@pytest.fixture
def fake_env(monkeypatch, tmp_path):
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    monkeypatch.setenv("ABYSS_LEDGER_PATH", str(tmp_path / "ledger.jsonl"))


async def _run(scenario_id: str = "payments_pool", approve: bool = True, sim=None):
    events: list[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)

    stream = EventStream(sink)
    rep = ReputationStore()
    sim = sim or create(scenario_id)
    control = IncidentControl()
    await stream.hello(rep)
    task = asyncio.create_task(run_incident(stream=stream, llm=LLM(), rep=rep, sim=sim, control=control))
    for _ in range(1000):
        if control.awaiting_approval or task.done():
            break
        await asyncio.sleep(0.001)
    paused = {"awaiting": control.awaiting_approval, "sim_healthy": sim.healthy(), "types": [e["type"] for e in events]}
    if approve:
        if control.awaiting_approval:
            assert control.grant()
        await task
    else:
        task.cancel()
    return events, paused, rep, sim


def _of(events, kind):
    return [e for e in events if e["type"] == kind]


def _one(events, kind):
    return _of(events, kind)[0]["data"]


@pytest.mark.parametrize("scenario_id", SCENARIO_IDS)
def test_scenario_runs_the_full_commander_flow(fake_env, scenario_id) -> None:
    expected = EXPECTED[scenario_id]
    events, _, rep, sim = asyncio.run(_run(scenario_id))
    validate_stream(events)

    received = _one(events, "incident_received")
    assert received["scenario_id"] == scenario_id
    assert received["package_tokens_est"] < received["full_context_tokens_est"]
    classified = _one(events, "commander_classified")
    assert (classified["domain"], classified["severity"], classified["source"]) == (
        expected["domain"], expected["severity"], "model")

    dispatched = _one(events, "specialists_dispatched")
    chosen = [s for s in dispatched["specialists"] if s["dispatched"]]
    assert {s["domain"] for s in chosen} == {expected["domain"]}
    assert dispatched["registered"] == len(config.specialists()) and dispatched["eligible"] == 3
    assert chosen[0]["label"].startswith(config.DOMAIN_LABELS[expected["domain"]] + " · ")

    assert all(e["data"]["domain"] == expected["domain"] for e in _of(events, "task_posted"))
    assert [e["data"]["type"] for e in _of(events, "task_posted")] == ["diagnose", "remediate", "remediate", "verify"]
    sandbox = [(s["data"]["passed"], [step["action"] for step in s["data"]["steps"]]) for s in _of(events, "sandbox_result")]
    assert sandbox == [(False, expected["decoy"]), (True, expected["fix"])]

    paged = {r["name"] for r in _one(events, "responders_selected")["responders"] if r["selected"]}
    assert paged == expected["paged"]
    assignments = _one(events, "human_assignments_created")
    assert assignments["required_approvers"] == expected["approvers"]
    assert _one(events, "approval_granted")["approved_by"] == expected["approvers"]

    restored = _one(events, "service_restored")
    assert restored["approved_by"] == expected["approvers"]
    assert all(check["passed"] for check in restored["verification"])
    assert all(change["rep_key"] == f"{expected['domain']}.{change['task_type']}" for change in restored["rep_changes"])
    assert sim.healthy()
    assert events[-1]["type"] == "final" and events[-1]["data"]["status"] == "ok"


@pytest.mark.parametrize("scenario_id", ["ams_db_outage", "auth_attack"])
def test_workflow_pauses_for_human_approval(fake_env, scenario_id) -> None:
    _, paused, _, _ = asyncio.run(_run(scenario_id, approve=False))
    assert paused["awaiting"] is True
    assert paused["sim_healthy"] is False
    assert paused["types"][-1] == "approval_required"
    assert "human_assignments_created" in paused["types"]
    assert "approval_granted" not in paused["types"] and "service_restored" not in paused["types"]


def test_restored_metrics_and_routing_are_calculated(fake_env) -> None:
    events, _, rep, _ = asyncio.run(_run("ams_db_outage"))
    restored = _one(events, "service_restored")
    final = events[-1]["data"]
    stats = _of(events, "stats")[-1]["data"]
    routing = _one(events, "routing_stats")
    assert restored["total_cost_usd"] == final["total_cost_usd"] == stats["total_cost_usd"] == routing["actual_cost_usd"]
    assert routing["actual_input_tokens"] == stats["input_tokens"]
    assert routing["actual_calls"] == stats["calls"]
    assert restored["repair_attempts"] == 2 and restored["failed_attempts"] == 1
    assert routing["auctions"] == 4
    assert routing["models_contacted"] == 12 and routing["models_skipped"] == 48
    assert routing["avoided_input_tokens_est"] > 0 and routing["avoided_cost_usd_est"] > 0
    assert "Estimate" in routing["method"] and "specialist routes" in routing["method"]
    assert "simulated" in routing["method"]
    assert "foundation model" not in routing["method"].lower()
    assert "specialist routes" in _one(events, "specialists_dispatched")["reason"]
    bids = [b for b in _of(events, "bid") if b["data"]["task_id"] == "t3"]
    winner = _of(events, "won")[2]["data"]["agent_id"]
    assert restored["confidence"] == next(b["data"]["confidence"] for b in bids if b["data"]["agent_id"] == winner)

    failed_repair = _of(events, "rep_update")[1]["data"]
    assert failed_repair["rep_key"] == "database.remediate" and failed_repair["new"] < failed_repair["old"]
    assert rep.get(failed_repair["agent_id"], "security.remediate") == 1.0
    assert rep.get(failed_repair["agent_id"], "research") == 1.0


def test_no_passing_plan_escalates_to_humans(fake_env, monkeypatch) -> None:
    monkeypatch.setattr(SCENARIOS["network_partition"], "fix_plan", [action("restart_db", region="fra")])
    sim = create("network_partition")
    events, _, _, _ = asyncio.run(_run(sim=sim))
    validate_stream(events)
    assert len(_of(events, "sandbox_result")) == config.MAX_REPAIR_ATTEMPTS
    assert not any(s["data"]["passed"] for s in _of(events, "sandbox_result"))
    escalated = _one(events, "incident_escalated")
    assert escalated["attempts"] == config.MAX_REPAIR_ATTEMPTS
    assert set(escalated["escalated_to"]) == {"Zak", "Riley"}
    assert "approval_required" not in [e["type"] for e in events]
    assert _of(events, "incident_status")[-1]["data"]["status"] == "failed"
    assert events[-2]["type"] == "routing_stats" and events[-1]["data"]["status"] == "error"
    assert not sim.healthy()


def test_briefings_are_tailored_per_audience() -> None:
    sim = create("payments_pool")
    sim.break_production()
    notes = sim.briefings("SEV-1", "Zak, Maya")
    assert "cfg-2291" in notes["engineering"] and "timeouts" in notes["engineering"]
    assert "checkouts" in notes["support"] and "cfg" not in notes["support"]
    assert "approve" in notes["commander"]
    assert "$" in notes["leadership"]
    for scenario_id in SCENARIO_IDS:
        other = create(scenario_id)
        other.break_production()
        assert set(other.briefings("SEV-1", "Zak")) == {"engineering", "support", "commander", "leadership"}


def test_healthy_service_pages_nobody() -> None:
    sim = create("payments_pool")
    assert customer_impact(sim.telemetry()) is False
    assert not any(r["selected"] for r in select_responders([], None))


def test_assignments_follow_ownership_rules() -> None:
    people = select_responders(required_skills("database", [], "SEV-1", True), "SEV-1")
    items, approvers = assign(SCENARIOS["ams_db_outage"].fix_plan, "SEV-1", people, True)
    owners = [(item["name"], item["approval_required"]) for item in items]
    assert owners == [("Maya", True), ("Riley", True), ("Zak", True), ("Jordan", False)]
    assert approvers == ["Maya", "Riley", "Zak"]
    assert "Paged for this step" in items[1]["reason"]
    items, approvers = assign(SCENARIOS["auth_attack"].fix_plan, "SEV-2", people, False)
    assert approvers == ["Sam"] and all(item["name"] == "Sam" for item in items)


def test_plan_mutation_after_sandbox_is_rejected(fake_env, monkeypatch) -> None:
    real = plan_fingerprint
    state = {"n": 0}

    def flip(steps):
        state["n"] += 1
        digest = real(steps)
        return "0" * 64 if state["n"] >= 2 else digest

    monkeypatch.setattr(mayday, "plan_fingerprint", flip)
    events, _, _, sim = asyncio.run(_run("ams_db_outage"))
    assert state["n"] >= 2
    assert not any(event["type"] == "service_restored" for event in events)
    assert events[-1]["data"]["status"] == "error"
    assert not sim.healthy()
    assert "sandbox-approved" in _one(events, "incident_escalated")["reason"]


def test_apply_failure_does_not_mark_restored(fake_env, monkeypatch) -> None:
    def explode(self, steps):
        raise ProductionApplyError("remediation could not be applied")

    monkeypatch.setattr(Scenario, "apply_production", explode)
    events, _, _, sim = asyncio.run(_run("ams_db_outage"))
    assert not any(event["type"] == "service_restored" for event in events)
    assert events[-1]["data"]["status"] == "error"
    assert not sim.healthy()
    blob = json.dumps(events)
    assert "Traceback" not in blob and "sk-" not in blob


def test_duplicate_approval_consumes_once() -> None:
    control = IncidentControl()
    digest = plan_fingerprint([action("restart_service")])
    control.arm(digest)
    assert control.grant()
    assert control.grant() is False
    assert control.consume(digest)
    assert control.consume(digest) is False
    assert control.grant() is False


def test_reset_while_awaiting_clears_pending_plan() -> None:
    control = IncidentControl()
    digest = plan_fingerprint([action("failover_db", region="fra"), action("route_traffic", region="fra")])
    control.arm(digest)
    assert control.awaiting_approval and control.plan_hash == digest
    control.clear()
    assert control.plan_hash is None and control.awaiting_approval is False
    assert control.grant() is False
    assert control.consume(digest) is False


def test_mutated_plan_hash_is_rejected() -> None:
    control = IncidentControl()
    steps = [action("failover_db", region="fra")]
    control.arm(plan_fingerprint(steps))
    assert control.grant()
    steps.append(action("route_traffic", region="fra"))
    assert control.consume(plan_fingerprint(steps)) is False
    assert control.plan_hash is None


def test_route_counts_do_not_double_count_compression() -> None:
    assert len(config.specialists()) == 15 and len(config.AGENTS) == 3
    contacted, skipped = specialist_route_counts(15, 3, 4)
    assert contacted == 12 and skipped == 48
    assert skipped == (15 - 3) * 4
    saved = avoided_input_tokens(skipped_tokens=1000, full_tokens=500, package_tokens=80)
    assert saved == 1000 + (500 - 80)
    assert saved != 1000 + (500 - 80) * 4
    assert avoided_cost_usd(1.5, 0.25) == 1.75


def test_routing_language_depends_on_provider_mode(monkeypatch) -> None:
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    fake = routing_method()
    assert "specialist routes" in fake and "simulated" in fake and "Estimate" in fake
    monkeypatch.delenv("ABYSS_FAKE_LLM", raising=False)
    monkeypatch.setenv("ABYSS_REAL_MODELS", "1")
    live = routing_method()
    assert "actual provider cost" in live
    assert "simulated" not in live
