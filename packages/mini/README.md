# @callisto/mini

A token-lean wrapper over Chromium via the Chrome DevTools Protocol — the
agent's hands and eyes. ~20 methods, no selector engine, no locator chains, no
assertions. Design: [rfcs/0001](../../rfcs/0001-mini-playwright-surface.md).

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
import { Mini } from '@callisto/mini'

const mini = await Mini.launch({ headless: true }) // viewport pinned 1440x900
await mini.goto('https://github.com', { waitUntil: 'load' })
const png = await mini.screenshot()
await mini.click({ x: 120, y: 30 })
await mini.close()
```

## Snapshot format

`snapshot().text` is a pruned accessibility tree — `[ref] role "name" {state}
=value`, two-space indent per depth. Only interactive nodes get refs. Design:
[rfcs/0002](../../rfcs/0002-a11y-tree.md).

```
[ax-3] button "Add to Cart" {focused}
navigation "Main"
  [ax-7] link "Sign in"
[ax-12] textbox "Search" =laptop
```

Rough density (approx tokens, `chars/4`): example.com ~40, github.com ~2.8k,
news.ycombinator.com ~4.3k. Reproduce with `scripts/tokens.mjs <url…>`.

## API

Targets are `{ x, y }` coordinates or opaque string refs (`ax-N`). Refs come
from `snapshot()` and resolve to the element's box-model center at action time;
they are stable by DOM node, so a ref survives clicks and state changes.

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
| `snapshot` | `() => Promise<{ url, title, text }>` — pruned, ref-annotated a11y tree |
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

No `page.locator()`, no `expect()`, no trace viewer, no video, no network
mocking. If the agent needs it, reach for `evaluate()`.
