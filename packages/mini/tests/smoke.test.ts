import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPoint, RefRegistry } from '../src/elements.js'
import { Mini } from '../src/index.js'

// --- unit (always run, no browser) ---

test('isPoint distinguishes coordinates from refs', () => {
  assert.equal(isPoint({ x: 1, y: 2 }), true)
  assert.equal(isPoint('ax-42'), false)
})

test('RefRegistry.resolve throws a helpful error until Phase 2', () => {
  const refs = new RefRegistry()
  assert.throws(() => refs.resolve('ax-1'), /Phase 2/)
  refs.set('ax-1', { x: 10, y: 20 })
  assert.deepEqual(refs.resolve('ax-1'), { x: 10, y: 20 })
})

// --- browser smoke (opt-in: needs a local Chrome + network) ---
// Roadmap Phase 1: open a page, screenshot, act, screenshot again.

test('smoke: drive github.com', { skip: !process.env.CALLISTO_SMOKE }, async () => {
  const mini = await Mini.launch({ headless: true })
  try {
    await mini.goto('https://github.com', { waitUntil: 'load' })

    const before = await mini.screenshot()
    assert.ok(before.length > 0, 'first screenshot should have bytes')

    const snap = await mini.snapshot()
    assert.match(snap.url, /github\.com/)
    assert.ok(snap.title.length > 0)

    // act: coordinate click (top-left nav) + scroll, then re-observe
    await mini.click({ x: 120, y: 30 })
    await mini.scroll(0, 600)

    const after = await mini.screenshot()
    assert.ok(after.length > 0, 'second screenshot should have bytes')

    const heading = await mini.evaluate<string>('document.querySelector("h1")?.textContent ?? ""')
    assert.equal(typeof heading, 'string')
  } finally {
    await mini.close()
  }
})
