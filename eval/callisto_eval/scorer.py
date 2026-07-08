from __future__ import annotations

import re
from typing import Protocol

from .types import EvalTask, Score, TaskResult


class Scorer(Protocol):
    name: str

    def score(self, task: EvalTask, result: TaskResult) -> Score: ...


class ContainsScorer:
    name = "contains"

    def score(self, task: EvalTask, result: TaskResult) -> Score:
        if result.status == "error":
            return Score(status="error", score=0.0, scorer=self.name, reason=result.failure_reason)
        if task.expected is None:
            return Score(status="fail", score=0.0, scorer=self.name, reason="task has no expected value")
        if not isinstance(task.expected, str):
            return Score(status="fail", score=0.0, scorer=self.name, reason="contains scorer expects string expected value")

        expected = task.expected.strip().lower()
        actual = result.final_answer.strip().lower()
        ok = expected in actual
        return Score(
            status="pass" if ok else "fail",
            score=1.0 if ok else 0.0,
            scorer=self.name,
            reason=None if ok else f"expected substring not found: {task.expected!r}",
            evidence={"expected": task.expected, "actual": result.final_answer},
        )


class ExactScorer:
    name = "exact"

    def score(self, task: EvalTask, result: TaskResult) -> Score:
        if task.expected is None:
            return Score(status="fail", score=0.0, scorer=self.name, reason="task has no expected value")
        ok = str(task.expected).strip() == result.final_answer.strip()
        return Score(
            status="pass" if ok else "fail",
            score=1.0 if ok else 0.0,
            scorer=self.name,
            reason=None if ok else "exact match failed",
            evidence={"expected": task.expected, "actual": result.final_answer},
        )


class RegexScorer:
    name = "regex"

    def score(self, task: EvalTask, result: TaskResult) -> Score:
        if task.expected is None:
            return Score(status="fail", score=0.0, scorer=self.name, reason="task has no expected value")
        pattern = str(task.expected)
        ok = re.search(pattern, result.final_answer) is not None
        return Score(
            status="pass" if ok else "fail",
            score=1.0 if ok else 0.0,
            scorer=self.name,
            reason=None if ok else f"regex did not match: {pattern!r}",
            evidence={"pattern": pattern, "actual": result.final_answer},
        )


def scorer_for(name: str) -> Scorer:
    if name == "contains":
        return ContainsScorer()
    if name == "exact":
        return ExactScorer()
    if name == "regex":
        return RegexScorer()
    raise ValueError(f"unknown scorer: {name}")
