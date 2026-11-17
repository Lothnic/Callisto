// Transparent stdio MCP transport to the owned benchmark session. No model logic.
import {request} from 'node:http';
import {createInterface} from 'node:readline';
const socketPath=process.argv[2];if(!socketPath)throw Error('Private benchmark socket required');
for await(const line of createInterface({input:process.stdin})){
 let message;try{message=JSON.parse(line);}catch{continue;}
 void new Promise(resolve=>{
  const call=request({socketPath,path:'/',method:'POST',headers:{'Content-Type':'application/json'}},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.on('end',()=>{if(message.id!==undefined&&body)process.stdout.write(body+'\n');resolve();});});
  call.on('error',()=>{if(message.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'Benchmark transport disconnected; uncertain actions are not replayed'}})+'\n');resolve();});
  call.end(JSON.stringify(message));
 });
}
