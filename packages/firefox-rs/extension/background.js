'use strict';
let socket = null;
let paired = false;
let rememberedCode = null;
let reconnectTimer = null;
let retryDelay = 1000;
let pairAttempt = 0;
let storageWrites = Promise.resolve();
let nextLease = 0;
let referenceWrites=Promise.resolve(),referenceHighWater=0;
async function refScope(){
  const allocated=referenceWrites.then(async()=>{
    const saved=await browser.storage.local.get('callistoRefScope');
    const next=Math.max(saved.callistoRefScope ?? 0,referenceHighWater)+1;
    if(!Number.isSafeInteger(next)||next>9007199253)throw new Error('Reference namespace exhausted.');
    await browser.storage.local.set({callistoRefScope:next});referenceHighWater=next;return next;
  });referenceWrites=allocated.catch(()=>{});return allocated;
}
let sharingIntent = 0;
let fullBrowserAccess = false;
const networkInspector = typeof createNetworkInspector === 'function' ? createNetworkInspector(browser) : null;
function savePairing(code) {
  const write = storageWrites.then(() => code === null ? browser.storage.local.remove('callistoPairing') : browser.storage.local.set({callistoPairing:code}));
  storageWrites = write.catch(() => {}); return write;
}
function reconnectLater() {
  if (!rememberedCode || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!rememberedCode || paired) return;
    void pair(rememberedCode).catch(() => reconnectLater());
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}

async function pair(code) {
  const attempt = ++pairAttempt;
  const match = /^127\.0\.0\.1:(\d{1,5})#([0-9a-f]{64})$/.exec(code);
  if (!match || +match[1] < 1 || +match[1] > 65535) throw new Error('Invalid pairing code.');
  await stop(true);
  paired = false;
  if (socket) socket.close();
  const ws = new WebSocket(`ws://127.0.0.1:${match[1]}`);
  socket = ws;
  let resolvePair, rejectPair;
  const confirmation = new Promise((resolve, reject) => { resolvePair = resolve; rejectPair = reject; });
  const timer = setTimeout(() => { rejectPair(new Error('Pairing timed out. Check that the MCP process is running.')); ws.close(); }, 6000);
  ws.onopen = () => ws.send(JSON.stringify({type:'pair',protocol:2,token:match[2]}));
  ws.onclose = () => { rejectPair(new Error('Pairing rejected or connection closed. Check the code and try again.')); if (socket === ws) { paired = false; socket = null; void stop(true); reconnectLater(); } };
  ws.onerror = () => { rejectPair(new Error('Cannot connect to the local Callisto process.')); if (socket === ws) { paired = false; void stop(true); } };
  ws.onmessage = async event => {
    let request;
    try { request = JSON.parse(event.data); } catch { return; }
    if(request?.type==='pairing_error'){rejectPair(new Error(String(request.message||'Pairing failed.')));ws.close();return;}
    if (request?.type === 'paired' && socket === ws) {
      if(request.protocol!==2){rejectPair(new Error('Callisto protocol mismatch. Update both the extension and runtime.'));ws.close();return;}
      try {
        await savePairing(code);
        if (attempt !== pairAttempt || socket !== ws) { rejectPair(new Error('Pairing was cancelled.')); return; }
        rememberedCode = code; retryDelay = 1000; paired = true; resolvePair();
      } catch (error) { rejectPair(error); ws.close(); }
      return;
    }
    if (!request || !Number.isSafeInteger(request.id)) return;
    try { const result = await executeCommand(request,ws); if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({id:request.id,result})); }
    catch(error) { if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({id:request.id,error:String(error.message||error)})); }

  };
  try { await confirmation; } finally { clearTimeout(timer); }
}
browser.runtime.onMessage.addListener(async message => {
  try {
    if (message.type === 'status') return {message:status()};
    if (message.type === 'ui-status') {
      const shared=[...new Set(sessions.values())].filter(session=>session.sharing);
      const [navigation,full,network,settings,background]=await Promise.all([
        browser.permissions.contains({origins:['<all_urls>']}),browser.permissions.contains(fullBrowserPermissions),
        browser.permissions.contains({origins:['<all_urls>'],permissions:['webRequest','webRequestBlocking']}),browser.storage.local.get('callistoAgentContainersEnabled'),browser.permissions.contains({permissions:['tabs']})]);
      return {connected:paired && socket?.readyState===WebSocket.OPEN,paired:!!rememberedCode,reconnecting:!!rememberedCode && !paired,shared_tabs:shared.length,full_access:fullBrowserAccess,
        background_tasks:[...new Set(sessions.values())].map(s=>s.background).filter(Boolean),
        permissions:{navigation,browser:full,network,background,containers:settings.callistoAgentContainersEnabled===true}};
    }
    if (message.type === 'pair') { await pair(message.code); return {message:'Connected. Open the desired tab and click Share this tab.'}; }
    if (message.type === 'full-access') return await setFullBrowserAccess(message.enabled===true);
    if (message.type === 'share') return {message:await share()};
    if(message.type==='background-share'){
      if(!(await browser.permissions.contains({permissions:['tabs']})))throw new Error('Allow background tab management first.');
      const work=share(),intent=sharingIntent;await work;if(intent!==sharingIntent)throw new Error('Sharing stopped during background setup.');const result=await sessions.get(0).startBackground(undefined,{allowWindowSetup:true});
      return {message:result.paused?'Agent window prepared. Return to your other window to start.':'Working in the background. Keep the agent window unminimized.',task:result};
    }
    if(message.type==='background-control'){
      const task=[...new Set(sessions.values())].find(s=>s.background?.tab_id===message.tab_id);
      if(!task)throw new Error('That background task is no longer available.');
      if(message.action==='pause'){await task.pauseBackground('paused');return {message:'Task paused. Its tab remains reserved.'};}
      if(message.action==='resume'){await task.resumeBackground();return {message:'Task resumed in the background.'};}
      if(message.action==='view'){await task.viewBackground();return {message:'Task paused for viewing. Resume from your other window.'};}
      if(message.action==='take-back'){await task.stop();return {message:'Automation stopped. Your tab and window remain open.'};}
      throw new Error('Unsupported background control.');
    }
    if (message.type === 'stop') { await stop(); return {message:'Sharing stopped. Browser pairing is still connected.'}; }
    if (message.type === 'enable-containers') {
      if(!(await browser.permissions.contains({permissions:['cookies']})))throw new Error('Cookie permission is needed for agent containers.');
      await browser.storage.local.set({callistoAgentContainersEnabled:true});
      return {message:'Agent containers enabled for new tabs and windows. Existing tabs keep their logins.'};
    }
    if (message.type === 'forget') {
      pairAttempt++; rememberedCode = null;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      await savePairing(null);
      await stop(); paired = false; if (socket) socket.close(); socket = null;
      return {message:'Pairing forgotten. Connect again to authorize this browser.'};
    }
    return {message:'Unknown request.'};
  } catch (error) { return {message:`Error: ${error.message}`}; }
});
browser.windows?.onFocusChanged?.addListener(id=>{for(const session of new Set(sessions.values()))void session.focusChanged(id).catch(()=>{});});
browser.tabs.onRemoved.addListener(id=>{void forgetNamedTab(id).catch(()=>{});for(const session of sessions.values())session.removed(id);});
browser.tabs.onUpdated.addListener((id,change)=>{for(const session of sessions.values())session.updated(id,change);});
browser.permissions.onRemoved.addListener(permissions=>{if(fullBrowserAccess&&(permissions.origins?.includes('<all_urls>')||permissions.permissions?.some(p=>fullControlPermissions.permissions.includes(p))))void stop();if(permissions.permissions?.some(p=>['webRequest','webRequestBlocking'].includes(p)) || permissions.origins?.includes('<all_urls>'))networkInspector?.revoke();for(const session of sessions.values())session.permissionsRemoved(permissions);});
browser.menus.create({id:'callisto-share', title:'Share this tab with Callisto', contexts:['page']});
browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'callisto-share' || !tab?.id) return;
  try {
    const [active] = await browser.tabs.query({active:true,currentWindow:true});
    if (active?.id !== tab.id) throw new Error('The selected tab is not active.');
    await share();
  } catch (error) {
    await browser.browserAction.setBadgeText({text:'!'});
    console.error('Callisto could not share the tab:', error);
  }
});

