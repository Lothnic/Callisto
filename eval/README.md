# Callisto eval kit

Phase 5 starts here: reproducible benchmark runs with pinned manifests,
per-task JSONL results, and summaries that can feed root `BENCHMARKS.md`.

## Install

```bash
cd eval
python -m venv .venv
. .venv/bin/activate
pip install -e .
```

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

## Current scope

- Implemented: WebVoyager full dataset downloader (`download_webvoyager.py`), `full` (643 tasks) and `pr-50` (50 tasks) subsets, offline fake agent, live Callisto harness agent adapter, deterministic contains/exact/regex scorers, bootstrap summary stats, and artifact manifests.
- Next: baseline comparison, scheduled live eval CI, and richer per-task audit artifact linking.

