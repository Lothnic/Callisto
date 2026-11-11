import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('sidecar retains the snapshot baseline across evaluations', { skip: !process.env.CALLISTO_SMOKE }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/sidecar.ts'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let id = 0
  async function call(method: string, params: Record<string, unknown> = {}) {
    child.stdin.write(JSON.stringify({ id: String(++id), method, params }) + '\n')
    const line = await lines.next()
    assert.equal(line.done, false)
    const response = JSON.parse(line.value)
    assert.equal(response.ok, true, response.error)
    return response.result
  }
  try {
    await call('launch', { headless: true, chromeFlags: process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : [] })
    const url = 'data:text/html,' + encodeURIComponent('<button>Go</button>')
    await call('eval', { code: `await page.goto(${JSON.stringify(url)}); return await page.accessibility.snapshot()` })
    const second = await call('eval', { code: 'return await page.accessibility.snapshot({diff:true})' })
    assert.equal(second.value.text, '[unchanged]')
    child.stdin.write(JSON.stringify({ id: 'queued-1', method: 'eval', params: { code: "await new Promise(r => setTimeout(r, 50)); return await page.evaluate(() => { window.queueValue = 42; return 'first' })" } }) + '\n')
    child.stdin.write(JSON.stringify({ id: 'queued-2', method: 'eval', params: { code: 'return await page.evaluate(() => window.queueValue)' } }) + '\n')
    const firstQueued = JSON.parse((await lines.next()).value!)
    const secondQueued = JSON.parse((await lines.next()).value!)
    assert.equal(firstQueued.id, 'queued-1')
    assert.equal(firstQueued.ok, true, firstQueued.error)
    assert.equal(secondQueued.id, 'queued-2')
    assert.equal(secondQueued.result.value, 42)
    await call('close')
  } finally {
    child.stdin.end()
    await once(child, 'exit')
  }
})
