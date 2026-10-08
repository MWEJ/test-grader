import { fingerprint } from '../hooks/register'
import { unkeep } from '../hooks/kept'
import { expect, mock, test } from 'claude-code/testing'
import type { Verdict } from '../types'
import type { Engine, On } from './helpers'
import { askGrades, buttonsOf, mount, project, verdictsDrawn, nodesOf, holdsKey, appended, E_TEST, E_FILE, sendEvidence, MUTATION, swayed, ASKED, seedState, BRANCH, branchGit } from './helpers'

test('Grade all tests grades every case of every test file git tracks, in batches of 10, and lists the flagged worst first', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const many = Array.from({ length: 23 }, (_, i) => `it('case ${i}', () => { expect(f(${i})).toBe(${i}) })\n`).join('')
  const { prompts } = project(on, {
    'src/math.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('does nothing', () => { expect(true).toBe(true) })\n",
    'src/big.test.ts': many + "it('a shallow check', () => { expect(f).toBeDefined() })\n",
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // one call for the small file, three (10 + 10 + 4) for the big one
  expect(prompts).toHaveLength(4)
  expect(prompts.every(p => p.includes('Test file: /proj/src/'))).toBe(true)
  // two files, so both start closed
  await ui.press({ key: 'f:/proj/src/math.test.ts' })
  await ui.press({ key: 'f:/proj/src/big.test.ts' })
  await ui.press({ key: 'r:/proj/src/math.test.ts:does nothing' })
  await ui.press({ key: 'r:/proj/src/big.test.ts:a shallow check' })
  const tree = JSON.stringify(await ui.drawn())
  // nothing written this session, so nothing is new
  expect(tree).toContain('26 tests · 24 strong · 1 hollow · 1 shallow"')
  // listed: the hollow before the shallow; the strong are counted, not listed
  expect(tree).toContain('hollow because.')
  expect(tree).toContain('shallow because. It would miss: a wrong edge.')
  expect(tree.indexOf('does nothing')).toBeLessThan(tree.indexOf('a shallow check'))
  // the strong are listed too, after the shallow in their file
  expect(tree.indexOf('a shallow check')).toBeLessThan(tree.indexOf('case 7'))
})


test('the pane first lists every test the project has: one graded before with its result, the rest ungraded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {
    'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
    'src/b.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n",
  }
  const { prompts } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)
  const ui = await mount($)
  for (const f of ['a', 'b']) await ui.press({ key: `f:/proj/src/${f}.test.ts` })
  expect(await verdictsDrawn(ui)).toEqual({ adds: 'ungraded', 'a shallow check': 'ungraded' })
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 0 strong · 2 ungraded')
  expect(prompts).toEqual([])

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  // a later session: a file added since, not graded yet
  files['src/c.test.ts'] = "it('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n"
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)
  await ui.press({ key: 'f:/proj/src/c.test.ts' })
  expect(await verdictsDrawn(ui)).toEqual({ adds: 'strong', 'a shallow check': 'shallow', subtracts: 'ungraded' })
  expect(prompts).toHaveLength(2)
})


test('while Grade all tests runs every test stays listed, the ones the grader has yet to answer as reviewing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let release = () => {}
  project(
    on,
    {
      'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
      'src/b.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n",
    },
    { gate: () => new Promise<void>(r => (release = r)) },
  )
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)
  const ui = await mount($)
  for (const f of ['a', 'b']) await ui.press({ key: `f:/proj/src/${f}.test.ts` })
  expect(await verdictsDrawn(ui)).toEqual({ adds: 'ungraded', 'a shallow check': 'ungraded' })
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  // the first file's call waits on the gate; the second has answered
  expect(await verdictsDrawn(ui)).toEqual({ adds: 'reviewing', 'a shallow check': 'shallow' })
  release()
  await clock.advance(10)
  expect(await verdictsDrawn(ui)).toEqual({ adds: 'strong', 'a shallow check': 'shallow' })
})


test('while grading, the button says how far it has got; Regrade all grades afresh',async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let release = () => {}
  const { prompts } = project(
    on,
    {
      'a.test.ts': "it('one', () => { expect(1).toBe(1) })\n",
      'b.test.ts': "it('two', () => { expect(2).toBe(2) })\n",
    },
    { gate: () => new Promise<void>(r => (release = r)) },
  )
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('Grading… 1/2 files done')
  release()
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests')

  await ui.press({ key: 'regradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(4)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests')
})


