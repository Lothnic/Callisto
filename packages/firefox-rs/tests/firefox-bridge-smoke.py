"""Disposable Firefox smoke test. Set GECKODRIVER_URL to a running test driver.

The test-only extension adds <all_urls> and automatically shares the fixture;
it does not verify the production extension's activeTab toolbar gesture.
"""
import tempfile
import html,urllib.parse
import base64,io,json,os,subprocess,threading,time,urllib.request,zipfile,http.server,socketserver
from pathlib import Path
ROOT=str(Path(__file__).resolve().parent.parent)+'/'
DRIVER=os.environ.get('GECKODRIVER_URL', 'http://127.0.0.1:4444').rstrip('/')
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  data=b'<h1>Callisto test</h1><label for="field">Name</label><input id="field"><p>Visible fixture text</p><label for="check">Accept</label><input id="check" type="checkbox"><label for="choice">Choice</label><select id="choice"><option value="a">A</option><option value="b">B</option></select><button id="send" onclick="document.title=\"done\"">Send</button>'
  if self.path.startswith('/frame'):
   data=b'<h1>Frame host</h1><iframe src="/inner" title="Fixture child"></iframe>'
  elif self.path.startswith('/inner'):
   data=b'<button onclick="window.frameClicked=true">Inside frame</button>'
  elif self.path.startswith('/slow-image'):
   time.sleep(5);data=b''
  elif self.path.startswith('/search'):
   data=b'<title>Research form</title><form action="/results"><label>Research <input type="search" name="q" required></label><button type="submit">Search</button></form><img src="/slow-image">'
  elif self.path.startswith('/results'):
   query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('q',[''])[0]
   data=('<h1>Results '+html.escape(query)+'</h1>').encode()
  elif self.path.startswith('/async-grid'):
   data=b'''<div class="row">Page A</div><button id="next" onclick="setTimeout(()=>{document.querySelector('.row').textContent='Page B';this.disabled=true},700)">Next</button>'''
  elif self.path.startswith('/animated'):
   data=b'<button id="moving" style="position:relative" onclick="window.clicks=(window.clicks||0)+1">Moving action</button>'
  elif self.path.startswith('/stuck-grid'):
   data=b'<div class="row">Same</div><button id="next">Next</button>'
  elif self.path.startswith('/grid'):
   page=int(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('page',['1'])[0])
   rows=''.join('<tr><td>F%d</td><td>%d</td></tr>'%(n,n*10) for n in range((page-1)*3+1,(page-1)*3+4))
   more='<a class="next" href="/grid?page=%d">Next</a>'%(page+1) if page<2 else '<span class="next disabled">Next</span>'
   data=('<title>Grid page %d</title><h1>Orders</h1><table id="grid"><tbody>%s</tbody></table>%s'%(page,rows,more)).encode()
  data+=b'<input type="file" aria-label="Attachment">'
  self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def log_message(self,*args): pass
socketserver.ThreadingTCPServer.daemon_threads=True
server=socketserver.ThreadingTCPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
def req(path,data=None,method=None):
 request=urllib.request.Request(DRIVER+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'},method=method)
 with urllib.request.urlopen(request,timeout=40) as response: return json.load(response)['value']
state=tempfile.TemporaryDirectory(prefix='callisto-relay-')
env=dict(os.environ,CALLISTO_FIREFOX_STATE_DIR=state.name)
def client(): return subprocess.Popen([ROOT+'target/debug/callisto-firefox-tab-mcp'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env=env)
p=client()
def tool(name,args={}):
 p.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args}})+'\n');p.stdin.flush();reply=json.loads(p.stdout.readline());return reply.get('result',{'isError':True,'content':[{'type':'text','text':str(reply.get('error'))}]})
def value(result):
 if result.get('isError'): raise Exception(result)
 return json.loads(result['content'][0]['text'])
