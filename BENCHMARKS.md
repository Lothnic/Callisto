# Callisto benchmarks

Phase 5 is in progress. This file reports only runs that can be reproduced from
this repository and linked artifacts.

## Headline table

| Benchmark | Callisto | Tasks | Model | Date | Run |
| --- | ---: | ---: | --- | --- | --- |
| WebVoyager smoke | 100% | 3 | siliconflow/tencent/Hy3 | 2026-07-09 | `runs/webvoyager-live-smoke` |
| WebVoyager smoke | 100% | 3 | fake/offline | 2026-07-09 | local scaffold |
| WebVoyager full | TBD | TBD | TBD | TBD | TBD |
| Online-Mind2Web | TBD | TBD | TBD | TBD | TBD |
| BU-Bench-V1 | TBD | TBD | TBD | TBD | TBD |
| Odyssey | TBD | TBD | TBD | TBD | TBD |

## Reproduce the scaffold run

```bash
cd eval
pip install -e .
python -m callisto_eval run webvoyager --subset smoke --agent fake --out runs/webvoyager-smoke
python -m callisto_eval summarize runs/webvoyager-smoke
```

The live smoke row is the first real Callisto browser-agent run, but it is only
three simple scaffold tasks (`example.com`, `github.com`, `linear.app`). Do not
compare it with external systems or full WebVoyager.

The fake smoke row is an offline plumbing check, not a browser-agent benchmark
claim.


## Publication rules

A real benchmark row requires:

- commit SHA and dirty-worktree flag,
- model/provider metadata,
- dependency versions,
- task subset hash,
- per-task `results.jsonl`,
- run `manifest.json`,
- confidence interval,
- documented exclusions.
