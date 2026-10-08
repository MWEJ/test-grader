import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Confidence, Coverage, ExistingRun, ExistingTest, TrackedTest, Verdict } from '../types'

import { attr, byDirOf, coverageNote, pct } from './coverage'
import type { CoverCommand } from './coverage'
import { TEST_FILE, among, caseLine, caseNames, casesAround, casesIn, changedCases, fits, isTemplate, kindOf, shortPath, suitesOf } from './discovery'
import { MAX_REPLY, asAsked, caseTextOf, foldCases, othersOf, clamp, excerptOf, loopsOf, parseVerdicts, unratedWhy } from './excerpt'
import type { Graded } from './excerpt'
import { goProfileOf, moduleOf } from './gocover'
import { gradesKey, keep, unkeep } from './kept'
import type { KeptGrades, SavedGrades } from './kept'
import { costOf } from './prices'
import { EVIDENCE_DESCRIPTION, EVIDENCE_HINT, EVIDENCE_MAX, EVIDENCE_SCHEMA, EVIDENCE_TOOL, CONTEXT_DESCRIPTION, CONTEXT_MAX, VERIFY_SIBLINGS, CONTEXT_SCHEMA, CONTEXT_TOOL, FOLLOW_UP, GRADE_DESCRIPTION, GRADE_SCHEMA, GRADE_TOOL, GRADES_DESCRIPTION, GRADES_LIMIT, GRADES_SCHEMA, GRADES_TOOL, GRADING_SECTION, LANGUAGE_NAMES, LANGUAGE_ORDER, MAX_ROUNDS, RUBRIC, SPENT_FOLLOW_UP, VERIFY_DESCRIPTION, VERIFY_SCHEMA, VERIFY_TOOL, guideOf } from './prompts'
import { isBuildFailure, runArgv, shown, tailOf } from './runner'
import type { RunTarget, Runners } from './runner'
import { DEFAULT_MODEL, modelOf, workersOf } from './settings'
import { FLAGGED, LISTED, isFlagged, verdictOf } from './verdicts'
import type { State } from './verdicts'

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
const root = atom({ plugin: 'test-grader', key: 'root' } as const, null)
const rounds = atom({ plugin: 'test-grader', key: 'rounds' } as const, {})
const outbox = atom({ plugin: 'test-grader', key: 'outbox' } as const, { accepted: [], going: [], spent: [] })
const coverWith = atom({ plugin: 'test-grader', key: 'coverWith' } as const, null)
const saveError = atom({ plugin: 'test-grader', key: 'saveError' } as const, null)
const graderError = atom({ plugin: 'test-grader', key: 'graderError' } as const, null)
const unrated = atom({ plugin: 'test-grader', key: 'unrated' } as const, {})
const testRuns = atom({ plugin: 'test-grader', key: 'testRuns' } as const, {})
const modified = atom({ plugin: 'test-grader', key: 'modified' } as const, [])

const GREEN = '#4ade80'
const AMBER = '#fbbf24'
const RED = '#f87171'
const MUTED = '#8b90a0'
const TRACK = '#343848'
const VIOLET = '#a78bfa'
const BLUE = '#60a5fa'
// the rows kept pressed open, and the tests written this session the list keeps: the oldest go
const MAX_OPEN = 60
const MAX_TESTS = 5_000
const CELLS = 12
// Go's package bars: how many show, and how wide their labels may be
const PACKAGE_BARS = 8
const PACKAGE_LABEL = 28
// where the pane keeps whether every package is shown
const ALL_PACKAGES = 'cov:packages'
// Grade all tests: cases per grader call
const BATCH = 10
// grader calls in flight at once, from the graderWorkers setting (1 to 20), 10 by default
let parallel = 10
// the model that grades, from the graderModel setting; set as the module loads, and again
// when the person changes it in /config
let graderModel: string = DEFAULT_MODEL
// grades again what the first grade flagged (a regrade, evidence, a last round), when set
let escalateModel: string | null = null
// which form of the grader request the host took last: an older host takes only a plainer one
let shapeTaken = 0

const ORANGE = '#fb923c'
const PINK = '#f472b6'
const VERDICT_COLOR: Record<Verdict, string> = { strong: GREEN, shallow: AMBER, brittle: ORANGE, hollow: RED, duplicate: PINK }
const verdictColor = (v: Verdict | undefined): string => (v === undefined ? MUTED : VERDICT_COLOR[v])

// a count of tokens as the pane shows it: 950, 310k, 1.2M
const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)

const pctColor = (p: number): string => (p >= 80 ? GREEN : p >= 50 ? AMBER : RED)

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

// A note to Claude: a user-role row added to the conversation, read in the turn under way or
// the next one, never a prompt, so no turn is started for it. A refusal or a failure is kept
// for the pane to show, until a note goes through. The debug log has every note, added or not
// (a test cannot see a row a mod appends)
const share = async ($: EngineInterface, text: string): Promise<void> => {
  let error: string | null = null
  try {
    const row = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    if (row.deny !== undefined) error = row.deny
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  $.ui.log(`test-grader: note to Claude (${error === null ? 'appended' : `not appended: ${error}`}): ${text}`, { to: 'debug' })
  await update($, noteError, () => error)
}

// the flagged tests of a list, worst grade first, one line each
const flaggedLines = (list: { file: string; name: string; verdict?: Verdict; reason?: string; confidence?: Confidence }[], cwd: string): string[] =>
  FLAGGED.flatMap(v =>
    list.filter(t => t.verdict === v).map(t => `- ${v}${unsure(t)} · ${shortPath(t.file, cwd)} · ${t.name} — ${t.reason ?? ''}`),
  )
// a grade the grader was not sure of, marked where it is told: it may read otherwise on a regrade
const unsure = (t: { confidence?: Confidence }): string => (t.confidence === 'low' || t.confidence === 'medium' ? ` (${t.confidence} confidence)` : '')

// What grader calls cost, summed: tokens in (of them read from the prompt cache) and out
export type Spent = { input: number; cached: number; output: number; cost: number; unpriced: number }
const addUsage = (spent: Spent | undefined, model: string, usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): void => {
  if (!spent || !usage) return
  spent.input += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  spent.cached += usage.cache_read_input_tokens ?? 0
  spent.output += usage.output_tokens ?? 0
  // priced call by call: Haiku 5.5's price depends on each prompt's length
  const cost = costOf(model, usage)
  if (cost === null) spent.unpriced += 1
  else spent.cost += cost
}

// a run's cost as the pane shows it: dollars to the cent, or finer below one; a call whose
// model has no known price says so
const dollars = (spent: { cost?: number; unpriced?: number }): string => {
  const cost = spent.cost ?? 0
  const shown = cost === 0 ? '' : cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toPrecision(2)}`
  const unpriced = spent.unpriced ? `${spent.unpriced} call${spent.unpriced === 1 ? '' : 's'} unpriced` : ''
  return [shown && `about ${shown}`, unpriced].filter(Boolean).join(', ')
}

// the project's own rules for its tests, from .test-grader.md at its root: read at a session's
// start and each turn's end; the grader is told them after the rubric
const RUBRIC_FILE = '.test-grader.md'
const MAX_RULES = 4_000
let projectRules = ''
const readRules = async ($: EngineInterface): Promise<void> => {
  const cwd = await projectDir($)
  projectRules = cwd ? ((await $.fs.read(`${cwd}/${RUBRIC_FILE}`).catch(() => '')) ?? '').trim().slice(0, MAX_RULES) : ''
}

// an API error worth trying again: too many requests, overloaded, the server's own, or no answer
const RETRIES = 3
const isPassing = (r: { reason: string; status?: number | null; error?: string }): boolean =>
  r.reason === 'api-error' && (r.status === null || r.status === 429 || r.status === 529 || (r.status ?? 0) >= 500 || r.error === 'rate_limit' || r.error === 'overloaded' || r.error === 'server_error')
const sleep = ($: EngineInterface, ms: number): Promise<void> => new Promise(done => void $.clock.after(ms, () => done()))
// how long one grader call may take
const CALL_TIMEOUT = 120_000

// prior: the grades these cases had for this same text, which a regrade keeps unless it finds them wrong
type GradeOptions = { evidence?: string; isMeasured?: boolean; model?: string; signal?: AbortSignal; spent?: Spent; confirming?: Graded[]; prior?: { name: string; verdict: Verdict; reason?: string }[] }

// The code a test file tests, as the grader reads it beside the test: the project files it
// imports by a relative path (JS and TS, Python, Ruby), its package's other files (Go), or the
// class it is named for (Kotlin, Java), each cut to its share of MAX_UNDER_TEST. Kept per file
// as it last read, until the file changes
const MAX_UNDER_TEST = 16_000
const MAX_UNDER_TEST_FILES = 4
const underTestCache = new Map<string, { hash: string; text: string }>()
const codeUnderTest = async ($: EngineInterface, file: string, text: string): Promise<string> => {
  const hash = fingerprint(text)
  const kept = underTestCache.get(file)
  if (kept?.hash === hash) return kept.text
  const cwd = await projectDir($)
  const paths = await candidatesFor($, file, text, cwd)
  const found: { path: string; text: string }[] = []
  for (const path of paths) {
    if (found.length >= MAX_UNDER_TEST_FILES || found.some(f => f.path === path) || path === file || TEST_FILE.test(path)) continue
    const body = await $.fs.read(path).catch(() => null)
    if (body !== null && body.trim() !== '') found.push({ path, text: body })
  }
  const share = Math.floor(MAX_UNDER_TEST / Math.max(1, found.length))
  const out =
    found.length === 0
      ? ''
      : ['The code under test, as the test file reaches it:', ...found.map(f => [`--- ${shortPath(f.path, cwd)} ---`, '```', clamp(f.text, share), '```'].join('\n'))].join('\n')
  underTestCache.set(file, { hash, text: out })
  return out
}

// where a test file's code under test may be, most likely first; a path that is not there is
// passed over when read
const candidatesFor = async ($: EngineInterface, file: string, text: string, cwd: string): Promise<string[]> => {
  const dir = file.slice(0, file.lastIndexOf('/'))
  const join = (base: string, rel: string): string => {
    const parts = `${base}/${rel}`.split('/')
    const out: string[] = []
    for (const part of parts) part === '..' ? out.pop() : part !== '.' && out.push(part)
    return out.join('/')
  }
  const kind = kindOf(file)
  if (kind === 'js') {
    const specs = [...text.matchAll(/(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|^import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)].map(m => m[1]!)
    return specs.flatMap(spec => {
      const base = join(dir, spec.replace(/\.[cm]?js$/, ''))
      return [spec.match(/\.[cm]?[jt]sx?$/) ? join(dir, spec) : null, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'].map(ext => base + ext)].filter((p): p is string => p !== null)
    })
  }
  if (kind === 'py') {
    return [...text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\b/gm)].flatMap(m => {
      const rel = m[2]!.replace(/\./g, '/')
      if (m[1]) {
        const up = '../'.repeat(m[1].length - 1)
        return rel ? [join(dir, `${up}${rel}.py`), join(dir, `${up}${rel}/__init__.py`)] : []
      }
      return rel ? [`${cwd}/${rel}.py`, `${cwd}/src/${rel}.py`, `${dir}/${rel}.py`] : []
    })
  }
  if (kind === 'rb') return [...text.matchAll(/^\s*require_relative\s+['"]([^'"]+)['"]/gm)].map(m => join(dir, m[1]!.endsWith('.rb') ? m[1]! : `${m[1]}.rb`))
  if (kind === 'go') {
    const entries = await $.fs.list(dir).catch(() => [])
    return entries.filter(e => e.kind === 'file' && e.name.endsWith('.go') && !e.name.endsWith('_test.go')).map(e => `${dir}/${e.name}`)
  }
  if (kind === 'jvm') {
    const name = file.slice(file.lastIndexOf('/') + 1).replace(/(Tests?|Spec|IT)\.(kt|java)$/, '.$2')
    const mainDir = dir.replace(/\/src\/test\//, '/src/main/')
    return mainDir === dir ? [] : [`${mainDir}/${name}`]
  }
  return []
}

// These cases of this file, judged; null when the grader gave no answer. A plain grade that
// flags a test is checked by a second, more careful call before the flag stands: where it
// disagrees, its grade is the one given. A test a measured mutation made fail is not hollow
const grade = async ($: EngineInterface, file: string, text: string, names: string[], options: GradeOptions = {}): Promise<Graded[] | null> => {
  const first = await gradeCall($, file, text, names, options)
  if (first === null) return null
  const measured = options.isMeasured ? first.map(v => (v.verdict === 'hollow' ? { ...v, verdict: 'strong' as const, reason: `${v.reason} (A measured mutation made it fail, so it is not hollow.)` } : v)) : first
  // evidence and a second look are already the careful call
  if (options.evidence || options.model !== undefined) return measured
  const flagged = measured.filter(v => isFlagged(v.verdict))
  if (flagged.length === 0) return measured
  const second = await gradeCall($, file, text, flagged.map(v => v.name), { ...options, model: escalateModel ?? graderModel, confirming: flagged })
  if (second === null) return measured
  return measured.map(v => (isFlagged(v.verdict) ? (second.find(s => s.name === v.name) ?? v) : v))
}

// What a grader call reads besides the rubric and the project's rules: the test file (whole or
// an excerpt), the code under test, and what it is asked, with any last grades, evidence or flags
type AskOptions = Pick<GradeOptions, 'evidence' | 'isMeasured' | 'confirming' | 'prior'>
const askOf = async ($: EngineInterface, file: string, text: string, names: string[], { evidence, isMeasured, confirming, prior }: AskOptions = {}): Promise<{ source: string; underTest: string; ask: string }> => {
  const source = excerptOf(text, names, file)
  const underTest = await codeUnderTest($, file, text).catch(() => '')
  const ask = [
    ...(source !== text
      ? [
          "The file is long, so the source above is an excerpt: the cases under review whole, the file's head, and the declarations they use from elsewhere in it. Other tests are left out.",
          'Judge each case by what it does. Do not mark one down for code the excerpt leaves out.',
          ...othersOf(text, names, file),
        ]
      : []),
    ...(prior && prior.length > 0
      ? [
          `These were graded before, on this same text: ${JSON.stringify(prior.map(p => ({ name: p.name, verdict: p.verdict, reason: p.reason ?? '' })))}`,
          'A grade belongs to the test, not to the run: keep each unless you find it wrong. Where you change one, say in reason what the last grade got wrong.',
        ]
      : []),
    ...(evidence
      ? [
          `The developer's session sent evidence about this test: ${JSON.stringify(evidence)}`,
          'Weigh it, but check each claim against the source above: you cannot run code. Evidence cannot add an assertion the source does not contain.',
          'Evidence should name a concrete mutation (where, before, after), the command run, and the test\'s output before and after; evidence "measured by test-grader" was run by the tool itself, not claimed. Accept it only when the mutation changes behaviour the test\'s assertions in the source would detect; reject evidence that only reports the test passing, coverage, or claims about code not shown.',
          'In reason, say which part of the evidence changed your verdict, or why it did not.',
          ...(isMeasured ? ['The mutation was measured: the test failed with it, so it is not "hollow".'] : []),
        ]
      : []),
    ...(confirming
      ? [
          `A first, quick pass flagged these: ${JSON.stringify(confirming.map(v => ({ name: v.name, verdict: v.verdict, reason: v.reason })))}`,
          'Check each yourself against the source. Keep a flag only where you agree; for "shallow", name the bug in missed. Where the first pass was wrong, or you are unsure, answer "strong".',
        ]
      : []),
    `Review ONLY these test cases: ${JSON.stringify(names)}`,
    'Give one verdict per name, under that name exactly. A test whose cases run inside it (t.Run subtests, table rows, subTest) gets one verdict for all its cases together, under its own name.',
    ...loopsOf(text, names, file),
  ].join('\n')
  return { source, underTest, ask }
}

