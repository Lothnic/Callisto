from __future__ import annotations

import json
from collections.abc import Iterable
from importlib import resources
from pathlib import Path
from typing import Any

from .types import EvalTask


def _rows(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                yield json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSONL at {path}:{line_no}: {exc}") from exc


def load_jsonl(path: Path) -> list[EvalTask]:
    tasks: list[EvalTask] = []
    for row in _rows(path):
        tasks.append(
            EvalTask(
                id=str(row["id"]),
                benchmark=str(row["benchmark"]),
                site=row.get("site"),
                start_url=str(row["start_url"]),
                instruction=str(row["instruction"]),
                expected=row.get("expected"),
                metadata=dict(row.get("metadata") or {}),
            )
        )
    return tasks


def subset_path(benchmark: str, subset: str) -> Path:
    root = resources.files("callisto_eval")
    traversable = root / "benchmarks" / benchmark / "subsets" / f"{subset}.jsonl"
    with resources.as_file(traversable) as path:
        return path


def load_subset(benchmark: str, subset: str) -> list[EvalTask]:
    path = subset_path(benchmark, subset)
    if not path.exists():
        raise FileNotFoundError(f"unknown benchmark subset: {benchmark}/{subset}")
    return load_jsonl(path)
