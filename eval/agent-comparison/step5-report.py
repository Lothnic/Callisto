"""Derive all comparisons from retained trial records. No handwritten scores."""
import datetime,hashlib,json,math,random,statistics,sys
from collections import Counter
from pathlib import Path
root=Path(sys.argv[1]);raw=json.loads((root/'results.json').read_text());rows=raw['results'];engines=['zen','browse']
traces={r['trace_file']:json.loads((root/r['trace_file']).read_text()) for r in rows}
def stats(group):
 usage=[r['usage'] for r in group if r.get('usage') is not None]
 total=lambda key:sum(u.get(key,0) or 0 for u in usage)
 times=[r['task_elapsed_ms']/1000 for r in group]
 events=[e for r in group for e in traces[r['trace_file']]['tools']]
 ops=Counter((e.get('arguments')or{}).get('op') if e['name']=='callisto' else e['name'] for e in events)
 passed=sum(r['success'] is True for r in group)
 return {'attempted':len(group),'passed':passed,'outcomes':dict(Counter(r['outcome']for r in group)),'usage_runs':len(usage),'mean_seconds':statistics.mean(times) if times else None,'median_seconds':statistics.median(times)if times else None,'sample_p95_seconds':sorted(times)[max(0,math.ceil(.95*len(times))-1)]if times else None,'total_seconds':sum(times),'input_tokens':total('input_tokens'),'cached_input_tokens':total('cached_input_tokens'),'cache_write_input_tokens':total('cache_write_input_tokens'),'uncached_input_tokens':total('input_tokens')-total('cached_input_tokens')-total('cache_write_input_tokens'),'output_tokens':total('output_tokens'),'reasoning_output_tokens':total('reasoning_output_tokens'),'mcp_calls':len(events),'tool_errors':sum(bool(e['failed'])for e in events),'response_bytes':sum(e['response_bytes']for e in events),'operations':dict(ops),'help_calls':ops.get('help',0),'help_bytes':sum(e['response_bytes']for e in events if e['name']=='callisto'and(e.get('arguments')or{}).get('op')=='help'),'uncached_input_per_strict_success':(total('input_tokens')-total('cached_input_tokens')-total('cache_write_input_tokens'))/passed if passed and len(usage)==len(group)else None}
pairs={}
for r in rows:pairs.setdefault((r['task'],r['round']),{})[r['engine']]=r
complete_pairs=[p for p in pairs.values() if all(e in p for e in engines)]
overlap=json.loads((root/'overlap-audit.json').read_text())if(root/'overlap-audit.json').exists()else None
affected=[]
if overlap:
 begin=datetime.datetime.fromisoformat(overlap['start'].replace('Z','+00:00')).timestamp();end=datetime.datetime.fromisoformat(overlap['end'].replace('Z','+00:00')).timestamp()
 for r in rows:
  interval=overlap.get('trial_intervals',{}).get(r['trace_file'])
  if interval is None:raise ValueError('Overlap audit requires preserved original trial intervals; checkout mtimes are not measurement timestamps')
  finish=interval['file_mtime_end_epoch'];start=interval['inferred_start_epoch']
  if start-2<=end and finish+2>=begin:affected.append({'engine':r['engine'],'task':r['task'],'round':r['round'],'inferred_start':datetime.datetime.fromtimestamp(start,datetime.timezone.utc).isoformat(),'file_mtime_end':datetime.datetime.fromtimestamp(finish,datetime.timezone.utc).isoformat()})
 affected_pairs={(r['task'],r['round'])for r in affected}