// Restore only the connection; never restore access to a previously shared tab.
browser.storage.local.get('callistoPairing').then(saved => {
  if (typeof saved.callistoPairing === 'string' && !socket && !rememberedCode) {
    rememberedCode = saved.callistoPairing;
    void pair(rememberedCode).catch(() => reconnectLater());
  }
}).catch(error => console.error('Callisto could not restore pairing:',error));

const sessions = new Map();
function newManual(){const session=createSession();sessions.set(0,session);return session;}
newManual();
async function setFullBrowserAccess(enabled){
  if(!enabled){await stop();return {message:'Full browser control stopped. Tab access released.'};}
  const intent=++sharingIntent,connection=socket;
  if(!paired || connection?.readyState!==WebSocket.OPEN)throw new Error('Connect the runtime first.');
  if(!(await browser.permissions.contains(fullControlPermissions)))throw new Error('Allow browser access and hidden-tab management before enabling full browser control.');
  if(intent!==sharingIntent || socket!==connection || !paired)throw new Error('Full browser control was cancelled.');
  await stop(false,false);
  if(intent!==sharingIntent || socket!==connection || !paired)throw new Error('Full browser control was cancelled.');
  fullBrowserAccess=true;
  await browser.browserAction.setBadgeText({text:'ALL'}).catch(()=>{});
  if(intent!==sharingIntent || !fullBrowserAccess || socket!==connection || !paired)throw new Error('Full browser control was cancelled.');
  return {message:'Full browser control enabled. Agents can select, create and control website tabs. Stop turns this mode off.'};
}
function status(){
  if(!paired)return 'Not connected.';
  if(fullBrowserAccess)return 'Full browser control enabled. Agents can select and control website tabs. Stop sharing turns this mode off.';
  const count=[...sessions.values()].filter(session=>session.target!==null).length;
  return count ? `Connected. ${count} tab(s) shared across agent sessions. Stop sharing releases all of them.` : sessions.get(0).status();
}
async function stop(reset=false,invalidate=true){
  if(invalidate)sharingIntent++;
  fullBrowserAccess=false;
  const work=Promise.all([...sessions.values()].map(session=>session.stop()));
  if(reset){sessions.clear();newManual();}
  await work;
}
async function share(id){const intent=++sharingIntent;await stop(false,false);if(intent!==sharingIntent)throw new Error('Sharing stopped before setup.');return sessions.get(0).share(id);}
browser.webNavigation.onDOMContentLoaded.addListener(event=>{if(event.frameId===0)for(const session of sessions.values())session.domReady(event.tabId);});
browser.webNavigation.onCommitted?.addListener(event=>{if(event.frameId!==0)for(const session of sessions.values())session.frameNavigated(event.tabId,event.frameId);});
async function executeCommand(request,connection){
  if(socket!==connection || !paired)throw new Error('Browser connection was revoked.');
  const id=Number.isSafeInteger(request.session)&&request.session>=0?request.session:0;
  let session=sessions.get(id);
  if(request.method==='release_session'){
    if(session)await session.stop();
    if(id!==0)sessions.delete(id);
    return {released:true};
  }
  const manual=sessions.get(0);
  if(id!==0&&request.method==='status'&&(!session||session.target===null)&&manual.target!==null)return manual.executeCommand(request,connection);
  if(id!==0 && request.method!=='status' && (!session || session.target===null) && manual.target!==null){
    if(session)await session.stop();
    session=manual;sessions.set(id,session);newManual();
  }
  if(!session){
    if(request.method==='status')return manual.executeCommand(request,connection);
    if(sessions.size>=64)throw new Error('Too many connected sessions; close unused MCP clients.');
    session=createSession();sessions.set(id,session);
  }
  const budget = request.method === 'run' ? 60000 : request.method==='demonstrate' ? 125000 : request.method === 'extract' ? 35000 : request.method === 'page' && JSON.parse(request.value ?? '{}').action==='wait_for' ? Math.min(20000,JSON.parse(request.value).timeout_ms ?? 5000) : 10000;
  const deadline=Date.now()+budget;
  if(fullBrowserAccess && !session.background && !['status','browser','release','input_validate'].includes(request.method))await session.prepareFullAccess(connection);
  return session.executeCommand(request,connection,deadline);
}
function createSession(){
let selected = null;
let generation = 0;
let ownership = 0;
let ready = false;
let continuous = false;
let selectedFrame = 0;
let frameStale = false;
let leaseKey=String(++nextLease);
let reserved=null;
let backgroundTask=null;
  const context={get selected(){return selected;},share,assertAvailable,guard(expected){if(expected!==ownership)throw new Error('Tab ownership changed before the browser operation.');}};
  function assertAvailable(tabId){
    for(const other of sessions.values())if(other!==context && other.target===tabId)throw new Error('Tab is owned by another agent session. Release it before taking control.');
  }
async function claimTab(tabId,owner){
  context.guard(owner);
  for(const other of new Set(sessions.values()))if(other!==context&&other.target===tabId){
    if(!fullBrowserAccess){assertAvailable(tabId);return;}
    await other.stop();context.guard(owner);
  }
  assertAvailable(tabId);
}
async function prepareFullAccess(connection){
  const owner=ownership;
  if(!(await browser.permissions.contains(fullControlPermissions)))throw new Error('Full browser permissions were removed.');
  context.guard(owner);
  if(!fullBrowserAccess||socket!==connection||!paired)throw new Error('Full browser control stopped.');
  if(selected===null){
    const [tab]=await browser.tabs.query({active:true,currentWindow:true});context.guard(owner);
    if(!tab)throw new Error('No active tab. Use callisto_browser tab_select or tab_create.');
    await claimTab(tab.id,owner);
    await activateBrowserTab(tab.id,context,owner);
    await share(tab.id,owner);
  }else await activateBrowserTab(selected,context,owner);
}
function status() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !paired) return 'Not connected.';
  return selected === null ? 'Connected. Select a tab and click Share this tab.' : ready ? 'Connected. The selected tab is shared.' : 'Connected. Waiting for the shared page to load.';
}
async function stop(keepBackground=false) {
  const previous = selected;
  if(!keepBackground)backgroundTask=null;
  const revoked=leaseKey;leaseKey=String(++nextLease);
  if(socket?.readyState===WebSocket.OPEN && previous!==null)socket.send(JSON.stringify({type:'lease_revoked',lease_id:revoked}));
  selected = null; reserved = null; selectedFrame = 0; frameStale = false; ready = false; continuous = false; generation++; ownership++;
  networkInspector?.release(context);
  await browser.browserAction.setBadgeText({text:fullBrowserAccess?'ALL':[...sessions.values()].some(s=>s.target!==null)?'ON':''}).catch(() => {});
  if (previous !== null) {
    const frames=await browser.webNavigation.getAllFrames({tabId:previous}).catch(()=>[{frameId:0}]);
    await Promise.all((frames || [{frameId:0}]).map(frame=>browser.tabs.sendMessage(previous,{type:'revoke'},{frameId:frame.frameId}).catch(()=>{})));
  }
}
async function share(tabId,expectedOwner,{keepBackground=false}={}) {
  if(expectedOwner!==undefined)context.guard(expectedOwner);
  if (!socket || socket.readyState !== WebSocket.OPEN || !paired) throw new Error('Connect first.');
  const tab = tabId === undefined ? (await browser.tabs.query({active:true,currentWindow:true}))[0] : await browser.tabs.get(tabId);
  if (!tab || !tab.active || tab.id === undefined) throw new Error('No active browser tab.');
  if(expectedOwner!==undefined)context.guard(expectedOwner);
  assertAvailable(tab.id);
  const beforeStop=ownership;
  await stop(keepBackground);
  if(ownership!==beforeStop+1)throw new Error('Sharing stopped before the tab was prepared.');
  assertAvailable(tab.id);
  reserved = tab.id;
  const stamp = generation, connection = socket;
  try {
  const hasSiteAccess = await browser.permissions.contains({origins:['<all_urls>']});
  const deadline=Date.now()+8000;
  while(true) {
    if(stamp!==generation || socket!==connection || !paired)throw new Error('Sharing was stopped while the tab was being prepared.');
    try {
      await browser.tabs.executeScript(tab.id,{file:'/content.js',runAt:'document_end'});
      await browser.tabs.sendMessage(tab.id,{type:'ping',ref_scope:await refScope()});break;
    } catch(error) {
      const pending=await browser.tabs.get(tab.id);
      if(Date.now()>=deadline || !(pending.status==='loading' || pending.pendingUrl || pending.url==='about:blank'))throw error;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  if (stamp !== generation || socket !== connection || !paired) {
    await browser.tabs.sendMessage(tab.id, {type:'revoke'}).catch(() => {});
    throw new Error('Sharing was stopped while the tab was being prepared.');
  }
  selected = tab.id; reserved = null;
  ready = true;
  continuous = hasSiteAccess;
  await browser.browserAction.setBadgeText({text:fullBrowserAccess?'ALL':'ON'}).catch(() => {});
  return 'Connected. This tab is shared; click Stop sharing to revoke access.';
  } catch (error) {
    if (stamp === generation && reserved === tab.id) {
      reserved = null;
      await browser.tabs.sendMessage(tab.id, {type:'revoke'}).catch(() => {});
    }
    throw error;
  }
}


function taskStatus(){return backgroundTask?{mode:'background-window',focusPolicy:'never',tab_id:backgroundTask.tabId,window_id:backgroundTask.windowId,paused:backgroundTask.paused,reason:backgroundTask.reason}:null;}
function taskGuard(task,epoch){if(backgroundTask!==task||ownership!==epoch)throw new Error('Background task changed or stopped during setup.');}
async function startBackground(expectedOwner=ownership,{allowWindowSetup=false}={}){
  context.guard(expectedOwner);
  if(backgroundTask)return taskStatus();
  if(!allowWindowSetup)throw new Error('needs_attention: Prepare background work in the extension first. Firefox/Zen window creation can take focus and requires an explicit user action.');
  if(selected===null)throw new Error('Share the intended tab before starting background work.');
  if(!(await browser.permissions.contains({permissions:['tabs']})))throw new Error('Background work needs the optional tabs permission.');
  context.guard(expectedOwner);
  const tab=await browser.tabs.get(selected);context.guard(expectedOwner);
  if(tab.pinned)throw new Error('Unpin this tab before moving it to an agent window.');
  const task={tabId:tab.id,windowId:null,paused:true,reason:'starting',startOnReturn:false};backgroundTask=task;
  await stop(true);const epoch=ownership;
  try{
    taskGuard(task,epoch);
    const siblings=await browser.tabs.query({windowId:tab.windowId});taskGuard(task,epoch);
    // Keep the person's window alive even when its only tab is moved.
    if(siblings.length===1){await browser.tabs.create({windowId:tab.windowId,url:'about:blank',active:false});taskGuard(task,epoch);}
    // Firefox ignores focused:false on creation. This path is user-initiated;
    // agents can only operate an already prepared task, never create it silently.
    const window=await browser.windows.create({tabId:tab.id,focused:false,incognito:!!tab.incognito,titlePreface:'[Callisto] '});
    taskGuard(task,epoch);task.windowId=window.id;
    const moved=await browser.tabs.get(tab.id);taskGuard(task,epoch);
    if(moved.windowId!==window.id||moved.cookieStoreId!==tab.cookieStoreId)throw new Error('Moved tab identity or cookie session changed. Inspect the page before continuing.');
    task.reason='ready';task.startOnReturn=true;
    const current=await browser.windows.get(window.id);taskGuard(task,epoch);
    if(!current.focused&&current.state!=='minimized')return await resumeBackground(epoch);
    return taskStatus();
  }catch(error){if(backgroundTask===task)await stop();throw error;}
}
async function pauseBackground(reason='paused'){
  if(!backgroundTask)throw new Error('No background task.');
  backgroundTask.paused=true;backgroundTask.reason=reason;backgroundTask.startOnReturn=false;await stop(true);
  return taskStatus();
}
async function resumeBackground(expectedOwner=ownership){
  context.guard(expectedOwner);const task=backgroundTask;
  if(!task)throw new Error('No background task.');
  if(!task.paused)return taskStatus();
  const tab=await browser.tabs.get(task.tabId);taskGuard(task,expectedOwner);
  if(tab.windowId!==task.windowId)throw new Error('needs_attention: The agent tab moved to another window. Take it back before sharing again.');
  const window=await browser.windows.get(task.windowId);taskGuard(task,expectedOwner);
  if(window.focused||window.state==='minimized')throw new Error('needs_attention: Keep the agent window unminimized and switch to your other window before resuming.');
  await browser.tabs.update(task.tabId,{active:true});taskGuard(task,expectedOwner);
  await share(task.tabId,expectedOwner,{keepBackground:true});const epoch=ownership;taskGuard(task,epoch);
  const checked=await browser.windows.get(task.windowId);taskGuard(task,epoch);
  if(checked.focused||checked.state==='minimized'){await stop(true);throw new Error('needs_attention: The agent window cannot run in its current state.');}
  task.paused=false;task.reason=null;task.startOnReturn=false;return taskStatus();
}
async function viewBackground(){
  if(!backgroundTask)throw new Error('No background task.');
  const task=backgroundTask;await pauseBackground('viewing');const epoch=ownership;taskGuard(task,epoch);
  await browser.tabs.update(task.tabId,{active:true});taskGuard(task,epoch);
  await browser.windows.update(task.windowId,{focused:true});
}
async function checkBackground(owner){
  if(!backgroundTask)return;
  if(backgroundTask.paused)throw new Error('background_paused: Resume the task explicitly from your other window.');
  const task=backgroundTask,tab=await browser.tabs.get(task.tabId);context.guard(owner);
  const window=await browser.windows.get(task.windowId);context.guard(owner);
  if(tab.windowId!==task.windowId||!tab.active||window.focused||window.state==='minimized'){
    await pauseBackground('needs_attention');throw new Error('needs_attention: Background task paused because its window or active tab changed.');
  }
}

async function waitReady(tabId, owner, connection, commandDeadline=Date.now()+8000) {
  const deadline = Math.min(Date.now()+8000,commandDeadline);
  while (!ready) {
    if (selected !== tabId || owner !== ownership || socket !== connection || !paired) throw new Error('Tab sharing was revoked while waiting for the page.');
    if (Date.now() >= deadline) throw new Error('The shared page did not become ready within 8 seconds; inspect before retrying.');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  if (selected !== tabId || owner !== ownership || socket !== connection) throw new Error('The shared tab changed.');
}
let restoring = null;
async function restorePage(id) {
  if (selected !== id || !continuous || ready || restoring === generation) return;
  const stamp = generation, connection = socket;
  restoring = stamp;
  try {
    if (!(await browser.permissions.contains({origins:['<all_urls>']}))) throw new Error('Website permission was removed.');
    await browser.tabs.executeScript(id,{file:'/content.js',runAt:'document_end'});
    await browser.tabs.sendMessage(id,{type:'ping',ref_scope:await refScope()});
    if (stamp !== generation || selected !== id || socket !== connection || !paired) return;
    ready = true;
  } catch (error) { if (stamp === generation && selected === id) await stop(); }
  finally { if (restoring === stamp) restoring = null; }
}


async function executeCommand(request, connection, deadline = Date.now()+10000) {
  const chosen = selected, stamp = generation, owner = ownership;
  if (request.method === 'release') { await stop(); return {released:true}; }
  if (request.method === 'status') {
    const target = chosen === null ? null : await browser.tabs.get(chosen);
    const [active] = target ? await browser.tabs.query({active:true,windowId:target.windowId}) : [];
    return {connected:true,lease_id:leaseKey,fullAccess:fullBrowserAccess,execution:taskStatus()??{mode:fullBrowserAccess?'full-browser':'shared-tab',focusPolicy:fullBrowserAccess?'agent-controlled':'user-controlled',paused:false},sharing:chosen !== null,active:chosen !== null && active?.id === chosen,ready,continuous,browserAccess:await browser.permissions.contains(fullBrowserPermissions),capabilities:{trustedInput:false,trustedBinding:true,frames:'same-origin',playwrightExecution:false,run:true,extract:true,snapshotPagination:true,runFormControls:true,selectorWait:true,targetedObservation:true,networkInspection:!!networkInspector,backgroundWindow:true,fullBrowserControl:true,canonicalActions:true,focusedSnapshot:true,scopedDiff:true,shortRefs:true,drag:true,recording:true,demonstration:true,namedTabs:true}};
  }
  if (Date.now() >= deadline) throw new Error('Command deadline exceeded; inspect before retrying.');
  if (request.method === 'browser') {
    const args = JSON.parse(request.value);
    if (!browserActions.includes(args.action)) throw new Error('Unsupported browser action.');
    return browserControl(args, context, owner);
  }
  await checkBackground(owner);
  if (chosen === null) throw new Error('No tab shared. Open the desired tab and click Share this tab in the Callisto extension.');
  if (request.method === 'network') {
    if(!networkInspector)throw new Error('Network inspection is unavailable; reload the extension.');
    const args=JSON.parse(request.value);
    if(args.action==='start'){
      const result=await networkInspector.start(context,chosen,args);
      if(owner!==ownership || chosen!==selected || socket!==connection){networkInspector.release(context);throw new Error('Tab sharing changed while starting network capture.');}
      return result;
    }
    if(args.action==='list')return networkInspector.list(context,args);
    if(args.action==='endpoints')return networkInspector.endpoints(context);
    if(['compare','schema','openapi'].includes(args.action))return networkInspector.analyze(context,args);
    if(args.action==='replay'){
      const spec=networkInspector.replayScope(context,args);
      const result=await executeCommand({method:'page',value:JSON.stringify({action:'api_replay',...spec})},connection,deadline);
      return networkInspector.replayResult(context,result);
    }
    if(args.action==='rules')return networkInspector.rules(context,args.rules);
    if(args.action==='stop')return networkInspector.stop(context);
    if(args.action==='export')return networkInspector.export(context);
    throw new Error('Unsupported network action.');
  }
  if (request.method === 'frames') return {frames:await browser.webNavigation.getAllFrames({tabId:chosen}),selectedFrame};
  if (request.method === 'frame') {
    const id=JSON.parse(request.value).frame_id;
    if(!Number.isSafeInteger(id) || id<0)throw new Error('frame_id must be a nonnegative integer.');
    const frames=await browser.webNavigation.getAllFrames({tabId:chosen});
    if(!frames.some(frame=>frame.frameId===id))throw new Error('Frame no longer exists; list frames again.');
    await browser.tabs.executeScript(chosen,{file:'/content.js',frameId:id,runAt:'document_end'});
    await browser.tabs.sendMessage(chosen,{type:'ping',ref_scope:await refScope()},{frameId:id});
    if(owner!==ownership || chosen!==selected)throw new Error('Tab changed while selecting frame.');
    selectedFrame=id;frameStale=false;
    return {frameId:id,snapshot:await executeCommand({method:'snapshot'},connection,deadline)};
  }
  if(request.method==='demonstrate'){
    const args=JSON.parse(request.value);
    await executeCommand({method:'page',value:JSON.stringify({action:'recording',operation:'start'})},connection,deadline);
    let confirmed;
    try{confirmed=await executeCommand({method:'handoff',value:JSON.stringify({prompt:args.message,timeout_ms:args.timeout_ms ?? 60000})},connection,deadline);}
    finally{if(owner===ownership && chosen===selected)await executeCommand({method:'page',value:JSON.stringify({action:'recording',operation:'stop'})},connection,Date.now()+2000).catch(()=>{});}
    const recording=await executeCommand({method:'page',value:JSON.stringify({action:'recording',operation:'list',limit:200})},connection,Date.now()+2000);
    return {...confirmed,recording};
  }
  if (request.method === 'handoff') {
    if(backgroundTask){await pauseBackground('needs_attention');throw new Error('needs_attention: View the paused agent window to complete the human step.');}
    await waitReady(chosen,owner,connection);
    const args=JSON.parse(request.value);
    const result=await browser.tabs.sendMessage(chosen,{type:'handoff',prompt:args.prompt,timeout_ms:args.timeout_ms},{frameId:0});
    if(owner!==ownership || selected!==chosen || socket!==connection)throw new Error('Tab ownership changed during handoff.');
    if(!result || result.error)throw new Error(result?.error || 'Handoff page did not respond.');
    return result.value;
  }
  if (request.method === 'extract') {
    const args = JSON.parse(request.value);
    const spec = args.spec ?? args;
    if (!spec || typeof spec.selector !== 'string' || !spec.selector || spec.selector.length > 500) throw new Error('A row selector (1-500 characters) is required.');
    if (!spec.fields || typeof spec.fields !== 'object' || !Object.keys(spec.fields).length || Object.keys(spec.fields).length > 20) throw new Error('Provide 1-20 fields.');
    const maxPages = spec.paginate ? Math.max(1, Math.min(Number(spec.paginate.max_pages) || 10, 25)) : 1;
    const totalLimit = 1000;
    const rows = [];
    let pages = 0;
    let truncated = false;
    const readPage = () => executeCommand({ method: 'page', value: JSON.stringify({ action: 'extract', spec }) }, connection, Math.min(deadline, Date.now() + 10000));
    let one = await readPage();
    for (let page = 0; page < maxPages; page++) {
      if (Date.now() >= deadline) throw new Error('Extraction deadline exceeded; inspect before retrying.');
      if (chosen !== selected || owner !== ownership || socket !== connection) throw new Error('Tab sharing changed during extraction.');
      pages++;
      rows.push(...one.rows);
      if (one.omitted) truncated = true;
      if (rows.length >= totalLimit) { if (rows.length > totalLimit || one.has_next) truncated = true; break; }
      if (!spec.paginate || !one.has_next) break;
      if (page + 1 >= maxPages) { truncated = true; break; }
      const stampBefore = generation;
      try {
        await executeCommand({ method: 'page', value: JSON.stringify({ action: 'click_next', selector: spec.paginate.next }) }, connection, Math.min(deadline, Date.now() + 10000));
      } catch (error) {
        // Only a navigation that actually started can explain a dropped reply.
        if (ready && generation === stampBefore) throw error;
      }
      const before = JSON.stringify(one.rows);
      const until = Math.min(deadline, Date.now() + 5000);
      let candidate = '', since = 0, advanced = false;
      while (Date.now() < until) {
        if (Date.now() >= deadline) throw new Error('Extraction deadline exceeded; inspect before retrying.');
        if (chosen !== selected || owner !== ownership || socket !== connection) throw new Error('Tab sharing changed during extraction.');
        if (!ready) await waitReady(chosen, owner, connection, until);
        let next;
        try { next = await readPage(); }
        catch (error) { if (ready) throw error; await new Promise(resolve => setTimeout(resolve, 100)); continue; }
        const current = JSON.stringify(next.rows);
        if (current !== before && next.rows.length > 0) {
          if (candidate !== current) { candidate = current; since = Date.now(); }
          else if (Date.now() - since >= 200) { one = next; advanced = true; break; }
        } else { candidate = ''; since = 0; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!advanced) throw new Error('Pagination did not produce a stable, different set of rows within 5 seconds; inspect the page before retrying.');
    }
    const tab = await browser.tabs.get(chosen);
    return {
      url: tab.url,
      title: tab.title || '',
      rows: rows.slice(0, totalLimit),
      count: Math.min(rows.length, totalLimit),
      pages,
      truncated,
    };
  }
  if (request.method === 'run') {
    const args = JSON.parse(request.value);
    const steps = args.steps;
    if (!Array.isArray(steps) || !steps.length || steps.length > 40) throw new Error('Expected 1-40 steps.');
    const started = Date.now();
    deadline = Math.min(deadline, started + 60000);
    let completed = 0;
    let extraction = null;
    for (const step of steps) {
      if (chosen !== selected || owner !== ownership || socket !== connection) throw new Error('Tab sharing changed during the run.');
      if (Date.now() >= deadline) throw new Error(`Run stopped at step ${completed + 1}: 60-second budget exceeded.`);
      try {
        let command = null;
        if (step.action === 'wait') {
          const ms = step.ms;
          if (!Number.isInteger(ms) || ms < 1 || ms > 5000) throw new Error('wait requires integer ms from 1 to 5000.');
          await new Promise(resolve => setTimeout(resolve, Math.min(ms, Math.max(0, deadline-Date.now()))));
        } else if (step.action === 'wait_for') {
          const timeout = step.timeout_ms ?? 5000;
          if (!Number.isInteger(timeout) || timeout < 100 || timeout > 20000) throw new Error('wait_for timeout_ms must be an integer from 100 to 20000.');
          await executeCommand({ method: 'page', value: JSON.stringify(step) }, connection, Math.min(deadline, Date.now()+timeout));
        } else if (step.action === 'extract') {
          extraction = await executeCommand({ method: 'extract', value: JSON.stringify(Object.fromEntries(Object.entries(step).filter(([key])=>key!=='action'))) }, connection, deadline);
        } else if (step.action === 'navigate') command = { method: 'navigate', value: step.url };
        else if (step.action === 'scroll') command = { method: 'page', value: JSON.stringify({ ...step, action: 'scroll' }) };
        else if (/^(fill|click|submit|select|check|hover|drag)(_(ref|role))?$/.test(step.action)) {
          const method = step.action.split('_')[0];
          command = { method: 'page', value: JSON.stringify({ ...step, action: method }) };
        } else if (step.action === 'press') command = { method: 'page', value: JSON.stringify({ action: 'press', key: step.key }) };
        else throw new Error('Unsupported run step.');
        if (command) {
          await executeCommand(command, connection, deadline);
          if (step.action === 'navigate' && !ready) await waitReady(chosen, owner, connection, deadline);
        }
        if (Date.now() >= deadline) throw new Error('Command deadline exceeded.');
        completed++;
      } catch (error) {
        throw new Error(`Run stopped at step ${completed + 1} (${step.action}); earlier steps may have completed: ${error.message}`);
      }
    }
    const feedback=await executeCommand({method:'page',value:JSON.stringify({action:'feedback'})},connection,deadline).catch(()=>({unavailable:true,needs_observation:true}));
    return { completed, elapsed_ms: Date.now() - started,feedback, ...(extraction ? { extraction } : {}), ...(args.snapshot ? { snapshot: await executeCommand({ method: 'snapshot' }, connection, deadline) } : {}) };
  }
  if (request.method === 'batch') {
    return executeCommand({method:'run',value:JSON.stringify({steps:JSON.parse(request.value),snapshot:true})},connection,deadline);
  }
  if (!['snapshot','click','fill','submit','navigate','page','input_prepare','input_validate'].includes(request.method)) throw new Error('Unsupported action.');
  if(request.method==='input_validate' && JSON.parse(request.value).lease_id!==leaseKey)throw new Error('Trusted input lease was revoked.');
  if(frameStale && request.method!=='navigate')throw new Error('The selected frame navigated; list frames and explicitly select it again.');
  const target = await browser.tabs.get(chosen);
  const [active] = await browser.tabs.query({active:true,windowId:target.windowId});
  if (!active || active.id !== chosen) throw new Error('The shared tab is not active. Return to it before continuing.');
  if (!ready) await waitReady(chosen,owner,connection,deadline);
  if (Date.now() >= deadline) throw new Error('Command deadline exceeded; inspect before retrying.');
  if (owner !== ownership || chosen !== selected || socket !== connection) throw new Error('Tab sharing changed before the action.');
  if (request.method === 'navigate') {
    if (!continuous || !(await browser.permissions.contains({origins:['<all_urls>']}))) throw new Error('Navigation needs the optional website permission. Choose Allow navigation in the extension, then share the tab again.');
    const url = new URL(request.value);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without credentials are supported.');
    let sameDocument = false;
    try { const current = new URL(active.url); current.hash=''; const target=new URL(url.href);target.hash='';sameDocument=current.href===target.href && active.url!==url.href; } catch {}
    if (owner !== ownership || chosen !== selected || socket !== connection) throw new Error('Tab sharing changed before navigation.');
    selectedFrame=0;frameStale=false;ready=false;generation++;
    try { await browser.tabs.update(chosen,{url:url.href}); }
    catch (error) { if(chosen===selected && generation===stamp+1)ready=true;throw error; }
    if (sameDocument && chosen===selected && generation===stamp+1)ready=true;
    return {navigationStarted:true,feedback:{tab_id:chosen,frame_id:selectedFrame,url:url.href,ready:false,needs_observation:true}};
  }
  let result;
  try { result = await browser.tabs.sendMessage(chosen,{type:'action',method:request.method,ref:request.ref,value:request.value,deadline},{frameId:selectedFrame}); }
  catch (error) {
    if (owner !== ownership || chosen !== selected || socket !== connection) throw new Error('Tab sharing changed during the action; inspect the page before retrying.');
    // Waiting is read-only and can safely resume in the next document, within
    // the original step deadline. Never replay an interrupted input operation.
    if (request.method === 'page' && JSON.parse(request.value).action === 'wait_for' && (stamp !== generation || !ready)) return executeCommand(request,connection,deadline);
    throw new Error(`Page message interrupted; action outcome is unknown. Inspect before retrying: ${error.message}`);
  }
  if (owner !== ownership || chosen !== selected || socket !== connection) throw new Error('Tab sharing changed during the action; inspect the page before retrying.');
  if (!result || result.error) {
    const reason=result?.error || 'The selected page did not respond.';
    if(backgroundTask&&reason==='The shared tab is not visible.'){
      await pauseBackground('needs_attention');throw new Error('needs_attention: The agent document is hidden. Use View to inspect it, then resume from your other window.');
    }
    throw new Error(reason);
  }
  if(result.value?.feedback)result.value.feedback={...result.value.feedback,tab_id:chosen,frame_id:selectedFrame,ready};
  const value=request.method==='input_prepare'?{...result.value,lease_id:leaseKey,tab_id:chosen,frame_id:selectedFrame}:result.value;
  return stamp !== generation ? {...value,navigationStarted:true} : value;
}

  Object.assign(context,{
    status,stop,share,executeCommand,startBackground,pauseBackground,resumeBackground,viewBackground,checkBackground,claimTab,prepareFullAccess,
    async focusChanged(id){
      if(!backgroundTask)return;
      if(!backgroundTask.paused&&backgroundTask.windowId===id)await pauseBackground('viewing');
      else if(backgroundTask.startOnReturn&&id!==backgroundTask.windowId){
        const task=backgroundTask,window=await browser.windows.get(task.windowId);
        if(backgroundTask!==task||!task.startOnReturn||window.focused||window.state==='minimized')return;
        try{await resumeBackground();}catch{if(backgroundTask===task&&task.startOnReturn){task.startOnReturn=false;task.reason='needs_attention';}}
      }
    },
    removed(id){if(selected===id||backgroundTask?.tabId===id)void stop();},
    updated(id,change){if(selected!==id)return;if(change.status==='loading'){selectedFrame=0;frameStale=false;ready=false;generation++;if(!continuous)void stop();}if(change.status==='complete')void restorePage(id);},
    frameNavigated(id,frame){if(selected===id && selectedFrame===frame)frameStale=true;},
    permissionsRemoved(permissions){if(backgroundTask&&permissions.permissions?.includes('tabs')){void stop();return;}if(permissions.permissions?.some(p=>['webRequest','webRequestBlocking'].includes(p)) || permissions.origins?.includes('<all_urls>'))void stop();},
    domReady(id){void restorePage(id);}
  });
  Object.defineProperty(context,'target',{get:()=>selected??reserved??backgroundTask?.tabId??null});
  Object.defineProperty(context,'background',{get:taskStatus});
  Object.defineProperty(context,'sharing',{get:()=>selected!==null});
  return context;
}
