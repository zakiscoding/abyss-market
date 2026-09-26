from __future__ import annotations

from dataclasses import dataclass

from .config import JOB_TASK_TYPES as TASK_TYPES
from .config import MAX_TASKS, ORCHESTRATOR_MODEL, SPLIT_EFFORT
from .ledger import Ledger
from .llm import LLM, LLMError
from . import prompts


@dataclass
class TaskSpec:
    task_id: str
    type: str
    title: str
    brief: str
    depends_on: list[str]


async def split_job(
    llm: LLM, ledger: Ledger, job_text: str
) -> tuple[list[TaskSpec], dict]:
    last_error = "split produced fewer than two valid tasks"
    for _ in range(2):
        try:
            result = await llm.call(
                ledger=ledger,
                purpose="split",
                nominal_model=ORCHESTRATOR_MODEL,
                system=prompts.SPLIT_SYSTEM,
                user=prompts.SPLIT_USER.format(job_text=job_text),
                max_tokens=4096,
                effort=SPLIT_EFFORT,
                schema=prompts.SPLIT_SCHEMA,
            )
        except LLMError as exc:
            last_error = str(exc)
            continue
        try:
            tasks = _sanitize_tasks(result.data)
        except (TypeError, ValueError, KeyError) as exc:
            last_error = str(exc)
            continue
        if len(tasks) >= 2:
            return tasks, result.usage
    raise LLMError(last_error)


def _sanitize_tasks(data: dict | None) -> list[TaskSpec]:
    if not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
        raise ValueError("split response must contain a tasks list")
    tasks: list[TaskSpec] = []
    for index, raw in enumerate(data["tasks"][:MAX_TASKS]):
        if not isinstance(raw, dict) or raw.get("type") not in TASK_TYPES:
            raise ValueError("split response contains an invalid task")
        raw_dependencies = raw.get("depends_on")
        if not isinstance(raw_dependencies, list):
            raise ValueError("task dependencies must be a list")
        dependencies: list[str] = []
        for dependency in raw_dependencies:
            if (
                isinstance(dependency, int)
                and not isinstance(dependency, bool)
                and 0 <= dependency < index
            ):
                task_id = f"t{dependency + 1}"
                if task_id not in dependencies:
                    dependencies.append(task_id)
        tasks.append(
            TaskSpec(
                task_id=f"t{index + 1}",
                type=raw["type"],
                title=str(raw.get("title", ""))[:40],
                brief=str(raw.get("brief", ""))[:300],
                depends_on=dependencies,
            )
        )
    return tasks
