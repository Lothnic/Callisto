#!/usr/bin/env node
/** Local MCP interface over Mini. No model provider or API key is required. */
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import { Mini, Page, type Snapshot } from './index.js'

const server = new McpServer({ name: 'callisto-mcp-server', version: '0.1.0' })
server.registerTool('callisto_capabilities', {
  description: 'Report backend capabilities without starting a browser.',
  inputSchema: {},
}, async () => success({schemaVersion:1,backend:'chromium-cdp',mode:process.env.CALLISTO_MCP_BROWSER ?? 'isolated',snapshot:'accessibility',sessionModel:process.env.CALLISTO_MCP_BROWSER==='attached'?'pinned-target':'per-process',input:{click:'browser-protocol',keyboard:'browser-protocol',fill:'browser-protocol-text-insertion',nativeKeyDefaults:true},capabilities:{trustedInput:true,frames:'same-origin',openShadowRoots:false,upload:false,existingTabAdoption:process.env.CALLISTO_MCP_BROWSER==='attached',cancellation:true,handoff:process.env.CALLISTO_MCP_BROWSER==='connected'}}))
let mini: Mini | undefined
let queue: Promise<void> = Promise.resolve()
let shuttingDown = false
const shutdownAbort = new AbortController()

// One browser belongs to this MCP process. Serializing operations prevents
// concurrent tool calls from mixing page state, refs or browser lifecycle.
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work)
  queue = result.then(() => undefined, () => undefined)
  return result
}
async function browser(): Promise<Mini> {
  if (shuttingDown) throw new Error('Browser session is shutting down')
  if (!mini) {
    const mode = process.env.CALLISTO_MCP_BROWSER ?? 'isolated'
    if (mode === 'connected') {
      const allowedOrigins = (process.env.CALLISTO_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
      mini = await Mini.connectBrowse({ allowedOrigins })
    } else if (mode === 'isolated') {
      mini = await Mini.launch({ headless: process.env.CALLISTO_MCP_HEADLESS !== '0' })
    } else if(mode==='attached') {
      if(!process.env.CALLISTO_CDP_ENDPOINT || !process.env.CALLISTO_CDP_TARGET)throw new Error('Attached mode requires CALLISTO_CDP_ENDPOINT and CALLISTO_CDP_TARGET')
      mini=await Mini.connectCDP({endpoint:process.env.CALLISTO_CDP_ENDPOINT,targetId:process.env.CALLISTO_CDP_TARGET})
    } else throw new Error('CALLISTO_MCP_BROWSER must be isolated, connected or attached')
  }
  return mini
}
function success(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] }
}
function failure(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
}
async function run(work: (m: Mini) => Promise<unknown>, options: { preserveSnapshot?: boolean; signal?: AbortSignal } = {}) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const signals = [shutdownAbort.signal, ...(options.signal ? [options.signal] : [])]
  for (const signal of signals) {
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, {once:true})
  }
  try { return await serial(async () => {
    if (controller.signal.aborted) throw new Error('Request was cancelled')
    // A failed action or batch can still change the page. A new find also
    // refreshes refs, so old snapshot pages must not be served after either.
    if (!options.preserveSnapshot) snapshotCache = undefined
    const m = await browser()
    if (controller.signal.aborted) throw new Error('Request was cancelled')
    return success(await m.withAbortSignal(controller.signal, () => work(m)))
  }) }
  catch (error) { return failure(error) }
  finally { for (const signal of signals) signal.removeEventListener('abort', cancel) }
}
const ref = z.string().regex(/^ax-\d+$/).describe('An ax-N ref from the latest Callisto snapshot')
const annotations = { openWorldHint: true }
const httpUrl = z.url().refine(v => /^https?:/i.test(v), 'Only HTTP(S) URLs are supported')
const maxChars = z.number().int().min(1000).max(30000).optional().default(12000)
let snapshotCache: { value: Snapshot; diff: boolean; revision: number } | undefined

