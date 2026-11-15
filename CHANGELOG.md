# Changelog

## Unreleased

### Firefox and Zen runtime

- Add explicit background-window preparation, start-on-return, Pause, View and
  Take back under the shared-tab lease. Preserve the exact tab and document;
  refuse focus-changing agent operations. Initial user preparation may take focus.
- Verify a one-minute headful Zen X11 run alongside OS typing and media, with
  saved action traces and a disclosed high-rate typing control failure. Other
  desktops, inactive tabs and minimized windows remain unverified.

- Add request comparison, observed pagination/schema hints, draft OpenAPI export
  and explicit same-origin GET/HEAD replay using the shared page's session.
- Add optional trusted BiDi input under extension tab ownership and Stop sharing,
  including forms, runs, batches and extraction pagination.
- Preserve trusted mode across failures, invalidate revoked bindings and avoid
  replaying uncertain writes during recovery.
- Capture stable snapshot revisions and continuation, generic text and compact
  diffs with explicit changed-order and capture-limit metadata.
- Retain failed-action checkpoints and interrupted outcomes; inspect incomplete
  captures and enforce explicit benchmark field/screenshot requirements.
- Validate disposable Firefox and Zen workflows and real HAR parsing. Extension
  distribution remains unsigned; a signed-in host now drives the local matched pilot.

### Host-agent evaluation

- Drive browser tasks through the installed, signed-in Codex host connected over
  native MCP tools. The host owns the model and conversation loop; the runtime
  needs no separate model API key.
- Retain host-reported usage, visible tool events and task-state checks. Leave
  subscription dollar charges unavailable when the host does not supply them.
- Reacquire the exact fixture tab and native input lease after navigation;
  WebDriver navigation alone does not establish the extension's active-tab lease.
  Add a Zen/Firefox regression without weakening runtime visibility checks.

### Alpha preparation and diagnostics

- Prepare a Linux x64 `v0.2.0-alpha.1` bundle with checksums, a local-directory
  installer and read-only `doctor` diagnostics. This build requires glibc 2.39.
- Validate persistent test profiles across cancellation, relay loss, extension
  updates, browser restart and lost tabs; Zen also covers a forced crash.
- Record real observation bytes and runtime measurements separately from model
  tokens and cost. Retain the failed provider preflight without scoring it as
  agent failure or reporting a browse comparison.
- Refine extension connection, permissions and recovery screens, including
  keyboard focus, explicit permission requests and layout at 200% zoom.

### Product

- **RFC 0006 — Callisto Browser (BrowserOS fork)** accepted: browser-first distribution
  on a Callisto-branded BrowserOS base (AGPL package boundary documented).
- New package `packages/callisto-browser/`: upstream sync, branding stubs, Linux build
  wrappers, stealth/ports docs. Mini/`run.sh` prefer `CALLISTO_BROWSER_PATH`.

