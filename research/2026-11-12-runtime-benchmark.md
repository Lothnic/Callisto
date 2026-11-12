# Chromium/CDP versus Rust/Firefox — 12 November 2026

## Decision

Do not choose Rust on the assumption that it makes the current existing-browser product faster overall. Its current extension relay wins observation microbenchmarks, but the form workflow is slower. The separate Rust BiDi experiment wins many warm tasks, while small navigation and first browser launch are slower. Browser engines, transport, snapshots and waiting policies differ, so these measurements do not isolate language performance.

## What was measured

Two separate comparisons against Chromium/TypeScript/CDP: (1) Rust/Firefox BiDi in an isolated profile, and (2) Rust/Firefox extension plus persistent relay in a disposable Firefox profile. The latter is the architecture used for normal existing Zen tabs, but this run uses Firefox, not Zen, and a test copy of the extension with permissions pre-granted. It does not measure the one-time UI permission flow, a real daily profile, authenticated workflows, browse itself, or host-LLM task success.

Release Rust binaries; built TypeScript; Node v26.5.0; Chromium 157.0.8103.38 snap; Mozilla Firefox 157.0.1. Source revision 5ef431f1204ba38a8ea34f010568c75c509c96c1 with current uncommitted runtime changes. Twelve warm trials per supported operation, alternating engine order on each trial. Local HTTP fixtures have 30 or 1,000 buttons and associated text; both contain a named form, a password and a result heading. Browser creation and initial navigation are excluded from warm measurements. One cold navigation sample per native engine is reported separately, not a startup distribution.

The extension form adapter explicitly adds a snapshot after fill and after click to match Mini’s action response work. Its navigation includes readiness polling and an updated snapshot. The extension has no batch tool; the missing row is unsupported, not a zero-latency result.

## Warm medians (milliseconds)

### Current extension relay

| Task | Chromium | Rust/Firefox | Chromium ÷ Rust | Successful trials per engine |
|---|---:|---:|---:|---|
| navigate_small | 26.07 | 42.63 | 0.61× | 12/12 · 12/12 |
| snapshot_small | 7.91 | 2.66 | 2.98× | 12/12 · 12/12 |
| find_small | 7.33 | 2.13 | 3.44× | 12/12 · 12/12 |
| form_fill_click_snapshot | 135.01 | 163.85 | 0.82× | 12/12 · 12/12 |
| navigate_large | 187.56 | 54.23 | 3.46× | 12/12 · 12/12 |
| snapshot_large | 126.29 | 7.84 | 16.11× | 12/12 · 12/12 |
| find_large | 129.45 | 2.89 | 44.87× | 12/12 · 12/12 |
| ping_100 | 13.23 | 9.60 | 1.38× | 12/12 · 12/12 |

A ratio above 1 means the Firefox stack was faster for this operation. `ping_100` measures 100 sequential MCP pings without browser work, not one ping.

### Separate BiDi experiment

| Task | Chromium | Rust/Firefox | Chromium ÷ Rust | Successful trials per engine |
|---|---:|---:|---:|---|
| navigate_small | 27.98 | 64.30 | 0.44× | 12/12 · 12/12 |
| snapshot_small | 7.54 | 3.61 | 2.09× | 12/12 · 12/12 |
| find_small | 6.74 | 3.10 | 2.18× | 12/12 · 12/12 |
| form_fill_click_snapshot | 133.51 | 68.29 | 1.96× | 12/12 · 12/12 |
| batch_form | 143.24 | 62.51 | 2.29× | 12/12 · 12/12 |
| navigate_large | 191.34 | 109.17 | 1.75× | 12/12 · 12/12 |
| snapshot_large | 134.09 | 61.18 | 2.19× | 12/12 · 12/12 |
| find_large | 130.40 | 23.64 | 5.52× | 12/12 · 12/12 |
| ping_100 | 9.40 | 7.50 | 1.25× | 12/12 · 12/12 |

A ratio above 1 means the Firefox stack was faster for this operation. `ping_100` measures 100 sequential MCP pings without browser work, not one ping.

## Limits that affect interpretation

