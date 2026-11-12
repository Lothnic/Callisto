import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Mini, Page } from '../src/index.js'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

test('connected mode requires an explicit origin allowlist', async () => {
  await assert.rejects(Mini.connectBrowse({ allowedOrigins: [] }), /requires at least one allowed origin/)
})

test('connected MCP rejects a missing allowlist before starting browse', async () => {
  const client = new Client({ name: 'callisto-allowlist-test', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    env: { ...process.env, CALLISTO_MCP_BROWSER: 'connected', CALLISTO_ALLOWED_ORIGINS: '', CALLISTO_BROWSE_COMMAND: '/missing/browse' } as Record<string, string>,
    stderr: 'pipe',
  })
  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'callisto_navigate', arguments: { url: 'https://example.com/' } })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.content), /requires at least one allowed origin/)
  } finally {
    await client.close()
  }
})

test('connected MCP tools navigate within scope and cleanly close', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<title>MCP connected fixture</title><label>Fruit <input></label>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`
  const client = new Client({ name: 'callisto-connected-test', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    env: { ...process.env, CALLISTO_MCP_BROWSER: 'connected', CALLISTO_ALLOWED_ORIGINS: origin } as Record<string, string>,
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  try {
    await client.connect(transport)
    const navigate = await client.callTool({ name: 'callisto_navigate', arguments: { url: origin } })
    assert.notEqual(navigate.isError, true, JSON.stringify(navigate.content))
    const content = navigate.content as Array<{ type: string; text: string }>
    const snapshot = JSON.parse(content[0].text)
    assert.equal(snapshot.title, 'MCP connected fixture')
    assert.match(snapshot.text, /textbox "Fruit"/)
    const denied = await client.callTool({ name: 'callisto_navigate', arguments: { url: 'https://example.com/' } })
    assert.equal(denied.isError, true)
    const closed = await client.callTool({ name: 'callisto_close', arguments: {} })
    assert.notEqual(closed.isError, true)
  } finally {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('connected Mini reads a scoped fixture, refuses other origins and closes its own session', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type','text/html'); res.end('<title>Connected fixture</title><label>Fruit <input></label><button>Save</button>') })
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  let mini: Mini | undefined
  try {
    mini = await Mini.connectBrowse({ allowedOrigins: [origin] })
    const page = new Page(mini)
    await page.goto(origin, {waitUntil:'domcontentloaded',timeout:10000})
    const snap = await mini.snapshot()
    assert.equal(snap.title, 'Connected fixture')
    assert.match(snap.text, /textbox "Fruit"/)
    await assert.rejects(page.goto('https://example.com/', {timeout:5000}), /allowlist|blocked/i)
    // The relay's focus lifecycle applies to its own execute tool, not raw CDP.
    // A background tab must fail instead of reporting a silent input success.
    await page.goto(origin, {waitUntil:'domcontentloaded',timeout:10000})
    if (await page.evaluate(() => document.visibilityState === 'hidden')) {
      await assert.rejects(page.getByRole('textbox',{name:'Fruit'}).fill('mango'), /background/)
      assert.equal(await page.evaluate(() => (document.querySelector('input') as HTMLInputElement).value), '')
    }
  } finally {
    await mini?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(()=>resolve()))
  }
})
