import type { Confidence, Verdict } from '../types'
import { verdictOf } from './verdicts'
import { DECLARATION, among, caseNames, caseStarts, fits, isTemplate, langOf } from './discovery'

// what the grader reads, and what its reply holds: pure text work, no engine calls

export const MAX_SOURCE = 40_000
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
    // a looped case is asked about by its expanded name: the loop that generates it is shown
    isChosen: names.some(name => fits(start.name, name)),
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

// Of a file sent as an excerpt, the tests it leaves out, by name: the grader reads what the
// siblings cover (TestX_ThresholdBoundary) before it calls a case missing
const MAX_OTHERS = 80
export const othersOf = (source: string, names: string[], file: string): string[] => {
  const others = [...new Set(caseNames(source, file))].filter(n => !names.some(name => fits(n, name)))
  if (others.length === 0) return []
  const shown = others.slice(0, MAX_OTHERS).map(n => JSON.stringify(n)).join(', ')
  return [`The tests left out, by name: ${shown}${others.length > MAX_OTHERS ? ` and ${others.length - MAX_OTHERS} more` : ''}. A case one of them covers by its name is not missing.`]
}

// a case's own text, from its start to the next case's (a looped case's: its loop's); null
// when the file no longer has it
export const caseTextOf = (source: string, name: string, file: string): string | null => caseTextsOf(source, file)(name)
// the same for many names of one file, its cases found once
export const caseTextsOf = (source: string, file: string): ((name: string) => string | null) => {
  const starts = caseStarts(source, file)
  return name => {
    const i = starts.findIndex(s => fits(s.name, name))
    return i < 0 ? null : source.slice(starts[i]!.at, starts[i + 1]?.at ?? source.length).trimEnd()
  }
}

// The asked names that are cases a loop generates, each set under the loop's own name in the
// file: the grader is told so, to judge each by that loop's body with its variable bound
export const loopsOf = (source: string, names: string[], file: string): string[] => {
  const templates = [...new Set(caseNames(source, file))].filter(isTemplate)
  const byLoop = new Map<string, string[]>()
  for (const name of names) {
    const loop = isTemplate(name) ? undefined : templates.find(t => fits(t, name))
    if (loop) byLoop.set(loop, [...(byLoop.get(loop) ?? []), name])
  }
  return [...byLoop].map(([loop, cases]) => `${cases.map(c => JSON.stringify(c)).join(', ')} ${cases.length === 1 ? 'is a case' : 'are cases'} of the loop that declares the test ${JSON.stringify(loop)}: judge ${cases.length === 1 ? 'it' : 'each'} by that loop's body, its variable bound to the case's value.`)
}

// the verdicts in a grader reply; of one cut off before its closing ], each object that
// arrived whole (isCut)
const CONFIDENCES: readonly unknown[] = ['high', 'medium', 'low']
export const parseVerdicts = (text: string): { verdicts: Graded[]; isCut: boolean } => {
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
    const verdict = verdictOf(o.verdict)
    if (typeof o.name !== 'string' || !verdict) return []
    const reason = String(o.reason ?? '')
    const missed = typeof o.missed === 'string' ? o.missed.trim() : ''
    const sure = typeof o.confidence === 'string' && CONFIDENCES.includes(o.confidence.trim().toLowerCase()) ? { confidence: o.confidence.trim().toLowerCase() as Confidence } : {}
    // shallow only with a bug the grader can name; told whoever fixes it, as the case to add
    if (verdict === 'shallow' && missed === '') return [{ name: o.name, summary: String(o.summary ?? ''), verdict: 'strong', reason: `${reason} (Graded strong: no bug it would miss was named.)`.trim(), ...sure }]
    return [{ name: o.name, summary: String(o.summary ?? ''), verdict, reason: verdict === 'shallow' ? `${reason} It would miss: ${missed}` : reason, ...sure }]
  })
  return { verdicts, isCut: !isClosed }
}

export type Graded = { name: string; summary: string; verdict: Verdict; reason: string; confidence?: Confidence }

