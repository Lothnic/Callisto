import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Mini, Page } from '../src/index.js'
import type { EventEmitter } from 'node:events'

const enabled = Boolean(process.env.CALLISTO_SMOKE)

test('browser: CDP clicks and text input produce trusted browser events', { skip: !enabled }, async () => {
  const mini = await Mini.launch({headless:true})
  try {
    const html = `<label>Probe <input></label><button>Probe button</button>
      <script>window.events=[]; for (const type of ['click','keydown','input'])
      document.addEventListener(type, e => window.events.push({type, trusted:e.isTrusted}), true)</script>`
    await mini.goto('data:text/html,' + encodeURIComponent(html))
    await mini.snapshot()
    const button = mini.ref({role:'button', name:'Probe button', exact:true})!
    const input = mini.ref({role:'textbox', name:'Probe', exact:true})!
    assert.ok(button && input)
    await mini.click(button)
    await mini.fill(input, 'hello')
    await mini.press('A')
    const result = await mini.evaluate(() => ({
      events: (window as any).events as Array<{type:string; trusted:boolean}>,
      value: (document.querySelector('input') as HTMLInputElement).value,
    }))
    for (const type of ['click','keydown','input']) {
      assert.ok(result.events.some(event => event.type === type && event.trusted), `${type} should be trusted`)
    }
    assert.match(result.value, /^hello/i)
  } finally { await mini.close() }
})

test('browser: click waits for submitted document before the next snapshot', {skip:!enabled}, async()=>{
  const {createServer}=await import('node:http')
  const server=createServer((req,res)=>{
    res.setHeader('content-type','text/html')
    if(req.url?.startsWith('/next'))setTimeout(()=>res.end('<title>Submitted document</title><h1>Saved result</h1>'),80)
    else res.end('<form action="/next"><button>Submit fixture</button></form>')
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const mini=await Mini.launch({headless:true})
  try{
    await mini.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}/`)
    const snapshot=await mini.snapshot()
    const ref=snapshot.text.match(/\[(ax-\d+)\] button "Submit fixture"/)![1]
    await mini.click(ref)
    const result=await mini.snapshot()
    assert.equal(result.title,'Submitted document')
    assert.match(result.text,/Saved result/)
  }finally{await mini.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('browser: repeated Enter presses release navigation listeners', { skip: !enabled }, async () => {
  const mini = await Mini.launch({headless:true, chromeFlags: process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : []})
  try {
    await mini.goto('data:text/html,<input autofocus>')
    const cdp = (mini as unknown as {session: {cdp: EventEmitter}}).session.cdp
    const before = ['Page.frameNavigated', 'Page.loadEventFired'].map(event => cdp.listenerCount(event))
    for (let i = 0; i < 3; i++) await mini.press('Enter')
    assert.deepEqual(['Page.frameNavigated', 'Page.loadEventFired'].map(event => cdp.listenerCount(event)), before)
  } finally { await mini.close() }
})

test('browser: Enter navigation updates the page after a form submission', { skip: !enabled }, async () => {
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(req.url?.startsWith('/next') ? '<title>After submit</title><h1>Submitted</h1>' :
      '<title>Before submit</title><form action="/next"><input name="query" autofocus></form>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const mini = await Mini.launch({headless:true, chromeFlags: process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : []})
  try {
    await mini.goto(`http://127.0.0.1:${(server.address() as {port: number}).port}/`)
    await mini.evaluate(() => document.querySelector('input')?.focus())
    await mini.press('Enter')
    const result = await mini.snapshot()
    assert.equal(result.title, 'After submit')
    assert.match(result.text, /Submitted/)
  } finally {
    await mini.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('browser: a covered drag destination fails before pressing the mouse', { skip: !enabled }, async () => {
  const mini = await Mini.launch({headless:true, chromeFlags: process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : []})
  try {
    const html = `<button id="source">Source</button>
      <span style="position:relative;display:inline-block"><button>Destination</button>
      <span style="position:absolute;inset:0;background:gray"></span></span>
      <script>window.presses=0; document.addEventListener('mousedown',()=>window.presses++)</script>`
    await mini.goto('data:text/html,' + encodeURIComponent(html))
    await mini.snapshot()
    const source = mini.ref({role:'button', name:'Source', exact:true})!
    const destination = mini.ref({role:'button', name:'Destination', exact:true})!
    assert.ok(source && destination)
    await assert.rejects(mini.dragTo(source, destination), /covered|not receiving events/)
    assert.equal(await mini.evaluate(() => (window as any).presses), 0)
  } finally { await mini.close() }
})

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
