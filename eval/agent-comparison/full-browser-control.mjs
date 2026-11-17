// Real browser check in an owned disposable profile. Never adopts personal tabs.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {MCPClient} from './mcp-client.mjs';
import {ZenFixture} from './zen-fixture.mjs';

const kind=process.env.CALLISTO_TEST_BROWSER||'zen';
const server=createServer((_request,response)=>{
 response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
 response.end('<title>Full control fixture</title><h1>Full control fixture</h1><label>Name<input id="name"></label>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const state=await mkdtemp(join(tmpdir(),'callisto-full-control-'));
const environment={...process.env,CALLISTO_FIREFOX_STATE_DIR:state};
const binary=resolve('packages/firefox-rs/target/debug/callisto-firefox-tab-mcp');
const client=new MCPClient(binary,[],environment);
const fixture=new ZenFixture(client,{kind,allowSystemAccess:true});
try{
 await client.initialize();await fixture.start(url);
 await fixture.call('callisto_browser',{action:'fixture_full_access',enabled:true});
 assert.equal((await fixture.call('callisto_status')).fullAccess,true);
 assert.equal((await fixture.call('callisto_capabilities')).capabilities.fullBrowserControl,true);
 assert.equal((await fixture.call('callisto_snapshot')).url,url);
 const created=await fixture.call('callisto_browser',{action:'tab_create',url:url+'new'});
 assert.equal(created.shared,true);
 let snapshot=await fixture.call('callisto_snapshot');assert.equal(snapshot.url,url+'new');
 const name=/\[(ax-\d+)\] textbox "Name"/.exec(snapshot.text);assert.ok(name,snapshot.text);
 assert.equal((await fixture.call('callisto_fill',{ref:name[1],value:'Full control input'})).completed,true);
 await fixture.call('callisto_browser',{action:'tab_activate',tab_id:fixture.tabId});
 assert.equal((await fixture.call('callisto_status')).sharing,false);
 assert.equal((await fixture.call('callisto_snapshot')).url,url);
 await fixture.call('callisto_browser',{action:'fixture_hide_tab',tab_id:created.id});
 await fixture.call('callisto_browser',{action:'tab_select',tab_id:created.id});
 assert.equal((await fixture.call('callisto_snapshot')).url,url+'new');
 const blank=await fixture.call('callisto_browser',{action:'tab_create'});
 assert.equal(blank.shared,false);
 await fixture.call('callisto_browser',{action:'tab_navigate',tab_id:blank.id,url:url+'from-blank'});
 assert.equal((await fixture.call('callisto_snapshot')).url,url+'from-blank');
 await fixture.call('callisto_browser',{action:'tab_close',tab_id:blank.id});
 await fixture.call('callisto_browser',{action:'tab_select',tab_id:fixture.tabId});
 const window=await fixture.call('callisto_browser',{action:'window_create',url:url+'window'});
 assert.equal(window.shared,true);assert.equal((await fixture.call('callisto_snapshot')).url,url+'window');
 await fixture.call('callisto_browser',{action:'window_close',window_id:window.windowId});
 await fixture.call('callisto_browser',{action:'tab_select',tab_id:fixture.tabId});
 await fixture.call('callisto_browser',{action:'tab_close',tab_id:created.id});
 assert.ok((await fixture.call('callisto_browser',{action:'windows_list'})).windows.length);
 await fixture.call('callisto_browser',{action:'fixture_full_access',enabled:false});
 const status=await fixture.call('callisto_status');assert.equal(status.fullAccess,false);assert.equal(status.sharing,false);
 await assert.rejects(()=>fixture.call('callisto_snapshot'),/No tab shared/);
 const report={passed:true,browser:kind,browserVersion:fixture.capabilities.browserVersion,extension:'temporary fixture copy of source '+JSON.parse(await readFile('packages/firefox-rs/extension/manifest.json','utf8')).version,checks:['active-tab adoption','create and auto-share','input on a newly created tab','activation without sharing','hidden-tab activation','blank-tab navigation','window creation and sharing','window and tab cleanup','disable revokes automatic access']};
 if(process.env.FULL_CONTROL_OUTPUT)await writeFile(process.env.FULL_CONTROL_OUTPUT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{
 await fixture.close();await client.close();
 execFileSync(binary,['--stop-relay'],{env:environment,stdio:'ignore',timeout:5000});
 await rm(state,{recursive:true,force:true});
 await new Promise(resolve=>server.close(resolve));
}
