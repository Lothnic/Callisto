// CDP connection plumbing: launch Chromium (via chrome-launcher), connect the
// protocol (via chrome-remote-interface), and pin the viewport. Everything the
// agent-facing surface (index.ts) needs to talk to a real browser.
import * as ChromeLauncher from 'chrome-launcher'
import CDP from 'chrome-remote-interface'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  chrome: ChromeLauncher.LaunchedChrome
  viewport: Viewport
  userAgent?: string
  headless: boolean
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
  await session.cdp.close()
  const cdp = await connectCdp(session.chrome.port, targetId)
  await enableDomains(cdp)
  await applyViewport(cdp, session.viewport, session.userAgent, session.headless)
  session.cdp = cdp
}

export async function closeSession(session: Session): Promise<void> {
  try {
    await session.cdp.close()
  } finally {
    await session.chrome.kill()
  }
}
