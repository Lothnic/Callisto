"""Derive this pilot's report from preserved trial data, including failures."""
import json
import statistics
import sys
from collections import Counter
from pathlib import Path

root = Path(sys.argv[1])
initial = json.loads((root / 'results.json').read_text())
raw = json.loads((root / 'results-reviewed.json').read_text()) if (root / 'results-reviewed.json').exists() else initial
assert len(raw['results']) == len(initial['results']), 'Reviewed data must cover every original trial'
rows = raw['results']
engines = ('zen', 'browse')
names = {'zen': 'Callisto / Zen', 'browse': 'browse / Chromium'}
traces = {r['trace_file']: json.loads((root / r['trace_file']).read_text()) for r in rows}

def stats(group):
    usage = [r['usage'] for r in group if r.get('usage') is not None]
    total = lambda key: sum(u.get(key, 0) or 0 for u in usage)
    times = [r['task_elapsed_ms'] / 1000 for r in group]
    tools = [t for r in group for t in traces[r['trace_file']]['tools']]
    return dict(
        attempted=len(group), passed=sum(r['success'] is True for r in group),
        outcomes=dict(Counter(r['outcome'] for r in group)), usage_runs=len(usage),
        mean_seconds=statistics.mean(times) if times else None,
        median_seconds=statistics.median(times) if times else None,
        total_seconds=sum(times), input_tokens=total('input_tokens'),
        cached_input_tokens=total('cached_input_tokens'),
        cache_write_input_tokens=total('cache_write_input_tokens'),
        uncached_input_tokens=total('input_tokens')-total('cached_input_tokens')-total('cache_write_input_tokens'),
        output_tokens=total('output_tokens'), reasoning_output_tokens=total('reasoning_output_tokens'),
        browser_calls=len(tools), tool_errors=sum(bool(t['failed']) for t in tools),
        failed_call_seconds=sum(t['elapsed_ms']/1000 for t in tools if t['failed']),
        response_bytes=sum(t['response_bytes'] for t in tools),
        help_calls=sum(t['name']=='callisto' and t['arguments'].get('op')=='help' for t in tools),
        help_response_bytes=sum(t['response_bytes'] for t in tools if t['name']=='callisto' and t['arguments'].get('op')=='help'),
        operations=dict(Counter(t['arguments'].get('op') for t in tools if t['name']=='callisto')),
    )

pairs = {}
for row in rows:
    pairs.setdefault((row['task'], row['round']), {})[row['engine']] = row
successful = [p for p in pairs.values() if all(p.get(e, {}).get('success') is True for e in engines)]
matched = [p for p in successful if p['zen']['phase']==p['browse']['phase']]
cross_phase = [dict(task=p['zen']['task'], round=p['zen']['round']) for p in successful if p['zen']['phase']!=p['browse']['phase']]
errors = [dict(engine=r['engine'], task=r['task'], round=r['round'],
               **{k:t[k] for k in ('name','arguments','elapsed_ms','result')})
          for r in rows for t in traces[r['trace_file']]['tools'] if t['failed']]
summary = dict(complete=len(rows)==raw['planned_runs'], planned_runs=raw['planned_runs'],
               completed_runs=len(rows), host=raw['host'], model=raw['model'], effort=raw['reasoning_effort'],
               all_attempts={e:stats([r for r in rows if r['engine']==e]) for e in engines},
               matched_successful_pairs=len(matched), successful_pairs=len(successful),
               cross_phase_pairs_excluded=cross_phase,
               matched={e:stats([p[e] for p in matched]) for e in engines},
               cost_usd=None, tool_errors=errors)
