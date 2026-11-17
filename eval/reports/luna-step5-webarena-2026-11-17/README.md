# Official WebArena Verified retrieval subset

Completed 6/6 planned model trials. Model request: `gpt-6-luna`, `high`. Raw answers, tool calls and usage are retained.

| Metric | Callisto / Zen | Browse / Chromium |
| --- | ---: | ---: |
| Strict task passes | 3 | 3 |
| Attempts | 3 | 3 |
| Mean task time, all attempts | 40.0 s | 49.3 s |
| Median task time, all attempts | 34.2 s | 55.1 s |
| Sample p95 (small sample) | 62.9 s | 65.0 s |
| Input including cache | 420,551 | 680,129 |
| Uncached input | 125,127 | 143,681 |
| Output including reasoning | 2,052 | 2,878 |
| Host MCP calls | 18 | 26 |
| Failed calls | 0 | 2 |
| Returned UTF-8 bytes | 52,831 | 126,473 |
| Contract-help calls | 0 | 0 |
| Uncached input per strict success | 41,709 | 47,894 |

All attempts remain in the table, including failed tasks. MCP calls include help and composed actions; they are not underlying browser-command counts or model-request counts. Cached input, output/reasoning and returned bytes remain separate. Billed dollar cost is unavailable.

3 complete pairs; 3 succeeded strictly on both engines. 3 successful pairs do not intersect the recorded overlap window.

| Secondary timing: successful, no-overlap pairs | Callisto / Zen | Browse / Chromium |
| --- | ---: | ---: |
| Mean | 40.0 s | 49.3 s |
| Median | 34.2 s | 55.1 s |

## Every attempt

| Task | Engine | Repetition | Outcome | Seconds | MCP calls | Errors |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| 41 | zen | 1 | passed | 22.9 | 2 | 0 |
| 41 | browse | 1 | passed | 27.8 | 3 | 0 |
| 94 | browse | 1 | passed | 65.0 | 12 | 1 |
| 94 | zen | 1 | passed | 62.9 | 8 | 0 |
| 208 | zen | 1 | passed | 34.2 | 8 | 0 |
| 208 | browse | 1 | passed | 55.1 | 11 | 1 |

## Measurement and limits

Provisioning, image initialization, authentication and initial page load are outside task elapsed and recorded. Task elapsed includes host startup, model turns, failures, shutdown and independent official scoring. Browser API inspection is allowed; direct API/network/file requests by the model are forbidden and audited conservatively.

Three predeclared answer-only RETRIEVE tasks from official WebArena Verified 1.2.3, one repetition per engine. Real pinned Shopping Admin site and official AgentResponseEvaluator; no network-evaluated tasks or leaderboard score. Fresh site container and browser profile per attempt. Authentication uses the official X-M2-Admin-Auto-Login header through a local provisioning proxy. No personal account. All browser decisions are model-selected.

- Fresh host conversation per attempt; exact requested model is configured, but Codex CLI does not independently echo an upstream served-model identifier.
- Published fixture pairing secrets may be redacted. Original returned-byte counts, usage and scores are preserved; the aggregate redaction audit records hashes of exact private originals and published files.
- Original initialization mode, exposed catalogs, binary/source hashes, oracles and fixture flags are retained in results.json. The public run uses the controlled task-tool facade; account/official runs forward native initialization instructions and expose the default Codex-compatible catalogs.
- Host/browser provisioning and login are outside task time and recorded. Navigation during a task, model work, retries, waits, host shutdown and independent verification are inside.
- The six public tasks have two repetitions; three account tasks have two; the official subset has one attempt per engine/task. These do not establish broad production reliability, multi-model superiority or stable tail latency.
- Resource RSS and isolated cold-start performance are not measured. The optional preflights may warm provider-side prefix caches; cache usage is recorded rather than inferred from schema bytes.
- This is not a full WebArena/BrowserGym run or leaderboard entry. The official subset uses only response-evaluated tasks; the adapter rejects network-evaluated tasks rather than inventing traces.
- See summary.json for failures, operations, usage coverage and descriptive task-cluster intervals. See harness/ and harness-sha256.json for exact executed sources.
