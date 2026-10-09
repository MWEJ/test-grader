// Which tests the last coverage run ran, read from what its runner reported: Go's -v lines, and
// Jest's or Vitest's JSON results; pure, so the engine calls stay in register.tsx
import { fits } from './discovery'

export type Outcome = 'passed' | 'failed' | 'skipped'
// a graded test as the last run left it: run, skipped, or not run at all though its file was in
// the run's reach; not built: a Go file whose build tag the run was not given, so it was never
// compiled, as the project chose and no fault of the test
export type RanState = 'ran' | 'skipped' | 'never ran' | 'not built'

// the run's tests by where they live, a JS file's path or a Go package's folder, each name with
// how it ended; measured: the folders the run reached, in which a test not listed did not run
// tagsBy: the build tags each Go folder was run with
export type RanRecord = { at: number; measured: string[]; by: Record<string, Record<string, Outcome>>; tagsBy?: Record<string, string[]> }

// the build tags a go test argv gives: -tags a,b, -tags=a,b, or the older space-separated list
export const tagsOfArgv = (argv: string[]): string[] => {
  const at = argv.findIndex(a => a === '-tags' || a === '--tags' || a.startsWith('-tags=') || a.startsWith('--tags='))
  if (at === -1) return []
  const value = argv[at]!.includes('=') ? argv[at]!.slice(argv[at]!.indexOf('=') + 1) : (argv[at + 1] ?? '')
  return value.split(/[,\s]+/).filter(Boolean)
}

const better = (a: Outcome | undefined, b: Outcome): Outcome => (a === undefined || a === 'skipped' ? b : a)

// go test -v: each test's --- PASS, FAIL or SKIP line, under the package line that ends its
// output (ok, FAIL or ? and the package's import path); a package is told by its folder
export const goRanOf = (output: string, moduleDir: string, module: string): Record<string, Record<string, Outcome>> => {
  const by: Record<string, Record<string, Outcome>> = {}
  let pending: [string, Outcome][] = []
  for (const line of output.split('\n')) {
    const result = /^\s*--- (PASS|FAIL|SKIP): (\S+)/.exec(line)
    if (result) {
      pending.push([result[2]!, result[1] === 'PASS' ? 'passed' : result[1] === 'FAIL' ? 'failed' : 'skipped'])
      continue
    }
    const pkg = /^(?:ok|FAIL|\?)\s+(\S+)(?:\s|$)/.exec(line)?.[1]
    if (!pkg) continue
    // the lines above are this package's, kept only for a package of the module
    const ended = pending
    pending = []
    if (pkg !== module && !pkg.startsWith(`${module}/`)) continue
    const tests = (by[`${moduleDir}${pkg.slice(module.length)}`] ??= {})
    for (const [name, outcome] of ended) tests[name] = better(tests[name], outcome)
  }
  return by
}

// Jest's --json, and Vitest's json reporter, which writes the same shape: each file's path,
// each test's title and status
export const jsRanOf = (json: string): Record<string, Record<string, Outcome>> => {
  const report = JSON.parse(json) as { testResults?: { name?: string; assertionResults?: { title?: string; status?: string }[] }[] }
  const by: Record<string, Record<string, Outcome>> = {}
  for (const file of report.testResults ?? []) {
    if (typeof file.name !== 'string') continue
    const tests = (by[file.name] ??= {})
    for (const t of file.assertionResults ?? []) {
      if (typeof t.title !== 'string') continue
      const outcome: Outcome = t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped'
      tests[t.title] = better(tests[t.title], outcome)
    }
  }
  return by
}

// a later run of some folders over the record before: what it reached is replaced, the rest kept
export const mergeRan = (before: RanRecord | null, next: RanRecord): RanRecord => {
  if (!before) return next
  const isUnder = (key: string): boolean => next.measured.some(d => key === d || key.startsWith(`${d}/`))
  const kept = Object.fromEntries(Object.entries(before.by).filter(([key]) => !isUnder(key)))
  const tagsBy = Object.fromEntries([...Object.entries(before.tagsBy ?? {}).filter(([d]) => !isUnder(d)), ...Object.entries(next.tagsBy ?? {})])
  return { at: next.at, measured: [...before.measured.filter(d => !isUnder(d)), ...next.measured], by: { ...kept, ...next.by }, ...(Object.keys(tagsBy).length > 0 ? { tagsBy } : {}) }
}

// a graded test's state in the record: undefined where the run did not reach its file; tags: a Go
// file's build tags
export const ranStateOf = (record: RanRecord | null, file: string, name: string, tags: string[] = []): RanState | undefined => {
  if (!record) return undefined
  const isGo = file.endsWith('.go')
  const key = isGo ? file.slice(0, file.lastIndexOf('/')) : file
  const reach = record.measured.find(d => key === d || key.startsWith(`${d}/`))
  if (reach === undefined) return undefined
  // Go: the test, its subtests, or a suite's method under its suite; JS: the title, or a
  // template's cases
  const outcomes = Object.entries(record.by[key] ?? {})
    .filter(([test]) => (isGo ? test === name || test.startsWith(`${name}/`) || test.endsWith(`/${name}`) : test === name || fits(name, test)))
    .map(([, outcome]) => outcome)
  if (outcomes.some(o => o !== 'skipped')) return 'ran'
  if (outcomes.length > 0) return 'skipped'
  const given = record.tagsBy?.[reach] ?? []
  return isGo && tags.some(t => !given.includes(t)) ? 'not built' : 'never ran'
}
