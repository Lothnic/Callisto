import {provenance} from './provenance.mjs';
import {MCPClient} from './mcp-client.mjs';
import {ZenFixture,until,value} from './zen-fixture.mjs';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile),runtime=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
const output=resolve(process.env.RECOVERY_OUTPUT||'eval/reports/session-recovery-2026-11-15.json');
const state=await mkdtemp(join(tmpdir(),'callisto-recovery-'));const env={...process.env,CALLISTO_FIREFOX_STATE_DIR:state};
const rows=[];let writes=0,fixture,client;
const server=createServer((req,res)=>{if(req.url==='/write'&&req.method==='POST'){writes++;res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;}res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Recovery fixture</title><h1>Persistent test profile</h1><label>Name <input></label><button onclick="fetch('/write',{method:'POST'}).then(()=>document.querySelector('#done').textContent='Saved')">Save</button><p id="done"></p>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/`;
async function check(name,work){const start=performance.now();try{await work();rows.push({name,passed:true,elapsed_ms:Math.round(performance.now()-start)});console.error(name+': PASS');}catch(error){rows.push({name,passed:false,elapsed_ms:Math.round(performance.now()-start),error:error.message.slice(0,500)});console.error(name+': FAIL '+error.message);throw error;}}
async function ownRelayPid(){for(const item of await readdir('/proc')){if(!/^\d+$/.test(item))continue;try{const args=(await readFile(`/proc/${item}/cmdline`,'utf8')).split('\0');const variables=(await readFile(`/proc/${item}/environ`,'utf8')).split('\0');if(args.includes('--relay')&&variables.includes('CALLISTO_FIREFOX_STATE_DIR='+state))return Number(item);}catch{}}throw Error('Cannot prove test relay ownership');}
try{
 client=await new MCPClient(runtime,[],env).initialize();fixture=new ZenFixture(client,{kind:process.env.CALLISTO_TEST_BROWSER||'zen'});await fixture.start(url);
 const originalCode=(await fixture.call('callisto_pair')).code;
 await check('cancelled-run-no-late-write',async()=>{const before=writes;const result=await client.callTool({name:'callisto_run',arguments:{steps:[{action:'wait',ms:1000},{action:'click_role',role:'button',name:'Save'}]}},{cancelAfter:150});assert(result.isError);await new Promise(r=>setTimeout(r,1100));assert.equal(writes,before);assert.equal((await fixture.call('callisto_status')).sharing,false);await fixture.share();});
 await check('relay-crash-no-trusted-downgrade',async()=>{process.kill(await ownRelayPid(),'SIGKILL');await until(async()=>{const status=await fixture.call('callisto_status');return status.connected&&status.input?.inputRecoveryRequired;});assert.equal((await fixture.call('callisto_pair')).code,originalCode);const tabs=(await fixture.call('callisto_browser',{action:'tabs_list'})).tabs;await fixture.call('callisto_browser',{action:'tab_select',tab_id:tabs.find(t=>t.url===url).id});const before=writes;const refused=await client.callTool({name:'callisto_run',arguments:{steps:[{action:'click_role',role:'button',name:'Save'}]}});assert(refused.isError);assert.equal(writes,before);await fixture.call('callisto_input',{action:'enable',endpoint:fixture.endpoint});await fixture.call('callisto_run',{steps:[{action:'click_role',role:'button',name:'Save'}]});await until(()=>writes===before+1);});
 await check('extension-update-requires-reshare',async()=>{await fixture.installExtension(false);assert.equal((await fixture.call('callisto_status')).sharing,false);assert.equal((await fixture.call('callisto_pair')).code,originalCode);await fixture.share();});
 await fixture.script('localStorage.setItem("recovery_marker","retained");document.cookie="recovery_cookie=retained; path=/; max-age=86400"');
 await check('browser-restart-retains-profile-and-pairing',async()=>{await fixture.restartBrowser();assert.equal((await fixture.call('callisto_status')).sharing,false);assert.equal((await fixture.call('callisto_pair')).code,originalCode);assert.equal(await fixture.script('return localStorage.getItem("recovery_marker")'),'retained');assert.match(await fixture.script('return document.cookie'),/recovery_cookie=retained/);await fixture.share();});
 if(fixture.kind==='zen')await check('browser-crash-retains-profile-with-explicit-reacquisition',async()=>{await fixture.crashBrowser();assert.equal((await fixture.call('callisto_status')).sharing,false);assert.equal(await fixture.script('return localStorage.getItem("recovery_marker")'),'retained');await fixture.share();});
 await check('tab-loss-cannot-retarget-input',async()=>{await fixture.call('callisto_browser',{action:'tab_close',tab_id:fixture.tabId});const before=writes;assert.equal((await fixture.call('callisto_status')).sharing,false);assert((await client.callTool({name:'callisto_fill',arguments:{ref:'ax-0',value:'wrong tab'}})).isError);assert.equal(writes,before);});
} catch(error){process.exitCode=1;if(!rows.some(r=>!r.passed))rows.push({name:'setup',passed:false,error:error.message.slice(0,500)});}
finally{
 const report={schema:'callisto.recovery-report.v1',created_at:new Date().toISOString(),...await provenance(),browser:fixture?.capabilities?.browserVersion,kind:fixture?.kind,persistent_test_profile:true,real_user_profile:false,temporary_extension_reinstalled_after_browser_restart:true,write_count:writes,rows,passed:rows.length>=5&&rows.every(r=>r.passed)};
 await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
 await fixture?.close();await client?.close();await exec(runtime,['--stop-relay'],{env}).catch(()=>{});await rm(state,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));console.log(output);
}
