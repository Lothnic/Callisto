# Callisto

**A lean browser runtime for agents you already use.**

Callisto gives an existing host agent an isolated Chromium session through a
local MCP server. Its TypeScript engine, `@callisto/mini`, uses the Chrome
DevTools Protocol and an accessibility snapshot with actionable references.
The runtime does not require a separate model API key; the host supplies the
agent.

Callisto is experimental. Its Playwright-shaped API is a subset, not a drop-in
replacement for Playwright, and it does not yet attach to your logged-in
browser like browse. Performance and reliability claims are still being tested.

## Get started

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

The server starts a fresh browser on the first browser tool call and closes it
when the session ends. Set `CHROME_PATH` in the host environment if Chrome is
not discovered, or `CALLISTO_MCP_HEADLESS=0` to show the window. See the
[Mini guide](packages/mini/README.md) for the available tools and limitations.

## Project layout

| Path | Purpose |
| --- | --- |
| [`packages/mini/`](packages/mini/) | CDP engine, accessibility snapshots and local MCP server |
| [`harness/`](harness/) | Optional reference agent and CLI, not required for MCP |
| [`eval/`](eval/) | Evaluation tools and reproducible comparison scripts |
| [`research/`](research/) | Findings, historical notes and benchmark evidence |
| [`packages/callisto-browser/`](packages/callisto-browser/) | Historical BrowserOS fork experiment; not the product runtime |

## Status and evidence

The current MCP interface has structured actions, bounded snapshots, text
search and action batches. Same-origin iframe actions are supported; cross-origin
frame coverage, browser attachment, human handoff and full Playwright
compatibility remain open work. Browser actions can change websites; the MCP
server does not supply an approval or security boundary.

Read the [runtime roadmap](roadmap.md), [benchmark index](BENCHMARKS.md), and
[research index](research/README.md) for current priorities and test caveats.
In particular, local fixture timings are not proof of agent success or of an
advantage over browse.

## Development

```bash
npm --prefix packages/mini test
npm --prefix packages/mini run typecheck
```

Browser tests are opt-in: set `CALLISTO_SMOKE=1` and `CHROME_PATH` to a local
Chrome binary. See [the Mini guide](packages/mini/README.md) for details. The
optional reference harness and eval package have their own Python dependencies.

## License

The root project is MIT ([LICENSE](LICENSE)). The separately marked
[`packages/callisto-browser`](packages/callisto-browser/) experiment has its own
AGPL-3.0 license and third-party notices; check those terms before distributing
its code or binaries.
