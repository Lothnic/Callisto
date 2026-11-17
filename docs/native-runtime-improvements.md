# Firefox/Zen runtime improvements (unreleased)

This change implements priorities 1–4 from the
[Browse comparison plan](../research/2026-11-17-browse-native-tools-and-callisto-plan.md).
The approved priority 5 screening is documented in the
[comparative report](../eval/reports/step5-2026-11-17/README.md). Update the
runtime and development extension together, stop the old persistent relay when
no task is running (`callisto-firefox-tab-mcp --stop-relay`), and reconnect the host
to start the new relay and reload its catalog. Re-share the intended tab. No new store release or benchmark win is claimed.

## One operation contract

`packages/firefox-rs/extension/operations.json` defines operation descriptions,
argument schemas and composable actions. Rust generates the named catalog,
compact help and composed-step schemas from that registry. Shared step field
schemas appear once; action-specific shapes retain required and allowed fields.
The runtime validates the entire plan before dispatching its first action.

Standalone operations and run steps now use the same names and fields:

```json
{"op":"run","args":{"steps":[
  {"action":"fill","role":"textbox","name":"Search","value":"Firefox"},
  {"action":"submit","role":"textbox","name":"Search"},
  {"action":"wait_for","selector":"main","state":"visible","timeout_ms":5000}
],"snapshot":false}}
```

Legacy `fill_ref`, `fill_role` and related suffixed actions remain accepted.
Legacy fill `text` is normalized to `value`; conflicting values are rejected.
Native form selects accept an exact option value or a unique displayed label.
Snapshots include a bounded set of enabled label/value pairs and mark truncation.

Invalid arguments return an MCP error with `structuredContent` containing
`code`, `field`, `expected` and `dispatch: "not_dispatched"`. Dynamic failures
still stop a running plan; earlier actions are not rolled back. Never replay an
uncertain write. Tool output describes dispatched actions, not proof that an
application saved the intended result.

## Host selection and composition

The default `CALLISTO_TOOL_PROFILE=auto` selects named tools when MCP
`clientInfo.name` contains `opencode` (case-insensitive). Other clients receive
the compact `callisto` interface. Set `compact`, `native` or `full` explicitly to
override this per stdio client. All profiles use the same handlers and leases;
profile selection grants no browser permissions.

Initialize replies carry instructions for the selected interface. OpenCode can
compose named operations with its Code Mode. The existing evaluation adapter
now accepts an explicit native-tool allowlist and `codeMode:true`; old trials
retain their existing defaults. `MCPClient.initialize({name,version})` records
both client identity and the native initialization result. HostSession's
`preserveInitialization:true` option preserves native instructions and rejects
a different host identity instead of silently measuring another interface.

Actual OpenCode config resolution, native/compact MCP routing, contracts and
browser operations are checked without a model call. Model-driven OpenCode
composition and comparative performance remain unmeasured because the free
provider returned HTTP 429 during the approved availability preflight. The old pilot is not silently reclassified as a
default-host experiment.

## Smaller observations and useful action outcomes

- `snapshot.focus`: `all` (default), `main`, `modal`, or `auto` (visible modal,
  otherwise main). A focused region must be unique. Use `selector` when it is
  not; selector and region focus cannot be combined.
- Focused observations retain header/navigation controls by default. Set
  `retain_navigation:false` to omit them. Output reports omitted controls and
  headings; it still carries the existing DOM/frame completeness warnings.
- Full, targeted, query and focused observations have separate diff baselines.
  Eight scopes are retained; eviction is explicit through `base_revision:null`.
  A targeted read no longer replaces the full-page baseline.
- Short numeric refs use a persistent, serialized document namespace allocation
  and a per-document counter. Namespaces are committed before injection. Refs
  cannot be reused in another document; the existing latest-snapshot and lease
  checks still apply. A document refuses more than 999,999 assigned refs.
- Actions and completed plans return bounded feedback: URL/title, document and
  DOM revision, tab/frame identity when available, and an observation hint.
  Feedback failure does not misreport a completed input as an undispatched one.
  No full snapshot is captured unless requested.
- Standalone `wait_for` uses the same bounded runtime condition as a run step.
  Read-only waits can resume after navigation within the original deadline.

