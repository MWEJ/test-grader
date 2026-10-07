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
    // no coverage run nor report in this project: no coverage section
    expect(tree).not.toContain('Coverage')
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
type Project = { isGit?: boolean; gate?: () => Promise<void>; expand?: Record<string, string[]>; held?: { calls: number; release: () => void }; rule?: (name: string, prompt: string) => 'good' | 'weak' | 'useless'; editor?: Shell; env?: Record<string, string>; outside?: Record<string, string>; cut?: (reply: string) => string; refuse?: string }
// a command's answer: its exit code, or what it printed too
type Shell = (argv: string[]) => number | { stdout?: string; stderr?: string; exitCode?: number }
// env: the variables the mod reads; outside: files by their full path, outside the project
function project(on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, string>, { isGit = true, gate, expand = {}, held, rule, editor, env = {}, outside = {}, cut, refuse }: Project = {}) {
  const prompts: string[] = []
  // every command but git, as run; editor answers it
  const runs: string[][] = []
  mock.env(on, env)
  // the notes for Claude, as the debug log has them: a row a mod appends reaches no test
  // hook (the kit answers it "no implementation"), so the log line is what a test can see
  const notes: string[] = []
  // every debug line, as logged
  const logs: string[] = []
  // each grader call's room for its reply
  const budgets: number[] = []
  on('ui.log', async (_$, e) => {
    const text = String((e as { text?: unknown }).text)
    logs.push(text)
    if (text.startsWith('test-watch: note to Claude')) notes.push(text.replace(/^[^)]*\): /, ''))
    return { value: undefined } as never
  })
  on('command.register', async () => ({ value: {} }) as never)
  // the tools the mod registers for the session, by name
  const tools: string[] = []
  on('tool.register', async (_$, e) => {
    tools.push((e as { name: string }).name)
    return { value: { tool: `mcp__test-watch__${(e as { name: string }).name}` } } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('session.start', async () => ({ cwd: '/proj' }) as never)
  on('session.cwd', async () => ({ value: '/proj' }) as never)
  // the session's id: a test sets another to start a new session, the same for a reload
  const session = { id: 's1' }
  on('session.id', async () => ({ value: session.id }) as never)
  // a file the project holds is there, written at the kit's start; any other is missing
  on('fs.stat', async (_$, e) => {
    const path = (e as { path: string }).path.replace(/^\/proj\//, '')
    if (!(path in files)) throw new Error('missing')
    return { value: { mtimeMs: 1_000_000, size: files[path]!.length, isFile: true, isDirectory: false } } as never
  })
  on('process.run', async (_$, e) => {
    const { argv } = e as { argv: string[] }
    if (argv[0] !== 'git') {
      if (!editor) throw new Error(`unexpected ${argv.join(' ')}`)
      runs.push(argv)
      const said = editor(argv)
      return { value: typeof said === 'number' ? { stdout: '', stderr: 'no such command', exitCode: said } : { stdout: '', stderr: '', exitCode: 0, ...said } } as never
    }
    return { value: isGit ? { stdout: ['README.md', 'src/math.ts', ...Object.keys(files)].join('\n'), stderr: '', exitCode: 0 } : { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 } } as never
  })
  on('fs.read', async (_$, e) => {
    const full = (e as { path: string }).path
    // a Windows path reaches the hook resolved under the kit's own folder: matched by its tail
    const known = Object.keys(outside).find(path => full === path || full.endsWith(`/${path}`))
    if (known) return { value: outside[known] } as never
    const path = full.replace(/^\/proj\//, '')
    if (!(path in files)) throw new Error(`no ${path}`)
    return { value: files[path] } as never
  })
  // grades by the body: a test asserting true is useless, one with "shallow" in its name weak, else good
  on('model.complete', async (_$, e) => {
    const prompt = String((e as { prompt?: unknown }).prompt)
    budgets.push(Number((e as { maxTokens?: unknown }).maxTokens))
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
        text: (cut ?? (t => t))(
          JSON.stringify(
            names.flatMap(name => expand[name] ?? [name]).map(name => {
              const verdict = rule ? rule(name, prompt) : name.includes('shallow') ? 'weak' : name.includes('nothing') ? 'useless' : 'good'
              return { name, summary: `Checks ${name}.`, verdict, reason: `${verdict} because.` }
            }),
          ),
        ),
      },
    } as never
  })
  // the notes sent as a prompt, which starts a turn once Claude is idle; a note only added
  // to the conversation is a row mock.session reads back
  const asked: string[] = []
  on('prompt.submit', async (_$, e) => {
    const { text } = e as { text: string }
    if (refuse !== undefined) return { drop: refuse } as never
    asked.push(text)
    return { text } as never
  })
  return { prompts, notes, runs, logs, budgets, tools, session, asked }
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

// each test row's verdict, as the pane draws it, by the test's name
const verdictsDrawn = async (ui: { drawn: () => Promise<unknown> }): Promise<Record<string, string>> => {
  const json = JSON.stringify(await ui.drawn())
  return Object.fromEntries(
    [...json.matchAll(/"children":\["(\w+)"\]\}\]\},\{"type":"Box","props":\{"flexDirection":"column"\},"children":\[\{"type":"Button","props":\{"key":"r:[^"]*?:([^"]*)"/g)].map(m => [m[2]!, m[1]!]),
  )
}

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
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 0 good · 0 weak · 0 useless · 2 ungraded')
  expect(prompts).toEqual([])

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  // a later session: a file added since, not graded yet
  files['src/c.test.ts'] = "it('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n"
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)
  await ui.press({ key: 'f:/proj/src/c.test.ts' })
  expect(await verdictsDrawn(ui)).toEqual({ adds: 'good', 'a shallow check': 'weak', subtracts: 'ungraded' })
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
  expect(await verdictsDrawn(ui)).toEqual({ adds: 'reviewing', 'a shallow check': 'weak' })
  release()
  await clock.advance(10)
  expect(await verdictsDrawn(ui)).toEqual({ adds: 'good', 'a shallow check': 'weak' })
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
      'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.\n' +
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
  const entry = tree.slice(unratedAt - 300, unratedAt + 700)
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
  project(on, { 'a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { refuse: 'the session is closing' })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test ·')
  expect(tree).toContain("Couldn't share the result with Claude: the session is closing")
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
      '- weak · src/a.test.ts · a shallow check — weak because.\n' +
      'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.',
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

test('a file pressed open stays open while the session runs, a reload included, and every file starts closed again in a new session', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { session } = project(on, {
    'src/a.test.ts': "it('fine one', () => { expect(f(1)).toBe(1) })\n",
    'src/b.test.ts': "it('a shallow check', () => { expect(g).toBeDefined() })\n",
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  await ui.press({ key: 'f:/proj/src/a.test.ts' })
  expect(JSON.stringify(await ui.drawn())).toContain('▾ src/a.test.ts')

  // a reload of the mod, or a compaction, starts the same session again: what is open stays
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.session.start({ source: 'compact', cwd: '/proj', surface: null, isInteractive: true } as never)
  expect(JSON.stringify(await ui.drawn())).toContain('▾ src/a.test.ts')

  session.id = 's2'
  await $.session.start({ source: 'resume', cwd: '/proj', surface: null, isInteractive: true } as never)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('▸ src/a.test.ts')
  expect(tree).toContain('▸ src/b.test.ts')
})

// opens 'a shallow check' (line 5 of src/e.test.ts) from the pane; the commands run, in order
const E_TEST = "import { f } from './f'\n\nit('first', () => { expect(f(1)).toBe(1) })\n\nit('a shallow check', () => {\n  expect(f).toBeDefined()\n})\n"
const E_FILE = '/proj/src/e.test.ts'
async function openShallow($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], world: Pick<Project, 'editor' | 'env' | 'outside'>) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { runs } = project(on, { 'src/e.test.ts': E_TEST }, world)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: `r:${E_FILE}:a shallow check` })
  await ui.press({ key: `o:${E_FILE}:a shallow check` })
  await clock.advance(10)
  return { runs, ui }
}

// macOS: what osascript says opens the file, as the mod's script prints it
const macDefault = (app: { app: string; id: string; exe: string } | null): Shell => argv =>
  argv[0] === 'osascript' ? { stdout: app ? JSON.stringify(app) : '' } : 0

test('on macOS the default app is asked by the file, and a VS Code fork opens at the line through its own bundled command', async ($, on) => {
  const app = '/Applications/Antigravity IDE.app'
  const { runs } = await openShallow($, on, {
    editor: macDefault({ app, id: 'com.google.antigravity-ide', exe: `${app}/Contents/MacOS/Electron` }),
    outside: { [`${app}/Contents/Resources/app/product.json`]: '{"applicationName": "antigravity-ide"}' },
  })

  expect(runs[0]![0]).toBe('osascript')
  expect(runs[0]!.at(-1)).toBe(E_FILE)
  expect(runs.slice(1)).toEqual([[`${app}/Contents/Resources/app/bin/antigravity-ide`, '--goto', `${E_FILE}:5`]])
})

test('on macOS Zed, Sublime Text and a JetBrains IDE each open at the line their own way', async ($, on) => {
  let current: { app: string; id: string; exe: string } = { app: '/Applications/Zed.app', id: 'dev.zed.Zed', exe: '/Applications/Zed.app/Contents/MacOS/zed' }
  const clock = mock.clock(on, { now: 1_000_000 })
  const { runs } = project(on, { 'src/e.test.ts': E_TEST }, { editor: argv => macDefault(current)(argv) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: `r:${E_FILE}:a shallow check` })
  const opened: string[][] = []
  for (const app of [
    current,
    { app: '/Applications/Sublime Text.app', id: 'com.sublimetext.4', exe: '/Applications/Sublime Text.app/Contents/MacOS/sublime_text' },
    { app: '/Applications/WebStorm.app', id: 'com.jetbrains.WebStorm', exe: '/Applications/WebStorm.app/Contents/MacOS/webstorm' },
  ]) {
    current = app
    await ui.press({ key: `o:${E_FILE}:a shallow check` })
    await clock.advance(10)
    opened.push(runs.at(-1)!)
  }

  expect(opened).toEqual([
    ['/Applications/Zed.app/Contents/MacOS/cli', `${E_FILE}:5`],
    ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl', `${E_FILE}:5`],
    ['/Applications/WebStorm.app/Contents/MacOS/webstorm', '--line', '5', E_FILE],
  ])
})

test('on macOS an app with no way to go to a line opens the file itself, and so does a line command that fails', async ($, on) => {
  const app = '/Applications/Cursor.app'
  const { runs } = await openShallow($, on, {
    editor: argv => (argv[0] === 'osascript' ? { stdout: JSON.stringify({ app, id: 'com.todesktop.cursor', exe: `${app}/Contents/MacOS/Cursor` }) } : argv.includes('--goto') ? 1 : 0),
    outside: { [`${app}/Contents/Resources/app/product.json`]: '{"applicationName": "cursor"}' },
  })

  expect(runs.slice(1)).toEqual([
    [`${app}/Contents/Resources/app/bin/cursor`, '--goto', `${E_FILE}:5`],
    ['open', '-a', app, E_FILE],
  ])
})

test('on macOS with no app for the file, it opens as the system would', async ($, on) => {
  const { runs, ui } = await openShallow($, on, { editor: macDefault(null) })

  expect(runs.slice(1)).toEqual([['open', E_FILE]])
  expect(JSON.stringify(await ui.drawn())).not.toContain("Couldn't open")
})

test('an EDITOR naming a GUI editor wins over the default app', async ($, on) => {
  const { runs } = await openShallow($, on, { env: { EDITOR: 'cursor --wait' }, editor: () => 0 })
  expect(runs).toEqual([['cursor', '--goto', `${E_FILE}:5`]])
})

test('a terminal EDITOR is passed over for the default app', async ($, on) => {
  const { runs } = await openShallow($, on, { env: { VISUAL: 'nvim', EDITOR: 'vim' }, editor: macDefault(null) })
  expect(runs.map(argv => argv[0])).toEqual(['osascript', 'open'])
})

// Linux: no osascript; xdg-mime names the file's type, then the .desktop file that opens it
const linux = (desktop: string | null): Shell => argv => {
  if (argv[0] === 'osascript') return { stderr: 'osascript: command not found', exitCode: 127 }
  if (argv.join(' ') === `xdg-mime query filetype ${E_FILE}`) return { stdout: 'text/vnd.trolltech.linguist\n' }
  if (argv.join(' ') === 'xdg-mime query default text/vnd.trolltech.linguist') return { stdout: desktop ? `${desktop}\n` : '' }
  return 0
}

test('on Linux the default app comes from xdg-mime and its .desktop file, the user\'s own first', async ($, on) => {
  const { runs } = await openShallow($, on, {
    env: { HOME: '/home/m' },
    editor: linux('code.desktop'),
    outside: {
      '/home/m/.local/share/applications/code.desktop': '[Desktop Entry]\nName=Visual Studio Code\nExec=/usr/share/code/code --unity-launch %F\nIcon=code\n',
      '/usr/share/applications/code.desktop': '[Desktop Entry]\nExec=/usr/bin/other %F\n',
    },
  })

  expect(runs.at(-1)).toEqual(['/usr/share/code/code', '--goto', `${E_FILE}:5`])
})

test('on Linux with no app for the file, xdg-open opens it', async ($, on) => {
  const { runs } = await openShallow($, on, { env: { HOME: '/home/m' }, editor: linux(null) })
  expect(runs.at(-1)).toEqual(['xdg-open', E_FILE])
})

// Windows: the user's choice for the extension, then that choice's open command, from the registry
const windows = (command: string | null): Shell => argv => {
  const asked = argv.join(' ')
  if (asked === 'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.ts\\UserChoice /v ProgId')
    return command ? { stdout: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.ts\\UserChoice\r\n    ProgId    REG_SZ    VSCode.ts\r\n\r\n' } : 1
  if (asked === 'reg query HKCR\\.ts /ve') return 1
  if (asked === 'reg query HKCR\\VSCode.ts\\shell\\open\\command /ve') return { stdout: `\r\nHKEY_CLASSES_ROOT\\VSCode.ts\\shell\\open\\command\r\n    (Default)    REG_SZ    ${command}\r\n\r\n` }
  return 0
}

test('on Windows the default app comes from the registry, and VS Code opens at the line through its code.cmd', async ($, on) => {
  const dir = 'C:\\Users\\m\\AppData\\Local\\Programs\\Microsoft VS Code'
  const { runs } = await openShallow($, on, {
    env: { OS: 'Windows_NT' },
    editor: windows(`"${dir}\\Code.exe" "%1"`),
    outside: { [`${dir}\\resources\\app\\product.json`]: '{"applicationName": "code"}' },
  })

  expect(runs.some(argv => argv[0] === 'osascript')).toBe(false)
  expect(runs.at(-1)).toEqual(['cmd', '/c', `${dir}\\bin\\code.cmd`, '--goto', `${E_FILE}:5`])
})

test('on Windows with no app for the file, start opens it', async ($, on) => {
  const { runs } = await openShallow($, on, { env: { OS: 'Windows_NT' }, editor: windows(null) })
  expect(runs.at(-1)).toEqual(['cmd', '/c', 'start', '', E_FILE])
})

test('a looped test opens at its loop\'s line', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "const SIZES = ['tiny']\nfor (const name of SIZES) {\n  it(`rounds ${name}`, () => { expect(round(name)).toBeDefined() })\n}\n"
  const { runs } = project(on, { 'src/l.test.ts': content }, { expand: { 'rounds ${name}': ['rounds tiny'] }, env: { EDITOR: 'code' }, editor: () => 0 })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  await ui.press({ key: 'r:/proj/src/l.test.ts:rounds tiny' })
  await ui.press({ key: 'o:/proj/src/l.test.ts:rounds tiny' })
  await clock.advance(10)

  expect(runs).toEqual([['code', '--goto', '/proj/src/l.test.ts:3']])
})

test('when nothing opens the file, the pane says so', async ($, on) => {
  const { ui } = await openShallow($, on, { editor: () => 1 })
  expect(JSON.stringify(await ui.drawn())).toContain("Couldn't open src/e.test.ts in an editor: no such command")
})

test('a test name too long for its row wraps onto the next lines, whole', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const name = 'keeps the quota band steady while the session compacts and the five hour window rolls over into the next one'
  project(on, { 'src/w.test.ts': `it('${name}', () => { expect(band()).toEqual(steady) })\n` })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // the row's lines, as drawn: the labels that are part of the name
  const labels = [...JSON.stringify(await ui.drawn()).matchAll(/"label":"([^"]*)"/g)].map(m => m[1]!).filter(label => name.includes(label))
  expect(labels.length).toBeGreaterThan(1)
  expect(labels.join(' ')).toBe(name)
  for (const label of labels) expect(label.length).toBeLessThanOrEqual(80 - 2 - 'good'.length - 1)
})

