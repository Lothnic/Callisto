import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {HostSession} from './host-session.mjs';
import {MCPClient} from './mcp-client.mjs';
test('real stdio host transport preserves the owned lease, schema and result; refuses other tools',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'callisto-host-test-')),requests=[];
 const result={content:[{type:'text',text:'{"text":"秘密🚀"}'}],structuredContent:{value:7}};
 const tool={name:'callisto_snapshot',description:'Native schema',inputSchema:{type:'object',properties:{query:{type:'string'}}}};
 const native={callTool:async request=>{requests.push(request);return result;}};
 const session=await new HostSession(native,[tool],{maxCalls:1}).start(join(directory,'host.sock'));let client;
 try{
  assert.equal((await stat(session.path)).mode&0o777,0o600);
  client=await new MCPClient(process.execPath,[resolve('eval/agent-comparison/host-mcp-proxy.mjs'),session.path]).initialize();
  assert.deepEqual((await client.request('tools/list')).tools,[tool]);
  const request={name:tool.name,arguments:{query:'秘密'}};assert.deepEqual(await client.callTool(request),result);assert.deepEqual(requests,[request]);
  await assert.rejects(()=>client.callTool({name:'callisto_browser',arguments:{action:'tab_close'}}),/outside benchmark catalog/);
  await assert.rejects(()=>client.callTool(request),/budget reached/);assert.equal(requests.length,1);
  assert.equal(session.events[0].response_bytes,Buffer.byteLength(JSON.stringify(result)));
 }finally{await client?.close();await session.close();await rm(directory,{recursive:true,force:true});}
});
