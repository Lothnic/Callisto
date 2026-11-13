# Backend parity and input reliability: implementation plan

Status: proposed; no implementation implied. Scope: Chromium Mini (isolated,
attached and browse-connected modes) and the Firefox/Zen extension bridge.
Preserve the user's existing profile, tabs, containers and logins when adopting
an existing tab. Do not claim identical internals, universal trusted input or
bot-protection bypass.

## 1. Baseline and contract

- Inventory every MCP tool, argument, result, error and mode-specific behavior;
  record known unsupported operations and pin dependency/browser versions.
- Specify a versioned common contract for capabilities, session/tab ownership,
  snapshots and refs, navigation, input, screenshots, cancellation and handoff.
  Include an explicit compatibility/migration period for existing clients.
- Separate browser engine, connection mode, input mechanism, trust level and
  observed limitations in capabilities. An unsupported operation must fail
  with a machine-readable code, not silently change semantics.
- Build a shared fixture server and backend adapters so the same assertions run
  through MCP against each advertised mode. Test controlled inputs, overlays,
  moving and disabled elements, frames, open shadow roots and navigation. Check
  actual DOM state and event sequences, not just tool success.
- Add Linux Chromium and Firefox real-browser PR jobs, then headful/Xvfb and
  supported OS coverage. Browse-connected runs separately with pinned versions;
  existing-profile/manual restart checks cannot be replaced by headless CI.

Gate: contract fixtures pass or have explicit tracked unsupported results for
all modes; no unrecorded differences; CI fails on regressions.

## 2. Existing tabs, ownership and recovery

- Normalize list/select/adopt/release, ownership leases, cancellation and
  human handoff. Identify browser/profile/window/tab separately; refs belong to
  a session, tab and document generation. Never steal an owned tab.
- Define what happens on navigation, browser/extension restart, disconnected
  clients, stale leases, concurrent operations and partial batches. Preserve
  the user's tab on close/release. Verify take-back and reacquisition.
- Keep Zen containers opt-in for newly created tabs: an isolated container has
  different cookies and will not automatically contain the user's logins.
- Research a Chromium extension-backed path for one-time pairing and lending
  existing tabs. Existing CDP mode requires a debugging-enabled browser;
  browse-connected mode has its own feature limits. Evaluate sessions and a
  daemon only after ownership requirements and lifecycle tests are in place.

Gate: two independent clients, same-tab conflict, disconnect/reconnect and
handoff tests pass; a real existing logged-in tab survives release and restart.

## 3. Input fidelity and action parity

- Establish local event probes for mouse, key, input/change and composition:
  record isTrusted, ordering, focus, default actions and final form state.
  Test native select/check, controlled inputs, contenteditable and shortcuts.
- Expose action-specific input mechanism and observed fidelity. Add structured
  errors for unsupported or unverified behavior; never silently fall back from
  trusted to synthetic input when a task requires trusted events.
- Chromium: verify CDP mouse/key dispatch and fill/insertText separately in all
  modes, including attached and extension-backed connections. Bring upload,
  selection, waits and diagnostics into the common contract only as supported.
- Zen: retain extension-based existing-tab adoption and DOM perception. Run a
  bounded feasibility spike for WebDriver/Marionette/BiDi against the user's
  existing profile, using a test profile first. Determine launch/enablement,
  session creation, window mapping, event fidelity, tab preservation, browser
  compatibility and cleanup; measure whether a restart is required. Treat
  enabling an unauthenticated remote control endpoint as a sensitive opt-in.
- Evaluate an OS input adapter only as a separate explicit opt-in experiment:
  test OS permissions, focus, screen coordinates, interruptibility, Wayland/X11,
  macOS and Windows, plus accessibility and background-tab limitations. Never
  assume OS input provides background control or is undetectable.
- If neither route meets the existing-profile requirement, keep synthetic input
  explicitly labelled and offer human handoff; do not market trusted Zen input.

Gate: automated event probe plus real-site user-authorized workflows document
what works; mode-specific limitations are reflected in capability responses.

## 4. Reliability and controls

- Add select/check/upload/download/dialog/wait semantics, same-origin frames,
  shadow traversal and stale-ref recovery by frequency of use. Investigate
  cross-origin frames separately for each transport and preserve fail-closed
  actionability where hit testing cannot be verified.
- Define structured errors (including stale refs, blocked targets, disconnection,
  cancellation and policy denial), optional bounded redacted traces and doctor.
- Apply read-only and origin restrictions consistently where enforceable;
  make scope and enforcement limits explicit. Add an explicit human handoff
  and host confirmation mechanism, without pretending destructive actions can
  always be recognized automatically. Avoid recording secrets in traces.

Gate: fixtures cover success, negative and recovery paths; policies cannot be
bypassed via alternate tools in modes where they are advertised.

## 5. Installation and release

- One launcher selects backend and registers an MCP host; pair once and provide
  clear status, stop and recovery controls. Package Rust and pinned dependencies
  with checksums, diagnostics and supported-platform reporting.
- Prepare Mozilla signing and distribution; actual durable extension release
  requires signing credentials and a published signed add-on. Test restart,
  upgrade and rollback on real browsers and machines before claiming durability.

Gate: a new user can install, pair, adopt a tab, restart, reconnect and remove
Callisto using published artifacts without a development checkout.

## 6. Evaluation and release gate

- Freeze versions and run identical fixed tasks with a single host/model across
  Callisto modes, browse and agent-browser. Include clean-profile and authorized
  existing-login cohorts where supported. Separate startup, warm action and
  post-action observation times; repeat and report successes, failures, turns,
  tokens, latency distributions and environment. Publish scripts and raw data
  without session secrets. Distinguish scripted reliability from agent success.
- Include local trusted-event controls and authorized real-site challenge rates;
  classify authentication, challenge, navigation and interaction failures.
  Stop for human completion when a site requires verification. No guaranteed
  CAPTCHA or bot-block evasion is a release criterion.
- Require contract conformance, ownership isolation, safety-policy tests,
  reliable take-back, documented accessibility/input gaps, restart/upgrade
  checks and reproducible benchmark results. Publish readiness per mode.

Dependencies: phases 1 and 2 precede action expansion; phase 3's Zen spike can
run alongside phase 2. Phase 5 signing preparation can run early, but publishing
is gated by external Mozilla access. No blanket 1.0 claim until each advertised
mode meets its own criteria.
