import { expect, mock, test } from 'claude-code/testing'
import { mount, project, ok, E_TEST, E_FILE, sendEvidence, MUTATION, swayed, askGrades, GRADED, turns, ADDING, jest } from './helpers'

test('evidence the grader accepts turns a shallow test strong, and the row says it was graded on evidence', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, tools } = project(on, { 'src/e.test.ts': E_TEST }, { rule: swayed })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  expect(tools).toEqual(['test_evidence', 'test_grades', 'test_verify'])
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 1 strong · 1 shallow')

  const answer = await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)

  expect(answer).toMatch(/^Now strong: /)
  // the grader saw the evidence, and was told to check it against the source
  expect(prompts.at(-1)).toContain(MUTATION)
  expect(prompts.at(-1)).toContain('check each claim against the source')
  expect(prompts.at(-1)).toContain('Review ONLY these test cases: ["a shallow check"]')
  await ui.press({ key: `r:${E_FILE}:a shallow check` })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('2 tests · 2 strong')
  expect(tree).toContain('"on evidence"')
  expect(tree).toContain(`Evidence: ${MUTATION}`)
})


test('evidence the grader rejects leaves the verdict, and the tool says why', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/e.test.ts': E_TEST })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const answer = await sendEvidence($, { file: '/proj/src/e.test.ts', test: 'a shallow check', evidence: 'It is fine.' })
  await clock.advance(10)

  expect(answer).toBe('Still shallow: shallow because. Strengthen it, or send other evidence (round 1 of 3).')
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 1 strong · 1 shallow')
})


test('evidence for a test that is not in the file is refused, with no grader call', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, { 'src/e.test.ts': E_TEST })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  const answer = await sendEvidence($, { file: 'src/e.test.ts', test: 'no such test', evidence: MUTATION })
  await clock.advance(10)

  expect(answer).toBe('There is no test named "no such test" in src/e.test.ts. Nothing was regraded.')
  expect(prompts).toHaveLength(0)
})


test('a verdict on evidence holds while the file is unchanged, and goes once it changes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/e.test.ts': E_TEST }
  project(on, files, { rule: swayed })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)

  // remembered: Grade all again keeps it
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('"on evidence"')

  files['src/e.test.ts'] = E_TEST + "\nit('second', () => { expect(f(2)).toBe(2) })\n"
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toContain('"on evidence"')
  expect(tree).toContain('3 tests · 2 strong · 1 shallow')
})


test('test_grades lists the flagged tests, worst first, each at its line with what it checks and why', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, GRADED)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(await askGrades($)).toBe(
    '4 tests: 1 strong, 1 hollow, 2 shallow.\n' +
      'Flagged, worst first:\n' +
      '- src/math.test.ts:2 "does nothing": hollow\n  Checks: Checks does nothing.\n  Why: hollow because.\n' +
      '- src/deep/more.test.ts:3 "a shallow check": shallow\n  Checks: Checks a shallow check.\n  Why: shallow because.\n' +
      '- src/deep/more.test.ts:4 "another shallow one": shallow\n  Checks: Checks another shallow one.\n  Why: shallow because.\n' +
      'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.',
  )
})


test('test_grades narrows to a folder, to the verdicts asked, and to a limit, saying how many it left out', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, GRADED)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const deep = await askGrades($, { path: 'src/deep/', limit: 1 })
  expect(deep).toBe(
    '2 tests in src/deep: 0 strong, 2 shallow.\n' +
      'Flagged, worst first:\n' +
      '- src/deep/more.test.ts:3 "a shallow check": shallow\n  Checks: Checks a shallow check.\n  Why: shallow because.\n' +
      '1 more not listed; raise limit or narrow path to see them.\n' +
      'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.',
  )
  // a file's name is not a folder: src/math.test is no prefix of src/math.test.ts
  expect(await askGrades($, { path: 'src/math.test' })).toBe('test-grader lists no tests in src/math.test.')
  const strong = await askGrades($, { verdicts: ['strong'], path: '/proj/src/math.test.ts' })
  expect(strong).toBe('2 tests in src/math.test.ts: 1 strong, 1 hollow.\nStrong, worst first:\n- src/math.test.ts:1 "adds": strong\n  Checks: Checks adds.\n  Why: strong because.')
})


