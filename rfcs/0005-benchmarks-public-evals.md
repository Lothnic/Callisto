# RFC 0005 — Benchmarks & public evals

- **Status:** Proposed
- **Phase:** 5
- **Author:** Lothnic
- **Depends:** RFC 0003, RFC 0003.1, RFC 0004

## Summary

Phase 5 ships Callisto's credibility layer: a reproducible public eval kit,
root-level benchmark reporting, CI regression checks, and artifact-backed runs
that anyone can inspect or rerun.

The core rule: **no number without the kit that produced it.** A benchmark claim
is valid only if it includes pinned code, pinned dependencies, model/provider
metadata, task inputs, per-task outputs, raw audit logs, and scoring decisions.

The first implementation target is **WebVoyager** because it is public and easy
to run. The suite then adds **Online-Mind2Web**, **BU-Bench-V1**, and **Odyssey**
as access and scoring confidence mature.

---

## Goals

1. Provide one-command local evals for public benchmark subsets and full runs.
2. Publish `BENCHMARKS.md` with current Callisto numbers and exact reproduction
   commands.
3. Store enough per-task artifacts to debug failures and audit scoring.
4. Run a small deterministic smoke subset on PRs and a larger scheduled run on
   `main`.
5. Make harness changes measurable: success rate, cost, latency, turn count, and
   token footprint.
6. Avoid benchmark theater: no cherry-picking, no hidden prompts, no unverifiable
   SOTA claims.

## Non-goals

- No leaderboard claims before a complete, reproducible run exists.
- No training, fine-tuning, or benchmark-specific prompt hacking.
- No private benchmark tasks committed to the repo.
- No grading by vibes. Every score must come from a documented scorer or a
  retained human-review record.
- No CI job that burns unbounded API spend.

---

## Benchmarks

Priority order:

| Priority | Benchmark | Why | Phase 5 target |
| --- | --- | --- | --- |
| 1 | WebVoyager | Public, broad web-navigation benchmark, easiest first runner | Full runner + PR subset |
| 2 | Online-Mind2Web | Canonical live web-agent benchmark | Runner scaffold + first reproducible run |
| 3 | BU-Bench-V1 | Hard browser-use benchmark referenced in public comparisons | Dataset adapter + local runner |
| 4 | Odyssey | Long-horizon frontier tasks, access-dependent | Adapter stub; full support after access |

Each benchmark adapter normalizes tasks into the same internal shape:

```python
@dataclass(frozen=True)
class EvalTask:
    id: str
    benchmark: str
    site: str | None
    start_url: str
    instruction: str
    expected: str | dict[str, Any] | None
    metadata: dict[str, Any]
```

Adapters may include benchmark-specific fields in `metadata`, but the runner only
consumes the normalized fields.

---

## Repository layout

```text
eval/
├── pyproject.toml
├── README.md
├── callisto_eval/
│   ├── __init__.py
│   ├── runner.py          # orchestration and retry policy
│   ├── scorer.py          # scorer interface + built-in scorers
│   ├── artifacts.py       # artifact paths and JSONL writers
│   ├── datasets.py        # task loading and splits
│   ├── stats.py           # confidence intervals and summaries
│   └── benchmarks/
│       ├── webvoyager/
│       │   ├── adapter.py
│       │   ├── scorer.py
│       │   └── subsets/
│       │       ├── smoke.jsonl
│       │       └── pr-50.jsonl
│       ├── mind2web/
│       ├── bu_bench_v1/
│       └── odyssey/
└── tests/
    ├── test_scoring.py
    ├── test_artifacts.py
    └── test_dataset_loading.py

BENCHMARKS.md
.github/workflows/eval.yml
```

The package name is `callisto-eval` to avoid colliding with Python's built-in
`eval` concept in import paths.

---

## CLI

The eval kit exposes a module CLI:

```bash
python -m callisto_eval run webvoyager --subset smoke --model openrouter/...
python -m callisto_eval run webvoyager --subset pr-50 --max-tasks 50
python -m callisto_eval summarize runs/2026-07-09T12-00-00Z
python -m callisto_eval compare runs/baseline runs/candidate
```

