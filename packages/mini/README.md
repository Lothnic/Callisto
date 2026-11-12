# @callisto/mini

A token-lean wrapper over Chromium via the Chrome DevTools Protocol — the
agent's hands and eyes. `Mini` is the thin CDP engine; `Page` is a
Playwright-shaped facade for agents. No `playwright-core`, no assertions, no full
selector engine. Design: [rfcs/0001](../../rfcs/0001-mini-playwright-surface.md).

## Install & run

```bash
npm install
npm run typecheck            # tsc --noEmit
npm test                     # unit tests only
CALLISTO_SMOKE=1 npm test    # + browser smoke (needs local Chrome + network)
```

Chrome discovery is handled by `chrome-launcher`; set `CHROME_PATH` to override.

## Connect a host agent with MCP

The local MCP server lets the host agent drive Mini without a separate model
API key. Install and build from this repository:

```bash
npm --prefix packages/mini ci
npm --prefix packages/mini run build
```

The repository's `opencode.json` registers the server for OpenCode in this
project. Start or reopen OpenCode from the repository root; after the server
connects its tools are available under `callisto`. Other MCP clients can launch
`node /absolute/path/to/callisto/packages/mini/dist/mcp.js` over stdio. Set
`CHROME_PATH` in the host environment if Chrome is not discovered; set
`CALLISTO_MCP_HEADLESS=0` for a visible window.

By default, each MCP server process owns one isolated browser, launched lazily on the first
browser action. `callisto_navigate` and `callisto_snapshot` return accessibility
trees with `ax-N` refs; use those refs with `callisto_click` and `callisto_fill`.
Snapshots returned over MCP default to 12,000 characters; use `nextOffset` with
`callisto_snapshot` for subsequent pages of the last captured snapshot, or
`callisto_find` to search the full tree. A new capture replaces that cached
snapshot, and refs may become stale when the page changes. `callisto_batch` executes up to
10 structured actions in order, including role-based targets; earlier actions
are not rolled back if a later one fails. The server also exposes
`callisto_press`, `callisto_scroll`, `callisto_screenshot`, and `callisto_close`.
Calls are serialized. Closing the
session removes its browser state; a subsequent call creates a fresh session.

