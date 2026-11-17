import {createInterface} from 'node:readline';
const send=message=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
const lines=createInterface({input:process.stdin});
for await(const line of lines){
  let message;try{message=JSON.parse(line);}catch{continue;}
  if(message.method==='initialize')send({id:message.id,result:{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'preflight-echo',version:'1'}}});
  else if(message.method==='tools/list')send({id:message.id,result:{tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]}});
  else if(message.method==='tools/call'){const text=String(message.params.arguments?.text??'');send({id:message.id,result:{content:[{type:'text',text:'ECHO:'+text}],isError:false}});}
  else if(message.method==='ping')send({id:message.id,result:{}});
  else if(message.method?.startsWith('notifications/')){}
  else if(message.id!==undefined)send({id:message.id,error:{code:-32601,message:'unsupported '+message.method}});
}
