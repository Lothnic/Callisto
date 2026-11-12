import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Mini, Page } from '../src/index.js'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Session } from '../src/client.js'
import { randomUUID } from 'node:crypto'

async function browseSessionIds(client: Client): Promise<string[]> {
  const result = await client.callTool({name:'session_list',arguments:{}})
  assert.notEqual(result.isError, true)
  return ((result.structuredContent as {sessions:Array<{id:string}>}).sessions).map(s => s.id)
}

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
    res.end('<title>MCP connected fixture</title><label>Fruit <input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>')
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
    const batch = await client.callTool({ name:'callisto_batch', arguments:{ actions:[
      {action:'fill_role',role:'textbox',name:'Fruit',value:'pear'},
      {action:'click_role',role:'button',name:'Save'},
    ]} })
    assert.notEqual(batch.isError, true, JSON.stringify(batch.content))
    assert.match(JSON.stringify(batch.content), /pear/)
    const handoff = await client.callTool({name:'callisto_handoff',arguments:{message:'Test handoff timeout',timeout_ms:1000}})
    assert.equal(handoff.isError, true, 'an unacknowledged handoff must report a timeout')
    assert.match(JSON.stringify(handoff.content), /timed out|timeout/i)
    const afterHandoff = await client.callTool({name:'callisto_snapshot',arguments:{}})
    assert.notEqual(afterHandoff.isError, true, JSON.stringify(afterHandoff.content))
    const controller = new AbortController()
    const pending = client.callTool({name:'callisto_handoff',arguments:{message:'Test handoff cancellation',timeout_ms:10000}}, {signal:controller.signal})
    const cancelled = pending.then(() => null, error => error as Error)
    await new Promise(resolve => setTimeout(resolve, 750))
    controller.abort()
    assert.ok(await cancelled, 'cancelling the host request should reject it')
    const afterCancel = await client.callTool({name:'callisto_snapshot',arguments:{}}, {timeout:5000})
    assert.notEqual(afterCancel.isError, true, JSON.stringify(afterCancel.content))
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

test('connected Mini interacts with a scoped fixture, refuses other origins and closes its own session', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type','text/html'); res.end('<title>Connected fixture</title><label>Fruit <input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output><button disabled>Disabled</button><span style="position:relative;display:inline-block"><button>Covered</button><span style="position:absolute;inset:0;background:gray"></span></span>') })
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
    await page.getByRole('textbox',{name:'Fruit'}).fill('mango')
    await mini.press('Control+A')
    await mini.type('banana')
    await page.getByRole('button',{name:'Save'}).click()
    assert.equal(await page.evaluate(() => document.querySelector('output')?.textContent), 'banana')
    assert.equal((await mini.screenshot()).subarray(1, 4).toString(), 'PNG')
    await assert.rejects(mini.click({x:Number.NaN,y:1}), /finite/)
    await assert.rejects(mini.scroll(Number.NaN,0), /finite/)
    await mini.snapshot()
    for (const [name, reason] of [['Disabled','disabled'], ['Covered','covered']]) {
      const ref = mini.ref({role:'button',name,exact:true})!
      assert.ok(ref)
      await assert.rejects(mini.click(ref,{timeout:250}), new RegExp(reason, 'i'))
    }
    await assert.rejects(page.goto('https://example.com/', {timeout:5000}), /allowlist|blocked/i)
  } finally {
    await mini?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(()=>resolve()))
  }
})

