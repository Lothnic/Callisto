import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openCodeConfig,parseEventLines,sumUsage,finalText,toolUses,providerError,infrastructureReason,privateEnvironment,prepareOpenCodeHome,OPENCODE_MODEL,OPENCODE_VARIANT} from './opencode-host.mjs';
const exec=promisify(execFile);

const lines=[
 {type:'step_start',timestamp:1,sessionID:'ses_test',part:{id:'prt_1',sessionID:'ses_test',messageID:'msg_1',type:'step-start'}},
 {type:'tool_use',timestamp:2,sessionID:'ses_test',part:{id:'prt_tool',sessionID:'ses_test',messageID:'msg_1',type:'tool',id:'call_1',tool:'browser_execute',executed:true,state:{status:'completed',input:{session:'bench',code:'return await page.title()'},output:'Example Domain',metadata:{},time:{}}}},
 {type:'text',timestamp:3,sessionID:'ses_test',part:{id:'prt_2',sessionID:'ses_test',messageID:'msg_1',type:'text',text:'{"answer":',time:{}}},
 {type:'text',timestamp:4,sessionID:'ses_test',part:{id:'prt_3',sessionID:'ses_test',messageID:'msg_1',type:'text',text:'"ok"}',time:{}}},
 {type:'step_finish',timestamp:5,sessionID:'ses_test',part:{id:'prt_4',sessionID:'ses_test',messageID:'msg_1',type:'step-finish',reason:'stop',cost:0,tokens:{input:100,output:10,reasoning:4,cache:{read:60,write:2}}}},
 {type:'step_finish',timestamp:6,sessionID:'ses_test',part:{id:'prt_5',sessionID:'ses_test',messageID:'msg_2',type:'step-finish',reason:'stop',cost:0,tokens:{input:50,output:5,reasoning:1,cache:{read:40,write:0}}}},
];
const raw=lines.map(line=>JSON.stringify(line)).join('\n');

test('exact OpenCode JSON lines preserve events and expose final assistant text',()=>{
 const parsed=parseEventLines(raw+'\nnot-json\n');
 assert.equal(parsed.events.length,lines.length);
 assert.equal(parsed.parse_errors,1);
 assert.equal(finalText(parsed.events),'{"answer":"ok"}');
 const tools=toolUses(parsed.events);
 assert.equal(tools.length,1);
 assert.equal(tools[0].name,'browser_execute');
 assert.deepEqual(tools[0].input,{session:'bench',code:'return await page.title()'});
 assert.equal(tools[0].output,'Example Domain');
});

test('usage is summed across model steps and cached input is a subset',()=>{
 const usage=sumUsage(parseEventLines(raw).events);
 assert.equal(usage.steps,2);
 assert.equal(usage.input_tokens,150);
 assert.equal(usage.output_tokens,15);
 assert.equal(usage.reasoning_tokens,5);
 assert.equal(usage.cached_input_tokens,100);
 assert.equal(usage.cached_write_tokens,2);
 assert.equal(usage.uncached_input_tokens,50);
 assert.equal(usage.total_tokens,170);
 assert.equal(usage.cost_usd,0);
});

test('provider free-limit event is an infrastructure blocker, not a task failure',()=>{
 const blocked=parseEventLines(JSON.stringify({type:'error',timestamp:1,sessionID:'ses_test',error:{type:'provider.free-limit',message:'Free usage limit reached.',status:429,retryAfterMs:3600000}})).events;
 assert.equal(providerError(blocked).status,429);
 assert.equal(infrastructureReason(blocked).type,'provider.free-limit');
 assert.equal(infrastructureReason(parseEventLines(raw).events),null);
});

test('private environment drops unrelated credentials, project config and harness session state',()=>{
 const environment=privateEnvironment({PATH:'/bin',HOME:'/home/person',OPENCODE_PASSWORD:'secret',OPENCODE_SESSION_ID:'ses_parent',AI_AGENT:'opencode',OPENCODE_CONFIG_CONTENT:'{}',ANTHROPIC_API_KEY:'secret',DISPLAY:':99',LANG:'C.UTF-8'},'/tmp/private-home');
 assert.equal(environment.HOME,'/tmp/private-home');
 assert.equal(environment.DISPLAY,':99');
 assert.equal(environment.OPENCODE_DISABLE_PROJECT_CONFIG,'1');
 assert.equal(environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS,'1');
 for(const key of ['OPENCODE_PASSWORD','OPENCODE_SESSION_ID','AI_AGENT','OPENCODE_CONFIG_CONTENT','ANTHROPIC_API_KEY'])assert.equal(key in environment,false,key);
});

test('host config exposes one native MCP tool and denies every other action',()=>{
 const config=openCodeConfig({model:'opencode/deepseek-v4.1-flash-free',variant:'high',socket:'/tmp/bench.sock',serverName:'browser',toolName:'execute'});
 assert.deepEqual(config.permissions,[{action:'*',resource:'*',effect:'deny'},{action:'browser_execute',resource:'*',effect:'allow'}]);
 assert.deepEqual(config.agents.benchmark.permissions,[{action:'*',resource:'*',effect:'deny'},{action:'browser_execute',resource:'*',effect:'allow'}]);
 assert.equal(config.default_agent,'benchmark');
 assert.deepEqual(config.instructions,[]);
 assert.equal(config.compaction.auto,false);
 assert.equal(config.mcp.servers.browser.codemode,false);
 assert.equal(config.mcp.servers.browser.command.at(-1),'/tmp/bench.sock');
 assert.equal(config.model,'opencode/deepseek-v4.1-flash-free#high');
});

test('OpenCode resolves the private host config without global or project MCP servers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'callisto-opencode-config-'));
 const home=await prepareOpenCodeHome({root,model:OPENCODE_MODEL,variant:OPENCODE_VARIANT});
 try{
  const config=openCodeConfig({model:OPENCODE_MODEL,variant:OPENCODE_VARIANT,socket:join(home.home,'bench.sock'),serverName:'zen',toolName:'callisto'});
  await writeFile(home.config_path,JSON.stringify(config,null,2));
  const {stdout}=await exec('opencode',['--standalone','debug','config'],{cwd:home.home,env:home.environment,timeout:30000});
  const documents=JSON.parse(stdout);
  const resolved=documents.find(document=>document.path===home.config_path)?.info;
  assert.ok(resolved,'private config document is loaded');
  assert.deepEqual(resolved.model,{providerID:'opencode',model:'deepseek-v4.1-flash-free',variant:'high'});
  assert.deepEqual(Object.keys(resolved.mcp.servers),['zen']);
  assert.equal(resolved.mcp.servers.zen.codemode,false);
  assert.deepEqual(resolved.instructions,[]);
  assert.equal(resolved.compaction.auto,false);
  assert.equal(resolved.default_agent,'benchmark');
  const agents=JSON.parse((await exec('opencode',['--standalone','debug','agents'],{cwd:home.home,env:home.environment,timeout:30000})).stdout);
  const benchmark=agents.find(agent=>agent.id==='benchmark');
  assert.ok(benchmark,'custom benchmark agent is resolved');
  assert.ok(benchmark.permissions.some(rule=>rule.action==='zen_callisto'&&rule.effect==='allow'));
  assert.ok(benchmark.permissions.some(rule=>rule.action==='*'&&rule.effect==='deny'));
 }finally{await rm(root,{recursive:true,force:true});}
});