test('Grade all tests outside a git repo says so and grades nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, {}, { isGit: false })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(0)
  expect(JSON.stringify(await ui.drawn())).toContain('Not a git repository: there is no list of test files to grade.')
})


test('Grade all tests runs up to 10 grader calls at once, and keeps the results in file order', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const cases = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `it('${prefix} ${i}', () => { expect(f(${i})).toBe(${i}) })\n`).join('')
  const held = { calls: 0, release: () => {} }
  const { prompts } = project(
    on,
    // 6 batches, 5 batches and 1: twelve calls in all
    { 'a.test.ts': cases('a', 55) + "it('a shallow one', () => {})\n", 'b.test.ts': cases('b', 45) + "it('b shallow one', () => {})\n", 'c.test.ts': cases('c', 3) },
    { held },
  )
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  // ten in flight, and no eleventh until one of them answers
  expect(held.calls).toBe(10)
  expect(prompts).toHaveLength(10)
  held.release()
  await clock.advance(10)
  expect(prompts).toHaveLength(12)
  held.release()
  await clock.advance(10)

  await ui.press({ key: 'f:/proj/a.test.ts' })
  await ui.press({ key: 'f:/proj/b.test.ts' })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('105 tests · 103 strong · 2 shallow')
  expect(tree.indexOf('a shallow one')).toBeLessThan(tree.indexOf('b shallow one'))
})


test('a finished run leaves Claude a note: the counts, then every shallow, hollow and unrated test, none of the strong', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes } = project(on, {
    'src/math.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('does nothing', () => { expect(true).toBe(true) })\n",
    'src/more.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\nit('lost ${x}', () => {})\n",
  }, { expand: { 'lost ${x}': [] } })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(notes).toEqual([
    'Test grading (test-grader) finished: 4 graded · 1 strong · 1 hollow · 1 shallow · 1 unrated.\n' +
      'Need work, worst first:\n' +
      '- hollow · src/math.test.ts · does nothing — hollow because.\n' +
      '- shallow · src/more.test.ts · a shallow check — shallow because. It would miss: a wrong edge.\n' +
      'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.\n' +
      'Unrated (the grader gave no verdict):\n' +
      '- src/more.test.ts · lost ${x}',
  ])
})


test('the pane lists an unrated test after the shallow, with its file, so it can be found', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, {
    'src/more.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\nit('lost ${x}', () => {})\n",
  }, { expand: { 'lost ${x}': [] } })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'r:/proj/src/more.test.ts:lost ${x}' })

  const drawn = await ui.drawn()
  // its verdict column says unrated, and it is listed after the shallow one
  expect(Object.entries(await verdictsDrawn(ui))).toEqual([['a shallow check', 'shallow'], ['lost ${x}', 'unrated']])
  // under its file's header
  const tree = JSON.stringify(drawn)
  expect(tree.indexOf('▾ src/more.test.ts')).toBeLessThan(tree.indexOf('"r:/proj/src/more.test.ts:lost ${x}"'))
  // its own details, the ones its Open in editor sits in, say why it has no verdict
  const details = nodesOf(drawn).findLast(n => n.type === 'Box' && n.props?.flexDirection === 'column' && holdsKey(n, 'o:/proj/src/more.test.ts:lost ${x}'))
  expect(JSON.stringify(details)).toContain('The grader gave no verdict for this test.')
  expect(holdsKey(details!, 'o:/proj/src/more.test.ts:a shallow check')).toBe(false)
})


test('a run with nothing to flag sends the count line alone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes } = project(on, { 'a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(notes).toEqual(['Test grading (test-grader) finished: 1 graded · 1 strong.'])
})


