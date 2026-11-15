# Background agent work: Zen first

Status: 15 November 2026. The first Zen agent-window slice is implemented in
source with explicit user preparation; see [usage and verification](background-work.md).
Inactive-tab and persistent-worker phases below remain proposed.

## Product contract

A person can keep watching a video, typing, or using another application while
Callisto completes a form in its own authorized tab. Automation must not select
the person's tab, raise its own window, redirect human keystrokes, or use the
physical mouse/keyboard as its normal input path. Bringing agent work to the
foreground is an explicit user action.

Foreground-only task success is insufficient. Background execution and human
input isolation become release criteria ahead of further benchmark tuning.

## Findings in the current source

- `extension/background.js` requires the shared tab to be active in its own
  window before snapshots, navigation and page/input commands. Sharing also
  initially requires an active tab. A different focused window is already
  distinct from this per-window active-tab requirement.
- `extension/content.js` rejects actionable input when the document's
  `visibilityState` is not `visible`, including the DOM input path.
- `extension/browser-control.js` explicitly raises the window during
  `tab_select`, creates focused windows, and takes screenshots with
  `captureVisibleTab`. These choices need a background-aware contract.
- Trusted Zen input is already dispatched to an explicitly bound BiDi browsing
  context under an extension-owned lease, rather than through OS-global input.
- Chromium Mini's isolated MCP mode already defaults to a headless browser.
  Attached mode binds an explicit CDP target; browse-connected mode delegates
  execution to browse and needs its own focus audit.
- The recent host benchmark explicitly activated the fixture tab before each
  task. It did not certify simultaneous human/agent work.

A tab's active state, window/system focus, document visibility, and the focused
form element are separate facts. One `active` boolean must not represent all of
these in the session contract.

## Zen P0: an agent window that leaves the person in control

This is the first product slice. Offer **Work in background** for a deliberately
shared tab. Move that exact tab into a labelled agent window in the same browser
profile, preserving the tab's login, container and current form/document state.
Moving an existing tab and opening a fresh copy are different operations; do not
reload or duplicate a partially completed form without an explicit choice.

Implementation finding: Firefox ignores `focused:false` when creating windows.
Window preparation is therefore an explicit popup action that may take focus
once; the task starts on return to the other window. MCP calls cannot create it
silently. Adopt/share the exact returned tab without running the current
focus-raising `tab_select` path. The agent tab stays
selected inside its own window while the person's window remains in front.
Revalidate the tab/document/native binding after moving it. Keep all existing
ownership, revocation and no-replay protections.

The extension should show background progress, **View**, **Pause**, and **Take
back**. View is the explicit focus-changing action. Take back revokes the lease
before allowing further automated input. The host receives `needs_attention`
when a step cannot run under the chosen focus policy; it must not repeatedly
raise the window or switch input mechanisms.

Zen mirrors pinned tabs into new windows. A new window is neither a security
sandbox nor a clean workspace: only the exact granted tab receives an agent
lease, and mirrored personal pins must not be moved, closed or adopted.

Gate for automated execution after preparation: native fill, click, submit,
select, frame/shadow input and navigation run
while a different window stays focused, with zero focus-change events attributable
to automation and unchanged human input. Test X11/Wayland and supported packaging
separately. Covered and minimized windows are separate cases; neither is promised
merely because an unfocused window works.

## Zen P1: an inactive tab in the same window

This is the user's ideal same-window experience. Split observation/ownership
checks from foreground pointer/keyboard requirements:

1. Let authorized read-only snapshots, extraction and supported network inspection
   address the leased tab by ID even when another tab is selected. Keep document
   generations, frame selection, origin grants and revocation checks.
2. Add an explicit background semantic-input route for compatible forms: fill,
   checkbox/select changes, supported clicks and form submission. Validate the
   actual target and resulting state without requiring desktop visibility or
   scrolling the person's viewport. Synthetic pointer/key events are not equivalent
   to browser-mediated input; report the mechanism and do not silently downgrade
   a session that requires trusted input.
3. Run a separate BiDi feasibility matrix for native input into an inactive tab
   with a human typing in the selected tab. Promote only the exact tested actions
   and platforms. A context-addressed protocol command alone is not a guarantee
   of focus independence or compatibility with every site.
4. Capture the authorized tab by ID, evaluating Firefox `tabs.captureTab` or
   BiDi capture. Do not temporarily select it to obtain a screenshot. If the
   browser cannot provide a fresh capture in that state, report it as unavailable.

Gate: the selected human tab never changes, human text remains exact, and the
agent's state changes occur only in the leased tab. Include React-controlled
fields, contenteditable, navigation, frames, open shadow roots, timer throttling,
discarded tabs and Stop sharing during a batch.

If inactive-tab native input cannot meet this gate, keep it unsupported and use
the agent-window or worker route by explicit session choice. Do not pretend that
rewriting `document.visibilityState` or focus-steal-and-restore provides isolation.

## Zen P2: an independently rendered worker

