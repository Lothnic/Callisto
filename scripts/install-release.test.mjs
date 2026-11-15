import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {installRelease,installLocalRelease} from './install-release.mjs';
const exec=promisify(execFile);

test('verified install provides a stable launcher; corrupt update preserves the active runtime',async()=>{
 const root=await mkdtemp(join(tmpdir(),'callisto-install-'));
 try{
  const tree=join(root,'tree');await mkdir(join(tree,'packages/mini'),{recursive:true});await mkdir(join(tree,'scripts'));
  await writeFile(join(tree,'packages/mini/package.json'),JSON.stringify({name:'fixture',version:'1.0.0'}));
  await writeFile(join(tree,'packages/mini/package-lock.json'),JSON.stringify({name:'fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'fixture',version:'1.0.0'}}}));
  await writeFile(join(tree,'scripts/callisto.mjs'),"console.log('fixture runtime');");
  const mini=join(root,'mini.tar.gz');await exec('tar',['-czf',mini,'-C',tree,'.']);
  const bridgeTree=join(root,'bridge');await mkdir(bridgeTree);await writeFile(join(bridgeTree,'callisto-firefox-tab-mcp'),'fixture');
  const bridge=join(root,'bridge.tar.gz');await exec('tar',['-czf',bridge,'-C',bridgeTree,'.']);
  const assets={'callisto-mini.tar.gz':await readFile(mini),'callisto-bridge-linux-x64.tar.gz':await readFile(bridge)};
  const metadata=tag=>({tag_name:tag,draft:false,prerelease:false,assets:Object.keys(assets).flatMap(name=>[{name},{name:name+'.sha256'}])});
  const fetcher=(tag,corrupt=false)=>async url=>{
   if(url.startsWith('https://api.github.com'))return new Response(JSON.stringify(url.includes('/tags/')?metadata(tag):[metadata(tag)]));
   const name=url.split('/').at(-1);
   if(name.endsWith('.sha256'))return new Response((corrupt?'0'.repeat(64):createHash('sha256').update(assets[name.slice(0,-7)]).digest('hex'))+'  '+name.slice(0,-7)+'\n');
   return new Response(assets[name]);
  };
  const prefix=join(root,'installation with spaces');
  const installed=await installRelease({prefix,version:'v9.9.9',fetcher:fetcher('v9.9.9'),platform:'linux',arch:'x64'});
  assert.equal((await exec(process.execPath,[installed.launcher])).stdout.trim(),'fixture runtime');
  await assert.rejects(()=>installRelease({prefix,version:'v9.9.10',fetcher:fetcher('v9.9.10',true),platform:'linux',arch:'x64'}),/Checksum mismatch/);
  assert.equal(JSON.parse(await readFile(join(prefix,'current/release.json'),'utf8')).version,'v9.9.9');
  assert.equal((await exec(process.execPath,[installed.launcher])).stdout.trim(),'fixture runtime');
  assert.deepEqual(await readdir(join(prefix,'releases')),['v9.9.9']);
  if(process.platform==='linux'&&process.arch==='x64'){
   const directory=join(root,'local-alpha');await mkdir(directory);
   const manifest={schema:'callisto.alpha-package.v1',version:'v0.2.0-alpha.1',platform:'linux-x64',assets:Object.entries(assets).map(([name,data])=>({name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}))};
   await writeFile(join(directory,'alpha-manifest.json'),JSON.stringify(manifest));
   for(const [name,data] of Object.entries(assets)){await writeFile(join(directory,name),data);await writeFile(join(directory,name+'.sha256'),createHash('sha256').update(data).digest('hex'));}
   const localPrefix=join(root,'local-installed');const local=await installLocalRelease({prefix:localPrefix,directory});
   assert.equal((await exec(process.execPath,[local.launcher])).stdout.trim(),'fixture runtime');
   await assert.rejects(()=>installLocalRelease({prefix:localPrefix,directory,version:'v0.2.0-alpha.2'}),/does not match/);
   const archive=join(directory,'callisto-mini.tar.gz');await rm(archive);await symlink(mini,archive);
   await assert.rejects(()=>installLocalRelease({prefix:localPrefix,directory}),/regular files/);
   assert.equal(JSON.parse(await readFile(join(localPrefix,'current/release.json'),'utf8')).version,manifest.version);
  }

  const unchanged=await installRelease({prefix,fetcher:fetcher('v9.9.8'),platform:'linux',arch:'x64'});
  assert.equal(unchanged.changed,false);assert.equal(unchanged.version,'v9.9.9');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('alpha releases require an explicit version and never enter stable discovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'callisto-alpha-filter-'));
 try{
  const release={tag_name:'v0.2.0-alpha.1',prerelease:true,draft:false,assets:['callisto-mini.tar.gz','callisto-bridge-linux-x64.tar.gz'].flatMap(name=>[{name},{name:name+'.sha256'}])};
  const calls=[];const fetcher=async url=>{calls.push(url);return new Response(JSON.stringify(url.includes('/tags/')?release:[release]));};
  await assert.rejects(()=>installRelease({prefix:join(root,'stable'),fetcher,platform:'linux',arch:'x64'}),/No compatible/);
  assert.equal(calls.length,1);
  await assert.rejects(()=>installRelease({prefix:join(root,'alpha'),version:'v0.2.0-alpha.1',fetcher:async url=>url.includes('/tags/')?new Response(JSON.stringify(release)):new Response('not-an-archive'),platform:'linux',arch:'x64'}),/Checksum mismatch/);
  await assert.rejects(()=>installRelease({prefix:join(root,'invalid'),version:'v0.2.0-alpha.1/../../escape',fetcher,platform:'linux',arch:'x64'}),/release tag/);
 }finally{await rm(root,{recursive:true,force:true});}
});
