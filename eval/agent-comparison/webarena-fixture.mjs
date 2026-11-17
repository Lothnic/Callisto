// Fresh official Shopping Admin image per attempt; never touches unrelated containers.
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createServer as createNetServer} from 'node:net';import {createServer,request} from 'node:http';import {randomBytes} from 'node:crypto';
const exec=promisify(execFile);
export const shoppingImage='am1n3e/webarena-verified-shopping_admin@sha256:d0531dd27ed98d0c459ff9e88118bf2ed8b660b0ed99c38837db46c065a5be13';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=createNetServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
export class ShoppingFixture{
 constructor(){this.owner=randomBytes(8).toString('hex');this.name='callisto-step5-wa-'+this.owner;this.log=[];}
 async docker(args,timeout=120000){const start=performance.now();try{const result=await exec('docker',['--host','unix:///var/run/docker.sock',...args],{timeout,maxBuffer:2_000_000});this.log.push({args,ok:true,elapsed_ms:performance.now()-start,stdout:result.stdout.slice(-4000)});return result.stdout;}catch(error){this.log.push({args,ok:false,elapsed_ms:performance.now()-start,error:String(error.stderr||error.message).slice(-4000)});throw error;}}
 async start(){
  const internal=await freePort();
  this.proxy=createServer((req,res)=>{const upstream=request({hostname:'127.0.0.1',port:internal,path:req.url,method:req.method,headers:{...req.headers,'x-m2-admin-auto-login':'admin'}},remote=>{res.writeHead(remote.statusCode,remote.headers);remote.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Local fixture starting');});req.pipe(upstream);});
  await new Promise(r=>this.proxy.listen(0,'127.0.0.1',r));this.origin='http://127.0.0.1:'+this.proxy.address().port;
  this.id=(await this.docker(['run','--detach','--name',this.name,'--label','callisto.step5.owner='+this.owner,'--memory','2g','--cpus','2','--pids-limit','512','--publish',`127.0.0.1:${internal}:80`,shoppingImage])).trim();
  // env-ctrl is the image's official setup interface; provisioning is not agent work.
  const deadline=Date.now()+150000;let ready=false;
  while(Date.now()<deadline){try{const status=JSON.parse(await this.docker(['exec',this.id,'env-ctrl','--verbose','status'],15000));if(status.success){ready=true;break;}}catch{}await pause(1000);}
  if(!ready)throw Error('Official Shopping Admin services did not become ready');
  await this.docker(['exec',this.id,'env-ctrl','--verbose','init','--base-url',this.origin]);
  let healthy=false;
  for(let i=0;i<40;i++){try{const response=await fetch(this.origin,{redirect:'manual',signal:AbortSignal.timeout(5000)});await response.body?.cancel();if(response.status<500){healthy=true;break;}}catch{}await pause(500);}
  if(!healthy)throw Error('Official Shopping Admin HTTP check failed');
  return this;
 }
 async close(){
  const target=this.id||this.name;
  const owner=(await this.docker(['inspect','--format','{{index .Config.Labels "callisto.step5.owner"}}',target],10000).catch(()=>'' )).trim();
  if(owner){if(owner!==this.owner)throw Error('Container ownership changed; refusing cleanup');await this.docker(['rm','--force',target],30000);this.id=null;}
  if(this.proxy){this.proxy.closeAllConnections();await new Promise(r=>this.proxy.close(r));}
 }
}
