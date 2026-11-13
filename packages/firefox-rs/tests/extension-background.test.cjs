const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture(executeScript = async () => {}, siteAccess = false, saved = {}, clock = Date) {
  let listener, menuListener, updateListener, domListener;
  const messages = [];
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; Socket.last = this; }
    send(message) { messages.push(JSON.parse(message)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen(); }
    receive(data) { return this.onmessage({data:JSON.stringify(data)}); }
  }
  const browser = {
    storage:{local:{get:async () => ({...saved}),set:async values => {Object.assign(saved,values);},remove:async key => {delete saved[key];}}},
    webNavigation:{getAllFrames:async()=>[{frameId:0,parentFrameId:-1},{frameId:7,parentFrameId:0}],onDOMContentLoaded:{addListener(fn){domListener=fn;}}},
    runtime:{onMessage:{addListener(fn) { listener = fn; }}},
    menus:{create(){},onClicked:{addListener(fn){ menuListener = fn; }}},
    browserAction:{setBadgeText:async () => {}},
    permissions:{contains:async () => siteAccess,onRemoved:{addListener(){}}},
    tabs:{
      query:async () => [{id:42,active:true,windowId:1}],
      get:async id=>({id,active:true,windowId:1}),
      executeScript,
      update:async () => {},
      sendMessage:async (_id, m) => { if (m.type === 'action') return {value:{ok:true}}; return {value:true}; },
      onRemoved:{addListener(){}}, onUpdated:{addListener(fn){ updateListener = fn; }}
    }
  };
  const context = vm.createContext({browser,WebSocket:Socket,setTimeout,clearTimeout,URL,Date:clock});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/browser-control.js'),'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'), context);
  return {listener,menuListener,updateListener,domListener,Socket,messages,browser};
}
const code = `127.0.0.1:1234#${'a'.repeat(64)}`;

test('a runtime without the session protocol is rejected instead of silently sharing targets',async()=>{
  const saved={};const {listener,Socket}=fixture(async()=>{},false,saved);
  const pairing=listener({type:'pair',code});await new Promise(setImmediate);
  Socket.last.open();await Socket.last.receive({type:'paired',protocol:1});
  assert.match((await pairing).message,/protocol mismatch/);
  assert.equal(saved.callistoPairing,undefined);
});

test('agent sessions keep distinct tabs and cannot retarget or release each other',async()=>{
  const {listener,Socket,messages,browser}=fixture(async()=>{},true);
  browser.tabs.get=async id=>({id,active:true,windowId:id===42?1:2});
  browser.tabs.query=async options=>[{id:options?.windowId===2?43:42,active:true,windowId:options?.windowId||1}];
  browser.tabs.update=async id=>({id,active:true,windowId:id===42?1:2});
  browser.windows={update:async()=>{}};
  const targets=[];
  browser.tabs.sendMessage=async(id,message)=>{if(message.type==='action'){targets.push(id);return {value:{tab:id}};}return {value:true};};
  const pairing=listener({type:'pair',code});await new Promise(setImmediate);
  const ws=Socket.last;ws.open();await ws.receive({type:'paired',protocol:2});await pairing;
  await listener({type:'share'});
  await ws.receive({id:1,session:101,method:'snapshot'});
  assert.equal(messages.at(-1).result.tab,42);
  await ws.receive({id:2,session:202,method:'browser',value:JSON.stringify({action:'tab_select',tab_id:43})});
  assert(!messages.at(-1).error);
  await ws.receive({id:3,session:101,method:'snapshot'});
  assert.equal(messages.at(-1).result.tab,42);
  await ws.receive({id:4,session:202,method:'browser',value:JSON.stringify({action:'tab_select',tab_id:42})});
  assert.match(messages.at(-1).error,/owned by another agent/);
  await ws.receive({id:5,session:202,method:'release_session'});
  await ws.receive({id:6,session:101,method:'status'});
  assert.equal(messages.at(-1).result.sharing,true);
  await listener({type:'stop'});
  await ws.receive({id:7,session:101,method:'status'});
  assert.equal(messages.at(-1).result.sharing,false);
  assert.deepEqual(targets,[42,42]);
});

