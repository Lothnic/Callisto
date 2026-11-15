# Callisto eval kit

Phase 5 starts here: reproducible benchmark runs with pinned manifests,
per-task JSONL results, and summaries that can feed root `BENCHMARKS.md`.

## Install

Browser evidence is separate from scoring. The
[advanced runtime guide](../docs/zen-advanced-runtime.md) documents real HAR/PNG/action
capture and `python -m callisto_eval.evidence` export. The runner links only files
actually supplied and present; empty artifact directories do not prove capture.
See [pinned upstream trace requirements](../research/2026-11-14-benchmark-trace-requirements.md).

```bash
cd eval
python -m venv .venv
. .venv/bin/activate
pip install -e .
```

## Inspect and export browser evidence

`callisto_trace` in the Firefox/Zen bridge records real action JSONL and optional
PNG/DOM checkpoints. Failed tasks can have complete recordings. Cancellation
records unknown outcomes and unavailable evidence separately from task success.

Inspect an interrupted capture without exporting it:

```sh
python -m callisto_eval.evidence /absolute/path/capture --inspect
```

An optional `--requirements /absolute/path/task-requirements.json` checks an
explicit `callisto.task-evidence.v1` contract: observed method/URL/status,
non-redacted request/response JSON pointers and screenshot count/attribution.
Derive that contract from the selected task's evaluator. Strict export refuses
incomplete captures or unmet requirements. The full contract and commands are
in the [advanced runtime guide](../docs/zen-advanced-runtime.md#task-evidence-coverage-and-interrupted-run-inspection).

WebVoyager export prepares an instruction/final-answer envelope and captured
PNGs. Verified export validates its typed response and HAR using version 1.2.3.
Neither runs a benchmark judge. Original WebArena requires its live evaluator;
Callisto action JSONL is not a genuine Playwright trace ZIP.

## Offline smoke run

No browser, no model API key. Uses the fake agent to exercise dataset loading,
scoring, artifact writing, and summary generation.

```bash
python -m callisto_eval run webvoyager --subset smoke --agent fake --out runs/webvoyager-smoke
python -m callisto_eval summarize runs/webvoyager-smoke
```

Artifacts:

```text
runs/<run_id>/
├── manifest.json
├── summary.json
├── tasks.jsonl
├── results.jsonl
├── audit/
├── screenshots/
├── snapshots/
└── traces/
```

## Live Callisto run

Install both the harness and eval package into the same environment, then keep
provider secrets in your shell environment:

```bash
cd ..
harness/.venv/bin/python -m pip install -e harness -e eval
export SILICONFLOW_KEY="..."
harness/.venv/bin/python -m callisto_eval run webvoyager \
  --subset smoke \
  --agent callisto \
  --provider siliconflow \
  --model tencent/Hy3 \
  --headed \
  --max-tasks 1 \
  --out /tmp/callisto-webvoyager-live
```

This uses the same SiliconFlow model adapter as:

```bash
SILICONFLOW_KEY="..." ./run.sh --siliconflow --chat --visible
```

Do not commit keys or paste them into benchmark artifacts.

## Dataset Download & Subsets

To download and align the WebVoyager dataset tasks and reference answers, run:

```bash
harness/.venv/bin/python eval/callisto_eval/benchmarks/webvoyager/download_webvoyager.py
```

This creates the following subsets in `eval/callisto_eval/benchmarks/webvoyager/subsets/`:
- `full.jsonl`: All 643 aligned tasks.
- `pr-50.jsonl`: A deterministically sampled 50-task subset representing all 15 websites for PR regression gates.

You can run these subsets using:

```bash
# Run 50-task subset offline with fake agent
harness/.venv/bin/python -m callisto_eval run webvoyager --subset pr-50 --agent fake --out runs/webvoyager-pr-50-fake

# Run full WebVoyager offline with fake agent
harness/.venv/bin/python -m callisto_eval run webvoyager --subset full --agent fake --out runs/webvoyager-full-fake
```

## Third-party benchmark reports

- [`reports/webarena-verified-2026-11-13/`](reports/webarena-verified-2026-11-13/README.md) — ten Shopping Admin
  retrieval tasks scored by the official WebArena Verified evaluator, run against
  Callisto Chromium, Callisto Zen, OpenCode browse and Vercel agent-browser. It
  records the per-task scores, tool calls and the limits of the comparison.

## Current scope

- Implemented: WebVoyager full dataset downloader (`download_webvoyager.py`), `full` (643 tasks) and `pr-50` (50 tasks) subsets, offline fake agent, live Callisto harness agent adapter, deterministic contains/exact/regex scorers, bootstrap summary stats, and artifact manifests.
- Next: baseline comparison, scheduled live eval CI, and richer per-task audit artifact linking.

