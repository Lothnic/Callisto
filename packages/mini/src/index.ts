// @callisto/mini — the ~20-method surface an agent needs to drive Chromium.
// Thin, typed, token-lean. No selector engine, no locator chains, no assertions.
// See rfcs/0001 for the design and README.md for the API reference.
import {
  launchChrome,
  closeSession,
  switchTarget,
  type LaunchOpts,
  type Session,
} from './client.js'
import { RefRegistry, isPoint, type Target, type Point, type Ref } from './elements.js'
import { snapshot, type Snapshot } from './snapshot.js'

export type { LaunchOpts, Viewport } from './client.js'
export type { Target, Point, Ref } from './elements.js'
export type { Snapshot } from './snapshot.js'

export type MouseButton = 'left' | 'right' | 'middle'
export interface ClickOpts {
  button?: MouseButton
  clickCount?: number
}
export interface TypeOpts {
  delay?: number
}
export interface WaitOpts {
  timeout?: number
  poll?: number
}
export interface CookieParam {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expires?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 }

// ponytail: minimal key table — printable chars + the few control keys agents
// actually press. Extend with a full virtual-keycode map only if pages need it.
function keyExtras(key: string): { text?: string } {
  if (key === 'Enter') return { text: '\r' }
  if (key === 'Tab') return { text: '\t' }
  if (key.length === 1) return { text: key }
  return {}
}

export class Mini {
  private constructor(
    private session: Session,
    private refs: RefRegistry,
  ) {}

  static async launch(opts: LaunchOpts = {}): Promise<Mini> {
    const session = await launchChrome(opts)
    return new Mini(session, new RefRegistry())
  }

  async close(): Promise<void> {
    await closeSession(this.session)
  }

  private get cdp() {
    return this.session.cdp
  }

  async pages(): Promise<Array<{ id: string; url: string; title: string }>> {
    const { targetInfos } = await this.cdp.Target.getTargets()
    return targetInfos
      .filter((t) => t.type === 'page')
      .map((t) => ({ id: t.targetId, url: t.url, title: t.title }))
  }

  // --- navigation ---

  async goto(url: string, opts: { waitUntil?: 'load' | 'domcontentloaded' } = {}): Promise<void> {
    const { Page } = this.cdp
    const settled =
      opts.waitUntil === 'domcontentloaded' ? Page.domContentEventFired() : Page.loadEventFired()
    await Page.navigate({ url })
    await settled
  }

  async back(): Promise<void> {
    await this.historyGo(-1)
  }

  async forward(): Promise<void> {
    await this.historyGo(1)
  }

  async reload(): Promise<void> {
    await this.cdp.Page.reload({})
    await this.cdp.Page.loadEventFired()
  }

  private async historyGo(delta: number): Promise<void> {
    const { Page } = this.cdp
    const { currentIndex, entries } = await Page.getNavigationHistory()
    const target = entries[currentIndex + delta]
    if (target) await Page.navigateToHistoryEntry({ entryId: target.id })
  }

  // --- interaction ---

  async click(target: Target, opts: ClickOpts = {}): Promise<void> {
    await this.mouse(this.point(target), opts.button ?? 'left', opts.clickCount ?? 1)
  }

  async dblclick(target: Target, opts: ClickOpts = {}): Promise<void> {
    await this.mouse(this.point(target), opts.button ?? 'left', 2)
  }

  async rightclick(target: Target): Promise<void> {
    await this.mouse(this.point(target), 'right', 1)
  }

