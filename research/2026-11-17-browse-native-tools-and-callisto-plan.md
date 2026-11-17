# browse native tools and a measurable Callisto improvement plan

## Scope and evidence

Inspected the published `@opencode/browse-linux-x64@0.1.1` binary, with npm's
SHA-512 integrity verified before extraction. Two private MCP handshakes used
`clientInfo.name=opencode` and `clientInfo.name=codex`. No model calls, browser
profiles or performance trials were run for this catalog inspection.

[Captured catalogs, binary checksums and source hashes](2026-11-17-browse-native-catalogs.json)
retain the evidence. Source is pinned to `v0.1.1`, commit
`0d5d907d85ba4efd2ec2ea651ed594e9d8afd314`. The installed 0.1.0 binary used by
the earlier Luna pilot matches the published 0.1.0 npm binary byte-for-byte.

The handshake returned 26 tools / 41,415 serialized UTF-8 catalog bytes for
OpenCode, and 3 tools / 7,495 bytes for Codex. These are server catalogs, not
model context or cost measurements. OpenCode Code Mode behavior and token usage
were not exercised by the simulated handshake.

## What OpenCode receives

Here, native means individually named MCP functions with JSON argument schemas.
OpenCode can compose them in its own Code Mode. The server selects the facade
from the client's name; an environment setting can override it. Other hosts
receive execute, status and tabs. See the version-pinned
[selection implementation](https://github.com/anomalyco/browse/blob/v0.1.1/rust/crates/browse-relay/src/surface.rs)
and [OpenCode instructions](https://github.com/anomalyco/browse/blob/v0.1.1/rust/crates/browse-relay/src/instructions.md).

| Group | Native tools |
| --- | --- |
| Navigation and tabs | `navigate`, `tabs` |
| Observation | `snapshot`, `screenshot`, `screenshot_diff`, `eval` |
| Interaction | `click`, `fill`, `type`, `press`, `select`, `hover`, `drag`, `scroll` |
| Waiting, dialogs and files | `wait_for`, `dialog`, `upload` |
| Inspection and integration | `network`, `console`, `recording`, `emulate`, `webmcp` |
| Human steps and runtime | `handoff`, `demonstrate`, `status`, `settings` |

The [page contracts](https://github.com/anomalyco/browse/blob/v0.1.1/rust/crates/browse-page/src/tools.rs)
show why this is more than renaming functions:

- `fill` supports multiple fields and optional submission. Selects accept an
  option value or label. Inputs, checkboxes and selections share a consistent
  target model.
- Actions return an outcome and page changes. The agent can choose its next
  read from feedback rather than always requesting another full observation.
- Snapshot options include main/modal scoping, retained header controls,
  omission notes, interactive-only output, scoped searches, diff/delta, frames
  and line budgets. Stable refs are part of the documented interface.
- Code Mode can compose inspect/act/verify operations within one script. Several
  underlying MCP requests can therefore occur without a separate model round
  trip after each one. This is an interface capability, not a measured speedup.

The executable is Rust. Its execute interface is Playwright-style; it is not
the upstream Playwright library. Our fixture uses Playwright to launch owned
Chromium profiles, separately from the agent's browse runtime. See
[the rewrite release](https://github.com/anomalyco/browse/releases/tag/v0.1.0).

## What the Callisto measurements actually show

The [Luna pilot](../eval/reports/luna-real-world-2026-11-17/README.md) used Codex,
not OpenCode: current compact Callisto versus browse 0.1.0's execute facade.
Both completed 12/12 trials after a uniform native-JSON quote-parser correction.
All original scores, outputs and timings are preserved.

| Metric | Callisto / Zen | browse / Chromium |
| --- | ---: | ---: |
| Exposed task catalog bytes | 940 | 4,113 |
| Mean task time | 42.8 s | 52.8 s |
| Median task time | 38.6 s | 40.2 s |
| Uncached input tokens | 419,960 | 358,379 |
| Host MCP tool calls | 105 | 74 |
| Returned bytes | 350,364 | 233,694 |

The raw catalog is already small. Callisto's uncached input was 17.2% higher
and its total input including cache was 33.5% higher. Its mean latency advantage
was concentrated in arXiv; excluding that task descriptively gives 36.4 s versus
35.4 s. No rows are excluded from the primary totals. No billed-cost win is known.

Callisto made 37 snapshot calls and 15 help calls. Host tool calls are not the
same as browser actions or model round trips: help is local, run can contain
many actions, and a host may issue multiple calls in one model step. Future
instrumentation should retain these distinctions.

Six Callisto errors identify concrete interface friction:

- Two run plans used `fill`, while the run vocabulary required `fill_ref`.
- One run fill and one standalone fill used `text`, while the contract required
  `value`.
- One snapshot supplied offset 10,800, beyond the allowed range.
- One select supplied the displayed label `Title` where the implementation
  required the option's value.

The snapshot implementation exposes long randomized refs and keeps one
scope-specific diff baseline. Targeted snapshots replace that baseline. These
are opportunities to investigate, not demonstrated token savings from a change.

## Build order

### 1. Establish the current baseline and host-specific profiles

- Pin both CLI and extension for browse 0.1.1 and retain 0.1.0 as a separate
  baseline. Snapshot fixes in 0.1.1 can change results; the catalog probe cannot
  substitute for task trials.
- Test Callisto's existing full named-tool profile in actual OpenCode Code Mode,
  alongside compact mode. The free DeepSeek host was quota-blocked earlier;
  there is no completed OpenCode performance comparison yet.
- Fix host identity propagation in the evaluator before that comparison. Its
  provisioning MCP client currently identifies as `callisto-validation`, and
  the blocked OpenCode adapter deliberately sets `codemode:false` and permits
  one browser action. That does not exercise browse's default native OpenCode
  facade. Select the catalog for the actual host while retaining the owned
  sharing lease, then test Code Mode permissions and composition. Extend the
  no-direct-API scoring checks to any native eval tools exposed by that profile.
- Preserve and record native MCP initialization instructions in a default-host
  comparison. The current HostSession returns a generic initialize response and
  supplies a custom task/backend prompt instead. That is a controlled task-tool
  pilot, not the complete default product experience. Keep these experiment
  types separate; do not silently change the old baseline.
- Keep compact as the ordinary-host path and retain an explicit override.
  Consider automatic host selection only after testing client identity, host
  versions, Code Mode settings and approval behavior. Tool profile selection
  does not change browser permissions.
- Generate advertised schemas, help, validators and composition contracts from
  one operation registry. Avoid separate vocabularies for a standalone operation
  and the same operation within run.

Exit evidence: real host composition succeeds, native/compact operations retain
the same semantics, and measured model usage improves without losing tasks.

### 2. Remove contract mistakes and redundant observation cycles

- Give ordinary fill/click/submit/wait operations concise examples and consistent
  fields. Prevalidate statically invalid plans before dispatching any step.
- Return structured errors with the offending field, accepted form and dispatch
  state. A successful repair should not need another general help call.
- Expose bounded option label/value pairs or support unambiguous label selection.
- Use bounded runtime waits for known conditions instead of repeated model-driven
  snapshot polling. Preserve cancellation and the current no-replay rule for
  actions whose outcome is uncertain.
- Return compact action feedback: tab, URL, document revision, relevant changes,
  and whether a targeted read is needed. Encourage run plus typed extraction,
  followed by one necessary verification read.

Exit evidence: the saved six error patterns have regression tests; new matched
agent trials have fewer failed/discovery calls and lower input usage. Do not
infer the improvement from a schema-byte reduction alone.

### 3. Improve observation quality per byte

- Prioritize the current dialog/main region while retaining task-relevant
  navigation controls and reporting omitted areas.
- Keep full observation baselines separate from targeted searches. Preserve
  scoped diff/revision semantics and completeness warnings.
- Evaluate short per-session refs or aliases. Do not reuse an identifier after
  navigation or let a stale reference resolve to a different element. The
  existing long IDs prevent a class of cross-document mistakes; preserve that
  property and document/lease checks.
- Prefer typed extraction and small result projections for requested facts.
  More useful semantics may add bytes while saving whole model cycles.

Exit evidence: targets remain discoverable, refs remain correct under mutations
and navigation, and real tasks use less input with unchanged success.

### 4. Close capability gaps with explicit tests

Existing Zen contracts cover navigation, controlled tabs, refs, forms, explicit
frames, screenshots, upload, waits/runs/extraction, scoped network inspection,
handoff and recovery. This is not proof of complete parity with browse.

Dedicated parity work is needed for drag, browser dialogs, richer screenshots,
console capture, emulation, WebMCP, recording/demonstration and persistent named
tab handles. Some could be composed today, but dedicated advertised contracts
and end-to-end coverage have not been established for all of them. Treat
cross-origin frames and trusted input as separate backend-specific cases.

Each new capability should have one implementation reused by its compact and
native adapters, plus actual browser-state verification. Adding a tool name does
not establish the capability.

### 5. Make the comparative claim testable

Use three layers, in order:

1. Cheap deterministic fixtures: contracts, delayed rendering, native form
   behavior, frames/shadow DOM, popups, multi-tab work, files/dialogs and
   interruption/recovery without duplicate writes.
2. Version-pinned agent trials: multiple models, public reads plus owned
   authenticated write workflows, balanced order, cold/warm conditions and
   held-out tasks. Use a small screening set first, then more repetitions before
   drawing a performance conclusion.
3. External suites using their real task evaluators. BrowserGym and WebArena
   have environment/agent integration requirements; a trace or HAR that parses
   is not a task score. A verified adapter is needed for each Callisto backend.

Record task success, unsupported cases, input/cache/output usage, model requests
when actually supplied by the host, MCP calls, underlying browser commands,
median/tail latency, startup time and resource use. Keep failures and missing
usage visible. Use paired uncertainty estimates and publish ties/regressions.
Run one change at a time, including compact/full and observation-size ablations.

The goal should be equal-or-better completion with lower task cost on a defined
held-out suite. A universal win over every benchmark, host, browser and budget
cannot be promised. Firefox/Zen support is a product differentiator and needs
its own results rather than being credited from a Chromium-only run.

## First implementation recommendation

Start with one consistent operation/step contract, actionable pre-dispatch
validation, and an OpenCode-native composition profile. Then improve action
feedback and observation defaults. These target measured mistakes and repeated
reads before adding a new general executor or another abstraction layer.

## Sources

- [browse 0.1.1 tool selection](https://github.com/anomalyco/browse/blob/v0.1.1/rust/crates/browse-relay/src/surface.rs)
- [OpenCode composition instructions](https://github.com/anomalyco/browse/blob/v0.1.1/rust/crates/browse-relay/src/instructions.md)
- [Page schemas and action feedback](https://github.com/anomalyco/browse/blob/v0.1.1/rust/crates/browse-page/src/tools.rs)
- [Tab/lifecycle contracts](https://github.com/anomalyco/browse/blob/v0.1.1/rust/crates/browse-relay/src/tools.rs)
- [0.1.1 changes](https://github.com/anomalyco/browse/blob/v0.1.1/changelog/0.1.1.md)
- [BrowserGym](https://github.com/ServiceNow/BrowserGym)
- [WebArena](https://github.com/web-arena-x/webarena)
- Local implementation: `packages/firefox-rs/src/tool_catalog.rs`,
  `packages/firefox-rs/src/tab_mcp.rs`, `packages/firefox-rs/extension/content.js`.
- [Luna raw data, correction audit, sources and report](../eval/reports/luna-real-world-2026-11-17/README.md).
