# Evaluate Callisto through its host agent

Callisto is a browser runtime exposed over MCP. The **host agent** supplies the
model, conversation loop and authentication. Codex, Claude Code and other stdio
MCP hosts can connect the launcher; Callisto does not need a separate model API
key. The host's own subscription or provider configuration still applies.

For normal use, register this command in the host's MCP configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/callisto/scripts/callisto.mjs", "zen"]
}
```

Start that MCP entry, load the temporary extension, pair it, and explicitly share
the intended tab. The host then chooses observations and actions through
Callisto's tools. See [getting started](getting-started.md) for setup and
[trusted input and recovery](zen-advanced-runtime.md) for native input requirements.

## Matched Codex-host pilot

`eval/agent-comparison/host-agent.mjs` launches the installed, signed-in Codex CLI
for each task. It connects the host to native Callisto or browse MCP tools. It
never reads `.env` or calls a model-provider completion API. The older
`matched-agent.mjs` remains an optional API experiment; its HTTP 402 failures do
not block the normal host architecture.

Install the source dependencies, build the debug bridge, and confirm that Codex
is already signed in:

```sh
npm --prefix packages/mini ci
cargo build --locked --manifest-path packages/firefox-rs/Cargo.toml --bin callisto-firefox-tab-mcp
codex login status
BENCH_OUTPUT_DIR=/tmp/new-callisto-host-run xvfb-run -a node eval/agent-comparison/host-agent.mjs
```

The Linux fixture setup also needs Zen Flatpak, Firefox/geckodriver, Chromium,
Xvfb, Python and the installed browse CLI with its extension built in
`vendor/browse/dist`. `GECKODRIVER_BINARY` and `CHROMIUM_PATH` override binary
locations. All browser profiles, pairing and sharing belong to disposable test
instances. This does not use or stop a person's browser session.

The pilot defaults to one paired trial of four tasks: form submission, paginated
table extraction, trusted input through a same-origin frame/open shadow root,
and finding an inventory item beyond the bounded first observation.
`BENCH_REPETITIONS=2` repeats them with the reverse engine order in the second
trial. `BENCH_TASKS=form` selects a smoke task. Always choose a fresh output
directory; results are not overwritten. The default model is `gpt-6.1-sol` at
`high` effort, matching the installed host configuration at implementation time;
`BENCH_HOST_MODEL` and `BENCH_HOST_EFFORT` select explicit alternatives for both
engines together.

## What is measured

Each task starts a fresh host conversation in an empty workspace, with unrelated
user configuration, project instructions, shell/web tools and skill instructions
removed from the task context. The fixture's browser tools have explicit approval.
This is a deliberately narrow, identical host configuration for both engines,
not a measurement of arbitrary personal Codex setups.

A private Unix-socket transport preserves the fixture's existing extension
sharing lease while the host opens its MCP connection. Tool names, schemas,
arguments and results pass through unchanged. The host sees eleven native
Callisto tools or browse's native `execute` tool; those catalogs and the backend
instructions are disclosed in the report. The harness explicitly reacquires the owned visible tab and native input lease
before each task, then checks state afterward. It makes no model decisions or browser actions on the host's behalf
during a measured task.

Elapsed time includes host startup and MCP initialization. Browser setup, initial
navigation and evaluator calls are excluded. Reports retain completed-host token
usage, including cached input and reasoning-token counts when supplied, browser
tool calls, UTF-8 response sizes, visible host events and exact task-state checks.
Private reasoning events are omitted. Token usage is not converted into invented
subscription dollar charges; per-run billed cost remains `null` when unavailable.

Runs stop on infrastructure errors. Tool approval/configuration failures are
infrastructure errors, not browser task failures. Each session has a 180-second
wall deadline and at most 40 dispatched browser calls. The runner stops before
starting another session once reported usage reaches one million input/output
tokens; this is a session-boundary guard, not a strict per-request token cap.

A small local fixture result cannot establish broad browse parity or real-site
reliability. Keep failures, cache effects, engine order, browser differences and
sample size visible when interpreting timing and usage.

The host integration follows the official OpenAI documentation for
[non-interactive JSON events](https://learn.chatgpt.com/docs/non-interactive-mode)
and [configuration overrides and MCP tool approval](https://learn.chatgpt.com/docs/config-file/config-reference).
