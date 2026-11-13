import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Mini, Page } from '../src/index.js'
import { createServer } from 'node:http'

const smoke = Boolean(process.env.CALLISTO_SMOKE)

test('browser: password redaction, offscreen actions and form input', { skip: !smoke }, async () => {
  const mini = await Mini.launch({ headless: true, chromeFlags: process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : [] })
  const page = new Page(mini)
  try {
    const html = '<label>Search <input value="old"></label><label>Secret <input type="password" value="my-secret"></label>' +
      '<div style="height:2000px"></div><button onclick="this.textContent=\'Done\'">Offscreen</button>'
    await page.goto('data:text/html,' + encodeURIComponent(html))
    const snap = await page.accessibility.snapshot()
    assert.match(snap.text, /\[REDACTED\]/)
    assert.doesNotMatch(snap.text, /my-secret|•{3}/)
    assert.match(snap.text, /Offscreen/)
    await page.getByRole('textbox', { name: 'Search' }).fill('café ✓')
    assert.equal(await page.evaluate(() => (document.querySelector('input') as HTMLInputElement).value), 'café ✓')
    await page.getByRole('textbox', { name: 'Search' }).press('Control+A')
    await page.keyboard.type('new')
    assert.equal(await page.evaluate(() => (document.querySelector('input') as HTMLInputElement).value), 'new')
    await page.getByRole('button', { name: 'Offscreen' }).click()
    assert.equal(await page.evaluate(() => document.querySelector('button')?.textContent), 'Done')
    await page.reload()
  } finally {
    await mini.close()
  }
})

test('browser: navigation timeout is bounded and the session can recover', { skip: !smoke }, async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.write('<title>Still loading</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const mini = await Mini.launch({ headless: true, chromeFlags: process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : [] })
  try {
    const address = server.address() as { port: number }
    await assert.rejects(mini.goto(`http://127.0.0.1:${address.port}`, { timeout: 200 }), /timed out/)
    await mini.goto('data:text/html,<title>Recovered</title>')
    assert.equal((await mini.snapshot()).title, 'Recovered')
  } finally {
    await mini.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('browser: optional evaluation arguments, text responses and printable chords work', { skip: !smoke }, async () => {
  const server = createServer((req, res) => {
    if (req.url === '/') res.writeHead(200, {'content-type':'text/html'}).end('<label>Text <input></label>')
    else if (req.url === '/json') res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({header:req.headers['x-test']}))
    else res.writeHead(200, {'content-type':'text/plain'}).end('plain response')
  })
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  const mini = await Mini.launch({headless:true})
  const page = new Page(mini)
  try {
    await mini.goto(base)
    assert.deepEqual(await mini.evaluate((a, b, c) => [a, b, c], 'first', undefined, 'third'), ['first',null,'third'])
    assert.equal(await page.request.get(base+'/text'), 'plain response')
    assert.equal(await page.request.post(base+'/text', {data:'hello'}), 'plain response')
    assert.deepEqual(await page.request.post(base+'/json', {headers:{'X-Test':'yes'}}), {header:'yes'})
    await page.getByRole('textbox',{name:'Text'}).fill('a')
    await mini.press('Space')
    await mini.press('b')
    await mini.press('Shift+C')
    await mini.press('Shift+1')
    assert.equal(await mini.evaluate(() => (document.querySelector('input') as HTMLInputElement).value), 'a bC!')
  } finally {
    await mini.close()
    server.closeAllConnections()
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})
