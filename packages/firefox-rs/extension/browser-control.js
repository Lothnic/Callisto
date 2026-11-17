'use strict';
const fullBrowserPermissions = {origins:['<all_urls>'],permissions:['tabs','cookies','bookmarks','history','downloads']};
const fullControlPermissions = {origins:['<all_urls>'],permissions:[...fullBrowserPermissions.permissions,'tabHide']};
const browserActions = ['tab_name','tab_resolve','background','tabs_list','windows_list','tab_select','tab_activate','tab_create','tab_navigate','window_create','window_close','agent_container','tab_close','back','forward','reload','screenshot','cookies_list','cookie_set','cookie_remove','bookmarks_search','history_search','downloads_search','download'];
let namedTabWrites=Promise.resolve();
const namedTabStorage=()=>browser.storage.local;
async function updateNamedTabs(change){
  const work=namedTabWrites.then(async()=>{
    const saved=await namedTabStorage().get('callistoNamedTabs');
    const names={...(saved.callistoNamedTabs ?? {})};
    const result=await change(names);await namedTabStorage().set({callistoNamedTabs:names});return result;
  });namedTabWrites=work.catch(()=>{});return work;
}
async function resolveNamedTab(name){
  if(typeof name!=='string'||!name.trim()||name.length>100)throw new Error('tab_name must be 1–100 characters.');
  await namedTabWrites;
  const saved=await namedTabStorage().get('callistoNamedTabs');
  const entry=saved.callistoNamedTabs?.[name];
  if(!entry || typeof entry.token!=='string')throw new Error('Unknown tab_name; assign it with browser action=tab_name first.');
  const candidates=[entry.id,...(await browser.tabs.query({})).map(t=>t.id).filter(id=>id!==entry.id)];
  for(const id of candidates){
    try{if(await browser.sessions.getTabValue(id,'callistoNamedTab')===entry.token){const tab=await browser.tabs.get(id);if(id!==entry.id)await updateNamedTabs(names=>{names[name]={...entry,id};});return tab;}}catch{}
  }
  await updateNamedTabs(names=>{delete names[name];});throw new Error('Named tab has closed; select or create a new tab.');
}

