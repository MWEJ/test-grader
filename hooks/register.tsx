import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Coverage, ExistingRun, ExistingTest, TrackedTest, Verdict } from '../types'

const PANE = 'test-grader'
const tests = atom({ plugin: 'test-grader', key: 'tests' } as const, [])
const coverage = atom({ plugin: 'test-grader', key: 'coverage' } as const, null)
const run = atom({ plugin: 'test-grader', key: 'run' } as const, { state: 'idle' })
const existing = atom({ plugin: 'test-grader', key: 'existing' } as const, { state: 'idle', done: 0, total: 0, results: [] })
const noteError = atom({ plugin: 'test-grader', key: 'noteError' } as const, null)
const opened = atom({ plugin: 'test-grader', key: 'open' } as const, [])
const fileOpen = atom({ plugin: 'test-grader', key: 'fileOpen' } as const, {})
const openError = atom({ plugin: 'test-grader', key: 'openError' } as const, null)
const seen = atom({ plugin: 'test-grader', key: 'seen' } as const, {})
const openFor = atom({ plugin: 'test-grader', key: 'openFor' } as const, null)
const rounds = atom({ plugin: 'test-grader', key: 'rounds' } as const, {})
const outbox = atom({ plugin: 'test-grader', key: 'outbox' } as const, { accepted: [], going: [], spent: [] })
const coverWith = atom({ plugin: 'test-grader', key: 'coverWith' } as const, null)

const GREEN = '#4ade80'
const AMBER = '#fbbf24'
const RED = '#f87171'
const MUTED = '#8b90a0'
const TRACK = '#343848'
const VIOLET = '#a78bfa'
const MAX_TESTS = 60
const MAX_SOURCE = 12_000
// of a file too long to send whole: at most this much of its head (imports, helpers), and of
// any one case under review
const MAX_HEAD = 12_000
const MAX_BODY = 20_000
const CELLS = 12
// Grade all tests: cases per grader call, and how many weak or useless ones are listed
const BATCH = 10
// grader calls in flight at once
const PARALLEL = 4
// a grader reply's room: a verdict runs to about 75 tokens, and a batch's looped tests can
// stand for many cases each
const MAX_REPLY = 4000
// the model that grades, from the graderModel setting; set as the module loads, and a change
// to the setting reloads the module
const GRADER_MODELS = ['haiku', 'sonnet', 'opus'] as const
let graderModel: string = 'haiku'

const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]*\.py$|Tests?\.(swift|kt|java)$|(^|\/)(__tests__|tests?)\/[^/]+\.[cm]?[jt]sx?$/
// a JS case opens its own line, so one quoted inside a fixture string is not one; its
// name runs to the closing quote, past any escaped one
const CASE_PATTERNS = [
  /^[ \t]*(?:it|test)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])+)\1/gm,
  /^\s*(?:async\s+)?def\s+(test_\w+)/gm,
  /\bfunc\s+(Test\w+)\s*\(/g,
  // a Go suite's test: a Test method of the suite type (testify)
  /\bfunc\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(Test\w+)\s*\(/g,
  /\bfunc\s+(test\w+)\s*\(/g,
  /^\s*#\[test\]\s*\n\s*(?:async\s+)?fn\s+(\w+)/gm,
]

// a Go suite's test, its suite the receiver's type; and a Go test that only runs a suite
const GO_SUITE_CASE = /\bfunc\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(Test\w+)\s*\(/g
const GO_SUITE_RUNNER = /\bfunc\s+(Test\w+)\s*\(\s*\w+\s+\*testing\.T\s*\)\s*\{\s*suite\.Run\([^)]*\)\)?\s*\}/g

const verdictColor = (v: Verdict | undefined): string =>
  v === 'good' ? GREEN : v === 'weak' ? AMBER : v === 'useless' ? RED : MUTED

const pctColor = (p: number): string => (p >= 80 ? GREEN : p >= 50 ? AMBER : RED)

const shortPath = (file: string, cwd: string): string => (cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file)

const nameOf = (m: RegExpMatchArray): string => (m[2] ?? (m[1] as string)).replace(/\\(.)/g, '$1')

// the families of syntax a test file's strings and comments follow: JS and TS; Go; Python
// and Ruby; and the C-like rest (Rust, Swift, Kotlin, Java)
type Lang = 'js' | 'go' | 'py' | 'c'
const langOf = (file: string): Lang =>
  /\.[cm]?[jt]sx?$/.test(file) ? 'js' : file.endsWith('.go') ? 'go' : /\.(py|rb)$/.test(file) ? 'py' : 'c'

// Which characters of a source sit inside a string literal or a comment (1) rather than in
// code (0): a test written out as text, a fixture, is not one of the file's tests
const quotedMask = (text: string, lang: Lang): Uint8Array => {
  const n = text.length
  const mask = new Uint8Array(n)
  const fill = (from: number, to: number): number => (mask.fill(1, from, to), to)
  // past a string's opening quote at `from`: where it ends, past its closing quote; one that
  // may not span lines ends at its line's end
  const close = (from: number, quote: string, { escapes = true, lines = false } = {}): number => {
    for (let j = from; j < n; j++) {
      if (escapes && text[j] === '\\') j++
      else if (text.startsWith(quote, j)) return j + quote.length
      else if (text[j] === '\n' && !lines) return j
    }
    return n
  }
  // JS: the ${…} holes open in templates, innermost last, each with the braces opened in it
  const holes: number[] = []
  // a JS template's text from `from` to its close or its next hole
  const template = (from: number, scan: number): number => {
    for (let j = scan; j < n; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === '`') return fill(from, j + 1)
      else if (text[j] === '$' && text[j + 1] === '{') return holes.push(0), fill(from, j + 2)
    }
    return fill(from, n)
  }
  // a JS slash opens a regex where a value is due, not after one
  const isRegexAt = (at: number): boolean => {
    let k = at - 1
    while (k >= 0 && /\s/.test(text[k]!)) k--
    if (k < 0 || '(,=:[!&|?{};+-*%~^'.includes(text[k]!)) return true
    return /\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(text.slice(Math.max(0, k - 9), k + 1))
  }
  const regexEnd = (at: number): number => {
    let isClass = false
    for (let j = at + 1; j < n; j++) {
      const t = text[j]
      if (t === '\\') j++
      else if (t === '\n') return j
      else if (isClass) isClass = t !== ']'
      else if (t === '[') isClass = true
      else if (t === '/') return j + 1
    }
    return n
  }
  const RUST_RAW = /r(#*)"/y
  let i = 0
  while (i < n) {
    const c = text[i]!
    const d = text[i + 1]
    if (lang === 'py' ? c === '#' : c === '/' && d === '/') {
      const end = text.indexOf('\n', i)
      i = fill(i, end < 0 ? n : end)
    } else if (lang !== 'py' && c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2)
      i = fill(i, end < 0 ? n : end + 2)
    } else if (lang === 'js' && c === '`') i = template(i, i + 1)
    else if (lang === 'js' && holes.length > 0 && (c === '{' || c === '}')) {
      const top = holes.length - 1
      if (c === '{') holes[top]! += 1
      else if (holes[top]! > 0) holes[top]! -= 1
      else {
        holes.pop()
        i = template(i, i + 1)
        continue
      }
      i++
    } else if (lang === 'js' && c === '/' && isRegexAt(i)) i = fill(i, regexEnd(i))
    else if (lang === 'go' && c === '`') i = fill(i, close(i + 1, '`', { escapes: false, lines: true }))
    else if (lang !== 'js' && lang !== 'go' && (text.startsWith('"""', i) || (lang === 'py' && text.startsWith("'''", i)))) {
      i = fill(i, close(i + 3, text.slice(i, i + 3), { lines: true }))
    } else if (lang === 'c' && c === 'r' && !/\w/.test(text[i - 1] ?? '') && ((RUST_RAW.lastIndex = i), RUST_RAW.test(text))) {
      i = fill(i, close(RUST_RAW.lastIndex, `"${text.slice(i + 1, RUST_RAW.lastIndex - 1)}`, { escapes: false, lines: true }))
    } else if (c === '"' || (c === "'" && lang !== 'c')) i = fill(i, close(i + 1, c))
    // C-like: a quote opens a char literal ('a', '\n'), not a Rust lifetime ('a)
    else if (c === "'" && d === '\\') i = fill(i, close(i + 1, "'"))
    else if (c === "'" && text[i + 2] === "'") i = fill(i, i + 3)
    else i++
  }
  return mask
}

// where a match's own keyword stands, past the indent a line-anchored pattern takes in
const opensOf = (m: RegExpMatchArray): number => (m.index ?? 0) + m[0].length - m[0].trimStart().length

// every case a test file declares in its code, in file order: where its match starts (at:
// for a JS case, its line's start) and where its keyword stands (opens). A Go function that
// only runs a suite is marked a runner
const casesIn = (text: string, file: string): { name: string; at: number; opens: number; isRunner: boolean }[] => {
  const quoted = quotedMask(text, langOf(file))
  const isCode = (m: RegExpMatchArray): boolean => quoted[opensOf(m)] !== 1
  const runners = new Set([...text.matchAll(GO_SUITE_RUNNER)].filter(isCode).map(m => m[1]!))
  return CASE_PATTERNS.flatMap(pattern =>
    [...text.matchAll(pattern)].filter(isCode).map(m => ({ name: nameOf(m), at: m.index ?? 0, opens: opensOf(m), isRunner: runners.has(nameOf(m)) })),
  ).sort((a, b) => a.at - b.at)
}

