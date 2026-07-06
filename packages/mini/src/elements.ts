// Coordinate/target types shared by the interaction surface. Ref *allocation*
// lives in ax-refs.ts (Phase 2); this file is just the value types.
export type Ref = string

export interface Point {
  x: number
  y: number
}

export type Target = Ref | Point

export function isPoint(t: Target): t is Point {
  return typeof t === 'object' && t !== null && 'x' in t && 'y' in t
}
