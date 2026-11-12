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
  if self.path.startswith('/slow-image'):
   time.sleep(5);data=b''
  elif self.path.startswith('/search'):
   data=b'<title>Research form</title><form action="/results"><label>Research <input type="search" name="q" required></label><button type="submit">Search</button></form><img src="/slow-image">'
  elif self.path.startswith('/results'):
   query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('q',[''])[0]
   data=('<h1>Results '+html.escape(query)+'</h1>').encode()
  self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
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
 p.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args}})+'\n');p.stdin.flush();return json.loads(p.stdout.readline())['result']
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
    manifest=json.loads(data);manifest['permissions'].extend(['<all_urls>','tabs','cookies','bookmarks','history','downloads','contextualIdentities']);data=json.dumps(manifest).encode()
   if name=='background.js': data+=('\nsetTimeout(async () => { try { await pair('+json.dumps(pair)+'); await share(); } catch(e) { console.error(e); } }, 1000);').encode()
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
 assert value(tool('callisto_fill',{'ref':ref,'value':'hello'}))['completed']
 actual=req('/session/'+session+'/execute/sync',{'script':'return document.querySelector("#field").value','args':[]})
 assert actual == 'hello', actual
 print('fill: verified in Firefox')
 p.stdin.close(); p.wait(timeout=10)
 p=client()
 assert value(tool('callisto_pair'))['code'] == pair
 assert value(tool('callisto_status'))['connected']
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
 assert 'Visible fixture' in value(tool('callisto_page',{'action':'text'}))['text']
 print('check, select, text and find: verified in Firefox')
 tabs=value(tool('callisto_browser',{'action':'tabs_list'}))['tabs']
 assert any(t.get('url','').startswith('http://127.0.0.1:') for t in tabs)
 shot=tool('callisto_browser',{'action':'screenshot'})
 assert shot['content'][0]['type'] == 'image', shot
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
 started=time.perf_counter()
 batch=value(tool('callisto_batch',{'actions':[{'action':'navigate','url':base+'search'},{'action':'fill_role','role':'searchbox','name':'Research','value':'Zen workflow'},{'action':'submit_role','role':'searchbox','name':'Research'}]}))
 elapsed=time.perf_counter()-started
 assert batch['completed']==3 and 'Results Zen workflow' in batch['snapshot']['text'],batch
 assert elapsed<4,('Waited for slow resource instead of DOM readiness',elapsed)
 print('search form batch across navigation before 5-second image load: verified',round(elapsed*1000),'ms')
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
 assert title.startswith('[Callisto] '),title
 print('opt-in container, inherited cookie store, agent window and controlled-tab marker: verified')
 assert value(tool('callisto_close'))['released']
 assert not value(tool('callisto_status'))['sharing']
 assert not req('/session/'+session+'/execute/sync',{'script':'return document.title','args':[]}).startswith('[Callisto] ')
 print('release: verified')
 subprocess.run([ROOT+'target/debug/callisto-firefox-tab-mcp','--stop-relay'],env=env,check=True,timeout=10)
 p.stdin.close(); p.wait(timeout=10); p=client()
 assert value(tool('callisto_pair'))['code'] == pair
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
