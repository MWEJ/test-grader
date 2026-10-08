import { fingerprint } from '../hooks/register'
import { TEST_FILE, casesIn } from '../hooks/discovery'
import { runArgv, shown as shownCommand, tailOf } from '../hooks/runner'
import type { RunTarget, Runners } from '../hooks/runner'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// a test's engine and its hook registrar, as the kit hands them to a test body
type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

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
      plugin: 'test-grader',
      surface,
      component: 'Pane',
      requestId: 'test-grader',
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
    plugin: 'test-grader',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'test-grader',
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
const mount = ($: Engine, rows = 60) =>
  $.ui.mount({ plugin: 'test-grader', surface: 'terminal', component: 'Pane', requestId: 'test-grader', props: PANE_PROPS, viewport: { columns: 80, rows } } as never)

// gate: the first grader call waits on it; held: every call waits until it is released
// rule: a verdict from the name and the prompt, in place of the name-only default
type Project = { isGit?: boolean; gate?: () => Promise<void>; expand?: Record<string, string[]>; held?: { calls: number; release: () => void }; rule?: (name: string, prompt: string) => 'good' | 'weak' | 'useless'; editor?: Shell; env?: Record<string, string>; outside?: Record<string, string>; cut?: (reply: string) => string; refuse?: string; room?: { limit: number }; git?: (argv: string[]) => { stdout: string; exitCode?: number } | undefined; reply?: (call: number) => unknown }
// a command's answer: its exit code, or what it printed too
type Shell = (argv: string[]) => number | { stdout?: string; stderr?: string; exitCode?: number }
// env: the variables the mod reads; outside: files by their full path, outside the project
function project(on: On, files: Record<string, string>, { isGit = true, gate, expand = {}, held, rule, editor, env = {}, outside = {}, cut, refuse, room, git, reply }: Project = {}) {
  const prompts: string[] = []
  // every command but git, as run; editor answers it
  const runs: string[][] = []
  // every git command, as run
  const gits: string[][] = []
  mock.env(on, env)
  // the notes for Claude, as the debug log has them: a row a mod appends reaches no test
  // hook (the kit answers it "no implementation"), so the log line is what a test can see
  const notes: string[] = []
  // every debug line, as logged
  const logs: string[] = []
  // each grader call's room for its reply
  const budgets: number[] = []
  // each grader call's model, and its system prompt
  const models: string[] = []
  const systems: string[] = []
  on('ui.log', async (_$, e) => {
    const text = String((e as { text?: unknown }).text)
    logs.push(text)
    if (text.startsWith('test-grader: note to Claude')) notes.push(text.replace(/^[^)]*\): /, ''))
    return { value: undefined } as never
  })
  on('command.register', async () => ({ value: {} }) as never)
  // the tools the mod registers for the session, by name
  const tools: string[] = []
  on('tool.register', async (_$, e) => {
    tools.push((e as { name: string }).name)
    return { value: { tool: `mcp__test-grader__${(e as { name: string }).name}` } } as never
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
    // modified when its text changes, as a file on disk is
    return { value: { mtimeMs: 1_000_000 + Number.parseInt(fingerprint(files[path]!).split('-')[0]!, 16), size: files[path]!.length, isFile: true, isDirectory: false } } as never
  })
  on('process.run', async (_$, e) => {
    const { argv } = e as { argv: string[] }
    if (argv[0] === 'git') gits.push(argv)
    const answered = argv[0] === 'git' ? git?.(argv) : undefined
    if (answered) return { value: { stderr: '', exitCode: 0, ...answered } } as never
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
    models.push(String((e as { model?: unknown }).model))
    systems.push(String((e as { system?: unknown }).system))
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
    // a reply set by the test, by the call's number: an API error, say
    const set = reply?.(prompts.length)
    if (set !== undefined) return { value: set } as never
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
  // files the mod writes land in the project, and are listed in the order written
  const writes: string[] = []
  on('fs.write', async (_$, e) => {
    const { path, text } = e as { path: string; text: string }
    writes.push(path)
    files[path.replace(/^\/proj\//, '')] = text
    return { value: undefined } as never
  })
  // the prompts the mod proposes in the box
  const suggested: string[] = []
  on('prompt.suggest', async (_$, e) => {
    suggested.push((e as { text: string }).text)
    return { isShown: true } as never
  })
  // the plugin's store, kept across sessions, as JSON reads it back
  const store: Record<string, unknown> = {}
  on('store.get', async (_$, e) => ({ value: store[(e as { key: string }).key] }) as never)
  on('store.set', async (_$, e) => {
    const { key, value } = e as { key: string; value: unknown }
    if (room && JSON.stringify(value).length > room.limit) return { deny: 'the store is full' } as never
    store[key] = JSON.parse(JSON.stringify(value))
    return { value: undefined } as never
  })
  return { prompts, notes, runs, logs, budgets, tools, session, asked, store, gits, models, systems, writes, suggested }
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

// the pane's drawing as nodes, every one in drawing order
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const nodesOf = (tree: unknown): Node[] => {
  const nodes: Node[] = []
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    nodes.push(n as Node)
    for (const c of (n as Node).children ?? []) walk(c)
  }
  walk(tree)
  return nodes
}
// whether a node draws a button with this key, at any depth
const holdsKey = (n: Node, key: string): boolean => JSON.stringify(n).includes(`"key":${JSON.stringify(key)}`)
// the buttons drawn, by key, with their labels
const buttonsOf = (tree: unknown): Map<string, string> =>
  new Map(nodesOf(tree).filter(n => n.type === 'Button').map(n => [String(n.props?.key), String(n.props?.label)]))

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
  const { prompts, systems } = project(
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
  expect(systems[0]).toContain('generated in a loop')
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
  expect(tree).toContain('105 tests · 103 good · 2 weak')
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
    'Test grading (test-grader) finished: 4 graded · 1 good · 1 weak · 1 useless · 1 unrated.\n' +
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

  const drawn = await ui.drawn()
  // its verdict column says unrated, and it is listed after the weak one
  expect(Object.entries(await verdictsDrawn(ui))).toEqual([['a shallow check', 'weak'], ['lost ${x}', 'unrated']])
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
  expect(notes).toEqual(['Test grading (test-grader) finished: 1 graded · 1 good · 0 weak · 0 useless.'])
})

test('a failed run sends nothing to Claude, and says in the pane why it failed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes, asked, gits, prompts } = project(on, {}, { isGit: false })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  // the listing a session start makes, done
  await clock.advance(10)
  const before = gits.length
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // the run started: it asked git for the files, and git said this is no repository
  expect(gits.slice(before)).toEqual([['git', 'ls-files', '--cached', '--others', '--exclude-standard']])
  expect(JSON.stringify(await ui.drawn())).toContain('Not a git repository: there is no list of test files to grade.')
  // and nothing reached Claude, as a note or a prompt, nor the grader
  expect(notes).toEqual([])
  expect(asked).toEqual([])
  expect(prompts).toEqual([])
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

// what a weak grade asks of Claude, in its note; and the notes only added to the conversation,
// as the mod's debug line says (a row a mod appends reaches no test hook: the kit refuses it)
const FOLLOW = 'Once you are done writing tests, strengthen each of these, or, where one is better than rated, send your evidence with the test_evidence tool. Each test gets 3 rounds.'
const appended = (logs: string[]): string[] =>
  logs.filter(l => /^test-grader: note to Claude \((appended|not appended: no implementation for session\.append)\): /.test(l)).map(l => l.replace(/^[^)]*\): /, ''))

test('a new test graded weak or useless as it is written is told to Claude in a note of those alone, starting no turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('a shallow check', () => { expect(f).toBeDefined() })\nit('does nothing', () => {})\n"
  const { notes, asked, logs } = project(on, { 'src/a.test.ts': content })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content } as never)
  await clock.advance(10)
  expect(asked).toEqual([])
  expect(notes).toEqual([
    'Tests graded weak or useless (test-grader):\n' +
      '- useless · src/a.test.ts · does nothing — useless because.\n' +
      '- weak · src/a.test.ts · a shallow check — weak because.\n' +
      FOLLOW,
  ])
  expect(appended(logs)).toEqual(notes)
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
  expect(tree).toContain('1 test · 1 good · 0 weak · 0 useless · 1 modified"')
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
async function openShallow($: Engine, on: On, world: Pick<Project, 'editor' | 'env' | 'outside'>) {
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

  const nodes = nodesOf(await ui.drawn())
  const text = (n: unknown): string => [...JSON.stringify(n).matchAll(/"children":\["([^"]*)"\]/g)].map(m => m[1]).join(' ')
  const width = 'useless'.length
  for (const [name, verdict] of [[long, 'good'], ['a shallow check', 'weak'], ['checks nothing', 'useless']] as const) {
    const key = `r:/proj/src/v.test.ts:${name}`
    // the test's line: the innermost row that holds its title's buttons
    const line = nodes.findLast(n => n.type === 'Box' && n.props?.flexDirection === 'row' && holdsKey(n, key))!
    const cells = (line.children ?? []) as Node[]
    const column = cells.find(c => !holdsKey(c, key))!
    const title = cells.find(c => holdsKey(c, key))!
    // the verdict first, in a column as wide as the widest verdict, so every title starts as far in
    expect(cells.indexOf(column)).toBeLessThan(cells.indexOf(title))
    expect(text(column)).toBe(verdict)
    expect(column.props?.width).toBe(width)
    // beside the title's first line, not centred on a title that wraps
    expect(line.props?.alignItems).toBe('flex-start')
    expect(name.startsWith(String(nodesOf(title).find(n => n.type === 'Button')?.props?.label))).toBe(true)
  }

  // the opened row's details start where its title does: the column, then the gap
  const details = nodes.findLast(n => n.type === 'Box' && n.props?.flexDirection === 'column' && holdsKey(n, 'o:/proj/src/v.test.ts:a shallow check'))
  expect(details?.props?.marginLeft).toBe(width + 1)
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
  expect(tree).toContain('3 tests · 2 good · 1 weak')
  expect(tree).toContain('2 graded · 1 remembered')
})

