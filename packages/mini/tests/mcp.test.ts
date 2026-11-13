import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

async function connect() {
  const client = new Client({ name: 'callisto-test-client', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    env: { ...process.env, OPENROUTER_API_KEY: '', SILICONFLOW_KEY: '', SILICONFLOW_API_KEY: '' } as Record<string, string>,
    stderr: 'pipe',
  })
  await client.connect(transport)
  return client
}

test('MCP: initializes, lists browser tools and validates arguments without launching Chrome', async () => {
  const client = await connect()
  try {
    const { tools } = await client.listTools()
    for (const name of ['callisto_navigate', 'callisto_snapshot', 'callisto_find', 'callisto_batch', 'callisto_extract', 'callisto_run', 'callisto_click', 'callisto_fill', 'callisto_press', 'callisto_scroll', 'callisto_handoff', 'callisto_screenshot', 'callisto_close']) {
      assert.ok(tools.some(tool => tool.name === name), `missing ${name}`)
    }
    assert.notEqual(tools.find(tool => tool.name === 'callisto_extract')?.annotations?.readOnlyHint, true, 'pagination may click a control')
    const bad = await client.callTool({ name: 'callisto_click', arguments: { ref: 'not-a-ref' } })
    assert.equal(bad.isError, true)
    const handoff = await client.callTool({ name: 'callisto_handoff', arguments: {message:'Complete the step'} })
    assert.equal(handoff.isError, true)
    assert.match(JSON.stringify(handoff.content), /connected browser session/)
    const legacyHandoff = await client.callTool({ name: 'callisto_handoff', arguments: {prompt:'Complete the step'} })
    assert.equal(legacyHandoff.isError, true)
    assert.match(JSON.stringify(legacyHandoff.content), /connected browser session/)
    const conflictingHandoff = await client.callTool({ name: 'callisto_handoff', arguments: {message:'One', prompt:'Two'} })
    assert.equal(conflictingHandoff.isError, true)
  } finally { await client.close() }
})

test('MCP: complete a local browser task through tools and close the session', { skip: !process.env.CALLISTO_SMOKE }, async () => {
  const fixture = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    if (req.url === '/long') {
      res.end(Array.from({length:180}, (_, i) => `<p>Paragraph ${i}: ${'context '.repeat(15)} ${i === 179 ? 'HiddenTargetPhrase' : ''}</p>`).join(''))
    } else if (req.url?.startsWith('/grid')) {
      res.end(`<table id="grid"><tbody>
        <tr><td>Alpha</td><td>3</td></tr>
        <tr><td>Beta</td><td>5</td></tr>
      </tbody></table><div id="ready">Grid ready</div>`)
    } else {
      res.end('<label>Fruit <input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>')
    }
  })
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const client = await connect()
  const invoke = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result.content))
    return result.content as Array<{type: string, text?: string}>
  }
  try {
    const port = (fixture.address() as {port: number}).port
    const initial = JSON.parse((await invoke('callisto_navigate', {url: `http://127.0.0.1:${port}/`}))[0].text!)
    const input = initial.text.match(/\[(ax-\d+)\] textbox "Fruit"/)?.[1]
    const button = initial.text.match(/\[(ax-\d+)\] button "Save"/)?.[1]
    assert.ok(input); assert.ok(button)
    await invoke('callisto_fill', {ref: input, value: 'mango'})
    const clicked = JSON.parse((await invoke('callisto_click', {ref: button}))[0].text!)
    assert.match(clicked.text, /mango/)
    const screenshot = await invoke('callisto_screenshot')
    assert.equal(screenshot[0].type, 'image')
    const batch = JSON.parse((await invoke('callisto_batch', {actions: [
      {action:'navigate',url:`http://127.0.0.1:${port}/`},
      {action:'fill_role',role:'textbox',name:'Fruit',value:'pear'},
      {action:'click_role',role:'button',name:'Save'},
    ]}))[0].text!)
    assert.equal(batch.completed, 3)
    assert.match(batch.snapshot.text, /pear/)
    const long = JSON.parse((await invoke('callisto_navigate', {url:`http://127.0.0.1:${port}/long`}))[0].text!)
    assert.ok(long.text.length <= 12000)
    assert.equal(long.nextOffset, 12000)
    const next = JSON.parse((await invoke('callisto_snapshot', {offset:long.nextOffset,max_chars:12000}))[0].text!)
    assert.equal(next.offset, 12000)
    const found = JSON.parse((await invoke('callisto_find', {query:'HiddenTargetPhrase'}))[0].text!)
    assert.match(found.matches[0].text, /HiddenTargetPhrase/)
    await invoke('callisto_navigate', {url: `http://127.0.0.1:${port}/grid`})
    const extraction = JSON.parse((await invoke('callisto_extract', {
      selector: '#grid tbody tr',
      fields: {name: 'td:nth-child(1)', total: {selector: 'td:nth-child(2)', type: 'number'}},
    }))[0].text!)
    assert.equal(extraction.count, 2)
    assert.deepEqual(extraction.rows, [{name: 'Alpha', total: 3}, {name: 'Beta', total: 5}])
    const scripted = JSON.parse((await invoke('callisto_run', {steps: [
      {action: 'navigate', url: `http://127.0.0.1:${port}/grid`},
      {action: 'wait_for', text: 'Grid ready'},
      {action: 'extract', spec: {selector: '#grid tbody tr', fields: {name: 'td:nth-child(1)'}}},
    ]}))[0].text!)
    assert.equal(scripted.completed, 3)
    assert.equal(scripted.extraction.count, 2)
    assert.equal(scripted.snapshot, undefined)
    const afterFind = await client.callTool({name:'callisto_snapshot', arguments:{offset:12000}})
    assert.equal(afterFind.isError, true, 'find replaces the ref registry, so old pages must be discarded')
    await invoke('callisto_navigate', {url:`http://127.0.0.1:${port}/long`})
    const failedBatch = await client.callTool({name:'callisto_batch', arguments:{actions:[
      {action:'navigate',url:`http://127.0.0.1:${port}/`},
      {action:'click_ref',ref:'ax-999999'},
    ]}})
    assert.equal(failedBatch.isError, true)
    const afterBatch = await client.callTool({name:'callisto_snapshot', arguments:{offset:12000}})
    assert.equal(afterBatch.isError, true, 'a partially completed batch must invalidate cached pages')
    await invoke('callisto_close')
  } finally {
    await client.close()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  }
})
