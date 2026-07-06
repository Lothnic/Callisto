// Ref allocation + remap. Refs are stable by backendDOMNodeId: the same DOM
// node gets the same `ax-N` for the life of the page, so refs survive clicks
// and state changes without re-allocation (rfcs/0002). The registry also keeps
// role/name/frameId per ref so a stale ref can be remapped heuristically.
import { isInteractive, type PrunedNode } from './ax-prune.js'

export interface RefInfo {
  ref: string
  backendDOMNodeId: number
  role: string
  name: string
  frameId: string
}

export class RefRegistry {
  private byBackend = new Map<number, RefInfo>()
  private byRef = new Map<string, RefInfo>()
  private next = 1

  /** Stable ref for a backend node — allocated once, reused thereafter. */
  private intern(backendDOMNodeId: number, role: string, name: string, frameId: string): string {
    const existing = this.byBackend.get(backendDOMNodeId)
    if (existing) {
      existing.role = role // refresh remap hints; ref itself is fixed
      existing.name = name
      return existing.ref
    }
    const info: RefInfo = { ref: `ax-${this.next++}`, backendDOMNodeId, role, name, frameId }
    this.byBackend.set(backendDOMNodeId, info)
    this.byRef.set(info.ref, info)
    return info.ref
  }

  /**
   * Walk a pruned forest and stamp `ref` onto every interactive, DOM-backed
   * node. Mutates in place and returns the same forest for chaining.
   */
  annotate(forest: PrunedNode[]): PrunedNode[] {
    const visit = (n: PrunedNode): void => {
      if (isInteractive(n.role) && n.backendDOMNodeId != null) {
        n.ref = this.intern(n.backendDOMNodeId, n.role, n.name, n.frameId)
      }
      n.children.forEach(visit)
    }
    forest.forEach(visit)
    return forest
  }

  get(ref: string): RefInfo | undefined {
    return this.byRef.get(ref)
  }

  /** Heuristic remap for a stale ref: another live ref with same role+name. */
  remap(ref: string): RefInfo | undefined {
    const stale = this.byRef.get(ref)
    if (!stale) return undefined
    for (const info of this.byRef.values()) {
      if (info.ref !== ref && info.role === stale.role && info.name === stale.name) return info
    }
    return undefined
  }
}
