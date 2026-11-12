// Reproducible host-scripted comparison. No model API, user profiles or Internet pages.
import {Client} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/index.mjs'
import {StdioClientTransport} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/stdio.mjs'
import {createServer} from 'node:http'
import {performance} from 'node:perf_hooks'
import {writeFile} from 'node:fs/promises'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {installFirefoxFixture} from './firefox-extension-fixture.mjs'
import {execFileSync} from 'node:child_process'
const extension=process.env.BENCH_FIREFOX_MODE==='extension'
const relayState=extension?await mkdtemp(tmpdir()+'/callisto-bench-'):null
let closeFixture
const repetitions=Number(process.env.BENCH_REPETITIONS||12)
const output=process.env.BENCH_OUTPUT||(extension?'research/2026-11-12-chromium-vs-rust-extension.json':'research/2026-11-12-chromium-vs-rust-firefox.json')
const server=createServer((req,res)=>{
 const n=req.url.startsWith('/large')?1000:30
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'})
 res.end(`<!doctype html><title>Benchmark</title><label>Name <input id="name"></label><label>Password <input type="password" value="hidden-secret"></label><button onclick="document.getElementById('result').textContent='Saved '+document.getElementById('name').value">Save</button><h2 id="result">Ready</h2>${Array.from({length:n},(_,i)=>`<button>Item ${i}</button><p>Fixture paragraph ${i}</p>`).join('')}`)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const base=`http://127.0.0.1:${server.address().port}`
const clients={},rows=[],startups=[],stderr={}
const env={...process.env,CALLISTO_MCP_BROWSER:'isolated',CALLISTO_MCP_HEADLESS:'1',CALLISTO_BROWSER:'firefox',CHROME_PATH:'/snap/bin/chromium',CALLISTO_NO_SANDBOX:'1',...(relayState?{CALLISTO_FIREFOX_STATE_DIR:relayState}:{})}
const defs={chromium:{command:process.execPath,args:['packages/mini/dist/mcp.js']},[extension?'rust_firefox_extension':'rust_firefox_bidi']:{command:extension?'packages/firefox-rs/target/release/callisto-firefox-tab-mcp':'packages/firefox-rs/target/release/callisto-firefox-mcp',args:[]}}
function decoded(r){if(r.isError)throw Error(r.content.map(x=>x.text||'').join(' '));return JSON.parse(r.content.find(x=>x.type==='text').text)}
async function call(engine,name,args={}){
 const raw=async(n,a={})=>decoded(await clients[engine].callTool({name:n,arguments:a},{timeout:45000}))
 if(engine==='rust_firefox_extension'){
  if(name==='callisto_find')return raw('callisto_page',{action:'find',query:args.query})
  if(name==='callisto_navigate'){
   await raw(name,args)
   for(let i=0;i<400;i++){
    const status=await raw('callisto_status')
    if(status.ready){const snap=await raw('callisto_snapshot');if(snap.url===args.url)return snap}
    await new Promise(r=>setTimeout(r,10))
   }
   throw Error('Navigation did not become ready')
  }
  if(['callisto_click','callisto_fill'].includes(name)){await raw(name,args);return raw('callisto_snapshot')}
 }
 return raw(name,args)
}
async function timed(engine,task,iteration,work){const start=performance.now();try{const value=await work(); rows.push({engine,task,iteration,ok:true,ms:performance.now()-start,chars:typeof value?.text==='string'?value.text.length:undefined});return value}catch(e){rows.push({engine,task,iteration,ok:false,ms:performance.now()-start,error:String(e.message||e).slice(0,800)});console.error(engine,task,'FAIL',String(e.message).slice(0,180));return null}}
const ref=(s,role,name)=>{const line=s.text.split('\n').find(x=>x.includes(`${role} ${JSON.stringify(name)}`));if(!line)throw Error(`Missing ${role} ${name}`);return line.match(/\[(ax-\d+)\]/)[1]}
function assert(v,m){if(!v)throw Error(m)}
function persist(){const summary={};for(const task of [...new Set(rows.map(r=>r.task))])for(const engine of Object.keys(defs)){const group=rows.filter(r=>r.task===task&&r.engine===engine);const times=group.filter(r=>r.ok).map(r=>r.ms).sort((a,b)=>a-b);summary[`${engine}:${task}`]={supported:group.length>0,success:times.length,total:group.length,medianMs:times.length?times[Math.floor(times.length/2)]:null,p95Ms:times.length?times[Math.ceil(times.length*.95)-1]:null}}
 return writeFile(output,JSON.stringify({date:new Date().toISOString(),sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeDirty:true,repetitions,notes:'Release Rust, built TypeScript/Node; extension lane (when selected) adds post-action snapshots and navigation readiness polling; browser/extension installation excluded from its timings; no batch tool in extension lane; isolated headless browsers, native MCP tools, local deterministic fixtures. Warm trials exclude initial navigation. Different browsers/protocols/implementations; not a Rust-vs-JS language benchmark. p95 is descriptive with a small sample. Success-only timings; inspect failures.',versions:{node:process.version,chromium:execFileSync('/snap/bin/chromium',['--version'],{encoding:'utf8'}).trim(),firefox:execFileSync('firefox',['--version'],{encoding:'utf8'}).trim()},startups,summary,rows,stderr},null,2)+'\n')}
try{
 for(const [engine,def]of Object.entries(defs)){
  const start=performance.now();const transport=new StdioClientTransport({...def,env,stderr:'pipe'});stderr[engine]='';transport.stderr?.on('data',d=>{stderr[engine]=(stderr[engine]+d).slice(-6000)})
  const client=new Client({name:'callisto-runtime-bench',version:'1'});clients[engine]=client;await client.connect(transport);startups.push({engine,handshakeMs:performance.now()-start})
  if(engine==='rust_firefox_extension')closeFixture=await installFirefoxFixture(client,base+'/small')
  else await timed(engine,'cold_first_navigation',-1,()=>call(engine,'callisto_navigate',{url:base+'/small'}))
 }
 for(let i=0;i<repetitions;i++){
  for(const engine of (i%2?Object.keys(defs).reverse():Object.keys(defs))){
   await timed(engine,'ping_100',i,async()=>{for(let n=0;n<100;n++)await clients[engine].ping()})
   for(const size of ['small','large']){
    await timed(engine,`navigate_${size}`,i,()=>call(engine,'callisto_navigate',{url:base+'/'+size}))
    const snap=await timed(engine,`snapshot_${size}`,i,async()=>{const s=await call(engine,'callisto_snapshot');assert(!s.text.includes('hidden-secret'),'Password leaked');assert(s.text.includes('[REDACTED]'),'Password redaction marker missing');return s})
    await timed(engine,`find_${size}`,i,async()=>{const r=await call(engine,'callisto_find',{query:'Save'});assert(r.matches.length>0,'Find failed');return r})
    if(size==='small'&&snap){
     const s=await call(engine,'callisto_snapshot')
     await timed(engine,'form_fill_click_snapshot',i,async()=>{await call(engine,'callisto_fill',{ref:ref(s,'textbox','Name'),value:'trial-'+i});const r=await call(engine,'callisto_click',{ref:ref(s,'button','Save')});assert(r.text.includes('Saved trial-'+i),'Form result missing');return r})
     if(engine!=='rust_firefox_extension')await timed(engine,'batch_form',i,async()=>{const r=await call(engine,'callisto_batch',{actions:[{action:'fill_role',role:'textbox',name:'Name',value:'batch-'+i},{action:'click_role',role:'button',name:'Save'}]});assert(r.snapshot.text.includes('Saved batch-'+i),'Batch result missing');return r.snapshot})
    }
   }
  }
  await persist();console.error(`Completed ${i+1}/${repetitions}`)
 }
}finally{
 for(const [engine,client]of Object.entries(clients)){await call(engine,'callisto_close').catch(()=>{});await client.close().catch(()=>{})}
 if(closeFixture)await closeFixture()
 if(relayState){execFileSync('packages/firefox-rs/target/release/callisto-firefox-tab-mcp',['--stop-relay'],{env});await rm(relayState,{recursive:true,force:true})}
 server.close();await persist()
}
