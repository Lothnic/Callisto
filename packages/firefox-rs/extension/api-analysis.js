'use strict';

// Observation-derived drafts, not claims about undocumented server contracts.
function analyzeCapturedAPI(entries, action, args = {}) {
  const sensitive = /authorization|cookie|password|secret|token|api[-_]?key|session|csrf|credential/i;
  const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
  function schema(value, depth = 0) {
    if (value === undefined) return {};
    if (value === null) return {type:'null'};
    if (depth >= 4) return {type:Array.isArray(value)?'array':typeof value};
    if (Array.isArray(value)) return {type:'array',items:merge(value.slice(0,20).map(item=>schema(item,depth+1)))};
    if (typeof value === 'object') {
      const fields=Object.entries(value).filter(([key])=>!sensitive.test(key)).slice(0,30);
      return {type:'object',properties:Object.fromEntries(fields.map(([key,item])=>[key,schema(item,depth+1)])),required:fields.map(([key])=>key)};
    }
    return {type:typeof value==='number' && Number.isInteger(value)?'integer':typeof value};
  }
  function merge(shapes) {
    const unique=[...new Map(shapes.map(shape=>[JSON.stringify(shape),shape])).values()];
    return unique.length===1?unique[0]:unique.length?{anyOf:unique.slice(0,20)}:{};
  }
  const decode = entry => ({
    id:entry._captureId,method:entry.request.method,url:new URL(entry.request.url),
    request:schema(parse(entry.request.postData?.text)),response:schema(parse(entry.response.content.text)),
    query:new Map((entry.request.queryString || []).filter(q=>!sensitive.test(q.name)).map(q=>[q.name,q.value])),
  });
  if (action === 'compare') {
    const left=entries.find(e=>e._captureId===args.left),right=entries.find(e=>e._captureId===args.right);
    if(!left || !right)throw new Error('Compare requires two capture IDs from network list.');
    const a=decode(left),b=decode(right);
    return {left:a.id,right:b.id,method_changed:a.method!==b.method,path_changed:a.url.origin+a.url.pathname!==b.url.origin+b.url.pathname,
      query_changes:[...new Set([...a.query.keys(),...b.query.keys()])].filter(key=>a.query.get(key)!==b.query.get(key)).slice(0,50),
      status:{left:left.response.status,right:right.response.status},
      request_shape_changed:JSON.stringify(a.request)!==JSON.stringify(b.request),response_shape_changed:JSON.stringify(a.response)!==JSON.stringify(b.response),
      shapes:{left:{request:a.request,response:a.response},right:{request:b.request,response:b.response}},
      basis:'redacted captured values; sensitive parameters excluded'};
  }
  const groups=new Map();
  for(const entry of entries){
    const item=decode(entry),key=item.method+' '+item.url.origin+item.url.pathname;
    let group=groups.get(key);
    if(!group){group={method:item.method,origin:item.url.origin,path:item.url.pathname,entries:[],queries:new Map()};groups.set(key,group);}
    group.entries.push({entry,item});
    for(const [name,value] of item.query){if(!group.queries.has(name))group.queries.set(name,new Set());group.queries.get(name).add(value);}
  }
  const endpoints=[...groups.values()].slice(0,100).map(group=>({method:group.method,origin:group.origin,path:group.path,samples:group.entries.length,
    pagination_hints:[...group.queries].filter(([name])=>/^(page|page_size|per_page|limit|offset|cursor|after|before|next|start)$/i.test(name)).map(([name,values])=>({parameter:name,distinct_observed_values:values.size,inferred:true})),
    request_schema:merge(group.entries.map(({item})=>item.request)),response_schema:merge(group.entries.map(({item})=>item.response)),
    query_parameters:[...group.queries.keys()],statuses:[...new Set(group.entries.map(({entry})=>entry.response.status))],
  }));
  if(action==='schema')return {basis:'observed samples only; optional fields, pagination and authorization are not guaranteed',endpoints,truncated:groups.size>100};
  if(action!=='openapi')throw new Error('Unsupported API analysis action.');
  const paths={};
  for(const endpoint of endpoints){
    paths[endpoint.path] ??= {};
    const method=endpoint.method.toLowerCase();
    if(!['get','head','post','put','patch','delete','options','trace'].includes(method))continue;
    // Keep origin-specific variants explicit instead of silently merging hosts.
    const existing=paths[endpoint.path][method];
    if(existing){existing['x-origin-variants-omitted']=true;continue;}
    const statuses=endpoint.statuses.filter(status=>status>=100 && status<=599);
    paths[endpoint.path][method]={summary:'Observed '+endpoint.method+' '+endpoint.path,servers:[{url:endpoint.origin}],
      parameters:endpoint.query_parameters.map(name=>({name,in:'query',required:false,schema:{type:'string'},'x-observed-only':true})),
      responses:statuses.length?Object.fromEntries(statuses.map(status=>[String(status),{description:'Observed response',content:{'application/json':{schema:endpoint.response_schema}}}])):{default:{description:'No completed HTTP response was observed'}},
      'x-observed-samples':endpoint.samples,'x-pagination-hints':endpoint.pagination_hints,
      ...(Object.keys(endpoint.request_schema).length?{requestBody:{required:false,content:{'application/json':{schema:endpoint.request_schema}}}}:{}),
    };
  }
  return {openapi:'3.1.0',info:{title:'Captured endpoints — draft',version:'0.0.0',description:'Observation-derived draft. No authorization or complete server contract is inferred.'},paths,'x-truncated':groups.size>100};
}
