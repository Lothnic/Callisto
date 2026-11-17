// Deterministic UI gate for the task fixture and independent judge; no model usage.
import assert from 'node:assert/strict';
import {chromium} from '../../packages/mini/node_modules/playwright-core/index.mjs';
import {createAccountFixture,evaluateAccount} from './account-fixture.mjs';
const fixture=createAccountFixture();await new Promise(r=>fixture.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+fixture.server.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/snap/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 for(const task of ['preferences','return','receipt-tabs']){
  const row=fixture.createCase(task,'deterministic',0),context=await browser.newContext(),page=await context.newPage();await page.goto(origin+'/case/'+row.key+'/login');
  if(task==='preferences'){await page.getByLabel(/^Digest/).selectOption({label:'Weekly digest'});await page.getByLabel('Send security alerts').check();await page.getByRole('button',{name:'Save preferences'}).click();await page.getByText('Saved preferences: Weekly digest. Security alerts enabled.').waitFor();}
  if(task==='return'){await page.getByRole('link',{name:'RC-209',exact:true}).click();await page.getByLabel(/^Return reason/).selectOption({label:'Wrong size'});await page.getByRole('button',{name:'Request return'}).click();await page.getByText('Return requested',{exact:true}).waitFor();}
  let receiptTabOpen=false;
  if(task==='receipt-tabs'){
   const waiting=context.waitForEvent('page');await page.getByRole('link',{name:'Open receipt'}).click();const receipt=await waiting;await receipt.waitForLoadState();
   const code=await receipt.locator('strong').innerText();await page.getByLabel('Verification code').fill(code);await page.getByRole('button',{name:'Save claim'}).click();await page.getByText('Claim verified',{exact:true}).waitFor();receiptTabOpen=context.pages().some(p=>p.url().endsWith('/receipt'));
  }
  assert.equal(evaluateAccount(row,{receiptTabOpen}).passed,true);await context.close();console.log('PASS independent UI/judge '+task);
 }
}finally{await browser.close();fixture.server.closeAllConnections();await new Promise(r=>fixture.server.close(r));}
