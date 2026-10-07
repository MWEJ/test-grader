import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Coverage, ExistingTest, TrackedTest, Verdict } from '../types'

const PANE = 'test-watch'
const tests = atom({ plugin: 'test-watch', key: 'tests' } as const, [])
const coverage = atom({ plugin: 'test-watch', key: 'coverage' } as const, null)
const run = atom({ plugin: 'test-watch', key: 'run' } as const, { state: 'idle' })
const existing = atom({ plugin: 'test-watch', key: 'existing' } as const, { state: 'idle', done: 0, total: 0, results: [] })
const noteError = atom({ plugin: 'test-watch', key: 'noteError' } as const, null)
const opened = atom({ plugin: 'test-watch', key: 'open' } as const, [])
const fileOpen = atom({ plugin: 'test-watch', key: 'fileOpen' } as const, {})

const GREEN = '#4ade80'
const AMBER = '#fbbf24'
const RED = '#f87171'
const MUTED = '#8b90a0'
const TRACK = '#343848'
const VIOLET = '#a78bfa'
const MAX_TESTS = 60
const MAX_SOURCE = 12_000
// of a file too long to send whole: at most this much of its head (imports, helpers)
const MAX_HEAD = 4_000
const CELLS = 12
// Grade all tests: cases per grader call, and how many weak or useless ones are listed
const BATCH = 10
// grader calls in flight at once
const PARALLEL = 4

const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]*\.py$|Tests?\.(swift|kt|java)$|(^|\/)(__tests__|tests?)\/[^/]+\.[cm]?[jt]sx?$/
// a JS case opens its own line, so one quoted inside a fixture string is not one; its
// name runs to the closing quote, past any escaped one
const CASE_PATTERNS = [
  /^[ \t]*(?:it|test)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])+)\1/gm,
  /^\s*(?:async\s+)?def\s+(test_\w+)/gm,
  /\bfunc\s+(Test\w+)\s*\(/g,
  /\bfunc\s+(test\w+)\s*\(/g,
  /^\s*#\[test\]\s*\n\s*(?:async\s+)?fn\s+(\w+)/gm,
]

const verdictColor = (v: Verdict | undefined): string =>
  v === 'good' ? GREEN : v === 'weak' ? AMBER : v === 'useless' ? RED : MUTED

const pctColor = (p: number): string => (p >= 80 ? GREEN : p >= 50 ? AMBER : RED)

const shortPath = (file: string, cwd: string): string => (cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file)

const nameOf = (m: RegExpMatchArray): string => (m[2] ?? (m[1] as string)).replace(/\\(.)/g, '$1')

const caseNames = (text: string): string[] => {
  const names: string[] = []
  for (const pattern of CASE_PATTERNS) {
    for (const m of text.matchAll(pattern)) names.push(nameOf(m))
  }
  return names
}

const clamp = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// where each case starts in a file, in file order: right after the previous case closes
// (a line opening with "})"), so what sits between two cases (a comment, the data a
// loop runs over, the loop itself) goes with the case below it; failing a close, on
// the line after the previous case's first
const caseStarts = (text: string): { name: string; at: number }[] => {
  const found: { name: string; at: number }[] = []
  for (const pattern of CASE_PATTERNS) {
    for (const m of text.matchAll(pattern)) found.push({ name: nameOf(m), at: m.index ?? 0 })
  }
  found.sort((a, b) => a.at - b.at)
  return found.map((start, i) => {
    const prev = found[i - 1]
    if (!prev) return start
    const between = text.slice(prev.at, start.at)
    const closes = [...between.matchAll(/\n[ \t]*\}\)[^\n]*\n/g)]
    const last = closes[closes.length - 1]
    const after = last ? last.index! + last[0].length : between.indexOf('\n') + 1
    return after > 0 ? { name: start.name, at: prev.at + after } : start
  })
}

