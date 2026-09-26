from __future__ import annotations

import json
import os
from pathlib import Path

from .config import AGENTS, ALL_TASK_TYPES, REP_ALPHA, REP_INIT, REP_MAX, REP_MIN


class ReputationStore:
    def __init__(self, path: Path | None = None):
        self.path = path
        self._values = self._initial_values()
        if path is not None and path.exists():
            loaded = json.loads(path.read_text(encoding="utf-8"))
            # Files written before a task type existed start that type at REP_INIT.
            self._values = {
                agent.agent_id: {
                    task_type: float(loaded.get(agent.agent_id, {}).get(task_type, REP_INIT))
                    for task_type in ALL_TASK_TYPES
                }
                for agent in AGENTS
            }

    def get(self, agent_id: str, task_type: str) -> float:
        return self._values[agent_id][task_type]

    def update(
        self,
        agent_id: str,
        task_type: str,
        grade: int,
        promised: int,
    ) -> tuple[float, float, float]:
        if promised <= 0:
            raise ValueError("promised quality must be positive")
        old = self.get(agent_id, task_type)
        ratio = round(min(REP_MAX, max(REP_MIN, grade / promised)), 4)
        new = round(old + REP_ALPHA * (ratio - old), 4)
        self._values[agent_id][task_type] = new
        self._persist()
        return old, new, ratio

    def snapshot(self) -> dict[str, dict[str, float]]:
        return {
            agent_id: dict(task_types)
            for agent_id, task_types in self._values.items()
        }

    def reset(self) -> None:
        self._values = self._initial_values()
        self._persist()

    @staticmethod
    def _initial_values() -> dict[str, dict[str, float]]:
        return {
            agent.agent_id: {task_type: REP_INIT for task_type in ALL_TASK_TYPES}
            for agent in AGENTS
        }

    def _persist(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(
            json.dumps(self._values, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)