test('pairing requires server confirmation and stop prevents further sharing', async () => {
  const {listener,Socket,messages} = fixture();
  const connecting = listener({type:'pair',code});
  await new Promise(setImmediate);
  const ws = Socket.last;
  ws.open();
  assert.equal(messages[0].type,'pair');
  assert.match((await listener({type:'share'})).message,/Connect first/);
  await ws.receive({type:'paired',protocol:2});
  assert.match((await connecting).message,/Connected/);
  assert.match((await listener({type:'share'})).message,/shared/);
  await ws.receive({id:1,method:'status'});
  assert.deepEqual(messages.at(-1).result,{connected:true,sharing:true,active:true,ready:true,continuous:false,browserAccess:false,capabilities:{trustedInput:false,frames:'same-origin',playwrightExecution:false}});
  await listener({type:'stop'});
  assert.match((await listener({type:'status'})).message,/Connected/);
});

test('a rejected connection reports an error instead of claiming success', async () => {
  const {listener,Socket} = fixture();
  const connecting = listener({type:'pair',code});
  await new Promise(setImmediate);
  Socket.last.open();
  Socket.last.close();
  assert.match((await connecting).message,/rejected or connection closed/i);
});

test('stopping while injection is in progress does not leave a shared tab', async () => {
  let finishInjection;
  const {listener,Socket} = fixture(() => new Promise(resolve => { finishInjection = resolve; }));
  const connecting = listener({type:'pair',code});
  await new Promise(setImmediate);
  Socket.last.open();
  Socket.last.receive({type:'paired',protocol:2});
  await connecting;
  const sharing = listener({type:'share'});
  await new Promise(setImmediate);
  await listener({type:'stop'});
  finishInjection();
  assert.match((await sharing).message,/stopped while the tab was being prepared/i);
  assert.match((await listener({type:'status'})).message,/Connected/);
});

test('context menu shares the current page after pairing', async () => {
  const {listener,menuListener,Socket,messages} = fixture();
  const connecting = listener({type:'pair',code});
  await new Promise(setImmediate);
  Socket.last.open();
  Socket.last.receive({type:'paired',protocol:2});
  await connecting;
  await menuListener({menuItemId:'callisto-share'}, {id:42});
  await Socket.last.receive({id:1,method:'status'});
  assert.equal(messages.at(-1).result.sharing, true);
});

test('navigation is denied without optional permission', async () => {
  const {listener,Socket,messages} = fixture();
  const connecting = listener({type:'pair',code});
  await new Promise(setImmediate);
  Socket.last.open(); Socket.last.receive({type:'paired',protocol:2}); await connecting;
  await listener({type:'share'});
  await Socket.last.receive({id:4,method:'navigate',value:'https://example.com'});
  assert.match(messages.at(-1).error,/optional website permission/);
});

test('with optional permission, a shared tab reconnects after navigation', async () => {
  const {listener,updateListener,Socket,messages} = fixture(async () => {},true);
  const connecting = listener({type:'pair',code});
  await new Promise(setImmediate);
  Socket.last.open(); Socket.last.receive({type:'paired',protocol:2}); await connecting;
  await listener({type:'share'});
  await Socket.last.receive({id:4,method:'navigate',value:'https://example.com'});
  assert.equal(messages.at(-1).result.navigationStarted,true);
  updateListener(42,{status:'loading'});
  await Socket.last.receive({id:5,method:'status'});
  assert.equal(messages.at(-1).result.ready,false);
  updateListener(42,{status:'complete'});
  await new Promise(setImmediate);
  await Socket.last.receive({id:6,method:'status'});
  assert.equal(messages.at(-1).result.ready,true);
});

 test('browser-wide tools refuse access before permission is granted', async () => {
  const {listener,Socket,messages} = fixture();
  const connecting = listener({type:'pair',code});
  await new Promise(setImmediate);
  Socket.last.open(); Socket.last.receive({type:'paired',protocol:2}); await connecting;
  await Socket.last.receive({id:4,method:'browser',value:JSON.stringify({action:'tabs_list'})});
  assert.match(messages.at(-1).error,/Enable browser access/);
 });
 test('browser-wide tab discovery works with permission and no shared page', async () => {
  const {listener,Socket,messages} = fixture(async () => {},true);
  const connecting = listener({type:'pair',code});
  await new Promise(setImmediate);
  Socket.last.open(); Socket.last.receive({type:'paired',protocol:2}); await connecting;
  await Socket.last.receive({id:4,method:'browser',value:JSON.stringify({action:'tabs_list'})});
  assert.equal(messages.at(-1).result.tabs[0].id,42);
 });

