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

## Usage

```ts
import { Mini } from '@callisto/mini'

const mini = await Mini.launch({ headless: true }) // viewport pinned 1440x900
await mini.goto('https://github.com', { waitUntil: 'load' })
const png = await mini.screenshot()
await mini.click({ x: 120, y: 30 })
await mini.close()
```

## API

Targets are `{ x, y }` coordinates or opaque string refs. Refs come from
`snapshot()` and land in **Phase 2**; until then use coordinates.

### Lifecycle
| Method | Signature |
| --- | --- |
| `Mini.launch` | `(opts?: { headless?, viewport?, userAgent? }) => Promise<Mini>` |
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
| `fill` | `(ref, value) => Promise<void>` — clears then types *(needs Phase 2 refs)* |
| `scroll` | `(deltaX, deltaY) => Promise<void>` |

### Observation
| Method | Signature |
| --- | --- |
| `screenshot` | `({ fullPage? }?) => Promise<Buffer>` |
| `snapshot` | `() => Promise<{ url, title, text }>` — `text` empty until Phase 2 |
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