const caseNames = (text: string, file: string): string[] => casesIn(text, file).flatMap(c => (c.isRunner ? [] : [c.name]))

// each Go suite test's suite, by its name
const suitesOf = (text: string, file: string): Map<string, string> => {
  const quoted = quotedMask(text, langOf(file))
  return new Map([...text.matchAll(GO_SUITE_CASE)].filter(m => quoted[opensOf(m)] !== 1).map(m => [m[2]!, m[1]!]))
}

const clamp = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// the lines a text fills at this width, broken between words; a word wider than a line, in pieces
const wrapWords = (s: string, n: number): string[] => {
  const lines: string[] = []
  let line = ''
  for (const word of s.split(' ')) {
    for (let rest = word; ; ) {
      const room = line ? n - line.length - 1 : n
      if (rest.length <= room) {
        line = line ? `${line} ${rest}` : rest
        break
      }
      if (line) lines.push(line), (line = '')
      else lines.push(rest.slice(0, n)), (rest = rest.slice(n))
    }
  }
  return [...lines, line]
}

// where each case starts in a file, in file order: right after the previous case closes
// (a line opening with "})"), so what sits between two cases (a comment, the data a
// loop runs over, the loop itself) goes with the case below it; failing a close, on
// the line after the previous case's first
const caseStarts = (text: string, file: string): { name: string; at: number; opens: number }[] => {
  const found = casesIn(text, file)
  return found.map((start, i) => {
    const prev = found[i - 1]
    const at = (): number => {
      if (!prev) return start.at
      const between = text.slice(prev.at, start.at)
      // the previous case's own close, at its indent: a helper declared after it keeps its head
      const indent = text.slice(text.lastIndexOf('\n', prev.opens - 1) + 1, prev.opens)
      const own = /^[ \t]*$/.test(indent) ? between.match(new RegExp(`\\n${indent}\\}\\)[^\\n]*\\n`)) : null
      const closes = [...between.matchAll(/\n[ \t]*\}\)[^\n]*\n/g)]
      const last = own ?? closes[closes.length - 1]
      const after = last ? last.index! + last[0].length : between.indexOf('\n') + 1
      return after > 0 ? prev.at + after : start.at
    }
    return { name: start.name, at: at(), opens: start.opens }
  })
}

// a top-level declaration a test can use: a constant, a helper, a type, a fixture
const DECLARATION = /^(?:export\s+)?(?:declare\s+)?(?:(?:const|let|var|function\*?|async\s+function\*?|class|type|interface|enum|func|def|fn|struct)\s+(\w+)|(\w+)\s*=(?!=))/gm

// A name with ${…} in it is a template: the cases a loop generates. The grader names each
// case as the loop expands it, and a returned name belongs to the template it fits
const isTemplate = (name: string): boolean => /\$\{[^}]*\}/.test(name)
const fits = (template: string, name: string): boolean => {
  if (!isTemplate(template)) return template === name
  const parts = template.split(/\$\{[^}]*\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${parts.join('[\\s\\S]+?')}$`).test(name)
}

// What the grader reads: the whole file when it fits. Else, in file order: its head, the
// cases under review whole, each from its start to the next case's, and of what sits between
// the other cases, each piece that declares a name the shown code uses
const excerptOf = (source: string, names: string[], file: string): string => {
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
const parseVerdicts = (text: string): { verdicts: { name: string; summary: string; verdict: Verdict; reason: string }[]; isCut: boolean } => {
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
  const verdicts = objects.flatMap(r => {
    const o = r as Record<string, unknown>
    const verdict = o.verdict === 'good' || o.verdict === 'weak' || o.verdict === 'useless' ? o.verdict : undefined
    if (typeof o.name !== 'string' || !verdict) return []
    return [{ name: o.name, summary: String(o.summary ?? ''), verdict, reason: String(o.reason ?? '') }]
  })
  return { verdicts, isCut: !isClosed }
}

// A note for Claude: a user-role row it reads on its next turn, no turn started. A refusal
// or a failure is kept for the pane to show, until a note goes through. The debug log has
// every note, appended or not (a test cannot see a row a mod appends)
// A note to Claude. Bare, it is added to the conversation, read in the turn under way: a new
// test's grade, written by that turn. With a nudge, the result of a run the person started
// from the pane, it is sent as a prompt ending in the nudge: Claude answers it once idle
const share = async ($: EngineInterface, text: string, nudge?: string): Promise<void> => {
  let error: string | null = null
  const way = nudge === undefined ? 'appended' : 'sent as a prompt'
  try {
    if (nudge === undefined) {
      const row = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (row.deny !== undefined) error = row.deny
    } else {
      const sent = await $.prompt.submit({ text: `${text}\n${nudge}` })
      if ('drop' in sent && sent.drop !== undefined) error = String(sent.drop)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  $.ui.log(`test-grader: note to Claude (${error === null ? way : `not ${way}: ${error}`}): ${text}`, { to: 'debug' })
  await update($, noteError, () => error)
}

// what a run's result asks of Claude
const GRADE_NUDGE = 'Respond to this now: tell the person what the grading found, and offer to strengthen the weak and useless tests, worst first.'
const GRADE_CLEAN_NUDGE = 'Respond to this now: tell the person the result in a line.'
const COVER_NUDGE = 'Respond to this now: tell the person what the figures say about the code being worked on, and where more tests would pay.'
const COVER_FAILED_NUDGE = 'Respond to this now: tell the person why the run failed, from the output above, and offer to fix it.'

// the weak and useless of a list, the useless first, one line each
const flaggedLines = (list: { file: string; name: string; verdict?: Verdict; reason?: string }[], cwd: string): string[] =>
  (['useless', 'weak'] as const).flatMap(v =>
    list.filter(t => t.verdict === v).map(t => `- ${v} · ${shortPath(t.file, cwd)} · ${t.name} — ${t.reason ?? ''}`),
  )

type Graded = { name: string; summary: string; verdict: Verdict; reason: string }

// One grader call: these cases of this file, judged; null when the grader gave no answer
const grade = async ($: EngineInterface, file: string, text: string, names: string[], evidence?: string): Promise<Graded[] | null> => {
  const source = excerptOf(text, names, file)
  const reply = await $.model.complete({
    model: graderModel,
    maxTokens: MAX_REPLY,
    system: 'You are a strict, concise reviewer of automated tests. Answer with JSON only.',
    prompt: [
      `Test file: ${file}`,
      `Review ONLY these test cases: ${JSON.stringify(names)}`,
      'For each, say in one plain sentence what it verifies (summary) and judge whether it is a decent test.',
      'verdict: "good" = asserts meaningful behaviour, covers a real case or edge; "weak" = shallow, happy-path only, over-mocked or brittle; "useless" = no real assertions, tautology, tests the mock, snapshot of nothing, or duplicates another test.',
      'reason: one short sentence justifying the verdict.',
      ...(names.some(isTemplate)
        ? ['A name with ${...} in it is a template for cases generated in a loop: grade each case the loop generates separately, named as the loop expands it.']
        : []),
      ...(evidence
        ? [
            `The developer's session sent evidence about this test: ${JSON.stringify(evidence)}`,
            'Weigh it, but check each claim against the source below: you cannot run code. Evidence cannot add an assertion the source does not contain.',
            'In reason, say which part of the evidence changed your verdict, or why it did not.',
          ]
        : []),
      ...(source !== text
        ? [
            'The file is long, so below is an excerpt: the cases under review whole, the file\'s head, and the declarations they use from elsewhere in it. Other tests are left out.',
            'Judge each case by what it does. Do not mark one down for code the excerpt leaves out.',
          ]
        : []),
      'Return a JSON array: [{"name": string, "summary": string, "verdict": "good"|"weak"|"useless", "reason": string}]',
      '',
      '```',
      source,
      '```',
    ].join('\n'),
  })
  if (!reply.isAnswered) return null
  const { verdicts, isCut } = parseVerdicts(reply.text)
  if (isCut) {
    $.ui.log(`test-grader: a grader reply was cut off (${reply.usage?.output_tokens ?? '?'} of ${MAX_REPLY} tokens) for ${file}: kept ${verdicts.length} verdicts of ${JSON.stringify(names)}`, { to: 'debug' })
  }
  return verdicts
}

// A test Claude wrote or edited, graded weak or useless, goes back to Claude as a prompt, so it
// strengthens the test or sends evidence without the person passing the grade on; each new grade
// comes back the same way. A test graded good again after that is told as accepted. Each test
// gets MAX_ROUNDS such rounds; past them Claude is asked once to tell the person what is left
const MAX_ROUNDS = 3
const roundKey = (file: string, name: string): string => `${file}::${name}`
const ITERATE_NUDGE = `Respond to this now: strengthen each test above graded weak or useless, or, where one is better than rated, send your evidence with the test_evidence tool. Each new grade comes back to you, until the test is graded good or it has had ${MAX_ROUNDS} rounds.`
const SPENT_NUDGE = 'Respond to this now: tell the person which tests are still weak or useless and why; test-grader has stopped asking about them.'

