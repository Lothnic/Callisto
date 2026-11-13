'use strict';
const fullBrowserPermissions = {origins:['<all_urls>'],permissions:['tabs','cookies','bookmarks','history','downloads']};
const browserActions = ['tabs_list','tab_select','tab_create','window_create','window_close','agent_container','tab_close','back','forward','reload','screenshot','cookies_list','cookie_set','cookie_remove','bookmarks_search','history_search','downloads_search','download'];
function webUrl(value) {
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP(S) URL without credentials.');
  return url.href;
}
async function browserControl(args, session, owner) {
  if (!(await browser.permissions.contains(fullBrowserPermissions))) throw new Error('Choose Enable browser access in the extension and approve its permissions first.');
  session.guard(owner);
  const id = () => { if (!Number.isSafeInteger(args.tab_id) || args.tab_id < 0) throw new Error('tab_id is required.'); return args.tab_id; };
  const summary = t => ({id:t.id,windowId:t.windowId,url:t.url,title:t.title,active:t.active,cookieStoreId:t.cookieStoreId,pinned:t.pinned});
  switch (args.action) {
    case 'tabs_list': return {tabs:(await browser.tabs.query({})).map(summary),warning:'Zen may omit tabs from inactive workspaces.'};
    case 'tab_select': {
      session.assertAvailable(id());
      const tab = await browser.tabs.update(id(),{active:true});
      session.guard(owner);
      await browser.windows.update(tab.windowId,{focused:true});
      await session.share(tab.id,owner); return summary(tab);
    }
    case 'window_close': {
      if(!Number.isSafeInteger(args.window_id) || args.window_id<0)throw new Error('window_id is required.');
      for(const tab of await browser.tabs.query({windowId:args.window_id}))session.assertAvailable(tab.id);
      session.guard(owner);
      await browser.windows.remove(args.window_id);return {closed:true};
    }
    case 'agent_container': return agentContainer();
    case 'window_create': {
      const options={url:webUrl(args.url),focused:true,titlePreface:'[Callisto] '};
      const store=await creationStore(args, session); if(store)options.cookieStoreId=store;
      session.guard(owner);
      const window=await browser.windows.create(options);
      return {windowId:window.id,tabs:window.tabs.map(summary)};
    }
    case 'tab_create': {
      const options = {url:webUrl(args.url),active:true};
      const store=await creationStore(args, session);if(store)options.cookieStoreId=store;
      session.guard(owner);
      const tab = await browser.tabs.create(options);
      return summary(tab);
    }
    case 'tab_close': session.assertAvailable(id()); await browser.tabs.remove(id()); return {closed:true};
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
      if (args.action === 'screenshot') return {dataUrl:await browser.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:70})};
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
