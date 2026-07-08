// Serialize a pruned, ref-annotated forest to compact indented text — the
// string the LLM actually reads. Format: `[ref] role "name" {state} =value`.
// Pure. See rfcs/0002 for the shape.
import { isInteractive, type PrunedNode } from './ax-prune.js'

const URGENT = new Set(['alert', 'status'])
const CONTEXT = new Set([
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'form',
  'search',
  'article',
  'heading',
  'list',
  'listitem',
  'table',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'tablist',
  'menu',
  'menubar',
  'img',
  'figure',
  'blockquote',
])

function line(node: PrunedNode, depth: number): string {
  const parts: string[] = []
  if (node.ref) parts.push(`[${node.ref}]`)
  parts.push(node.role)
  if (node.name.trim()) parts.push(`"${node.name.trim()}"`)
  if (node.state.length) parts.push(`{${node.state.join(',')}}`)
  if (node.value != null && node.value !== '') parts.push(`=${node.value}`)
  return '  '.repeat(depth) + parts.join(' ')
}

function rank(node: PrunedNode): number {
  if (isInteractive(node.role) || node.ref) return 0
  if (URGENT.has(node.role)) return 1
  if (CONTEXT.has(node.role)) return 2
  if (node.role === 'StaticText' || node.role === 'text') return 3
  return 4
}

function ordered(nodes: PrunedNode[]): PrunedNode[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => rank(a.node) - rank(b.node) || a.index - b.index)
    .map(({ node }) => node)
}

export function formatTree(forest: PrunedNode[]): string {
  const out: string[] = []
  const walk = (node: PrunedNode, depth: number): void => {
    out.push(line(node, depth))
    for (const child of ordered(node.children)) walk(child, depth + 1)
  }
  for (const root of ordered(forest)) walk(root, 0)
  return out.join('\n')
}
