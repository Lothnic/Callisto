'use strict';

// Each capture belongs to a session and one explicitly shared tab. Browser-wide
// listeners are installed only after the user grants optional network access.
function createNetworkInspector(api) {
  const captures = new Map();
  let installed = false;
  let registrations = [];
  const secret = /authorization|cookie|password|passwd|secret|token|api[-_]?key|session|csrf|credential/i;
  const safeHeaders = new Set(['accept','content-type','content-length','cache-control','etag','last-modified']);
  const cleanURL = raw => {
    try {
      const url = new URL(raw); url.username = ''; url.password = ''; url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (secret.test(key)) url.searchParams.set(key,'[REDACTED]');
      return url.href.slice(0,2000);
    } catch { return '[invalid URL]'; }
  };
  function redact(value, depth = 0) {
    if (depth > 12) return '[depth limit]';
    if (Array.isArray(value)) return value.slice(0,1000).map(item => redact(item,depth+1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0,1000).map(([key,item]) => [key,secret.test(key) ? '[REDACTED]' : redact(item,depth+1)]));
    return typeof value === 'string' ? value.slice(0,4000)
      .replace(/((?:[?&]|\b)(?:[\w-]*(?:token|password|secret|api[_-]?key|session|credential|csrf)[\w-]*)=)[^&\s#"']+/gi,'$1[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer [REDACTED]') : value;
  }
  const headers = values => (values || []).slice(0,16).map(header => ({name:header.name.slice(0,80),value:safeHeaders.has(header.name.toLowerCase()) ? String(header.value || '').slice(0,200) : ['location','referer'].includes(header.name.toLowerCase()) ? cleanURL(header.value) : '[REDACTED]'}));
  function origin(raw) {
    const url = new URL(raw);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Network scope requires HTTP(S) URLs without credentials.');
    return url.origin;
  }
  function scope(details) {
    for (const capture of captures.values()) {
      if (!capture.active || capture.tabId !== details.tabId) continue;
      try { if (capture.origins.has(origin(details.url))) return capture; } catch {}
    }
    return null;
  }
  function record(capture, details) {
    if (capture.requests.has(details.requestId)) return capture.requests.get(details.requestId);
    if (capture.entries.length >= capture.limit) { capture.dropped++; return null; }
    const entry = {
      startedDateTime:new Date(details.timeStamp || Date.now()).toISOString(),time:0,
      request:{method:details.method,url:cleanURL(details.url),httpVersion:'',headers:[],queryString:[...new URL(cleanURL(details.url)).searchParams].map(([name,value])=>({name,value})),cookies:[],headersSize:-1,bodySize:-1},
      response:{status:0,statusText:'',httpVersion:'',headers:[],cookies:[],content:{size:0,mimeType:''},redirectURL:'',headersSize:-1,bodySize:-1},
      cache:{},timings:{send:0,wait:0,receive:0},
      _requestId:details.requestId,_resourceType:details.type,_frameId:details.frameId,_complete:false,
    };
    capture.entries.push(entry); capture.requests.set(details.requestId,entry);
    if (capture.bodies && details.requestBody) {
      const body = details.requestBody;
      if (body.formData && JSON.stringify(body.formData).length<=65536) entry.request.postData={mimeType:'application/x-www-form-urlencoded',params:Object.entries(redact(body.formData)).map(([name,value])=>({name,value:JSON.stringify(value)}))};
      else if (body.raw && body.raw.every(part => part.bytes) && body.raw.reduce((n,part)=>n+part.bytes.byteLength,0)<=65536) {
        try {
          const bytes=new Uint8Array(body.raw.reduce((n,part)=>n+part.bytes.byteLength,0));let offset=0;
          for(const part of body.raw){const chunk=new Uint8Array(part.bytes);bytes.set(chunk,offset);offset+=chunk.length;}
          entry.request.postData={mimeType:'application/json',text:JSON.stringify(redact(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))))};
        }
        catch { entry.request._bodyOmitted='Only bounded JSON and parsed form bodies are captured.'; }
      } else entry.request._bodyOmitted='Unsupported or oversized request body.';
    }
    if(entry.request.postData){const bytes=new TextEncoder().encode(JSON.stringify(entry.request.postData)).length;if(capture.bodyBytes+bytes<=1048576)capture.bodyBytes+=bytes;else {delete entry.request.postData;entry.request._bodyOmitted='Capture body budget reached.';}}
    return entry;
  }
  function before(details) {
    const capture = scope(details);
    if (!capture) return {};
    const entry = record(capture,details);
    const rule = capture.rules.find(rule => details.url.startsWith(rule.url_prefix) && (!rule.method || rule.method === details.method));
    if (rule) {
      if (entry) entry._interception=rule.action;
      return rule.action === 'block' ? {cancel:true} : {redirectUrl:rule.redirect_url};
    }
    if (capture.bodies && entry && ['xmlhttprequest','fetch'].includes(details.type) && api.webRequest.filterResponseData) {
      try {
        const filter = api.webRequest.filterResponseData(details.requestId);
        const chunks=[]; let bytes=0, omitted=false;
        capture.filters.set(filter,()=>{chunks.length=0;});
        filter.ondata=event=>{
          filter.write(event.data); // Always forward unchanged; capture cannot hold a response open.
          bytes+=event.data.byteLength;
          if (bytes<=65536) chunks.push(new Uint8Array(event.data)); else { omitted=true; chunks.length=0; }
        };
        filter.onstop=()=>{
          try {
            entry.response.content.size=bytes;
            if (capture.active && !omitted && capture.bodyBytes+bytes<=1048576 && /(?:application|text)\/(?:[\w.+-]*\+)?json/i.test(entry.response.content.mimeType)) {
              const all=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
              try { entry.response.content.text=JSON.stringify(redact(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all)))); capture.bodyBytes+=bytes; }
              catch { entry.response.content._bodyOmitted='Invalid JSON.'; }
            } else entry.response.content._bodyOmitted='Not JSON, capture stopped, or body limit reached.';
          } finally { chunks.length=0;capture.filters.delete(filter);filter.close(); }
        };
        filter.onerror=()=>{chunks.length=0;capture.filters.delete(filter);try{filter.disconnect();}catch{}};
      } catch { entry.response.content._bodyOmitted='Response stream unavailable.'; }
    }
    return {};
  }
  function requestHeaders(details) {
    const capture=scope(details), entry=capture?.requests.get(details.requestId);
    if(entry)entry.request.headers=headers(details.requestHeaders);
  }
  function responseHeaders(details) {
    const capture=scope(details), entry=capture?.requests.get(details.requestId);
    if(!entry)return;
    entry.response.status=details.statusCode;entry.response.headers=headers(details.responseHeaders);
    entry.response.content.mimeType=details.responseHeaders?.find(h=>h.name.toLowerCase()==='content-type')?.value || '';
  }
  function complete(details) {
    const capture=scope(details), entry=capture?.requests.get(details.requestId);
    if(!entry)return;
    entry._complete=true;
    entry.time=Math.max(0,(details.timeStamp || Date.now())-Date.parse(entry.startedDateTime));
    entry.timings.wait=entry.time;
    if(details.statusCode)entry.response.status=details.statusCode;
    if(details.error)entry._error=String(details.error).slice(0,200);
    capture.requests.delete(details.requestId);
  }
  function redirected(details) {
    responseHeaders(details);
    const capture=scope(details),entry=capture?.requests.get(details.requestId);
    if(entry)entry.response.redirectURL=cleanURL(details.redirectUrl);
    complete(details);
  }
  function install() {
    if(installed)return;
    const registered=[];
    try {
      for(const [event,listener,extra] of [
        [api.webRequest.onBeforeRequest,before,['blocking','requestBody']],
        [api.webRequest.onBeforeSendHeaders,requestHeaders,['requestHeaders']],
        [api.webRequest.onHeadersReceived,responseHeaders,['responseHeaders']],
        [api.webRequest.onBeforeRedirect,redirected,['responseHeaders']],[api.webRequest.onCompleted,complete,[]],[api.webRequest.onErrorOccurred,complete,[]],
      ]){if(extra.length)event.addListener(listener,{urls:['<all_urls>']},extra);else event.addListener(listener,{urls:['<all_urls>']});registered.push([event,listener]);}
      installed=true;
      registrations=registered;
    } catch(error){for(const [event,listener] of registered)event.removeListener(listener);throw error;}
  }
  function deactivate(capture) {
    if(!capture)return;
    capture.active=false;capture.rules=[];
    for(const [filter,clear] of capture.filters){clear();try{filter.disconnect();}catch{}}
    capture.filters.clear();capture.requests.clear();
  }
  function get(owner) { const capture=captures.get(owner);if(!capture)throw new Error('No network capture for this session.');return capture; }
  return {
    async start(owner,tabId,args) {
      if(!api.webRequest || !(await api.permissions.contains({permissions:['webRequest','webRequestBlocking'],origins:['<all_urls>']})))throw new Error('Enable network access in the extension first.');
      if(!Array.isArray(args.origins) || !args.origins.length || args.origins.length>10)throw new Error('Provide 1-10 explicit network origins.');
      const origins=new Set(args.origins.map(value=>{if(typeof value!=='string' || origin(value)!==value)throw new Error('Use exact origins without paths or trailing slashes.');return value;}));
      const limit=args.limit ?? 200;
      if(!Number.isInteger(limit) || limit<1 || limit>500)throw new Error('Network limit must be 1-500.');
      if(args.capture_bodies!==undefined && typeof args.capture_bodies!=='boolean')throw new Error('capture_bodies must be boolean.');
      install();deactivate(captures.get(owner));
      captures.set(owner,{tabId,origins,limit,bodies:args.capture_bodies===true,active:true,entries:[],requests:new Map(),filters:new Map(),rules:[],dropped:0,bodyBytes:0});
      return {active:true,tab_id:tabId,origins:[...origins],capture_bodies:args.capture_bodies===true,redaction:'credentials-and-sensitive-keys-v1'};
    },
    rules(owner,rules) {
      const capture=get(owner);
      if(!capture.active)throw new Error('Start network capture before interception.');
      if(!Array.isArray(rules) || rules.length>20)throw new Error('Provide at most 20 interception rules.');
      const checked=rules.map(rule=>{
        if(!rule || !['block','redirect'].includes(rule.action) || typeof rule.url_prefix!=='string' || rule.url_prefix.length>2000 || !capture.origins.has(origin(rule.url_prefix)))throw new Error('Rule must use block/redirect and a URL prefix in capture scope.');
        if(rule.method!==undefined && !/^[A-Z]{3,12}$/.test(rule.method))throw new Error('Invalid rule method.');
        if(rule.action==='redirect' && (typeof rule.redirect_url!=='string' || rule.redirect_url.length>2000 || !capture.origins.has(origin(rule.redirect_url))))throw new Error('Redirect target must stay inside capture scope.');
        return {action:rule.action,url_prefix:rule.url_prefix,...(rule.method?{method:rule.method}:{}),...(rule.action==='redirect'?{redirect_url:rule.redirect_url}:{})};
      });
      capture.rules=checked;return {rules:checked};
    },
    list(owner,args={}) {
      const capture=get(owner),offset=args.offset ?? 0,limit=args.limit ?? 20;
      if(!Number.isInteger(offset) || offset<0 || !Number.isInteger(limit) || limit<1 || limit>100)throw new Error('Invalid network page bounds.');
      const entries=capture.entries.slice(offset,offset+limit).map(entry=>args.include_bodies ? structuredClone(entry) : {...entry,request:{...entry.request,postData:undefined},response:{...entry.response,content:{...entry.response.content,text:undefined}}});
      return {entries,total:capture.entries.length,next_offset:offset+limit<capture.entries.length?offset+limit:null,dropped:capture.dropped,active:capture.active};
    },
    endpoints(owner) {
      const capture=get(owner),groups=new Map();
      for(const entry of capture.entries){
        const url=new URL(entry.request.url),key=entry.request.method+' '+url.origin+url.pathname;
        let group=groups.get(key);
        if(!group){group={method:entry.request.method,origin:url.origin,path:url.pathname,samples:0,query_parameters:new Set(),statuses:new Set(),mime_types:new Set(),request_fields:new Set(),response_fields:new Set()};groups.set(key,group);}
        group.samples++;group.statuses.add(entry.response.status);
        if(entry.response.content.mimeType)group.mime_types.add(entry.response.content.mimeType);
        for(const field of entry.request.queryString)group.query_parameters.add(field.name);
        for(const field of entry.request.postData?.params || [])group.request_fields.add(field.name);
        for(const [body,fields] of [[entry.request.postData?.text,group.request_fields],[entry.response.content.text,group.response_fields]]){
          try{const parsed=JSON.parse(body);if(parsed && !Array.isArray(parsed) && typeof parsed==='object')for(const field of Object.keys(parsed).slice(0,30))fields.add(field);}catch{}
        }
      }
      return {basis:'observed requests only; no inferred authentication or API guarantees',dropped:capture.dropped,endpoints:[...groups.values()].slice(0,100).map(group=>Object.fromEntries(Object.entries(group).map(([key,value])=>[key,value instanceof Set?[...value].slice(0,100):value]))),truncated:groups.size>100};
    },
    export(owner) {
      const capture=get(owner);
      return {log:{version:'1.2',creator:{name:'Callisto Firefox extension',version:'0.1.0'},entries:structuredClone(capture.entries),_capture:{active:capture.active,origins:[...capture.origins],dropped:capture.dropped,redacted:true,complete:capture.dropped===0 && capture.filters.size===0 && capture.entries.every(e=>e._complete)}}};
    },
    stop(owner){const capture=get(owner);deactivate(capture);return {active:false,count:capture.entries.length};},
    release(owner){deactivate(captures.get(owner));captures.delete(owner);},
    revoke(){for(const capture of captures.values())deactivate(capture);captures.clear();for(const [event,listener] of registrations)event.removeListener(listener);registrations=[];installed=false;},
  };
}