async function boundedSnapshot(m: Mini, options: { diff?: boolean; offset?: number; maxChars?: number } = {}) {
  const offset = options.offset ?? 0
  const limit = options.maxChars ?? 12000
  const diff = options.diff ?? false
  if (offset === 0) {
    // A failed recapture must not leave an older page available as its result.
    snapshotCache = undefined
    const revision = m.getPageRevision()
    const value = await m.snapshot({ diff })
    if (revision !== m.getPageRevision()) throw new Error('The page changed during snapshot capture; try again.')
    snapshotCache = { value, diff, revision }
  }
  if (!snapshotCache || snapshotCache.diff !== diff || snapshotCache.revision !== m.getPageRevision()) {
    snapshotCache = undefined
    throw new Error('No matching captured snapshot; request offset 0 first.')
  }
  const snapshot = snapshotCache.value
  const text = snapshot.text.slice(offset, offset + limit)
  return { ...snapshot, text, offset, totalChars: snapshot.text.length, nextOffset: offset + text.length < snapshot.text.length ? offset + text.length : null }
}

server.registerTool('callisto_navigate', {
  description: 'Open an HTTP(S) URL in the configured Callisto browser session and return its accessibility snapshot. The browser session starts on the first call.',
  inputSchema: z.object({ url: httpUrl }),
  annotations,
}, async ({ url }, context) => run(async m => { await m.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }); return boundedSnapshot(m) }, {signal:context.mcpReq.signal}))

server.registerTool('callisto_snapshot', {
  description: 'Get a bounded accessibility snapshot with ax-N refs. Use nextOffset to page through the last captured snapshot; a new capture replaces it. Refs can become stale when the page changes. diff=true captures changes since the previous snapshot.',
  inputSchema: z.object({ diff: z.boolean().optional().default(false), offset: z.number().int().min(0).optional().default(0), max_chars: maxChars }),
  annotations: { ...annotations, readOnlyHint: true },
}, async ({ diff, offset, max_chars }, context) => run(m => boundedSnapshot(m, { diff, offset, maxChars: max_chars }), { preserveSnapshot: true, signal:context.mcpReq.signal }))

server.registerTool('callisto_find', {
  description: 'Find text in the full accessibility snapshot and return bounded matching snippets, including nearby refs when present.',
  inputSchema: z.object({ query: z.string().min(1).max(200), max_matches: z.number().int().min(1).max(10).optional().default(5) }),
  annotations: { ...annotations, readOnlyHint: true },
}, async ({ query, max_matches }, context) => run(async m => {
  const snapshot = await m.snapshot()
  const haystack = snapshot.text.toLowerCase(), needle = query.toLowerCase()
  const matches: Array<{ offset: number; text: string }> = []
  let pos = 0
  while (matches.length < max_matches) {
    const index = haystack.indexOf(needle, pos)
    if (index < 0) break
    matches.push({ offset: index, text: snapshot.text.slice(Math.max(0, index - 120), Math.min(snapshot.text.length, index + query.length + 120)) })
    pos = index + needle.length
  }
  return { url: snapshot.url, title: snapshot.title, matches, ...(snapshot.warnings ? { warnings: snapshot.warnings } : {}) }
}, {signal:context.mcpReq.signal}))

server.registerTool('callisto_click', {
  description: 'Click a snapshot ref after checking visibility, stability, enabled state and whether it receives events. Return an updated snapshot.',
  inputSchema: z.object({ ref }), annotations,
}, async ({ ref: target }, context) => run(async m => { await m.click(target); return boundedSnapshot(m) }, {signal:context.mcpReq.signal}))

server.registerTool('callisto_fill', {
  description: 'Replace the value of an editable snapshot ref and return an updated snapshot.',
  inputSchema: z.object({ ref, value: z.string().max(100_000) }), annotations,
}, async ({ ref: target, value }, context) => run(async m => { await m.fill(target, value); return boundedSnapshot(m) }, {signal:context.mcpReq.signal}))

server.registerTool('callisto_press', {
  description: 'Press a supported key or chord, such as Enter, Escape, ArrowDown or Control+A, on the focused element; return an updated snapshot.',
  inputSchema: z.object({ key: z.string().min(1).max(40) }), annotations,
}, async ({ key }, context) => run(async m => { await m.press(key); return boundedSnapshot(m) }, {signal:context.mcpReq.signal}))

server.registerTool('callisto_scroll', {
  description: 'Scroll by pixel deltas at the viewport center and return an updated snapshot.',
  inputSchema: z.object({ delta_x: z.number().finite().default(0), delta_y: z.number().finite() }), annotations,
}, async ({ delta_x, delta_y }, context) => run(async m => { await m.scroll(delta_x, delta_y); return boundedSnapshot(m) }, {signal:context.mcpReq.signal}))