// the round a test is on now: one more for a weak or useless grade, none once it is good
const countRound = async ($: EngineInterface, file: string, name: string, verdict: Verdict | undefined): Promise<{ round: number; wasRetried: boolean }> => {
  const key = roundKey(file, name)
  const before = (await read($, rounds))[key] ?? 0
  const round = verdict === 'weak' || verdict === 'useless' ? before + 1 : 0
  if (round !== before) await update($, rounds, all => (({ [key]: _, ...rest }) => (round > 0 ? { ...rest, [key]: round } : rest))(all))
  return { round, wasRetried: before > 0 }
}

// Grades wait in the outbox while grading is under way or a turn of Claude's runs, then go
// as one prompt: several weak tests, or several files graded, are one round, not one prompt each.
// A test graded again before then is listed once, at its latest grade
type Report = { file: string; name: string; verdict?: Verdict; reason?: string }
const reportGrades = async ($: EngineInterface, graded: Report[]): Promise<void> => {
  for (const t of graded) {
    // a test waiting in the outbox is in a round already counted (one edit graded on both
    // lists): its entry takes this grade's words and keeps its place
    const isSame = (o: Report): boolean => roundKey(o.file, o.name) === roundKey(t.file, t.name)
    const box = await read($, outbox)
    if ([...box.accepted, ...box.going, ...box.spent].some(isSame)) {
      const take = (list: Report[]) => list.map(o => (isSame(o) ? { ...o, reason: t.reason ?? o.reason } : o))
      await update($, outbox, b => ({ accepted: take(b.accepted), going: take(b.going), spent: take(b.spent) }))
      continue
    }
    const { round, wasRetried } = await countRound($, t.file, t.name, t.verdict)
    const kind = round === 0 && wasRetried ? 'accepted' : round > 0 && round <= MAX_ROUNDS ? 'going' : round === MAX_ROUNDS + 1 ? 'spent' : null
    await update($, outbox, box => {
      const key = roundKey(t.file, t.name)
      const others = (list: Report[]) => list.filter(o => roundKey(o.file, o.name) !== key)
      const next = { accepted: others(box.accepted), going: others(box.going), spent: others(box.spent) }
      return kind === null ? next : { ...next, [kind]: [...next[kind], t] }
    })
  }
  await flush($)
}

// a turn of Claude's under way: its grades wait for its end
let isTurnRunning = false

const flush = async ($: EngineInterface): Promise<void> => {
  if (working > 0 || isTurnRunning) return
  const box = await read($, outbox)
  const { accepted, going, spent } = box
  if (accepted.length + going.length + spent.length === 0) return
  await update($, outbox, () => ({ accepted: [], going: [], spent: [] }))
  const cwd = await $.session.cwd()
  const lines = [
    ...(accepted.length > 0 ? ['Now graded good (test-grader):', ...accepted.map(t => `- good · ${shortPath(t.file, cwd)} · ${t.name}`)] : []),
    ...(going.length > 0 ? ['Tests graded weak or useless (test-grader):', ...flaggedLines(going, cwd), EVIDENCE_HINT] : []),
    ...(spent.length > 0 ? [`Still weak or useless after ${MAX_ROUNDS} rounds (test-grader stops asking about these):`, ...flaggedLines(spent, cwd)] : []),
  ]
  // accepted alone needs nothing of Claude: added to the conversation, no turn started
  await share($, lines.join('\n'), going.length > 0 ? ITERATE_NUDGE : spent.length > 0 ? SPENT_NUDGE : undefined)
}

// Grading under way in this load of the module: a Grade all run, a regrade, a new test's
// grading. The host keeps their marks (a run running, rows reviewing, tests pending) across a
// reload of this mod, which drops the work itself; at a session's start with none under way
// here, resume takes the marks left behind for work to do again
let working = 0
// the last grading under way done: the grades it left go to Claude
const finishWork = async ($: EngineInterface): Promise<void> => {
  working -= 1
  if (working === 0) await flush($).catch(() => undefined)
}
const busy = async <T,>($: EngineInterface, work: () => Promise<T>): Promise<T> => {
  working += 1
  try {
    return await work()
  } finally {
    await finishWork($)
  }
}

// work started on the next tick, counted as under way from now
const soon = ($: EngineInterface, work: () => Promise<void>): void => {
  working += 1
  void $.clock.after(1, () => void work().catch(() => undefined).finally(() => finishWork($)))
}

const evaluate = ($: EngineInterface, file: string, ids: Map<string, string>): Promise<void> => busy($, () => evaluateNow($, file, ids))
const evaluateNow = async ($: EngineInterface, file: string, ids: Map<string, string>): Promise<void> => {
  const fail = (): Promise<void> =>
    update($, tests, list => list.map(t => (ids.has(t.id) && t.status === 'pending' ? { ...t, status: 'failed' } : t)))
  try {
    const verdicts = await grade($, file, await $.fs.read(file), [...ids.values()])
    if (verdicts === null) return fail()
    await update($, tests, list =>
      // a looped test becomes one entry per case it generates
      list.flatMap((t): TrackedTest[] => {
        if (!ids.has(t.id)) return [t]
        const found = verdicts.filter(v => fits(t.name, v.name))
        if (found.length === 0) return [{ ...t, status: 'failed' }]
        return found.map((v, k) => ({
          ...t,
          id: k === 0 ? t.id : `${t.id}-${k}`,
          name: v.name,
          status: 'done',
          summary: v.summary,
          verdict: v.verdict,
          reason: v.reason,
        }))
      }),
    )
    const mine = (await read($, tests)).filter(t => [...ids.keys()].some(id => t.id === id || t.id.startsWith(`${id}-`)))
    await reportGrades($, mine)
  } catch {
    await fail()
  }
}

const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null)

const attr = (xml: string, name: string): number | null => {
  const m = xml.match(new RegExp(`${name}="([0-9.]+)"`))
  return m ? pct(Number(m[1]) * 100) : null
}

const mtime = async ($: EngineInterface, path: string): Promise<number | null> => {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return null
  }
}

const readCoverage = async ($: EngineInterface): Promise<Coverage | null> => {
  const cwd = await $.session.cwd()
  const summaryPath = `${cwd}/coverage/coverage-summary.json`
  const lcovPath = `${cwd}/coverage/lcov.info`
  const xmlPath = `${cwd}/coverage.xml`
  const goPath = `${cwd}/.test-grader-go-coverage.txt`

  const at = await mtime($, summaryPath)
  if (at !== null) {
    try {
      const total = (JSON.parse(await $.fs.read(summaryPath)) as { total: Record<string, { pct: unknown }> }).total
      return {
        lines: pct(total.lines?.pct),
        statements: pct(total.statements?.pct),
        branches: pct(total.branches?.pct),
        functions: pct(total.functions?.pct),
        source: 'coverage-summary.json',
        updatedAt: at,
      }
    } catch {
      /* fall through to the next format */
    }
  }
  const lcovAt = await mtime($, lcovPath)
  if (lcovAt !== null) {
    const text = await $.fs.read(lcovPath)
    const sum = (key: string): number => [...text.matchAll(new RegExp(`^${key}:(\\d+)`, 'gm'))].reduce((s, m) => s + Number(m[1]), 0)
    const ratio = (hit: string, found: string): number | null => (sum(found) > 0 ? pct((sum(hit) / sum(found)) * 100) : null)
    return {
      lines: ratio('LH', 'LF'),
      statements: null,
      branches: ratio('BRH', 'BRF'),
      functions: ratio('FNH', 'FNF'),
      source: 'lcov.info',
      updatedAt: lcovAt,
    }
  }
  const xmlAt = await mtime($, xmlPath)
  if (xmlAt !== null) {
    const head = (await $.fs.read(xmlPath)).slice(0, 2000)
    return { lines: attr(head, 'line-rate'), statements: null, branches: attr(head, 'branch-rate'), functions: null, source: 'coverage.xml', updatedAt: xmlAt }
  }
  const goAt = await mtime($, goPath)
  if (goAt !== null) {
    const text = await $.fs.read(goPath)
    const values = [...text.matchAll(/coverage:\s+([0-9.]+)% of statements/g)].map(m => Number(m[1]))
    if (values.length > 0) {
      const mean = values.reduce((s, v) => s + v, 0) / values.length
      return { lines: null, statements: pct(mean), branches: null, functions: null, source: 'go test -cover', updatedAt: goAt }
    }
  }
  return null
}

const refreshCoverage = async ($: EngineInterface): Promise<void> => {
  try {
    const next = await readCoverage($)
    await update($, coverage, () => next)
  } catch {
    /* no coverage yet is a normal state */
  }
}

// the project's coverage run: its command, and how a note to Claude names it
type CoverCommand = { argv: string[]; label: string; goOutput?: string }
const detectCommand = async ($: EngineInterface, cwd: string): Promise<CoverCommand | undefined> => {
  const exists = async (name: string): Promise<boolean> => (await mtime($, `${cwd}/${name}`)) !== null
  if (await exists('package.json')) {
    const pkg = await $.fs.read(`${cwd}/package.json`)
    if (/"vitest"/.test(pkg)) return { argv: ['npx', 'vitest', 'run', '--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=lcov'], label: 'npx vitest run --coverage' }
    if (/"jest"/.test(pkg)) return { argv: ['npx', 'jest', '--coverage', '--coverageReporters=json-summary', '--coverageReporters=lcov'], label: 'npx jest --coverage' }
  }
  if ((await exists('pytest.ini')) || (await exists('pyproject.toml')) || (await exists('setup.cfg'))) {
    return { argv: ['python3', '-m', 'pytest', '--cov', '--cov-report=xml'], label: 'pytest --cov' }
  }
  if (await exists('go.mod')) return { argv: ['go', 'test', './...', '-cover'], label: 'go test ./... -cover', goOutput: '.test-grader-go-coverage.txt' }
  return undefined
}

