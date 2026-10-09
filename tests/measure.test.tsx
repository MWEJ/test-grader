// Strong grades name the bug they would catch, and a sample is measured in the background
import { expect, mock, test } from 'claude-code/testing'
import { catchesOf, parseVerdicts } from '../hooks/excerpt'
import { measuredLine, mutate, pickToMeasure } from '../hooks/measure'
import type { Measured, Proposed } from '../hooks/measure'
import { TURN, mount, project } from './helpers'
import type { Engine, Shell } from './helpers'

test('a strong grade keeps the bug it names in its reason, and the change that makes it', () => {
  const { verdicts } = parseVerdicts('[{"name":"a","summary":"s","verdict":"strong","reason":"r.","catches":{"bug":"add(1, 2) giving -1","file":"src/add.ts","find":"a + b","replace":"a - b"}}]')
  expect(verdicts).toEqual([{ name: 'a', summary: 's', verdict: 'strong', reason: 'r. It catches: add(1, 2) giving -1', catches: { bug: 'add(1, 2) giving -1', file: 'src/add.ts', find: 'a + b', replace: 'a - b' } }])
})

test('a strong grade that names no bug it would catch is low confidence, and says why', () => {
  const { verdicts } = parseVerdicts('[{"name":"a","summary":"s","verdict":"strong","reason":"r.","confidence":"high","catches":{}}]')
  expect(verdicts).toEqual([{ name: 'a', summary: 's', verdict: 'strong', reason: 'r. (It named no bug the test would catch.)', confidence: 'low' }])
})

test('a flagged grade carries no bug caught, whatever the grader put in catches', () => {
  const { verdicts } = parseVerdicts('[{"name":"a","summary":"s","verdict":"brittle","reason":"r.","catches":{"bug":"x"}}]')
  expect(verdicts).toEqual([{ name: 'a', summary: 's', verdict: 'brittle', reason: 'r.' }])
})

const CATCHES: [string, unknown, ReturnType<typeof catchesOf>][] = [
  ['a bug given as plain text has no change', ' a wrong sum ', { bug: 'a wrong sum' }],
  ['a change that alters nothing is left off', { bug: 'b', file: 'f.ts', find: 'x', replace: 'x' }, { bug: 'b' }],
  ['a change with no file is left off', { bug: 'b', find: 'x', replace: 'y' }, { bug: 'b' }],
  ['a change to empty text is kept', { bug: 'b', file: 'f.ts', find: 'x', replace: '' }, { bug: 'b', file: 'f.ts', find: 'x', replace: '' }],
  ['a blank bug is no bug', { bug: '  ', file: 'f.ts', find: 'x', replace: 'y' }, null],
  ['no catches is no bug', undefined, null],
]
for (const [name, given, read] of CATCHES) {
  test(`the bug a grade catches: ${name}`, () => {
    expect(catchesOf(given)).toEqual(read)
  })
}

const P = (textOf: string): Proposed => ({ bug: 'b', file: '/p/a.ts', find: 'x', replace: 'y', textOf })
const M = (textOf: string, state: Measured['state'] = 'held'): Measured => ({ state, change: 'c', textOf })

test('the tests picked to measure are strong ones with a change for their text as it stands, not measured at it', () => {
  const strong = [
    { key: 'unproposed', textOf: 't' },
    { key: 'changed since', textOf: 'new' },
    { key: 'measured', textOf: 't' },
    { key: 'measured before a change', textOf: 'new' },
    { key: 'open', textOf: 't' },
    { key: 'written this session', textOf: undefined },
  ]
  const proposed = { 'changed since': P('old'), measured: P('t'), 'measured before a change': P('new'), open: P('t'), 'written this session': P('w') }
  const measured = { measured: M('t'), 'measured before a change': M('old') }
  expect(pickToMeasure(strong, proposed, measured, 10, () => 0).sort()).toEqual(['measured before a change', 'open', 'written this session'])
})

test('no more tests are picked than asked for', () => {
  const strong = ['a', 'b', 'c'].map(key => ({ key, textOf: 't' }))
  const proposed = { a: P('t'), b: P('t'), c: P('t') }
  expect(pickToMeasure(strong, proposed, {}, 2, () => 0.5)).toHaveLength(2)
  expect(pickToMeasure(strong, proposed, {}, 0)).toEqual([])
})

test('a change is made where its text is found once, taken literally', () => {
  expect(mutate('return a + b', 'a + b', '$& - b')).toEqual({ code: 'return $& - b' })
})