test('test_grades before any grading says none is flagged, and how to grade the tests', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, GRADED)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(await askGrades($)).toBe(
    '4 tests: 0 strong, 4 never graded.\nNone is flagged. Grade all tests in the Tests pane grades the ones never graded.',
  )
  expect(prompts).toHaveLength(0)
})


test('test_grades tells which round a test Claude is strengthening is in, round after round, and when its rounds are spent', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GRADED }
  project(on, files)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/deep/more.test.ts', content: files['src/deep/more.test.ts'] } as never)
  await clock.advance(10)
  const roundOf = async (): Promise<string> => {
    const line = (await askGrades($, { path: 'src/deep' })).split('\n').find(l => l.includes('"another shallow one"'))!
    return line.slice(line.indexOf(': shallow') + ': shallow'.length)
  }
  expect(await roundOf()).toBe(' (round 1 of 3)')
  // each edit inside its body, its name untouched, is graded again: shallow again, the next round
  const rounds: string[] = []
  for (const value of ['1', '2', '3']) {
    const before = files['src/deep/more.test.ts']!
    files['src/deep/more.test.ts'] = before.replace(/toBeTruthy\(\d*\)/, `toBeTruthy(${value})`)
    const [old] = before.match(/toBeTruthy\(\d*\)/)!
    await $.tool.call({ tool: 'Edit', file_path: '/proj/src/deep/more.test.ts', old_string: old, new_string: `toBeTruthy(${value})` } as never)
    await clock.advance(10)
    rounds.push(await roundOf())
  }
  expect(rounds).toEqual([' (round 2 of 3)', ' (round 3 of 3)', ' (3 rounds spent: test-grader has stopped on it)'])
  // the other test in the file, not edited, stays in its first round
  expect(await askGrades($, { path: 'src/deep' })).toContain('"a shallow check": shallow (round 1 of 3)')
})


test('test_grades with written lists only the tests written or edited this session, and says which are still being graded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GRADED }
  project(on, files)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const fresh = "it('a new shallow test', () => { expect(g).toBeDefined() })\nit('another new one', () => { expect(g(1)).toBe(2) })\n"
  files['src/new.test.ts'] = fresh
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/new.test.ts', content: fresh } as never)

  // asked before the grader answers: nothing to list yet, and the two are being graded
  expect(await askGrades($, { written: true })).toBe(
    '2 tests written or edited this session: 0 strong, 2 being graded.\nNone is flagged.\n2 still being graded: ask again in a moment for their grades.',
  )
  await clock.advance(10)
  expect(await askGrades($, { written: true })).toBe(
    '2 tests written or edited this session: 1 strong, 1 shallow.\n' +
      'Flagged, worst first:\n' +
      '- src/new.test.ts:1 "a new shallow test": shallow (round 1 of 3)\n  Checks: Checks a new shallow test.\n  Why: shallow because.\n' +
      'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.',
  )
})


test('a file pressed open stays open when one of its tests is regraded on evidence', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/e.test.ts': E_TEST, 'src/z.test.ts': "it('zeroes', () => { expect(z()).toBe(0) })\n" }, { rule: swayed })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: `f:${E_FILE}` })
  expect(JSON.stringify(await ui.drawn())).toContain(`"▾ src/e.test.ts"`)

  await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)

  expect(JSON.stringify(await ui.drawn())).toContain(`"▾ src/e.test.ts"`)
})