test('a finished Grade all tests saves its grades and each file\'s fingerprint under the project', async ($, on) => {
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
  // by file, each path written once: its fingerprint, and its tests as [name, verdict, summary, reason]
  expect(store['grades:/proj']).toEqual({
    v: 2,
    files: {
      '/proj/src/a.test.ts': { hash: fingerprint(files['src/a.test.ts']!), tests: [['adds', 'g', 'Checks adds.', 'good because.']] },
      '/proj/src/b.test.ts': { hash: fingerprint(files['src/b.test.ts']!), tests: [['a shallow check', 'w', 'Checks a shallow check.', 'weak because.']] },
    },
    finishedAt: 1_000_001,
  })
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
      { file: '/proj/src/a.test.ts', name: 'adds', verdict: 'good', summary: 'Checks adds.', reason: 'good because.' },
      { file: '/proj/src/b.test.ts', name: 'a shallow check', verdict: 'weak', summary: 'Checks a shallow check.', reason: 'saved weak.' },
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
  expect(tree).toContain('saved weak.')
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
  const verdictOf = () => (store['grades:/proj'] as { files: Record<string, { tests: string[][] }> }).files[E_FILE]!.tests.find(t => t[0] === 'a shallow check')?.[1]
  expect(verdictOf()).toBe('w')
  await sendEvidence($, { file: 'src/e.test.ts', test: 'a shallow check', evidence: MUTATION })
  await clock.advance(10)
  expect(verdictOf()).toBe('g')
  // the evidence is kept with it
  expect((store['grades:/proj'] as { files: Record<string, { tests: string[][] }> }).files[E_FILE]!.tests.find(t => t[0] === 'a shallow check')?.[5]).toBe(MUTATION)
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
  expect((store['grades:/proj'] as { files: Record<string, { tests: string[][] }> }).files['/proj/src/a.test.ts']!.tests).toEqual([['adds', 'g', '', 'good because.']])
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
  expect(await verdictsDrawn(ui)).toEqual({ lost: 'good' })
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 1 good · 0 weak · 0 useless')
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
      plugin: 'test-grader', surface, component: 'Pane', requestId: 'test-grader',
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
  expect(logs.some(line => line.startsWith('test-grader: a grader reply was cut off') && line.includes('src/k.test.ts'))).toBe(true)
})

test('a grader call has room in its reply for a looped test\'s every case', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const loop = "for (const name of NAMES) {\n  it(`the lifetime: ${name}`, () => { expect(ttl(name)).toBeDefined() })\n}\n"
  // a grader that writes about 75 tokens a verdict, its reply cut off where its budget ends
  const budgets: number[] = []
  const cut = (reply: string): string => {
    const all = JSON.parse(reply) as unknown[]
    const room = Math.floor(budgets.at(-1)! / 75)
    return room >= all.length ? reply : JSON.stringify(all.slice(0, room)).slice(0, -1)
  }
  const { budgets: given, logs } = project(on, { 'src/l.test.ts': loop }, { cut, expand: { 'the lifetime: ${name}': Array.from({ length: 20 }, (_, i) => `the lifetime: case ${i}`) } })
  // the budget of the call under way, as the cut reads it
  Object.defineProperty(budgets, 'at', { value: (i: number) => given.at(i) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // every one of the loop's twenty cases came back with its verdict, and no reply was cut off
  const verdicts = await verdictsDrawn(ui)
  expect(Object.keys(verdicts)).toHaveLength(20)
  expect(Object.values(verdicts).every(v => v === 'good')).toBe(true)
  expect(logs.some(line => line.startsWith('test-grader: a grader reply was cut off'))).toBe(false)
})

// the session's evidence for a test, sent through the mod's tool; what the tool answers
const EVIDENCE_TOOL = 'mcp__test-grader__test_evidence'
const sendEvidence = async ($: Engine, input: { file: string; test: string; evidence: string }) =>
  String((await $.tool.call({ tool: EVIDENCE_TOOL, ...input } as never)).result)
const MUTATION = 'Removing the default export of f makes this test fail; no other test fails.'
// the grader is swayed by the mutation, when it is sent; else a shallow test stays weak
const swayed = (name: string, prompt: string): 'good' | 'weak' => (name.includes('shallow') && !prompt.includes(MUTATION) ? 'weak' : 'good')

test('evidence the grader accepts turns a weak test good, and the row says it was graded on evidence', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, tools } = project(on, { 'src/e.test.ts': E_TEST }, { rule: swayed })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  expect(tools).toEqual(['test_evidence', 'test_grades', 'test_verify'])
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

  expect(answer).toBe('Still weak: weak because. Strengthen it, or send other evidence (round 1 of 3).')
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

// the session asks for the grades as they stand, through the mod's tool
const GRADES_TOOL = 'mcp__test-grader__test_grades'
const askGrades = async ($: Engine, input: { verdicts?: string[]; path?: string; limit?: number; written?: boolean } = {}) =>
  String((await $.tool.call({ tool: GRADES_TOOL, ...input } as never)).result)
const GRADED = {
  'src/math.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('does nothing', () => { expect(true).toBe(true) })\n",
  'src/deep/more.test.ts': "import { f } from './f'\n\nit('a shallow check', () => { expect(f).toBeDefined() })\nit('another shallow one', () => { expect(f).toBeTruthy() })\n",
}

test('test_grades lists the weak and useless tests, worst first, each at its line with what it checks and why', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, GRADED)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(await askGrades($)).toBe(
    '4 tests: 1 good, 2 weak, 1 useless.\n' +
      'Useless or weak, worst first:\n' +
      '- src/math.test.ts:2 "does nothing": useless\n  Checks: Checks does nothing.\n  Why: useless because.\n' +
      '- src/deep/more.test.ts:3 "a shallow check": weak\n  Checks: Checks a shallow check.\n  Why: weak because.\n' +
      '- src/deep/more.test.ts:4 "another shallow one": weak\n  Checks: Checks another shallow one.\n  Why: weak because.\n' +
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
    '2 tests in src/deep: 0 good, 2 weak, 0 useless.\n' +
      'Useless or weak, worst first:\n' +
      '- src/deep/more.test.ts:3 "a shallow check": weak\n  Checks: Checks a shallow check.\n  Why: weak because.\n' +
      '1 more not listed; raise limit or narrow path to see them.\n' +
      'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.',
  )
  // a file's name is not a folder: src/math.test is no prefix of src/math.test.ts
  expect(await askGrades($, { path: 'src/math.test' })).toBe('test-grader lists no tests in src/math.test.')
  const good = await askGrades($, { verdicts: ['good'], path: '/proj/src/math.test.ts' })
  expect(good).toBe('2 tests in src/math.test.ts: 1 good, 0 weak, 1 useless.\nGood, worst first:\n- src/math.test.ts:1 "adds": good\n  Checks: Checks adds.\n  Why: good because.')
})

