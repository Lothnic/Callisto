import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareBrowseExtension} from './browse-extension.mjs';

test('store package gets upstream unpacked identity only in an owned copy',async()=>{
 const root=await mkdtemp(join(tmpdir(),'browse-identity-'));
 try{
  const source=join(root,'store'),destination=join(root,'owned');await mkdir(source);
  const original=JSON.stringify({manifest_version:3,version:'0.0.16',background:{service_worker:'background.js'}});
  const code='// original native browser implementation';
  await writeFile(join(source,'manifest.json'),original);await writeFile(join(source,'background.js'),code);
  const prepared=await prepareBrowseExtension(source,destination);
  const loaded=JSON.parse(await readFile(join(prepared.path,'manifest.json'),'utf8'));
  const upstream=JSON.parse(await readFile(new URL('../../vendor/browse/public/manifest.json',import.meta.url),'utf8'));
  assert.equal(loaded.key,upstream.key);delete loaded.key;
  assert.deepEqual(loaded,JSON.parse(original));
  assert.equal(await readFile(join(source,'manifest.json'),'utf8'),original);
  assert.equal(await readFile(join(prepared.path,'background.js'),'utf8'),code);
  assert.equal(prepared.metadata.unpacked_identity_added,true);
  assert.notEqual(prepared.metadata.source_manifest_sha256,prepared.metadata.loaded_manifest_sha256);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('development package retains its existing identity and source path',async()=>{
 const root=await mkdtemp(join(tmpdir(),'browse-identity-'));
 try{
  await writeFile(join(root,'manifest.json'),JSON.stringify({key:'existing-public-key'}));
  const prepared=await prepareBrowseExtension(root,join(root,'unused'));
  assert.equal(prepared.path,root);assert.equal(prepared.metadata.unpacked_identity_added,false);
  assert.equal(prepared.metadata.source_manifest_sha256,prepared.metadata.loaded_manifest_sha256);
  await assert.rejects(stat(join(root,'unused')),e=>e.code==='ENOENT');
 }finally{await rm(root,{recursive:true,force:true});}
});
