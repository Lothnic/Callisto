import {execFileSync} from 'node:child_process'
export async function installFirefoxFixture(client,url){
 const driver=process.env.GECKODRIVER_URL||'http://127.0.0.1:53851'
 const request=async(path,data,method)=>{const r=await fetch(driver+path,{method:method??(data?'POST':'GET'),headers:{'content-type':'application/json'},body:data?JSON.stringify(data):undefined});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v.value}
 const session=(await request('/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{args:['-headless']}}}})).sessionId
 try{
  await request(`/session/${session}/url`,{url})
  const result=await client.callTool({name:'callisto_pair',arguments:{}})
  const code=JSON.parse(result.content[0].text).code
  const archive=execFileSync('python3',['-c',`import sys,os,json,base64,zipfile,io
root='packages/firefox-rs/extension';out=io.BytesIO()
with zipfile.ZipFile(out,'w') as z:
 for name in os.listdir(root):
  data=open(root+'/'+name,'rb').read()
  if name=='manifest.json':
   m=json.loads(data);m['permissions'].extend(m.pop('optional_permissions'));data=json.dumps(m).encode()
  if name=='background.js':data+=('\\nsetTimeout(async()=>{await pair('+json.dumps(sys.argv[1])+');await share()},1000);').encode()
  z.writestr(name,data)
print(base64.b64encode(out.getvalue()).decode())`,code],{encoding:'utf8'}).trim()
  await request(`/session/${session}/moz/addon/install`,{addon:archive,temporary:true})
  for(let i=0;i<100;i++){const r=await client.callTool({name:'callisto_status',arguments:{}});const s=JSON.parse(r.content[0].text);if(s.sharing&&s.ready)return async()=>{await request(`/session/${session}`,undefined,'DELETE')};await new Promise(r=>setTimeout(r,100))}
  throw Error('Fixture extension did not connect')
 }catch(e){await request(`/session/${session}`,undefined,'DELETE').catch(()=>{});throw e}
}