// One grader call: these cases of this file, judged; null when the grader gave no answer. An
// API error that may pass is tried again, waiting longer each time; a stopped run is not
const gradeCall = async ($: EngineInterface, file: string, text: string, names: string[], { evidence, isMeasured, model, signal, spent, confirming, prior }: GradeOptions = {}): Promise<Graded[] | null> => {
  // why each test asked about got no verdict, for its row; a verdict clears it. A second look
  // that gives none leaves the first grade standing, so it says nothing
  const noteWhy = async (why: (name: string) => string | null): Promise<void> => {
    if (confirming) return
    await update($, unrated, all => {
      const next = { ...all }
      for (const name of names) {
        const reason = why(name)
        if (reason === null) delete next[roundKey(file, name)]
        else next[roundKey(file, name)] = reason
      }
      return next
    })
  }
  const { source, underTest, ask } = await askOf($, file, text, names, { evidence, isMeasured, confirming, prior })
  const request = {
    model: model ?? graderModel,
    maxTokens: MAX_REPLY,
    // the plain grade asks for little thought; a second look, or evidence, the model's own
    ...(model === undefined && !evidence ? { effort: 'low' as const } : {}),
    timeoutMs: CALL_TIMEOUT,
    system: [{ text: RUBRIC, cache: true as const }, ...(projectRules ? [{ text: `The project's own rules for its tests (${RUBRIC_FILE}):\n${projectRules}` }] : [])],
    // the file first and marked, so the next batch of the same file reads it from the cache
    prompt: [{ text: [`Test file: ${file}`, '```', source, '```', ...(underTest ? ['', underTest] : [])].join('\n'), cache: true as const }, { text: `\n${ask}` }],
  }
  // an older host takes less: the same request with plain texts and no effort, then the model
  // and one prompt alone; the first it takes is kept for the session's later calls
  const joined = (blocks: { text: string }[], by: string): string => blocks.map(b => b.text).join(by)
  const shapes: Parameters<typeof $.model.complete>[0][] = [
    request,
    { model: request.model, maxTokens: request.maxTokens, timeoutMs: request.timeoutMs, system: joined(request.system, '\n\n'), prompt: joined(request.prompt, '') },
    { model: request.model, prompt: `${joined(request.system, '\n\n')}\n\n${joined(request.prompt, '')}` },
  ]
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return null
    let reply: Awaited<ReturnType<typeof $.model.complete>> | undefined
    let refused = ''
    for (let s = shapeTaken; s < shapes.length && reply === undefined; s++) {
      try {
        reply = await $.model.complete(shapes[s]!, signal ? { signal } : undefined)
        shapeTaken = s
      } catch (err) {
        // a request the host will not send rejects at once: a blocked model, or a shape it does not take
        if (signal?.aborted) return null
        refused = err instanceof Error ? err.message : String(err)
        $.ui.log(`test-grader: the grader call failed for ${file} (request ${s + 1} of ${shapes.length}: ${refused})`, { to: 'debug' })
      }
    }
    if (reply === undefined) {
      await update($, graderError, () => `The grader (${request.model}) call failed: ${refused}`)
      await noteWhy(() => `The grader (${request.model}) call failed: ${refused}`)
      return null
    }
    addUsage(spent, request.model, reply.usage)
    if (reply.isAnswered) {
      const parsed = parseVerdicts(reply.text)
      const verdicts = foldCases(names, asAsked(names, parsed.verdicts))
      const { isCut } = parsed
      if (isCut) {
        $.ui.log(`test-grader: a grader reply was cut off (${reply.usage?.output_tokens ?? '?'} of ${MAX_REPLY} tokens) for ${file}: kept ${verdicts.length} verdicts of ${JSON.stringify(names)}`, { to: 'debug' })
      }
      // an answer with no verdict for any case asked about leaves them unrated: the pane says
      // what came back, so a model that will not answer in the format can be told apart
      if (names.length > 0 && !verdicts.some(v => among(names, v.name))) {
        const said = reply.text.replace(/\s+/g, ' ').trim()
        $.ui.log(`test-grader: the grader answered with no verdict for ${file}: ${said.slice(0, 2_000)}`, { to: 'debug' })
        await update($, graderError, () => `The grader (${request.model}) answered with no verdict it could read: "${said.length > 160 ? `${said.slice(0, 160)}…` : said}".`)
      } else await update($, graderError, () => null)
      await noteWhy(name => unratedWhy(reply.text, verdicts, isCut, names, name, request.model))
      return verdicts
    }
    if (attempt >= RETRIES || !isPassing(reply as never)) {
      const why = `${reply.reason}${'status' in reply ? ` ${reply.status ?? ''} ${reply.error}` : ''}`
      $.ui.log(`test-grader: the grader gave no answer for ${file} (${why})`, { to: 'debug' })
      // shown in the pane: a setting or an account that cannot reach the model says so there
      await update($, graderError, () => `The grader (${request.model}) gave no answer: ${why}.`)
      await noteWhy(() => `The grader (${request.model}) gave no answer: ${why}.`)
      return null
    }
    // 2s, 4s, 8s, each with up to a second more, so parallel calls do not retry together
    await sleep($, 2_000 * 2 ** attempt + Math.floor(Math.random() * 1_000))
  }
}

// A test Claude wrote or edited, given a flagged grade, is told to Claude in a note, never a
// prompt: the system prompt has told it to look up its tests' grades with test_grades once it is
// done writing them, and follow up. A test graded strong after that is told as accepted.
// Each test gets MAX_ROUNDS such rounds; past them the note says test-grader stops on it
const roundKey = (file: string, name: string): string => `${file}::${name}`

// the reasons these tests of a file have no verdict, as their last grader call left them, by name
const unratedOf = async ($: EngineInterface, file: string): Promise<(name: string) => { reason?: string }> => {
  const all = await read($, unrated)
  return name => (all[roundKey(file, name)] ? { reason: all[roundKey(file, name)] } : {})
}
// a grading that failed outright: each of its tests says how
const noteFailed = async ($: EngineInterface, file: string, names: string[], err: unknown): Promise<void> => {
  const why = `Grading failed: ${err instanceof Error ? err.message : String(err)}`
  await update($, unrated, all => ({ ...all, ...Object.fromEntries(names.map(name => [roundKey(file, name), why])) }))
}

// the round a test is on now: one more for a flagged grade, none once it is strong
const countRound = async ($: EngineInterface, file: string, name: string, verdict: Verdict | undefined): Promise<{ round: number; wasRetried: boolean }> => {
  const key = roundKey(file, name)
  const before = (await read($, rounds))[key] ?? 0
  const round = isFlagged(verdict) ? before + 1 : 0
  if (round !== before) await update($, rounds, all => (({ [key]: _, ...rest }) => (round > 0 ? { ...rest, [key]: round } : rest))(all))
  return { round, wasRetried: before > 0 }
}

