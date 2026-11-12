# Connected runtime: next additions

Status: active development. The experimental Mini bridge uses the installed browse relay and creates its own tab. Navigation and input use browse's execution lifecycle, and a session reset interrupts in-flight execution. Handoff is exposed through MCP, with timeout and cancellation tested and one human-confirmed local fixture handoff through the Mini API. Toolbar take-back, reconnect recovery and broader background-input behavior still need end-to-end tests.

Initial reliability work invalidates cached snapshots after actions and search,
reports incomplete frame capture, checks both ends before starting a drag, and
cleans up Enter navigation listeners. The current connected action path delegates
to browse's Patchright-backed executor and is not a Mini-only execution lease;
these changes do not make the runtime ready for production.

1. **Execution and control.** Design a relay-supported Mini execution lease around each operation, reusing browse's session ownership, focus, active-state presentation, cancellation and handoff. Make take-back interrupt pending work and prevent subsequent input until control is returned. Define timeout and disconnect behavior before implementing; do not emulate focus outside the relay lifecycle.
2. **Live browser workflows.** Test click, fill, keyboard, navigation and verification on foreground and background tabs, with moving, disabled and covered targets. Exercise stop, handoff, reconnect, cleanup and simultaneous sessions in an isolated paired test profile before using real accounts. Include failure and cancellation assertions.
3. **Tab and frame ownership.** Design explicit consent for lending existing tabs, then implement controlled selection, return and cleanup without closing the user's tabs. Add same-origin, cross-origin and transformed-frame fixtures and cover navigation, popups, downloads, stale references and browser restarts.
4. **Owned distribution.** Decide which vendored relay and extension components Callisto will ship. Remove or replace Patchright only where tests demonstrate equivalent behavior; track upstream fixes, retain notices, audit dependencies and verify build and installer support. Add pairing, diagnostics and recovery. The snapshot is not currently the active runtime.
5. **Agent interface and evaluation.** Compare structured MCP actions with browse's composable interface on repeatable, authorized end-to-end tasks. Measure completion, errors, time, turns and context under identical conditions, including authenticated workflows. Keep fixture microbenchmarks separate from real-agent results.
6. **Release readiness.** Perform security and privacy review, accessibility and cross-platform testing, installation/upgrade tests and soak tests. Document supported browser versions and constraints. Revisit Firefox only after the Chromium lifecycle and product experience are reliable; its transport and extension APIs require separate investigation.

Each phase should land with tests and an explicit scope statement. No phase implies that Callisto is production-ready until its acceptance tests and review pass.