test('connected execution is stopped by session reset and refuses a replacement tab', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  let started!: () => void
  const startedRequest = new Promise<void>(resolve => { started = resolve })
  let lateRequests = 0
  const server = createServer((req, res) => {
    if (req.url === '/started') { started(); res.end('ok'); return }
    if (req.url === '/late') { lateRequests++; res.end('unexpected'); return }
    res.setHeader('content-type', 'text/html'); res.end('<title>Cancellation fixture</title>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`
  const control = new Client({name:'callisto-reset-test',version:'1.0.0'})
  const transport = new StdioClientTransport({command:'browse',args:['mcp'],stderr:'pipe'})
  transport.stderr?.on('data', () => {})
  let mini: Mini | undefined
  try {
    await control.connect(transport)
    mini = await Mini.connectBrowse({allowedOrigins:[origin]})
    await mini.goto(origin, {waitUntil:'domcontentloaded'})
    const session = (mini as unknown as {session: Session}).session
    assert.ok(session.connectedExecute && session.connectedSessionId)
    const action = session.connectedExecute(`await page.evaluate(() => fetch('/started')); await page.waitForTimeout(1200); await page.evaluate(() => fetch('/late'))`)
    // Register a rejection handler immediately while reset is in progress.
    const outcome = action.then(() => null, error => error as Error)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([startedRequest, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('execution did not start')), 5000) })])
    } finally { if (timer) clearTimeout(timer) }
    const reset = await control.callTool({name:'session_reset',arguments:{id:session.connectedSessionId}})
    assert.notEqual(reset.isError, true, JSON.stringify(reset.content))
    assert.ok(await outcome, 'reset should interrupt the running action')
    await assert.rejects(mini.press('Enter'), /changed or was taken back|target|closed/i)
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.equal(lateRequests, 0)
  } finally {
    await mini?.close()
    await control.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('closing a connected session leaves another session and its tab intact', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type','text/html'); res.end('<title>Sentinel fixture</title>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  const id = `callisto-sentinel-${randomUUID()}`
  const control = new Client({name:'callisto-ownership-test',version:'1.0.0'})
  const transport = new StdioClientTransport({command:'browse',args:['mcp'],stderr:'pipe'})
  transport.stderr?.on('data', () => {})
  let mini: Mini | undefined
  let sentinelCreated = false
  try {
    await control.connect(transport)
    const created = await control.callTool({name:'session_new',arguments:{id,allowedOrigins:[origin]}})
    assert.notEqual(created.isError, true)
    sentinelCreated = true
    const first = await control.callTool({name:'execute',arguments:{session:id,code:`await page.goto(${JSON.stringify(origin)}); return await page.title()`}})
    assert.equal((first.structuredContent as {value?: unknown})?.value, 'Sentinel fixture')
    mini = await Mini.connectBrowse({allowedOrigins:[origin]})
    await mini.goto(origin, {waitUntil:'domcontentloaded'})
    await mini.close()
    mini = undefined
    const after = await control.callTool({name:'execute',arguments:{session:id,code:'return await page.title()'}})
    assert.notEqual(after.isError, true, JSON.stringify(after.content))
    assert.equal((after.structuredContent as {value?: unknown})?.value, 'Sentinel fixture')
  } finally {
    await mini?.close()
    if (sentinelCreated) await control.callTool({name:'session_delete',arguments:{id}}).catch(() => undefined)
    await control.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('cancelling a connected execution prevents its later action', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let lateRequests = 0
  const server = createServer((req, res) => {
    if (req.url === '/started') { started(); res.end('ok'); return }
    if (req.url === '/late') { lateRequests++; res.end('unexpected'); return }
    res.setHeader('content-type', 'text/html'); res.end('<title>Abort fixture</title>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  let mini: Mini | undefined
  try {
    mini = await Mini.connectBrowse({allowedOrigins:[origin]})
    await mini.goto(origin,{waitUntil:'domcontentloaded'})
    const execute = (mini as unknown as {session:Session}).session.connectedExecute!
    const controller = new AbortController()
    const action = execute(`await page.evaluate(() => fetch('/started')); await page.waitForTimeout(1200); await page.evaluate(() => fetch('/late'))`, {signal:controller.signal})
    const outcome = action.then(() => null, error => error as Error)
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('execution did not start')), 5000) })]) }
    finally { if (timer) clearTimeout(timer) }
    controller.abort()
    assert.ok(await outcome, 'the cancelled action must reject')
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.equal(lateRequests, 0, 'cancellation must stop browser work, not merely reject the caller')
  } finally {
    await mini?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('connected click navigation retires refs from the old document', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(req.url === '/next' ? '<title>New document</title><h1>Arrived</h1><button>New action</button>' : '<title>Old document</title><a href="/next">Continue</a>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  let mini: Mini | undefined
  try {
    mini = await Mini.connectBrowse({allowedOrigins:[origin]})
    await mini.goto(origin,{waitUntil:'domcontentloaded'})
    await mini.snapshot()
    const oldRef = mini.ref({role:'link',name:'Continue',exact:true})!
    assert.ok(oldRef)
    await mini.click(oldRef)
    await mini.waitFor(() => document.title === 'New document', {timeout:5000})
    await assert.rejects(mini.click(oldRef,{timeout:250}), /unknown|stale/i)
    assert.equal((await mini.snapshot()).title, 'New document')
    assert.notEqual(mini.ref({role:'button',name:'New action',exact:true}), oldRef)
    await assert.rejects(mini.click(oldRef,{timeout:250}), /unknown|stale/i)
  } finally {
    await mini?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('disconnecting the MCP host cancels handoff and cleans up its session', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type','text/html'); res.end('<title>Disconnect fixture</title>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  const control = new Client({name:'callisto-disconnect-control',version:'1.0.0'})
  const client = new Client({name:'callisto-disconnect-host',version:'1.0.0'})
  const controlTransport = new StdioClientTransport({command:'browse',args:['mcp'],stderr:'pipe'})
  const hostTransport = new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp.ts'],env:{...process.env,CALLISTO_MCP_BROWSER:'connected',CALLISTO_ALLOWED_ORIGINS:origin} as Record<string,string>,stderr:'pipe'})
  controlTransport.stderr?.on('data', () => {})
  hostTransport.stderr?.on('data', () => {})
  const sessionIds = async () => {
    const result = await control.callTool({name:'session_list',arguments:{}})
    assert.notEqual(result.isError, true)
    return ((result.structuredContent as {sessions:Array<{id:string}>}).sessions).map(s => s.id)
  }
  let ownedId: string | undefined
  try {
    await control.connect(controlTransport)
    const before = new Set(await sessionIds())
    await client.connect(hostTransport)
    const navigation = await client.callTool({name:'callisto_navigate',arguments:{url:origin}})
    assert.notEqual(navigation.isError, true, JSON.stringify(navigation.content))
    const created = (await sessionIds()).filter(id => id.startsWith('callisto-') && !before.has(id))
    assert.equal(created.length, 1)
    ownedId = created[0]
    const handoff = client.callTool({name:'callisto_handoff',arguments:{message:'Disconnect cleanup test',timeout_ms:30000}}).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 750))
    await client.close()
    await handoff
    const deadline = Date.now() + 5000
    while ((await sessionIds()).includes(ownedId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await sessionIds()).includes(ownedId), false, 'host disconnect must promptly remove its session')
    ownedId = undefined
  } finally {
    await client.close().catch(() => undefined)
    if (ownedId) await control.callTool({name:'session_delete',arguments:{id:ownedId}}).catch(() => undefined)
    await control.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('cancelling an MCP click while its target is disabled prevents a later click', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  let clicks = 0
  const server = createServer((req, res) => {
    if (req.url === '/clicked') { clicks++; res.end('ok'); return }
    res.setHeader('content-type','text/html')
    res.end('<button disabled onclick="fetch(\'/clicked\')">Delayed</button>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  const client = new Client({name:'callisto-cancel-click-test',version:'1.0.0'})
  const control = new Client({name:'callisto-cancel-click-control',version:'1.0.0'})
  const controlTransport = new StdioClientTransport({command:'browse',args:['mcp'],stderr:'pipe'})
  controlTransport.stderr?.on('data', () => {})
  const transport = new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp.ts'],env:{...process.env,CALLISTO_MCP_BROWSER:'connected',CALLISTO_ALLOWED_ORIGINS:origin} as Record<string,string>,stderr:'pipe'})
  transport.stderr?.on('data', () => {})
  try {
    await control.connect(controlTransport)
    const before = new Set(await browseSessionIds(control))
    await client.connect(transport)
    const navigation = await client.callTool({name:'callisto_navigate',arguments:{url:origin}})
    assert.notEqual(navigation.isError, true, JSON.stringify(navigation.content))
    const snapshot = JSON.parse((navigation.content as Array<{text:string}>)[0].text)
    const session = (await browseSessionIds(control)).find(id => id.startsWith('callisto-') && !before.has(id))
    assert.ok(session)
    const ref = snapshot.text.match(/\[(ax-\d+)\] button "Delayed"/)?.[1]
    assert.ok(ref)
    const controller = new AbortController()
    const pending = client.callTool({name:'callisto_click',arguments:{ref}}, {signal:controller.signal})
    const outcome = pending.then(() => null, error => error as Error)
    await new Promise(resolve => setTimeout(resolve, 200))
    controller.abort()
    assert.ok(await outcome)
    const enabled = await control.callTool({name:'execute',arguments:{session,code:'await page.evaluate(() => document.querySelector("button").disabled = false)'}})
    assert.notEqual(enabled.isError, true, JSON.stringify(enabled.content))
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(clicks, 0, 'cancelled click must not resume after the button becomes enabled')
    const after = await client.callTool({name:'callisto_snapshot',arguments:{}}, {timeout:5000})
    assert.notEqual(after.isError, true)
    assert.doesNotMatch(JSON.stringify(after.content), /disabled/)
  } finally {
    await client.close()
    await control.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('cancelling a connected navigation stops its pending document load', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let lateRequests = 0
  const server = createServer((req, res) => {
    if (req.url === '/slow') {
      started()
      setTimeout(() => { if (!res.destroyed) { res.setHeader('content-type','text/html'); res.end('<title>Late</title><script>fetch("/late")</script>') } }, 1200)
      return
    }
    if (req.url === '/late') { lateRequests++; res.end('unexpected'); return }
    res.setHeader('content-type','text/html'); res.end('<title>Initial</title>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  const client = new Client({name:'callisto-cancel-navigation-test',version:'1.0.0'})
  const transport = new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp.ts'],env:{...process.env,CALLISTO_MCP_BROWSER:'connected',CALLISTO_ALLOWED_ORIGINS:origin} as Record<string,string>,stderr:'pipe'})
  transport.stderr?.on('data', () => {})
  try {
    await client.connect(transport)
    const first = await client.callTool({name:'callisto_navigate',arguments:{url:origin}})
    assert.notEqual(first.isError, true)
    const controller = new AbortController()
    const pending = client.callTool({name:'callisto_navigate',arguments:{url:`${origin}/slow`}}, {signal:controller.signal})
    const outcome = pending.then(() => null, error => error as Error)
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([ready, new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error('navigation did not start')), 5000) })]) }
    finally { if (timer) clearTimeout(timer) }
    controller.abort()
    assert.ok(await outcome)
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal(lateRequests, 0, 'a cancelled navigation must not later load the document')
  } finally {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('connected snapshot pagination rejects a page navigated outside MCP', { skip: !process.env.CALLISTO_BROWSE_SMOKE }, async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type','text/html')
    if (req.url === '/next') res.end('<title>New document</title><h1>New content</h1>')
    else res.end('<title>Old document</title>' + Array.from({length:200},(_,i)=>`<p>Old paragraph ${i}: ${'context '.repeat(20)}</p>`).join(''))
  })
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  const client = new Client({name:'callisto-navigation-cache-test',version:'1.0.0'})
  const control = new Client({name:'callisto-navigation-cache-control',version:'1.0.0'})
  const controlTransport = new StdioClientTransport({command:'browse',args:['mcp'],stderr:'pipe'})
  controlTransport.stderr?.on('data', () => {})
  const transport = new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp.ts'],env:{...process.env,CALLISTO_MCP_BROWSER:'connected',CALLISTO_ALLOWED_ORIGINS:origin} as Record<string,string>,stderr:'pipe'})
  transport.stderr?.on('data', () => {})
  try {
    await control.connect(controlTransport)
    const before = new Set(await browseSessionIds(control))
    await client.connect(transport)
    const first = await client.callTool({name:'callisto_navigate',arguments:{url:origin}})
    assert.notEqual(first.isError, true, JSON.stringify(first.content))
    const snapshot = JSON.parse((first.content as Array<{text:string}>)[0].text)
    assert.ok(snapshot.nextOffset)
    const session = (await browseSessionIds(control)).find(id => id.startsWith('callisto-') && !before.has(id))
    assert.ok(session)
    const navigation = await control.callTool({name:'execute',arguments:{session,code:`await page.goto(${JSON.stringify(`${origin}/next`)})`}})
    assert.notEqual(navigation.isError, true, JSON.stringify(navigation.content))
    const continuation = await client.callTool({name:'callisto_snapshot',arguments:{offset:snapshot.nextOffset}})
    assert.equal(continuation.isError, true, 'a new document invalidates old snapshot pages')
    const current = await client.callTool({name:'callisto_snapshot',arguments:{}})
    assert.notEqual(current.isError, true, JSON.stringify(current.content))
    assert.match(JSON.stringify(current.content), /New document/)
  } finally {
    await client.close()
    await control.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
