# Runtime parity against browse — 12 November 2026

This is a source audit of the current working tree, including uncommitted Firefox work. It does not assert that the tests named below were rerun during this audit. The separately generated benchmark is an empirical performance result, not evidence of browser capability parity.

The reference is the repository's pinned browse 0.0.16 snapshot (`3fa986601245d4f2ef9e7260f00d9f4c5a92a3b2`), rather than an assertion about the latest upstream release. [Vendor provenance](../vendor/README.md).

## Three Callisto paths, not one equivalent pair

1. **Chromium Mini isolated:** TypeScript wrapper over CDP controlling an agent-owned Chromium profile. MCP has navigation, bounded snapshot/diff/pagination, find, ref click/fill, key press, scroll, handoff (connected only), structured batch, screenshot and close. [MCP source](../packages/mini/src/mcp.ts), [engine](../packages/mini/src/index.ts).
2. **Chromium Mini connected:** creates a browse session and lets browse create a new owned tab, opens a routed CDP connection for inspection, and sends input/navigation through browse `execute` and Playwright. It is not a completely independent replacement for browse's connected execution. It requires an origin allowlist. Connected create/switch/close tab methods reject; the public MCP has no existing-tab adoption tool. [Attachment and execution](../packages/mini/src/client.ts), [connected branches and restrictions](../packages/mini/src/index.ts).
3. **Rust Firefox/Zen:** two binaries with different semantics. `callisto-firefox-mcp` is a BiDi engine able to launch isolated profiles or attach to a browser explicitly started with remote debugging. `callisto-firefox-tab-mcp` is a no-restart WebExtension DOM bridge to the existing normal browser. Benchmarks and recommendations must name which binary they mean. [BiDi MCP](../packages/firefox-rs/src/main.rs), [browser launch/attach](../packages/firefox-rs/src/browser.rs), [extension MCP](../packages/firefox-rs/src/tab_mcp.rs).

## What browse supplies

Browse exposes persistent relay/browser status, named sessions, adoption, origin allowlists, reset/delete and cleanup; composable Playwright JavaScript; frame-aware snapshots/ref locators, screenshot helpers, user handoff/demonstration, file helpers, console/network capture, protected secret typing, and recordings. This is a source-level reference surface, not proof that all upstream features work on every website. [Session tools](../vendor/browse/cli/src/mcp/session.ts), [execute tool and helper contract](../vendor/browse/cli/src/mcp/execute.ts), [browser status/settings/cleanup](../vendor/browse/cli/src/mcp/browser.ts), [network](../vendor/browse/cli/src/mcp/network.ts), [secrets](../vendor/browse/cli/src/mcp/secrets.ts), [recording](../vendor/browse/cli/src/mcp/recording.ts).

## Capability comparison

| Capability | Chromium Mini MCP | Rust Firefox BiDi MCP | Rust Firefox extension MCP |
|---|---|---|---|
| Normal existing profile without restart | Connected through browse; currently creates an owned tab | Requires browser started with debug port | Implemented via explicit extension sharing |
| Adopt an arbitrary existing tab | Not exposed; connected adapter creates its own tab | Attach selection exists for debug-enabled browser | Explicit sharing or `tab_select` after broad permission |
| One-time browser pairing | Inherited from external browse | Debug endpoint, not this pairing protocol | Persistent local relay + extension storage/retry implemented |
| Independent named agent sessions | One Mini instance per MCP; browse has underlying session ownership | One State/engine per MCP | Absent: clients share one selected tab and serialize actions |
| Input/navigation | CDP isolated; browse Playwright connected | BiDi actions | Synthetic click/fill/hover/check/select; no trusted keyboard/mouse transport |
| Page observation | AX-based compact snapshot, bounded paging/find/diff | DOM-derived BiDi snapshot with paging/find/diff | Limited DOM snapshot; separate bounded body text/find |
| Frames | Same-origin cases covered; cross-origin/transformed actionability explicitly rejected | Cross-origin/transformed frame checks also explicitly reject | No frame targeting or frame snapshot contents |
| Screenshots | MCP exposed | MCP exposed | Browser-wide action returns image after permission |
| Tabs | Isolated Mini API; connected create/switch/close rejected; MCP not browser-wide | Tab API exists; MCP surface differs from full browse session tools | Discover/create/select/close through optional browser permissions |
| Cookies/history/bookmarks/downloads | Some lower-level APIs; no equivalent browser-wide MCP tools | Cookie methods exist; not exposed as browser-wide MCP contract | Optional WebExtension tools; downloads require Save As prompt |
| Network interception/capture | Not browse's full MCP network interface | `network_recent` is an empty advisory stub | Not implemented |
| Human handoff lifecycle | Connected MCP delegates to browse | Tool explicitly returns not implemented | Not implemented |
| Arbitrary Playwright execution | Not exposed by Mini MCP; used internally for connected actions | Not implemented | Not implemented |
| Files/upload/secrets/recording | No equivalent Mini MCP helper suite | Not equivalent | Not implemented |
| Host cancellation | Abort signal wired through MCP/connected execution; tests cover cases | Requires much stronger evidence | In-flight MCP cancellation explicitly not implemented |
| Install/update/distribution | Depends on installed paired browse for connected mode | Experimental package | Temporary unsigned add-on; Unix relay; manual Flatpak copy workaround |