test('test_grades before any grading says none is weak or useless, and how to grade the tests', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, GRADED)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(await askGrades($)).toBe(
    '4 tests: 0 good, 0 weak, 0 useless, 4 never graded.\nNone is useless or weak. Grade all tests in the Tests pane grades the ones never graded.',
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
    return line.slice(line.indexOf(': weak') + ': weak'.length)
  }
  expect(await roundOf()).toBe(' (round 1 of 3)')
  // each edit inside its body, its name untouched, is graded again: weak again, the next round
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
  expect(await askGrades($, { path: 'src/deep' })).toContain('"a shallow check": weak (round 1 of 3)')
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
    '2 tests written or edited this session: 0 good, 0 weak, 0 useless, 2 being graded.\nNone is useless or weak.\n2 still being graded: ask again in a moment for their grades.',
  )
  await clock.advance(10)
  expect(await askGrades($, { written: true })).toBe(
    '2 tests written or edited this session: 1 good, 1 weak, 0 useless.\n' +
      'Useless or weak, worst first:\n' +
      '- src/new.test.ts:1 "a new shallow test": weak (round 1 of 3)\n  Checks: Checks a new shallow test.\n  Why: weak because.\n' +
      'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.',
  )
})

// Claude is told ahead of any test it writes that its tests are graded, and how to follow up
test('the system prompt tells Claude how to write tests that grade good, to check test_grades when done, and names the guide of each language the project tests in, readable unasked', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { ...GRADED, 'pkg/a_test.go': 'func TestA(t *testing.T) {}\n' })
  on('tool.check', async () => ({ decision: 'ask' }) as never)
  on('prompt.compose', async () => ({ sections: [{ id: 'base', text: 'You are Claude.', scope: 'shared' }] }) as never)
  const compose = (tools: string[]) =>
    $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools, outputStyle: null, traits: [] } as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const offered = await compose(['Write', GRADES_TOOL, EVIDENCE_TOOL])
  expect(offered.sections.map(x => x.id)).toEqual(['base', 'test-grader:grading'])
  const section = offered.sections[1]!
  expect(section.scope).toBe('session')
  expect(section.text).toContain('call test_grades with written: true')
  expect(section.text).toContain('Strengthen each weak or useless test')
  expect(section.text).toContain('ask which plausible bug in the code would make it fail')
  // the project tests in JS and Go: the guide for each, in that order, and none for the rest
  const guides = section.text.split('the others do not apply to this project):\n')[1]!.split('\n')
  expect(guides.map(g => g.replace(/: \S*\/guides\//, ': guides/'))).toEqual(['- JavaScript and TypeScript: guides/js.md', '- Go: guides/go.md'])
  // each one is there to read, and reading it asks no permission; a file beside the guides does
  const guide = guides[0]!.slice(guides[0]!.indexOf(': ') + 2)
  expect((await $.tool.check({ tool: 'Read', input: { file_path: guide } } as never)).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: guide.replace('guides/js.md', 'guides/../hooks/register.tsx') } } as never)).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '/proj/src/a.test.ts' } } as never)).decision).toBe('ask')

  // a request that does not offer the tool (a subagent's, say) is not told to call it
  const without = await compose(['Write'])
  expect(without.sections.map(x => x.id)).toEqual(['base'])
})

test('the note on weak tests tells Claude it can send evidence', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes } = project(on, { 'src/e.test.ts': E_TEST })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // the hint, word for word, right after the weak and useless it is about
  const lines = notes.at(-1)!.split('\n')
  const lastFlagged = lines.findLastIndex(l => l.startsWith('- weak ') || l.startsWith('- useless '))
  expect(lastFlagged).toBeGreaterThan(-1)
  expect(lines[lastFlagged + 1]).toBe(
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
  const clock = mock.clock(on, { now: 1_000_000 })
  const { runs } = project(on, JEST_PROJECT, { editor: () => 0 })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  const buttons = buttonsOf(await ui.drawn())
  expect(buttons.get('run')).toBe('Run coverage')
  expect([...buttons.values()]).not.toContain('Clear list')

  // the button runs the project's own runner
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(runs.map(argv => argv.slice(0, 3).join(' '))).toEqual(['npx jest --coverage'])
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
  expect(notes).toEqual(['Coverage run (test-grader) finished: lines 82.5% · statements 80% · branches 61.2% · functions 75% (coverage-summary.json).'])
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
  expect(head).toBe('Coverage run (test-grader) failed: npx jest --coverage exited with 1. The last 20 lines it printed:')
  expect(tail).toEqual([...Array.from({ length: 19 }, (_, i) => `line ${i + 12}`), 'FAIL src/a.test.ts'])
})

test('the results of Grade all tests, Regrade all and a coverage run ask Claude to respond; a weak new test is only a note', async ($, on) => {
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

  // a weak test written: its grade is a note, read by Claude, no turn started
  const shallow = "it('a shallow check', () => { expect(f).toBeDefined() })\n"
  files['src/b.test.ts'] = shallow
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/b.test.ts', content: shallow } as never)
  await clock.advance(10)
  expect(asked).toEqual([])
  expect(appended(logs).map(text => text.split('\n')[0])).toEqual(['Tests graded weak or useless (test-grader):'])
  const added = () => appended(logs).slice(1)

  for (const key of ['gradeAll', 'regradeAll', 'run']) {
    await ui.press({ key })
    await clock.advance(10)
  }
  expect(asked.map(text => text.split('\n')[0])).toEqual([
    expect.stringMatching(/^Test grading \(test-grader\) finished: /),
    expect.stringMatching(/^Test grading \(test-grader\) finished: /),
    expect.stringMatching(/^Coverage run \(test-grader\) finished: /),
  ])
  // each ends asking for a reply about what it found
  for (const text of asked) expect(text.split('\n').at(-1)).toMatch(/^Respond to this now: /)
  expect(added()).toEqual([])
})

// Test discovery reads code, not text: a test written inside a string or a comment is a
// fixture or a note, not one of the file's tests
const ASKED = (prompts: string[]): string[] => prompts.map(p => JSON.parse(p.match(/test cases: (\[.*\])/)![1]!) as string[]).flat().sort()