test('each verdict sits in one column on its title\'s first line, and an opened row\'s details sit under the title', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const long = 'keeps the quota band steady while the session compacts and the five hour window rolls over into the next one'
  project(on, { 'src/v.test.ts': `it('${long}', () => { expect(band()).toEqual(steady) })\nit('a shallow check', () => { expect(f).toBeDefined() })\nit('checks nothing', () => {})\n` })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'r:/proj/src/v.test.ts:a shallow check' })

  type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const nodes: Node[] = []
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    nodes.push(n as Node)
    for (const c of (n as Node).children ?? []) walk(c)
  }
  walk(await ui.drawn())
  // a test's line: a row whose first child is its verdict's column
  const lines = nodes.filter(n => n.type === 'Box' && n.props?.flexDirection === 'row' && (n.children?.[0] as Node | undefined)?.props?.width !== undefined)
  expect(lines).toHaveLength(3)
  const widths = lines.map(l => (l.children![0] as Node).props!.width)
  expect(new Set(widths).size).toBe(1)
  const width = widths[0] as number
  // as wide as the widest verdict drawn, so no title starts further in than another
  const verdicts = lines.map(l => JSON.stringify(l.children![0]).match(/"children":\["(\w+)"\]/)![1]!)
  expect(verdicts.sort()).toEqual(['good', 'useless', 'weak'])
  expect(width).toBe('useless'.length)
  for (const l of lines) {
    // the verdict on the first line of its title, beside the title's first part
    expect(l.props!.alignItems).toBe('flex-start')
    const title = l.children![1] as Node
    expect([long, 'a shallow check', 'checks nothing'].some(n => n.startsWith(String((title.children![0] as Node).props!.label)))).toBe(true)
  }

  // the opened row's details start where its title does: the column, then the gap
  const details = nodes.findLast(n => n.type === 'Box' && JSON.stringify(n.children).includes('Open in editor') && n.props?.flexDirection === 'column')
  expect(details?.props?.marginLeft).toBe(width + 1)
})

