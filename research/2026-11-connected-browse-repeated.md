# Connected Callisto and browse: local fixture comparison

Three scripted trials per scenario were run with Callisto connected to the same paired browser used by browse, using separate session-owned tabs and explicit localhost allowlists. No model or autonomous agent was involved. Callisto uses Mini for snapshots and actionability checks and delegates navigation and input to browse's Patchright-backed executor; the two entries are therefore not independent browser engines. See the [raw results](2026-11-connected-browse-repeated-results.json) for per-trial timing, errors, output sizes, and tool schemas.

The run preceded the subsequent change that prevents ref identifiers from
being reused after navigation; it does not measure that final source state.

| Scenario | Callisto | browse |
| --- | ---: | ---: |
| Snapshot | 3/3 | 3/3 |
| Form input and submit | 3/3 | 3/3 |
| Initially disabled button | 1/3 | 1/3 |
| Initially covered button | 2/3 | 1/3 |
| Same-origin iframe | 3/3 | 3/3 |
| Link navigation | 3/3 | 3/3 |

The disabled and covered fixtures rely on timers to clear their conditions. In failed runs the condition had not cleared before the respective action timeout (Callisto 2 seconds, browse 3 seconds). The reasons for the variable timing have not been established; browser background scheduling is a hypothesis, not a demonstrated cause. The different timeouts, single machine and three trials make this unsuitable for ranking the products or asserting reliability. Neither handoff completion nor toolbar takeover was measured by this script.

A first temporary-tab handoff timed out without an acknowledgement. In a later
manual run, a person clicked Continue in the browse banner, the Mini handoff
returned successfully, and a subsequent snapshot confirmed the same temporary
fixture tab remained available. This was one Mini API handoff, not an MCP-host
or authenticated-workflow test.

A follow-up single-page probe observed a 1.2-second timer firing while the Callisto-owned tab reported `document.visibilityState` as `hidden`. This shows that a hidden tab alone does not explain every outcome; it does not identify the cause of the intermittent comparison failures.