test('a test written inside a string or a comment is not one of the file\'s tests', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const js = [
    "const FIXTURE = `",
    "it('in a template', () => { expect(true).toBe(true) })",
    "test(`nested ${`it('in a hole', () => {})`} still text`, () => {})",
    "`",
    "const GO = `func TestInGo(t *testing.T) {}`",
    "// it('in a line comment', () => {})",
    "/*",
    "it('in a block comment', () => {})",
    "*/",
    "const re = /it\\('in a regex'/",
    "it('real one', () => { expect(add(1, 2)).toBe(3) })",
    "it(`real after ${FIXTURE.length} chars`, () => { expect(1).toBe(1) })",
    "",
  ].join('\n')
  const go = "package q\n\nconst src = `\nfunc TestInRaw(t *testing.T) {}\n`\n\n// func TestInComment(t *testing.T) {}\n\nfunc TestRealGo(t *testing.T) {\n\tif add(1, 2) != 3 {\n\t\tt.Fatal(\"func TestInString(t *testing.T) {\")\n\t}\n}\n"
  const py = 'DOC = """\ndef test_in_docstring():\n    pass\n"""\n\n# def test_in_comment():\n\ndef test_real_py():\n    assert add(1, 2) == 3\n'
  const swift = 'final class MathTests: XCTestCase {\n  let src = """\n  func testInMultiline() {}\n  """\n  // func testInComment() {}\n  func testRealSwift() {\n    XCTAssertEqual(add(1, 2), 3, "func testInString() {")\n  }\n}\n'
  const { prompts } = project(on, { 'src/a.test.ts': js, 'q/a_test.go': go, 'test_a.py': py, 'Tests/MathTests.swift': swift })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(ASKED(prompts)).toEqual(['TestRealGo', 'real after ${FIXTURE.length} chars', 'real one', 'testRealSwift', 'test_real_py'])
})

test('a fixture string an edit adds holding a test is not tracked as a new test', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const added = "const CONTENT = `\nit('fixture case', () => {})\n`\n"
  const after = `${added}it('real one', () => { expect(add(1, 2)).toBe(3) })\n`
  const { prompts } = project(on, { 'src/a.test.ts': after })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: 'x', new_string: added } as never)
  await clock.advance(10)

  expect(prompts).toHaveLength(0)
  expect(JSON.stringify(await (await mount($)).drawn())).not.toContain('fixture case')
})

// A long file reaches the grader as an excerpt that leaves nothing of the cases under review
// out, and brings the helpers they use from wherever in the file they are declared
test('in a long file, a long case reaches the grader whole, with the helpers it uses from between other tests', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const old = (from: number) => Array.from({ length: 200 }, (_, i) => `it('old case ${from + i}', () => {\n  expect(add(${i}, 1)).toBe(${i + 1})\n})\n`).join('')
  const helper = "\nconst MOCK_HOME = '/home/someone'\nfunction mockProject(dir: string) {\n  const off = listen(() => {\n    return dir\n  })\n  return { dir, home: MOCK_HOME, off }\n}\n"
  const unused = "\nconst NEVER_USED = 'left out'\n"
  const steps = Array.from({ length: 80 }, (_, i) => `  expect(step(p, ${i})).toBe(${i * 2})\n`).join('')
  const added = `it('a long case', () => {\n  const p = mockProject('/proj')\n${steps}  expect(p.home).toBe('/home/someone') // the last line\n})\n`
  const content = old(0) + helper + old(200) + unused + old(400) + added
  expect(added.length).toBeGreaterThan(2_000)
  const { prompts } = project(on, { 'src/a.test.ts': content })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: 'x', new_string: added } as never)
  await clock.advance(10)

  expect(prompts).toHaveLength(1)
  const prompt = prompts[0]!
  expect(prompt).toContain("expect(p.home).toBe('/home/someone') // the last line")
  // the helper the case calls, and the constant the helper uses in turn
  expect(prompt).toContain('function mockProject(dir: string) {')
  expect(prompt).toContain("const MOCK_HOME = '/home/someone'")
  expect(prompt).not.toContain('NEVER_USED')
  expect(prompt).not.toContain('old case 450')
  expect(prompt).toContain('above is an excerpt')
})

test('a file short enough goes to the grader whole, with no word of an excerpt', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('adds', () => { expect(add(1, 2)).toBe(3) })\n"
  const { prompts } = project(on, { 'src/a.test.ts': content })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content } as never)
  await clock.advance(10)

  expect(prompts[0]).toContain(content.trimEnd())
  expect(prompts[0]).not.toContain('excerpt')
})

// A reload of the mod drops the grading under way, and the host keeps its marks: the run left
// running, its rows reviewing. Here the host holds them as the cut-off load left them: each
// read answers with them until the mod first writes the value
function seedState(on: On, seeds: Record<string, unknown>) {
  const written = new Set<string>()
  on('state.set', async (_$, e, next) => {
    written.add((e as { key: string }).key)
    return next(e)
  })
  on('state.get', async (_$, e, next) => {
    const { plugin, key } = e as { plugin: string; key: string }
    const held = await next(e)
    if (plugin !== 'test-grader' || !(key in seeds) || written.has(key)) return held
    // a hook's answer comes wrapped: { value: { value, version } }
    return { value: { value: seeds[key], version: (held as { value: { version: number } }).value.version } } as never
  })
}

test('a Grade all run a reload cut off is started again at the session start, and its rows stop reviewing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('adds', () => { expect(add(1, 2)).toBe(3) })\n"
  const { prompts } = project(on, { 'src/a.test.ts': content })
  seedState(on, {
    existing: { state: 'running', done: 0, total: 1, isFresh: true, hashes: { '/proj/src/a.test.ts': 'old' }, results: [{ file: '/proj/src/a.test.ts', name: 'adds', verdict: 'weak', isPending: true }] },
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
    existing: { state: 'running', done: 0, total: 1, isFresh: true, hashes: { '/proj/src/a.test.ts': hash }, results: [{ file: '/proj/src/a.test.ts', name: 'adds', verdict: 'weak', isPending: true }] },
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
    existing: { state: 'idle', done: 1, total: 1, results: [{ file: '/proj/src/a.test.ts', name: 'adds', verdict: 'weak', isPending: true }] },
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

// A weak or useless grade on a test Claude wrote or edited is told to Claude in a note, never a
// prompt; each new grade comes the same way, until the test is good or has had three rounds
// a turn of Claude's, its start and end as the engine raises them
const turns = (on: On) => {
  on('turn.start', async (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', async () => ({ text: 'done' }) as never)
}
const turnStart = ($: Engine, turnId: string) => $.turn.start({ text: '', turnId } as never)
const turnEnd = ($: Engine, turnId: string) => $.turn.complete({ turnId, reason: 'answer', text: 'done' } as never)

test('weak tests graded together, over several files, reach Claude as one note while its turn still runs', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const a = "it('a shallow check', () => { expect(f).toBeDefined() })\nit('does nothing', () => {})\n"
  const b = "it('another shallow one', () => { expect(g).toBeDefined() })\n"
  const { asked, logs } = project(on, { 'src/a.test.ts': a, 'src/b.test.ts': b })
  turns(on)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  await turnStart($, 't1')
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: a } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/b.test.ts', content: b } as never)
  await clock.advance(10)

  // the turn has not ended: the note is there for Claude to read in it
  expect(asked).toEqual([])
  expect(appended(logs)).toHaveLength(1)
  const lines = appended(logs)[0]!.split('\n')
  expect(lines.filter(l => l.startsWith('- '))).toEqual([
    '- useless · src/a.test.ts · does nothing — useless because.',
    '- weak · src/a.test.ts · a shallow check — weak because.',
    '- weak · src/b.test.ts · another shallow one — weak because.',
  ])
  expect(lines.at(-1)).toBe(FOLLOW)
  await turnEnd($, 't1')
  expect(appended(logs)).toHaveLength(1)
})

test('a weak test edited and graded weak again comes back in a note as the next round; graded good, it is told as accepted', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" }
  // weak until its body asserts a value
  const { asked, notes } = project(on, files, { rule: (_name, prompt) => (prompt.includes('toBe(42)') ? 'good' : 'weak') })
  const { length } = asked
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const edit = async (body: string) => {
    const before = files['src/a.test.ts']!
    files['src/a.test.ts'] = `it('a shallow check', () => { ${body} })\n`
    await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: before, new_string: files['src/a.test.ts'] } as never)
    await clock.advance(10)
  }

  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: files['src/a.test.ts'] } as never)
  await clock.advance(10)
  expect(notes).toHaveLength(1)

  await edit('expect(f()).toBeTruthy()')
  expect(notes).toHaveLength(2)
  expect(notes[1]).toContain('- weak · src/a.test.ts · a shallow check')
  expect(notes[1]!.split('\n').at(-1)).toBe(FOLLOW)

  await edit('expect(f()).toBe(42)')
  expect(notes.at(-1)).toBe('Now graded good (test-grader):\n- good · src/a.test.ts · a shallow check')
  expect(asked).toHaveLength(length)
})

