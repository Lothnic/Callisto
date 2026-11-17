// Read text/JSON values actually returned in tool observations. browse's tab API
// wraps returned JSON with a documented tab header and optional page metadata.
// Do not search arbitrary prose for JSON or infer facts that were not observed.
function decoded(text){
 try{return JSON.parse(text);}catch{}
 const header=/^tab:\s*\d+\r?\n\r?\n/.exec(text);
 if(!header)return undefined;
 const payload=text.slice(header[0].length).split(/\r?\n\r?\n(?:Page|Console|Warnings?):/,1)[0];
 try{return JSON.parse(payload);}catch{return undefined;}
}
export function observationTextValues(value){
 if(typeof value==='string'){
  const parsed=decoded(value);
  return parsed!==undefined&&parsed!==value?[value,...observationTextValues(parsed)]:[value];
 }
 if(Array.isArray(value))return value.flatMap(observationTextValues);
 if(value&&typeof value==='object')return Object.values(value).flatMap(observationTextValues);
 return [];
}