test('a failed run sends nothing to Claude, and says in the pane why it failed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes, asked, prompts } = project(on, {}, { isGit: false })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  // the listing a session start makes, done
  await clock.advance(10)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // the pane says why, and the run is over: Grade all can be pressed again
  expect(JSON.stringify(await ui.drawn())).toContain('Not a git repository: there is no list of test files to grade.')
  expect(buttonsOf(await ui.drawn()).get('gradeAll')).toBe('Grade all tests')
  // and nothing reached Claude, as a note or a prompt, nor the grader
  expect(notes).toEqual([])
  expect(asked).toEqual([])
  expect(prompts).toEqual([])
})


test('Grade all tests again grades only the files changed since their last grading, and remembers the rest',async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {
    'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
    'src/b.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n",
  }
  const { prompts } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(2)

  // later, one file changed while none watched
  files['src/a.test.ts'] = "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n"
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(prompts).toHaveLength(3)
  expect(prompts[2]).toContain('src/a.test.ts')
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('3 tests · 2 strong · 1 shallow')
  expect(tree).toContain('2 graded · 1 remembered')
})


test('a finished Grade all tests saves grades a later session reads back whole, with each file\'s fingerprint and when it finished', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {
    'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
    'src/b.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n",
  }
  const { store } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(Object.keys(store)).toEqual(['grades:/proj'])
  // what a later session reads back: every grade, its words, and each file's fingerprint
  expect(unkeep(store['grades:/proj'] as never)).toEqual({
    results: [
      { file: '/proj/src/a.test.ts', name: 'adds', verdict: 'strong', summary: 'Checks adds.', reason: 'strong because.' },
      { file: '/proj/src/b.test.ts', name: 'a shallow check', verdict: 'shallow', summary: 'Checks a shallow check.', reason: 'shallow because. It would miss: a wrong edge.' },
    ],
    hashes: { '/proj/src/a.test.ts': fingerprint(files['src/a.test.ts']!), '/proj/src/b.test.ts': fingerprint(files['src/b.test.ts']!) },
    finishedAt: 1_000_001,
  })
  // kept small: each file's path once, however many tests it holds
  expect(JSON.stringify(store['grades:/proj']).split('/proj/src/a.test.ts')).toHaveLength(2)
})


test('a new session lists the grades saved for its project, and Grade all tests grades again only the files changed since', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const before = "it('adds', () => { expect(add(1, 2)).toBe(3) })\n"
  const files: Record<string, string> = {
    'src/a.test.ts': before + "it('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n",
    'src/b.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n",
  }
  const { prompts, store } = project(on, files)
  // what an earlier session saved, before a.test.ts gained a test
  store['grades:/proj'] = {
    results: [
      { file: '/proj/src/a.test.ts', name: 'adds', verdict: 'strong', summary: 'Checks adds.', reason: 'strong because.' },
      { file: '/proj/src/b.test.ts', name: 'a shallow check', verdict: 'shallow', summary: 'Checks a shallow check.', reason: 'saved shallow.' },
    ],
    hashes: { '/proj/src/a.test.ts': fingerprint(before), '/proj/src/b.test.ts': fingerprint(files['src/b.test.ts']!) },
    finishedAt: 500_000,
  }
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)
  const ui = await mount($)
  await ui.press({ key: 'f:/proj/src/b.test.ts' })
  await ui.press({ key: 'r:/proj/src/b.test.ts:a shallow check' })
  let tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('saved shallow.')
  expect(tree).toContain('1 ungraded')
  expect(prompts).toHaveLength(0)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('src/a.test.ts')
  tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('2 graded · 1 remembered')
})


test('a regrade on evidence is kept in the store too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { store } = project(on, { 'src/e.test.ts': E_TEST }, { rule: swayed })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  // the test as a later session reads it back from the store
  const saved = () => unkeep(store['grades:/proj'] as never).results.find(t => t.name === 'a shallow check')
  expect(saved()?.verdict).toBe('shallow')
  expect(saved()?.evidence).toBeUndefined()
  await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)
  // its new grade, and the evidence it was given on
  expect(saved()).toMatchObject({ file: E_FILE, verdict: 'strong', evidence: MUTATION })
})