## Dedicated browser facilities

| Operation | Behavior and requirements |
| --- | --- |
| `drag` | Synthetic mode dispatches HTML drag/drop events with one DataTransfer. Trusted mode performs native pointer dragging under the lease. Firefox trusted HTML5 draggable elements are explicitly unsupported after a failed native drop verification; the runtime never switches input mode silently. |
| `console` | Start/list/stop bounded BiDi console and JavaScript error capture for the selected context. Reports dropped entries and supports clearing. Requires explicitly enabled BiDi. |
| `dialog` | Start before triggering a native prompt; status exposes current and last observed prompt; accept/dismiss handles it once. Requires BiDi. A caller-owned WebDriver session should use `unhandledPromptBehavior: "ignore"`; sessions created by Callisto use that setting. Already configured sessions may auto-handle prompts. |
| `emulate` | Set/reset viewport dimensions and device pixel ratio through BiDi. Does not spoof browser identity, media preferences or network conditions. |
| `screenshot` | Viewport PNG/JPEG through the extension; full-page and rectangular clips through lease-bound BiDi. MCP returns an image plus metadata. |
| `screenshot_diff` | Per-session baseline/compare/clear for viewport PNGs. Returns exact changed-pixel counts and explicit dimension changes. Baselines expire with the lease. |
| `webmcp` | Lists/calls `document.modelContext.getTools`/`executeTool` where implemented. Returns `supported:false` when absent. Page tool calls may mutate state and are not replayed. Firefox/Zen native API availability is not claimed. |
| `recording` | Bounded semantic recording of trusted human clicks, inputs, changes and selected keys. Password values are redacted; synthetic agent events and the confirmation banner are omitted. Document-local, not video. |
| `demonstrate` | Start a human interaction recording, show the handoff banner, and return the recording after trusted confirmation. Cancellation/revocation stops capture. No automatic replay. |
| `browser` named tabs | `tab_name` associates `tab_name` with `tab_id`; `tab_resolve` retrieves it. Select/activate/close accept the name. Local mappings are verified against an extension-owned per-tab sessions token, preventing stale browser IDs from selecting another tab. Closed handles are removed. |

Named tabs add the optional Firefox `sessions` permission to browser access.
Approve the updated **Enable browser access** grant to use them. This is separate
from host tool-profile selection and from Full browser control. Browser-protected
pages and existing input-mode restrictions still apply.

Console/prompt subscriptions are context-scoped and bounded. Lease invalidation
stops observers and clears session captures. Screenshots and WebMCP calls use the
same extension-proven document binding as trusted input; they never choose a
context merely because its URL matches.

## Verification

Correctness checks use local fixtures and owned disposable profiles, with no
personal browser profile or model/provider calls:

```sh
cargo test --locked --manifest-path packages/firefox-rs/Cargo.toml
cargo build --locked --manifest-path packages/firefox-rs/Cargo.toml --bin callisto-firefox-tab-mcp
node --test scripts/compact-tools.test.mjs eval/agent-comparison/host-session.test.mjs
node --test eval/agent-comparison/opencode-host.test.mjs
node packages/firefox-rs/tests/extension-content.mjs
node packages/firefox-rs/tests/extension-ui.mjs
CALLISTO_TEST_BROWSER=firefox node packages/firefox-rs/tests/native-improvements.mjs
CALLISTO_TEST_BROWSER=zen node packages/firefox-rs/tests/native-improvements.mjs
```

The new live suite passed in Firefox 157.0.1 and Zen 1.14.9b, covering rejected
plans without partial writes, canonical/legacy inputs, label selection, focused
and independent diffs, refs across navigation, synthetic HTML dragging, trusted
pointer dragging, redacted human recording and confirmation, named tabs, real
console logs, viewport/screenshot pixel changes, prompts and lease revocation.
WebMCP checks cover both absent support and a page-provided fixture implementation;
they do not certify native browser WebMCP support.

OpenCode config resolution is a setup check. Engineering correctness alone
does not establish a comparative win. See the separate
[screening report](../eval/reports/step5-2026-11-17/README.md) for measured
Luna outcomes, regressions, usage and limits.

Protocol references: [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/) and
[WebMCP draft](https://webmachinelearning.github.io/webmcp/).
