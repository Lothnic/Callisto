// CDP connection plumbing: launch Chromium (via chrome-launcher), connect the
// protocol (via chrome-remote-interface), and pin the viewport. Everything the
// agent-facing surface (index.ts) needs to talk to a real browser.
import * as ChromeLauncher from 'chrome-launcher'
import CDP from 'chrome-remote-interface'
import { existsSync } from 'node:fs'
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
  /** Chrome/BrowserOS binary path. Defaults to CHROME_PATH, then bundled BrowserOS. */
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
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const BUNDLED_BROWSEROS = path.resolve(__dirname, '../browseros/browseros')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  // Bypass basic automation detection by removing navigator.webdriver safely
  await Page.addScriptToEvaluateOnNewDocument({
    source: `
      try {
        const newProto = Object.getPrototypeOf(navigator);
        delete newProto.webdriver;
      } catch (e) {}
    `
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

export async function launchChrome(opts: LaunchOpts = {}): Promise<Session> {
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT
  const headless = opts.headless ?? true
  const defaultFlags = ChromeLauncher.Launcher.defaultFlags().filter(
    (flag) => flag !== '--disable-extensions' && flag !== '--mute-audio'
  )
  const flags = [
    ...defaultFlags,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-browseros-server',
    `--load-extension=${path.resolve(__dirname, '../callisto-extension')}`,
  ]
  if (headless) {
    flags.push(`--window-size=${viewport.width},${viewport.height}`)
    flags.push('--headless=new')
  } else {
    flags.push('--start-maximized')
  }
  if (opts.chromeFlags) flags.push(...opts.chromeFlags)

  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
  const chromePath = opts.chromePath ?? process.env.CHROME_PATH ?? (existsSync(BUNDLED_BROWSEROS) ? BUNDLED_BROWSEROS : undefined)
  const chrome = await ChromeLauncher.launch({ chromeFlags: flags, ignoreDefaultFlags: true, chromePath })
  const cdp = await connectCdp(chrome.port)
  await enableDomains(cdp)
  await applyViewport(cdp, viewport, userAgent, headless)
  return { cdp, chrome, viewport, userAgent, headless }
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
