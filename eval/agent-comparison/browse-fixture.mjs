// An isolated browse relay and disposable extension profile; no existing pairing.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {chromium} from '../../packages/mini/node_modules/playwright-core/index.mjs';
import {MCPClient} from './mcp-client.mjs';
import {until} from './zen-fixture.mjs';
import {prepareBrowseExtension} from './browse-extension.mjs';
const exec=promisify(execFile);
export class BrowseFixture {
 async start(origin){
  const base=join(homedir(),'snap/chromium/common');await mkdir(base,{recursive:true});this.directory=await mkdtemp(join(base,'callisto-browse-'));
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));this.port=listener.address().port;await new Promise(r=>listener.close(r));
  this.env={...process.env,OPENCODE_BROWSER_HOME:join(this.directory,'relay'),OPENCODE_BROWSER_PORT:String(this.port),OPENCODE_BROWSER_AUTO_UPDATE:'off',OPENCODE_BROWSER_UPDATE_CHECK:'0'};
  this.relay=spawn('browse',['serve'],{env:this.env,stdio:'ignore'});
  await until(()=>fetch(`http://127.0.0.1:${this.port}/version`).then(r=>r.ok));
  let pairOutput;try{const result=await exec('browse',['pair','--wait-seconds','1'],{env:this.env,timeout:10000});pairOutput=result.stdout+'\n'+result.stderr;}catch(error){pairOutput=(error.stdout||'')+'\n'+(error.stderr||'');}
  const code=pairOutput.match(/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/)?.[0];if(!code)throw Error('Could not create private browse pairing code');
  const prepared=await prepareBrowseExtension(resolve(process.env.BROWSE_EXTENSION_PATH||'vendor/browse/dist'),join(this.directory,'extension'));
  const extension=prepared.path;this.extensionMetadata=prepared.metadata;
  this.browser=await chromium.launchPersistentContext(join(this.directory,'profile'),{executablePath:process.env.CHROMIUM_PATH||'/snap/bin/chromium',headless:false,viewport:{width:1440,height:900},args:['--no-sandbox',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=this.browser.serviceWorkers()[0]||await this.browser.waitForEvent('serviceworker',{timeout:15000});
  await worker.evaluate(async({code,port})=>{await chrome.storage.local.set({agentRelayPort:port,agentRelayPairingCode:code.replace('-','')});},{code,port:this.port});
  await until(async()=>{const result=await exec('browse',['status','--json'],{env:this.env,timeout:5000});const status=JSON.parse(result.stdout);return status.extension?.connected;});
  this.client=await new MCPClient('browse',['mcp'],this.env).initialize();
  const tools=(await this.client.request('tools/list')).tools;
  this.apiMode=tools.some(t=>t.name==='session_new')?'session':'tab';
  if(this.apiMode==='session'){
   this.session='callisto-matched-'+Date.now();
   await this.configureOrigins([origin],false);
  }else{
   if(!tools.find(t=>t.name==='execute')?.inputSchema?.properties?.tab)throw Error('Unsupported browse execute contract');
   const result=await this.client.callTool({name:'execute',arguments:{code:`await page.goto(${JSON.stringify(origin)},{waitUntil:'domcontentloaded'}); return {url:page.url()};`}});
   const tab=result.content?.find(c=>c.type==='text')?.text.match(/^tab:\s*(\d+)\b/m)?.[1];
   if(result.isError||!tab)throw Error('Private browse tab could not start: '+JSON.stringify(result));
   this.tab=Number(tab);
  }
  return this;
 }
 async configureOrigins(allowedOrigins,replace=true){
  if(this.apiMode!=='session')return;
  if(replace)await this.client.callTool({name:'session_delete',arguments:{id:this.session}});
  const result=await this.client.callTool({name:'session_new',arguments:{id:this.session,allowedOrigins}});
  if(result.isError)throw Error('Private browse session could not start: '+JSON.stringify(result));
 }
 async execute(code){return this.client.callTool({name:'execute',arguments:{...(this.apiMode==='session'?{session:this.session}:{tab:this.tab}),code}});}
 async close(){if(this.client){if(this.apiMode==='session')await this.client.callTool({name:'session_delete',arguments:{id:this.session}}).catch(()=>{});await this.client.close();}await this.browser?.close().catch(()=>{});this.relay?.kill('SIGTERM');if(this.directory)await rm(this.directory,{recursive:true,force:true});}
}
if(process.argv.includes('--probe')){
 const server=createHttpServer((req,res)=>res.end('<title>Owned fixture</title>'));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const fixture=new BrowseFixture();try{await fixture.start(`http://127.0.0.1:${server.address().port}`);console.log('Private browse relay, extension and '+fixture.apiMode+' connected.');}finally{await fixture.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