test('/test-grader report writes the grades as Markdown, worst first with each test at its line, and as JSON', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GRADED }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const ran = await $.command.run({ command: 'test-grader', args: 'report' } as never)
  expect((ran as { text: string }).text).toBe('Wrote test-grader-report.md and test-grader-report.json: 4 tests, 1 strong, 1 hollow, 2 shallow.')
  const md = files['test-grader-report.md']!
  expect(md.split('\n').slice(0, 3)).toEqual(['# Test grades', '', `4 tests: 1 hollow, 2 shallow, 1 strong. Graded by test-grader, ${new Date(1_000_010).toISOString()}.`])
  expect(md).toContain('## Hollow (1)\n\n- `src/math.test.ts:2` does nothing: hollow because.\n\n## Shallow (2)\n\n- `src/deep/more.test.ts:3` a shallow check: shallow because.\n- `src/deep/more.test.ts:4` another shallow one: shallow because.')
  const json = JSON.parse(files['test-grader-report.json']!) as { counts: Record<string, number>; tests: { file: string; line: number; name: string; state: string }[] }
  expect(json.counts).toEqual({ hollow: 1, duplicate: 0, shallow: 2, brittle: 0, unrated: 0, reviewing: 0, ungraded: 0, strong: 1 })
  expect(json.tests[0]).toEqual({ file: 'src/math.test.ts', line: 2, name: 'does nothing', state: 'hollow', summary: 'Checks does nothing.', reason: 'hollow because.', onEvidence: false })
})


test('Run test runs the one test with the project runner, and its row says how it ended', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...ADDING, 'src/add.ts': 'export const add = (a: number, b: number) => a - b\n' }
  const { runs } = project(on, files, { editor: jest(files) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: '/proj/src/a.test.ts:a shallow check'.replace(/^/, 'r:') })
  await ui.press({ key: 'x:/proj/src/a.test.ts:a shallow check' })
  await clock.advance(10)
  expect(runs.filter(r => r[1] === 'jest')).toEqual([['npx', 'jest', 'src/a.test.ts', '-t', '^a shallow check$']])
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain("Failed: npx jest src/a.test.ts -t '^a shallow check$'\\nFAIL src/a.test.ts\\n  ● a shallow check\\n    expected 3")
})


test('test_verify measures a mutation the test catches, puts the file back, and the grade takes what it measured', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...ADDING }
  const { writes, prompts } = project(on, files, { editor: jest(files), rule: (_n, prompt) => (prompt.includes('Measured by test-grader') ? 'strong' : 'shallow') })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const verify = (input: Record<string, string>) => $.tool.call({ tool: 'mcp__test-grader__test_verify', ...input } as never).then(r => String((r as { result: unknown }).result))

  const answer = await verify({ file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a + b', replace: 'a - b' })
  expect(answer).toMatch(/^Measured: the test passes unchanged and fails with the mutation\. Now strong: /)
  expect(files['src/add.ts']).toBe(ADDING['src/add.ts'])
  expect(prompts.at(-1)).toContain('With \\"a + b\\" replaced by \\"a - b\\" in src/add.ts, the same command failed.')
  expect(prompts.at(-1)).toContain('expected 3')

  // a mutation it does not catch: nothing is regraded
  const missed = await verify({ file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: '(a: number', replace: '(a: any' })
  expect(missed).toBe('The test still passes with "(a: number" replaced by "(a: any" in src/add.ts: it does not catch that change. The file is back as it was; nothing was regraded.')
  expect(files['src/add.ts']).toBe(ADDING['src/add.ts'])
  // nor is a test file mutated, nor text that is not found exactly once: neither writes a file
  const written = writes.length
  expect(await verify({ file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/a.test.ts', find: 'add', replace: 'sub' })).toBe('src/a.test.ts is a test file: mutate the code under test. Nothing was run.')
  expect(await verify({ file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'number', replace: 'any' })).toBe('The text to find is in src/add.ts 2 times, not once: give a piece found exactly once. Nothing was run.')
  expect(writes).toHaveLength(written)
  expect(files['src/a.test.ts']).toBe(ADDING['src/a.test.ts'])
})

