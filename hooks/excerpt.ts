import type { Verdict } from '../types'
import { DECLARATION, caseStarts, langOf } from './discovery'

// what the grader reads, and what its reply holds: pure text work, no engine calls

export const MAX_SOURCE = 12_000
// of a file too long to send whole: at most this much of its head (imports, helpers), and of
// any one case under review
export const MAX_HEAD = 12_000
export const MAX_BODY = 20_000

export const clamp = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// What the grader reads: the whole file when it fits. Else, in file order: its head, the
// cases under review whole, each from its start to the next case's, and of what sits between
// the other cases, each piece that declares a name the shown code uses
export const excerptOf = (source: string, names: string[], file: string): string => {
  if (source.length <= MAX_SOURCE) return source
  const starts = caseStarts(source, file)
  const head = clamp(source.slice(0, starts[0]?.at ?? source.length), MAX_HEAD)
  const pieces = starts.map((start, i) => ({
    isChosen: names.includes(start.name),
    whole: source.slice(start.at, starts[i + 1]?.at ?? source.length).trimEnd(),
    // what sits above the case's own line: comments, data, helpers
    declares: [...source.slice(start.at, start.opens).matchAll(DECLARATION)].map(m => (m[1] ?? m[2])!),
    gap: source.slice(start.at, start.opens).trimEnd(),
  }))
  const extra = new Set<number>()
  let shown = pieces.filter(p => p.isChosen).map(p => p.whole).join('\n')
  // a helper the shown code uses can use another, so until nothing more is named
  for (let isGrowing = true; isGrowing; ) {
    isGrowing = false
    pieces.forEach((p, i) => {
      if (p.isChosen || extra.has(i) || !p.declares.some(name => new RegExp(`\\b${name}\\b`).test(shown))) return
      extra.add(i)
      shown += `\n${p.gap}`
      isGrowing = true
    })
  }
  const note = langOf(file) === 'py' ? '#' : '//'
  const LEFT_OUT = `${note} … other tests left out …`
  const out = [head.trimEnd()]
  pieces.forEach((p, i) => {
    const piece = p.isChosen
      ? p.whole.length > MAX_BODY
        ? `${p.whole.slice(0, MAX_BODY)}\n${note} … the rest of this test is left out: it is too long to send …`
        : p.whole
      : extra.has(i)
        ? p.gap
        : null
    if (piece !== null) out.push(piece)
    else if (out[out.length - 1] !== LEFT_OUT) out.push(LEFT_OUT)
  })
  return out.join('\n\n')
}

// the verdicts in a grader reply; of one cut off before its closing ], each object that
// arrived whole (isCut)
export const parseVerdicts = (text: string): { verdicts: { name: string; summary: string; verdict: Verdict; reason: string }[]; isCut: boolean } => {
  const start = text.indexOf('[')
  if (start < 0) return { verdicts: [], isCut: false }
  const objects: unknown[] = []
  let depth = 0
  let from = -1
  let inString = false
  let isClosed = false
  for (let i = start + 1; i < text.length && !isClosed; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') {
      if (depth === 0) from = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          objects.push(JSON.parse(text.slice(from, i + 1)))
        } catch {
          // a malformed one is skipped; the rest still count
        }
      }
    } else if (c === ']' && depth === 0) isClosed = true
  }
  const verdicts = objects.flatMap((r): Graded[] => {
    const o = r as Record<string, unknown>
    const verdict = o.verdict === 'good' || o.verdict === 'weak' || o.verdict === 'useless' ? o.verdict : undefined
    if (typeof o.name !== 'string' || !verdict) return []
    return [{ name: o.name, summary: String(o.summary ?? ''), verdict, reason: String(o.reason ?? '') }]
  })
  return { verdicts, isCut: !isClosed }
}

export type Graded = { name: string; summary: string; verdict: Verdict; reason: string }