test('Grade all tests again grades only the files changed since their last grading, and remembers the rest across sessions',async ($, on) => {
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

  // a later session, one file changed while none watched
  files['src/a.test.ts'] = "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n"
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(prompts).toHaveLength(3)
  expect(prompts[2]).toContain('src/a.test.ts')
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('3 tests · 2 good · 1 weak')
  expect(tree).toContain('2 graded · 1 remembered')
})

test('Grade all tests again grades a file whose last grading left a test unrated', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, { 'src/u.test.ts': "it('lost', () => { expect(f()).toBe(1) })\n" }, { expand: { lost: [] } })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(prompts).toHaveLength(2)
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

// a testify suite spread over two files, its runner, and a plain test beside it
const QUOTA_TEST = `package quota

type QuotaSuite struct{ suite.Suite }

func TestQuotaSuite(t *testing.T) {
	suite.Run(t, new(QuotaSuite))
}

func (s *QuotaSuite) TestRollover() {
	s.Equal(5, rollover(4))
}

func TestPlain(t *testing.T) {
	if plain() != 1 {
		t.Fatal("plain")
	}
}
`
const OTHER_TEST = `package quota

func (s *QuotaSuite) TestShallowCheck() {
	s.NotNil(New())
}
`

test('Go suite methods are graded as tests, and the function that only runs the suite is not', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, { 'pkg/quota/quota_test.go': QUOTA_TEST, 'pkg/quota/other_test.go': OTHER_TEST })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const asked = prompts.map(p => JSON.parse(p.match(/test cases: (\[.*\])/)![1]!) as string[]).flat().sort()
  expect(asked).toEqual(['TestPlain', 'TestRollover', 'TestShallowCheck'])
})

