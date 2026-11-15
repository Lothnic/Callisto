import {provenance} from './provenance.mjs';
// Same model/policy/tasks; native MCP tools, independent owned browser profiles.
import {MCPClient} from './mcp-client.mjs';
import {ZenFixture,value,until} from './zen-fixture.mjs';
import {BrowseFixture} from './browse-fixture.mjs';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile),root=resolve(process.env.BENCH_OUTPUT_DIR||'eval/reports/matched-agent-2026-11-15'),runtime=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
const provider=process.env.BENCH_PROVIDER||'siliconflow';if(!['siliconflow','openrouter'].includes(provider))throw Error('Unsupported provider');
const repetitions=Number(process.env.BENCH_REPETITIONS||2),model=process.env.BENCH_MODEL||(provider==='openrouter'?'tencent/hy3':'tencent/Hy3');
if(!Number.isInteger(repetitions)||repetitions<1||repetitions>5)throw Error('BENCH_REPETITIONS must be an integer from 1 to 5');
const hy3=['tencent/hy3','tencent/hy3-preview','tencent/Hy3'].includes(model);
const envLines=(await readFile('.env','utf8').catch(()=>'' )).split(/\r?\n/);
const keyName=provider==='openrouter'?'OPENROUTER_API_KEY':'SILICONFLOW_KEY';
const key=process.env[keyName]||envLines.find(line=>line.startsWith(keyName+'='))?.slice(keyName.length+1).trim().replace(/^['"]|['"]$/g,'');
if(!key)throw Error('The configured benchmark provider credential is unavailable');
const budget={maxModelCalls:100,maxTotalTokens:250000,usedTokens:0,calls:0};
const state=await mkdtemp(join(tmpdir(),'callisto-matched-'));let zen,browse,client;const results=[];
const tasks=[{id:'form',instruction:'Enter Mango in Fruit and submit the form. Report the resulting heading.',answer:'Saved Mango',state:true},{id:'grid',instruction:'Find the total Amount of every order across both pages. Report a number.',answer:210},{id:'frame',instruction:'Confirm the action inside the embedded frame, including its open shadow root. Report confirmed.',answer:'confirmed',state:true},{id:'search',instruction:'Find the stock quantity for Aster helmet. Report the integer quantity.',answer:17}];
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture');res.setHeader('Content-Type','text/html; charset=utf-8');let body='';
 if(url.pathname==='/form')body='<form action="/saved"><label>Fruit <input name="fruit" required></label><button>Save</button></form>';
 if(url.pathname==='/saved'){const fruit=(url.searchParams.get('fruit')||'').replace(/[^a-z]/gi,'');body=`<h1>Saved ${fruit}</h1><script>document.body.dataset.done=${JSON.stringify(fruit==='Mango'?'yes':'no')}</script>`;}
 if(url.pathname==='/grid'){const page=Number(url.searchParams.get('page')||1);body='<h1>Orders</h1><table><thead><tr><th>Order</th><th>Amount</th></tr></thead><tbody>'+Array.from({length:3},(_,i)=>{const n=(page-1)*3+i+1;return `<tr><td>${n}</td><td>${n*10}</td></tr>`;}).join('')+'</tbody></table>'+(page===1?'<a class="next" href="/grid?page=2">Next page</a>':'<span class="next disabled">End</span>');}
 if(url.pathname==='/frame')body='<h1>Confirmation</h1><iframe title="Action" src="/inner"></iframe><p id="result">Waiting</p>';
 if(url.pathname==='/inner')body=`<div id="shadow"></div><script>shadow.attachShadow({mode:'open'}).innerHTML='<button>Confirm</button>';shadow.shadowRoot.querySelector('button').onclick=e=>{parent.document.body.dataset.done=e.isTrusted?'yes':'untrusted';parent.document.querySelector('#result').textContent='confirmed';};</script>`;
 if(url.pathname==='/search'){const q=url.searchParams.get('q')||'';body='<h1>Inventory</h1><form><label>Search inventory <input type="search" name="q"></label><button>Search</button></form><div id="products">'+(q.toLowerCase().includes('aster')?'<div class="product"><span>Aster helmet</span><span>Stock: 17</span></div>':Array.from({length:600},(_,i)=>`<div class="product"><span>${i===487?'Aster helmet':'Fixture item '+i}</span><span>Stock: ${i===487?17:i%29}</span></div>`).join(''))+'</div>';}
 res.end('<!doctype html><title>Matched local fixture</title><body>'+body+'</body>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
function text(result){return result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||JSON.stringify(result.structuredContent??result);}
async function complete(messages,tools){
 const payload={model,temperature:0,max_tokens:800,messages,tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}))};
 const upper=Buffer.byteLength(JSON.stringify(payload))+payload.max_tokens;
 if(budget.calls>=budget.maxModelCalls||budget.usedTokens+upper>budget.maxTotalTokens)throw Error('Shared model budget reached; remaining runs must not be reported as completed');
 budget.calls++;const started=performance.now();
 const response=await fetch(provider==='openrouter'?'https://openrouter.ai/api/v1/chat/completions':'https://api.siliconflow.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
 const data=await response.json();if(!response.ok)throw Error(response.status===402?'Provider HTTP 402: insufficient credit':`Provider HTTP ${response.status}: ${String(data.error?.message||'request failed').slice(0,200)}`);
 if(!data.usage||!Number.isFinite(data.usage.prompt_tokens)||!Number.isFinite(data.usage.completion_tokens))throw Error('Provider did not supply real token usage');
 budget.usedTokens+=data.usage.prompt_tokens+data.usage.completion_tokens;
 return {message:data.choices?.[0]?.message,usage:data.usage,servedBy:data.provider||provider,elapsed_ms:performance.now()-started};
}
function answerOf(content){try{return JSON.parse(content.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')).answer;}catch{return null;}}
async function run(engine,task,iteration,tools){
 const selected=engine==='zen'?client:browse.client;let statusError=null;
 if(engine==='zen'){await zen.request(`/session/${zen.session}/url`,{url:origin+'/'+task.id});await until(async()=>{const s=await zen.call('callisto_status');return s.ready;});await zen.call('callisto_frame',{frame_id:0});}
 else {const r=await browse.execute(`await page.goto(${JSON.stringify(origin+'/'+task.id)},{waitUntil:'domcontentloaded'}); return null`);if(r.isError)throw Error('Browse task setup failed: '+text(r));}
 const messages=[{role:'system',content:'Complete the local browser task using the supplied native MCP tools. Inspect what you need; use targeted observations, batches or extraction when useful. Do not use external sites or local files. Finish with ONLY JSON {"answer": ...}. Do not guess success after an error. The browser is already on the task page. '+(engine==='browse'?`Use session ${browse.session}. The execute tool runs Playwright with page. Open shadow roots are supported by Playwright locators.`:'Input is trusted BiDi in the shared Zen tab. Select frames explicitly. Tool results expose snapshot text, stable refs, and structured rows. A navigation call starts navigation; read a snapshot when needed.')} ,{role:'user',content:task.instruction}];
 const trace=[],usage={prompt_tokens:0,completion_tokens:0},started=performance.now();let answer=null,toolCalls=0,toolFailures=0,responseBytes=0,actualCost=0,costComplete=true;const servedBy=new Set();
 for(let turn=0;turn<8;turn++){
  let modelResult;try{modelResult=await complete(messages,tools);}catch(error){statusError=error.message;break;}
  const {message}=modelResult;servedBy.add(modelResult.servedBy);if(typeof modelResult.usage.cost==='number')actualCost+=modelResult.usage.cost;else costComplete=false;usage.prompt_tokens+=modelResult.usage.prompt_tokens;usage.completion_tokens+=modelResult.usage.completion_tokens;
  if(!message){statusError='Provider supplied no message';break;}
  // Only visible text and tool calls are retained, never private reasoning fields.
  const visible={role:'assistant',content:message.content??null,...(message.tool_calls?{tool_calls:message.tool_calls}:{})};messages.push(visible);
  const event={turn,assistant:visible,usage:modelResult.usage,model_ms:modelResult.elapsed_ms,tools:[]};trace.push(event);
  if(!message.tool_calls?.length){answer=answerOf(message.content||'');break;}
  for(const call of message.tool_calls){
   const begin=performance.now();let result;toolCalls++;
   try{const args=JSON.parse(call.function.arguments);assert(tools.some(t=>t.name===call.function.name),'Tool is outside this task catalog');result=await selected.callTool({name:call.function.name,arguments:args},{timeout:40000});}catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
   if(result.isError)toolFailures++;const output=text(result);responseBytes+=Buffer.byteLength(output);
   event.tools.push({name:call.function.name,arguments:call.function.arguments,result,elapsed_ms:performance.now()-begin,response_bytes:Buffer.byteLength(output)});
   messages.push({role:'tool',tool_call_id:call.id,content:output});
  }
 }
 let statePassed=true;if(task.state){if(engine==='zen')statePassed=await zen.script('return document.body.dataset.done === "yes"');else{const result=await browse.execute('return await page.evaluate(()=>document.body.dataset.done === "yes")');const parsed=result.structuredContent?.value;statePassed=parsed===true||text(result).trim()==='true'||text(result).includes('"value":true');}}
 const answerPassed=typeof task.answer==='number'?Number(answer)===task.answer:answer===task.answer;
 const infrastructureError=statusError&&/^(Provider|Shared model budget|Provider did not)/.test(statusError);
 const row={engine,task:task.id,iteration,success:infrastructureError?null:statePassed&&answerPassed&&!statusError,outcome:infrastructureError?'infrastructure_error':statePassed&&answerPassed&&!statusError?'passed':'agent_failure',served_by:[...servedBy],provider_reported_cost_usd:costComplete&&trace.length?actualCost:null,answer,expected_answer:task.answer,state_passed:statePassed,error:statusError,elapsed_ms:performance.now()-started,tool_calls:toolCalls,tool_failures:toolFailures,response_bytes:responseBytes,usage,estimated_uncached_cost_usd:hy3?(usage.prompt_tokens*.132+usage.completion_tokens*.528)/1e6:null,trace_file:`${engine}-${task.id}-${iteration}.json`};
 await writeFile(join(root,row.trace_file),JSON.stringify({schema:'callisto.matched-trace.v1',...row,trace},null,2)+'\n',{mode:0o600});return row;
}
try{
 await mkdir(root,{recursive:false,mode:0o700});client=await new MCPClient(runtime,[],{...process.env,CALLISTO_FIREFOX_STATE_DIR:state}).initialize();zen=new ZenFixture(client);await zen.start(origin+'/form');browse=new BrowseFixture();await browse.start(origin);
 const zenNames=['callisto_snapshot','callisto_run','callisto_extract','callisto_find','callisto_click','callisto_fill','callisto_press','callisto_submit','callisto_frames','callisto_frame','callisto_page'];
 const catalogs={zen:(await client.request('tools/list')).tools.filter(t=>zenNames.includes(t.name)),browse:(await browse.client.request('tools/list')).tools.filter(t=>t.name==='execute')};
 runs: for(let iteration=0;iteration<repetitions;iteration++)for(const task of tasks)for(const engine of iteration%2?['browse','zen']:['zen','browse']){
  const row=await run(engine,task,iteration,catalogs[engine]);results.push(row);console.error(engine,task.id,iteration,row.success?'PASS':'FAIL',row.error||'',row.usage.prompt_tokens+row.usage.completion_tokens);
  await writeFile(join(root,'results.json'),JSON.stringify({schema:'callisto.matched-agent-report.v1',created_at:new Date().toISOString(),...await provenance(),model,provider,browser_versions:{zen:zen.capabilities.browserVersion,browse_cli:(await exec('browse',['--version'])).stdout.trim()},viewport:{width:1440,height:900},repetitions,tasks,catalogs,budget,pricing:hy3?{basis:'Estimated uncached list price, not an invoice; caching discounts excluded',input_usd_per_million:.132,output_usd_per_million:.528,source:provider==='openrouter'?'https://openrouter.ai/api/v1/models':'https://www.siliconflow.com/models/tencent',checked_at:'2026-11-15'}:null,comparison_available:results.length===tasks.length*repetitions*2&&results.every(r=>r.outcome!=='infrastructure_error'),requested_runs:tasks.length*repetitions*2,completed_agent_runs:results.filter(r=>r.outcome!=='infrastructure_error').length,scope:'Local fixtures; independent persistent test profiles; setup, navigation and evaluator calls excluded from timing/tool totals. Different native tool schemas and observations; restricted task catalogs disclosed above. No production reliability claim.',results},null,2)+'\n');
  if(row.outcome==='infrastructure_error'){process.exitCode=2;console.error('Model access blocked; no valid matched comparison can be concluded.');break runs;}
 }
}finally{await browse?.close();await zen?.close();await client?.close();await exec(runtime,['--stop-relay'],{env:{...process.env,CALLISTO_FIREFOX_STATE_DIR:state}}).catch(()=>{});await rm(state,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));}
