// A setup regression: background the intended test tab, then reacquire that exact tab.
import assert from 'node:assert/strict';
import {MCPClient} from './mcp-client.mjs';
import {ZenFixture,until} from './zen-fixture.mjs';
import {createFixtureServer} from './matched-fixture.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),directory=await mkdtemp(join(tmpdir(),'callisto-activation-')),environment={...process.env,CALLISTO_FIREFOX_STATE_DIR:directory},runtime=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
const server=createFixtureServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;let client,fixture;
try{
 client=await new MCPClient(runtime,[],environment).initialize();fixture=new ZenFixture(client,{kind:process.env.CALLISTO_TEST_BROWSER||'zen'});await fixture.start(origin+'/form');
 const intended=fixture.tabId;await fixture.call('callisto_browser',{action:'tab_create',url:origin+'/search'});
 await fixture.navigate(origin+'/form');
 const tabs=(await fixture.call('callisto_browser',{action:'tabs_list'})).tabs;assert(tabs.find(t=>t.id===intended)?.active,'The exact fixture tab must be active');
 const snapshot=await fixture.call('callisto_snapshot');assert.equal(snapshot.url,origin+'/form');
 await fixture.call('callisto_run',{steps:[{action:'fill_role',role:'textbox',name:'Fruit',value:'Mango'},{action:'click_role',role:'button',name:'Save'}]});
 await until(async()=>await fixture.script('return document.body.dataset.done')==='yes');
 await fixture.navigate(origin+'/frame');const frames=(await fixture.call('callisto_frames')).frames;
 await fixture.call('callisto_frame',{frame_id:frames.find(f=>f.parentFrameId===0).frameId});
 const inner=await fixture.call('callisto_snapshot');await fixture.call('callisto_click',{ref:inner.text.match(/\[(ax-\d+)\]/)[1]});
 await until(async()=>await fixture.script('return document.body.dataset.done')==='yes');
 console.log('Owned fixture activation, form input and trusted frame/shadow input passed.');
}finally{await fixture?.close();await client?.close();await exec(runtime,['--stop-relay'],{env:environment}).catch(()=>{});await rm(directory,{recursive:true,force:true});server.closeAllConnections();await new Promise(r=>server.close(r));}
