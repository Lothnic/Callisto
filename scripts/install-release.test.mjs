import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {installRelease} from './install-release.mjs';
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
  const unchanged=await installRelease({prefix,fetcher:fetcher('v9.9.8'),platform:'linux',arch:'x64'});
  assert.equal(unchanged.changed,false);assert.equal(unchanged.version,'v9.9.9');
 }finally{await rm(root,{recursive:true,force:true});}
});