test('a test still weak after three rounds is told once, asking Claude to tell the person, and then no more', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" }
  const { asked, notes } = project(on, files)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: files['src/a.test.ts'] } as never)
  await clock.advance(10)
  for (let i = 0; i < 4; i++) {
    const before = files['src/a.test.ts']!
    files['src/a.test.ts'] = `it('a shallow check', () => { expect(f${i}).toBeDefined() })\n`
    await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: before, new_string: files['src/a.test.ts'] } as never)
    await clock.advance(10)
  }

  // rounds one to three ask for a fix, the fourth weak grade asks Claude to tell the person, the fifth nothing
  expect(notes.map(text => text.split('\n').at(-1))).toEqual([FOLLOW, FOLLOW, FOLLOW, 'Tell the person which of these are still weak or useless and why.'])
  expect(notes[3]).toContain('Still weak or useless after 3 rounds')
  expect(asked).toEqual([])
})

test('a test Grade all listed weak, edited by Claude, has its new grade told in a note too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" }
  const { asked, logs } = project(on, files)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(asked).toHaveLength(1)

  const before = files['src/a.test.ts']!
  files['src/a.test.ts'] = "it('a shallow check', () => { expect(f()).toBeTruthy() })\n"
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: before, new_string: files['src/a.test.ts'] } as never)
  await clock.advance(10)

  expect(asked).toHaveLength(1)
  expect(appended(logs)).toHaveLength(1)
  expect(appended(logs)[0]).toContain('- weak · src/a.test.ts · a shallow check — weak because.')
  expect(appended(logs)[0]!.split('\n').at(-1)).toBe(FOLLOW)
})

// The grader model is a setting: haiku unless the person picks another
const gradeOnce = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { models } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  return models
}

test('with no grader model set, tests are graded by haiku', async ($, on) => {
  expect(await gradeOnce($, on)).toEqual(['haiku'])
})

test('the grader model setting picks the model that grades', { options: { graderModel: 'opus' } }, async ($, on) => {
  expect(await gradeOnce($, on)).toEqual(['opus'])
})

// a Haiku older than 5.5, however it is named, grades as Haiku 5.5; any other model as set
for (const [set, used] of [
  ['claude-haiku-4-5', 'claude-haiku-5-5'],
  ['claude-haiku-4-5-20251001', 'claude-haiku-5-5'],
  ['claude-3-5-haiku-20241022', 'claude-haiku-5-5'],
  ['us.anthropic.claude-3-haiku-20240307-v1:0', 'claude-haiku-5-5'],
  ['claude-haiku-5-5', 'claude-haiku-5-5'],
  ['claude-haiku-6', 'claude-haiku-6'],
  ['claude-sonnet-4-5', 'claude-sonnet-4-5'],
  ['  ', 'haiku'],
] as const) {
  test(`a grader model set to ${JSON.stringify(set)} grades with ${used}`, { options: { graderModel: set } }, async ($, on) => {
    expect(await gradeOnce($, on)).toEqual([used])
  })
}

test('a second-look model, when set, grades again what the first grade left weak; the first grade stays with the grader model', { options: { graderEscalate: 'claude-haiku-4-5' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" }
  const { models } = project(on, files)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: files['src/a.test.ts'] } as never)
  await clock.advance(10)
  files['src/a.test.ts'] = "it('a shallow check', () => { expect(f).toBeTruthy() })\n"
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: 'toBeDefined', new_string: 'toBeTruthy' } as never)
  await clock.advance(10)
  // the second look is a Haiku too old to grade: raised to 5.5 as the grader model is
  expect(models).toEqual(['haiku', 'claude-haiku-5-5'])
})

// A project with tests in folders and subfolders: the pane draws its folders as a tree
const TREE = {
  'internal/domain/user.test.ts': "it('does nothing', () => {})\n",
  'internal/gateways/api/api.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\nit('lists clusters', () => { expect(list()).toEqual([1]) })\n",
  'internal/gateways/api/query.test.ts': "it('parses a query', () => { expect(parse('a=1')).toEqual({ a: '1' }) })\n",
  'cmd/exporter/exporter.test.ts': "it('another shallow one', () => { expect(g).toBeDefined() })\n",
  'root.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
}
// the group rows drawn, folders and files, in drawing order, by key with their labels
const groupRows = async (ui: { drawn: () => Promise<unknown> }): Promise<[string, string][]> =>
  [...buttonsOf(await ui.drawn()).entries()].filter(([key]) => /^(d|f|s):/.test(key))

test('tests in folders are grouped by folder, the worst folder first, each with the counts of all beneath it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, TREE)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // the top level: internal (a useless and a weak beneath it), then cmd/exporter, merged as it
  // holds nothing but one folder, then the file at the root; several, so each starts closed
  expect(await groupRows(ui)).toEqual([
    ['d:internal', '▸ internal/'],
    ['d:cmd/exporter', '▸ cmd/exporter/'],
    ['f:/proj/root.test.ts', '▸ root.test.ts'],
  ])
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"4 · 2 good · 1 weak · 1 useless"')

  // opened, a folder lists its own folders and files, named from it, worst first
  await ui.press({ key: 'd:internal' })
  expect(await groupRows(ui)).toEqual([
    ['d:internal', '▾ internal/'],
    ['d:internal/domain', '▸ domain/'],
    ['d:internal/gateways/api', '▸ gateways/api/'],
    ['d:cmd/exporter', '▸ cmd/exporter/'],
    ['f:/proj/root.test.ts', '▸ root.test.ts'],
  ])
  await ui.press({ key: 'd:internal/gateways/api' })
  const rows = await groupRows(ui)
  expect(rows.slice(2, 5)).toEqual([
    ['d:internal/gateways/api', '▾ gateways/api/'],
    ['f:/proj/internal/gateways/api/api.test.ts', '▸ api.test.ts'],
    ['f:/proj/internal/gateways/api/query.test.ts', '▸ query.test.ts'],
  ])

  // pressed again, it closes, and what is beneath it goes
  await ui.press({ key: 'd:internal' })
  expect((await groupRows(ui)).map(([key]) => key)).toEqual(['d:internal', 'd:cmd/exporter', 'f:/proj/root.test.ts'])
})

test('a folder alone at its level draws no row of its own: its path leads the names beneath', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, {
    'internal/gateways/api/api.test.ts': TREE['internal/gateways/api/api.test.ts'],
    'internal/gateways/api/query.test.ts': TREE['internal/gateways/api/query.test.ts'],
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(await groupRows(ui)).toEqual([
    ['f:/proj/internal/gateways/api/api.test.ts', '▸ internal/gateways/api/api.test.ts'],
    ['f:/proj/internal/gateways/api/query.test.ts', '▸ internal/gateways/api/query.test.ts'],
  ])
})