test('a Go suite is a top-level group over its files, and the tests outside it stay under their file', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'pkg/quota/quota_test.go': QUOTA_TEST, 'pkg/quota/other_test.go': OTHER_TEST }, { rule: name => (name.includes('Shallow') ? 'weak' : 'good') })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // two groups at the top, both closed: the suite (weak, so first) and the plain test's file
  let tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('▸ QuotaSuite · pkg/quota')
  expect(tree.indexOf('▸ QuotaSuite')).toBeLessThan(tree.indexOf('▸ pkg/quota/quota_test.go'))
  expect(tree).not.toContain('TestRollover')

  // open, the suite lists its two files, closed; a file opened lists its suite tests only
  await ui.press({ key: 's:/proj/pkg/quota:QuotaSuite' })
  tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"▸ pkg/quota/other_test.go"')
  await ui.press({ key: 'sf:/proj/pkg/quota:QuotaSuite:/proj/pkg/quota/quota_test.go' })
  tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"TestRollover"')
  expect(tree).not.toContain('"TestPlain"')

  await ui.press({ key: 'f:/proj/pkg/quota/quota_test.go' })
  expect(JSON.stringify(await ui.drawn())).toContain('"TestPlain"')
})

test('a project of one Go suite in one file starts open all the way down', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'pkg/quota/other_test.go': OTHER_TEST })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('▾ QuotaSuite · pkg/quota')
  expect(tree).toContain('"▾ pkg/quota/other_test.go"')
  expect(tree).toContain('"TestShallowCheck"')
})

