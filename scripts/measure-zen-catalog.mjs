// Measure the advertised MCP interface without pairing or reading a browser page.
import {MCPClient} from '../eval/agent-comparison/mcp-client.mjs';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),binary=resolve(process.env.CALLISTO_FIREFOX_BINARY||'packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
const state=await mkdtemp(join(tmpdir(),'callisto-catalog-'));const env={...process.env,CALLISTO_FIREFOX_STATE_DIR:state};
const result={measured_at:new Date().toISOString(),unit:'UTF-8 bytes of JSON.stringify(tools); not model tokens',profiles:{}};
try{
 for(const profile of ['full','compact']){
  const client=await new MCPClient(binary,[],{...env,CALLISTO_TOOL_PROFILE:profile}).initialize();
  try{
   const tools=(await client.request('tools/list')).tools;
   result.profiles[profile]={tool_count:tools.length,catalog_bytes:Buffer.byteLength(JSON.stringify(tools)),description_bytes:tools.reduce((n,t)=>n+Buffer.byteLength(t.description),0),input_schema_bytes:tools.reduce((n,t)=>n+Buffer.byteLength(JSON.stringify(t.inputSchema)),0),tools};
  }finally{await client.close();}
 }
 result.catalog_reduction_percent=100*(1-result.profiles.compact.catalog_bytes/result.profiles.full.catalog_bytes);
 const previous=JSON.parse(await readFile('eval/reports/real-world-2026-11-16-run2/results.json','utf8'));
 result.previous_benchmark={zen_task_catalog_bytes:previous.metadata.catalogs.zen.exposed_bytes,browse_execute_bytes:previous.metadata.catalogs.browse.exposed_bytes,source:'eval/reports/real-world-2026-11-16-run2/results.json'};
 if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({...result,profiles:Object.fromEntries(Object.entries(result.profiles).map(([k,{tools,...v}])=>[k,v]))},null,2));
}finally{await exec(binary,['--stop-relay'],{env,timeout:5000}).catch(()=>{});await rm(state,{recursive:true,force:true});}