test('a folder pressed open stays open when the pane draws again after a grading', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, TREE)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'd:internal' })
  await ui.press({ key: 'regradeAll' })
  await clock.advance(10)

  expect((await groupRows(ui)).map(([key, label]) => `${key} ${label}`)).toContain('d:internal ▾ internal/')
})

// How many grader calls Grade all tests has in flight at once: the graderWorkers setting
const inFlight = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // 25 batches of 10: more than any setting lets run at once
  const many = Array.from({ length: 250 }, (_, i) => `it('case ${i}', () => { expect(f(${i})).toBe(${i}) })\n`).join('')
  const held = { calls: 0, release: () => {} }
  project(on, { 'a.test.ts': many }, { held })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  return held.calls
}

test('the grader workers setting sets how many grader calls run at once', { options: { graderWorkers: 3 } }, async ($, on) => {
  expect(await inFlight($, on)).toBe(3)
})

test('a grader workers setting below 1 runs one call at a time', { options: { graderWorkers: 0 } }, async ($, on) => {
  expect(await inFlight($, on)).toBe(1)
})

test('a grader workers setting above 20 runs 20 at a time', { options: { graderWorkers: 50 } }, async ($, on) => {
  expect(await inFlight($, on)).toBe(20)
})

// Discovery, language by language: the cases each declares in code, two of one name told apart
// by the groups around them; none that sits in a string or a comment
const DISCOVERED: [string, string, string[]][] = [
  [
    'src/a.test.ts',
    "describe('one', () => {\n  it('works', () => {})\n  it.each([[1, f(2)]])('row %s', () => {})\n})\ndescribe('two', () => {\n  it('works', () => {})\n  test.concurrent.each`a`('tmpl', () => {})\n})\nit('works', () => {})\nDeno.test(\"deno one\", () => {})\ntest.describe('pw', () => {})\n",
    ['one › works', 'row %s', 'two › works', 'tmpl', 'works', 'deno one'],
  ],
  ['tests/test_x.py', 'class TestA:\n    def test_a(self):\n        pass\n\nclass TestB:\n    def test_a(self):\n        pass\n\ndef test_free():\n    s = "def test_fake"\n', ['TestA › test_a', 'TestB › test_a', 'test_free']],
  [
    'spec/x_spec.rb',
    "RSpec.describe Foo do\n  context 'when a' do\n    it 'works' do\n    end\n  end\n  context 'when b' do\n    it \"works\" do\n    end\n  end\n  specify('x') { }\nend\nclass FooTest < Minitest::Test\n  def test_one\n  end\n  test \"rails way\" do\n  end\nend\n",
    ['Foo › when a › works', 'Foo › when b › works', 'x', 'test_one', 'rails way'],
  ],
  ['src/lib/tests.rs', '#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {}\n    #[tokio::test]\n    #[ignore]\n    async fn later() {}\n    #[rstest]\n    #[case(1)]\n    fn param(#[case] n: u32) {}\n}\nconst S: &str = "#[test]\\nfn fake() {}";\n', ['adds', 'later', 'param']],
  [
    'src/test/java/FooTest.java',
    'class FooTest {\n  @Test\n  void adds() {}\n  @ParameterizedTest\n  @ValueSource(ints = {1, 2})\n  public void many(int n) {}\n  @Nested\n  class Inner {\n    @Test void adds() {}\n  }\n}\n',
    ['FooTest › adds', 'many', 'FooTest › Inner › adds'],
  ],
  ['FooTest.kt', 'class FooTest {\n  @Test\n  fun `adds two numbers`() {}\n  @Test suspend fun later() {}\n}\n', ['adds two numbers', 'later']],
  ['FooTests.cs', 'public class FooTests {\n  [Fact]\n  public void Adds() {}\n  [Theory]\n  [InlineData(1)]\n  public async Task Many(int n) {}\n  [Test, Category("x")]\n  public void Nunit() {}\n}\n', ['Adds', 'Many', 'Nunit']],
  [
    'tests/FooTest.php',
    "<?php\nclass FooTest extends TestCase {\n  public function testAdds(): void {}\n  /** @test */\n  public function it_works() {}\n  #[Test]\n  public function attributed() {}\n  # public function testHidden() {}\n}\nit('pest case', function () {});\n",
    ['testAdds', 'it_works', 'attributed', 'pest case'],
  ],
  ['Tests/FooTests.swift', 'final class FooTests: XCTestCase {\n  func testAdds() {}\n}\n@Suite struct Bar {\n  @Test("shown") func baz() {}\n  @Test func qux() async throws {}\n}\n', ['testAdds', 'baz', 'qux']],
  ['pkg/a_test.go', 'func TestA(t *testing.T) {}\nfunc testHelper(t *testing.T) {}\nfunc (s *Suite) TestB() {}\n', ['TestA', 'TestB']],
  ['src/same.test.ts', "it('twin', () => {})\nit('twin', () => {})\n", ['twin', 'twin (2)']],
]
for (const [file, text, names] of DISCOVERED) {
  test(`${file} is a test file, and its cases are ${names.join(', ')}`, async () => {
    expect(TEST_FILE.test(file)).toBe(true)
    expect(casesIn(text, file).filter(c => !c.isRunner).map(c => c.name)).toEqual(names)
  })
}

test('source files of each language are not test files', async () => {
  for (const file of ['src/add.ts', 'pkg/add.go', 'app/models/user.rb', 'src/lib.rs', 'src/main/java/Foo.java', 'Foo.cs', 'src/Foo.php', 'Sources/Foo.swift', 'add.py']) {
    expect([file, TEST_FILE.test(file)]).toEqual([file, false])
  }
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
  expect(tree).toContain('1 test · 1 good')
  expect(tree).toContain('1 file could not be read, and was passed over.')
})

test('a grader call the API answers overloaded is tried again after a wait, and one it refuses is not', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const failing = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} }
  const refused = { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request', usage: {} }
  const files: Record<string, string> = { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }
  const answers: unknown[] = [failing, undefined, refused]
  const { prompts, logs } = project(on, files, { reply: n => answers[n - 1] })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  // the first call failed; the retry waits two to three seconds
  expect(prompts).toHaveLength(1)
  await clock.advance(3_000)
  expect(prompts).toHaveLength(2)
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 1 good')

  await ui.press({ key: 'regradeAll' })
  await clock.advance(10_000)
  expect(prompts).toHaveLength(3)
  expect(JSON.stringify(await ui.drawn())).toContain('1 unrated')
  expect(logs).toContain('test-grader: the grader gave no answer for /proj/src/a.test.ts (api-error 400 invalid_request)')
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
  expect(tree).toContain('3 tests · 0 good · 0 weak · 0 useless · 3 ungraded')
  expect(tree).not.toContain('reviewing')
  expect(prompts).toHaveLength(3)
  expect(asked).toEqual([])
  // the next run grades them all
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  held.release()
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('3 tests · 3 good')
})

test('the pane shows what the last run cost, in tokens in, from the cache and out', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const answer = { isAnswered: true, usage: { input_tokens: 400, cache_read_input_tokens: 1_600, output_tokens: 300 }, text: JSON.stringify([{ name: 'adds', summary: 's', verdict: 'good', reason: 'r' }]) }
  project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { reply: () => answer })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('Last run: 1 graded · 0 remembered · 2k in (2k cached) / 300 out')
})

