#!/usr/bin/env node
// Linux alpha assets; unsigned extension is labelled explicitly.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),args=process.argv.slice(2);let version,out;
while(args.length){const arg=args.shift();if(arg==='--version')version=args.shift();else if(arg==='--out')out=args.shift();else throw Error('Usage: package-alpha.mjs --version vX.Y.Z-alpha.N --out new-directory');}
if(!/^v\d+\.\d+\.\d+-alpha\.\d+$/.test(version||'')||!out)throw Error('An explicit alpha version and new output directory are required');
if(process.platform!=='linux'||process.arch!=='x64')throw Error('This alpha packager is validated for Linux x64 only');
const cargo=await readFile('packages/firefox-rs/Cargo.toml','utf8'),componentVersion=cargo.match(/^version = "([^"]+)"/m)?.[1];
if(version!=='v'+componentVersion)throw Error('Alpha tag must match the Rust package version');
const extension=JSON.parse(await readFile('packages/firefox-rs/extension/manifest.json','utf8'));
if(extension.version!==componentVersion.split('-')[0])throw Error('Extension version must match the alpha core version');
out=resolve(out);await mkdir(out,{recursive:false,mode:0o700});
const stage=await mkdtemp(join(tmpdir(),'callisto-alpha-'));
try{
 await exec('npm',['--prefix','packages/mini','run','build'],{maxBuffer:2000000});
 await exec('cargo',['build','--locked','--release','--manifest-path','packages/firefox-rs/Cargo.toml','--bin','callisto-firefox-tab-mcp'],{maxBuffer:2000000});
 const bundle=join(stage,'mini');await mkdir(join(bundle,'packages/mini'),{recursive:true});await mkdir(join(bundle,'packages/firefox-rs'),{recursive:true});await mkdir(join(bundle,'scripts'),{recursive:true});await mkdir(join(bundle,'docs'),{recursive:true});
 for(const name of ['dist','package.json','package-lock.json'])await cp(join('packages/mini',name),join(bundle,'packages/mini',name),{recursive:true});
 await cp('packages/firefox-rs/extension',join(bundle,'packages/firefox-rs/extension'),{recursive:true});
 for(const name of ['callisto.mjs','install-release.mjs','doctor.mjs'])await cp(join('scripts',name),join(bundle,'scripts',name));
 for(const name of ['getting-started.md','zen-advanced-runtime.md','alpha-guide.md'])await cp(join('docs',name),join(bundle,'docs',name));
 for(const name of ['README.md','LICENSE'])await cp(name,join(bundle,name));
 const bridge=join(stage,'bridge');await mkdir(bridge);await cp('packages/firefox-rs/target/release/callisto-firefox-tab-mcp',join(bridge,'callisto-firefox-tab-mcp'));await cp('LICENSE',join(bridge,'LICENSE'));
 const files=['callisto-mini.tar.gz','callisto-bridge-linux-x64.tar.gz','callisto-extension-unsigned.zip','callisto-install.mjs'];
 await cp('scripts/install-release.mjs',join(out,'callisto-install.mjs'));
 await exec('tar',['-czf',join(out,files[0]),'-C',bundle,'.']);await exec('tar',['-czf',join(out,files[1]),'-C',bridge,'.']);
 await exec('python3',['-c',`from pathlib import Path
import sys,zipfile
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for path in sorted(Path(sys.argv[1]).iterdir()):
  if path.is_file():z.write(path,path.name)
`,resolve('packages/firefox-rs/extension'),join(out,files[2])]);
 const assets=[];for(const name of files){const data=await readFile(join(out,name)),sha256=createHash('sha256').update(data).digest('hex');await writeFile(join(out,name+'.sha256'),sha256+'  '+name+'\n');assets.push({name,bytes:data.length,sha256});}
 const revision=(await exec('git',['rev-parse','HEAD'])).stdout.trim();
 const symbols=(await exec('objdump',['-T','packages/firefox-rs/target/release/callisto-firefox-tab-mcp'])).stdout;const glibc=[...new Set(symbols.match(/GLIBC_[0-9.]+/g)||[])].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1)?.replace('GLIBC_','');
 await writeFile(join(out,'alpha-manifest.json'),JSON.stringify({schema:'callisto.alpha-package.v1',version,sourceRevision:revision,sourceTreeDirty:!!(await exec('git',['status','--porcelain','--','packages/firefox-rs','packages/mini','scripts','docs'])).stdout.trim(),platform:'linux-x64',libc:{family:'glibc',minimum:glibc},extension:{signed:false,installation:'temporary; reload after browser exit'},assets},null,2)+'\n');
 console.log(JSON.stringify({version,directory:out,assets:assets.map(a=>a.name)},null,2));
}finally{await rm(stage,{recursive:true,force:true});}
