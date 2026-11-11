// Small end-to-end model-driven comparison on a local, resettable site.
// Run from packages/mini via npm run benchmark:agent (see README).
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from '../../packages/mini/node_modules/playwright-core/index.mjs'
import { Mini, Page } from '../../packages/mini/dist/index.js'

const envFile = await readFile(new URL('../../.env', import.meta.url), 'utf8').catch(() => '')
function env(name) {
  const line = envFile.split(/\r?\n/).find(x => x.startsWith(name + '='))
  return process.env[name] || (line ? line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '') : '')
}
const provider = process.env.BENCH_PROVIDER || 'siliconflow'
if (!['siliconflow', 'openrouter'].includes(provider)) throw new Error('BENCH_PROVIDER must be siliconflow or openrouter')
const key = provider === 'openrouter' ? env('OPENROUTER_API_KEY') : env('SILICONFLOW_KEY') || env('SILICONFLOW_API_KEY')
if (!key) throw new Error(`Provider key is not configured for ${provider}`)
const endpoint = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.siliconflow.com/v1/chat/completions'
const model = process.env.BENCH_MODEL || (provider === 'openrouter' ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'tencent/Hy3')
const chromePath = process.env.CHROME_PATH
if (!chromePath) throw new Error('Set CHROME_PATH to the browser binary')
const tasks = [
  { id:'click', instruction:'Click the button named Confirm.', html:'<button onclick="document.body.dataset.done=\'yes\'">Confirm</button>' },
  { id:'form', instruction:'Enter mango into the field labelled Fruit and click Save.', html:'<label>Fruit <input id="fruit"></label><button onclick="document.body.dataset.done=document.querySelector(\'#fruit\').value===\'mango\'?\'yes\':\'no\'">Save</button>' },
  { id:'delayed', instruction:'Click the button named Continue after it becomes enabled.', html:'<button disabled onclick="document.body.dataset.done=\'yes\'">Continue</button><script>setTimeout(()=>document.querySelector("button").disabled=false, 700)</script>' },
]
const server = createServer((req,res) => {
  const task = tasks.find(t=>req.url===`/${t.id}`)
  res.writeHead(task?200:404, {'content-type':'text/html'})
  res.end(`<!doctype html><title>Fixture</title><body data-done="no">${task?.html||'Not found'}</body>`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base = `http://127.0.0.1:${server.address().port}`
const args = process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : []
const execFile = promisify(execFileCallback)
const engines = (process.env.BENCH_ENGINES || 'mini,playwright').split(',')
if (engines.some(engine => !['mini','playwright','browse'].includes(engine))) throw new Error('Unsupported BENCH_ENGINES')
let mini, browser, browseSession, previousSession
const results = []
async function browseExecute(code) {
  const { stdout } = await execFile('browse', ['execute','--json','--session',browseSession,'--timeout-ms','10000',code], { timeout: 20000, maxBuffer: 1_000_000 })
  const response = JSON.parse(stdout)
  if (!response.ok) throw new Error(response.error?.message || response.text || 'browse execute failed')
  return response.value
}
function browsePage() {
  return {
    goto: url => browseExecute(`await page.goto(${JSON.stringify(url)}); return null`),
    evaluate: fn => browseExecute(`return await page.evaluate(${fn.toString()})`),
    getByRole: (role, options) => ({
      click: () => browseExecute(`await page.getByRole(${JSON.stringify(role)},${JSON.stringify(options)}).click({timeout:2000}); return null`),
      fill: value => browseExecute(`await page.getByRole(${JSON.stringify(role)},${JSON.stringify(options)}).fill(${JSON.stringify(value)},{timeout:2000}); return null`),
    }),
  }
}
async function observe(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('button,input')).map(el => ({
    role: el.tagName === 'BUTTON' ? 'button' : 'textbox',
    name: el.getAttribute('aria-label') || el.closest('label')?.innerText.trim() || el.textContent.trim(),
    disabled: Boolean(el.disabled), value: el.tagName === 'INPUT' ? el.value : undefined,
  })))
}
async function runTask(engine,page,task) {
  const start = performance.now()
  let usage = {prompt_tokens:0, completion_tokens:0}, calls = 0, error = null, answer = null
  const trace = []
  await page.goto(`${base}/${task.id}`)
  const messages = [{role:'system',content:'You control a small test browser. Return ONLY one JSON object per turn: {"action":"click","role":"button","name":"..."}, {"action":"fill","role":"textbox","name":"...","value":"..."}, {"action":"wait"}, or {"action":"done"}. Do not invent other actions. Observe the page after each action. Complete the requested task, then say done.'}, {role:'user',content:task.instruction}]
  for (let turn=0; turn<6; turn++) {
    const observation = await observe(page)
    messages.push({role:'user',content:'Page controls: '+JSON.stringify(observation)})
    let data
    try {
      const response = await fetch(endpoint, {method:'POST',headers:{'Content-Type':'application/json', Authorization:`Bearer ${key}`},body:JSON.stringify({model,temperature:0,max_tokens:256,messages}),signal:AbortSignal.timeout(45000)})
      data = await response.json()
      if (!response.ok) throw new Error(`model request HTTP ${response.status}: ${data.error?.message || 'error'}`)
    } catch(e) { error = String(e.message || e); break }
    calls++
    usage.prompt_tokens += data.usage?.prompt_tokens || 0
    usage.completion_tokens += data.usage?.completion_tokens || 0
    const content = data.choices?.[0]?.message?.content || ''
    messages.push({role:'assistant',content})
    let action
    try { action = JSON.parse(content.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')) }
    catch { error = 'model returned invalid action JSON'; trace.push({content:content.slice(0,500),error}); break }
    try {
      if (action.action === 'done') { answer = 'done'; trace.push({action}); break }
      if (action.action === 'wait') await new Promise(r=>setTimeout(r,250))
      else if (action.action === 'click') await page.getByRole(action.role,{name:action.name,exact:true}).click()
      else if (action.action === 'fill') await page.getByRole(action.role,{name:action.name,exact:true}).fill(String(action.value ?? ''))
      else throw new Error('unsupported action')
      trace.push({action,ok:true})
      messages.push({role:'user',content:'Action succeeded.'})
    } catch(e) { const message = String(e.message || e).slice(0,300); trace.push({action,ok:false,error:message}); messages.push({role:'user',content:`Action failed: ${message}`}) }
  }
  const success = await page.evaluate(() => document.body.dataset.done === 'yes')
  return {engine,task:task.id,success,answer,error,calls,usage,elapsedMs:Math.round(performance.now()-start),trace}
}
try {
  const pages = {}
  if (engines.includes('mini')) {
    mini = await Mini.launch({headless:true,chromePath,chromeFlags:args})
    pages.mini = new Page(mini)
  }
  if (engines.includes('playwright')) {
    browser = await chromium.launch({executablePath:chromePath,headless:true,args})
    const ctx = await browser.newContext({viewport:{width:1440,height:900}})
    pages.playwright = await ctx.newPage(); pages.playwright.setDefaultTimeout(2000)
  }
  if (engines.includes('browse')) {
    previousSession = (await execFile('browse', ['session','current'])).stdout.trim()
    browseSession = `callisto-eval-${Date.now()}`
    await execFile('browse', ['session','new',browseSession,'--allow-origin',base])
    pages.browse = browsePage()
  }
  for (const task of tasks) {
    for (const engine of engines) {
      const page = pages[engine]
      const result = await runTask(engine,page,task)
      results.push(result)
      process.stderr.write(`${engine} ${task.id}: ${result.success?'PASS':'FAIL'} (${result.calls} model calls)\n`)
    }
  }
  const report={createdAt:new Date().toISOString(),provider,model,protocol:'Same model, JSON action policy, observation and fixture; isolated warm Chrome instances; one trial each.',results}
  console.log(JSON.stringify(report,null,2))
  if (process.env.BENCH_OUTPUT) await writeFile(process.env.BENCH_OUTPUT,JSON.stringify(report,null,2)+'\n')
} finally {
  if (browser) await browser.close()
  if (mini) await mini.close()
  if (browseSession) {
    await execFile('browse', ['session','delete',browseSession]).catch(() => undefined)
    if (previousSession && previousSession !== 'none') await execFile('browse', ['session','use',previousSession]).catch(() => undefined)
  }
  await new Promise(resolve=>server.close(resolve))
}