for (const [surface, perLine] of [
  // the terminal: a cell a character, every cell of the room after the margin, verdict and gap
  ['terminal', 50 - 2 - 'good'.length - 1],
  // a desktop's proportional font fits a fifth more characters than the pane has cells
  ['desktop', Math.floor((50 - 2 - 'good'.length - 1) * 1.2)],
] as const) {
  test(`on the ${surface} a docked pane wraps names to its own width, not the window's, and uses all of it`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const name = 'a chosen lifetime is set in the variable at once, warming on or off; auto sets no value at all until it is chosen'
    project(on, { 'src/w.test.ts': `it('${name}', () => { expect(band()).toEqual(steady) })\n` })
    await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
    const ui = await $.ui.mount({
      plugin: 'test-watch', surface, component: 'Pane', requestId: 'test-watch',
      props: { title: 'Tests', isFocused: false, bodyColumns: 50, placement: 'dock' }, viewport: { columns: 160, rows: 60 },
    } as never)
    await ui.press({ key: 'gradeAll' })
    await clock.advance(10)

    const labels = [...JSON.stringify(await ui.drawn()).matchAll(/"label":"([^"]*)"/g)].map(m => m[1]!).filter(label => name.includes(label))
    expect(labels.join(' ')).toBe(name)
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(perLine)
    // each line but the last is broken only where the next word would not fit
    for (const [i, label] of labels.slice(0, -1).entries()) expect(`${label} ${labels[i + 1]!.split(' ')[0]}`.length).toBeGreaterThan(perLine)
  })
}

