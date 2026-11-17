# Callisto benchmarks

Measurements are experimental, not a claim that Callisto is better than browse
or Playwright. The scripts, task outcomes, environments and limitations are kept
with the associated notes.

The [native OpenCode tool review and improvement plan](research/2026-11-17-browse-native-tools-and-callisto-plan.md)
separates the 0.1.1 catalog inspection from task performance, identifies current
measurement limits, and prioritizes the next Callisto changes.

| Comparison | What it measures | Results |
| --- | --- | --- |
| [GPT-6 Luna public-site pilot](eval/reports/luna-real-world-2026-11-17/README.md) | Current compact Zen and browse tab API, six goals twice per engine | Both 12/12 after uniform JSON-observation scoring correction; profile restart disclosed; token usage is not billed cost |
| [Compact Zen interface](eval/reports/compact-interface-2026-11-17/README.md) | Serialized catalog size and six public-site functional trials | 25 tools / 14,490 bytes to 1 / 940 bytes; 6/6 goals passed, no matched cost claim |
| [Public-site host-agent pilot](eval/reports/real-world-2026-11-16-run2/README.md) | Six public informational tasks, two repetitions per engine, fresh model conversations and real host usage | Both 12/12 after a documented date-format scoring correction; small sample, profile restart disclosed |
| [Runtime upgrade follow-up](research/2026-11-runtime-upgrade-comparison.md) | Same-origin frames, batching and bounded snapshots | Current exploratory run; small sample |
| [MCP vs browse](research/2026-11-callisto-mcp-vs-browse.md) | Scripted local interactions and public-page snapshots | Historical pre-upgrade baseline; small sample |
| [Connected Callisto vs browse](research/2026-11-connected-browse-repeated.md) | Scripted local tasks in the same paired browser | Three trials per case; two timer-dependent cases were unreliable |
| [Mini vs Playwright](research/2026-11-mini-playwright-fixture-benchmark.md) | Deterministic local fixture operations | Historical baseline; not an agent benchmark |
| [Local model-driven tests](research/2026-11-actionability-agent-comparison.md) | Three synthetic tasks under a shared action policy | Exploratory single trials |
| [Live-site agent tests](research/2026-11-live-browser-comparison.md) | Native page observations and generated answers | Inconclusive: model/provider limits |

## Zen workflow and evidence validation

The 14 November 2026 source update was validated with disposable Firefox and
headful Zen Flatpak fixture workflows: extension-owned trusted input, native form
controls and pagination, frames, API replay, scoped interception, cancellation
and relay restart. Rust, JavaScript and Python checks cover recovery without
replaying uncertain writes, stable snapshot captures and failed/interrupted evidence.

A real Zen fixture HAR was accepted by `webarena-verified==1.2.3`. An explicit
task evidence contract also checked observed JSON fields and captured PNG counts.
Parser acceptance and field coverage do not establish a task score. The exporter
does not run benchmark judges or create genuine Playwright traces; original
WebArena still needs its live evaluator. No new controlled browse latency,
model-cost or task-success comparison accompanied this update.

See [runtime reproduction and limits](docs/zen-advanced-runtime.md) and the
[pinned benchmark trace requirements](research/2026-11-14-benchmark-trace-requirements.md).

## Reproduce the MCP comparison

From the repository root, install and build `packages/mini`, set `CHROME_PATH`
to a Chrome binary, and connect browse's extension. These scripts use the same
MCP client without a model API key:

```bash
npm --prefix packages/mini ci
npm --prefix packages/mini run build
CHROME_PATH=/path/to/chrome BROWSE_ACTION_TIMEOUT_MS=10000 \
  BENCH_OUTPUT=/tmp/callisto-mcp-results.json node eval/agent-comparison/mcp-compare.mjs
CHROME_PATH=/path/to/chrome BENCH_OUTPUT=/tmp/callisto-batching.json \
  node eval/agent-comparison/mcp-batching.mjs
CHROME_PATH=/path/to/chrome BENCH_OUTPUT=/tmp/callisto-live.json \
  node eval/agent-comparison/mcp-live.mjs
```

Set `BENCH_CALLISTO_CONNECTED=1` for the first command to use Callisto's
experimental connected mode against the same paired browser as browse. That
mode delegates navigation and input to browse's executor; it is not a comparison
of independent browser engines.

Set `CALLISTO_NO_SANDBOX=1` only if the environment requires it. The local
scripts create and delete their own browse sessions; the public-page script
uses the existing browser profile and public websites. See
[`eval/agent-comparison/`](eval/agent-comparison/) for other experiments.

A defensible comparison should identify browser and model versions, task set,
state, settings, failures, sample size and per-task results. Report model turns,
context cost and task success only when an actual agent was run. A scripted tool
call is not an agent task.

## Follow-up: persistent sessions and observations

The [Zen](eval/reports/session-recovery-2026-11-15.json) and
[Firefox](eval/reports/session-recovery-firefox-2026-11-15.json) recovery reports
cover dedicated persistent test profiles. An
[observation-size ablation](eval/reports/observation-efficiency-2026-11-15/README.md)
records serialized response bytes and whether the requested item is present.
These checks do not measure model-token savings or browse task performance.

A [matched Hy3 pilot](eval/reports/matched-agent-2026-11-15/README.md) attempted
both configured providers. HTTP 402 prevented agent execution, so no comparative
score or latency/cost result is reported. The harness saves real provider usage
when available and keeps infrastructure errors out of browser-task scores.

## Codex host over native MCP tools

The [host-agent pilot](eval/reports/host-agent-2026-11-15/README.md) runs the
installed, signed-in Codex CLI with native Callisto or browse tools. All four
local tasks passed on each runtime after explicitly reacquiring the owned test
tab before each task. The [initial visibility refusal](eval/reports/host-agent-2026-11-15-initial/README.md)
is retained separately, alongside the fixture correction and regression.

This is one paired trial with fixed engine order, different browser engines and
visible cache effects. The report records real host token usage and elapsed
startup/task time; it does not establish a general speedup or billed-cost saving.
Dollar charges remain unavailable. See [reproduction and measurement boundaries](docs/host-agent-evaluation.md).
The runtime takes its model from the MCP host; no separate model API credential
is required by this primary evaluation path.