This interface exposes structured actions rather than arbitrary JavaScript.
An experimental connected mode can open its own tab in a browser paired with
browse. Set `CALLISTO_MCP_BROWSER=connected` and `CALLISTO_ALLOWED_ORIGINS` to
the comma-separated origins to allow, with the browse CLI and extension already
installed and paired. Set `CALLISTO_BROWSE_COMMAND` if the CLI is not on PATH.
This mode does not adopt existing tabs, integrate browse's handoff or stop
controls, or reliably drive background tabs; input on hidden tabs is refused.
Foreground input and recovery are not adequately tested. See the
[project README](../../README.md#experimental-connected-browser) for status.

Mini is not a complete Playwright API or a sandbox for untrusted pages; browser actions
can modify websites. Same-origin iframe ref actions are supported; cross-origin
or transformed frames can fail closed.

### Current compatibility limits

This is a subset, not a Playwright replacement. Semantic locators refresh the
accessibility registry and wait up to two seconds for a match, rejecting
ambiguous matches. Ref-based click and fill check visibility, stability,
enabled state, hit testing and (for fill) editability, with a two-second
default action timeout. These are a subset of Playwright's actionability
checks and locator semantics; cross-origin iframe actions can fail closed.
Coordinate actions bypass these checks. CSS selectors and `networkidle` are
unsupported.
Snapshot output includes offscreen nodes, and password input values and their
accessibility descendants are redacted. Do not treat snapshots, screenshots,
arbitrary page evaluation, or network capture as a general secret filter.

For a small repeatable comparison with real Playwright, set `CHROME_PATH` and run
`npm run benchmark:playwright`. See the [results and limitations](../../research/2026-11-mini-playwright-fixture-benchmark.md).

### Getting a usable Chrome (Linux / snap trap)

`chrome-launcher` needs a Chrome that speaks CDP over a debug port. **Ubuntu's
snap Chromium doesn't** — it silently refuses the remote-debugging port and you
get `ECONNREFUSED`. If `which google-chrome` points into `/snap`, grab a
Chrome for Testing binary once:

```bash
npx @puppeteer/browsers install chrome@stable
# prints e.g. .../chrome/linux-XXX/chrome-linux64/chrome — export that:
export CHROME_PATH="$PWD/chrome/linux-<version>/chrome-linux64/chrome"
CALLISTO_SMOKE=1 npm test
```

The `chrome/` download is git-ignored. macOS/Windows with real Chrome
installed can skip this — `chrome-launcher` finds it automatically.

## Usage

```ts
import { Mini, Page } from '@callisto/mini'

const mini = await Mini.launch({ headless: true }) // viewport pinned 1440x900
const page = new Page(mini)

await page.goto('https://github.com', { waitUntil: 'load' })
const snap = await page.accessibility.snapshot()
await page.locator('[callisto-ref="ax-7"]').click()
const png = await page.screenshot()
await mini.close()
```

## Snapshot format

`page.accessibility.snapshot().text` (backed by `mini.snapshot()`) is a pruned accessibility tree — `[ref] role "name" {state}
=value`, two-space indent per depth. Actionable nodes are sorted before passive context so buttons, inputs, dialogs, and links appear before landmarks. Design:
[rfcs/0002](../../rfcs/0002-a11y-tree.md).

```
[ax-3] button "Add to Cart" {focused,clickable}
[ax-12] textbox "Search" =laptop
navigation "Main"
  [ax-7] link "Sign in"
```

Repeated perception turns can request a ref-keyed diff instead of the full tree:

```ts
await page.accessibility.snapshot()              // full baseline
await page.accessibility.snapshot({ diff: true }) // changed/new/removed refs
```

Diff output keeps critical changes upfront:

```
[changed] ax-42 button "Add to Cart" {checked}
[new]     ax-91 dialog "Confirm"
[removed] ax-7 link "Sign in"
```

### Snapshot density comparator

Build first, then run the comparator from the repo root:

```bash
npm --prefix packages/mini run build
node packages/mini/scripts/tokens.mjs \
  https://github.com https://linear.app https://amazon.com
```

Callisto defaults to the bundled `packages/mini/browseros/browseros` binary.
`CHROME_PATH` can override it. In root/Docker environments, set
`CALLISTO_NO_SANDBOX=1`.

Measured with BrowserOS 142.0.7552.49 on this repo. Agent-browser / Playwright MCP
columns are intentionally `TBD` until the same URLs are run with those tools. Do
not publish guessed comparison numbers.

| URL | Callisto chars | Callisto ~tokens | agent-browser ~tokens | Playwright MCP ~tokens | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| https://github.com | 1,308 | 327 | TBD | TBD | Full accessibility layout captured with stable refs |
| https://linear.app | 2,882 | 721 | TBD | TBD | Full accessibility layout captured with stable refs |
| https://amazon.com | 212 | 53 | TBD | TBD | CAPTCHA / anti-bot page in headless mode |

`amazon.com` is not representative of the real homepage in this run: Amazon
served an anti-bot CAPTCHA page under headless automation, yielding a small
53-token layout. Keep it in the table as a visibility issue, not a success claim.

## API

Targets are `{ x, y }` coordinates or opaque string refs (`ax-N`). Refs come
from the snapshot and resolve to the element's box-model center at action time;
they are stable by DOM node, so a ref survives clicks and state changes.

### Agent signals

The sidecar listens to asynchronous CDP browser events and attaches them to the
next `repl` result as steering lines, without adding another tool:

```text
[Agent signal: popup opened at https://example.com/]
[Agent signal: dialog opened: Are you sure?]
[Agent signal: download started: report.pdf]
[Agent signal: tab closed at https://old.example/]
```

Signals currently cover JavaScript dialogs, popups/window opens, downloads, tab
opens, and tab closes.

### Page facade
| Method | Signature |
| --- | --- |
| `new Page(mini)` | wraps a `Mini` engine |
| `goto` / `goBack` / `goForward` / `reload` | Playwright-shaped navigation |
| `click` / `fill` / `press` | `(locatorOrRef, ...) => Promise<void>` |
| `locator` | `('[callisto-ref="ax-N"]') => Locator` |
| `getByRole` / `getByText` / `getByLabel` | resolves against the latest snapshot refs |
| `accessibility.snapshot` | `({ diff?: boolean }?) => Promise<{ url, title, text }>` — Callisto's pruned tree or ref-keyed diff |
| `screenshot` | `({ fullPage?, path? }?) => Promise<Buffer>` |
| `evaluate` | `(fn: string \| Function, ...args) => Promise<T>` |
| `waitForTimeout` / `waitForFunction` | minimal wait helpers |
| `url` / `title` | `() => Promise<string>` |
| `context().pages()` | `() => Promise<{ id, url, title }[]>` |
| `mouse.wheel` / `keyboard.press` | common Playwright-shaped input helpers |

### Lifecycle
| Method | Signature |
| --- | --- |
| `Mini.launch` | `(opts?: { headless?, viewport?, userAgent?, chromeFlags? }) => Promise<Mini>` |
| `close` | `() => Promise<void>` |
| `pages` | `() => Promise<{ id, url, title }[]>` |

### Navigation
| Method | Signature |
| --- | --- |
| `goto` | `(url, { waitUntil?: 'load' \| 'domcontentloaded' }?) => Promise<void>` |
| `back` / `forward` / `reload` | `() => Promise<void>` |

### Interaction
| Method | Signature |
| --- | --- |
| `click` | `(target, { button?, clickCount? }?) => Promise<void>` |
| `dblclick` / `rightclick` / `hover` | `(target) => Promise<void>` |
| `dragTo` | `(from, to) => Promise<void>` |
| `type` | `(text, { delay? }?) => Promise<void>` |
| `press` / `keyDown` / `keyUp` | `(key) => Promise<void>` |
| `fill` | `(target, value) => Promise<void>` — clears then types |
| `scroll` | `(deltaX, deltaY) => Promise<void>` |

### Observation
| Method | Signature |
| --- | --- |
| `screenshot` | `({ fullPage? }?) => Promise<Buffer>` |
| `snapshot` | `({ diff?: boolean }?) => Promise<{ url, title, text }>` — pruned tree or ref-keyed diff |
| `evaluate<T>` | `(fn: string \| Function, ...args) => Promise<T>` |

### Tabs / wait
| Method | Signature |
| --- | --- |
| `tabs.new` | `(url?) => Promise<targetId>` |
| `tabs.switch` | `(targetId) => Promise<void>` |
| `tabs.close` | `(targetId) => Promise<void>` |
| `waitFor` | `(predicate: string \| Function, { timeout?, poll? }?) => Promise<void>` |

### Storage
| Method | Signature |
| --- | --- |
| `cookies.get` / `set` / `clear` | — |
| `localStorage.getItem` / `setItem` | `(key[, value]) => Promise<...>` |
| `sessionStorage.getItem` / `setItem` | `(key[, value]) => Promise<...>` |

## Not here (on purpose)

No full CSS selector engine, no `expect()`, no trace viewer, no video, no network
mocking. `page.locator()` intentionally supports only `[callisto-ref="ax-N"]`
ref locators; role/text/label helpers resolve against Callisto's snapshot refs.
If the agent needs more, reach for `evaluate()`.
