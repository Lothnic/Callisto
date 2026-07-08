from __future__ import annotations

import time
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from .agents import FakeAgent
from .artifacts import ArtifactWriter, current_manifest
from .datasets import load_subset
from .scorer import scorer_for
from .types import EvalTask, TaskResult


class Agent(Protocol):
    name: str
    provider: str

    def run(self, task: EvalTask) -> TaskResult: ...




def timestamp_run_id(benchmark: str, subset: str) -> str:
    stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")
    return f"{stamp}-{benchmark}-{subset}"


def run_eval(
    *,
    benchmark: str,
    subset: str,
    out_dir: Path,
    agent: Agent | None = None,
    scorer_name: str = "contains",
    max_tasks: int | None = None,
    seed: int = 0,
    max_cost: float = 0.0,
) -> tuple[Path, list[TaskResult]]:
    agent = agent or FakeAgent()
    tasks = load_subset(benchmark, subset)
    if max_tasks is not None:
        tasks = tasks[:max_tasks]

    run_id = out_dir.name if out_dir.name else timestamp_run_id(benchmark, subset)
    manifest = current_manifest(
        run_id=run_id,
        benchmark=benchmark,
        subset=subset,
        model=agent.name,
        provider=agent.provider,
        seed=seed,
        max_tasks=max_tasks,
        max_cost=max_cost,
    )
    writer = ArtifactWriter(out_dir, manifest)
    writer.write_tasks(tasks)

    scorer = scorer_for(scorer_name)
    results: list[TaskResult] = []
    for task in tasks:
        start = time.monotonic()
        try:
            raw = agent.run(task)
            score = scorer.score(task, raw)
            result = replace(
                raw,
                status=score.status,
                score=score.score,
                scorer=score.scorer,
                failure_reason=score.reason,
                duration_s=time.monotonic() - start,
                artifacts={
                    "audit": f"audit/{task.id}.jsonl",
                    "screenshots": f"screenshots/{task.id}/",
                    "snapshots": f"snapshots/{task.id}/",
                },
            )
        except Exception as exc:
            result = TaskResult(
                task_id=task.id,
                status="error",
                final_answer="",
                score=0.0,
                scorer=scorer_name,
                failure_reason=f"{type(exc).__name__}: {exc}",
                duration_s=time.monotonic() - start,
            )
        results.append(result)

    writer.write_results(results)
    return out_dir, results
