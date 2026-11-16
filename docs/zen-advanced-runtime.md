# Zen input, observations, network inspection and evidence

These source features are experimental. A Linux x64 alpha is described in the [alpha guide](alpha-guide.md).
[Install the published Firefox/Zen add-on](published-extension.md); install its matching
local bridge using the [setup guide](getting-started.md). The
[matched host pilot](host-agent-evaluation.md) connects the signed-in Codex agent
over MCP; Callisto does not require its own model API credential. The earlier Hy3
API preflight was credit-blocked and is kept as historical evidence. The extension can now use trusted BiDi input
under its shared-tab ownership contract. The standalone `zen-bidi` server remains
a separate control path.

## Work alongside your agent

[Prepare background work](background-work.md) moves the exact shared tab into
a labelled agent window. User preparation may take focus once. Return to another
window to start; execution then refuses focus-changing operations and pauses
when brought forward. Headful concurrent typing/media is verified on Zen X11
only. Inactive tabs and minimized windows remain separate work.

## One lease for observations, input, network and evidence

Use the normal `zen`/`firefox` extension bridge. Pair and explicitly share a tab,
then enable native input on that same MCP client:

```json
{"action":"enable","endpoint":"ws://127.0.0.1:9222/session"}
```

This is `callisto_input`; `status` reports mode, transport and binding state, and
`disable` explicitly returns to DOM input. The endpoint must belong to a browser
you deliberately started with remote debugging. A Classic WebDriver session's
`webSocketUrl` (`/session/<id>`) also works without creating or ending its session.
Raw `/session` connections create a Callisto-owned BiDi session and end it on detach.

The extension places a fresh document/target nonce in the shared frame. BiDi must
find exactly one matching document, then validate the lease and actionability
before every dispatch. Input uses that document's top-level context, including
verified parent-frame offsets. URLs alone never choose an input target. Existing
click/fill/press/submit, form controls, runs, batches and extraction pagination use
the selected mode. Native select focuses the verified control and sends real keys
without opening a platform popup. Upload remains an explicit synthetic FileList
operation. Scrolling remains a DOM operation.

Stop sharing, tab loss, permission removal, client cancellation and extension
disconnect invalidate the binding. Held inputs are released best effort; an
already-dispatched browser action can have completed. Failed input is never
replayed. A closed native socket can reconnect for a new explicit request; a lost
extension connection requires sharing again and explicit native enablement. The
trusted preference survives failure so an error cannot silently switch to DOM
input. Each run retains its original lease across steps and navigation.

Disposable Firefox and headful Zen Flatpak integration tests cover native typing,
checks/selects, form submission, frames, tab ownership, scoped API replay,
interception, evidence, cancellation and relay restart. These are fixture tests,
not comparative benchmark results or production-profile recovery certification.

## Trusted input through an explicit BiDi connection

```sh
cargo build --locked --release --manifest-path packages/firefox-rs/Cargo.toml --bins
CALLISTO_BIDI_PORT=9222 CALLISTO_TAB='https://example.com/' node scripts/callisto.mjs zen-bidi
```

Start the browser deliberately with a remote-debugging port first. A normal
already-running Zen process cannot be upgraded silently; enabling debugging may
require restarting that browser. `CALLISTO_BIDI_URL` accepts an explicit loopback
`ws://` endpoint instead of a port. Remote hosts, credentials and query parameters
are rejected. There is no process scan or implicit tab choice.

Use `CALLISTO_BIDI_CONTEXT` for a fixed context, or `CALLISTO_TAB` for an explicit
index or unique URL/title selector. Ambiguous selectors fail. `firefox-bidi` uses
the same connection contract. `CALLISTO_BIDI_BINARY` overrides the executable.
The launcher defaults these modes to `connected`; isolated launch is available
only when explicitly configured with `CALLISTO_MCP_BROWSER=isolated`.

