// Re-score saved answers/observations without re-running or altering any agent trial.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {tasks,applyOracles,evaluate} from './real-world-tasks.mjs';
const root=resolve(process.argv[2]);
const original=JSON.parse(await readFile(join(root,'results.json'),'utf8'));
applyOracles(original.oracles);
const scoringStarted=performance.now();
const reviewed=structuredClone(original),changes=[];
for(const row of reviewed.results){
 const task=tasks.find(t=>t.id===row.task);
 const trace=JSON.parse(await readFile(join(root,row.trace_file),'utf8'));
 const assessment=evaluate(task,row.answer,trace.tools);
 const previous=row.outcome;
 row.initial_evaluation=row.evaluation;row.initial_outcome=row.outcome;
 row.evaluation=assessment;
 if(row.outcome!=='infrastructure_error'){
  row.success=assessment.passed&&row.tool_calls>0&&!row.forbidden_host_calls&&!row.timed_out;
  row.outcome=row.success?'passed':row.initial_outcome==='passed'?'agent_failure':row.initial_outcome;
 }
 if(row.outcome!==previous)changes.push({engine:row.engine,task:row.task,round:row.round,before:previous,after:row.outcome});
}
reviewed.scoring_correction={at:new Date().toISOString(),reason:process.argv[3]||'The current scorer decodes native tab-wrapped JSON observations and accepts a shared explicit year for the requested dates. The same fact, source URL, exact observed-quote and no-direct-fetch checks apply uniformly to every trial on both engines. Original answers, timings, usage, traces and raw results are preserved.',changed_trials:changes,scorer_sha256:createHash('sha256').update(await readFile(new URL('./real-world-tasks.mjs',import.meta.url))).digest('hex'),offline_scoring_ms:performance.now()-scoringStarted};
reviewed.scoring_correction.scorer_support_sha256=createHash('sha256').update(await readFile(new URL('./observation-text.mjs',import.meta.url))).digest('hex');
await writeFile(join(root,'results-reviewed.json'),JSON.stringify(reviewed,null,2)+'\n',{mode:0o600});
await writeFile(join(root,'scoring-correction.json'),JSON.stringify(reviewed.scoring_correction,null,2)+'\n');
console.log(JSON.stringify({trials:reviewed.results.length,changed:changes},null,2));
