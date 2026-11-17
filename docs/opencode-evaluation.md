# Evaluate Callisto through the OpenCode host

This adapter runs measured browser-agent trials through the installed OpenCode
CLI. It is deliberately narrow: it starts a fresh OpenCode conversation per
trial, exposes only the browser MCP server that the harness owns, and does not
inspect or reuse a person's OpenCode configuration, credentials, sessions or
browser.

The public-site benchmark remains `eval/agent-comparison/real-world-agent.mjs`.
Select the host with `BENCH_HOST=opencode`. The default Codex path is unchanged.

## Requirements

- OpenCode 2.3.0 or a compatible v2 CLI.
- A model that the local OpenCode installation can list, for example
  `opencode/deepseek-v4.1-flash-free`.
- The variant must exist in the model catalog. `high` is confirmed for the
  DeepSeek V4.1 Flash Free model (`low`, `high`, `max`).
- The existing browser prerequisites: built Callisto runtime, Zen Flatpak and
  geckodriver, or Chromium and the browse CLI plus extension.
- Xvfb and `xvfb-run` for headful owned browser profiles.

Check the exact model and variant before a run:

```sh
opencode models | grep '^opencode/deepseek-v4.1-flash-free$'
```

`opencode models` lists model IDs, not variants. The model catalog used by this
installation reports `reasoning_options` with an `effort` enum including `high`.
The adapter also records the served model and variant from
`opencode session export` for every trial; a mismatch or an unverifiable served model is an infrastructure error.

## Run a small matched preflight pair

Use a fresh output directory. This runs one task on both engines, one repetition
each, before the full 24-trial run:

```sh
BENCH_HOST=opencode \
BENCH_ENGINES=zen,browse \
BENCH_TASKS=wikipedia-biography \
BENCH_REPETITIONS=1 \
BENCH_ZEN_TOOL_PROFILE=compact \
BENCH_INPUT_MODE=synthetic-dom \
BENCH_OUTPUT_DIR=/tmp/opencode-preflight-pair \
BROWSE_EXTENSION_PATH=/absolute/path/to/pinned/browse-extension \
xvfb-run -a node eval/agent-comparison/real-world-agent.mjs
```

Inspect the saved traces, catalog sizes, errors and exact model/variant before
starting the full run. Do not reuse the preflight directory for the full run;
use a new phase-0 directory.

## Full run

```sh
BENCH_HOST=opencode \
BENCH_ENGINES=zen,browse \
BENCH_REPETITIONS=2 \
BENCH_ZEN_TOOL_PROFILE=compact \
BENCH_INPUT_MODE=synthetic-dom \
BENCH_OUTPUT_DIR=/tmp/opencode-deepseek-full \
BROWSE_EXTENSION_PATH=/absolute/path/to/pinned/browse-extension \
xvfb-run -a node eval/agent-comparison/real-world-agent.mjs
```

The default is 24 planned trials: six tasks × two repetitions × two engines,
with balanced engine order. The model calls are made by OpenCode, not by the
harness. The evaluator's HTTP oracles are separate and are never shown to the
model.

If the reported-token guard stops the process, resume only missing trial IDs
with the same settings and a higher guard:

```sh
BENCH_HOST=opencode \
BENCH_ENGINES=zen,browse \
BENCH_REPETITIONS=2 \
BENCH_ZEN_TOOL_PROFILE=compact \
BENCH_INPUT_MODE=synthetic-dom \
BENCH_OUTPUT_DIR=/tmp/opencode-deepseek-full \
BENCH_RESUME=1 \
BENCH_MAX_REPORTED_TOKENS=6000000 \
BROWSE_EXTENSION_PATH=/absolute/path/to/pinned/browse-extension \
xvfb-run -a node eval/agent-comparison/real-world-agent.mjs
```

Resume refuses a different host, model, variant, task set, engine list, tool
profile, input mode, runtime hash or exposed catalog. A resume starts new owned
browser profiles and records a new phase. Cross-phase pairs are excluded from
the matched latency summary but remain in the totals.

## What the adapter configures

`eval/agent-comparison/opencode-host.mjs` creates a temporary HOME and XDG tree
outside the user's global configuration. Each trial writes a private
`opencode.json` with:

- `model` = `opencode/deepseek-v4.1-flash-free#high` (or the `BENCH_OPENCODE_*`
  override).
- one local stdio MCP server pointing at the harness's private Unix socket
  through `host-mcp-proxy.mjs`.
- `codemode: false`, so OpenCode exposes the native MCP tool schema instead of
  wrapping it in its Code Mode sandbox.
- `instructions: []`, no extra skills directories, no project configuration,
  and no plugins from the private HOME.
- `compaction.auto: false`, avoiding hidden summary model calls during a short
  measured task.
- a custom primary agent `benchmark` with an ordered deny-everything policy and
  one allow rule for the browser tool action
  (`zen_callisto` for compact Callisto, `browser_execute` for browse).
