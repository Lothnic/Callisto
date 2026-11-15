// Actual X11 human typing + media playback alongside extension-owned native input.
import {MCPClient} from './mcp-client.mjs';
import {ZenFixture,until} from './zen-fixture.mjs';
import {provenance} from './provenance.mjs';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';
const exec=promisify(execFile),state=await mkdtemp(join(tmpdir(),'callisto-background-')),runtime=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp'),environment={...process.env,CALLISTO_FIREFOX_STATE_DIR:state};
const output=resolve(process.env.BACKGROUND_OUTPUT||'eval/reports/background-window-2026-11-15.json'),duration=Number(process.env.BACKGROUND_DURATION_MS||10000),typingDelay=Number(process.env.BACKGROUND_TYPING_DELAY_MS||100),idle=process.env.BACKGROUND_AGENT_IDLE==='1';
if(!Number.isFinite(typingDelay)||typingDelay<10||typingDelay>300)throw Error('Typing delay must be 10–300 ms');
if(!Number.isFinite(duration)||duration<1000||duration>900000)throw Error('Duration must be 1000–900000 ms');
let client,fixture,typing,manager,stage='browser start',managerErrors='',managerStatus='';const writes=[],rows=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/save'){let body='';for await(const b of req)body+=b;writes.push(JSON.parse(body));res.end('{}');return;}
 res.setHeader('Content-Type','text/html');
 if(req.url==='/human'){res.end(`<title>Human work</title><label>Human editor <textarea id="human" rows="4"></textarea></label><video id="video" muted autoplay width="160" height="90"></video><canvas id="source" width="160" height="90" style="width:1px;height:1px;position:absolute"></canvas><script>window.humanKeys=[];human.addEventListener('keydown',e=>humanKeys.push({key:e.key,ctrl:e.ctrlKey,alt:e.altKey}));const c=source.getContext('2d');let n=0;setInterval(()=>{c.fillStyle=n++%2?'blue':'green';c.fillRect(0,0,160,90);},40);video.srcObject=source.captureStream(25);video.play().catch(e=>document.body.dataset.mediaError=e.message);</script>`);return;}
 res.end(`<title>Agent form</title><p id="sentinel">Fresh document</p><form><label>Agent name <input id="agent" name="agent"></label><label><input id="check" type="checkbox">Confirm</label><label>Choice <select id="choice"><option value="a">A</option><option value="b">B</option></select></label><button>Save</button></form><p id="result"></p><script>const trust=[];agent.oninput=e=>trust.push(e.isTrusted);document.querySelector('form').onsubmit=async e=>{e.preventDefault();const value=agent.value;await fetch('/save',{method:'POST',body:JSON.stringify({value,trusted:e.isTrusted,inputTrusted:trust.every(Boolean),checked:check.checked,choice:choice.value})});result.textContent='Saved '+value;};</script>`);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
