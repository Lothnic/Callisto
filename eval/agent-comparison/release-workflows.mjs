// Repeated host-scripted workflows. No LLM latency or real account credentials.
import {Client} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import {StdioClientTransport} from '../../packages/mini/node_modules/@modelcontextprotocol/client/dist/stdio.mjs';
import {installFirefoxFixture} from './firefox-extension-fixture.mjs';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
const exec=promisify(execFile),rows=[],clients={};
const repetitions=Number(process.env.BENCH_REPETITIONS||5);
const agent=process.env.AGENT_BROWSER_COMMAND;
if(!agent)throw Error('Set AGENT_BROWSER_COMMAND to the installed agent-browser executable.');
const state=await mkdtemp(tmpdir()+'/callisto-workflows-');
const session='callisto-workflows-'+Date.now();
const server=createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 const logged=req.headers.cookie?.includes('fixture_login=present');
 if(u.pathname==='/login')res.setHeader('Set-Cookie','fixture_login=present; HttpOnly; SameSite=Lax; Path=/');
 res.setHeader('Content-Type','text/html');
 const value=(u.searchParams.get('q')||'').replace(/[^a-z0-9-]/gi,'');
 res.end(`<!doctype html><title>Workflow fixture</title><h1>${u.pathname==='/saved'?'Saved '+value:'Research form'}</h1><h2>${logged?'Signed in':'Signed out'}</h2><form action="/saved"><label>Query <input name="q" required></label><button type="submit">Search</button></form><a href="/form">Return to form</a>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const chrome=process.env.BENCH_CHROME_PATH||'/snap/bin/chromium';
const env={...process.env,CALLISTO_FIREFOX_STATE_DIR:state,CALLISTO_MCP_BROWSER:'isolated',CHROME_PATH:chrome};
let closeFirefox;
async function connect(name,command,args){const client=new Client({name:'release-workflows',version:'1'});await client.connect(new StdioClientTransport({command,args,env,stderr:'pipe'}));clients[name]=client;}
async function call(engine,name,args={}){const r=await clients[engine].callTool({name,arguments:args},{timeout:140000});if(r.isError)throw Error(r.content.map(c=>c.text||'').join(' '));return r;}
const data=r=>JSON.parse(r.content.find(c=>c.type==='text').text);
async function ab(...args){return (await exec(agent,['--session',session,...args],{timeout:30000,maxBuffer:1000000})).stdout;}
async function browse(code){const r=await call('browse','execute',{session,code});return r.structuredContent?.value??r.content?.[0]?.text;}
async function navigate(engine,path){
 const url=origin+path;
 if(engine==='browse')return browse(`await page.goto(${JSON.stringify(url)},{waitUntil:'domcontentloaded'}); return await page.locator('body').innerText()`);
 if(engine==='agent-browser'){await ab('open',url);return ab('get','text','body');}
 await call(engine,'callisto_navigate',{url});
 if(engine==='firefox')return data(await call(engine,'callisto_snapshot'));
 return data(await call(engine,'callisto_snapshot'));
}
async function workflow(engine,iteration){
 await navigate(engine,'/form');
 const query='trial-'+iteration;
 if(engine==='browse')await browse(`await page.getByRole('textbox',{name:'Query',exact:true}).fill(${JSON.stringify(query)}); await page.getByRole('button',{name:'Search',exact:true}).click(); return await page.locator('body').innerText()`);
 else if(engine==='agent-browser'){
   const snapshot=await ab('snapshot','-i');
   const ref=name=>{const line=snapshot.split('\n').find(line=>line.includes('"'+name+'"'));if(!line)throw Error('Missing '+name);return '@'+line.match(/ref=(e\d+)/)[1];};
   await ab('fill',ref('Query'),query);await ab('click',ref('Search'));
 } else {
   const s=data(await call(engine,'callisto_snapshot'));
   const ref=name=>s.text.split('\n').find(line=>line.includes('"'+name+'"')).match(/\[(ax-\d+)\]/)[1];
   await call(engine,'callisto_fill',{ref:ref('Query'),value:query});await call(engine,'callisto_click',{ref:ref('Search')});
 }
 let text;
 if(engine==='browse')text=await browse("return await page.locator('body').innerText()");
 else if(engine==='agent-browser')text=await ab('get','text','body');
 else text=data(await call(engine,'callisto_snapshot')).text;
 if(!text.includes('Saved '+query)||!text.includes('Signed in'))throw Error('Form result or persisted fixture login missing');
 // Revisit after navigation to verify session state is retained.
 const returned=await navigate(engine,'/form');
 const observation=typeof returned==='string'?returned:returned.text;
 if(!observation.includes('Signed in'))throw Error('Login state lost on return');
}
try{
 await connect('chromium',process.execPath,['packages/mini/dist/mcp.js']);
 await connect('firefox','packages/firefox-rs/target/release/callisto-firefox-tab-mcp',[]);
 closeFirefox=await installFirefoxFixture(clients.firefox,origin+'/login');
 await connect('browse','browse',['mcp']);await call('browse','session_new',{id:session,allowedOrigins:[origin]});
 await ab('--executable-path',chrome,'open',origin+'/login');
 for(const engine of ['chromium','firefox','browse'])await navigate(engine,'/login');
 const engines=['chromium','firefox','browse','agent-browser'];
 for(let i=0;i<repetitions;i++)for(const engine of i%2?[...engines].reverse():engines){
  const start=performance.now();let error=null;
  try{await workflow(engine,i);}catch(e){error=String(e.message).slice(0,1000);}
  rows.push({engine,iteration:i,ok:!error,ms:performance.now()-start,error});console.error(engine,i,error||'PASS');
 }
 const summary=Object.fromEntries(engines.map(engine=>{const all=rows.filter(r=>r.engine===engine),ok=all.filter(r=>r.ok).map(r=>r.ms).sort((a,b)=>a-b);return [engine,{passed:ok.length,total:all.length,medianMs:ok.length?ok[Math.floor(ok.length/2)]:null}];}));
 await writeFile(process.env.BENCH_OUTPUT||'research/2026-11-12-release-workflows.json',JSON.stringify({date:new Date().toISOString(),sourceRevision:(await exec('git',['rev-parse','HEAD'])).stdout.trim(),workingTreeDirty:!!(await exec('git',['status','--porcelain'])).stdout.trim(),versions:{node:process.version,chromium:(await exec(chrome,['--version'])).stdout.trim(),agentBrowser:(await exec(agent,['--version'])).stdout.trim(),firefox:(await exec('firefox',['--version'])).stdout.trim()},repetitions,notes:'Host-scripted form submission and cookie persistence, local fixture login only; not an autonomous-agent benchmark or real-account login proof. Firefox runs a disposable test extension with all optional permissions granted. browse uses the paired existing Chromium profile in an owned tab; Mini and agent-browser launch isolated Chromium. CLI process overhead included for agent-browser. Warm runs exclude setup and initial login. Different observations and transports; no language-level speed claim.',summary,rows},null,2)+'\n');
 console.log(JSON.stringify(summary,null,2));
}finally{
 await ab('close').catch(()=>{});
 if(clients.browse)await call('browse','session_delete',{id:session}).catch(()=>{});
 for(const engine of ['chromium','firefox'])if(clients[engine])await call(engine,'callisto_close').catch(()=>{});
 for(const client of Object.values(clients))await client.close().catch(()=>{});
 await closeFirefox?.().catch(()=>{});
 await exec('packages/firefox-rs/target/release/callisto-firefox-tab-mcp',['--stop-relay'],{env}).catch(()=>{});
 await rm(state,{recursive:true,force:true});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
