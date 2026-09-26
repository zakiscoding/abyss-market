from __future__ import annotations

import asyncio
import contextlib
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from . import config
from .events import EventStream
from .llm import LLM
from .market import run_job
from .mayday import IncidentSession, emit_healthy, run_incident
from .reputation import ReputationStore


logger = logging.getLogger(__name__)
app = FastAPI()
reputation = ReputationStore(config.rep_path())
llm = LLM()


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    stream = EventStream(ws.send_json)
    running: asyncio.Task | None = None
    session = IncidentSession()
    await stream.hello(reputation)

    try:
        while True:
            raw = await ws.receive_text()
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
                    await _connection_error(stream, "a job is already running")
                    continue
                session.sim.reset()
                running = asyncio.create_task(_run_incident_safely(stream, session))
            elif message_type == "approve_repair":
                if not session.awaiting_approval:
                    await _connection_error(stream, "no repair is awaiting approval")
                    continue
                session.approval.set()
            elif message_type == "reset_incident":
                if running is not None and not running.done():
                    running.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await running
                session.sim.reset()
                stream.job_id = None
                await emit_healthy(stream, session.sim)
            else:
                await _connection_error(stream, "unknown message type")
    except WebSocketDisconnect:
        if running is not None and not running.done():
            running.cancel()
            try:
                await running
            except asyncio.CancelledError:
                pass


async def _run_job_safely(stream: EventStream, job: str, price_weight: float) -> None:
    # A crashed job must tell the client instead of leaving it waiting forever.
    try:
        await run_job(job, stream=stream, llm=llm, rep=reputation, price_weight=price_weight)
    except Exception as exc:
        logger.exception("job crashed")
        with contextlib.suppress(Exception):
            await stream.emit(
                "error", {"message": f"internal error: {exc}", "task_id": None, "fatal": True}, job_id=None
            )


async def _run_incident_safely(stream: EventStream, session: IncidentSession) -> None:
    try:
        await run_incident(stream=stream, llm=llm, rep=reputation, session=session)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("incident crashed")
        with contextlib.suppress(Exception):
            await stream.emit(
                "error", {"message": f"internal error: {exc}", "task_id": None, "fatal": True}, job_id=None
            )


def _validate_start(message: dict) -> str | None:
    job = message.get("job")
    if not isinstance(job, str) or not job.strip() or len(job) > 2000:
        return "job must be a string between 1 and 2000 characters"
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
