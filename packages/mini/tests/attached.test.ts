import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Mini} from '../src/index.js'
import {launchChrome,closeSession,connectExistingCDP} from '../src/client.js'

test('attached CDP rejects remote endpoints and missing targets before connecting',async()=>{
  await assert.rejects(()=>connectExistingCDP({endpoint:'https://example.com',targetId:'A'}),/loopback/)
  await assert.rejects(()=>connectExistingCDP({endpoint:'http://127.0.0.1:9222',targetId:''}),/explicit CDP target/)
})

test('browser: attached CDP adopts one existing tab, leases it and leaves it open on close',{skip:!process.env.CALLISTO_SMOKE},async()=>{
  const owner=await launchChrome({headless:true})
  let attached:Mini|undefined
  try{
    const {targetInfos}=await owner.cdp.Target.getTargets()
    const target=targetInfos.find(target=>target.type==='page')!
    const opts={endpoint:`http://127.0.0.1:${owner.chrome!.port}`,targetId:target.targetId}
    attached=await Mini.connectCDP(opts)
    await attached.goto('data:text/html,<title>Adopted tab</title><button>Existing action</button>')
    assert.match((await attached.snapshot()).text,/Existing action/)
    await assert.rejects(()=>Mini.connectCDP(opts),/already leased/)
    await assert.rejects(()=>attached!.tabs.close(target.targetId),/cannot close user tabs/)
    await attached.close();attached=undefined
    assert((await owner.cdp.Target.getTargets()).targetInfos.some(page=>page.targetId===target.targetId))
    assert.equal((await owner.cdp.Runtime.evaluate({expression:'document.title',returnByValue:true})).result.value,'Adopted tab')
    attached=await Mini.connectCDP(opts)
    assert.match((await attached.snapshot()).text,/Existing action/)
  }finally{await attached?.close();await closeSession(owner)}
})
