// Serialize a pruned, ref-annotated forest to compact indented text — the
// string the LLM actually reads. Format: `[ref] role "name" {state} =value`.
// Pure. See rfcs/0002 for the shape.
import type { PrunedNode } from './ax-prune.js'

function line(node: PrunedNode, depth: number): string {
  const parts: string[] = []
  if (node.ref) parts.push(`[${node.ref}]`)
  parts.push(node.role)
  if (node.name.trim()) parts.push(`"${node.name.trim()}"`)
  if (node.state.length) parts.push(`{${node.state.join(',')}}`)
  if (node.value != null && node.value !== '') parts.push(`=${node.value}`)
  return '  '.repeat(depth) + parts.join(' ')
}

export function formatTree(forest: PrunedNode[]): string {
  const out: string[] = []
  const walk = (node: PrunedNode, depth: number): void => {
    out.push(line(node, depth))
    for (const child of node.children) walk(child, depth + 1)
  }
  for (const root of forest) walk(root, 0)
  return out.join('\n')
}
