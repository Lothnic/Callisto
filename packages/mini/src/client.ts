// CDP connection plumbing: launch Chromium (via chrome-launcher), connect the
// protocol (via chrome-remote-interface), and pin the viewport. Everything the
// agent-facing surface (index.ts) needs to talk to a real browser.
import * as ChromeLauncher from 'chrome-launcher'
import CDP from 'chrome-remote-interface'
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface Viewport {
  width: number
  height: number
}

export interface LaunchOpts {
  /** default: true */
  headless?: boolean
  /** default: 1440x900 — pinned so the model sees a stable, training-shaped page */
  viewport?: Viewport
  userAgent?: string
  /**
   * Chromium binary path.
   * Defaults: CALLISTO_BROWSER_PATH → CHROME_PATH → Callisto Browser install →
   * bundled packages/mini/browseros (legacy).
   */
  chromePath?: string
  /** extra Chrome flags, e.g. ['--no-sandbox'] in Docker/CI/root environments */
  chromeFlags?: string[]
}

export interface Session {
  cdp: CDP.Client
  chrome?: ChromeLauncher.LaunchedChrome
  viewport: Viewport
  userAgent?: string
  headless: boolean
  mode?: 'connected' | 'attached'
  targetId?: string
  connectedSessionId?: string
  connectedPageSessionId?: string
  dispose?: () => Promise<void>
  /** Run fixed, internally generated page actions under browse's lifecycle. */
  connectedExecute?: (code: string, options?: { signal?: AbortSignal; timeout?: number }) => Promise<unknown>
}

export interface ConnectBrowseOpts {
  /** Explicit navigation scope; no unrestricted connected sessions. */
  allowedOrigins: string[]
  /** The upstream browse CLI executable; defaults to the installed browse. */
  browseCommand?: string
}

export interface ConnectCDPOpts {
  endpoint: string
  targetId: string
}

/** Adopt one explicit page on an already debug-enabled local Chromium. */
export async function connectExistingCDP(opts:ConnectCDPOpts):Promise<Session> {
  const url=new URL(opts.endpoint)
  if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw new Error('CDP endpoint must be a loopback HTTP origin')
  if(!opts.targetId || !/^[A-Za-z0-9_-]+$/.test(opts.targetId))throw new Error('An explicit CDP target ID is required')
  const connection={host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port||80)}
  const pages=await CDP.List(connection)
  if(!pages.some(page=>page.id===opts.targetId && page.type==='page'))throw new Error('The requested page target does not exist')
  const directory=path.join(process.env.XDG_STATE_HOME || path.join(homedir(),'.local/state'),'callisto/chromium-leases')
  mkdirSync(directory,{recursive:true,mode:0o700})
  const lease=path.join(directory,createHash('sha256').update(`${connection.port}:${opts.targetId}`).digest('hex')+'.json')
  const token=randomUUID()
  let fd:number
  try{fd=openSync(lease,'wx',0o600)}catch(error){throw new Error(`CDP target is already leased, or its lease needs recovery: ${lease}`,{cause:error})}
  const release=()=>{try{if(JSON.parse(readFileSync(lease,'utf8')).token===token)unlinkSync(lease)}catch{}}
  try{writeFileSync(fd,JSON.stringify({pid:process.pid,token}));}catch(error){unlinkSync(lease);throw error}finally{closeSync(fd)}
  let cdp:CDP.Client|undefined
  try{
    cdp=await CDP({...connection,target:opts.targetId})
    await Promise.all([cdp.Page.enable(),cdp.DOM.enable(),cdp.Runtime.enable(),cdp.Network.enable(),cdp.Accessibility.enable()])
    const {layoutViewport}=await cdp.Page.getLayoutMetrics()
    return {cdp,viewport:{width:layoutViewport.clientWidth,height:layoutViewport.clientHeight},headless:false,mode:'attached',targetId:opts.targetId,dispose:async()=>{release()}}
  }catch(error){await cdp?.close().catch(()=>{});release();throw error}
}

