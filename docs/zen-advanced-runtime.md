# Zen input, observations, network inspection and evidence

These source features are experimental. Extension distribution and a controlled
browse comparison remain deferred. The two Firefox/Zen transports are distinct:
the existing-tab extension has sharing/ownership/network/evidence controls; the
explicit BiDi path supplies browser-mediated input in a debug-enabled process.
Neither silently falls back to the other.

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

This is a separate privileged control path. **The extension's Stop sharing button
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

Output uses complete lines and `next_offset` for live-DOM pagination. DOM changes
can shift offsets. Closed shadow roots and some text in generic wrappers remain
omitted; full text/extraction are separate tools. Frames remain explicitly selected.
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
Automatic checkpoints follow successful input/navigation/run calls. `checkpoint`
captures enabled evidence explicitly without changing the agent's current refs.
`status` reports collection state. Stop network capture, stop the trace, then
release the tab. Trace stop adds HAR when a capture exists.

Files include `actions.jsonl`, ordered `snapshot<N>.json`/`screenshot<N>.png`,
optional `network.har` and a manifest of actual outputs. In-flight/cancelled actions
and capture failures prevent a complete manifest. Directories use mode 0700 and
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
and captured HAR with its pinned native parser; task-specific network field
coverage remains unchecked. Neither export runs a judge or produces a score.
Original WebArena still needs its live environment/evaluator. The generic eval
runner now retains only agent-supplied artifact links that actually exist inside
the run, instead of publishing placeholder screenshot/trace paths.

See the [primary-source trace requirement research](../research/2026-11-14-benchmark-trace-requirements.md)
for pinned evaluator revisions and the distinction between runner outputs and
scoring inputs. The generated fixture HAR was accepted by Verified 1.2.3; this is
a format check, not an official benchmark result.

## Activate source changes

Rebuild the binaries, reload the extension, close MCP clients, stop the previous
relay with `packages/firefox-rs/target/release/callisto-firefox-tab-mcp --stop-relay`,
and restart MCP connections to refresh tool schemas. The implementation tests did
not restart or change the user's existing Zen profile. Permanent distribution and
new controlled browse comparisons remain deferred.
