import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Coverage, ExistingRun, ExistingTest, TrackedTest, Verdict } from '../types'

import { TEST_FILE, among, caseLine, caseNames, casesAround, changedCases, casesIn, fits, isTemplate, kindOf, suitesOf } from './discovery'
import type { Kind } from './discovery'
import { clamp, excerptOf, parseVerdicts } from './excerpt'
import type { Graded } from './excerpt'
import { DEFAULT_MODEL, modelOf, workersOf } from './settings'
import { FIX, FLAGGED, isFlagged, verdictOf } from './verdicts'
import { runArgv, shown, tailOf } from './runner'
import type { RunTarget, Runners } from './runner'

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
const saveError = atom({ plugin: 'test-grader', key: 'saveError' } as const, null)
const graderError = atom({ plugin: 'test-grader', key: 'graderError' } as const, null)
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
// Grade all tests: cases per grader call
const BATCH = 10
// grader calls in flight at once, from the graderWorkers setting (1 to 20), 10 by default
let parallel = 10
// a grader reply's room: a verdict runs to about 75 tokens, and a batch's looped tests can
// stand for many cases each
const MAX_REPLY = 4000
// the model that grades, from the graderModel setting; set as the module loads, and a change
// to the setting reloads the module
let graderModel: string = DEFAULT_MODEL
// grades again what the first grade flagged (a regrade, evidence, a last round), when set
let escalateModel: string | null = null

const ORANGE = '#fb923c'
const PINK = '#f472b6'
const VERDICT_COLOR: Record<Verdict, string> = { strong: GREEN, shallow: AMBER, brittle: ORANGE, hollow: RED, duplicate: PINK }
const verdictColor = (v: Verdict | undefined): string => (v === undefined ? MUTED : VERDICT_COLOR[v])

// a count of tokens as the pane shows it: 950, 310k, 1.2M
const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)

const pctColor = (p: number): string => (p >= 80 ? GREEN : p >= 50 ? AMBER : RED)

const shortPath = (file: string, cwd: string): string => (cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file)

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
const flaggedLines = (list: { file: string; name: string; verdict?: Verdict; reason?: string }[], cwd: string): string[] =>
  FLAGGED.flatMap(v =>
    list.filter(t => t.verdict === v).map(t => `- ${v} · ${shortPath(t.file, cwd)} · ${t.name} — ${t.reason ?? ''}`),
  )

// What grader calls cost, summed: tokens in (of them read from the prompt cache) and out
export type Spent = { input: number; cached: number; output: number }
const addUsage = (spent: Spent | undefined, usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): void => {
  if (!spent || !usage) return
  spent.input += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  spent.cached += usage.cache_read_input_tokens ?? 0
  spent.output += usage.output_tokens ?? 0
}

// the rubric every grader call opens with, fixed so the prompt cache keeps it
const RUBRIC = [
  'You are a strict, concise reviewer of automated tests. Answer with JSON only.',
  'For each test case you are asked about, say in one plain sentence what it verifies (summary) and judge whether it is a decent test.',
  'verdict, one of five, each naming what is wrong:',
  '"strong" = a plausible bug in the code under test would make it fail, and a correct change to how the code works would not;',
  '"shallow" = it can fail, but misses the likely bugs: happy path only, checks that a value is defined or truthy, loose matchers, one easy case where the edges matter;',
  '"brittle" = it checks real behaviour but would also fail on a correct change: large snapshots, exact mock call order or counts, private state or implementation details, real time, timing, network or order between tests;',
  '"hollow" = no real bug could make it fail: no assertion, a tautology, asserts only on its own mock, a snapshot of nothing, would pass with the code under test deleted;',
  '"duplicate" = another test in the file already catches the same bugs; name that test in the reason.',
  'Where more than one fits, give the first of: hollow, duplicate, shallow, brittle.',
  'reason: one short sentence justifying the verdict.',
  'A name with ${...} in it is a template for cases generated in a loop: grade each case the loop generates separately, named as the loop expands it.',
  "A loop's variables belong only to the tests inside that loop: do not fault a test outside it for not using them.",
  'A name with › in it is the groups the test sits in (describe blocks, classes), then its own name; a name ending in (2) is the second test of that name. Answer with each name exactly as given.',
  'When the code under test is shown, judge each assertion against what that code really does.',
  'Return a JSON array: [{"name": string, "summary": string, "verdict": "strong"|"shallow"|"brittle"|"hollow"|"duplicate", "reason": string}]',
].join('\n')

