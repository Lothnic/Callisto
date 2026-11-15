const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function fixture(allowed=true){
  const event=()=>({addListener(fn){this.listener=fn;},removeListener(){delete this.listener;}});
  const filters=[];
  const api={permissions:{contains:async()=>allowed},webRequest:{}};
  for(const name of ['onBeforeRequest','onBeforeSendHeaders','onHeadersReceived','onBeforeRedirect','onCompleted','onErrorOccurred'])api.webRequest[name]=event();
  api.webRequest.filterResponseData=()=>{const filter={written:[],write(data){this.written.push(data);},close(){this.closed=true;},disconnect(){this.disconnected=true;}};filters.push(filter);return filter;};
  const context=vm.createContext({URL,TextEncoder,TextDecoder,structuredClone});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/api-analysis.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/network.js'),'utf8'),context);
  const inspector=context.createNetworkInspector(api);
  const emit=(name,details)=>api.webRequest[name].listener(details);
  const request=(extra={})=>({requestId:'req1',tabId:42,frameId:0,url:'https://fixture.test/api',method:'GET',type:'xmlhttprequest',timeStamp:Date.now(),...extra});
  return {api,inspector,filters,emit,request};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('network capture requires explicit permission and exact origins',async()=>{
  const denied=fixture(false);await assert.rejects(denied.inspector.start({},42,{origins:['https://fixture.test']}),/Enable network access/);
  const {inspector}=fixture();
  for(const origins of [[],['*'],['https://fixture.test/'],['https://user:pass@fixture.test'],['file:///tmp']])await assert.rejects(inspector.start({},42,{origins}),/origin|scope|HTTP|URL/);
});

test('capture is scoped by owner, shared tab and origin; credentials are redacted',async()=>{
  const {inspector,emit,request,filters}=fixture();const owner={};
  await inspector.start(owner,42,{origins:['https://fixture.test'],capture_bodies:true});
  emit('onBeforeRequest',request({tabId:43}));emit('onBeforeRequest',request({url:'https://other.test/api'}));
  assert.equal(inspector.list(owner).total,0);
  const details=request({url:'https://fixture.test/api?page=2&token=hidden-token',method:'POST',requestBody:{raw:[{bytes:new TextEncoder().encode(JSON.stringify({query:'orders',password:'hidden-password'})).buffer}]}});
  emit('onBeforeRequest',details);
  emit('onBeforeSendHeaders',{...details,requestHeaders:[{name:'Authorization',value:'Bearer hidden-auth'},{name:'Cookie',value:'login=hidden-cookie'},{name:'Content-Type',value:'application/json'}]});
  emit('onHeadersReceived',{...details,statusCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Set-Cookie',value:'hidden-setcookie'}]});
  const bytes=new TextEncoder().encode(JSON.stringify({orders:[1,2],access_token:'hidden-response-token'})).buffer;
  filters[0].ondata({data:bytes});filters[0].onstop();emit('onCompleted',{...details,statusCode:200});
  assert.equal(filters[0].written[0],bytes);assert.equal(filters[0].closed,true);
  const har=inspector.export(owner),serialized=JSON.stringify(har);
  for(const secret of ['hidden-token','hidden-password','hidden-auth','hidden-cookie','hidden-setcookie','hidden-response-token'])assert(!serialized.includes(secret),secret);
  assert(serialized.includes('orders'));assert.equal(har.log.entries[0].response.status,200);
  assert.equal(har.log._capture.complete,true);
  assert.equal(inspector.list(owner).entries[0].response.content.text,undefined);
  assert(inspector.list(owner,{include_bodies:true}).entries[0].response.content.text);
  assert.throws(()=>inspector.list({}),/No network capture/);
  const endpoints=inspector.endpoints(owner).endpoints;
  assert.equal(endpoints[0].path,'/api');assert.deepEqual(plain(endpoints[0].query_parameters),['page','token']);
  assert(endpoints[0].response_fields.includes('orders'));assert(!JSON.stringify(endpoints).includes('hidden-'));
});

test('declarative interception stays in scope and disappears on stop or release',async()=>{
  const {inspector,emit,request}=fixture();const owner={};
  await inspector.start(owner,42,{origins:['https://fixture.test']});
  assert.throws(()=>inspector.rules(owner,[{action:'redirect',url_prefix:'https://fixture.test/api',redirect_url:'https://elsewhere.test/api'}]),/inside capture scope/);
  inspector.rules(owner,[{action:'block',url_prefix:'https://fixture.test/api',method:'GET'}]);
  assert.deepEqual(plain(emit('onBeforeRequest',request())),{cancel:true});
  assert.deepEqual(plain(emit('onBeforeRequest',request({tabId:7}))),{});
  inspector.rules(owner,[{action:'redirect',url_prefix:'https://fixture.test/old',redirect_url:'https://fixture.test/new'}]);
  assert.deepEqual(plain(emit('onBeforeRequest',request({requestId:'redirect',url:'https://fixture.test/old'}))),{redirectUrl:'https://fixture.test/new'});
  inspector.stop(owner);
  assert.deepEqual(plain(emit('onBeforeRequest',request())),{});
  assert.equal(inspector.export(owner).log._capture.active,false);
  inspector.release(owner);assert.throws(()=>inspector.export(owner),/No network capture/);
});

test('limits report dropped requests and stopping disconnects outstanding streams',async()=>{
  const {inspector,emit,request,filters}=fixture();const owner={};
  await inspector.start(owner,42,{origins:['https://fixture.test'],limit:1,capture_bodies:true});
  emit('onBeforeRequest',request());emit('onBeforeRequest',request({requestId:'req2'}));
  assert.equal(inspector.list(owner).total,1);assert.equal(inspector.list(owner).dropped,1);
  inspector.stop(owner);assert(filters[0].disconnected);assert.equal(inspector.export(owner).log._capture.complete,false);
});

test('redirect hops remain distinct HAR entries even when the request ID is reused',async()=>{
  const {inspector,emit,request}=fixture();const owner={};await inspector.start(owner,42,{origins:['https://fixture.test']});
  emit('onBeforeRequest',request());emit('onBeforeRedirect',request({statusCode:302,redirectUrl:'https://fixture.test/new'}));
  emit('onBeforeRequest',request({url:'https://fixture.test/new'}));emit('onCompleted',request({url:'https://fixture.test/new',statusCode:200}));
  const entries=inspector.export(owner).log.entries;
  assert.equal(entries.length,2);assert.equal(entries[0].response.status,302);assert.equal(entries[0].response.redirectURL,'https://fixture.test/new');assert.equal(entries[1].response.status,200);
});

test('permission revocation removes listeners and a later explicit capture reinstalls them',async()=>{
  const {api,inspector,emit,request}=fixture();const owner={};await inspector.start(owner,42,{origins:['https://fixture.test']});
  inspector.revoke();assert.equal(api.webRequest.onBeforeRequest.listener,undefined);
  await inspector.start(owner,42,{origins:['https://fixture.test']});emit('onBeforeRequest',request());assert.equal(inspector.list(owner).total,1);
});

test('request JSON preserves UTF-8 split across upload chunks',async()=>{
  const {inspector,emit,request}=fixture();const owner={};await inspector.start(owner,42,{origins:['https://fixture.test'],capture_bodies:true});
  const bytes=new TextEncoder().encode(JSON.stringify({label:'\u20ac'}));
  const index=bytes.indexOf(0xe2)+1;
  emit('onBeforeRequest',request({method:'POST',requestBody:{raw:[{bytes:bytes.slice(0,index).buffer},{bytes:bytes.slice(index).buffer}]}}));
  const body=inspector.list(owner,{include_bodies:true}).entries[0].request.postData.text;
  assert.equal(JSON.parse(body).label,'\u20ac');
});

test('API analysis compares observations and exports drafts without credential fields',async()=>{
  const {inspector,emit,request,filters}=fixture();const owner={};await inspector.start(owner,42,{origins:['https://fixture.test'],capture_bodies:true});
  for(let page=1;page<=2;page++){
    const details=request({requestId:String(page),url:`https://fixture.test/items?page=${page}&token=hidden`});emit('onBeforeRequest',details);
    emit('onHeadersReceived',{...details,statusCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}]});
    filters.at(-1).ondata({data:new TextEncoder().encode(JSON.stringify({items:[{id:page,name:'private value'}],token:'hidden'})).buffer});filters.at(-1).onstop();emit('onCompleted',{...details,statusCode:200});
  }
  const comparison=inspector.analyze(owner,{action:'compare',left:'net-1',right:'net-2'});assert.deepEqual(plain(comparison.query_changes),['page']);
  const draft=inspector.analyze(owner,{action:'openapi'});assert.equal(draft.openapi,'3.1.0');assert(draft.paths['/items'].get['x-pagination-hints'].length);
  assert(!JSON.stringify(draft).includes('private value'));assert(!JSON.stringify(draft).includes('token'));
  assert.throws(()=>inspector.replayScope(owner,{method:'POST',url:'https://fixture.test/items'}),/GET\/HEAD/);
  assert.throws(()=>inspector.replayScope(owner,{url:'https://other.test/items'}),/capture origins/);
  assert.throws(()=>inspector.replayScope(owner,{url:'https://fixture.test/items',headers:{Authorization:'secret'}}),/overrides/);
  assert.equal(inspector.replayScope(owner,{url:'https://fixture.test/items'}).method,'GET');
});

test('response streams finishing before header delivery retain bounded JSON',async()=>{
  const {inspector,emit,request,filters}=fixture();const owner={};
  await inspector.start(owner,42,{origins:['https://fixture.test'],capture_bodies:true});
  const details=request();emit('onBeforeRequest',details);
  const bytes=new TextEncoder().encode('{"items":[1],"token":"private"}');
  filters[0].ondata({data:bytes.buffer});filters[0].onstop();
  assert.equal(filters[0].closed,true);
  assert.equal(inspector.export(owner).log._capture.complete,false);
  emit('onHeadersReceived',{...details,statusCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}]});
  emit('onCompleted',{...details,statusCode:200});
  const har=inspector.export(owner);
  assert.deepEqual(JSON.parse(har.log.entries[0].response.content.text),{items:[1],token:'[REDACTED]'});
  assert.equal(har.log._capture.complete,true);
});