// A name with ${…} in it is a template: the cases a loop generates. The grader names each
// case as the loop expands it, and a returned name belongs to the template it fits
const isTemplate = (name: string): boolean => /\$\{[^}]*\}/.test(name)
const fits = (template: string, name: string): boolean => {
  if (!isTemplate(template)) return template === name
  const parts = template.split(/\$\{[^}]*\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${parts.join('[\\s\\S]+?')}$`).test(name)
}

// What the grader reads: the whole file when it fits, else its head and the new cases
// themselves, each from its start to the next case's, wherever in the file they sit
const excerptOf = (source: string, names: string[]): string => {
  if (source.length <= MAX_SOURCE) return source
  const starts = caseStarts(source)
  const head = clamp(source.slice(0, starts[0]?.at ?? source.length), MAX_HEAD)
  const bodies = starts.flatMap((start, i) =>
    names.includes(start.name) ? [source.slice(start.at, starts[i + 1]?.at ?? source.length).trimEnd()] : [],
  )
  const room = Math.max(1_000, Math.floor((MAX_SOURCE - head.length) / Math.max(1, bodies.length)))
  return [head.trimEnd(), '// … other tests left out …', ...bodies.map(b => clamp(b, room))].join('\n\n')
}

const parseVerdicts = (text: string): { name: string; summary: string; verdict: Verdict; reason: string }[] => {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(raw)) return []
    return raw.flatMap(r => {
      const o = r as Record<string, unknown>
      const verdict = o.verdict === 'good' || o.verdict === 'weak' || o.verdict === 'useless' ? o.verdict : undefined
      if (typeof o.name !== 'string' || !verdict) return []
      return [{ name: o.name, summary: String(o.summary ?? ''), verdict, reason: String(o.reason ?? '') }]
    })
  } catch {
    return []
  }
}

// A note for Claude: a user-role row it reads on its next turn, no turn started. A refusal
// or a failure is kept for the pane to show, until a note goes through. The debug log has
// every note, appended or not (a test cannot see a row a mod appends)
const share = async ($: EngineInterface, text: string): Promise<void> => {
  let error: string | null = null
  try {
    const row = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    if (row.deny !== undefined) error = row.deny
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  $.ui.log(`test-watch: note to Claude (${error === null ? 'appended' : `not appended: ${error}`}): ${text}`, { to: 'debug' })
  await update($, noteError, () => error)
}

// the weak and useless of a list, the useless first, one line each
const flaggedLines = (list: { file: string; name: string; verdict?: Verdict; reason?: string }[], cwd: string): string[] =>
  (['useless', 'weak'] as const).flatMap(v =>
    list.filter(t => t.verdict === v).map(t => `- ${v} · ${shortPath(t.file, cwd)} · ${t.name} — ${t.reason ?? ''}`),
  )

type Graded = { name: string; summary: string; verdict: Verdict; reason: string }

// One grader call: these cases of this file, judged; null when the grader gave no answer
const grade = async ($: EngineInterface, file: string, text: string, names: string[]): Promise<Graded[] | null> => {
  const source = excerptOf(text, names)
  const reply = await $.model.complete({
    model: 'haiku',
    maxTokens: 1500,
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
      'Return a JSON array: [{"name": string, "summary": string, "verdict": "good"|"weak"|"useless", "reason": string}]',
      '',
      '```',
      source,
      '```',
    ].join('\n'),
  })
  return reply.isAnswered ? parseVerdicts(reply.text) : null
}

