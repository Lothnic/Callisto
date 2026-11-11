// Full snapshot: CDP Accessibility -> normalized forest -> iframe stitch ->
// prune -> refs -> text. The orchestration; the heavy lifting is in the pure
// ax-*.ts modules. See rfcs/0002.
import type { Session } from './client.js'
import { pruneForest, type RawNode } from './ax-prune.js'
import { formatTree } from './ax-format.js'
import type { RefRegistry } from './ax-refs.js'

export interface Snapshot {
  url: string
  title: string
  /** the pruned, ref-annotated a11y tree as indented text */
  text: string
}

// --- CDP shapes (typed locally; the shipped protocol types are incomplete for
// getFullAXTree's frameId param). ---
interface CdpAXNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  description?: { value?: string }
  value?: { value?: unknown }
  properties?: Array<{ name: string; value?: { value?: unknown } }>
  childIds?: string[]
  backendDOMNodeId?: number
}
interface FrameTreeNode {
  frame: { id: string; parentId?: string }
  childFrames?: FrameTreeNode[]
}

const STATE_PROPS = new Set([
  'focused',
  'checked',
  'expanded',
  'disabled',
  'selected',
  'required',
  'pressed',
  'readonly',
  'invalid',
  'clickable',
])

function strval(v?: { value?: unknown }): string {
  const x = v?.value
  if (typeof x === 'string') return x
  return x == null ? '' : String(x)
}

function extractState(n: CdpAXNode): string[] {
  const s: string[] = []
  for (const p of n.properties ?? []) {
    if (!STATE_PROPS.has(p.name)) continue
    const v = p.value?.value
    if (v === true || v === 'true') s.push(p.name)
    else if (v === 'mixed') s.push('mixed')
  }
  return s
}

function flattenFrames(t: FrameTreeNode): Array<{ id: string; parentId?: string }> {
  const out: Array<{ id: string; parentId?: string }> = [{ id: t.frame.id, parentId: t.frame.parentId }]
  for (const c of t.childFrames ?? []) out.push(...flattenFrames(c))
  return out
}

/** Normalize one frame's AX nodes into byId; return this frame's root id. */
function normalizeFrame(
  nodes: CdpAXNode[],
  frameId: string,
  byId: Map<string, RawNode>,
): string | undefined {
  const local: string[] = []
  const referenced = new Set<string>()
  for (const n of nodes) {
    const id = `${frameId}:${n.nodeId}`
    const childIds = (n.childIds ?? []).map((c) => `${frameId}:${c}`)
    const state = extractState(n)
    if (n.ignored) state.push('ignored')
    byId.set(id, {
      id,
      role: n.role?.value ?? '',
      name: strval(n.name),
      description: strval(n.description) || undefined,
      value: (n.role?.value === 'password' || n.role?.value === 'PasswordField') ? '[REDACTED]' : (strval(n.value) || undefined),
      state,
      backendDOMNodeId: n.backendDOMNodeId,
      frameId,
      childIds,
    })
    local.push(id)
    childIds.forEach((c) => referenced.add(c))
  }
  return local.find((id) => !referenced.has(id))
}

export async function snapshot(session: Session, refs: RefRegistry): Promise<Snapshot> {
  const cdp = session.cdp

  const ax = cdp.Accessibility as unknown as {
    getFullAXTree(p: { frameId?: string }): Promise<{ nodes: CdpAXNode[] }>
  }
  const dom = cdp.DOM as unknown as {
    getFrameOwner(p: { frameId: string }): Promise<{ backendNodeId: number }>
  }

  {
    const { frameTree } = await cdp.Page.getFrameTree()
    const frames = flattenFrames(frameTree as unknown as FrameTreeNode)
    const mainId = frames[0].id

    const byId = new Map<string, RawNode>()
    const frameRoot = new Map<string, string>()
    for (const f of frames) {
      try {
        const { nodes } = await ax.getFullAXTree({ frameId: f.id })
        // AX exposes password fields as textboxes in Chromium. Inspect the DOM
        // type for nodes with values and fail closed if inspection is unavailable.
        await Promise.all(nodes.filter((n) => n.value && (n.role?.value === 'textbox' || n.role?.value === 'searchbox')).map(async (n) => {
          try {
            if (n.backendDOMNodeId == null) throw new Error('missing DOM node')
            const { node } = await cdp.DOM.describeNode({ backendNodeId: n.backendDOMNodeId })
            const attributes = node.attributes ?? []
            const typeIndex = attributes.findIndex((a, i) => i % 2 === 0 && a.toLowerCase() === 'type')
            if (typeIndex >= 0 && attributes[typeIndex + 1]?.toLowerCase() === 'password') n.value = { value: '[REDACTED]' }
          } catch {
            n.value = { value: '[REDACTED]' }
          }
        }))
        // Password fields can also expose masked text as AX descendants. Omit
        // those descendants, including their length, from the snapshot.
        const byNodeId = new Map(nodes.map((n) => [n.nodeId, n]))
        const excluded = new Set<string>()
        const exclude = (id: string): void => {
          if (excluded.has(id)) return
          excluded.add(id)
          for (const child of byNodeId.get(id)?.childIds ?? []) exclude(child)
        }
        for (const n of nodes) {
          if (n.value?.value === '[REDACTED]') {
            for (const child of n.childIds ?? []) exclude(child)
            n.childIds = []
          }
        }
        const root = normalizeFrame(nodes.filter((n) => !excluded.has(n.nodeId)), f.id, byId)
        if (root) frameRoot.set(f.id, root)
      } catch {
        // frame went away mid-snapshot; skip it
      }
    }

    // Stitch: graft each child frame's root under its owner <iframe> node.
    const byBackend = new Map<number, string>()
    for (const [id, n] of byId) {
      if (n.backendDOMNodeId != null) byBackend.set(n.backendDOMNodeId, id)
    }
    for (const f of frames) {
      if (f.id === mainId) continue
      const childRoot = frameRoot.get(f.id)
      if (!childRoot) continue
      try {
        const { backendNodeId } = await dom.getFrameOwner({ frameId: f.id })
        const ownerId = byBackend.get(backendNodeId)
        if (ownerId) byId.get(ownerId)!.childIds.push(childRoot)
      } catch {
        // OOPIF / detached: leave the child frame as its own top-level root
      }
    }

    // Top-level roots = nodes referenced by no one (main root + any orphan frames).
    const referenced = new Set<string>()
    for (const n of byId.values()) n.childIds.forEach((c) => referenced.add(c))
    const roots: string[] = []
    for (const id of byId.keys()) if (!referenced.has(id)) roots.push(id)

    const forest = refs.annotate(pruneForest(roots, byId))
    const text = formatTree(forest)

    const meta = await cdp.Runtime.evaluate({
      expression: 'JSON.stringify({ url: location.href, title: document.title })',
      returnByValue: true,
    })
    const { url, title } = JSON.parse(meta.result.value as string) as { url: string; title: string }
    return { url, title, text }
  }
}
