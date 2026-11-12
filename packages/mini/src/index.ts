// @callisto/mini — the ~20-method surface an agent needs to drive Chromium.
// Thin, typed, token-lean. No selector engine, no locator chains, no assertions.
// See rfcs/0001 for the design and README.md for the API reference.
import {
  launchChrome,
  connectBrowse,
  closeSession,
  switchTarget,
  type LaunchOpts,
  type ConnectBrowseOpts,
  type Session,
} from './client.js'
import { tmpdir } from 'node:os'
import type { EventEmitter } from 'node:events'
import { isPoint, type Target, type Point, type Ref } from './elements.js'
import { RefRegistry, type RefLookup } from './ax-refs.js'
import { formatDiff } from './ax-diff.js'
import { snapshot, type Snapshot } from './snapshot.js'
import type { CapturedRequest } from './page.js'
export { Page, Locator, type CapturedRequest } from './page.js'
export type { LocatorOptions } from './page.js'

export type { LaunchOpts, Viewport, ConnectBrowseOpts } from './client.js'
export type { Target, Point, Ref } from './elements.js'
export type { Snapshot } from './snapshot.js'
export type { RefLookup } from './ax-refs.js'

export type MouseButton = 'left' | 'right' | 'middle'
export interface ClickOpts {
  button?: MouseButton
  clickCount?: number
  timeout?: number
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
export interface SnapshotOpts {
  /** Return a ref-keyed diff from the previous full snapshot. First call returns full text. */
  diff?: boolean
}
export type AgentSignalType = 'dialog' | 'popup' | 'download' | 'tab'
export interface AgentSignal {
  type: AgentSignalType
  message: string
  url?: string
  filename?: string
  targetId?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const MAX_SIGNALS = 20
const NAVIGATION_TIMEOUT = 30_000

async function withTimeout<T>(promise: Promise<T>, timeout: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation}: timed out after ${timeout}ms`)), timeout)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type CdpEvent = Record<string, unknown>

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

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
  private lastSnapshotText: string | undefined
  private signals: AgentSignal[] = []
  private knownTargets = new Set<string>()
  private targetUrls = new Map<string, string>()
  private networkHistory: CapturedRequest[] = []
  /** CDP target currently attached (session.cdp). */
  private currentTargetId: string | undefined
  /**
   * Newest page target the agent should focus (popup / new tab).
   * Applied in flushPendingFocus() before the next snapshot/eval return.
   */
  private pendingFocusTargetId: string | undefined
  private signalListenersInstalled = false
  private operationSignal: AbortSignal | undefined
  private pageRevision = 0

  private constructor(
    private session: Session,
    private refs: RefRegistry,
  ) {}

  static async launch(opts: LaunchOpts = {}): Promise<Mini> {
    const session = await launchChrome(opts)
    const mini = new Mini(session, new RefRegistry())
    await mini.installSignalListeners()
    // Seed current target so popup auto-focus has a baseline.
    try {
      const pages = await mini.pages()
      if (pages[0]) mini.currentTargetId = pages[0].id
    } catch {
      /* ignore */
    }
    await mini.drainSignals()
    return mini
  }

  /** Open a new agent-owned tab in a paired browser through browse's relay. */
  static async connectBrowse(opts: ConnectBrowseOpts): Promise<Mini> {
    const session = await connectBrowse(opts)
    const mini = new Mini(session, new RefRegistry())
    mini.currentTargetId = session.targetId
    // Navigation can also be triggered by a click or by the person during a
    // handoff. Retire refs only for this tab, not another relay client.
    session.cdp.on('Page.frameNavigated', (event: {frame?: {parentId?: string}}, cdpSessionId?: string) => {
      if (cdpSessionId === session.connectedPageSessionId && event.frame && !event.frame.parentId) mini.resetPageState()
    })
    // Connected sessions deliberately avoid global browser changes and target
    // auto-focus until ownership and takeover events are integrated.
    return mini
  }

  async close(): Promise<void> {
    await closeSession(this.session)
  }

  /** Changes when the current document or tab is replaced. */
  getPageRevision(): number { return this.pageRevision }

  /** Scope cancellation to one serialized host operation. */
  async withAbortSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const previous = this.operationSignal
    this.operationSignal = signal
    try { return await work() } finally { this.operationSignal = previous }
  }

  /** Ask the person using a paired browser to complete a step in this tab. */
  async handoff(message: string, options: {timeoutMs?: number; signal?: AbortSignal} = {}): Promise<void> {
    if (this.session.mode !== 'connected' || !this.session.connectedExecute) throw new Error('Human handoff requires a connected browser session')
    const timeoutMs = options.timeoutMs ?? 60_000
    if (!message.trim() || message.length > 500) throw new Error('handoff: provide a message of at most 500 characters')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error('handoff: timeout must be between 1000 and 120000ms')
    try {
      await this.session.connectedExecute(`await handoff(${JSON.stringify(message)}, {timeoutMs: ${timeoutMs}})`, {signal:options.signal, timeout:timeoutMs + 10_000})
    } finally {
      // The person may have changed or navigated the page, even on timeout.
      this.resetPageState()
    }
  }

  private get cdp() {
    return this.session.cdp
  }

  async pages(): Promise<Array<{ id: string; url: string; title: string }>> {
    await this.flushPendingFocus()
    const { targetInfos } = await this.cdp.Target.getTargets()
    return targetInfos
      .filter((t) => t.type === 'page' && (this.session.mode !== 'connected' || t.targetId === this.session.targetId))
      .map((t) => ({ id: t.targetId, url: t.url, title: t.title }))
  }

  // --- navigation ---

  async goto(url: string, opts: { waitUntil?: 'load' | 'domcontentloaded'; timeout?: number } = {}): Promise<void> {
    if (this.session.mode === 'connected') {
      try {
        await this.connectedAction(`await page.goto(${JSON.stringify(url)}, ${JSON.stringify({waitUntil:opts.waitUntil ?? 'load', timeout:opts.timeout ?? NAVIGATION_TIMEOUT})})`)
      } finally { this.resetPageState() }
      return
    }
    const cdp = this.cdp
    const event = opts.waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired'
    let listener: () => void = () => undefined
    const settled = new Promise<void>((resolve) => { listener = resolve; cdp.on(event, listener) })
    try {
      const navigate = async () => {
        const result = await cdp.Page.navigate({ url })
        if (result.errorText) throw new Error(`goto: ${result.errorText}`)
        if (result.loaderId) await settled
      }
      await withTimeout(navigate(), opts.timeout ?? NAVIGATION_TIMEOUT, 'goto')
    } finally {
      ;(cdp as unknown as EventEmitter).removeListener(event, listener)
      // Even a timed-out navigation may have changed the document.
      this.resetPageState()
    }
  }

  async back(): Promise<void> {
    await this.historyGo(-1)
  }

  async forward(): Promise<void> {
    await this.historyGo(1)
  }

  async reload(): Promise<void> {
    if (this.session.mode === 'connected') {
      try { await this.connectedAction('await page.reload()') } finally { this.resetPageState() }
      return
    }
    const cdp = this.cdp
    let listener: () => void = () => undefined
    const loaded = new Promise<void>((resolve) => { listener = resolve; cdp.on('Page.loadEventFired', listener) })
    try {
      await withTimeout((async () => { await cdp.Page.reload({}); await loaded })(), NAVIGATION_TIMEOUT, 'reload')
    } finally {
      ;(cdp as unknown as EventEmitter).removeListener('Page.loadEventFired', listener)
      this.resetPageState()
    }
  }

  private async historyGo(delta: number): Promise<void> {
    if (this.session.mode === 'connected') {
      try { await this.connectedAction(delta < 0 ? 'await page.goBack()' : 'await page.goForward()') }
      finally { this.resetPageState() }
      return
    }
    const { Page } = this.cdp
    const { currentIndex, entries } = await Page.getNavigationHistory()
    const target = entries[currentIndex + delta]
    if (target) {
      // History can change only the fragment or use the back-forward cache;
      // neither is guaranteed to emit a load event.
      await withTimeout(Page.navigateToHistoryEntry({ entryId: target.id }), NAVIGATION_TIMEOUT, 'history navigation')
      this.resetPageState()
    }
  }

  // --- interaction ---

  async click(target: Target, opts: ClickOpts = {}): Promise<void> {
    await this.mouse(await this.actionable(target, 'click', opts.timeout), opts.button ?? 'left', opts.clickCount ?? 1)
  }

  async dblclick(target: Target, opts: ClickOpts = {}): Promise<void> {
    await this.mouse(await this.actionable(target, 'click', opts.timeout), opts.button ?? 'left', 2)
  }

  async rightclick(target: Target): Promise<void> {
    await this.mouse(await this.actionable(target, 'click'), 'right', 1)
  }

  async hover(target: Target): Promise<void> {
    const p = await this.actionable(target, 'hover')
    if (this.session.mode === 'connected') {
      await this.connectedAction(`await page.mouse.move(${p.x}, ${p.y})`)
      return
    }
    await this.cdp.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y })
  }

  async dragTo(from: Target, to: Target): Promise<void> {
    // Check both ends before pressing the mouse: a covered destination must
    // not leave behind a partial drag or start a destructive gesture.
    const a = await this.actionable(from, 'click')
    const b = await this.actionable(to, 'hover')
    if (this.session.mode === 'connected') {
      await this.connectedAction(`await page.mouse.move(${a.x}, ${a.y}); await page.mouse.down(); await page.mouse.move(${b.x}, ${b.y}); await page.mouse.up()`)
      return
    }
    const { Input } = this.cdp
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: b.x, y: b.y, button: 'left', buttons: 1 })
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
  }

  async type(text: string, opts: TypeOpts = {}): Promise<void> {
    await this.requireConnectedInput()
    if (this.session.mode === 'connected') {
      await this.connectedAction(opts.delay ? `await page.keyboard.type(${JSON.stringify(text)}, ${JSON.stringify({delay:opts.delay})})` : `await page.keyboard.insertText(${JSON.stringify(text)})`)
      return
    }
    if (!opts.delay) {
      await this.cdp.Input.insertText({ text })
      return
    }
    for (const ch of text) {
      await this.cdp.Input.insertText({ text: ch })
      await sleep(opts.delay)
    }
  }

  async press(key: string): Promise<void> {
    await this.requireConnectedInput()
    const aliases: Record<string, string> = { Ctrl: 'Control', Cmd: 'Meta', Command: 'Meta', Esc: 'Escape', ' ': 'Space' }
    const parts = key.split('+').map((part) => aliases[part] ?? part)
    const main = parts.pop()
    if (!main) throw new Error(`press: invalid key ${key}`)
    const modifierBits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
    let modifiers = 0
    for (const part of parts) {
      if (!(part in modifierBits)) throw new Error(`press: unsupported modifier ${part}`)
      modifiers |= modifierBits[part]
    }
    const keys: Record<string, [string, number]> = {
      Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8],
      Delete: ['Delete', 46], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38],
      ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35],
      Space: ['Space', 32],
    }
    const upper = main.toUpperCase()
    const known = keys[main] ?? (main.length === 1 && /^[A-Z0-9]$/.test(upper)
      ? [/^[A-Z]$/.test(upper) ? `Key${upper}` : `Digit${upper}`, upper.charCodeAt(0)] as [string, number]
      : undefined)
    if (!known) throw new Error(`press: unsupported key ${main}; use keyboard.type for text`)
    const [code, windowsVirtualKeyCode] = known
    if (this.session.mode === 'connected') {
      await this.connectedAction(`await page.keyboard.press(${JSON.stringify([...parts, main].join('+'))})`)
      return
    }
    const text = modifiers === 0 && main.length === 1 ? main : main === 'Enter' ? '\r' : undefined
    const event = { key: main === 'Space' ? ' ' : main, code, windowsVirtualKeyCode, modifiers }
    const observeNav = main === 'Enter' && modifiers === 0
    const cdpEvents = this.cdp as unknown as EventEmitter
    let navigated = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onFrame: () => void = () => {}
    let onLoad: () => void = () => {}
    const pendingNav = observeNav ? new Promise<void>((resolve) => {
      onFrame = () => { navigated = true }
      onLoad = () => { if (navigated) resolve() }
      cdpEvents.on('Page.frameNavigated', onFrame)
      cdpEvents.on('Page.loadEventFired', onLoad)
      timer = setTimeout(resolve, 400)
    }) : undefined
    try {
      await this.cdp.Input.dispatchKeyEvent({ type: 'keyDown', ...event, ...(text ? { text } : {}) })
      await this.cdp.Input.dispatchKeyEvent({ type: 'keyUp', ...event })
      if (pendingNav) await pendingNav
    } finally {
      if (timer) clearTimeout(timer)
      if (observeNav) {
        cdpEvents.removeListener('Page.frameNavigated', onFrame)
        cdpEvents.removeListener('Page.loadEventFired', onLoad)
      }
      // The document can change even if key dispatch subsequently fails.
      if (navigated) this.resetPageState()
    }
  }

  async keyDown(key: string): Promise<void> {
    await this.requireConnectedInput()
    if (this.session.mode === 'connected') throw new Error('Holding keys across connected actions is not supported; use press instead')
    await this.cdp.Input.dispatchKeyEvent({ type: 'keyDown', key, ...keyExtras(key) })
  }

  async keyUp(key: string): Promise<void> {
    await this.requireConnectedInput()
    if (this.session.mode === 'connected') throw new Error('Holding keys across connected actions is not supported; use press instead')
    await this.cdp.Input.dispatchKeyEvent({ type: 'keyUp', key, ...keyExtras(key) })
  }

  /** Focus the target, select its contents, and insert text through the browser. */
  async fill(target: Target, value: string): Promise<void> {
    const point = await this.actionable(target, 'fill')
    if (this.session.mode === 'connected') {
      const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A'
      await this.connectedAction(`await page.mouse.click(${point.x}, ${point.y}); await page.keyboard.press(${JSON.stringify(selectAll)}); ${value ? `await page.keyboard.insertText(${JSON.stringify(value)})` : 'await page.keyboard.press("Backspace")'}`)
      return
    }
    await this.mouse(point, 'left', 1)
    await this.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    if (value) await this.type(value)
    else await this.press('Backspace')
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.requireConnectedInput()
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error('scroll: deltas must be finite numbers')
    if (this.session.mode === 'connected') {
      await this.connectedAction(`const __v = await page.evaluate(() => ({width: innerWidth, height: innerHeight})); await page.mouse.move(__v.width / 2, __v.height / 2); await page.mouse.wheel(${deltaX}, ${deltaY})`)
      return
    }
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

  /** Pruned, ref-annotated a11y tree as indented text (rfcs/0002). */
  async snapshot(opts: SnapshotOpts = {}): Promise<Snapshot> {
    await this.flushPendingFocus()
    const snap = await snapshot(this.session, this.refs)
    const previous = this.lastSnapshotText
    this.lastSnapshotText = snap.text
    return opts.diff ? { ...snap, text: formatDiff(previous, snap.text) } : snap
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
      if (this.session.mode === 'connected') throw new Error('Creating additional tabs is not supported in connected mode')
      const { targetId } = await this.cdp.Target.createTarget({ url: url ?? 'about:blank' })
      return targetId
    },
    switch: async (targetId: string): Promise<void> => {
      if (this.session.mode === 'connected') throw new Error('Switching tabs is not supported in connected mode')
      this.pendingFocusTargetId = undefined
      await this.attachTarget(targetId)
    },
    close: async (targetId: string): Promise<void> => {
      if (this.session.mode === 'connected') throw new Error('Closing tabs is not supported in connected mode')
      await this.cdp.Target.closeTarget({ targetId })
      if (this.pendingFocusTargetId === targetId) this.pendingFocusTargetId = undefined
      if (this.currentTargetId === targetId) this.currentTargetId = undefined
    },
  }

  /** Attach CDP session to a page target and reset snapshot baseline. */
  private async attachTarget(targetId: string): Promise<void> {
    if (this.currentTargetId === targetId) return
    await switchTarget(this.session, targetId)
    this.currentTargetId = targetId
    // switchTarget opens a new CDP client — re-bind signal listeners on it.
    this.signalListenersInstalled = false
    await this.installSignalListeners()
    this.resetPageState()
  }

  /**
   * If a popup/new tab opened during the last action, focus it so the next
   * snapshot/actions hit the page the agent almost certainly cares about.
   */
  async flushPendingFocus(): Promise<void> {
    const targetId = this.pendingFocusTargetId
    if (!targetId || targetId === this.currentTargetId) {
      this.pendingFocusTargetId = undefined
      return
    }
    try {
      const { targetInfos } = await this.cdp.Target.getTargets()
      const stillOpen = targetInfos.some((t) => t.targetId === targetId && t.type === 'page')
      if (!stillOpen) {
        this.pendingFocusTargetId = undefined
        return
      }
      const info = targetInfos.find((t) => t.targetId === targetId)
      await this.attachTarget(targetId)
      this.pendingFocusTargetId = undefined
      this.queueSignal({
        type: 'tab',
        message: 'focused new tab',
        url: info?.url ?? this.targetUrls.get(targetId),
        targetId,
      })
    } catch {
      // Best-effort: leave pending for a later attempt.
    }
  }

  private requestFocus(targetId: string, url?: string): void {
    if (targetId === this.currentTargetId) return
    this.pendingFocusTargetId = targetId
    if (url) this.targetUrls.set(targetId, url)
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

  network = {
    recent: (n: number): CapturedRequest[] => {
      return this.networkHistory.slice(-n).reverse()
    }
  }

  // --- internals ---

  private resetSnapshotBaseline(): void {
    this.lastSnapshotText = undefined
  }

  /** Drop snapshot baseline + ref registry after a document change. */
  private resetPageState(): void {
    this.pageRevision++
    this.resetSnapshotBaseline()
    this.refs.reset()
  }

  async drainSignals(): Promise<AgentSignal[]> {
    await this.flushPendingFocus()
    const out = this.signals
    this.signals = []
    return out
  }

  private queueSignal(signal: AgentSignal): void {
    this.signals.push(signal)
    if (this.signals.length > MAX_SIGNALS) this.signals.shift()
  }

  private async installSignalListeners(): Promise<void> {
    // Only register CDP listeners once per Mini — re-registering stacks handlers.
    if (this.signalListenersInstalled) return
    this.signalListenersInstalled = true

    ;(this.cdp as unknown as EventEmitter).on('Page.frameNavigated', (event: {frame?: {parentId?: string}}) => {
      if (event.frame && !event.frame.parentId) this.resetPageState()
    })

    const cdp = this.cdp as unknown as {
      Page?: {
        javascriptDialogOpening?: (cb: (event: CdpEvent) => void) => void
        windowOpen?: (cb: (event: CdpEvent) => void) => void
      }
      Browser?: {
        downloadWillBegin?: (cb: (event: CdpEvent) => void) => void
        setDownloadBehavior?: (params: Record<string, unknown>) => Promise<void>
      }
      Target?: {
        getTargets?: () => Promise<{ targetInfos: Array<{ targetId: string; type: string; url?: string; title?: string }> }>
        setDiscoverTargets?: (params: { discover: boolean }) => Promise<void>
        targetCreated?: (cb: (event: { targetInfo?: { targetId: string; type: string; url?: string; title?: string } }) => void) => void
        targetDestroyed?: (cb: (event: { targetId?: string }) => void) => void
        targetInfoChanged?: (cb: (event: { targetInfo?: { targetId: string; type: string; url?: string; title?: string } }) => void) => void
      }
      Network?: {
        requestWillBeSent?: (cb: (event: {
          requestId: string
          request: { url: string; method: string; headers: Record<string, string>; postData?: string }
          type?: string
        }) => void) => void
        responseReceived?: (cb: (event: {
          requestId: string
          response: { url: string; status: number; headers: Record<string, string> }
        }) => void) => void
      }
    }

    const pendingRequests = new Map<string, CapturedRequest>()

    cdp.Network?.requestWillBeSent?.((event) => {
      const type = event.type?.toLowerCase()
      if (type === 'xhr' || type === 'fetch') {
        const req = event.request
        const captured: CapturedRequest = {
          method: req.method,
          url: req.url,
          requestHeaders: req.headers,
          postData: req.postData,
        }
        pendingRequests.set(event.requestId, captured)
        this.networkHistory.push(captured)
        if (this.networkHistory.length > 100) {
          this.networkHistory.shift()
        }
      }
    })

    cdp.Network?.responseReceived?.((event) => {
      const captured = pendingRequests.get(event.requestId)
      if (captured) {
        captured.status = event.response.status
        captured.responseHeaders = event.response.headers
        pendingRequests.delete(event.requestId)
      }
    })

    try {
      const targets = await cdp.Target?.getTargets?.()
      for (const target of targets?.targetInfos ?? []) {
        this.knownTargets.add(target.targetId)
        if (target.url) this.targetUrls.set(target.targetId, target.url)
      }
    } catch {
      // Target discovery is best-effort; signals are advisory.
    }

    cdp.Page?.javascriptDialogOpening?.((event) => {
      this.queueSignal({
        type: 'dialog',
        message: asString(event.message) ?? asString(event.type) ?? 'dialog opened',
        url: asString(event.url),
      })
    })

    cdp.Page?.windowOpen?.((event) => {
      const url = asString(event.url)
      this.queueSignal({
        type: 'popup',
        message: 'popup opened',
        url,
      })
      // Match an already-created page target by URL when possible.
      void this.cdp.Target.getTargets()
        .then(({ targetInfos }) => {
          const pages = targetInfos.filter((t) => t.type === 'page')
          const byUrl = url
            ? pages.find((t) => t.url === url && t.targetId !== this.currentTargetId)
            : undefined
          const newest = [...pages].reverse().find((t) => t.targetId !== this.currentTargetId)
          const pick = byUrl ?? newest
          if (pick) this.requestFocus(pick.targetId, pick.url || url)
        })
        .catch(() => {
          /* advisory */
        })
    })

    cdp.Browser?.downloadWillBegin?.((event) => {
      this.queueSignal({
        type: 'download',
        message: 'download started',
        url: asString(event.url),
        filename: asString(event.suggestedFilename),
      })
    })

    cdp.Target?.targetCreated?.((event) => {
      const info = event.targetInfo
      if (!info || info.type !== 'page') return
      const alreadyKnown = this.knownTargets.has(info.targetId)
      this.knownTargets.add(info.targetId)
      if (info.url) this.targetUrls.set(info.targetId, info.url)
      if (alreadyKnown) return
      // New page (popup often starts about:blank) — mark for auto-focus.
      this.requestFocus(info.targetId, info.url)
      if (info.url && info.url !== 'about:blank') {
        this.queueSignal({
          type: 'tab',
          message: 'tab opened',
          url: info.url,
          targetId: info.targetId,
        })
      }
    })

    cdp.Target?.targetDestroyed?.((event) => {
      if (!event.targetId || !this.knownTargets.has(event.targetId)) return
      const url = this.targetUrls.get(event.targetId)
      this.knownTargets.delete(event.targetId)
      this.targetUrls.delete(event.targetId)
      if (this.pendingFocusTargetId === event.targetId) this.pendingFocusTargetId = undefined
      this.queueSignal({
        type: 'tab',
        message: 'tab closed',
        url,
        targetId: event.targetId,
      })
    })

    cdp.Target?.targetInfoChanged?.((event) => {
      const info = event.targetInfo
      if (!info || info.type !== 'page') return
      const prevUrl = this.targetUrls.get(info.targetId)
      this.knownTargets.add(info.targetId)
      if (info.url) this.targetUrls.set(info.targetId, info.url)
      // Popup navigated from about:blank → real URL: surface a tab signal + focus.
      const becameReal =
        info.url &&
        info.url !== 'about:blank' &&
        (!prevUrl || prevUrl === 'about:blank')
      if (becameReal && info.targetId !== this.currentTargetId) {
        this.requestFocus(info.targetId, info.url)
        this.queueSignal({
          type: 'tab',
          message: 'tab opened',
          url: info.url,
          targetId: info.targetId,
        })
      }
    })

    try {
      await cdp.Target?.setDiscoverTargets?.({ discover: true })
    } catch {
      // Ignore: some Chromium builds reject Target discovery from target sessions.
    }

    try {
      await cdp.Browser?.setDownloadBehavior?.({
        behavior: 'allow',
        downloadPath: tmpdir(),
        eventsEnabled: true,
      })
    } catch {
      // Ignore: downloads still work, only the advisory signal may be missing.
    }
  }

  /** Find a snapshot ref by accessible metadata for the Playwright-shaped facade. */
  ref(query: RefLookup): Ref | undefined {
    return this.refs.find(query)?.ref
  }

  /** Refresh locator candidates without changing the agent's diff baseline. */
  async refreshLocators(): Promise<void> {
    await this.flushPendingFocus()
    await snapshot(this.session, this.refs)
  }

  /** Bounded safety checks for ref targets. Raw coordinates are explicit and unchecked. */
  private async actionable(target: Target, action: 'click' | 'hover' | 'fill', timeout = 2_000): Promise<Point> {
    await this.requireConnectedInput()
    if (isPoint(target)) {
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) throw new Error(`${action}: coordinates must be finite numbers`)
      return target
    }
    const ref = target.replace(/^\[|\]$/g, '')
    const info = this.refs.get(ref)
    if (!info) throw new Error(`ref "${target}" unknown — call snapshot() first.`)
    const deadline = Date.now() + timeout
    let lastReason = 'not ready'
    let previous: number[] | undefined
    while (Date.now() < deadline) {
      if (this.operationSignal?.aborted) throw new Error(`${action}: request was cancelled`)
      let objectId: string | undefined
      try {
        await this.cdp.DOM.scrollIntoViewIfNeeded({ backendNodeId: info.backendDOMNodeId })
        const { object } = await this.cdp.DOM.resolveNode({ backendNodeId: info.backendDOMNodeId })
        objectId = object.objectId
        if (!objectId) throw new Error('node is detached')
        const response = await this.cdp.Runtime.callFunctionOn({
          objectId, returnByValue: true,
          arguments: [{ value: action }],
          functionDeclaration: `function(action) {
            const el = this;
            if (!el.isConnected) return { reason: 'detached' };
            const style = getComputedStyle(el), r = el.getBoundingClientRect();
            if (!r.width || !r.height || style.visibility !== 'visible' || style.display === 'none') return { reason: 'not visible' };
            if (el.closest('[inert]')) return { reason: 'inert' };
            if (action !== 'hover' && (el.matches(':disabled') || el.closest('[aria-disabled="true"]'))) return { reason: 'disabled' };
            if (action === 'fill' && (el.matches('[readonly]') || el.getAttribute('aria-readonly') === 'true' || !(el.matches('input,textarea') || el.isContentEditable))) return { reason: 'not editable' };
            let view = el.ownerDocument.defaultView;
            let x = Math.max(0, r.left) + (Math.min(view.innerWidth, r.right) - Math.max(0, r.left))/2;
            let y = Math.max(0, r.top) + (Math.min(view.innerHeight, r.bottom) - Math.max(0, r.top))/2;
            const root = el.getRootNode();
            const hit = root.elementFromPoint ? root.elementFromPoint(x, y) : el.ownerDocument.elementFromPoint(x, y);
            if (!hit || !(el === hit || el.contains(hit))) return { reason: 'covered or not receiving events' };
            // Translate through same-origin frame owners and check every parent
            // for an overlay. Fail closed where the browser denies frame access.
            while (view !== view.top) {
              let frame;
              try { frame = view.frameElement; } catch { return { reason: 'cross-origin iframe actionability unsupported' }; }
              if (!frame) return { reason: 'cross-origin iframe actionability unsupported' };
              const fr = frame.getBoundingClientRect();
              if (Math.abs(fr.width - frame.offsetWidth) > 0.5 || Math.abs(fr.height - frame.offsetHeight) > 0.5 || getComputedStyle(frame).transform !== 'none') return { reason: 'transformed iframe actionability unsupported' };
              x += fr.left + frame.clientLeft;
              y += fr.top + frame.clientTop;
              const parent = frame.ownerDocument.defaultView;
              const parentHit = frame.ownerDocument.elementFromPoint(x, y);
              if (parentHit !== frame) return { reason: 'iframe covered or not receiving events' };
              view = parent;
            }
            return { x, y, rect: [x, y, r.width, r.height] };
          }`,
        })
        if (response.exceptionDetails) throw new Error('could not inspect element')
        const result = response.result.value as { reason?: string; x?: number; y?: number; rect?: number[] }
        if (result.reason) { lastReason = result.reason; previous = undefined }
        else if (result.rect && previous && result.rect.every((v, i) => Math.abs(v - previous![i]) < 0.25)) {
          return { x: result.x!, y: result.y! }
        } else { lastReason = 'moving'; previous = result.rect }
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error)
        previous = undefined
      } finally {
        if (objectId) await this.cdp.Runtime.releaseObject({ objectId }).catch(() => undefined)
      }
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())))
    }
    throw new Error(`${action}: target ${target} not actionable after ${timeout}ms (${lastReason})`)
  }

  /** A target is either raw coordinates or a ref resolved to its box center. */
  private async resolve(target: Target): Promise<Point> {
    if (isPoint(target)) return target
    let cleanRef = target
    if (cleanRef.startsWith('[') && cleanRef.endsWith(']')) {
      cleanRef = cleanRef.slice(1, -1)
    }
    let info = this.refs.get(cleanRef) ?? this.refs.remap(cleanRef)
    if (!info) {
      throw new Error(`ref "${target}" unknown — call snapshot() first.`)
    }
    try {
      return await this.boxCenter(info.backendDOMNodeId)
    } catch {
      // Node detached since snapshot: try a same-role+name survivor once.
      const remapped = this.refs.remap(cleanRef)
      if (remapped && remapped.backendDOMNodeId !== info.backendDOMNodeId) {
        return await this.boxCenter(remapped.backendDOMNodeId)
      }
      throw new Error(`ref "${target}" is stale — re-snapshot and retry.`)
    }
  }

  /** Center of a backend node's content box, via CDP box model. */
  private async boxCenter(backendNodeId: number): Promise<Point> {
    await this.cdp.DOM.scrollIntoViewIfNeeded({ backendNodeId })
    const { model } = await this.cdp.DOM.getBoxModel({ backendNodeId })
    const q = model.content // [x1,y1, x2,y2, x3,y3, x4,y4]
    return { x: Math.round((q[0] + q[2] + q[4] + q[6]) / 4), y: Math.round((q[1] + q[3] + q[5] + q[7]) / 4) }
  }

  private async mouse(p: Point, button: MouseButton, clickCount: number): Promise<void> {
    if (this.session.mode === 'connected') {
      await this.connectedAction(`await page.mouse.click(${p.x}, ${p.y}, ${JSON.stringify({button,clickCount})})`)
      return
    }
    const { Input } = this.cdp
    const buttons = BUTTON_MASK[button]
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y })
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button, buttons, clickCount })
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button, buttons, clickCount })
  }

  private async connectedAction(code: string): Promise<void> {
    if (!this.session.connectedExecute) throw new Error('Connected browser execution lifecycle is unavailable')
    await this.session.connectedExecute(code, {signal:this.operationSignal})
  }

  /** Never send connected input outside browse's execution lifecycle. */
  private async requireConnectedInput(): Promise<void> {
    if (this.session.mode !== 'connected') return
    if (!this.session.connectedExecute) throw new Error('Connected browser execution lifecycle is unavailable')
  }
}
