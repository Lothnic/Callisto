// Deterministic host-driven MCP comparison; no LLM or external model API.
import {Client} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/index.mjs'
import {StdioClientTransport} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/stdio.mjs'
import {createServer} from 'node:http'
import {performance} from 'node:perf_hooks'
import {writeFile} from 'node:fs/promises'

const done = new Map()
const escape = x => String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const web=createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost'), key=u.searchParams.get('key')||'', safe=escape(key)
  if(u.pathname==='/mark'){done.set(key,u.searchParams.get('value')||'yes');res.writeHead(204);return res.end()}
  res.setHeader('content-type','text/html; charset=utf-8')
  const mark=`fetch('/mark?key=${encodeURIComponent(key)}')`
  let body=''
  if(u.pathname==='/form')body=`<label>Fruit <input id="fruit"></label><button onclick="fetch('/mark?key=${encodeURIComponent(key)}&value='+encodeURIComponent(document.querySelector('#fruit').value));document.querySelector('output').textContent='Saved '+document.querySelector('#fruit').value">Save</button><output></output>`
  else if(u.pathname==='/disabled')body=`<button disabled onclick="${mark}">Continue</button><script>setTimeout(()=>document.querySelector('button').disabled=false,1200)</script>`
  else if(u.pathname==='/covered')body=`<div style="display:inline-block;position:relative"><button onclick="${mark}">Confirm</button><div id="cover" style="position:absolute;inset:0;background:gray"></div></div><script>setTimeout(()=>document.querySelector('#cover').remove(),1200)</script>`
  else if(u.pathname==='/frame')body=`<h1>Frame fixture</h1><iframe title="Child" src="/inner?key=${encodeURIComponent(key)}"></iframe>`
  else if(u.pathname==='/inner')body=`<button onclick="${mark}">Inside frame</button>`
  else if(u.pathname==='/link')body=`<h1>Link fixture</h1><a href="/destination?key=${encodeURIComponent(key)}">Next page</a>`
  else if(u.pathname==='/destination'){done.set(key,'yes');body='<h1>Destination reached</h1>'}
  else body='<h1>Snapshot fixture</h1><button>Visible action</button><p>Fixture text</p>'
  res.end(`<!doctype html><title>${safe}</title><body>${body}</body>`)
})
await new Promise(r=>web.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${web.address().port}`
const repeat=Number(process.env.BENCH_REPETITIONS||3)
const browseTimeout=Number(process.env.BROWSE_ACTION_TIMEOUT_MS||3000)
const output=process.env.BENCH_OUTPUT||'research/2026-11-mcp-comparison-results.json'
const env={...process.env,OPENROUTER_API_KEY:'',SILICONFLOW_KEY:'',SILICONFLOW_API_KEY:''}
const clients={};const rows=[];let session
async function client(command,args){const c=new Client({name:'callisto-mcp-comparison',version:'1.0'});await c.connect(new StdioClientTransport({command,args,env,stderr:'pipe'}));return c}
async function tool(engine,name,args={}){
 const t=performance.now();const out=await clients[engine].callTool({name,arguments:args});const ms=performance.now()-t
 if(out.isError)throw new Error((out.content||[]).map(x=>x.text||'').join(' ').slice(0,600))
 return {out,ms,chars:JSON.stringify(out.content).length}
}
async function navigate(engine,url){
 if(engine==='callisto'){const r=await tool(engine,'callisto_navigate',{url});const data=JSON.parse(r.out.content[0].text);return {...r,snapshot:data.text}}
 const r=await tool(engine,'execute',{session,code:`await page.goto(${JSON.stringify(url)},{waitUntil:'domcontentloaded',timeout:10000}); return await snapshot()`});return {...r,snapshot:String(r.out.structuredContent?.value??r.out.content[0]?.text??'')}
}
async function action(engine,op,name,ref,value){
 if(engine==='callisto'){if(!ref)throw new Error('target absent from snapshot');return tool(engine,op==='fill'?'callisto_fill':'callisto_click',op==='fill'?{ref,value}:{ref})}
 let code=op==='frame'?`await page.frameLocator('iframe').getByRole('button',{name:${JSON.stringify(name)},exact:true}).click({timeout:${browseTimeout}}); return await snapshot()`:
 `await page.getByRole(${JSON.stringify(op==='fill'?'textbox':op==='link'?'link':'button')},{name:${JSON.stringify(name)},exact:true}).${op==='fill'?`fill(${JSON.stringify(value)},{timeout:${browseTimeout}})`:`click({timeout:${browseTimeout}})`}; return await snapshot()`
 return tool(engine,'execute',{session,code})
}
const cases=[
 {id:'snapshot',path:'/snapshot',target:'Visible action',kind:'snapshot'},
 {id:'form',path:'/form',target:'Fruit',kind:'form'},
 {id:'disabled',path:'/disabled',target:'Continue',kind:'click'},
 {id:'covered',path:'/covered',target:'Confirm',kind:'click'},
 {id:'iframe',path:'/frame',target:'Inside frame',kind:'frame'},
 {id:'link',path:'/link',target:'Next page',kind:'link'},
]
function findRef(snapshot,name){const line=snapshot.split('\n').find(s=>s.includes(`"${name}"`) && /\[ax-\d+\]/.test(s));return line?.match(/\[(ax-\d+)\]/)?.[1]}
async function trial(engine,task,i){
 const key=`${engine}-${task.id}-${i}`, timings=[], sizes=[], begin=performance.now(); let error=null, success=false, snapshot='', attempts=0
 try{
  attempts++;const nav=await navigate(engine,`${origin}${task.path}?key=${key}`);timings.push(nav.ms);sizes.push(nav.chars);snapshot=nav.snapshot
  if(task.kind==='snapshot')success=snapshot.includes('Snapshot fixture')&&snapshot.includes('Visible action')
  else {
   let ref=findRef(snapshot,task.target)
   if(task.kind==='form'){
    attempts++;let r=await action(engine,'fill','Fruit',ref,'mango');timings.push(r.ms);sizes.push(r.chars)
    if(engine==='callisto')snapshot=JSON.parse(r.out.content[0].text).text
    ref=findRef(snapshot,'Save');attempts++;r=await action(engine,'click','Save',ref);timings.push(r.ms);sizes.push(r.chars)
   } else {attempts++;const r=await action(engine,task.kind,task.target,ref);timings.push(r.ms);sizes.push(r.chars)}
   for(let j=0;j<30&&!done.has(key);j++)await new Promise(r=>setTimeout(r,100))
   success=done.get(key)===(task.kind==='form'?'mango':'yes')
   if(!success)throw new Error('fixture outcome not observed')
  }
 } catch(e){error=String(e.message||e).slice(0,600)}
 return {engine,task:task.id,trial:i,success,error,toolCalls:attempts,successfulToolMs:Math.round(timings.reduce((a,b)=>a+b,0)),elapsedMs:Math.round(performance.now()-begin),outputChars:sizes.reduce((a,b)=>a+b,0),snapshotChars:snapshot.length}
}
try{
 clients.callisto=await client(process.execPath,['packages/mini/dist/mcp.js'])
 clients.browse=await client('browse',['mcp'])
 session=`callisto-mcp-compare-${Date.now()}`
 await tool('browse','session_new',{id:session,allowedOrigins:[origin]})
 const toolCatalog={};for(const name of ['callisto','browse'])toolCatalog[name]=(await clients[name].listTools()).tools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema}))
 for(let i=0;i<repeat;i++)for(const [j,task] of cases.entries())for(const engine of ((i+j)%2?['browse','callisto']:['callisto','browse'])){
  const row=await trial(engine,task,i);rows.push(row);process.stderr.write(`${engine} ${task.id} ${i+1}: ${row.success?'PASS':'FAIL'}${row.error?' '+row.error.slice(0,100):''}\n`)
  await writeFile(output,JSON.stringify({date:new Date().toISOString(),repeat,origin,browseTimeout,notes:'Scripted host actions, not an autonomous agent; local fixtures, different browser binaries/profiles; timing includes MCP and page operations, not model latency.',toolCatalog,rows},null,2)+'\n')
 }
}finally{
 if(clients.browse&&session)await tool('browse','session_delete',{id:session}).catch(()=>{})
 if(clients.callisto)await tool('callisto','callisto_close').catch(()=>{})
 for(const c of Object.values(clients))await c.close().catch(()=>{})
 web.closeAllConnections();await new Promise(r=>web.close(r))
}
