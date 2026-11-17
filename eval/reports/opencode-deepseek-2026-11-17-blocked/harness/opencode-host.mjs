// Narrow OpenCode CLI host adapter for matched browser-agent trials.
//
// This module does not make browser decisions and does not rewrite MCP tool
// schemas, arguments or results. It starts one fresh, private OpenCode process
// per trial with a private HOME/XDG directory, an empty workspace, a private
// stdio MCP transport to the owned benchmark session, and permission rules that
// deny every non-browser tool.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

export const OPENCODE_MODEL=process.env.BENCH_OPENCODE_MODEL||'opencode/deepseek-v4.1-flash-free';
export const OPENCODE_VARIANT=process.env.BENCH_OPENCODE_VARIANT||'high';
export const OPENCODE_PROVIDER=OPENCODE_MODEL.split('/')[0];
export const OPENCODE_MODEL_ID=OPENCODE_MODEL.split('/').slice(1).join('/');

const proxy=resolve('eval/agent-comparison/host-mcp-proxy.mjs');
const digest=data=>createHash('sha256').update(data).digest('hex');

export function privateEnvironment(base,home){
 const keep=/^(PATH|USER|LOGNAME|LANG|LC_.*|TZ|DISPLAY|TMPDIR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|XDG_RUNTIME_DIR)$/;
 const environment=Object.fromEntries(Object.entries(base).filter(([key])=>keep.test(key)));
 return {...environment,
  HOME:home,
  XDG_CONFIG_HOME:join(home,'.config'),
  XDG_DATA_HOME:join(home,'.local/share'),
  XDG_CACHE_HOME:join(home,'.cache'),
  XDG_STATE_HOME:join(home,'.local/state'),
  OPENCODE_DISABLE_PROJECT_CONFIG:'1',
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS:'1',
  OPENCODE_DISABLE_AUTOUPDATE:'1',
 };
}

// The OpenCode catalog names an MCP tool `<server>_<tool>`; the transport still
// receives the unchanged native tool name. `codemode:false` keeps the native
// schema on the provider tool list instead of wrapping it in OpenCode's execute
// sandbox.
export function openCodeConfig({model,variant,socket,serverName,toolName}){
 if(!/^[a-z0-9-]+$/.test(serverName))throw Error('OpenCode MCP server name must be a short slug');
 const action=`${serverName}_${toolName}`;
 return {
  $schema:'https://opencode.ai/config.json',
  model:`${model}#${variant}`,
  default_agent:'benchmark',
  update:'disable',
  instructions:[],
  compaction:{auto:false},
  permissions:[
   {action:'*',resource:'*',effect:'deny'},
   {action,resource:'*',effect:'allow'},
  ],
  agents:{
   benchmark:{
    description:'Read-only public-site browser benchmark agent',
    mode:'primary',
    permissions:[
     {action:'*',resource:'*',effect:'deny'},
     {action,resource:'*',effect:'allow'},
    ],
   },
  },
  mcp:{
   timeout:{startup:20000,catalog:20000,execution:60000},
   servers:{
    [serverName]:{
     type:'local',
     command:[process.execPath,proxy,socket],
     codemode:false,
    },
   },
  },
 };
}

export async function prepareOpenCodeHome({root,model=OPENCODE_MODEL,variant=OPENCODE_VARIANT}={}){
 const home=await mkdtemp(join(root||tmpdir(),'callisto-opencode-host-'));
 await chmod(home,0o700);
 for(const directory of ['.config/opencode','.local/share','.cache','.local/state'])await mkdir(join(home,directory),{recursive:true,mode:0o700});
 const configuration={
  model,provider:model.split('/')[0],model_id:model.split('/').slice(1).join('/'),variant,
  home,
  config_path:join(home,'.config/opencode/opencode.json'),
  environment:privateEnvironment(process.env,home),
 };
 return configuration;
}

export function parseEventLines(text){
 const events=[];let parseErrors=0;
 for(const line of String(text).split('\n')){
  if(!line.trim())continue;
  try{events.push(JSON.parse(line));}catch{parseErrors++;}
 }
 return {events,parse_errors:parseErrors};
}

