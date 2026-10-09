import { expect, mock, test } from 'claude-code/testing'
import { ADDING, askGrades, mount, ok, project, seedState } from './helpers'
import type { Engine } from './helpers'

const source = "it('adds', () => { expect(add(1, 2)).toBe(3) })\n"
const start = ($: Engine) => $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool: `mcp__test-grader__${tool}`, ...input } as never)).result)

// Bug: the read-only grading tools could defer to an unrelated host permission decision.
for (const tool of ['test_evidence', 'test_grades', 'test_grade', 'test_context']) {
  test(`${tool} is allowed even when the host otherwise asks for tool permission`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    project(on, {})
    on('tool.check', async () => ({ decision: 'ask' }) as never)
    expect((await $.tool.check({ tool: `mcp__test-grader__${tool}` } as never)).decision).toBe('allow')
  })
}

// Bug: corrupt host state could let a tool throw without telling Claude how to retry it.
for (const [tool, input, state, answer] of [
  ['test_evidence', { file: 'a.test.ts', test: 'adds', evidence: 'Subtracting instead of adding returns -1.' }, 'existing', /^The evidence tool could not answer \(.+\)\. Nothing was regraded; send it again\.$/],
  ['test_grades', {}, 'existing', /^The grades tool could not answer \(.+\); ask again\.$/],
  ['test_grade', {}, 'existing', /^The grade tool could not answer \(.+\); ask again\.$/],
  ['test_context', { file: 'a.test.ts', test: 'adds' }, 'existing', /^The context tool could not answer \(.+\); ask again\.$/],
  ['test_coverage', {}, 'run', /^The coverage tool could not answer \(.+\); ask again\.$/],
] as const) {
  test(`${tool} explains a corrupt host state instead of failing without an answer`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    project(on, { 'a.test.ts': source })
    let broken = false
    on('state.get', async (_$, e, next) => broken && (e as { key: string }).key === state ? { value: { value: null, version: 1 } } as never : next(e))
    await start($)
    await clock.advance(10)
    broken = true
    expect(await call($, tool, input)).toMatch(answer)
    broken = false
    expect(await askGrades($, { verdicts: ['ungraded'] })).toContain('"adds": ungraded')
  })
}

// Bug: a rejected config change could nevertheless change the model used for future grades.
test('a denied grader-model setting leaves grading on the previous model', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { models } = project(on, { 'a.test.ts': source })
  on('config.set', async () => ({ deny: 'settings are locked' }) as never)
  await start($)
  await $.config.set({ key: 'test-grader.graderModel', value: 'sonnet' } as never).catch(() => undefined)
  await (await mount($)).press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(await askGrades($, { verdicts: ['strong'] })).toContain('"adds": strong')
  expect(models).toEqual(['haiku'])
})

// Bug: a malformed summary could hide a valid fallback report and leave the pane empty.
test('a malformed coverage summary falls through to the valid lcov report', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, {
    'a.test.ts': source,
    'coverage/coverage-summary.json': '{broken',
    'coverage/lcov.info': 'SF:/proj/a.ts\nLF:4\nLH:2\nBRF:2\nBRH:0\nFNF:1\nFNH:1\nend_of_record\n',
  })
  await start($)
  await clock.advance(10)
  const text = (await (await mount($)).findAll({ type: 'Text' })).map(n => n.text)
  expect(text).toContain('50%')
  expect(text).toContain('0%')
  expect(text).toContain('100%')
  expect(text.some(t => t.startsWith('lcov.info'))).toBe(true)
})

// Bug: a per-file summary lacking lines could throw or invent a folder figure.
test('coverage summaries skip missing line totals while keeping the total figures', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, {
    'package.json': '{"devDependencies":{"jest":"29"}}', 'a.test.ts': source,
    'coverage/coverage-summary.json': JSON.stringify({ total: { branches: { pct: 25 } }, '/proj/a.ts': { functions: { pct: 100 } }, '/proj/b.ts': { lines: {} } }),
  }, { editor: () => 0 })
  await start($)
  await clock.advance(10)
  expect(await call($, 'test_coverage', { path: '.' })).toBe('Coverage (test-grader), by npx jest --coverage:\nThe project has no figure in the report: none of its code was measured.')
  expect((await (await mount($)).findAll({ type: 'Text' })).map(n => n.text)).toContain('25%')
})

