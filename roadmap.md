# Callisto runtime roadmap

Callisto is a lean browser runtime for existing agents. The MCP interface and
`@callisto/mini` are the product; the Python harness and evaluation tools help
develop and measure it. This is a working plan, not a claim of Playwright or
browse parity. The [original phased roadmap](docs/history/roadmap-2026.md) is
preserved for historical context.

## 1. Correctness and usable perception

- Support actions in same-origin frames and fail explicitly for cross-origin or
  otherwise inaccessible frames; expand frame coverage with regression tests.
- Bound MCP snapshots, provide continuation and targeted text search, and
  measure whether the agent can find task-relevant content. Pagination offsets
  refer to the last captured snapshot and refs can become stale as pages change.
- Strengthen actionability checks, timeouts, input handling, stale refs and
  browser cleanup. Compare their behavior with Playwright on controlled pages.
- Avoid claiming an action or security guarantee until the corresponding
  behavior is tested.

## 2. Host-agent interface

- Maintain the local stdio MCP server and test it from a real MCP client.
- Provide composable structured actions, informative errors and clear partial
  failure semantics. Evaluate a Playwright-shaped JavaScript surface separately;
  the current MCP server intentionally does not expose arbitrary host code.
- Improve packaging, setup, screenshots, navigation and multi-tab behavior.
- Extend and test the connected-browser bridge's execution lifecycle, including
  toolbar stop and take-back, focus, and broader human handoff. Connected
  navigation and input use the installed browse executor; session reset
  interruption, tab identity checks, handoff timeout and cancellation, and one
  human-confirmed fixture handoff have coverage, while toolbar take-back and
  reconnect recovery need further testing.

## 3. Evidence

- Run local controlled scenarios and separately reported live-site tasks against
  browse and Playwright. Record versions, settings, per-task outcomes and
  failures; do not infer agent success or cost from scripted MCP timings.
- Compare native snapshots for information coverage as well as size. Repeat
  trials and include authenticated workflows only when deliberately configured.
- Measure agent outcomes with the same host harness and model once the host
  integration is ready for matched tasks. A separate model API is not required
  to use the runtime.

## Decisions still open

The custom CDP engine is a hypothesis. If an equally lean agent interface over
Playwright proves more reliable at similar cost, use that evidence to choose the
backend. The BrowserOS fork under `packages/callisto-browser` remains a historical
experiment outside the runtime's critical path, with its own AGPL license and
notices; do not redistribute its outputs as if they were MIT-only.

## Before a 1.0 release

The connected runtime needs tested execution ownership and cancellation,
foreground and background input, user takeover and broader handoff coverage,
tab and frame recovery, and reliable cleanup after disconnects. Its shipped relay and
extension, upgrade path, dependency licenses, and supported platforms also need
to be settled. Repeated host-agent comparisons and a security review are release
gates; local fixture tests alone do not establish production readiness. See the
[connected runtime plan](research/2026-11-connected-runtime-next-steps.md) for
the proposed sequence.

A second Gecko backend for Firefox and Zen is a candidate for launch in isolated
owned-browser mode. Full connected takeover, handoff, and attach-to-daily-profile
behavior remain post-launch work. See the
[future work note](future.md#part-2--firefox-and-gecko-compatibility) for the
market scan and the [Firefox roadmap](future.md#part-4--firefox-implementation-roadmap)
for the phased plan.

A Rust rewrite is not planned before launch. The [Rust review](future.md#part-3--rust-feasibility)
found that the measured speed gap comes from bypassing Playwright, which
Callisto already does, and that the Firefox ecosystem is more mature in
TypeScript. Distribution friction should be solved with a lean binary build
before considering a rewrite.
