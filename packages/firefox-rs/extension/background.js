'use strict';
let socket = null;
let paired = false;
let rememberedCode = null;
let reconnectTimer = null;
let retryDelay = 1000;
let pairAttempt = 0;
let storageWrites = Promise.resolve();
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
    if (message.type === 'pair') { await pair(message.code); return {message:'Connected. Open the desired tab and click Share this tab.'}; }
    if (message.type === 'share') return {message:await share()};
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
browser.tabs.onRemoved.addListener(id=>{for(const session of sessions.values())session.removed(id);});
browser.tabs.onUpdated.addListener((id,change)=>{for(const session of sessions.values())session.updated(id,change);});
browser.permissions.onRemoved.addListener(permissions=>{for(const session of sessions.values())session.permissionsRemoved(permissions);});
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
function status(){
  if(!paired)return 'Not connected.';
  const count=[...sessions.values()].filter(session=>session.target!==null).length;
  return count ? `Connected. ${count} tab(s) shared across agent sessions. Stop sharing releases all of them.` : sessions.get(0).status();
}
async function stop(reset=false){
  const work=Promise.all([...sessions.values()].map(session=>session.stop()));
  if(reset){sessions.clear();newManual();}
  await work;
}
async function share(id){await stop();return sessions.get(0).share(id);}
browser.webNavigation.onDOMContentLoaded.addListener(event=>{if(event.frameId===0)for(const session of sessions.values())session.domReady(event.tabId);});
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
  if(id!==0 && request.method!=='status' && (!session || session.target===null) && manual.target!==null){
    if(session)await session.stop();
    session=manual;sessions.set(id,session);newManual();
  }
  if(!session){
    if(request.method==='status')return manual.executeCommand(request,connection);
    if(sessions.size>=64)throw new Error('Too many connected sessions; close unused MCP clients.');
    session=createSession();sessions.set(id,session);
  }
  return session.executeCommand(request,connection);
}
function createSession(){
let selected = null;
let generation = 0;
let ownership = 0;
let ready = false;
let continuous = false;
let selectedFrame = 0;
let reserved=null;
  const context={get selected(){return selected;},share,assertAvailable,guard(expected){if(expected!==ownership)throw new Error('Tab ownership changed before the browser operation.');}};
  function assertAvailable(tabId){
    for(const other of sessions.values())if(other!==context && other.target===tabId)throw new Error('Tab is owned by another agent session. Release it before taking control.');
  }
function status() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !paired) return 'Not connected.';
  return selected === null ? 'Connected. Select a tab and click Share this tab.' : ready ? 'Connected. The selected tab is shared.' : 'Connected. Waiting for the shared page to load.';
}
async function stop() {
  const previous = selected;
  selected = null; reserved = null; selectedFrame = 0; ready = false; continuous = false; generation++; ownership++;
  await browser.browserAction.setBadgeText({text:[...sessions.values()].some(s=>s.target!==null)?'ON':''}).catch(() => {});
  if (previous !== null) await browser.tabs.sendMessage(previous, {type:'revoke'}).catch(() => {});
}
async function share(tabId,expectedOwner) {
  if(expectedOwner!==undefined)context.guard(expectedOwner);
  if (!socket || socket.readyState !== WebSocket.OPEN || !paired) throw new Error('Connect first.');
  const tab = tabId === undefined ? (await browser.tabs.query({active:true,currentWindow:true}))[0] : await browser.tabs.get(tabId);
  if (!tab || !tab.active || tab.id === undefined) throw new Error('No active browser tab.');
  if(expectedOwner!==undefined)context.guard(expectedOwner);
  assertAvailable(tab.id);
  const beforeStop=ownership;
  await stop();
  if(ownership!==beforeStop+1)throw new Error('Sharing stopped before the tab was prepared.');
  assertAvailable(tab.id);
  reserved = tab.id;
  const stamp = generation, connection = socket;
  const hasSiteAccess = await browser.permissions.contains({origins:['<all_urls>']});
  const deadline=Date.now()+8000;
  while(true) {
    if(stamp!==generation || socket!==connection || !paired)throw new Error('Sharing was stopped while the tab was being prepared.');
    try {
      await browser.tabs.executeScript(tab.id,{file:'/content.js',runAt:'document_end'});
      await browser.tabs.sendMessage(tab.id,{type:'ping'});break;
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
  await browser.browserAction.setBadgeText({text:'ON'}).catch(() => {});
  return 'Connected. This tab is shared; click Stop sharing to revoke access.';
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
    await browser.tabs.sendMessage(id,{type:'ping'});
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
    return {connected:true,sharing:chosen !== null,active:chosen !== null && active?.id === chosen,ready,continuous,browserAccess:await browser.permissions.contains(fullBrowserPermissions),capabilities:{trustedInput:false,frames:'same-origin',playwrightExecution:false}};
  }
  if (request.method === 'browser') {
    const args = JSON.parse(request.value);
    if (!browserActions.includes(args.action)) throw new Error('Unsupported browser action.');
    return browserControl(args, context, owner);
  }
  if (chosen === null) throw new Error('No tab shared. Open the desired tab and click Share this tab in the Callisto extension.');
  if (request.method === 'frames') return {frames:await browser.webNavigation.getAllFrames({tabId:chosen}),selectedFrame};
  if (request.method === 'frame') {
    const id=JSON.parse(request.value).frame_id;
    if(!Number.isSafeInteger(id) || id<0)throw new Error('frame_id must be a nonnegative integer.');
    const frames=await browser.webNavigation.getAllFrames({tabId:chosen});
    if(!frames.some(frame=>frame.frameId===id))throw new Error('Frame no longer exists; list frames again.');
    await browser.tabs.executeScript(chosen,{file:'/content.js',frameId:id,runAt:'document_end'});
    await browser.tabs.sendMessage(chosen,{type:'ping'},{frameId:id});
    if(owner!==ownership || chosen!==selected)throw new Error('Tab changed while selecting frame.');
    selectedFrame=id;
    return {frameId:id,snapshot:await executeCommand({method:'snapshot'},connection,deadline)};
  }
  if (request.method === 'handoff') {
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
    for (let page = 0; page < maxPages; page++) {
      if (chosen !== selected || owner !== ownership || socket !== connection) throw new Error('Tab sharing changed during extraction.');
      const one = await executeCommand({ method: 'page', value: JSON.stringify({ action: 'extract', spec }) }, connection, Date.now() + 30000);
      pages++;
      rows.push(...one.rows);
      if (rows.length >= totalLimit || !spec.paginate || !one.has_next) break;
      try {
        await executeCommand({ method: 'page', value: JSON.stringify({ action: 'click_next', selector: spec.paginate.next }) }, connection, Date.now() + 30000);
      } catch (error) {
        // A pager link can navigate and drop the reply; the page load is expected.
      }
      if (!ready) await waitReady(chosen, owner, connection, Date.now() + 10000);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const tab = await browser.tabs.get(chosen);
    return {
      url: tab.url,
      title: tab.title || '',
      rows: rows.slice(0, totalLimit),
      count: Math.min(rows.length, totalLimit),
      pages,
      truncated: rows.length > totalLimit,
    };
  }
  if (request.method === 'run') {
    const args = JSON.parse(request.value);
    const steps = args.steps;
    if (!Array.isArray(steps) || !steps.length || steps.length > 40) throw new Error('Expected 1-40 steps.');
    const started = Date.now();
    const deadline = started + 60000;
    let completed = 0;
    let extraction = null;
    for (const step of steps) {
      if (chosen !== selected || owner !== ownership || socket !== connection) throw new Error('Tab sharing changed during the run.');
      if (Date.now() >= deadline) throw new Error(`Run stopped at step ${completed + 1}: 60-second budget exceeded.`);
      try {
        let command = null;
        if (step.action === 'wait') {
          const ms = Math.max(1, Math.min(Number(step.ms) || 0, 5000));
          if (!ms) throw new Error('wait requires ms.');
          await new Promise(resolve => setTimeout(resolve, ms));
        } else if (step.action === 'wait_for') {
          if (typeof step.text !== 'string' || !step.text || step.text.length > 500) throw new Error('wait_for requires text (1-500 characters).');
          const budget = Math.min(Number(step.timeout_ms) || 5000, 20000);
          const until = Date.now() + budget;
          let found = false;
          while (Date.now() < until) {
            const result = await executeCommand({ method: 'page', value: JSON.stringify({ action: 'find', query: step.text }) }, connection, deadline);
            if (result.matches && result.matches.length) { found = true; break; }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!found) throw new Error(`wait_for timed out after ${budget}ms waiting for ${JSON.stringify(step.text)}.`);
        } else if (step.action === 'extract') {
          extraction = await executeCommand({ method: 'extract', value: JSON.stringify(step.spec ?? {}) }, connection, deadline);
        } else if (step.action === 'navigate') command = { method: 'navigate', value: step.url };
        else if (step.action === 'scroll') command = { method: 'page', value: JSON.stringify({ ...step, action: 'scroll' }) };
        else if (/^(fill|click)_(ref|role)$/.test(step.action)) {
          const method = step.action.split('_')[0];
          command = { method: 'page', value: JSON.stringify({ ...step, action: method }) };
        } else if (step.action === 'press') command = { method: 'page', value: JSON.stringify({ action: 'press', key: step.key }) };
        else throw new Error('Unsupported run step.');
        if (command) {
          await executeCommand(command, connection, deadline);
          if (step.action === 'navigate' && !ready) await waitReady(chosen, owner, connection, deadline);
        }
        completed++;
      } catch (error) {
        throw new Error(`Run stopped at step ${completed + 1} (${step.action}); earlier steps may have completed: ${error.message}`);
      }
    }
    return { completed, elapsed_ms: Date.now() - started, ...(extraction ? { extraction } : {}), ...(args.snapshot ? { snapshot: await executeCommand({ method: 'snapshot' }, connection, deadline) } : {}) };
  }
  if (request.method === 'batch') {
    const steps = JSON.parse(request.value);
    if (!Array.isArray(steps) || !steps.length || steps.length>10) throw new Error('Expected 1–10 batch actions.');
    let completed = 0;
    for (const step of steps) {
      try {
        if (chosen !== selected || owner !== ownership || socket !== connection || Date.now()>=deadline) throw new Error('Batch ownership changed or its deadline expired.');
        let command;
        if (step.action === 'navigate') command = {method:'navigate',value:step.url};
        else if (step.action === 'scroll') command = {method:'page',value:JSON.stringify({...step,action:'scroll'})};
        else if (/^(fill|click|submit)_(ref|role)$/.test(step.action)) {
          const method = step.action.split('_')[0];
          command = {method:'page',value:JSON.stringify({...step,action:method})};
        } else throw new Error('Unsupported batch action.');
        await executeCommand(command,connection,deadline); completed++;
      } catch (error) { throw new Error(`Batch stopped at step ${completed+1}; earlier actions may have completed: ${error.message}`); }
    }
    if (owner !== ownership || chosen !== selected) throw new Error('Batch ownership changed before observation.');
    return {completed,snapshot:await executeCommand({method:'snapshot'},connection,deadline)};
  }
  if (!['snapshot','click','fill','submit','navigate','page'].includes(request.method)) throw new Error('Unsupported action.');
  const target = await browser.tabs.get(chosen);
  const [active] = await browser.tabs.query({active:true,windowId:target.windowId});
  if (!active || active.id !== chosen) throw new Error('The shared tab is not active. Return to it before continuing.');
  if (!ready) await waitReady(chosen,owner,connection,deadline);
  if (owner !== ownership || chosen !== selected || socket !== connection) throw new Error('Tab sharing changed before the action.');
  if (request.method === 'navigate') {
    if (!continuous || !(await browser.permissions.contains({origins:['<all_urls>']}))) throw new Error('Navigation needs the optional website permission. Choose Allow navigation in the extension, then share the tab again.');
    const url = new URL(request.value);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without credentials are supported.');
    let sameDocument = false;
    try { const current = new URL(active.url); current.hash=''; const target=new URL(url.href);target.hash='';sameDocument=current.href===target.href && active.url!==url.href; } catch {}
    if (owner !== ownership || chosen !== selected || socket !== connection) throw new Error('Tab sharing changed before navigation.');
    selectedFrame=0;ready=false;generation++;
    try { await browser.tabs.update(chosen,{url:url.href}); }
    catch (error) { if(chosen===selected && generation===stamp+1)ready=true;throw error; }
    if (sameDocument && chosen===selected && generation===stamp+1)ready=true;
    return {navigationStarted:true};
  }
  let result;
  try { result = await browser.tabs.sendMessage(chosen,{type:'action',method:request.method,ref:request.ref,value:request.value},{frameId:selectedFrame}); }
  catch (error) {
    throw new Error(`Page message interrupted; action outcome is unknown. Inspect before retrying: ${error.message}`);
  }
  if (owner !== ownership || chosen !== selected || socket !== connection) throw new Error('Tab sharing changed during the action; inspect the page before retrying.');
  if (!result || result.error) throw new Error(result?.error || 'The selected page did not respond.');
  return stamp !== generation ? {...result.value,navigationStarted:true} : result.value;
}

  Object.assign(context,{
    status,stop,share,executeCommand,
    removed(id){if(selected===id)void stop();},
    updated(id,change){if(selected!==id)return;if(change.status==='loading'){selectedFrame=0;ready=false;generation++;if(!continuous)void stop();}if(change.status==='complete')void restorePage(id);},
    permissionsRemoved(permissions){if(continuous&&permissions.origins?.includes('<all_urls>'))void stop();},
    domReady(id){void restorePage(id);}
  });
  Object.defineProperty(context,'target',{get:()=>selected??reserved});
  return context;
}