- no shell, edit, read, glob, grep, webfetch, websearch, skill, subagent,
  question, external-directory or MCP-resource permission.

The child environment keeps only routine process settings (PATH, locale,
display, proxy and XDG) plus private HOME/XDG paths. It removes inherited
`OPENCODE_*` session/config state and model-provider API keys. Authentication
for the free model is supplied by OpenCode itself; the adapter never reads,
copies, prints or writes credentials.

OpenCode names MCP tools `<server>_<tool>`. The transport receives the unchanged
native name and arguments (`callisto` with `{op,args}` for compact Zen,
`execute` with `{session,code}` for browse). The model sees `zen_callisto` or
`browser_execute`; the runner records this host naming difference and adapts only
the backend prompt's tool name. Tool schemas and results are not rewritten.

## Event and usage contract

`opencode run --format json` emits newline-delimited JSON. The adapter retains
visible lines and omits reasoning text because reasoning events are only emitted
with `--thinking`; private chain-of-thought is not requested or saved:

| Line type | Meaning |
| --- | --- |
| `step_start` | One model step began; carries session and message IDs. |
| `text` | Visible assistant text chunk with message ID. |
| `tool_use` | Native tool call and its completed/error state, input and output. |
| `step_finish` | Step finish reason, reported cost and token counters. |
| `error` | Provider/configuration error, including HTTP status and retry hint. |

The final answer is the concatenated `text` of the last assistant message. A
strict `JSON.parse` is applied exactly as in the Codex path; fenced or malformed
JSON is not repaired.

Usage sums the disjoint counters in `step_finish.part.tokens`. In OpenCode
2.3.0, raw `input` is **uncached** input and raw `output` is visible output.
Normalized `input_tokens = input + cache.read + cache.write` and
`output_tokens = output + reasoning`; each component is also retained separately.
The total is normalized input plus output, without counting reasoning twice.
See the version-pinned [usage mapping](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/usage.ts)
and [total calculation](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/schema/src/token-usage.ts).
Returned browser bytes remain separate from model tokens. Missing step costs
remain unavailable; a reported cost may also be a catalog-price fallback,
so it is not an invoice.

The adapter passes a fixed `--title` to avoid the hidden title-generation model
call and disables automatic compaction, so visible step usage is not polluted by
maintenance calls. `opencode session export <id>` is read after the run for
actual provider/model/variant verification and OpenCode's session totals. The
export is summarized; assistant content and reasoning are not copied into the
report.

Reported `cost` for the free model is zero marginal cost. The saved
`cost_usd` remains `null`; a zero reported cost is retained as
`reported_cost_usd`, never presented as an invoice or as a general cost saving.

Measured task time includes OpenCode startup, MCP connection, model steps,
navigation, waits, retries, browser calls, OpenCode shutdown and independent
answer/evidence verification. Browser profile provisioning and neutral-tab reset
are measured and recorded separately. The model process deadline is 180 seconds; session export has a separate
10-second maximum and is included in elapsed time. The browser-call ceiling is 35.

## Quota and failure handling

A genuine provider quota or authentication error stops the run. The adapter
records the exact `error` event and `opencode session export` outcome, writes
`preflight-opencode.json` and `run-error.json`, and does not substitute another
provider, model, paid endpoint or Codex. A `provider.free-limit` response with
HTTP 429 is an infrastructure blocker, not a browser-task failure. Do not retry
in a loop; wait for the reported `retryAfterMs` to elapse or change the account
explicitly outside the benchmark.

The 17 November 2026 attempt is saved under
`eval/reports/opencode-deepseek-2026-11-17-blocked/`. A minimal preflight call
succeeded, then the first tool-use preflight was rejected with
`provider.free-limit` (HTTP 429, `retryAfterMs` about 16.8 hours). No measured
browser trials were run and no comparison is claimed.

## Tests

The adapter tests cover exact JSON event parsing, multi-step usage summation,
provider-limit classification, private-environment filtering, config exposure
and OpenCode's own resolution of the private config and agent:

```sh
node --test \
  eval/agent-comparison/opencode-host.test.mjs \
  eval/agent-comparison/real-world-tasks.test.mjs \
  eval/agent-comparison/host-session.test.mjs
```

The scorer tests remain the authority for task success. They require the exact
requested facts, a canonical source URL and a short quote that was actually
returned in browser tool output; direct network, file and request APIs fail the
trial uniformly for both engines.

## Validation status

The [17 November attempt](../eval/reports/opencode-deepseek-2026-11-17-blocked/README.md)
was quota-blocked before browser trials. Local parsing/configuration tests and
MCP connectivity passed; the full OpenCode browser workflow remains unvalidated.
The earlier Codex report generator contains Codex-specific prose and should not
be used unchanged for OpenCode results. Build the OpenCode report from its saved
trials and include both cache-read and cache-write components.
