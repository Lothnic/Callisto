import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPoint } from '../src/elements.js'
import { Mini } from '../src/index.js'

// Docker/CI/root need --no-sandbox; real desktops don't. Opt in via env.
const chromeFlags = process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : []

// --- unit (always run, no browser) ---

test('isPoint distinguishes coordinates from refs', () => {
  assert.equal(isPoint({ x: 1, y: 2 }), true)
  assert.equal(isPoint('ax-42'), false)
})

// --- browser smoke (opt-in: needs a local Chrome + network) ---
// Phase 1: open a page, screenshot, act, screenshot again.

test('smoke: drive github.com', { skip: !process.env.CALLISTO_SMOKE }, async () => {
  const mini = await Mini.launch({ headless: true, chromeFlags })
  try {
    await mini.goto('https://github.com', { waitUntil: 'load' })

    const before = await mini.screenshot()
    assert.ok(before.length > 0, 'first screenshot should have bytes')

    const snap = await mini.snapshot()
    assert.match(snap.url, /github\.com/)
    assert.ok(snap.title.length > 0)

    await mini.click({ x: 120, y: 30 })
    await mini.scroll(0, 600)

    const after = await mini.screenshot()
    assert.ok(after.length > 0, 'second screenshot should have bytes')
  } finally {
    await mini.close()
  }
})

// Phase 2: the a11y tree carries refs, and a ref survives a state change.

test('smoke: a11y snapshot has refs and stable ids', { skip: !process.env.CALLISTO_SMOKE }, async () => {
  const mini = await Mini.launch({ headless: true, chromeFlags })
  try {
    // data: URL keeps the test hermetic — a checkbox whose state we can toggle.
    const page =
      'data:text/html,' +
      encodeURIComponent(
        '<h1>Form</h1><label><input type="checkbox" id="c"> Subscribe</label>' +
          '<button onclick="document.getElementById(\'c\').checked=true">Set</button>',
      )
    await mini.goto(page, { waitUntil: 'load' })

    const snap1 = await mini.snapshot()
    // tree should carry at least one ref on the interactive nodes
    const refs1 = [...snap1.text.matchAll(/\[(ax-\d+)\]/g)].map((m) => m[1])
    assert.ok(refs1.length >= 2, `expected refs for checkbox+button, got:\n${snap1.text}`)
    assert.match(snap1.text, /checkbox/)
    assert.match(snap1.text, /button "Set"/)

    // toggle the checkbox by clicking "Set", re-snapshot, confirm refs are stable
    const setRef = snap1.text.split('\n').find((l) => /button "Set"/.test(l))!.match(/\[(ax-\d+)\]/)![1]
    await mini.click(setRef)

    const snap2 = await mini.snapshot()
    const refs2 = new Set([...snap2.text.matchAll(/\[(ax-\d+)\]/g)].map((m) => m[1]))
    // same DOM nodes -> same refs across the state change (Phase 2 criterion)
    for (const r of refs1) assert.ok(refs2.has(r), `ref ${r} should survive re-snapshot`)
    assert.match(snap2.text, /checkbox.*\{checked\}|checkbox \{checked\}/)
  } finally {
    await mini.close()
  }
})

test('smoke: iframe stitching grafts nested frame content', { skip: !process.env.CALLISTO_SMOKE }, async () => {
  const mini = await Mini.launch({ headless: true, chromeFlags })
  try {
    const iframeContent = encodeURIComponent('<h2>Inside Iframe</h2><button id="ibtn">Iframe Button</button>')
    const page =
      'data:text/html,' +
      encodeURIComponent(
        '<h1>Main Page</h1>' +
          `<iframe id="sub" src="data:text/html,${iframeContent}"></iframe>`
      )
    await mini.goto(page, { waitUntil: 'load' })

    const snap = await mini.snapshot()
    // The button inside the iframe should be stitched, pruned, and annotated
    assert.match(snap.text, /button "Iframe Button"/)
    
    const iframeBtnRef = snap.text.split('\n').find((l) => /button "Iframe Button"/.test(l))!.match(/\[(ax-\d+)\]/)![1]
    assert.ok(iframeBtnRef, 'expected to find a ref for the button inside the iframe')
  } finally {
    await mini.close()
  }
})
