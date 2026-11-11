import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Mini, Page } from '../src/index.js'

const enabled = Boolean(process.env.CALLISTO_SMOKE)

test('browser: waits for enabled, uncovered and stable targets; fails safely otherwise', { skip: !enabled }, async () => {
  const mini = await Mini.launch({headless:true, chromeFlags: process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : []})
  const page = new Page(mini)
  try {
    const html = `<style>
      #moving {position:relative; animation: slide 1s linear infinite alternate}
      @keyframes slide { from {left:0} to {left:120px} }
      #wrap {position:relative;display:inline-block} #cover {position:absolute;inset:0;background:gray}
      </style>
      <button id="disabled" disabled onclick="window.clicked='disabled'">Disabled</button>
      <span id="wrap"><button id="covered" onclick="window.clicked='covered'">Covered</button><span id="cover"></span></span>
      <button id="moving" onclick="window.clicked='moving'">Moving</button>
      <input aria-label="Read only" readonly value="original">
      <script>window.clicked='none'</script>`
    await page.goto('data:text/html,' + encodeURIComponent(html))
    await page.accessibility.snapshot()
    for (const [name, reason] of [['Disabled','disabled'], ['Covered','covered'], ['Moving','moving']]) {
      const ref = mini.ref({role:'button', name, exact:true})!
      assert.ok(ref, `missing ${name}`)
      await assert.rejects(mini.click(ref, {timeout:250}), new RegExp(reason, 'i'))
      assert.equal(await page.evaluate(() => (window as any).clicked), 'none')
    }
    await assert.rejects(page.getByRole('textbox', {name:'Read only'}).fill('overwrite'), /not editable/)
    assert.equal(await page.evaluate(() => document.querySelector('input')!.value), 'original')
    for (const name of ['Disabled','Covered','Moving']) {
      await page.evaluate((name: string) => {
        setTimeout(() => {
          if (name === 'Disabled') (document.querySelector('#disabled') as HTMLButtonElement).disabled = false
          if (name === 'Covered') document.querySelector('#cover')!.remove()
          if (name === 'Moving') (document.querySelector('#moving') as HTMLElement).style.animation = 'none'
        }, 200)
      }, name)
      const start = Date.now()
      await page.getByRole('button',{name, exact:true}).click()
      assert.ok(Date.now() - start >= 150, `${name} should wait for the condition to clear`)
    }
    assert.equal(await page.evaluate(() => (window as any).clicked), 'moving')
  } finally { await mini.close() }
})

test('browser: clicks a same-origin iframe target and refuses a covered frame', { skip: !enabled }, async () => {
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/child') res.end('<button onclick="document.body.dataset.clicked=\'yes\'">Inside frame</button>')
    else res.end('<style>iframe{margin:30px;border:4px solid;display:block} #cover{position:absolute;left:30px;top:30px;width:400px;height:200px;background:gray;z-index:2}</style><iframe src="/child" width="350" height="130"></iframe>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const mini = await Mini.launch({headless:true,chromeFlags:process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : []})
  try {
    const port = (server.address() as {port:number}).port
    await mini.goto(`http://127.0.0.1:${port}/`)
    const snap = await mini.snapshot()
    const ref = snap.text.split('\n').find(l=>l.includes('Inside frame'))?.match(/\[(ax-\d+)\]/)?.[1]
    assert.ok(ref, 'iframe button should have a ref')
    await mini.click(ref)
    assert.equal(await mini.evaluate(() => document.querySelector('iframe')?.contentDocument?.body.dataset.clicked), 'yes')
    await mini.evaluate(() => { document.querySelector('iframe')!.contentDocument!.body.dataset.clicked = 'no'; document.body.insertAdjacentHTML('beforeend','<div id="cover"></div>') })
    await assert.rejects(mini.click(ref, {timeout:300}), /iframe covered/)
    assert.equal(await mini.evaluate(() => document.querySelector('iframe')?.contentDocument?.body.dataset.clicked), 'no')
  } finally {
    await mini.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})