Required runner flags:

| Flag | Meaning |
| --- | --- |
| `benchmark` | `webvoyager`, `mind2web`, `bu_bench_v1`, `odyssey` |
| `--subset` | named subset: `smoke`, `pr-50`, `full`, etc. |
| `--model` | model/provider identifier passed to the harness |
| `--max-tasks` | hard cap for local debugging |
| `--seed` | deterministic task shuffling / subset sampling |
| `--headless/--headed` | browser visibility |
| `--max-cost` | hard budget; fail closed when exceeded |
| `--out` | run directory; defaults to timestamped `runs/<id>` |
| `--resume` | skip tasks with completed artifact records |

The CLI exits non-zero when infrastructure fails, the budget is exceeded, or a
configured regression threshold is crossed. Individual task failures are recorded
as failed task results, not process failures.

---

## Run artifact schema

Every run creates a self-contained directory:

```text
runs/<run_id>/
├── manifest.json
├── summary.json
├── tasks.jsonl
├── results.jsonl
├── audit/
│   └── <task_id>.jsonl
├── screenshots/
│   └── <task_id>/step-000.png
├── snapshots/
│   └── <task_id>/step-000.txt
└── traces/
    └── <task_id>.jsonl
```

### `manifest.json`

```json
{
  "schema_version": 1,
  "run_id": "2026-07-09T12-00-00Z-webvoyager-pr-50",
  "benchmark": "webvoyager",
  "subset": "pr-50",
  "callisto_commit": "<git sha>",
  "dirty_worktree": false,
  "model": "openrouter/provider/model-version",
  "provider": "openrouter",
  "harness_version": "0.1.0",
  "mini_version": "0.1.0",
  "eval_version": "0.1.0",
  "python_version": "3.12.x",
  "node_version": "20.x",
  "os": "linux",
  "started_at": "ISO-8601",
  "seed": 0,
  "max_steps": 40,
  "max_cost": 5.0
}
```

### `results.jsonl`

One row per task:

```json
{
  "task_id": "webvoyager-0001",
  "status": "pass | fail | error | skipped",
  "score": 1.0,
  "scorer": "exact | regex | llm_judge | human | benchmark_native",
  "instruction": "...",
  "start_url": "https://...",
  "final_answer": "...",
  "failure_reason": null,
  "steps": 12,
  "duration_s": 91.2,
  "input_tokens": 12345,
  "output_tokens": 2345,
  "cost_usd": 0.42,
  "artifacts": {
    "audit": "audit/webvoyager-0001.jsonl",
    "screenshots": "screenshots/webvoyager-0001/",
    "snapshots": "snapshots/webvoyager-0001/"
  }
}
```

`error` means infrastructure failure, not task failure. Error rows remain in the
denominator unless a documented benchmark policy excludes them.

---

## Scoring policy

Scoring is benchmark-specific but must use a shared interface:

```python
class Scorer(Protocol):
    def score(self, task: EvalTask, result: TaskResult) -> Score: ...
```

`Score` includes `score: float`, `status`, `reason`, and `evidence`.

Scorer priority:

1. **Benchmark-native scorer** when the benchmark provides one.
2. **Deterministic scorer** for exact match, regex, URL reached, or DOM state.
3. **LLM judge** only when deterministic scoring is impossible.
4. **Human review** for leaderboard submissions or disputed examples.

LLM judges must be pinned separately from the task-solving model and recorded in
`manifest.json`. Judge prompts are versioned in the repo. Human review records
must include reviewer ID or alias, timestamp, score, and rationale.

### Denominator rule

Default denominator is all attempted tasks. Page downtime, CAPTCHA, rate limits,
and provider failures are reported explicitly. Excluding tasks requires a written
exclusion file:

```text
runs/<run_id>/exclusions.jsonl
```

Each exclusion row must include task ID, reason, evidence, and reviewer. Excluded
numbers must be labeled as such in `BENCHMARKS.md`.

---

## Metrics

Every summary reports:

| Metric | Definition |
| --- | --- |
| `success_rate` | passed tasks / denominator |
| `mean_score` | arithmetic mean of task scores |
| `ci_95` | bootstrap 95% confidence interval over task scores |
| `mean_steps` | average harness steps per task |
| `median_duration_s` | median wall-clock task duration |
| `mean_cost_usd` | average model cost per task |
| `tokens_per_task` | input + output tokens per task |
| `snapshot_tokens` | token estimate for snapshot tool results |
| `action_error_rate` | failed browser actions / browser actions |

Phase 5 also adds a Callisto-specific perception metric:

```text
snapshot_density = useful_snapshot_lines / estimated_snapshot_tokens
```

This is not a benchmark score. It is a diagnostic to compare Mini/Page snapshot
changes against token usage.

---

## Reproducibility discipline

A published number must include:

- Git commit SHA and dirty-worktree flag.
- `uv.lock` / pinned Python dependencies for eval and harness.
- `package-lock.json` or equivalent for `packages/mini`.
- Node, Python, OS, Chrome/Chromium version.
- Model ID, provider, temperature, max tokens, and any provider-specific flags.
- System prompt hash.
- Benchmark adapter version and task subset hash.
- Raw model outputs, tool calls, audit logs, final answers, screenshots, and
  snapshots for every task.
- Scorer version and judge model metadata if applicable.

If any required field is missing, the run can be used for debugging but cannot be
published in `BENCHMARKS.md`.

---

## CI policy

### PR eval

Every PR runs:

1. Unit tests for dataset loading, artifact writing, scoring, and stats.
2. A no-network fake-model smoke run.
3. Optional live eval when API keys are present:
   - `webvoyager --subset smoke` for normal PRs.
   - `webvoyager --subset pr-50` for changes touching `harness/`,
     `packages/mini/`, `eval/`, or prompts.

PR live eval is budget-capped and may be skipped for forks without secrets.
Skipped live evals are reported as neutral, not passing evidence.

### Regression gate

For protected branches, compare against the latest blessed baseline artifact:

- Fail if success rate drops by more than 5 percentage points on `pr-50`.
- Warn if mean cost increases by more than 25%.
- Warn if mean steps increase by more than 25%.
- Warn if snapshot tokens increase by more than 25%.

The gate is noisy by design but not absolute truth. Maintainers can override with
an explicit note in the PR when benchmark sites are unstable.

### Scheduled eval

Nightly or weekly cron runs a larger WebVoyager subset on `main`. Full runs are
manual to control API cost.

---

## `BENCHMARKS.md`

Root `BENCHMARKS.md` is generated or updated from run summaries. It contains:

1. Current headline table.
2. Exact reproduction command.
3. Run manifest links.
4. Confidence intervals.
5. Known exclusions.
6. Cost and latency summary.
7. Hardware/browser/model metadata.

Example row:

```markdown
| WebVoyager | 72.4% ± 3.1 | 640 | openrouter/... | 2026-07-09 | [run](runs/...) |
```

Never write `SOTA` in `BENCHMARKS.md`. Report numbers; let leaderboards decide.

---

## Baselines and comparisons

Phase 5 may include adapters to run other agents only if doing so is cheap and
fair. The first release does **not** need to re-run browser-use, Operator, or
Aside. Public comparison numbers may be cited if they are labeled with source,
date, and configuration caveats.

When Callisto runs a competitor locally, the same artifact and scoring policy
applies. No asymmetric judging.

---

## Data contamination and benchmark ethics

- Do not train or tune on benchmark solutions.
- Do not add benchmark-specific prompt rules beyond generic browser behavior.
- Do not remove failed tasks after the fact.
- Do not hide CAPTCHA, login, or downtime failures.
- Do not report private benchmark results unless the benchmark license permits it.
- Do not submit leaderboard numbers that cannot be reproduced from a clean clone
  plus documented secrets/API keys.

If a benchmark's terms conflict with artifact publication, publish the maximum
allowed metadata and clearly mark the run as partially reproducible.

---

## Failure taxonomy

Every failed task gets one primary reason:

