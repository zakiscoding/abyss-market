from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from .config import AGENTS, PRICES
from .safety import redact_text

# In-process only. Two OS processes writing the same ledger file can still interleave.
_PATH_LOCKS: dict[str, threading.Lock] = {}
_PATH_LOCKS_GUARD = threading.Lock()


def _path_lock(path: Path) -> threading.Lock:
    key = str(path.resolve())
    with _PATH_LOCKS_GUARD:
        lock = _PATH_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _PATH_LOCKS[key] = lock
        return lock


Purpose = Literal["split", "bid", "work", "review"]
PURPOSES: tuple[Purpose, ...] = ("split", "bid", "work", "review")


def cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read: int = 0,
    cache_write: int = 0,
) -> float:
    input_price, output_price = PRICES[model]
    cost = (
        input_tokens * input_price
        + output_tokens * output_price
        + cache_read * input_price * 0.1
        + cache_write * input_price * 1.25
    ) / 1_000_000
    return round(cost, 6)


@dataclass(frozen=True)
class LedgerEntry:
    id: str
    ts: float
    job_id: str
    task_id: str | None
    agent_id: str | None
    purpose: Purpose
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int
    cost_usd: float
    ok: bool
    stop_reason: str | None
    error: str | None
    duration_ms: int


class Ledger:
    def __init__(self, job_id: str, path: Path | None):
        self.job_id = job_id
        self.path = path
        self._entries: list[LedgerEntry] = []
        self._lock = threading.Lock()

    def record(self, **fields: object) -> LedgerEntry:
        error = fields.get("error")
        if isinstance(error, str):
            fields["error"] = redact_text(error, limit=200) or "model request failed"
        with self._lock:
            entry = LedgerEntry(
                id=f"c_{len(self._entries) + 1:04d}",
                ts=time.time(),
                job_id=self.job_id,
                **fields,  # type: ignore[arg-type]
            )
            self._entries.append(entry)
            line = json.dumps(asdict(entry), separators=(",", ":")) + "\n"
            path = self.path
        if path is not None:
            # The file lock is not held across model calls; record() runs after the call returns.
            with _path_lock(path):
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("a", encoding="utf-8") as handle:
                    handle.write(line)
                    handle.flush()
        return entry

    def entries(self) -> list[LedgerEntry]:
        return list(self._entries)

    def stats(self, tasks_won: dict[str, int]) -> dict:
        by_purpose = {
            purpose: {"cost_usd": 0.0, "calls": 0} for purpose in PURPOSES
        }
        by_agent = {
            agent.agent_id: {
                "cost_usd": 0.0,
                "input_tokens": 0,
                "output_tokens": 0,
                "calls": 0,
                "tasks_won": tasks_won.get(agent.agent_id, 0),
            }
            for agent in AGENTS
        }

        for entry in self._entries:
            purpose_stats = by_purpose[entry.purpose]
            purpose_stats["cost_usd"] += entry.cost_usd
            purpose_stats["calls"] += 1

            if entry.purpose in ("bid", "work") and entry.agent_id is not None:
                agent_stats = by_agent[entry.agent_id]
                agent_stats["cost_usd"] += entry.cost_usd
                agent_stats["input_tokens"] += entry.input_tokens
                agent_stats["output_tokens"] += entry.output_tokens
                agent_stats["calls"] += 1

        for purpose_stats in by_purpose.values():
            purpose_stats["cost_usd"] = round(purpose_stats["cost_usd"], 6)
        for agent_stats in by_agent.values():
            agent_stats["cost_usd"] = round(agent_stats["cost_usd"], 6)

        return {
            "total_cost_usd": self.total_cost(),
            "input_tokens": sum(entry.input_tokens for entry in self._entries),
            "output_tokens": sum(entry.output_tokens for entry in self._entries),
            "calls": len(self._entries),
            "by_purpose": by_purpose,
            "by_agent": by_agent,
        }

    def task_cost(self, task_id: str) -> float:
        return round(
            sum(entry.cost_usd for entry in self._entries if entry.task_id == task_id),
            6,
        )

    def total_cost(self) -> float:
        return round(sum(entry.cost_usd for entry in self._entries), 6)