// a test file changed some other way than Claude's Write or Edit: the shell, an editor, a checkout
const SUM_BEFORE = "it('a shallow check', () => { expect(sum).toBeDefined() })\nit('adds', () => { expect(sum(1, 2)).toBe(3) })\n"
const SUM_AFTER = "it('checks the sum and the carry', () => { expect(sum(9, 1)).toBe(10) })\nit('adds', () => { expect(sum(1, 2)).toBe(3) })\n"
const TURN = { answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as never

test('at a turn\'s end, a listed test file changed by other means is updated as an edit would: gone tests leave, new ones are graded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', () => ({ text: '' }) as never)
  const files: Record<string, string> = { 'src/c.test.ts': SUM_BEFORE }
  const { prompts } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('"a shallow check"')

  files['src/c.test.ts'] = SUM_AFTER
  await $.turn.complete(TURN)
  await clock.advance(10)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toContain('"a shallow check"')
  expect(tree).toContain('"checks the sum and the carry"')
  expect(tree).toContain('2 tests · 2 good · 0 weak · 0 useless · 1 new')
  expect(prompts.at(-1)).toContain('checks the sum and the carry')
})

test('at a turn\'s end, unchanged files cost no grader call, nor does one Claude just wrote', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  const files: Record<string, string> = { 'src/c.test.ts': SUM_BEFORE }
  const { prompts } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(prompts).toHaveLength(1)

  files['src/c.test.ts'] = SUM_AFTER
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/c.test.ts', content: SUM_AFTER } as never)
  await clock.advance(10)
  const afterWrite = prompts.length
  await $.turn.complete(TURN)
  await clock.advance(10)

  expect(prompts).toHaveLength(afterWrite)
})