// Bug: a missing go.mod could prevent reading a usable profile's statement totals.
test('a Go profile without a readable go.mod still shows its statement coverage', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'a.test.ts': source, '.test-grader-go-cover.out': 'mode: set\nother.org/pkg/a.go:1.1,2.1 4 1\nother.org/pkg/b.go:1.1,2.1 4 0\n' })
  await start($)
  await clock.advance(10)
  const text = (await (await mount($)).findAll({ type: 'Text' })).map(n => n.text)
  expect(text).toContain('Statements')
  expect(text).toContain('50%')
  expect(text.some(t => t.startsWith('go test -coverprofile'))).toBe(true)
})

// Bug: a missing or corrupt saved part could stop startup and hide the project's current tests.
for (const [label, outside] of [
  ['missing part', {}],
  ['malformed JSON', { '/saved/0.part': '{bad' }],
] as const) {
  test(`saved grades with a ${label} leave current tests available for fresh grading`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const { store } = project(on, { 'a.test.ts': source }, { outside })
    store['grades:/proj'] = { v: 2, onDisk: '/saved', parts: 1 }
    await start($)
    await clock.advance(10)
    expect(await askGrades($, { verdicts: ['ungraded'] })).toContain('"adds": ungraded')
    expect(await call($, 'test_grade')).toContain('1 strong')
    expect(await askGrades($, { verdicts: ['strong'] })).toContain('"adds": strong')
  })
}

// Bug: a newly written test whose file disappears before grading could stay reviewing forever.
test('a written test that cannot be read for grading becomes unrated with the failure reason', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, {})
  on('tool.call', async () => ok as never)
  await start($)
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.test.ts', content: source } as never)
  await clock.advance(10)
  const answer = await askGrades($, { written: true, verdicts: ['unrated'] })
  expect(answer).toContain('"adds": unrated')
  expect(answer).toContain('Why: Grading failed:')
  expect(answer).not.toContain('still being graded')
})

// Bug: a scoped grade outside git could continue as if an empty file list were authoritative.
test('grading a folder outside a git repository explains why no tests were graded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'a.test.ts': source }, { isGit: false })
  await start($)
  await clock.advance(10)
  expect(await call($, 'test_grade', { path: 'src' })).toBe('Not a git repository: there is no list of test files to grade.')
})

// Bug: a mutation could run too many sibling tests or claim that unrun siblings catch it.
test('mutation verification caps sibling runs at twenty and names the cases it left out', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...ADDING, 'src/a.test.ts': ADDING['src/a.test.ts'] + Array.from({ length: 22 }, (_, i) => `it('sibling ${i}', () => { expect(add(${i}, 0)).toBe(${i}) })\n`).join('') }
  project(on, files, { editor: argv => ({ exitCode: files['src/add.ts']!.includes('a - b') && ['a shallow check', 'sibling 0', 'sibling 21'].some(name => argv[4]!.includes(name)) ? 1 : 0, stdout: 'test finished' }) })
  await start($)
  await clock.advance(10)
  const answer = await call($, 'test_verify', { file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a + b', replace: 'a - b', siblings: true })
  expect(answer).toContain('Other tests in the file also failed with it: "sibling 0" (of 20 run).')
  expect(answer).toContain('2 more were not run: the limit is 20.')
  expect(answer).not.toContain('"sibling 21"')
  expect(files['src/add.ts']).toBe(ADDING['src/add.ts'])
})

// Bug: missing restored code could be accepted as a completed measurement and change the grade.
test('mutation verification reports a restored file that can no longer be read', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let restored = false
  const backing = { ...ADDING }
  const files = new Proxy(backing, {
    get(target, key: string) {
      if (restored && key === 'src/add.ts') throw new Error('disk unavailable')
      return target[key]
    },
    set(target, key: string, value: string) {
      if (key === 'src/add.ts' && value === ADDING['src/add.ts']) restored = true
      target[key] = value
      return true
    },
  })
  project(on, files, { editor: () => ({ exitCode: backing['src/add.ts']!.includes('a - b') ? 1 : 0 }) })
  await start($)
  await clock.advance(10)
  expect(await call($, 'test_verify', { file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a + b', replace: 'a - b' })).toBe('test-grader could not put src/add.ts back as it was: check it now.')
})

// Bug: a reload could leave rows reviewing indefinitely when their file was removed.
test('a reload drops a reviewing row whose file disappeared', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, {})
  seedState(on, { existing: { state: 'idle', done: 1, total: 1, results: [{ file: '/proj/gone.test.ts', name: 'adds', isPending: true }] } })
  await start($)
  await clock.advance(10)
  expect(await askGrades($)).toBe('test-grader lists no tests.')
})

