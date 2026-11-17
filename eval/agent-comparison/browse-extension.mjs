// Store packages omit the public key; unpacked fixtures need browse's upstream
// development identity. Never edit the installed source or relax relay origins.
import {readFile,cp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const digest=data=>createHash('sha256').update(data).digest('hex');
export async function prepareBrowseExtension(source,destination){
 source=resolve(source);
 const original=await readFile(join(source,'manifest.json'));
 const manifest=JSON.parse(original);
 let loaded=original;const identityAdded=!manifest.key;
 await cp(source,destination,{recursive:true});
 if(!manifest.key){
  const upstream=JSON.parse(await readFile(new URL('../../vendor/browse/public/manifest.json',import.meta.url),'utf8'));
  if(!upstream.key)throw Error('browse upstream development manifest has no public identity key');
  manifest.key=upstream.key;
  loaded=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  await writeFile(join(destination,'manifest.json'),loaded);
 }
 return {path:destination,metadata:{source_path:source,source_manifest_sha256:digest(original),loaded_manifest_sha256:digest(loaded),copied_to_owned_profile:true,unpacked_identity_added:identityAdded,identity_source:identityAdded?'vendor/browse/public/manifest.json':null}};
}
