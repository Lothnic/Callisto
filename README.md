# Callisto

**A lean browser runtime for agents you already use.**

Callisto gives an existing host agent browser tools through a local MCP server.
Its TypeScript engine, `@callisto/mini`, uses the Chrome
DevTools Protocol and an accessibility snapshot with actionable references.
The runtime does not require a separate model API key; the host supplies the
agent.

An experimental Rust extension bridge also connects to an already running
Firefox or Zen profile, including existing tabs and logins. See the
[Firefox and Zen guide](packages/firefox-rs/README.md) for setup, permissions,
capabilities and limitations. A shared [launcher and setup command](docs/development-installation.md)
selects the backend and reports its capabilities. Direct attachment to an explicit
existing Chromium CDP target is also available when remote debugging is already
enabled; see the [Mini attachment guide](packages/mini/README.md#attach-directly-to-an-existing-debug-enabled-chromium-tab).

Callisto is experimental. Its Playwright-shaped API is a subset, not a drop-in
replacement for Playwright. An experimental connection to an existing Chromium
browser through browse's relay is available with significant limitations below.
Performance and reliability claims are still being tested.

## Get started

For setup with Codex, Claude Code or OpenCode, including existing Zen tabs and
pairing, start with the [user and agent setup guide](docs/getting-started.md).

From the repository root, with Node.js 20+ and a Chromium/Chrome binary:

```bash
npm --prefix packages/mini ci
npm --prefix packages/mini run build
```

The included [OpenCode project configuration](opencode.json) registers the
local MCP server. Start or reopen OpenCode in this project and use the
`callisto` tools. For another MCP host, launch:

```bash
node /absolute/path/to/callisto/packages/mini/dist/mcp.js
```

Both backends share the same structured batch/extract interface: `callisto_run`
executes up to 40 dependent steps (navigate, click/fill by ref or exact role,
press, scroll, wait, wait-for-text, extract) and `callisto_extract` reads typed
rows from a CSS row selector plus field map, optionally following a next-page
control and merging pages. Neither evaluates arbitrary page JavaScript. See the
[Mini guide](packages/mini/README.md) and [Firefox and Zen guide](packages/firefox-rs/README.md) for the full limits.

The server starts a fresh browser on the first browser tool call and closes it
when the session ends. Set `CHROME_PATH` in the host environment if Chrome is
not discovered, or `CALLISTO_MCP_HEADLESS=0` to show the window. See the
[Mini guide](packages/mini/README.md) for the available tools and limitations.

### Experimental connected browser

With the browse CLI and its paired Chromium extension already running, set
`CALLISTO_MCP_BROWSER=connected` and `CALLISTO_ALLOWED_ORIGINS` to a
comma-separated list of HTTP(S) origins in the MCP host environment. The server
creates an agent-owned tab in that browser profile, so the tab can use the
profile's existing logged-in sessions. It does not adopt existing tabs.
`CALLISTO_BROWSE_COMMAND` can specify the browse CLI executable.

Navigation and pointer and keyboard actions run through browse's execution
lifecycle; Mini still captures and checks the page over CDP. A session reset
interrupts an executing action, and actions reject a replaced tab. The bridge
uses browse's Patchright-backed execution for these operations, so it is not a
standalone Mini-only connected runtime. `callisto_handoff` delegates a human
step to browse; timeout, cancellation, and one human-confirmed handoff on a
local fixture have been tested. Toolbar take-back, interruptions during every
action, and reconnect recovery still need end-to-end coverage. This mode is
experimental and is not production-ready.
Closing Callisto closes its own tab and session, not the browser. The vendored
[browse source and license](vendor/README.md) are a preserved upstream copy;
the connected bridge currently uses the installed browse CLI and extension.

## Website

The marketing site lives in [`site/`](site/) and is published at
<https://callisto.lothnic.dev>. It is plain HTML, CSS and JavaScript with no
build step. Open `site/index.html` directly, or serve the folder:

```bash
python3 -m http.server 8087 --directory site
```

## Project layout

| Path | Purpose |
| --- | --- |
| [`packages/mini/`](packages/mini/) | CDP engine, accessibility snapshots and local MCP server |
| [`packages/firefox-rs/`](packages/firefox-rs/) | Experimental Rust Firefox/Zen bridge and BiDi runtime |
| [`site/`](site/) | Static marketing site; no build step |
| [`harness/`](harness/) | Optional reference agent and CLI, not required for MCP |
| [`eval/`](eval/) | Evaluation tools and reproducible comparison scripts |
| [`research/`](research/) | Findings, historical notes and benchmark evidence |
| [`future.md`](future.md) | Benchmark plan, Firefox/Gecko assessment, Rust review and Firefox roadmap |
| [`packages/callisto-browser/`](packages/callisto-browser/) | Historical BrowserOS fork experiment; not the product runtime |

## Status and evidence

The current MCP interface has structured actions, bounded snapshots, text
search and action batches. Same-origin iframe actions are supported. An
experimental connected mode adds navigation and input through browse's executor
and a basic human-handoff tool, but cross-origin frame coverage, toolbar
take-back, full interruption and reconnect handling, and full Playwright
compatibility remain open work. Browser actions can change websites; the MCP
server does not supply an approval or security boundary.

Read the [runtime roadmap](roadmap.md), [benchmark index](BENCHMARKS.md), and
[research index](research/README.md) for current priorities and test caveats.
The [future work note](future.md) covers the benchmark plan, the
Firefox/Gecko compatibility assessment, the Rust feasibility review, and the
Firefox implementation roadmap. In particular, local fixture timings are
not proof of agent success or of an advantage over browse.

## Development

```bash
npm --prefix packages/mini test
npm --prefix packages/mini run typecheck
```

Browser tests are opt-in: set `CALLISTO_SMOKE=1` and `CHROME_PATH` to a local
Chrome binary. See [the Mini guide](packages/mini/README.md) for details. The
optional reference harness and eval package have their own Python dependencies.
To run the connected smoke tests against a paired browse browser, set
`CALLISTO_BROWSE_SMOKE=1`; they use a temporary local fixture and their own tab.

## License

The root project is MIT ([LICENSE](LICENSE)). The separately marked
[`packages/callisto-browser`](packages/callisto-browser/) experiment has its own
AGPL-3.0 license and third-party notices; check those terms before distributing
its code or binaries.