const evaluate = async ($: EngineInterface, file: string, ids: Map<string, string>): Promise<void> => {
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
    // the weak and useless among them, told to Claude (the good ones are no news)
    const mine = (await read($, tests)).filter(t => [...ids.keys()].some(id => t.id === id || t.id.startsWith(`${id}-`)))
    const lines = flaggedLines(mine, await $.session.cwd())
    if (lines.length > 0) await share($, ['New tests graded weak or useless (test-watch):', ...lines].join('\n'))
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
  const goPath = `${cwd}/.test-watch-go-coverage.txt`

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

const detectCommand = async ($: EngineInterface, cwd: string): Promise<{ argv: string[]; goOutput?: string } | undefined> => {
  const exists = async (name: string): Promise<boolean> => (await mtime($, `${cwd}/${name}`)) !== null
  if (await exists('package.json')) {
    const pkg = await $.fs.read(`${cwd}/package.json`)
    if (/"vitest"/.test(pkg)) return { argv: ['npx', 'vitest', 'run', '--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=lcov'] }
    if (/"jest"/.test(pkg)) return { argv: ['npx', 'jest', '--coverage', '--coverageReporters=json-summary', '--coverageReporters=lcov'] }
  }
  if ((await exists('pytest.ini')) || (await exists('pyproject.toml')) || (await exists('setup.cfg'))) {
    return { argv: ['python3', '-m', 'pytest', '--cov', '--cov-report=xml'] }
  }
  if (await exists('go.mod')) return { argv: ['go', 'test', './...', '-cover'], goOutput: '.test-watch-go-coverage.txt' }
  return undefined
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
  const lines = [`Test grading (test-watch) finished: ${counts.join(' · ')}.`]
  const flagged = flaggedLines(results, cwd)
  if (flagged.length > 0) lines.push('Weak or useless, worst first:', ...flagged)
  if (unrated.length > 0) lines.push('Unrated (the grader gave no verdict):', ...unrated.map(t => `- ${shortPath(t.file, cwd)} · ${t.name}`))
  return lines.join('\n')
}

// Grade all tests: every case of every test file git tracks, BATCH cases a call and
// PARALLEL calls at once; the results keep file order. A batch the grader fails leaves
// its cases unrated, and the run goes on
const gradeAll = async ($: EngineInterface): Promise<void> => {
  if ((await read($, existing)).state === 'running') return
  const cwd = await $.session.cwd()
  const fail = (message: string) => update($, existing, () => ({ state: 'failed', done: 0, total: 0, message, results: [] }))
  try {
    const listed = await $.process.run(['git', 'ls-files'], { cwd, timeoutMs: 60_000 })
    if (listed.exitCode !== 0) return void (await fail('Not a git repository: there is no list of test files to grade.'))
    const files = listed.stdout.split('\n').filter(f => f !== '' && TEST_FILE.test(f))
    await update($, existing, () => ({ state: 'running', done: 0, total: files.length, results: [] }))
    // every file's batches, in file order; a file is done when its last batch is
    const jobs: { file: string; text: string; batch: string[]; slot: ExistingTest[][] }[] = []
    const perFile: { left: number; slots: ExistingTest[][] }[] = []
    let done = 0
    for (const rel of files) {
      const file = `${cwd}/${rel}`
      const text = await $.fs.read(file)
      const names = [...new Set(caseNames(text))]
      const entry = { left: 0, slots: [] as ExistingTest[][] }
      for (let at = 0; at < names.length; at += BATCH) {
        const slot: ExistingTest[] = []
        entry.slots.push(slot)
        entry.left += 1
        jobs.push({ file, text, batch: names.slice(at, at + BATCH), slot })
      }
      perFile.push(entry)
      if (entry.left === 0) done += 1
    }
    await update($, existing, s => ({ ...s, done }))
    const owner = new Map(perFile.flatMap(f => f.slots.map(slot => [slot, f] as const)))
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        const { file, text, batch, slot } = jobs[next++]!
        const verdicts = (await grade($, file, text, batch).catch(() => null)) ?? []
        for (const name of batch) {
          const found = verdicts.filter(v => fits(name, v.name))
          if (found.length === 0) slot.push({ file, name })
          for (const v of found) slot.push({ file, name: v.name, verdict: v.verdict, summary: v.summary, reason: v.reason })
        }
        const entry = owner.get(slot)!
        entry.left -= 1
        if (entry.left === 0) {
          done += 1
          await update($, existing, s => ({ ...s, done }))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker))
    const results = perFile.flatMap(f => f.slots.flat())
    const finishedAt = await $.clock.now()
    await update($, existing, () => ({ state: 'idle', done: files.length, total: files.length, results, finishedAt }))
    await share($, existingNote(results, cwd))
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err))
  }
}

const track = async ($: EngineInterface, file: string, names: string[]): Promise<void> => {
  const now = await $.clock.now()
  const ids = new Map<string, string>()
  const entries: TrackedTest[] = names.map((name, i) => {
    const id = `${now}-${i}-${file}`
    ids.set(id, name)
    return { id, file, name, at: now, status: 'pending' }
  })
  await update($, tests, list => [...list, ...entries].slice(-MAX_TESTS))
  $.clock.after(1, () => void evaluate($, file, ids))
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
  const present = caseNames(text)
  const isRedo = (t: { file: string; name: string; verdict?: Verdict }): boolean =>
    t.file === file && t.verdict !== 'good' && among(touched, t.name)

  const now = await read($, tests)
  const redoNew = new Map(now.filter(t => isRedo(t) && t.status !== 'pending' && among(present, t.name)).map(t => [t.id, t.name]))
  await update($, tests, list =>
    list
      .filter(t => t.file !== file || t.status === 'pending' || among(present, t.name))
      .map(t => (redoNew.has(t.id) ? { ...t, status: 'pending' as const, verdict: undefined, summary: undefined, reason: undefined } : t)),
  )
  if (redoNew.size > 0) $.clock.after(1, () => void evaluate($, file, redoNew))

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
  $.clock.after(1, async () => {
    const verdicts = await grade($, file, text, redo).catch(() => null)
    await update($, existing, r => ({
      ...r,
      results: r.results.map(t => {
        if (!pick(t)) return t
        const v = verdicts?.find(x => x.name === t.name)
        return { file: t.file, name: t.name, ...(v ? { verdict: v.verdict, summary: v.summary, reason: v.reason } : {}) }
      }),
    }))
  })
}

