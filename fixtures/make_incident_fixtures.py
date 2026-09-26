"""Record fixtures/incident_<scenario_id>.json for every MAYDAY scenario.

Each file is a real run of the Commander and the market in fake-LLM mode:
fixed job ids, fresh reputation, and a virtual clock that advances a scripted
amount after each event so replay has realistic pacing. Every number (costs,
scores, grades, reputation, MTTR, routing savings) comes from the engine. The
human approval is simulated right after approval_required. Re-run after any
contract change:

    backend/.venv/Scripts/python fixtures/make_incident_fixtures.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ["ABYSS_FAKE_LLM"] = "1"
os.environ["ABYSS_FAKE_DELAY"] = "0"
os.environ["ABYSS_LEDGER_PATH"] = str(Path(tempfile.mkdtemp()) / "ledger.jsonl")

import abyss.llm as llm_module  # noqa: E402
from abyss.contract import validate_stream  # noqa: E402
from abyss.events import EventStream  # noqa: E402
from abyss.llm import LLM  # noqa: E402
from abyss.mayday import IncidentControl, healthy_status, run_incident  # noqa: E402
from abyss.reputation import ReputationStore  # noqa: E402
from abyss.scenarios import SCENARIO_IDS, create  # noqa: E402

JOB_IDS = {scenario_id: f"j_5eb0a9{index:02x}" for index, scenario_id in enumerate(SCENARIO_IDS, start=0x11)}
# Milliseconds the next step takes after each event type.
PACE_MS = {
    "incident_received": 1400,
    "incident_status": 1600,
    "commander_classified": 2200,
    "specialists_dispatched": 1800,
    "responders_selected": 2200,
    "task_posted": 900,
    "bid": 700,
    "won": 900,
    "stats": 150,
    "working": 2600,
    "done": 900,
    "remediation_proposed": 1200,
    "sandbox_result": 2200,
    "graded": 700,
    "rep_update": 400,
    "remediation_plan_created": 1500,
    "human_assignments_created": 1500,
    "approval_required": 6000,
    "approval_granted": 1200,
    "service_restored": 1500,
    "routing_stats": 800,
}


async def record(scenario_id: str) -> list[dict]:
    events: list[dict] = []
    clock = [0.0]
    control = IncidentControl()
    # Fake calls report wall-clock durations; use the virtual clock so output is stable.
    llm_module.time = SimpleNamespace(monotonic=lambda: clock[0])

    async def sink(event: dict) -> None:
        events.append(event)
        clock[0] += PACE_MS.get(event["type"], 300) / 1000
        if event["type"] == "approval_required":
            control.approval.set()

    stream = EventStream(sink, clock=lambda: clock[0])
    rep = ReputationStore()
    sim = create(scenario_id)
    await stream.hello(rep)
    await stream.emit("incident_status", healthy_status(sim), job_id=None)
    await run_incident(stream=stream, llm=LLM(), rep=rep, sim=sim, control=control, job_id=JOB_IDS[scenario_id])
    return events


def main() -> None:
    for scenario_id in SCENARIO_IDS:
        events = asyncio.run(record(scenario_id))
        validate_stream(events)
        out = Path(__file__).with_name(f"incident_{scenario_id}.json")
        out.write_text(json.dumps(events, indent=2) + "\n", encoding="utf-8")
        restored = next(e["data"] for e in events if e["type"] == "service_restored")
        routing = next(e["data"] for e in events if e["type"] == "routing_stats")
        print(
            f"wrote {out.name} ({len(events)} events, MTTR {restored['mttr_ms'] / 1000:.1f}s, "
            f"cost ${restored['total_cost_usd']}, attempts {restored['repair_attempts']}, "
            f"~{routing['avoided_input_tokens_est']} input tokens avoided (estimate))"
        )


if __name__ == "__main__":
    main()
