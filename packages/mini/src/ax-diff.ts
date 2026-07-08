// Compact snapshot diffs for repeated perception turns. Diffs are keyed by
// stable ax-N refs, so unchanged context disappears and critical new/changed
// interactive nodes stay upfront.

interface RefLine {
  ref: string
  line: string
}

const REF_RE = /\[(ax-\d+)\]/

function displayLine(line: string): string {
  return line
    .trim()
    .replace(/^\[(ax-\d+)\]\s+/, '$1 ')
}

function refLines(text: string): RefLine[] {
  const out: RefLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(REF_RE)
    if (!m) continue
    out.push({ ref: m[1], line })
  }
  return out
}

function tag(label: '[changed]' | '[new]' | '[removed]', line: string): string {
  return `${label.padEnd(9)} ${displayLine(line)}`
}

export function formatDiff(previous: string | undefined, current: string): string {
  if (!previous) return current

  const prev = refLines(previous)
  const next = refLines(current)
  const prevByRef = new Map(prev.map((x) => [x.ref, x.line]))
  const nextByRef = new Map(next.map((x) => [x.ref, x.line]))

  const out: string[] = []
  for (const item of next) {
    const old = prevByRef.get(item.ref)
    if (!old) out.push(tag('[new]', item.line))
    else if (old !== item.line) out.push(tag('[changed]', item.line))
  }

  for (const item of prev) {
    if (!nextByRef.has(item.ref)) out.push(tag('[removed]', item.line))
  }

  return out.length ? out.join('\n') : '[unchanged]'
}
