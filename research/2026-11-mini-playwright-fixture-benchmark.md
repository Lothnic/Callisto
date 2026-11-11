# Mini vs Playwright: local fixture benchmark

**2026-11-11.** Exploratory engine microbenchmark, not a browser-agent benchmark. Run with Chrome for Testing 150.0.7871.46, Playwright 1.65.0, Node 26.5.0, headless, 1440×900, one warm browser per engine, 10 repetitions, alternating engine order. The raw data and per-trial outcomes are in [the JSON results](./2026-11-mini-playwright-fixture-results.json). Both engines used the same local HTML fixture and Chrome binary; their browser launch flags and action semantics differ.

| Fixture operation | Mini success | Mini median | Playwright success | Playwright median |
|---|---:|---:|---:|---:|
| Navigate | 10/10 | 13.22 ms | 10/10 | 15.94 ms |
| Fill and submit form | 10/10 | 35.58 ms | 10/10 | 67.26 ms |
| Select all and type | 10/10 | 17.38 ms | 10/10 | 10.67 ms |
| Click an offscreen button | 10/10 | 15.16 ms | 10/10 | 38.43 ms |
| Snapshot / ARIA snapshot | 10/10 | 2.65 ms | 10/10 | 6.35 ms |
| Delayed button | 10/10 | 147.07 ms | 10/10 | 227.73 ms |
| Reject ambiguous target | 10/10 | 23.57 ms | 10/10 | 49.92 ms |

Timing includes operation-specific assertions. Form and keyboard timings for Mini include explicit snapshot calls as well as its locator refresh; Playwright uses its own locators. The snapshot row compares different outputs, and only Mini's snapshot is checked for the redaction marker. Mini does not implement Playwright's full visibility, stability, enabled, event-receiving and editable checks, so these timings do **not** demonstrate equivalent reliability. Runs are warm and sequential; there are no live websites, LLM calls, model tokens, costs, confidence intervals, authentication, cold-start measurements or cross-machine trials. Ten samples are insufficient for a general performance claim.

Reproduce from `packages/mini` after `npm ci`:

```sh
CHROME_PATH=/path/to/chrome BENCH_REPETITIONS=10 BENCH_OUTPUT=/tmp/callisto-results.json npm run benchmark:playwright
```

On environments that require it, explicitly set `CALLISTO_NO_SANDBOX=1`. The script runs both engines locally on a server bound to loopback. Inspect failed trials in the JSON, not just successful-operation medians.

Next evaluation: add actionability and delayed/disabled/covered/animating fixtures, frame and SPA navigation cases, more keyboards and framework-controlled inputs; then test multiple real sites with the same agent and model. Compare end-to-end success, errors, turns, time and cost, with identical or explicitly controlled observation and setup. This benchmark does not compare browse.
