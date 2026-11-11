# Research and comparisons

These notes record evidence and experiments, not product specifications.
Callisto's current direction is the [browser-runtime roadmap](../roadmap.md).

| Note | Scope | Status |
| --- | --- | --- |
| [Runtime upgrade comparison](2026-11-runtime-upgrade-comparison.md) | Follow-up local MCP fixtures, batching and public-page snapshots | Current exploratory run; small sample |
| [Stripped Playwright assessment](2026-11-stripped-playwright-browse-assessment.md) | Product hypothesis, primary sources and proposed comparisons | Context; conclusions remain hypotheses |
| [Callisto MCP vs browse](2026-11-callisto-mcp-vs-browse.md) | Scripted MCP fixtures and public-page snapshots | Historical pre-upgrade baseline; see raw results |
| [Mini vs Playwright fixture benchmark](2026-11-mini-playwright-fixture-benchmark.md) | Controlled fixture timings | Historical baseline, not an agent benchmark |
| [Actionability and model-driven comparison](2026-11-actionability-agent-comparison.md) | Local agent fixtures and actionability | Exploratory, few trials |
| [Live-site comparison](2026-11-live-browser-comparison.md) | Native snapshots and model-generated answers | Inconclusive; provider and model limits |
| [Browser-agent landscape and positioning](2026-11-browser-agent-landscape-and-callisto-positioning.md) | Earlier research and proposed scoreboard pivot | Historical; product recommendation superseded |

Raw JSON artifacts are linked from the relevant notes. Several include captured
public-page snapshots and model output; review before sharing or redistributing.
The old comparisons reflect the code and environment at the time and must not be
presented as results for the current runtime.

Current open questions include cross-origin iframe behavior, snapshot coverage
under a bounded context budget, real host-agent task success, attachment to an
existing browser, and whether the custom CDP backend outperforms a
Playwright-backed interface on meaningful tasks.
