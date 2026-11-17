// Correctness checks in an owned local Firefox/Zen profile. No model or benchmark trials.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {MCPClient} from '../../../eval/agent-comparison/mcp-client.mjs';
import {ZenFixture,until,value} from '../../../eval/agent-comparison/zen-fixture.mjs';
const exec=promisify(execFile),binary=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
const directory=await mkdtemp(join(tmpdir(),'callisto-native-checks-'));
const environment={...process.env,CALLISTO_FIREFOX_STATE_DIR:directory,CALLISTO_TOOL_PROFILE:'auto'};
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Native contracts fixture</title>
<header><a href="#main">Home navigation</a></header><aside><button>Unrelated sidebar</button></aside>
<main id="main"><h1>Local fixture</h1><p id="fact">Original fact</p><form onsubmit="event.preventDefault();document.querySelector('#fact').textContent='Submitted '+entry.value">
<label>Entry<input id="entry"></label><label>Secret<input type="password" id="secret"></label><button type="submit">Submit entry</button></form>
<label>Search by<select id="choice"><option value="all">All fields</option><option value="ti">Title</option></select></label>
<button id="count" onclick="window.count=(window.count||0)+1">Count</button>
<div id="source" draggable="true" role="button" aria-label="Drag source" style="width:80px;height:40px;background:orange">Source</div>
<div id="drop" role="button" aria-label="Drop target" style="width:120px;height:60px;background:lightblue">Drop</div>
<button id="prompt" onclick="document.querySelector('#fact').textContent=prompt('Fixture prompt','default')">Open prompt</button>
</main><script>window.count=0;source.ondragstart=e=>e.dataTransfer.setData('text/plain','fixture');drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();window.dropped=e.dataTransfer.getData('text/plain')};</script>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/`;
let client,fixture;const checks=[];
const check=async(name,work)=>{await work();checks.push(name);console.log('PASS '+name);};
try{
 client=await new MCPClient(binary,[],environment).initialize({name:'opencode',version:'native-contract-check'});
 assert(client.initialization.instructions.includes('Code Mode'));
 const catalog=(await client.request('tools/list')).tools;assert(catalog.some(t=>t.name==='callisto_dialog'));assert(!catalog.some(t=>t.name==='callisto'));
 fixture=new ZenFixture(client,{kind:process.env.CALLISTO_TEST_BROWSER||'firefox',promptBehavior:'ignore'});await fixture.start(url);
 const call=(op,args={})=>fixture.call('callisto_'+op,args);
 await call('input',{action:'disable'});
 await check('invalid later step dispatches no earlier write',async()=>{
  const result=await client.callTool({name:'callisto_run',arguments:{steps:[{action:'click',role:'button',name:'Count'},{action:'fill',role:'textbox',name:'Entry'}]}});
  assert(result.isError);assert.equal(result.structuredContent.dispatch,'not_dispatched');assert.equal(await fixture.script('return count'),0);
 });
 await check('canonical actions, legacy fill aliases, and option labels',async()=>{
  const result=await call('run',{steps:[{action:'fill',role:'textbox',name:'Entry',text:'one registry'},{action:'select',role:'combobox',name:'Search by',value:'Title'},{action:'submit',role:'textbox',name:'Entry'}]});
  assert.equal(result.completed,3);assert(result.feedback.document_revision);assert.equal(await fixture.script('return choice.value'),'ti');assert.equal(await fixture.script('return fact.textContent'),'Submitted one registry');
 });
 let sourceRef;
 await check('focused observations, independent diffs, and bounded refs',async()=>{
  const full=await call('snapshot');sourceRef=/\[(ax-\d+)\] button "Drag source"/.exec(full.text)[1];assert(sourceRef.length<16,sourceRef);
  const focus=await call('snapshot',{focus:'main'});assert(focus.text.includes('Home navigation'));assert(!focus.text.includes('Unrelated sidebar'));assert(focus.omitted>0);assert(focus.text.includes('"value":"ti"'));
  await call('snapshot',{query:'Title'});await fixture.script("fact.textContent='Changed fact'");
  const delta=await call('snapshot',{diff:true});assert.equal(delta.base_revision,full.revision);assert(delta.text.includes('Changed fact'));assert(!delta.text.includes('button "Count"'));
 });
 await check('synthetic HTML drag/drop changes browser state',async()=>{
  const snapshot=await call('snapshot');const target=label=>snapshot.text.split('\n').find(l=>l.includes('"'+label+'"')).match(/\[(ax-\d+)\]/)[1];
  const result=await call('drag',{ref:target('Drag source'),target_ref:target('Drop target')});assert(result.drop_accepted);assert.equal(await fixture.script('return dropped'),'fixture');
 });
 await check('trusted human recordings redact passwords and omit synthetic events',async()=>{
  await call('recording',{action:'start'});await call('click',{role:'button',name:'Count'});
  const key='element-6066-11e4-a52e-4f735466cecf';
  for(const [selector,text] of [['#entry','Human input'],['#secret','never-record-this']]){
   const found=await fixture.request(`/session/${fixture.session}/element`,{using:'css selector',value:selector});
   await fixture.request(`/session/${fixture.session}/element/${found[key]}/click`,{});
   await fixture.request(`/session/${fixture.session}/element/${found[key]}/value`,{text});
  }
  const result=await call('recording',{action:'stop',limit:200});assert(result.events.length>0);assert(!JSON.stringify(result).includes('never-record-this'));assert(result.events.some(e=>e.value==='[REDACTED]'));assert(!result.events.some(e=>e.target.name==='Count'));
 });
 await check('named tab handles resolve across native calls',async()=>{
  await call('browser',{action:'tab_name',tab_id:fixture.tabId,tab_name:'work-form'});
  assert.equal((await call('browser',{action:'tab_resolve',tab_name:'work-form'})).id,fixture.tabId);
 });
 await call('input',{action:'enable',endpoint:fixture.endpoint});
 await check('trusted drag performs native pointer input',async()=>{
  await fixture.script("source.draggable=false;window.dragState={down:false,completed:0};source.onpointerdown=e=>{if(e.isTrusted)dragState.down=true};drop.onpointerup=e=>{if(e.isTrusted&&dragState.down){dragState.completed++;dragState.down=false}}");
  const snapshot=await call('snapshot');const target=label=>snapshot.text.split('\n').find(l=>l.includes('"'+label+'"')).match(/\[(ax-\d+)\]/)[1];
  assert.equal((await call('drag',{ref:target('Drag source'),target_ref:target('Drop target')})).trusted,true);
  assert.equal(await fixture.script('return dragState.completed'),1);
 });
 await check('human demonstration returns trusted interactions after confirmation',async()=>{
  await call('input',{action:'disable'});
  const work=call('demonstrate',{message:'Demonstrate the local form',timeout_ms:10000});
  const key='element-6066-11e4-a52e-4f735466cecf';
  await until(()=>fixture.script('return Boolean(document.querySelector("[data-callisto-handoff]"))'));
  const field=await fixture.request(`/session/${fixture.session}/element`,{using:'css selector',value:'#entry'});
  await fixture.request(`/session/${fixture.session}/element/${field[key]}/click`,{});
  await fixture.request(`/session/${fixture.session}/element/${field[key]}/value`,{text:'demonstrated'});
  const done=await fixture.request(`/session/${fixture.session}/element`,{using:'css selector',value:'[data-callisto-handoff] button'});
  await fixture.request(`/session/${fixture.session}/element/${done[key]}/click`,{});
  const result=await work;assert.equal(result.confirmed,true);assert(result.recording.events.some(e=>e.value?.includes('demonstrated')));assert.equal(result.recording.active,false);
  await call('input',{action:'enable',endpoint:fixture.endpoint});
 });
 await check('lease-bound console captures real page logs',async()=>{
  await call('console',{action:'start'});await fixture.script("console.log('callisto-console-fixture')");
  await until(async()=>{const result=await call('console',{action:'list'});return result.entries.some(e=>e.text.includes('callisto-console-fixture'));});
  assert.equal((await call('console',{action:'stop'})).active,false);
 });
 await check('viewport emulation and screenshot comparison use real pixels',async()=>{
  await call('emulate',{action:'viewport',width:800,height:600,device_pixel_ratio:1});
  assert.equal(await fixture.script('return innerWidth'),800);
  const screenshot=await client.callTool({name:'callisto_screenshot',arguments:{format:'png',clip:{x:0,y:0,width:100,height:100}}});assert(screenshot.content.some(c=>c.type==='image'&&c.mimeType==='image/png'));
  await fixture.script('document.body.insertAdjacentHTML("beforeend","<div id=tall style=height:1600px></div>")');
  const full=await client.callTool({name:'callisto_screenshot',arguments:{format:'png',full_page:true}});
  const png=Buffer.from(full.content.find(c=>c.type==='image').data,'base64');assert(png.readUInt32BE(20)>600);
  await fixture.script('document.querySelector("#tall").remove();entry.blur();secret.blur()');await call('screenshot_diff',{action:'baseline'});
  await fixture.script("document.body.style.background='rgb(100,20,80)'");
  assert((await call('screenshot_diff',{action:'compare'})).changed_pixels>0);
  await call('emulate',{action:'reset'});
 });
 await check('WebMCP reports absence and executes page-provided tools',async()=>{
  assert.equal((await call('webmcp',{action:'list'})).supported,false);
  await fixture.script("document.modelContext={getTools:async()=>[{name:'setFixture',description:'Owned fixture',inputSchema:{type:'object'}}],executeTool:async(_tool,args)=>{document.body.dataset.webmcp=args.value;return {saved:args.value}}}");
  assert.equal((await call('webmcp',{action:'list'})).tools[0].name,'setFixture');
  assert.equal((await call('webmcp',{action:'call',name:'setFixture',arguments:{value:'ok'}})).result.saved,'ok');assert.equal(await fixture.script('return document.body.dataset.webmcp'),'ok');
 });
 await check('native prompts are observed and accepted without replay',async()=>{
  await call('dialog',{action:'start'});
  await fixture.script("setTimeout(()=>{document.querySelector('#fact').textContent=prompt('Fixture prompt','default')},200)");
  await until(async()=>Boolean((await call('dialog',{action:'status'})).prompt));
  assert.equal((await call('dialog',{action:'accept',text:'accepted once'})).handled,true);
  assert.equal(await fixture.script('return fact.textContent'),'accepted once');await call('dialog',{action:'stop'});
 });
 await check('stale refs and facility captures expire when sharing stops',async()=>{
  await call('close');assert.equal((await call('status')).sharing,false);
  const refused=await client.callTool({name:'callisto_click',arguments:{ref:sourceRef}});assert(refused.isError);
  await fixture.share();await assert.rejects(()=>call('screenshot_diff',{action:'compare'}),/baseline/);
  await fixture.navigate(url+'new-document');const snapshot=await call('snapshot');assert(!snapshot.text.includes('['+sourceRef+']'));
  assert((await client.callTool({name:'callisto_click',arguments:{ref:sourceRef}})).isError);
 });
 console.log(JSON.stringify({passed:true,browser:fixture.kind,version:fixture.capabilities.browserVersion,checks}));
}finally{
 await fixture?.close();await client?.close();await exec(binary,['--stop-relay'],{env:environment}).catch(()=>{});await rm(directory,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));
}
