'use strict';
const fullBrowserPermissions = {origins:['<all_urls>'],permissions:['tabs','cookies','bookmarks','history','downloads']};
const fullControlPermissions = {origins:['<all_urls>'],permissions:[...fullBrowserPermissions.permissions,'tabHide']};
const browserActions = ['background','tabs_list','windows_list','tab_select','tab_activate','tab_create','tab_navigate','window_create','window_close','agent_container','tab_close','back','forward','reload','screenshot','cookies_list','cookie_set','cookie_remove','bookmarks_search','history_search','downloads_search','download'];
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
  const id = () => { if (!Number.isSafeInteger(args.tab_id) || args.tab_id < 0) throw new Error('tab_id is required.'); return args.tab_id; };
  const summary = t => ({id:t.id,windowId:t.windowId,url:t.url,title:t.title,active:t.active,cookieStoreId:t.cookieStoreId,pinned:t.pinned,hidden:!!t.hidden});
  switch (args.action) {
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
