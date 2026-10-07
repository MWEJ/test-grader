import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Coverage, ExistingTest, TrackedTest, Verdict } from '../types'

const PANE = 'test-watch'
const tests = atom({ plugin: 'test-watch', key: 'tests' } as const, [])
const coverage = atom({ plugin: 'test-watch', key: 'coverage' } as const, null)
const run = atom({ plugin: 'test-watch', key: 'run' } as const, { state: 'idle' })
const existing = atom({ plugin: 'test-watch', key: 'existing' } as const, { state: 'idle', done: 0, total: 0, results: [] })

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
const MAX_LISTED = 20

const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]*\.py$|Tests?\.(swift|kt|java)$|(^|\/)(__tests__|tests?)\/[^/]+\.[cm]?[jt]sx?$/
const CASE_PATTERNS = [
  /\b(?:it|test)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(\s*(['"`])(.+?)\1/g,
  /^\s*(?:async\s+)?def\s+(test_\w+)/gm,
  /\bfunc\s+(Test\w+)\s*\(/g,
  /\bfunc\s+(test\w+)\s*\(/g,
  /^\s*#\[test\]\s*\n\s*(?:async\s+)?fn\s+(\w+)/gm,
]

const verdictColor = (v: Verdict | undefined): string =>
  v === 'good' ? GREEN : v === 'weak' ? AMBER : v === 'useless' ? RED : MUTED

const pctColor = (p: number): string => (p >= 80 ? GREEN : p >= 50 ? AMBER : RED)

const shortPath = (file: string, cwd: string): string => (cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file)

const caseNames = (text: string): string[] => {
  const names: string[] = []
  for (const pattern of CASE_PATTERNS) {
    for (const m of text.matchAll(pattern)) names.push((m[2] ?? m[1]) as string)
  }
  return names
}

const clamp = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// where each case starts in a file, in file order
const caseStarts = (text: string): { name: string; at: number }[] => {
  const starts: { name: string; at: number }[] = []
  for (const pattern of CASE_PATTERNS) {
    for (const m of text.matchAll(pattern)) starts.push({ name: (m[2] ?? m[1]) as string, at: m.index ?? 0 })
  }
  return starts.sort((a, b) => a.at - b.at)
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
      list.map(t => {
        if (!ids.has(t.id)) return t
        const v = verdicts.find(x => x.name === t.name)
        return v ? { ...t, status: 'done', summary: v.summary, verdict: v.verdict, reason: v.reason } : { ...t, status: 'failed' }
      }),
    )
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

// Grade all tests: every case of every test file git tracks, a file at a time and
// BATCH cases a call. A batch the grader fails leaves its cases unrated, and the run goes on
const gradeAll = async ($: EngineInterface): Promise<void> => {
  if ((await read($, existing)).state === 'running') return
  const cwd = await $.session.cwd()
  const fail = (message: string) => update($, existing, () => ({ state: 'failed', done: 0, total: 0, message, results: [] }))
  try {
    const listed = await $.process.run(['git', 'ls-files'], { cwd, timeoutMs: 60_000 })
    if (listed.exitCode !== 0) return void (await fail('Not a git repository: there is no list of test files to grade.'))
    const files = listed.stdout.split('\n').filter(f => f !== '' && TEST_FILE.test(f))
    await update($, existing, () => ({ state: 'running', done: 0, total: files.length, results: [] }))
    const results: ExistingTest[] = []
    for (const [i, rel] of files.entries()) {
      const file = `${cwd}/${rel}`
      const text = await $.fs.read(file)
      const names = [...new Set(caseNames(text))]
      for (let at = 0; at < names.length; at += BATCH) {
        const batch = names.slice(at, at + BATCH)
        const verdicts = (await grade($, file, text, batch).catch(() => null)) ?? []
        for (const name of batch) {
          const v = verdicts.find(x => x.name === name)
          results.push(v ? { file, name, verdict: v.verdict, summary: v.summary, reason: v.reason } : { file, name })
        }
      }
      await update($, existing, s => ({ ...s, done: i + 1 }))
    }
    await update($, existing, () => ({ state: 'idle', done: files.length, total: files.length, results }))
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tests', description: 'Open the test-watch pane (new tests, their quality, coverage)' })
    await refreshCoverage($)
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
      if (names.length > 0) await track($, e.file_path, names)
    }

    return ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && TEST_FILE.test(e.file_path)) {
      const before = new Set(caseNames(e.old_string))
      const names = caseNames(e.new_string).filter(n => !before.has(n))
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
    const list = await read($, tests)
    const cov = await read($, coverage)
    const running = await read($, run)
    const graded = await read($, existing)
    const cwd = await $.session.cwd()
    const now = await $.clock.now()

    const rows = e.viewport?.rows ?? 30
    const room = Math.max(1, Math.floor((rows - 12) / 5))
    const shown = [...list].reverse().slice(0, room)
    const count = (v: Verdict): number => list.filter(t => t.verdict === v).length
    const pending = list.filter(t => t.status === 'pending').length

    const metrics: [string, number | null][] = cov
      ? [['Lines', cov.lines], ['Statements', cov.statements], ['Branches', cov.branches], ['Functions', cov.functions]]
      : []
    const age = cov?.updatedAt ? Math.max(0, Math.round((now - cov.updatedAt) / 60_000)) : null

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold color={VIOLET}>{`${list.length} new tests`}</Text>
          <Text color={GREEN}>{`${count('good')} good`}</Text>
          <Text color={AMBER}>{`${count('weak')} weak`}</Text>
          <Text color={RED}>{`${count('useless')} useless`}</Text>
          {pending > 0 && <Text color={MUTED}>{`${pending} reviewing`}</Text>}
        </Box>
        <Box flexDirection="column" flexGrow={1} marginTop={1} gap={1}>
          {list.length === 0 && <Text color={MUTED}>No new tests yet. They show up here as they are written.</Text>}
          {shown.map(t => (
            <Box key={`t-${t.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text bold color={verdictColor(t.verdict)}>
                  {t.status === 'pending' ? 'reviewing' : t.status === 'failed' ? 'unrated' : t.verdict}
                </Text>
                <Text bold>{t.name}</Text>
              </Box>
              <Text color={MUTED}>{shortPath(t.file, cwd)}</Text>
              {t.summary && <Text>{t.summary}</Text>}
              {t.reason && <Text color={verdictColor(t.verdict)}>{t.reason}</Text>}
            </Box>
          ))}
          {list.length > shown.length && <Text color={MUTED}>{`+ ${list.length - shown.length} older`}</Text>}
        </Box>
        {(graded.state !== 'idle' || graded.results.length > 0) && (() => {
          const of = (v: Verdict): ExistingTest[] => graded.results.filter(t => t.verdict === v)
          const unrated = graded.results.filter(t => !t.verdict).length
          const listed = [...of('useless'), ...of('weak')]
          return (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Box flexDirection="row" gap={2}>
                <Text bold>Existing tests</Text>
                {graded.results.length > 0 && (
                  <Text color={MUTED}>
                    {[`${graded.results.length} graded`, `${of('good').length} good`, `${of('weak').length} weak`, `${of('useless').length} useless`, ...(unrated > 0 ? [`${unrated} unrated`] : [])].join(' · ')}
                  </Text>
                )}
              </Box>
              {graded.state === 'failed' && <Text color={RED}>{graded.message ?? 'Grading failed.'}</Text>}
              {listed.slice(0, MAX_LISTED).map((t, i) => (
                <Box key={`e-${i}-${t.file}-${t.name}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text bold color={verdictColor(t.verdict)}>{t.verdict}</Text>
                    <Text bold>{t.name}</Text>
                  </Box>
                  <Text color={MUTED}>{shortPath(t.file, cwd)}</Text>
                  {t.summary && <Text>{t.summary}</Text>}
                  {t.reason && <Text color={verdictColor(t.verdict)}>{t.reason}</Text>}
                </Box>
              ))}
              {listed.length > MAX_LISTED && <Text color={MUTED}>{`+ ${listed.length - MAX_LISTED} more`}</Text>}
            </Box>
          )
        })()}
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
              label={graded.state === 'running' ? `Grading ${Math.min(graded.done + 1, graded.total)}/${graded.total} files…` : 'Grade all tests'}
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
