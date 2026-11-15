// Actual signed-in host agent -> native MCP runtime -> owned browser, no model API.
import {MCPClient} from './mcp-client.mjs';
import {ZenFixture} from './zen-fixture.mjs';
import {BrowseFixture} from './browse-fixture.mjs';
import {createFixtureServer,tasks} from './matched-fixture.mjs';
import {HostSession} from './host-session.mjs';
import {runCodexHost} from './codex-host.mjs';
import {provenance} from './provenance.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const root=resolve(process.env.BENCH_OUTPUT_DIR||'eval/reports/host-agent-2026-11-15');
const repetitions=Number(process.env.BENCH_REPETITIONS||1),model=process.env.BENCH_HOST_MODEL||'gpt-6.1-sol',effort=process.env.BENCH_HOST_EFFORT||'high';
if(!Number.isInteger(repetitions)||repetitions<1||repetitions>2)throw Error('Host repetitions must be 1 or 2');
const selectedTasks=process.env.BENCH_TASKS?tasks.filter(t=>process.env.BENCH_TASKS.split(',').includes(t.id)):tasks;
if(!selectedTasks.length)throw Error('No selected tasks');
const runtime=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
await mkdir(root,{recursive:false,mode:0o700});const state=await mkdtemp(join(tmpdir(),'callisto-host-')),environment={...process.env,CALLISTO_FIREFOX_STATE_DIR:join(state,'relay')};
const cwd=join(state,'workspace');await mkdir(cwd);const schema=join(state,'answer-schema.json');await writeFile(schema,JSON.stringify({type:'object',properties:{answer:{type:['string','number','boolean','null']}},required:['answer'],additionalProperties:false}));
const server=createFixtureServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
let client,zen,browse;const rows=[];let catalogs,versions;
const traceText=result=>result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'';
async function run(engine,task,iteration){
 if(engine==='zen'){await zen.navigate(origin+'/'+task.id);}
 else{const result=await browse.execute(`await page.goto(${JSON.stringify(origin+'/'+task.id)},{waitUntil:'domcontentloaded'});return null`);if(result.isError)throw Error('Browse fixture navigation failed');}
 const session=await new HostSession(engine==='zen'?client:browse.client,catalogs[engine]).start(join(state,'host.sock'));
 const prompt='Complete the browser task using ONLY the browser MCP tools. The browser is already on the task page. Inspect what you need and verify the result. Use targeted observations, batches or extraction when useful. Do not access external websites, local files, other agents or non-browser tools. Finish with JSON {"answer": ...}. Maximum 35 browser tool calls. '+(engine==='zen'?'Input is trusted BiDi in the shared Zen tab. Select frames explicitly. Tool results expose snapshot text, stable refs and structured rows. Navigation starts a page load; read a snapshot when needed.':`Use browse session ${browse.session}. The execute tool runs Playwright with page. Open shadow roots are supported by Playwright locators.`)+'\nTask: '+task.instruction;
 let host;try{host=await runCodexHost({cwd,socket:session.path,schema,model,effort,prompt});}finally{await session.close();}
 let answer=null;try{answer=JSON.parse(host.final).answer;}catch{}
 let statePassed=true;if(task.state){if(engine==='zen')statePassed=await zen.script('return document.body.dataset.done === "yes"');else{const result=await browse.execute('return await page.evaluate(()=>document.body.dataset.done === "yes")');statePassed=result.structuredContent?.value===true||traceText(result).trim()==='true'||traceText(result).includes('"value":true');}}
 const forbidden=host.events.filter(e=>e.type==='item.completed'&&['command_execution','web_search','file_change'].includes(e.item?.type));
 const approvalBlocked=host.events.some(e=>e.item?.type==='mcp_tool_call'&&/requires approval/.test(e.item.error?.message||''));
 const configurationError=host.events.some(e=>e.item?.type==='error'&&/unrecognized configuration/.test(e.item.message||''));
 const infrastructure=host.code!==0&&!host.timed_out||!host.usage||approvalBlocked||configurationError;
 const answerPassed=typeof task.answer==='number'?Number(answer)===task.answer:answer===task.answer;
 const success=answerPassed&&statePassed&&session.events.length>0&&!forbidden.length&&!host.timed_out&&!infrastructure;
 const row={engine,task:task.id,iteration,success:infrastructure?null:success,outcome:infrastructure?'infrastructure_error':success?'passed':'agent_failure',answer,expected_answer:task.answer,state_passed:statePassed,elapsed_ms:host.elapsed_ms,usage:host.usage,tool_calls:session.events.length,tool_failures:session.events.filter(e=>e.failed).length,response_bytes:session.events.reduce((sum,e)=>sum+(e.response_bytes||0),0),forbidden_tool_calls:forbidden.length,host_exit_code:host.code,timed_out:host.timed_out,cost_usd:null,trace_file:`${engine}-${task.id}-${iteration}.json`};
 await writeFile(join(root,row.trace_file),JSON.stringify({schema:'callisto.host-trace.v1',...row,prompt,host,tools:session.events},null,2)+'\n',{mode:0o600});return row;
}
async function report(){await writeFile(join(root,'results.json'),JSON.stringify({schema:'callisto.host-agent-report.v1',created_at:new Date().toISOString(),...await provenance(),host:'Codex CLI',versions,model,reasoning_effort:effort,repetitions,tasks:selectedTasks,catalogs,requested_runs:selectedTasks.length*repetitions*2,completed_agent_runs:rows.filter(r=>r.outcome!=='infrastructure_error').length,comparison_available:rows.length===selectedTasks.length*repetitions*2&&rows.every(r=>r.outcome!=='infrastructure_error'),cost_usd:null,cost_note:'Signed-in ChatGPT host. CLI token usage is retained; no per-run billed dollar cost was supplied. No API list-price estimate is substituted.',scope:'Small local fixture pilot; independent owned persistent Zen and Chromium profiles. Native catalogs and observations differ. Setup, navigation and evaluator calls excluded; elapsed includes host startup and MCP initialization. Private transport forwards unchanged tool arguments/results under the fixture sharing lease. Fresh host context and empty workspace per invocation; identical model, effort and policy. Visible events only; reasoning events omitted. No production reliability or broad parity claim.',budget:{max_sessions:selectedTasks.length*repetitions*2,max_calls_per_session:40,wall_timeout_ms_per_session:180000,stop_before_next_session_at_reported_tokens:1000000},results:rows},null,2)+'\n');}
try{
 const login=await exec('codex',['login','status']);if(!(login.stdout+login.stderr).includes('Logged in'))throw Error('Codex host is not signed in');
 client=await new MCPClient(runtime,[],environment).initialize();zen=new ZenFixture(client);await zen.start(origin+'/form');browse=new BrowseFixture();await browse.start(origin);
 const names=['callisto_snapshot','callisto_run','callisto_extract','callisto_find','callisto_click','callisto_fill','callisto_press','callisto_submit','callisto_frames','callisto_frame','callisto_page'];
 catalogs={zen:(await client.request('tools/list')).tools.filter(t=>names.includes(t.name)),browse:(await browse.client.request('tools/list')).tools.filter(t=>t.name==='execute')};versions={codex:(await exec('codex',['--version'])).stdout.trim(),zen:zen.capabilities.browserVersion,browse_cli:(await exec('browse',['--version'])).stdout.trim(),chromium:browse.browser.browser().version()};
 runs:for(let iteration=0;iteration<repetitions;iteration++)for(const task of selectedTasks)for(const engine of iteration%2?['browse','zen']:['zen','browse']){
  if(rows.reduce((n,r)=>n+(r.usage?.input_tokens||0)+(r.usage?.output_tokens||0),0)>=1000000)throw Error('Reported host token budget reached before the next session');
  const row=await run(engine,task,iteration);rows.push(row);await report();console.error(engine,task.id,iteration,row.outcome,Math.round(row.elapsed_ms)+'ms',JSON.stringify(row.usage));
  if(row.outcome==='infrastructure_error'||row.timed_out){process.exitCode=row.timed_out?1:2;break runs;}
 }
}finally{
 await browse?.close();await zen?.close();await client?.close();await exec(runtime,['--stop-relay'],{env:environment}).catch(()=>{});await rm(state,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));
}
