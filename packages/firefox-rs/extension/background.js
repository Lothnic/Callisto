'use strict';
let socket = null;
let selected = null;
let generation = 0;

function status() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return 'Not connected.';
  return selected === null ? 'Connected. Select a tab and click Share this tab.' : 'Connected. The selected tab is shared.';
}
async function stop() {
  const previous = selected;
  selected = null; generation++;
  if (previous !== null) await browser.tabs.sendMessage(previous, {type:'revoke'}).catch(() => {});
}
async function share() {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Connect first.');
  const [tab] = await browser.tabs.query({active:true,currentWindow:true});
  if (!tab || tab.id === undefined) throw new Error('No active browser tab.');
  await stop();
  await browser.tabs.executeScript(tab.id, {file:'content.js',runAt:'document_idle'});
  await browser.tabs.sendMessage(tab.id, {type:'ping'});
  selected = tab.id;
  return 'Connected. This tab is shared; click Stop sharing to revoke access.';
}
async function pair(code) {
  const match = /^127\.0\.0\.1:(\d{1,5})#([0-9a-f]{64})$/.exec(code);
  if (!match || +match[1] < 1 || +match[1] > 65535) throw new Error('Invalid pairing code.');
  await stop();
  if (socket) socket.close();
  const ws = new WebSocket(`ws://127.0.0.1:${match[1]}`);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({type:'pair',token:match[2]}));
  ws.onclose = () => { if (socket === ws) { socket = null; void stop(); } };
  ws.onerror = () => { if (socket === ws) void stop(); };
  ws.onmessage = async event => {
    let request;
    try { request = JSON.parse(event.data); } catch { return; }
    if (!request || !Number.isSafeInteger(request.id)) return;
    const chosen = selected, stamp = generation;
    try {
      if (request.method === 'release') { await stop(); ws.send(JSON.stringify({id:request.id,result:{released:true}})); return; }
      if (chosen === null) throw new Error('No tab shared. Open the desired tab and click Share this tab in the Callisto extension.');
      if (!['snapshot','click','fill'].includes(request.method)) throw new Error('Unsupported action.');
      const [active] = await browser.tabs.query({active:true,currentWindow:true});
      if (!active || active.id !== chosen) throw new Error('The shared tab is not active. Return to it before continuing.');
      const result = await browser.tabs.sendMessage(chosen,{type:'action',method:request.method,ref:request.ref,value:request.value});
      if (stamp !== generation || chosen !== selected) throw new Error('Tab sharing changed during the action; inspect the page before retrying.');
      if (!result || result.error) throw new Error(result?.error || 'The selected page did not respond.');
      ws.send(JSON.stringify({id:request.id,result:result.value}));
    } catch (error) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({id:request.id,error:String(error.message || error)})); }
  };
}
browser.runtime.onMessage.addListener(async message => {
  try {
    if (message.type === 'status') return {message:status()};
    if (message.type === 'pair') { await pair(message.code); return {message:'Connecting. Then reopen this popup and share the desired tab.'}; }
    if (message.type === 'share') return {message:await share()};
    if (message.type === 'stop') { await stop(); if (socket) socket.close(); socket = null; return {message:'Sharing stopped and connection closed.'}; }
    return {message:'Unknown request.'};
  } catch (error) { return {message:`Error: ${error.message}`}; }
});
browser.tabs.onRemoved.addListener(id => { if (selected === id) void stop(); });
browser.tabs.onUpdated.addListener((id, change) => { if (selected === id && change.status === 'loading') void stop(); });