// the project's own rules for its tests, from .test-grader.md at its root: read at a session's
// start and each turn's end; the grader is told them after the rubric
const RUBRIC_FILE = '.test-grader.md'
const MAX_RULES = 4_000
let projectRules = ''
const readRules = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
  projectRules = cwd ? ((await $.fs.read(`${cwd}/${RUBRIC_FILE}`).catch(() => '')) ?? '').trim().slice(0, MAX_RULES) : ''
}

// an API error worth trying again: too many requests, overloaded, the server's own, or no answer
const RETRIES = 3
const isPassing = (r: { reason: string; status?: number | null; error?: string }): boolean =>
  r.reason === 'api-error' && (r.status === null || r.status === 429 || r.status === 529 || (r.status ?? 0) >= 500 || r.error === 'rate_limit' || r.error === 'overloaded' || r.error === 'server_error')
const sleep = ($: EngineInterface, ms: number): Promise<void> => new Promise(done => void $.clock.after(ms, () => done()))
// how long one grader call may take
const CALL_TIMEOUT = 120_000

type GradeOptions = { evidence?: string; model?: string; signal?: AbortSignal; spent?: Spent }

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
  const cwd = await $.session.cwd()
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

// One grader call: these cases of this file, judged; null when the grader gave no answer. An
// API error that may pass is tried again, waiting longer each time; a stopped run is not
const grade = async ($: EngineInterface, file: string, text: string, names: string[], { evidence, model, signal, spent }: GradeOptions = {}): Promise<Graded[] | null> => {
  const source = excerptOf(text, names, file)
  const underTest = await codeUnderTest($, file, text).catch(() => '')
  const ask = [
    ...(source !== text
      ? [
          "The file is long, so the source above is an excerpt: the cases under review whole, the file's head, and the declarations they use from elsewhere in it. Other tests are left out.",
          'Judge each case by what it does. Do not mark one down for code the excerpt leaves out.',
        ]
      : []),
    ...(evidence
      ? [
          `The developer's session sent evidence about this test: ${JSON.stringify(evidence)}`,
          'Weigh it, but check each claim against the source above: you cannot run code. Evidence cannot add an assertion the source does not contain.',
          'Evidence should name a concrete mutation (where, before, after), the command run, and the test\'s output before and after; evidence "measured by test-grader" was run by the tool itself, not claimed. Accept it only when the mutation changes behaviour the test\'s assertions in the source would detect; reject evidence that only reports the test passing, coverage, or claims about code not shown.',
          'In reason, say which part of the evidence changed your verdict, or why it did not.',
        ]
      : []),
    `Review ONLY these test cases: ${JSON.stringify(names)}`,
  ].join('\n')
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
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return null
    let reply: Awaited<ReturnType<typeof $.model.complete>>
    try {
      reply = await $.model.complete(request, signal ? { signal } : undefined)
    } catch (err) {
      // a call that throws, as one through a gateway it cannot reach may, says so like any other
      if (signal?.aborted) return null
      const why = err instanceof Error ? err.message : String(err)
      $.ui.log(`test-grader: the grader call failed for ${file} (${why})`, { to: 'debug' })
      await update($, graderError, () => `The grader (${request.model}) call failed: ${why}`)
      return null
    }
    addUsage(spent, reply.usage)
    if (reply.isAnswered) {
      const { verdicts, isCut } = parseVerdicts(reply.text)
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
      return verdicts
    }
    if (attempt >= RETRIES || !isPassing(reply as never)) {
      const why = `${reply.reason}${'status' in reply ? ` ${reply.status ?? ''} ${reply.error}` : ''}`
      $.ui.log(`test-grader: the grader gave no answer for ${file} (${why})`, { to: 'debug' })
      // shown in the pane: a setting or an account that cannot reach the model says so there
      await update($, graderError, () => `The grader (${request.model}) gave no answer: ${why}.`)
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
const MAX_ROUNDS = 3
const roundKey = (file: string, name: string): string => `${file}::${name}`
const FOLLOW_UP = `Once you are done writing tests, fix each of these as its grade asks (${FLAGGED.map(v => `${v}: ${FIX[v]}`).join('; ')}), or, where one is better than rated, send your evidence with the test_evidence tool. Each test gets ${MAX_ROUNDS} rounds.`
const SPENT_FOLLOW_UP = 'Tell the person which of these still need work and why.'

// told to Claude in the system prompt, ahead of any test it writes: how to write a test the
// grader rates strong, and how to follow up on the grades
const GRADING_SECTION = [
  '# Test grading (test-grader)',
  'Every test you write or edit is graded in the background by a reviewer model, with a grade that names what is wrong: strong (a plausible bug makes it fail, a correct refactor does not), shallow (misses the likely bugs: happy path only, defined or truthy checks), brittle (fails on correct changes: big snapshots, exact mock calls, implementation details, timing), hollow (cannot fail: no real assertion, a tautology, tests the mock) or duplicate (another test catches the same bugs). Write tests that grade strong:',
  '- Assert on behaviour: the return value, the thrown error, the state or output the code produces. Never assert only that a mock was called, that a value is defined or truthy, or that a thing equals itself.',
  '- Before you keep a test, ask which plausible bug in the code would make it fail. If none, rewrite it. If it would pass with the function body deleted, it is hollow.',
  '- One behaviour per test, named for the behaviour and the case ("rejects a negative amount"), not the function.',
  '- Cover edges and errors, not only the happy path: empty, boundary, invalid input, failure paths. Prefer several small tests to one long one.',
  "- Use real code where you can; mock only I/O, time and randomness, and assert on what the code did with the mock's answer, not on the mock.",
  '- Make it deterministic: fixed clocks, seeds and data; no sleeps, no order dependence, no shared mutable state.',
  '- No snapshots unless the snapshot is small and reviewed; assert on what the code does, not on how it does it.',
  'Grades arrive as notes; nothing waits on them. When you have finished writing or editing tests for the task, call test_grades with written: true. Fix each flagged test as its grade asks, worst first: rewrite a hollow one, delete or merge a duplicate, add the missing case to a shallow one, and loosen a brittle one to assert on behaviour.',
  'Where one is better than rated, prove it: test_verify runs it, applies a mutation to the code under test, runs it again and puts the file back, and sends what it measured as evidence. Or send test_evidence: run the test unchanged (it must pass), apply the mutation, run again (it must fail), revert, and quote both results.',
  `Each change is graded again; call test_grades again to see the new grades. Tests listed as being graded: wait a moment and ask again. After ${MAX_ROUNDS} rounds on one test, tell the person what is left instead.`,
].join('\n')

// A guide for each language, in the mod's guides folder (guides/js.md, guides/go.md, ...): the
// section names only the ones for the languages the project's tests are written in, for Claude
// to read before it writes tests
const LANGUAGE_NAMES: Record<Kind, string> = {
  js: 'JavaScript and TypeScript',
  go: 'Go',
  py: 'Python',
  rb: 'Ruby',
  swift: 'Swift',
  jvm: 'Java and Kotlin',
  cs: 'C#',
  php: 'PHP',
  rs: 'Rust',
}
const guideOf = (root: string, kind: Kind): string => `${root}/guides/${kind}.md`
const LANGUAGE_ORDER: Kind[] = ['js', 'go', 'py', 'rb', 'swift', 'jvm', 'cs', 'php', 'rs']

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
  const cwd = await $.session.cwd()
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

// model: a second look, for a test graded again after a flagged grade
const evaluate = ($: EngineInterface, file: string, ids: Map<string, string>, model?: string): Promise<void> => busy($, () => evaluateNow($, file, ids, model))
const evaluateNow = async ($: EngineInterface, file: string, ids: Map<string, string>, model?: string): Promise<void> => {
  const fail = async (): Promise<void> => {
    await update($, tests, list => list.map(t => (ids.has(t.id) && t.status === 'pending' ? { ...t, status: 'failed' as const } : t)))
  }
  try {
    const verdicts = await grade($, file, await $.fs.read(file), [...ids.values()], { model })
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

// Line coverage by folder, every folder holding the lines of all beneath it: by its path in
// the project ('' the project itself)
const byDirOf = (files: { file: string; total: number; covered: number }[], cwd: string): Record<string, { total: number; covered: number }> => {
  const dirs: Record<string, { total: number; covered: number }> = {}
  for (const f of files) {
    if (f.total <= 0) continue
    const rel = shortPath(f.file, cwd)
    const parts = rel.split('/').slice(0, -1)
    for (let i = 0; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const d = (dirs[dir] ??= { total: 0, covered: 0 })
      d.total += f.total
      d.covered += f.covered
    }
  }
  return dirs
}

// the least covered folders, a few lines each at least, lowest first: where more tests would pay
const LEAST_COVERED = 5
const MIN_LINES = 20
const leastCovered = (cov: Coverage | null): string[] =>
  Object.entries(cov?.byDir ?? {})
    .filter(([dir, d]) => dir !== '' && d.total >= MIN_LINES)
    .map(([dir, d]) => ({ dir, p: (d.covered / d.total) * 100 }))
    .filter(d => d.p < 80)
    .sort((a, b) => a.p - b.p)
    .slice(0, LEAST_COVERED)
    .map(d => `${d.dir}/ ${Math.round(d.p)}%`)

const readCoverage = async ($: EngineInterface): Promise<Coverage | null> => {
  const cwd = await $.session.cwd()
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
const REPORTS = ['coverage/coverage-summary.json', 'coverage/lcov.info', 'coverage.xml', '.test-grader-go-coverage.txt']
let reportsAt = ''
const refreshCoverageIfChanged = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
  const at = (await Promise.all(REPORTS.map(r => mtime($, `${cwd}/${r}`)))).join(',')
  if (at === reportsAt) return
  reportsAt = at
  await refreshCoverage($)
}

// the project's coverage run: its command, and how a note to Claude names it
type CoverCommand = { argv: string[]; label: string; goOutput?: string }
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
    const least = leastCovered(cov)
    return figures
      ? `Coverage run (test-grader) finished: ${figures} (${cov!.source}).${least.length > 0 ? `\nLeast covered folders (lines): ${least.join(', ')}.` : ''}`
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
const existingNote = (results: ExistingTest[], cwd: string, scope?: string): string => {
  const count = (v: Verdict): number => results.filter(t => t.verdict === v).length
  const unrated = results.filter(t => !t.verdict)
  const counts = [`${results.length} graded`, `${count('strong')} strong`, ...FLAGGED.filter(v => count(v) > 0).map(v => `${count(v)} ${v}`)]
  if (unrated.length > 0) counts.push(`${unrated.length} unrated`)
  const lines = [`Test grading (test-grader) finished${scope ? ` for ${scope}` : ''}: ${counts.join(' · ')}.`]
  const flagged = flaggedLines(results, cwd)
  if (flagged.length > 0) lines.push('Need work, worst first:', ...flagged, EVIDENCE_HINT)
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

// The project's grades outlive the session: kept in the store under the project's folder,
// with each graded file's fingerprint, so a later session lists them and Grade all tests
// grades again only the files changed since. Listed-but-ungraded rows are not kept
type SavedGrades = { results: ExistingTest[]; hashes: Record<string, string>; finishedAt?: number }
// as kept: by file, each file's fingerprint and its tests as [name, verdict, summary, reason,
// suite, evidence], verdicts as g (strong), w (shallow), b (brittle), u (hollow), d (duplicate)
// (none: unrated), the first three as the grades before these were kept; a file's path is
// written once
type KeptTest = [string, string, string?, string?, string?, string?]
type KeptGrades = { v: 2; files: Record<string, { hash?: string; tests: KeptTest[] }>; finishedAt?: number }
const gradesKey = (cwd: string): string => `grades:${cwd}`
const VERDICT_CODE: Record<Verdict, string> = { strong: 'g', shallow: 'w', brittle: 'b', hollow: 'u', duplicate: 'd' }
const CODE_VERDICT: Record<string, Verdict> = Object.fromEntries(Object.entries(VERDICT_CODE).map(([v, c]) => [c, v as Verdict]))

// lean: the summaries left out, for a project whose grades are too many to keep whole
const keep = (saved: SavedGrades, isLean: boolean): KeptGrades => {
  const files: KeptGrades['files'] = {}
  for (const [file, hash] of Object.entries(saved.hashes)) files[file] = { hash, tests: [] }
  for (const t of saved.results) {
    const row: KeptTest = [t.name, t.verdict ? VERDICT_CODE[t.verdict] : '', isLean ? '' : (t.summary ?? ''), t.reason ?? '', t.suite ?? '', t.evidence ?? '']
    while (row.length > 2 && !row[row.length - 1]) row.pop()
    ;(files[t.file] ??= { tests: [] }).tests.push(row)
  }
  return { v: 2, files, ...(saved.finishedAt === undefined ? {} : { finishedAt: saved.finishedAt }) }
}
export const unkeep = (kept: KeptGrades | SavedGrades): SavedGrades => {
  // the oldest form, verdicts in words: the old words read as the nearest grade
  if (!('v' in kept)) return { ...kept, results: kept.results.map(({ verdict, ...t }) => (verdictOf(verdict) ? { ...t, verdict: verdictOf(verdict)! } : t)) }
  const results: ExistingTest[] = []
  const hashes: Record<string, string> = {}
  for (const [file, { hash, tests }] of Object.entries(kept.files)) {
    if (hash) hashes[file] = hash
    for (const [name, code, summary, reason, suite, evidence] of tests) {
      results.push({ file, name, ...(CODE_VERDICT[code] ? { verdict: CODE_VERDICT[code] } : {}), ...(summary ? { summary } : {}), ...(reason ? { reason } : {}), ...(suite ? { suite } : {}), ...(evidence ? { evidence } : {}) })
    }
  }
  return { results, hashes, ...(kept.finishedAt === undefined ? {} : { finishedAt: kept.finishedAt }) }
}

const saveGrades = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
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
  const cwd = await $.session.cwd()
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

// isFresh: grade every file again, the remembered ones too; only: these files alone (their
// paths in the project), the rest of the project's results left as they are
type RunOptions = { isFresh?: boolean; only?: string[] }
const gradeAll = ($: EngineInterface, isFresh = false, only?: string[]): Promise<void> => busy($, () => gradeAllNow($, { isFresh, only }))
const gradeAllNow = async ($: EngineInterface, { isFresh = false, only }: RunOptions): Promise<void> => {
  const before = await read($, existing)
  if (before.state === 'running') return
  const cwd = await $.session.cwd()
  const fail = (message: string) => update($, existing, () => ({ state: 'failed' as const, done: 0, total: 0, message, results: before.results, hashes: before.hashes }))
  const stop = new AbortController()
  stopRun = stop
  try {
    const listed = only ?? (await testFiles($, cwd))
    if (listed === null) return void (await fail('Not a git repository: there is no list of test files to grade.'))
    const files = only ? listed.filter(f => TEST_FILE.test(f)) : listed
    const inRun = new Set(files.map(rel => `${cwd}/${rel}`))
    // a narrowed run leaves the other files' results be
    const others = only ? before.results.filter(t => !inRun.has(t.file)) : []
    await update($, existing, r => ({ ...r, state: 'running' as const, done: 0, total: files.length, isFresh, ...(only ? { only } : {}) }))
    const hashes: Record<string, string> = {}
    const spent: Spent = { input: 0, cached: 0, output: 0 }
    // tests whose results stand from before
    let remembered = 0
    // every file's batches, in file order; a file is done when its last batch is. Until the
    // grader answers a batch, its tests are listed as they were, marked reviewing
    // was: the batch's rows as they stood before the run, for a stop to put back
    type Slot = { items: ExistingTest[]; waiting: ExistingTest[]; was: ExistingTest[]; isDone: boolean }
    type Entry = { file: string; left: number; slots: Slot[]; hash?: string }
    const jobs: { file: string; text: string; batch: string[]; slot: Slot }[] = []
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
        for (let at = 0; at < names.length; at += BATCH) {
          const batch = names.slice(at, at + BATCH)
          const was = batch.flatMap(name => {
            const had = kept.filter(t => fits(name, t.name))
            return had.length > 0 ? had : [{ file, name, isUngraded: true }]
          })
          const waiting = was.map(({ isUngraded: _, ...t }) => ({ ...t, isPending: true }))
          const slot: Slot = { items: [], waiting, was, isDone: false }
          entry.slots.push(slot)
          owner.set(slot, entry)
          entry.left += 1
          jobs.push({ file, text, batch, slot })
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
        const { file, text, batch, slot } = jobs[next++]!
        const verdicts = (await grade($, file, text, batch, { signal: stop.signal, spent }).catch(() => null)) ?? []
        // cut by a stop: the batch keeps what it had
        if (stop.signal.aborted) return
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
    if (isStopped) return
    const told = results.filter(t => inRun.has(t.file))
    await share($, existingNote(told, cwd, only ? 'the files changed on this branch' : undefined))
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err))
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
  const isRedo = (t: { file: string; name: string; verdict?: Verdict }): boolean => t.file === file && among(touched, t.name)
  const known = new Set([...(await read($, existing)).results, ...(await read($, tests))].filter(t => t.file === file && among(touched, t.name) && among(present, t.name)).map(t => `${t.file}:${t.name}`))
  if (known.size > 0) await update($, modified, all => [...new Set([...all, ...known])].slice(-MAX_TESTS))

  const now = await read($, tests)
  const redoTests = now.filter(t => isRedo(t) && t.status !== 'pending' && among(present, t.name))
  const redoNew = new Map(redoTests.map(t => [t.id, t.name]))
  await update($, tests, list =>
    list
      .filter(t => t.file !== file || t.status === 'pending' || among(present, t.name))
      .map(t => (redoNew.has(t.id) ? { ...t, status: 'pending' as const, verdict: undefined, summary: undefined, reason: undefined } : t)),
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
    const verdicts = await grade($, file, text, names, { model }).catch(() => null)
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
    await update($, existing, ({ isFresh: _, only: _o, ...r }): ExistingRun => ({ ...r, state: 'idle', results: r.results.map(({ isPending: _p, ...t }) => t) }))
    soon($, () => gradeAll($, run.isFresh === true, run.only))
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
  const cwd = await $.session.cwd()
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
  const cwd = await $.session.cwd()
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
  const cwd = await $.session.cwd()
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
  const cwd = await $.session.cwd()
  await update($, openError, () => `Couldn't open ${shortPath(file, cwd)} in an editor: ${why}`)
}

// One list: the last Grade all tests run and the tests written this session, a test in
// both once, with the newer verdict; one written this session is marked new
type State = Verdict | 'unrated' | 'reviewing' | 'ungraded'
// isModified: a test that was there before, edited this session (a new one is new, not modified)
type Entry = { file: string; name: string; state: State; summary?: string; reason?: string; isNew: boolean; isModified?: boolean; suite?: string; evidence?: string }
const entriesOf = (graded: ExistingRun, list: TrackedTest[], edited: string[] = []): Entry[] => {
  const merged = new Map<string, Entry>()
  for (const t of graded.results) {
    const state: State = t.isPending ? 'reviewing' : t.isUngraded ? 'ungraded' : (verdictOf(t.verdict) ?? 'unrated')
    merged.set(`${t.file}:${t.name}`, { file: t.file, name: t.name, state, summary: t.summary, reason: t.reason, isNew: false, suite: t.suite, evidence: t.evidence })
  }
  for (const t of list) {
    const key = `${t.file}:${t.name}`
    const prev = merged.get(key)
    const state: State = t.status === 'pending' ? 'reviewing' : t.status === 'failed' ? 'unrated' : (verdictOf(t.verdict) ?? 'unrated')
    const isNewer = !prev || graded.finishedAt === undefined || t.at >= graded.finishedAt
    merged.set(key, isNewer ? { file: t.file, name: t.name, state, summary: t.summary, reason: t.reason, isNew: true, suite: t.suite ?? prev?.suite, evidence: t.evidence ?? prev?.evidence } : { ...prev, isNew: true })
  }
  for (const key of edited) {
    const t = merged.get(key)
    if (t && !t.isNew) merged.set(key, { ...t, isModified: true })
  }
  return [...merged.values()]
}

// the session's tool for evidence that a test is better (or worse) than its verdict
const EVIDENCE_TOOL = 'test_evidence'
const EVIDENCE_MAX = 4_000
const EVIDENCE_HINT =
  'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.'
const EVIDENCE_DESCRIPTION =
  'Ask test-grader to regrade one test on evidence that it deserves a different verdict. The grader cannot run code, so give it facts it can check against the source: the exact mutation you made (file, line, before and after), the command you ran, and the test\'s output before and after. ' +
  'Strong evidence: a mutation that changes behaviour and makes only this test fail. Weak evidence: that the test passes, that it has coverage, or that other tests cover the same code. Send one test per call; test_verify measures a mutation for you.'
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

const regradeOnEvidence = async ($: EngineInterface, file: string, text: string, name: string, caseName: string, evidence: string): Promise<string> => {
  const before = [...(await read($, existing)).results, ...(await read($, tests))].find(t => t.file === file && t.name === name)?.verdict
  const verdicts = await grade($, file, text, [caseName], { evidence, model: escalateModel ?? undefined }).catch(() => null)
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
  const cwd = await $.session.cwd()
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

// The session's tool for evidence test-grader measures itself: the test is run as it is (it
// must pass), then with one change made to the code under test (it should fail), and the file
// put back. What was run and what came of it goes to the grader as evidence. It changes files
// and runs commands, so the person is asked before it runs
const VERIFY_TOOL = 'test_verify'
const VERIFY_DESCRIPTION =
  'Have test-grader measure whether a test catches a bug: it runs the test unchanged (it must pass), applies your mutation to the code under test (replace one exact piece of text in one file), runs the test again (it should fail), and puts the file back. ' +
  'What it measured is sent to the grader as evidence, and the test regraded. Use it for a test you believe is better than its grade: pick a mutation that breaks the behaviour the test asserts.'
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'The test file, absolute or relative to the project' },
    test: { type: 'string', description: 'The test name, as test_grades lists it' },
    mutate: { type: 'string', description: 'The file of code under test to change for the second run (not a test file)' },
    find: { type: 'string', description: 'Exact text in that file, found exactly once, to replace' },
    replace: { type: 'string', description: 'What to put in its place: a plausible bug' },
  },
  required: ['file', 'test', 'mutate', 'find', 'replace'],
}

const answerVerify = async ($: EngineInterface, input: { file?: unknown; test?: unknown; mutate?: unknown; find?: unknown; replace?: unknown }): Promise<string> => {
  const cwd = await $.session.cwd()
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
  try {
    await $.fs.write(target, original.replace(find, replace))
    mutated = await runOne($, file, name).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
  } finally {
    await $.fs.write(target, original)
  }
  if ((await $.fs.read(target).catch(() => null)) !== original) return `test-grader could not put ${shortPath(target, cwd)} back as it was: check it now.`
  if (typeof mutated === 'string') return `The run with the mutation failed to start: ${mutated}. The file is back as it was; nothing was regraded.`
  if (mutated.isPassed) {
    return `The test still passes with ${JSON.stringify(find)} replaced by ${JSON.stringify(replace)} in ${shortPath(target, cwd)}: it does not catch that change. The file is back as it was; nothing was regraded.`
  }
  const evidence = clamp(
    [
      `Measured by test-grader, not claimed: ${clean.command} passed with the code unchanged.`,
      `With ${JSON.stringify(find)} replaced by ${JSON.stringify(replace)} in ${shortPath(target, cwd)}, the same command failed. The end of its output:`,
      mutated.tail,
    ].join('\n'),
    EVIDENCE_MAX,
  )
  return `Measured: the test passes unchanged and fails with the mutation. ${await regradeOnEvidence($, file, text, name, caseName, evidence)}`
}

// the session's tool for the grades as they stand: the flagged tests by default,
// worst first, each at its line, so Claude can find them without the pane
const GRADES_TOOL = 'test_grades'
const GRADES_LIMIT = 50
const LISTED: readonly State[] = [...FLAGGED, 'unrated', 'reviewing', 'ungraded', 'strong']
const GRADES_DESCRIPTION =
  'List the tests test-grader has graded, with each grade, what the test checks and why. A grade names what is wrong, and so the fix: hollow (cannot fail: rewrite it to assert on what the code does), duplicate (delete it or merge it), shallow (add the case it misses), brittle (assert on behaviour, not how the code does it), strong (keep it). ' +
  'By default only the flagged ones (hollow, duplicate, shallow, brittle), worst first, each with its file and line. ' +
  'Call it with written: true once you have finished writing or editing tests, and again after each fix. Use path to narrow to a file or folder.'
const GRADES_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: { type: 'string', enum: [...LISTED] },
      description: 'Which tests to list, by state; default ["hollow", "duplicate", "shallow", "brittle"]. unrated: the grader gave no verdict; reviewing: being graded; ungraded: never graded',
    },
    path: { type: 'string', description: 'Only tests in this file or folder, absolute or relative to the project' },
    written: { type: 'boolean', description: 'Only the tests written or edited this session' },
    limit: { type: 'number', description: `How many tests to list at most; default ${GRADES_LIMIT}` },
  },
}

const answerGrades = async ($: EngineInterface, input: { verdicts?: unknown; path?: unknown; limit?: unknown; written?: unknown }): Promise<string> => {
  const cwd = await $.session.cwd()
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
      `- ${shortPath(t.file, cwd)}${at} ${JSON.stringify(t.name)}: ${t.state}` +
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
  const found = await branchFiles($, await $.session.cwd())
  if (typeof found === 'string') return found
  if (found.files.length === 0) return `No test files changed against ${found.base}.`
  soon($, () => gradeAll($, true, found.files))
  return `Grading the ${found.files.length} test ${found.files.length === 1 ? 'file' : 'files'} changed against ${found.base}.`
}

// The grades written out, for a review or CI: a Markdown page and its JSON, at the project's root
const REPORT = 'test-grader-report'
const writeReport = async ($: EngineInterface): Promise<string> => {
  const cwd = await $.session.cwd()
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

export const register: Register = (on, options) => {
  graderModel = modelOf(options.graderModel, DEFAULT_MODEL)
  escalateModel = options.graderEscalate === 'off' ? null : modelOf(options.graderEscalate, '') || null
  parallel = workersOf(options.graderWorkers)
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
      .register({ name: VERIFY_TOOL, description: VERIFY_DESCRIPTION, inputSchema: VERIFY_SCHEMA })
      .catch(error => $.ui.log(`test-grader: the verify tool could not be registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
    runners = await detectRunners($, await $.session.cwd()).catch(() => ({}))
    await refreshCoverage($)
    // the coverage run this project has, if any: the pane offers it only then
    const cover = await detectCommand($, await $.session.cwd()).catch(() => undefined)
    await update($, coverWith, () => cover?.label ?? null)
    await readRules($).catch(() => undefined)
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
      // a file written afresh holds its old cases too: only the ones not tracked yet are new
      const known = new Set((await read($, tests)).filter(t => t.file === e.file_path).map(t => t.name))
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

    // a group's header line: its toggle, its counts, and new when it holds a new test
    // lines: the folder's line coverage, when the report has it
    const header = (key: string, label: string, of: Entry[], indent: number, open: boolean, onPress: () => Promise<void>, lines?: { total: number; covered: number }): unknown => {
      const linePct = lines && lines.total > 0 ? Math.round((lines.covered / lines.total) * 100) : null
      const worst = worstFirst(of)[0]!.state
      const groupCounts = [
        `${of.length}`,
        `${tally(of, 'strong')} strong`,
        ...([...FLAGGED, 'unrated', 'reviewing', 'ungraded'] as const).filter(s => tally(of, s) > 0).map(s => `${tally(of, s)} ${s}`),
      ].join(' · ')
      return (
        <Box key={`h-${key}`} flexDirection="row" gap={1} marginLeft={indent}>
          <Button key={key} plain label={`${open ? '▾' : '▸'} ${clamp(label, Math.max(16, columns - groupCounts.length - 10 - indent))}`} onPress={onPress} />
          <Text color={stateColor(worst)}>{groupCounts}</Text>
          {linePct !== null && <Text color={pctColor(linePct)}>{`${linePct}% lines`}</Text>}
          {of.some(t => t.isNew) && <Text color={VIOLET}>new</Text>}
          {of.some(t => t.isModified) && <Text color={BLUE}>modified</Text>}
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
      const room = columns - indent - 2 - verdictWidth - 1 - (t.isNew ? ' new'.length : 0) - (t.isModified ? ' modified'.length : 0) - (t.evidence ? ' on evidence'.length : 0)
      return Math.max(12, Math.floor(room * (e.surface === 'desktop' ? 1.2 : 1)))
    }
    // openKey: where its open or closed is kept; a top-level file's, by its path as before
    const drawFile = (key: string, openKey: string, label: string, of: Entry[], indent: number, siblings: number): void => {
      const open = isGroupOpen(openKey, siblings)
      drawn.push(header(key, label, of, indent, open, flip(openKey, open)))
      if (!open) return
      for (const t of of) {
        const key = `r:${t.file}:${t.name}`
        const ran = runs[`${t.file}:${t.name}`]
        const reason = t.state === 'unrated' ? `The grader gave no verdict for this test. ${graderFailed ?? ''}${graderFailed ? ' ' : ''}Grade again to retry it.` : t.state === 'ungraded' ? 'Not graded yet: Grade all tests grades it.' : t.reason
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
          drawn.push(header(key, `${prefix}${c.name}/`, c.of, indent, open, flip(key, open), cov?.byDir?.[c.folder.path]))
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
        drawn.push(header(key, prefix ? `${g.suite} · ${prefix.slice(0, -1)}` : g.suite, g.of, indent, open, flip(key, open)))
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

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color={VIOLET}>{counts}</Text>
        {graded.state === 'failed' && <Text color={RED}>{graded.message ?? 'Grading failed.'}</Text>}
        {graded.state === 'idle' && graded.graded !== undefined && (
          <Text color={MUTED}>
            {`Last run: ${graded.graded} graded · ${graded.remembered ?? 0} remembered` +
              (graded.spent && graded.spent.input + graded.spent.output > 0 ? ` · ${tokens(graded.spent.input)} in (${tokens(graded.spent.cached)} cached) / ${tokens(graded.spent.output)} out` : '')}
          </Text>
        )}
        {graded.state === 'idle' && graded.message !== undefined && <Text color={AMBER}>{graded.message}</Text>}
        {graderFailed !== null && <Text color={RED}>{graderFailed}</Text>}
        <Box flexDirection="column" flexGrow={1} marginTop={1}>
          {entries.length === 0 && (
            <Text color={MUTED}>No tests yet. New tests show up here as they are written; Grade all tests grades the ones already there.</Text>
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
            {graded.state === 'running' && <Button key="stopGrading" label="Stop" onPress={() => stopGrading()} />}
            {graded.state !== 'running' && graded.hashes && Object.keys(graded.hashes).length > 0 && (
              <Button key="regradeAll" label="Regrade all" onPress={() => soon($, () => gradeAll($, true))} />
            )}
          </Box>
        </Box>
      </Box>
    )
  })
}