The disposable input probe verifies trusted fill events, native Enter form
submission, open-shadow and same-origin frame clicks, and detach/reacquire in
Firefox and headful Zen under Xvfb. The Zen test profile needed first-run welcome
suppression and an explicit window size. Tabs with no layout viewport fail; these
results do not promise every Zen build or headless configuration works.

The standalone `zen-bidi` server is a separate privileged control path. **The extension's Stop sharing button
does not revoke BiDi control.** Use `callisto_close` or disconnect its MCP client.
Detaching ends its session without closing the person's tabs. Failed attachment
ends the newly created BiDi session. A closed connection can be reacquired on the
next explicit tool call, using the configured target again; failed input is never
replayed. Input errors release held key/pointer state and invalidate uncertain
navigation observations. Extension ownership, network and trace tools are not
provided by this BiDi MCP surface yet.

Reproduce on disposable profiles, without touching the user's browser:

```sh
python3 packages/firefox-rs/tests/bidi-input-smoke.py
CALLISTO_TEST_BROWSER=zen CALLISTO_TEST_HEADFUL=1 xvfb-run -a python3 packages/firefox-rs/tests/bidi-input-smoke.py
```

## Targeted observations in the extension

`callisto_snapshot` includes paragraph, list and table-cell text alongside controls.
Use `include_text: false` for controls, `selector` to scope to one element, and
`query` to filter names/values. Selection and extraction traverse open shadow roots.

```json
{"selector":"#orders","query":"total","max_chars":2000,"include_text":true}
```

Output uses complete lines, `next_offset` and a `revision`. Continuation reads the
same bounded capture even if the live DOM changes; pass its revision to reject a
superseded capture. `live_changed` is advisory. A new offset-zero capture refreshes
refs. `diff: true` reports added/removed lines against the previous same-scope
capture, including repeated lines, with `base_revision` and `order_changed`.
Request a full snapshot to inspect a changed order. Direct text in generic wrappers
is included. Capture limits (5,000 lines/500,000 characters) are distinct from page
limits; use targeted selectors when `capture_truncated` is true. Closed shadow roots
remain omitted; full text/extraction are separate tools. Frames remain explicitly selected.
A selected subframe navigation invalidates input until it is selected again.
Releasing a session revokes content scripts in every frame, not only the top page.

## Network inspection and interception in the extension

Choose **Enable network access** in the popup/options to grant optional website,
`webRequest` and `webRequestBlocking` access. The tool still requires a shared tab
and explicit exact origins. Capture and rules belong to that session, not all tabs.

Call `callisto_network`:

```json
{"action":"start","origins":["https://your-site.example"],"capture_bodies":false,"limit":200}
```

- `list`: request/response metadata, default 20 entries, up to 100 per read. Use
  `offset` and the returned `next_offset`. `include_bodies` reads bodies only when
  body capture was explicitly enabled at start.
- `endpoints`: observed methods, paths, query names, status codes, MIME types and
  JSON field names, without returning payload values or inventing API guarantees.
- `compare`: supply `left` and `right` capture IDs from `list` to compare method,
  path, query changes, statuses and inferred request/response shapes.
- `schema`: observed field types and pagination parameter hints, marked as inferred.
- `openapi`: an OpenAPI 3.1 draft from observed samples, optionally written to a new
  absolute `output_path`. Authorization, optionality and full contracts remain unknown.
- `replay`: an explicit GET/HEAD to the shared document's same origin, also inside
  the capture's allowed origins. It inherits the page/container session using
  Firefox MV2 page-context fetch. Redirects, custom headers and request bodies are
  refused. Results contain at most 64 KiB of redacted JSON; the request aborts on
  sharing revocation or after five seconds. GET/HEAD describe allowed methods,
  not a guarantee that a poorly designed server has no side effects.
- `rules`: replace up to 20 `block`/`redirect` rules. Each has `url_prefix` and
  optional `method`; redirect targets must stay inside allowed origins. Pass an
  empty array to clear rules. This supports controlled website testing and API
  investigation; it does not provide credentials, challenge solving or a proxy
  for evading access restrictions.
