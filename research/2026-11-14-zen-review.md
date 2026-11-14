# Zen review and improvements — 14 November 2026

Reviewed the existing-tab Firefox/Zen extension, Rust MCP facade and local
`vendor/browse` capability surface. This is an implementation review plus
targeted regression work; it does not establish full browse parity.

## Findings addressed

1. **High: short animations caused failed input and extra agent turns.**
   `content.js` previously centered every target, slept 75 ms and rejected any
   geometry change. An animated filter could fail despite becoming usable a
   moment later. Input now samples two animation frames and retries only moving
   or covered preconditions for up to two seconds, bounded by the command
   deadline. Scrolling uses `nearest`, including nested overflow containers.
   No click, submit or fill is replayed after dispatch.

2. **High: form workflows fell out of the 40-step run API.**
   The smaller batch API had submit, but run lacked submit/select/check/hover.
   Run now supports each by ref or exact role/name. A real Firefox smoke test
   completes select, check, fill, submit, selector wait, text wait and extraction
   in one MCP call. Native Enter remains unsupported; submit preserves browser
   form validation and submit handlers.

3. **Medium: wait advertised 500 characters but called a 200-character find.**
   Run previously polled the extension message bridge every 100 ms. Waits now
   execute in the selected document, using mutation observation and a 50 ms
   fallback for CSS-only changes. They support text through 500 characters and
   CSS selectors with visible/hidden/attached/detached states. Navigation may
   resume this read-only operation within the original step deadline.
   Invalid timeout values and invalid fixed waits are rejected.

4. **Medium: large snapshots silently cut lines and stranded later controls.**
   Snapshot previously sliced output at 12,000 characters after collecting up to
   400 elements. It now keeps complete lines, reports truncation and next_offset,
   and supports bounded max_chars and element offsets. Tests traverse 450
   controls and act on the last one. Snapshot offsets refer to the live DOM;
   changes between calls can shift positions. Refs are from the latest snapshot.

5. **High: pending input could outlive revoke/re-share or state changes.**
   The content script now tracks lease changes across waits and rechecks
   disabled/read-only state and handoff before dispatch. Pending document waits
   are cancelled immediately on revocation. Navigation recovery checks the
   original ownership before continuing; interrupted input is never replayed.

6. **High: compiled capability flags hid stale installed extensions.**
   The MCP facade previously advertised run/extract without consulting the loaded
   extension. New feature flags now come from extension status. Disconnected or
   older extensions do not claim support for run, extraction, paginated snapshots,
   run form controls or selector waits unless explicitly advertised. Tests cover
   disconnected, older and current extension responses.

## Measurements and limits

Raw data: [`../eval/reports/zen-extension-2026-11-14.json`](../eval/reports/zen-extension-2026-11-14.json).
The benchmark alternates baseline/candidate order across four trials in the
same disposable headless Chromium. Each variant executes 80 stable clicks and
four independently animated clicks. Source hashes and exact browser, Node and
Playwright versions are recorded in the JSON.

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Stable action median | 75.5 ms | 33.3 ms |
| Stable actions completed | 80/80 | 80/80 |
| Animated actions completed in one attempt | 0/4 | 4/4 |

The stable action median is about 44% of baseline (56% lower). This measures
the content actionability code only. It excludes Zen, extension transport,
agent inference, dollars, and end-to-end browsing. No claim about a fraction
of browse's total time or cost follows from these numbers. Fewer agent calls
and configurable snapshot size provide cost controls, not a measured dollar
saving. The earlier WebArena fixture was not rerun here.

## Remaining browse capability gaps, in priority order

- **Trusted input and Playwright execution:** existing-tab DOM events remain
  synthetic. The separate BiDi experiment needs a debug-enabled process and
  cannot adopt a normal Zen process retroactively. Closing this gap requires a
  privileged transport and a separately validated connection path.
- **Observation completeness:** DOM snapshots still omit text-only content,
  closed shadow roots and unselected frames. Use explicit text/extraction tools;
  input in cross-origin or transformed frames remains unsupported.
- **Background rendering and Zen workspaces:** hidden tabs are still refused
  for input. The documented Magento foreground-rendering issue and cross-workspace
  enumeration have not been verified or solved by these changes.
- **Network interception, protected secrets and recording:** browse has dedicated
  implementations under `vendor/browse/cli/src/mcp`; this Zen bridge lacks those
  equivalent contracts.

## Validation and reproduction

```sh
cargo test --locked --manifest-path packages/firefox-rs/Cargo.toml
cargo build --locked --manifest-path packages/firefox-rs/Cargo.toml --bin callisto-firefox-tab-mcp
node --test packages/firefox-rs/tests/extension-background.test.cjs
node packages/firefox-rs/tests/extension-content.mjs
geckodriver --host 127.0.0.1 --port 53861
# In another terminal, with the disposable test driver above:
GECKODRIVER_URL=http://127.0.0.1:53861 python3 packages/firefox-rs/tests/firefox-bridge-smoke.py
ZEN_BASELINE_REF=4e82451 node eval/agent-comparison/zen-actionability.mjs /tmp/zen-actions.json
```

The smoke test uses a temporary Firefox profile, relay state and test extension
with broader fixture permissions. It does not modify the user's Zen profile or
verify production permission prompts. It covers the new form run, long text
and selector waits, animated input and snapshot pagination, plus existing pairing,
navigation, screenshots, cookies, uploads, frames, containers, per-client
ownership, handoff, release and relay restart behavior.

The optimized MCP binary was rebuilt. To activate changes in an existing
session, reload the Zen extension, close MCP clients, stop the old relay with
`packages/firefox-rs/target/release/callisto-firefox-tab-mcp --stop-relay`, then
restart MCP connections to refresh tool schemas. The review did not restart or
change the user's running Zen profile.
