from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

import anthropic

from . import config, prompts
from .ledger import Ledger, cost_usd


Purpose = Literal["split", "bid", "work", "review"]
NETWORK_TIMEOUT_SECONDS = 120.0
THINKING_PAD = {
    "claude-haiku-4-5": 0,
    "claude-sonnet-5": 150,
    "claude-opus-5": 300,
}


@dataclass
class LLMResult:
    text: str
    data: dict | None
    usage: dict
    stop_reason: str | None


class LLMError(Exception):
    pass


class LLM:
    def __init__(self, client: Any | None = None) -> None:
        self._fake = config.fake_llm()
        self._client = client

    async def call(
        self,
        *,
        ledger: Ledger,
        purpose: Purpose,
        nominal_model: str,
        system: str,
        user: str,
        max_tokens: int,
        effort: str | None = None,
        schema: dict | None = None,
        task_id: str | None = None,
        agent_id: str | None = None,
    ) -> LLMResult:
        if self._fake:
            return await self._fake_call(
                ledger=ledger,
                purpose=purpose,
                nominal_model=nominal_model,
                system=system,
                user=user,
                schema=schema,
                task_id=task_id,
                agent_id=agent_id,
            )

        model = config.resolve_model(nominal_model)
        started = time.monotonic()
        client = self._get_client()
        request = self._request(
            model=model,
            system=system,
            user=user,
            max_tokens=max_tokens,
            effort=effort,
            schema=schema,
        )

        try:
            response = await self._create(client, request)
        except anthropic.APIStatusError as exc:
            if schema is None or model != "claude-haiku-4-5" or exc.status_code != 400:
                self._record_error(
                    ledger, purpose, model, task_id, agent_id, started, str(exc)
                )
                raise LLMError(str(exc)) from exc
            fallback = self._fallback_request(request, system, schema)
            try:
                response = await self._create(client, fallback)
            except (
                anthropic.APIStatusError,
                anthropic.APIConnectionError,
                asyncio.TimeoutError,
            ) as fallback_exc:
                self._record_error(
                    ledger,
                    purpose,
                    model,
                    task_id,
                    agent_id,
                    started,
                    str(fallback_exc),
                )
                raise LLMError(str(fallback_exc)) from fallback_exc
        except (anthropic.APIConnectionError, asyncio.TimeoutError) as exc:
            self._record_error(
                ledger, purpose, model, task_id, agent_id, started, str(exc)
            )
            raise LLMError(str(exc)) from exc

        return self._result_from_response(
            ledger=ledger,
            purpose=purpose,
            model=model,
            response=response,
            schema=schema,
            task_id=task_id,
            agent_id=agent_id,
            started=started,
        )

    def _get_client(self) -> Any:
        if self._client is None:
            self._client = anthropic.AsyncAnthropic(timeout=NETWORK_TIMEOUT_SECONDS)
        return self._client

    async def _create(self, client: Any, request: dict[str, Any]) -> Any:
        return await asyncio.wait_for(
            client.messages.create(**request), timeout=NETWORK_TIMEOUT_SECONDS
        )

    @staticmethod
    def _request(
        *,
        model: str,
        system: str,
        user: str,
        max_tokens: int,
        effort: str | None,
        schema: dict | None,
    ) -> dict[str, Any]:
        request: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        output_config: dict[str, Any] = {}
        if effort is not None and model in config.SUPPORTS_EFFORT:
            output_config["effort"] = effort
        if schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": schema}
        if output_config:
            request["output_config"] = output_config
        return request

    @staticmethod
    def _fallback_request(
        request: dict[str, Any], system: str, schema: dict
    ) -> dict[str, Any]:
        fallback = dict(request)
        output_config = dict(fallback.get("output_config", {}))
        output_config.pop("format", None)
        if output_config:
            fallback["output_config"] = output_config
        else:
            fallback.pop("output_config", None)
        schema_text = json.dumps(schema, separators=(",", ":"))
        fallback["system"] = (
            system
            + "\n\nRespond with only a JSON object matching this schema: "
            + schema_text
        )
        return fallback

    def _result_from_response(
        self,
        *,
        ledger: Ledger,
        purpose: Purpose,
        model: str,
        response: Any,
        schema: dict | None,
        task_id: str | None,
        agent_id: str | None,
        started: float,
    ) -> LLMResult:
        text_blocks = _text_blocks(response)
        text = "".join(text_blocks)
        stop_reason = getattr(response, "stop_reason", None)
        usage_values = _usage_values(response)
        duration_ms = _duration_ms(started)
        price = cost_usd(
            model,
            usage_values["input_tokens"],
            usage_values["output_tokens"],
            usage_values["cache_read_input_tokens"],
            usage_values["cache_creation_input_tokens"],
        )

        if stop_reason == "refusal":
            self._record(
                ledger,
                purpose,
                model,
                task_id,
                agent_id,
                usage_values,
                price,
                duration_ms,
                False,
                stop_reason,
                "refusal",
            )
            raise LLMError("model refused the request")

        data: dict | None = None
        if schema is not None:
            try:
                data = _parse_json_object(text_blocks[0] if text_blocks else "")
            except (json.JSONDecodeError, ValueError, IndexError) as exc:
                self._record(
                    ledger,
                    purpose,
                    model,
                    task_id,
                    agent_id,
                    usage_values,
                    price,
                    duration_ms,
                    False,
                    stop_reason,
                    str(exc),
                )
                raise LLMError(f"invalid JSON response: {exc}") from exc

        self._record(
            ledger,
            purpose,
            model,
            task_id,
            agent_id,
            usage_values,
            price,
            duration_ms,
            True,
            stop_reason,
            None,
        )
        usage = {
            "model": model,
            "input_tokens": usage_values["input_tokens"],
            "output_tokens": usage_values["output_tokens"],
            "cost_usd": price,
            "duration_ms": duration_ms,
        }
        return LLMResult(text=text, data=data, usage=usage, stop_reason=stop_reason)

    async def _fake_call(
        self,
        *,
        ledger: Ledger,
        purpose: Purpose,
        nominal_model: str,
        system: str,
        user: str,
        schema: dict | None,
        task_id: str | None,
        agent_id: str | None,
    ) -> LLMResult:
        started = time.monotonic()
        await asyncio.sleep(config.fake_delay())
        digest = hashlib.sha256(
            (purpose + nominal_model + user).encode("utf-8")
        ).digest()
        text, data = _fake_output(purpose, user, digest, system)
        if schema is None:
            data = None
        input_tokens = len(system + user) // 4
        output_tokens = len(text) // 4 + THINKING_PAD[nominal_model]
        price = cost_usd(nominal_model, input_tokens, output_tokens)
        duration_ms = _duration_ms(started)
        usage_values = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }
        self._record(
            ledger,
            purpose,
            nominal_model,
            task_id,
            agent_id,
            usage_values,
            price,
            duration_ms,
            True,
            "end_turn",
            None,
        )
        usage = {
            "model": nominal_model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": price,
            "duration_ms": duration_ms,
        }
        return LLMResult(text=text, data=data, usage=usage, stop_reason="end_turn")

    @staticmethod
    def _record(
        ledger: Ledger,
        purpose: Purpose,
        model: str,
        task_id: str | None,
        agent_id: str | None,
        usage: dict[str, int],
        price: float,
        duration_ms: int,
        ok: bool,
        stop_reason: str | None,
        error: str | None,
    ) -> None:
        ledger.record(
            task_id=task_id,
            agent_id=agent_id if purpose in {"bid", "work"} else None,
            purpose=purpose,
            model=model,
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            cache_read_input_tokens=usage["cache_read_input_tokens"],
            cache_creation_input_tokens=usage["cache_creation_input_tokens"],
            cost_usd=price,
            ok=ok,
            stop_reason=stop_reason,
            error=error,
            duration_ms=duration_ms,
        )

    def _record_error(
        self,
        ledger: Ledger,
        purpose: Purpose,
        model: str,
        task_id: str | None,
        agent_id: str | None,
        started: float,
        error: str,
    ) -> None:
        self._record(
            ledger,
            purpose,
            model,
            task_id,
            agent_id,
            {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
            0.0,
            _duration_ms(started),
            False,
            None,
            error,
        )


def _duration_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


def _text_blocks(response: Any) -> list[str]:
    texts: list[str] = []
    for block in getattr(response, "content", []):
        block_type = block.get("type") if isinstance(block, dict) else getattr(block, "type", None)
        if block_type != "text":
            continue
        text = block.get("text") if isinstance(block, dict) else getattr(block, "text", "")
        texts.append(text)
    return texts


def _usage_values(response: Any) -> dict[str, int]:
    usage = response.usage
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(
            usage, "cache_creation_input_tokens", 0
        )
        or 0,
    }


