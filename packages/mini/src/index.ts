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
import { tmpdir } from 'node:os'
import { isPoint, type Target, type Point, type Ref } from './elements.js'
import { RefRegistry, type RefLookup } from './ax-refs.js'
import { formatDiff } from './ax-diff.js'
import { snapshot, type Snapshot } from './snapshot.js'
import type { CapturedRequest } from './page.js'
export { Page, Locator, type CapturedRequest } from './page.js'
export type { LocatorOptions } from './page.js'

export type { LaunchOpts, Viewport } from './client.js'
export type { Target, Point, Ref } from './elements.js'
export type { Snapshot } from './snapshot.js'
export type { RefLookup } from './ax-refs.js'

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

  async close(): Promise<void> {
    await closeSession(this.session)
  }

  private get cdp() {
    return this.session.cdp
  }

  async pages(): Promise<Array<{ id: string; url: string; title: string }>> {
    await this.flushPendingFocus()
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
    this.resetSnapshotBaseline()
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
    this.resetSnapshotBaseline()
  }

  private async historyGo(delta: number): Promise<void> {
    const { Page } = this.cdp
    const { currentIndex, entries } = await Page.getNavigationHistory()
    const target = entries[currentIndex + delta]
    if (target) {
      await Page.navigateToHistoryEntry({ entryId: target.id })
      this.resetSnapshotBaseline()
    }
  }

  // --- interaction ---

  async click(target: Target, opts: ClickOpts = {}): Promise<void> {
    await this.mouse(await this.resolve(target), opts.button ?? 'left', opts.clickCount ?? 1)
  }

  async dblclick(target: Target, opts: ClickOpts = {}): Promise<void> {
    await this.mouse(await this.resolve(target), opts.button ?? 'left', 2)
  }

  async rightclick(target: Target): Promise<void> {
    await this.mouse(await this.resolve(target), 'right', 1)
  }

  async hover(target: Target): Promise<void> {
    const p = await this.resolve(target)
    await this.cdp.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y })
  }

  async dragTo(from: Target, to: Target): Promise<void> {
    const a = await this.resolve(from)
    const b = await this.resolve(to)
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
  async fill(target: Target, value: string): Promise<void> {
    if (isPoint(target)) {
      await this.mouse(target, 'left', 1)
      await this.evaluate(
        '(() => { const el = document.activeElement; if (el && "value" in el) el.value = ""; })()',
      )
    } else {
      let cleanRef = target
      if (cleanRef.startsWith('[') && cleanRef.endsWith(']')) {
        cleanRef = cleanRef.slice(1, -1)
      }
      const info = this.refs.get(cleanRef) ?? this.refs.remap(cleanRef)
      if (!info) {
        throw new Error(`ref "${target}" unknown — call snapshot() first.`)
      }

      try {
        // Click first to trigger any custom dropdown / hover state scripts on the page
        await this.mouse(await this.resolve(target), 'left', 1)

        // Resolve the backend node to a DOM element, focus and clear it, and trigger events
        const { object } = await this.cdp.DOM.resolveNode({ backendNodeId: info.backendDOMNodeId })
        if (object.objectId) {
          await this.cdp.Runtime.callFunctionOn({
            objectId: object.objectId,
            functionDeclaration: `function() {
              const input = this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' ? this : this.querySelector('input, textarea');
              if (input) {
                input.focus();
                input.value = "";
                input.dispatchEvent(new Event('focus', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }`
          })
          await this.cdp.Runtime.releaseObject({ objectId: object.objectId })
        }
      } catch (err) {
        // Fallback to coordinates click + activeElement clear if CDP node resolution fails
        await this.mouse(await this.resolve(target), 'left', 1)
        await this.evaluate(
          '(() => { const el = document.activeElement; if (el && "value" in el) el.value = ""; })()',
        )
      }
    }

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
      const { targetId } = await this.cdp.Target.createTarget({ url: url ?? 'about:blank' })
      return targetId
    },
    switch: async (targetId: string): Promise<void> => {
      this.pendingFocusTargetId = undefined
      await this.attachTarget(targetId)
    },
    close: async (targetId: string): Promise<void> => {
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
    this.resetSnapshotBaseline()
    this.refs = new RefRegistry()
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
      const remapped = this.refs.remap(target)
      if (remapped && remapped.backendDOMNodeId !== info.backendDOMNodeId) {
        return await this.boxCenter(remapped.backendDOMNodeId)
      }
      throw new Error(`ref "${target}" is stale — re-snapshot and retry.`)
    }
  }

  /** Center of a backend node's content box, via CDP box model. */
  private async boxCenter(backendNodeId: number): Promise<Point> {
    const { model } = await this.cdp.DOM.getBoxModel({ backendNodeId })
    const q = model.content // [x1,y1, x2,y2, x3,y3, x4,y4]
    return { x: Math.round((q[0] + q[2] + q[4] + q[6]) / 4), y: Math.round((q[1] + q[3] + q[5] + q[7]) / 4) }
  }

  private async mouse(p: Point, button: MouseButton, clickCount: number): Promise<void> {
    const { Input } = this.cdp
    const buttons = BUTTON_MASK[button]
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y })
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button, buttons, clickCount })
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button, buttons, clickCount })
  }
}
