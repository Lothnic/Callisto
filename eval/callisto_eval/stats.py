from __future__ import annotations

import random
from statistics import mean, median

from .types import TaskResult


def bootstrap_ci(values: list[float], *, seed: int = 0, samples: int = 1000, alpha: float = 0.05) -> tuple[float, float]:
    if not values:
        return (0.0, 0.0)
    if len(values) == 1:
        return (values[0], values[0])

    rng = random.Random(seed)
    means: list[float] = []
    n = len(values)
    for _ in range(samples):
        draw = [values[rng.randrange(n)] for _ in range(n)]
        means.append(mean(draw))
    means.sort()
    lo = means[int((alpha / 2) * samples)]
    hi = means[int((1 - alpha / 2) * samples) - 1]
    return (lo, hi)


def summarize(results: list[TaskResult]) -> dict[str, float | int | list[float]]:
    scores = [r.score for r in results if r.status != "skipped"]
    denominator = len(scores)
    passed = sum(1 for r in results if r.status == "pass")
    ci = bootstrap_ci(scores)
    durations = [r.duration_s for r in results]
    costs = [r.cost_usd for r in results]
    steps = [r.steps for r in results]
    tokens = [r.input_tokens + r.output_tokens for r in results]

    return {
        "tasks": len(results),
        "denominator": denominator,
        "passed": passed,
        "success_rate": (passed / denominator) if denominator else 0.0,
        "mean_score": mean(scores) if scores else 0.0,
        "ci_95": [ci[0], ci[1]],
        "mean_steps": mean(steps) if steps else 0.0,
        "median_duration_s": median(durations) if durations else 0.0,
        "mean_cost_usd": mean(costs) if costs else 0.0,
        "tokens_per_task": mean(tokens) if tokens else 0.0,
    }
