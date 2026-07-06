# RFC 0001 — Mini Playwright surface

- **Status:** Accepted
- **Phase:** 1
- **Author:** Lothnic

## Summary

Define the method surface of `@callisto/mini`: a thin, agent-friendly wrapper
over Chromium via the Chrome DevTools Protocol (CDP). The goal is ~15–20
methods describable in <2K tokens, versus raw Playwright's ~13K.

## Motivation

Every token the wrapper's description burns is a token the agent cannot spend
reasoning, and every method is a thing the LLM must learn. Playwright is built
for human test authors: locator chains, auto-waiting, assertions, tracing. An
agent needs none of that. It needs to *see* (snapshot/screenshot) and *act*
(click/type/navigate) over a small, predictable surface.

## Design

### CDP client

Use [`chrome-remote-interface`](https://github.com/cyrus-and/chrome-remote-interface):
tiny, well-typed, direct CDP access. Add `puppeteer-core` only if something is
impractical to do directly. We launch Chromium ourselves with
`--remote-debugging-port`.

### The surface

All methods are `async` and typed. Grouped:

**Lifecycle**
- `launch({ headless?, viewport?, userAgent? })` — default viewport pinned to
  **1440×900** (Aside's lesson: pin it, models are trained on that shape).
- `close()`
- `pages()` — list open targets/tabs.

**Navigation**
- `goto(url, { waitUntil? })`
- `back()`, `forward()`, `reload()`

**Interaction**
- `click(ref | { x, y }, opts?)`, `dblclick`, `rightclick`, `hover`, `dragTo(from, to)`
- `type(text, { delay? })`, `press(key)`, `keyDown(key)`, `keyUp(key)`
- `fill(ref, value)` — clears the field first, then types.
- `scroll(deltaX, deltaY)`

**Observation**
- `screenshot(opts?)` → `Buffer`
- `snapshot()` → custom a11y tree. **Stub in Phase 1**, full impl in Phase 2.
- `evaluate<T>(fn, ...args)` → typed result.

**Tabs / wait**
- `tabs.new(url?) / switch / close`
- `waitFor(predicate, { timeout?, poll? })`

**Storage**
- `cookies.get / set / clear`
- `localStorage.getItem / setItem`, `sessionStorage` similarly.

### Refs

Interaction targets are opaque string refs (e.g. `ax-42`) produced by
`snapshot()`, or raw `{ x, y }` coordinates. No CSS selectors, no locator
chains. Ref allocation and cross-re-render stability are owned by the a11y-tree
work in Phase 2; Phase 1 ships a coordinate path and a stubbed ref path.

## Non-goals (skipped ruthlessly)

No selector engine, no `page.locator()`, no `expect()`, no trace viewer, no
video, no network mocking. If the agent needs it, it can `evaluate()`.

## Open questions

- Ref stability heuristics across re-renders (deferred to Phase 2 / RFC 0002).
- Multi-frame ref addressing (`iframeId`) — designed in Phase 2.