| Reason | Meaning |
| --- | --- |
| `agent_wrong_answer` | Agent completed but answer/action was wrong |
| `agent_incomplete` | Agent stopped early or exceeded step limit |
| `browser_action_error` | Refs stale, click/fill failed, navigation failure |
| `site_changed` | Page no longer matches benchmark assumption |
| `site_unavailable` | DNS, 5xx, maintenance, blocking |
| `auth_required` | Task requires unavailable credentials |
| `captcha_or_bot_block` | CAPTCHA or bot wall prevented progress |
| `provider_error` | Model/API failure |
| `budget_exceeded` | Per-task or run budget cap hit |
| `scorer_error` | Scorer could not determine outcome |

This taxonomy makes regressions actionable: a harness bug and a dead website
should not look the same.

---

## Security and privacy

Eval artifacts can contain page content, user-provided instructions, URLs, and
model outputs. They must not contain secrets.

- Reuse Phase 4 secret redaction before artifact write.
- Do not run credentialed evals in public CI.
- Store screenshots and snapshots only for benchmark pages or explicit local
  runs.
- Add `.gitignore` entries for raw run directories by default.
- Publish selected run artifacts intentionally, not accidentally.

---

## Implementation plan

### Milestone 1 — skeleton and fake runs

- Add `eval/pyproject.toml` and `callisto_eval` package.
- Add artifact writer and manifest schema.
- Add fake benchmark with fake model for offline CI.
- Add stats summary with bootstrap confidence intervals.

### Milestone 2 — WebVoyager smoke

- Add WebVoyager adapter and `smoke` subset.
- Run through existing `harness.callisto.loop.run`.
- Store audit logs, snapshots, screenshots, and results.
- Add deterministic scoring where possible; mark unclear tasks for review.

### Milestone 3 — CI and BENCHMARKS

- Add `.github/workflows/eval.yml`.
- Add `BENCHMARKS.md` generator.
- Add PR regression compare against a checked-in or release-attached baseline.

### Milestone 4 — larger public run

- Run WebVoyager `pr-50`, then full WebVoyager.
- Publish run summary and selected artifacts.
- Document cost and reproduction steps.

### Milestone 5 — next benchmark adapters

- Add Online-Mind2Web loader/scorer scaffold.
- Add BU-Bench-V1 adapter.
- Add Odyssey placeholder until access is available.

---

## Open questions

1. Where should large public artifacts live: GitHub Releases, Hugging Face
   datasets, S3-compatible storage, or a separate `callisto-benchmarks` repo?
2. Which LLM judge is acceptable for tasks with no deterministic scorer?
3. Should the PR regression baseline be checked into the repo or downloaded from
   the latest successful scheduled run?
4. How much screenshot data is safe and useful to publish by default?
5. Should eval runs use a fresh Chrome profile per task or per run? Fresh per
   task is cleaner but slower.

---

## Success criteria

Phase 5 is complete when:

- `python -m callisto_eval run webvoyager --subset smoke` works locally.
- A WebVoyager `pr-50` run can be reproduced from a clean clone.
- `BENCHMARKS.md` exists at the repo root and links to at least one real run
  manifest.
- CI runs offline eval tests on every PR.
- Live eval CI runs when secrets are available and enforces the regression gate.
- Every published benchmark row includes confidence intervals, model metadata,
  commit SHA, and reproduction command.

---

## Pitfalls

- **Benchmark-maxxing prompts.** Do not add task-specific rules to the system
  prompt. Fix general browser behavior instead.
- **Silent exclusions.** Excluding hard tasks after a run destroys credibility.
- **Single-run overconfidence.** Report confidence intervals and avoid broad
  claims from small subsets.
- **Hidden cost.** Always report cost per task and total run cost.
- **Noisy CI.** Keep PR evals small and budget-capped; use scheduled runs for
  broad confidence.
- **Artifact leaks.** Redact secrets and do not publish raw runs accidentally.

---

## Time box

3 weeks part-time for WebVoyager smoke + PR subset + `BENCHMARKS.md`.
Longer-running benchmark adapters can continue after v1 as long as the WebVoyager
path proves the reproducibility discipline.
