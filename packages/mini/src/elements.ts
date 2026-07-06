// Ref handling. Interaction targets are either raw viewport coordinates
// ({ x, y }) or opaque string refs produced by snapshot(). The ref -> point map
// is populated by the accessibility tree in Phase 2; until then resolving a ref
// throws with a clear pointer so callers get a signal, not a silent no-op.
export type Ref = string

export interface Point {
  x: number
  y: number
}

export type Target = Ref | Point

export function isPoint(t: Target): t is Point {
  return typeof t === 'object' && t !== null && 'x' in t && 'y' in t
}

export class RefRegistry {
  private map = new Map<Ref, Point>()

  clear(): void {
    this.map.clear()
  }

  set(ref: Ref, point: Point): void {
    this.map.set(ref, point)
  }

  resolve(ref: Ref): Point {
    const point = this.map.get(ref)
    if (!point) {
      throw new Error(
        `ref "${ref}" not found. Ref-based targeting lands in Phase 2 (a11y tree); ` +
          `for now pass { x, y } coordinates.`,
      )
    }
    return point
  }
}