Offer a dedicated, persistent agent profile for jobs that must continue with no
visible desktop window, including cases where minimized/occluded windows cannot
run the required action. The existing standalone Zen/BiDi launcher has headless
launch support in source, but is a separate control path. Productizing this needs
its own Zen compatibility tests and the same session/trace/cancellation contract.

The person signs into the worker once; it keeps its own session across jobs.
This does not automatically inherit a live personal tab's cookies, local storage,
passkeys or unsaved form state. Never open the live personal profile in a second
browser process. A container separates cookie state, not browser execution or
physical focus, so it is not a substitute for a worker.

Prefer the real Zen headless route when validated. A Linux virtual-display worker
is a possible compatibility fallback with explicit platform/resource costs.
Headless Firefox should be named as Firefox rather than advertised as tested Zen.

Gate: persistent login, restart recovery, downloads/uploads, screenshots and
handoff work without an OS-visible window. Login/permission/verification steps
that need human interaction pause and notify; they do not seize the desktop.

## Chromium plan

1. **Make the existing headless Mini path the obvious background option.** Expose
   it in setup and show task status, results and an explicit human handoff. It
   already avoids a displayed browser window in the default isolated mode.
2. **Add a persistent agent profile.** Authenticate once and reuse its session
   for background jobs, with the same profile-locking and lifecycle rules as the
   Zen worker. Existing Mini launches should not be presented as persistent-login
   workers until this behavior is implemented and verified.
3. **Harden existing-profile/attached operation independently.** Keep an explicit
   leased CDP target and dispatch input/capture directly to it. Audit every
   activation/bring-to-front path. Evaluate target-scoped focus emulation only
   when needed; it is experimental and does not guarantee user activation,
   permission prompts, site compatibility, or background rendering.
4. **Audit browse-connected execution separately.** Mini's raw-CDP behavior does
   not prove that browse's executor avoids focus changes. Apply the same tests
   and report unsupported cases rather than promising a universal mode.

## One session policy across both backends

Keep execution choice at session creation instead of adding a focus flag to
every tool. Proposed session properties:

- Execution: shared tab, agent window, or persistent worker.
- Focus policy: never change human focus by default; explicit handoff can grant it.
- Input requirement: browser-mediated native input or explicit semantic input.
- Capability results: background reads, background input by action, capture support,
  visibility constraints, login/session source and any reason attention is needed.

Normal click/fill/run/extract tools remain the host-facing interface. The runtime
selects only a route authorized by that session. It must not retry uncertain
writes, switch profiles, or silently change trusted-input semantics.

## Release test and implementation order

First build the concurrent-use fixture: one human window/tab with a typing
sentinel and playing media, plus the leased agent form. Record browser focus
changes, OS foreground-window changes where supported, selected tabs, element
focus, trusted event/state results, human text, and media continuity. Checking
only focus before/after can miss a brief interruption. Protocol-based human
keystrokes can themselves refocus a window and mask the problem, so include a
real desktop typing pass before claiming support.

Run normal, another-app-focused, covered, minimized, same-window inactive-tab,
frame, navigation, native-control, restart, cancellation and take-back cases.
Add a sustained run (for example 15 minutes), not only a short happy path.

Delivery order: **Zen concurrent-use fixture -> Zen background agent window ->
Zen inactive-tab observation/semantic route and native feasibility gate ->
persistent workers**, then bring the Chromium paths through the same gates.
Chromium's existing headless default can be documented immediately; it should
not displace the Zen work.

## Sources and exploratory evidence

- [MDN: active tab can belong to an unfocused window](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab).
- [MDN: window creation parameters; Firefox compatibility limitations apply](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/create).
- [MDN: Firefox capture by tab ID](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureTab).
- [WebDriver BiDi input command](https://w3c.github.io/webdriver-bidi/#command-input-performActions).
- [Chromium focus emulation protocol definition](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Emulation.pdl).
- [Chrome headless windows are not displayed](https://developer.chrome.com/docs/automation-and-testing/headless).

The original probe did not independently verify its display backend. Use the
new concurrent-typing report linked from the usage guide for X11 evidence.

The [exploratory Zen two-window probe](../research/2026-11-15-zen-background-window-probe.json)
used Zen 1.14.9b in a disposable Xvfb profile. Native fill and Save completed in
an unfocused window. The human fixture window remained focused, its pre-existing
text stayed unchanged, and the extension recorded no window-focus event during
the action. Final agent state confirmed both the intended field value and a
trusted click result.

This was one short action sequence. No simultaneous physical typing, media
playback, minimize/occlusion matrix or sustained desktop workload was tested.
Browser focus-event records alone do not certify OS focus/cursor isolation on
every platform. The probe's human text was entered before the action; it is not
a substitute for the concurrent-use release fixture.

The tested Zen build rejected Classic WebDriver creation of a new window
(`openWindow() not supported in Zen`). Creating the owned window through the
existing WebExtension window API worked. Use that path for the first product
slice rather than assuming all Firefox WebDriver window commands work in Zen.
