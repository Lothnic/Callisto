// Dedicated persistent test profile. Never attaches to a person's browser.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,chmod,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createServer} from 'node:net';
const exec=promisify(execFile);
const shellQuote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
export async function until(check,timeout=15000){const until=Date.now()+timeout;let last;while(Date.now()<until){try{const value=await check();if(value)return value;}catch(error){last=error;}await pause(100);}throw Error('Fixture deadline exceeded'+(last?': '+last.message:''));}
export const value=result=>{if(result.isError)throw Error(result.content?.map(c=>c.text||'').join(' '));return JSON.parse(result.content.find(c=>c.type==='text').text);};
export class ZenFixture {
 constructor(client,{kind='zen',headless=kind==='firefox'}={}){this.client=client;this.kind=kind;this.headless=headless;this.extensionVersion=0;}
 async call(name,args={}){return value(await this.client.callTool({name,arguments:args},{timeout:45000}));}
 async request(path,data,method){const response=await fetch(this.driverURL+path,{method:method??(data?'POST':'GET'),headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(30000)});const result=await response.json();if(!response.ok)throw Error(result.value?.message||'WebDriver request failed');return result.value;}
 async start(url){
  this.url=url;
  const base=this.kind==='zen'?join(homedir(),'.var/app/app.zen_browser.zen/cache'):join(homedir(),'snap/firefox/common');
  await mkdir(base,{recursive:true,mode:0o700});
  this.directory=await mkdtemp(join(base,'callisto-persistent-'));await chmod(this.directory,0o700);
  this.profile=join(this.directory,'profile');await exec('mkdir',['-p',this.profile]);
  this.driverURL='http://127.0.0.1:'+await freePort();const bidiPort=await freePort();
  this.driver=spawn('xvfb-run',['-a',process.env.GECKODRIVER_BINARY||'/snap/firefox/current/usr/lib/firefox/geckodriver','--host','127.0.0.1','--port',new URL(this.driverURL).port,'--websocket-port',String(bidiPort),'--profile-root',this.directory],{stdio:'ignore',detached:true,env:{...process.env,MOZ_ENABLE_WAYLAND:'0',GDK_BACKEND:'x11',WAYLAND_DISPLAY:''}});
  await until(()=>fetch(this.driverURL+'/status').then(r=>r.ok));
  if(this.kind==='zen'){
   const location=(await exec('flatpak',['info','--show-location','app.zen_browser.zen'])).stdout.trim();
   this.binary=join(this.directory,'zen-wrapper');
   const auth=join(this.directory,'fixture.Xauthority');
   await writeFile(this.binary,'#!/bin/sh\ncp -- "$XAUTHORITY" '+shellQuote(auth)+'\nchmod 600 '+shellQuote(auth)+'\nexec flatpak run --socket=x11 --nosocket=wayland --env=DISPLAY="$DISPLAY" --env=XAUTHORITY='+shellQuote(auth)+' --env=MOZ_ENABLE_WAYLAND=0 --env=GDK_BACKEND=x11 app.zen_browser.zen "$@"\n',{mode:0o700});
   for(const name of ['application.ini','platform.ini'])await copyFile(join(location,'files/zen',name),join(this.directory,name));
  }
  await this.openBrowser();await this.installExtension(true);await this.share();return this;
 }
 async openBrowser(){
  const args=['-no-remote','-profile',this.profile];if(this.headless)args.push('-headless');
  const options={args,prefs:{'zen.welcome-screen.seen':true,'browser.shell.checkDefaultBrowser':false,'privacy.userContext.enabled':true}};if(this.binary)options.binary=this.binary;
  const created=await this.request('/session',{capabilities:{alwaysMatch:{browserName:'firefox',webSocketUrl:true,'moz:firefoxOptions':options}}});this.session=created.sessionId;this.capabilities=created.capabilities;this.endpoint=created.capabilities.webSocketUrl;
  // Zen can expose an internal empty-workspace placeholder as the initial
  // WebDriver context after restart. Create a genuine owned tab explicitly.
  const tab=await this.request(`/session/${this.session}/window/new`,{type:'tab'});this.handle=tab.handle;
  await this.request(`/session/${this.session}/window`,{handle:tab.handle});
  await this.request(`/session/${this.session}/window/rect`,{width:1440,height:900});
  await this.request(`/session/${this.session}/url`,{url:this.url});
 }
 async installExtension(initial=false){
  const code=initial?(await this.call('callisto_pair')).code:null;
  const archive=join(this.directory,`extension-${++this.extensionVersion}.xpi`);
  await exec('python3',['-c',`import pathlib,json,zipfile,sys
root=pathlib.Path(sys.argv[1]);code=json.loads(sys.argv[3])
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for p in root.iterdir():
  if not p.is_file():continue
  data=p.read_bytes()
  if p.name=='manifest.json':
   m=json.loads(data);m['version']='0.2.'+sys.argv[4];m['permissions']=list(dict.fromkeys(m['permissions']+m.pop('optional_permissions')));data=json.dumps(m).encode()
  if p.name=='browser-control.js':data+=b'\\nglobalThis.fixtureFocusEvents=[];browser.windows.onFocusChanged.addListener(id=>globalThis.fixtureFocusEvents.push({id,at:Date.now()}));const fixtureBrowserControl=browserControl;browserControl=async(...args)=>{if(args[0].action==="fixture_background_prepare")return args[1].startBackground(args[2],{allowWindowSetup:true});const result=await fixtureBrowserControl(...args);if(args[0].action==="tabs_list")result.fixture_diagnostics={focusEvents:globalThis.fixtureFocusEvents,version:browser.runtime.getManifest().version,windows:(await browser.windows.getAll({populate:true})).map(w=>({id:w.id,focused:w.focused,state:w.state,type:w.type,tabs:w.tabs?.map(t=>({id:t.id,active:t.active,url:t.url}))})),allTabs:(await browser.tabs.query({})).map(t=>({id:t.id,url:t.url}))};return result;};'
  if p.name=='background.js':data+=b'\\n browserActions.push("fixture_background_prepare");'
  if p.name=='background.js' and code:data+=('\\nsetTimeout(()=>pair('+json.dumps(code)+').catch(console.error),300);').encode()
  z.writestr(p.name,data)
`,resolve('packages/firefox-rs/extension'),archive,JSON.stringify(code),String(this.extensionVersion)]).catch(error=>{throw Error('Fixture extension build failed: '+String(error.stderr||'archive creation failed').slice(0,300));});
  await this.request(`/session/${this.session}/moz/addon/install`,{path:archive,temporary:true});
  await until(async()=>{const s=await this.call('callisto_status');return s.connected&&s;});
 }
 async share(){
  const tab=await until(async()=>{const listing=await this.call('callisto_browser',{action:'tabs_list'});const tabs=listing.tabs;this.lastTabs=tabs;this.lastDiagnostics=listing.fixture_diagnostics;const matches=tabs.filter(tab=>tab.url===this.url);return matches.find(tab=>tab.active)||(matches.length===1?matches[0]:null);}).catch(()=>{throw Error('Persistent fixture tab missing: '+JSON.stringify({tabs:this.lastTabs,extension:this.lastDiagnostics}));});
  this.tabId=tab.id;await this.call('callisto_browser',{action:'tab_select',tab_id:tab.id});
  await this.call('callisto_input',{action:'enable',endpoint:this.endpoint});
 }
 async navigate(url){
  // WebDriver navigation does not establish the extension's active-tab lease.
  // Reacquire only the original owned fixture tab before each measured task.
  await this.request(`/session/${this.session}/window`,{handle:this.handle});
  await this.request(`/session/${this.session}/url`,{url});
  await this.call('callisto_browser',{action:'tab_select',tab_id:this.tabId});
  await until(()=>this.script('return document.visibilityState === "visible" && document.readyState !== "loading"'));
  await this.call('callisto_input',{action:'enable',endpoint:this.endpoint});
  await this.call('callisto_frame',{frame_id:0});
 }
 async script(script){return this.request(`/session/${this.session}/execute/sync`,{script,args:[]});}
 async ownedInstance(){
  if(this.kind!=='zen')return null;
  const pid=String(this.capabilities['moz:processID']);if(!/^\d+$/.test(pid))throw Error('Missing fixture process id');
  const rows=(await exec('flatpak',['ps','--columns=instance,application'])).stdout.trim().split('\n');
  for(const row of rows){const [instance,app]=row.trim().split(/\s+/);if(app!=='app.zen_browser.zen')continue;
   try{const cmd=(await exec('flatpak',['enter',instance,'cat',`/proc/${pid}/cmdline`])).stdout.split('\0');if(cmd.includes(this.profile))return {instance,pid};}catch{}
  }
  return null;
 }
 async terminateOwned(owned,signal='-TERM'){
  if(!owned)return;
  try{const cmd=(await exec('flatpak',['enter',owned.instance,'cat',`/proc/${owned.pid}/cmdline`])).stdout.split('\0');if(!cmd.includes(this.profile))throw Error('Fixture process ownership changed');await exec('flatpak',['enter',owned.instance,'kill',signal,owned.pid]);}catch(error){if(error.message.includes('ownership changed'))throw error;}
 }
 async restartBrowser(){
  const owned=await this.ownedInstance();await this.request(`/session/${this.session}`,undefined,'DELETE');this.session=null;
  await this.terminateOwned(owned);
  await until(async()=>!(await this.call('callisto_status')).connected);
  await this.openBrowser();await this.installExtension(false);
 }
 async crashBrowser(){
  if(this.kind!=='zen')throw Error('Crash injection currently targets the isolated Zen Flatpak');
  const owned=await this.ownedInstance();if(!owned)throw Error('Refusing crash injection: cannot prove profile ownership');
  await this.terminateOwned(owned,'-KILL');
  await this.request(`/session/${this.session}`,undefined,'DELETE').catch(()=>{});this.session=null;
  await until(async()=>!(await this.call('callisto_status')).connected);
  await this.openBrowser();await this.installExtension(false);
 }
 async close(){
  const owned=await this.ownedInstance().catch(()=>null);
  if(this.session)await this.request(`/session/${this.session}`,undefined,'DELETE').catch(()=>{});
  await this.terminateOwned(owned);
  if(this.driver?.pid){try{process.kill(-this.driver.pid,'SIGTERM');}catch{}}
  if(this.directory)await rm(this.directory,{recursive:true,force:true});
 }
}
