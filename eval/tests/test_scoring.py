from callisto_eval.scorer import scorer_for
from callisto_eval.stats import summarize
from callisto_eval.types import EvalTask, TaskResult


def test_contains_scorer_passes_on_expected_substring():
    task = EvalTask(
        id="t1",
        benchmark="fake",
        site=None,
        start_url="https://example.com",
        instruction="find heading",
        expected="Example Domain",
    )
    result = TaskResult(task_id="t1", status="pass", final_answer="The heading is Example Domain")

    score = scorer_for("contains").score(task, result)

    assert score.status == "pass"
    assert score.score == 1.0


def test_summarize_reports_success_rate_and_ci():
    results = [
        TaskResult(task_id="a", status="pass", final_answer="ok", score=1.0),
        TaskResult(task_id="b", status="fail", final_answer="no", score=0.0),
    ]

    summary = summarize(results)

    assert summary["tasks"] == 2
    assert summary["success_rate"] == 0.5
    assert summary["ci_95"][0] <= summary["mean_score"] <= summary["ci_95"][1]
