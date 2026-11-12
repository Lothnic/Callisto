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

export interface RefLookup {
  role?: string
  name?: string | RegExp
  exact?: boolean
}

export class RefRegistry {
  private byBackend = new Map<number, RefInfo>()
  private byRef = new Map<string, RefInfo>()
  private currentRefs = new Set<string>()
  private next = 1

  /** Drop document-local references without reusing their identifiers. */
  reset(): void {
    this.byBackend.clear()
    this.byRef.clear()
    this.currentRefs.clear()
  }

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
    this.currentRefs.clear()
    const visit = (n: PrunedNode): void => {
      if (isInteractive(n.role) && n.backendDOMNodeId != null) {
        n.ref = this.intern(n.backendDOMNodeId, n.role, n.name, n.frameId)
        this.currentRefs.add(n.ref)
      }
      n.children.forEach(visit)
    }
    forest.forEach(visit)
    return forest
  }

  get(ref: string): RefInfo | undefined {
    return this.byRef.get(ref)
  }

  find(query: RefLookup): RefInfo | undefined {
    const role = query.role?.toLowerCase()
    const candidates = [...this.byRef.values()].filter((info) => {
      if (!this.currentRefs.has(info.ref)) return false
      if (role && info.role.toLowerCase() !== role) return false
      return this.matchesName(info.name, query.name, query.exact)
    })
    if (candidates.length > 1) throw new Error(`locator matched ${candidates.length} elements; refine the role or name`)
    return candidates[0]
  }

  private matchesName(actual: string, expected?: string | RegExp, exact = false): boolean {
    if (expected === undefined) return true
    if (expected instanceof RegExp) return expected.test(actual)

    const a = actual.trim()
    const e = expected.trim()
    if (exact) return a === e
    if (a === e) return true
    return a.toLowerCase().includes(e.toLowerCase())
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