test('saved browser pairing reconnects after extension startup without another code', async () => {
 const saved={callistoPairing:code};
 const {Socket,listener,messages}=fixture(async () => {},false,saved);
 await new Promise(setImmediate);
 assert(Socket.last);
 Socket.last.open(); await Socket.last.receive({type:'paired',protocol:2});
 assert.equal(messages[0].token,'a'.repeat(64));
 assert.match((await listener({type:'status'})).message,/Connected/);
 await listener({type:'forget'});
 assert.equal(saved.callistoPairing,undefined);
 assert.match((await listener({type:'status'})).message,/Not connected/);
});

test('successful click navigation is not mistaken for revoked sharing', async () => {
 const {listener,Socket,messages,updateListener,browser} = fixture(async () => {},true);
 const connecting=listener({type:'pair',code});await new Promise(setImmediate);
 Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await connecting;
 await listener({type:'share'});
 browser.tabs.sendMessage=async (_id,m)=>{
  if(m.type==='action' && m.method==='click') { updateListener(42,{status:'loading'});return {value:{completed:true}}; }
  return {value:true};
 };
 await Socket.last.receive({id:80,method:'click',ref:'ax-1'});
 assert.equal(messages.at(-1).error,undefined);
 assert.equal(messages.at(-1).result.navigationStarted,true);
});

test('user revocation is still rejected when an action acknowledges completion',async()=>{
 const {listener,Socket,messages,browser}=fixture(async()=>{},true);
 const connecting=listener({type:'pair',code});await new Promise(setImmediate);
 Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await connecting;await listener({type:'share'});
 browser.tabs.sendMessage=async(_id,m)=>{if(m.type==='action'){await listener({type:'stop'});return {value:{completed:true}};}return {value:true}};
 await Socket.last.receive({id:90,method:'click',ref:'ax-1'});
 assert.match(messages.at(-1).error,/sharing changed during the action/i);
});
test('page becomes ready at DOMContentLoaded without waiting for resource completion',async()=>{
 const {listener,Socket,messages,updateListener,domListener}=fixture(async()=>{},true);
 const connecting=listener({type:'pair',code});await new Promise(setImmediate);
 Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await connecting;await listener({type:'share'});
 updateListener(42,{status:'loading'});domListener({tabId:42,frameId:0});await new Promise(setImmediate);
 await Socket.last.receive({id:91,method:'status'});assert.equal(messages.at(-1).result.ready,true);
});
test('batch returns one final snapshot and refuses to continue after revocation',async()=>{
 const {listener,Socket,messages,browser}=fixture(async()=>{},true);
 const connecting=listener({type:'pair',code});await new Promise(setImmediate);
 Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await connecting;await listener({type:'share'});
 await Socket.last.receive({id:92,method:'batch',value:JSON.stringify([{action:'fill_role',role:'textbox',name:'Search',value:'demo'},{action:'submit_role',role:'textbox',name:'Search'}])});
 assert.equal(messages.at(-1).result.completed,2);assert(messages.at(-1).result.snapshot);
 let actions=0;browser.tabs.sendMessage=async(_id,m)=>{if(m.type==='action'){actions++;await listener({type:'stop'});return {value:{completed:true}}}return {value:true}};
 await Socket.last.receive({id:93,method:'batch',value:JSON.stringify([{action:'click_ref',ref:'ax-1'},{action:'click_ref',ref:'ax-2'}])});
 assert.match(messages.at(-1).error,/Batch stopped at step 1/);assert.equal(actions,1);
});