def _parse_json_object(text: str) -> dict:
    stripped = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL)
    if fenced:
        stripped = fenced.group(1)
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start < 0 or end < start:
            raise
        parsed = json.loads(stripped[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("response JSON must be an object")
    return parsed


def _fake_output(
    purpose: Purpose, user: str, digest: bytes, system: str = ""
) -> tuple[str, dict | None]:
    if purpose == "work":
        incident = _fake_incident_work(system, user)
        if incident is not None:
            return incident, None
    if purpose == "split" and system == prompts.COMMANDER_SYSTEM:
        from .commander import rules_classify

        data = rules_classify(json.loads(user.split("\n", 1)[1]))
        return json.dumps(data), data
    if purpose == "split":
        data = {
            "tasks": [
                {
                    "type": "research",
                    "title": "Research the key facts",
                    "brief": "Find the accurate facts and caveats needed for the requested answer.",
                    "depends_on": [],
                },
                {
                    "type": "writing",
                    "title": "Write the requested response",
                    "brief": "Use the research to produce the requested clear final response.",
                    "depends_on": [0],
                },
                {
                    "type": "checking",
                    "title": "Fact-check the response",
                    "brief": "Check the written response and identify any factual errors or caveats.",
                    "depends_on": [1],
                },
            ]
        }
        return json.dumps(data), data
    if purpose == "bid":
        data = {
            "predicted_output_tokens": 150 + int.from_bytes(digest[:2], "big") % 551,
            "promised_quality": 6 + digest[2] % 5,
            "confidence": round(0.55 + digest[3] % 41 / 100, 2),
            "pitch": "A careful, concise result at a competitive price.",
        }
        return json.dumps(data), data
    if purpose == "review":
        data = {
            "grade": 5 + digest[0] % 6,
            "rationale": "The response is relevant, clear, and mostly accurate.",
        }
        return json.dumps(data), data

    brief = user
    marker = "Task brief:\n"
    if marker in user:
        brief = user.split(marker, 1)[1].splitlines()[0]
    first_words = " ".join(brief.split()[:8])
    text = (
        f"Completed work for: {first_words}. "
        "The response is concise, useful, and follows the requested task constraints."
    )
    return text, None


def _fake_incident_work(system: str, user: str) -> str | None:
    if system not in {prompts.WORK_SYSTEM[t] for t in ("diagnose", "remediate", "verify")}:
        return None
    from .scenarios import SCENARIOS

    match = re.search(r"Scenario id: (\w+)", user)
    scenario = SCENARIOS[match.group(1)] if match and match.group(1) in SCENARIOS else None
    if scenario is None:
        return None
    if system == prompts.WORK_SYSTEM["diagnose"]:
        return scenario.fake_diagnosis
    if system == prompts.WORK_SYSTEM["remediate"]:
        # A plausible but wrong first plan, so the sandbox has something to reject.
        plan = scenario.decoy_plan if "Previous failed attempts: none" in user else scenario.fix_plan
        steps = [{key: value for key, value in step.items() if value is not None} for step in plan]
        return json.dumps({"steps": steps})
    return (
        "Verdict: recovered. Every production health target is back inside its "
        "limit after the approved plan was deployed."
    )


async def _smoke() -> int:
    ledger = Ledger("j_00000000", config.ledger_path())
    llm = LLM()
    object_schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    }
    calls = [
        ("split", None, None, object_schema),
        ("bid", "t1", "haiku", object_schema),
        ("work", "t1", "haiku", None),
        ("review", "t1", None, object_schema),
    ]
    for purpose, task_id, agent_id, schema in calls:
        result = await llm.call(
            ledger=ledger,
            purpose=purpose,
            nominal_model="claude-haiku-4-5",
            system="Answer briefly.",
            user="Return a tiny answer.",
            max_tokens=128,
            effort="low",
            schema=schema,
            task_id=task_id,
            agent_id=agent_id,
        )
        print(result.usage)
    print({"total_cost_usd": ledger.total_cost()})
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Abyss LLM gateway")
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args(argv)
    if not args.smoke:
        parser.error("--smoke is required")
    return asyncio.run(_smoke())


if __name__ == "__main__":
    raise SystemExit(main())
