# Runtime hardening validation

The [final results](2026-11-12-release-workflows.json) record five alternating
warm trials per runtime on a local form and cookie-persistence workflow.

| Runtime | Passed | Median workflow time |
| --- | --- | --- |
| Mini Chromium | 5/5 | 205 ms |
| Rust Firefox extension | 5/5 | 274 ms |
| browse 0.0.16 | 5/5 | 605 ms |
| agent-browser 0.42.0 | 5/5 | 424 ms |

Timing includes scripted tool/CLI calls and page work, excluding setup/login and
model latency. The test verifies submitted values and retained fixture login on
return navigation. It uses no real account credentials or separate model API.
Mini and agent-browser use the same Chrome for Testing binary. browse uses the
paired Chromium; Firefox uses a disposable profile with test permissions.
Observations, APIs and numbers of calls differ. Agent-browser includes CLI
process overhead. These results establish neither general superiority nor a
Rust language speedup. This is not an autonomous-agent benchmark.

The [initial run](2026-11-12-release-workflows-before-click-fix.json) exposed
Mini's stale post-click snapshots (0/5). A browser regression test reproduced
the failure. Mini now waits for click-triggered main-document navigation through
DOMContentLoaded. The regression, six actionability tests and final trials pass.

Separate local validation covers two Firefox MCP clients with independent tab
ownership, cross-agent selection/close refusal, binary upload, same-origin frame
input and parent-overlay rejection, containers, whole-window cleanup, form
batches, WebDriver-confirmed handoff, saved pairing and relay restart with the
same stdio proxy. Rust tests cover queue/in-flight cancellation, scoped release,
pending cleanup, authenticated pairing and another client proceeding during a
handoff. DOM checks cover open shadow roots, inert hosts, keyboard event delivery,
upload contents, handoff/revocation and transformed frames. Chromium tests cover
existing-target attachment, competing leases and preserving the tab on close.
Installer tests verify a stable launcher and retaining the installed version
after checksum failure. Native Codex/Zen status remained usable after a relay
restart without repeating pairing.

Run `eval/agent-comparison/release-workflows.mjs` with `AGENT_BROWSER_COMMAND`,
`BENCH_CHROME_PATH` and a disposable `GECKODRIVER_URL`. browse's paired Chromium
must be connected. Actual signed-extension/browser/machine restart testing and
repeated real host-agent workflows remain release gates.