// Grades wait in the outbox while grading is under way, then go as one note: several flagged
// tests, or several files graded, are one round, not one note each.
// A test graded again before then is listed once, at its latest grade
type Report = { file: string; name: string; verdict?: Verdict; reason?: string }
const reportGrades = async ($: EngineInterface, graded: Report[]): Promise<void> => {
  for (const t of graded) {
    // a test waiting in the outbox is in a round already counted (one edit graded on both
    // lists): its entry takes this grade's words and keeps its place
    const isSame = (o: Report): boolean => roundKey(o.file, o.name) === roundKey(t.file, t.name)
    const box = await read($, outbox)
    const waiting = [...box.accepted, ...box.going, ...box.spent].find(isSame)
    // the same kind of grade: its words and verdict replace the waiting one's, in its place
    if (waiting && isFlagged(waiting.verdict ?? (box.accepted.includes(waiting) ? 'strong' : undefined)) === isFlagged(t.verdict)) {
      const take = (list: Report[]) => list.map(o => (isSame(o) ? { ...o, verdict: t.verdict ?? o.verdict, reason: t.reason ?? o.reason } : o))
      await update($, outbox, b => ({ accepted: take(b.accepted), going: take(b.going), spent: take(b.spent) }))
      continue
    }
    // another kind (a flagged test now strong): the waiting entry's round is undone, and the new
    // grade counted in its stead
    if (waiting && isFlagged(waiting.verdict)) {
      const key = roundKey(t.file, t.name)
      await update($, rounds, all => {
        const left = (all[key] ?? 1) - 1
        const { [key]: _, ...rest } = all
        return left > 0 ? { ...rest, [key]: left } : rest
      })
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

const flush = async ($: EngineInterface): Promise<void> => {
  if (working > 0) return
  const box = await read($, outbox)
  const { accepted, going, spent } = box
  if (accepted.length + going.length + spent.length === 0) return
  await update($, outbox, () => ({ accepted: [], going: [], spent: [] }))
  const cwd = await projectDir($)
  const lines = [
    ...(accepted.length > 0 ? ['Now graded strong (test-grader):', ...accepted.map(t => `- strong · ${shortPath(t.file, cwd)} · ${t.name}`)] : []),
    ...(going.length > 0 ? ['Tests that need work (test-grader):', ...flaggedLines(going, cwd), FOLLOW_UP] : []),
    ...(spent.length > 0 ? [`Still flagged after ${MAX_ROUNDS} rounds (test-grader stops on these):`, ...flaggedLines(spent, cwd), SPENT_FOLLOW_UP] : []),
  ]
  // a note, added to the conversation: no turn is started for it
  await share($, lines.join('\n'))
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

// A grade is for the text it read: the file as it is now when any of these cases' own text has
// changed since (an outside edit while the grader ran), else null. Graded again at most so often
const MAX_STALE = 2
const staleOf = async ($: EngineInterface, file: string, graded: string, names: string[]): Promise<string | null> => {
  const now = await $.fs.read(file).catch(() => null)
  if (now === null || now === graded) return null
  return names.some(name => caseTextOf(graded, name, file) !== caseTextOf(now, name, file)) ? now : null
}

// model: a second look, for a test graded again after a flagged grade
const evaluate = ($: EngineInterface, file: string, ids: Map<string, string>, model?: string): Promise<void> => busy($, () => evaluateNow($, file, ids, model))
const evaluateNow = async ($: EngineInterface, file: string, ids: Map<string, string>, model?: string, tries = 0): Promise<void> => {
  const fail = async (): Promise<void> => {
    const why = await unratedOf($, file)
    await update($, tests, list => list.map(t => (ids.has(t.id) && t.status === 'pending' ? { ...t, status: 'failed' as const, ...why(t.name) } : t)))
  }
  try {
    const text = await $.fs.read(file)
    const verdicts = await grade($, file, text, [...ids.values()], { model })
    if (verdicts === null) return fail()
    // the file changed under the grade: graded again on its new text, not kept for the old
    if (tries < MAX_STALE && (await staleOf($, file, text, [...ids.values()])) !== null) return evaluateNow($, file, ids, model, tries + 1)
    const why = await unratedOf($, file)
    await update($, tests, list =>
      // a looped test becomes one entry per case it generates
      list.flatMap((t): TrackedTest[] => {
        if (!ids.has(t.id)) return [t]
        const found = verdicts.filter(v => fits(t.name, v.name))
        if (found.length === 0) return [{ ...t, status: 'failed', ...why(t.name) }]
        return found.map((v, k) => ({
          ...t,
          id: k === 0 ? t.id : `${t.id}-${k}`,
          name: v.name,
          status: 'done',
          summary: v.summary,
          verdict: v.verdict,
          reason: v.reason,
          confidence: v.confidence,
        }))
      }),
    )
    const mine = (await read($, tests)).filter(t => [...ids.keys()].some(id => t.id === id || t.id.startsWith(`${id}-`)))
    await reportGrades($, mine)
  } catch (err) {
    await noteFailed($, file, [...ids.values()], err)
    await fail()
  }
}

const mtime = async ($: EngineInterface, path: string): Promise<number | null> => {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return null
  }
}

const readCoverage = async ($: EngineInterface): Promise<Coverage | null> => {
  const cwd = await projectDir($)
  const summaryPath = `${cwd}/coverage/coverage-summary.json`
  const lcovPath = `${cwd}/coverage/lcov.info`
  const xmlPath = `${cwd}/coverage.xml`
  const goPath = `${cwd}/.test-grader-go-coverage.txt`

  const at = await mtime($, summaryPath)
  if (at !== null) {
    try {
      const report = JSON.parse(await $.fs.read(summaryPath)) as Record<string, Record<string, { pct?: unknown; total?: unknown; covered?: unknown }>>
      const total = report.total!
      const byFile = Object.entries(report)
        .filter(([file]) => file !== 'total')
        .map(([file, m]) => ({ file, total: Number(m.lines?.total ?? 0), covered: Number(m.lines?.covered ?? 0) }))
      return {
        byDir: byDirOf(byFile, cwd),
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
    // per file: each record from its SF: line to its end_of_record
    const byFile = text.split('end_of_record').flatMap(record => {
      const file = record.match(/^SF:(.+)$/m)?.[1]?.trim()
      const count = (key: string): number => Number(record.match(new RegExp(`^${key}:(\\d+)`, 'm'))?.[1] ?? 0)
      return file ? [{ file: file.startsWith('/') ? file : `${cwd}/${file}`, total: count('LF'), covered: count('LH') }] : []
    })
    return {
      byDir: byDirOf(byFile, cwd),
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
  const profileAt = await mtime($, `${cwd}/${GO_PROFILE}`)
  if (profileAt !== null) {
    const goMod = await $.fs.read(`${cwd}/go.mod`).catch(() => '')
    const { statements, byFile, byPackage } = goProfileOf(await $.fs.read(`${cwd}/${GO_PROFILE}`), moduleOf(goMod), cwd)
    if (statements !== null) return { byDir: byDirOf(byFile, cwd), byPackage, lines: null, statements: pct(statements), branches: null, functions: null, source: 'go test -coverprofile', updatedAt: profileAt }
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

// The coverage report as the watch last saw it, by each report's modification time: a report
// a run outside the pane writes shows in the pane within one watch period
const GO_PROFILE = '.test-grader-go-cover.out'
const REPORTS = ['coverage/coverage-summary.json', 'coverage/lcov.info', 'coverage.xml', GO_PROFILE, '.test-grader-go-coverage.txt']
let reportsAt = ''
const refreshCoverageIfChanged = async ($: EngineInterface): Promise<void> => {
  const cwd = await projectDir($)
  const at = (await Promise.all(REPORTS.map(r => mtime($, `${cwd}/${r}`)))).join(',')
  if (at === reportsAt) return
  reportsAt = at
  await refreshCoverage($)
}

// the project's coverage run: its command, and how a note to Claude names it
const detectCommand = async ($: EngineInterface, cwd: string): Promise<CoverCommand | undefined> => {
  const exists = async (name: string): Promise<boolean> => (await mtime($, `${cwd}/${name}`)) !== null
  if (await exists('package.json')) {
    const pkg = await $.fs.read(`${cwd}/package.json`)
    // the project's own coverage script first: it knows how the project measures it
    const scripts = (() => {
      try {
        return (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {}
      } catch {
        return {}
      }
    })()
    if (typeof scripts.coverage === 'string') return { argv: ['npm', 'run', '--silent', 'coverage'], label: 'npm run coverage' }
    if (/"vitest"/.test(pkg)) return { argv: ['npx', 'vitest', 'run', '--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=lcov'], label: 'npx vitest run --coverage' }
    if (/"jest"/.test(pkg)) return { argv: ['npx', 'jest', '--coverage', '--coverageReporters=json-summary', '--coverageReporters=lcov'], label: 'npx jest --coverage' }
  }
  if ((await exists('pytest.ini')) || (await exists('pyproject.toml')) || (await exists('setup.cfg'))) {
    return { argv: ['python3', '-m', 'pytest', '--cov', '--cov-report=xml'], label: 'pytest --cov' }
  }
  // the profile gives each file's statements, so the total is weighted by package size and
  // the folders can be told apart; the printed lines are kept for a run that wrote no profile
  if (await exists('go.mod')) return { argv: ['go', 'test', './...', '-cover', `-coverprofile=${GO_PROFILE}`], label: 'go test ./... -coverprofile', goOutput: '.test-grader-go-coverage.txt' }
  return undefined
}

const runCoverage = async ($: EngineInterface): Promise<void> => {
  const cwd = await projectDir($)
  const setRun = (state: 'idle' | 'running' | 'failed', message?: string) => update($, run, () => ({ state, message }))
  try {
    const command = await detectCommand($, cwd)
    if (!command) return void (await setRun('failed', 'No coverage script, jest, vitest, pytest or Go project found here.'))
    await setRun('running')
    const result = await $.process.run(command.argv, { cwd, timeoutMs: 600_000 })
    if (command.goOutput) await $.fs.write(`${cwd}/${command.goOutput}`, result.stdout)
    await refreshCoverage($)
    await setRun(result.exitCode === 0 ? 'idle' : 'failed', result.exitCode === 0 ? undefined : `Tests exited with ${result.exitCode}.`)
    await share($, coverageNote(command, result.exitCode, [result.stdout, result.stderr].join('\n'), await read($, coverage)))
  } catch (err) {
    await setRun('failed', err instanceof Error ? err.message : String(err))
  }
}

// what a finished Grade all tests run tells Claude: the counts, then every flagged and
// unrated test (the strong are counted, not listed)
// changed: the files graded again because they changed since their last grading; added: the
// files graded for the first time; each by its path in the project
type RunFiles = { changed: string[]; added: string[] }
const MAX_NAMED_FILES = 20
const namedFiles = (label: string, files: string[]): string[] =>
  files.length === 0 ? [] : [`${label}: ${files.slice(0, MAX_NAMED_FILES).join(', ')}${files.length > MAX_NAMED_FILES ? ` and ${files.length - MAX_NAMED_FILES} more` : ''}.`]
const existingNote = (results: ExistingTest[], cwd: string, scope?: string, files?: RunFiles): string => {
  const count = (v: Verdict): number => results.filter(t => t.verdict === v).length
  const unrated = results.filter(t => !t.verdict)
  const counts = [`${results.length} graded`, `${count('strong')} strong`, ...FLAGGED.filter(v => count(v) > 0).map(v => `${count(v)} ${v}`)]
  if (unrated.length > 0) counts.push(`${unrated.length} unrated`)
  const lines = [`Test grading (test-grader) finished${scope ? ` for ${scope}` : ''}: ${counts.join(' · ')}.`]
  if (files) lines.push(...namedFiles('Changed since their last grading', files.changed), ...namedFiles('Graded for the first time', files.added))
  const flagged = flaggedLines(results, cwd)
  if (flagged.length > 0) lines.push(`Need work, worst first (${FLAGGED.join(', then ')}):`, ...flagged, EVIDENCE_HINT)
  if (unrated.length > 0) lines.push('Unrated (the grader gave no verdict):', ...unrated.map(t => `- ${shortPath(t.file, cwd)} · ${t.name}`))
  return lines.join('\n')
}

// Grade all tests: every case of every test file git tracks, BATCH cases a call and
// parallel calls at once; the results keep file order. A batch the grader fails leaves
// its cases unrated, and the run goes on
// a file's contents, fingerprinted (FNV-1a), with its length
export const fingerprint = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return `${(hash >>> 0).toString(16)}-${text.length}`
}

// a test's own text, fingerprinted: what a verdict given on evidence was given for
const ownText = (text: string, name: string, file: string): string => fingerprint(caseTextOf(text, name, file) ?? '')
// a verdict given on evidence holds, and is not graded again, while the test's own text is as it was
const isHeld = (t: { name: string; evidence?: string; evidenceOf?: string }, text: string, file: string): boolean =>
  Boolean(t.evidence && t.evidenceOf && t.evidenceOf === ownText(text, t.name, file))

const saveGrades = async ($: EngineInterface): Promise<void> => {
  const cwd = await projectDir($)
  if (!cwd) return
  const run = await read($, existing)
  const saved: SavedGrades = {
    results: run.results.filter(t => !t.isUngraded).map(({ isPending: _, ...t }) => t),
    hashes: run.hashes ?? {},
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  }
  const why = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  try {
    await $.store.set(gradesKey(cwd), keep(saved, false))
    await update($, saveError, () => null)
  } catch (error) {
    // too large whole: kept without the summaries; failing that, the pane says the grades
    // will not outlive the session
    try {
      await $.store.set(gradesKey(cwd), keep(saved, true))
      await update($, saveError, () => null)
      $.ui.log(`test-grader: the grades were kept without their summaries: ${why(error)}`, { to: 'debug' })
    } catch (lean) {
      $.ui.log(`test-grader: the grades could not be saved: ${why(lean)}`, { to: 'debug' })
      await update($, saveError, () => `The grades could not be saved, and will not outlive this session: ${why(lean)}`)
    }
  }
}

// at a session's start, one that has graded nothing yet takes the project's saved grades
const loadGrades = async ($: EngineInterface): Promise<void> => {
  const run = await read($, existing)
  if (run.hashes || run.results.some(t => !t.isUngraded)) return
  const cwd = await projectDir($)
  if (!cwd) return
  const kept = (await $.store.get(gradesKey(cwd)).catch(() => undefined)) as KeptGrades | SavedGrades | undefined
  if (!kept || !('v' in kept ? kept.files : Array.isArray(kept.results))) return
  const saved = unkeep(kept)
  await update($, existing, r => ({ ...r, results: saved.results, hashes: saved.hashes ?? {}, ...(saved.finishedAt === undefined ? {} : { finishedAt: saved.finishedAt }) }))
}

// The project's test files, by their path in it: every one git tracks, and every new one it
// would (untracked, not ignored); null outside a git repository
const testFiles = async ($: EngineInterface, cwd: string): Promise<string[] | null> => {
  const listed = await $.process.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeoutMs: 60_000 })
  if (listed.exitCode !== 0) return null
  return [...new Set(listed.stdout.split('\n').filter(f => f !== '' && TEST_FILE.test(f)))]
}

// A run under way can be stopped: its grader calls are cut and no more start. The files it had
// not graded keep what they had, and the next run grades them
let stopRun: AbortController | null = null
const stopGrading = (): void => stopRun?.abort()

// isFresh: grade every test again, the rated ones too; only: these files alone (their paths
// in the project), the rest of the project's results left as they are; scope: what Claude's
// note says the run graded; isQuiet: no note, the run's text answers whoever asked (a tool).
// It comes to what the note says, or why nothing was graded
type RunOptions = { isFresh?: boolean; only?: string[]; scope?: string; isQuiet?: boolean }
const gradeAll = ($: EngineInterface, options: RunOptions = {}): Promise<string> => busy($, () => gradeAllNow($, options))
const gradeAllNow = async ($: EngineInterface, { isFresh = false, only, scope, isQuiet = false }: RunOptions): Promise<string> => {
  const before = await read($, existing)
  if (before.state === 'running') return 'Grading is already under way; wait for it to finish.'
  const cwd = await projectDir($)
  const fail = async (message: string): Promise<string> => {
    await update($, existing, () => ({ state: 'failed' as const, done: 0, total: 0, message, results: before.results, hashes: before.hashes }))
    return message
  }
  const stop = new AbortController()
  stopRun = stop
  try {
    const listed = only ?? (await testFiles($, cwd))
    if (listed === null) return await fail('Not a git repository: there is no list of test files to grade.')
    const files = only ? listed.filter(f => TEST_FILE.test(f)) : listed
    // nothing to grade: the pane says why, and Claude is told nothing
    if (!only && files.length === 0) {
      const ignored = (await $.process.run(['git', 'check-ignore', '-q', '.'], { cwd, timeoutMs: 10_000 }).catch(() => null))?.exitCode === 0
      return await fail(ignored ? `No test files in ${cwd}: git ignores this folder. Open the session in the project's root to grade its tests.` : `No test files in ${cwd}: git lists none here.`)
    }
    const inRun = new Set(files.map(rel => `${cwd}/${rel}`))
    // a narrowed run leaves the other files' results be
    const others = only ? before.results.filter(t => !inRun.has(t.file)) : []
    await update($, existing, r => ({ ...r, state: 'running' as const, done: 0, total: files.length, isFresh, ...(only ? { only } : {}), ...(scope ? { scope } : {}) }))
    const hashes: Record<string, string> = {}
    const spent: Spent = { input: 0, cached: 0, output: 0, cost: 0, unpriced: 0 }
    // tests whose results stand from before
    let remembered = 0
    // every file's batches, in file order; a file is done when its last batch is. Until the
    // grader answers a batch, its tests are listed as they were, marked reviewing
    // was: the batch's rows as they stood before the run, for a stop to put back
    type Slot = { items: ExistingTest[]; waiting: ExistingTest[]; was: ExistingTest[]; isDone: boolean }
    type Entry = { file: string; left: number; slots: Slot[]; hash?: string }
    const jobs: { file: string; text: string; batch: string[]; slot: Slot; prior: ExistingTest[] }[] = []
    const runFiles: RunFiles = { changed: [], added: [] }
    const perFile: Entry[] = []
    const shown = (): ExistingTest[] => [...others, ...perFile.flatMap(f => f.slots.flatMap(s => (s.isDone ? s.items : s.waiting)))]
    let done = 0
    let skipped = 0
    // the files are read while the first are graded: a worker waits for the reading when it
    // has caught up with it
    let isRead = false
    let wake: (() => void) | null = null
    const ready = (): void => {
      wake?.()
      wake = null
    }
    const owner = new Map<Slot, Entry>()
    const reading = (async () => {
      for (const rel of files) {
        if (stop.signal.aborted) break
        const file = `${cwd}/${rel}`
        // a file git lists but that cannot be read (deleted, too large) is passed over
        const text = await $.fs.read(file).catch(() => null)
        if (text === null) {
          skipped += 1
          done += 1
          continue
        }
        const hash = fingerprint(text)
        lastText.set(file, text)
        const was = before.hashes?.[file]
        // new files are named once the project has been graded before: on its first run, all are
        if (was === undefined) {
          if (Object.keys(before.hashes ?? {}).length > 0 && !before.results.some(t => t.file === file && t.verdict !== undefined)) runFiles.added.push(rel)
        } else if (was !== hash) runFiles.changed.push(rel)
        const names = [...new Set(caseNames(text, file))]
        const entry: Entry = { file, left: 0, slots: [], hash }
        // unchanged since its last grading, and every test rated: its results stand
        const kept = before.results.filter(t => t.file === file)
        if (!isFresh && before.hashes?.[file] === hash && kept.length > 0 && kept.every(t => t.verdict !== undefined)) {
          entry.slots.push({ items: kept, waiting: kept, was: kept, isDone: true })
          perFile.push(entry)
          hashes[file] = hash
          remembered += kept.length
          done += 1
          continue
        }
        // a test graded on evidence, its own text unchanged since, keeps that grade; so does
        // every rated test of a file unchanged since its last grading, short of a regrade
        const isSame = !isFresh && before.hashes?.[file] === hash
        const held = kept.filter(t => isHeld(t, text, file) || (isSame && t.verdict !== undefined))
        const toGrade = names.filter(name => !held.some(t => fits(name, t.name)))
        if (held.length > 0) {
          entry.slots.push({ items: held, waiting: held, was: held, isDone: true })
          remembered += held.length
        }
        for (let at = 0; at < toGrade.length; at += BATCH) {
          const batch = toGrade.slice(at, at + BATCH)
          const was = batch.flatMap(name => {
            const had = kept.filter(t => fits(name, t.name))
            return had.length > 0 ? had : [{ file, name, isUngraded: true }]
          })
          const waiting = was.map(({ isUngraded: _, ...t }) => ({ ...t, isPending: true }))
          const slot: Slot = { items: [], waiting, was, isDone: false }
          entry.slots.push(slot)
          owner.set(slot, entry)
          entry.left += 1
          // a file unchanged since: the grader sees the grades its tests had, to keep them steady
          const prior = before.hashes?.[file] === hash ? kept.filter(t => t.verdict !== undefined && batch.some(name => fits(name, t.name))) : []
          jobs.push({ file, text, batch, slot, prior })
        }
        perFile.push(entry)
        if (entry.left === 0) {
          hashes[file] = hash
          done += 1
        }
        ready()
      }
      isRead = true
      ready()
      await update($, existing, r => ({ ...r, done, results: shown() }))
    })()
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stop.signal.aborted) return
        if (next >= jobs.length) {
          if (isRead) return
          await new Promise<void>(r => {
            const before = wake
            wake = () => (before?.(), r())
          })
          continue
        }
        const { file, text, batch, slot, prior } = jobs[next++]!
        const priorGrades = prior.map(t => ({ name: t.name, verdict: t.verdict!, ...(t.reason ? { reason: t.reason } : {}) }))
        const verdicts = (await grade($, file, text, batch, { signal: stop.signal, spent, ...(priorGrades.length > 0 ? { prior: priorGrades } : {}) }).catch(async (err: unknown) => (await noteFailed($, file, batch, err), null))) ?? []
        // cut by a stop: the batch keeps what it had
        if (stop.signal.aborted) return
        const suites = suitesOf(text, file)
        const why = await unratedOf($, file)
        for (const name of batch) {
          const suite = suites.has(name) ? { suite: suites.get(name) } : {}
          const found = verdicts.filter(v => fits(name, v.name))
          if (found.length === 0) slot.items.push({ file, name, ...suite, ...why(name) })
          for (const v of found) slot.items.push({ file, name: v.name, verdict: v.verdict, summary: v.summary, reason: v.reason, ...(v.confidence ? { confidence: v.confidence } : {}), ...suite })
        }
        slot.isDone = true
        const entry = owner.get(slot)!
        entry.left -= 1
        if (entry.left === 0) {
          hashes[entry.file] = entry.hash!
          done += 1
        }
        await update($, existing, r => ({ ...r, done, results: shown() }))
      }
    }
    await Promise.all([reading, ...Array.from({ length: parallel }, worker)])
    const isStopped = stop.signal.aborted
    // stopped: a batch not graded lists its tests as they were, not reviewing
    for (const f of perFile) for (const slot of f.slots) if (!slot.isDone) slot.waiting = slot.was
    const results = shown()
    const finishedAt = await $.clock.now()
    const graded = perFile.flatMap(f => f.slots.filter(s => s.isDone && s.items !== s.was).flatMap(s => s.items)).length
    // a file not graded keeps its last fingerprint, so the next run grades it
    const kept = Object.fromEntries(Object.entries(before.hashes ?? {}).filter(([f]) => !inRun.has(f) || hashes[f] === undefined))
    const allHashes = only || isStopped ? { ...kept, ...hashes } : hashes
    await update($, existing, (): ExistingRun => ({
      state: 'idle' as const,
      done,
      total: files.length,
      results,
      finishedAt,
      hashes: allHashes,
      graded,
      remembered,
      spent,
      ...(isStopped ? { message: `Stopped: ${done} of ${files.length} files graded.` } : skipped > 0 ? { message: skipped === 1 ? '1 file could not be read, and was passed over.' : `${skipped} files could not be read, and were passed over.` } : {}),
    }))
    await saveGrades($)
    await update($, seen, all => ({ ...all, ...hashes }))
    if (isStopped) return `Stopped: ${done} of ${files.length} files graded.`
    const told = results.filter(t => inRun.has(t.file))
    const note = existingNote(told, cwd, scope, runFiles)
    if (!isQuiet) await share($, note)
    return note
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err))
  } finally {
    if (stopRun === stop) stopRun = null
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

// After the session writes a test file: entries for cases no longer in it leave both lists,
// and the flagged and unrated ones the change touched are graded again
const refresh = async ($: EngineInterface, file: string, touched: string[]): Promise<void> => {
  let text: string
  try {
    text = await $.fs.read(file)
  } catch {
    return
  }
  const present = caseNames(text, file)
  // every test the change touched is graded again: a strong grade may not hold for its new text
  // but one graded on evidence whose own text is as it was keeps that grade
  const isRedo = (t: { file: string; name: string; verdict?: Verdict; evidence?: string; evidenceOf?: string }): boolean => t.file === file && among(touched, t.name) && !isHeld(t, text, file)
  const known = new Set([...(await read($, existing)).results, ...(await read($, tests))].filter(t => t.file === file && among(touched, t.name) && among(present, t.name)).map(t => `${t.file}:${t.name}`))
  if (known.size > 0) await update($, modified, all => [...new Set([...all, ...known])].slice(-MAX_TESTS))

  const now = await read($, tests)
  const redoTests = now.filter(t => isRedo(t) && t.status !== 'pending' && among(present, t.name))
  const redoNew = new Map(redoTests.map(t => [t.id, t.name]))
  // stamped now: its new grade is newer than any Grade all run's, and is the one shown
  const at = await $.clock.now()
  await update($, tests, list =>
    list
      .filter(t => t.file !== file || t.status === 'pending' || among(present, t.name))
      .map(t => (redoNew.has(t.id) ? { ...t, at, status: 'pending' as const, verdict: undefined, summary: undefined, reason: undefined } : t)),
  )
  // a test its last grade flagged gets the second look, when one is set; the rest the grader
  for (const isSecond of [true, false]) {
    const ids = new Map(redoTests.filter(t => isFlagged(t.verdict) === isSecond).map(t => [t.id, t.name]))
    if (ids.size > 0) soon($, () => evaluate($, file, ids, isSecond ? (escalateModel ?? undefined) : undefined))
  }

  const run = await read($, existing)
  const kept = run.results.filter(t => t.file !== file || among(present, t.name))
  // a test the session's own list grades again is not graded twice: its newer grade wins the row
  const redoing = new Set(redoNew.values())
  const redoRows = kept.filter(t => isRedo(t) && !t.isPending && !redoing.has(t.name))
  const redo = redoRows.map(t => t.name)
  if (kept.length === run.results.length && redo.length === 0) return
  const pick = (t: ExistingTest): boolean => t.file === file && redo.includes(t.name)
  await update($, existing, r => ({
    ...r,
    results: r.results.filter(t => t.file !== file || among(present, t.name)).map(t => (pick(t) ? { ...t, isPending: true } : t)),
  }))
  if (redo.length === 0) return
  for (const isSecond of [true, false]) {
    const names = redoRows.filter(t => isFlagged(t.verdict) === isSecond).map(t => t.name)
    if (names.length > 0) soon($, () => regradeRows($, file, text, names, isSecond ? (escalateModel ?? undefined) : undefined))
  }
}

// these rows of a file, as Grade all lists them, graded again, their reviewing marks cleared;
// model: the second look, for rows a grade flagged
const regradeRows = ($: EngineInterface, file: string, text: string, names: string[], model?: string): Promise<void> =>
  busy($, async () => {
    const pick = (t: ExistingTest): boolean => t.file === file && names.includes(t.name)
    let verdicts: Graded[] | null = null
    // the file changed under the grade: graded again on its new text, not kept for the old
    for (let tries = 0, at = text; tries <= MAX_STALE; tries++) {
      verdicts = await grade($, file, at, names, { model }).catch(async (err: unknown) => (await noteFailed($, file, names, err), null))
      const now = verdicts === null || tries === MAX_STALE ? null : await staleOf($, file, at, names)
      if (now === null) break
      at = now
    }
    await reportGrades($, names.flatMap(name => {
      const v = verdicts?.find(x => x.name === name)
      return v ? [{ file, name, verdict: v.verdict, reason: v.reason }] : []
    }))
    const why = await unratedOf($, file)
    await update($, existing, r => ({
      ...r,
      results: r.results.map(t => {
        if (!pick(t)) return t
        const v = verdicts?.find(x => x.name === t.name)
        return { file: t.file, name: t.name, ...(t.suite ? { suite: t.suite } : {}), ...(v ? { verdict: v.verdict, summary: v.summary, reason: v.reason, ...(v.confidence ? { confidence: v.confidence } : {}) } : why(t.name)) }
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
    await update($, existing, ({ isFresh: _, only: _o, scope: _s, ...r }): ExistingRun => ({ ...r, state: 'idle', results: r.results.map(({ isPending: _p, ...t }) => t) }))
    soon($, async () => void (await gradeAll($, { isFresh: run.isFresh === true, ...(run.only ? { only: run.only } : {}), ...(run.scope ? { scope: run.scope } : {}) })))
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
// gone tests leave, its flagged and unrated ones are graded again, and new ones are added.
// Last seen: as Write, Edit or Grade all left it, else as its last grading fingerprinted it
// each file's modification time as catchUp last read it, in this load of the module
const readAt = new Map<string, number>()
// each listed test file's text as last read, in this load of the module: a change made by other
// means is compared with it test by test, so only the tests it touched are graded again
const lastText = new Map<string, string>()
const catchUp = async ($: EngineInterface): Promise<void> => {
  const cwd = await projectDir($)
  const run = await read($, existing)
  const files = [...new Set([...(await read($, tests)).map(t => t.file), ...run.results.map(t => t.file)])].filter(f => cwd !== '' && f.startsWith(`${cwd}/`))
  const last = await read($, seen)
  for (const file of files) {
    // a file not modified since last read is passed over unread
    const at = await mtime($, file)
    if (at !== null && readAt.get(file) === at && last[file] !== undefined) continue
    const text = await $.fs.read(file).catch(() => null)
    if (text === null) continue
    if (at !== null) readAt.set(file, at)
    const prior = lastText.get(file)
    lastText.set(file, text)
    const now = fingerprint(text)
    const before = last[file] ?? run.hashes?.[file]
    if (before === now) continue
    await update($, seen, all => ({ ...all, [file]: now }))
    if (before === undefined) continue
    const names = caseNames(text, file)
    // the tests whose text changed; every one, where the file's text before is not known
    await refresh($, file, prior !== undefined ? changedCases(prior, text, file) : names)
    const known = [...(await read($, tests)).filter(t => t.file === file), ...(await read($, existing)).results.filter(t => t.file === file)].map(t => t.name)
    const fresh = [...new Set(names)].filter(n => !among(known, n) && !known.some(k => fits(n, k)))
    if (fresh.length > 0) await track($, file, fresh)
  }
}

// A grade the session kept from before the grades were renamed (good, weak, useless), as the
// nearest grade now: the session's state outlives a reload of this mod
const renamed = <T extends { verdict?: Verdict }>(t: T): T => {
  const v = verdictOf(t.verdict)
  return v === t.verdict ? t : { ...t, verdict: v }
}
const renameGrades = async ($: EngineInterface): Promise<void> => {
  await update($, tests, list => list.map(renamed))
  await update($, existing, r => ({ ...r, results: r.results.map(renamed) }))
  await update($, outbox, b => ({ accepted: b.accepted.map(renamed), going: b.going.map(renamed), spent: b.spent.map(renamed) }))
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
  const cwd = await projectDir($)
  const listed = await testFiles($, cwd)
  if (listed === null) return
  const files = listed.map(rel => `${cwd}/${rel}`)
  const run = await read($, existing)
  const cases: ExistingTest[] = []
  const hashes: Record<string, string> = {}
  for (const file of files) {
    const text = await $.fs.read(file).catch(() => null)
    if (text === null) continue
    hashes[file] = fingerprint(text)
    lastText.set(file, text)
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

// A test file the pane does not list yet, made by the shell, an editor or a checkout, is
// listed ungraded; a listed one git no longer has and that cannot be read leaves
const listNew = async ($: EngineInterface): Promise<void> => {
  const cwd = await projectDir($)
  const listed = await testFiles($, cwd)
  if (listed === null) return
  const files = new Set(listed.map(rel => `${cwd}/${rel}`))
  const run = await read($, existing)
  if (run.state === 'running') return
  const known = new Set([...run.results.map(t => t.file), ...(await read($, tests)).map(t => t.file)])
  const cases: ExistingTest[] = []
  const hashes: Record<string, string> = {}
  for (const file of files) {
    if (known.has(file)) continue
    const text = await $.fs.read(file).catch(() => null)
    if (text === null) continue
    hashes[file] = fingerprint(text)
    lastText.set(file, text)
    const suites = suitesOf(text, file)
    for (const name of new Set(caseNames(text, file))) cases.push({ file, name, isUngraded: true, ...(suites.has(name) ? { suite: suites.get(name) } : {}) })
  }
  const gone: string[] = []
  for (const file of known) {
    if (file.startsWith(`${cwd}/`) && !files.has(file) && (await mtime($, file)) === null) gone.push(file)
  }
  if (cases.length === 0 && gone.length === 0) return
  const isGone = (t: { file: string }): boolean => gone.includes(t.file)
  await update($, existing, r => (r.state === 'running' ? r : { ...r, results: [...r.results.filter(t => !isGone(t) && !(t.file in hashes)), ...cases] }))
  await update($, tests, list => list.filter(t => t.status === 'pending' || !isGone(t)))
  await update($, seen, all => ({ ...Object.fromEntries(Object.entries(all).filter(([f]) => !gone.includes(f))), ...hashes }))
  if (gone.length > 0) await saveGrades($)
}

// The pane kept current as files change, not only at a turn's end: every WATCH_MS the listed
// test files are checked for a change (by modification time, so an unchanged one is not
// read), and every LIST_EVERY checks, or right after a shell command, the project's test files
// are listed again for new and removed ones. One check at a time
const WATCH_MS = 2000
const LIST_EVERY = 5
let checks = 0
// the check under way: a timer's check is passed over while one runs; a listing one waits for it
let checking: Promise<void> | null = null
let watcher: Timer | null = null
// The project is the folder the session started in: a session that moves to a subfolder (cd
// in a command, a tool changing its folder) keeps the same tests, coverage and rules. A
// reload or compaction starts the same session again and keeps it; a new session takes its own
const projectDir = async ($: EngineInterface): Promise<string> => (await read($, root))?.dir ?? (await $.session.cwd())
const pinProject = async ($: EngineInterface): Promise<void> => {
  const id = await $.session.id().catch(() => null)
  const pinned = await read($, root)
  if (pinned !== null && pinned.session === id) return
  const dir = await $.session.cwd()
  await update($, root, () => ({ session: id, dir }))
}

// What the project offers, found as a session starts: its test runners, its coverage run (the
// pane offers Run coverage only then), its report, and its rules
const detectProject = async ($: EngineInterface): Promise<void> => {
  const cwd = await projectDir($)
  runners = await detectRunners($, cwd).catch(() => ({}))
  await refreshCoverage($)
  const cover = await detectCommand($, cwd).catch(() => undefined)
  await update($, coverWith, () => cover?.label ?? null)
  await readRules($).catch(() => undefined)
}

const check = async ($: EngineInterface, isListing = false): Promise<void> => {
  if (checking !== null && !isListing) return
  const after = checking ?? Promise.resolve()
  const now = after.then(async () => {
    checks += 1
    if (isListing || checks % LIST_EVERY === 0) await listNew($).catch(() => undefined)
    await catchUp($).catch(() => undefined)
    await refreshCoverageIfChanged($).catch(() => undefined)
  })
  checking = now
  try {
    await now
  } finally {
    if (checking === now) checking = null
  }
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
      if (done.exitCode === 0) return void (await update($, openError, () => null))
      why = done.stderr.trim() || `exit ${done.exitCode}`
    } catch (err) {
      why = err instanceof Error ? err.message : String(err)
    }
  }
  const cwd = await projectDir($)
  await update($, openError, () => `Couldn't open ${shortPath(file, cwd)} in an editor: ${why}`)
}

// One list: the last Grade all tests run and the tests written this session, a test in
// both once, with the newer verdict; one written this session is marked new
// isModified: a test that was there before, edited this session (a new one is new, not modified)
type Entry = { file: string; name: string; state: State; summary?: string; reason?: string; confidence?: Confidence; isNew: boolean; isModified?: boolean; suite?: string; evidence?: string }
const entriesOf = (graded: ExistingRun, list: TrackedTest[], edited: string[] = []): Entry[] => {
  const merged = new Map<string, Entry>()
  for (const t of graded.results) {
    const state: State = t.isPending ? 'reviewing' : t.isUngraded ? 'ungraded' : (verdictOf(t.verdict) ?? 'unrated')
    merged.set(`${t.file}:${t.name}`, { file: t.file, name: t.name, state, summary: t.summary, reason: t.reason, ...(t.confidence ? { confidence: t.confidence } : {}), isNew: false, suite: t.suite, evidence: t.evidence })
  }
  for (const t of list) {
    const key = `${t.file}:${t.name}`
    const prev = merged.get(key)
    const state: State = t.status === 'pending' ? 'reviewing' : t.status === 'failed' ? 'unrated' : (verdictOf(t.verdict) ?? 'unrated')
    const isNewer = !prev || graded.finishedAt === undefined || t.at >= graded.finishedAt
    merged.set(key, isNewer ? { file: t.file, name: t.name, state, summary: t.summary, reason: t.reason, ...(t.confidence ? { confidence: t.confidence } : {}), isNew: true, suite: t.suite ?? prev?.suite, evidence: t.evidence ?? prev?.evidence } : { ...prev, isNew: true })
  }
  for (const key of edited) {
    const t = merged.get(key)
    if (t && !t.isNew) merged.set(key, { ...t, isModified: true })
  }
  return [...merged.values()]
}

// The test regraded with the session's evidence; its verdict replaces the one in both lists
const answerEvidence = async ($: EngineInterface, input: { file?: unknown; test?: unknown; evidence?: unknown }): Promise<string> => {
  const cwd = await projectDir($)
  const file = inProject(cwd, String(input.file ?? ''))
  const name = String(input.test ?? '')
  const evidence = String(input.evidence ?? '').trim().slice(0, EVIDENCE_MAX)
  if (!evidence) return 'No evidence was given. Nothing was regraded.'
  const text = await $.fs.read(file).catch(() => null)
  if (text === null) return `There is no file ${shortPath(file, cwd)}. Nothing was regraded.`
  const caseName = [...new Set(caseNames(text, file))].find(n => fits(n, name))
  if (caseName === undefined) return `There is no test named ${JSON.stringify(name)} in ${shortPath(file, cwd)}. Nothing was regraded.`
  return regradeOnEvidence($, file, text, name, caseName, evidence)
}

// a path the session gave: absolute, or in the project
const inProject = (cwd: string, given: string): string => (given.startsWith('/') ? given : `${cwd}/${given.replace(/^\.\//, '')}`)

const regradeOnEvidence = async ($: EngineInterface, file: string, text: string, name: string, caseName: string, evidence: string, isMeasured = false): Promise<string> => {
  const before = [...(await read($, existing)).results, ...(await read($, tests))].find(t => t.file === file && t.name === name)?.verdict
  const verdicts = await grade($, file, text, [caseName], { evidence, isMeasured, model: escalateModel ?? undefined }).catch(() => null)
  const v = verdicts?.find(x => x.name === name) ?? verdicts?.find(x => fits(caseName, x.name))
  if (!v) return `${(await unratedOf($, file))(name).reason ?? 'The grader gave no verdict.'} Nothing was regraded; send it again.`
  const judged = { verdict: v.verdict, summary: v.summary, reason: v.reason, confidence: v.confidence, evidence, evidenceOf: ownText(text, caseName, file) }
  const suite = suitesOf(text, file).get(caseName)
  await update($, existing, r => ({
    ...r,
    results: r.results.some(t => t.file === file && t.name === name)
      ? r.results.map(t => (t.file === file && t.name === name ? { ...t, ...judged, isPending: undefined, isUngraded: undefined } : t))
      : [...r.results, { file, name, ...(suite ? { suite } : {}), ...judged }],
  }))
  await update($, tests, list => list.map(t => (t.file === file && t.name === name && t.status !== 'pending' ? { ...t, status: 'done' as const, ...judged } : t)))
  await saveGrades($)
  const { round } = await countRound($, file, name, v.verdict)
  const left =
    round === 0 ? '' : round <= MAX_ROUNDS ? ` Strengthen it, or send other evidence (round ${round} of ${MAX_ROUNDS}).` : ' test-grader has stopped asking about this test: tell the person what is left.'
  return `${v.verdict === before ? 'Still' : 'Now'} ${v.verdict}: ${v.reason}${left}`
}

// What the project runs its tests with, found at its root as a session starts
let runners: Runners = {}
const detectRunners = async ($: EngineInterface, cwd: string): Promise<Runners> => {
  const has = async (name: string): Promise<boolean> => (await mtime($, `${cwd}/${name}`)) !== null
  const pkg = (await has('package.json')) ? await $.fs.read(`${cwd}/package.json`).catch(() => '') : ''
  const composer = (await has('composer.json')) ? await $.fs.read(`${cwd}/composer.json`).catch(() => '') : ''
  return {
    ...(/"vitest"/.test(pkg) ? { js: 'vitest' as const } : /"jest"/.test(pkg) ? { js: 'jest' as const } : /"@playwright\/test"/.test(pkg) ? { js: 'playwright' as const } : {}),
    ...((await has('build.gradle')) || (await has('build.gradle.kts')) ? { jvm: 'gradle' as const } : (await has('pom.xml')) ? { jvm: 'maven' as const } : {}),
    ...((await has('Gemfile')) ? { isBundled: true } : {}),
    ...(/"pestphp\/pest"/.test(composer) ? { isPest: true } : {}),
  }
}

// a test as its runner names it, found in its file as it is now
const targetOf = (cwd: string, file: string, text: string, name: string): RunTarget | null => {
  const found = casesIn(text, file).find(c => fits(c.name, name))
  if (!found) return null
  const suite = suitesOf(text, file).get(found.plain)
  return { rel: shortPath(file, cwd), kind: kindOf(file), plain: found.plain, groups: found.groups, line: text.slice(0, found.opens).split('\n').length, ...(suite ? { suite } : {}) }
}

// One test run by the project's runner: whether it passed, and the end of what it printed
const RUN_TAIL = 12
const RUN_TIMEOUT = 300_000
type Ran = { isPassed: boolean; command: string; tail: string }
const runOne = async ($: EngineInterface, file: string, name: string): Promise<Ran | string> => {
  const cwd = await projectDir($)
  const text = await $.fs.read(file).catch(() => null)
  if (text === null) return `There is no file ${shortPath(file, cwd)}.`
  const target = targetOf(cwd, file, text, name)
  if (!target) return `There is no test named ${JSON.stringify(name)} in ${shortPath(file, cwd)}.`
  const argv = runArgv(target, runners)
  if (!argv) return `test-grader knows no way to run one test of ${shortPath(file, cwd)} in this project.`
  const result = await $.process.run(argv, { cwd, timeoutMs: RUN_TIMEOUT })
  return { isPassed: result.exitCode === 0, command: shown(argv), tail: tailOf([result.stdout, result.stderr].join('\n'), RUN_TAIL) }
}

// a test run from the pane: its row shows it running, then passed or failed with the end of
// what it printed
const runFromPane = async ($: EngineInterface, file: string, name: string): Promise<void> => {
  const key = `${file}:${name}`
  await update($, testRuns, all => ({ ...all, [key]: { state: 'running' as const } }))
  const ran = await runOne($, file, name).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
  await update($, testRuns, all => ({
    ...all,
    [key]: typeof ran === 'string' ? { state: 'failed' as const, tail: ran } : { state: ran.isPassed ? ('passed' as const) : ('failed' as const), command: ran.command, tail: ran.tail },
  }))
}

const answerVerify = async ($: EngineInterface, input: { file?: unknown; test?: unknown; mutate?: unknown; find?: unknown; replace?: unknown; siblings?: unknown }): Promise<string> => {
  const cwd = await projectDir($)
  const file = inProject(cwd, String(input.file ?? ''))
  const name = String(input.test ?? '')
  const target = inProject(cwd, String(input.mutate ?? ''))
  const find = String(input.find ?? '')
  const replace = String(input.replace ?? '')
  if (TEST_FILE.test(target)) return `${shortPath(target, cwd)} is a test file: mutate the code under test. Nothing was run.`
  if (find === '' || find === replace) return 'The mutation changes nothing: give the text to find and a different text to replace it with. Nothing was run.'
  const text = await $.fs.read(file).catch(() => null)
  if (text === null) return `There is no file ${shortPath(file, cwd)}. Nothing was run.`
  const caseName = [...new Set(caseNames(text, file))].find(n => fits(n, name))
  if (caseName === undefined) return `There is no test named ${JSON.stringify(name)} in ${shortPath(file, cwd)}. Nothing was run.`
  const original = await $.fs.read(target).catch(() => null)
  if (original === null) return `There is no file ${shortPath(target, cwd)} to mutate. Nothing was run.`
  const count = original.split(find).length - 1
  if (count !== 1) return `The text to find is in ${shortPath(target, cwd)} ${count} times, not once: give a piece found exactly once. Nothing was run.`

  const clean = await runOne($, file, name)
  if (typeof clean === 'string') return `${clean} Nothing was run.`
  if (!clean.isPassed) return `The test fails unchanged, so a mutation shows nothing. ${clean.command} printed:\n${clean.tail}`
  let mutated: Ran | string
  // with siblings: the file's other tests under the same mutation, the failing ones run again
  // unchanged after, so a test that fails anyway is not counted as catching it
  const others = input.siblings === true ? [...new Set(caseNames(text, file))].filter(n => n !== caseName && !isTemplate(n)) : []
  const tried = others.slice(0, VERIFY_SIBLINGS)
  const alsoFailed: string[] = []
  try {
    await $.fs.write(target, original.replace(find, replace))
    mutated = await runOne($, file, name).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    if (typeof mutated !== 'string' && !mutated.isPassed && !isBuildFailure(mutated.tail)) {
      for (const other of tried) {
        const ran = await runOne($, file, other).catch(() => null)
        if (ran !== null && typeof ran !== 'string' && !ran.isPassed) alsoFailed.push(other)
      }
    }
  } finally {
    await $.fs.write(target, original)
  }
  const failsAnyway = new Set<string>()
  for (const other of alsoFailed) {
    const ran = await runOne($, file, other).catch(() => null)
    if (ran === null || typeof ran === 'string' || !ran.isPassed) failsAnyway.add(other)
  }
  const caught = alsoFailed.filter(n => !failsAnyway.has(n))
  const siblingsSaid =
    tried.length === 0
      ? []
      : [
          caught.length === 0
            ? `No other test in the file failed with it (${tried.length} run): this test alone catches the change.`
            : `Other tests in the file also failed with it: ${caught.map(n => JSON.stringify(n)).join(', ')} (of ${tried.length} run).`,
          ...(failsAnyway.size > 0 ? [`${[...failsAnyway].map(n => JSON.stringify(n)).join(', ')} failed unchanged too, so ${failsAnyway.size === 1 ? 'it is' : 'they are'} not counted.`] : []),
          ...(others.length > tried.length ? [`${others.length - tried.length} more were not run: the limit is ${VERIFY_SIBLINGS}.`] : []),
        ]
  if ((await $.fs.read(target).catch(() => null)) !== original) return `test-grader could not put ${shortPath(target, cwd)} back as it was: check it now.`
  if (typeof mutated === 'string') return `The run with the mutation failed to start: ${mutated}. The file is back as it was; nothing was regraded.`
  // a failure to build is no test failing: it measures nothing
  if (!mutated.isPassed && isBuildFailure(mutated.tail)) {
    return `The mutated code did not build, so the test never ran: that measures nothing. Pick a change that compiles and alters behaviour. The end of the output:\n${mutated.tail}\nThe file is back as it was; nothing was regraded.`
  }
  if (mutated.isPassed) {
    return `The test still passes with ${JSON.stringify(find)} replaced by ${JSON.stringify(replace)} in ${shortPath(target, cwd)}: it does not catch that change. The file is back as it was; nothing was regraded.`
  }
  const evidence = clamp(
    [
      `Measured by test-grader, not claimed: ${clean.command} passed with the code unchanged.`,
      `With ${JSON.stringify(find)} replaced by ${JSON.stringify(replace)} in ${shortPath(target, cwd)}, the same command failed.`,
      ...siblingsSaid,
      'The end of its output:',
      mutated.tail,
    ].join('\n'),
    EVIDENCE_MAX,
  )
  return `Measured: the test passes unchanged and fails with the mutation.${siblingsSaid.length > 0 ? ` ${siblingsSaid.join(' ')}` : ''} ${await regradeOnEvidence($, file, text, name, caseName, evidence, true)}`
}

const answerGrades = async ($: EngineInterface, input: { verdicts?: unknown; path?: unknown; limit?: unknown; written?: unknown }): Promise<string> => {
  const cwd = await projectDir($)
  const asked = Array.isArray(input.verdicts) ? input.verdicts.filter((v): v is State => (LISTED as readonly unknown[]).includes(v)) : []
  const wanted = new Set<State>(asked.length > 0 ? asked : FLAGGED)
  const given = typeof input.path === 'string' ? input.path.trim().replace(/\/+$/, '') : ''
  const scope = given === '' || given === '.' ? '' : given.startsWith('/') ? given : `${cwd}/${given.replace(/^\.\//, '')}`
  const limit = typeof input.limit === 'number' && input.limit >= 1 ? Math.floor(input.limit) : GRADES_LIMIT
  const isWritten = input.written === true
  const inScope = entriesOf(await read($, existing), await read($, tests), await read($, modified)).filter(
    t => (scope === '' || t.file === scope || t.file.startsWith(`${scope}/`)) && (!isWritten || t.isNew || t.isModified === true),
  )
  const where = (isWritten ? ' written or edited this session' : '') + (scope === '' ? '' : ` in ${shortPath(scope, cwd)}`)
  if (inScope.length === 0) return `test-grader lists no tests${where}.`
  const count = (s: State): number => inScope.filter(t => t.state === s).length
  const head =
    `${inScope.length} tests${where}: ${count('strong')} strong` +
    FLAGGED.map(v => (count(v) > 0 ? `, ${count(v)} ${v}` : '')).join('') +
    [['unrated', 'with no verdict'], ['reviewing', 'being graded'], ['ungraded', 'never graded']]
      .map(([s, label]) => (count(s as State) > 0 ? `, ${count(s as State)} ${label}` : ''))
      .join('') +
    '.'
  const chosen = inScope.filter(t => wanted.has(t.state)).sort((a, b) => LISTED.indexOf(a.state) - LISTED.indexOf(b.state) || a.file.localeCompare(b.file))
  // the four flagged grades asked together are named as one
  const isFlaggedAll = FLAGGED.every(v => wanted.has(v))
  const names = [...(isFlaggedAll ? ['flagged'] : []), ...[...wanted].filter(s => !isFlaggedAll || !isFlagged(verdictOf(s)))]
    .sort((a, b) => LISTED.indexOf(a as State) - LISTED.indexOf(b as State))
    .join(' or ')
  const waiting = count('reviewing') > 0 ? `\n${count('reviewing')} still being graded: ask again in a moment for their grades.` : ''
  if (chosen.length === 0) {
    const hint = count('ungraded') > 0 ? ' Grade all tests in the Tests pane grades the ones never graded.' : ''
    return `${head}\nNone is ${names}.${hint}${waiting}`
  }
  const shown = chosen.slice(0, limit)
  const texts = new Map<string, string | null>()
  const counted = await read($, rounds)
  const lines: string[] = []
  for (const t of shown) {
    if (!texts.has(t.file)) texts.set(t.file, await $.fs.read(t.file).catch(() => null))
    const text = texts.get(t.file)
    const at = text ? `:${caseLine(text, t.name, t.file)}` : ''
    const round = counted[roundKey(t.file, t.name)]
    lines.push(
      `- ${shortPath(t.file, cwd)}${at} ${JSON.stringify(t.name)}: ${t.state}${unsure(t)}` +
        (round ? (round > MAX_ROUNDS ? ` (${MAX_ROUNDS} rounds spent: test-grader has stopped on it)` : ` (round ${round} of ${MAX_ROUNDS})`) : '') +
        (t.summary ? `\n  Checks: ${t.summary}` : '') +
        (t.reason ? `\n  Why: ${t.reason}` : '') +
        (t.evidence ? '\n  Graded on evidence.' : ''),
    )
  }
  const more = chosen.length > shown.length ? `\n${chosen.length - shown.length} more not listed; raise limit or narrow path to see them.` : ''
  const act = shown.some(t => isFlagged(verdictOf(t.state))) ? `\n${EVIDENCE_HINT}` : ''
  return `${head}\n${names[0]!.toUpperCase()}${names.slice(1)}, worst first:\n${lines.join('\n')}${more}${act}${waiting}`
}

// The test files this branch changed: against where it left main (or master, or the remote's
// default), with the changes not committed yet and new files; null outside a git repository
const branchFiles = async ($: EngineInterface, cwd: string): Promise<{ base: string; files: string[] } | string> => {
  const git = (argv: string[]) => $.process.run(['git', ...argv], { cwd, timeoutMs: 60_000 })
  let base: string | null = null
  for (const ref of ['origin/HEAD', 'main', 'master', 'origin/main', 'origin/master']) {
    const found = await git(['merge-base', 'HEAD', ref])
    if (found.exitCode === 0 && found.stdout.trim()) {
      base = ref
      break
    }
  }
  if (base === null) return 'No main or master branch to compare with: /test-grader diff grades the test files changed since this branch left it.'
  const changed = await git(['diff', '--name-only', '--diff-filter=d', `${base}...`])
  const working = await git(['diff', '--name-only', '--diff-filter=d', 'HEAD'])
  const added = await git(['ls-files', '--others', '--exclude-standard'])
  if (changed.exitCode !== 0) return `git could not list the changes against ${base}: ${changed.stderr.trim()}`
  const files = [...new Set([changed, working, added].flatMap(r => (r.exitCode === 0 ? r.stdout.split('\n') : [])))].filter(f => f !== '' && TEST_FILE.test(f))
  return { base, files }
}

const gradeBranch = async ($: EngineInterface): Promise<string> => {
  if ((await read($, existing)).state === 'running') return 'Grading is already under way.'
  const found = await branchFiles($, await projectDir($))
  if (typeof found === 'string') return found
  if (found.files.length === 0) return `No test files changed against ${found.base}.`
  soon($, async () => void (await gradeAll($, { isFresh: true, only: found.files, scope: 'the files changed on this branch' })))
  return `Grading the ${found.files.length} test ${found.files.length === 1 ? 'file' : 'files'} changed against ${found.base}.`
}

// Claude's grade tool: a run over the project, or a file or folder of it, waited for, its note
// the answer. Short of again, the tests already rated in files unchanged since keep their grades
const answerGrade = async ($: EngineInterface, input: { path?: unknown; again?: unknown }): Promise<string> => {
  if ((await read($, existing)).state === 'running') return 'Grading is already under way; wait for it to finish, then call test_grades.'
  const cwd = await projectDir($)
  const given = typeof input.path === 'string' ? input.path.trim().replace(/\/+$/, '').replace(/^\.\//, '') : ''
  const abs = given === '' || given === '.' ? cwd : given.startsWith('/') ? given : `${cwd}/${given}`
  const isFresh = input.again === true
  if (abs === cwd) return gradeAll($, { isFresh, isQuiet: true })
  if (!abs.startsWith(`${cwd}/`)) return `${given} is outside the project (${cwd}).`
  const rel = abs.slice(cwd.length + 1)
  const listed = await testFiles($, cwd)
  if (listed === null) return 'Not a git repository: there is no list of test files to grade.'
  const only = listed.filter(f => f === rel || f.startsWith(`${rel}/`))
  if (only.length === 0) return `No test files in ${rel}.`
  return gradeAll($, { isFresh, only, scope: only.length === 1 && only[0] === rel ? rel : `${rel}/`, isQuiet: true })
}

// Claude's context tool: what a plain grade of this test sends the grader, past the rubric
const answerContext = async ($: EngineInterface, input: { file?: unknown; test?: unknown }): Promise<string> => {
  const cwd = await projectDir($)
  const file = inProject(cwd, String(input.file ?? ''))
  const name = String(input.test ?? '')
  const text = await $.fs.read(file).catch(() => null)
  if (text === null) return `There is no file ${shortPath(file, cwd)}.`
  const caseName = [...new Set(caseNames(text, file))].find(n => fits(n, name))
  if (caseName === undefined) return `There is no test named ${JSON.stringify(name)} in ${shortPath(file, cwd)}.`
  const { source, underTest, ask } = await askOf($, file, text, [name])
  const last = entriesOf(await read($, existing), await read($, tests)).find(t => t.file === file && t.name === name)
  const lines = [
    `What the grader reads for ${JSON.stringify(name)} in ${shortPath(file, cwd)}, as a plain grade sends it. A regrade of an unchanged file adds the last grades; evidence and a second look add theirs.`,
    `System: the grading rubric, the same for every test${projectRules ? `, then the project's rules (${RUBRIC_FILE}):\n${projectRules}` : '. The project has no rules file.'}`,
    source === text ? `The test file, whole (${text.length} characters):` : `The test file, as an excerpt (${source.length} of ${text.length} characters):`,
    '```',
    source,
    '```',
    underTest ? `The code under test:\n${underTest}` : 'No code under test was found for it: the grader judges the assertions without it.',
    `Asked:\n${ask}`,
    last ? `Its last grade: ${last.state}${unsure(last)}${last.reason ? `: ${last.reason}` : ''}` : 'It has no grade yet.',
  ]
  return clamp(lines.join('\n'), CONTEXT_MAX)
}

// The grades written out, for a review or CI: a Markdown page and its JSON, at the project's root
const REPORT = 'test-grader-report'
const writeReport = async ($: EngineInterface): Promise<string> => {
  const cwd = await projectDir($)
  if (!cwd) return 'No project folder to write the report to.'
  const entries = entriesOf(await read($, existing), (await read($, tests)).filter(t => t.file.startsWith(`${cwd}/`)), await read($, modified))
  if (entries.length === 0) return 'No tests to report: Grade all tests grades the project first.'
  const texts = new Map<string, string | null>()
  const rows: { file: string; line: number | null; name: string; state: State; summary: string | null; reason: string | null; onEvidence: boolean }[] = []
  for (const t of [...entries].sort((a, b) => LISTED.indexOf(a.state) - LISTED.indexOf(b.state) || a.file.localeCompare(b.file))) {
    if (!texts.has(t.file)) texts.set(t.file, await $.fs.read(t.file).catch(() => null))
    const text = texts.get(t.file)
    rows.push({ file: shortPath(t.file, cwd), line: text ? caseLine(text, t.name, t.file) : null, name: t.name, state: t.state, summary: t.summary ?? null, reason: t.reason ?? null, onEvidence: Boolean(t.evidence) })
  }
  const counts = Object.fromEntries(LISTED.map(s => [s, entries.filter(t => t.state === s).length]))
  const at = new Date(await $.clock.now()).toISOString()
  const cov = await read($, coverage)
  const md = [
    '# Test grades',
    '',
    `${entries.length} tests: ${LISTED.filter(s => counts[s]! > 0).map(s => `${counts[s]} ${s}`).join(', ')}. Graded by test-grader, ${at}.`,
    ...(cov?.lines != null ? ['', `Line coverage: ${cov.lines}% (${cov.source}).`] : []),
    ...LISTED.filter(s => s !== 'strong' && counts[s]! > 0).flatMap(s => [
      '',
      `## ${s[0]!.toUpperCase()}${s.slice(1)} (${counts[s]})`,
      '',
      ...rows.filter(r => r.state === s).map(r => `- \`${r.file}${r.line ? `:${r.line}` : ''}\` ${r.name}${r.reason ? `: ${r.reason}` : ''}`),
    ]),
    ...(counts.strong! > 0 ? ['', `## Strong (${counts.strong})`, '', ...rows.filter(r => r.state === 'strong').map(r => `- \`${r.file}${r.line ? `:${r.line}` : ''}\` ${r.name}`)] : []),
    '',
  ].join('\n')
  await $.fs.write(`${cwd}/${REPORT}.md`, md)
  await $.fs.write(`${cwd}/${REPORT}.json`, `${JSON.stringify({ generatedAt: at, counts, coverage: cov ? { lines: cov.lines, branches: cov.branches, functions: cov.functions, statements: cov.statements } : null, tests: rows }, null, 2)}\n`)
  const flagged = FLAGGED.filter(v => counts[v]! > 0).map(v => `${counts[v]} ${v}`)
  return `Wrote ${REPORT}.md and ${REPORT}.json: ${entries.length} tests, ${counts.strong} strong${flagged.length > 0 ? `, ${flagged.join(', ')}` : ''}.`
}

// After a turn that leaves tests it wrote flagged, the prompt box offers to fix
// them, once for each set of such tests
let suggestedFor = ''
const suggestStrengthening = async ($: EngineInterface): Promise<void> => {
  const counted = await read($, rounds)
  const flagged = (await read($, tests)).filter(t => t.status === 'done' && isFlagged(t.verdict) && (counted[roundKey(t.file, t.name)] ?? 1) <= MAX_ROUNDS)
  const key = flagged.map(t => `${t.file}:${t.name}`).sort().join('\n')
  if (flagged.length === 0 || key === suggestedFor) return
  suggestedFor = key
  const what = flagged.length === 1 ? `${flagged[0]!.verdict} test` : `${flagged.length} flagged tests`
  await $.prompt.suggest({ text: `Fix the ${what} you wrote this session (test_grades lists them)` })
}

// a setting as the module keeps it: from the options it loads with, and from /config as the
// person changes it, so a new model grades the next call without a restart
const SETTINGS: Record<string, (value: unknown) => void> = {
  graderModel: v => (graderModel = modelOf(v, DEFAULT_MODEL)),
  graderEscalate: v => (escalateModel = v === 'off' ? null : modelOf(v, '') || null),
  graderWorkers: v => (parallel = workersOf(v)),
}

export const register: Register = (on, options) => {
  for (const [field, apply] of Object.entries(SETTINGS)) apply(options[field])
  on('config.set', async ($, e, next) => {
    const result = await next(e)
    const field = e.key.startsWith('test-grader.') ? e.key.slice('test-grader.'.length) : ''
    if (result.deny === undefined && field in SETTINGS) SETTINGS[field]!(result.value)
    return result
  })
  // the evidence tool: it changes only this mod's own verdicts, so no permission prompt
  on('tool.check', { tool: 'mcp__test-grader__test_evidence' }, () => ({ decision: 'allow' as const })).catch(() => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'mcp__test-grader__test_evidence' }, async ($, e) => ({ result: await answerEvidence($, e as never) })).catch(
    (_$, _e, next) => ({ result: `The evidence tool could not answer (${next.error.kind}). Nothing was regraded; send it again.` }),
  )

  on('tool.check', { tool: 'mcp__test-grader__test_grades' }, () => ({ decision: 'allow' as const })).catch(() => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'mcp__test-grader__test_grades' }, async ($, e) => ({ result: await answerGrades($, e as never) })).catch(
    (_$, _e, next) => ({ result: `The grades tool could not answer (${next.error.kind}); ask again.` }),
  )

  // the guides are the mod's own files, read-only: Claude reads them with no permission asked
  on('tool.check', { tool: 'Read' }, async ($, e, next) => {
    const path = (e.input as { file_path?: unknown } | undefined)?.file_path
    const isGuide = typeof path === 'string' && /^[\w-]+\.md$/.test(path.slice(`${$.plugin.root}/guides/`.length)) && path.startsWith(`${$.plugin.root}/guides/`)
    return isGuide ? { decision: 'allow' as const } : next(e)
  }).catch(($, e, next) => next(e))

  // grading reads files and calls the grader, as Grade all tests does: no permission asked
  on('tool.check', { tool: 'mcp__test-grader__test_grade' }, () => ({ decision: 'allow' as const })).catch(() => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'mcp__test-grader__test_grade' }, async ($, e) => ({ result: await answerGrade($, e as never) })).catch(
    (_$, _e, next) => ({ result: `The grade tool could not answer (${next.error.kind}); ask again.` }),
  )

  // what the grader reads: files the session can read already, so no permission asked
  on('tool.check', { tool: 'mcp__test-grader__test_context' }, () => ({ decision: 'allow' as const })).catch(() => ({ decision: 'allow' as const }))
  on('tool.call', { tool: 'mcp__test-grader__test_context' }, async ($, e) => ({ result: await answerContext($, e as never) })).catch(
    (_$, _e, next) => ({ result: `The context tool could not answer (${next.error.kind}); ask again.` }),
  )

  // the verify tool runs commands and changes a file for a moment: the person is asked first,
  // as for any tool, so no allow here
  on('tool.call', { tool: 'mcp__test-grader__test_verify' }, async ($, e) => ({ result: await answerVerify($, e as never) })).catch(
    (_$, _e, next) => ({ result: `The verify tool could not answer (${next.error.kind}). If it had changed a file, check that it is back as it was.` }),
  )

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'test-grader',
      description: 'Open the test-grader pane (tests, their quality, coverage); diff grades the tests changed on this branch, report writes the grades out',
      argumentHint: '[diff | report]',
    })
    await $.tool
      .register({ name: EVIDENCE_TOOL, description: EVIDENCE_DESCRIPTION, inputSchema: EVIDENCE_SCHEMA })
      .catch(error => $.ui.log(`test-grader: the evidence tool could not be registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
    await $.tool
      .register({ name: GRADES_TOOL, description: GRADES_DESCRIPTION, inputSchema: GRADES_SCHEMA })
      .catch(error => $.ui.log(`test-grader: the grades tool could not be registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
    await $.tool
      .register({ name: GRADE_TOOL, description: GRADE_DESCRIPTION, inputSchema: GRADE_SCHEMA })
      .catch(error => $.ui.log(`test-grader: the grade tool could not be registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
    await $.tool
      .register({ name: CONTEXT_TOOL, description: CONTEXT_DESCRIPTION, inputSchema: CONTEXT_SCHEMA })
      .catch(error => $.ui.log(`test-grader: the context tool could not be registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
    await $.tool
      .register({ name: VERIFY_TOOL, description: VERIFY_DESCRIPTION, inputSchema: VERIFY_SCHEMA })
      .catch(error => $.ui.log(`test-grader: the verify tool could not be registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
    await pinProject($)
    await detectProject($)
    await renameGrades($).catch(() => undefined)
    await loadGrades($).catch(() => undefined)
    await prune($).catch(() => undefined)
    $.clock.after(1, () => void listAll($).catch(() => undefined))
    watcher?.cancel()
    watcher = $.clock.every(WATCH_MS, () => void check($))
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

  // /test-grader opens the pane; /test-grader diff grades the test files changed on this branch;
  // /test-grader report writes the grades out
  on('command.run', { command: 'test-grader' }, async ($, e) => {
    const [verb] = e.args.trim().split(/\s+/)
    await $.ui.open({ id: PANE, title: 'Tests' })
    await refreshCoverage($)
    if (verb === 'diff') return { text: await gradeBranch($) }
    if (verb === 'report') return { text: await writeReport($) }
    if (verb) return { text: `Test pane opened. /test-grader takes diff (grade the test files changed on this branch) or report (write the grades to ${REPORT}.md and .json); not ${JSON.stringify(verb)}.` }

    return { text: 'Test pane opened.' }
  })

  // a shell command may have made, changed or removed test files: the pane shows it now
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    $.clock.after(1, () => void check($, true))
    return result
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const prior = TEST_FILE.test(e.file_path) ? await $.fs.read(e.file_path).catch(() => null) : null
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && TEST_FILE.test(e.file_path)) {
      const names = caseNames(e.content, e.file_path)
      await update($, seen, all => ({ ...all, [e.file_path]: fingerprint(e.content) }))
      lastText.set(e.file_path, e.content)
      // a file written over: only the tests whose text changed are touched
      await refresh($, e.file_path, prior !== null && prior !== e.content ? changedCases(prior, e.content, e.file_path) : names)
      // a file written afresh holds its old cases too: only the ones not tracked yet, nor listed
      // by Grade all, are new
      const listed = [...(await read($, tests)), ...(await read($, existing)).results].filter(t => t.file === e.file_path)
      const known = new Set(listed.map(t => t.name))
      const fresh = names.filter(n => !known.has(n) && !(isTemplate(n) && [...known].some(k => fits(n, k))))
      if (fresh.length > 0) await track($, e.file_path, fresh)
    }

    return ran
  }).catch(($, e, next) => {
    // the write ran (or not) as it would without this mod; only its tests went untracked.
    // next is replay-safe here: it answers what the tool did, running nothing again
    $.ui.log(`test-grader: a write to a test file was not tracked (${next.error.kind})`, { to: 'debug' })

    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    // the file as it was: where the replaced text stood, for an edit that only removes
    const prior = TEST_FILE.test(e.file_path) ? await $.fs.read(e.file_path).catch(() => null) : null
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && TEST_FILE.test(e.file_path)) {
      const text = await $.fs.read(e.file_path).catch(() => null)
      // an edit's two strings are pieces of the file: a name they hold is a case only if the
      // whole file, read as code, has it as one (not as a fixture's text)
      const isCase = text === null ? () => true : ((all: Set<string>) => (n: string) => all.has(n))(new Set(caseNames(text, e.file_path)))
      const before = new Set(caseNames(e.old_string, e.file_path))
      const named = caseNames(e.new_string, e.file_path).filter(isCase)
      // and the cases the edit fell inside: a change to a test's body alone names no test
      const inside: string[] = []
      if (text !== null && e.new_string !== '') {
        for (let at = text.indexOf(e.new_string); at >= 0; at = e.replace_all ? text.indexOf(e.new_string, at + e.new_string.length) : -1) {
          inside.push(...casesAround(text, e.file_path, at, at + e.new_string.length))
        }
      }
      if (prior !== null && e.old_string !== '') {
        const at = prior.indexOf(e.old_string)
        if (at >= 0) inside.push(...casesAround(prior, e.file_path, at, at + e.old_string.length).filter(isCase))
      }
      // with the file as it was: the tests whose own text changed, and no other
      // (an edit read as already made, the file the same before and after: by where it fell)
      const touched = prior !== null && text !== null && prior !== text ? changedCases(prior, text, e.file_path).filter(isCase) : [...new Set([...named, ...inside])]
      if (text !== null) {
        await update($, seen, all => ({ ...all, [e.file_path]: fingerprint(text) }))
        lastText.set(e.file_path, text)
      }
      await refresh($, e.file_path, touched)
      const names = named.filter(n => !before.has(n))
      if (names.length > 0) await track($, e.file_path, names)
    }

    return ran
  }).catch(($, e, next) => {
    // the edit ran (or not) as it would without this mod; only its tests went untracked.
    // next is replay-safe here: it answers what the tool did, running nothing again
    $.ui.log(`test-grader: an edit to a test file was not tracked (${next.error.kind})`, { to: 'debug' })

    return next(e)
  })

  // Claude is told ahead of any test it writes that its tests are graded, and to look the
  // grades up when it is done writing them
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(`mcp__test-grader__${GRADES_TOOL}`)) return composed

    // the languages the project's tests are in, as listed: the guide for each, and no other
    const kinds = new Set([...(await read($, existing)).results, ...(await read($, tests))].map(t => kindOf(t.file)))
    const guides = LANGUAGE_ORDER.filter(k => kinds.has(k)).map(k => `- ${LANGUAGE_NAMES[k]}: ${guideOf($.plugin.root, k)}`)
    const text =
      guides.length > 0
        ? `${GRADING_SECTION}\nBefore you write or edit tests, read the guide for their language (once a session; the others do not apply to this project):\n${guides.join('\n')}`
        : GRADING_SECTION

    return { sections: [...composed.sections, { id: 'test-grader:grading', text, scope: 'session' as const }] }
  })

  on('turn.complete', async ($, e, next) => {
    await suggestStrengthening($).catch(() => undefined)
    await refreshCoverage($)
    await readRules($).catch(() => undefined)
    await check($, true)
    await flush($).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cwd = await projectDir($)
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
    const saveFailed = await read($, saveError)
    const graderFailed = await read($, graderError)
    const runs = await read($, testRuns)
    const now = await $.clock.now()

    // the pane's own width: docked beside the transcript, it is narrower than the window
    const columns = (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 60
    const isOpen = new Set(await read($, opened))
    const filesOpen = await read($, fileOpen)
    const toggle = async (key: string): Promise<void> => {
      await update($, opened, keys => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key].slice(-MAX_OPEN)))
    }

    const entries = entriesOf(graded, list, await read($, modified))
    const tally = (of: Entry[], s: State): number => of.filter(t => t.state === s).length

    // grouped: a Go suite over its files, else by file; the worst group first, and in a
    // file the worst test first, the new ahead
    const RANK = Object.fromEntries(LISTED.map((s, i) => [s, i])) as Record<State, number>
    const worstFirst = (of: Entry[]): Entry[] => [...of].sort((a, b) => RANK[a.state] - RANK[b.state] || Number(b.isNew) - Number(a.isNew) || Number(b.isModified ?? false) - Number(a.isModified ?? false))
    const byFile = (of: Entry[]): { file: string; of: Entry[] }[] => {
      const files = new Map<string, Entry[]>()
      for (const t of of) files.set(t.file, [...(files.get(t.file) ?? []), t])
      return [...files.entries()].map(([file, of]) => ({ file, of: worstFirst(of) })).sort((a, b) => worse(a.of, b.of) || a.file.localeCompare(b.file))
    }
    const worse = (a: Entry[], b: Entry[]): number =>
      [...FLAGGED, 'unrated' as const].reduce((d, s) => d || tally(b, s) - tally(a, s), 0)
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
    const stateColor = (s: State): string => verdictColor(verdictOf(s))
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

    const counts = [
      plural(entries.length, 'test'),
      `${tally(entries, 'strong')} strong`,
      ...FLAGGED.filter(v => tally(entries, v) > 0).map(v => `${tally(entries, v)} ${v}`),
      ...(tally(entries, 'unrated') > 0 ? [`${tally(entries, 'unrated')} unrated`] : []),
      ...(tally(entries, 'reviewing') > 0 ? [`${tally(entries, 'reviewing')} reviewing`] : []),
      ...(tally(entries, 'ungraded') > 0 ? [`${tally(entries, 'ungraded')} ungraded`] : []),
      ...(list.length > 0 ? [`${new Set(list.map(t => `${t.file}:${t.name}`)).size} new`] : []),
      ...(entries.some(t => t.isModified) ? [`${entries.filter(t => t.isModified).length} modified`] : []),
    ].join(' · ')

    // a group's header line: its toggle, its counts, new when it holds a new test, and Regrade,
    // which grades its files again alone (scope: what Claude's note says was graded)
    // lines: the folder's line coverage, when the report has it
    const header = (key: string, label: string, of: Entry[], indent: number, open: boolean, onPress: () => Promise<void>, scope: string, lines?: { total: number; covered: number }): unknown => {
      const only = [...new Set(of.map(t => t.file).filter(f => f.startsWith(`${cwd}/`)).map(f => f.slice(cwd.length + 1)))]
      const canRegrade = graded.state !== 'running' && only.length > 0
      const linePct = lines && lines.total > 0 ? Math.round((lines.covered / lines.total) * 100) : null
      const worst = worstFirst(of)[0]!.state
      const groupCounts = [
        `${of.length}`,
        `${tally(of, 'strong')} strong`,
        ...([...FLAGGED, 'unrated', 'reviewing', 'ungraded'] as const).filter(s => tally(of, s) > 0).map(s => `${tally(of, s)} ${s}`),
      ].join(' · ')
      return (
        <Box key={`h-${key}`} flexDirection="row" gap={1} marginLeft={indent}>
          <Button key={key} plain label={`${open ? '▾' : '▸'} ${clamp(label, Math.max(16, columns - groupCounts.length - 10 - (canRegrade ? 10 : 0) - indent))}`} onPress={onPress} />
          <Text color={stateColor(worst)}>{groupCounts}</Text>
          {linePct !== null && <Text color={pctColor(linePct)}>{`${linePct}% ${cov?.lines === null && cov?.statements !== null ? 'statements' : 'lines'}`}</Text>}
          {of.some(t => t.isNew) && <Text color={VIOLET}>new</Text>}
          {of.some(t => t.isModified) && <Text color={BLUE}>modified</Text>}
          {canRegrade && <Button key={`g-${key}`} plain label="↻ Regrade" onPress={() => soon($, async () => void (await gradeAll($, { isFresh: true, only, scope })))} />}
        </Box>
      )
    }
    // a group starts open when it is alone among its siblings, closed among several; a press
    // sets it, until the next session
    const isGroupOpen = (key: string, siblings: number): boolean => filesOpen[key] ?? siblings === 1
    const flip = (key: string, open: boolean) => async (): Promise<void> => {
      await update($, fileOpen, all => ({ ...all, [key]: !open }))
    }

    // a file's header and, open, every one of its tests; the pane scrolling
    const drawn: unknown[] = []
    // the verdicts' column, one width for the pane, so every title starts in line
    const verdictWidth = Math.max(...entries.map(t => t.state.length))
    // the characters a name's line holds: the row's room after its margin, the verdict, the gap
    // and the marks beside it; a desktop's proportional font fits a fifth more than its cells
    const nameWidth = (indent: number, t: Entry): number => {
      const room = columns - indent - 2 - verdictWidth - 1 - (t.isNew ? ' new'.length : 0) - (t.isModified ? ' modified'.length : 0) - (t.evidence ? ' on evidence'.length : 0) - (t.confidence === 'low' || t.confidence === 'medium' ? ' medium confidence'.length : 0)
      return Math.max(12, Math.floor(room * (e.surface === 'desktop' ? 1.2 : 1)))
    }
    // openKey: where its open or closed is kept; a top-level file's, by its path as before
    const drawFile = (key: string, openKey: string, label: string, of: Entry[], indent: number, siblings: number): void => {
      const open = isGroupOpen(openKey, siblings)
      drawn.push(header(key, label, of, indent, open, flip(openKey, open), shortPath(of[0]!.file, cwd)))
      if (!open) return
      for (const t of of) {
        const key = `r:${t.file}:${t.name}`
        const ran = runs[`${t.file}:${t.name}`]
        // an unrated test says why, as its grader call left it; a row from before reasons were kept, what the pane knows
        const why = t.reason ?? (graderFailed ? `The grader gave no verdict for this test. ${graderFailed}` : 'The grader gave no verdict for this test.')
        const reason = t.state === 'unrated' ? `${why} Grade again to retry it.` : t.state === 'ungraded' ? 'Not graded yet: Grade all tests grades it.' : t.reason
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
              {t.isModified && <Text color={BLUE}>modified</Text>}
              {t.evidence && <Text color={MUTED}>on evidence</Text>}
              {(t.confidence === 'low' || t.confidence === 'medium') && <Text color={MUTED}>{`${t.confidence} confidence`}</Text>}
            </Box>
            {isOpen.has(key) && (
              <Box flexDirection="column" marginLeft={verdictWidth + 1}>
                {/* the description set apart from the title above it: dim and italic */}
                {t.summary && (
                  <Text italic color={MUTED}>
                    {t.summary}
                  </Text>
                )}
                {reason && <Text color={stateColor(t.state)}>{reason}</Text>}
                {t.evidence && <Text color={MUTED}>{`Evidence: ${t.evidence}`}</Text>}
                {ran && (
                  <Text color={ran.state === 'passed' ? GREEN : ran.state === 'failed' ? RED : MUTED}>
                    {ran.state === 'running'
                      ? 'Running…'
                      : [`${ran.state === 'passed' ? 'Passed' : 'Failed'}${ran.command ? `: ${ran.command}` : ''}`, ...(ran.state === 'failed' && ran.tail ? [ran.tail] : [])].join('\n')}
                  </Text>
                )}
                {/* actions drawn as buttons, [ Open in editor ], apart from the text above */}
                <Box flexDirection="row" gap={2}>
                  <Button key={`o:${t.file}:${t.name}`} label="Open in editor" onPress={() => $.clock.after(1, () => void openInEditor($, t.file, t.name))} />
                  {runArgv({ rel: '', kind: kindOf(t.file), plain: '', groups: [], line: 1 }, runners) !== null && ran?.state !== 'running' && (
                    <Button key={`x:${t.file}:${t.name}`} label="Run test" onPress={() => $.clock.after(1, () => void runFromPane($, t.file, t.name))} />
                  )}
                </Box>
              </Box>
            )}
          </Box>,
        )
      }
    }
    // The groups in a tree of the project's folders. A folder that holds only one folder is
    // drawn as one row with it (gateways/api/); a level that is only one folder draws no row
    // for it, its path leading the names below, so tests in one folder read as a flat list
    type Folder = { path: string; dirs: Map<string, Folder>; groups: Group[] }
    const root: Folder = { path: '', dirs: new Map(), groups: [] }
    for (const g of groups) {
      const dir = g.kind === 'suite' ? g.dir : dirOf(g.file)
      const rel = dir === cwd ? '' : shortPath(dir, cwd)
      let at = root
      for (const part of rel.split('/').filter(Boolean)) {
        const path = at.path ? `${at.path}/${part}` : part
        const next = at.dirs.get(part) ?? { path, dirs: new Map(), groups: [] }
        at.dirs.set(part, next)
        at = next
      }
      at.groups.push(g)
    }
    const allOf = (f: Folder): Entry[] => [...f.groups.flatMap(g => g.of), ...[...f.dirs.values()].flatMap(allOf)]
    type Child = { kind: 'dir'; name: string; folder: Folder; of: Entry[] } | { kind: 'group'; group: Group; of: Entry[] }
    const childrenOf = (f: Folder): Child[] => {
      const dirs = [...f.dirs.entries()].map(([name, folder]): Child => {
        while (folder.groups.length === 0 && folder.dirs.size === 1) {
          const [inner, only] = [...folder.dirs.entries()][0]!
          name = `${name}/${inner}`
          folder = only
        }
        return { kind: 'dir', name, folder, of: allOf(folder) }
      })
      const name = (c: Child): string => (c.kind === 'dir' ? c.name : c.group.kind === 'suite' ? c.group.suite : c.group.file.slice(c.group.file.lastIndexOf('/') + 1))
      return [...dirs, ...f.groups.map((group): Child => ({ kind: 'group', group, of: group.of }))].sort((a, b) => worse(a.of, b.of) || name(a).localeCompare(name(b)))
    }
    const drawLevel = (f: Folder, prefix: string, indent: number): void => {
      const children = childrenOf(f)
      const only = children[0]
      if (children.length === 1 && only?.kind === 'dir') return drawLevel(only.folder, `${prefix}${only.name}/`, indent)
      for (const c of children) {
        if (c.kind === 'dir') {
          const key = `d:${c.folder.path}`
          const open = isGroupOpen(key, children.length)
          drawn.push(header(key, `${prefix}${c.name}/`, c.of, indent, open, flip(key, open), `${c.folder.path}/`, cov?.byDir?.[c.folder.path]))
          if (open) drawLevel(c.folder, '', indent + 2)
          continue
        }
        const g = c.group
        if (g.kind === 'file') {
          drawFile(`f:${g.file}`, g.file, `${prefix}${g.file.slice(g.file.lastIndexOf('/') + 1)}`, g.of, indent, children.length)
          continue
        }
        // a suite names its package's folder where no row above does
        const key = `s:${g.id}`
        const open = isGroupOpen(key, children.length)
        drawn.push(header(key, prefix ? `${g.suite} · ${prefix.slice(0, -1)}` : g.suite, g.of, indent, open, flip(key, open), `the ${g.suite} suite`))
        if (!open) continue
        const files = byFile(g.of)
        for (const { file, of } of files) drawFile(`sf:${g.id}:${file}`, `sf:${g.id}:${file}`, shortPath(file, cwd), of, indent + 2, files.length)
      }
    }
    drawLevel(root, '', 0)

    const metrics: [string, number | null][] = cov
      ? [['Lines', cov.lines], ['Statements', cov.statements], ['Branches', cov.branches], ['Functions', cov.functions]]
      : []
    const age = cov?.updatedAt ? Math.max(0, Math.round((now - cov.updatedAt) / 60_000)) : null
    // a coverage figure as a bar: its label, its cells filled by the figure, and the figure
    const bar = (key: string, label: string, value: number, width: number, indent: number): unknown => {
      const filled = Math.round((Math.min(100, value) / 100) * CELLS)
      return (
        <Box key={key} flexDirection="row" gap={1} marginLeft={indent}>
          <Box width={width}>
            <Text color={MUTED}>{clamp(label, width)}</Text>
          </Box>
          <Box flexDirection="row" width={CELLS}>
            {Array.from({ length: CELLS }, (_, i) => (
              <Box key={`c-${key}-${i}`} width={1} backgroundColor={i < filled ? pctColor(value) : TRACK}>
                <Text> </Text>
              </Box>
            ))}
          </Box>
          <Text bold color={pctColor(value)}>{`${value}%`}</Text>
        </Box>
      )
    }
    // Go's packages under the total, least covered first: a few, then how many more and their best
    const packages = (cov?.byPackage ?? []).length > 1
      ? cov!.byPackage!.map(p => ({ name: p.name, pct: pct((p.covered / p.total) * 100)! })).sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name))
      : []
    // the rest behind a press, kept open as a group is
    const isAllPackages = filesOpen[ALL_PACKAGES] === true
    const packageBars = isAllPackages ? packages : packages.slice(0, PACKAGE_BARS)
    const packagesLeft = isAllPackages ? [] : packages.slice(PACKAGE_BARS)
    const packageWidth = Math.min(PACKAGE_LABEL, Math.max(9, ...packageBars.map(p => p.name.length)))

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color={VIOLET}>{counts}</Text>
        {graded.state === 'failed' && <Text color={RED}>{graded.message ?? 'Grading failed.'}</Text>}
        {graded.state === 'idle' && graded.graded !== undefined && (
          <Text color={MUTED}>
            {`Last run: ${graded.graded} graded · ${graded.remembered ?? 0} remembered` +
              (graded.spent && graded.spent.input + graded.spent.output > 0 ? ` · ${tokens(graded.spent.input)} in (${tokens(graded.spent.cached)} cached) / ${tokens(graded.spent.output)} out` + (dollars(graded.spent) ? ` · ${dollars(graded.spent)}` : '') : '')}
          </Text>
        )}
        {graded.state === 'idle' && graded.message !== undefined && <Text color={AMBER}>{graded.message}</Text>}
        {graderFailed !== null && <Text color={RED}>{graderFailed}</Text>}
        <Box flexDirection="column" flexGrow={1} marginTop={1}>
          {entries.length === 0 && (
            <Text color={MUTED}>{`No tests in ${cwd} yet. New tests show up here as they are written; Grade all tests grades the ones already there.`}</Text>
          )}
          {drawn as never}
        </Box>
        {openFailed !== null && <Text color={RED}>{openFailed}</Text>}
        {noteFailed !== null && <Text color={RED}>{`Couldn't share the result with Claude: ${noteFailed}`}</Text>}
        {saveFailed !== null && <Text color={RED}>{saveFailed}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {hasCoverage && (
            <Box flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold>Coverage</Text>
                <Text color={MUTED}>{cov ? `${cov.source}${age !== null ? ` – ${age < 60 ? `${age}m` : `${Math.round(age / 60)}h`} ago` : ''}` : 'no report found'}</Text>
              </Box>
              {metrics.filter(([, v]) => v !== null).map(([label, v]) => bar(`cov-${label}`, label, v as number, 11, 0)) as never}
              {packageBars.map(p => bar(`cov-pkg-${p.name}`, p.name, p.pct, packageWidth, 2)) as never}
              {packagesLeft.length > 0 && (
                <Box marginLeft={2}>
                  <Button key={ALL_PACKAGES} plain label={`▸ ${plural(packagesLeft.length, 'more package')}, up to ${Math.max(...packagesLeft.map(p => p.pct))}%`} onPress={flip(ALL_PACKAGES, false)} />
                </Box>
              )}
              {isAllPackages && packages.length > PACKAGE_BARS && (
                <Box marginLeft={2}>
                  <Button key={ALL_PACKAGES} plain label={`▾ the ${PACKAGE_BARS} least covered only`} onPress={flip(ALL_PACKAGES, true)} />
                </Box>
              )}
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
              onPress={() => (graded.state === 'running' ? undefined : soon($, async () => void (await gradeAll($))))}
            />
            {graded.state === 'running' && <Button key="stopGrading" label="Stop" onPress={() => stopGrading()} />}
            {graded.state !== 'running' && graded.hashes && Object.keys(graded.hashes).length > 0 && (
              <Button key="regradeAll" label="Regrade all" onPress={() => soon($, async () => void (await gradeAll($, { isFresh: true })))} />
            )}
          </Box>
        </Box>
      </Box>
    )
  })
}
