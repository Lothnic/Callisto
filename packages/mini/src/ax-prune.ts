// Pruning: raw AX forest -> pruned forest. Pure, no CDP. Drops noise, hoists
// wrapper children, collapses redundancy. See rfcs/0002 for the heuristics.

/** A normalized AX node (snapshot.ts builds these from CDP AXNodes). */
export interface RawNode {
  id: string // `${frameId}:${nodeId}` — nodeIds collide across frames
  role: string // verbatim CDP role token (mixed case: 'button', 'StaticText')
  name: string
  description?: string
  value?: string
  state: string[]
  backendDOMNodeId?: number
  frameId: string
  childIds: string[]
}

export interface PrunedNode {
  role: string
  name: string
  description?: string
  value?: string
  state: string[]
  backendDOMNodeId?: number
  frameId: string
  ref?: string // filled by ax-refs after pruning
  children: PrunedNode[]
}

// Roles hoisted away (children pulled up to parent). The wrapper-collapse
// mechanism. RootWebArea/WebArea included: we never want the frame root itself.
const TRANSPARENT = new Set([
  'RootWebArea',
  'WebArea',
  'none',
  'presentation',
  'generic',
  'GenericContainer',
  'InlineTextBox',
  'LineBreak',
  'paragraph',
  // CSS layout tables (not semantic data tables) — pure structural noise.
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
])

// Roles the agent can act on — always kept, always get a ref.
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'scrollbar',
  // Critical surfaces that should appear in diffs even when they are containers.
  'dialog',
  'alertdialog',
])

// Structural / landmark roles — kept for context, not reffed. Landmarks live
// here so they are never dropped as "role-less wrappers" (roadmap pitfall).
const STRUCTURAL = new Set([
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
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'tablist',
  'menu',
  'menubar',
  'img',
  'figure',
  'blockquote',
])

export function isInteractive(role: string): boolean {
  return INTERACTIVE.has(role)
}

type Keep = 'keep' | 'hoist'

/**
 * Decide a node's fate. `ancestorName` is the nearest kept ancestor's name,
 * used to drop StaticText that merely echoes its labelled container.
 */
function classify(node: RawNode, ancestorName: string): Keep {
  const role = node.role
  if (node.state.includes('ignored')) return 'hoist'
  if (TRANSPARENT.has(role)) return 'hoist'
  if (INTERACTIVE.has(role)) return 'keep'

  if (role === 'StaticText' || role === 'text') {
    const name = node.name.trim()
    if (!name) return 'hoist'
    if (name === ancestorName.trim()) return 'hoist' // echoes its container
    return 'keep'
  }

  if (role === 'group') return node.name.trim() ? 'keep' : 'hoist'
  if (STRUCTURAL.has(role)) return 'keep'

  // Unknown role: keep if it carries a name, else hoist.
  return node.name.trim() ? 'keep' : 'hoist'
}

function toPruned(node: RawNode): PrunedNode {
  let name = node.name
  if ((node.role === 'StaticText' || node.role === 'text') && name.length > 250) {
    name = name.slice(0, 250) + '... [truncated]'
  }
  return {
    role: node.role,
    name,
    description: node.description,
    value: node.value,
    state: node.state,
    backendDOMNodeId: node.backendDOMNodeId,
    frameId: node.frameId,
    children: [],
  }
}

/**
 * Prune a forest. `roots` are the top-level node ids; `byId` is the full map.
 * Returns the kept top-level nodes with hoisted descendants attached.
 */
export function pruneForest(roots: string[], byId: Map<string, RawNode>): PrunedNode[] {
  // Walk children of `ids`, returning the pruned nodes that survive. Hoisted
  // nodes contribute their (recursively pruned) children in place.
  function walk(ids: string[], ancestorName: string): PrunedNode[] {
    const out: PrunedNode[] = []
    for (const id of ids) {
      const node = byId.get(id)
      if (!node) continue
      const fate = classify(node, ancestorName)
      if (fate === 'hoist') {
        out.push(...walk(node.childIds, ancestorName))
      } else {
        const pruned = toPruned(node)
        pruned.children = walk(node.childIds, node.name || ancestorName)
        out.push(collapse(pruned))
      }
    }
    return out
  }
  return walk(roots, '')
}

/**
 * Collapse a kept node that has exactly one kept child of the same semantic
 * weight and no name of its own — the child is more specific, so promote it.
 */
function collapse(node: PrunedNode): PrunedNode {
  if (!node.name.trim() && node.children.length === 1 && !isInteractive(node.role)) {
    const child = node.children[0]
    if (child.frameId === node.frameId) return child
  }
  return node
}
