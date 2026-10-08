import { expect, mock, test } from 'claude-code/testing'
import { mount, project, ok, E_TEST, E_FILE, sendEvidence, MUTATION, swayed, askGrades, GRADED, turns, ADDING, jest, ASKED, buttonsOf, BRANCH, branchGit, SUMMARY } from './helpers'
import type { Engine, Shell } from './helpers'

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

  expect(answer).toBe('Still shallow: shallow because. It would miss: a wrong edge. Strengthen it, or send other evidence (round 1 of 3).')
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


test('a verdict on evidence holds while the test\'s own text is unchanged, other tests in the file changing or not, and goes once it changes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/e.test.ts': E_TEST }
  const { prompts } = project(on, files, { rule: swayed })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  const asked = (name: string): number => ASKED(prompts).filter(n => n === name).length
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)
  const before = asked('a shallow check')

  // another test added: the file is graded again, but not the test held on evidence
  files['src/e.test.ts'] = E_TEST + "\nit('second', () => { expect(f(2)).toBe(2) })\n"
  await ui.press({ key: 'regradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('"on evidence"')
  expect(JSON.stringify(await ui.drawn())).toContain('3 tests · 3 strong')
  expect(asked('a shallow check')).toBe(before)

  // its own text changed: graded again, without the evidence
  files['src/e.test.ts'] = files['src/e.test.ts']!.replace('expect(f).toBeDefined()', 'expect(f).toBeTruthy()')
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
      '- src/deep/more.test.ts:3 "a shallow check": shallow\n  Checks: Checks a shallow check.\n  Why: shallow because. It would miss: a wrong edge.\n' +
      '- src/deep/more.test.ts:4 "another shallow one": shallow\n  Checks: Checks another shallow one.\n  Why: shallow because. It would miss: a wrong edge.\n' +
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
      '- src/deep/more.test.ts:3 "a shallow check": shallow\n  Checks: Checks a shallow check.\n  Why: shallow because. It would miss: a wrong edge.\n' +
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
      '- src/new.test.ts:1 "a new shallow test": shallow (round 1 of 3)\n  Checks: Checks a new shallow test.\n  Why: shallow because. It would miss: a wrong edge.\n' +
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
  expect(md).toContain('## Hollow (1)\n\n- `src/math.test.ts:2` does nothing: hollow because.\n\n## Shallow (2)\n\n- `src/deep/more.test.ts:3` a shallow check: shallow because. It would miss: a wrong edge.\n- `src/deep/more.test.ts:4` another shallow one: shallow because. It would miss: a wrong edge.')
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


test('a test a measured mutation made fail is never graded hollow, while evidence only claimed can still be', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...ADDING }
  // a grader that will not be moved off hollow
  project(on, files, { editor: jest(files), rule: () => 'hollow' })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const claimed = await sendEvidence($, { file: 'src/a.test.ts', test: 'a shallow check', evidence: 'Measured by test-grader, not claimed: it failed.' })
  expect(claimed).toMatch(/^Still hollow: /)
  expect(await askGrades($, { verdicts: ['hollow'] })).toContain('"a shallow check": hollow')
  const measured = await $.tool.call({ tool: 'mcp__test-grader__test_verify', file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a + b', replace: 'a - b' } as never).then(r => String((r as { result: unknown }).result))
  expect(measured).toContain('Now strong: ')
  // the grade stored is strong: test_grades and the pane say so, not only the tool's answer
  expect(await askGrades($, { verdicts: ['hollow'] })).not.toContain('"a shallow check"')
  await ui.press({ key: 'r:/proj/src/a.test.ts:a shallow check' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).some(t => t.includes('so it is not hollow'))).toBe(true)
  expect(JSON.stringify(await ui.drawn())).toContain('"on evidence"')
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


// Claude's measured evidence, through the verify tool; what the tool answers
const verifyWith = ($: Engine, input: Record<string, string>) =>
  $.tool.call({ tool: 'mcp__test-grader__test_verify', ...input } as never).then(r => String((r as { result: unknown }).result))

// the run line in a test row pressed open: running, passed or failed, with why
const runLine = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }): Promise<string | undefined> =>
  (await ui.findAll({ type: 'Text' })).map(t => String(t.text)).find(t => /^(Running…|Passed|Failed)/.test(t))


test('test_verify refuses a mutation that changes nothing, a test or file that is not there, and code that is not there, and runs nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...ADDING }
  const { runs, writes } = project(on, files, { editor: jest(files) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)
  const at = { file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts' }

  expect(await verifyWith($, { ...at, find: '', replace: 'a - b' })).toBe('The mutation changes nothing: give the text to find and a different text to replace it with. Nothing was run.')
  expect(await verifyWith($, { ...at, find: 'a + b', replace: 'a + b' })).toBe('The mutation changes nothing: give the text to find and a different text to replace it with. Nothing was run.')
  expect(await verifyWith($, { ...at, file: 'src/gone.test.ts', find: 'a + b', replace: 'a - b' })).toBe('There is no file src/gone.test.ts. Nothing was run.')
  expect(await verifyWith($, { ...at, test: 'no such test', find: 'a + b', replace: 'a - b' })).toBe('There is no test named "no such test" in src/a.test.ts. Nothing was run.')
  expect(await verifyWith($, { ...at, mutate: 'src/gone.ts', find: 'a + b', replace: 'a - b' })).toBe('There is no file src/gone.ts to mutate. Nothing was run.')
  expect(runs).toEqual([])
  expect(writes).toEqual([])
})


test('test_verify in a project with no runner it knows says so, and runs nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the jest project, without the package.json that names jest
  const { 'package.json': _, ...files } = ADDING
  const { runs, writes } = project(on, files, { editor: jest(files) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await verifyWith($, { file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a + b', replace: 'a - b' })

  expect(answer).toBe('test-grader knows no way to run one test of src/a.test.ts in this project. Nothing was run.')
  expect(runs).toEqual([])
  expect(writes).toEqual([])
})


test('test_verify on a test that fails unchanged says so, with what it printed, and mutates nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // add subtracts already: the test fails before any mutation
  const files = { ...ADDING, 'src/add.ts': 'export const add = (a: number, b: number) => a - b\n' }
  const { runs, writes, prompts } = project(on, files, { editor: jest(files) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await verifyWith($, { file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a - b', replace: 'a * b' })

  expect(answer).toBe("The test fails unchanged, so a mutation shows nothing. npx jest src/a.test.ts -t '^a shallow check$' printed:\nFAIL src/a.test.ts\n  ● a shallow check\n    expected 3")
  expect(runs).toHaveLength(1)
  expect(writes).toEqual([])
  expect(prompts).toHaveLength(0)
})


test('test_verify whose run with the mutation fails to start puts the file back and regrades nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...ADDING }
  // the runner starts on the code as it was, and not on the mutated code
  const { prompts } = project(on, files, {
    editor: argv => {
      // a runner that throws is passed over, and nothing else runs the command: the run rejects
      if (files['src/add.ts']!.includes('a - b')) throw new Error('spawn npx ENOENT')
      return { stdout: `PASS ${argv[2]}` }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await verifyWith($, { file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a + b', replace: 'a - b' })

  expect(answer).toBe('The run with the mutation failed to start: no implementation for process.run. The file is back as it was; nothing was regraded.')
  expect(files['src/add.ts']).toBe(ADDING['src/add.ts'])
  expect(prompts).toHaveLength(0)
})


test('test_verify that finds the mutated file not back as it was says so, and regrades nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...ADDING }
  // while the mutated code runs, something else rewrites add.ts: reads from then on find that
  const outside: Record<string, string> = {}
  const editor: Shell = argv => {
    if (files['src/add.ts']!.includes('a - b')) outside['/proj/src/add.ts'] = 'export const add = (a: number, b: number) => b + a\n'
    return jest(files)(argv)
  }
  const { prompts } = project(on, files, { editor, outside })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await verifyWith($, { file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a + b', replace: 'a - b' })

  expect(answer).toBe('test-grader could not put src/add.ts back as it was: check it now.')
  expect(prompts).toHaveLength(0)
})


test('evidence with no text, or for a file that is not there, is refused, with no grader call', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, { 'src/e.test.ts': E_TEST })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: '  \n ' })).toBe('No evidence was given. Nothing was regraded.')
  expect(await sendEvidence($, { file: 'src/gone.test.ts', test: 'a shallow check', evidence: MUTATION })).toBe('There is no file src/gone.test.ts. Nothing was regraded.')
  expect(prompts).toHaveLength(0)
})


test('evidence the grader gives no verdict on leaves the test as it was, and the tool says to send it again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the grader answers with no verdict at all
  project(on, { 'src/e.test.ts': E_TEST }, { reply: () => ({ isAnswered: true, usage: {}, text: '[]' }) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)

  expect(answer).toBe('The grader gave no verdict. Nothing was regraded; send it again.')
  expect(await askGrades($, { verdicts: ['ungraded'] })).toBe(
    '2 tests: 0 strong, 2 never graded.\nUngraded, worst first:\n- src/e.test.ts:3 "first": ungraded\n- src/e.test.ts:5 "a shallow check": ungraded',
  )
})


test('evidence for a test not yet listed adds it to the grades, as graded on evidence', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/e.test.ts': E_TEST }, { rule: swayed })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  // sent before the session's first listing of the project's tests
  const answer = await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)

  // strong: no round to tell
  expect(answer).toBe('Now strong: strong because.')
  expect(await askGrades($, { verdicts: ['strong'] })).toBe(
    '2 tests: 1 strong, 1 never graded.\nStrong, worst first:\n- src/e.test.ts:5 "a shallow check": strong\n  Checks: Checks a shallow check.\n  Why: strong because.\n  Graded on evidence.',
  )
})


// a test listed but never graded loses that mark with its grade: test_grades, the pane and the
// kept grades all read it as the tool answered
test('evidence for a test listed but never graded gives it the grade the tool answers', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/e.test.ts': E_TEST }, { rule: swayed })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)

  expect(answer).toBe('Now strong: strong because.')
  expect(await askGrades($, { verdicts: ['strong'] })).toBe(
    '2 tests: 1 strong, 1 never graded.\nStrong, worst first:\n- src/e.test.ts:5 "a shallow check": strong\n  Checks: Checks a shallow check.\n  Why: strong because.\n  Graded on evidence.',
  )
})


test('evidence rejected round after round counts each round, and after the third says test-grader has stopped asking', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/e.test.ts': E_TEST })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const answers: string[] = []
  for (const said of ['It is fine.', 'It is still fine.', 'It is really fine.', 'Trust me.']) {
    answers.push(await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: said }))
    await clock.advance(10)
  }

  expect(answers).toEqual([
    'Still shallow: shallow because. It would miss: a wrong edge. Strengthen it, or send other evidence (round 1 of 3).',
    'Still shallow: shallow because. It would miss: a wrong edge. Strengthen it, or send other evidence (round 2 of 3).',
    'Still shallow: shallow because. It would miss: a wrong edge. Strengthen it, or send other evidence (round 3 of 3).',
    'Still shallow: shallow because. It would miss: a wrong edge. test-grader has stopped asking about this test: tell the person what is left.',
  ])
})


test('test_grades lists a test whose file cannot be read without a line, and one never graded without what it checks or why', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GRADED }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)
  expect(await askGrades($, { verdicts: ['ungraded'], path: 'src/math.test.ts' })).toBe(
    '2 tests in src/math.test.ts: 0 strong, 2 never graded.\nUngraded, worst first:\n- src/math.test.ts:1 "adds": ungraded\n- src/math.test.ts:2 "does nothing": ungraded',
  )
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // gone from the disk, before the pane notices: its grades stand, its lines are not known
  delete files['src/deep/more.test.ts']

  expect(await askGrades($, { path: 'src/deep', limit: 1 })).toBe(
    '2 tests in src/deep: 0 strong, 2 shallow.\n' +
      'Flagged, worst first:\n' +
      '- src/deep/more.test.ts "a shallow check": shallow\n  Checks: Checks a shallow check.\n  Why: shallow because. It would miss: a wrong edge.\n' +
      '1 more not listed; raise limit or narrow path to see them.\n' +
      'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.',
  )
})