// what a finished coverage run tells Claude: the figures it left, or how it failed and
// the end of what it printed
const COVER_TAIL = 20
const coverageNote = (command: CoverCommand, exitCode: number, output: string, cov: Coverage | null): string => {
  const figures = cov
    ? ([['lines', cov.lines], ['statements', cov.statements], ['branches', cov.branches], ['functions', cov.functions]] as const)
        .filter(([, v]) => v !== null)
        .map(([name, v]) => `${name} ${v}%`)
        .join(' · ')
    : ''
  if (exitCode === 0) {
    return figures
      ? `Coverage run (test-grader) finished: ${figures} (${cov!.source}).`
      : `Coverage run (test-grader) finished, but ${command.label} wrote no report test-grader reads.`
  }
  const lines = output.split('\n').filter(l => l.trim() !== '').slice(-COVER_TAIL)
  return [`Coverage run (test-grader) failed: ${command.label} exited with ${exitCode}. The last ${lines.length} lines it printed:`, ...lines].join('\n')
}

const runCoverage = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
  const setRun = (state: 'idle' | 'running' | 'failed', message?: string) => update($, run, () => ({ state, message }))
  try {
    const command = await detectCommand($, cwd)
    if (!command) return void (await setRun('failed', 'No jest, vitest, pytest or Go project found here.'))
    await setRun('running')
    const result = await $.process.run(command.argv, { cwd, timeoutMs: 600_000 })
    if (command.goOutput) await $.fs.write(`${cwd}/${command.goOutput}`, result.stdout)
    await refreshCoverage($)
    await setRun(result.exitCode === 0 ? 'idle' : 'failed', result.exitCode === 0 ? undefined : `Tests exited with ${result.exitCode}.`)
    await share(
      $,
      coverageNote(command, result.exitCode, [result.stdout, result.stderr].join('\n'), await read($, coverage)),
      result.exitCode === 0 ? COVER_NUDGE : COVER_FAILED_NUDGE,
    )
  } catch (err) {
    await setRun('failed', err instanceof Error ? err.message : String(err))
  }
}

// what a finished Grade all tests run tells Claude: the counts, then every weak,
// useless and unrated test (the good are counted, not listed)
const existingNote = (results: ExistingTest[], cwd: string): string => {
  const count = (v: Verdict): number => results.filter(t => t.verdict === v).length
  const unrated = results.filter(t => !t.verdict)
  const counts = [`${results.length} graded`, `${count('good')} good`, `${count('weak')} weak`, `${count('useless')} useless`]
  if (unrated.length > 0) counts.push(`${unrated.length} unrated`)
  const lines = [`Test grading (test-grader) finished: ${counts.join(' · ')}.`]
  const flagged = flaggedLines(results, cwd)
  if (flagged.length > 0) lines.push('Weak or useless, worst first:', ...flagged, EVIDENCE_HINT)
  if (unrated.length > 0) lines.push('Unrated (the grader gave no verdict):', ...unrated.map(t => `- ${shortPath(t.file, cwd)} · ${t.name}`))
  return lines.join('\n')
}

// Grade all tests: every case of every test file git tracks, BATCH cases a call and
// PARALLEL calls at once; the results keep file order. A batch the grader fails leaves
// its cases unrated, and the run goes on
// a file's contents, fingerprinted (FNV-1a), with its length
export const fingerprint = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return `${(hash >>> 0).toString(16)}-${text.length}`
}

// The project's grades outlive the session: kept in the store under the project's folder,
// with each graded file's fingerprint, so a later session lists them and Grade all tests
// grades again only the files changed since. Listed-but-ungraded rows are not kept
type SavedGrades = { results: ExistingTest[]; hashes: Record<string, string>; finishedAt?: number }
const gradesKey = (cwd: string): string => `grades:${cwd}`

