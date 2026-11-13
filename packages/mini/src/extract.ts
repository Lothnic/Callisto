import type { Mini } from './index.js'

export interface ExtractField {
  selector?: string
  attribute?: string
  type?: 'text' | 'number'
}

export interface ExtractSpec {
  selector: string
  fields: Record<string, string | ExtractField>
  limit?: number
  include_text?: boolean
  paginate?: { next: string; max_pages?: number }
}

export interface ExtractResult {
  url: string
  title: string
  rows: Array<Record<string, string | number | null>>
  count: number
  pages: number
  truncated: boolean
}

/**
 * Runs in the page. It must stay self-contained: `Mini.evaluate` serializes the
 * function and passes the spec as JSON, so no closure state is available.
 *
 * Keep behaviour identical to `extractPage` in the Firefox extension's
 * content.js; the shared contract is covered by tests on both backends.
 */
function extractPageInBrowser(spec: ExtractSpec): { rows: Array<Record<string, string | number | null>>; has_next: boolean } {
  const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const matches = Array.from(document.querySelectorAll(spec.selector))
  const limit = spec.limit ?? 500
  const rows: Array<Record<string, string | number | null>> = []
  for (const row of matches.slice(0, limit)) {
    const item: Record<string, string | number | null> = {}
    for (const [name, rawField] of Object.entries(spec.fields)) {
      const field: ExtractField = typeof rawField === 'string' ? { selector: rawField } : rawField
      const element = field.selector ? row.querySelector(field.selector) : row
      if (!element) { item[name] = null; continue }
      const raw = field.attribute ? element.getAttribute(field.attribute) : element.textContent
      const text = clean(raw)
      if (field.type === 'number') {
        const normalized = text.replace(/[^0-9.eE+-]/g, '')
        const number = normalized === '' ? NaN : Number(normalized)
        item[name] = Number.isFinite(number) ? number : null
      } else item[name] = text.slice(0, 300)
    }
    if (spec.include_text) item._text = clean((row as HTMLElement).innerText).slice(0, 500)
    rows.push(item)
  }
  let has_next = false
  if (spec.paginate) {
    const next = document.querySelector(spec.paginate.next)
    const disabled = !next
      || next.hasAttribute('disabled')
      || next.getAttribute('aria-disabled') === 'true'
      || next.classList.contains('disabled')
    has_next = !disabled && (next.tagName !== 'A' || Boolean(next.getAttribute('href')))
  }
  return { rows, has_next }
}

/** Runs in the page and clicks the pager control. */
function clickNextInBrowser(selector: string): { clicked: boolean } {
  const next = document.querySelector<HTMLElement>(selector)
  if (!next) return { clicked: false }
  if (next.hasAttribute('disabled') || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('disabled')) {
    throw new Error('The next-page control is disabled.')
  }
  next.scrollIntoView({ block: 'center' })
  next.click()
  return { clicked: true }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function stableDocument(mini: Mini, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await mini.evaluate<boolean>(() => document.readyState === 'complete')) return
    } catch {
      // Navigation destroys the execution context; retry until the next document.
    }
    await sleep(50)
  }
  throw new Error('The page did not finish loading within 10 seconds.')
}

async function extractOnce(mini: Mini, spec: ExtractSpec): Promise<{ rows: Array<Record<string, string | number | null>>; has_next: boolean }> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      return await mini.evaluate(extractPageInBrowser, spec)
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await sleep(100)
    }
  }
}

/**
 * Extract rows from the current page, optionally following a pager. Pagination
 * stops at max_pages, at the row limit, when the pager disappears, or when the
 * page stops changing.
 */
export async function extractRows(mini: Mini, spec: ExtractSpec, limitTotal = 1000): Promise<ExtractResult> {
  const limit = Math.max(1, Math.min(spec.limit ?? 500, 1000))
  const maxPages = spec.paginate ? Math.max(1, Math.min(spec.paginate.max_pages ?? 10, 25)) : 1
  const rows: Array<Record<string, string | number | null>> = []
  let pages = 0
  let truncated = false
  for (let page = 0; page < maxPages; page++) {
    const result = await extractOnce(mini, { ...spec, limit })
    pages++
    rows.push(...result.rows)
    if (rows.length >= limitTotal) { truncated = true; break }
    if (!spec.paginate || !result.has_next) break
    let clicked: { clicked: boolean }
    try {
      clicked = await mini.evaluate(clickNextInBrowser, spec.paginate.next)
    } catch {
      // A pager link may navigate and destroy the execution context mid-call.
      clicked = { clicked: true }
    }
    if (!clicked.clicked) break
    await stableDocument(mini)
    await sleep(150)
  }
  const info = await mini.evaluate<{ url: string; title: string }>(() => ({ url: location.href, title: document.title }))
  return {
    url: info.url,
    title: info.title,
    rows: rows.slice(0, limitTotal),
    count: Math.min(rows.length, limitTotal),
    pages,
    truncated: truncated || rows.length > limitTotal,
  }
}
