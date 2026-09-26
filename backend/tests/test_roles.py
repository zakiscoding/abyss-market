from __future__ import annotations

from copy import deepcopy

import pytest

from abyss.agents import build_work_prompt, do_work, est_input_tokens, request_bid
from abyss.config import AGENTS
from abyss.ledger import Ledger
from abyss.llm import LLM, LLMError, LLMResult
from abyss.orchestrator import TaskSpec, split_job
from abyss.reviewer import review


class StubLLM:
    def __init__(self, results: list[LLMResult]):
        self.results = list(results)
        self.calls: list[dict] = []

    async def call(self, **kwargs) -> LLMResult:
        self.calls.append(kwargs)
        return self.results.pop(0)


def result(data: dict | None, text: str = "text") -> LLMResult:
    return LLMResult(
        text=text,
        data=data,
        usage={
            "model": "claude-haiku-4-5",
            "input_tokens": 10,
            "output_tokens": 5,
            "cost_usd": 0.000035,
            "duration_ms": 1,
        },
        stop_reason="end_turn",
    )


@pytest.mark.asyncio
async def test_fake_role_shapes(monkeypatch) -> None:
    monkeypatch.setenv("ABYSS_FAKE_LLM", "1")
    monkeypatch.setenv("ABYSS_FAKE_DELAY", "0")
    llm = LLM()
    ledger = Ledger("j_00000001", None)
    tasks, split_usage = await split_job(llm, ledger, "Explain a fact, then check it.")
    assert [task.type for task in tasks] == ["research", "writing", "checking"]
    assert tasks[1].depends_on == ["t1"]
    assert split_usage["model"] == "claude-sonnet-5"

    raw_bid, bid_usage = await request_bid(
        llm,
        ledger,
        AGENTS[0],
        "Explain a fact, then check it.",
        tasks[0],
        {},
        1.0,
    )
    assert set(raw_bid) == {
        "predicted_output_tokens",
        "promised_quality",
        "confidence",
        "pitch",
    }
    assert bid_usage["model"] == AGENTS[0].model

    output, work_usage = await do_work(
        llm, ledger, AGENTS[0], "Explain a fact.", tasks[0], {}
    )
    assert "Find the accurate facts and caveats needed for" in output
    assert work_usage["model"] == AGENTS[0].model

    grade, rationale, review_usage = await review(
        llm, ledger, "Explain a fact.", tasks[0], {}, output
    )
    assert 1 <= grade <= 10
    assert rationale
    assert review_usage["model"] == "claude-sonnet-5"


@pytest.mark.asyncio
async def test_split_sanitizes_dependencies_and_limits_tasks() -> None:
    raw_tasks = [
        {
            "type": "research" if index == 0 else "writing",
            "title": "x" * 60,
            "brief": "y" * 400,
            "depends_on": [0, index, index + 1, -1],
        }
        for index in range(7)
    ]
    stub = StubLLM([result({"tasks": raw_tasks})])

    tasks, _ = await split_job(stub, Ledger("j_00000001", None), "job")

    assert len(tasks) == 5
    assert tasks[0].depends_on == []
    assert tasks[1].depends_on == ["t1"]
    assert len(tasks[0].title) == 40
    assert len(tasks[0].brief) == 300


@pytest.mark.asyncio
async def test_split_retries_once_for_too_few_tasks() -> None:
    one_task = {
        "tasks": [
            {
                "type": "writing",
                "title": "Only",
                "brief": "Only one task",
                "depends_on": [],
            }
        ]
    }
    two_tasks = {
        "tasks": [
            {
                "type": "research",
                "title": "Research",
                "brief": "Research facts",
                "depends_on": [],
            },
            {
                "type": "writing",
                "title": "Write",
                "brief": "Write answer",
                "depends_on": [0],
            },
        ]
    }
    stub = StubLLM([result(one_task), result(two_tasks)])

    tasks, _ = await split_job(stub, Ledger("j_00000001", None), "job")

    assert len(tasks) == 2
    assert len(stub.calls) == 2


@pytest.mark.asyncio
async def test_split_raises_after_one_retry() -> None:
    invalid = result({"tasks": []})
    stub = StubLLM([deepcopy(invalid), deepcopy(invalid)])
    with pytest.raises(LLMError):
        await split_job(stub, Ledger("j_00000001", None), "job")


@pytest.mark.asyncio
async def test_bid_prompt_uses_dependency_sizes_not_contents() -> None:
    secret = "DEPENDENCY SECRET TEXT"
    stub = StubLLM(
        [
            result(
                {
                    "predicted_output_tokens": 100,
                    "promised_quality": 8,
                    "pitch": "pitch",
                }
            )
        ]
    )
    task = TaskSpec("t2", "writing", "Write", "Write the answer", ["t1"])

    await request_bid(
        stub,
        Ledger("j_00000001", None),
        AGENTS[0],
        "job",
        task,
        {"t1": len(secret)},
        1.0,
    )

    prompt = stub.calls[0]["user"]
    assert str(len(secret)) in prompt
    assert secret not in prompt


@pytest.mark.asyncio
async def test_work_token_estimate_uses_exact_prompt() -> None:
    task = TaskSpec("t2", "writing", "Write", "Write a clear answer", ["t1"])
    system, user = build_work_prompt("job", task, {"t1": "facts"})
    stub = StubLLM([result(None, "answer")])

    await do_work(
        stub,
        Ledger("j_00000001", None),
        AGENTS[0],
        "job",
        task,
        {"t1": "facts"},
    )

    assert stub.calls[0]["system"] == system
    assert stub.calls[0]["user"] == user
    assert est_input_tokens(system, user) == -(-(len(system + user)) // 4)


@pytest.mark.asyncio
async def test_review_is_blind_and_clamps_result() -> None:
    stub = StubLLM([result({"grade": 14, "rationale": "r" * 250})])
    task = TaskSpec("t1", "research", "Research", "Find facts", [])

    grade, rationale, _ = await review(
        stub,
        Ledger("j_00000001", None),
        "job",
        task,
        {},
        "output",
    )

    prompt = stub.calls[0]["system"] + stub.calls[0]["user"]
    assert "haiku" not in prompt.lower()
    assert "promised quality" not in prompt.lower()
    assert grade == 10
    assert len(rationale) == 200
