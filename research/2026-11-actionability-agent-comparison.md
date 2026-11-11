# Actionability and local model-driven comparison

**2026-11-11.** An exploratory, single-trial comparison on three local fixtures. Raw action traces and token counts: [Mini and Playwright](./2026-11-mini-playwright-agent-openrouter-results.json); [browse](./2026-11-browse-agent-openrouter-results.json). A prior partial SiliconFlow run is retained [here](./2026-11-mini-playwright-agent-results.json): it stopped receiving useful responses after HTTP 402 and must not be treated as a completed comparison.

The completed run used OpenRouter's `meta-llama/llama-4-scout-17b-16e-instruct`, identical task instructions, JSON action policy, DOM-derived observations, temperature and limits. Each engine got a fresh local fixture for each task. Mini and Playwright ran in separate headless Chrome 150 instances. browse ran separately through its connected browser and CLI, with a temporary session restricted to the fixture origin. Thus timing also reflects different browser environments, CLI overhead, provider latency and sequential execution. One run is not a ranking.

| Task | Mini | Playwright | browse |
|---|---|---|---|
| Click Confirm | pass, 2 model calls | pass, 2 | pass, 2 |
| Fill and save | pass, 3 | pass, 3 | pass, 5 |
| Wait for enabled button and click | pass, 3 | pass, 3 | pass, 4 |

browse timed out once on Save and once on Continue, and the model recovered on a subsequent attempt. The cause has not been established. No conclusion about comparative reliability, cost or speed should be drawn from one trial. These are synthetic action-tool tasks: the same simplified observation is supplied to all engines, rather than their native agent interfaces, so it does not measure browse's or Mini's perception system. No live sites, account state, human handoff, screenshots or real consumer workflows were tested. Provider usage is recorded; no verified USD pricing was collected.

The actionability integration fixture separately tests permanently disabled, covered and continuously moving elements and checks that no unintended click occurs; it also tests read-only inputs and delayed transitions into an actionable state. The implementation checks visibility, disabled/inert state, input editability, stable geometry sampled across time and hit testing before ref-based actions. It does not provide full Playwright parity: ref-based actions inside iframes fail closed, coordinate actions bypass the checks, and races remain possible between check and input. More fixtures are needed for shadow DOM, nested frames, controls changing between checks, duplicate targets, transient overlays and framework-specific inputs.

To reproduce, see [the agent comparison instructions](../eval/agent-comparison/README.md) and run `tests/actionability.test.ts` with `CALLISTO_SMOKE=1`, `CHROME_PATH` and, if needed, `CALLISTO_NO_SANDBOX=1`. Never include credentials in benchmark outputs.