const saveGrades = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
  if (!cwd) return
  const run = await read($, existing)
  const saved: SavedGrades = {
    results: run.results.filter(t => !t.isUngraded).map(({ isPending: _, ...t }) => t),
    hashes: run.hashes ?? {},
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  }
  await $.store.set(gradesKey(cwd), saved).catch(error => $.ui.log(`test-grader: the grades could not be saved: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
}

// at a session's start, one that has graded nothing yet takes the project's saved grades
const loadGrades = async ($: EngineInterface): Promise<void> => {
  const run = await read($, existing)
  if (run.hashes || run.results.some(t => !t.isUngraded)) return
  const cwd = await $.session.cwd()
  if (!cwd) return
  const saved = (await $.store.get(gradesKey(cwd)).catch(() => undefined)) as SavedGrades | undefined
  if (!saved || !Array.isArray(saved.results)) return
  await update($, existing, r => ({ ...r, results: saved.results, hashes: saved.hashes ?? {}, ...(saved.finishedAt === undefined ? {} : { finishedAt: saved.finishedAt }) }))
}

// isFresh: grade every file again, the remembered ones too
const gradeAll = ($: EngineInterface, isFresh = false): Promise<void> => busy($, () => gradeAllNow($, isFresh))
const gradeAllNow = async ($: EngineInterface, isFresh: boolean): Promise<void> => {
  const before = await read($, existing)
  if (before.state === 'running') return
  const cwd = await $.session.cwd()
  const fail = (message: string) => update($, existing, () => ({ state: 'failed', done: 0, total: 0, message, results: before.results, hashes: before.hashes }))
  try {
    const listed = await $.process.run(['git', 'ls-files'], { cwd, timeoutMs: 60_000 })
    if (listed.exitCode !== 0) return void (await fail('Not a git repository: there is no list of test files to grade.'))
    const files = listed.stdout.split('\n').filter(f => f !== '' && TEST_FILE.test(f))
    await update($, existing, r => ({ ...r, state: 'running', done: 0, total: files.length, isFresh }))
    const hashes: Record<string, string> = {}
    // tests whose results stand from before
    let remembered = 0
    // every file's batches, in file order; a file is done when its last batch is. Until the
    // grader answers a batch, its tests are listed as they were, marked reviewing
    type Slot = { items: ExistingTest[]; waiting: ExistingTest[]; isDone: boolean }
    const jobs: { file: string; text: string; batch: string[]; slot: Slot }[] = []
    const perFile: { left: number; slots: Slot[] }[] = []
    const shown = (): ExistingTest[] => perFile.flatMap(f => f.slots.flatMap(s => (s.isDone ? s.items : s.waiting)))
    let done = 0
    for (const rel of files) {
      const file = `${cwd}/${rel}`
      const text = await $.fs.read(file)
      hashes[file] = fingerprint(text)
      const names = [...new Set(caseNames(text, file))]
      const entry = { left: 0, slots: [] as Slot[] }
      // unchanged since its last grading, and every test rated: its results stand
      const kept = before.results.filter(t => t.file === file)
      if (!isFresh && before.hashes?.[file] === hashes[file] && kept.length > 0 && kept.every(t => t.verdict !== undefined)) {
        entry.slots.push({ items: kept, waiting: kept, isDone: true })
        perFile.push(entry)
        remembered += kept.length
        done += 1
        continue
      }
      for (let at = 0; at < names.length; at += BATCH) {
        const batch = names.slice(at, at + BATCH)
        const waiting = batch.flatMap(name => {
          const had = kept.filter(t => fits(name, t.name))
          return (had.length > 0 ? had : [{ file, name }]).map(({ isUngraded: _, ...t }) => ({ ...t, isPending: true }))
        })
        const slot: Slot = { items: [], waiting, isDone: false }
        entry.slots.push(slot)
        entry.left += 1
        jobs.push({ file, text, batch, slot })
      }
      perFile.push(entry)
      if (entry.left === 0) done += 1
    }
    await update($, existing, s => ({ ...s, done, results: shown() }))
    const owner = new Map(perFile.flatMap(f => f.slots.map(slot => [slot, f] as const)))
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        const { file, text, batch, slot } = jobs[next++]!
        const verdicts = (await grade($, file, text, batch).catch(() => null)) ?? []
        const suites = suitesOf(text, file)
        for (const name of batch) {
          const suite = suites.has(name) ? { suite: suites.get(name) } : {}
          const found = verdicts.filter(v => fits(name, v.name))
          if (found.length === 0) slot.items.push({ file, name, ...suite })
          for (const v of found) slot.items.push({ file, name: v.name, verdict: v.verdict, summary: v.summary, reason: v.reason, ...suite })
        }
        slot.isDone = true
        const entry = owner.get(slot)!
        entry.left -= 1
        if (entry.left === 0) done += 1
        await update($, existing, s => ({ ...s, done, results: shown() }))
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker))
    const results = shown()
    const finishedAt = await $.clock.now()
    const graded = results.length - remembered
    await update($, existing, () => ({ state: 'idle', done: files.length, total: files.length, results, finishedAt, hashes, graded, remembered }))
    await saveGrades($)
    await update($, seen, all => ({ ...all, ...hashes }))
    await share($, existingNote(results, cwd), results.some(t => t.verdict !== 'good') ? GRADE_NUDGE : GRADE_CLEAN_NUDGE)
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err))
  }
}

const track = async ($: EngineInterface, file: string, names: string[]): Promise<void> => {
  const now = await $.clock.now()
  const suites = await $.fs.read(file).then(text => suitesOf(text, file), () => new Map<string, string>())
  const ids = new Map<string, string>()
  const entries: TrackedTest[] = names.map((name, i) => {
    const id = `${now}-${i}-${file}`
    ids.set(id, name)
    return { id, file, name, at: now, status: 'pending', ...(suites.has(name) ? { suite: suites.get(name) } : {}) }
  })
  await update($, tests, list => [...list, ...entries].slice(-MAX_TESTS))
  soon($, () => evaluate($, file, ids))
}

// whether a name the lists hold is still among a file's cases: itself, or a case of a loop
const among = (names: string[], name: string): boolean => names.some(n => fits(n, name))

// After the session writes a test file: entries for cases no longer in it leave both lists,
// and the weak, useless and unrated ones the change touched are graded again
const refresh = async ($: EngineInterface, file: string, touched: string[]): Promise<void> => {
  let text: string
  try {
    text = await $.fs.read(file)
  } catch {
    return
  }
  const present = caseNames(text, file)
  const isRedo = (t: { file: string; name: string; verdict?: Verdict }): boolean =>
    t.file === file && t.verdict !== 'good' && among(touched, t.name)

  const now = await read($, tests)
  const redoNew = new Map(now.filter(t => isRedo(t) && t.status !== 'pending' && among(present, t.name)).map(t => [t.id, t.name]))
  await update($, tests, list =>
    list
      .filter(t => t.file !== file || t.status === 'pending' || among(present, t.name))
      .map(t => (redoNew.has(t.id) ? { ...t, status: 'pending' as const, verdict: undefined, summary: undefined, reason: undefined } : t)),
  )
  if (redoNew.size > 0) soon($, () => evaluate($, file, redoNew))

  const run = await read($, existing)
  const kept = run.results.filter(t => t.file !== file || among(present, t.name))
  const redo = kept.filter(t => isRedo(t) && !t.isPending).map(t => t.name)
  if (kept.length === run.results.length && redo.length === 0) return
  const pick = (t: ExistingTest): boolean => t.file === file && redo.includes(t.name)
  await update($, existing, r => ({
    ...r,
    results: r.results.filter(t => t.file !== file || among(present, t.name)).map(t => (pick(t) ? { ...t, isPending: true } : t)),
  }))
  if (redo.length === 0) return
  soon($, () => regradeRows($, file, text, redo))
}

// these rows of a file, as Grade all lists them, graded again, their reviewing marks cleared
const regradeRows = ($: EngineInterface, file: string, text: string, names: string[]): Promise<void> =>
  busy($, async () => {
    const pick = (t: ExistingTest): boolean => t.file === file && names.includes(t.name)
    const verdicts = await grade($, file, text, names).catch(() => null)
    await reportGrades($, names.flatMap(name => {
      const v = verdicts?.find(x => x.name === name)
      return v ? [{ file, name, verdict: v.verdict, reason: v.reason }] : []
    }))
    await update($, existing, r => ({
      ...r,
      results: r.results.map(t => {
        if (!pick(t)) return t
        const v = verdicts?.find(x => x.name === t.name)
        return { file: t.file, name: t.name, ...(t.suite ? { suite: t.suite } : {}), ...(v ? { verdict: v.verdict, summary: v.summary, reason: v.reason } : {}) }
      }),
    }))
    await saveGrades($)
  })

// At a session's start, the grading a reload of this mod cut off, started again: a Grade all
// run (Regrade all again if it was one), rows a regrade left reviewing, new tests left
// pending. A start with grading under way here (a compaction) leaves it to finish
const resume = async ($: EngineInterface): Promise<void> => {
  if (working > 0) return
  const run = await read($, existing)
  if (run.state === 'running') {
    await update($, existing, ({ isFresh: _, ...r }): ExistingRun => ({ ...r, state: 'idle', results: r.results.map(({ isPending: _p, ...t }) => t) }))
    soon($, () => gradeAll($, run.isFresh === true))
  } else {
    const byFile = new Map<string, string[]>()
    for (const t of run.results) if (t.isPending) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t.name])
    for (const [file, names] of byFile) {
      const text = await $.fs.read(file).catch(() => null)
      if (text !== null) soon($, () => regradeRows($, file, text, names))
      // the file is gone: its rows leave with it at the next listing; unmarked till then
      else await update($, existing, r => ({ ...r, results: r.results.map(t => (t.file === file ? (({ isPending: _, ...rest }) => rest)(t) : t)) }))
    }
  }
  const pending = new Map<string, Map<string, string>>()
  for (const t of await read($, tests)) {
    if (t.status === 'pending') pending.set(t.file, (pending.get(t.file) ?? new Map<string, string>()).set(t.id, t.name))
  }
  for (const [file, ids] of pending) soon($, () => evaluate($, file, ids))
}

// At a turn's end: a listed test file changed since last seen, by the shell, an editor or a
// checkout rather than Claude's Write or Edit, is taken as if Claude had written it whole: its
// gone tests leave, its weak, useless and unrated ones are graded again, and new ones are added.
// Last seen: as Write, Edit or Grade all left it, else as its last grading fingerprinted it
const catchUp = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
  const run = await read($, existing)
  const files = [...new Set([...(await read($, tests)).map(t => t.file), ...run.results.map(t => t.file)])].filter(f => cwd !== '' && f.startsWith(`${cwd}/`))
  const last = await read($, seen)
  for (const file of files) {
    const text = await $.fs.read(file).catch(() => null)
    if (text === null) continue
    const now = fingerprint(text)
    const before = last[file] ?? run.hashes?.[file]
    if (before === now) continue
    await update($, seen, all => ({ ...all, [file]: now }))
    if (before === undefined) continue
    const names = caseNames(text, file)
    await refresh($, file, names)
    const known = [...(await read($, tests)).filter(t => t.file === file), ...(await read($, existing)).results.filter(t => t.file === file)].map(t => t.name)
    const fresh = [...new Set(names)].filter(n => !among(known, n) && !known.some(k => fits(n, k)))
    if (fresh.length > 0) await track($, file, fresh)
  }
}

// At a session's start: an entry whose test is no longer among its file's cases, or whose
// file is gone, was changed while no session watched it, and leaves both lists
const prune = async ($: EngineInterface): Promise<void> => {
  const files = [...new Set([...(await read($, tests)).map(t => t.file), ...(await read($, existing)).results.map(t => t.file)])]
  const present = new Map<string, string[]>()
  for (const file of files) present.set(file, await $.fs.read(file).then(text => caseNames(text, file), () => []))
  const isThere = (t: { file: string; name: string }): boolean => among(present.get(t.file) ?? [], t.name)
  await update($, tests, list => list.filter(t => t.status === 'pending' || isThere(t)))
  await update($, existing, r => ({ ...r, results: r.results.filter(isThere) }))
  await saveGrades($)
}

// The project's tests as the pane first shows them: every case of every test file git
// tracks, with its result from before when it has one, ungraded otherwise. No grader call
const listAll = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
  const listed = await $.process.run(['git', 'ls-files'], { cwd, timeoutMs: 60_000 })
  if (listed.exitCode !== 0) return
  const files = listed.stdout.split('\n').filter(f => f !== '' && TEST_FILE.test(f)).map(rel => `${cwd}/${rel}`)
  const run = await read($, existing)
  const cases: ExistingTest[] = []
  const hashes: Record<string, string> = {}
  for (const file of files) {
    const text = await $.fs.read(file).catch(() => null)
    if (text === null) continue
    hashes[file] = fingerprint(text)
    const suites = suitesOf(text, file)
    for (const name of new Set(caseNames(text, file))) {
      const had = run.results.filter(t => t.file === file && fits(name, t.name))
      cases.push(...(had.length > 0 ? had : [{ file, name, isUngraded: true, ...(suites.has(name) ? { suite: suites.get(name) } : {}) }]))
    }
  }
  const isListed = new Set(Object.keys(hashes))
  await update($, existing, r => (r.state === 'running' ? r : { ...r, results: [...cases, ...r.results.filter(t => !isListed.has(t.file))] }))
  // a file never seen nor graded is seen as it is now; a graded one keeps its last grading's
  // fingerprint, so a change made between sessions is still caught at a turn's end
  await update($, seen, all => ({ ...Object.fromEntries(Object.entries(hashes).filter(([f]) => !run.hashes?.[f])), ...all }))
}

// the line a case opens on: its own it( or test(, a looped case's the loop's; else the top
const caseLine = (text: string, name: string, file: string): number => {
  const found = casesIn(text, file).find(c => fits(c.name, name))
  return found ? text.slice(0, found.opens).split('\n').length : 1
}

// an editor as the system names it: its program, and on macOS the app it is inside
type Editor = { exe: string; app?: string; id?: string }

// macOS: the app a double-click opens the file in, as JSON, or nothing
const MAC_DEFAULT = `ObjC.import('AppKit')
function run(argv) {
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(argv[0]))
  if (url.isNil()) return ''
  const bundle = $.NSBundle.bundleWithURL(url)
  return JSON.stringify({ app: url.path.js, id: bundle.bundleIdentifier.js, exe: bundle.executablePath.js })
}`

// editors that go to a line, by program name: VS Code and its forks, Zed, Sublime Text, JetBrains
const VSCODES = /^(code|code-insiders|codium|vscodium|cursor|windsurf|antigravity|antigravity-ide)$/
const ZEDS = /^(zed|zeditor|zed-preview)$/
const SUBLIMES = /^(subl|sublime_text)$/
const JETBRAINS = /^(idea|webstorm|pycharm|phpstorm|goland|rider|clion|rubymine|rustrover|datagrip|studio)(64)?$/

const ran = async ($: EngineInterface, argv: string[]): Promise<{ stdout: string; isOk: boolean }> =>
  $.process.run(argv, { timeoutMs: 30_000 }).then(
    r => ({ stdout: r.stdout, isOk: r.exitCode === 0 }),
    () => ({ stdout: '', isOk: false }),
  )

// the program in a command line: the first word, or the first quoted run
const programOf = (command: string): string => command.trim().match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) ?? ''

// how this editor opens a file at a line, or null when it has no way to
const atLine = async ($: EngineInterface, ed: Editor, file: string, line: number, isWindows: boolean): Promise<string[] | null> => {
  const sep = ed.exe.includes('\\') ? '\\' : '/'
  // a bare name, found on the PATH, has no folder to look in
  const dir = ed.exe.includes(sep) ? ed.exe.slice(0, ed.exe.lastIndexOf(sep)) : null
  // a VS Code fork ships a product.json naming its command, beside it or inside its app
  const root = ed.app ? `${ed.app}/Contents/Resources/app` : dir && `${dir}${sep}resources${sep}app`
  const product = root ? await $.fs.read(`${root}${sep}product.json`).then(text => JSON.parse(text) as { applicationName?: unknown }, () => null) : null
  if (typeof product?.applicationName === 'string') {
    const cli = ed.app ? `${root}/bin/${product.applicationName}` : `${dir}${sep}bin${sep}${product.applicationName}${isWindows ? '.cmd' : ''}`
    return [...(isWindows ? ['cmd', '/c'] : []), cli, '--goto', `${file}:${line}`]
  }
  if (ed.id?.startsWith('dev.zed.')) return [`${ed.app}/Contents/MacOS/cli`, `${file}:${line}`]
  if (ed.id?.startsWith('com.sublimetext.')) return [`${ed.app}/Contents/SharedSupport/bin/subl`, `${file}:${line}`]
  if (ed.id?.startsWith('com.jetbrains.') || ed.id === 'com.google.android.studio') return [ed.exe, '--line', String(line), file]
  const name = ed.exe.slice(ed.exe.lastIndexOf(sep) + 1).toLowerCase().replace(/\.(exe|cmd|sh)$/, '')
  if (VSCODES.test(name)) return [ed.exe, '--goto', `${file}:${line}`]
  if (ZEDS.test(name) || SUBLIMES.test(name)) return [ed.exe, `${file}:${line}`]
  if (JETBRAINS.test(name)) return [ed.exe, '--line', String(line), file]
  return null
}

// Windows: the user's choice for the extension, else the class's, then that one's open command
const windowsDefault = async ($: EngineInterface, file: string): Promise<Editor | null> => {
  const ext = file.match(/\.[^.\\/]+$/)?.[0]
  if (!ext) return null
  const value = (stdout: string, kind: string): string | undefined => stdout.match(new RegExp(`${kind}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`))?.[1]?.trim()
  const choice = await ran($, ['reg', 'query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`, '/v', 'ProgId'])
  const cls = await ran($, ['reg', 'query', `HKCR\\${ext}`, '/ve'])
  const progId = (choice.isOk ? value(choice.stdout, 'ProgId') : undefined) ?? (cls.isOk ? value(cls.stdout, '\\S+') : undefined)
  if (!progId) return null
  const open = await ran($, ['reg', 'query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'])
  const command = open.isOk ? value(open.stdout, '\\S+') : undefined
  return command ? { exe: programOf(command) } : null
}

