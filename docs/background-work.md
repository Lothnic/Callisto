# Background work in Zen and Firefox

The extension can keep a deliberately shared tab in its own agent window while
you work in another window. This is an experimental feature. It does not
enable native input in an inactive tab inside your work window.
The [published AMO add-on 0.2.0](published-extension.md) includes these controls;
install its matching local bridge to use them.

## Start a task

1. Reload the extension and restart its MCP entry after updating this checkout.
2. Open the page the agent should use. In Callisto's popup, choose **Prepare
   background work**, then allow tab management if asked. Preparing a tab replaces
   current shares. The popup requests the optional `tabs` permission, not cookie,
   history or bookmark access.
3. The same tab moves to a labelled agent window. Its login, cookie container and
   unsaved document state are preserved. Pinned tabs must be unpinned first; the
   extension does not move or adopt Zen's mirrored personal pins.
4. Return to your other browser window or application. The prepared task starts
   automatically once the agent window is unfocused and unminimized. Your host
   agent can then use the ordinary snapshot, fill, click, run and extract tools.
   Trusted input still requires the explicitly enabled BiDi connection described
   in [the runtime guide](zen-advanced-runtime.md).

**Window preparation can take focus once.** Firefox ignores `focused:false` when
creating windows, so an MCP request cannot silently prepare one. The creation
step is an explicit user action. Automation enforces its no-focus policy after
preparation; unsupported window states pause the task instead of raising it.
See [Mozilla's release notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/86)
and [the underlying issue](https://bugzilla.mozilla.org/show_bug.cgi?id=1253129).

## Keep control

- **View** pauses the task before showing its window.
- **Pause** stops further dispatch and retains the tab reservation. An already
  dispatched action may finish; interrupted writes are not replayed.
- **Resume** works from your other window while the agent window is unfocused
  and unminimized. It keeps the selected native/DOM input mode.
- **Take back** stops automation and releases that task's lease. The tab/window
  remain open. **Stop sharing** releases all agent sessions, including paused ones.

Bringing the agent window forward pauses it. Minimizing it, selecting another tab
inside it, moving its controlled tab elsewhere, or making its document hidden
can pause execution or require attention. Returning after **View** or **Pause**
does not automatically resume; that initial start-on-return applies only to the
explicit preparation action.

## Host-agent contract

`callisto_capabilities.capabilities.backgroundWindow` negotiates support with
the loaded extension. `callisto_status.execution` reports the mode, tab/window,
pause reason and focus policy. The focus policy applies to automated execution;
explicit user preparation and View can change focus.

```json
{"action":"background","operation":"start"}
{"action":"background","operation":"pause"}
{"action":"background","operation":"resume"}
{"action":"background","operation":"stop"}
```

These are `callisto_browser` calls. `start` returns the already prepared task or
`needs_attention` directing the user to prepare it in the popup. It never creates
a new window on an agent's initiative. `stop`, like `callisto_close`, preserves
the tab. A background session refuses browser actions that select/create/close
other tabs or windows or open a save dialog. View remains a user control.

## Verification and current limits

The saved [Zen concurrency check](../eval/reports/background-window-2026-11-15.md)
passed a one-minute run with 92 native form cycles, 620 exact human characters,
continued video playback and no browser focus changes during execution. The
real-browser check uses a disposable profile on a private Xvfb/X11 display
with Openbox. A human fixture receives OS-level `xdotool` typing and plays a
muted canvas-stream video while the agent performs native fill, check, select
and Save operations. It checks document preservation, exact human text, media
progress, browser-focus events, X11 keyboard focus and pause/resume/take-back.
This is not certification for Wayland, macOS, Windows, minimized/covered windows,
passkeys/OS dialogs or real personal media.

Headful concurrent use has been verified only on Zen 1.14.9b in this environment.
Firefox headless recovery checks pass, but the local Snap Firefox headful fixture
failed at startup; Firefox concurrent use is not certified. The current alpha
archive predates this source feature.

Build the debug bridge and install the test prerequisites (Zen Flatpak,
geckodriver, Xvfb, Openbox, xdotool, wmctrl and the existing Node/Python dependencies),
then run from the checkout:

```sh
node eval/agent-comparison/background-window.mjs
```

`BACKGROUND_OUTPUT` chooses a report path. `BACKGROUND_DURATION_MS` controls the
concurrent workload (default 10 seconds; up to 15 minutes).
`BACKGROUND_TYPING_DELAY_MS` controls injected human typing (default 100 ms per
character). `BACKGROUND_AGENT_IDLE=1` runs a human-only control.
`BACKGROUND_TRACE_DIR` selects a fresh directory for a Callisto action log and
manifest; this is not a Playwright trace.
`BACKGROUND_WINDOW_MANAGER` can name an Openbox executable/wrapper.
`CALLISTO_TEST_BROWSER=firefox` requests an experimental Firefox run. OS input is sent only after the
harness identifies the exact owned geckodriver, private Xauthority file and sole
browser window on that display. Setup and the simulated user return are outside
the measured background execution interval.
