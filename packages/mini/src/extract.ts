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

type PageRows = { rows: Array<Record<string, string | number | null>>; has_next: boolean; omitted: boolean }

/** Runs in the page; keep behavior aligned with the Firefox content script. */
function extractPageInBrowser(spec: ExtractSpec): PageRows {
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
  return { rows, has_next, omitted: matches.length > limit }
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

async function extractOnce(mini: Mini, spec: ExtractSpec): Promise<PageRows> {
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

async function waitForAdvance(mini: Mini, spec: ExtractSpec, previous: PageRows): Promise<PageRows> {
  const deadline = Date.now() + 5_000
  const before = JSON.stringify(previous.rows)
  let candidate = '', since = 0
  while (Date.now() < deadline) {
    let result: PageRows
    try { result = await mini.evaluate(extractPageInBrowser, spec) }
    catch { await sleep(100); continue } // A navigation may replace the document.
    const current = JSON.stringify(result.rows)
    // A temporarily empty grid is common while an async page is loading.
    if (current !== before && result.rows.length > 0) {
      if (candidate !== current) { candidate = current; since = Date.now() }
      else if (Date.now() - since >= 200) return result
    } else { candidate = ''; since = 0 }
    await sleep(100)
  }
  throw new Error('Pagination did not produce a stable, different set of rows within 5 seconds; inspect the page before retrying.')
}

/**
 * Extract rows from the current page, optionally following a pager. Pagination
 * stops at max_pages, at the row limit, or when the pager disappears. A page
 * that does not advance fails rather than returning duplicated rows.
 */
export async function extractRows(mini: Mini, spec: ExtractSpec, limitTotal = 1000): Promise<ExtractResult> {
  const limit = Math.max(1, Math.min(spec.limit ?? 500, 1000))
  const maxPages = spec.paginate ? Math.max(1, Math.min(spec.paginate.max_pages ?? 10, 25)) : 1
  const rows: Array<Record<string, string | number | null>> = []
  let pages = 0
  let truncated = false
  let result = await extractOnce(mini, { ...spec, limit })
  for (let page = 0; page < maxPages; page++) {
    pages++
    rows.push(...result.rows)
    if (result.omitted) truncated = true
    if (rows.length >= limitTotal) { if (rows.length > limitTotal || result.has_next) truncated = true; break }
    if (!spec.paginate || !result.has_next) break
    if (page + 1 >= maxPages) { truncated = true; break }
    let clicked: { clicked: boolean }
    try {
      clicked = await mini.evaluate(clickNextInBrowser, spec.paginate.next)
    } catch (error) {
      // Only navigation-related failures may have occurred after the click.
      if (!/context|navigation|target closed|cannot find/i.test(String(error))) throw error
      clicked = { clicked: true }
    }
    if (!clicked.clicked) break
    await stableDocument(mini)
    result = await waitForAdvance(mini, { ...spec, limit }, result)
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
