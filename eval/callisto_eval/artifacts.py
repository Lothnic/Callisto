from __future__ import annotations

import json
import platform
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import __version__
from .stats import summarize
from .types import EvalTask, TaskResult


@dataclass(frozen=True)
class RunManifest:
    schema_version: int
    run_id: str
    benchmark: str
    subset: str
    callisto_commit: str
    dirty_worktree: bool
    model: str
    provider: str
    eval_version: str
    python_version: str
    os: str
    started_at: str
    seed: int
    max_tasks: int | None
    max_cost: float


def _git(args: list[str]) -> str:
    try:
        return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return "unknown"


def current_manifest(
    *,
    run_id: str,
    benchmark: str,
    subset: str,
    model: str,
    provider: str,
    seed: int,
    max_tasks: int | None,
    max_cost: float,
) -> RunManifest:
    status = _git(["status", "--porcelain"])
    return RunManifest(
        schema_version=1,
        run_id=run_id,
        benchmark=benchmark,
        subset=subset,
        callisto_commit=_git(["rev-parse", "HEAD"]),
        dirty_worktree=bool(status and status != "unknown"),
        model=model,
        provider=provider,
        eval_version=__version__,
        python_version=sys.version.split()[0],
        os=f"{platform.system()} {platform.release()}",
        started_at=datetime.now(UTC).isoformat(),
        seed=seed,
        max_tasks=max_tasks,
        max_cost=max_cost,
    )


class ArtifactWriter:
    def __init__(self, out_dir: Path, manifest: RunManifest) -> None:
        self.out_dir = out_dir
        self.manifest = manifest
        self.out_dir.mkdir(parents=True, exist_ok=True)
        (self.out_dir / "audit").mkdir(exist_ok=True)
        (self.out_dir / "screenshots").mkdir(exist_ok=True)
        (self.out_dir / "snapshots").mkdir(exist_ok=True)
        (self.out_dir / "traces").mkdir(exist_ok=True)
        self.write_json("manifest.json", asdict(manifest))

    def write_json(self, name: str, data: dict[str, Any]) -> None:
        (self.out_dir / name).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def write_tasks(self, tasks: list[EvalTask]) -> None:
        self.write_jsonl("tasks.jsonl", [asdict(t) for t in tasks])

    def write_results(self, results: list[TaskResult]) -> None:
        self.write_jsonl("results.jsonl", [asdict(r) for r in results])
        self.write_json("summary.json", summarize(results))

    def write_jsonl(self, name: str, rows: list[dict[str, Any]]) -> None:
        with (self.out_dir / name).open("w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, sort_keys=True) + "\n")
