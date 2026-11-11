// Compare a fixed local form workflow, including browse's one-call batching.
import {Client} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/index.mjs'
import {StdioClientTransport} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/stdio.mjs'
import {createServer} from 'node:http'
import {performance} from 'node:perf_hooks'
import {writeFile} from 'node:fs/promises'
const seen=new Map(),web=createServer((q,r)=>{const u=new URL(q.url,'http://localhost'),key=u.searchParams.get('key');if(u.pathname==='/mark'){seen.set(key,u.searchParams.get('value'));r.writeHead(204);return r.end()}r.setHeader('content-type','text/html');r.end(`<label>Fruit <input id="fruit"></label><button onclick="fetch('/mark?key=${encodeURIComponent(key)}&value='+document.querySelector('#fruit').value)">Save</button>`)});
const output=process.env.BENCH_OUTPUT||'research/2026-11-mcp-batching-results.json'
await new Promise(r=>web.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${web.address().port}`,session=`callisto-batch-${Date.now()}`;const env={...process.env,OPENROUTER_API_KEY:'',SILICONFLOW_KEY:''};let c,b;const rows=[]
async function connect(cmd,args){const client=new Client({name:'mcp-batching',version:'1'});await client.connect(new StdioClientTransport({command:cmd,args,env,stderr:'pipe'}));return client}
async function call(client,name,args){const v=await client.callTool({name,arguments:args});if(v.isError)throw Error(v.content?.map(x=>x.text).join(' ').slice(0,400));return v}
try{
 c=await connect(process.execPath,['packages/mini/dist/mcp.js']);b=await connect('browse',['mcp']);await call(b,'session_new',{id:session,allowedOrigins:[origin]})
 for(let i=0;i<3;i++)for(const engine of (i%2?['browse','callisto']:['callisto','browse'])){
  const key=`${engine}-${i}`,url=`${origin}/?key=${key}`,start=performance.now();let error=null,calls=0
  try{if(engine==='browse'){
   calls++;await call(b,'execute',{session,code:`await page.goto(${JSON.stringify(url)}); await page.getByRole('textbox',{name:'Fruit'}).fill('mango'); await page.getByRole('button',{name:'Save'}).click(); return await snapshot()`})
  }else{
   calls++;await call(c,'callisto_batch',{actions:[{action:'navigate',url},{action:'fill_role',role:'textbox',name:'Fruit',value:'mango'},{action:'click_role',role:'button',name:'Save'}]})
  }
  for(let j=0;j<20&&!seen.has(key);j++)await new Promise(r=>setTimeout(r,100));if(seen.get(key)!=='mango')throw Error('fixture outcome missing')
  }catch(e){error=String(e.message||e)}
  const row={engine,trial:i,success:!error,error,toolCalls:calls,elapsedMs:Math.round(performance.now()-start)};rows.push(row);console.error(JSON.stringify(row));await writeFile(output,JSON.stringify({date:new Date().toISOString(),notes:'Fixed host-scripted local form; both engines batch actions into one MCP call; differing browser profiles and human input settings; not an LLM task.',rows},null,2)+'\n')
 }
}finally{if(b)await call(b,'session_delete',{id:session}).catch(()=>{});if(c)await call(c,'callisto_close',{}).catch(()=>{});await b?.close();await c?.close();web.closeAllConnections();await new Promise(r=>web.close(r))}
