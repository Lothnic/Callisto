// Phase 1 stub. The real snapshot — a dense, ref-annotated, iframe-aware
// accessibility tree serialized to indented text — is Phase 2 (see roadmap.md
// and rfcs/0001). For now we return page metadata and an empty tree so the
// surface shape is stable and callers can start integrating.
import type { Session } from './client.js'

export interface Snapshot {
  url: string
  title: string
  /** indented a11y tree; empty until Phase 2 fills it */
  text: string
}

export async function snapshot(session: Session): Promise<Snapshot> {
  const { result } = await session.cdp.Runtime.evaluate({
    expression: 'JSON.stringify({ url: location.href, title: document.title })',
    returnByValue: true,
  })
  const meta = JSON.parse(result.value as string) as { url: string; title: string }
  // ponytail: stub — a11y tree fills `text` in Phase 2. Full impl pruned for now.
  return { ...meta, text: '' }
}