server.registerTool('callisto_handoff', {
  description: 'In connected mode, ask the person to complete a step in the session-owned browser tab and wait for their confirmation. A confirmation does not verify the outcome; inspect the returned snapshot. The request may time out or be cancelled.',
  inputSchema: z.object({ message: z.string().trim().min(1).max(500).optional(), prompt: z.string().trim().min(1).max(500).optional(), timeout_ms: z.number().int().min(1000).max(120000).default(60000) }).refine(args => Boolean(args.message || args.prompt) && (!args.message || !args.prompt || args.message === args.prompt), 'Provide message (or legacy prompt); both must match if supplied'),
  annotations,
}, async ({ message, prompt, timeout_ms }, context) => {
  if (process.env.CALLISTO_MCP_BROWSER !== 'connected') return failure(new Error('Human handoff requires a connected browser session'))
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const signals = [context.mcpReq.signal, shutdownAbort.signal]
  for (const signal of signals) {
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, {once:true})
  }
  try {
    return await run(async m => {
      await m.handoff((message ?? prompt)!, {timeoutMs:timeout_ms, signal:controller.signal})
      return boundedSnapshot(m)
    }, {signal:controller.signal})
  } finally {
    for (const signal of signals) signal.removeEventListener('abort', cancel)
  }
})

const batchAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: httpUrl }),
  z.object({ action: z.literal('click_ref'), ref }),
  z.object({ action: z.literal('click_role'), role: z.string().min(1).max(50), name: z.string().min(1).max(200) }),
  z.object({ action: z.literal('fill_ref'), ref, value: z.string().max(100000) }),
  z.object({ action: z.literal('fill_role'), role: z.string().min(1).max(50), name: z.string().min(1).max(200), value: z.string().max(100000) }),
  z.object({ action: z.literal('press'), key: z.string().min(1).max(40) }),
  z.object({ action: z.literal('scroll'), delta_x: z.number().finite(), delta_y: z.number().finite() }),
])
server.registerTool('callisto_batch', {
  description: 'Execute up to 10 structured browser actions in order and return a bounded snapshot. Prior actions are not rolled back if a later action fails.',
  inputSchema: z.object({ actions: z.array(batchAction).min(1).max(10) }), annotations,
}, async ({ actions }, context) => run(async m => {
  const page = new Page(m)
  for (const [index, step] of actions.entries()) {
    try {
      switch (step.action) {
        case 'navigate': await m.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); break
        case 'click_ref': await m.click(step.ref); break
        case 'click_role': await page.getByRole(step.role, { name: step.name, exact: true }).click(); break
        case 'fill_ref': await m.fill(step.ref, step.value); break
        case 'fill_role': await page.getByRole(step.role, { name: step.name, exact: true }).fill(step.value); break
        case 'press': await m.press(step.key); break
        case 'scroll': await m.scroll(step.delta_x, step.delta_y); break
      }
    } catch (error) {
      throw new Error(`Batch stopped at step ${index + 1} (${step.action}); earlier actions may have completed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { completed: actions.length, snapshot: await boundedSnapshot(m) }
}, {signal:context.mcpReq.signal}))

server.registerTool('callisto_screenshot', {
  description: 'Capture the current browser viewport as a PNG image.',
  inputSchema: z.object({}), annotations: { ...annotations, readOnlyHint: true },
}, async () => {
  try {
    return await serial(async () => ({ content: [{ type: 'image' as const, data: (await (await browser()).screenshot()).toString('base64'), mimeType: 'image/png' }] }))
  } catch (error) { return failure(error) }
})

server.registerTool('callisto_close', {
  description: 'Close the Callisto browser session and its agent-owned tab. A later browser call starts a fresh session.',
  inputSchema: z.object({}), annotations,
}, async () => {
  try {
    return await serial(async () => { const previous = mini; mini = undefined; snapshotCache = undefined; if (previous) await previous.close(); return success('Browser closed.') })
  } catch (error) { return failure(error) }
})

function cleanup(): Promise<void> {
  if (shuttingDown) return queue
  shuttingDown = true
  shutdownAbort.abort()
  return serial(async () => { const previous = mini; mini = undefined; snapshotCache = undefined; if (previous) await previous.close() })
}
server.server.onclose = () => {
  void cleanup().catch(error => process.stderr.write(`Callisto cleanup failed: ${String(error)}\n`))
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void cleanup().catch(error => process.stderr.write(`Callisto cleanup failed: ${String(error)}\n`))
      .finally(() => process.exit(0))
  })
}
await server.connect(new StdioServerTransport())