// Linux: the file's type, the .desktop file that opens it, and that one's Exec program
const linuxDefault = async ($: EngineInterface, file: string): Promise<Editor | null> => {
  const type = (await ran($, ['xdg-mime', 'query', 'filetype', file])).stdout.trim()
  const desktop = type ? (await ran($, ['xdg-mime', 'query', 'default', type])).stdout.trim() : ''
  if (!desktop) return null
  const home = await $.env.get('HOME')
  const dataHome = (await $.env.get('XDG_DATA_HOME')) || (home ? `${home}/.local/share` : '')
  const dataDirs = ((await $.env.get('XDG_DATA_DIRS')) || '/usr/local/share:/usr/share').split(':')
  for (const base of [dataHome, ...dataDirs, '/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop'].filter(Boolean)) {
    const text = await $.fs.read(`${base}/applications/${desktop}`).catch(() => null)
    const exec = text?.match(/^Exec=(.+)$/m)?.[1]
    if (exec) return { exe: programOf(exec.replace(/^env\s+(\S+=\S+\s+)*/, '')) }
  }
  return null
}

// the editor named by VISUAL or EDITOR, when it is one that goes to a line
const namedEditor = async ($: EngineInterface): Promise<Editor | null> => {
  for (const command of [await $.env.get('VISUAL'), await $.env.get('EDITOR')]) {
    const exe = programOf(command ?? '')
    const name = exe.slice(Math.max(exe.lastIndexOf('/'), exe.lastIndexOf('\\')) + 1).toLowerCase().replace(/\.(exe|cmd|sh)$/, '')
    if ([VSCODES, ZEDS, SUBLIMES, JETBRAINS].some(family => family.test(name))) return { exe }
  }
  return null
}

// the commands to try, in order: VISUAL or EDITOR, the system's default app at the line, then the file as the system opens it
const openers = async ($: EngineInterface, file: string, line: number): Promise<string[][]> => {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const named = await namedEditor($)
  const ways: string[][] = []
  const add = async (ed: Editor | null): Promise<void> => {
    const argv = ed && (await atLine($, ed, file, line, isWindows))
    if (argv) ways.push(argv)
  }
  await add(named)
  if (named && ways.length > 0) return [...ways, ...(isWindows ? [['cmd', '/c', 'start', '', file]] : [])]
  if (isWindows) {
    await add(await windowsDefault($, file))
    return [...ways, ['cmd', '/c', 'start', '', file]]
  }
  const mac = await ran($, ['osascript', '-l', 'JavaScript', '-e', MAC_DEFAULT, file])
  if (mac.isOk) {
    const app = mac.stdout.trim() ? (JSON.parse(mac.stdout) as Editor) : null
    await add(app)
    return [...ways, app?.app ? ['open', '-a', app.app, file] : ['open', file]]
  }
  await add(await linuxDefault($, file))
  return [...ways, ['xdg-open', file]]
}

// the editor at the case's line, else the file as the system opens it; why nothing did, in the pane
const openInEditor = async ($: EngineInterface, file: string, name: string): Promise<void> => {
  const line = await $.fs.read(file).then(text => caseLine(text, name, file), () => 1)
  let why = ''
  for (const argv of await openers($, file, line)) {
    try {
      const done = await $.process.run(argv, { timeoutMs: 30_000 })
      if (done.exitCode === 0) return update($, openError, () => null)
      why = done.stderr.trim() || `exit ${done.exitCode}`
    } catch (err) {
      why = err instanceof Error ? err.message : String(err)
    }
  }
  const cwd = await $.session.cwd()
  await update($, openError, () => `Couldn't open ${shortPath(file, cwd)} in an editor: ${why}`)
}

// the session's tool for evidence that a test is better (or worse) than its verdict
const EVIDENCE_TOOL = 'test_evidence'
const EVIDENCE_MAX = 4_000
const EVIDENCE_HINT =
  'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.'
const EVIDENCE_DESCRIPTION =
  'Send evidence to test-grader that a test deserves a different verdict than it got (good, weak, useless), e.g. a mutation of the code that makes this test fail. ' +
  'The grader weighs it against the test source and answers with the new verdict and why. It cannot run code: state what you ran and what happened.'
const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'The test file, absolute or relative to the project' },
    test: { type: 'string', description: 'The test name as written (it(...)/test(...)), or as its loop generates it' },
    evidence: { type: 'string', description: 'What shows the test is better or worse than rated' },
  },
  required: ['file', 'test', 'evidence'],
}