- `stop`: remove rules and release response filters, keeping captured entries.
- `export`: return HAR 1.2 or write a new absolute `output_path`. Its parent must
  exist. Files are private and never overwritten.

```json
{"action":"rules","rules":[{"action":"block","url_prefix":"https://your-site.example/test-resource","method":"GET"}]}
```

Bodies default off. When enabled, bounded JSON responses and JSON/form requests
are captured, with a 64 KiB per-body and 1 MiB aggregate budget. Non-JSON response
bodies are omitted. At most 500 entries are retained. Drops, active capture and
unfinished requests are explicit in HAR metadata. Redirect hops remain distinct.

Credential headers, sensitive query/JSON/form fields and recognized embedded
credential URLs are redacted. This is heuristic: application data can still be
private, and redaction can remove fields a benchmark evaluator needs. Stream
capture passes response bytes through unchanged. Stop/release, disconnect, tab
loss or permission removal clears rules and releases pending streams. Permission
regrant supports a fresh explicit capture. Ordinary navigation keeps the capture
only while the same session retains sharing and continuous website permission.

## Private evidence recorder

Call `callisto_trace` before a task. The directory must be new and absolute; its
parent must exist. Screenshots and DOM text are opt-in because they may contain
private page data.

```json
{"action":"start","directory":"/absolute/path/task-evidence","snapshots":true,"screenshots":true}
```

Action start/end JSONL excludes recognized sensitive arguments and fill values.
Automatic checkpoints follow successful and failed input/navigation/run calls. Available
artifacts are saved even when another requested artifact fails. `checkpoint`
captures enabled evidence explicitly without changing the agent's current refs.
`status` reports collection state. Stop network capture, stop the trace, then
release the tab. Trace stop adds HAR when a capture exists.

Files include `actions.jsonl`, ordered `snapshot<N>.json`/`screenshot<N>.png`,
optional `network.har` and a manifest of actual outputs. Artifacts include
`after_sequence` and capture time. Cancellation writes a terminal action with an
unknown outcome and records unavailable checkpoint evidence. Missing requested
evidence prevents a complete manifest. A failed task can have a complete recording;
`task_success` stays unknown, separate from recording completeness. Manifests are
updated during capture so interrupted runs remain inspectable. Directories use mode 0700 and
files 0600. Limits are 10,000 recorded calls and 1,000 checkpoints. Runtime tool
times exclude model inference. No model reasoning transcript is reconstructed.

These files are custom evidence, **not Playwright trace ZIPs**. The exporter
validates actual files, sizes, PNG structure, action completion and HAR completeness,
and records SHA-256 hashes. It refuses missing or escaping artifact paths.

After installing the eval package, export captured data:

```sh
python -m callisto_eval.evidence /absolute/path/task-evidence /absolute/path/export --benchmark webvoyager --task-id task-example --instruction 'Find the price' --answer '42 dollars'
# Install webarena-verified==1.2.3 for its official response/HAR validators:
python -m callisto_eval.evidence /absolute/path/task-evidence /absolute/path/export --benchmark webarena-verified --task-id 11 --response /absolute/path/agent_response.json
```

WebVoyager export uses ordered PNGs and a translated task/final-answer message
envelope accepted by the inspected auto-evaluator. It is not a reconstruction of
the original model's thoughts/actions. Verified export validates the typed response
and captured HAR with its pinned native parser. Supply `--requirements` to enforce
an explicit task evidence contract in addition to parser validation. Neither export runs a judge or produces a score.
Original WebArena still needs its live environment/evaluator. The generic eval
runner now retains only agent-supplied artifact links that actually exist inside
the run, instead of publishing placeholder screenshot/trace paths.

See the [primary-source trace requirement research](../research/2026-11-14-benchmark-trace-requirements.md)
for pinned evaluator revisions and the distinction between runner outputs and
scoring inputs. The generated fixture HAR was accepted by Verified 1.2.3; this is
a format check, not an official benchmark result.

## Task evidence coverage and interrupted-run inspection