function forgetNamedTab(id){return updateNamedTabs(names=>{for(const [name,tab] of Object.entries(names))if(tab.id===id)delete names[name];});}
function webUrl(value) {
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP(S) URL without credentials.');
  return url.href;
}
function tabUrl(value){return value===undefined||value==='about:blank'?'about:blank':value==='about:newtab'?value:webUrl(value);}
async function activateBrowserTab(id,session,owner){
  session.guard(owner);session.assertAvailable(id);
  let tab=await browser.tabs.get(id);session.guard(owner);
  if(tab.hidden){
    if(!browser.tabs.show)throw new Error('Enable Full browser control to show hidden tabs (tabHide permission).');
    await browser.tabs.show(id);session.guard(owner);
  }
  tab=await browser.tabs.update(id,{active:true});session.guard(owner);
  const window=browser.windows.get?await browser.windows.get(tab.windowId):null;session.guard(owner);
  await browser.windows.update(tab.windowId,{focused:true,...(window?.state==='minimized'?{state:'normal'}:{})});session.guard(owner);
  return tab;
}
async function browserControl(args, session, owner) {
  if(args.action==='background'){
    if(!['start','pause','resume','stop'].includes(args.operation))throw new Error('Choose background operation start, pause, resume or stop.');
    session.guard(owner);
    if(args.operation==='start')return session.startBackground(owner);
    if(args.operation==='pause')return session.pauseBackground('paused');
    if(args.operation==='resume')return session.resumeBackground(owner);
    await session.stop();return {released:true,windowPreserved:true};
  }
  if(session.background && ['tab_select','tab_activate','tab_create','tab_navigate','window_create','window_close','tab_close','download'].includes(args.action))throw new Error('needs_attention: This background task cannot select, create, close or raise other tabs/windows or open a save dialog. Take back the task first.');
  if(session.background&&!['tabs_list','cookies_list','bookmarks_search','history_search','downloads_search'].includes(args.action))await session.checkBackground(owner);
  if (!(await browser.permissions.contains(fullBrowserPermissions))) throw new Error('Choose Enable browser access in the extension and approve its permissions first.');
  session.guard(owner);
  if((args.action==='tab_name'||args.tab_name!==undefined) && !(await browser.permissions.contains({permissions:['sessions']})))throw new Error('Named tabs need the sessions permission. Choose Enable browser access again to grant it.');
  if(args.action!=='tab_name' && args.tab_name!==undefined){
    const tab=await resolveNamedTab(args.tab_name);session.guard(owner);
    if(args.tab_id!==undefined && args.tab_id!==tab.id)throw new Error('Conflicting tab_id and tab_name.');
    args={...args,tab_id:tab.id};
  }
  const id = () => { if (!Number.isSafeInteger(args.tab_id) || args.tab_id < 0) throw new Error('tab_id is required.'); return args.tab_id; };
  const summary = t => ({id:t.id,windowId:t.windowId,url:t.url,title:t.title,active:t.active,cookieStoreId:t.cookieStoreId,pinned:t.pinned,hidden:!!t.hidden});
  switch (args.action) {
    case 'tab_name': {
      if(typeof args.tab_name!=='string'||!args.tab_name.trim()||args.tab_name.length>100)throw new Error('tab_name must be 1–100 characters.');
      const tab=await browser.tabs.get(id());session.guard(owner);
      const token=await browser.sessions.getTabValue(tab.id,'callistoNamedTab') ?? crypto.randomUUID();
      await browser.sessions.setTabValue(tab.id,'callistoNamedTab',token);session.guard(owner);
      await updateNamedTabs(names=>{Object.defineProperty(names,args.tab_name,{value:{id:tab.id,token},enumerable:true,configurable:true,writable:true});});
      return {...summary(tab),tab_name:args.tab_name};
    }
    case 'tab_resolve': {
      if(args.tab_name===undefined)throw new Error('tab_name is required.');
      return {...summary(await browser.tabs.get(id())),tab_name:args.tab_name};
    }
    case 'tabs_list': return {tabs:(await browser.tabs.query({})).map(summary),warning:'Zen may omit tabs from inactive workspaces.'};
    case 'windows_list': return {windows:await browser.windows.getAll({populate:true})};
    case 'tab_activate': {
      await session.claimTab(id(),owner);
      const tab=await activateBrowserTab(id(),session,owner);
      await session.stop();return {...summary(tab),shared:false};
    }
    case 'tab_select': {
      await session.claimTab(id(),owner);
      const tab=await activateBrowserTab(id(),session,owner);
      await session.share(tab.id,owner); return {...summary(tab),shared:true};
    }
    case 'tab_navigate': {
      await session.claimTab(id(),owner);
      const tab=await browser.tabs.update(id(),{url:webUrl(args.url)});session.guard(owner);
      if(fullBrowserAccess){await activateBrowserTab(tab.id,session,owner);await session.share(tab.id,owner);}
      return {...summary(tab),shared:fullBrowserAccess};
    }
    case 'window_close': {
      if(!Number.isSafeInteger(args.window_id) || args.window_id<0)throw new Error('window_id is required.');
      for(const tab of await browser.tabs.query({windowId:args.window_id}))await session.claimTab(tab.id,owner);
      session.guard(owner);
      await browser.windows.remove(args.window_id);return {closed:true};
    }
    case 'agent_container': return agentContainer();
    case 'window_create': {
      const options={url:tabUrl(args.url),focused:true,titlePreface:'[Callisto] '};
      const store=await creationStore(args, session); if(store)options.cookieStoreId=store;
      session.guard(owner);
      const window=await browser.windows.create(options);
      session.guard(owner);
      const attach=fullBrowserAccess&&!!window.tabs[0]&&/^https?:/.test(options.url);
      if(attach)await session.share(window.tabs[0].id,owner);else if(fullBrowserAccess)await session.stop();
      return {windowId:window.id,tabs:window.tabs.map(summary),shared:attach};
    }
    case 'tab_create': {
      const options = {url:tabUrl(args.url),active:true};
      if(args.window_id!==undefined){if(!Number.isSafeInteger(args.window_id)||args.window_id<0)throw new Error('window_id must be a nonnegative integer.');options.windowId=args.window_id;}
      const store=await creationStore(args, session);if(store)options.cookieStoreId=store;
      session.guard(owner);
      const tab = await browser.tabs.create(options);
      session.guard(owner);
      const attach=fullBrowserAccess&&/^https?:/.test(options.url);
      if(fullBrowserAccess){await activateBrowserTab(tab.id,session,owner);if(attach)await session.share(tab.id,owner);else await session.stop();}
      return {...summary(tab),shared:attach};
    }
    case 'tab_close': await session.claimTab(id(),owner);session.guard(owner);await browser.tabs.remove(id()); return {closed:true};
    case 'bookmarks_search': return (await browser.bookmarks.search(String(args.query || '').slice(0,200))).slice(0,100);
    case 'history_search': return browser.history.search({text:String(args.query || '').slice(0,200),maxResults:100,startTime:0});
    case 'downloads_search': return browser.downloads.search({limit:100,query:args.query ? [String(args.query).slice(0,200)] : []});
    case 'download': return {id:await browser.downloads.download({url:webUrl(args.url),saveAs:true})};
    case 'cookies_list': return browser.cookies.getAll({url:webUrl(args.url),...(args.cookie_store_id ? {storeId:String(args.cookie_store_id)} : {})});
    case 'cookie_set': {
      if (typeof args.name !== 'string' || typeof args.value !== 'string') throw new Error('Cookie name and value are required.');
      return browser.cookies.set({url:webUrl(args.url),name:args.name,value:args.value,...(args.cookie_store_id ? {storeId:String(args.cookie_store_id)} : {})});
    }
    case 'cookie_remove': {
      if (typeof args.name !== 'string') throw new Error('Cookie name is required.');
      return browser.cookies.remove({url:webUrl(args.url),name:args.name,...(args.cookie_store_id ? {storeId:String(args.cookie_store_id)} : {})});
    }
    default: {
      if (session.selected === null) throw new Error('Select or share a tab first.');
      const tab = await browser.tabs.get(session.selected);
      const [active] = await browser.tabs.query({active:true,windowId:tab.windowId});
      session.guard(owner);
      if (active?.id !== session.selected) throw new Error('The controlled tab is not active.');
      if (args.action === 'screenshot') {
        const format=args.format ?? 'jpeg';
        if(!['jpeg','png'].includes(format))throw new Error('Screenshot format must be jpeg or png.');
        return {dataUrl:await browser.tabs.captureVisibleTab(tab.windowId,{format,...(format==='jpeg'?{quality:70}:{})})};
      }
      if (args.action === 'back') await browser.tabs.goBack(session.selected);
      else if (args.action === 'forward') await browser.tabs.goForward(session.selected);
      else if (args.action === 'reload') await browser.tabs.reload(session.selected);
      else throw new Error('Unsupported browser action.');
      return {navigationStarted:true};
    }
  }
}

