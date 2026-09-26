from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from abyss import commander, config
from abyss.contract import CommanderClassifiedData
from abyss.ledger import Ledger
from abyss.llm import LLMError
from abyss.scenarios import SCENARIO_IDS, create

RULES = {
    "payments_pool": ("database", ["payments"], "SEV-1"),
    "ams_db_outage": ("database", ["networking"], "SEV-1"),
    "auth_attack": ("security", [], "SEV-2"),
    "network_partition": ("networking", [], "SEV-1"),
}


def _package(scenario_id: str) -> dict:
    sim = create(scenario_id)
    sim.break_production()
    return commander.incident_package(sim)


class StubLLM:
    def __init__(self, data=None, error: Exception | None = None):
        self.data, self.error, self.calls = data, error, []

    async def call(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        usage = {"model": kwargs["nominal_model"], "input_tokens": 10, "output_tokens": 5,
                 "cost_usd": 0.0001, "duration_ms": 1}
        return SimpleNamespace(data=self.data, usage=usage, text="")


def _classify(llm, scenario_id: str, tmp_path) -> dict:
    ledger = Ledger("j_00000000", tmp_path / "ledger.jsonl")
    result = asyncio.run(commander.classify(llm, ledger, _package(scenario_id)))
    CommanderClassifiedData.model_validate(
        {"scenario_id": scenario_id, "required_specialties": ["x"], **result}
    )
    return result


@pytest.mark.parametrize("scenario_id", SCENARIO_IDS)
def test_rules_classify_every_scenario(scenario_id) -> None:
    result = commander.rules_classify(_package(scenario_id))
    assert (result["domain"], result["secondary_domains"], result["severity"]) == RULES[scenario_id]
    assert result["rationale"]


def test_package_is_compressed() -> None:
    sim = create("ams_db_outage")
    sim.break_production()
    package = commander.incident_package(sim)
    assert len(package["log_excerpt"]) <= commander.LOG_EXCERPT_LINES
    assert all(not item["ok"] for item in package["breached"])
    assert commander.package_tokens(package) < commander.full_context_tokens(sim)


def test_unclear_incident_goes_to_generalists() -> None:
    package = {"service": "misc", "region": "iad", "source_system": "x", "alert": "something odd",
               "breached": [], "log_excerpt": [], "recent_changes": []}
    result = commander.rules_classify(package)
    assert result["domain"] == "generalist" and result["severity"] == "SEV-3"


def test_valid_model_answer_is_used(tmp_path) -> None:
    llm = StubLLM({"domain": "security", "secondary_domains": ["security", "payments"],
                   "severity": "SEV-2", "rationale": "Login failures from a few sources."})
    result = _classify(llm, "auth_attack", tmp_path)
    assert result["source"] == "model" and result["fallback_reason"] is None
    assert result["domain"] == "security" and result["secondary_domains"] == ["payments"]
    assert llm.calls[0]["purpose"] == "split" and llm.calls[0]["schema"]
    assert "Incident package" in llm.calls[0]["user"] and "telemetry" not in llm.calls[0]["user"]


def test_model_cannot_downgrade_rule_severity(tmp_path) -> None:
    llm = StubLLM({"domain": "database", "secondary_domains": [], "severity": "SEV-3", "rationale": "Minor."})
    result = _classify(llm, "ams_db_outage", tmp_path)
    assert result["severity"] == "SEV-1" and "raised" in result["rationale"]


@pytest.mark.parametrize("bad", [
    None,
    {"domain": "kubernetes", "secondary_domains": [], "severity": "SEV-1", "rationale": "x"},
    {"domain": "database", "secondary_domains": [], "severity": "P0", "rationale": "x"},
    {"domain": "database", "secondary_domains": "networking", "severity": "SEV-1", "rationale": "x"},
    {"domain": "database", "severity": "SEV-1", "rationale": "x"},
    {"domain": "database", "secondary_domains": [], "severity": "SEV-1", "rationale": "", "extra": 1},
])
def test_invalid_model_output_falls_back_to_rules(tmp_path, bad) -> None:
    result = _classify(StubLLM(bad), "network_partition", tmp_path)
    assert result["source"] == "rules" and "invalid" in result["fallback_reason"]
    assert result["domain"] == "networking" and result["usage"] is not None


def test_model_failure_falls_back_to_rules(tmp_path) -> None:
    result = _classify(StubLLM(error=LLMError("timeout")), "payments_pool", tmp_path)
    assert result["source"] == "rules" and result["usage"] is None
    assert result["domain"] == "database"


def test_dispatch_selects_only_the_domain_market() -> None:
    data = commander.dispatch("networking")
    chosen = [s for s in data["specialists"] if s["dispatched"]]
    assert data["registered"] == len(config.DOMAINS) * 3
    assert data["eligible"] == 3 and {s["domain"] for s in chosen} == {"networking"}
    assert [s["label"] for s in chosen] == [
        "Networking Specialist · Haiku", "Networking Specialist · Sonnet", "Networking Specialist · Opus",
    ]
