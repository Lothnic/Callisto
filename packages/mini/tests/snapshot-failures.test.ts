import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshot } from '../src/snapshot.js'
import { RefRegistry } from '../src/ax-refs.js'
import type { Session } from '../src/client.js'

function fakeSession(mainFails: boolean): Session {
  return {
    cdp: {
      Page: { getFrameTree: async () => ({frameTree:{frame:{id:'main'},childFrames:[{frame:{id:'child', parentId:'main'}}]}}) },
      Accessibility: { getFullAXTree: async ({frameId}: {frameId: string}) => {
        if (frameId === 'child' || mainFails) throw new Error('frame detached')
        return { nodes: [{nodeId:'1',role:{value:'RootWebArea'},name:{value:'Fixture'},childIds:[]}] }
      } },
      DOM: { getFrameOwner: async () => ({backendNodeId:1}) },
      Runtime: { evaluate: async () => ({result:{value:JSON.stringify({url:'https://example.test/',title:'Fixture'})}}) },
    } as unknown as Session['cdp'],
    viewport: {width:800,height:600}, headless:true,
  }
}

test('snapshot reports an omitted child frame', async () => {
  const result = await snapshot(fakeSession(false), new RefRegistry())
  assert.equal(result.title, 'Fixture')
  assert.match(result.warnings?.join(' ') ?? '', /child frame.*could not be captured/)
})

test('snapshot fails instead of reporting an empty page when its main frame cannot be captured', async () => {
  await assert.rejects(snapshot(fakeSession(true), new RefRegistry()), /main frame accessibility tree/)
})

test('snapshot rejects an empty main accessibility tree', async () => {
  const session = fakeSession(false)
  session.cdp.Accessibility.getFullAXTree = async () => ({nodes: []})
  await assert.rejects(snapshot(session, new RefRegistry()), /main frame accessibility tree/)
})
