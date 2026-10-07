import { expect, mock, test } from 'claude-code/testing'

const FILE = '/proj/src/math.test.ts'
const CONTENT = `
it('adds numbers', () => { expect(add(1, 2)).toBe(3) })
it('does nothing', () => { expect(true).toBe(true) })
`

for (const surface of ['desktop', 'terminal'] as const) {
  test(`pane tracks and rates new tests on ${surface}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    on('command.register', async () => ({ value: {} }) as never)
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('session.start', async () => ({ cwd: '/proj' }) as never)
    on('session.cwd', async () => ({ value: '/proj' }) as never)
    on('fs.stat', async () => {
      throw new Error('missing')
    })
    on('fs.read', async () => ({ value: CONTENT }) as never)
    on('model.complete', async () => ({
      value: {
        isAnswered: true,
        usage: {},
        text: JSON.stringify([
          { name: 'adds numbers', summary: 'Checks add(1,2) is 3.', verdict: 'good', reason: 'Asserts a real result.' },
          { name: 'does nothing', summary: 'Asserts true is true.', verdict: 'useless', reason: 'Tautology.' },
        ]),
      },
    }) as never)
    on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
    await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

    await $.tool.call({ tool: 'Write', file_path: FILE, content: CONTENT } as never)
    await clock.advance(10)

    const ui = await $.ui.mount({
      plugin: 'test-watch',
      surface,
      component: 'Pane',
      requestId: 'test-watch',
      props: { title: 'Tests', isFocused: false, bodyColumns: 60, placement: 'inline' } as never,
    })
    await ui.press({ key: `r:${FILE}:does nothing` })
    const tree = JSON.stringify(await ui.drawn())
    expect(tree).toContain('2 tests · 1 good · 0 weak · 1 useless · 2 new')
    expect(tree).toContain('adds numbers')
    expect(tree).toContain('Tautology.')
    expect(tree).toContain('1 useless')
    expect(tree).toContain('no report found')
  })
}

test('a non-test file is ignored', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  on('session.cwd', async () => ({ value: '/proj' }) as never)
  on('fs.stat', async () => {
    throw new Error('missing')
  })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/math.ts', content: "it('x', () => {})" } as never)
  const ui = await $.ui.mount({
    plugin: 'test-watch',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'test-watch',
    props: { title: 'Tests', isFocused: false, bodyColumns: 60, placement: 'inline' } as never,
  })
  expect(JSON.stringify(await ui.drawn())).toContain('0 tests · 0 good · 0 weak · 0 useless"')
})

test('a new test deep in a long file reaches the grader with its body, however far down it sits', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const helper = "const helper = (n: number) => n * 2\n"
  const old = Array.from({ length: 400 }, (_, i) => `it('old case ${i}', () => { expect(add(${i}, 1)).toBe(${i + 1}) })\n`).join('')
  const added = "it('subtracts numbers', () => {\n  expect(sub(5, 3)).toBe(2)\n})\n"
  const content = helper + old + added
  expect(content.length).toBeGreaterThan(20_000)
  const prompts: string[] = []
  on('session.cwd', async () => ({ value: '/proj' }) as never)
  on('fs.stat', async () => {
    throw new Error('missing')
  })
  on('fs.read', async () => ({ value: content }) as never)
  on('model.complete', async (_$, e) => {
    prompts.push(String((e as { prompt?: unknown }).prompt))
    return { value: { isAnswered: true, usage: {}, text: '[]' } } as never
  })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)

  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'x', new_string: added } as never)
  await clock.advance(10)

  expect(prompts).toHaveLength(1)
  // the new case whole, and the file's head where its helpers live
  expect(prompts[0]).toContain('expect(sub(5, 3)).toBe(2)')
  expect(prompts[0]).toContain('const helper = (n: number) => n * 2')
})

// Grade all tests: the project as git tracks it, every case graded, the weak and useless listed
const PANE_PROPS = { title: 'Tests', isFocused: false, bodyColumns: 80, placement: 'inline' } as never
const mount = ($: Parameters<Parameters<typeof test>[1]>[0], rows = 60) =>
  $.ui.mount({ plugin: 'test-watch', surface: 'terminal', component: 'Pane', requestId: 'test-watch', props: PANE_PROPS, viewport: { columns: 80, rows } } as never)

// gate: the first grader call waits on it; held: every call waits until it is released
// rule: a verdict from the name and the prompt, in place of the name-only default
type Project = { isGit?: boolean; gate?: () => Promise<void>; expand?: Record<string, string[]>; held?: { calls: number; release: () => void }; rule?: (name: string, prompt: string) => 'good' | 'weak' | 'useless' }
function project(on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, string>, { isGit = true, gate, expand = {}, held, rule }: Project = {}) {
  const prompts: string[] = []
  // the notes for Claude, as the debug log has them: a row a mod appends reaches no test
  // hook (the kit answers it "no implementation"), so the log line is what a test can see
  const notes: string[] = []
  on('ui.log', async (_$, e) => {
    const text = String((e as { text?: unknown }).text)
    if (text.startsWith('test-watch: note to Claude')) notes.push(text.replace(/^[^)]*\): /, ''))
    return { value: undefined } as never
  })
  on('command.register', async () => ({ value: {} }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('session.start', async () => ({ cwd: '/proj' }) as never)
  on('session.cwd', async () => ({ value: '/proj' }) as never)
  on('fs.stat', async () => {
    throw new Error('missing')
  })
  on('process.run', async (_$, e) => {
    const { argv } = e as { argv: string[] }
    if (argv[0] !== 'git') throw new Error(`unexpected ${argv.join(' ')}`)
    return { value: isGit ? { stdout: ['README.md', 'src/math.ts', ...Object.keys(files)].join('\n'), stderr: '', exitCode: 0 } : { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 } } as never
  })
  on('fs.read', async (_$, e) => {
    const path = (e as { path: string }).path.replace(/^\/proj\//, '')
    if (!(path in files)) throw new Error(`no ${path}`)
    return { value: files[path] } as never
  })
  // grades by the body: a test asserting true is useless, one with "shallow" in its name weak, else good
  on('model.complete', async (_$, e) => {
    const prompt = String((e as { prompt?: unknown }).prompt)
    if (gate && prompts.length === 0) {
      prompts.push(prompt)
      await gate()
    } else prompts.push(prompt)
    if (held) {
      held.calls += 1
      await new Promise<void>(r => {
        const before = held.release
        held.release = () => (before(), r())
      })
    }
    const names = JSON.parse(prompt.match(/test cases: (\[.*\])/)![1]!) as string[]
    return {
      value: {
        isAnswered: true,
        usage: {},
        text: JSON.stringify(
          names.flatMap(name => expand[name] ?? [name]).map(name => {
            const verdict = rule ? rule(name, prompt) : name.includes('shallow') ? 'weak' : name.includes('nothing') ? 'useless' : 'good'
            return { name, summary: `Checks ${name}.`, verdict, reason: `${verdict} because.` }
          }),
        ),
      },
    } as never
  })
  return { prompts, notes }
}

test('Grade all tests grades every case of every test file git tracks, in batches of 10, and lists the weak and useless worst first', async ($, on) => {
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
  expect(tree).toContain('26 tests · 24 good · 1 weak · 1 useless"')
  // listed: the useless before the weak; the good are counted, not listed
  expect(tree).toContain('useless because.')
  expect(tree).toContain('weak because.')
  expect(tree.indexOf('does nothing')).toBeLessThan(tree.indexOf('a shallow check'))
  // the good are listed too, after the weak in their file
  expect(tree.indexOf('a shallow check')).toBeLessThan(tree.indexOf('case 7'))
})

test('while grading, the button says how far it has got; pressing again grades afresh', async ($, on) => {
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

  await ui.press({ key: 'gradeAll' })
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

test('a test generated in a loop is graded case by case: the loop and its data reach the grader, and each case counts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const looped = [
    "it('first', () => { expect(1).toBe(1) })",
    '',
    '// each size, rounded',
    "const CASES = [['tiny', 1], ['huge shallow', 9], ['middle', 5]]",
    'for (const [name, n] of CASES) {',
    '  it(`rounds ${name}`, () => { expect(round(n)).toBe(n) })',
    '}',
    '',
  ].join('\n')
  const { prompts } = project(
    on,
    { 'src/round.test.ts': looped },
    // the grader names the loop's cases as it expands them, and one name that is not one of them
    { expand: { 'rounds ${name}': ['rounds tiny', 'rounds huge shallow', 'rounds middle', 'something else'] } },
  )
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('generated in a loop')
  const tree = JSON.stringify(await ui.drawn())
  // first, and the loop's three cases; the stray name is dropped
  expect(tree).toContain('4 tests · 3 good · 1 weak')
  expect(tree).toContain('rounds huge shallow')
  expect(tree).not.toContain('unrated')
  expect(tree).not.toContain('something else')
})

test('in a long file, a looped test reaches the grader with the data above it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const old = Array.from({ length: 400 }, (_, i) => `it('old case ${i}', () => {\n  expect(add(${i}, 1)).toBe(${i + 1})\n})\n`).join('')
  const added = "\nconst SIZES = [['tiny', 1], ['huge', 9]]\nfor (const [name, n] of SIZES) {\n  it(`rounds ${name}`, () => { expect(round(n)).toBe(n) })\n}\n"
  const prompts: string[] = []
  on('session.cwd', async () => ({ value: '/proj' }) as never)
  on('fs.stat', async () => {
    throw new Error('missing')
  })
  on('fs.read', async () => ({ value: old + added }) as never)
  on('model.complete', async (_$, e) => {
    prompts.push(String((e as { prompt?: unknown }).prompt))
    return { value: { isAnswered: true, usage: {}, text: '[]' } } as never
  })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)

  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'x', new_string: added } as never)
  await clock.advance(10)

  expect(prompts[0]).toContain("const SIZES = [['tiny', 1], ['huge', 9]]")
  expect(prompts[0]).toContain('for (const [name, n] of SIZES) {')
  expect(prompts[0]).not.toContain('old case 399')
})

test('a new looped test becomes one entry per case it generates', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "const SIZES = ['tiny', 'huge']\nfor (const name of SIZES) {\n  it(`rounds ${name}`, () => { expect(round(name)).toBeDefined() })\n}\n"
  project(on, { 'src/round.test.ts': content }, { expand: { 'rounds ${name}': ['rounds tiny', 'rounds huge'] } })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  await $.tool.call({ tool: 'Write', file_path: '/proj/src/round.test.ts', content } as never)
  await clock.advance(10)

  const ui = await mount($)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('· 2 new')
  expect(tree).toContain('rounds tiny')
  expect(tree).toContain('rounds huge')
  expect(tree).not.toContain('unrated')
})

test('Grade all tests runs up to 4 grader calls at once, and keeps the results in file order', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const cases = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `it('${prefix} ${i}', () => { expect(f(${i})).toBe(${i}) })\n`).join('')
  const held = { calls: 0, release: () => {} }
  const { prompts } = project(
    on,
    // 3 batches, 2 batches and 1: six calls in all
    { 'a.test.ts': cases('a', 25) + "it('a shallow one', () => {})\n", 'b.test.ts': cases('b', 15) + "it('b shallow one', () => {})\n", 'c.test.ts': cases('c', 3) },
    { held },
  )
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  // four in flight, and no fifth until one of them answers
  expect(held.calls).toBe(4)
  expect(prompts).toHaveLength(4)
  held.release()
  await clock.advance(10)
  expect(prompts).toHaveLength(6)
  held.release()
  await clock.advance(10)

  await ui.press({ key: 'f:/proj/a.test.ts' })
  await ui.press({ key: 'f:/proj/b.test.ts' })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('45 tests · 43 good · 2 weak')
  expect(tree.indexOf('a shallow one')).toBeLessThan(tree.indexOf('b shallow one'))
})

test('a finished run leaves Claude a note: the counts, then every weak, useless and unrated test, none of the good', async ($, on) => {
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
    'Test grading (test-watch) finished: 4 graded · 1 good · 1 weak · 1 useless · 1 unrated.\n' +
      'Weak or useless, worst first:\n' +
      '- useless · src/math.test.ts · does nothing — useless because.\n' +
      '- weak · src/more.test.ts · a shallow check — weak because.\n' +
      'Unrated (the grader gave no verdict):\n' +
      '- src/more.test.ts · lost ${x}',
  ])
})

test('the pane lists an unrated test after the weak, with its file, so it can be found', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, {
    'src/more.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\nit('lost ${x}', () => {})\n",
  }, { expand: { 'lost ${x}': [] } })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'r:/proj/src/more.test.ts:lost ${x}' })

  const tree = JSON.stringify(await ui.drawn())
  const weakAt = tree.indexOf('"a shallow check"')
  const unratedAt = tree.indexOf('"lost ${x}"')
  expect(weakAt).toBeGreaterThan(-1)
  expect(unratedAt).toBeGreaterThan(weakAt)
  // under its file's header; at its name, its label and why it has no verdict
  expect(tree.indexOf('▾ src/more.test.ts')).toBeLessThan(unratedAt)
  const entry = tree.slice(unratedAt - 120, unratedAt + 700)
  expect(entry).toContain('"unrated"')
  expect(entry).toContain('The grader gave no verdict for this test.')
})

test('a run with nothing to flag sends the count line alone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes } = project(on, { 'a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(notes).toEqual(['Test grading (test-watch) finished: 1 graded · 1 good · 0 weak · 0 useless.'])
})

test('a failed run sends nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes } = project(on, {}, { isGit: false })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(notes).toEqual([])
})

// the kit answers every append "no implementation": a note that does not go through
test('a note the session does not take says so in the pane, and why', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test ·')
  expect(tree).toContain("Couldn't share the result with Claude: no implementation for session.append")
})

test('a new test graded weak or useless as it is written leaves a note of those alone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('a shallow check', () => { expect(f).toBeDefined() })\nit('does nothing', () => {})\n"
  const { notes } = project(on, { 'src/a.test.ts': content })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content } as never)
  await clock.advance(10)
  expect(notes).toEqual([
    'New tests graded weak or useless (test-watch):\n' +
      '- useless · src/a.test.ts · does nothing — useless because.\n' +
      '- weak · src/a.test.ts · a shallow check — weak because.',
  ])
})

test('a new test graded good as it is written leaves no note', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" } as never)
  await clock.advance(10)
  expect(JSON.stringify(await (await mount($)).drawn())).toContain('1 good')
  expect(notes).toEqual([])
})

// one line per test, pressed open for the details; names read whole; the lists follow the session's edits
const ok = { result: {}, text: 'ok', isError: false, isReadOnly: false }

test('a test name with an escaped quote is read whole, so the grader\'s verdict finds it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, { 'src/q.test.ts': "it('the command\\'s status', () => { expect(f()).toBe(1) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(prompts[0]).toContain('["the command\'s status"]')
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 good · 0 weak · 0 useless')
  expect(tree).not.toContain('unrated')
})

test('a test written inside a fixture string is not a test', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('real one', () => {\n  const files = { 'a.test.ts': \"it('inner fixture', () => {})\" }\n  expect(run(files)).toBe(1)\n})\n"
  project(on, { 'src/f.test.ts': content })
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  await $.tool.call({ tool: 'Write', file_path: '/proj/src/f.test.ts', content } as never)
  await clock.advance(10)

  const ui = await mount($)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 good · 0 weak · 0 useless · 1 new')
  expect(tree).toContain('real one')
  expect(tree).not.toContain('inner fixture')
})

test('each test is one line until pressed open, and a second press closes it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/more.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const closed = JSON.stringify(await ui.drawn())
  expect(closed).toContain('a shallow check')
  expect(closed).not.toContain('weak because.')
  expect(closed).not.toContain('Checks a shallow check.')

  await ui.press({ key: 'r:/proj/src/more.test.ts:a shallow check' })
  const open = JSON.stringify(await ui.drawn())
  expect(open).toContain('src/more.test.ts')
  expect(open).toContain('Checks a shallow check.')
  expect(open).toContain('weak because.')

  await ui.press({ key: 'r:/proj/src/more.test.ts:a shallow check' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('weak because.')
})

test('a test the session deletes leaves both lists', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const shallow = "it('a shallow check', () => { expect(f).toBeDefined() })\n"
  const files: Record<string, string> = { 'src/more.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" + shallow }
  project(on, files)
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/more.test.ts', content: files['src/more.test.ts'] } as never)
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('a shallow check')

  files['src/more.test.ts'] = "it('adds', () => { expect(add(1, 2)).toBe(3) })\n"
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/more.test.ts', old_string: shallow, new_string: '' } as never)
  await clock.advance(10)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toContain('a shallow check')
  // the test written this session and the graded one are the same test, once
  expect(tree).toContain('1 test · 1 good · 0 weak · 0 useless · 1 new')
})

test('a weak test the session edits is graded again, and its new verdict replaces the old', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const before = "it('a shallow check', () => { expect(f).toBeDefined() })\n"
  const after = "it('a shallow check', () => { expect(f()).toBe(3) })\n"
  const files: Record<string, string> = { 'src/more.test.ts': before }
  // weak while the file still holds the shallow assertion, good once it is gone
  const { prompts } = project(on, files, { rule: (_name, prompt) => (prompt.includes('toBeDefined()') ? 'weak' : 'good') })
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 0 good · 1 weak')

  files['src/more.test.ts'] = after
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/more.test.ts', old_string: before, new_string: after } as never)
  await clock.advance(10)

  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('["a shallow check"]')
  const tree = JSON.stringify(await ui.drawn())
  // an edit to a test already there is no new test
  expect(tree).toContain('1 test · 1 good · 0 weak · 0 useless"')
})

test('tests are grouped by file, the worst file first; with several files each starts closed, and a press opens it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, {
    'src/a.test.ts': "it('fine one', () => { expect(f(1)).toBe(1) })\nit('fine two', () => { expect(f(2)).toBe(2) })\n",
    'src/b.test.ts': "it('solid', () => { expect(g(1)).toBe(2) })\nit('a shallow check', () => { expect(g).toBeDefined() })\n",
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('4 tests · 3 good · 1 weak · 0 useless')
  // b has the weak test, so it comes first; both closed, counted on their header lines
  expect(tree.indexOf('▸ src/b.test.ts')).toBeGreaterThan(-1)
  expect(tree.indexOf('▸ src/b.test.ts')).toBeLessThan(tree.indexOf('▸ src/a.test.ts'))
  expect(tree).toContain('2 · 1 good · 1 weak')
  // an all-good file's counts in green
  expect(tree).toContain('{"color":"#4ade80"},"children":["2 · 2 good"]')
  expect(tree).not.toContain('a shallow check')
  expect(tree).not.toContain('fine one')

  await ui.press({ key: 'f:/proj/src/b.test.ts' })
  const opened = JSON.stringify(await ui.drawn())
  expect(opened).toContain('▾ src/b.test.ts')
  expect(opened.indexOf('a shallow check')).toBeLessThan(opened.indexOf('"solid"'))
  expect(opened).not.toContain('fine one')
})

test('a single file starts open, and every one of its tests is listed, however many', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const many = Array.from({ length: 80 }, (_, i) => `it('case ${i}', () => { expect(f(${i})).toBe(${i}) })\n`).join('')
  project(on, { 'src/big.test.ts': many })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($, 30)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('▾ src/big.test.ts')
  expect(tree).toContain('"case 0"')
  expect(tree).toContain('"case 79"')
  expect(tree).not.toContain('more test')
})

test('a test written this session and graded again by Grade all tests shows once, marked new, with the newer verdict', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/c.test.ts': "it('a shallow check', () => { expect(h).toBeDefined() })\n" }
  // weak when written, good by the time Grade all tests reads it
  let isLater = false
  project(on, files, { rule: () => (isLater ? 'good' : 'weak') })
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/c.test.ts', content: files['src/c.test.ts'] } as never)
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 0 good · 1 weak · 0 useless · 1 new')

  isLater = true
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 good · 0 weak · 0 useless · 1 new')
  expect(tree.split('"a shallow check"')).toHaveLength(2)
})

test('a test written outside the session\'s folder is graded but not listed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('a shallow check', () => { expect(f).toBeDefined() })\n"
  const { prompts, notes } = project(on, { '/elsewhere/x.test.ts': content })
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  await $.tool.call({ tool: 'Write', file_path: '/elsewhere/x.test.ts', content } as never)
  await clock.advance(10)

  expect(prompts).toHaveLength(1)
  expect(notes).toHaveLength(1)
  const tree = JSON.stringify(await (await mount($)).drawn())
  expect(tree).not.toContain('a shallow check')
  expect(tree).toContain('0 tests · 0 good · 0 weak · 0 useless"')
})

test('a session start drops the entries whose test is no longer in its file', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/s.test.ts': "it('stays', () => { expect(f(1)).toBe(1) })\nit('goes', () => { expect(f(2)).toBe(2) })\n" }
  project(on, files)
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/s.test.ts', content: files['src/s.test.ts'] } as never)
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests ·')

  // changed while no session watched it
  files['src/s.test.ts'] = "it('stays', () => { expect(f(1)).toBe(1) })\n"
  await $.session.start({ source: 'resume', cwd: '/proj', surface: null, isInteractive: true } as never)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 good')
  expect(tree).toContain('stays')
  expect(tree).not.toContain('"goes"')
})

test('a file pressed open stays open while the session runs, and every file starts closed again at the next start', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, {
    'src/a.test.ts': "it('fine one', () => { expect(f(1)).toBe(1) })\n",
    'src/b.test.ts': "it('a shallow check', () => { expect(g).toBeDefined() })\n",
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  await ui.press({ key: 'f:/proj/src/a.test.ts' })
  expect(JSON.stringify(await ui.drawn())).toContain('▾ src/a.test.ts')

  await $.session.start({ source: 'resume', cwd: '/proj', surface: null, isInteractive: true } as never)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('▸ src/a.test.ts')
  expect(tree).toContain('▸ src/b.test.ts')
})
