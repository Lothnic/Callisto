# Host-agent evaluation

Callisto supplies browser tools over MCP; the host agent supplies the model and
conversation loop. The primary matched pilot now uses the installed, signed-in
Codex host through `host-agent.mjs`, rather than a separate model API account.
See [the host evaluation guide](../../docs/host-agent-evaluation.md) for setup,
reproduction, measurement boundaries and limits.

```sh
BENCH_OUTPUT_DIR=/tmp/new-callisto-host-run xvfb-run -a node eval/agent-comparison/host-agent.mjs
```

The host selects observations and actions through unchanged native MCP tools.
The harness owns disposable profiles and verifies task state. No `.env` or model
API key is needed for this runner. Claude Code and other MCP hosts can use the
same Callisto launcher; the automated adapter in this pilot currently runs Codex.

## Concurrent human and agent use

`background-window.mjs` tests the explicit preparation flow and native form work
while OS-level typing and muted video continue in a focused human window. It
uses an owned Xvfb/X11 display and Openbox, not a personal browser. No model is
called. See [reproduction and limits](../../docs/background-work.md) and the
[saved run with traces](../reports/background-window-2026-11-15.md).

## Earlier API-driven experiments

### Local model-driven engine comparison

The runner uses the same model, prompt, observations and action schema for Mini, Playwright and optionally browse on three resettable local fixtures. It records actions, success, elapsed time and token usage. It is a small exploratory test, not a live-site, security or representative production benchmark. The shared, scripted DOM observation bypasses each product's native snapshot format. It does not persist or print the API key. The prompt and fixture contain no personal data.

From the repository root, build Mini and run with `CHROME_PATH` set to a local Chrome for Testing binary:

```sh
npm --prefix packages/mini run build
CHROME_PATH=/path/to/chrome BENCH_OUTPUT=/tmp/agent-results.json node eval/agent-comparison/run.mjs
```

The `playwright-core` dev dependency is resolved from `packages/mini/node_modules`; run `npm ci` there first. The runner reads `SILICONFLOW_KEY` from the environment or repo `.env`, and accepts `BENCH_MODEL`. Set `BENCH_PROVIDER=openrouter` to use `OPENROUTER_API_KEY`. It makes up to six model requests per engine per task and uses a single trial. `CALLISTO_NO_SANDBOX=1` is an explicit opt-in for hosts that need it.

Set `BENCH_ENGINES=mini,playwright,browse` to include browse. It needs a paired and connected extension and runs in a temporary, origin-limited session, which is deleted at the end. Browse runs in the user's browser, not the same isolated browser binary, and CLI startup is included in timing.

### Persistent Zen sessions and the optional API pilot

- `session-recovery.mjs`: dedicated persistent Zen/Firefox profiles, explicit
  crash/restart tests, saved pairing and fail-closed input intent. Set
  `CALLISTO_TEST_BROWSER=firefox` for Firefox and `RECOVERY_OUTPUT` for a report.
- `observation-efficiency.mjs`: one synthetic inventory, bounded/full/targeted/diff
  observations, byte counts, content coverage and real runtime trace counters.
  `OBSERVATION_OUTPUT` must name a new directory. No model is called.
- `matched-agent.mjs`: identical model, task instructions and budget across native
  Zen and browse MCP interfaces. Uses independent owned test profiles and saves
  catalogs, visible tool transcripts, provider token usage and task-state checks.
  Run under Xvfb, set a new `BENCH_OUTPUT_DIR`, choose `BENCH_PROVIDER=siliconflow`
  or `openrouter`, and use an already configured funded credential. Never commit
  credentials. Defaults to two alternating-order trials of four local tasks.

The model harness has a shared 100-request/250,000-token safety budget. Dollar
estimates use a documented uncached list price, not an invoice; returned provider
cost is recorded separately. A provider failure stops the run with exit code 2
and infrastructure-error metadata, never an invented browser-task score. Different
native catalogs and observations are retained and disclosed rather than silently
normalized. Setup, task navigation and evaluator calls are excluded from measured
agent work. None of the fixtures attaches to a person's existing browser.

