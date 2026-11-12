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
  assert.deepEqual(await invoke({type:'action',method:'fill',ref:ref('Email'),value:'hello@example.com'}), {value:{completed:true}});
  assert.equal(await page.locator('#email').inputValue(), 'hello@example.com');
  assert.deepEqual(await invoke({type:'action',method:'click',ref:ref('Send')}), {value:{completed:true}});
  assert.equal(await page.evaluate(() => window.clicked), 1);
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
  await invoke({type:'revoke'});
  assert.equal(await page.title(),'Site updated');
  assert.match((await invoke({type:'action',method:'click',ref:ref('Send')})).error, /sharing stopped/i);
  console.log('DOM bridge checks passed (disposable Chromium).');
} finally { await browser.close(); }
