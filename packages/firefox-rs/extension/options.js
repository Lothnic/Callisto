'use strict';
const status = document.getElementById('status');
async function send(message) {
  try { const result = await browser.runtime.sendMessage(message); status.textContent = result.message; }
  catch (error) { status.textContent = `Error: ${error.message}`; }
}
document.getElementById('pair').addEventListener('click', () => send({type:'pair', code:document.getElementById('code').value.trim()}));
document.getElementById('stop').addEventListener('click', () => send({type:'stop'}));
document.getElementById('allow').addEventListener('click', async () => {
  try {
    const granted = await browser.permissions.request({origins:['<all_urls>']});
    status.textContent = granted ? 'Website access granted. Share the tab to enable navigation.' : 'Website access was not granted.';
  } catch (error) { status.textContent = `Error: ${error.message}`; }
});
document.getElementById('full').addEventListener('click', async () => {
  try {
    const granted = await browser.permissions.request({origins:['<all_urls>'],permissions:['tabs','cookies','bookmarks','history','downloads']});
    status.textContent = granted ? 'Browser access enabled. The connected agent can manage your browser.' : 'Browser access was not granted.';
  } catch (error) { status.textContent = `Error: ${error.message}`; }
});
document.getElementById('forget').addEventListener('click', () => send({type:'forget'}));
document.getElementById('containers').addEventListener('click',async()=>{
 try { const granted=await browser.permissions.request({permissions:['contextualIdentities','cookies']});status.textContent=granted?'Agent containers enabled for new tabs and windows. Existing tabs keep their logins.':'Container permission was not granted.'; } catch(error){status.textContent=`Error: ${error.message}`;}
});
send({type:'status'});