async function agentContainer() {
  if(!(await browser.storage.local.get('callistoAgentContainersEnabled')).callistoAgentContainersEnabled)throw new Error('Enable agent containers in the extension first.');
  if (!(await browser.permissions.contains({permissions:['contextualIdentities','cookies']}))) throw new Error('Enable agent containers in the extension first. This is a separate cookie session.');
  const saved=await browser.storage.local.get('callistoAgentContainerId');
  if(saved.callistoAgentContainerId) {
    try { return await browser.contextualIdentities.get(saved.callistoAgentContainerId); } catch {}
  }
  const api=browser.contextualIdentities;
  const colors=api.getSupportedColors?(await api.getSupportedColors()).map(entry=>entry.color):['blue'];
  const icons=api.getSupportedIcons?(await api.getSupportedIcons()).map(entry=>entry.icon):['briefcase'];
  const identity=await api.create({name:'Callisto',color:colors.includes('blue')?'blue':colors[0],icon:icons.includes('briefcase')?'briefcase':icons[0]});
  await browser.storage.local.set({callistoAgentContainerId:identity.cookieStoreId});
  return identity;
}
async function creationStore(args, session) {
  if(args.agent_container && args.cookie_store_id)throw new Error('Choose agent_container or cookie_store_id, not both.');
  if(args.agent_container)return (await agentContainer()).cookieStoreId;
  if(args.cookie_store_id)return String(args.cookie_store_id);
  if(session.selected!==null)return (await browser.tabs.get(session.selected)).cookieStoreId;
  return undefined;
}
