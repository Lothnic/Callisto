// An isolated browse relay and disposable extension profile; no existing pairing.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createServer} from 'node:net';
import {chromium} from '../../packages/mini/node_modules/playwright-core/index.mjs';
import {MCPClient} from './mcp-client.mjs';
import {until} from './zen-fixture.mjs';
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
  const extension=resolve('vendor/browse/dist');
  this.browser=await chromium.launchPersistentContext(join(this.directory,'profile'),{executablePath:process.env.CHROMIUM_PATH||'/snap/bin/chromium',headless:false,viewport:{width:1440,height:900},args:['--no-sandbox',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=this.browser.serviceWorkers()[0]||await this.browser.waitForEvent('serviceworker',{timeout:15000});
  await worker.evaluate(async({code,port})=>{await chrome.storage.local.set({agentRelayPort:port,agentRelayPairingCode:code.replace('-','')});},{code,port:this.port});
  await until(async()=>{const result=await exec('browse',['status','--json'],{env:this.env,timeout:5000});const status=JSON.parse(result.stdout);return status.extension?.connected;});
  this.client=await new MCPClient('browse',['mcp'],this.env).initialize();
  this.session='callisto-matched-'+Date.now();
  const result=await this.client.callTool({name:'session_new',arguments:{id:this.session,allowedOrigins:[origin]}});if(result.isError)throw Error('Private browse session could not start');
  return this;
 }
 async execute(code){return this.client.callTool({name:'execute',arguments:{session:this.session,code}});}
 async close(){if(this.client){await this.client.callTool({name:'session_delete',arguments:{id:this.session}}).catch(()=>{});await this.client.close();}await this.browser?.close().catch(()=>{});this.relay?.kill('SIGTERM');if(this.directory)await rm(this.directory,{recursive:true,force:true});}
}
if(process.argv.includes('--probe')){const fixture=new BrowseFixture();try{await fixture.start('http://127.0.0.1:8080');console.log('Private browse relay and extension connected.');}finally{await fixture.close();}}
