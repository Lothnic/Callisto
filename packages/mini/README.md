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

| URL | Callisto chars | Callisto ~tokens | agent-browser ~tokens | Playwright MCP ~tokens |
| --- | ---: | ---: | ---: | ---: |
| https://github.com | 1,183 | 296 | TBD | TBD |
| https://linear.app | 2,881 | 721 | TBD | TBD |
| https://amazon.com | 0 | 0 | TBD | TBD |

`amazon.com` returned an empty pruned AX snapshot in this run, likely due to site
blocking or an empty accessibility tree under automation. Keep it in the table as
a visibility issue, not a success claim.

## API

Targets are `{ x, y }` coordinates or opaque string refs (`ax-N`). Refs come
from the snapshot and resolve to the element's box-model center at action time;
they are stable by DOM node, so a ref survives clicks and state changes.

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