## Public-site host-agent comparison

`real-world-agent.mjs` runs fresh signed-in Codex conversations on six anonymous,
read-only public-site goals: Wikipedia biography, arXiv paper metadata, a GitHub
issue, PyPI release metadata, Python documentation and a GOV.UK calendar.
The model chooses its browser actions. No selector recipes or expected answers
are supplied to it. This is separate from the scripted local fixture suites.

```sh
cargo build --locked --manifest-path packages/firefox-rs/Cargo.toml --bin callisto-firefox-tab-mcp
BROWSE_EXTENSION_PATH=/absolute/path/to/browse/extension \
BENCH_OUTPUT_DIR=/tmp/new-real-world-run \
xvfb-run -a node eval/agent-comparison/real-world-agent.mjs
node eval/agent-comparison/real-world-report.mjs /tmp/new-real-world-run
```

Use the already installed browse extension directory to pin its actual version,
rather than silently comparing a stale vendored build. Without the override,
`BrowseFixture` uses `vendor/browse/dist`. Both browser profiles belong to the
benchmark; no personal tabs, logins or pairing state are used. The owned Zen
extension pregrants permissions and pairs automatically. This is not a test of
store installation or permission onboarding.

The default is two repetitions with balanced engine order. `BENCH_TASKS` selects
comma-separated task IDs, `BENCH_REPETITIONS` accepts 1–3, and
`BENCH_INPUT_MODE` is `synthetic-dom` by default. `trusted-bidi` is an optional,
separate configuration. Both engines use `gpt-6.1-sol` at high effort through the
same Codex host. Each trial is a fresh conversation with browser tools only.

Time includes the model's work, site navigation, waiting, retries and independent
answer/evidence checking. Setup and neutral-tab reacquisition are separate.
Every attempt retains usage, tool errors, text size and visible traces; private
reasoning events are omitted. Billed dollar cost remains unavailable. Exact
source URLs and quotations must be observed through browser tools; direct
network/API/file access by the agent is prohibited. API/JSON data used by the
independent evaluator are saved separately and never shown to the model.

A six-site, two-repeat pilot does not establish a general browser success rate
or a stable latency/cost advantage. Keep challenge pages, timeouts, cache effects
and incomplete runs visible; compare successful-task timing only on matched
same-task/repetition pairs.

`real-world-adjudicate.mjs OUTPUT_DIR` rechecks saved answers and observations
without rerunning agents. It writes separate reviewed scores and a correction
audit, preserving raw scores and timings. The calendar checker accepts a shared
explicit year for both dates. Its positive, negative and evidence checks run
with `node --test eval/agent-comparison/real-world-tasks.test.mjs`.

If the runner stops at its reported-token session boundary, resume only missing
trial IDs with the same output directory and settings:

```sh
BROWSE_EXTENSION_PATH=/absolute/path/to/browse/extension \
BENCH_OUTPUT_DIR=/tmp/existing-real-world-run \
BENCH_RESUME=1 BENCH_MAX_REPORTED_TOKENS=5000000 \
xvfb-run -a node eval/agent-comparison/real-world-agent.mjs
```

Resume verifies that official answer facts, runtime hashes and exposed catalogs
are unchanged. It records a new profile phase. The report excludes cross-phase
pairs from its primary matched latency summary, while retaining every attempt.
The completed [16 November pilot](../reports/real-world-2026-11-16-run2/README.md)
includes both harness snapshots, the original guard event and all 24 traces.

```sh
node eval/agent-comparison/real-world-adjudicate.mjs /tmp/existing-real-world-run
node eval/agent-comparison/real-world-report.mjs /tmp/existing-real-world-run
uv run --with matplotlib python eval/agent-comparison/real-world-plot.py /tmp/existing-real-world-run
```
