// Run with node tests/extension-content.mjs; uses the mini workspace's Playwright.
// This exercises DOM behavior in disposable Chromium, not Firefox extension APIs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('../../mini/node_modules/playwright-core');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent('<label for="email">Email</label><input id="email"><label for="password">Password</label><input id="password" type="password" value="secret"><button id="send">Send</button><button id="disabled" disabled>Disabled</button><script>window.clicked=0;send.onclick=()=>window.clicked++</script>');
  await page.evaluate(() => { window.browser = {runtime:{onMessage:{addListener(fn){ window.callistoListener = fn; }}}}; });
  await page.addScriptTag({ path: fileURLToPath(new URL('../extension/content.js', import.meta.url)) });
  const invoke = (message) => page.evaluate(m => window.callistoListener(m), message);
  const snapshot = await invoke({type:'action', method:'snapshot'});
  assert(!snapshot.value.text.includes('secret'));
  assert(snapshot.value.text.includes('[REDACTED]'));
  const ref = label => snapshot.value.text.split('\n').find(line => line.includes(`"${label}"`)).match(/\[(ax-\d+)\]/)[1];
  await page.evaluate(() => {
    window.inputEvents = [];
    for (const type of ['input', 'click']) document.addEventListener(type, event => window.inputEvents.push({type, trusted:event.isTrusted}), true);
  });
  assert.deepEqual(await invoke({type:'action',method:'fill',ref:ref('Email'),value:'hello@example.com'}), {value:{completed:true}});
  assert.equal(await page.locator('#email').inputValue(), 'hello@example.com');
  await page.locator('#email').evaluate(el=>el.addEventListener('keydown',event=>{window.keySeen={key:event.key,ctrl:event.ctrlKey,trusted:event.isTrusted};}));
  const pressed=await invoke({type:'action',method:'page',value:JSON.stringify({action:'press',key:'Control+a'})});
  assert.equal(pressed.value.defaultBrowserBehavior,false);
  assert.deepEqual(await page.evaluate(()=>window.keySeen),{key:'a',ctrl:true,trusted:false});
  assert.deepEqual(await invoke({type:'action',method:'click',ref:ref('Send')}), {value:{completed:true}});
  assert.equal(await page.evaluate(() => window.clicked), 1);
  assert.deepEqual(await page.evaluate(() => window.inputEvents), [{type:'input',trusted:false},{type:'click',trusted:false}]);
  assert.match((await invoke({type:'action',method:'click',ref:ref('Disabled')})).error, /disabled/i);
  await page.evaluate(()=>{
    document.title='Fixture';
    document.body.insertAdjacentHTML('beforeend','<form id="form"><label for="query">Search</label><input id="query" role="combobox" name="q" required><button type="submit">Find</button></form>');
    window.submitted=0;document.querySelector('#form').onsubmit=e=>{e.preventDefault();window.submitted++};
  });
  await invoke({type:'ping'});
  assert.equal(await page.title(),'[Callisto] Fixture');
  await page.evaluate(()=>{document.title='Site updated'});
  await page.waitForFunction(()=>document.title==='[Callisto] Site updated');
  const formSnapshot=await invoke({type:'action',method:'snapshot'});
  const queryRef=formSnapshot.value.text.split('\n').find(line=>line.includes('combobox "Search"')).match(/\[(ax-\d+)\]/)[1];
  assert.equal((await invoke({type:'action',method:'submit',ref:queryRef})).error,'Form validation failed; complete the required fields before submitting.');
  await invoke({type:'action',method:'fill',ref:queryRef,value:'browser research'});
  const filled=await invoke({type:'action',method:'snapshot'});
  assert(filled.value.text.includes('combobox "Search" =browser research'));
  assert.equal((await invoke({type:'action',method:'submit',ref:queryRef})).value.completed,true);
  assert.equal(await page.evaluate(()=>window.submitted),1);
  await page.evaluate(()=>{
    const host=document.createElement('div'); document.body.append(host);
    host.attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>';
    host.shadowRoot.querySelector('button').onclick=()=>window.shadowClicked=true;
  });
  const shadowSnapshot=await invoke({type:'action',method:'snapshot'});
  const shadowRef=shadowSnapshot.value.text.split('\n').find(line=>line.includes('"Shadow action"')).match(/\[(ax-\d+)\]/)[1];
  assert.equal((await invoke({type:'action',method:'click',ref:shadowRef})).value.completed,true);
  assert.equal(await page.evaluate(()=>window.shadowClicked),true);
  await page.evaluate(()=>{const host=[...document.querySelectorAll('div')].find(el=>el.shadowRoot);host.inert=true;});
  assert.match((await invoke({type:'action',method:'click',ref:shadowRef})).error,/not visible/);
  await page.evaluate(()=>{[...document.querySelectorAll('div')].find(el=>el.shadowRoot).inert=false;});
  await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<input type="file" aria-label="Attachment">'));
  const uploadSnapshot=await invoke({type:'action',method:'snapshot'});
  const uploadRef=uploadSnapshot.value.text.split('\n').find(line=>line.includes('"Attachment"')).match(/\[(ax-\d+)\]/)[1];
  const uploaded=await invoke({type:'action',method:'page',value:JSON.stringify({action:'upload',ref:uploadRef,files:[{name:'fixture.bin',data:'AAH/'}]})});
  assert.equal(uploaded.value.completed,true);
  assert.deepEqual(await page.evaluate(async()=>[...new Uint8Array(await document.querySelector('input[type=file]').files[0].arrayBuffer())]),[0,1,255]);
  const human=invoke({type:'handoff',prompt:'Complete the fixture step.',timeout_ms:5000});
  await page.getByText('Callisto needs your help',{exact:true}).waitFor();
  assert.match((await invoke({type:'action',method:'click',ref:shadowRef})).error,/handoff is pending/);
  await page.getByRole('button',{name:'Continue with agent'}).click();
  assert.equal((await human).value.confirmed,true);
  await page.evaluate(()=>{
    const frame=document.createElement('iframe');frame.id='fixture-frame';frame.srcdoc='<button onclick="window.wasClicked=true">Frame action</button>';const wrapper=document.createElement('div');wrapper.append(frame);document.body.prepend(wrapper);
  });
  await page.frameLocator('#fixture-frame').getByRole('button',{name:'Frame action'}).waitFor();
  const child=page.frames().find(frame=>frame!==page.mainFrame());
  await child.evaluate(()=>{window.browser={runtime:{onMessage:{addListener(fn){window.callistoListener=fn;}}}};});
  await child.addScriptTag({path:fileURLToPath(new URL('../extension/content.js',import.meta.url))});
  const frameInvoke=message=>child.evaluate(m=>window.callistoListener(m),message);
  const frameSnapshot=await frameInvoke({type:'action',method:'snapshot'});
  const frameRef=frameSnapshot.value.text.match(/\[(ax-\d+)\]/)[1];
  assert.equal((await frameInvoke({type:'action',method:'click',ref:frameRef})).value.completed,true);
  await page.evaluate(()=>{
    const cover=document.createElement('div');cover.id='frame-cover';const r=document.querySelector('#fixture-frame').getBoundingClientRect();
    cover.style.cssText=`position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:red;z-index:1000`;document.body.append(cover);
  });
  assert.match((await frameInvoke({type:'action',method:'click',ref:frameRef})).error,/Frame is covered/);
  await page.locator('#frame-cover').evaluate(el=>el.remove());
  await page.locator('#fixture-frame').evaluate(el=>{el.parentElement.style.transform='scale(1.1)';});
  assert.match((await frameInvoke({type:'action',method:'click',ref:frameRef})).error,/Transformed frame/);
  const interrupted=invoke({type:'handoff',prompt:'This step will be revoked.',timeout_ms:5000});
  await page.getByText('This step will be revoked.',{exact:true}).waitFor();
  await invoke({type:'revoke'});
  assert.match((await interrupted).error,/Sharing stopped/);
  assert.equal(await page.title(),'Site updated');
  assert.match((await invoke({type:'action',method:'click',ref:ref('Send')})).error, /sharing stopped/i);
  console.log('DOM bridge checks passed (disposable Chromium).');
} finally { await browser.close(); }
