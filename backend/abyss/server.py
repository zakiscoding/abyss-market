from __future__ import annotations

import asyncio
import contextlib
import json
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from . import config, safety
from .events import EventStream
from .incident import Scenario
from .llm import LLM
from .market import run_job
from .mayday import IncidentControl, healthy_status, run_incident
from .reputation import ReputationStore
from .scenarios import DEFAULT_SCENARIO, SCENARIO_IDS, SCENARIOS, catalog, create


app = FastAPI()
reputation = ReputationStore(config.rep_path())
llm = LLM()
MAX_CLIENT_MESSAGE_CHARS = 16_384


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/ready")
async def ready() -> JSONResponse:
    checks = {
        "initialized": llm is not None and reputation is not None,
        "scenarios": _scenarios_ready(),
        "reputation": reputation.storage_ready(),
        "config": _config_ready(),
        "provider": _provider_ready(),
    }
    ok = all(checks.values())
    return JSONResponse(status_code=200 if ok else 503, content={"ok": ok, "checks": checks})


def _scenarios_ready() -> bool:
    try:
        listed = catalog()
        ids = {item["scenario_id"] for item in listed}
        return ids == set(SCENARIO_IDS) and len(listed) == len(SCENARIO_IDS)
    except Exception as exc:
        safety.log_internal(exc, label="scenario registry check failed")
        return False


def _config_ready() -> bool:
    try:
        if not config.DOMAINS or not config.AGENTS or not config.PRICES:
            return False
        if not 0 <= config.PRICE_WEIGHT <= 10:
            return False
        if set(config.SPECIALIST_MODELS) != set(config.DOMAINS):
            return False
        return all(price[0] >= 0 and price[1] >= 0 for price in config.PRICES.values())
    except Exception as exc:
        safety.log_internal(exc, label="config check failed")
        return False


def _provider_ready() -> bool:
    # Only initialized fake mode avoids provider calls; Haiku test mode also needs a key.
    if llm is not None and llm._fake:
        return True
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    stream = EventStream(ws.send_json)
    running: asyncio.Task | None = None
    sim: Scenario = create(DEFAULT_SCENARIO)
    control = IncidentControl()
    await stream.hello(reputation)

    try:
        while True:
            try:
                raw = await ws.receive_text()
            except WebSocketDisconnect:
                raise
            except Exception as exc:
                safety.log_internal(exc, label="websocket receive failed")
                await _connection_error(stream, "invalid message")
                continue
            if len(raw) > MAX_CLIENT_MESSAGE_CHARS:
                await _connection_error(stream, "message exceeds maximum size")
                continue
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await _connection_error(stream, "invalid JSON")
                continue
            if not isinstance(message, dict):
                await _connection_error(stream, "message must be a JSON object")
                continue

            message_type = message.get("type")
            if message_type == "start_job":
                if running is not None and not running.done():
                    await _connection_error(stream, "a job is already running")
                    continue
                error = _validate_start(message)
                if error is not None:
                    await _connection_error(stream, error)
                    continue
                running = asyncio.create_task(
                    _run_job_safely(
                        stream,
                        message["job"],
                        message.get("price_weight", config.PRICE_WEIGHT),
                    )
                )
            elif message_type == "reset":
                if running is not None and not running.done():
                    await _connection_error(stream, "cannot reset while a job is running")
                    continue
                reputation.reset()
                await stream.hello(reputation)
            elif message_type == "start_incident":
                if running is not None and not running.done():
                    await _connection_error(stream, "a job or incident is already running")
                    continue
                error = _validate_incident_start(message)
                if error is not None:
                    await _connection_error(stream, error)
                    continue
                sim = create(message.get("scenario_id", DEFAULT_SCENARIO))
                control = IncidentControl()
                running = asyncio.create_task(
                    _run_incident_safely(
                        stream, sim, control, message.get("price_weight", config.PRICE_WEIGHT)
                    )
                )
            elif message_type == "approve_repair":
                if running is None or running.done() or not control.awaiting_approval:
                    await _connection_error(stream, "no repair is awaiting approval")
                    continue
                if not control.grant():
                    await _connection_error(stream, "repair approval was already recorded")
                    continue
            elif message_type == "reset_incident":
                await _cancel_running(running)
                running = None
                control.clear()
                sim.reset()
                await stream.emit("incident_status", healthy_status(sim), job_id=None)
            else:
                await _connection_error(stream, "unknown message type")
    except WebSocketDisconnect:
        await _cancel_running(running)


async def _cancel_running(running: asyncio.Task | None) -> None:
    if running is None or running.done():
        return
    running.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await running


async def _run_job_safely(stream: EventStream, job: str, price_weight: float) -> None:
    # A crashed job must tell the client instead of leaving it waiting forever.
    try:
        await run_job(job, stream=stream, llm=llm, rep=reputation, price_weight=price_weight)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        correlation = safety.log_internal(exc, label="job crashed")
        with contextlib.suppress(Exception):
            await stream.emit(
                "error",
                {"message": safety.client_internal_error(correlation), "task_id": None, "fatal": True},
                job_id=None,
            )


async def _run_incident_safely(
    stream: EventStream, sim: Scenario, control: IncidentControl, price_weight: float
) -> None:
    try:
        await run_incident(
            stream=stream, llm=llm, rep=reputation, sim=sim, control=control, price_weight=price_weight
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        correlation = safety.log_internal(exc, label="incident crashed")
        with contextlib.suppress(Exception):
            await stream.emit(
                "error",
                {"message": safety.client_internal_error(correlation), "task_id": None, "fatal": True},
                job_id=None,
            )


def _validate_start(message: dict) -> str | None:
    job = message.get("job")
    if not isinstance(job, str) or not job.strip() or len(job) > 2000:
        return "job must be a string between 1 and 2000 characters"
    return _validate_price_weight(message)


def _validate_incident_start(message: dict) -> str | None:
    scenario_id = message.get("scenario_id", DEFAULT_SCENARIO)
    if not isinstance(scenario_id, str) or scenario_id not in SCENARIOS:
        return f"scenario_id must be one of {', '.join(SCENARIOS)}"
    return _validate_price_weight(message)


def _validate_price_weight(message: dict) -> str | None:
    price_weight = message.get("price_weight", config.PRICE_WEIGHT)
    if (
        isinstance(price_weight, bool)
        or not isinstance(price_weight, (int, float))
        or not 0 <= price_weight <= 10
    ):
        return "price_weight must be between 0 and 10"
    return None


async def _connection_error(stream: EventStream, message: str) -> None:
    await stream.emit(
        "error",
        {"message": message, "task_id": None, "fatal": False},
        job_id=None,
    )