// OpenCode emits one `step_finish` per model step. Its internal session total
// (`usage.turn`) adds those step token records. `input` includes cached prompt
// tokens; `cache.read` is the cached subset. Reasoning is a separate reported
// field and is not counted as output here.
export function sumUsage(events){
 const steps=events.filter(e=>e.type==='step_finish'&&e.part?.tokens);
 if(!steps.length)return null;
 const totals={input_tokens:0,output_tokens:0,reasoning_tokens:0,cached_input_tokens:0,cached_write_tokens:0,cost_usd:0,steps:steps.length};
 for(const event of steps){
  const tokens=event.part.tokens;
  totals.input_tokens+=Number(tokens.input)||0;
  totals.output_tokens+=Number(tokens.output)||0;
  totals.reasoning_tokens+=Number(tokens.reasoning)||0;
  totals.cached_input_tokens+=Number(tokens.cache?.read)||0;
  totals.cached_write_tokens+=Number(tokens.cache?.write)||0;
  totals.cost_usd+=Number(event.part.cost)||0;
 }
 totals.uncached_input_tokens=Math.max(0,totals.input_tokens-totals.cached_input_tokens);
 totals.total_tokens=totals.input_tokens+totals.output_tokens+totals.reasoning_tokens;
 return totals;
}

export function finalText(events){
 const texts=new Map();
 for(const event of events){
  if(event.type!=='text'||event.part?.type!=='text')continue;
  const id=event.part.messageID||event.part.id;
  texts.set(id,(texts.get(id)||'')+String(event.part.text||''));
 }
 return [...texts.values()].at(-1)||'';
}

export function toolUses(events){
 return events.filter(e=>e.type==='tool_use'&&e.part?.type==='tool').map(e=>({
  id:e.part.id,
  name:e.part.tool,
  input:e.part.state?.input,
  status:e.part.state?.status,
  output:e.part.state?.output,
  error:e.part.state?.error,
  executed:e.part.executed,
 }));
}

export function providerError(events){
 for(const event of [...events].reverse()){
  if(event.type==='error'&&event.error)return event.error;
  const failed=event.error?.type==='provider.free-limit'||event.error?.type==='provider.auth'||event.error?.type==='provider.quota'||event.error?.type==='provider.rate-limit';
  if(failed)return event.error;
 }
 return null;
}

export function infrastructureReason(events){
 const error=providerError(events);
 if(!error)return null;
 if(/free-limit|quota|usage limit|auth|credential|rate.?limit|429|401|403/i.test(`${error.type} ${error.message}`))return error;
 return null;
}

function requestedModel(model,variant){
 return {provider:model.split('/')[0],model_id:model.split('/').slice(1).join('/'),variant};
}
function modelMatches(requested,actual){
 return actual?.providerID===requested.provider&&actual?.id===requested.model_id&&(requested.variant?actual?.variant===requested.variant:true);
}

async function exportSession({environment,cwd,sessionID,model,variant}){
 if(!sessionID)return null;
 const result=await new Promise(resolve=>{
  const child=spawn('opencode',['--standalone','session','export',sessionID],{cwd,env:environment,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-2000));
  child.once('error',error=>resolve({error:error.message}));
  child.once('exit',code=>resolve({code,stdout,stderr}));
 });
 if(result.error||result.code!==0)return {error:result.error||result.stderr||`session export exit ${result.code}`};
 let exported;try{exported=JSON.parse(result.stdout);}catch{return {error:'session export was not JSON'};}
 const info=exported.info||{};
 return {
  session_id:info.id,
  model:info.model??null,
  model_matches:modelMatches(requestedModel(model,variant),info.model),
  outcome:info.outcome??null,
  tokens:info.tokens??null,
  cost_usd:info.cost??null,
  message_count:Array.isArray(exported.messages)?exported.messages.length:null,
 };
}

