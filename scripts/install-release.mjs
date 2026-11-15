#!/usr/bin/env node
// Versioned Unix installs. Only the current symlink changes after a successful build.
import {mkdir,mkdtemp,readFile,writeFile,rename,symlink,rm,open,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),repository='Lothnic/Callisto';
const readJSON=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch{return null;}};
const tagPattern=/^v(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;
const newer=(a,b)=>{const left=tagPattern.exec(a),right=tagPattern.exec(b);if(!left||!right)return false;for(let i=1;i<=3;i++){if(+left[i]!==+right[i])return +left[i]>+right[i];}if(!left[4]||!right[4])return !left[4]&&!!right[4];const rank={alpha:0,beta:1,rc:2};return rank[left[4]]===rank[right[4]]?+left[5]>+right[5]:rank[left[4]]>rank[right[4]];};
async function bytes(fetcher,url){
  const response=await fetcher(url,{signal:AbortSignal.timeout(30000),headers:{Accept:'application/vnd.github+json'}});
  if(!response.ok)throw Error(`Release download failed (${response.status}): ${url}`);
  const chunks=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>100*1024*1024)throw Error('Release asset exceeds 100 MiB');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
export async function installRelease(options){
  const prefix=resolve(options.prefix);await mkdir(prefix,{recursive:true,mode:0o700});
  const lock=await open(join(prefix,'update.lock'),'wx',0o600);
  try{await lock.writeFile(JSON.stringify({pid:process.pid}));return await installUnlocked({...options,prefix});}
  finally{await lock.close();await rm(join(prefix,'update.lock'),{force:true});}
}
async function installUnlocked({prefix,version,autoUpdate=false,fetcher=fetch,platform=process.platform,arch=process.arch}){
  prefix=resolve(prefix);
  const supported={'linux:x64':'linux-x64','darwin:arm64':'macos-arm64'};
  const target=supported[platform+':'+arch];if(!target)throw Error('Packaged install currently supports Linux x64 and macOS ARM64 only');
  if(version&&!tagPattern.test(version))throw Error('Use a release tag such as v0.2.0 or v0.2.0-alpha.1');
  const current=await readJSON(join(prefix,'current/release.json'));
  const metadata=JSON.parse(await bytes(fetcher,`https://api.github.com/repos/${repository}/releases${version?'/tags/'+version:'?per_page=20'}`));
  const names=['callisto-mini.tar.gz',`callisto-bridge-${target}.tar.gz`];
  const available=release=>!release.draft&&tagPattern.test(release.tag_name)&&names.every(name=>release.assets?.some(asset=>asset.name===name)&&release.assets.some(asset=>asset.name===name+'.sha256'));
  const release=version?metadata:metadata.find(release=>!release.prerelease&&available(release));
  if(!release||!available(release))throw Error('No compatible packaged release found. v0.1.0 is source-only; use the checkout setup guide.');
  const tag=release.tag_name;
  if(version&&tag!==version)throw Error('Release metadata does not match the requested version');
  if(!version&&current&&!newer(tag,current.version))return {version:current.version,changed:false};
  await mkdir(join(prefix,'releases'),{recursive:true,mode:0o700});
  const stage=await mkdtemp(join(prefix,'releases/.install-'));
  const bundle=join(stage,'bundle');await mkdir(bundle);
  try{
    for(const name of names){
      const url=`https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;
      const archive=await bytes(fetcher,url),checksum=(await bytes(fetcher,url+'.sha256')).toString().trim().split(/\s+/)[0];
      if(!/^[a-f0-9]{64}$/i.test(checksum)||createHash('sha256').update(archive).digest('hex')!==checksum.toLowerCase())throw Error(`Checksum mismatch: ${name}`);
      const file=join(stage,name);await writeFile(file,archive);
      const listing=(await exec('tar',['-tzf',file])).stdout.split('\n');
      if(listing.some(path=>path.startsWith('/')||path.split('/').includes('..')))throw Error('Invalid release archive path');
      const destination=name===names[0]?bundle:join(bundle,'packages/firefox-rs/target/release');await mkdir(destination,{recursive:true});
      await exec('tar',['-xzf',file,'--no-same-owner','-C',destination]);
    }
    await exec('npm',['--prefix',join(bundle,'packages/mini'),'ci','--omit=dev','--no-audit','--no-fund'],{maxBuffer:2000000});
    await writeFile(join(bundle,'release.json'),JSON.stringify({version:tag,platform:target}));
    const destination=join(prefix,'releases',tag);
    // A version is immutable once installed. Never mutate an active runtime.
    try{await rename(bundle,destination);}catch(error){if(error.code!=='EEXIST'&&error.code!=='ENOTEMPTY')throw error;}
    const pointer=join(stage,'current');await symlink(destination,pointer);await rename(pointer,join(prefix,'current'));
    const settings=join(stage,'settings.json');await writeFile(settings,JSON.stringify({autoUpdate,checkedAt:Date.now()}),{mode:0o600});await rename(settings,join(prefix,'settings.json'));
    await mkdir(join(prefix,'bin'),{recursive:true});
    const shim=join(prefix,'bin/callisto.mjs');
    await writeFile(shim,"#!/usr/bin/env node\nimport {fileURLToPath} from 'node:url';\nprocess.env.CALLISTO_INSTALL_ROOT=fileURLToPath(new URL('../',import.meta.url));\nawait import(new URL('../current/scripts/callisto.mjs',import.meta.url));\n",{mode:0o755});
    return {version:tag,changed:true,launcher:shim};
  }finally{await rm(stage,{recursive:true,force:true});}
}
export async function installLocalRelease({prefix,directory,version,autoUpdate=false}){
  directory=resolve(directory);
  const manifest=JSON.parse(await readFile(join(directory,'alpha-manifest.json'),'utf8'));
  if(manifest.schema!=='callisto.alpha-package.v1'||!tagPattern.test(manifest.version)||!manifest.version.includes('-alpha.'))throw Error('Invalid local alpha manifest');
  if(version&&version!==manifest.version)throw Error('Local alpha version does not match the requested version');
  const target={'linux:x64':'linux-x64','darwin:arm64':'macos-arm64'}[process.platform+':'+process.arch];
  if(manifest.platform!==target)throw Error('Local alpha does not match this platform');
  const names=['callisto-mini.tar.gz',`callisto-bridge-${target}.tar.gz`];
  if(!names.every(name=>manifest.assets?.some(a=>a.name===name)))throw Error('Local alpha runtime assets missing');
  const allowed=new Set(names.flatMap(name=>[name,name+'.sha256']));
  const metadata={tag_name:manifest.version,draft:false,prerelease:true,assets:[...allowed].map(name=>({name}))};
  const fetcher=async url=>{
    if(url.startsWith('https://api.github.com/'))return new Response(JSON.stringify(metadata));
    const name=new URL(url).pathname.split('/').at(-1);if(!allowed.has(name))throw Error('Unexpected local release asset');
    const path=join(directory,name),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('Local release assets must be regular files');
    const data=await readFile(path);
    if(!name.endsWith('.sha256')){const asset=manifest.assets.find(a=>a.name===name);if(asset.bytes!==data.length||asset.sha256!==createHash('sha256').update(data).digest('hex'))throw Error(`Local manifest checksum mismatch: ${name}`);}
    return new Response(data);
  };
  return installRelease({prefix,version:manifest.version,autoUpdate,fetcher});
}
export async function maybeUpdate(prefix){
  const settings=await readJSON(join(prefix,'settings.json'));
  if(process.env.CALLISTO_AUTO_UPDATE==='0'||!(process.env.CALLISTO_AUTO_UPDATE==='1'||settings?.autoUpdate)||Date.now()-(settings?.checkedAt||0)<86400000)return;
  // Record a bounded daily attempt, including failures. Never print on MCP stdout.
  try{
    await writeFile(join(prefix,'settings.json'),JSON.stringify({...settings,checkedAt:Date.now()}),{mode:0o600});
    await installRelease({prefix,autoUpdate:true});
  }catch(error){console.error('Callisto update deferred: '+error.message);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let version,directory,prefix=join(homedir(),'.local/share/callisto-runtime'),autoUpdate=false,check=false;
  while(args.length){const key=args.shift();const value=()=>{if(!args[0]||args[0].startsWith('--'))throw Error('Missing value for '+key);return args.shift();};if(key==='--version')version=value();else if(key==='--from-dir')directory=value();else if(key==='--prefix')prefix=value();else if(key==='--auto-update')autoUpdate=true;else if(key==='--check')check=true;else throw Error('Usage: install-release.mjs [--version vX.Y.Z] [--from-dir alpha-directory] [--prefix path] [--auto-update]');}
  if(!prefix)throw Error('Install prefix required');
  if(check&&directory)throw Error('--check cannot be combined with --from-dir');
  if(check)await maybeUpdate(prefix);else console.log(JSON.stringify(await (directory?installLocalRelease({prefix,directory,version,autoUpdate}):installRelease({prefix,version,autoUpdate})),null,2));
}
