# Zen search and agent-window refinement — 12 November 2026

## Changes

- Separated navigation generations from sharing ownership. A successful content
  action followed by navigation no longer reports user revocation. A real stop,
  tab ownership change or connection change still fails closed. An interrupted
  content-message channel remains an explicitly uncertain outcome.
- Added `callisto_submit` using browser form validation and `requestSubmit`.
  This allows submitting through a search-input ref when its submit icon is
  absent from the snapshot. This is not trusted keyboard emulation.
- Added `callisto_batch`: up to ten structured actions and one final snapshot,
  with a ten-second deadline and ownership checks between steps. Role locators
  wait briefly for missing controls and reject ambiguous matches.
- Reattach at DOMContentLoaded instead of waiting exclusively for window load.
  Requests arriving during navigation wait for page readiness, avoiding separate
  host status-polling turns. The fixed 75 ms stability check was preserved.
- Include current input-combobox values and submit-input labels in snapshots.
- Mark controlled tab titles `[Callisto]` and restore them on release, including
  when the site changes its title during control.
- Added optional Callisto cookie-container creation/reuse for explicitly new
  tabs/windows. Normal creation inherits the selected tab's cookie store.
- Added labelled agent windows, control scoped to the selected window's active
  tab, initial about:blank attachment retries and whole-window cleanup.

## Validation

`node --test packages/firefox-rs/tests/extension-background.test.cjs` reproduces
and fixes the exact successful-navigation-as-revocation bug, checks actual
revocation, early DOM readiness, cross-window targeting, initial-load retries,
batch ownership and saved pairing.

`node packages/firefox-rs/tests/extension-content.mjs` verifies filling, disabled
controls, password redaction, validated form submission, combobox values and
controlled-title restoration in a disposable Chromium DOM fixture.

`tests/firefox-bridge-smoke.py` verifies the real Firefox extension/Rust relay:
search navigation → fill → form submission → resulting snapshot in one batch;
container creation/reuse; cookie-store inheritance; agent window creation,
selection and whole-window closing; title marking/release; prior browser and
reconnection checks. Its search fixture includes an image delayed five seconds.
Recent complete runs reached the search result in roughly 0.3 seconds, before
that image completed. This proves the early-readiness condition locally; it is
not a measured speedup for Internet search or a controlled before/after trial.

## Live Zen observations and remaining validation

The user reloaded the temporary extension twice and the saved pairing
reconnected without entering a code. The retest of the old personal tab stopped
when the user switched tabs, as intended. A temporary agent-window retest then
failed because Zen returned an initial about:blank tab before its requested URL
was available for extension injection.

Zen also mirrored pinned tabs into each new window. Closing the newly created
non-pinned test tab did not close that window. The user closed the two temporary
labelled windows; individual pinned tabs were not removed by the agent.

These observations produced the initial-load retry, per-window target selection
and whole-window cleanup changes. Those final changes pass the automated
Firefox/regression tests but have **not** yet passed a repeat live Zen test.
Do not report the real DuckDuckGo workflow as cleanly fixed until that happens.
No isolated agent container was created in the user's real profile; the
container/window feature tests used disposable Firefox profiles.

## Container semantics

The normal existing-tab path preserves the existing cookie store and logins.
The isolated Callisto container is opt-in and requires optional permissions;
it intentionally has separate cookies. It is not a Zen workspace/folder API.

References: [form submission](https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/requestSubmit),
[DOM readiness](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webNavigation/onDOMContentLoaded),
[containers](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Work_with_contextual_identities),
[window creation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/create).
