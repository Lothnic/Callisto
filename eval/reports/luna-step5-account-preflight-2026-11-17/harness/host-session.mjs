// Keep the extension's sharing lease on one real MCP client while a host connects.
import {createServer} from 'node:http';
import {chmod,rm} from 'node:fs/promises';
export class HostSession {
 constructor(client,tools,{maxCalls=40,preserveInitialization=false}={}){this.preserveInitialization=preserveInitialization;this.client=client;this.tools=tools;this.maxCalls=maxCalls;this.events=[];this.closed=false;this.calls=0;this.pending=new Set();}
 async start(path){
  this.path=path;this.server=createServer(async(req,res)=>{
   let message;try{
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error('MCP request too large');chunks.push(chunk);}message=JSON.parse(Buffer.concat(chunks));
    const dispatch=this.dispatch(message);this.pending.add(dispatch);let result;try{result=await dispatch;}finally{this.pending.delete(dispatch);}res.setHeader('Content-Type','application/json');res.end(message.id===undefined?'':JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
   }catch(error){res.end(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:-32000,message:error.message}}));}
  });await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(path,resolve);});await chmod(path,0o600);return this;
 }
 async dispatch(message){
  if(message.method==='initialize'){this.hostInfo=message.params.clientInfo;const native=this.preserveInitialization?this.client.initialization:null;if(native&&!this.client.clientInfo)throw Error('Native client identity must be recorded before host setup');if(native&&this.client.clientInfo.name!==this.hostInfo?.name)throw Error('Host identity differs from the initialized native client; recreate the owned client with the real host identity');return {...(native||{}),protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:native?.serverInfo||{name:'owned-native-browser-session',version:'1'}};}
  if(message.method==='tools/list')return {tools:this.tools};
  if(message.method==='ping')return {};
  if(message.method==='resources/list')return {resources:[]};
  if(message.method==='resources/templates/list')return {resourceTemplates:[]};
  if(message.method==='prompts/list')return {prompts:[]};
  if(message.method.startsWith('notifications/'))return {};
  if(message.method!=='tools/call')throw Error('Unsupported MCP method');
  if(this.closed)throw Error('Benchmark session closed');
  if(!this.tools.some(t=>t.name===message.params.name))throw Error('Tool outside benchmark catalog');
  if(this.calls++>=this.maxCalls)throw Error('Benchmark tool-call budget reached');
  const event={sequence:this.events.length+1,name:message.params.name,arguments:message.params.arguments,started_at:new Date().toISOString()};this.events.push(event);const started=performance.now();
  try{event.result=await this.client.callTool(message.params,{timeout:45000});event.failed=event.result.isError===true;return event.result;}
  catch(error){event.failed=true;event.result={isError:true,content:[{type:'text',text:error.message}]};return event.result;}
  finally{event.elapsed_ms=performance.now()-started;event.response_bytes=Buffer.byteLength(JSON.stringify(event.result));}
 }
 async close(){this.closed=true;if(this.server){this.server.closeAllConnections();const closed=new Promise(resolve=>this.server.close(resolve));await Promise.allSettled([...this.pending]);await closed;}if(this.path)await rm(this.path,{force:true});}
}
