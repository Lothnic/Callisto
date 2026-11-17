import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {MCPClient} from '../eval/agent-comparison/mcp-client.mjs';
const exec=promisify(execFile),binary=resolve(process.env.CALLISTO_FIREFOX_BINARY||'packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
const decode=result=>JSON.parse(result.content.find(c=>c.type==='text').text);

test('compact discovery, native compatibility and full clients share one relay',async()=>{
 const state=await mkdtemp(join(tmpdir(),'callisto-compact-'));const base={...process.env,CALLISTO_FIREFOX_STATE_DIR:state};delete base.CALLISTO_TOOL_PROFILE;
 let compact,full;
 try{
  compact=await new MCPClient(binary,[],base).initialize();
  full=await new MCPClient(binary,[],{...base,CALLISTO_TOOL_PROFILE:'full'}).initialize();
  const compactTools=(await compact.request('tools/list')).tools,fullTools=(await full.request('tools/list')).tools;
  assert.deepEqual(compactTools.map(t=>t.name),['callisto']);assert.equal(fullTools.length,25);
  assert.ok(JSON.stringify(compactTools).length*8<JSON.stringify(fullTools).length);
  const run=decode(await compact.callTool({name:'callisto',arguments:{op:'help',args:{op:'run'}}}));
  assert.deepEqual(run.args_schema,fullTools.find(t=>t.name==='callisto_run').inputSchema);
  const index=decode(await compact.callTool({name:'callisto',arguments:{op:'help'}}));
  assert.equal(index.operations.length,25);assert.ok(!JSON.stringify(index).includes('inputSchema'));
  const nativeStatus=decode(await full.callTool({name:'callisto_status',arguments:{}}));
  const routedStatus=decode(await compact.callTool({name:'callisto',arguments:{op:'status'}}));
  assert.deepEqual(routedStatus,nativeStatus);
  assert.deepEqual(decode(await compact.callTool({name:'callisto_status',arguments:{}})),nativeStatus);
  for(const args of [{max_chars:999},{offset:-1}]){
   const native=await full.callTool({name:'callisto_snapshot',arguments:args});
   const routed=await compact.callTool({name:'callisto',arguments:{op:'snapshot',args}});
   assert.deepEqual(routed,native);assert.equal(routed.isError,true);
  }
  for(const args of [{op:'relay/shutdown'},{op:'navigate',url:'https://example.com'},{op:'help',args:{op:'made_up'}},{op:'run',args:[]}]){
   assert.equal((await compact.callTool({name:'callisto',arguments:args})).isError,true);
  }
  assert.equal((await full.request('tools/list')).tools.length,25);
 }finally{
  await compact?.close();await full?.close();await exec(binary,['--stop-relay'],{env:base,timeout:5000}).catch(()=>{});await rm(state,{recursive:true,force:true});
 }
});

test('an invalid profile fails explicitly before starting a relay',async()=>{
 const state=await mkdtemp(join(tmpdir(),'callisto-profile-'));
 try{await assert.rejects(exec(binary,[],{env:{...process.env,CALLISTO_FIREFOX_STATE_DIR:state,CALLISTO_TOOL_PROFILE:'typo'},timeout:5000}),e=>e.stderr.includes('CALLISTO_TOOL_PROFILE must be compact or full'));}
 finally{await rm(state,{recursive:true,force:true});}
});