test('a grader reply cut off before its end keeps every verdict that arrived whole, and the log says it was cut', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { logs } = project(
    on,
    { 'src/k.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('a shallow check', () => { expect(f).toBeDefined() })\nit('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n" },
    // the reply stops partway through its third verdict
    { cut: reply => reply.slice(0, reply.lastIndexOf('{"name"') + 30) },
  )
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(JSON.stringify(await ui.drawn())).toContain('3 tests · 1 good · 1 weak · 0 useless · 1 unrated')
  expect(logs.some(line => line.startsWith('test-watch: a grader reply was cut off') && line.includes('src/k.test.ts'))).toBe(true)
})

test('a grader call has room in its reply for a looped test\'s every case', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const loop = "for (const name of NAMES) {\n  it(`the lifetime: ${name}`, () => { expect(ttl(name)).toBeDefined() })\n}\n"
  const { budgets } = project(on, { 'src/l.test.ts': loop }, { expand: { 'the lifetime: ${name}': Array.from({ length: 20 }, (_, i) => `the lifetime: case ${i}`) } })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // about 75 tokens a verdict, for 20 cases
  expect(budgets[0]).toBeGreaterThanOrEqual(20 * 75)
  expect(budgets[0]).toBeGreaterThan(1500)
})

// the session's evidence for a test, sent through the mod's tool; what the tool answers
const EVIDENCE_TOOL = 'mcp__test-watch__test_evidence'
const sendEvidence = async ($: Parameters<Parameters<typeof test>[1]>[0], input: { file: string; test: string; evidence: string }) =>
  String((await $.tool.call({ tool: EVIDENCE_TOOL, ...input } as never)).result)
const MUTATION = 'Removing the default export of f makes this test fail; no other test fails.'
// the grader is swayed by the mutation, when it is sent; else a shallow test stays weak
const swayed = (name: string, prompt: string): 'good' | 'weak' => (name.includes('shallow') && !prompt.includes(MUTATION) ? 'weak' : 'good')

test('evidence the grader accepts turns a weak test good, and the row says it was graded on evidence', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, tools } = project(on, { 'src/e.test.ts': E_TEST }, { rule: swayed })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  expect(tools).toEqual(['test_evidence'])
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 1 good · 1 weak')

  const answer = await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)

  expect(answer).toMatch(/^Now good: /)
  // the grader saw the evidence, and was told to check it against the source
  expect(prompts.at(-1)).toContain(MUTATION)
  expect(prompts.at(-1)).toContain('check each claim against the source')
  expect(prompts.at(-1)).toContain('Review ONLY these test cases: ["a shallow check"]')
  await ui.press({ key: `r:${E_FILE}:a shallow check` })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('2 tests · 2 good · 0 weak')
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

  expect(answer).toBe('Still weak: weak because.')
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 1 good · 1 weak')
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
  expect(tree).toContain('3 tests · 2 good · 1 weak')
})