// The test regraded with the session's evidence; its verdict replaces the one in both lists
const answerEvidence = async ($: EngineInterface, input: { file?: unknown; test?: unknown; evidence?: unknown }): Promise<string> => {
  const cwd = await $.session.cwd()
  const given = String(input.file ?? '')
  const file = given.startsWith('/') ? given : `${cwd}/${given.replace(/^\.\//, '')}`
  const name = String(input.test ?? '')
  const evidence = String(input.evidence ?? '').trim().slice(0, EVIDENCE_MAX)
  if (!evidence) return 'No evidence was given. Nothing was regraded.'
  const text = await $.fs.read(file).catch(() => null)
  if (text === null) return `There is no file ${shortPath(file, cwd)}. Nothing was regraded.`
  const caseName = [...new Set(caseNames(text, file))].find(n => fits(n, name))
  if (caseName === undefined) return `There is no test named ${JSON.stringify(name)} in ${shortPath(file, cwd)}. Nothing was regraded.`
  const before = [...(await read($, existing)).results, ...(await read($, tests))].find(t => t.file === file && t.name === name)?.verdict
  const verdicts = await grade($, file, text, [caseName], evidence).catch(() => null)
  const v = verdicts?.find(x => x.name === name) ?? verdicts?.find(x => fits(caseName, x.name))
  if (!v) return 'The grader gave no verdict. Nothing was regraded; send it again.'
  const judged = { verdict: v.verdict, summary: v.summary, reason: v.reason, evidence }
  const suite = suitesOf(text, file).get(caseName)
  await update($, existing, r => ({
    ...r,
    results: r.results.some(t => t.file === file && t.name === name)
      ? r.results.map(t => (t.file === file && t.name === name ? { ...t, ...judged, isPending: undefined } : t))
      : [...r.results, { file, name, ...(suite ? { suite } : {}), ...judged }],
  }))
  await update($, tests, list => list.map(t => (t.file === file && t.name === name && t.status !== 'pending' ? { ...t, status: 'done' as const, ...judged } : t)))
  await saveGrades($)
  const { round } = await countRound($, file, name, v.verdict)
  const left =
    round === 0 ? '' : round <= MAX_ROUNDS ? ` Strengthen it, or send other evidence (round ${round} of ${MAX_ROUNDS}).` : ' test-grader has stopped asking about this test: tell the person what is left.'
  return `${v.verdict === before ? 'Still' : 'Now'} ${v.verdict}: ${v.reason}${left}`
}

