import { writeFile } from 'node:fs/promises'
import type { ClickOpts, Mini, TypeOpts, WaitOpts } from './index.js'
import type { Point, Ref, Target } from './elements.js'

export interface LocatorOptions {
  name?: string | RegExp
  exact?: boolean
}

type LocatorQuery =
  | { kind: 'ref'; ref: Ref }
  | { kind: 'role'; role: string; name?: string | RegExp; exact?: boolean }
  | { kind: 'text'; text: string | RegExp; exact?: boolean }
  | { kind: 'label'; label: string | RegExp; exact?: boolean }

export interface ScreenshotOptions {
  fullPage?: boolean
  path?: string
}

function targetLabel(query: LocatorQuery): string {
  switch (query.kind) {
    case 'ref':
      return `[callisto-ref="${query.ref}"]`
    case 'role':
      return `role=${query.role}${query.name ? ` name=${String(query.name)}` : ''}`
    case 'text':
      return `text=${String(query.text)}`
    case 'label':
      return `label=${String(query.label)}`
  }
}

/**
 * Playwright-shaped locator over Callisto's snapshot refs.
 *
 * This is intentionally not a selector engine: role/text/label locators resolve
 * against the latest ref registry populated by `page.accessibility.snapshot()`.
 */
export class Locator {
  #mini: Mini
  #query: LocatorQuery

  constructor(mini: Mini, query: LocatorQuery) {
    this.#mini = mini
    this.#query = query
  }

  async click(opts: ClickOpts = {}): Promise<void> {
    await this.#mini.click(await this.#target(), opts)
  }

  async dblclick(opts: ClickOpts = {}): Promise<void> {
    await this.#mini.dblclick(await this.#target(), opts)
  }

  async hover(): Promise<void> {
    await this.#mini.hover(await this.#target())
  }

  async fill(value: string): Promise<void> {
    await this.#mini.fill(await this.#target(), value)
  }

  async press(key: string): Promise<void> {
    await this.click()
    await this.#mini.press(key)
  }

  async type(text: string, opts: TypeOpts = {}): Promise<void> {
    await this.click()
    await this.#mini.type(text, opts)
  }

  first(): Locator {
    return this
  }

  async #target(): Promise<Target> {
    if (this.#query.kind === 'ref') return this.#query.ref

    const ref = this.#resolveRef()
    if (!ref) {
      throw new Error(
        `locator ${targetLabel(this.#query)} not found — call page.accessibility.snapshot() first.`,
      )
    }
    return ref
  }

  #resolveRef(): Ref | undefined {
    switch (this.#query.kind) {
      case 'role':
        return this.#mini.ref({
          role: this.#query.role,
          name: this.#query.name,
          exact: this.#query.exact,
        })
      case 'text':
        return this.#mini.ref({ name: this.#query.text, exact: this.#query.exact })
      case 'label':
        return this.#mini.ref({ name: this.#query.label, exact: this.#query.exact })
      case 'ref':
        return this.#query.ref
    }
  }
}

/**
 * Playwright-shaped facade over Mini. Mini remains the CDP engine; Page is the
 * API face shown to agents.
 */
export class Page {
  #mini: Mini

  constructor(mini: Mini) {
    this.#mini = mini
  }

  async goto(url: string, opts: { waitUntil?: 'load' | 'domcontentloaded' } = {}): Promise<void> {
    await this.#mini.goto(url, opts)
  }

  async goBack(): Promise<void> {
    await this.#mini.back()
  }

  async goForward(): Promise<void> {
    await this.#mini.forward()
  }

  async reload(): Promise<void> {
    await this.#mini.reload()
  }

  async click(target: string | Locator | Point, opts: ClickOpts = {}): Promise<void> {
    if (target instanceof Locator) return target.click(opts)
    if (typeof target === 'string') return this.locatorOrRef(target).click(opts)
    await this.#mini.click(target, opts)
  }

  async fill(target: string | Locator | Point, value: string): Promise<void> {
    if (target instanceof Locator) return target.fill(value)
    if (typeof target === 'string') return this.locatorOrRef(target).fill(value)
    await this.#mini.fill(target, value)
  }

  async press(target: string | Locator | Point, key: string): Promise<void> {
    if (target instanceof Locator) return target.press(key)
    if (typeof target === 'string') return this.locatorOrRef(target).press(key)
    await this.#mini.click(target)
    await this.#mini.press(key)
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer> {
    const png = await this.#mini.screenshot({ fullPage: opts.fullPage })
    if (opts.path) await writeFile(opts.path, png)
    return png
  }

  async evaluate<T = unknown>(
    fn: string | ((...args: never[]) => T),
    ...args: unknown[]
  ): Promise<T> {
    return this.#mini.evaluate<T>(fn, ...args)
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  async waitForFunction(predicate: string | (() => boolean), opts: WaitOpts = {}): Promise<void> {
    await this.#mini.waitFor(predicate, opts)
  }

  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load'): Promise<void> {
    if (state === 'domcontentloaded') {
      await this.#mini.waitFor(() => document.readyState === 'interactive' || document.readyState === 'complete')
      return
    }
    if (state === 'networkidle') {
      await this.waitForTimeout(500)
      return
    }
    await this.#mini.waitFor(() => document.readyState === 'complete')
  }

  async url(): Promise<string> {
    return this.#mini.evaluate<string>(() => location.href)
  }

  async title(): Promise<string> {
    return this.#mini.evaluate<string>(() => document.title)
  }

  context(): { pages: () => ReturnType<Mini['pages']> } {
    return {
      pages: () => this.#mini.pages(),
    }
  }

  getByRole(role: string, opts: LocatorOptions = {}): Locator {
    return new Locator(this.#mini, { kind: 'role', role, name: opts.name, exact: opts.exact })
  }

  getByText(text: string | RegExp, opts: Omit<LocatorOptions, 'name'> = {}): Locator {
    return new Locator(this.#mini, { kind: 'text', text, exact: opts.exact })
  }

  getByLabel(label: string | RegExp, opts: Omit<LocatorOptions, 'name'> = {}): Locator {
    return new Locator(this.#mini, { kind: 'label', label, exact: opts.exact })
  }

  locator(selector: string): Locator {
    const normalized = selector.trim()
    const callistoRef = normalized.match(/^\[callisto-ref=(?:"|')?(ax-\d+)(?:"|')?\]$/)
    if (callistoRef) return new Locator(this.#mini, { kind: 'ref', ref: callistoRef[1] })

    const bareRef = normalized.match(/^\[?(ax-\d+)\]?$/)
    if (bareRef) return new Locator(this.#mini, { kind: 'ref', ref: bareRef[1] })

    throw new Error('Only [callisto-ref="ax-N"] locators are supported')
  }

  accessibility = {
    snapshot: () => this.#mini.snapshot(),
  }

  mouse = {
    click: (x: number, y: number, opts: ClickOpts = {}) => this.#mini.click({ x, y }, opts),
    wheel: (deltaX: number, deltaY: number) => this.#mini.scroll(deltaX, deltaY),
  }

  keyboard = {
    press: (key: string) => this.#mini.press(key),
    type: (text: string, opts: TypeOpts = {}) => this.#mini.type(text, opts),
    down: (key: string) => this.#mini.keyDown(key),
    up: (key: string) => this.#mini.keyUp(key),
  }

  private locatorOrRef(selector: string): Locator {
    return this.locator(selector)
  }
}
