// Real agents on public sites: no prewritten selectors or tool-action recipes.
import {MCPClient} from './mcp-client.mjs';
import {ZenFixture,until,value} from './zen-fixture.mjs';
import {BrowseFixture} from './browse-fixture.mjs';
import {HostSession} from './host-session.mjs';
import {runCodexHost} from './codex-host.mjs';
import {runOpenCodeHost,prepareOpenCodeHome,runOpenCodePreflight,closeOpenCodeHome,OPENCODE_MODEL,OPENCODE_VARIANT} from './opencode-host.mjs';
import {tasks,applyOracles,evaluate} from './real-world-tasks.mjs';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),root=resolve(process.env.BENCH_OUTPUT_DIR||'eval/reports/real-world-2026-11-16');
const hostName=process.env.BENCH_HOST||'codex';
const hostInterface=process.env.BENCH_HOST_INTERFACE||'controlled';
if(!['controlled','default'].includes(hostInterface))throw Error('BENCH_HOST_INTERFACE must be controlled or default');
if(!['codex','opencode'].includes(hostName))throw Error('BENCH_HOST must be codex or opencode');
const repetitions=Number(process.env.BENCH_REPETITIONS||2),model=hostName==='opencode'?OPENCODE_MODEL:(process.env.BENCH_HOST_MODEL||'gpt-6.1-sol'),effort=hostName==='opencode'?OPENCODE_VARIANT:(process.env.BENCH_HOST_EFFORT||'high');
const toolProfile=process.env.BENCH_ZEN_TOOL_PROFILE||(hostName==='opencode'?'compact':'full');
if(!['compact','full'].includes(toolProfile))throw Error('BENCH_ZEN_TOOL_PROFILE must be compact or full');
if(hostName==='opencode'&&toolProfile!=='compact')throw Error('The OpenCode adapter currently supports the compact Callisto catalog only');
const engines=(process.env.BENCH_ENGINES||'zen,browse').split(',');
if(!engines.length||new Set(engines).size!==engines.length||engines.some(e=>!['zen','browse'].includes(e)))throw Error('BENCH_ENGINES must select zen and/or browse');
if(!Number.isInteger(repetitions)||repetitions<1||repetitions>3)throw Error('Repetitions must be 1–3');
const requestedTasks=process.env.BENCH_TASKS?.split(',');
const unknownTasks=requestedTasks?.filter(id=>!tasks.some(task=>task.id===id))||[];
if(unknownTasks.length)throw Error(`Unknown task IDs: ${unknownTasks.join(', ')}. Available: ${tasks.map(t=>t.id).join(', ')}`);
const selected=tasks.filter(t=>!requestedTasks||requestedTasks.includes(t.id));
if(!selected.length)throw Error('No selected tasks');
const inputMode=process.env.BENCH_INPUT_MODE||'synthetic-dom';
if(!['synthetic-dom','trusted-bidi'].includes(inputMode))throw Error('Unknown input mode');
const resuming=process.env.BENCH_RESUME==='1';
const previous=resuming?JSON.parse(await readFile(join(root,'results.json'),'utf8')):null;
const maxTokens=Number(process.env.BENCH_MAX_REPORTED_TOKENS||3000000);
if(!Number.isFinite(maxTokens)||maxTokens<1)throw Error('Invalid reported-token guard');
if(previous&&(previous.metadata.host_interface||'controlled')!==hostInterface)throw Error('Resume host interface must match the original run');
if(previous&&((previous.host||'codex')!==hostName||previous.model!==model||previous.reasoning_effort!==effort||previous.input_mode!==inputMode||previous.repetitions!==repetitions||JSON.stringify(previous.tasks.map(t=>t.id))!==JSON.stringify(selected.map(t=>t.id))))throw Error('Resume settings must match the original task set, repetitions, host, model and input mode');
if(previous&&(JSON.stringify(previous.engines||['zen','browse'])!==JSON.stringify(engines)||(previous.metadata?.tool_profile||'full')!==toolProfile))throw Error('Resume engines and tool profile must match the original run');
if(!resuming)await mkdir(root,{recursive:false,mode:0o700});
const phases=previous?.phases||(previous?.metadata?[{id:0,metadata:previous.metadata}]:[]);
const phaseId=phases.length;
if(previous){
 await writeFile(join(root,`results-before-phase-${phaseId}.json`),JSON.stringify(previous,null,2)+'\n',{mode:0o600});
 await rename(join(root,'run-error.json'),join(root,`run-error-phase-${phaseId-1}.json`)).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
const state=await mkdtemp(join(tmpdir(),'callisto-real-world-'));const cwd=join(state,'workspace');await mkdir(cwd);
const runtime=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
const environment={...process.env,CALLISTO_TOOL_PROFILE:toolProfile,CALLISTO_FIREFOX_STATE_DIR:join(state,'relay')};
const schema=join(state,'answer-schema.json');
await writeFile(schema,JSON.stringify({type:'object',properties:{answer:{type:'string'},evidence:{type:'array',items:{type:'object',properties:{url:{type:'string'},quote:{type:'string'}},required:['url','quote'],additionalProperties:false}}},required:['answer','evidence'],additionalProperties:false}));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Browser benchmark start</title><h1>Ready for a public-site task</h1>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const allowedOrigins=[origin,...new Set(tasks.flatMap(t=>t.origins))];
let client,zen,browse,opencodeHome,catalogs=previous?.catalogs,metadata=previous?.metadata,oracles=previous?.oracles;const rows=previous?.results||[];
const doneKeys=new Set(rows.map(r=>`${r.engine}:${r.task}:${r.round}`));const setupStarted=performance.now();
const digest=data=>createHash('sha256').update(data).digest('hex');
async function oracle(url){const response=await fetch(url,{headers:{'User-Agent':'Callisto-public-benchmark/0.1'},signal:AbortSignal.timeout(25000)});if(!response.ok)throw Error(`Oracle HTTP ${response.status}: ${url}`);return response.json();}
async function save(){await writeFile(join(root,'results.json'),JSON.stringify({schema:'callisto.real-world-agent.v1',updated_at:new Date().toISOString(),host:hostName,model,reasoning_effort:effort,model_variant:hostName==='opencode'?effort:null,input_mode:inputMode,repetitions,engines,planned_runs:selected.length*repetitions*engines.length,completed_runs:rows.length,metadata,phases,continuation_note:previous?'An internal reported-token guard stopped the earlier process. Only missing trial IDs are resumed in fresh owned profiles; previous trials and usage are retained. Phase metadata records profile resets.':null,oracles,tasks:selected.map(({checks,source,...t})=>({...t,answer_patterns:checks.map(c=>c.source),source_pattern:source.source})),catalogs,cost_usd:null,cost_note:hostName==='opencode'?'Host-reported step costs are retained when supplied. They may use catalog pricing; invoice amounts are unavailable and missing costs remain null.':'Actual CLI usage is retained. Signed-in subscription does not provide per-trial dollar charges.',measurement:'Fresh host conversation per run. Host elapsed includes startup, model turns, navigation, waits, failures and retries. Task elapsed additionally includes independent answer/evidence validation. Profile setup and neutral-tab reacquisition are separate. Verification is not cut off the timer. Browser output UTF-8 bytes and characters are separate from model input/output/cached tokens.',scope:`${selected.length} public informational workflows, ${repetitions} repetition(s), engines ${engines.join(',')}. Anonymous owned browser profiles; initially the first round is cold per site and the second is warm. A resumed phase resets profiles and is explicitly identified in phase metadata. Fixed gold facts for stable pages; time-stamped official JSON/API oracles for mutable metadata. Native task-tool catalogs differ and are saved. Not a store-install, authenticated-account or production reliability test.`,budget:{max_browser_calls:35,host_timeout_ms:180000,stop_before_next_session_at_reported_tokens:maxTokens},results:rows},null,2)+'\n',{mode:0o600});}
async function reset(engine){
 if(engine==='zen'){await zen.navigate(origin);if(inputMode==='synthetic-dom')await zen.call('callisto_input',{action:'disable'});}
 else{const result=await browse.execute(`await page.goto(${JSON.stringify(origin)},{waitUntil:'domcontentloaded'});return {url:page.url()}`);if(result.isError)throw Error('Browse neutral-tab reset failed');}
}
async function run(engine,task,round){
 const preparationStart=performance.now();await reset(engine);const preparationMs=performance.now()-preparationStart;
 const session=await new HostSession(engine==='zen'?client:browse.client,catalogs[engine],{maxCalls:35,preserveInitialization:hostInterface==='default'}).start(join(state,'host.sock'));
 const policy='Complete this read-only public website task using ONLY the browser MCP tools. You must inspect the live page; do not answer from memory. You choose your own observations, selectors and actions. Do not use HTTP/API clients, fetch, network replay, files, shell, other agents, or non-browser tools. Browser DOM evaluation is allowed for text extraction, but must not make network requests. Do not visit API endpoints. Do not sign in, create accounts, post messages, buy, or change account settings. Do not solve CAPTCHAs or bypass access challenges; report them. You may follow links, use site search and recover from errors. Stay on the task site. Maximum 30 browser calls. Verify all requested facts and finish with JSON {"answer":"concise answer covering every requested fact","evidence":[{"url":"source page URL","quote":"a short exact supporting quote you observed in browser output"}]}. Evidence quotes must be copied exactly from an observation. Do not claim success when blocked.';
 const serverName=engine==='zen'?'zen':'browser',nativeTool=toolProfile==='compact'||engine==='browse'?(engine==='zen'?'callisto':'execute'):null;
 const exposedTool=hostName==='opencode'?`${serverName}_${nativeTool}`:nativeTool;
 const backend=engine==='zen'?`You control the owned Zen tab using Callisto in ${inputMode} input mode. Navigation starts loading; read a fresh snapshot before using refs. You may use run, batches, targeted observations, extraction and supported explicit waits. Do not enable or change input mode. ${toolProfile==='compact'?`Use the ${exposedTool} tool with op and args. op=help returns one operation contract on demand.`:''}`:`Use browse ${browse.apiMode==='tab'?`tab ${browse.tab}; pass tab: ${browse.tab} to continue in the owned starting tab`:`session ${browse.session}`}. Its execute tool provides a Playwright-style page interface. Choose what text to return to yourself, and verify it.${hostName==='opencode'?` The tool is named ${exposedTool} in this host.`:''}`;
 const prompt=policy+'\n'+backend+'\nStart URL: '+task.start+'\nTask: '+task.instruction;
 let host;const started=performance.now();
 try{if(hostName==='opencode')host=await runOpenCodeHost({cwd,socket:session.path,schema,model,variant:effort,serverName,toolName:nativeTool,prompt,timeout:180000,home:opencodeHome});else host=await runCodexHost({cwd,socket:session.path,schema,model,effort,prompt,timeout:180000});}finally{await session.close();}
 const verificationStart=performance.now();let final=null;try{final=JSON.parse(host.final);}catch{}
 const evaluation=evaluate(task,final,session.events);
 const forbiddenHost=hostName==='opencode'?(host.forbidden_tool_calls||[]).map(name=>({name})):host.events.filter(e=>e.type==='item.completed'&&['command_execution','web_search','file_change'].includes(e.item?.type));
 const approvalBlocked=host.events.some(e=>e.item?.type==='mcp_tool_call'&&/requires approval/.test(e.item.error?.message||''));
 const configError=host.events.some(e=>e.item?.type==='error'&&/unrecognized configuration|unknown model|not supported|authentication|quota|usage limit/i.test(e.item.message||''));
 const infrastructure=Boolean(host.infrastructure)||approvalBlocked||configError||!host.usage&&!host.timed_out;
 const observations=JSON.stringify(session.events.map(e=>e.result));
 const siteBlocked=/verify (?:that )?you are human|checking your browser|just a moment|access denied|client challenge|enable javascript and cookies to continue/i.test(observations);
 const success=evaluation.passed&&session.events.length>0&&!forbiddenHost.length&&!host.timed_out&&!infrastructure;
 const outcome=infrastructure?'infrastructure_error':success?'passed':siteBlocked?'site_blocked':host.timed_out?'timeout':'agent_failure';
 const row={host:hostName,actual_host_client_info:session.hostInfo??null,engine,task:task.id,round,phase:phaseId,success:infrastructure?null:success,outcome,answer:final,expected:task.expected,evaluation,preparation_ms:preparationMs,host_elapsed_ms:host.elapsed_ms,verification_ms:performance.now()-verificationStart,task_elapsed_ms:performance.now()-started,usage:host.usage,model_verified:host.model_verified??null,host_error:host.infrastructure_reason??null,exposed_tools:hostName==='opencode'?[exposedTool]:undefined,tool_calls:session.events.length,tool_failures:session.events.filter(e=>e.failed).length,tool_elapsed_ms:session.events.reduce((n,e)=>n+e.elapsed_ms,0),response_bytes:session.events.reduce((n,e)=>n+e.response_bytes,0),response_characters:session.events.reduce((n,e)=>n+JSON.stringify(e.result).length,0),forbidden_host_calls:forbiddenHost.length,reported_cost_usd:host.usage?.cost_usd??null,cost_usd:null,timed_out:host.timed_out,trace_file:`${engine}-${task.id}-${round}.json`};
 await writeFile(join(root,row.trace_file),JSON.stringify({schema:'callisto.real-world-trace.v1',...row,prompt,host,tools:session.events},null,2)+'\n',{mode:0o600});
 rows.push(row);doneKeys.add(`${engine}:${task.id}:${round}`);await save();console.error(JSON.stringify({progress:rows.length,total:selected.length*repetitions*engines.length,engine,task:task.id,round,outcome,seconds:Math.round(row.task_elapsed_ms/100)/10,calls:row.tool_calls,usage:row.usage}));
 return row;
}
try{
 let opencodePreflight=null;
 if(hostName==='codex'){const login=await exec('codex',['login','status']);if(!(login.stdout+login.stderr).includes('Logged in'))throw Error('Codex host is not signed in');}
 else{
  opencodePreflight=await runOpenCodePreflight({root,model,variant:effort});
  opencodeHome=opencodePreflight.home;
  await writeFile(join(root,'preflight-opencode.json'),JSON.stringify({...opencodePreflight,home:opencodeHome.home},null,2)+'\n',{mode:0o600});
  if(opencodePreflight.status!=='passed')throw Error('OpenCode model preflight blocked: '+(opencodePreflight.provider_error?opencodePreflight.provider_error.type+': '+opencodePreflight.provider_error.message:`exit ${opencodePreflight.code}`));
 }
 const [pypi,github,holidays]=await Promise.all([oracle('https://pypi.org/pypi/httpx/json'),oracle('https://api.github.com/repos/microsoft/TypeScript/issues/1'),oracle('https://www.gov.uk/bank-holidays.json')]);
 oracles={captured_at:new Date().toISOString(),pypi:{version:pypi.info.version,requires_python:pypi.info.requires_python},github:{title:github.title,state:github.state,author:github.user.login,url:github.html_url},holidays:holidays.scotland.events.filter(e=>e.date.startsWith('2027')&&/summer|andrew/i.test(e.title)),sources:['https://pypi.org/pypi/httpx/json','https://api.github.com/repos/microsoft/TypeScript/issues/1','https://www.gov.uk/bank-holidays.json']};
 if(previous){
  for(const key of ['pypi','github','holidays'])if(JSON.stringify(oracles[key])!==JSON.stringify(previous.oracles[key]))throw Error('Official oracle facts changed; refusing to resume across different answers');
  oracles=previous.oracles;
 }
 applyOracles(oracles);
 console.error('Starting isolated profiles for '+engines.join(', ')+'…');
 if(engines.includes('zen')){
  client=await new MCPClient(runtime,[],environment).initialize({name:hostName==='opencode'?'opencode':'codex-mcp-client',version:'benchmark'});zen=new ZenFixture(client);await zen.start(origin+'/');if(inputMode==='synthetic-dom')await zen.call('callisto_input',{action:'disable'});
 }
 if(engines.includes('browse')){
  browse=new BrowseFixture({clientInfo:{name:hostName==='opencode'?'opencode':'codex-mcp-client',version:'benchmark'}});await browse.start(origin);
  await browse.configureOrigins(allowedOrigins);
 }
 const zenCatalog=client?(await client.request('tools/list')).tools:[],browseCatalog=browse?(await browse.client.request('tools/list')).tools:[];
 const names=['callisto_navigate','callisto_snapshot','callisto_run','callisto_batch','callisto_extract','callisto_find','callisto_click','callisto_fill','callisto_press','callisto_submit','callisto_frames','callisto_frame','callisto_page','callisto_browser'];
 catalogs={zen:zenCatalog.filter(t=>toolProfile==='compact'?t.name==='callisto':names.includes(t.name)),browse:browseCatalog.filter(t=>t.name==='execute')};
 const extensionPath=resolve(process.env.BROWSE_EXTENSION_PATH||'vendor/browse/dist');
 const manifest=JSON.parse(await readFile('packages/firefox-rs/extension/manifest.json','utf8')),browseManifest=browse?JSON.parse(await readFile(join(extensionPath,'manifest.json'),'utf8')):null;
 const {stdout:revision}=await exec('git',['rev-parse','HEAD']);
 const {stdout:worktree}=await exec('git',['status','--porcelain']);
 const hostVersion=hostName==='opencode'?(await exec('opencode',['--version'])).stdout.trim():(await exec('codex',['--version'])).stdout.trim();
 const harnessFiles=['real-world-agent.mjs','real-world-tasks.mjs','observation-text.mjs','policy-audit.mjs','codex-host.mjs','opencode-host.mjs','host-session.mjs','host-mcp-proxy.mjs','zen-fixture.mjs','browse-fixture.mjs','browse-extension.mjs','mcp-client.mjs'];
 const harnessDirectory=dirname(fileURLToPath(import.meta.url));
 const harnessFileHashes=Object.fromEntries(await Promise.all(harnessFiles.map(async name=>[name,digest(await readFile(join(harnessDirectory,name)))])));
 metadata={started_at:new Date().toISOString(),source_revision:revision.trim(),source_worktree_dirty:Boolean(worktree.trim()),host:hostName,host_version:hostVersion,model,model_variant:hostName==='opencode'?effort:null,tool_profile:toolProfile,runtime_version:(await exec(runtime,['--version'])).stdout.trim(),runtime_sha256:digest(await readFile(runtime)),extension_source_version:manifest.version,fixture_extension_version:'0.2.1',fixture_note:'Owned test extension uses pregranted optional permissions, automatic private pairing and test diagnostics. No task content or answers are injected.',extension_sources_sha256:Object.fromEntries(await Promise.all(['manifest.json','background.js','content.js','browser-control.js','operations.json','connection-ui.js'].map(async n=>[n,digest(await readFile('packages/firefox-rs/extension/'+n))]))),zen_version:zen?.capabilities.browserVersion??null,zen_profile:'owned temporary persistent profile on Xvfb',zen_input:zen?await zen.call('callisto_input',{action:'status'}):null,codex_version:hostName==='codex'?hostVersion:null,opencode_version:hostName==='opencode'?hostVersion:null,opencode_model:hostName==='opencode'?OPENCODE_MODEL:null,opencode_variant:hostName==='opencode'?OPENCODE_VARIANT:null,opencode_preflight:opencodePreflight?{status:opencodePreflight.status,usage:opencodePreflight.usage,model:opencodePreflight.model,variant:opencodePreflight.variant,session:opencodePreflight.session}:null,host_exposed_tools:hostName==='opencode'?{zen:engines.includes('zen')?{native:'callisto',exposed:'zen_callisto'}:null,browse:engines.includes('browse')?{native:'execute',exposed:'browser_execute'}:null}:null,browser_client_identity:{zen:client?.clientInfo??null,browse:browse?.client.clientInfo??null},host_interface:hostInterface,initialization_instructions_forwarded:hostInterface==='default',native_initialization:{zen:client?{serverInfo:client.initialization.serverInfo,instructions:client.initialization.instructions??null}:null,browse:browse?{serverInfo:browse.client.initialization.serverInfo,instructions:browse.client.initialization.instructions??null}:null},browse_binary_sha256:browse?digest(await readFile(browse.binaryPath)):null,browse_cli:browse?(await exec(process.env.BROWSE_BINARY||'browse',['--version'])).stdout.trim():null,browse_extension_version:browseManifest?.version??null,browse_extension_fixture:browse?.extensionMetadata??null,browse_api_mode:browse?.apiMode??null,browse_origin_allowlist:browse?.apiMode==='session'?allowedOrigins:null,browse_extension_manifest_sha256:browse?digest(await readFile(join(extensionPath,'manifest.json'))):null,chromium_version:browse?.browser.browser().version()??null,browse_profile:browse?'owned anonymous profile on Xvfb':null,setup_elapsed_ms:performance.now()-setupStarted,catalogs:{zen:{native_count:zenCatalog.length,exposed_count:catalogs.zen.length,exposed_bytes:Buffer.byteLength(JSON.stringify(catalogs.zen))},browse:{native_count:browseCatalog.length,exposed_count:catalogs.browse.length,exposed_bytes:Buffer.byteLength(JSON.stringify(catalogs.browse))}}};
 metadata.harness_sha256=digest(await readFile(new URL(import.meta.url)));
 metadata.harness_files_sha256=harnessFileHashes;
 if(previous){
  for(const key of ['runtime_sha256','extension_source_version','browse_extension_manifest_sha256','zen_version','chromium_version',...(hostName==='opencode'?['opencode_version','opencode_model','opencode_variant']:[])])if(metadata[key]!==previous.metadata[key])throw Error('Resume runtime changed: '+key);
  if(JSON.stringify(catalogs)!==JSON.stringify(previous.catalogs))throw Error('Resume exposed catalogs changed');
 }
 const savedHarness=join(root,phaseId?'harness-phase'+phaseId:'harness');await mkdir(savedHarness,{recursive:false});
 for(const name of harnessFiles){const source=join(harnessDirectory,name);const data=await readFile(source);if(digest(data)!==harnessFileHashes[name])throw Error('Harness changed while capturing source: '+name);await copyFile(source,join(savedHarness,name));}
 await writeFile(join(root,phaseId?'harness-phase'+phaseId+'-sha256.json':'harness-sha256.json'),JSON.stringify(harnessFileHashes,null,2)+'\n');
 phases.push({id:phaseId,metadata});
 await save();
 console.error('Preflight passed. Starting measured real-site agent trials.');
 runs:for(let round=0;round<repetitions;round++)for(let index=0;index<selected.length;index++)for(const engine of engines.length===1?engines:(round+index)%2?['browse','zen']:['zen','browse']){
  if(doneKeys.has(`${engine}:${selected[index].id}:${round}`))continue;
  if(rows.reduce((n,r)=>n+(r.usage?.input_tokens||0)+(r.usage?.output_tokens||0),0)>=maxTokens)throw Error('Reported token session-boundary guard reached');
  const row=await run(engine,selected[index],round);if(row.outcome==='infrastructure_error'){process.exitCode=2;break runs;}
 }
}catch(error){await writeFile(join(root,'run-error.json'),JSON.stringify({at:new Date().toISOString(),message:error.message,stack:error.stack},null,2)+'\n');process.exitCode=1;console.error(error.stack);}
finally{
 if(metadata||rows.length)await save().catch(()=>{});await browse?.close();await zen?.close();await client?.close();await closeOpenCodeHome(opencodeHome).catch(()=>{});await exec(runtime,['--stop-relay'],{env:environment}).catch(()=>{});await rm(state,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));
}
