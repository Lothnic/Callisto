// Real agents on public sites: no prewritten selectors or tool-action recipes.
import {MCPClient} from './mcp-client.mjs';
import {ZenFixture,until,value} from './zen-fixture.mjs';
import {BrowseFixture} from './browse-fixture.mjs';
import {HostSession} from './host-session.mjs';
import {runCodexHost} from './codex-host.mjs';
import {tasks,applyOracles,evaluate} from './real-world-tasks.mjs';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),root=resolve(process.env.BENCH_OUTPUT_DIR||'eval/reports/real-world-2026-11-16');
const repetitions=Number(process.env.BENCH_REPETITIONS||2),model='gpt-6.1-sol',effort='high';
if(!Number.isInteger(repetitions)||repetitions<1||repetitions>3)throw Error('Repetitions must be 1–3');
const selected=tasks.filter(t=>!process.env.BENCH_TASKS||process.env.BENCH_TASKS.split(',').includes(t.id));
if(!selected.length)throw Error('No selected tasks');
const inputMode=process.env.BENCH_INPUT_MODE||'synthetic-dom';
if(!['synthetic-dom','trusted-bidi'].includes(inputMode))throw Error('Unknown input mode');
await mkdir(root,{recursive:false,mode:0o700});
const state=await mkdtemp(join(tmpdir(),'callisto-real-world-'));const cwd=join(state,'workspace');await mkdir(cwd);
const runtime=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
const environment={...process.env,CALLISTO_FIREFOX_STATE_DIR:join(state,'relay')};
const schema=join(state,'answer-schema.json');
await writeFile(schema,JSON.stringify({type:'object',properties:{answer:{type:'string'},evidence:{type:'array',items:{type:'object',properties:{url:{type:'string'},quote:{type:'string'}},required:['url','quote'],additionalProperties:false}}},required:['answer','evidence'],additionalProperties:false}));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Browser benchmark start</title><h1>Ready for a public-site task</h1>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const allowedOrigins=[origin,...new Set(tasks.flatMap(t=>t.origins))];
let client,zen,browse,catalogs,metadata,oracles;const rows=[];const setupStarted=performance.now();
const digest=data=>createHash('sha256').update(data).digest('hex');
async function oracle(url){const response=await fetch(url,{headers:{'User-Agent':'Callisto-public-benchmark/0.1'},signal:AbortSignal.timeout(25000)});if(!response.ok)throw Error(`Oracle HTTP ${response.status}: ${url}`);return response.json();}
async function save(){await writeFile(join(root,'results.json'),JSON.stringify({schema:'callisto.real-world-agent.v1',updated_at:new Date().toISOString(),model,reasoning_effort:effort,input_mode:inputMode,repetitions,planned_runs:selected.length*repetitions*2,completed_runs:rows.length,metadata,oracles,tasks:selected.map(({checks,source,...t})=>({...t,answer_patterns:checks.map(c=>c.source),source_pattern:source.source})),catalogs,cost_usd:null,cost_note:'Actual CLI usage is retained. Signed-in subscription does not provide per-trial dollar charges.',measurement:'Fresh host conversation per run. Host elapsed includes startup, model turns, navigation, waits, failures and retries. Task elapsed additionally includes independent answer/evidence validation. Profile setup and neutral-tab reacquisition are separate. Verification is not cut off the timer. Browser output UTF-8 bytes and characters are separate from model input/output/cached tokens.',scope:'Six public informational workflows, two repetitions. Anonymous owned browser profiles, first round cold per site and second round warm. Fixed gold facts for stable pages; time-stamped official JSON/API oracles for mutable metadata. Native task-tool catalogs differ and are saved. Not a store-install, authenticated-account or production reliability test.',budget:{max_browser_calls:35,host_timeout_ms:180000,stop_before_next_session_at_reported_tokens:3000000},results:rows},null,2)+'\n',{mode:0o600});}
async function reset(engine){
 if(engine==='zen'){await zen.navigate(origin);if(inputMode==='synthetic-dom')await zen.call('callisto_input',{action:'disable'});}
 else{const result=await browse.execute(`await page.goto(${JSON.stringify(origin)},{waitUntil:'domcontentloaded'});return {url:page.url()}`);if(result.isError)throw Error('Browse neutral-tab reset failed');}
}
async function run(engine,task,round){
 const preparationStart=performance.now();await reset(engine);const preparationMs=performance.now()-preparationStart;
 const session=await new HostSession(engine==='zen'?client:browse.client,catalogs[engine],{maxCalls:35}).start(join(state,'host.sock'));
 const policy='Complete this read-only public website task using ONLY the browser MCP tools. You must inspect the live page; do not answer from memory. You choose your own observations, selectors and actions. Do not use HTTP/API clients, fetch, network replay, files, shell, other agents, or non-browser tools. Browser DOM evaluation is allowed for text extraction, but must not make network requests. Do not visit API endpoints. Do not sign in, create accounts, post messages, buy, or change account settings. Do not solve CAPTCHAs or bypass access challenges; report them. You may follow links, use site search and recover from errors. Stay on the task site. Maximum 30 browser calls. Verify all requested facts and finish with JSON {"answer":"concise answer covering every requested fact","evidence":[{"url":"source page URL","quote":"a short exact supporting quote you observed in browser output"}]}. Evidence quotes must be copied exactly from an observation. Do not claim success when blocked.';
 const backend=engine==='zen'?`You control the owned Zen tab using Callisto in ${inputMode} input mode. Navigation starts loading; read a fresh snapshot before using refs. You may use run, batches, targeted observations, extraction and supported explicit waits. Do not enable or change input mode.`:`Use browse session ${browse.session}. Its execute tool runs Playwright with page. Choose what text to return to yourself, and verify it.`;
 const prompt=policy+'\n'+backend+'\nStart URL: '+task.start+'\nTask: '+task.instruction;
 let host;const started=performance.now();
 try{host=await runCodexHost({cwd,socket:session.path,schema,model,effort,prompt,timeout:180000});}finally{await session.close();}
 const verificationStart=performance.now();let final=null;try{final=JSON.parse(host.final);}catch{}
 const evaluation=evaluate(task,final,session.events);
 const forbiddenHost=host.events.filter(e=>e.type==='item.completed'&&['command_execution','web_search','file_change'].includes(e.item?.type));
 const approvalBlocked=host.events.some(e=>e.item?.type==='mcp_tool_call'&&/requires approval/.test(e.item.error?.message||''));
 const configError=host.events.some(e=>e.item?.type==='error'&&/unrecognized configuration|unknown model|not supported|authentication|quota|usage limit/i.test(e.item.message||''));
 const infrastructure=approvalBlocked||configError||!host.usage&&!host.timed_out;
 const observations=JSON.stringify(session.events.map(e=>e.result));
 const siteBlocked=/verify (?:that )?you are human|checking your browser|just a moment|access denied|client challenge|enable javascript and cookies to continue/i.test(observations);
 const success=evaluation.passed&&session.events.length>0&&!forbiddenHost.length&&!host.timed_out&&!infrastructure;
 const outcome=infrastructure?'infrastructure_error':success?'passed':siteBlocked?'site_blocked':host.timed_out?'timeout':'agent_failure';
 const row={engine,task:task.id,round,success:infrastructure?null:success,outcome,answer:final,expected:task.expected,evaluation,preparation_ms:preparationMs,host_elapsed_ms:host.elapsed_ms,verification_ms:performance.now()-verificationStart,task_elapsed_ms:performance.now()-started,usage:host.usage,tool_calls:session.events.length,tool_failures:session.events.filter(e=>e.failed).length,tool_elapsed_ms:session.events.reduce((n,e)=>n+e.elapsed_ms,0),response_bytes:session.events.reduce((n,e)=>n+e.response_bytes,0),response_characters:session.events.reduce((n,e)=>n+JSON.stringify(e.result).length,0),forbidden_host_calls:forbiddenHost.length,cost_usd:null,timed_out:host.timed_out,trace_file:`${engine}-${task.id}-${round}.json`};
 await writeFile(join(root,row.trace_file),JSON.stringify({schema:'callisto.real-world-trace.v1',...row,prompt,host,tools:session.events},null,2)+'\n',{mode:0o600});
 rows.push(row);await save();console.error(JSON.stringify({progress:rows.length,total:selected.length*repetitions*2,engine,task:task.id,round,outcome,seconds:Math.round(row.task_elapsed_ms/100)/10,calls:row.tool_calls,usage:row.usage}));
 return row;
}
try{
 const login=await exec('codex',['login','status']);if(!(login.stdout+login.stderr).includes('Logged in'))throw Error('Codex host is not signed in');
 const [pypi,github,holidays]=await Promise.all([oracle('https://pypi.org/pypi/httpx/json'),oracle('https://api.github.com/repos/microsoft/TypeScript/issues/1'),oracle('https://www.gov.uk/bank-holidays.json')]);
 oracles={captured_at:new Date().toISOString(),pypi:{version:pypi.info.version,requires_python:pypi.info.requires_python},github:{title:github.title,state:github.state,author:github.user.login,url:github.html_url},holidays:holidays.scotland.events.filter(e=>e.date.startsWith('2027')&&/summer|andrew/i.test(e.title)),sources:['https://pypi.org/pypi/httpx/json','https://api.github.com/repos/microsoft/TypeScript/issues/1','https://www.gov.uk/bank-holidays.json']};
 applyOracles(oracles);
 console.error('Starting isolated Zen and browse profiles…');
 client=await new MCPClient(runtime,[],environment).initialize();zen=new ZenFixture(client);await zen.start(origin+'/');if(inputMode==='synthetic-dom')await zen.call('callisto_input',{action:'disable'});
 browse=new BrowseFixture();await browse.start(origin);
 await browse.client.callTool({name:'session_delete',arguments:{id:browse.session}});
 const created=await browse.client.callTool({name:'session_new',arguments:{id:browse.session,allowedOrigins}});if(created.isError)throw Error('Browse public-site session initialization failed');
 const zenCatalog=(await client.request('tools/list')).tools,browseCatalog=(await browse.client.request('tools/list')).tools;
 const names=['callisto_navigate','callisto_snapshot','callisto_run','callisto_batch','callisto_extract','callisto_find','callisto_click','callisto_fill','callisto_press','callisto_submit','callisto_frames','callisto_frame','callisto_page','callisto_browser'];
 catalogs={zen:zenCatalog.filter(t=>names.includes(t.name)),browse:browseCatalog.filter(t=>t.name==='execute')};
 const extensionPath=resolve(process.env.BROWSE_EXTENSION_PATH||'vendor/browse/dist');
 const manifest=JSON.parse(await readFile('packages/firefox-rs/extension/manifest.json','utf8')),browseManifest=JSON.parse(await readFile(join(extensionPath,'manifest.json'),'utf8'));
 const {stdout:revision}=await exec('git',['rev-parse','HEAD']);
 metadata={started_at:new Date().toISOString(),source_revision:revision.trim(),runtime_version:(await exec(runtime,['--version'])).stdout.trim(),runtime_sha256:digest(await readFile(runtime)),extension_source_version:manifest.version,fixture_extension_version:'0.2.1',fixture_note:'Owned test extension uses pregranted optional permissions, automatic private pairing and test diagnostics. No task content or answers are injected.',extension_sources_sha256:Object.fromEntries(await Promise.all(['manifest.json','background.js','content.js','browser-control.js'].map(async n=>[n,digest(await readFile('packages/firefox-rs/extension/'+n))]))),zen_version:zen.capabilities.browserVersion,zen_profile:'owned temporary persistent profile on Xvfb',zen_input:await zen.call('callisto_input',{action:'status'}),codex_version:(await exec('codex',['--version'])).stdout.trim(),browse_cli:(await exec('browse',['--version'])).stdout.trim(),browse_extension_version:browseManifest.version,browse_extension_manifest_sha256:digest(await readFile(join(extensionPath,'manifest.json'))),chromium_version:browse.browser.browser().version(),browse_profile:'owned anonymous profile on Xvfb',setup_elapsed_ms:performance.now()-setupStarted,catalogs:{zen:{native_count:zenCatalog.length,exposed_count:catalogs.zen.length,exposed_bytes:Buffer.byteLength(JSON.stringify(catalogs.zen))},browse:{native_count:browseCatalog.length,exposed_count:catalogs.browse.length,exposed_bytes:Buffer.byteLength(JSON.stringify(catalogs.browse))}}};
 await save();
 console.error('Preflight passed. Starting measured real-site agent trials.');
 runs:for(let round=0;round<repetitions;round++)for(let index=0;index<selected.length;index++)for(const engine of (round+index)%2?['browse','zen']:['zen','browse']){
  if(rows.reduce((n,r)=>n+(r.usage?.input_tokens||0)+(r.usage?.output_tokens||0),0)>=3000000)throw Error('Reported token session-boundary guard reached');
  const row=await run(engine,selected[index],round);if(row.outcome==='infrastructure_error'){process.exitCode=2;break runs;}
 }
}catch(error){await writeFile(join(root,'run-error.json'),JSON.stringify({at:new Date().toISOString(),message:error.message,stack:error.stack},null,2)+'\n');process.exitCode=1;console.error(error.stack);}
finally{
 await save().catch(()=>{});await browse?.close();await zen?.close();await client?.close();await exec(runtime,['--stop-relay'],{env:environment}).catch(()=>{});await rm(state,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));
}
