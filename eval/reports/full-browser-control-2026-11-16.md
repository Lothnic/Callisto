# Full browser control — 16 November 2026

Source revision `70f3eef9f20198ec0e14f5432c06b6757b1d284a` introduces extension
0.3.0 and runtime 0.3.0-alpha.1. The user can grant Full browser control from
the popup or settings. It removes the per-page Share step for paired agents,
while browser-protected pages and unavailable Zen workspace IDs remain outside
the extension's reach.

Saved assertion results: [Firefox 157.0.1](full-browser-control-2026-11-16/firefox.json)
and [Zen 1.14.9b](full-browser-control-2026-11-16/zen.json).

## Verification

- 65 extension, network, installer, diagnostics and host-transport contract tests
  passed. Six real launcher contract tests passed separately, for 71 total.
- Both Rust suites passed: 5 standalone tests and 28 bridge tests.
- The real disposable Firefox smoke passed. Its added full-mode assertions cover
  active-page adoption, automatic sharing after creating a website tab,
  activation-only behavior, showing and selecting a hidden tab, blank-tab
  creation and navigation by ID, listing windows, disabling mode and refusal
  to automatically attach after disable. The pre-existing native-input, frame,
  network, cancellation, trace and recovery checks also passed.
- A separate headful Zen 1.14.9b check passed on a private Xvfb/X11 display.
  It verified the same tab and window lifecycle, hidden-tab activation and
  native input on a newly created tab. The dedicated runner is
  `eval/agent-comparison/full-browser-control.mjs`; the Firefox variant also runs
  in CI with `CALLISTO_TEST_BROWSER=firefox`.
- Unit fixtures additionally cover pinned tabs, minimized-window restoration,
  transfer from another agent session, protected-page activation without a false
  sharing result, permission removal and disconnect. Stop races during permission
  lookup, badge updates and automatic injection cannot leave full mode enabled.
- The rendered popup checks passed at a narrow viewport and 2× zoom, including
  permission denial, toggle behavior and cancellation of a pending grant. The
  Impeccable mechanical detector returned no findings. The touched Rust file
  passed its scoped formatting check.

The Firefox fixture pregrants its test permissions and enables the mode through
a fixture-only hook. The shipped extension has no tool action that enables it;
the user must use its UI. Browser permission-prompt text is not certified by
the fixture. The UI checks simulate granted and denied permission responses.

The browser assertions ran in disposable Firefox and Zen profiles on Linux.
Zen workspace enumeration, private-window permissions and other platforms
require separate checks. No personal tabs were used in these
tests. The 0.3.0 extension still needs submission to the existing Mozilla listing.

See [usage and limits](../../docs/full-browser-control.md).