test('control stays within the selected window when another window is focused',async()=>{
 const {listener,Socket,messages,browser}=fixture(async()=>{},true);
 const connecting=listener({type:'pair',code});await new Promise(setImmediate);Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await connecting;await listener({type:'share'});
 browser.tabs.query=async options=>options.windowId===1?[{id:42,active:true,windowId:1}]:[{id:99,active:true,windowId:2}];
 await Socket.last.receive({id:94,method:'click',ref:'ax-1'});assert.equal(messages.at(-1).error,undefined);
});
test('initial about:blank navigation is retried before sharing',async()=>{
 let attempts=0;const {listener,Socket,browser}=fixture(async()=>{if(++attempts===1)throw new Error('Missing host permission for the tab')},true);
 const connecting=listener({type:'pair',code});await new Promise(setImmediate);Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await connecting;
 browser.tabs.get=async id=>({id,active:true,windowId:1,url:'about:blank',status:'loading'});
 assert.match((await listener({type:'share'})).message,/tab is shared/);assert.equal(attempts,2);
});


test('nested extraction respects the enclosing absolute deadline', async()=>{
  let now=0, page=0, clicks=0;
  const {listener,Socket,messages,browser}=fixture(async()=>{},true,{}, {now:()=>now});
  const pairing=listener({type:'pair',code});await new Promise(setImmediate);
  Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await pairing;
  await listener({type:'share'});
  browser.tabs.sendMessage=async(_id,message)=>{
    if(message.type!=='action')return {value:true};
    const args=JSON.parse(message.value);
    if(args.action==='extract'){now+=100;return {value:{rows:[{page}],has_next:true,omitted:false}};}
    if(args.action==='click_next'){clicks++;page++;now+=2500;return {value:{clicked:true}};}
    return {value:{}};
  };
  await Socket.last.receive({id:200,method:'run',value:JSON.stringify({steps:[{action:'extract',spec:{selector:'.row',fields:{page:{}},paginate:{next:'#next',max_pages:25}}}]})});
  assert.match(messages.at(-1).error,/deadline|budget|within 5 seconds/i);
  assert(clicks<24, 'no new pager clicks after the enclosing deadline');
});


test('revocation during window lookup prevents window closure',async()=>{
  const {listener,Socket,browser,messages}=fixture(async()=>{},true);
  const pairing=listener({type:'pair',code});await new Promise(setImmediate);
  Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await pairing;
  await listener({type:'share'});
  let release; let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  browser.tabs.query=async options=>{if(options?.windowId===9){entered();await new Promise(resolve=>{release=resolve;});return [];}return [{id:42,active:true,windowId:1}];};
  let removed=false;browser.windows={remove:async()=>{removed=true;}};
  const pending=Socket.last.receive({id:300,method:'browser',value:JSON.stringify({action:'window_close',window_id:9})});
  await started;await listener({type:'stop'});release();await pending;
  assert.equal(removed,false);assert.match(messages.at(-1).error,/ownership changed/i);
});

test('failed tab sharing releases its reservation',async()=>{
  const {listener,Socket,browser,messages}=fixture(async id=>{if(id===43)throw new Error('Missing host permission');},true);
  browser.tabs.get=async id=>({id,active:true,windowId:1,url:'https://example.test'});
  browser.tabs.update=async id=>({id,active:true,windowId:1});
  browser.windows={update:async()=>{}};
  const pairing=listener({type:'pair',code});await new Promise(setImmediate);
  Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await pairing;
  await Socket.last.receive({id:301,session:101,method:'browser',value:JSON.stringify({action:'tab_select',tab_id:43})});
  assert.match(messages.at(-1).error,/Missing host permission/);
  let closed=false;browser.tabs.remove=async()=>{closed=true;};
  await Socket.last.receive({id:302,session:202,method:'browser',value:JSON.stringify({action:'tab_close',tab_id:43})});
  assert.equal(closed,true);
});