summary['scoring_correction']=raw.get('scoring_correction')
summary['raw_passed']={e:sum(r['success'] is True for r in initial['results'] if r['engine']==e) for e in engines}
summary['per_task']={t['id']:{e:stats([r for r in rows if r['task']==t['id'] and r['engine']==e]) for e in engines} for t in raw['tasks']}
(root/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')

fmt = lambda n: 'unavailable' if n is None else f'{n:,.0f}'
seconds = lambda n: 'unavailable' if n is None else f'{n:.1f} s'
all_stats = summary['all_attempts']
lines = ['# GPT-6 Luna: compact Callisto / Zen and browse', '',
         f"Completed **{len(rows)}/{raw['planned_runs']}** planned trials. " +
         ('The full task set is complete.' if summary['complete'] else 'This run is incomplete.'), '',
         f"Each task used a fresh signed-in Codex conversation configured with `{raw['model']}` at `{raw['reasoning_effort']}` effort. "
         f"The model chose its actions on {len(raw['tasks'])} public, read-only goals, repeated {raw['repetitions']} times per engine. "
         'Browser order alternated by task and repetition. Failed attempts are retained.', '',
         '## All attempts', '', '| Metric | Callisto / Zen | browse / Chromium |', '| --- | ---: | ---: |']
metrics = [('Passed / attempted', None, lambda s:f"{s['passed']}/{s['attempted']}"),
           ('Mean task time', 'mean_seconds', seconds), ('Median task time', 'median_seconds', seconds),
           ('Total task time', 'total_seconds', seconds), ('Model input, including cache', 'input_tokens', fmt),
           ('Cached input', 'cached_input_tokens', fmt), ('Uncached input', 'uncached_input_tokens', fmt),
           ('Model output, including reasoning', 'output_tokens', fmt), ('Reasoning output subset', 'reasoning_output_tokens', fmt),
           ('Host MCP tool calls', 'browser_calls', fmt), ('Failed browser calls', 'tool_errors', fmt),
           ('Returned UTF-8 bytes', 'response_bytes', fmt), ('On-demand contract-help calls', 'help_calls', fmt)]
for label, key, format_value in metrics:
    values=[format_value(all_stats[e] if key is None else all_stats[e][key]) for e in engines]
    lines.append(f"| {label} | {' | '.join(values)} |")
lines += ['', 'Token totals sum the supplied usage records: ' + ', '.join(f"{names[e]} {all_stats[e]['usage_runs']}/{all_stats[e]['attempted']}" for e in engines) +
          '. Missing usage is not counted as zero cost. Reasoning is part of output and is not added twice. '
          'Cache-write input is retained separately in summary.json. Dollar charges are unavailable; bytes are not tokens or cost.', '',
          '## Matched successful pairs', '',
          f"{len(successful)} pairs passed on both engines; {len(matched)} used the same profile phase. "
          f"{len(cross_phase)} cross-phase pairs are excluded from matched latency. All attempts remain above.", '']
if matched:
    lines += ['| Metric | Callisto / Zen | browse / Chromium |', '| --- | ---: | ---: |']
    for label,key,format_value in [('Mean task time','mean_seconds',seconds),('Median task time','median_seconds',seconds),('Uncached input','uncached_input_tokens',fmt)]:
        lines.append(f"| {label} | {' | '.join(format_value(summary['matched'][e][key]) for e in engines)} |")
if raw.get('scoring_correction'):
    correction=raw['scoring_correction']
    lines += ['', '## Uniform scoring correction', '', correction['reason'], '',
              f"{len(correction['changed_trials'])} outcomes changed. Original passed counts were " +
              ', '.join(f"{names[e]} {summary['raw_passed'][e]}" for e in engines) + '.',
              'Raw results, answers, tool outputs, errors, timings and usage are unchanged. '
              'The scorer rechecks every saved trial on both engines; only decoded values actually present in native JSON observations are admitted. '
              f"Offline re-scoring took {correction.get('offline_scoring_ms')} ms outside original task timing. "
              'See [the correction audit](scoring-correction.json) and [reviewed results](results-reviewed.json).']
lines += ['', 'These are descriptive timings, not a general speed guarantee or a billed-cost comparison.', '',
          '## Every trial', '', '| Task | Engine | Repeat | Outcome | Time | Calls | Errors |', '| --- | --- | ---: | --- | ---: | ---: | ---: |']
for r in rows:
    lines.append(f"| {r['task']} | {r['engine']} | {r['round']+1} | {r['outcome']} | {seconds(r['task_elapsed_ms']/1000)} | {r['tool_calls']} | {r['tool_failures']} |")
z,b=all_stats['zen'],all_stats['browse']
outlier=max((r for r in rows if r['engine']=='zen'),key=lambda r:(r.get('usage') or {}).get('input_tokens',0))
outlier_usage=outlier.get('usage') or {}
without_arxiv={e:stats([r for r in rows if r['engine']==e and r['task']!='arxiv-paper']) for e in engines}
lines += ['', '## Interpretation and next experiment', '',
          f"Callisto's mean time is {100*(1-z['mean_seconds']/b['mean_seconds']):.1f}% lower in this run, "
          f"while its uncached input is {100*(z['uncached_input_tokens']/b['uncached_input_tokens']-1):.1f}% higher "
          f"and total input including cache is {100*(z['input_tokens']/b['input_tokens']-1):.1f}% higher. "
          'This is not a billed-cost win.', '',
          'The mean latency advantage is concentrated in arXiv. As a descriptive sensitivity check, '
          f"excluding that task gives means of {seconds(without_arxiv['zen']['mean_seconds'])} on Callisto "
          f"and {seconds(without_arxiv['browse']['mean_seconds'])} on browse. No rows are removed from the primary results.", '',
          f"Callisto used {z['browser_calls']} calls, including {z['operations'].get('snapshot',0)} snapshots "
          f"and {z['help_calls']} contract-help calls returning {z['help_response_bytes']:,} bytes. "
          f"browse used {b['browser_calls']} calls. The largest Callisto input trial "
          f"({outlier['task']}, repetition {outlier['round']+1}) alone used {outlier['tool_calls']} calls, "
          f"{outlier_usage.get('input_tokens',0):,} input tokens including {outlier_usage.get('cached_input_tokens',0):,} cached, "
          f"and {outlier['tool_failures']} recovered argument/action errors. "
          'Callisto errors completed quickly, but the following model turns still consume context. '
          'browse failed calls consumed about '+seconds(b['failed_call_seconds'])+' in total.', '',
          'The catalog is already small. The next controlled changes should reduce repeated observations and '
          'extra help/recovery turns: compose dependent actions with run, request one bounded observation at the end, '
          'and use typed extraction for requested facts. Test concise common-operation guidance and actionable '
          'validation messages against the observed errors. Then compare compact/full schemas on the same Luna '
          'runtime and tasks with cache usage recorded; this run alone cannot attribute a token effect to schema size.', '',
          '| Goal | Callisto mean | browse mean |', '| --- | ---: | ---: |']
for t in raw['tasks']:
    group=summary['per_task'][t['id']]
    lines.append(f"| {t['name']} | {seconds(group['zen']['mean_seconds'])} | {seconds(group['browse']['mean_seconds'])} |")
lines += ['', '![Completion, per-trial times and uncached model input](comparison.png)']
lines += ['', '## Failure and interface evidence', '',
          'Failed tool calls, exact arguments, results and elapsed times are in summary.json and the per-trial traces. '
          'An error followed by task success is recovery, not evidence that the error was free. '
          'The operations/help counts above expose the cost of progressive contract discovery.', '',
          '## Setup and measurement boundaries', '']
m=raw['metadata']
lines += [f"- Host {m['codex_version']}; configured model `{raw['model']}`, `{raw['reasoning_effort']}`. "
          'The CLI accepts that explicit model request and returns completed turns and usage. Its visible event stream does not independently echo an upstream served-model identifier.',
          f"- Zen {m['zen_version']}, runtime {m['runtime_version']}, extension source {m['extension_source_version']}; "
          f"Chromium {m['chromium_version']}, browse {m['browse_cli']}, extension {m['browse_extension_version']}.",
          f"- The model saw one native compact Callisto tool ({m['catalogs']['zen']['exposed_bytes']:,} UTF-8 catalog bytes) "
          f"or browse execute ({m['catalogs']['browse']['exposed_bytes']:,} bytes). Full catalogs and prompts are saved. "
          'This differs from the older Sol experiment and does not isolate the effect of compact schemas.',
          '- browse 0.1.0 uses native tab-based execution. Its installed store package lacks a key for unpacked loading; '
          "the fixture copies it and adds browse's upstream public development key to its manifest. Code is unchanged. "
          'Source/loaded manifest hashes, API mode, source-file hashes and the public key source are saved. '
          'The current tab API has no legacy session origin allowlist; agents received a same-site policy and their traces were checked.',
          '- Callisto uses synthetic DOM input; browse uses CDP-backed input through a Playwright-style interface. Owned headful Xvfb profiles contain no personal logins or tabs. '
          'The Zen fixture pregrants optional permissions and pairs automatically; this is not an installation/onboarding test.',
          '- Provisioning and neutral-tab reset are outside task time and recorded separately. Host startup, model work, navigation, '
          'waits, retries, shutdown and independent fact/evidence checks are inside task time. The model deadline is 180 seconds and the dispatch ceiling is 35 browser calls.',
          '- HostSession supplies a generic MCP initialization response and a custom task/backend prompt; it does not forward the runtime server initialization instructions. This is a controlled task-tool pilot, not the full default host/product experience.',
          '- The evaluator obtains official mutable facts separately and never supplies them to the model. Success requires the requested facts, '
          'an appropriate source URL and an exact supporting quotation found in browser observations. Direct API/file/network answers are prohibited by task policy and transcript checks.',
          '- A separate paired Wikipedia preflight passed before this run. Its results and usage are not pooled into this comparison. '
          'It may have warmed provider-side prefix caches; full-run browser profiles were fresh. The first repetition is initially cold per site and the second is warm.',
          '- The first coordinator used an invalid task ID and stopped before model access. A later setup-only attempt exposed the missing unpacked identity and changed browse API. '
          'Those attempts are retained separately and are not measured browser-task failures. No failed measured trial was silently repeated.',
          '- Two repetitions over six informational tasks on one machine do not establish production reliability, authenticated-write coverage, '
          'general parity, or stable price/performance. Different interfaces, prompts, browser engines and cache behavior remain confounders.', '',
          '## Artifacts', '', '- [Raw results, catalogs, phases and answer oracles](results.json)',
          '- [Derived summary and exact tool failures](summary.json)', '- [Executed harness hashes](harness-sha256.json)',
          '- [All artifact hashes](artifact-sha256.json)', '- [Local validation: 20 checks passed](analysis/tests.log)',
          '- [browse extension source hashes](browse-extension-sha256.json)',
          '- Exact executed sources are under `harness/`; each trial JSON contains visible host events and native tool results. Private reasoning text is omitted.',
          '- [Separate successful preflight](../luna-preflight-2026-11-17-run2/results.json)',
          '- [Setup-only failure](../luna-preflight-2026-11-17/run-error.json)', '',
          '## Reproduce', '', '```sh',
          'cargo build --locked --manifest-path packages/firefox-rs/Cargo.toml --bin callisto-firefox-tab-mcp',
          'BENCH_HOST=codex BENCH_HOST_MODEL=gpt-6-luna BENCH_HOST_EFFORT=high \\',
          'BENCH_ZEN_TOOL_PROFILE=compact BENCH_REPETITIONS=2 BENCH_ENGINES=zen,browse \\',
          'BROWSE_EXTENSION_PATH=/absolute/path/to/browse-extension \\',
          'BENCH_OUTPUT_DIR=/tmp/new-luna-run \\',
          'xvfb-run -a node eval/agent-comparison/real-world-agent.mjs',
          'python eval/reports/luna-real-world-2026-11-17/analysis/write-report.py /tmp/new-luna-run',
          '```', '', 'Run the report script from its saved location, or copy it to the new output directory. '
          'Use `BENCH_TASKS=wikipedia-biography BENCH_REPETITIONS=1` and a separate output directory for the paired preflight. '
          'An existing signed-in Codex CLI and the documented browser dependencies are required.']
if len(raw.get('phases',[]))>1:
    phase_counts=dict(Counter(r['phase'] for r in rows))
    lines += ['', '## Continuation and cache reset', '',
              f"The session-boundary token guard stopped phase 0 after {phase_counts.get(0,0)} trials. "
              f"Only the {len(rows)-phase_counts.get(0,0)} missing IDs resumed in fresh owned profiles in phase 1, "
              'with the same runtime, catalogs, model and effort. No measured trial was repeated or dropped. '
              'The guard was raised from 3 million to 5 million cumulative reported tokens for this one continuation.',
              f"Profile-phase trial counts: `{phase_counts}`. All matched pairs use the same phase on both sides "
              f"except the {len(cross_phase)} explicitly excluded above. Browser caches reset between phases; "
              'the resumed second-repetition tasks therefore start cold in their new profiles.',
              'The first guard error and original settings remain in `run-error-phase-0.json` and '
              '`results-before-phase-1.json`. The configured token guard is a session-boundary stop, '
              'not a strict per-request cap. Model input totals include cache hits.']
(root/'README.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k not in ('tool_errors',)},indent=2))
