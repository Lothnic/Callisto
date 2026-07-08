from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

TaskStatus = Literal["pass", "fail", "error", "skipped"]
ScorerName = Literal["exact", "contains", "regex", "llm_judge", "human", "benchmark_native"]


@dataclass(frozen=True)
class EvalTask:
    id: str
    benchmark: str
    site: str | None
    start_url: str
    instruction: str
    expected: str | dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TaskResult:
    task_id: str
    status: TaskStatus
    final_answer: str
    score: float = 0.0
    scorer: str = "contains"
    failure_reason: str | None = None
    steps: int = 0
    duration_s: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    artifacts: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Score:
    status: TaskStatus
    score: float
    scorer: str
    reason: str | None = None
    evidence: dict[str, Any] = field(default_factory=dict)