session=None
try:
 pair=value(tool('callisto_pair'))['code']
 session=req('/session',{'capabilities':{'alwaysMatch':{'browserName':'firefox','moz:firefoxOptions':{'args':['-headless'],'prefs':{'privacy.userContext.enabled':True}}}}})['sessionId']
 req('/session/'+session+'/url',{'url':'http://127.0.0.1:'+str(server.server_address[1])+'/'})
 out=io.BytesIO()
 with zipfile.ZipFile(out,'w') as z:
  for name in os.listdir(ROOT+'extension'):
   data=open(ROOT+'extension/'+name,'rb').read()
   if name=='manifest.json':
    manifest=json.loads(data);manifest['permissions']=list(dict.fromkeys(manifest['permissions']+['<all_urls>','tabs','cookies','bookmarks','history','downloads']));data=json.dumps(manifest).encode()
   if name=='background.js': data+=('\nsetTimeout(async () => { try { await browser.storage.local.set({callistoAgentContainersEnabled:true}); await pair('+json.dumps(pair)+'); await share(); } catch(e) { console.error(e); } }, 1000);').encode()
   z.writestr(name,data)
 req('/session/'+session+'/moz/addon/install',{'addon':base64.b64encode(out.getvalue()).decode(),'temporary':True})
 for i in range(30):
  status=value(tool('callisto_status'))
  if status.get('sharing'): break
  time.sleep(.3)
 print('status:',status)
 if not status.get('sharing'): raise Exception('not sharing')
 snapshot=value(tool('callisto_snapshot'));print('snapshot:',snapshot['text'])
 import re
 ref=re.search(r'\[(ax-\d+)\] textbox "Name"',snapshot['text']).group(1)
 req('/session/'+session+'/execute/sync',{'script':'window.callistoEvents=[];document.addEventListener("input",e=>window.callistoEvents.push({type:e.type,trusted:e.isTrusted}),true);document.addEventListener("keydown",e=>window.callistoEvents.push({type:e.type,trusted:e.isTrusted}),true);','args':[]})
 assert value(tool('callisto_fill',{'ref':ref,'value':'hello'}))['completed']
 actual=req('/session/'+session+'/execute/sync',{'script':'return document.querySelector("#field").value','args':[]})
 assert actual == 'hello', actual
 assert value(tool('callisto_press',{'key':'a'}))['completed']
 events=req('/session/'+session+'/execute/sync',{'script':'return window.callistoEvents','args':[]})
 assert {'type':'input','trusted':False} in events and {'type':'keydown','trusted':False} in events,events
 req('/session/'+session+'/execute/sync',{'script':'window.callistoEvents=[];document.querySelector("#field").focus();','args':[]})
 req('/session/'+session+'/actions',{'actions':[{'type':'key','id':'keyboard','actions':[{'type':'keyDown','value':'x'},{'type':'keyUp','value':'x'}]}]})
 native=req('/session/'+session+'/execute/sync',{'script':'return {events:window.callistoEvents,value:document.querySelector("#field").value}','args':[]})
 assert {'type':'input','trusted':True} in native['events'] and {'type':'keydown','trusted':True} in native['events'],native
 assert 'x' in native['value'],native
 print('WebDriver browser-mediated keys produce trusted events in disposable Firefox: verified')
 print('fill: verified in Firefox')
 upload_ref=re.search(r'\[(ax-\d+)\] textbox "Attachment"',snapshot['text']).group(1)
 upload_path=Path(state.name)/'fixture.bin';upload_path.write_bytes(bytes([0,1,255]))
 assert value(tool('callisto_upload',{'ref':upload_ref,'paths':[str(upload_path)]}))['completed']
 assert req('/session/'+session+'/execute/sync',{'script':'const f=document.querySelector("input[type=file]").files[0];return [f.name,f.size];','args':[]})==['fixture.bin',3]
 print('local binary file upload into Firefox input: verified')
 p.stdin.close(); p.wait(timeout=10)
 p=client()
 assert value(tool('callisto_pair'))['code'] == pair
 assert value(tool('callisto_status'))['connected']
 caps=value(tool('callisto_capabilities'))
 assert caps['extensionConnected'] and all(caps['capabilities'][feature] for feature in ['run','extract','snapshotPagination','runFormControls','selectorWait']),caps
 assert caps['capabilities']['run'] and caps['capabilities']['extract'],caps
 for i in range(100):
  if not value(tool('callisto_status'))['sharing']: break
  time.sleep(.01)
 assert not value(tool('callisto_status'))['sharing']
 tabs=value(tool('callisto_browser',{'action':'tabs_list'}))['tabs']
 value(tool('callisto_browser',{'action':'tab_select','tab_id':next(tab['id'] for tab in tabs if tab['active'])}))
 snapshot=value(tool('callisto_snapshot'))
 print('new MCP client reuses pairing and explicitly reacquires the released tab: verified')
 check=re.search(r'\[(ax-\d+)\] checkbox "Accept"',snapshot['text']).group(1)
 choice=re.search(r'\[(ax-\d+)\] combobox "Choice"',snapshot['text']).group(1)
 assert value(tool('callisto_page',{'action':'check','ref':check,'checked':True}))['completed']
 assert value(tool('callisto_page',{'action':'select','ref':choice,'value':'b'}))['completed']
 assert req('/session/'+session+'/execute/sync',{'script':'return document.querySelector("#check").checked && document.querySelector("#choice").value === "b"','args':[]})
 assert value(tool('callisto_page',{'action':'find','query':'Visible fixture'}))['matches']
 assert value(tool('callisto_find',{'query':'Visible fixture','max_matches':1}))['matches']
 assert value(tool('callisto_scroll',{'delta_y':50}))['completed']
 assert 'Visible fixture' in value(tool('callisto_page',{'action':'text'}))['text']
 print('check, select, text and find: verified in Firefox')
 req('/session/'+session+'/execute/sync',{'script':'''document.body.insertAdjacentHTML('afterbegin','<form id="batched"><label>Search <input name="query"></label><button type="submit">Submit query</button></form>');document.querySelector('#batched').onsubmit=e=>{e.preventDefault();setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<div id="ready-row">'+'Ready '.repeat(60)+'</div>'),100)};''','args':[]})
 batched=value(tool('callisto_run',{'steps':[
  {'action':'select_role','role':'combobox','name':'Choice','value':'a'},
  {'action':'check_role','role':'checkbox','name':'Accept','checked':False},
  {'action':'fill_role','role':'textbox','name':'Search','value':'Zen workflow'},
  {'action':'submit_role','role':'textbox','name':'Search'},
  {'action':'wait_for','selector':'#ready-row','state':'visible','timeout_ms':2000},
  {'action':'wait_for','text':('Ready '*60).strip(),'timeout_ms':2000},
  {'action':'extract','spec':{'selector':'#ready-row','fields':{'result':{}}}},
 ]}))
 assert batched['completed']==7 and batched['extraction']['count']==1,batched
 assert req('/session/'+session+'/execute/sync',{'script':'return !document.querySelector("#check").checked && document.querySelector("#choice").value === "a"','args':[]})
 print('seven-step form submission, selector/text waits and extraction in one MCP call: verified in Firefox')
 tabs=value(tool('callisto_browser',{'action':'tabs_list'}))['tabs']
 assert any(t.get('url','').startswith('http://127.0.0.1:') for t in tabs)
 shot=tool('callisto_browser',{'action':'screenshot'})
 assert shot['content'][0]['type'] == 'image', shot
 shot=tool('callisto_screenshot')
 assert shot['content'][0]['type'] == 'image' and shot['content'][0]['mimeType']=='image/jpeg', shot
 base='http://127.0.0.1:'+str(server.server_address[1])+'/'
 value(tool('callisto_browser',{'action':'cookie_set','url':base,'name':'callisto-test','value':'ok'}))
 cookies=value(tool('callisto_browser',{'action':'cookies_list','url':base}))
 assert any(c['name']=='callisto-test' and c['value']=='ok' for c in cookies)
 value(tool('callisto_browser',{'action':'cookie_remove','url':base,'name':'callisto-test'}))
 assert isinstance(value(tool('callisto_browser',{'action':'bookmarks_search','query':'fixture'})),list)
 assert isinstance(value(tool('callisto_browser',{'action':'history_search','query':'127.0.0.1'})),list)
 assert isinstance(value(tool('callisto_browser',{'action':'downloads_search','query':'fixture'})),list)
 print('browser tab discovery, screenshot, cookies and read APIs: verified in Firefox')
 target='http://127.0.0.1:'+str(server.server_address[1])+'/second'
 assert value(tool('callisto_navigate',{'url':target}))['navigationStarted']
 for i in range(50):
  current=req('/session/'+session+'/url')
  status=value(tool('callisto_status'))
  if current == target and status.get('ready'): break
  time.sleep(.1)
 assert current == target and status.get('ready'), (current,status)
 assert value(tool('callisto_snapshot'))['url'] == target
 print('navigation and reattachment: verified in Firefox')
 original=next(t['id'] for t in value(tool('callisto_browser',{'action':'tabs_list'}))['tabs'] if t.get('url')==target)
 created=value(tool('callisto_browser',{'action':'tab_create','url':target+'?new=1'}))
 value(tool('callisto_browser',{'action':'tab_select','tab_id':created['id']}))
 assert value(tool('callisto_snapshot'))['url'] == target+'?new=1'
 value(tool('callisto_browser',{'action':'tab_close','tab_id':created['id']}))
 value(tool('callisto_browser',{'action':'tab_select','tab_id':original}))
 print('tab creation, selection, closing and return: verified in Firefox')
 primary=p;other=client()
 try:
  p=other
  second=value(tool('callisto_browser',{'action':'tab_create','url':target+'?other=1'}))
  value(tool('callisto_browser',{'action':'tab_select','tab_id':second['id']}))
  blocked=tool('callisto_browser',{'action':'tab_select','tab_id':original})
  assert blocked.get('isError') and 'owned by another agent' in str(blocked),blocked
  blocked_close=tool('callisto_browser',{'action':'tab_close','tab_id':original})
  assert blocked_close.get('isError'),blocked_close
  p=primary
  assert value(tool('callisto_status'))['sharing']
  value(tool('callisto_browser',{'action':'tab_select','tab_id':original}))
  assert value(tool('callisto_snapshot'))['url']==target
  p=other
  value(tool('callisto_close'))
  value(tool('callisto_browser',{'action':'tab_close','tab_id':second['id']}))
 finally:
  other.stdin.close();other.wait(timeout=10);p=primary
 assert value(tool('callisto_status'))['sharing']
 print('independent MCP clients keep tab ownership; cross-agent selection and close are refused: verified')
 value(tool('callisto_navigate',{'url':base+'frame'}))
 value(tool('callisto_snapshot'))
 frame=None
 for i in range(100):
  frame=next((f for f in value(tool('callisto_frames'))['frames'] if f['url'].endswith('/inner')),None)
  if frame:break
  time.sleep(.05)
 assert frame,'Missing child frame'
 child_snapshot=value(tool('callisto_frame',{'frame_id':frame['frameId']}))['snapshot']
 frame_match=re.search(r'\[(ax-\d+)\] button "Inside frame"',child_snapshot['text'])
 assert frame_match,(frame,child_snapshot)
 frame_ref=frame_match.group(1)
 assert value(tool('callisto_click',{'ref':frame_ref}))['completed']
 assert req('/session/'+session+'/execute/sync',{'script':'return document.querySelector("iframe").contentWindow.frameClicked','args':[]})
 req('/session/'+session+'/execute/sync',{'script':'const f=document.querySelector("iframe"),r=f.getBoundingClientRect(),c=document.createElement("div");c.id="cover";c.style.cssText=`position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:red;z-index:999`;document.body.append(c);','args':[]})
 assert tool('callisto_click',{'ref':frame_ref}).get('isError')
 req('/session/'+session+'/execute/sync',{'script':'document.querySelector("#cover").remove()','args':[]})
 value(tool('callisto_frame',{'frame_id':0}))
 value(tool('callisto_navigate',{'url':target}))
 value(tool('callisto_snapshot'))
 print('explicit same-origin frame selection, input and parent-overlay rejection: verified in Firefox')
 started=time.perf_counter()
 batch=value(tool('callisto_batch',{'actions':[{'action':'navigate','url':base+'search'},{'action':'fill_role','role':'searchbox','name':'Research','value':'Zen workflow'},{'action':'submit_role','role':'searchbox','name':'Research'}]}))
 elapsed=time.perf_counter()-started
 assert batch['completed']==3 and 'Results Zen workflow' in batch['snapshot']['text'],batch
 assert elapsed<4,('Waited for slow resource instead of DOM readiness',elapsed)
 print('search form batch across navigation before 5-second image load: verified',round(elapsed*1000),'ms')
 value(tool('callisto_navigate',{'url':base+'grid'}))
 extracted=value(tool('callisto_extract',{'selector':'#grid tbody tr','fields':{'name':'td:nth-child(1)','total':{'selector':'td:nth-child(2)','type':'number'}},'paginate':{'next':'a.next','max_pages':3}}))
 assert extracted['count']==6 and extracted['pages']==2,(extracted,)
 assert extracted['rows'][0]=={'name':'F1','total':10} and extracted['rows'][-1]=={'name':'F6','total':60},extracted
 scripted=value(tool('callisto_run',{'steps':[{'action':'navigate','url':base+'grid'},{'action':'wait_for','text':'Orders'},{'action':'extract','spec':{'selector':'#grid tbody tr','fields':{'name':'td:nth-child(1)'}}}]}))
 assert scripted['completed']==3 and scripted['extraction']['count']==3,scripted
 assert 'snapshot' not in scripted
 limited=value(tool('callisto_extract',{'selector':'#grid tbody tr','fields':{'name':'td:nth-child(1)'},'limit':2}))
 assert limited['count']==2 and limited['truncated'],limited
 value(tool('callisto_navigate',{'url':base+'async-grid'}))
 result=value(tool('callisto_extract',{'selector':'.row','fields':{'value':{}},'paginate':{'next':'#next','max_pages':2}}))
 assert result['rows']==[{'value':'Page A'},{'value':'Page B'}] and not result['truncated'],result
 value(tool('callisto_navigate',{'url':base+'async-grid'}))
 result=value(tool('callisto_extract',{'selector':'.row','fields':{'value':{}},'paginate':{'next':'#next','max_pages':1}}))
 assert result['truncated'],result
 value(tool('callisto_navigate',{'url':base+'stuck-grid'}))
 result=tool('callisto_extract',{'selector':'.row','fields':{'value':{}},'paginate':{'next':'#next','max_pages':2}})
 assert result.get('isError') and 'did not produce a stable' in str(result),result
 print('structured extraction across pager and scripted run: verified in Firefox')
 value(tool('callisto_navigate',{'url':base+'animated'}))
 value(tool('callisto_snapshot'))
 req('/session/'+session+'/execute/sync',{'script':'''const el=document.querySelector('#moving'),start=performance.now();const timer=setInterval(()=>el.style.left=(performance.now()-start)/2+'px',10);setTimeout(()=>clearInterval(timer),220);''','args':[]})
 animated=value(tool('callisto_run',{'steps':[{'action':'click_role','role':'button','name':'Moving action'}]}))
 assert animated['completed']==1 and req('/session/'+session+'/execute/sync',{'script':'return window.clicks','args':[]})==1,animated
 print('moving target settles in one call with exactly one click: verified in Firefox')
 req('/session/'+session+'/execute/sync',{'script':'''const box=document.createElement('div');box.id='snapshot-fixture';box.innerHTML=Array.from({length:450},(_,i)=>'<button>Extra '+i+'</button>').join('');document.body.append(box);''','args':[]})
 compact=value(tool('callisto_snapshot',{'max_chars':1000}))
 assert compact['truncated'] and len(compact['text'])<=1000,compact
 offset=compact['next_offset'];found=False
 while offset is not None:
  portion=value(tool('callisto_snapshot',{'offset':offset,'max_chars':30000}))
  found=found or 'Extra 449' in portion['text'];offset=portion['next_offset']
 assert found,'Last control was not reachable through snapshot pagination'
 req('/session/'+session+'/execute/sync',{'script':'document.querySelector("#snapshot-fixture").remove()','args':[]})
 print('bounded snapshot output and pagination reach all 450 extra controls: verified in Firefox')
 container=value(tool('callisto_browser',{'action':'agent_container'}))
 assert value(tool('callisto_browser',{'action':'agent_container'}))['cookieStoreId']==container['cookieStoreId']
 agent_tab=value(tool('callisto_browser',{'action':'tab_create','url':target,'agent_container':True}))
 assert agent_tab['cookieStoreId']==container['cookieStoreId']
 normal_tab=value(tool('callisto_browser',{'action':'tab_create','url':target}))
 assert normal_tab['cookieStoreId']=='firefox-default'
 value(tool('callisto_browser',{'action':'tab_close','tab_id':agent_tab['id']}))
 value(tool('callisto_browser',{'action':'tab_close','tab_id':normal_tab['id']}))
 value(tool('callisto_browser',{'action':'tab_select','tab_id':original}))
 window=value(tool('callisto_browser',{'action':'window_create','url':target,'agent_container':True}))
 assert window['tabs'][0]['cookieStoreId']==container['cookieStoreId']
 value(tool('callisto_browser',{'action':'tab_select','tab_id':window['tabs'][0]['id']}))
 value(tool('callisto_browser',{'action':'window_close','window_id':window['windowId']}))
 value(tool('callisto_browser',{'action':'tab_select','tab_id':original}))
 title=req('/session/'+session+'/execute/sync',{'script':'return document.title','args':[]})
 assert title=='[Callisto]' or title.startswith('[Callisto] '),title
 print('opt-in container, inherited cookie store, agent window and controlled-tab marker: verified')
 handoff_result=[]
 def handoff(): handoff_result.append(tool('callisto_handoff',{'prompt':'Confirm this disposable fixture step.','timeout_ms':10000}))
 worker=threading.Thread(target=handoff);worker.start()
 button=None
 for i in range(100):
  try:
   button=req('/session/'+session+'/element',{'using':'css selector','value':'[data-callisto-handoff] button'});break
  except Exception: time.sleep(.05)
 assert button,'Handoff banner did not appear'
 element=button['element-6066-11e4-a52e-4f735466cecf']
 req('/session/'+session+'/element/'+element+'/click',{})
 worker.join(timeout=15);assert not worker.is_alive()
 assert value(handoff_result[0])['confirmed']
 print('trusted human-style click confirms handoff in disposable Firefox: verified')
 assert value(tool('callisto_close'))['released']
 assert not value(tool('callisto_status'))['sharing']
 assert not req('/session/'+session+'/execute/sync',{'script':'return document.title','args':[]}).startswith('[Callisto]')
 print('release: verified')
 subprocess.run([ROOT+'target/debug/callisto-firefox-tab-mcp','--stop-relay'],env=env,check=True,timeout=10)
 for i in range(100):
  try:
   if value(tool('callisto_pair'))['code']==pair:break
  except Exception:pass
  time.sleep(.05)
 assert p.poll() is None,'MCP proxy exited when relay restarted'
 assert value(tool('callisto_pair'))['code']==pair
 for i in range(100):
  status=value(tool('callisto_status'))
  if status.get('connected'): break
  time.sleep(.1)
 assert status.get('connected'),status
 assert not status.get('sharing'),status
 print('relay restart reconnects with saved pairing and no tab restored: verified')
finally:
 if session:
  try: req('/session/'+session,method='DELETE')
  except Exception as e: print('webdriver cleanup:',e)
 p.stdin.close();p.wait(timeout=10)
 subprocess.run([ROOT+'target/debug/callisto-firefox-tab-mcp','--stop-relay'],env=env,timeout=10)
 server.shutdown();server.server_close();state.cleanup()
