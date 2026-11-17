import {test} from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
const exec=promisify(execFile),script=resolve('eval/agent-comparison/webarena-response.py');
const args=['run','--isolated','--no-project','--python','3.12','--with','webarena-verified==1.2.3','python',script];
test('official task descriptions omit gold answers; fabricated responses score zero',async()=>{
 const task=JSON.parse((await exec('uv',[...args,'describe','41','http://127.0.0.1:7780'])).stdout);assert.equal(task.task_id,41);assert.equal(task.evaluator_version,'1.2.3');assert(!('eval'in task));assert(!('expected'in task));
 const root=await mkdtemp(join(tmpdir(),'callisto-wa-judge-'));try{const answer=join(root,'answer.json');await writeFile(answer,JSON.stringify({task_type:'RETRIEVE',status:'SUCCESS',retrieved_data:['invented-no-match'],error_details:null}));const result=JSON.parse((await exec('uv',[...args,'score','41','http://127.0.0.1:7780',answer])).stdout);assert.equal(result.score,0);assert.equal(result.status,'failure');}finally{await rm(root,{recursive:true,force:true});}
});
test('network-evaluated official tasks are refused by the answer-only adapter',async()=>{await assert.rejects(exec('uv',[...args,'describe','44','http://127.0.0.1:7780']),error=>error.stderr.includes('network/live-judge tasks require their real evaluator inputs'));});
