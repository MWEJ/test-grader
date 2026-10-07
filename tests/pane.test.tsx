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
    const tree = JSON.stringify(await ui.drawn())
    expect(tree).toContain('2 new tests')
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
  expect(JSON.stringify(await ui.drawn())).toContain('0 new tests')
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

function project(on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, string>, isGit = true, gate?: () => Promise<void>) {
  const prompts: string[] = []
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
    const names = JSON.parse(prompt.match(/test cases: (\[.*\])/)![1]!) as string[]
    return {
      value: {
        isAnswered: true,
        usage: {},
        text: JSON.stringify(
          names.map(name => {
            const verdict = name.includes('shallow') ? 'weak' : name.includes('nothing') ? 'useless' : 'good'
            return { name, summary: `Checks ${name}.`, verdict, reason: `${verdict} because.` }
          }),
        ),
      },
    } as never
  })
  return { prompts }
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
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('Existing tests')
  expect(tree).toContain('26 graded')
  expect(tree).toContain('24 good')
  expect(tree).toContain('1 weak')
  expect(tree).toContain('1 useless')
  // listed: the useless before the weak; the good are counted, not listed
  expect(tree).toContain('useless because.')
  expect(tree).toContain('weak because.')
  expect(tree.indexOf('does nothing')).toBeLessThan(tree.indexOf('a shallow check'))
  expect(tree).not.toContain('case 7')
  // the new-tests list is untouched
  expect(tree).toContain('0 new tests')
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
    true,
    () => new Promise<void>(r => (release = r)),
  )
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('Grading 1/2 files…')
  release()
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('2 graded')

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(4)
  expect(JSON.stringify(await ui.drawn())).toContain('2 graded')
})

test('Grade all tests outside a git repo says so and grades nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, {}, false)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(0)
  expect(JSON.stringify(await ui.drawn())).toContain('Not a git repository: there is no list of test files to grade.')
})