The table distinguishes actual MCP exposure from code that exists only in a lower-level library. In particular, advertising a method on an internal engine does not give a host agent that capability. [Mini API/MCP](../packages/mini/src/index.ts), [BiDi engine/MCP](../packages/firefox-rs/src/engine.rs), [extension browser actions](../packages/firefox-rs/extension/browser-control.js), [content actions](../packages/firefox-rs/extension/content.js), [extension limitations and tests](../packages/firefox-rs/README.md).

## Remaining work, in priority order

### Chromium/CDP

**1. Existing-tab ownership and session interface.** Add explicit adoption/select/release behavior to the Mini connected adapter if the product promise is “use the form I already opened.” Keep browse's identity check, take-back, cancellation and origin scope intact. Do not silently create a fresh tab for this workflow. Expose scoped tab/session operations through MCP. Today, `connectBrowse` calls `session_new` and `execute` to bind a fresh default page, and verifies its exact target before subsequent inputs. [Source](../packages/mini/src/client.ts).

**2. Frames and observation recovery.** Implement and test cross-origin/OOPIF and transformed-frame targeting before promising general iframe parity. Improve frame-aware refs, shadow DOM coverage, omitted-content diagnostics and screenshot fallback in real workflows. Current same-origin iframe actionability test is useful but not comprehensive frame parity. [Actionability checks](../packages/mini/src/index.ts), [tests](../packages/mini/tests/actionability.test.ts), [snapshot failures](../packages/mini/tests/snapshot-failures.test.ts).

**3. Broader agent contract.** Decide whether Mini intentionally remains a bounded structured interface, or exposes a composable execution interface. Add uploads/download completion, network/console diagnostics, secret handling and handoff/recording capabilities according to that decision. A generic execute surface should not be described as a security sandbox merely because it restricts some globals; upstream explicitly rejects that claim. [Mini tool contract](../packages/mini/src/mcp.ts), [browse execute caveat](../vendor/browse/cli/src/mcp/execute.ts).

**4. Release validation and packaging.** Run the opt-in connected tests against the supported browse version, then repeated real host-agent tasks with session reset, tab take-back, browser/extension restart and concurrent clients. Pin and package the dependency/update contract rather than implying a self-contained connected runtime. The test suite includes stop/reset, replacement identity refusal, cancellation, unrelated-session preservation and stale pagination cases, but connected tests are skipped unless `CALLISTO_BROWSE_SMOKE` is enabled. [Tests](../packages/mini/tests/browse-connected.test.ts), [vendor provenance](../vendor/README.md).

### Firefox/Zen

**1. Resolve the trusted-input architecture before claiming literal parity.** Firefox does not implement Chromium's debugger WebExtension API. The existing no-restart extension dispatches DOM events; it cannot be relabelled as trusted native input or arbitrary Playwright. BiDi can supply a different transport only for a browser with remote debugging enabled; the launcher does not retroactively enable it in a normal running browser. A privileged/remote integration and its deployment model must be chosen and demonstrated if literal parity remains a release requirement. [Mozilla compatibility documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities), [content implementation](../packages/firefox-rs/extension/content.js), [BiDi attachment](../packages/firefox-rs/src/browser.rs).

