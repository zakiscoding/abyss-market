"""Record fixtures/mayday_run.json by running the real MAYDAY workflow in fake-LLM mode.

Deterministic: a fixed job id, fresh reputation, the fake LLM, and a virtual clock
that advances a scripted amount after each event so replay has realistic pacing.
Every number (costs, scores, grades, reputation, MTTR) comes from the engine.
The human approval is simulated right after approval_required. Re-run after any
contract change:

    backend/.venv/Scripts/python fixtures/make_mayday_run.py
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
from abyss.incident import PaymentsSimulator  # noqa: E402
from abyss.llm import LLM  # noqa: E402
from abyss.mayday import IncidentControl, healthy_status, run_incident  # noqa: E402
from abyss.reputation import ReputationStore  # noqa: E402

JOB_ID = "j_5eb0a911"
# Milliseconds the next step takes after each event type.
PACE_MS = {
    "incident_status": 1800,
    "responders_selected": 2500,
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
    "approval_required": 6000,
    "service_restored": 1500,
}


async def record() -> list[dict]:
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
    sim = PaymentsSimulator()
    await stream.hello(rep)
    await stream.emit("incident_status", healthy_status(sim), job_id=None)
    await run_incident(stream=stream, llm=LLM(), rep=rep, sim=sim, control=control, job_id=JOB_ID)
    return events


def main() -> None:
    events = asyncio.run(record())
    validate_stream(events)
    out = Path(__file__).with_name("mayday_run.json")
    out.write_text(json.dumps(events, indent=2) + "\n", encoding="utf-8")
    restored = next(e["data"] for e in events if e["type"] == "service_restored")
    print(
        f"wrote {out} ({len(events)} events, MTTR {restored['mttr_ms'] / 1000:.1f}s, "
        f"cost ${restored['total_cost_usd']}, attempts {restored['repair_attempts']})"
    )


if __name__ == "__main__":
    main()
