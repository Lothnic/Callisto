// Read-only package diagnostics. Does not start a relay, expose credentials or grant access.
import {access,readFile,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export async function diagnose(root,{backend='zen',environment=process.env}={}){
 if(!['zen','firefox','chromium'].includes(backend))throw Error('doctor backend must be zen, firefox or chromium');
 const checks=[];checks.push({name:'node',passed:Number(process.versions.node.split('.')[0])>=20,detail:process.version});
 checks.push({name:'platform',passed:backend==='chromium'||process.platform!=='win32',detail:process.platform+'-'+process.arch});
 const target=backend==='chromium'?join(root,'packages/mini/dist/mcp.js'):join(root,'packages/firefox-rs/target/release/callisto-firefox-tab-mcp');
 try{await access(target,backend==='chromium'?constants.R_OK:constants.X_OK);if(backend!=='chromium'){const version=(await exec(target,['--version'],{timeout:5000})).stdout.trim();checks.push({name:'runtime',passed:version.startsWith('callisto-firefox-tab-mcp '),path:target,version});}else checks.push({name:'runtime',passed:true,path:target});}catch(error){checks.push({name:'runtime',passed:false,path:target,detail:String(error.stderr||error.code||'Runtime missing or not executable').slice(0,240)});}
 let extensionVersion=null;
 if(backend!=='chromium'){try{const manifest=JSON.parse(await readFile(join(root,'packages/firefox-rs/extension/manifest.json'),'utf8'));extensionVersion=manifest.version;checks.push({name:'extension_files',passed:manifest.manifest_version===2,detail:'Unsigned temporary extension; reload after browser exit'});}catch{checks.push({name:'extension_files',passed:false,detail:'Extension files missing'});}}
 const directory=environment.CALLISTO_FIREFOX_STATE_DIR||join(environment.XDG_STATE_HOME||join(homedir(),'.local/state'),'callisto/firefox');let relaySocketPresent=false;
 if(backend!=='chromium'){try{const metadata=await stat(directory);checks.push({name:'private_state',passed:metadata.isDirectory()&&(metadata.mode&0o077)===0,detail:'Directory permissions only; credentials were not read'});relaySocketPresent=(await stat(join(directory,'relay.sock')).catch(()=>null))?.isSocket()||false;}catch(error){checks.push({name:'private_state',passed:error.code==='ENOENT',detail:error.code==='ENOENT'?'Created privately on first runtime use':'State directory could not be inspected'});}}
 const release=JSON.parse(await readFile(join(root,'release.json'),'utf8').catch(()=>'null'));
 return {schema:'callisto.doctor.v1',backend,release,extensionVersion,ready:checks.every(c=>c.passed),checks,relay_socket_present:relaySocketPresent,live_connection_probed:false,next:[`Register the MCP command: node ${resolve(root,'scripts/callisto.mjs')} ${backend}`,backend==='chromium'?'Install Chrome/Chromium and set CHROME_PATH if needed.':`Load ${resolve(root,'packages/firefox-rs/extension/manifest.json')} temporarily, pair once and explicitly share the intended tab.`,'After reconnecting, re-enable trusted input with its explicit endpoint when requested.']};
}