test('grades too many to keep whole are kept without their summaries; failing that, the pane says they will not outlive the session', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }
  // the store takes a value only as small as the limit lets it
  const room = { limit: Infinity }
  const { store, logs } = project(on, files, { room })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  // whole, the value runs past the limit; lean, it fits
  room.limit = 130
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect((store['grades:/proj'] as { files: Record<string, { tests: string[][] }> }).files['/proj/src/a.test.ts']!.tests).toEqual([['adds', 'g', '', 'strong because.']])
  expect(logs).toContain('test-grader: the grades were kept without their summaries: test-grader: $.store.set: the store is full')
  expect(JSON.stringify(await ui.drawn())).not.toContain('could not be saved')

  room.limit = 10
  await ui.press({ key: 'regradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('The grades could not be saved, and will not outlive this session: test-grader: $.store.set: the store is full')
})


test('Grade all tests again grades a file whose last grading left a test unrated', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the grader gives no verdict for it the first time, and one the second
  const expand: Record<string, string[]> = { lost: [] }
  const { prompts } = project(on, { 'src/u.test.ts': "it('lost', () => { expect(f()).toBe(1) })\n" }, { expand })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(await verdictsDrawn(ui)).toEqual({ lost: 'unrated' })
  delete expand.lost

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // the unchanged file was sent again, for that test, and its verdict now stands
  expect(ASKED(prompts.slice(1))).toEqual(['lost'])
  expect(await verdictsDrawn(ui)).toEqual({ lost: 'strong' })
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 1 strong')
})


test('Regrade all grades every file again, remembered or not', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  expect(JSON.stringify(await ui.drawn())).not.toContain('"Regrade all"')
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(1)

  await ui.press({ key: 'regradeAll' })
  await clock.advance(10)

  expect(prompts).toHaveLength(2)
  expect(JSON.stringify(await ui.drawn())).toContain('1 graded · 0 remembered')
})


test('a Grade all run a reload cut off is started again at the session start, and its rows stop reviewing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('adds', () => { expect(add(1, 2)).toBe(3) })\n"
  const { prompts } = project(on, { 'src/a.test.ts': content })
  seedState(on, {
    existing: { state: 'running', done: 0, total: 1, isFresh: true, hashes: { '/proj/src/a.test.ts': 'old' }, results: [{ file: '/proj/src/a.test.ts', name: 'adds', verdict: 'shallow', isPending: true }] },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(ASKED(prompts)).toEqual(['adds'])
  const tree = JSON.stringify(await (await mount($)).drawn())
  expect(tree).not.toContain('reviewing')
  expect(tree).not.toContain('Grading…')
  expect(tree).toContain('Grade all tests')
})


test('a Regrade all a reload cut off is done again as a Regrade all, its unchanged files graded too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('adds', () => { expect(add(1, 2)).toBe(3) })\n"
  const { prompts } = project(on, { 'src/a.test.ts': content })
  // the file's grades stand from before, its fingerprint the one it has now
  const hash = fingerprint(content)
  seedState(on, {
    existing: { state: 'running', done: 0, total: 1, isFresh: true, hashes: { '/proj/src/a.test.ts': hash }, results: [{ file: '/proj/src/a.test.ts', name: 'adds', verdict: 'shallow', isPending: true }] },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(ASKED(prompts)).toEqual(['adds'])
})


test('a regrade a reload cut off is done again, and a new test left pending is graded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('a shallow check', () => { expect(f).toBeDefined() })\n"
  const { prompts } = project(on, { 'src/a.test.ts': content })
  seedState(on, {
    existing: { state: 'idle', done: 1, total: 1, results: [{ file: '/proj/src/a.test.ts', name: 'adds', verdict: 'shallow', isPending: true }] },
    tests: [{ id: 't1', file: '/proj/src/a.test.ts', name: 'a shallow check', at: 1, status: 'pending' }],
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(ASKED(prompts)).toEqual(['a shallow check', 'adds'])
  const tree = JSON.stringify(await (await mount($)).drawn())
  expect(tree).not.toContain('reviewing')
})


test('a session start while a run is under way leaves it to finish, with no second run', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const held = { calls: 0, release: () => {} }
  const { prompts } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { held })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(held.calls).toBe(1)

  // a compaction starts the session again with the run's grader call still out
  await $.session.start({ source: 'compact', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)
  held.release()
  await clock.advance(10)

  expect(prompts).toHaveLength(1)
  expect(JSON.stringify(await ui.drawn())).not.toContain('Grading…')
})


test('Grade all passes over a file git lists that cannot be read, grades the rest, and says so', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }
  const { prompts } = project(on, files, { git: argv => (argv[1] === 'ls-files' ? { stdout: 'src/a.test.ts\nsrc/gone.test.ts\n' } : undefined) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(1)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 strong')
  expect(tree).toContain('1 file could not be read, and was passed over.')
})


test('Stop cuts a run short: no more grader calls, the tests keep what they had, the pane says how far it got, and Claude is told nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const held = { calls: 0, release: () => {} }
  const files: Record<string, string> = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`src/t${i}.test.ts`, `it('case ${i}', () => { expect(f(${i})).toBe(${i}) })\n`]))
  const { prompts, asked } = project(on, files, { held })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(held.calls).toBe(3)
  await ui.press({ key: 'stopGrading' })
  held.release()
  await clock.advance(10)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('Stopped: 0 of 3 files graded.')
  expect(tree).toContain('3 tests · 0 strong · 3 ungraded')
  expect(tree).not.toContain('reviewing')
  expect(prompts).toHaveLength(3)
  expect(asked).toEqual([])
  // the next run grades them all
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  held.release()
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('3 tests · 3 strong')
})


