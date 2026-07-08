import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Page } from '../src/index.js'

function fakeMini() {
  const calls: Array<[string, ...unknown[]]> = []
  return {
    calls,
    ref: (query: unknown) => {
      calls.push(['ref', query])
      return 'ax-2'
    },
    click: async (...args: unknown[]) => {
      calls.push(['click', ...args])
    },
    fill: async (...args: unknown[]) => {
      calls.push(['fill', ...args])
    },
    press: async (...args: unknown[]) => {
      calls.push(['press', ...args])
    },
    screenshot: async (...args: unknown[]) => {
      calls.push(['screenshot', ...args])
      return Buffer.from('png')
    },
    snapshot: async () => ({ url: 'https://example.test', title: 'Example', text: '[ax-2] button "Go"' }),
    evaluate: async () => 'ok',
    waitFor: async (...args: unknown[]) => {
      calls.push(['waitFor', ...args])
    },
    pages: async () => [{ id: 't1', url: 'about:blank', title: '' }],
    goto: async (...args: unknown[]) => {
      calls.push(['goto', ...args])
    },
    back: async () => {
      calls.push(['back'])
    },
    forward: async () => {
      calls.push(['forward'])
    },
    reload: async () => {
      calls.push(['reload'])
    },
    scroll: async (...args: unknown[]) => {
      calls.push(['scroll', ...args])
    },
    type: async (...args: unknown[]) => {
      calls.push(['type', ...args])
    },
    keyDown: async (...args: unknown[]) => {
      calls.push(['keyDown', ...args])
    },
    keyUp: async (...args: unknown[]) => {
      calls.push(['keyUp', ...args])
    },
  }
}

test('page.locator bridges [callisto-ref="ax-N"] to Mini refs', async () => {
  const mini = fakeMini()
  const page = new Page(mini as never)

  await page.locator('[callisto-ref="ax-42"]').click()

  assert.deepEqual(mini.calls, [['click', 'ax-42', {}]])
})

test('getByRole resolves against the Mini ref registry at action time', async () => {
  const mini = fakeMini()
  const page = new Page(mini as never)

  await page.getByRole('button', { name: 'Go' }).click()

  assert.deepEqual(mini.calls, [
    ['ref', { role: 'button', name: 'Go', exact: undefined }],
    ['click', 'ax-2', {}],
  ])
})

test('page.accessibility.snapshot returns the custom Callisto snapshot', async () => {
  const mini = fakeMini()
  const page = new Page(mini as never)

  const snap = await page.accessibility.snapshot()

  assert.deepEqual(snap, {
    url: 'https://example.test',
    title: 'Example',
    text: '[ax-2] button "Go"',
  })
})

test('page.screenshot returns bytes and writes path when requested', async () => {
  const mini = fakeMini()
  const page = new Page(mini as never)
  const dir = await mkdtemp(join(tmpdir(), 'callisto-page-'))

  try {
    const path = join(dir, 'shot.png')
    const png = await page.screenshot({ fullPage: true, path })

    assert.equal(png.toString(), 'png')
    assert.equal((await readFile(path)).toString(), 'png')
    assert.deepEqual(mini.calls, [['screenshot', { fullPage: true }]])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