test('a change whose text is missing, or found more than once, is not made', () => {
  expect(mutate('return a', 'a + b', 'a - b')).toEqual({ why: 'the text to change is not in the file' })
  expect(mutate('a + b; a + b', 'a + b', 'a - b')).toEqual({ why: 'the text to change is in the file 2 times, not once' })
})

test('the pane line counts the strong tests a measured change made fail, and those that let theirs through', () => {
  const measured = { held: M('t'), other: M('t'), shallow: M('t', 'through'), odd: M('t', 'unmeasured') }
  expect(measuredLine(['held', 'odd', 'new'], measured)).toBe('measured: 1 of 3 strong · 1 let their named bug through (now shallow)')
  expect(measuredLine(['held'], { held: M('t') })).toBe('measured: 1 of 1 strong')
  expect(measuredLine(['held'], {})).toBeNull()
})


// A Go module whose one test the grader grades strong, naming a change to the code it checks
const GO: Record<string, string> = {
  'go.mod': 'module example.com/calc\n\ngo 1.22\n',
  'calc/add.go': 'package calc\n\nfunc Add(a, b int) int { return a + b }\n',
  'calc/add_test.go': 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("sum")\n\t}\n}\n',
}
const OVERLAY = '/tmp/test-grader-overlay-s1/overlay.json'
const strongReply = (file: string, name: string, find = 'a + b') => () => ({
  isAnswered: true,
  usage: {},
  text: JSON.stringify([{ name, summary: 's', verdict: 'strong', reason: 'r.', catches: { bug: 'Add(1, 2) giving -1', file, find, replace: 'a - b' } }]),
})
// go test passes when the code it builds adds: the overlay's copy where it names one
const goShell = (files: Record<string, string>): Shell => argv => {
  if (argv[0] !== 'go') return 1
  const overlay = argv.find(a => a.startsWith('-overlay='))
  const code = overlay ? files[(JSON.parse(files[overlay.slice('-overlay='.length)]!) as { Replace: Record<string, string> }).Replace['/proj/calc/add.go']!]! : files['calc/add.go']!
  return code.includes('a + b') ? { stdout: '=== RUN   TestAdd\n--- PASS: TestAdd\nok  example.com/calc', exitCode: 0 } : { stdout: '=== RUN   TestAdd\n--- FAIL: TestAdd\nFAIL', exitCode: 1 }
}

const gradeThenIdle = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await $.turn.complete(TURN)
  await clock.advance(6_000)
  return ui
}

test('a strong Go test that fails with its named bug is measured through an overlay, its source untouched', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', () => ({ text: '' }) as never)
  const files = { ...GO }
  const { runs } = project(on, files, { editor: goShell(files), env: { TMPDIR: '/tmp' }, reply: strongReply('calc/add.go', 'TestAdd') })
  const ui = await gradeThenIdle($, clock)

  expect(runs.map(r => r.find(a => a.startsWith('-overlay=')) ?? 'plain')).toEqual(['plain', `-overlay=${OVERLAY}`])
  expect(files['calc/add.go']).toBe(GO['calc/add.go'])
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 strong')
  expect(tree).toContain('measured: 1 of 1 strong')
})

test('a strong Go test that still passes with its named bug is graded shallow, its reason naming the change', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', () => ({ text: '' }) as never)
  const files = { ...GO }
  // a change the test cannot see: it passes either way
  const { runs } = project(on, files, { editor: () => ({ stdout: '=== RUN   TestAdd\n--- PASS: TestAdd\nok', exitCode: 0 }), env: { TMPDIR: '/tmp' }, reply: strongReply('calc/add.go', 'TestAdd') })
  const ui = await gradeThenIdle($, clock)

  expect(runs).toHaveLength(2)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 0 strong · 1 shallow')
  expect(tree).toContain('measured: 0 of 0 strong · 1 let their named bug through (now shallow)')
  const listed = await $.tool.call({ tool: 'mcp__test-grader__test_grades' } as never).then(r => String((r as { result: unknown }).result))
  expect(listed).toContain('Measured: it still passes with "a + b" replaced by "a - b" in calc/add.go, the bug its strong grade named. It would miss: Add(1, 2) giving -1')
})

