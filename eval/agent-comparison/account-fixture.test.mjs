import {test} from 'node:test';import assert from 'node:assert/strict';
import {createAccountFixture,evaluateAccount} from './account-fixture.mjs';
test('independent account judge requires authentication, exact state and one write',async()=>{
 const fixture=createAccountFixture();await new Promise(r=>fixture.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+fixture.server.address().port;
 try{
  const row=fixture.createCase('preferences','test',0),base=origin+'/case/'+row.key+'/';
  assert.equal((await fetch(base+'settings')).status,401);assert.equal(evaluateAccount(row).passed,false);
  row.requests=[];
  const login=await fetch(base+'login',{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
  await fetch(base+'settings',{method:'POST',headers:{cookie,'Content-Type':'application/x-www-form-urlencoded'},body:'name=Asha+Mitra&digest=weekly&security=yes',redirect:'manual'});
  assert.equal(evaluateAccount(row).passed,true);
  await fetch(base+'settings',{method:'POST',headers:{cookie},body:'name=Asha+Mitra&digest=weekly&security=yes',redirect:'manual'});
  assert.equal(evaluateAccount(row).checks.exactly_one_write,false);
 }finally{fixture.server.closeAllConnections();await new Promise(r=>fixture.server.close(r));}
});
test('receipt answer alone and incorrect order mutations do not pass',()=>{
 const fixture=createAccountFixture();const receipt=fixture.createCase('receipt-tabs','test',0);receipt.requests=[{authenticated:true}];receipt.writes=[{}];receipt.claim=receipt.receiptCode;
 assert.equal(evaluateAccount(receipt).passed,false);assert.equal(evaluateAccount(receipt,{receiptTabOpen:true}).passed,true);
 const order=fixture.createCase('return','test',0);order.requests=[{authenticated:true}];order.writes=[{}];order.returns=[{order:'RC-208',reason:'size'}];assert.equal(evaluateAccount(order).passed,false);
});