export const register: Register = (on, options) => {
  const chosen = options.graderModel
  graderModel = typeof chosen === 'string' && (GRADER_MODELS as readonly string[]).includes(chosen) ? chosen : 'haiku'
  // the evidence tool: it changes only this mod's own verdicts, so no permission prompt
  on('tool.check', { tool: /^mcp__test-grader__test_evidence$/ }, () => ({ decision: 'allow' as const })).catch(() => ({ decision: 'allow' as const }))
  on('tool.call', { tool: /^mcp__test-grader__test_evidence$/ }, async ($, e) => ({ result: await answerEvidence($, e as never) })).catch(
    (_$, _e, next) => ({ result: `The evidence tool could not answer (${next.error.kind}). Nothing was regraded; send it again.` }),
  )

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'test-grader', description: 'Open the test-grader pane (new tests, their quality, coverage)' })
    await $.tool
      .register({ name: EVIDENCE_TOOL, description: EVIDENCE_DESCRIPTION, inputSchema: EVIDENCE_SCHEMA })
      .catch(error => $.ui.log(`test-grader: the evidence tool could not be registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
    await refreshCoverage($)
    // the coverage run this project has, if any: the pane offers it only then
    const cover = await detectCommand($, await $.session.cwd()).catch(() => undefined)
    await update($, coverWith, () => cover?.label ?? null)
    await loadGrades($).catch(() => undefined)
    await prune($).catch(() => undefined)
    $.clock.after(1, () => void listAll($).catch(() => undefined))
    await resume($).catch(error => $.ui.log(`test-grader: the grading a reload cut off could not be resumed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
    // each session starts with its files at their default, closed when there are several; a
    // reload of this mod or a compaction starts the same session again, and keeps them
    const id = await $.session.id().catch(() => null)
    if (id === null || id !== (await read($, openFor))) {
      await update($, fileOpen, () => ({}))
      await update($, openFor, () => id)
    }
    void $.ui.open({ id: PANE, title: 'Tests' })

    return next(e)
  })

  on('command.run', { command: 'test-grader' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Tests' })
    await refreshCoverage($)

    return { text: 'Test pane opened.' }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && TEST_FILE.test(e.file_path)) {
      const names = caseNames(e.content, e.file_path)
      await update($, seen, all => ({ ...all, [e.file_path]: fingerprint(e.content) }))
      await refresh($, e.file_path, names)
      // a file written afresh holds its old cases too: only the ones not tracked yet are new
      const known = new Set((await read($, tests)).filter(t => t.file === e.file_path).map(t => t.name))
      const fresh = names.filter(n => !known.has(n) && !(isTemplate(n) && [...known].some(k => fits(n, k))))
      if (fresh.length > 0) await track($, e.file_path, fresh)
    }

    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && TEST_FILE.test(e.file_path)) {
      const text = await $.fs.read(e.file_path).catch(() => null)
      // an edit's two strings are pieces of the file: a name they hold is a case only if the
      // whole file, read as code, has it as one (not as a fixture's text)
      const isCase = text === null ? () => true : ((all: Set<string>) => (n: string) => all.has(n))(new Set(caseNames(text, e.file_path)))
      const before = new Set(caseNames(e.old_string, e.file_path))
      const touched = caseNames(e.new_string, e.file_path).filter(isCase)
      if (text !== null) await update($, seen, all => ({ ...all, [e.file_path]: fingerprint(text) }))
      await refresh($, e.file_path, touched)
      const names = touched.filter(n => !before.has(n))
      if (names.length > 0) await track($, e.file_path, names)
    }

    return ran
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isTurnRunning = false
    await refreshCoverage($)
    await catchUp($).catch(() => undefined)
    await flush($).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cwd = await $.session.cwd()
    // only this session's folder: a test written elsewhere is graded and told, not listed
    const list = (await read($, tests)).filter(t => cwd !== '' && t.file.startsWith(`${cwd}/`))
    const cov = await read($, coverage)
    const running = await read($, run)
    // coverage is shown where the project has a run test-grader knows, or a report to read
    const coverRun = await read($, coverWith)
    const hasCoverage = coverRun !== null || cov !== null
    const graded = await read($, existing)
    const noteFailed = await read($, noteError)
    const openFailed = await read($, openError)
    const now = await $.clock.now()

    // the pane's own width: docked beside the transcript, it is narrower than the window
    const columns = (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 60
    const isOpen = new Set(await read($, opened))
    const filesOpen = await read($, fileOpen)
    const toggle = (key: string): Promise<void> =>
      update($, opened, keys => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key].slice(-MAX_TESTS)))

    // One list: the last Grade all tests run and the tests written this session, a test in
    // both once, with the newer verdict; one written this session is marked new
    type State = Verdict | 'unrated' | 'reviewing' | 'ungraded'
    type Entry = { file: string; name: string; state: State; summary?: string; reason?: string; isNew: boolean; suite?: string; evidence?: string }
    const merged = new Map<string, Entry>()
    for (const t of graded.results) {
      const state: State = t.isPending ? 'reviewing' : t.isUngraded ? 'ungraded' : (t.verdict ?? 'unrated')
      merged.set(`${t.file}:${t.name}`, { file: t.file, name: t.name, state, summary: t.summary, reason: t.reason, isNew: false, suite: t.suite, evidence: t.evidence })
    }
    for (const t of list) {
      const key = `${t.file}:${t.name}`
      const prev = merged.get(key)
      const state: State = t.status === 'pending' ? 'reviewing' : t.status === 'failed' ? 'unrated' : (t.verdict ?? 'unrated')
      const isNewer = !prev || graded.finishedAt === undefined || t.at >= graded.finishedAt
      merged.set(key, isNewer ? { file: t.file, name: t.name, state, summary: t.summary, reason: t.reason, isNew: true, suite: t.suite ?? prev?.suite, evidence: t.evidence ?? prev?.evidence } : { ...prev, isNew: true })
    }
    const entries = [...merged.values()]
    const tally = (of: Entry[], s: State): number => of.filter(t => t.state === s).length

    // grouped: a Go suite over its files, else by file; the worst group first, and in a
    // file the worst test first, the new ahead
    const RANK: Record<State, number> = { useless: 0, weak: 1, unrated: 2, reviewing: 3, ungraded: 4, good: 5 }
    const worstFirst = (of: Entry[]): Entry[] => [...of].sort((a, b) => RANK[a.state] - RANK[b.state] || Number(b.isNew) - Number(a.isNew))
    const byFile = (of: Entry[]): { file: string; of: Entry[] }[] => {
      const files = new Map<string, Entry[]>()
      for (const t of of) files.set(t.file, [...(files.get(t.file) ?? []), t])
      return [...files.entries()].map(([file, of]) => ({ file, of: worstFirst(of) })).sort((a, b) => worse(a.of, b.of) || a.file.localeCompare(b.file))
    }
    const worse = (a: Entry[], b: Entry[]): number =>
      tally(b, 'useless') - tally(a, 'useless') || tally(b, 'weak') - tally(a, 'weak') || tally(b, 'unrated') - tally(a, 'unrated')
    // a suite is its package's: the folder of its files and its type's name
    const dirOf = (file: string): string => file.slice(0, file.lastIndexOf('/'))
    const suites = new Map<string, { dir: string; suite: string; of: Entry[] }>()
    for (const t of entries.filter(t => t.suite)) {
      const id = `${dirOf(t.file)}:${t.suite}`
      const group = suites.get(id) ?? { dir: dirOf(t.file), suite: t.suite!, of: [] }
      group.of.push(t)
      suites.set(id, group)
    }
    type Group = { kind: 'suite'; id: string; dir: string; suite: string; of: Entry[] } | { kind: 'file'; file: string; of: Entry[] }
    const labelOf = (g: Group): string => (g.kind === 'suite' ? `${g.suite} · ${shortPath(g.dir, cwd)}` : shortPath(g.file, cwd))
    const groups: Group[] = [
      ...[...suites.entries()].map(([id, g]): Group => ({ kind: 'suite', id, ...g })),
      ...byFile(entries.filter(t => !t.suite)).map(({ file, of }): Group => ({ kind: 'file', file, of })),
    ].sort((a, b) => worse(a.of, b.of) || labelOf(a).localeCompare(labelOf(b)))
    const stateColor = (s: State): string => (s === 'good' || s === 'weak' || s === 'useless' ? verdictColor(s) : MUTED)
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

    const counts = [
      plural(entries.length, 'test'),
      `${tally(entries, 'good')} good`,
      `${tally(entries, 'weak')} weak`,
      `${tally(entries, 'useless')} useless`,
      ...(tally(entries, 'unrated') > 0 ? [`${tally(entries, 'unrated')} unrated`] : []),
      ...(tally(entries, 'reviewing') > 0 ? [`${tally(entries, 'reviewing')} reviewing`] : []),
      ...(tally(entries, 'ungraded') > 0 ? [`${tally(entries, 'ungraded')} ungraded`] : []),
      ...(list.length > 0 ? [`${new Set(list.map(t => `${t.file}:${t.name}`)).size} new`] : []),
    ].join(' · ')

    // a group's header line: its toggle, its counts, and new when it holds a new test
    const header = (key: string, label: string, of: Entry[], indent: number, open: boolean, onPress: () => Promise<void>): unknown => {
      const worst = worstFirst(of)[0]!.state
      const groupCounts = [
        `${of.length}`,
        `${tally(of, 'good')} good`,
        ...(['weak', 'useless', 'unrated', 'reviewing', 'ungraded'] as const).filter(s => tally(of, s) > 0).map(s => `${tally(of, s)} ${s}`),
      ].join(' · ')
      return (
        <Box key={`h-${key}`} flexDirection="row" gap={1} marginLeft={indent}>
          <Button key={key} plain label={`${open ? '▾' : '▸'} ${clamp(label, Math.max(16, columns - groupCounts.length - 10 - indent))}`} onPress={onPress} />
          <Text color={worst === 'good' ? GREEN : stateColor(worst)}>{groupCounts}</Text>
          {of.some(t => t.isNew) && <Text color={VIOLET}>new</Text>}
        </Box>
      )
    }
    // a group starts open when it is alone among its siblings, closed among several; a press
    // sets it, until the next session
    const isGroupOpen = (key: string, siblings: number): boolean => filesOpen[key] ?? siblings === 1
    const flip = (key: string, open: boolean) => () => update($, fileOpen, all => ({ ...all, [key]: !open }))

    // a file's header and, open, every one of its tests; the pane scrolling
    const drawn: unknown[] = []
    // the verdicts' column, one width for the pane, so every title starts in line
    const verdictWidth = Math.max(...entries.map(t => t.state.length))
    // the characters a name's line holds: the row's room after its margin, the verdict, the gap
    // and the marks beside it; a desktop's proportional font fits a fifth more than its cells
    const nameWidth = (indent: number, t: Entry): number => {
      const room = columns - indent - 2 - verdictWidth - 1 - (t.isNew ? ' new'.length : 0) - (t.evidence ? ' on evidence'.length : 0)
      return Math.max(12, Math.floor(room * (e.surface === 'desktop' ? 1.2 : 1)))
    }
    // openKey: where its open or closed is kept; a top-level file's, by its path as before
    const drawFile = (key: string, openKey: string, file: string, of: Entry[], indent: number, siblings: number): void => {
      const open = isGroupOpen(openKey, siblings)
      drawn.push(header(key, shortPath(file, cwd), of, indent, open, flip(openKey, open)))
      if (!open) return
      for (const t of of) {
        const key = `r:${t.file}:${t.name}`
        const reason = t.state === 'unrated' ? 'The grader gave no verdict for this test. Grade again to retry it.' : t.state === 'ungraded' ? 'Not graded yet: Grade all tests grades it.' : t.reason
        drawn.push(
          <Box key={`row-${key}`} flexDirection="column" marginLeft={indent + 2}>
            <Box flexDirection="row" gap={1} alignItems="flex-start">
              <Box width={verdictWidth} flexShrink={0}>
                <Text bold color={stateColor(t.state)}>{t.state}</Text>
              </Box>
              <Box flexDirection="column">
                {wrapWords(t.name, nameWidth(indent, t)).map((part, i) => (
                  <Button key={i === 0 ? key : `${key}#${i}`} plain label={part} onPress={() => toggle(key)} />
                ))}
              </Box>
              {t.isNew && <Text color={VIOLET}>new</Text>}
              {t.evidence && <Text color={MUTED}>on evidence</Text>}
            </Box>
            {isOpen.has(key) && (
              <Box flexDirection="column" marginLeft={verdictWidth + 1}>
                {t.summary && <Text>{t.summary}</Text>}
                {reason && <Text color={stateColor(t.state)}>{reason}</Text>}
                {t.evidence && <Text color={MUTED}>{`Evidence: ${t.evidence}`}</Text>}
                <Button key={`o:${t.file}:${t.name}`} plain label="Open in editor" onPress={() => $.clock.after(1, () => void openInEditor($, t.file, t.name))} />
              </Box>
            )}
          </Box>,
        )
      }
    }
    for (const g of groups) {
      if (g.kind === 'file') {
        drawFile(`f:${g.file}`, g.file, g.file, g.of, 0, groups.length)
        continue
      }
      const key = `s:${g.id}`
      const open = isGroupOpen(key, groups.length)
      drawn.push(header(key, labelOf(g), g.of, 0, open, flip(key, open)))
      if (!open) continue
      const files = byFile(g.of)
      for (const { file, of } of files) drawFile(`sf:${g.id}:${file}`, `sf:${g.id}:${file}`, file, of, 2, files.length)
    }

    const metrics: [string, number | null][] = cov
      ? [['Lines', cov.lines], ['Statements', cov.statements], ['Branches', cov.branches], ['Functions', cov.functions]]
      : []
    const age = cov?.updatedAt ? Math.max(0, Math.round((now - cov.updatedAt) / 60_000)) : null

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color={VIOLET}>{counts}</Text>
        {graded.state === 'failed' && <Text color={RED}>{graded.message ?? 'Grading failed.'}</Text>}
        {graded.state === 'idle' && graded.graded !== undefined && (
          <Text color={MUTED}>{`Last run: ${graded.graded} graded · ${graded.remembered ?? 0} remembered`}</Text>
        )}
        <Box flexDirection="column" flexGrow={1} marginTop={1}>
          {entries.length === 0 && (
            <Text color={MUTED}>No tests yet. New tests show up here as they are written; Grade all tests grades the ones already there.</Text>
          )}
          {drawn as never}
        </Box>
        {openFailed !== null && <Text color={RED}>{openFailed}</Text>}
        {noteFailed !== null && <Text color={RED}>{`Couldn't share the result with Claude: ${noteFailed}`}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {hasCoverage && (
            <Box flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold>Coverage</Text>
                <Text color={MUTED}>{cov ? `${cov.source}${age !== null ? ` – ${age < 60 ? `${age}m` : `${Math.round(age / 60)}h`} ago` : ''}` : 'no report found'}</Text>
              </Box>
              {metrics
                .filter(([, v]) => v !== null)
                .map(([label, v]) => {
                  const value = v as number
                  const filled = Math.round((Math.min(100, value) / 100) * CELLS)
                  return (
                    <Box key={`cov-${label}`} flexDirection="row" gap={1}>
                      <Box width={11}>
                        <Text color={MUTED}>{label}</Text>
                      </Box>
                      <Box flexDirection="row" width={CELLS}>
                        {Array.from({ length: CELLS }, (_, i) => (
                          <Box key={`c-${label}-${i}`} width={1} backgroundColor={i < filled ? pctColor(value) : TRACK}>
                            <Text> </Text>
                          </Box>
                        ))}
                      </Box>
                      <Text bold color={pctColor(value)}>{`${value}%`}</Text>
                    </Box>
                  )
                })}
              {!cov && <Text color={MUTED}>Run coverage to see the numbers.</Text>}
              {running.state === 'failed' && <Text color={RED}>{running.message ?? 'Coverage run failed.'}</Text>}
            </Box>
          )}
          <Box flexDirection="row" gap={2} marginTop={1}>
            {coverRun !== null && (
              <Button
                key="run"
                label={running.state === 'running' ? 'Running…' : 'Run coverage'}
                onPress={() => (running.state === 'running' ? undefined : runCoverage($))}
              />
            )}
            <Button
              key="gradeAll"
              label={graded.state === 'running' ? `Grading… ${graded.done}/${graded.total} files done` : 'Grade all tests'}
              // on a timer: a run outlasts the press that starts it
              onPress={() => (graded.state === 'running' ? undefined : soon($, () => gradeAll($)))}
            />
            {graded.state !== 'running' && graded.hashes && Object.keys(graded.hashes).length > 0 && (
              <Button key="regradeAll" label="Regrade all" onPress={() => soon($, () => gradeAll($, true))} />
            )}
          </Box>
        </Box>
      </Box>
    )
  })
}