// Bug: an exception in test tracking could swallow or replay a successful editing tool.
for (const tool of ['Write', 'Edit']) {
  test(`a successful ${tool} keeps its answer when test tracking encounters corrupt state`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files = { 'a.test.ts': source }
    project(on, files)
    let broken = false
    on('state.get', async (_$, e, next) => broken && (e as { key: string }).key === 'tests' ? { value: { value: null, version: 1 } } as never : next(e))
    on('tool.call', async () => {
      files['a.test.ts'] = source.replace('add(1, 2)', 'add(2, 1)')
      return { ...ok, text: 'File saved.' } as never
    })
    await start($)
    await clock.advance(10)
    broken = true
    const result = await $.tool.call({ tool, file_path: '/proj/a.test.ts', content: files['a.test.ts'], old_string: 'add(1, 2)', new_string: 'add(2, 1)' } as never)
    expect(result.text).toBe('File saved.')
    expect(files['a.test.ts']).toBe(source.replace('add(1, 2)', 'add(2, 1)'))
    broken = false
    expect(await askGrades($, { verdicts: ['ungraded'] })).toContain('"adds": ungraded')
  })
}

// Bug: an unexpected grading exception could leave a batch reviewing forever with no explanation.
test('an exception during manual grading leaves each test unrated with the error', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'a.test.ts': source })
  let broken = false
  on('state.get', async (_$, e, next) => broken && (e as { key: string }).key === 'survived' ? { value: { value: { '/proj/a.test.ts::adds': 42 }, version: 1 } } as never : next(e))
  await start($)
  await clock.advance(10)
  broken = true
  await call($, 'test_grade')
  broken = false
  expect(await askGrades($, { verdicts: ['unrated'] })).toContain('"adds": unrated\n  Why: Grading failed:')
  expect(await askGrades($)).not.toContain('still being graded')
})

// Bug: an exception during a regrade after an edit could retain the old grade as current.
test('an exception while regrading an edited existing test clears its old grade and explains the failure', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { 'a.test.ts': source }
  project(on, files)
  on('tool.call', async () => ok as never)
  let broken = false
  on('state.get', async (_$, e, next) => broken && (e as { key: string }).key === 'survived' ? { value: { value: { '/proj/a.test.ts::adds': 42 }, version: 1 } } as never : next(e))
  await start($)
  await call($, 'test_grade')
  broken = true
  files['a.test.ts'] = source.replace('add(1, 2)', 'add(2, 1)')
  await $.tool.call({ tool: 'Edit', file_path: '/proj/a.test.ts', old_string: 'add(1, 2)', new_string: 'add(2, 1)' } as never)
  await clock.advance(10)
  broken = false
  expect(await askGrades($, { verdicts: ['unrated'] })).toContain('"adds": unrated\n  Why: Grading failed:')
  expect(await askGrades($)).not.toContain('still being graded')
})

// Bug: a rejected state write could poison the queued writes and discard the grades kept before it.
test('grading recovers from a rejected state write and keeps the previous grades', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'a.test.ts': source })
  let reject = false
  on('state.set', async (_$, e, next) => {
    if (reject && (e as { key: string }).key === 'existing') {
      reject = false
      return { deny: 'state quota exceeded' } as never
    }
    return next(e)
  })
  await start($)
  await clock.advance(10)
  await call($, 'test_grade')
  reject = true
  expect(await call($, 'test_grade', { again: true })).toContain('state quota exceeded')
  expect(await askGrades($, { verdicts: ['strong'] })).toContain('"adds": strong')
  expect(await call($, 'test_grade', { again: true })).toContain('1 strong')
})

// Bug: files holding only setup code could stay unfinished because no grading jobs were queued.
test('a Go test file containing only TestMain finishes without inventing test cases', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'setup_test.go': 'package x\nfunc TestMain(m *testing.M) { m.Run() }\n' })
  await start($)
  await clock.advance(10)
  expect(await call($, 'test_grade')).toContain('0 graded')
  expect(await askGrades($)).toBe('test-grader lists no tests.')
  expect((await (await mount($)).findAll({ type: 'Button' })).map(b => b.props?.label)).toContain('Grade all tests')
})
