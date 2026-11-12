import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pruneForest, type RawNode } from '../src/ax-prune.js'
import { formatTree } from '../src/ax-format.js'
import { formatDiff } from '../src/ax-diff.js'
import { RefRegistry } from '../src/ax-refs.js'

// Build a byId map from terse fixtures. Each fixture: [id, role, name, children].
function forest(
  nodes: Array<[string, string, string, string[]]>,
  backends: Record<string, number> = {},
): { roots: string[]; byId: Map<string, RawNode> } {
  const byId = new Map<string, RawNode>()
  const referenced = new Set<string>()
  for (const [id, role, name, childIds] of nodes) {
    byId.set(id, {
      id,
      role,
      name,
      state: [],
      frameId: 'main',
      childIds,
      backendDOMNodeId: backends[id],
    })
    childIds.forEach((c) => referenced.add(c))
  }
  const roots = nodes.map((n) => n[0]).filter((id) => !referenced.has(id))
  return { roots, byId }
}

test('prune hoists generic wrappers and keeps interactive nodes', () => {
  const { roots, byId } = forest([
    ['1', 'RootWebArea', 'Page', ['2']],
    ['2', 'generic', '', ['3', '4']],
    ['3', 'button', 'Buy', []],
    ['4', 'generic', '', ['5']],
    ['5', 'link', 'Home', []],
  ])
  const out = pruneForest(roots, byId)
  // RootWebArea + generics vanish; button and link surface as top-level.
  assert.deepEqual(
    out.map((n) => `${n.role}:${n.name}`),
    ['button:Buy', 'link:Home'],
  )
})

test('prune drops StaticText that echoes its container name', () => {
  const { roots, byId } = forest([
    ['1', 'button', 'Search', ['2']],
    ['2', 'StaticText', 'Search', []],
  ])
  const out = pruneForest(roots, byId)
  assert.equal(out.length, 1)
  assert.equal(out[0].children.length, 0) // echoed text pruned
})

test('prune keeps landmarks (main/nav) and named groups', () => {
  const { roots, byId } = forest([
    ['1', 'main', 'Content', ['2', '3']],
    ['2', 'group', '', ['4']], // unnamed group -> hoisted
    ['3', 'group', 'Filters', []], // named group -> kept
    ['4', 'button', 'Go', []],
  ])
  const out = pruneForest(roots, byId)
  assert.equal(out[0].role, 'main')
  const roles = out[0].children.map((c) => `${c.role}:${c.name}`)
  assert.deepEqual(roles, ['button:Go', 'group:Filters'])
})

test('refs are stable by backendDOMNodeId across re-annotation', () => {
  const f1 = forest([['1', 'button', 'A', []]], { '1': 100 })
  const refs = new RefRegistry()
  const a = refs.annotate(pruneForest(f1.roots, f1.byId))
  const ref1 = a[0].ref
  assert.match(ref1!, /^ax-\d+$/)

  // Re-snapshot: same backend id -> same ref, even though name changed.
  const f2 = forest([['9', 'button', 'A (pressed)', []]], { '9': 100 })
  const b = refs.annotate(pruneForest(f2.roots, f2.byId))
  assert.equal(b[0].ref, ref1)
})

test('a document reset retires refs without reusing their identifiers', () => {
  const refs = new RefRegistry()
  const before = forest([['1', 'button', 'Old', []]], {'1':100})
  const oldRef = refs.annotate(pruneForest(before.roots, before.byId))[0].ref!
  refs.reset()
  const after = forest([['2', 'button', 'New', []]], {'2':100})
  const newRef = refs.annotate(pruneForest(after.roots, after.byId))[0].ref!
  assert.notEqual(newRef, oldRef)
  assert.equal(refs.get(oldRef), undefined)
})

test('format emits [ref] role "name" {state} =value', () => {
  const { roots, byId } = forest([
    ['1', 'navigation', 'Main', ['2']],
    ['2', 'textbox', 'Email', []],
  ])
  byId.get('2')!.state = ['required', 'focused']
  byId.get('2')!.value = 'a@b.c'
  byId.get('2')!.backendDOMNodeId = 5
  const refs = new RefRegistry()
  const out = formatTree(refs.annotate(pruneForest(roots, byId)))
  const lines = out.split('\n')
  assert.equal(lines[0], 'navigation "Main"')
  assert.match(lines[1], /^ {2}\[ax-\d+\] textbox "Email" \{required,focused\} =a@b\.c$/)
})

test('format puts interactive siblings before passive context', () => {
  const { roots, byId } = forest([
    ['1', 'navigation', 'Main', []],
    ['2', 'heading', 'Welcome', []],
    ['3', 'button', 'Start', []],
  ], { '3': 3 })
  const refs = new RefRegistry()
  const out = formatTree(refs.annotate(pruneForest(roots, byId))).split('\n')

  assert.match(out[0], /^\[ax-\d+\] button "Start"$/)
  assert.equal(out[1], 'navigation "Main"')
  assert.equal(out[2], 'heading "Welcome"')
})

test('dialogs are ref-annotated so new modal surfaces appear in diffs', () => {
  const { roots, byId } = forest([['1', 'dialog', 'Confirm', []]], { '1': 1 })
  const refs = new RefRegistry()
  const out = formatTree(refs.annotate(pruneForest(roots, byId)))

  assert.match(out, /^\[ax-\d+\] dialog "Confirm"$/)
})

test('formatDiff reports changed, new, and removed ref lines', () => {
  const previous = [
    '[ax-1] button "Add to Cart"',
    '[ax-2] link "Sign in"',
  ].join('\n')
  const current = [
    '[ax-1] button "Add to Cart" {checked}',
    '[ax-3] dialog "Confirm"',
  ].join('\n')

  assert.equal(
    formatDiff(previous, current),
    [
      '[changed] ax-1 button "Add to Cart" {checked}',
      '[new]     ax-3 dialog "Confirm"',
      '[removed] ax-2 link "Sign in"',
    ].join('\n'),
  )
})
