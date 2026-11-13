# WebArena Verified comparison — 2026-11-13

Ten Shopping Admin retrieval tasks from [WebArena Verified](https://servicenow.github.io/webarena-verified/latest/),
run against four browser runtimes by subagents using the same task text, the same
local fixture site and the official answer evaluator.

| Runtime | Version / mode |
| --- | --- |
| Callisto Chromium (`packages/mini`) | isolated headless Chromium, CDP input |
| Callisto Zen (`callisto-firefox-tab-mcp`) | user's Zen profile via the extension bridge, synthetic DOM input |
| OpenCode `browse` | its paired Chromium profile and relay |
| Vercel `agent-browser` | its own headless Chromium profile |

All tasks are read-only (`RETRIEVE`) and scored by `AgentResponseEvaluator`. Every
answer was checked by the official evaluator, not by the agent's own success claim.

## Results

Official evaluator score, with MCP/tool calls in parentheses. A cell of `0` means
the evaluator rejected the submitted answer.

| Task | Intent | Chromium | Zen | browse | agent-browser |
| --- | --- | --- | --- | --- | --- |
| 11 | Reviews mentioning "disappointed" | 1 (8) | 1 (19) | 1 (9) | 1 (14) |
| 41 | Top search term | 1 (1) | 1 (3) | 1 (1) | 1 (3) |
| 62 | Customer with most completed orders | 0 (9) | 0 (15) | 1 (13) | 0 (33) |
| 94 | Grand total of invoice 000000001 | 1 (5) | 1 (6) | 1 (4) | 1 (10) |
| 107 | Monthly completed orders, May–Dec 2022 | 1 (9) | 0 (10) | 1 (1) | 1 (21) |
| 112 | Customers rating Circe fleece ≤ 3 stars | 1 (23) | 1 (13) | 1 (8) | 1 (45) |
| 183 | SKUs with 10 units left | 0 (10) | 0 (16) | 0 (3) | 0 (21) |
| 193 | Total payment of last 2 completed orders | 0 (19) | 1 (6) | 1 (1) | 0 (16) |
| 198 | Email of most recent cancelled order | 1 (9) | 1 (7) | 1 (1) | 1 (25) |
| 208 | Customer name and email for a phone number | 1 (8) | 1 (6) | 1 (3) | 1 (25) |
| **Score** | | **7/10** | **7/10** | **9/10** | **7/10** |
| **Tool calls** | | 101 | 101 | 44 | 213 |

Task 183 failed for all four runtimes: none reported the product SKUs the
evaluator expected.

### What this does and does not show

- **browse scored highest** on this subset and used the fewest calls. Its
  `execute` batching lets one call cover several UI steps, which is also why its
  call counts are not directly comparable to one-action-per-call runtimes.
- **Chromium and Zen tied on score** with identical total call counts, but they
  failed different tasks: Chromium missed 62, 183 and 193; Zen missed 62, 107 and
  183. A ten-task subset is too small to separate them.
- **agent-browser tied on score but used about twice as many calls** and exceeded
  a 20-call budget on six tasks.
- The runs **overlapped on one machine against one shared fixture container**, so
  the recorded times are not a fair speed comparison. Reliable `elapsed_ms` was
  captured only for browse (262 s total); the other runtimes recorded `null`.
  These results measure task completion, not per-operation latency.
- The agents came from the same host and model family, but each runtime surfaces
  a different action vocabulary, so the number of calls reflects interface design
  as much as browser speed.
- Zen needed the user to bring its benchmark tab into view mid-run; that is a
  real limitation of the current extension path, and it counted against Zen.
- This is **not** a WebArena Verified leaderboard entry, not a statistically
  meaningful sample, and not evidence that Rust is faster than JavaScript.
  A single-site, ten-task, one-attempt run cannot support those claims.

## Reproducing

`tasks.json` holds the ten task intents, start URLs and expected result schemas.
Reference answers are deliberately **not** included. `evaluate.py` refuses to
score any task that is not answer-only, so this subset cannot silently stand in
for network-evaluated tasks.

```
uvx webarena-verified agent-input-get --task-ids 11,41,62,94,107,112,183,193,198,208 \
  --config <config> --output tasks.json
uv run --isolated --no-project --python 3.12 --with webarena-verified==1.2.3 \
  python evaluate.py <runtime>
```

Environment: WebArena Verified CLI 1.2.3, Shopping Admin image
`am1n3e/webarena-verified-shopping_admin@sha256:d0531dd27ed98d0c459ff9e88118bf2ed8b660b0ed99c38837db46c065a5be13`,
container limited to 3 GiB and 2 CPUs on loopback only. The container was removed
after the run. HAR traces were captured during the runs but are not committed
because they contain fixture session data.

`responses-*.json` contains each runtime's submitted answers and evidence;
`scores-*.json` contains the official evaluator verdict per task.