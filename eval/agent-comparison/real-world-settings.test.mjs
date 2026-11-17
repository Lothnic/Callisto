import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('unknown task IDs reject the whole selection before provisioning or model access',async()=>{
 const root=await mkdtemp(join(tmpdir(),'callisto-selection-'));
 const output=join(root,'must-not-start');
 try{
  const child=spawnSync(process.execPath,[resolve('eval/agent-comparison/real-world-agent.mjs')],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:'',BENCH_HOST:'codex',BENCH_TASKS:'wikipedia,wikipedia-biography',BENCH_OUTPUT_DIR:output,BENCH_RESUME:'0'}});
  assert.notEqual(child.status,0);
  assert.match(child.stderr,/Unknown task IDs: wikipedia/);
  assert.match(child.stderr,/wikipedia-biography/);
  await assert.rejects(stat(output),e=>e.code==='ENOENT');
 }finally{await rm(root,{recursive:true,force:true});}
});
