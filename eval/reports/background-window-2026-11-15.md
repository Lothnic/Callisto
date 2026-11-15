# Zen background-window check — 15 November 2026

The one-minute check passed on Zen 1.14.9b: 92 native form cycles completed
while a human fixture received all 620 requested characters and played a muted
canvas-stream video. The browser recorded no window-focus events during the
measured interval; X11 keyboard focus was unchanged. Video time advanced from
0.152 to 61.067 seconds. This is a scripted runtime check, not a model benchmark
or a claim about browse parity, cost or general website compatibility.

## Evidence

- [Successful raw report](background-window-2026-11-15.json): source
  `ff98a2d7e6448caa6417e3479fe6cf65e096e679`, tracked working tree clean when recorded.
- [Callisto trace manifest](background-window-2026-11-15-trace/manifest.json) and
  [redacted action log](background-window-2026-11-15-trace/actions.jsonl).
  The single failed action is the intentional write rejection while paused.
  This is Callisto JSONL, not a Playwright ZIP or a benchmark-native trace.
  Screenshots/DOM checkpoint files were not requested. `task_success:null` in
  the generic manifest is separate from the fixture's explicit state assertions.
- [Persistent Zen recovery recheck](background-window-2026-11-15-recovery.json):
  all six cases passed, including relay loss, extension reload, browser restart,
  forced crash, cancellation and lost-tab isolation. This report records a dirty
  tracked tree while final UI/docs edits were in progress; no clean-source claim
  is made for that recheck.

## Setup and scope

The fixture uses an owned disposable Zen profile on a private Xvfb/X11 display
with Openbox. It verifies the exact geckodriver process, Xauthority and sole
initial browser window before sending OS-level `xdotool` input. Agent input
uses the extension-owned BiDi lease; the host does not own the physical keyboard.

User preparation moves the exact tab, preserving an unsaved document sentinel
and form value. Firefox/Zen window creation may bring that window forward once.
The fixture models explicit preparation through a test-only hook, then models
the user's return to the human window before starting the measured interval.
This hook is absent from the shipped extension and MCP schema. Product agents
can only access an already prepared background task.

The native loop fills a field, checks a checkbox, changes a select and presses
Save. The HTTP handler verifies all values plus trusted input/click events.
After the measured run, Pause rejects another write, Resume performs one fresh
write, and Take back releases sharing without closing the owned tab/window.
UI tests separately cover the explicit permission and task-control flow.

This run covers neither Wayland/macOS/Windows nor a real personal profile,
another desktop application, minimized/covered windows, inactive same-window
tabs, frames/shadow roots in background mode, OS dialogs or a 15-minute soak.
The [local headful Snap Firefox attempt](background-window-2026-11-15-firefox-startup-failure.json)
failed during browser startup; it does not measure Firefox concurrency.
Do not infer those capabilities from this result. The current alpha archive
predates this feature; source update/reload is required.

## Retained stress failures

The earlier [10 ms/character agent stress run](background-window-2026-11-15-fast-typing-stress.json)
failed exact human-text integrity. A subsequent
[10 ms/character human-only control](background-window-2026-11-15-human-only-fast.json)
also failed with zero agent form cycles during the measured interval. In that
control, the textarea exactly matched its received keydown sequence and no
Ctrl/Alt modifiers were recorded; that sequence differed from the requested
generator text. These dirty-source development reports lack some fields added
to the final harness, including expected text and the full submission list.
The control shows that the extreme-rate result does not isolate agent
interference. It remains a failed stress test, not a passing guarantee.
The verified final rate was 100 ms/character (about 120 words/minute by the
five-character convention), and both original failures are retained unchanged.

## Reproduce

Install the prerequisites and build the debug runtime as described in the
[background-work guide](../../docs/background-work.md), then use a fresh trace
directory and report path:

```sh
BACKGROUND_DURATION_MS=60000 \
BACKGROUND_TYPING_DELAY_MS=100 \
BACKGROUND_TRACE_DIR=/tmp/new-callisto-background-trace \
BACKGROUND_OUTPUT=/tmp/new-callisto-background.json \
node eval/agent-comparison/background-window.mjs
```

No model provider is called. The normal extension's default input mode remains
DOM; this native fixture explicitly enables its owned BiDi endpoint.
