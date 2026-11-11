# Runtime upgrade: follow-up MCP comparison

**2026-11-11.** Scripted host-driven MCP calls, not autonomous agent tasks. This
is a follow-up to the [earlier baseline](2026-11-callisto-mcp-vs-browse.md).
Both tools used the same fixture server and MCP client. Callisto ran headless
Chrome for Testing 150 with an isolated profile; browse 0.0.16 used the
connected Chromium 157 profile with human-like input enabled. Browse's action
timeout was 10 seconds; Callisto's default was 2 seconds. Three trials per
fixture, alternating order. Results are not comparable claims about end-to-end
agent performance or a controlled browser-backend ablation.

| Fixture | Callisto success / median | browse success / median |
| --- | ---: | ---: |
| Snapshot | 3/3 · 24 ms | 3/3 · 94 ms |
| Fill and submit | 3/3 · 161 ms | 3/3 · 1,594 ms |
| Disabled button | 3/3 · 1,295 ms | 3/3 · 3,990 ms |
| Covered button | 3/3 · 1,303 ms | 3/3 · 3,615 ms |
| Same-origin iframe button | 3/3 · 101 ms | 3/3 · 2,951 ms |
| Follow link | 3/3 · 112 ms | 3/3 · 769 ms |

The same-origin iframe fixture previously failed all three Callisto trials.
This does not establish cross-origin or nested frame parity. Timings include
navigation and tool calls; medians hide the cold first launch. See the
[per-trial records](2026-11-mcp-comparison-updated.json).

Both interfaces also completed a scripted form workflow in one MCP call in all
three trials: Callisto with structured `callisto_batch`, browse with JavaScript
`execute`. Callisto's median was 162 ms and browse's 2,348 ms, with the same
browser/profile and pacing caveats. These are not model-turn or cost figures.
[Batch records](2026-11-mcp-batching-updated.json).

On six public pages (one trial each), the first bounded snapshot contained the
chosen expected text on 5/6 pages for each interface. Callisto's RFC 9110 text
was outside the 12,000-character first page but found via `callisto_find`;
browse's compact Wikipedia snapshot omitted the chosen birth year but its page
text API found it. Each fallback adds a tool call and browser work. One expected
string is not a coverage metric, and live pages and sessions can differ.
[Public-page records](2026-11-mcp-live-updated.json).

For reproduction and limitations see [BENCHMARKS.md](../BENCHMARKS.md). Raw
output and page observations can change. The relevant upgrade tests cover
same-origin frame interaction and parent overlay rejection, bounded MCP output,
pagination, full-tree search and a multi-action batch; broader frame, action
race, snapshot coverage, authentication, and multi-agent cases remain open.
