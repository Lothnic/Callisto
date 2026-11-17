# Owned account Luna comparison

Completed 12/12 planned model trials. Model request: `gpt-6-luna`, `high`. Raw answers, tool calls and usage are retained.

| Metric | Callisto / Zen | Browse / Chromium |
| --- | ---: | ---: |
| Strict task passes | 6 | 6 |
| Attempts | 6 | 6 |
| Mean task time, all attempts | 63.4 s | 51.5 s |
| Median task time, all attempts | 57.7 s | 52.0 s |
| Sample p95 (small sample) | 102.2 s | 68.2 s |
| Input including cache | 1,429,055 | 941,473 |
| Uncached input | 218,943 | 175,521 |
| Output including reasoning | 7,455 | 5,574 |
| Host MCP calls | 83 | 37 |
| Failed calls | 4 | 1 |
| Returned UTF-8 bytes | 76,443 | 17,695 |
| Contract-help calls | 11 | 0 |
| Uncached input per strict success | 36,490 | 29,254 |

All attempts remain in the table, including failed tasks. MCP calls include help and composed actions; they are not underlying browser-command counts or model-request counts. Cached input, output/reasoning and returned bytes remain separate. Billed dollar cost is unavailable.

6 complete pairs; 6 succeeded strictly on both engines. 6 successful pairs do not intersect the recorded overlap window.

| Secondary timing: successful, no-overlap pairs | Callisto / Zen | Browse / Chromium |
| --- | ---: | ---: |
| Mean | 63.4 s | 51.5 s |
| Median | 57.7 s | 52.0 s |

## Every attempt

| Task | Engine | Repetition | Outcome | Seconds | MCP calls | Errors |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| preferences | zen | 1 | passed | 53.1 | 7 | 0 |
| preferences | browse | 1 | passed | 47.5 | 3 | 0 |
| return | browse | 1 | passed | 61.5 | 7 | 0 |
| return | zen | 1 | passed | 62.3 | 17 | 1 |
| receipt-tabs | zen | 1 | passed | 102.2 | 18 | 2 |
| receipt-tabs | browse | 1 | passed | 53.7 | 7 | 1 |
| preferences | browse | 2 | passed | 27.8 | 3 | 0 |
| preferences | zen | 2 | passed | 50.4 | 8 | 1 |
| return | zen | 2 | passed | 46.6 | 14 | 0 |
| return | browse | 2 | passed | 50.3 | 10 | 0 |
| receipt-tabs | browse | 2 | passed | 68.2 | 7 | 0 |
| receipt-tabs | zen | 2 | passed | 65.6 | 19 | 0 |

## Measurement and limits

Fresh model conversation and fresh authenticated local case per trial. Provisioning, login and neutral-tab cleanup are excluded and recorded. Task elapsed includes host startup, model turns, errors, waits, shutdown and independent server-state/tab verification. Native initialization instructions are forwarded. Per-case HTTP-only cookies are test-only; no personal accounts. No official external benchmark score is claimed.



- Fresh host conversation per attempt; exact requested model is configured, but Codex CLI does not independently echo an upstream served-model identifier.
- Published fixture pairing secrets may be redacted. Original returned-byte counts, usage and scores are preserved; the aggregate redaction audit records hashes of exact private originals and published files.
- Original initialization mode, exposed catalogs, binary/source hashes, oracles and fixture flags are retained in results.json. The public run uses the controlled task-tool facade; account/official runs forward native initialization instructions and expose the default Codex-compatible catalogs.
- Host/browser provisioning and login are outside task time and recorded. Navigation during a task, model work, retries, waits, host shutdown and independent verification are inside.
- The six public tasks have two repetitions; three account tasks have two; the official subset has one attempt per engine/task. These do not establish broad production reliability, multi-model superiority or stable tail latency.
- Resource RSS and isolated cold-start performance are not measured. The optional preflights may warm provider-side prefix caches; cache usage is recorded rather than inferred from schema bytes.
- This is not a full WebArena/BrowserGym run or leaderboard entry. The official subset uses only response-evaluated tasks; the adapter rejects network-evaluated tasks rather than inventing traces.
- See summary.json for failures, operations, usage coverage and descriptive task-cluster intervals. See harness/ and harness-sha256.json for exact executed sources.