// the branch's changes, as git answers: main is where it left, a.test.ts changed on it, b.test.ts
// changed and not committed, c.test.ts new; d.test.ts unchanged
const BRANCH: Record<string, string> = {
  'src/a.test.ts': "it('a', () => { expect(f(1)).toBe(1) })\n",
  'src/b.test.ts': "it('b', () => { expect(f(2)).toBe(2) })\n",
  'src/c.test.ts': "it('c shallow', () => { expect(f).toBeDefined() })\n",
  'src/d.test.ts': "it('d', () => { expect(f(4)).toBe(4) })\n",
}
const branchGit = (argv: string[]) => {
  const args = argv.slice(1).join(' ')
  if (args === 'merge-base HEAD origin/HEAD') return { stdout: '', exitCode: 1 }
  if (args === 'merge-base HEAD main') return { stdout: 'abc123\n' }
  if (args === 'diff --name-only --diff-filter=d main...') return { stdout: 'src/a.test.ts\nsrc/lib.ts\n' }
  if (args === 'diff --name-only --diff-filter=d HEAD') return { stdout: 'src/b.test.ts\n' }
  if (args === 'ls-files --others --exclude-standard') return { stdout: 'src/c.test.ts\n' }
  return undefined
}

test('/test-grader diff grades only the test files changed on the branch, and leaves the rest of the grades be', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, asked } = project(on, BRANCH, { git: branchGit })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  prompts.length = 0
  asked.length = 0

  const ran = await $.command.run({ command: 'test-grader', args: 'diff' } as never)
  expect((ran as { text: string }).text).toBe('Grading the 3 test files changed against main.')
  await clock.advance(10)
  expect(ASKED(prompts)).toEqual(['a', 'b', 'c shallow'])
  expect(asked[0]!.split('\n')[0]).toBe('Test grading (test-grader) finished for the files changed on this branch: 3 graded · 2 good · 1 weak · 0 useless.')
  // d keeps its grade
  expect(JSON.stringify(await ui.drawn())).toContain('4 tests · 3 good · 1 weak')
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

test('/test-grader report writes the grades as Markdown, worst first with each test at its line, and as JSON', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GRADED }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const ran = await $.command.run({ command: 'test-grader', args: 'report' } as never)
  expect((ran as { text: string }).text).toBe('Wrote test-grader-report.md and test-grader-report.json: 4 tests, 2 weak, 1 useless.')
  const md = files['test-grader-report.md']!
  expect(md.split('\n').slice(0, 3)).toEqual(['# Test grades', '', `4 tests: 1 useless, 2 weak, 1 good. Graded by test-grader, ${new Date(1_000_010).toISOString()}.`])
  expect(md).toContain('## Useless (1)\n\n- `src/math.test.ts:2` does nothing: useless because.\n\n## Weak (2)\n\n- `src/deep/more.test.ts:3` a shallow check: weak because.\n- `src/deep/more.test.ts:4` another shallow one: weak because.')
  const json = JSON.parse(files['test-grader-report.json']!) as { counts: Record<string, number>; tests: { file: string; line: number; name: string; state: string }[] }
  expect(json.counts).toEqual({ useless: 1, weak: 2, unrated: 0, reviewing: 0, ungraded: 0, good: 1 })
  expect(json.tests[0]).toEqual({ file: 'src/math.test.ts', line: 2, name: 'does nothing', state: 'useless', summary: 'Checks does nothing.', reason: 'useless because.', onEvidence: false })
})

// a jest project whose tests fail when add subtracts
const ADDING: Record<string, string> = {
  'package.json': '{ "devDependencies": { "jest": "^29.0.0" } }',
  'src/add.ts': 'export const add = (a: number, b: number) => a + b\n',
  'src/a.test.ts': "import { add } from './add'\n\nit('a shallow check', () => {\n  expect(add(1, 2)).toBeDefined()\n})\n",
}
const jest = (files: Record<string, string>): Shell => argv =>
  argv[1] === 'jest' ? (files['src/add.ts']!.includes('a - b') ? { stdout: 'FAIL src/a.test.ts\n  ● a shallow check\n    expected 3', exitCode: 1 } : { stdout: 'PASS src/a.test.ts', exitCode: 0 }) : 1

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
  const { writes, prompts } = project(on, files, { editor: jest(files), rule: (_n, prompt) => (prompt.includes('Measured by test-grader') ? 'good' : 'weak') })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const verify = (input: Record<string, string>) => $.tool.call({ tool: 'mcp__test-grader__test_verify', ...input } as never).then(r => String((r as { result: unknown }).result))

  const answer = await verify({ file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'a + b', replace: 'a - b' })
  expect(answer).toMatch(/^Measured: the test passes unchanged and fails with the mutation\. Now good: /)
  expect(files['src/add.ts']).toBe(ADDING['src/add.ts'])
  expect(writes).toEqual(['/proj/src/add.ts', '/proj/src/add.ts'])
  expect(prompts.at(-1)).toContain('With \\"a + b\\" replaced by \\"a - b\\" in src/add.ts, the same command failed.')
  expect(prompts.at(-1)).toContain('expected 3')

  // a mutation it does not catch: nothing is regraded
  const missed = await verify({ file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: '(a: number', replace: '(a: any' })
  expect(missed).toBe('The test still passes with "(a: number" replaced by "(a: any" in src/add.ts: it does not catch that change. The file is back as it was; nothing was regraded.')
  expect(files['src/add.ts']).toBe(ADDING['src/add.ts'])
  // nor is a test file mutated, nor text that is not found exactly once
  expect(await verify({ file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/a.test.ts', find: 'add', replace: 'sub' })).toBe('src/a.test.ts is a test file: mutate the code under test. Nothing was run.')
  expect(await verify({ file: 'src/a.test.ts', test: 'a shallow check', mutate: 'src/add.ts', find: 'number', replace: 'any' })).toBe('The text to find is in src/add.ts 2 times, not once: give a piece found exactly once. Nothing was run.')
  expect(writes).toHaveLength(4)
})

test('the grader reads the code under test the test file imports, and the project rules in .test-grader.md', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...ADDING, '.test-grader.md': 'Snapshots are fine here.' }
  const { prompts, systems } = project(on, files)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: files['src/a.test.ts'] } as never)
  await clock.advance(10)
  expect(prompts[0]).toContain('The code under test, as the test file reaches it:\n--- src/add.ts ---\n```\nexport const add = (a: number, b: number) => a + b\n')
  expect(systems[0]).toContain("The project's own rules for its tests (.test-grader.md):\nSnapshots are fine here.")
})

test('folder rows show their line coverage, and a coverage run names the least covered folders', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const lcov = 'SF:src/a/x.ts\nLF:100\nLH:90\nend_of_record\nSF:src/b/y.ts\nLF:50\nLH:10\nend_of_record\n'
  const files: Record<string, string> = {
    'package.json': '{ "devDependencies": { "jest": "^29.0.0" } }',
    'src/a/x.test.ts': "it('x', () => { expect(x()).toBe(1) })\n",
    'src/b/y.test.ts': "it('y', () => { expect(y()).toBe(1) })\n",
  }
  const { asked } = project(on, files, { editor: argv => (argv[1] === 'jest' ? ((files['coverage/lcov.info'] = lcov), 0) : 1) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"90% lines"')
  expect(tree).toContain('"20% lines"')
  expect(asked[0]).toContain('Least covered folders (lines): src/b/ 20%, src/ 67%.')
})

test('after a turn that leaves weak tests it wrote, the prompt box offers to strengthen them, once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { suggested } = project(on, { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" })
  turns(on)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await turnStart($, 't1')
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: "it('a shallow check', () => { expect(f).toBeDefined() })\n" } as never)
  await clock.advance(10)
  await turnEnd($, 't1')
  await turnStart($, 't2')
  await turnEnd($, 't2')
  expect(suggested).toEqual(['Strengthen the weak test you wrote this session (test_grades lists them)'])
})

