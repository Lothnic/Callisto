# Public-site Luna comparison

Completed 24/24 planned model trials. Model request: `gpt-6-luna`, `high`. Raw answers, tool calls and usage are retained.

| Metric | Callisto / Zen | Browse / Chromium |
| --- | ---: | ---: |
| Strict task passes | 10 | 12 |
| Attempts | 12 | 12 |
| Mean task time, all attempts | 66.4 s | 53.5 s |
| Median task time, all attempts | 62.4 s | 47.4 s |
| Sample p95 (small sample) | 149.1 s | 108.7 s |
| Input including cache | 2,404,942 | 1,559,779 |
| Uncached input | 394,702 | 374,883 |
| Output including reasoning | 14,221 | 13,055 |
| Host MCP calls | 115 | 67 |
| Failed calls | 5 | 12 |
| Returned UTF-8 bytes | 427,242 | 193,403 |
| Contract-help calls | 12 | 0 |
| Uncached input per strict success | 39,470 | 31,240 |

All attempts remain in the table, including failed tasks. MCP calls include help and composed actions; they are not underlying browser-command counts or model-request counts. Cached input, output/reasoning and returned bytes remain separate. Billed dollar cost is unavailable.

12 complete pairs; 10 succeeded strictly on both engines. 8 successful pairs do not intersect the recorded overlap window.

An account preflight accidentally overlapped this public run. The primary table retains every row. A secondary timing view excludes both engines for any affected task/repetition pair, using a conservative exogenous interval. See overlap-audit.json and summary.json for the file-mtime inference and exact pair list. No trial was dropped, overwritten or rerun for a better outcome.

| Secondary timing: successful, no-overlap pairs | Callisto / Zen | Browse / Chromium |
| --- | ---: | ---: |
| Mean | 71.4 s | 56.3 s |
| Median | 62.4 s | 53.4 s |

Facts-only checks passed for Callisto 12 and Browse 12. This is a secondary diagnostic. The primary rule also requires an appropriate source and an exact quote observed in tool output; it has not been relaxed after seeing the results.

## Every attempt

| Task | Engine | Repetition | Outcome | Seconds | MCP calls | Errors |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| wikipedia-biography | zen | 1 | passed | 50.5 | 10 | 1 |
| wikipedia-biography | browse | 1 | passed | 28.6 | 4 | 0 |
| arxiv-paper | browse | 1 | passed | 108.7 | 12 | 3 |
| arxiv-paper | zen | 1 | passed | 149.1 | 21 | 0 |
| github-issue | zen | 1 | passed | 41.9 | 4 | 0 |
| github-issue | browse | 1 | passed | 38.3 | 3 | 0 |
| pypi-metadata | browse | 1 | passed | 74.1 | 8 | 2 |
| pypi-metadata | zen | 1 | passed | 81.1 | 6 | 0 |
| python-json | zen | 1 | passed | 90.7 | 11 | 1 |
| python-json | browse | 1 | passed | 49.3 | 6 | 1 |
| govuk-calendar | browse | 1 | passed | 63.3 | 6 | 2 |
| govuk-calendar | zen | 1 | passed | 55.4 | 9 | 1 |
| wikipedia-biography | browse | 2 | passed | 33.8 | 4 | 0 |
| wikipedia-biography | zen | 2 | agent_failure | 85.0 | 12 | 1 |
| arxiv-paper | zen | 2 | passed | 61.2 | 13 | 0 |
| arxiv-paper | browse | 2 | passed | 74.3 | 10 | 2 |
| github-issue | browse | 2 | passed | 45.5 | 1 | 0 |
| github-issue | zen | 2 | agent_failure | 17.6 | 2 | 0 |
| pypi-metadata | zen | 2 | passed | 34.4 | 4 | 0 |
| pypi-metadata | browse | 2 | passed | 57.4 | 6 | 1 |
| python-json | browse | 2 | passed | 28.1 | 3 | 0 |
| python-json | zen | 2 | passed | 63.5 | 12 | 1 |
| govuk-calendar | zen | 2 | passed | 66.6 | 11 | 0 |
| govuk-calendar | browse | 2 | passed | 40.8 | 4 | 1 |

## Measurement and limits

Fresh host conversation per run. Host elapsed includes startup, model turns, navigation, waits, failures and retries. Task elapsed additionally includes independent answer/evidence validation. Profile setup and neutral-tab reacquisition are separate. Verification is not cut off the timer. Browser output UTF-8 bytes and characters are separate from model input/output/cached tokens.

6 public informational workflows, 2 repetition(s), engines zen,browse. Anonymous owned browser profiles; initially the first round is cold per site and the second is warm. A resumed phase resets profiles and is explicitly identified in phase metadata. Fixed gold facts for stable pages; time-stamped official JSON/API oracles for mutable metadata. Native task-tool catalogs differ and are saved. Not a store-install, authenticated-account or production reliability test.

- Fresh host conversation per attempt; exact requested model is configured, but Codex CLI does not independently echo an upstream served-model identifier.
- Published fixture pairing secrets may be redacted. Original returned-byte counts, usage and scores are preserved; the aggregate redaction audit records hashes of exact private originals and published files.
- Original initialization mode, exposed catalogs, binary/source hashes, oracles and fixture flags are retained in results.json. The public run uses the controlled task-tool facade; account/official runs forward native initialization instructions and expose the default Codex-compatible catalogs.
- Host/browser provisioning and login are outside task time and recorded. Navigation during a task, model work, retries, waits, host shutdown and independent verification are inside.
- The six public tasks have two repetitions; three account tasks have two; the official subset has one attempt per engine/task. These do not establish broad production reliability, multi-model superiority or stable tail latency.
- Resource RSS and isolated cold-start performance are not measured. The optional preflights may warm provider-side prefix caches; cache usage is recorded rather than inferred from schema bytes.
- This is not a full WebArena/BrowserGym run or leaderboard entry. The official subset uses only response-evaluated tasks; the adapter rejects network-evaluated tasks rather than inventing traces.
- See summary.json for failures, operations, usage coverage and descriptive task-cluster intervals. See harness/ and harness-sha256.json for exact executed sources.