async function check(name,work){const start=performance.now();try{await work();rows.push({name,passed:true,elapsed_ms:performance.now()-start});console.error(name+': PASS');}catch(error){rows.push({name,passed:false,error:error.message});throw error;}}
async function displayEnvironment(){for(const item of await readdir('/proc')){if(!/^\d+$/.test(item))continue;try{const args=(await readFile(`/proc/${item}/cmdline`,'utf8')).split('\0');if(!args[0]?.endsWith('/geckodriver')||!args.includes('--profile-root')||!args.includes(fixture.directory))continue;const env=Object.fromEntries((await readFile(`/proc/${item}/environ`,'utf8')).split('\0').filter(v=>v.includes('=')).map(v=>[v.slice(0,v.indexOf('=')),v.slice(v.indexOf('=')+1)]));if(env.DISPLAY&&env.XAUTHORITY?.startsWith('/tmp/xvfb-run.'))return {...process.env,DISPLAY:env.DISPLAY,XAUTHORITY:env.XAUTHORITY};}catch{}}throw Error('Cannot identify the owned Xvfb display; refusing OS input');}
const inspect=async()=>({human:await fixture.script('return {focused:document.hasFocus(),value:human.value,mediaTime:video.currentTime,paused:video.paused,mediaError:document.body.dataset.mediaError||null,keys:humanKeys.map(e=>e.key.length===1?e.key:"").join(""),modifierKeys:humanKeys.filter(e=>e.ctrl||e.alt)}'),diagnostics:(await fixture.call('callisto_browser',{action:'tabs_list'})).fixture_diagnostics});
let before,after,started,executionEnded,osFocusBefore,osFocusAfter,typedText='',rounds=0,task,traceStarted=false;
const traceDirectory=process.env.BACKGROUND_TRACE_DIR?resolve(process.env.BACKGROUND_TRACE_DIR):null;
try{
 client=await new MCPClient(runtime,[],environment).initialize();fixture=new ZenFixture(client,{kind:process.env.CALLISTO_TEST_BROWSER||'zen',headless:false});await fixture.start(origin+'/agent');
 if(traceDirectory){await fixture.call('callisto_trace',{action:'start',directory:traceDirectory});traceStarted=true;}
 stage='window manager';const display=await displayEnvironment();manager=spawn(process.env.BACKGROUND_WINDOW_MANAGER||'openbox',['--sm-disable'],{env:display,stdio:['ignore','ignore','pipe']});manager.stderr.on('data',b=>managerErrors=(managerErrors+b.toString()).slice(-1000));manager.on('error',error=>managerErrors=error.message);await until(async()=>(managerStatus=(await exec('wmctrl',['-m'],{env:display})).stdout).toLowerCase().includes('openbox'));
 await fixture.script('sentinel.textContent="Unsaved document marker"');await fixture.call('callisto_run',{steps:[{action:'fill_role',role:'textbox',name:'Agent name',value:'UNSAVED'}]});
 stage='human media';const human=await fixture.request(`/session/${fixture.session}/window/new`,{type:'tab'});await fixture.request(`/session/${fixture.session}/window`,{handle:human.handle});await fixture.request(`/session/${fixture.session}/url`,{url:origin+'/human'});
 const element=await fixture.request(`/session/${fixture.session}/element`,{using:'css selector',value:'#human'});await fixture.request(`/session/${fixture.session}/element/${Object.values(element)[0]}/click`,{});
 await until(async()=>await fixture.script('return !video.paused&&video.currentTime>0'));
 before=await inspect();stage='task';
 assert.equal(fixture.capabilities['moz:headless'],false,'Concurrency requires a real headful browser');
 const osEnvironment=await displayEnvironment();

 const clients=(await exec('wmctrl',['-lp'],{env:osEnvironment})).stdout.trim().split('\n').filter(Boolean);
 assert.equal(clients.length,1,'Expected exactly the owned browser window on this private X11 display');
 const humanWindow=clients[0].split(/\s+/)[0];await exec('xdotool',['windowactivate','--sync',humanWindow],{env:osEnvironment,timeout:5000});
 before=await inspect();
 await check('explicit-user-preparation-preserves-exact-tab-and-document',async()=>{task=await fixture.call('callisto_browser',{action:'fixture_background_prepare'});assert.equal(task.focusPolicy,'never');assert.equal(task.tab_id,fixture.tabId);await exec('xdotool',['windowactivate','--sync',humanWindow],{env:osEnvironment,timeout:5000});await fixture.request(`/session/${fixture.session}/window`,{handle:human.handle});await until(async()=>!(await fixture.call('callisto_status')).execution.paused);const snapshot=await fixture.call('callisto_snapshot',{max_chars:4000});assert(snapshot.text.includes('UNSAVED'));assert(snapshot.text.includes('Unsaved document marker'));const state=await inspect();assert(state.human.focused);assert.equal(state.diagnostics.windows.find(w=>w.focused)?.id,before.diagnostics.windows.find(w=>w.focused)?.id);});
 started=Date.now();const text=typedText='human types while agent works. '.repeat(Math.ceil(duration/('human types while agent works. '.length*typingDelay)));
 osFocusBefore=(await exec('xdotool',['getwindowfocus'],{env:osEnvironment})).stdout.trim();
 typing=exec('xdotool',['type','--clearmodifiers','--delay',String(typingDelay),'--',text],{env:osEnvironment,timeout:Math.max(30000,duration*3)});
 await check('native-form-work-alongside-real-X11-typing-and-media',async()=>{
  const untilTime=performance.now()+duration;
  while(performance.now()<untilTime){if(idle){await new Promise(r=>setTimeout(r,100));continue;}const value='Agent '+(++rounds);await fixture.call('callisto_run',{steps:[{action:'fill_role',role:'textbox',name:'Agent name',value},{action:'check_role',role:'checkbox',name:'Confirm',checked:true},{action:'select_role',role:'combobox',name:'Choice',value:'b'},{action:'click_role',role:'button',name:'Save'}]});await until(()=>writes.some(w=>w.value===value));}
  await typing;typing=null;after=await inspect();executionEnded=Date.now();assert(after.human.value===text,'Human typing was changed or lost');assert(after.human.focused);assert(!after.human.paused);assert(after.human.mediaTime>before.human.mediaTime+duration/2000);assert((idle||writes.length>0)&&writes.every(w=>w.trusted&&w.inputTrusted&&w.checked&&w.choice==='b'));
  assert.deepEqual(after.diagnostics.focusEvents.filter(e=>e.at>=started),[]);osFocusAfter=(await exec('xdotool',['getwindowfocus'],{env:osEnvironment})).stdout.trim();assert.equal(osFocusAfter,osFocusBefore);
 });
 await check('pause-resume-and-take-back-preserve-window',async()=>{
  await fixture.call('callisto_browser',{action:'background',operation:'pause'});const count=writes.length;assert((await client.callTool({name:'callisto_run',arguments:{steps:[{action:'click_role',role:'button',name:'Save'}]}})).isError);assert.equal(writes.length,count);
  await fixture.call('callisto_browser',{action:'background',operation:'resume'});await fixture.call('callisto_run',{steps:[{action:'fill_role',role:'textbox',name:'Agent name',value:'Resumed'},{action:'click_role',role:'button',name:'Save'}]});await until(()=>writes.some(w=>w.value==='Resumed'));
  await fixture.call('callisto_browser',{action:'background',operation:'stop'});assert.equal((await fixture.call('callisto_status')).sharing,false);const tabs=(await fixture.call('callisto_browser',{action:'tabs_list'})).tabs;assert(tabs.some(t=>t.id===task.tab_id&&t.windowId===task.window_id));
 });
}catch(error){process.exitCode=1;if(!rows.some(r=>!r.passed))rows.push({name:'setup',passed:false,error:stage+': '+error.message+(stage==='window manager'?' '+managerErrors+' '+managerStatus:'')});console.error(stage+': '+error.message+(stage==='window manager'?' '+managerErrors+' '+managerStatus:''));}
finally{
 if(typing)await typing.catch(()=>{});if(traceStarted)await fixture.call('callisto_trace',{action:'stop'}).catch(()=>{});manager?.kill('SIGTERM');
 const report={schema:'callisto.background-window-check.v1',created_at:new Date().toISOString(),...await provenance(),browser:fixture?.capabilities?.browserVersion,kind:fixture?.kind,real_user_profile:false,setup:'Explicit user preparation can focus the agent window once. The fixture then simulates returning to the human window; automatic resume happens before measured typing/work.',scope:'Owned headful browser under Xvfb/X11 with Openbox. Concurrent OS-level xdotool typing and muted canvas-stream video in the human tab. Not Wayland/macOS/Windows, covered/minimized or a real personal-media session.',window_manager:'Openbox',desktop:'private Xvfb / X11',headful:fixture?.capabilities?.['moz:headless']===false,execution_started_at_ms:started,execution_ended_at_ms:executionEnded,os_keyboard_focus_before:osFocusBefore,os_keyboard_focus_after:osFocusAfter,expected_human_text:typedText,form_submissions:writes,focus_events_during_execution:after?.diagnostics.focusEvents.filter(e=>e.at>=started&&e.at<=executionEnded),trace_directory:traceDirectory,human_typing_delay_ms:typingDelay,human_only_control:idle,duration_ms:duration,rounds,passed:rows.length===3&&rows.every(r=>r.passed),rows,before,after};
 await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
 await fixture?.close();await client?.close();await exec(runtime,['--stop-relay'],{env:environment}).catch(()=>{});await rm(state,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));console.log(output);
}
