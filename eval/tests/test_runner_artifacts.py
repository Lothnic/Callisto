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
    assert all(result.artifacts == {} for result in results)
    index = json.loads((out / 'artifact-index.json').read_text())
    assert all(not task['native_evaluation_executed'] for task in index['tasks'].values())


def test_runner_preserves_only_real_agent_evidence(tmp_path):
    from callisto_eval.agents import FakeAgent
    from dataclasses import replace
    out = tmp_path / 'run'
    out.mkdir()
    (out / 'real.jsonl').write_text('{}\n')

    class RecordedAgent(FakeAgent):
        def run(self, task):
            return replace(super().run(task), artifacts={'audit': 'real.jsonl', 'trace': 'missing.zip',
                                                        'outside': '../private.txt'})

    _, results = run_eval(benchmark='webvoyager', subset='smoke', out_dir=out, agent=RecordedAgent())
    assert all(result.artifacts == {'audit': 'real.jsonl'} for result in results)
    index = json.loads((out / 'artifact-index.json').read_text())
    assert {item['state'] for item in next(iter(index['tasks'].values()))['artifacts']} == {
        'present', 'missing_or_unsafe', 'outside_run_rejected'}
