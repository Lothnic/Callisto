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

## Re-run with `callisto_run` / `callisto_extract` — 2026-11-13

Round 2 re-ran only the two Callisto backends, serially, on the same fixture
and the same scoring path. Both backends now expose two additional tools:
`callisto_extract` (typed rows from a CSS row selector plus field map, with
optional next-page pagination) and `callisto_run` (up to 40 dependent steps:
navigate, click/fill by ref or exact role, press, scroll, wait, wait-for-text,
extract). Answers below are the same agent, model family and task text, evaluated
by the same `AgentResponseEvaluator` wrapper.

| Task | Intent | Chromium (round 1) | Zen (round 1) | Chromium (round 2) | Zen (round 2) |
| --- | --- | --- | --- | --- | --- |
| 11 | Reviews mentioning "disappointed" | 1 (8) | 1 (19) | 1 (1) | 1 (1) |
| 41 | Top search term | 1 (1) | 1 (3) | 1 (1) | 1 (1) |
| 62 | Customer with most completed orders | 0 (9) | 0 (15) | 1 (6) | 1 (7) |
| 94 | Grand total of invoice 000000001 | 1 (5) | 1 (6) | 1 (1) | 1 (1) |
| 107 | Monthly completed orders, May–Dec 2022 | 1 (9) | 0 (10) | 1 (0) | 1 (0) |
| 112 | Customers rating Circe fleece ≤ 3 stars | 1 (23) | 1 (13) | 1 (3) | 1 (3) |
| 183 | SKUs with 10 units left | 0 (10) | 0 (16) | 0 (3) | 0 (1) |
| 193 | Total payment of last 2 completed orders | 0 (19) | 1 (6) | 1 (0) | 1 (0) |
| 198 | Email of most recent cancelled order | 1 (9) | 1 (7) | 1 (2) | 1 (11) |
| 208 | Customer name and email for a phone number | 1 (8) | 1 (6) | 1 (1) | 1 (0) |
| **Score** | | **7/10** | **7/10** | **9/10** | **9/10** |
| **Tool calls** | | 101 | 101 | 18 (+2 setup, +8 wasted) | 25 (+5 reconnect) |

### What round 2 does and does not show

- Both Callisto backends fixed the two round-1 failures that were tooling
  limits (62 Jane Smith disambiguation via the `Customer Email` grid column,
  and 107/193 by one paginated orders extraction reused across tasks). Task 183
  is still unsolved on both — the fixture exposes no products with exactly
  10 units (quantities observed: 0, 3, 4, 14, 100), and the low-stock report
  filtered to qty 10 returns no records. That is consistent with all four
  runtimes failing it, but it is also unverified by more than one agent policy.
- `callisto_run`/`callisto_extract` cut Chromium's task-call count from 101 to
  18 and Zen's from 101 to 25. Most of the savings come from batched grid
  extraction, not from any single trick.
- **Zen T198 cost 11 calls**: the Magento filter combobox clicks were flaky in
  Zen (`Target is moving`, retry-then-fallback) and the agent fell back to a
  Clear-all + single paginated extraction of all 308 orders. Chromium completed
  the identical task in 2 calls. The same input-stability problem, not the
  answer, is the cost driver.
- Zen rendered the Magento virtual-scroll grid only when its window was in the
  foreground; a background Zen window shows headers and no rows. This delayed
  and complicated the run but is a real product limitation to fix, not hide.
- Zen's extension in the benchmark profile was stale; the Downloads copy
  (`~/Downloads/Callisto-Zen-Extension`) was synced from the repo and reloaded.
  A backup was taken (`*.bak-20261113`).
- The browser tests share the admin user's persisted Magento grid state, which
  this run left as "Complete + Customer Email" (Chromium set it; Zen cleared to
  unfiltered at the end for the all-orders extraction). Later runs start from
  that state, not a pristine one.
- setup/reconnect calls are reported separately, not folded into per-task
  counts; Chromium also made 8 non-scoring calls working around the persisted
  grid state (failed filter URL attempts, stale refs). Those are disclosed for
  transparency but, per AGENTS.md/reporting norms, not hidden.
- Task-call counts are an agent-policy outcome as much as a runtime outcome:
  round 1 and round 2 used different policies. Comparing 18/25 calls against
  browse's 44 is fair only as "same agent policy per tool," not as a controlled
  A/B. The scores are the meaningful invariant here.
- The runs overlap against one fixture on one machine; timings were not
  compared in either round.

`responses-chromium-run2.json` / `responses-zen-run2.json` contain the round-2
answers and evidence; `scores-*-run2.json` contain the evaluator verdicts.

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
`responses-*-run2.json` and `scores-*-run2.json` are the round-2 equivalents
for `callisto_run`/`callisto_extract` (see the round-2 section above).