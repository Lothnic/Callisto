// CDP connection plumbing: launch Chromium (via chrome-launcher), connect the
// protocol (via chrome-remote-interface), and pin the viewport. Everything the
// agent-facing surface (index.ts) needs to talk to a real browser.
import * as ChromeLauncher from 'chrome-launcher'
import CDP from 'chrome-remote-interface'

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
}

export interface Session {
  cdp: CDP.Client
  chrome: ChromeLauncher.LaunchedChrome
  viewport: Viewport
}

const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 }

async function enableDomains(cdp: CDP.Client): Promise<void> {
  const { Page, DOM, Runtime, Network } = cdp
  await Promise.all([Page.enable(), DOM.enable(), Runtime.enable(), Network.enable()])
}

async function applyViewport(cdp: CDP.Client, viewport: Viewport, userAgent?: string): Promise<void> {
  await cdp.Emulation.setDeviceMetricsOverride({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  if (userAgent) await cdp.Network.setUserAgentOverride({ userAgent })
}

export async function launchChrome(opts: LaunchOpts = {}): Promise<Session> {
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT
  const headless = opts.headless ?? true
  const flags = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--window-size=${viewport.width},${viewport.height}`,
  ]
  if (headless) flags.push('--headless=new')

  const chrome = await ChromeLauncher.launch({ chromeFlags: flags })
  const cdp = await CDP({ port: chrome.port })
  await enableDomains(cdp)
  await applyViewport(cdp, viewport, opts.userAgent)
  return { cdp, chrome, viewport }
}

/** Repoint the session's protocol connection at another tab (target). */
export async function switchTarget(session: Session, targetId: string): Promise<void> {
  await session.cdp.close()
  const cdp = await CDP({ port: session.chrome.port, target: targetId })
  await enableDomains(cdp)
  await applyViewport(cdp, session.viewport)
  session.cdp = cdp
}

export async function closeSession(session: Session): Promise<void> {
  try {
    await session.cdp.close()
  } finally {
    await session.chrome.kill()
  }
}