test('the note on weak tests tells Claude it can send evidence', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes } = project(on, { 'src/e.test.ts': E_TEST })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(notes.at(-1)).toContain('test_evidence')
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

// a jest project, and the summary its coverage run writes
const JEST_PROJECT = { 'package.json': '{ "devDependencies": { "jest": "^29.0.0" } }', 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }
const SUMMARY = JSON.stringify({ total: { lines: { pct: 82.5 }, statements: { pct: 80 }, branches: { pct: 61.2 }, functions: { pct: 75 } } })

test('Run coverage shows only in a project with a runner it knows, and the coverage section with it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  // a project of plugin tests: no jest, vitest, pytest or Go
  project(on, { 'package.json': '{ "name": "a-mod" }', 'tests/a.test.ts': "test('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('"key":"run"')
  expect(drawn).not.toContain('Coverage')
  expect(drawn).toContain('"key":"gradeAll"')
  await ui.unmount()
})

test('in a jest project Run coverage shows, and Clear list is gone', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  project(on, JEST_PROJECT)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"key":"run"')
  expect(drawn).not.toContain('"key":"clear"')
})

test('a finished coverage run tells Claude its figures', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...JEST_PROJECT }
  const { notes, runs } = project(on, files, {
    editor: () => {
      files['coverage/coverage-summary.json'] = SUMMARY
      return { stdout: 'Tests: 1 passed, 1 total', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(runs.map(argv => argv.slice(0, 3).join(' '))).toEqual(['npx jest --coverage'])
  expect(notes).toEqual(['Coverage run (test-watch) finished: lines 82.5% · statements 80% · branches 61.2% · functions 75% (coverage-summary.json).'])
})

test('a coverage run that fails tells Claude how it exited and the end of what it printed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const output = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
  const { notes } = project(on, JEST_PROJECT, { editor: () => ({ stdout: output, stderr: 'FAIL src/a.test.ts', exitCode: 1 }) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(notes).toHaveLength(1)
  const [head, ...tail] = notes[0]!.split('\n')
  expect(head).toBe('Coverage run (test-watch) failed: npx jest --coverage exited with 1. The last 20 lines it printed:')
  expect(tail).toEqual([...Array.from({ length: 19 }, (_, i) => `line ${i + 12}`), 'FAIL src/a.test.ts'])
})

test('the results of Grade all tests, Regrade all and a coverage run ask Claude to respond; a new test\'s note is only added', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...JEST_PROJECT }
  const { asked, logs } = project(on, files, {
    editor: () => {
      files['coverage/coverage-summary.json'] = SUMMARY
      return { stdout: '', exitCode: 0 }
    },
  })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  // written mid-turn, a weak test's note is read in that turn: no prompt of its own
  const shallow = "it('a shallow check', () => { expect(f).toBeDefined() })\n"
  files['src/b.test.ts'] = shallow
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/b.test.ts', content: shallow } as never)
  await clock.advance(10)
  expect(asked).toEqual([])
  // the kit takes no appended row in this build: the mod's debug line says which way a note went
  const added = () => logs.filter(l => l.startsWith('test-watch: note to Claude (not appended: no implementation for session.append): '))
  expect(added()).toEqual([expect.stringMatching(/: New tests graded weak or useless/)])

  for (const key of ['gradeAll', 'regradeAll', 'run']) {
    await ui.press({ key })
    await clock.advance(10)
  }
  expect(asked.map(text => text.split('\n')[0])).toEqual([
    expect.stringMatching(/^Test grading \(test-watch\) finished: /),
    expect.stringMatching(/^Test grading \(test-watch\) finished: /),
    expect.stringMatching(/^Coverage run \(test-watch\) finished: /),
  ])
  // each ends asking for a reply about what it found
  for (const text of asked) expect(text.split('\n').at(-1)).toMatch(/^Respond to this now: /)
  expect(added()).toHaveLength(1)
})
