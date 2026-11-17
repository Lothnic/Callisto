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
 let path=source,loaded=original;
 if(!manifest.key){
  const upstream=JSON.parse(await readFile(new URL('../../vendor/browse/public/manifest.json',import.meta.url),'utf8'));
  if(!upstream.key)throw Error('browse upstream development manifest has no public identity key');
  manifest.key=upstream.key;
  await cp(source,destination,{recursive:true});
  loaded=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  await writeFile(join(destination,'manifest.json'),loaded);
  path=destination;
 }
 return {path,metadata:{source_path:source,source_manifest_sha256:digest(original),loaded_manifest_sha256:digest(loaded),unpacked_identity_added:path!==source,identity_source:path!==source?'vendor/browse/public/manifest.json':null}};
}
