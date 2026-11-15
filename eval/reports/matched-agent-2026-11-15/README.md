# Matched agent pilot — blocked by model access

Both configured providers returned HTTP 402 for insufficient credit before any
agent tool call. No valid task-success, latency, token-cost or browse comparison
can be concluded. These attempts are infrastructure errors, not failed browser
tasks. Provider-account details were omitted from public errors.

- [OpenRouter Hy3 attempt](results.json)
- [SiliconFlow Hy3 attempt](../matched-agent-2026-11-15-siliconflow-blocked/results.json)

The harness uses the same model, task instructions, budgets and task set for
both native MCP interfaces, with independent owned Zen and Chromium profiles.
Tool catalogs and differences are saved in the report. Setup/navigation and
evaluator calls are excluded from task measurements. Each successful model
response must supply real usage. The pilot needs funded model access before
its task results can be evaluated.

Run `BENCH_OUTPUT_DIR=/tmp/new-matched-run BENCH_PROVIDER=openrouter xvfb-run -a node eval/agent-comparison/matched-agent.mjs`
with the existing configured provider funded, or use `siliconflow`. No credentials
are stored in these reports. Listed dollar estimates are uncached list-price
estimates, not invoices; a returned provider cost is recorded separately.