const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 }
// Match current BrowserOS/Chromium major so UA and binary don't disagree (bot signals).
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const BUNDLED_BROWSEROS = path.resolve(__dirname, '../browseros/browseros')
/** Callisto Browser install / build output (RFC 0006). Checked before stock BrowserOS. */
const CALLISTO_BROWSER_CANDIDATES = [
  process.env.CALLISTO_BROWSER_PATH,
  path.resolve(__dirname, '../../callisto-browser/out/callisto'),
  path.resolve(__dirname, '../../callisto-browser/.work/browseros/out/callisto'),
  path.resolve(process.env.HOME || '', '.local/callisto/callisto'),
].filter((p): p is string => Boolean(p))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function resolveChromePath(explicit?: string): string | undefined {
  if (explicit) return explicit
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  for (const candidate of CALLISTO_BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  if (existsSync(BUNDLED_BROWSEROS)) return BUNDLED_BROWSEROS
  return undefined
}

/** Flags that make Chromium look like a test harness to bot walls. */
const AUTOMATION_FLAG_BLOCKLIST = new Set([
  '--enable-automation',
  '--disable-extensions', // we load our extension explicitly; keep the default off
  '--propagate-iph-for-testing',
])

async function connectCdp(port: number, target?: string): Promise<CDP.Client> {
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await CDP(target ? { port, target } : { port })
    } catch (err) {
      lastError = err
      await sleep(100)
    }
  }
  throw lastError
}

async function enableDomains(cdp: CDP.Client): Promise<void> {
  const { Page, DOM, Runtime, Network, Accessibility } = cdp
  await Promise.all([
    Page.enable(),
    DOM.enable(),
    Runtime.enable(),
    Network.enable(),
    Accessibility.enable(),
  ])
  // Light anti-automation patches. Not a full stealth stack — just avoid the
  // cheapest bot-wall checks (navigator.webdriver, empty plugins, wrong chrome).
  await Page.addScriptToEvaluateOnNewDocument({
    source: `
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (e) {}
      try {
        if (!window.chrome) window.chrome = { runtime: {} };
      } catch (e) {}
      try {
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      } catch (e) {}
      try {
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
      } catch (e) {}
    `,
  })
}