else:affected_pairs=set()
clean=[p for p in complete_pairs if(p['zen']['task'],p['zen']['round'])not in affected_pairs]
successful=[p for p in complete_pairs if all(p[e]['success']is True for e in engines)]
clean_successful=[p for p in clean if all(p[e]['success']is True for e in engines)]
errors=[{'engine':r['engine'],'task':r['task'],'round':r['round'],'name':e['name'],'arguments':e['arguments'],'result':e['result'],'elapsed_ms':e['elapsed_ms']}for r in rows for e in traces[r['trace_file']]['tools']if e['failed']]
summary={'schema':'callisto.step5-summary.v1','complete':len(rows)==raw['planned_runs'],'planned_runs':raw['planned_runs'],'completed_runs':len(rows),'model':raw['model'],'reasoning_effort':raw['reasoning_effort'],'all_attempts':{e:stats([r for r in rows if r['engine']==e])for e in engines},'paired_successful_count':len(successful),'no_overlap_all_pairs':len(clean),'no_overlap_successful_pairs':len(clean_successful),'no_overlap_all_attempts':{e:stats([p[e]for p in clean])for e in engines},'no_overlap_successful':{e:stats([p[e]for p in clean_successful])for e in engines},'overlap':{'window':overlap,'affected_trials':affected,'excluded_pairs_only_from_secondary_timing':[{'task':k[0],'round':k[1]}for k in sorted(affected_pairs)]},'tool_errors':errors,'billed_cost_usd':None}
if raw['schema']=='callisto.real-world-agent.v1':
 summary['facts_only_passed']={e:sum(all(f['passed']for f in r['evaluation']['facts'])for r in rows if r['engine']==e)for e in engines}
 summary['strict_failure_reasons']=[{'engine':r['engine'],'task':r['task'],'round':r['round'],'evaluation':r['evaluation'],'answer':r['answer']}for r in rows if r['success']is not True]
# Cluster bootstrap by task: repeats of one goal are not independent samples.
clusters={}
for p in complete_pairs:clusters.setdefault(p['zen']['task'],[]).append(p)
if len(clusters)>=3:
 rng=random.Random(20261117);names=list(clusters);delta=[];token_ratios=[]
 for _ in range(5000):
  sampled=[p for name in rng.choices(names,k=len(names))for p in clusters[name]]
  z=stats([p['zen']for p in sampled]);b=stats([p['browse']for p in sampled]);delta.append(z['mean_seconds']-b['mean_seconds']);token_ratios.append(z['uncached_input_tokens']/b['uncached_input_tokens']if b['uncached_input_tokens']else 0)
 def ci(values):s=sorted(values);return[s[int(.025*(len(s)-1))],s[int(.975*(len(s)-1))]]
 summary['task_cluster_bootstrap']={'clusters':len(names),'resamples':5000,'seed':20261117,'latency_delta_seconds_zen_minus_browse_95pct':ci(delta),'uncached_input_ratio_zen_over_browse_95pct':ci(token_ratios),'note':'Descriptive interval conditional on this small predeclared task set; not a production reliability or broad-model estimate. All attempts included, including overlap and failures.'}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