test('Run test on a test whose file is gone, or whose name is gone from its file, fails in its row with why, and runs nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...ADDING }
  const { runs } = project(on, files, { editor: jest(files) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'r:/proj/src/a.test.ts:a shallow check' })

  // gone from the disk, before the pane notices
  delete files['src/a.test.ts']
  await ui.press({ key: 'x:/proj/src/a.test.ts:a shallow check' })
  await clock.advance(10)
  expect(await runLine(ui)).toBe('Failed\nThere is no file src/a.test.ts.')

  // back, with the test renamed
  files['src/a.test.ts'] = ADDING['src/a.test.ts']!.replace('a shallow check', 'adds one and two')
  await ui.press({ key: 'x:/proj/src/a.test.ts:a shallow check' })
  await clock.advance(10)
  expect(await runLine(ui)).toBe('Failed\nThere is no test named "a shallow check" in src/a.test.ts.')
  expect(runs).toEqual([])
})


test('Run test whose runner cannot be started fails in its row with the error', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...ADDING }
  // a runner that throws is passed over, and nothing else runs the command: the run rejects
  project(on, files, {
    editor: () => {
      throw new Error('spawn npx ENOENT')
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'r:/proj/src/a.test.ts:a shallow check' })

  await ui.press({ key: 'x:/proj/src/a.test.ts:a shallow check' })
  await clock.advance(10)

  expect(await runLine(ui)).toBe('Failed\nno implementation for process.run')
  // the row offers to run it again
  expect(buttonsOf(await ui.drawn()).get('x:/proj/src/a.test.ts:a shallow check')).toBe('Run test')
})