async function applyViewport(
  cdp: CDP.Client,
  viewport: Viewport,
  userAgent?: string,
  headless: boolean = true
): Promise<void> {
  if (headless) {
    await cdp.Emulation.setDeviceMetricsOverride({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
  }
  if (userAgent) await cdp.Network.setUserAgentOverride({ userAgent })
}

function hasNoSandbox(flags: string[]): boolean {
  return flags.some((f) => f === '--no-sandbox' || f.startsWith('--no-sandbox='))
}

/**
 * Ubuntu 23.10+ / many hardened hosts set AppArmor to block unprivileged user
 * namespaces. Chromium then fatals with "No usable sandbox!" and chrome-launcher
 * hangs waiting for a DevTools port that never opens.
 *
 * Detect that (or explicit CALLISTO_NO_SANDBOX=1) and inject --no-sandbox
 * before launch. Opt out with CALLISTO_REQUIRE_SANDBOX=1.
 */
function shouldDisableChromeSandbox(flags: string[]): boolean {
  if (hasNoSandbox(flags)) return false
  if (process.env.CALLISTO_REQUIRE_SANDBOX === '1') return false
  if (process.env.CALLISTO_NO_SANDBOX === '1') return true
  if (process.platform !== 'linux') return false
  try {
    const restricted = readFileSync(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
      'utf8',
    ).trim()
    return restricted === '1'
  } catch {
    return false
  }
}

function buildChromeFlags(opts: LaunchOpts, extra: string[] = []): string[] {
  const headless = opts.headless ?? true
  const defaultFlags = ChromeLauncher.Launcher.defaultFlags().filter((flag) => {
    const base = flag.split('=')[0]
    if (AUTOMATION_FLAG_BLOCKLIST.has(flag) || AUTOMATION_FLAG_BLOCKLIST.has(base)) return false
    if (flag === '--mute-audio') return false
    return true
  })
  const flags = [
    ...defaultFlags,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-browseros-server',
    '--disable-blink-features=AutomationControlled',
  ]
  const extension = path.resolve(__dirname, '../callisto-extension')
  if (existsSync(extension)) flags.push(`--load-extension=${extension}`)
  if (headless) {
    flags.push(`--window-size=${(opts.viewport ?? DEFAULT_VIEWPORT).width},${(opts.viewport ?? DEFAULT_VIEWPORT).height}`)
    flags.push('--headless=new')
  } else {
    flags.push('--start-maximized')
  }
  if (opts.chromeFlags) flags.push(...opts.chromeFlags)
  flags.push(...extra)
  if (shouldDisableChromeSandbox(flags)) {
    process.stderr.write(
      '[callisto/mini] AppArmor restricts unprivileged user namespaces; ' +
        'launching Chrome/BrowserOS with --no-sandbox. ' +
        'Set CALLISTO_REQUIRE_SANDBOX=1 to forbid this.\n',
    )
    flags.push('--no-sandbox', '--disable-setuid-sandbox')
  }
  return flags
}

async function launchOnce(
  flags: string[],
  chromePath: string | undefined,
  viewport: Viewport,
  userAgent: string | undefined,
  headless: boolean,
): Promise<Session> {
  const chrome = await ChromeLauncher.launch({
    chromeFlags: flags,
    ignoreDefaultFlags: true,
    chromePath,
  })
  try {
    const cdp = await connectCdp(chrome.port)
    await enableDomains(cdp)
    await applyViewport(cdp, viewport, userAgent, headless)
    return { cdp, chrome, viewport, userAgent, headless }
  } catch (err) {
    try {
      await chrome.kill()
    } catch {
      /* best-effort */
    }
    throw err
  }
}

function cdpErrorMessage(err: unknown, chromePath: string | undefined): string {
  const base = err instanceof Error ? err.message : String(err)
  return (
    `Failed to connect to Chrome DevTools Protocol (${base}). ` +
    `Binary: ${chromePath ?? 'system default'}. ` +
    `On Ubuntu 23.10+ / AppArmor hosts Chromium often needs --no-sandbox ` +
    `(pass via CLI: ./run.sh --no-sandbox ...). ` +
    `Also ensure CHROME_PATH points at a working BrowserOS/Chrome binary and DISPLAY is set for --visible.`
  )
}

export async function launchChrome(opts: LaunchOpts = {}): Promise<Session> {
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT
  const headless = opts.headless ?? true
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
  const chromePath = resolveChromePath(opts.chromePath)

  const flags = buildChromeFlags(opts)

  try {
    return await launchOnce(flags, chromePath, viewport, userAgent, headless)
  } catch (err) {
    throw new Error(cdpErrorMessage(err, chromePath), { cause: err })
  }
}

/** Repoint the session's protocol connection at another tab (target). */
export async function switchTarget(session: Session, targetId: string): Promise<void> {
  if (session.mode === 'connected') throw new Error('Switching tabs in connected mode is not supported yet')
  if (!session.chrome) throw new Error('No owned Chrome process')
  await session.cdp.close()
  const cdp = await connectCdp(session.chrome.port, targetId)
  await enableDomains(cdp)
  await applyViewport(cdp, session.viewport, session.userAgent, session.headless)
  session.cdp = cdp
}

export async function closeSession(session: Session): Promise<void> {
  if(session.mode==='attached'){try{await session.cdp.close()}finally{await session.dispose?.()}return}
  if (session.mode === 'connected') {
    await session.dispose?.()
    return
  }
  try {
    // Ask the browser to exit before closing the protocol connection. Some
    // launcher wrappers can leave the real Chromium process alive otherwise.
    await session.cdp.Browser.close().catch(() => undefined)
    await session.cdp.close()
  } finally {
    await session.chrome?.kill()
  }
}

/** Attach a new, session-owned tab to the user's browser through browse's relay. */
export async function connectBrowse(opts: ConnectBrowseOpts): Promise<Session> {
  if (!opts.allowedOrigins.length) throw new Error('Connected mode requires at least one allowed origin')
  const id = `callisto-${randomUUID()}`
  const client = new Client({ name: 'callisto-connected', version: '0.1.0' })
  const command = opts.browseCommand ?? process.env.CALLISTO_BROWSE_COMMAND ?? 'browse'
  const env: Record<string, string> = { ...getDefaultEnvironment() }
  for (const [name, value] of Object.entries(process.env)) {
    if (value && (/^OPENCODE_BROWSER_/.test(name) || /^XDG_(CONFIG|DATA|STATE|CACHE)_HOME$/.test(name))) env[name] = value
  }
  const transport = new StdioClientTransport({ command, args: ['mcp'], env, stderr: 'pipe' })
  // Drain diagnostics without exposing relay credentials or blocking the child.
  transport.stderr?.on('data', () => {})
  let raw: CDP.Client | undefined
  let targetId: string | undefined
  let created = false
  const close = async () => {
    if (raw && targetId) await raw.Target.closeTarget({ targetId }).catch(() => undefined)
    if (raw) await raw.close().catch(() => undefined)
    if (created) await client.callTool({ name: 'session_delete', arguments: { id } }).catch(() => undefined)
    await client.close().catch(() => undefined)
  }
  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'session_new', arguments: { id, allowedOrigins: opts.allowedOrigins } })
    if (result.isError) throw new Error('Could not create a connected browser session; check browse status and pairing')
    created = true
    // Let browse create and bind the session's default page. This retains its
    // execution state, focus, stop and ownership lifecycle for later actions.
    const initial = await client.callTool({ name: 'execute', arguments: {
      session: id,
      code: 'const c = await context.newCDPSession(page); try { const r = await c.send("Target.getTargetInfo"); return r.targetInfo.targetId } finally { await c.detach() }',
    } })
    if (initial.isError) throw new Error('Could not initialize the connected browser tab')
    const initialTarget = (initial.structuredContent as {value?: unknown} | undefined)?.value
    if (typeof initialTarget !== 'string' || !initialTarget) throw new Error('browse did not report the connected tab identity')
    targetId = initialTarget
    const status = await client.callTool({ name: 'status', arguments: {} })
    const endpoint = (status.structuredContent as { endpoint?: unknown } | undefined)?.endpoint
    if (typeof endpoint !== 'string') throw new Error('browse did not report a relay endpoint')
    const relayUrl = new URL(endpoint)
    if (relayUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(relayUrl.hostname)) {
      throw new Error('Connected mode only supports a local browse relay')
    }
    const base = process.env.OPENCODE_BROWSER_HOME || path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), 'browse')
    const token = readFileSync(path.join(base, 'relay-token'), 'utf8').trim()
    const response = await fetch(new URL('/json/version', relayUrl), {
      headers: { authorization: `Bearer ${token}`, 'opencode-browser-session-id': id },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`browse relay discovery failed (HTTP ${response.status})`)
    const info = await response.json() as { webSocketDebuggerUrl?: unknown }
    if (typeof info.webSocketDebuggerUrl !== 'string') throw new Error('browse relay did not provide a CDP endpoint')
    const wsUrl = new URL(info.webSocketDebuggerUrl)
    if (wsUrl.protocol !== 'ws:' || wsUrl.host !== relayUrl.host) throw new Error('Unexpected browse CDP endpoint')
    // Do not propagate connection errors: the WebSocket URL contains the relay token.
    try { raw = await CDP({ target: wsUrl.toString(), local: true }) }
    catch { throw new Error('Could not connect to the browse CDP relay') }
    const attached = await raw.Target.attachToTarget({ targetId, flatten: true })
    const pageSession = attached.sessionId
    // The relay exposes a browser-level socket; Mini's page-domain commands
    // must be routed to the one tab we created. Browser/Target calls stay root-scoped.
    const originalSend = raw.send.bind(raw) as (...args: any[]) => any
    const patched = raw as unknown as { send: (...args: any[]) => any }
    patched.send = (method: string, params?: object, sessionOrCallback?: string | ((...args: any[]) => void), callback?: (...args: any[]) => void) => {
      const explicit = typeof sessionOrCallback === 'string' ? sessionOrCallback : undefined
      const cb = typeof sessionOrCallback === 'function' ? sessionOrCallback : callback
      const route = explicit ?? (/^(Target|Browser)\./.test(method) ? undefined : pageSession)
      return originalSend(method, params, route, cb)
    }
    await Promise.all([raw.Page.enable(), raw.DOM.enable(), raw.Runtime.enable(), raw.Network.enable(), raw.Accessibility.enable()])
    const connectedExecute = async (code: string, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<unknown> => {
      // browse may create a replacement after a tab is closed or taken back.
      // Never apply a stale Mini action to that replacement or another tab.
      const verify = `const __c = await context.newCDPSession(page); try { const __i = await __c.send("Target.getTargetInfo"); if (__i.targetInfo.targetId !== ${JSON.stringify(targetId)}) throw new Error("The connected tab changed or was taken back; start a new session.") } finally { await __c.detach() }\n`
      const result = await client.callTool({ name: 'execute', arguments: { session: id, code: verify + code } }, options)
      if (result.isError) {
        const detail = result.content?.find(item => item.type === 'text')
        throw new Error(detail?.type === 'text' ? detail.text : 'Connected browser action failed')
      }
      return (result.structuredContent as {value?: unknown} | undefined)?.value
    }
    // Do not alter the user's UA, viewport, browser-wide download settings or scripts.
    return { cdp: raw, viewport: DEFAULT_VIEWPORT, headless: false, mode: 'connected', targetId, connectedSessionId: id, connectedPageSessionId: pageSession, dispose: close, connectedExecute }
  } catch (error) {
    await close()
    throw error
  }
}
