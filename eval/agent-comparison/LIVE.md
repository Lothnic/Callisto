# Live read-only agent comparison

The runner compares Mini, Playwright and browse on 11 predefined public-site questions. Each tool supplies its native snapshot to the same model. The model may answer or click a link; links are checked against a fixed HTTPS hostname allowlist and sensitive account/action names are rejected. Browse requires its paired extension to be connected and uses a temporary origin-allowlisted session which the script deletes. The connected browser's normal profile is used, so browser state differs from the isolated Mini and Playwright sessions.

Install Mini's dependencies, configure `OPENROUTER_API_KEY` in the environment or the repository `.env`, and set a Chrome for Testing binary. This sends public page snapshots to the model provider and can incur model charges.

```sh
npm --prefix packages/mini ci
npm --prefix packages/mini run build
CHROME_PATH=/path/to/chrome \
BENCH_MODEL=liquid/lfm-2.5-2.6b:free \
BENCH_MAX_OUTPUT_TOKENS=1200 \
BENCH_OUTPUT=research/my-live-results.json \
node eval/agent-comparison/live.mjs
```

Use `CALLISTO_NO_SANDBOX=1` only on hosts where required. `BENCH_ENGINES=mini,playwright,browse` selects engines; use the same list, model and configuration across comparable trials. Results are incrementally saved to the output file. They include page snapshots and model responses; review them before sharing. Read [the initial report](../../research/2026-11-live-browser-comparison.md) for scoring and caveats. External pages can change, disappear, or block browsers. All live results need independent review before drawing conclusions.
