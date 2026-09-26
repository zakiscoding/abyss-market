from __future__ import annotations

import secrets
import time
from dataclasses import asdict
from typing import Awaitable, Callable

from . import config
from .contract import validate_event
from .reputation import ReputationStore


Sink = Callable[[dict], Awaitable[None]]


class EventStream:
    def __init__(self, sink: Sink, clock: Callable[[], float] = time.monotonic):
        self.sink = sink
        self.seq = 0
        self.job_id: str | None = None
        self._started: float | None = None
        self._clock = clock

    async def hello(self, rep: ReputationStore) -> None:
        await self.emit(
            "hello",
            {
                "agents": [asdict(agent) for agent in config.AGENTS],
                "reputation": rep.snapshot(),
                "config": {
                    "price_weight": config.PRICE_WEIGHT,
                    "rep_init": config.REP_INIT,
                    "rep_alpha": config.REP_ALPHA,
                    "task_types": config.ALL_TASK_TYPES,
                    "real_models": config.real_models(),
                    "fake_llm": config.fake_llm(),
                    "orchestrator_model": config.ORCHESTRATOR_MODEL,
                    "reviewer_model": config.REVIEWER_MODEL,
                },
            },
            job_id=None,
        )

    def start_job(self, job_id: str) -> None:
        self.job_id = job_id
        self._started = self._clock()

    def elapsed_ms(self) -> int:
        if self._started is None:
            return 0
        return round((self._clock() - self._started) * 1000)

    async def emit(
        self,
        type: str,
        data: dict,
        job_id: str | None = ...,
    ) -> None:
        resolved_job_id = self.job_id if job_id is ... else job_id
        elapsed = 0
        if resolved_job_id is not None:
            elapsed = self.elapsed_ms()
        event = {
            "v": 1,
            "seq": self.seq,
            "t": elapsed,
            "job_id": resolved_job_id,
            "type": type,
            "data": data,
        }
        validate_event(event)
        await self.sink(event)
        self.seq += 1


def new_job_id() -> str:
    return "j_" + secrets.token_hex(4)