export async function runOpenCodeHost({cwd,socket,model=OPENCODE_MODEL,variant=OPENCODE_VARIANT,serverName='browser',toolName='execute',prompt,timeout=180000,home}){
 const configuration=home||await prepareOpenCodeHome({root:tmpdir(),model,variant});
 const config=openCodeConfig({model,variant,socket,serverName,toolName});
 await writeFile(configuration.config_path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
 const environment=configuration.environment;
 const args=['run','--standalone','--format','json','--archived','--agent','benchmark','--model',`${model}#${variant}`,'--title','callisto browser benchmark',prompt];
 const child=spawn('opencode',args,{cwd,env:environment,stdio:['ignore','pipe','pipe'],detached:true});
 let timedOut=false,stderr='';const started=performance.now();
 const stop=signal=>{try{process.kill(-child.pid,signal);}catch{}};
 const timer=setTimeout(()=>{timedOut=true;stop('SIGTERM');},timeout);
 const hardStop=setTimeout(()=>{stop('SIGKILL');},timeout+5000);
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
 const stdoutLines=[];const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{stdoutLines.push(line);});
 const {code,signal,error}=await new Promise(resolve=>{child.once('error',error=>resolve({error:error.message}));child.once('exit',(code,signal)=>resolve({code,signal}));});
 clearTimeout(timer);clearTimeout(hardStop);lines.close();
 const {events,parse_errors}=parseEventLines(stdoutLines.join('\n'));
 const usage=sumUsage(events);
 const final=finalText(events);
 const sessionID=events.find(e=>e.sessionID)?.sessionID??null;
 const session=await exportSession({environment,cwd,sessionID,model,variant}).catch(error=>({error:error.message}));
 const provider=infrastructureReason(events);
 const forbidden=(()=>{
  const allowed=`${serverName}_${toolName}`;
  return toolUses(events).filter(tool=>tool.name!==allowed).map(tool=>tool.name);
 })();
 const modelVerified=session?.model_matches===true;
 const infrastructure=Boolean(provider)||forbidden.length>0||(session&&session.model&&!session.model_matches);
 return {
  code,signal,error:error??null,timed_out:timedOut,elapsed_ms:performance.now()-started,
  usage,final,events,parse_errors,
  session,
  provider_error:provider,
  infrastructure,
  infrastructure_reason:provider?`${provider.type}: ${provider.message}`:forbidden.length?`forbidden host tool: ${forbidden.join(', ')}`:session?.model&&!session.model_matches?'served model did not match request':null,
  forbidden_tool_calls:forbidden,
  model_verified:modelVerified,
  diagnostic:code===0&&!provider?null:stderr.slice(-2000),
  configuration:{
   host:'opencode',model,variant,agent:'benchmark',sandbox:'private HOME/XDG, empty workspace, deny-all permissions except one browser MCP action',
   shell:false,webfetch:false,websearch:false,skills:false,instructions:[],project_config:false,codemode:false,
   native_mcp_tool_names:true,mcp_server:serverName,native_tool:toolName,exposed_tool:`${serverName}_${toolName}`,
   mcp_transport:'stdio → private Unix socket → native runtime MCP client',title_generation_disabled:true,compaction_disabled:true,
   auth:'OpenCode free-model session; no credential copied or printed',schema_enforcement:false,
  },
  config_sha256:digest(await readFile(configuration.config_path)),
 };
}

export async function runOpenCodePreflight({root,model=OPENCODE_MODEL,variant=OPENCODE_VARIANT,prompt='Reply with exactly: OK',timeout=120000}){
 const home=await prepareOpenCodeHome({root,model,variant});
 const config={...openCodeConfig({model,variant,socket:join(home,'unused.sock'),serverName:'preflight',toolName:'none'})};
 config.mcp={servers:{}};config.default_agent='build';
 config.permissions=[{action:'*',resource:'*',effect:'deny'}];
 delete config.agents;
 await writeFile(home.config_path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
 const cwd=join(home,'workspace');await mkdir(cwd,{mode:0o700});
 const started=performance.now();
 const child=spawn('opencode',['run','--standalone','--format','json','--archived','--model',`${model}#${variant}`,'--title','callisto preflight',prompt],{cwd,env:home.environment,stdio:['ignore','pipe','pipe'],detached:true});
 let timedOut=false,stderr='';const stop=signal=>{try{process.kill(-child.pid,signal);}catch{}};
 const timer=setTimeout(()=>{timedOut=true;stop('SIGTERM');},timeout);
 const hardStop=setTimeout(()=>{stop('SIGKILL');},timeout+5000);
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
 const stdoutLines=[];createInterface({input:child.stdout}).on('line',line=>stdoutLines.push(line));
 const {code,signal,error}=await new Promise(resolve=>{child.once('error',error=>resolve({error:error.message}));child.once('exit',(code,signal)=>resolve({code,signal}));});
 clearTimeout(timer);clearTimeout(hardStop);
 const {events,parse_errors}=parseEventLines(stdoutLines.join('\n'));
 const sessionID=events.find(e=>e.sessionID)?.sessionID??null;
 const session=await exportSession({environment:home.environment,cwd,sessionID,model,variant}).catch(error=>({error:error.message}));
 return {status:providerError(events)?'blocked':code===0&&!timedOut?'passed':'failed',model,variant,code,signal,error:error??null,timed_out:timedOut,elapsed_ms:performance.now()-started,events,parse_errors,usage:sumUsage(events),final:finalText(events),provider_error:providerError(events),session,stderr:stderr.slice(-2000),home,cwd};
}

export async function closeOpenCodeHome(configuration){
 if(configuration?.home)await rm(configuration.home,{recursive:true,force:true});
}
