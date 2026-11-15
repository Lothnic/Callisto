import {provenance} from './provenance.mjs';
// Observation ablation on one owned Zen fixture. No model calls or browse claims.
import {MCPClient} from './mcp-client.mjs';import {ZenFixture} from './zen-fixture.mjs';
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve,join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';
const exec=promisify(execFile),runtime=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp'),state=await mkdtemp(join(tmpdir(),'callisto-observe-')),env={...process.env,CALLISTO_FIREFOX_STATE_DIR:state};
const root=resolve(process.env.OBSERVATION_OUTPUT||'eval/reports/observation-efficiency-2026-11-15');await mkdir(root,{recursive:false,mode:0o700});const trace=join(root,'trace');let client,fixture;const rows=[];
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Observation fixture</title><h1>Inventory</h1><div id="inventory">'+Array.from({length:600},(_,i)=>`<div class="product" ${i===487?'id="target"':''}>${i===487?'Aster helmet':'Fixture inventory item '+i} · Stock: ${i===487?17:i%29}</div>`).join('')+'</div>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 client=await new MCPClient(runtime,[],env).initialize();fixture=new ZenFixture(client);await fixture.start(`http://127.0.0.1:${server.address().port}/`);
 await fixture.call('callisto_trace',{action:'start',directory:trace});
 async function capture(name,args,expected='Aster helmet'){const begin=performance.now(),result=await fixture.call('callisto_snapshot',args);rows.push({name,arguments:args,elapsed_ms:performance.now()-begin,response_bytes:Buffer.byteLength(JSON.stringify(result)),observation_chars:[...result.text].length,task_relevant_content_present:result.text.includes(expected),truncated:result.truncated,capture_truncated:result.capture_truncated,revision:result.revision});return result;}
 await capture('default_bounded',{});await capture('targeted_query',{query:'Aster',max_chars:1000});
 await capture('full_before',{max_chars:30000});await fixture.script('document.querySelector("#target").textContent="Aster helmet · Stock: 18"');
 const delta=await capture('change_diff',{max_chars:1000,diff:true},'Stock: 18');assert(delta.text.includes('Stock: 17')&&delta.text.includes('Stock: 18'));
 await capture('full_after',{max_chars:30000},'Stock: 18');await fixture.call('callisto_trace',{action:'stop'});
 const manifest=JSON.parse(await readFile(join(trace,'manifest.json'),'utf8'));assert.equal(manifest.measurements.by_tool.callisto_snapshot.calls,rows.length);assert(manifest.complete);
 const report={schema:'callisto.observation-report.v1',created_at:new Date().toISOString(),...await provenance(),browser:fixture.capabilities.browserVersion,fixture_rows:600,model_calls:0,measured_model_tokens:null,scope:'Synthetic catalog observations only. Different queries can omit content. Timing is runtime work, not agent latency; byte reductions are not model-token or billed-cost measurements. No browse comparison.',rows,trace_measurements:manifest.measurements};
 await writeFile(join(root,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(rows.map(({name,response_bytes,task_relevant_content_present})=>({name,response_bytes,task_relevant_content_present})),null,2));
}finally{await fixture?.close();await client?.close();await exec(runtime,['--stop-relay'],{env}).catch(()=>{});await rm(state,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));}
