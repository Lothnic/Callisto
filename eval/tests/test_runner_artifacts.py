import json

from callisto_eval.runner import run_eval


def test_fake_run_writes_reproducible_artifacts(tmp_path):
    out = tmp_path / "run"

    run_dir, results = run_eval(benchmark="webvoyager", subset="smoke", out_dir=out)

    assert run_dir == out
    assert len(results) == 3
    assert all(r.status == "pass" for r in results)
    assert (out / "manifest.json").exists()
    assert (out / "tasks.jsonl").exists()
    assert (out / "results.jsonl").exists()
    summary = json.loads((out / "summary.json").read_text())
    assert summary["success_rate"] == 1.0
