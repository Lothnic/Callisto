# Callisto MCP vs browse

**2026-11-11.** A direct MCP comparison from one scripted Node host, without a model API. This measures tool behavior on a small set of fixtures and public pages; it is not an autonomous-agent success or token-cost benchmark. Raw records: [local, 3-second browse timeout](./2026-11-mcp-comparison-results.json), [local, 10-second browse timeout](./2026-11-mcp-comparison-long-timeout.json), [batched form](./2026-11-mcp-batching-results.json), and [public pages](./2026-11-mcp-live-comparison.json).

## Environment

Callisto MCP uses `@callisto/mini` from this working tree, headless Chrome for Testing 150.0.7871.46, viewport 1440×900, with an isolated browser. Browse 0.0.16 used the connected user's Chromium, reporting Chrome 157, with human-like input enabled, a temporary session and an origin allowlist. Both were called by the same MCP SDK client over stdio. Callisto's browser starts lazily; browse's browser and relay were already running. Task order alternated. No model API key was supplied. Different browser versions, profile state, implementation guarantees, display modes and input pacing limit comparisons.

## Local fixtures

Three trials per case, using synthetic local pages. The 10-second browse action timeout gives it a chance to finish delayed actions; Callisto's ref actions use their 2-second default. Times are medians of successful complete host-driven workflows, including navigation and MCP calls. They exclude model reasoning. A case can pass while still doing less checking than the other engine.

| Fixture | Callisto success | Callisto median | browse success | browse median |
|---|---:|---:|---:|---:|
| Snapshot and find control | 3/3 | 23 ms | 3/3 | 95 ms |
| Fill and submit form | 3/3 | 184 ms | 3/3 | 2,625 ms |
| Wait for disabled button | 3/3 | 1,309 ms | 3/3 | 3,916 ms |
| Wait for overlay to clear | 3/3 | 1,302 ms | 3/3 | 3,597 ms |
| Click button inside iframe | 0/3 | — | 3/3 | 2,946 ms |
| Follow a link | 3/3 | 127 ms | 3/3 | 833 ms |

The Callisto iframe failures explicitly reported that iframe actionability is unsupported. With browse limited to a **3-second** action timeout, it failed all three delayed-button and all three overlay trials; a follow-up using a 10-second timeout passed all six. A separate probe completed the delayed click in about 3.6 seconds at a 10-second limit. This is a result in this environment, not proof of the cause or a general browser-speed claim.

The scripted form comparison deliberately used three MCP calls for both engines. Browse can instead navigate, fill and click in **one** `execute` call. In three additional successful fixed-form trials, Callisto used three calls (median 191 ms, first trial included cold launch) and browse used one (median 2,492 ms). Fewer host calls could matter when an agent must decide between calls, but this experiment did not include an LLM and cannot measure that effect.

## Public-page native snapshots

One trial per page; expected text was checked case-insensitively in the returned snapshot, with no LLM or answer generation. Snapshot character counts are not tokens. Public pages can change, and profiles/browser versions differ.

| Page | Callisto: expected text, snapshot chars | browse: expected text, snapshot chars |
|---|---:|---:|
| example.com | yes, 1,003 | yes, 916 |
| RFC 9110 | yes, 585,003 | yes, 3,101 |
| IANA reserved domains | yes, 4,751 | yes, 2,770 |
| Project Gutenberg | yes, 5,254 | yes, 4,237 |
| Ada Lovelace Wikipedia | yes, 196,756 | no, 3,798 |
| MDN HTTP | yes, 20,706 | yes, 7,532 |

On RFC 9110, Callisto returned a very large tree; even though it contained the target text, an agent or client may have limited context. On Wikipedia, browse's default compact snapshot did not contain `1815`; a follow-up using its page text API found the birth year on the same page. This is a limitation of that default snapshot, not evidence that browse cannot complete the task. The public-page test uses one expected string per page; it does not measure complete coverage or task success.

## Interface and product comparison

| | Callisto MCP | browse |
|---|---|---|
| Integration | 8 structured tools, one isolated browser per server | JavaScript `execute` plus session and management tools |
| Agent actions | Refs, separate tool calls; no general JS execution | Composable Playwright JS in `execute` |
| Existing user browser | No | Yes, through its extension |
| Auth / handoff | Fresh isolated session; no handoff | Existing profile and human handoff |
| Iframe actions | Ref action currently fails closed | Frame locator succeeded in this fixture |
| Page observation | Full pruned tree; can be extremely large | Compact snapshot; can omit needed text, with other access methods available |

No performance or security superiority is established. The immediate evidence-backed priorities are frame-aware actionability, bounded and navigable snapshots that retain relevant text, and a composable interface that reduces host round trips. Then run repeated agent-driven tasks with the same host and matched site state, measure outcomes and actual host turns, and compare browse's fast-input option in a separately authorized configuration.

## Reproduce

From the repository root, install and build `packages/mini`, start a paired browse browser, set `CHROME_PATH` and, only if needed, `CALLISTO_NO_SANDBOX=1`. Run `node eval/agent-comparison/mcp-compare.mjs`, `node eval/agent-comparison/mcp-batching.mjs`, and `node eval/agent-comparison/mcp-live.mjs`. The scripts use local or public pages, create and delete their own browse sessions and do not use a model API. For the longer timeout set `BROWSE_ACTION_TIMEOUT_MS=10000` and a distinct `BENCH_OUTPUT` path. The tools may use your browser's existing session state on public sites. Inspect outputs before sharing.