test('an edit that only removes lines inside a test regrades that test, and only it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('first', () => { expect(f(1)).toBe(1) })\n\nit('a shallow check', () => {\n  expect(f).toBeDefined()\n  expect(g).toBeDefined()\n})\n" }
  const { prompts } = project(on, files)
  // the edit, as the tool makes it: the file loses the line
  on('tool.call', async (_$, e) => {
    const { old_string, new_string } = e as { old_string?: string; new_string?: string }
    if (old_string !== undefined) files['src/a.test.ts'] = files['src/a.test.ts']!.replace(old_string, new_string ?? '')
    return { result: {}, text: 'ok', isError: false, isReadOnly: false } as never
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: '  expect(g).toBeDefined()\n', new_string: '' } as never)
  await clock.advance(10)
  expect(files['src/a.test.ts']).not.toContain('expect(g)')
  expect(ASKED(prompts.slice(1))).toEqual(['a shallow check'])
})

test('more than 60 tests written in a session are all listed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = Array.from({ length: 70 }, (_, i) => `it('case ${i}', () => { expect(f(${i})).toBe(${i}) })\n`).join('')
  project(on, { 'src/many.test.ts': content })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/many.test.ts', content } as never)
  await clock.advance(10)
  expect(JSON.stringify(await (await mount($)).drawn())).toContain('70 tests · 70 good · 0 weak · 0 useless · 70 new')
})

test('a test that was there, edited this session, is graded again even if it was good, and marked modified; a new one is new, not modified', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n" }
  const { prompts } = project(on, files, { rule: (name, prompt) => (name === 'adds' && prompt.includes('toBeDefined') ? 'weak' : 'good') })
  on('tool.call', async (_$, e) => {
    const { old_string, new_string } = e as { old_string?: string; new_string?: string }
    if (old_string !== undefined) files['src/a.test.ts'] = files['src/a.test.ts']!.replace(old_string, new_string ?? '')
    return { result: {}, text: 'ok', isError: false, isReadOnly: false } as never
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  prompts.length = 0

  // a good test's body changed: it is graded again, and its new grade shows
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: 'expect(add(1, 2)).toBe(3)', new_string: 'expect(add(1, 2)).toBeDefined()' } as never)
  await clock.advance(10)
  expect(ASKED(prompts)).toEqual(['adds'])
  // and a test added after it
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: "it('subtracts'", new_string: "it('multiplies', () => { expect(mul(2, 3)).toBe(6) })\nit('subtracts'" } as never)
  await clock.advance(10)

  await ui.press({ key: 'r:/proj/src/a.test.ts:adds' })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('3 tests · 2 good · 1 weak · 0 useless · 1 new · 1 modified')
  // the badges sit on their rows: adds modified, multiplies new, subtracts neither
  const rowOf = (name: string): string => tree.slice(tree.indexOf(`"key":"row-r:/proj/src/a.test.ts:${name}"`)).split('"key":"row-r:')[1]!
  expect(rowOf('adds')).toContain('"modified"')
  expect(rowOf('adds')).not.toContain('"new"')
  expect(rowOf('multiplies')).toContain('"new"')
  expect(rowOf('multiplies')).not.toContain('"modified"')
  expect(rowOf('subtracts')).not.toMatch(/"(new|modified)"/)
  // test_grades counts both as the session's own
  expect(await askGrades($, { written: true, verdicts: ['weak', 'good'] })).toMatch(/^2 tests written or edited this session: 1 good, 1 weak, 0 useless\./)
})

// The command that runs one test, by its language and the project's runner
const RUNS: [string, RunTarget, Runners, string[] | null][] = [
  ['vitest', { rel: 'src/a.test.ts', kind: 'js', plain: 'adds (1+1)', groups: ['math'], line: 3 }, { js: 'vitest' }, ['npx', 'vitest', 'run', 'src/a.test.ts', '-t', '^math adds \\(1\\+1\\)$']],
  ['playwright', { rel: 'e2e/a.spec.ts', kind: 'js', plain: 'logs in', groups: [], line: 7 }, { js: 'playwright' }, ['npx', 'playwright', 'test', 'e2e/a.spec.ts:7']],
  ['no JS runner', { rel: 'src/a.test.ts', kind: 'js', plain: 'x', groups: [], line: 1 }, {}, null],
  ['pytest in a class', { rel: 'tests/test_a.py', kind: 'py', plain: 'test_a', groups: ['TestA'], line: 2 }, {}, ['python3', '-m', 'pytest', '-q', 'tests/test_a.py::TestA::test_a']],
  ['go', { rel: 'pkg/a_test.go', kind: 'go', plain: 'TestA', groups: [], line: 1 }, {}, ['go', 'test', './pkg', '-count=1', '-run', '^TestA$']],
  ['go suite', { rel: 'pkg/a_test.go', kind: 'go', plain: 'TestB', groups: [], line: 1, suite: 'Suite' }, {}, ['go', 'test', './pkg', '-count=1', '-run', '/^TestB$']],
  ['rspec', { rel: 'spec/a_spec.rb', kind: 'rb', plain: 'works', groups: ['Foo'], line: 4 }, { isBundled: true }, ['bundle', 'exec', 'rspec', 'spec/a_spec.rb:4']],
  ['minitest', { rel: 'test/a_test.rb', kind: 'rb', plain: 'rails way', groups: [], line: 4 }, {}, ['ruby', '-Itest', 'test/a_test.rb', '-n', '/^rails_way$|^test_rails_way$/']],
  ['cargo', { rel: 'tests/a.rs', kind: 'rs', plain: 'adds', groups: ['tests'], line: 3 }, {}, ['cargo', 'test', 'adds']],
  ['gradle', { rel: 'src/test/java/FooTest.java', kind: 'jvm', plain: 'adds', groups: ['FooTest'], line: 3 }, { jvm: 'gradle' }, ['./gradlew', 'test', '--tests', '*FooTest.adds']],
  ['maven', { rel: 'src/test/java/FooTest.java', kind: 'jvm', plain: 'adds', groups: [], line: 3 }, { jvm: 'maven' }, ['mvn', '-q', 'test', '-Dtest=FooTest#adds']],
  ['no JVM build', { rel: 'FooTest.kt', kind: 'jvm', plain: 'adds', groups: [], line: 3 }, {}, null],
  ['dotnet', { rel: 'FooTests.cs', kind: 'cs', plain: 'Adds', groups: ['FooTests'], line: 3 }, {}, ['dotnet', 'test', '--filter', 'FullyQualifiedName~FooTests.Adds']],
  ['phpunit', { rel: 'tests/FooTest.php', kind: 'php', plain: 'testAdds', groups: [], line: 3 }, {}, ['vendor/bin/phpunit', '--filter', '/::testAdds$/', 'tests/FooTest.php']],
  ['pest', { rel: 'tests/FooTest.php', kind: 'php', plain: 'pest case', groups: [], line: 3 }, { isPest: true }, ['vendor/bin/pest', 'tests/FooTest.php', '--filter', 'pest case']],
  ['swift', { rel: 'Tests/FooTests.swift', kind: 'swift', plain: 'testAdds', groups: ['FooTests'], line: 2 }, {}, ['swift', 'test', '--filter', 'FooTests/testAdds']],
]
for (const [label, target, found, argv] of RUNS) {
  test(`one test runs with ${label}: ${argv ? shownCommand(argv) : 'no command'}`, async () => {
    expect(runArgv(target, found)).toEqual(argv)
  })
}

test('a command is shown as typed, quoting what the shell would split', async () => {
  expect(shownCommand(['npx', 'jest', 'src/a.test.ts', '-t', "^it's (1)$"])).toBe("npx jest src/a.test.ts -t '^it'\\''s (1)$'")
  expect(tailOf('a\n\n  \nb\nc\n', 2)).toBe('b\nc')
})