- Chromium snapshots use `Accessibility.getFullAXTree` and frame enumeration. The BiDi runtime walks the DOM in page JavaScript. The extension scans a subset of roles and controls, capped at 400 elements and 12,000 characters, without frame traversal. These are not equal observations. Large-page extension snapshots perform less work and omit more content; its speed advantage is not evidence of superior complete-page perception.
- Extension text find reads visible body text directly. Native Mini find captures and searches its accessibility representation. The same search term passing does not establish equal semantic coverage.
- Mini actionability polls at 50 ms, BiDi at 16 ms, and extension actions wait 75 ms. Two action checks alone can explain a substantial portion of the form timing differences. These policies must be equalized before attributing gains to Rust.
- This is one machine and a small sample; p95 values in the JSON/canvas are descriptive, not stable tail estimates. Operating-system cache, background load and browser-specific behavior remain confounders. The two reports are separate runs with their own Chromium baseline.
- All checks passed, but checks cover expected form output, text lookup, password redaction and transport completion. They do not test overlays, moving targets, cross-origin frames, signed installation, cancellation, handoff, browser restart, complex web applications or long tasks.
- Server-process startup handshakes were single samples: Chromium 222.1 ms; Rust BiDi 5.2 ms. First navigation including browser launch: Chromium 727.6 ms; Rust Firefox 2847.4 ms. The faster Rust MCP handshake does not translate into faster first-browser use here.

## Remaining work against browse

The [source audit](2026-11-12-runtime-parity-gaps.md) separates Chromium isolated/connected, Firefox BiDi and Firefox extension behavior. Priorities:

1. Chromium: adopt the existing tab instead of always creating a session-owned browse tab; expose per-agent session/tab ownership; complete cross-origin/transformed-frame behavior; harden recovery/distribution and prove repeated real host-agent workflows. Connected input/navigation currently runs through browse’s Playwright execution, so it is not a fully independent Mini connected backend.
2. Firefox: resolve trusted-input/Playwright transport before promising literal parity; add independent agent sessions, cancellation and human handoff; improve full text/ARIA/frame perception; production-grade pairing/revocation, signed extension distribution and real Zen restart proof. The persistent relay is implemented, but all MCP clients share a controlled tab and its bearer authentication is simpler than browse’s challenge/token protocol.
3. Shared benchmark gate: equalize observation coverage and actionability semantics, then compare completion rates and wall time on realistic host-agent tasks. Preserve correctness before reducing waits.

## Reproduce

Build `packages/mini` with `npm run build` and both Rust binaries with `cargo build --locked --release`. The scripts launch disposable browsers; they do not use the daily browser profile or a model API.

```sh
node eval/agent-comparison/chromium-vs-firefox.mjs
# Separate terminal: start a test geckodriver on 127.0.0.1:53851.
# For Snap Firefox use --profile-root "$HOME/snap/firefox/common".
BENCH_FIREFOX_MODE=extension GECKODRIVER_URL=http://127.0.0.1:53851 node eval/agent-comparison/chromium-vs-firefox.mjs
```

The extension fixture installer installs a temporary test-only copy and pre-grants its optional permissions; its cleanup deletes the disposable WebDriver session and stops/removes the test relay. Stop your test geckodriver after the run.

## Evidence

- [BiDi raw results](2026-11-12-chromium-vs-rust-firefox.json), [extension raw results](2026-11-12-chromium-vs-rust-extension.json): all per-trial timings, summaries, versions, errors and timestamps.
- [Benchmark runner](../eval/agent-comparison/chromium-vs-firefox.mjs), [Firefox fixture setup](../eval/agent-comparison/firefox-extension-fixture.mjs).
- [Chromium snapshot](../packages/mini/src/snapshot.ts), [Chromium actionability](../packages/mini/src/index.ts), [Rust BiDi snapshot](../packages/firefox-rs/src/snapshot.rs), [Rust BiDi actionability](../packages/firefox-rs/src/engine.rs), [extension observation/action code](../packages/firefox-rs/extension/content.js).

## Subsequent implementation changes

These measurements predate the [search and window refinements](2026-11-12-zen-search-refinement.md), which added extension batching, form submission and earlier DOM readiness. The raw measurements remain unchanged and must not be presented as post-refinement performance.
