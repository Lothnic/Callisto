// Conservative transcript checks, not a JavaScript sandbox or proof against obfuscation.
const directAccess=/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\bsendBeacon\s*\(|\b(?:request|files)\s*\.\s*(?:get|post|read|write)\s*\(|\brequire\s*\(|\bimport\s*\(/;
export function policyViolations(events){
 const violations=[];
 for(const event of events){
  const args=event.arguments||{},op=event.name==='callisto'?args.op:event.name?.replace(/^callisto_/,''),input=event.name==='callisto'?(args.args||{}):args;
  if((event.name==='execute'||event.name==='eval')&&directAccess.test(args.code||args.expression||''))violations.push({sequence:event.sequence,reason:'direct network/file code'});
  if(op==='network'&&input.action==='replay')violations.push({sequence:event.sequence,reason:'direct API replay'});
  if(op==='webmcp')violations.push({sequence:event.sequence,reason:'page API tools outside the public-read task contract'});
  if(op==='trace'&&input.action==='start')violations.push({sequence:event.sequence,reason:'agent file output'});
  if(op==='input'&&input.action!=='status')violations.push({sequence:event.sequence,reason:'agent changed the declared input mode'});
 }
 return violations;
}
