// Model-selected browser actions on fresh owned account cases; judge reads server state.
import {MCPClient} from './mcp-client.mjs';import {ZenFixture} from './zen-fixture.mjs';import {BrowseFixture} from './browse-fixture.mjs';
import {HostSession} from './host-session.mjs';import {runCodexHost} from './codex-host.mjs';import {policyViolations} from './policy-audit.mjs';
import {createAccountFixture,accountTasks,evaluateAccount} from './account-fixture.mjs';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve,join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
const exec=promisify(execFile),hash=x=>createHash('sha256').update(x).digest('hex');
const root=resolve(process.env.BENCH_OUTPUT_DIR||'eval/reports/luna-step5-account-2026-11-17'),model=process.env.BENCH_HOST_MODEL||'gpt-6-luna',effort=process.env.BENCH_HOST_EFFORT||'high',repetitions=Number(process.env.BENCH_REPETITIONS||2);
const selected=accountTasks.filter(t=>!process.env.BENCH_TASKS||process.env.BENCH_TASKS.split(',').includes(t.id));
if(!selected.length||!Number.isInteger(repetitions)||repetitions<1||repetitions>2)throw Error('Select known account tasks and 1–2 repetitions');
await mkdir(root,{recursive:false,mode:0o700});const state=await mkdtemp(join(tmpdir(),'callisto-account-agent-')),cwd=join(state,'workspace');await mkdir(cwd);
const binary=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp'),environment={...process.env,CALLISTO_TOOL_PROFILE:'compact',CALLISTO_FIREFOX_STATE_DIR:join(state,'relay')};
const schema=join(state,'answer-schema.json');await writeFile(schema,JSON.stringify({type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}));
const fixture=createAccountFixture();await new Promise(r=>fixture.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+fixture.server.address().port;
let client,zen,browse,metadata;const rows=[];let sequence=0;
async function save(){await writeFile(join(root,'results.json'),JSON.stringify({schema:'callisto.account-agent.v1',created_at:new Date().toISOString(),host:'codex',model,reasoning_effort:effort,repetitions,planned_runs:selected.length*repetitions*2,completed_runs:rows.length,tasks:selected,metadata,cost_usd:null,measurement:'Fresh model conversation and fresh authenticated local case per trial. Provisioning, login and neutral-tab cleanup are excluded and recorded. Task elapsed includes host startup, model turns, errors, waits, shutdown and independent server-state/tab verification. Native initialization instructions are forwarded. Per-case HTTP-only cookies are test-only; no personal accounts. No official external benchmark score is claimed.',budget:{max_mcp_calls:35,host_timeout_ms:180000,stop_before_next_session_at_reported_tokens:4000000},results:rows},null,2)+'\n');}
async function prepare(engine,caseRow){
 const prefix=origin+'/case/'+caseRow.key+'/',login=prefix+'login';
 if(engine==='zen'){
  await zen.navigate(login);await zen.call('callisto_input',{action:'disable'});
  const tabs=(await zen.call('callisto_browser',{action:'tabs_list'})).tabs;
  for(const tab of tabs)if(tab.id!==zen.tabId&&tab.url?.startsWith(origin+'/case/'))await zen.call('callisto_browser',{action:'tab_close',tab_id:tab.id});
  await zen.call('callisto_browser',{action:'tab_select',tab_id:zen.tabId});
  await zen.call('callisto_browser',{action:'fixture_full_access',enabled:true});
 }else{
  const result=await browse.execute(`await page.goto(${JSON.stringify(login)},{waitUntil:'domcontentloaded'});return {url:page.url()}`);if(result.isError)throw Error('Owned account login failed');
  for(const page of browse.browser.pages())if(page.url().startsWith(origin+'/case/')&&!page.url().startsWith(prefix))await page.close();
 }
 return prefix;
}
try{
 client=await new MCPClient(binary,[],environment).initialize({name:'codex-mcp-client',version:'0.166.0'});
 zen=new ZenFixture(client,{kind:'zen',allowSystemAccess:true});await zen.start(origin+'/bootstrap');
 browse=new BrowseFixture({clientInfo:{name:'codex-mcp-client',version:'0.166.0'}});await browse.start(origin+'/bootstrap');
 const catalogs={zen:(await client.request('tools/list')).tools,browse:(await browse.client.request('tools/list')).tools};
 if(!catalogs.browse.some(t=>t.name==='tabs'))throw Error('The account tab workflow requires browse tab controls');
 const files=['account-agent.mjs','account-fixture.mjs','policy-audit.mjs','mcp-client.mjs','zen-fixture.mjs','browse-fixture.mjs','browse-extension.mjs','host-session.mjs','host-mcp-proxy.mjs','codex-host.mjs'];
 const directory=dirname(fileURLToPath(import.meta.url)),sources=Object.fromEntries(await Promise.all(files.map(async n=>[n,hash(await readFile(join(directory,n)))])));
 await mkdir(join(root,'harness'));for(const name of files)await copyFile(join(directory,name),join(root,'harness',name));await writeFile(join(root,'harness-sha256.json'),JSON.stringify(sources,null,2)+'\n');
 metadata={started_at:new Date().toISOString(),source_revision:(await exec('git',['rev-parse','HEAD'])).stdout.trim(),source_worktree_dirty:Boolean((await exec('git',['status','--porcelain','--','eval/agent-comparison'])).stdout.trim()),codex_version:(await exec('codex',['--version'])).stdout.trim(),model_request:model,served_model_echo_available:false,runtime_version:(await exec(binary,['--version'])).stdout.trim(),runtime_sha256:hash(await readFile(binary)),zen_version:zen.capabilities.browserVersion,browse_binary_sha256:hash(await readFile(browse.binaryPath)),browse_cli:(await exec(browse.binary,['--version'])).stdout.trim(),browse_extension_version:JSON.parse(await readFile(join(process.env.BROWSE_EXTENSION_PATH,'manifest.json'),'utf8')).version,chromium_version:browse.browser.browser().version(),initialization_instructions_forwarded:true,native_initialization:{zen:client.initialization,browse:browse.client.initialization},catalogs,harness_sha256:sources,zen_input:'synthetic-dom',zen_permissions:'all optional permissions pregranted in owned fixture; Full browser control enabled during preparation',profile_isolation:'fresh cases with scoped HttpOnly cookies; shared owned browser profiles across serial trials'};
 await save();
 runs:for(let round=0;round<repetitions;round++)for(let index=0;index<selected.length;index++)for(const engine of (round+index)%2?['browse','zen']:['zen','browse']){
  if(rows.reduce((s,r)=>s+(r.usage?.input_tokens||0)+(r.usage?.output_tokens||0),0)>=4000000)throw Error('Account reported-token guard reached');
  const task=selected[index],caseRow=fixture.createCase(task.id,engine,round),prepStart=performance.now(),prefix=await prepare(engine,caseRow),preparationMs=performance.now()-prepStart;
  const session=await new HostSession(engine==='zen'?client:browse.client,catalogs[engine],{maxCalls:35,preserveInitialization:true}).start(join(state,'host.sock'));
  const backend=engine==='zen'?'Use compact Callisto with op/args. Full browser control is enabled in this owned fixture. browser tabs_list/tab_select manage the task tabs. Input is synthetic DOM; do not change input mode.':`Use the existing browse tab ${browse.tab}; tabs/execute can inspect the receipt popup and return to that portal tab.`;
  const prompt='Complete this task in the signed-in local test account using ONLY browser MCP tools. The account is already signed in. Inspect the page, act, and verify. Do not use HTTP clients, fetch, network replay, API endpoints, local files, shell, other agents or non-browser tools. Stay inside '+prefix+'. Do not change input mode, permissions or runtime settings. Do not repeat uncertain writes: inspect first. End with JSON {"answer":"concise result"}. Maximum 35 browser MCP calls. '+backend+'\nTask: '+task.instruction;
  const started=performance.now();let host;try{host=await runCodexHost({cwd,socket:session.path,schema,model,effort,prompt,timeout:180000});}finally{await session.close();}
  const verificationStart=performance.now();let receiptTabOpen=false;
  if(task.id==='receipt-tabs')receiptTabOpen=engine==='zen'?(await zen.call('callisto_browser',{action:'tabs_list'})).tabs.some(t=>t.url===prefix+'receipt'):browse.browser.pages().some(p=>p.url()===prefix+'receipt');
  const assessment=evaluateAccount(caseRow,{receiptTabOpen}),violations=policyViolations(session.events);let answer=null;try{answer=JSON.parse(host.final);}catch{}
  const forbiddenHost=host.events.filter(e=>e.type==='item.completed'&&['command_execution','web_search','file_change'].includes(e.item?.type));
  const infrastructure=host.code!==0&&!host.timed_out||!host.usage;
  const success=!infrastructure&&!host.timed_out&&assessment.passed&&violations.length===0&&forbiddenHost.length===0&&typeof answer?.answer==='string'&&answer.answer.length>0&&session.events.length>0;
  const row={sequence:++sequence,engine,task:task.id,round,success:infrastructure?null:success,outcome:infrastructure?'infrastructure_error':host.timed_out?'timeout':success?'passed':'agent_failure',answer,actual_host_client_info:session.hostInfo,preparation_ms:preparationMs,host_elapsed_ms:host.elapsed_ms,verification_ms:performance.now()-verificationStart,task_elapsed_ms:performance.now()-started,usage:host.usage,tool_calls:session.events.length,tool_failures:session.events.filter(e=>e.failed).length,response_bytes:session.events.reduce((s,e)=>s+e.response_bytes,0),evaluation:assessment,policy_violations:violations,forbidden_host_calls:forbiddenHost.length,timed_out:host.timed_out,cost_usd:null,trace_file:`${engine}-${task.id}-${round}.json`};
  await writeFile(join(root,row.trace_file),JSON.stringify({...row,prompt,host,tools:session.events},null,2)+'\n');rows.push(row);await save();console.log(JSON.stringify({progress:rows.length,total:selected.length*repetitions*2,engine,task:task.id,round,outcome:row.outcome,seconds:row.task_elapsed_ms/1000,calls:row.tool_calls,writes:assessment.write_count}));
  if(infrastructure){process.exitCode=2;break runs;}
 }
}catch(error){await writeFile(join(root,'run-error.json'),JSON.stringify({message:error.message,stack:error.stack},null,2));process.exitCode=1;}
finally{if(metadata)await save();await browse?.close();await zen?.close();await client?.close();await exec(binary,['--stop-relay'],{env:environment}).catch(()=>{});await rm(state,{recursive:true,force:true});fixture.server.closeAllConnections();await new Promise(r=>fixture.server.close(r));}
