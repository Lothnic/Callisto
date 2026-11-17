import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),script=resolve('eval/agent-comparison/step5-redact.py');
test('redaction handles pending host events, preserves measured fields and private originals, and protects its audit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'callisto-redaction-'));
 try{
  const reports=join(root,'reports'),run=join(reports,'luna-step5-transcript'),backup=join(root,'private'),audit=join(root,'audit.json');await mkdir(run,{recursive:true});
  const secret='fixture-only-secret-'+ 'x'.repeat(50);
  const transcript={pending:{arguments:{op:'pair'},result:null},tools:[{name:'callisto',arguments:{op:'pair'},response_bytes:777,result:{content:[{text:JSON.stringify({code:secret,instructions:'test only'})}]}}],host:{duplicate:secret},usage:{input_tokens:123},success:true};
  const path=join(run,'trace.json');await writeFile(path,JSON.stringify(transcript));const original=await readFile(path);
  await exec('python3',[script,reports,backup,audit]);const published=await readFile(path,'utf8'),parsed=JSON.parse(published),record=JSON.parse(await readFile(audit,'utf8'));
  assert(!published.includes(secret));assert(published.includes('[REDACTED_EXPIRED_FIXTURE_PAIRING_CODE]'));assert.equal(parsed.tools[0].response_bytes,777);assert.deepEqual(parsed.usage,transcript.usage);assert.equal(parsed.success,true);
  assert.deepEqual(await readFile(join(backup,'luna-step5-transcript','trace.json')),original);assert.equal(record.changes[0].original_sha256,createHash('sha256').update(original).digest('hex'));assert.equal(record.changes[0].replacements,2);
  const savedAudit=await readFile(audit);await assert.rejects(exec('python3',[script,reports,backup,audit]),error=>error.stderr.includes('Refusing to overwrite an existing redaction audit'));assert.deepEqual(await readFile(audit),savedAudit);
 }finally{await rm(root,{recursive:true,force:true});}
});