test('test_verify whose first run cannot be started says it could not answer, and leaves the code as it was', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...ADDING }
  const { writes, prompts } = project(on, files, {
    editor: () => {
      throw new Error('spawn npx ENOENT')
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await verifyWith($, { file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a + b', replace: 'a - b' })

  expect(answer).toMatch(/^The verify tool could not answer \(.+\)\. If it had changed a file, check that it is back as it was\.$/)
  expect(writes).toEqual([])
  expect(prompts).toHaveLength(0)
})


// The runner each project's files name, found as the session starts, runs Run test
const FOUND: [string, Record<string, string>, string, string[], string][] = [
  [
    'composer.json requiring pestphp/pest: Pest',
    { 'composer.json': '{ "require-dev": { "pestphp/pest": "^2.0" } }', 'tests/FooTest.php': "<?php\nit('pest case', function () { expect(add(1, 2))->toBe(3); });\n" },
    'tests/FooTest.php:pest case',
    ['vendor/bin/pest', 'tests/FooTest.php', '--filter', 'pest case'],
    "Passed: vendor/bin/pest tests/FooTest.php --filter 'pest case'",
  ],
  [
    'build.gradle.kts: Gradle',
    { 'build.gradle.kts': 'plugins { java }\n', 'src/test/java/FooTest.java': 'class FooTest {\n  @Test\n  void adds() { assertEquals(3, add(1, 2)); }\n}\n' },
    'src/test/java/FooTest.java:adds',
    ['./gradlew', 'test', '--tests', '*FooTest.adds'],
    "Passed: ./gradlew test --tests '*FooTest.adds'",
  ],
  [
    'pom.xml: Maven',
    { 'pom.xml': '<project></project>\n', 'src/test/java/FooTest.java': 'class FooTest {\n  @Test\n  void adds() { assertEquals(3, add(1, 2)); }\n}\n' },
    'src/test/java/FooTest.java:adds',
    ['mvn', '-q', 'test', '-Dtest=FooTest#adds'],
    "Passed: mvn -q test '-Dtest=FooTest#adds'",
  ],
  [
    'a Gemfile: RSpec through bundle exec',
    { Gemfile: "source 'https://rubygems.org'\n", 'spec/foo_spec.rb': "RSpec.describe Foo do\n  it 'adds' do\n    expect(add(1, 2)).to eq(3)\n  end\nend\n" },
    'spec/foo_spec.rb:adds',
    ['bundle', 'exec', 'rspec', 'spec/foo_spec.rb:2'],
    'Passed: bundle exec rspec spec/foo_spec.rb:2',
  ],
  [
    'package.json with @playwright/test: Playwright',
    { 'package.json': '{ "devDependencies": { "@playwright/test": "^1.40.0" } }', 'e2e/login.spec.ts': "import { test, expect } from '@playwright/test'\n\ntest('logs in', async ({ page }) => {\n  await expect(page).toHaveTitle('Home')\n})\n" },
    'e2e/login.spec.ts:logs in',
    ['npx', 'playwright', 'test', 'e2e/login.spec.ts:3'],
    'Passed: npx playwright test e2e/login.spec.ts:3',
  ],
]

for (const [label, files, at, argv, row] of FOUND) {
  test(`Run test runs the one test with the runner the project names, ${label}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const { runs } = project(on, files, { editor: () => ({ stdout: 'ok' }) })
    await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
    const ui = await mount($)
    await ui.press({ key: 'gradeAll' })
    await clock.advance(10)
    await ui.press({ key: `r:/proj/${at}` })

    await ui.press({ key: `x:/proj/${at}` })
    await clock.advance(10)

    expect(runs).toEqual([argv])
    expect(await runLine(ui)).toBe(row)
  })
}


// /test-grader diff, against main: what git answers for the changes made since the branch left
// it, those not committed, and new files; any other git command is the project's listing
const onMain = (changed: { stdout: string; stderr?: string; exitCode?: number }, working = '', added = '') => (argv: string[]) => {
  const args = argv.slice(1).join(' ')
  if (args === 'merge-base HEAD origin/HEAD') return { stdout: '', exitCode: 1 }
  if (args === 'merge-base HEAD main') return { stdout: 'abc123\n' }
  if (args === 'diff --name-only --diff-filter=d main...') return changed
  if (args === 'diff --name-only --diff-filter=d HEAD') return { stdout: working }
  if (args === 'ls-files --others --exclude-standard') return { stdout: added }
  return undefined
}

const diff = async ($: Engine): Promise<string> =>
  ((await $.command.run({ command: 'test-grader', args: 'diff' } as never)) as { text: string }).text


test('/test-grader diff that git cannot list the changes for says what git said, and grades nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, BRANCH, { git: onMain({ stdout: '', stderr: "fatal: ambiguous argument 'main...': unknown revision\n", exitCode: 128 }, 'src/b.test.ts\n') })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  const answer = await diff($)
  await clock.advance(10)

  expect(answer).toBe("git could not list the changes against main: fatal: ambiguous argument 'main...': unknown revision")
  expect(prompts).toEqual([])
})


test('/test-grader diff with no test file changed says so, and grades nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // only code changed: on the branch, not committed, and a new file
  const { prompts } = project(on, BRANCH, { git: onMain({ stdout: 'src/lib.ts\n' }, 'README.md\n', 'src/new.ts\n') })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  const answer = await diff($)
  await clock.advance(10)

  expect(answer).toBe('No test files changed against main.')
  expect(prompts).toEqual([])
})


test('/test-grader diff with one test file changed names it as one file, and grades only it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the same file changed on the branch and since: one file
  const { prompts } = project(on, BRANCH, { git: onMain({ stdout: 'src/a.test.ts\nsrc/lib.ts\n' }, 'src/a.test.ts\n') })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  const answer = await diff($)
  await clock.advance(10)

  expect(answer).toBe('Grading the 1 test file changed against main.')
  expect(ASKED(prompts)).toEqual(['a'])
})


test('/test-grader diff while Grade all tests is under way says so, and starts nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let open = () => {}
  const { prompts, gits } = project(on, BRANCH, { git: branchGit, gate: () => new Promise<void>(r => (open = r)) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const answer = await diff($)
  open()
  await clock.advance(10)

  expect(answer).toBe('Grading is already under way.')
  // the branch was never looked at, and each test was graded once, by Grade all tests
  expect(gits.filter(g => g[1] === 'merge-base' || g[1] === 'diff')).toEqual([])
  expect(ASKED(prompts)).toEqual(['a', 'b', 'c shallow', 'd'])
})


test('/test-grader report with no tests says to grade the project first, and writes nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { writes } = project(on, { 'src/math.ts': 'export const add = (a: number, b: number) => a + b\n' })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const ran = await $.command.run({ command: 'test-grader', args: 'report' } as never)

  expect((ran as { text: string }).text).toBe('No tests to report: Grade all tests grades the project first.')
  expect(writes).toEqual([])
})


test('/test-grader report before any grading lists every test as never graded, at its line, with no reason', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GRADED }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const ran = await $.command.run({ command: 'test-grader', args: 'report' } as never)

  expect((ran as { text: string }).text).toBe('Wrote test-grader-report.md and test-grader-report.json: 4 tests, 0 strong.')
  expect(files['test-grader-report.md']).toBe(
    '# Test grades\n\n' +
      `4 tests: 4 ungraded. Graded by test-grader, ${new Date(1_000_010).toISOString()}.\n\n` +
      '## Ungraded (4)\n\n' +
      '- `src/deep/more.test.ts:3` a shallow check\n' +
      '- `src/deep/more.test.ts:4` another shallow one\n' +
      '- `src/math.test.ts:1` adds\n' +
      '- `src/math.test.ts:2` does nothing\n',
  )
  const json = JSON.parse(files['test-grader-report.json']!) as { coverage: unknown; tests: unknown[] }
  expect(json.coverage).toBe(null)
  expect(json.tests[0]).toEqual({ file: 'src/deep/more.test.ts', line: 3, name: 'a shallow check', state: 'ungraded', summary: null, reason: null, onEvidence: false })
})


test('/test-grader report gives the line coverage, lists the strong tests last, and a test whose file cannot be read without a line', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GRADED, 'coverage/coverage-summary.json': SUMMARY }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  // gone from the disk, before the pane notices: its grades stand, its lines are not known
  delete files['src/deep/more.test.ts']

  await $.command.run({ command: 'test-grader', args: 'report' } as never)

  expect(files['test-grader-report.md']).toBe(
    '# Test grades\n\n' +
      `4 tests: 1 hollow, 2 shallow, 1 strong. Graded by test-grader, ${new Date(1_000_010).toISOString()}.\n\n` +
      'Line coverage: 82.5% (coverage-summary.json).\n\n' +
      '## Hollow (1)\n\n- `src/math.test.ts:2` does nothing: hollow because.\n\n' +
      '## Shallow (2)\n\n- `src/deep/more.test.ts` a shallow check: shallow because. It would miss: a wrong edge.\n- `src/deep/more.test.ts` another shallow one: shallow because. It would miss: a wrong edge.\n\n' +
      '## Strong (1)\n\n- `src/math.test.ts:1` adds\n',
  )
  const json = JSON.parse(files['test-grader-report.json']!) as { coverage: unknown; tests: { line: number | null }[] }
  expect(json.coverage).toEqual({ lines: 82.5, branches: 61.2, functions: 75, statements: 80 })
  expect(json.tests.map(t => t.line)).toEqual([2, null, null, 1])
})
