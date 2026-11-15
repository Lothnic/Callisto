const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture(executeScript = async () => {}, siteAccess = false, saved = {}, clock = Date) {
  let listener, menuListener, updateListener, domListener, commitListener, focusListener;
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
    webNavigation:{getAllFrames:async()=>[{frameId:0,parentFrameId:-1},{frameId:7,parentFrameId:0}],onDOMContentLoaded:{addListener(fn){domListener=fn;}},onCommitted:{addListener(fn){commitListener=fn;}}},
    windows:{onFocusChanged:{addListener(fn){focusListener=fn;}}},
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
  return {listener,menuListener,updateListener,domListener,commitListener,Socket,messages,browser,focusChanged:id=>focusListener?.(id)};
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
  assert.deepEqual(messages.at(-1).result,{connected:true,execution:{mode:'shared-tab',focusPolicy:'user-controlled',paused:false},sharing:true,active:true,ready:true,continuous:false,browserAccess:false,capabilities:{trustedInput:false,trustedBinding:true,frames:'same-origin',playwrightExecution:false,run:true,extract:true,snapshotPagination:true,runFormControls:true,selectorWait:true,targetedObservation:true,networkInspection:false,backgroundWindow:true}});
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

test('run batches form controls and waits in the document with an absolute deadline',async()=>{
  const {listener,Socket,messages,browser}=fixture(async()=>{},true);
  const pairing=listener({type:'pair',code});await new Promise(setImmediate);
  Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await pairing;
  await listener({type:'share'});
  const commands=[];
  browser.tabs.sendMessage=async(_id,message)=>{commands.push(message);return {value:{completed:true,matched:true}};};
  const steps=[
    {action:'select_role',role:'combobox',name:'Status',value:'complete'},
    {action:'check_ref',ref:'ax-2',checked:true},
    {action:'hover_role',role:'button',name:'Menu'},
    {action:'submit_role',role:'textbox',name:'Search'},
    {action:'wait_for',selector:'.row',state:'visible',timeout_ms:1000},
    {action:'wait_for',text:'long '.repeat(60).trim(),timeout_ms:1000},
  ];
  const before=Date.now();
  await Socket.last.receive({id:303,method:'run',value:JSON.stringify({steps})});
  assert.equal(messages.at(-1).error,undefined);
  assert.equal(messages.at(-1).result.completed,steps.length);
  assert.deepEqual(commands.map(m=>JSON.parse(m.value).action),['select','check','hover','submit','wait_for','wait_for']);
  assert(commands.every(m=>m.deadline>=before && m.deadline<=Date.now()+60000));
  assert.equal(new Set(commands.slice(0,4).map(m=>m.deadline)).size,1);
  assert(commands.slice(4).every(m=>m.deadline<=Date.now()+1000));
});

test('run rejects invalid waits before dispatching subsequent actions',async()=>{
  const {listener,Socket,messages,browser}=fixture(async()=>{},true);
  const pairing=listener({type:'pair',code});await new Promise(setImmediate);
  Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await pairing;
  await listener({type:'share'});
  let dispatched=0;browser.tabs.sendMessage=async()=>{dispatched++;return {value:{completed:true}};};
  for(const ms of [undefined,0,-1,1.5,6000,'20']){
    await Socket.last.receive({id:304,method:'run',value:JSON.stringify({steps:[{action:'wait',ms},{action:'click_ref',ref:'ax-1'}]})});
    assert.match(messages.at(-1).error,/Run stopped at step 1.*integer ms/);
  }
  assert.equal(dispatched,0);
});

test('read-only wait resumes across navigation without extending its deadline',async()=>{
  const {listener,Socket,messages,browser,updateListener,domListener}=fixture(async()=>{},true);
  const pairing=listener({type:'pair',code});await new Promise(setImmediate);
  Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await pairing;
  await listener({type:'share'});
  const waits=[];
  browser.tabs.sendMessage=async(_id,message)=>{
    if(message.type!=='action')return {value:true};
    waits.push(message);
    if(waits.length===1){
      updateListener(42,{status:'loading'});domListener({tabId:42,frameId:0});
      await new Promise(setImmediate);
      throw new Error('The document unloaded');
    }
    return {value:{matched:true}};
  };
  await Socket.last.receive({id:305,method:'run',value:JSON.stringify({steps:[{action:'wait_for',selector:'#result',timeout_ms:1000}]})});
  assert.equal(messages.at(-1).error,undefined);
  assert.equal(messages.at(-1).result.completed,1);
  assert.equal(waits.length,2);
  assert.equal(waits[0].deadline,waits[1].deadline);
});


test('release revokes all frames and frame navigation requires explicit reselection',async()=>{
 const {listener,Socket,messages,browser,commitListener}=fixture(async()=>{},true);
 const pairing=listener({type:'pair',code});await new Promise(setImmediate);Socket.last.open();await Socket.last.receive({type:'paired',protocol:2});await pairing;await listener({type:'share'});
 await Socket.last.receive({id:401,method:'frame',value:JSON.stringify({frame_id:7})});
 commitListener({tabId:42,frameId:7});
 await Socket.last.receive({id:402,method:'snapshot'});assert.match(messages.at(-1).error,/selected frame navigated/);
 await Socket.last.receive({id:403,method:'frame',value:JSON.stringify({frame_id:7})});assert.equal(messages.at(-1).error,undefined);
 const revoked=[];browser.tabs.sendMessage=async(id,message,options)=>{if(message.type==='revoke')revoked.push(options.frameId);return {value:true};};
 await listener({type:'stop'});assert.deepEqual(revoked.sort(),[0,7]);
});

function backgroundFixture(){
 const f=fixture(async()=>{},true);
 const tabs=new Map([[42,{id:42,windowId:1,index:0,active:true,pinned:false,cookieStoreId:'firefox-container-5',url:'https://example.test/form'}],[99,{id:99,windowId:1,index:1,active:false,pinned:false}]]);
 const windows=new Map([[1,{id:1,focused:true,state:'normal'}]]),changes=[];
 f.browser.permissions.contains=async request=>!request.permissions?.some(p=>['cookies','history','bookmarks','downloads'].includes(p));
 f.browser.tabs.get=async id=>{if(!tabs.has(id))throw Error('Tab gone');return {...tabs.get(id)};};
 f.browser.tabs.query=async q=>[...tabs.values()].filter(t=>(q?.windowId===undefined||t.windowId===q.windowId)&&(!q?.active||t.active)).map(t=>({...t}));
 f.browser.tabs.update=async(id,opts)=>{changes.push({type:'tab',id,...opts});const t=tabs.get(id);if(opts.active)for(const other of tabs.values())if(other.windowId===t.windowId)other.active=false;Object.assign(t,opts);return {...t};};
 f.browser.tabs.move=async(id,opts)=>{changes.push({type:'move',id,...opts});const t=tabs.get(id);t.windowId=opts.windowId;t.active=true;if(tabs.has(99))tabs.get(99).active=true;return {...t};};
 f.browser.tabs.create=async opts=>{changes.push({type:'create-tab',...opts});const t={id:100,windowId:opts.windowId,active:opts.active,pinned:false};tabs.set(100,t);return t;};
 f.browser.windows={
  get:async id=>({...windows.get(id)}),
  create:async opts=>{changes.push({type:'create-window',...opts});const t=tabs.get(opts.tabId);t.windowId=9;t.active=true;if(tabs.has(99))tabs.get(99).active=true;const win={id:9,focused:false,state:'normal'};windows.set(9,win);return {...win,tabs:[{...t}]};},
  update:async(id,opts)=>{changes.push({type:'window',id,...opts});if(opts.focused){for(const w of windows.values())w.focused=false;windows.get(id).focused=true;f.focusChanged(id);}return {...windows.get(id)};},
 };
 const sent=[];f.browser.tabs.sendMessage=async(id,m)=>{sent.push({id,...m});return m.type==='action'?{value:{tab:id}}:{value:true};};
 return {...f,tabs,windows,changes,sent};
}
async function pairFixture(f){const pairing=f.listener({type:'pair',code});await new Promise(setImmediate);const ws=f.Socket.last;ws.open();await ws.receive({type:'paired',protocol:2});await pairing;await f.listener({type:'share'});return ws;}

test('prepared background task preserves the exact tab without requiring cookie/history grants',async()=>{
 const f=backgroundFixture(),ws=await pairFixture(f);
 await f.listener({type:'background-share'});
 await ws.receive({id:40,session:101,method:'browser',value:JSON.stringify({action:'background',operation:'start'})});
 assert.equal(f.messages.at(-1).error,undefined);assert.equal(f.tabs.get(42).windowId,9);
 assert.equal(f.tabs.get(42).cookieStoreId,'firefox-container-5');
 assert.deepEqual(f.changes.filter(c=>c.type==='create-window').map(c=>({tabId:c.tabId,focused:c.focused})),[{tabId:42,focused:false}]);
 assert(!f.changes.some(c=>c.type==='window'&&c.focused));
 await ws.receive({id:41,session:101,method:'status'});assert.equal(f.messages.at(-1).result.execution.mode,'background-window');
 await ws.receive({id:42,session:101,method:'snapshot'});assert.equal(f.messages.at(-1).result.tab,42);
 await ws.receive({id:43,session:101,method:'browser',value:JSON.stringify({action:'tab_select',tab_id:99})});assert.match(f.messages.at(-1).error,/needs_attention/);
});

test('pause reserves the exact task tab, resume requires an unfocused window, and take back leaves it open',async()=>{
 const f=backgroundFixture(),ws=await pairFixture(f);
 await f.listener({type:'background-share'});
 await ws.receive({id:50,session:101,method:'browser',value:JSON.stringify({action:'background',operation:'start'})});
 await f.listener({type:'background-control',tab_id:42,action:'pause'});
 await ws.receive({id:51,session:101,method:'click',ref:'ax-1'});assert.match(f.messages.at(-1).error,/paused/);
 f.browser.permissions.contains=async()=>true;
 await ws.receive({id:52,session:202,method:'browser',value:JSON.stringify({action:'tab_select',tab_id:42})});assert.match(f.messages.at(-1).error,/owned by another/);
 f.windows.get(9).focused=true;
 await ws.receive({id:53,session:101,method:'browser',value:JSON.stringify({action:'background',operation:'resume'})});assert.match(f.messages.at(-1).error,/needs_attention/);
 f.windows.get(9).focused=false;
 await ws.receive({id:54,session:101,method:'browser',value:JSON.stringify({action:'background',operation:'resume'})});assert.equal(f.messages.at(-1).error,undefined);
 await f.listener({type:'background-control',tab_id:42,action:'take-back'});
 await ws.receive({id:55,session:101,method:'status'});assert.equal(f.messages.at(-1).result.sharing,false);assert(f.tabs.has(42));assert(f.windows.has(9));
});

test('stopping during background-window creation cannot regrant sharing',async()=>{
 const f=backgroundFixture(),ws=await pairFixture(f);const create=f.browser.windows.create;let release,entered;
 const entry=new Promise(r=>entered=r);f.browser.windows.create=async opts=>{entered();await new Promise(r=>release=r);return create(opts);};
 const work=f.listener({type:'background-share'});
 await entry;await f.listener({type:'stop'});release();const result=await work;
 assert.match(result.message,/changed|stopped/);
 const ui=await f.listener({type:'ui-status'});assert.equal(ui.shared_tabs,0);assert.equal(ui.background_tasks.length,0);
});

test('View pauses before focusing; foregrounding a running agent window pauses it',async()=>{
 const f=backgroundFixture(),ws=await pairFixture(f);
 await f.listener({type:'background-share'});
 await ws.receive({id:70,session:101,method:'browser',value:JSON.stringify({action:'background',operation:'start'})});
 await f.listener({type:'background-control',tab_id:42,action:'view'});
 assert.equal(f.windows.get(9).focused,true);
 await ws.receive({id:71,session:101,method:'status'});assert.equal(f.messages.at(-1).result.execution.paused,true);assert.equal(f.messages.at(-1).result.sharing,false);
 f.windows.get(9).focused=false;
 await ws.receive({id:72,session:101,method:'browser',value:JSON.stringify({action:'background',operation:'resume'})});
 f.windows.get(9).focused=true;await f.focusChanged(9);
 await ws.receive({id:73,session:101,method:'status'});assert.equal(f.messages.at(-1).result.execution.paused,true);
 const sends=f.sent.filter(m=>m.type==='action').length;
 await ws.receive({id:74,session:101,method:'click',ref:'ax-1'});assert.match(f.messages.at(-1).error,/paused/);assert.equal(f.sent.filter(m=>m.type==='action').length,sends);
});

test('background setup refuses pinned tabs and preserves the source window when moving its sole tab',async()=>{
 const f=backgroundFixture(),ws=await pairFixture(f);f.tabs.get(42).pinned=true;
 const rejected=await f.listener({type:'background-share'});assert.match(rejected.message,/Unpin/);assert.equal(f.changes.length,0);
 f.tabs.get(42).pinned=false;f.tabs.delete(99);
 await f.listener({type:'background-share'});
 await ws.receive({id:81,session:101,method:'browser',value:JSON.stringify({action:'background',operation:'start'})});assert.equal(f.messages.at(-1).error,undefined);
 assert(f.changes.some(c=>c.type==='create-tab'&&c.windowId===1&&c.active===false));
});

test('agent requests cannot create a window; explicit preparation starts only after focus returns',async()=>{
 const f=backgroundFixture(),ws=await pairFixture(f);
 await ws.receive({id:90,session:101,method:'browser',value:JSON.stringify({action:'background',operation:'start'})});assert.match(f.messages.at(-1).error,/Prepare background work/);assert.equal(f.changes.length,0);
 const create=f.browser.windows.create;f.browser.windows.create=async opts=>{const result=await create(opts);f.windows.get(1).focused=false;f.windows.get(9).focused=true;return {...result,focused:true};};
 const prepared=await f.listener({type:'background-share'});assert.equal(prepared.task.reason,'ready');assert.equal(prepared.task.paused,true);
 f.windows.get(9).focused=false;f.windows.get(1).focused=true;await f.focusChanged(1);await new Promise(setImmediate);
 await ws.receive({id:91,session:101,method:'status'});assert.equal(f.messages.at(-1).result.execution.paused,false);assert.equal(f.messages.at(-1).result.sharing,true);
});

test('Stop during initial revocation cancels a pending user preparation before it can share again',async()=>{
 const f=backgroundFixture();await pairFixture(f);const send=f.browser.tabs.sendMessage;let entered;const releases=[];
 const entry=new Promise(r=>entered=r);f.browser.tabs.sendMessage=async(id,message,...rest)=>{if(message.type==='revoke'){entered();await new Promise(r=>releases.push(r));}return send(id,message,...rest);};
 const work=f.listener({type:'background-share'});await entry;await f.listener({type:'stop'});for(const release of releases)release();const result=await work;
 assert.match(result.message,/stopped/);assert.equal(f.changes.length,0);assert.equal((await f.listener({type:'ui-status'})).shared_tabs,0);
});
