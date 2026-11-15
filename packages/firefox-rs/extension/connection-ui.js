'use strict';
(() => {
 const byId=id=>document.getElementById(id);let state=null,busy=false,revision=0,taskRevision='';
 function notice(text,error=false){byId('notice').textContent=text;byId('notice').dataset.error=String(error);}
 function render(){
  if(!state)return;
  const count=state.shared_tabs||0,tasks=state.background_tasks||[];
  byId('connection-title').textContent=state.connected&&tasks.length?(tasks.every(t=>t.paused)?'Background work paused':'Background control active'):state.connected?(count===1?'One tab shared':count?`${count} tabs shared`:'Connected · no tab shared'):state.reconnecting?'Reconnecting to runtime':'Runtime not connected';
  byId('connection-copy').textContent=state.connected&&tasks.length?'Task control stays with its agent window. View pauses it first. Sharing or preparing another tab releases current shares.':state.connected?(count?'Sharing or preparing this tab replaces current shares. Foreground shares must stay active in their window.':document.body.dataset.surface==='popup'?'Open the intended page and choose Share this tab.':'Return to the intended page, right-click it and choose Share this tab with Callisto.'):state.paired?'Start the Callisto MCP server. Saved pairing will reconnect; tab access is never restored automatically.':'Start Callisto in your agent, then enter its pairing code below.';
  byId('pair-form').hidden=!!state.paired;
  if(byId('share'))byId('share').disabled=!state.connected||busy;
  if(byId('background-start'))byId('background-start').disabled=!state.connected||busy;
  renderTasks(tasks);
  byId('stop').disabled=!count&&!tasks.length;byId('pair').disabled=busy;byId('forget').disabled=!state.paired||busy;
  for(const key of ['navigation','browser','network','containers'])byId(key+'-state').textContent=state.permissions?.[key]?'Enabled':'Not granted';
 }
 function renderTasks(tasks){
  const signature=JSON.stringify(tasks);if(signature===taskRevision)return;taskRevision=signature;
  const focusKey=document.activeElement?.dataset?.taskControl,root=byId('background-tasks');root.replaceChildren();root.hidden=!tasks.length;
  for(const [index,task] of tasks.entries()){
   const row=document.createElement('section');row.className='background-task';
   const title=document.createElement('h2');title.textContent=tasks.length===1?'Background task':`Background task ${index+1}`;row.append(title);
   const status=document.createElement('p');status.className='hint';status.textContent=task.reason==='starting'?'Preparing agent window…':task.paused?(task.reason==='ready'?'Ready. Return to your other window to start automatically.':task.reason==='viewing'?'Paused for viewing. Resume from your other window.':task.reason==='needs_attention'?'Paused. Check the agent window, then resume from your other window.':'Paused. Its tab remains reserved.'):'Agent control is active without raising its window. Keep it unminimized.';row.append(status);
   const actions=document.createElement('div');actions.className='actions';
   for(const [action,label] of [['view','View'],[task.paused?'resume':'pause',task.paused?'Resume':'Pause'],['take-back','Take back']]){
    const button=document.createElement('button');button.textContent=label;button.dataset.taskControl=task.tab_id+':'+action;
    button.disabled=task.reason==='starting';if(action==='take-back')button.className='danger';
    button.addEventListener('click',()=>{const work=()=>browser.runtime.sendMessage({type:'background-control',tab_id:task.tab_id,action});if(action==='resume')void perform(work);else void (async()=>{try{const result=await work();notice(result.message,result.message?.startsWith('Error:'));}catch(error){notice(error.message,true);}await refresh();})();});
    actions.append(button);
   }
   row.append(actions);root.append(row);
  }
  if(focusKey)[...root.querySelectorAll('button')].find(b=>b.dataset.taskControl===focusKey&&!b.disabled)?.focus();
 }
 async function refresh(){const stamp=++revision;try{const next=await browser.runtime.sendMessage({type:'ui-status'});if(stamp!==revision)return;if(typeof next?.connected!=='boolean')throw Error('Extension state unavailable. Reload the extension and try again.');state=next;render();}catch(error){if(stamp===revision)notice(error.message,true);}}
 async function perform(work){if(busy)return;busy=true;render();try{const result=await work();if(result?.message?.startsWith('Error:'))throw Error(result.message.slice(7));notice(result?.message||'Updated.');}catch(error){notice(error.message,true);}finally{busy=false;await refresh();}}
 byId('pair-form').addEventListener('submit',event=>{event.preventDefault();const code=byId('code').value.trim();if(!/^127\.0\.0\.1:\d{1,5}#[0-9a-f]{64}$/.test(code)){notice('Use the complete pairing code from Callisto, beginning with 127.0.0.1:',true);byId('code').focus();return;}void perform(()=>browser.runtime.sendMessage({type:'pair',code}));});
 byId('background-start')?.addEventListener('click',()=>perform(async()=>{if(!(await browser.permissions.request({permissions:['tabs']})))return {message:'Tab management was not granted. The tab stays where it is.'};return browser.runtime.sendMessage({type:'background-share'});}));
 byId('share')?.addEventListener('click',()=>perform(()=>browser.runtime.sendMessage({type:'share'})));
 // Revocation stays available even while another operation is pending.
 byId('stop').addEventListener('click',async()=>{try{notice((await browser.runtime.sendMessage({type:'stop'})).message);}catch(error){notice(error.message,true);}await refresh();});
 byId('forget').addEventListener('click',()=>perform(()=>browser.runtime.sendMessage({type:'forget'})));
 byId('settings')?.addEventListener('click',()=>browser.runtime.openOptionsPage());
 function permission(id,request,success){byId(id).addEventListener('click',()=>perform(async()=>{const granted=await browser.permissions.request(request);if(!granted)return {message:'Permission was not granted. Existing access is unchanged.'};return typeof success==='function'?success():{message:success};}));}
 permission('allow',{origins:['<all_urls>']},'Navigation allowed. Share the tab again to use it.');
 permission('full',{origins:['<all_urls>'],permissions:['tabs','cookies','bookmarks','history','downloads']},'Browser access enabled.');
 permission('network',{origins:['<all_urls>'],permissions:['webRequest','webRequestBlocking']},'Network access enabled. The agent must start a capture with explicit origins.');
 permission('containers',{permissions:['cookies']},()=>browser.runtime.sendMessage({type:'enable-containers'}));
 window.addEventListener('focus',refresh);const timer=setInterval(()=>{if(!document.hidden)void refresh();},1500);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});void refresh();
})();
