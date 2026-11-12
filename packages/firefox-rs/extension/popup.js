'use strict';
const status = document.getElementById('status');
async function send(message) {
  try { const result = await browser.runtime.sendMessage(message); status.textContent = result.message; }
  catch (error) { status.textContent = `Error: ${error.message}`; }
}
document.getElementById('pair').addEventListener('click', () => send({type:'pair', code:document.getElementById('code').value.trim()}));
document.getElementById('share').addEventListener('click', () => send({type:'share'}));
document.getElementById('stop').addEventListener('click', () => send({type:'stop'}));
send({type:'status'});
