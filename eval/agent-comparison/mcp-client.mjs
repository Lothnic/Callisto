import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
export class MCPClient {
 constructor(command,args=[],env=process.env){this.sequence=0;this.pending=new Map();this.child=spawn(command,args,{env,stdio:['pipe','pipe','pipe']});this.child.stderr.on('data',()=>{});
  createInterface({input:this.child.stdout}).on('line',line=>{let reply;try{reply=JSON.parse(line);}catch{return;}const item=this.pending.get(reply.id);if(item){clearTimeout(item.timer);this.pending.delete(reply.id);reply.error?item.reject(Error(reply.error.message)):item.resolve(reply.result);}});
  this.child.on('exit',()=>{for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('MCP process exited'));}this.pending.clear();});
 }
 request(method,params={},options={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}})+'\n');reject(Error('MCP request deadline'));},options.timeout??45000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');if(options.cancelAfter)setTimeout(()=>this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}})+'\n'),options.cancelAfter);});}
 callTool(params,options={}){return this.request('tools/call',params,options);}
 async initialize({name='callisto-validation',version='1'}={}){this.clientInfo={name,version};this.initialization=await this.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:this.clientInfo});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return this;}
 async close(){this.child.stdin.end();await Promise.race([new Promise(r=>this.child.once('exit',r)),new Promise(r=>setTimeout(()=>{this.child.kill();r();},3000))]);}
}
