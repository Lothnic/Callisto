import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diagnose} from './doctor.mjs';
test('diagnostics are read-only and do not expose pairing material',async()=>{
 const root=await mkdtemp(join(tmpdir(),'callisto-doctor-'));
 try{
  const state=join(root,'state');await mkdir(state,{mode:0o700});await writeFile(join(state,'pairing.json'),'{"token":"do-not-read-or-print"}');
  const report=await diagnose(root,{environment:{CALLISTO_FIREFOX_STATE_DIR:state}});
  assert.equal(report.ready,false);assert.equal(report.live_connection_probed,false);assert(!JSON.stringify(report).includes('do-not-read-or-print'));assert.deepEqual(await readdir(state),['pairing.json']);
  const regular=join(root,'not-a-directory');await writeFile(regular,'fixture');const bad=await diagnose(root,{environment:{CALLISTO_FIREFOX_STATE_DIR:regular}});assert.equal(bad.checks.find(c=>c.name==='private_state').passed,false);
  const empty=join(root,'absent');await diagnose(root,{environment:{CALLISTO_FIREFOX_STATE_DIR:empty}});assert(!(await readdir(root)).includes('absent'));
 }finally{await rm(root,{recursive:true,force:true});}
});