// a run of one grader call with this usage, and the line the pane says it cost in
const costLine = async ($: Engine, on: On, usage: Record<string, number>) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const answer = { isAnswered: true, usage, text: JSON.stringify([{ name: 'adds', summary: 's', verdict: 'strong', reason: 'r' }]) }
  project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { reply: () => answer })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  return (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => t.startsWith('Last run:'))
}

test('the pane shows what the last run cost, in tokens in, from the cache and out, and in dollars at Haiku 5.5 prices', async ($, on) => {
  // 400 × $0.10 + 1,600 × $0.01 + 300 × $0.50 a million
  expect(await costLine($, on, { input_tokens: 400, cache_read_input_tokens: 1_600, output_tokens: 300 })).toBe('Last run: 1 graded · 0 remembered · 2k in (2k cached) / 300 out · about $0.00021')
})

test('a Haiku 5.5 prompt of exactly 100,000 tokens is priced short', async ($, on) => {
  // 100,000 × $0.10 + 2,000 × $0.50 a million; priced long it would be $0.055
  expect(await costLine($, on, { input_tokens: 100_000, output_tokens: 2_000 })).toContain('· about $0.011')
})

test('a Haiku 5.5 prompt over 100,000 tokens, cache writes and reads counted in, is priced long', async ($, on) => {
  // 80,000 × $0.50 + 10,000 × $0.625 + 20,000 × $0.05 + 1,000 × $2.50 a million
  expect(await costLine($, on, { input_tokens: 80_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 20_000, output_tokens: 1_000 })).toContain('· about $0.050')
})

test('a grader model with no known price shows its calls as unpriced, not a cost', { options: { graderModel: 'my-gateway-model' } }, async ($, on) => {
  const line = await costLine($, on, { input_tokens: 400, output_tokens: 300 })
  expect(line).toContain('· 1 call unpriced')
  expect(line).not.toContain('$')
})


test('/test-grader diff grades only the test files changed on the branch, and leaves the rest of the grades be', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, logs } = project(on, BRANCH, { git: branchGit })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  prompts.length = 0

  const ran = await $.command.run({ command: 'test-grader', args: 'diff' } as never)
  expect((ran as { text: string }).text).toBe('Grading the 3 test files changed against main.')
  await clock.advance(10)
  expect(ASKED(prompts)).toEqual(['a', 'b', 'c shallow'])
  expect(appended(logs).at(-1)!.split('\n')[0]).toBe('Test grading (test-grader) finished for the files changed on this branch: 3 graded · 2 strong · 1 shallow.')
  // d keeps its grade
  expect(JSON.stringify(await ui.drawn())).toContain('4 tests · 3 strong · 1 shallow')
})


test('/test-grader diff with no main branch says so and grades nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, BRANCH, { git: argv => (argv[1] === 'merge-base' ? { stdout: '', exitCode: 1 } : undefined) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ran = await $.command.run({ command: 'test-grader', args: 'diff' } as never)
  await clock.advance(10)
  expect((ran as { text: string }).text).toMatch(/^No main or master branch to compare with/)
  expect(prompts).toEqual([])
})


