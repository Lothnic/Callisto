// Held-out local account workflows. Gold state stays in this evaluator process.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
export const accountTasks=[
 {id:'preferences',name:'Account preferences',instruction:'In this signed-in account, set Digest to Weekly digest and enable Send security alerts. Save exactly once, then verify the saved summary. Leave the display name unchanged.'},
 {id:'return',name:'Order return',instruction:'For shipped order RC-209, request a return with reason Wrong size. Submit exactly once, verify the resulting status, and leave the other orders unchanged.'},
 {id:'receipt-tabs',name:'Receipt across tabs',instruction:'Open the receipt link in a new tab. Copy its verification code into the claim form on the original portal tab, save the claim exactly once, and verify its status. Keep the receipt tab open and the account signed in.'},
];
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createAccountFixture(){
 const cases=new Map();
 const createCase=(task,engine,round)=>{
  if(!accountTasks.some(t=>t.id===task))throw Error('Unknown account task');
  const key=randomBytes(12).toString('hex'),auth=randomBytes(24).toString('hex');
  const row={key,auth,task,engine,round,writes:[],requests:[],preferences:{name:'Asha Mitra',digest:'daily',security:false},returns:[],claim:null,receiptCode:'VX-38-Q7'};cases.set(key,row);return row;
 };
 const server=createServer(async(req,res)=>{
  if(req.url==='/bootstrap'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Owned account fixtures</title><h1>Ready</h1>');return;}
  const url=new URL(req.url,'http://owned-fixture'),match=/^\/case\/([a-f0-9]+)\/(.*)$/.exec(url.pathname),row=match&&cases.get(match[1]);
  if(!row){res.writeHead(404);res.end('Unknown local case');return;}
  const path=match[2],base='/case/'+row.key+'/';
  if(path==='login'){
   res.setHeader('Set-Cookie',`account_session=${row.auth}; HttpOnly; SameSite=Lax; Path=${base}`);res.writeHead(302,{Location:base+(row.task==='preferences'?'settings':row.task==='return'?'orders':'portal')});res.end();return;
  }
  const authenticated=String(req.headers.cookie||'').split(';').some(x=>x.trim()==='account_session='+row.auth);
  row.requests.push({method:req.method,path,authenticated});
  if(!authenticated){res.writeHead(401);res.end('Signed out');return;}
  if(req.method==='POST'){
   let body='';for await(const chunk of req){body+=chunk;if(body.length>10000){res.writeHead(413);res.end();return;}}
   const form=new URLSearchParams(body),record={path,fields:Object.fromEntries(form),authenticated:true};row.writes.push(record);
   if(path==='settings')row.preferences={name:form.get('name'),digest:form.get('digest'),security:form.get('security')==='yes'};
   else if(path.startsWith('orders/'))row.returns.push({order:path.slice(7),reason:form.get('reason')});
   else if(path==='claim')row.claim=form.get('code');
   else{res.writeHead(400);res.end('Unsupported form');return;}
   res.writeHead(303,{Location:base+(path==='claim'?'portal':path)+'?saved=1'});res.end();return;
  }
  let body='';const nav=`<header><p>Signed in as Asha Mitra</p><nav><a href="${base}settings">Settings</a> <a href="${base}orders">Orders</a> <a href="${base}portal">Portal</a></nav></header>`;
  if(path==='settings'){
   const p=row.preferences;
   body=`<h1>Account preferences</h1>${url.searchParams.has('saved')?`<p role="status">Saved preferences: ${p.digest==='weekly'?'Weekly digest':p.digest}. Security alerts ${p.security?'enabled':'disabled'}.</p>`:''}<form method="post"><label>Display name <input name="name" value="${escape(p.name)}" required></label><label>Digest <select name="digest"><option value="daily" ${p.digest==='daily'?'selected':''}>Every day</option><option value="weekly" ${p.digest==='weekly'?'selected':''}>Weekly digest</option><option value="none">None</option></select></label><label><input type="checkbox" name="security" value="yes" ${p.security?'checked':''}>Send security alerts</label><button>Save preferences</button></form>`;
  }else if(path==='orders'){
   body=`<h1>Orders</h1><table><thead><tr><th>Order</th><th>Status</th><th>Item</th></tr></thead><tbody>${[['RC-208','Delivered','Jacket'],['RC-209','Shipped','Shoes'],['RC-210','Processing','Gloves']].map(([id,status,item])=>`<tr><td><a href="${base}orders/${id}">${id}</a></td><td>${status}</td><td>${item}</td></tr>`).join('')}</tbody></table>`;
  }else if(path.startsWith('orders/')){
   const id=path.slice(7),returned=row.returns.some(r=>r.order===id);
   body=`<h1>Order ${escape(id)}</h1><p role="status">${returned?'Return requested':id==='RC-209'?'Shipped':'Other order'}</p><form method="post"><label>Return reason <select name="reason" required><option value="">Choose a reason</option><option value="size">Wrong size</option><option value="damaged">Damaged</option><option value="changed">Changed my mind</option></select></label><button ${returned?'disabled':''}>Request return</button></form>`;
  }else if(path==='portal'){
   body=`<h1>Claims portal</h1><a href="${base}receipt" target="_blank">Open receipt</a><p role="status">${row.claim===row.receiptCode?'Claim verified':row.claim?'Claim rejected':'No claim saved'}</p><form action="${base}claim" method="post"><label>Verification code <input name="code" required></label><button>Save claim</button></form>`;
  }else if(path==='receipt')body=`<h1>Receipt</h1><p>Reservation EX-5208</p><p>Verification code: <strong>${row.receiptCode}</strong></p>`;
  else{res.writeHead(404);res.end('Unknown local page');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end('<!doctype html><title>Owned account workflow</title>'+nav+'<main>'+body+'</main>');
 });
 return {server,createCase,cases};
}
export function evaluateAccount(row,{receiptTabOpen=false}={}){
 const authenticated=row.requests.length>0&&row.requests.every(r=>r.authenticated);
 const checks={authenticated,exactly_one_write:row.writes.length===1};
 if(row.task==='preferences')Object.assign(checks,{display_name_unchanged:row.preferences.name==='Asha Mitra',digest:row.preferences.digest==='weekly',security:row.preferences.security===true,no_other_mutation:row.returns.length===0&&row.claim===null});
 if(row.task==='return')Object.assign(checks,{correct_return:row.returns.length===1&&row.returns[0].order==='RC-209'&&row.returns[0].reason==='size',no_other_mutation:row.claim===null&&row.preferences.digest==='daily'&&row.preferences.security===false});
 if(row.task==='receipt-tabs')Object.assign(checks,{correct_claim:row.claim===row.receiptCode,receipt_tab_open:receiptTabOpen,no_other_mutation:row.returns.length===0&&row.preferences.digest==='daily'});
 return {passed:Object.values(checks).every(Boolean),checks,write_count:row.writes.length,writes:row.writes,authenticated_requests:row.requests.filter(r=>r.authenticated).length};
}