Derive requirements from the actual task evaluator. The explicit contract checks
observed method/URL/status, non-redacted request/response JSON pointers, screenshot
counts and screenshot attribution to action sequences. It does not run the judge,
validate expected field values or infer requirements from a task ID.

```json
{"schema":"callisto.task-evidence.v1","network":[{"method":"POST","url_glob":"https://your-site.example/api/orders*","status":200,"request_json_pointers":["/sku"],"response_json_pointers":["/id"],"min_count":1}],"screenshots":{"min_count":1,"after_each_action":true}}
```

```sh
python -m callisto_eval.evidence /absolute/path/task-evidence --inspect --requirements /absolute/path/requirements.json
python -m callisto_eval.evidence /absolute/path/task-evidence /absolute/path/export --benchmark webarena-verified --task-id 11 --response /absolute/path/agent_response.json --requirements /absolute/path/requirements.json
```

Inspection accepts incomplete captures while retaining path, size, PNG and action
ordering validation. Export stays strict and refuses unmet requirements. A coverage
report explicitly says no benchmark evaluation ran. Redaction can make a real task
unscorable; missing data is never reconstructed.

The unified smoke test needs a running disposable geckodriver. For Firefox:

```sh
GECKODRIVER_URL=http://127.0.0.1:4444 python3 packages/firefox-rs/tests/firefox-bridge-smoke.py
```

For Zen Flatpak, start a host geckodriver under Xvfb with `--profile-root` inside
`~/.var/app/app.zen_browser.zen/cache`, then set `CALLISTO_TEST_BROWSER=zen` and
`CALLISTO_TEST_HEADFUL=1` for the test. Its wrapper launches Flatpak and installs the
test XPI from that same accessible cache. A host `/tmp` addon path caused invalid
file-descriptor errors when content scripts loaded inside Flatpak. All profiles,
permissions and automatic fixture sharing belong only to the disposable test.

## Activate source changes

Rebuild the binaries, reload the extension, close MCP clients, stop the previous
relay with `packages/firefox-rs/target/release/callisto-firefox-tab-mcp --stop-relay`,
and restart MCP connections to refresh tool schemas. The implementation tests did
not restart or change the user's existing Zen profile. Permanent distribution and
new matched agent results still require working model access.

## Recovery and measurement validation — 15 November 2026

The persistent-profile suite exercises cancellation, abrupt relay loss, extension
replacement, clean browser restart and tab loss in Firefox and Zen. It also kills
and restarts its own Zen Flatpak process after verifying profile ownership.
Profile storage and persistent cookies survive restart/crash; saved pairing
reconnects while tab access still requires explicit reacquisition. The surviving
stdio proxy refuses writes until a prior trusted-input choice is re-established.
Failed trusted enablement remains in trusted mode instead of allowing DOM input.

The suite creates a genuine owned WebDriver tab. Zen's internal empty-workspace
placeholder is not an ordinary extension-visible tab; navigating that placeholder
was a test-fixture startup error. No personal browser or profile is used.

Run `node eval/agent-comparison/session-recovery.mjs`, or set
`CALLISTO_TEST_BROWSER=firefox` and a fresh `RECOVERY_OUTPUT`. Override
`GECKODRIVER_BINARY` when needed. See the saved [Zen report](../eval/reports/session-recovery-2026-11-15.json)
and [Firefox report](../eval/reports/session-recovery-firefox-2026-11-15.json).

Trace end events now contain content-free measurement samples. Status/manifests
aggregate calls, failures, serialized argument/value UTF-8 bytes, observation
characters and runtime elapsed milliseconds. Sizes exclude MCP framing; elapsed
time excludes model inference and checkpoint capture. Interrupted actions remain
explicit and are not invented as completed measurement samples. These counters
are not tokenizer counts or invoices.

The [observation ablation](../eval/reports/observation-efficiency-2026-11-15/README.md)
shows why output size must be reported together with task-content coverage. The
[matched pilot attempt](../eval/reports/matched-agent-2026-11-15/README.md) saves
provider failures separately from browser-task failures.