// The grades name what is wrong: brittle and duplicate are kept and listed like the others,
// and grades saved before they were renamed read as the nearest grade now
const FIVE = {
  'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('adds again', () => { expect(add(1, 2)).toBe(3) })\n",
  'src/b.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\nit('matches the snapshot', () => { expect(render()).toMatchSnapshot() })\nit('checks nothing', () => {})\n",
}
const fiveRule = (name: string): Verdict =>
  name === 'adds again' ? 'duplicate' : name === 'matches the snapshot' ? 'brittle' : name.includes('shallow') ? 'shallow' : name.includes('nothing') ? 'hollow' : 'strong'

test('brittle and duplicate grades are saved as their own codes and read back as themselves', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { store } = project(on, { ...FIVE }, { rule: fiveRule })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await (await mount($)).press({ key: 'gradeAll' })
  await clock.advance(10)
  const kept = store['grades:/proj'] as { files: Record<string, { tests: string[][] }> }
  expect(kept.files['/proj/src/a.test.ts']!.tests.map(t => t.slice(0, 2))).toEqual([['adds', 'g'], ['adds again', 'd']])
  expect(kept.files['/proj/src/b.test.ts']!.tests.map(t => t.slice(0, 2))).toEqual([['a shallow check', 'w'], ['matches the snapshot', 'b'], ['checks nothing', 'u']])

  // a new session reads them back: every grade as it was given
  const answer = await askGrades($, { verdicts: ['brittle', 'duplicate'] })
  expect(answer).toContain('"adds again": duplicate')
  expect(answer).toContain('"matches the snapshot": brittle')
  expect(answer).not.toContain('"a shallow check"')
})

test('a finished run lists the flagged worst first, hollow, duplicate, shallow, brittle, and counts only the grades it gave', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { logs } = project(on, { ...FIVE }, { rule: fiveRule })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const note = appended(logs).at(-1)!.split('\n')
  expect(note[0]).toBe('Test grading (test-grader) finished: 5 graded · 1 strong · 1 hollow · 1 duplicate · 1 shallow · 1 brittle.')
  expect(note.filter(l => l.startsWith('- ')).map(l => l.split(' · ')[0])).toEqual(['- hollow', '- duplicate', '- shallow', '- brittle'])
  expect(JSON.stringify(await ui.drawn())).toContain('5 tests · 1 strong · 1 hollow · 1 duplicate · 1 shallow · 1 brittle')
})

test('grades saved before the rename, good, weak and useless, read as strong, shallow and hollow', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/b.test.ts': FIVE['src/b.test.ts'] }
  const { store } = project(on, files)
  // the oldest form, verdicts in words, as an earlier version kept them
  store['grades:/proj'] = {
    results: [
      { file: '/proj/src/b.test.ts', name: 'a shallow check', verdict: 'weak', reason: 'was weak.' },
      { file: '/proj/src/b.test.ts', name: 'matches the snapshot', verdict: 'good', reason: 'was good.' },
      { file: '/proj/src/b.test.ts', name: 'checks nothing', verdict: 'useless', reason: 'was useless.' },
    ],
    hashes: { '/proj/src/b.test.ts': fingerprint(files['src/b.test.ts']!) },
  }
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(await verdictsDrawn(await mount($))).toEqual({ 'checks nothing': 'hollow', 'a shallow check': 'shallow', 'matches the snapshot': 'strong' })
})

test('grades this session held before a reload renamed them read as the nearest grade now', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/b.test.ts': FIVE['src/b.test.ts'] })
  seedState(on, {
    existing: {
      state: 'idle',
      done: 3,
      total: 3,
      results: [
        { file: '/proj/src/b.test.ts', name: 'a shallow check', verdict: 'weak' },
        { file: '/proj/src/b.test.ts', name: 'matches the snapshot', verdict: 'good' },
        { file: '/proj/src/b.test.ts', name: 'checks nothing', verdict: 'useless' },
      ],
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(await verdictsDrawn(await mount($))).toEqual({ 'checks nothing': 'hollow', 'a shallow check': 'shallow', 'matches the snapshot': 'strong' })
})
