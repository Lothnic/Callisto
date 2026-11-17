import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
const proxy=resolve('eval/agent-comparison/host-mcp-proxy.mjs');
export async function runCodexHost({cwd,socket,schema,model,effort,prompt,timeout=180000}){
 const config={model,model_reasoning_effort:effort,approval_policy:'never',web_search:'disabled',project_doc_max_bytes:0,'features.shell_tool':false,'features.multi_agent':false,'skills.bundled.enabled':false,'skills.include_instructions':false,'skills.max_context_tokens':1};
 const args=['exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--json','--color','never','--sandbox','read-only','--cd',cwd,'--output-schema',schema];
 for(const [key,value] of Object.entries(config))args.push('-c',key+'='+JSON.stringify(value));
 args.push('-c',`mcp_servers.browser={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([proxy,socket])},startup_timeout_sec=20,tool_timeout_sec=50,required=true,default_tools_approval_mode="approve"}`,'-');
 const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|HOME|USER|LOGNAME|LANG|LC_.*|DISPLAY|TMPDIR|XDG_.*|CODEX_HOME|HTTPS?_PROXY|NO_PROXY|SSL_CERT_.*)$/.test(key)));
 const child=spawn('codex',args,{env:environment,stdio:['pipe','pipe','pipe'],detached:true});
 let timedOut=false,stderr='',parseErrors=0;const events=[];const started=performance.now();
 const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};
 const timer=setTimeout(()=>{timedOut=true;stop();},timeout);const hardStop=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},timeout+5000);
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{const event=JSON.parse(line);if(event.item?.type==='reasoning')return;events.push(event);}catch{parseErrors++;}});
 child.stdin.end(prompt);
 const {code,signal,error}=await new Promise(resolve=>{child.once('error',error=>resolve({error:error.message}));child.once('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);clearTimeout(hardStop);lines.close();
 const usage=events.findLast(e=>e.type==='turn.completed')?.usage??null;
 const final=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item?.text??'';
 return {code,signal,error:error??null,timed_out:timedOut,elapsed_ms:performance.now()-started,usage,final,events,parse_errors:parseErrors,diagnostic:code===0?null:stderr.slice(-1000),configuration:{model,effort,sandbox:'read-only',shell_tool:false,web_search:'disabled',user_config_loaded:false,project_instructions_loaded:false,skills_catalog_max_tokens:1,automatic_skill_instructions:false,fixture_tool_approval:'explicit approve',auth:'existing signed-in Codex host',mcp_transport:'stdio → private Unix socket → native runtime MCP client'}};
}