// A test the grader graded case by case (Test › xdr role, Test/xdr role, Test > xdr role) when
// asked for the test: one verdict for it, the worst of its cases', its reason saying which case
// earned it. A verdict under the test's own name stands, its cases' set aside
const CASE_MARK = /^\s*(?:›|>|\/|::|-)\s*/
const WORST: Verdict[] = ['hollow', 'duplicate', 'shallow', 'brittle', 'strong']
export const foldCases = <V extends { name: string; verdict: Verdict; reason: string; summary: string }>(names: string[], verdicts: V[]): V[] => {
  const caseOf = (v: V): { test: string; label: string } | null => {
    if (among(names, v.name)) return null
    // the longest asked name it extends, so Test_A is not taken for Test_AB's case
    const test = names.filter(n => !isTemplate(n) && v.name.startsWith(n) && CASE_MARK.test(v.name.slice(n.length))).sort((a, b) => b.length - a.length)[0]
    return test === undefined ? null : { test, label: v.name.slice(test.length).replace(CASE_MARK, '') }
  }
  const cases = new Map<string, { label: string; v: V }[]>()
  const rest: V[] = []
  for (const v of verdicts) {
    const c = caseOf(v)
    if (c === null) rest.push(v)
    else cases.set(c.test, [...(cases.get(c.test) ?? []), { label: c.label, v }])
  }
  const folded = [...cases.entries()]
    .filter(([test]) => !rest.some(v => v.name === test))
    .map(([test, of]): V => {
      const worst = [...of].sort((a, b) => WORST.indexOf(a.v.verdict) - WORST.indexOf(b.v.verdict))[0]!
      const labels = of.map(c => JSON.stringify(c.label)).join(', ')
      const reason = worst.v.verdict === 'strong' ? `Graded case by case (${labels}), each strong. ${worst.v.reason}` : `Graded case by case (${labels}); the case ${JSON.stringify(worst.label)} is ${worst.v.verdict}: ${worst.v.reason}`
      return { ...worst.v, name: test, reason: reason.trim() }
    })
  return [...rest, ...folded]
}

// a name as a model may echo it back: curly quotes straight, dashes plain, an escape's
// backslash dropped, each run of space one
const loose = (name: string): string =>
  name
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\\(['"`\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

// each verdict under the name it was asked by: a verdict whose name differs from one asked
// name alone only in its quotes, dashes, escapes or spacing answers for that test
// and one named with the groups around it ("ApiClient › appends every file") answers for the
// test asked by the end of that name, where one test alone has it; a name that extends an
// asked one by a case mark is a case of that test, not a group's
const GROUP_MARK = /\s+(?:›|>)\s+/
export const asAsked = <V extends { name: string }>(names: string[], verdicts: V[]): V[] => {
  const asked = [...new Set(names)]
  const alikeTo = (name: string): string[] => asked.filter(n => !isTemplate(n) && loose(n) === loose(name))
  return verdicts.map(v => {
    if (among(names, v.name)) return v
    const alike = alikeTo(v.name)
    if (alike.length === 1) return { ...v, name: alike[0]! }
    if (asked.some(n => !isTemplate(n) && v.name.startsWith(n) && CASE_MARK.test(v.name.slice(n.length)))) return v
    const parts = v.name.split(GROUP_MARK)
    for (let k = 1; k < parts.length; k++) {
      const tail = parts.slice(k).join(' › ')
      const fitting = asked.filter(n => isTemplate(n) && fits(n, tail))
      const matched = [...new Set([...alikeTo(tail), ...(among(asked.filter(n => !isTemplate(n)), tail) ? [tail] : [])])]
      if (matched.length + fitting.length === 1) return { ...v, name: matched[0] ?? tail }
      if (matched.length + fitting.length > 1) return v
    }
    return v
  })
}

// the grader's reply limit, in tokens: a reply cut off there loses the verdicts it had not reached
export const MAX_REPLY = 4000

// Why a test asked about got no verdict from this reply, for its row to say; null when it got
// one. The likely causes in turn: the reply cut off before it, no verdict read at all, its own
// verdict unreadable (an unknown grade, a broken object), a verdict under another name, left out
export const unratedWhy = (text: string, verdicts: Graded[], isCut: boolean, names: string[], name: string, model: string): string | null => {
  if (verdicts.some(v => fits(name, v.name))) return null
  const answered = verdicts.filter(v => among(names, v.name)).length
  const count = `it gave ${answered} of the ${names.length} verdicts asked for`
  if (isCut) return `The grader's (${model}) reply was cut off at its ${MAX_REPLY}-token limit before it reached this test: ${count}.`
  if (verdicts.length === 0) {
    const said = text.replace(/\s+/g, ' ').trim()
    return `The grader (${model}) answered with no verdict it could read: "${said.length > 160 ? `${said.slice(0, 160)}…` : said}".`
  }
  // the test's own object, as it came back: its name as JSON writes it, and the braces around it
  const at = isTemplate(name) ? -1 : text.indexOf(JSON.stringify(name))
  if (at >= 0) {
    const from = text.lastIndexOf('{', at)
    const to = text.indexOf('}', at)
    const own = text.slice(from < 0 ? at : from, to < 0 ? undefined : to + 1).replace(/\s+/g, ' ')
    return `The grader (${model}) answered for this test, but its verdict could not be read: ${own.length > 240 ? `${own.slice(0, 240)}…` : own}`
  }
  const strays = verdicts.filter(v => !among(names, v.name)).map(v => JSON.stringify(v.name))
  if (strays.length > 0) return `The grader (${model}) gave no verdict under this test's name; it answered for ${strays.slice(0, 3).join(', ')}${strays.length > 3 ? ` and ${strays.length - 3} more` : ''}, which no test asked about is named.`
  return `The grader (${model}) left this test out of its answer: ${count}.`
}