// At a session's start: an entry whose test is no longer among its file's cases, or whose
// file is gone, was changed while no session watched it, and leaves both lists
const prune = async ($: EngineInterface): Promise<void> => {
  const files = [...new Set([...(await read($, tests)).map(t => t.file), ...(await read($, existing)).results.map(t => t.file)])]
  const present = new Map<string, string[]>()
  for (const file of files) present.set(file, await $.fs.read(file).then(caseNames, () => []))
  const isThere = (t: { file: string; name: string }): boolean => among(present.get(t.file) ?? [], t.name)
  await update($, tests, list => list.filter(t => t.status === 'pending' || isThere(t)))
  await update($, existing, r => ({ ...r, results: r.results.filter(isThere) }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tests', description: 'Open the test-watch pane (new tests, their quality, coverage)' })
    await refreshCoverage($)
    await prune($).catch(() => undefined)
    // each session starts with its files at their default, closed when there are several
    await update($, fileOpen, () => ({}))
    void $.ui.open({ id: PANE, title: 'Tests' })

    return next(e)
  })

  on('command.run', { command: 'tests' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Tests' })
    await refreshCoverage($)

    return { text: 'Test pane opened.' }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && TEST_FILE.test(e.file_path)) {
      const names = caseNames(e.content)
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
      const before = new Set(caseNames(e.old_string))
      const touched = caseNames(e.new_string)
      await refresh($, e.file_path, touched)
      const names = touched.filter(n => !before.has(n))
      if (names.length > 0) await track($, e.file_path, names)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    await refreshCoverage($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cwd = await $.session.cwd()
    // only this session's folder: a test written elsewhere is graded and told, not listed
    const list = (await read($, tests)).filter(t => cwd !== '' && t.file.startsWith(`${cwd}/`))
    const cov = await read($, coverage)
    const running = await read($, run)
    const graded = await read($, existing)
    const noteFailed = await read($, noteError)
    const now = await $.clock.now()

    const columns = e.viewport?.columns ?? 60
    const isOpen = new Set(await read($, opened))
    const filesOpen = await read($, fileOpen)
    const toggle = (key: string): Promise<void> =>
      update($, opened, keys => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key].slice(-MAX_TESTS)))

    // One list: the last Grade all tests run and the tests written this session, a test in
    // both once, with the newer verdict; one written this session is marked new
    type State = Verdict | 'unrated' | 'reviewing'
    type Entry = { file: string; name: string; state: State; summary?: string; reason?: string; isNew: boolean }
    const merged = new Map<string, Entry>()
    for (const t of graded.results) {
      const state: State = t.isPending ? 'reviewing' : (t.verdict ?? 'unrated')
      merged.set(`${t.file}:${t.name}`, { file: t.file, name: t.name, state, summary: t.summary, reason: t.reason, isNew: false })
    }
    for (const t of list) {
      const key = `${t.file}:${t.name}`
      const prev = merged.get(key)
      const state: State = t.status === 'pending' ? 'reviewing' : t.status === 'failed' ? 'unrated' : (t.verdict ?? 'unrated')
      const isNewer = !prev || graded.finishedAt === undefined || t.at >= graded.finishedAt
      merged.set(key, isNewer ? { file: t.file, name: t.name, state, summary: t.summary, reason: t.reason, isNew: true } : { ...prev, isNew: true })
    }
    const entries = [...merged.values()]
    const tally = (of: Entry[], s: State): number => of.filter(t => t.state === s).length

    // grouped by file, worst file first; in a file the worst test first, the new ahead
    const RANK: Record<State, number> = { useless: 0, weak: 1, unrated: 2, reviewing: 3, good: 4 }
    const byFile = new Map<string, Entry[]>()
    for (const t of entries) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t])
    const files = [...byFile.entries()]
      .map(([file, of]) => ({ file, of: [...of].sort((a, b) => RANK[a.state] - RANK[b.state] || Number(b.isNew) - Number(a.isNew)) }))
      .sort((a, b) =>
        tally(b.of, 'useless') - tally(a.of, 'useless') || tally(b.of, 'weak') - tally(a.of, 'weak') ||
        tally(b.of, 'unrated') - tally(a.of, 'unrated') || a.file.localeCompare(b.file))
    const stateColor = (s: State): string => (s === 'good' || s === 'weak' || s === 'useless' ? verdictColor(s) : MUTED)
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

    const counts = [
      plural(entries.length, 'test'),
      `${tally(entries, 'good')} good`,
      `${tally(entries, 'weak')} weak`,
      `${tally(entries, 'useless')} useless`,
      ...(tally(entries, 'unrated') > 0 ? [`${tally(entries, 'unrated')} unrated`] : []),
      ...(tally(entries, 'reviewing') > 0 ? [`${tally(entries, 'reviewing')} reviewing`] : []),
      ...(list.length > 0 ? [`${new Set(list.map(t => `${t.file}:${t.name}`)).size} new`] : []),
    ].join(' · ')

    // a file's header line, and when it is open every one of its tests, the pane scrolling
    const drawn: unknown[] = []
    for (const { file, of } of files) {
      const fileKey = `f:${file}`
      // one file starts open, several start closed; a press sets it, until the next session
      const open = filesOpen[file] ?? files.length === 1
      const worst = of[0]!.state
      const fileCounts = [
        `${of.length}`,
        `${tally(of, 'good')} good`,
        ...(['weak', 'useless', 'unrated', 'reviewing'] as const).filter(s => tally(of, s) > 0).map(s => `${tally(of, s)} ${s}`),
      ].join(' · ')
      drawn.push(
        <Box key={`fh-${file}`} flexDirection="row" gap={1}>
          <Button key={fileKey} plain label={`${open ? '▾' : '▸'} ${clamp(shortPath(file, cwd), Math.max(16, columns - fileCounts.length - 10))}`} onPress={() => update($, fileOpen, all => ({ ...all, [file]: !open }))} />
          <Text color={worst === 'good' ? GREEN : stateColor(worst)}>{fileCounts}</Text>
          {of.some(t => t.isNew) && <Text color={VIOLET}>new</Text>}
        </Box>,
      )
      if (!open) continue
      for (const t of of) {
        const key = `r:${t.file}:${t.name}`
        const reason = t.state === 'unrated' ? 'The grader gave no verdict for this test. Grade again to retry it.' : t.reason
        drawn.push(
          <Box key={`row-${key}`} flexDirection="column" marginLeft={2}>
            <Box flexDirection="row" gap={1}>
              <Text bold color={stateColor(t.state)}>{t.state}</Text>
              <Button key={key} plain label={clamp(t.name, Math.max(12, columns - t.state.length - (t.isNew ? 10 : 6)))} onPress={() => toggle(key)} />
              {t.isNew && <Text color={VIOLET}>new</Text>}
            </Box>
            {isOpen.has(key) && (
              <Box flexDirection="column" marginLeft={2}>
                {t.summary && <Text>{t.summary}</Text>}
                {reason && <Text color={stateColor(t.state)}>{reason}</Text>}
              </Box>
            )}
          </Box>,
        )
      }
    }

    const metrics: [string, number | null][] = cov
      ? [['Lines', cov.lines], ['Statements', cov.statements], ['Branches', cov.branches], ['Functions', cov.functions]]
      : []
    const age = cov?.updatedAt ? Math.max(0, Math.round((now - cov.updatedAt) / 60_000)) : null

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color={VIOLET}>{counts}</Text>
        {graded.state === 'failed' && <Text color={RED}>{graded.message ?? 'Grading failed.'}</Text>}
        <Box flexDirection="column" flexGrow={1} marginTop={1}>
          {entries.length === 0 && (
            <Text color={MUTED}>No tests yet. New tests show up here as they are written; Grade all tests grades the ones already there.</Text>
          )}
          {drawn as never}
        </Box>
        {noteFailed !== null && <Text color={RED}>{`Couldn't share the result with Claude: ${noteFailed}`}</Text>}
        <Box flexDirection="column" marginTop={1}>
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
          <Box flexDirection="row" gap={2} marginTop={1}>
            <Button
              key="run"
              label={running.state === 'running' ? 'Running…' : 'Run coverage'}
              onPress={() => (running.state === 'running' ? undefined : runCoverage($))}
            />
            <Button
              key="gradeAll"
              label={graded.state === 'running' ? `Grading… ${graded.done}/${graded.total} files done` : 'Grade all tests'}
              // on a timer: a run outlasts the press that starts it
              onPress={() => (graded.state === 'running' ? undefined : $.clock.after(1, () => void gradeAll($)))}
            />
            <Button key="clear" label="Clear list" onPress={() => update($, tests, () => [])} />
          </Box>
        </Box>
      </Box>
    )
  })
}
