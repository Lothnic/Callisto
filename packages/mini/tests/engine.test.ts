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
