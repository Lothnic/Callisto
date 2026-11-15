# Initial host-agent pilot

This is the first complete run through the signed-in Codex host, before the
fixture explicitly reacquired the intended visible tab for every task. It used
`gpt-6.1-sol` at high effort, native MCP tools and one paired trial of four local
tasks. Host usage and visible tool traces are retained in full.

Callisto completed form, table and inventory tasks. Its frame/shadow-root input
was refused because the document reported it was not visible. Browse completed
all four. This failure is retained; it was not relabelled or removed to improve
the result.

A smaller setup regression reproduced an active-tab refusal after a different
owned tab became active. WebDriver navigation alone did not establish the
extension's active-tab/sharing lease. The fixture now explicitly reacquires its
original owned tab and native input before each measured task. The visibility
guard remains unchanged. That regression passes on Zen and Firefox.

The [separate corrected run](../host-agent-2026-11-15/README.md) uses that setup
precondition. These are different runs, not a claim that the failed task succeeded
in this original trace. The base revision and dirty working-tree status are
recorded in [results.json](results.json); the first run predates the committed
host adapter.