  async hover(target: Target): Promise<void> {
    const p = this.point(target)
    await this.cdp.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y })
  }

  async dragTo(from: Target, to: Target): Promise<void> {
    const a = this.point(from)
    const b = this.point(to)
    const { Input } = this.cdp
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: b.x, y: b.y, button: 'left', buttons: 1 })
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
  }

  async type(text: string, opts: TypeOpts = {}): Promise<void> {
    const { Input } = this.cdp
    for (const ch of text) {
      await Input.dispatchKeyEvent({ type: 'char', text: ch })
      if (opts.delay) await sleep(opts.delay)
    }
  }

  async press(key: string): Promise<void> {
    const extras = keyExtras(key)
    const { Input } = this.cdp
    await Input.dispatchKeyEvent({ type: 'keyDown', key, ...extras })
    await Input.dispatchKeyEvent({ type: 'keyUp', key, ...extras })
  }

  async keyDown(key: string): Promise<void> {
    await this.cdp.Input.dispatchKeyEvent({ type: 'keyDown', key, ...keyExtras(key) })
  }

  async keyUp(key: string): Promise<void> {
    await this.cdp.Input.dispatchKeyEvent({ type: 'keyUp', key, ...keyExtras(key) })
  }

  /** Clears the field first (so the model needn't remember to), then types. */
  async fill(ref: Ref, value: string): Promise<void> {
    await this.mouse(this.refs.resolve(ref), 'left', 1) // focus (Phase 2: real refs)
    await this.evaluate(
      '(() => { const el = document.activeElement; if (el && "value" in el) el.value = ""; })()',
    )
    await this.type(value)
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    const { width, height } = this.session.viewport
    await this.cdp.Input.dispatchMouseEvent({
      type: 'mouseWheel',
      x: Math.round(width / 2),
      y: Math.round(height / 2),
      deltaX,
      deltaY,
    })
  }

  // --- observation ---

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    const { data } = await this.cdp.Page.captureScreenshot({
      format: 'png',
      captureBeyondViewport: opts.fullPage ?? false,
    })
    return Buffer.from(data, 'base64')
  }

  /** Phase 1: page metadata + empty tree. Full a11y tree in Phase 2. */
  async snapshot(): Promise<Snapshot> {
    return snapshot(this.session)
  }

  async evaluate<T = unknown>(
    fn: string | ((...args: never[]) => T),
    ...args: unknown[]
  ): Promise<T> {
    const expression =
      typeof fn === 'string'
        ? fn
        : `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
    const { result, exceptionDetails } = await this.cdp.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.value as T
  }

  // --- tabs / wait ---

  tabs = {
    new: async (url?: string): Promise<string> => {
      const { targetId } = await this.cdp.Target.createTarget({ url: url ?? 'about:blank' })
      return targetId
    },
    switch: async (targetId: string): Promise<void> => {
      await switchTarget(this.session, targetId)
    },
    close: async (targetId: string): Promise<void> => {
      await this.cdp.Target.closeTarget({ targetId })
    },
  }

  async waitFor(predicate: string | (() => boolean), opts: WaitOpts = {}): Promise<void> {
    const timeout = opts.timeout ?? 10_000
    const poll = opts.poll ?? 100
    const expr = typeof predicate === 'string' ? predicate : `(${predicate.toString()})()`
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await this.evaluate<boolean>(expr)) return
      await sleep(poll)
    }
    throw new Error(`waitFor: timed out after ${timeout}ms`)
  }

  // --- storage ---

  cookies = {
    get: async () => (await this.cdp.Network.getCookies()).cookies,
    set: async (cookies: CookieParam[]): Promise<void> => {
      await this.cdp.Network.setCookies({ cookies })
    },
    clear: async (): Promise<void> => {
      await this.cdp.Network.clearBrowserCookies()
    },
  }

  localStorage = {
    getItem: (key: string): Promise<string | null> =>
      this.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(key)})`),
    setItem: (key: string, value: string): Promise<void> =>
      this.evaluate<void>(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`),
  }

  sessionStorage = {
    getItem: (key: string): Promise<string | null> =>
      this.evaluate<string | null>(`sessionStorage.getItem(${JSON.stringify(key)})`),
    setItem: (key: string, value: string): Promise<void> =>
      this.evaluate<void>(
        `sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
      ),
  }

  // --- internals ---

  private point(target: Target): Point {
    return isPoint(target) ? target : this.refs.resolve(target)
  }

  private async mouse(p: Point, button: MouseButton, clickCount: number): Promise<void> {
    const { Input } = this.cdp
    const buttons = BUTTON_MASK[button]
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y })
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button, buttons, clickCount })
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button, buttons, clickCount })
  }
}
