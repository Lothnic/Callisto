# Changelog

## Unreleased

### Firefox and Zen runtime

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
  distribution and controlled browse time/cost comparisons remain deferred.

### Product

- **RFC 0006 — Callisto Browser (BrowserOS fork)** accepted: browser-first distribution
  on a Callisto-branded BrowserOS base (AGPL package boundary documented).
- New package `packages/callisto-browser/`: upstream sync, branding stubs, Linux build
  wrappers, stealth/ports docs. Mini/`run.sh` prefer `CALLISTO_BROWSER_PATH`.

