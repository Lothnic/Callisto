import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { Mini, Page } from '../dist/index.js'

const chromePath = process.env.CHROME_PATH
if (!chromePath) throw new Error('Set CHROME_PATH to the same Chrome binary for both engines')
const repetitions = Number(process.env.BENCH_REPETITIONS ?? 5)
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('BENCH_REPETITIONS must be a positive integer')
const html = `<!doctype html><title>Fixture</title>
<label>Search <input id="search" value="old"></label><label>Password <input type="password" value="secret-value"></label>
<button id="submit" onclick="document.querySelector('#result').textContent=document.querySelector('#search').value">Submit</button><output id="result"></output>
<div style="height:1600px"></div><button id="offscreen" onclick="this.textContent='Done'">Offscreen</button>`
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const args = process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : []
let mini, browser
const results = []
async function trial(engine, name, run) {
  const start = performance.now()
  try { await run(); results.push({engine, name, ok: true, ms: +(performance.now()-start).toFixed(2)}) }
  catch (e) { results.push({engine, name, ok: false, ms: +(performance.now()-start).toFixed(2), error: String(e.message ?? e)}) }
}
const assert = (v, message) => { if (!v) throw new Error(message) }
try {
  mini = await Mini.launch({ headless: true, chromePath, chromeFlags: args })
  const cp = new Page(mini)
  browser = await chromium.launch({ executablePath: chromePath, headless: true, args })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pw = await context.newPage()
  pw.setDefaultTimeout(2000)
  for (let i=0; i<repetitions; i++) {
    for (const engine of (i % 2 ? ['playwright','mini'] : ['mini','playwright'])) {
      const isMini = engine === 'mini'
      const page = isMini ? cp : pw
      const reset = () => page.goto(url)
      await trial(engine, 'navigation', reset)
      await trial(engine, 'form', async () => {
        if (isMini) await cp.accessibility.snapshot()
        await page.getByRole('textbox', {name: 'Search'}).fill('café ✓')
        await page.getByRole('button', {name: 'Submit'}).click()
        assert(await page.evaluate(() => document.querySelector('#result').textContent) === 'café ✓', 'form result mismatch')
      })
      await trial(engine, 'keyboard selection', async () => {
        if (isMini) await cp.accessibility.snapshot()
        await page.getByRole('textbox', {name: 'Search'}).press('Control+A')
        await page.keyboard.type('new')
        assert(await page.evaluate(() => document.querySelector('#search').value) === 'new', 'keyboard selection failed')
      })
      await trial(engine, 'offscreen click', async () => {
        if (isMini) await cp.accessibility.snapshot()
        await page.getByRole('button', {name: 'Offscreen'}).click()
        assert(await page.evaluate(() => document.querySelector('#offscreen').textContent) === 'Done', 'offscreen click failed')
      })
      await trial(engine, 'snapshot or aria', async () => {
        if (isMini) {
          const snap = await cp.accessibility.snapshot()
          assert(!snap.text.includes('secret-value') && !/•{3}/.test(snap.text), 'password leaked or was not redacted')
          assert(snap.text.includes('[REDACTED]'), 'password marker missing')
        } else await pw.locator('body').ariaSnapshot()
      })
      await trial(engine, 'delayed target', async () => {
        await reset()
        await page.evaluate(() => setTimeout(() => {
          const b = document.createElement('button'); b.textContent = 'Delayed'
          b.onclick = () => { b.textContent = 'Activated' }; document.body.appendChild(b)
        }, 100))
        if (isMini) await cp.accessibility.snapshot()
        await page.getByRole('button', {name: 'Delayed'}).click()
        assert(await page.evaluate(() => document.body.textContent.includes('Activated')), 'delayed target not activated')
      })
      await trial(engine, 'ambiguous target rejected', async () => {
        await reset()
        await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<button>Duplicate</button><button>Duplicate</button>') })
        if (isMini) await cp.accessibility.snapshot()
        let rejected = false
        try { await page.getByRole('button', {name: 'Duplicate', exact: true}).click() } catch { rejected = true }
        assert(rejected, 'ambiguous target was clicked instead of rejected')
      })
    }
  }
  const summary = {}
  for (const engine of ['mini','playwright']) for (const name of [...new Set(results.map(r=>r.name))]) {
    const rows = results.filter(r=>r.engine===engine && r.name===name)
    const times = rows.filter(r=>r.ok).map(r=>r.ms).sort((a,b)=>a-b)
    summary[`${engine}:${name}`] = {success: rows.filter(r=>r.ok).length, total: rows.length, medianMs: times.length ? times[Math.floor(times.length/2)] : null}
  }
  const report = { generatedAt: new Date().toISOString(), chromeVersion: await browser.version(), playwrightVersion: (await import('playwright-core/package.json', {with:{type:'json'}})).default.version, repetitions, caveats: 'Warm browser, local deterministic fixture, no LLM, snapshots use different formats; timings include assertions and are not task-agent results.', summary, results }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.BENCH_OUTPUT) await writeFile(process.env.BENCH_OUTPUT, JSON.stringify(report, null, 2)+'\n')
} finally {
  if (browser) await browser.close()
  if (mini) await mini.close()
  await new Promise(resolve => server.close(resolve))
}
