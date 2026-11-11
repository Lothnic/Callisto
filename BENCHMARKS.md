# Callisto benchmarks

Measurements are experimental, not a claim that Callisto is better than browse
or Playwright. The scripts, task outcomes, environments and limitations are kept
with the associated notes.

| Comparison | What it measures | Results |
| --- | --- | --- |
| [Runtime upgrade follow-up](research/2026-11-runtime-upgrade-comparison.md) | Same-origin frames, batching and bounded snapshots | Current exploratory run; small sample |
| [MCP vs browse](research/2026-11-callisto-mcp-vs-browse.md) | Scripted local interactions and public-page snapshots | Historical pre-upgrade baseline; small sample |
| [Mini vs Playwright](research/2026-11-mini-playwright-fixture-benchmark.md) | Deterministic local fixture operations | Historical baseline; not an agent benchmark |
| [Local model-driven tests](research/2026-11-actionability-agent-comparison.md) | Three synthetic tasks under a shared action policy | Exploratory single trials |
| [Live-site agent tests](research/2026-11-live-browser-comparison.md) | Native page observations and generated answers | Inconclusive: model/provider limits |

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

Set `CALLISTO_NO_SANDBOX=1` only if the environment requires it. The local
scripts create and delete their own browse sessions; the public-page script
uses the existing browser profile and public websites. See
[`eval/agent-comparison/`](eval/agent-comparison/) for other experiments.

A defensible comparison should identify browser and model versions, task set,
state, settings, failures, sample size and per-task results. Report model turns,
context cost and task success only when an actual agent was run. A scripted tool
call is not an agent task.
