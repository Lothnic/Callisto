# Local model-driven engine comparison

The runner uses the same model, prompt, observations and action schema for Mini, Playwright and optionally browse on three resettable local fixtures. It records actions, success, elapsed time and token usage. It is a small exploratory test, not a live-site, security or representative production benchmark. The shared, scripted DOM observation bypasses each product's native snapshot format. It does not persist or print the API key. The prompt and fixture contain no personal data.

From the repository root, build Mini and run with `CHROME_PATH` set to a local Chrome for Testing binary:

```sh
npm --prefix packages/mini run build
CHROME_PATH=/path/to/chrome BENCH_OUTPUT=/tmp/agent-results.json node eval/agent-comparison/run.mjs
```

The `playwright-core` dev dependency is resolved from `packages/mini/node_modules`; run `npm ci` there first. The runner reads `SILICONFLOW_KEY` from the environment or repo `.env`, and accepts `BENCH_MODEL`. Set `BENCH_PROVIDER=openrouter` to use `OPENROUTER_API_KEY`. It makes up to six model requests per engine per task and uses a single trial. `CALLISTO_NO_SANDBOX=1` is an explicit opt-in for hosts that need it.

Set `BENCH_ENGINES=mini,playwright,browse` to include browse. It needs a paired and connected extension and runs in a temporary, origin-limited session, which is deleted at the end. Browse runs in the user's browser, not the same isolated browser binary, and CLI startup is included in timing.

## Persistent Zen sessions and a matched native-tool pilot

- `session-recovery.mjs`: dedicated persistent Zen/Firefox profiles, explicit
  crash/restart tests, saved pairing and fail-closed input intent. Set
  `CALLISTO_TEST_BROWSER=firefox` for Firefox and `RECOVERY_OUTPUT` for a report.
- `observation-efficiency.mjs`: one synthetic inventory, bounded/full/targeted/diff
  observations, byte counts, content coverage and real runtime trace counters.
  `OBSERVATION_OUTPUT` must name a new directory. No model is called.
- `matched-agent.mjs`: identical model, task instructions and budget across native
  Zen and browse MCP interfaces. Uses independent owned test profiles and saves
  catalogs, visible tool transcripts, provider token usage and task-state checks.
  Run under Xvfb, set a new `BENCH_OUTPUT_DIR`, choose `BENCH_PROVIDER=siliconflow`
  or `openrouter`, and use an already configured funded credential. Never commit
  credentials. Defaults to two alternating-order trials of four local tasks.

The model harness has a shared 100-request/250,000-token safety budget. Dollar
estimates use a documented uncached list price, not an invoice; returned provider
cost is recorded separately. A provider failure stops the run with exit code 2
and infrastructure-error metadata, never an invented browser-task score. Different
native catalogs and observations are retained and disclosed rather than silently
normalized. Setup, task navigation and evaluator calls are excluded from measured
agent work. None of the fixtures attaches to a person's existing browser.
