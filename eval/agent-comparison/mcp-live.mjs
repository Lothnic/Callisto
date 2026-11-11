// Host-scripted MCP observations on public sites. No model API is used.
import {Client} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/index.mjs'
import {StdioClientTransport} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/stdio.mjs'
import {writeFile} from 'node:fs/promises'
import {performance} from 'node:perf_hooks'
const tasks=[
 {id:'example',url:'https://example.com/',expected:'documentation'},
 {id:'rfc9110',url:'https://www.rfc-editor.org/rfc/rfc9110.html',expected:'HTTP Semantics'},
 {id:'iana',url:'https://www.iana.org/domains/reserved',expected:'example.com'},
 {id:'gutenberg',url:'https://www.gutenberg.org/ebooks/1342',expected:'Jane Austen'},
 {id:'wikipedia',url:'https://en.wikipedia.org/wiki/Ada_Lovelace',expected:'1815'},
 {id:'mdn',url:'https://developer.mozilla.org/en-US/docs/Web/HTTP',expected:'Hypertext Transfer Protocol'},
]
const env={...process.env,OPENROUTER_API_KEY:'',SILICONFLOW_KEY:'',SILICONFLOW_API_KEY:''}
const session=`callisto-live-mcp-${Date.now()}`, clients={},rows=[]
const output=process.env.BENCH_OUTPUT||'research/2026-11-mcp-live-comparison.json'
async function connect(command,args){const c=new Client({name:'callisto-live-mcp',version:'1'});await c.connect(new StdioClientTransport({command,args,env,stderr:'pipe'}));return c}
async function call(engine,name,args){const start=performance.now(),result=await clients[engine].callTool({name,arguments:args});if(result.isError)throw Error(result.content.map(x=>x.text||'').join(' ').slice(0,500));return {result,ms:Math.round(performance.now()-start)}}
try{
 clients.callisto=await connect(process.execPath,['packages/mini/dist/mcp.js']);clients.browse=await connect('browse',['mcp'])
 const allowedOrigins=tasks.map(t=>new URL(t.url).origin)
 await call('browse','session_new',{id:session,allowedOrigins})
 for(let i=0;i<tasks.length;i++)for(const engine of (i%2?['browse','callisto']:['callisto','browse'])){
  const task=tasks[i],start=performance.now();let text='',error=null,ms=null
  try{
   if(engine==='callisto'){const r=await call(engine,'callisto_navigate',{url:task.url});ms=r.ms;text=JSON.parse(r.result.content[0].text).text}
   else {const r=await call(engine,'execute',{session,code:`await page.goto(${JSON.stringify(task.url)},{waitUntil:'domcontentloaded',timeout:15000}); return await snapshot()`});ms=r.ms;text=String(r.result.structuredContent?.value??'')}
  }catch(e){error=String(e.message||e).slice(0,500)}
  const norm=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
  const foundInInitial=!error&&norm(text).includes(norm(task.expected))
  let foundWithFallback=foundInInitial, fallbackError=null, fallbackMs=0
  if (!error && !foundInInitial) {
   try {
    if (engine==='callisto') {
     const r=await call(engine,'callisto_find',{query:task.expected});fallbackMs=r.ms
     const found=JSON.parse(r.result.content[0].text);foundWithFallback=found.matches.length>0
    } else {
     const r=await call(engine,'execute',{session,code:`const text=await page.locator('body').innerText(); const term=${JSON.stringify(task.expected)}; return text.toLowerCase().includes(term.toLowerCase())`});fallbackMs=r.ms;foundWithFallback=r.result.structuredContent?.value===true
    }
   } catch(e) { fallbackError=String(e.message||e).slice(0,500) }
  }
  const row={engine,task:task.id,expected:task.expected,success:foundInInitial,foundWithFallback,fallbackMs,fallbackError,elapsedMs:ms??Math.round(performance.now()-start),snapshotChars:text.length,expectedOffset:norm(text).indexOf(norm(task.expected)),error}
  rows.push(row);console.error(`${engine} ${task.id}: ${row.success?'PASS':'FAIL'}${error?' '+error.slice(0,100):''}`)
  await writeFile(output,JSON.stringify({date:new Date().toISOString(),notes:'Host-scripted native MCP snapshots on dynamic public pages; one trial each; different browser profiles/binaries; no model.',tasks,rows},null,2)+'\n')
 }
}finally{
 if(clients.browse)await call('browse','session_delete',{id:session}).catch(()=>{})
 if(clients.callisto)await call('callisto','callisto_close',{}).catch(()=>{})
 for(const c of Object.values(clients))await c.close().catch(()=>{})
}
