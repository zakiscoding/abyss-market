from __future__ import annotations

from abyss.incident import PaymentsSimulator
from abyss.responders import select_responders


def _broken() -> PaymentsSimulator:
    sim = PaymentsSimulator()
    sim.break_production()
    return sim


def test_db_incident_selects_the_right_team() -> None:
    sim = _broken()
    team = select_responders(sim.telemetry(), sim.config_changes())
    selected = {r["role"] for r in team["responders"] if r["selected"]}
    assert team["severity"] == "SEV-1"
    assert selected == {
        "Incident Commander",
        "Database Engineer",
        "Backend Engineer",
        "Customer Support",
    }
    sam = next(r for r in team["responders"] if r["name"] == "Sam")
    assert not sam["selected"] and sam["reason"]
    assert all(r["reason"] for r in team["responders"])


def test_selection_is_deterministic() -> None:
    sim = _broken()
    assert select_responders(sim.telemetry(), sim.config_changes()) == select_responders(
        sim.telemetry(), sim.config_changes()
    )


def test_briefings_are_tailored_and_use_live_numbers() -> None:
    sim = _broken()
    t = sim.telemetry()
    briefings = select_responders(t, sim.config_changes())["briefings"]
    assert str(t["p95_latency_ms"]) in briefings["engineering"]
    assert "db.pool.max_size" in briefings["engineering"]
    assert "customers" in briefings["support"]
    assert "approve" in briefings["commander"]
    assert "payments" in briefings["leadership"]
    assert len(set(briefings.values())) == 4


def test_healthy_service_needs_nobody_but_standby() -> None:
    sim = PaymentsSimulator()
    team = select_responders(sim.telemetry(), sim.config_changes())
    assert team["severity"] == "SEV-3"
    assert not any(r["selected"] for r in team["responders"])