test('a strong grade whose change is not in the code is not measured, and its grade stands', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', () => ({ text: '' }) as never)
  const files = { ...GO }
  const { runs } = project(on, files, { editor: goShell(files), env: { TMPDIR: '/tmp' }, reply: strongReply('calc/add.go', 'TestAdd', 'a * b') })
  const ui = await gradeThenIdle($, clock)

  expect(runs).toEqual([])
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 strong')
  expect(tree).toContain('measured: 0 of 1 strong')
})


// A JS project: its code is changed in place for a run, only when the person turns that on
const JS: Record<string, string> = {
  'package.json': '{"devDependencies": {"jest": "29"}}',
  'src/add.ts': 'export const add = (a: number, b: number) => a + b\n',
  'src/add.test.ts': "import { add } from './add'\n\nit('adds', () => { expect(add(1, 2)).toBe(3) })\n",
}
const jsShell = (files: Record<string, string>): Shell => () => (files['src/add.ts']!.includes('a + b') ? { stdout: 'PASS src/add.test.ts', exitCode: 0 } : { stdout: 'FAIL src/add.test.ts', exitCode: 1 })

test('a JS test is not measured unless changing files in place is turned on', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', () => ({ text: '' }) as never)
  const files = { ...JS }
  const { runs } = project(on, files, { editor: jsShell(files), reply: strongReply('src/add.ts', 'adds') })
  await gradeThenIdle($, clock)
  expect(runs).toEqual([])
})

test('with changing files in place on, a JS test is measured and its code put back after', { options: { measureInPlace: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', () => ({ text: '' }) as never)
  const files = { ...JS }
  const { runs, store } = project(on, files, { editor: jsShell(files), reply: strongReply('src/add.ts', 'adds') })
  const ui = await gradeThenIdle($, clock)

  expect(runs).toHaveLength(2)
  expect(files['src/add.ts']).toBe(JS['src/add.ts'])
  expect(Object.keys(store).filter(k => k.startsWith('mutating:'))).toEqual([])
  expect(JSON.stringify(await ui.drawn())).toContain('measured: 1 of 1 strong')
})

test('a turn starting while a JS test runs with its code changed puts the code back at once and records nothing', { options: { measureInPlace: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.start', () => ({ turnId: 't2' }) as never)
  const files = { ...JS }
  // the run with the change waits until the test lets it finish
  let finish = () => {}
  const until = new Promise<void>(r => (finish = r))
  let calls = 0
  const shell: Shell = async () => {
    calls += 1
    if (calls === 2) await until
    return files['src/add.ts']!.includes('a + b') ? { stdout: 'PASS', exitCode: 0 } : { stdout: 'FAIL', exitCode: 1 }
  }
  project(on, files, { editor: shell, reply: strongReply('src/add.ts', 'adds') })
  const ui = await gradeThenIdle($, clock)
  expect(files['src/add.ts']).toContain('a - b')

  await $.turn.start({ text: 'next', turnId: 't2' } as never)
  expect(files['src/add.ts']).toBe(JS['src/add.ts'])
  finish()
  await clock.advance(10)
  expect(files['src/add.ts']).toBe(JS['src/add.ts'])
  expect(JSON.stringify(await ui.drawn())).not.toContain('measured:')
})

test('a change a cut-off run left in a file is put back at the next start, and one edited since is left as it is', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...JS, 'src/sub.ts': 'export const sub = (a: number, b: number) => a + b // edited\n' }
  const { store } = project(on, files)
  files['src/add.ts'] = 'export const add = (a: number, b: number) => a - b\n'
  store['mutating:s1'] = { target: '/proj/src/add.ts', original: JS['src/add.ts'], mutated: files['src/add.ts'], at: 999_000 }
  store['mutating:gone'] = { target: '/proj/src/sub.ts', original: 'export const sub = (a: number, b: number) => a - b\n', mutated: 'export const sub = (a: number, b: number) => a + b\n', at: 0 }
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(files['src/add.ts']).toBe(JS['src/add.ts'])
  expect(files['src/sub.ts']).toBe('export const sub = (a: number, b: number) => a + b // edited\n')
  expect(Object.keys(store).filter(k => k.startsWith('mutating:'))).toEqual([])
})

test('another live session\'s change under way is left to it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { ...JS }
  const { store } = project(on, files)
  files['src/add.ts'] = 'export const add = (a: number, b: number) => a - b\n'
  store['mutating:other'] = { target: '/proj/src/add.ts', original: JS['src/add.ts'], mutated: files['src/add.ts'], at: 999_000 }
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(files['src/add.ts']).toContain('a - b')
  expect(Object.keys(store)).toContain('mutating:other')
})