fmt=lambda n:'unavailable'if n is None else f'{n:,.0f}'
sec=lambda n:'unavailable'if n is None else f'{n:.1f} s'
lines=['# '+('Public-site Luna comparison'if raw['schema']=='callisto.real-world-agent.v1'else'Owned account Luna comparison'if raw['schema']=='callisto.account-agent.v1'else'Official WebArena Verified retrieval subset'),'',f"Completed {len(rows)}/{raw['planned_runs']} planned model trials. Model request: `{raw['model']}`, `{raw['reasoning_effort']}`. Raw answers, tool calls and usage are retained.",'','| Metric | Callisto / Zen | Browse / Chromium |','| --- | ---: | ---: |']
for label,key,form in [('Strict task passes','passed',fmt),('Attempts','attempted',fmt),('Mean task time, all attempts','mean_seconds',sec),('Median task time, all attempts','median_seconds',sec),('Sample p95 (small sample)','sample_p95_seconds',sec),('Input including cache','input_tokens',fmt),('Uncached input','uncached_input_tokens',fmt),('Output including reasoning','output_tokens',fmt),('Host MCP calls','mcp_calls',fmt),('Failed calls','tool_errors',fmt),('Returned UTF-8 bytes','response_bytes',fmt),('Contract-help calls','help_calls',fmt),('Uncached input per strict success','uncached_input_per_strict_success',fmt)]:lines.append('| '+label+' | '+' | '.join(form(summary['all_attempts'][e][key])for e in engines)+' |')
lines+=['','All attempts remain in the table, including failed tasks. MCP calls include help and composed actions; they are not underlying browser-command counts or model-request counts. Cached input, output/reasoning and returned bytes remain separate. Billed dollar cost is unavailable.','',f"{len(complete_pairs)} complete pairs; {len(successful)} succeeded strictly on both engines. {len(clean_successful)} successful pairs do not intersect the recorded overlap window."]
if overlap:lines+=['','An account preflight accidentally overlapped this public run. The primary table retains every row. A secondary timing view excludes both engines for any affected task/repetition pair, using a conservative exogenous interval. See overlap-audit.json and summary.json for the file-mtime inference and exact pair list. No trial was dropped, overwritten or rerun for a better outcome.']
if clean_successful:
 lines+=['','| Secondary timing: successful, no-overlap pairs | Callisto / Zen | Browse / Chromium |','| --- | ---: | ---: |',f"| Mean | {sec(summary['no_overlap_successful']['zen']['mean_seconds'])} | {sec(summary['no_overlap_successful']['browse']['mean_seconds'])} |",f"| Median | {sec(summary['no_overlap_successful']['zen']['median_seconds'])} | {sec(summary['no_overlap_successful']['browse']['median_seconds'])} |"]
if 'facts_only_passed'in summary:lines+=['',f"Facts-only checks passed for Callisto {summary['facts_only_passed']['zen']} and Browse {summary['facts_only_passed']['browse']}. This is a secondary diagnostic. The primary rule also requires an appropriate source and an exact quote observed in tool output; it has not been relaxed after seeing the results."]
lines+=['','## Every attempt','','| Task | Engine | Repetition | Outcome | Seconds | MCP calls | Errors |','| --- | --- | ---: | --- | ---: | ---: | ---: |']
for r in rows:lines.append(f"| {r['task']} | {r['engine']} | {r['round']+1} | {r['outcome']} | {r['task_elapsed_ms']/1000:.1f} | {r['tool_calls']} | {r['tool_failures']} |")
lines+=['','## Measurement and limits','',raw.get('measurement',''),'',raw.get('scope',''),'', '- Fresh host conversation per attempt; exact requested model is configured, but Codex CLI does not independently echo an upstream served-model identifier.', '- Published fixture pairing secrets may be redacted. Original returned-byte counts, usage and scores are preserved; the aggregate redaction audit records hashes of exact private originals and published files.', '- Original initialization mode, exposed catalogs, binary/source hashes, oracles and fixture flags are retained in results.json. The public run uses the controlled task-tool facade; account/official runs forward native initialization instructions and expose the default Codex-compatible catalogs.', '- Host/browser provisioning and login are outside task time and recorded. Navigation during a task, model work, retries, waits, host shutdown and independent verification are inside.', '- The six public tasks have two repetitions; three account tasks have two; the official subset has one attempt per engine/task. These do not establish broad production reliability, multi-model superiority or stable tail latency.', '- Resource RSS and isolated cold-start performance are not measured. The optional preflights may warm provider-side prefix caches; cache usage is recorded rather than inferred from schema bytes.', '- This is not a full WebArena/BrowserGym run or leaderboard entry. The official subset uses only response-evaluated tasks; the adapter rejects network-evaluated tasks rather than inventing traces.', '- See summary.json for failures, operations, usage coverage and descriptive task-cluster intervals. See harness/ and harness-sha256.json for exact executed sources.','']
(root/'README.md').write_text('\n'.join(lines))
print(json.dumps({'completed':len(rows),'planned':raw['planned_runs'],'all_attempts':summary['all_attempts'],'overlap_pairs':summary['overlap']['excluded_pairs_only_from_secondary_timing']},indent=2))
