import assert from 'node:assert/strict';
import {chromium} from '../../mini/node_modules/playwright-core/index.mjs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/snap/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:380,height:800}});
 await page.addInitScript(()=>{
  window.state={connected:false,paired:false,shared_tabs:0,permissions:{}};window.messages=[];window.grants=[];
  window.browser={runtime:{sendMessage:async message=>{messages.push(message.type);if(message.type==='ui-status')return structuredClone(state);if(message.type==='pair'){state.connected=true;state.paired=true;return {message:'Connected.'};}if(message.type==='share'){state.shared_tabs=1;return {message:'This tab is shared.'};}if(message.type==='stop'){state.shared_tabs=0;return {message:'Sharing stopped.'};}if(message.type==='forget'){state.paired=false;state.connected=false;state.reconnecting=false;return {message:'Pairing forgotten.'};}return {message:'Done.'};},openOptionsPage:async()=>{}},permissions:{request:async permission=>{grants.push(permission);return false;}}};
 });
 await page.goto(pathToFileURL(resolve('packages/firefox-rs/extension/popup.html')).href);
 await page.getByRole('heading',{name:'Runtime not connected'}).waitFor();assert.equal(await page.locator('#share').isDisabled(),true);assert.deepEqual(await page.evaluate(()=>grants),[]);
 await page.locator('#code').fill('invalid');await page.locator('#pair').click();assert.equal(await page.locator('#code').inputValue(),'invalid');assert((await page.locator('#notice').textContent()).includes('complete pairing code'));
 await page.locator('#code').fill('127.0.0.1:12345#'+'a'.repeat(64));await page.locator('#pair').click();await page.getByRole('heading',{name:'Connected · no tab shared'}).waitFor();assert.equal(await page.locator('#pair-form').isHidden(),true);
 await page.locator('#share').click();await page.getByRole('heading',{name:'One tab shared'}).waitFor();assert.equal(await page.locator('#stop').isEnabled(),true);
 await page.screenshot({path:'/tmp/callisto-popup-shared.png',fullPage:true});
 await page.locator('#stop').click();await page.getByRole('heading',{name:'Connected · no tab shared'}).waitFor();
 await page.locator('#optional > summary').click();await page.locator('#network').click();assert.equal((await page.evaluate(()=>grants)).length,1);assert.match(await page.locator('#notice').textContent(),/not granted/);
 await page.evaluate(()=>{state.connected=false;state.reconnecting=true;window.dispatchEvent(new Event('focus'));});await page.getByRole('heading',{name:'Reconnecting to runtime'}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'/tmp/callisto-popup-recovery.png',fullPage:true});
 await page.locator('details').last().locator('summary').click();await page.locator('#forget').click();await page.getByRole('heading',{name:'Runtime not connected'}).waitFor();assert.equal(await page.locator('#pair-form').isVisible(),true);
 await page.evaluate(()=>document.documentElement.style.zoom='2');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 console.log('Extension UI: pairing, revocation, explicit permissions, recovery, wrapping and zoom passed.');
}finally{await browser.close();}