**2. Per-agent sessions, take-back and cancellation.** Replace the shared global selected tab with explicit session/target ownership. Serializing individual commands does not prevent two agents' multi-step tasks from changing each other's selection. Add request cancellation, bounded handoff with user confirmation, and cancellation tests at every awaited action boundary. [Shared relay dispatch](../packages/firefox-rs/src/tab_mcp.rs), [global selection/generation state](../packages/firefox-rs/extension/background.js).

**3. Pairing lifecycle and release-grade recovery.** Persistent endpoint/credential and automatic extension retry are implemented. Remaining work includes real signed-extension/browser restart coverage, multi-profile behavior, a usable server-side revoke/rotate command, authentication review, port conflict recovery, diagnostics and cross-platform service lifecycle. Current pairing uses a persisted loopback bearer credential; “Forget” deletes the extension's copy, while server revocation requires stopping the relay and removing its state file. It is not browse's one-time-code ECDH/HMAC token exchange. [Relay state](../packages/firefox-rs/src/tab_relay.rs), [extension pairing](../packages/firefox-rs/extension/background.js), [browse pairing reference](../vendor/browse/cli/src/relay/browser-pairing.ts).

**4. Perception and parity semantics.** Implement frame-aware/shadow-DOM observations, content pagination/diffs and stable refs across the supported target model. Normalize response semantics with Chromium: Mini click/fill returns an updated snapshot; the extension returns completion only. Snapshot/action equivalence is required before treating differences in measured latency as equal-work speedups. [Mini MCP](../packages/mini/src/mcp.ts), [extension MCP](../packages/firefox-rs/src/tab_mcp.rs), [extension content](../packages/firefox-rs/extension/content.js).

**5. Browser capability completion and boundaries.** Implement and validate keyboard input, uploads, network/console capture, handoff, controlled execution, secrets and recording where transport allows them. Distinguish tab sharing from explicit browser-wide authorization: cookies, history and all-site access are intentionally much broader than current-tab sharing. Test container identity and Zen workspaces before automatic grouping; cookie-store migration can change logins. [Permissions](../packages/firefox-rs/extension/manifest.json), [browser operations](../packages/firefox-rs/extension/browser-control.js).

**6. Distribution and installation.** Signed permanent add-on, updates, installer, Firefox/Zen platform matrix and support diagnostics remain. Temporary add-ons disappear on browser exit; saved local storage is not proof of a supported permanently installed restart experience. The current Unix-only relay imports Unix sockets/process APIs directly. Flatpak's manifest-only file chooser access caused blank UI; loading a complete copy under Downloads worked manually. Hardening extension-resource references to root-relative URLs is also prudent given Firefox's documented relative injection URL differences. [Current setup caveats](../packages/firefox-rs/README.md), [relay platform imports](../packages/firefox-rs/src/tab_relay.rs), [Mozilla resource URL guidance](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities).

## Evidence strength and release gate

- Chromium has a wider suite covering snapshots, page operations, actionability, MCP and connected lifecycle. Many browser tests are opt-in. File existence or test definition is not a current successful run.
- Firefox has Rust transport/persistence tests, mocked extension background tests and a real disposable-Firefox smoke script. That smoke script modifies its test extension to grant permissions and automatically share the fixture: it does **not** test production permission prompts, normal toolbar grants, a signed extension or the full Zen profile.
- The working-tree README records manual Zen snapshot, release and a Reddit Share-menu click. It explicitly leaves Zen form filling, broader permissions, toolbar sharing and actual browser-restart testing incomplete.

Recommended release gate: the same task assertions pass for each advertised runtime and mode; the ordinary install/pair/restart/stop path works without development tools; multi-agent ownership and cancellation are proven; observations have tested recovery; unsupported capabilities are machine-readable; timing includes the same post-action observations and validations. Publish capability- and mode-specific readiness, not one blanket “browser ready” label. [Chromium tests](../packages/mini/tests/), [Firefox tests](../packages/firefox-rs/tests/), [Firefox documented manual evidence](../packages/firefox-rs/README.md).
