# Live-site browser-agent comparison

**Run date:** 2026-11-11. This is an exploratory comparison, not a conclusive ranking. The user asked for 10–20 read-only tasks; the suite has 11 questions on public pages, including one that requires following a link. Each task was attempted once per engine, in rotating order.

## Method

Mini and Playwright ran in separate headless Chrome for Testing 150.0.7871.46 sessions, 1440×900. Playwright was 1.65.0. browse was version 0.0.16, connected to the user's existing Chromium browser, in a temporary origin-allowlisted session; it was a different browser environment and included CLI overhead. We did not test authentication or personal pages. The benchmark asked a model to answer from each product's **native snapshot**, or click a permitted link. It capped each observation at 12,000 characters and allowed at most three turns. It used an identical prompt, question, model and output limit within each run. The automated strict pass required a matching answer, an exact short quote verifiable in a captured snapshot, and a successful link action for the navigation task. Captured snapshots, answers, model token counts, errors and action traces are in the raw JSON files. An exact-quote mismatch may be a model formatting error even when the answer is correct.

The first run used `meta-llama/llama-4-scout-17b-16e-instruct` via OpenRouter with a 300-token output limit. Credits ran out. [Raw paid-model results](./2026-11-live-comparison-results.json):

| Engine | Strict pass / 11 | Correct answer / 11 | HTTP 402 provider failures | Invalid model JSON |
|---|---:|---:|---:|---:|
| Mini | 7 | 8 | 2 | 0 |
| Playwright | 7 | 7 | 3 | 1 |
| browse | 6 | 7 | 2 | 1 |

The second run used `liquid/lfm-2.5-2.6b:free`, also with a 300-token output limit. It reached all 33 engine–task combinations, but many responses were empty or truncated at the output cap. [Raw free-model results](./2026-11-live-comparison-liquid-results.json):

| Engine | Strict pass / 11 | Correct answer / 11 | Invalid model JSON |
|---|---:|---:|---:|
| Mini | 4 | 5 | 6 |
| Playwright | 4 | 6 | 5 |
| browse | 3 | 3 | 8 |

These outcomes mix browser behavior, snapshots, model behavior and scorer strictness; they cannot support a ranking. In particular, the 300-token cap was inadequate for the free model. The link-following task did not complete successfully in either run, so the suite does not establish real-site multi-step reliability. A third free model was stopped after four trials because its entire output budget was consumed without usable responses; its incomplete [raw results](./2026-11-live-comparison-free-results.json) are retained for audit.

## Useful observations

- In the paid-model run, browse answered RFC 9110's title correctly but its quote joined two separate heading nodes; it failed the exact quote check. Mini answered HTTP/1.1 instead. Mini's 12,000-character snapshot was dominated by links before the title, which is a concrete reason to inspect and improve ordering and coverage; it does not isolate the cause of the wrong answer.
- Median **capped snapshot characters** over the 11 tasks were 7,418 for Mini, 12,000 for Playwright and 3,101 for browse. This is not a token count or a fair measure of information density: some observations hit the 12,000-character cap and the formats and logged-in browser states differ. Compact output can hide useful material.
- Each paid-model engine completed 11 browser navigations and produced snapshots, but model credit failures prevented full scoring. Task answers, not just process navigation, need more repetitions and stronger tasks.
- These tests involve live dynamic public pages and one model trial per engine. They have no confidence intervals, cold-start comparison, cost-per-success, controlled site state, human review of every quote, screenshot fallback, authentication or general security testing. The three short local model-driven tasks from [the earlier report](./2026-11-actionability-agent-comparison.md) are separate and should not be combined with these outcomes.

## Reproduce

See [live benchmark instructions](../eval/agent-comparison/LIVE.md). The runner now defaults to a 1,200-token output budget for future runs to reduce the observed truncation; both result files above were produced with 300, so reruns are a different experiment. The same task/model/limit must be used for all entrants in a run. Do not put API keys into results.

## Next experiment

Run repeated, counterbalanced trials with a model and account that can complete the full suite, a sufficient output budget, and a stricter task set with independent reference answers and human-reviewed evidence. Add multi-step navigation and local fixture tasks with observable outcomes; preserve provider and setup failures separately. Do not claim Mini is better than Playwright or browse from these runs.
