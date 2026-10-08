import { expect, mock, test } from 'claude-code/testing'
import { parseVerdicts } from '../hooks/excerpt'
import { FILE, mount, project, verdictsDrawn, ok, gradeOnce, inFlight, ADDING, ASKED, REFUSED } from './helpers'

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
  expect(tree).toContain('4 tests · 3 strong · 1 shallow')
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


test('in a long file, a looped test graded again by its cases\' names still reaches the grader with its loop, and is told which loop they come from', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const old = Array.from({ length: 400 }, (_, i) => `it('old case ${i}', () => {\n  expect(add(${i}, 1)).toBe(${i + 1})\n})\n`).join('')
  const loop = "\nfor (const name of ['tiny', 'huge']) {\n  it(`rounds ${name}`, () => { expect(round(name)).toBe(-7) })\n}\n"
  const files: Record<string, string> = { 'src/round.test.ts': old + loop }
  const { prompts } = project(on, files, { expand: { 'rounds ${name}': ['rounds tiny', 'rounds huge'] } })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // the loop's body edited: its cases, tracked by their own names now, are graded again
  files['src/round.test.ts'] = files['src/round.test.ts']!.replace('toBe(-7)', 'toBe(-8)')
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/round.test.ts', old_string: 'toBe(-7)', new_string: 'toBe(-8)' } as never)
  await clock.advance(10)

  const regrade = prompts.at(-1)!
  expect(ASKED([regrade])).toEqual(['rounds huge', 'rounds tiny'])
  expect(regrade).toContain("for (const name of ['tiny', 'huge']) {")
  expect(regrade).toContain('expect(round(name)).toBe(-8)')
  expect(regrade).not.toContain('old case 399')
  // told, after the source, which loop the cases come from
  expect(regrade.slice(regrade.lastIndexOf('```'))).toContain('rounds ${name}')
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

  expect(JSON.stringify(await ui.drawn())).toContain('3 tests · 1 strong · 1 shallow · 1 unrated')
  expect(logs.some(line => line.startsWith('test-grader: a grader reply was cut off') && line.includes('src/k.test.ts'))).toBe(true)
})


test('a grader call has room in its reply for a looped test\'s every case', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const loop = "for (const name of NAMES) {\n  it(`the lifetime: ${name}`, () => { expect(ttl(name)).toBeDefined() })\n}\n"
  // a grader whose reply stops where its token budget ends, at about 4 characters a token
  const calls: { budgets: number[] } = { budgets: [] }
  const cut = (reply: string): string => reply.slice(0, calls.budgets.at(-1)! * 4)
  const { budgets, logs } = project(on, { 'src/l.test.ts': loop }, { cut, expand: { 'the lifetime: ${name}': Array.from({ length: 20 }, (_, i) => `the lifetime: case ${i}`) } })
  calls.budgets = budgets
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // every one of the loop's twenty cases came back with its verdict, and no reply was cut off
  const verdicts = await verdictsDrawn(ui)
  expect(Object.keys(verdicts)).toHaveLength(20)
  expect(Object.values(verdicts).every(v => v === 'strong')).toBe(true)
  expect(logs.some(line => line.startsWith('test-grader: a grader reply was cut off'))).toBe(false)
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


test('with no grader model set, tests are graded by the haiku alias', async ($, on) => {
  expect(await gradeOnce($, on)).toEqual(['haiku'])
})


test('the grader model setting picks the model that grades', { options: { graderModel: 'opus' } }, async ($, on) => {
  expect(await gradeOnce($, on)).toEqual(['opus'])
})


test('a gateway\'s own id for an older Haiku grades exactly as set', { options: { graderModel: 'us.anthropic.claude-3-haiku-20240307-v1:0' } }, async ($, on) => {
  expect(await gradeOnce($, on)).toEqual(['us.anthropic.claude-3-haiku-20240307-v1:0'])
})


test('a grader model set with spaces around it grades with them trimmed', { options: { graderModel: '  claude-haiku-4-5  ' } }, async ($, on) => {
  expect(await gradeOnce($, on)).toEqual(['claude-haiku-4-5'])
})


test('a grader model changed in /config grades the next call, with no restart; another plugin\'s field of that name changes nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { models } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  // the settings writer: takes the value as set
  on('config.set', async (_$, e) => ({ value: e.value }))
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  const regrade = async () => {
    await ui.press({ key: 'regradeAll' })
    await clock.advance(10)
  }
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  await $.config.set({ key: 'test-grader.graderModel', value: 'sonnet' } as never)
  await regrade()
  await $.config.set({ key: 'other.graderModel', value: 'opus' } as never).catch(() => undefined)
  await regrade()
  expect(models).toEqual(['haiku', 'sonnet', 'sonnet'])
})


test('a blank grader model setting grades with the haiku alias', { options: { graderModel: '   ' } }, async ($, on) => {
  expect(await gradeOnce($, on)).toEqual(['haiku'])
})


test('a second-look model, when set, grades again only what the first grade flagged; a strong test edited stays with the grader model', { options: { graderModel: 'sonnet', graderEscalate: 'claude-haiku-4-5' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the files Claude writes, not there before
  const written: Record<string, string> = {
    'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n",
    'src/b.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
  }
  const files: Record<string, string> = {}
  const { models, prompts } = project(on, files)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  // the model of the grader call that judged this test
  const gradedBy = (name: string): string[] => prompts.flatMap((p, i) => (ASKED([p]).includes(name) ? [models[i]!] : []))
  const edit = async (file: string, from: string, to: string) => {
    files[file] = files[file]!.replace(from, to)
    await $.tool.call({ tool: 'Edit', file_path: `/proj/${file}`, old_string: from, new_string: to } as never)
    await clock.advance(10)
  }
  for (const [file, content] of Object.entries(written)) {
    files[file] = content
    await $.tool.call({ tool: 'Write', file_path: `/proj/${file}`, content } as never)
    await clock.advance(10)
  }

  // graded shallow at first by the grader model; its edit is the second look's
  await edit('src/a.test.ts', 'toBeDefined', 'toBeTruthy')
  // graded strong at first; its edit stays with the grader model
  await edit('src/b.test.ts', 'toBe(3)', 'toEqual(3)')

  expect(gradedBy('a shallow check')).toEqual(['sonnet', 'claude-haiku-4-5'])
  expect(gradedBy('adds')).toEqual(['sonnet', 'sonnet'])
})


test('the grader workers setting sets how many grader calls run at once', { options: { graderWorkers: 3 } }, async ($, on) => {
  expect(await inFlight($, on)).toBe(3)
})


test('a grader workers setting below 1 runs one call at a time', { options: { graderWorkers: 0 } }, async ($, on) => {
  expect(await inFlight($, on)).toBe(1)
})


test('a grader workers setting above 20 runs 20 at a time', { options: { graderWorkers: 50 } }, async ($, on) => {
  expect(await inFlight($, on)).toBe(20)
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
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 1 strong')

  await ui.press({ key: 'regradeAll' })
  await clock.advance(10_000)
  expect(prompts).toHaveLength(3)
  expect(JSON.stringify(await ui.drawn())).toContain('1 unrated')
  expect(logs).toContain('test-grader: the grader gave no answer for /proj/src/a.test.ts (api-error 400 invalid_request)')
})


test('the grader reads the code under test the test file imports, and the project rules in .test-grader.md', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...ADDING, 'src/unrelated.ts': 'export const UNRELATED_MARK = 1\n', '.test-grader.md': 'Snapshots are fine here.' }
  const { prompts, systems } = project(on, files)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: files['src/a.test.ts'] } as never)
  await clock.advance(10)
  // the module the test imports, whole, under its path; a file it does not import, not at all
  expect(prompts[0]).toContain('src/add.ts')
  expect(prompts[0]).toContain(ADDING['src/add.ts']!)
  expect(prompts[0]).not.toContain('UNRELATED_MARK')
  // the project's rules, after the grader's own rubric so they can override it
  expect(systems[0]).toContain('Snapshots are fine here.')
  expect(systems[0]!.indexOf('Snapshots are fine here.')).toBeGreaterThan(systems[0]!.indexOf('Answer with JSON only.'))
})


test('a grader call that gets no answer says why in the pane, on the row and above the list, until a call answers', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const missing = { isAnswered: false, reason: 'api-error', status: 404, error: 'not_found_error', usage: {} }
  const answers: unknown[] = [missing, undefined]
  const { prompts } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { reply: n => answers[n - 1] })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const why = 'The grader (haiku) gave no answer: api-error 404 not_found_error.'
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)

  // above the list, and on the unrated row once it is opened
  expect(await texts()).toContain(why)
  await ui.press({ key: 'r:/proj/src/a.test.ts:adds' })
  expect(await texts()).toContain(`The grader gave no verdict for this test. ${why} Grade again to retry it.`)

  // a call that answers clears it
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(2)
  expect((await texts()).some(t => t.includes('gave no answer'))).toBe(false)
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 1 strong')
})

test('a grader call the engine refuses to send, as it does a blocked model, says so in the pane, and the test is unrated', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { reply: () => REFUSED })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  // the reason is the host's own, whole: here the test kit's, which has no model to send to
  expect(texts).toContain('The grader (haiku) call failed: no implementation for model.complete')
  expect(texts.filter(t => t.includes('call failed'))).toHaveLength(1)
  expect(JSON.stringify(await ui.drawn())).toContain('1 unrated')
})

test('a host that will not take marked blocks grades with plain texts, and keeps to them when it grades again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const older = (r: Record<string, unknown>): boolean => 'effort' in r || ((r.promptBlocks as { cache?: boolean }[] | undefined) ?? []).some(b => b.cache)
  const { refused, systems, prompts } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n", 'src/b.test.ts': "it('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n" }, { older })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 2 strong')
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text.includes('call failed'))).toBe(false)
  // the rubric still reaches the grader
  expect(systems.every(s => s.includes('Answer with JSON only.'))).toBe(true)
  // once the plain form has worked, later calls go straight to it
  const before = refused.length
  expect(before).toBeGreaterThan(0)
  await ui.press({ key: 'regradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(4)
  expect(refused).toHaveLength(before)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 2 strong')
})

test('a host that takes only a model and a prompt grades with the rubric in the prompt', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const older = (r: Record<string, unknown>): boolean => String(r.system ?? '') !== '' || 'maxTokens' in r && r.maxTokens !== undefined
  const { prompts, refused } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { older })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(refused).toHaveLength(2)
  expect(prompts[0]).toContain('Answer with JSON only.')
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 1 strong')
})

test('a looped test\'s verdict, named for its case, counts as an answer and shows no error', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "for (const name of ['tiny', 'huge']) {\n  it(`rounds ${name}`, () => { expect(round(name)).toBe(1) })\n}\n"
  project(on, { 'src/round.test.ts': content }, { expand: { 'rounds ${name}': ['rounds tiny', 'rounds huge'] } })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text.includes('no verdict it could read'))).toBe(false)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 2 strong')
})

test('a grader answer holding no verdict for the tests asked about says what came back, until one does', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const prose = { isAnswered: true, text: 'I cannot help with that.', usage: {} }
  const otherName = { isAnswered: true, text: '[{"name":"subtracts","summary":"s","verdict":"strong","reason":"r"}]', usage: {} }
  const answers: unknown[] = [prose, otherName, undefined]
  project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { reply: n => answers[n - 1] })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(await texts()).toContain('The grader (haiku) answered with no verdict it could read: "I cannot help with that.".')

  // a verdict, but for a test it was not asked about, counts as none
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect((await texts()).some(t => t.includes('answered with no verdict') && t.includes('subtracts'))).toBe(true)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect((await texts()).some(t => t.includes('answered with no verdict'))).toBe(false)
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 1 strong')
})


// one test a first pass grades shallow, with the reply the grader gives
const ONE = { 'src/a.test.ts': "it('totals', () => { expect(total([])).toBeDefined() })\n" }
const answer = (o: Record<string, unknown>) => ({ isAnswered: true, usage: {}, text: JSON.stringify([{ name: 'totals', summary: 'Checks totals.', ...o }]) })
const gradeAllOf = async (ui: Awaited<ReturnType<typeof mount>>, clock: { advance: (ms: number) => Promise<void> }) => {
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  return JSON.stringify(await ui.drawn())
}

test('a shallow grade that names no bug it would miss counts as strong', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { confirms } = project(on, ONE, { reply: () => answer({ verdict: 'shallow', reason: 'Only checks it is defined.', missed: '  ' }) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  expect(await gradeAllOf(ui, clock)).toContain('1 test · 1 strong')
  // strong already: nothing to confirm
  expect(confirms).toHaveLength(0)
})

test('a shallow grade with the bug it would miss is kept, the bug told in its reason; other grades need none', () => {
  const reply = JSON.stringify([
    { name: 'totals', summary: 's', verdict: 'shallow', reason: 'Only checks it is defined.', missed: 'total([2, 3]) returning 4 would pass' },
    { name: 'calls', summary: 's', verdict: 'brittle', reason: 'Counts calls.' },
  ])
  expect(parseVerdicts(reply).verdicts).toEqual([
    { name: 'totals', summary: 's', verdict: 'shallow', reason: 'Only checks it is defined. It would miss: total([2, 3]) returning 4 would pass' },
    { name: 'calls', summary: 's', verdict: 'brittle', reason: 'Counts calls.' },
  ])
})

test('a flag the confirm pass overturns reaches no one: the test is strong', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { confirms } = project(on, { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\nit('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { confirm: () => 'strong' })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  expect(await gradeAllOf(ui, clock)).toContain('2 tests · 2 strong')
  // only the flagged test is sent to be confirmed
  expect(confirms).toHaveLength(1)
  expect(ASKED(confirms.map(c => c.prompt))).toEqual(['a shallow check'])
})

test('a flag the confirm pass agrees with stands, confirmed by the second-look model when one is set', { options: { graderEscalate: 'sonnet' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { confirms, models } = project(on, { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  expect(await gradeAllOf(ui, clock)).toContain('1 test · 0 strong · 1 shallow')
  expect(models).toEqual(['haiku'])
  expect(confirms.map(c => c.model)).toEqual(['sonnet'])
})

test('a flag the confirm pass grades differently takes the confirm pass\'s grade', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { confirms } = project(on, { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" }, { confirm: () => 'hollow' })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  expect(await gradeAllOf(ui, clock)).toContain('1 test · 0 strong · 1 hollow')
  // with no second-look model set, the grader model confirms
  expect(confirms.map(c => c.model)).toEqual(['haiku'])
})

test('a test changed outside the editor while its grade was under way is graded again on its new text, the old grade not kept', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const held = { calls: 0, release: () => {} }
  const files: Record<string, string> = {}
  const weak = "it('totals', () => { expect(total([2, 3])).toBeDefined() })\n"
  const { prompts } = project(on, files, { held, rule: (_n, prompt) => (prompt.includes('toBeDefined') ? 'shallow' : 'strong') })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  files['src/a.test.ts'] = weak
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: weak } as never)
  await clock.advance(10)
  expect(held.calls).toBe(1)

  // while the grader reads the weak text, the test is made strong on disk
  files['src/a.test.ts'] = weak.replace('toBeDefined()', 'toBe(5)')
  held.release()
  await clock.advance(10)
  held.release()
  await clock.advance(10)

  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('toBe(5)')
  const ui = await mount($)
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 1 strong')
})


test('a change elsewhere in the file while a test is graded keeps that test\'s grade, with no second call', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const held = { calls: 0, release: () => {} }
  const files: Record<string, string> = {}
  const text = "it('a shallow check', () => { expect(f).toBeDefined() })\n"
  const { prompts } = project(on, files, { held })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  files['src/a.test.ts'] = text
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: text } as never)
  await clock.advance(10)

  files['src/a.test.ts'] = `${text}it('adds', () => { expect(add(1, 2)).toBe(3) })\n`
  held.release()
  await clock.advance(10)
  held.release()
  await clock.advance(10)

  expect(ASKED(prompts).filter(n => n === 'a shallow check')).toHaveLength(1)
  const ui = await mount($)
  expect(JSON.stringify(await ui.drawn())).toContain('1 shallow')
})


test('a test written this session, then graded by Grade all, then edited, shows its new grade, not Grade all\'s older one', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const weak = "it('totals', () => { expect(total([2, 3])).toBeDefined() })\n"
  const files: Record<string, string> = {}
  project(on, files, { rule: (_n, prompt) => (prompt.includes('toBeDefined') ? 'shallow' : 'strong') })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  files['src/a.test.ts'] = weak
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: weak } as never)
  await clock.advance(10)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('1 shallow')

  files['src/a.test.ts'] = weak.replace('toBeDefined()', 'toBe(5)')
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: 'toBeDefined()', new_string: 'toBe(5)' } as never)
  await clock.advance(10)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 strong')
  expect(tree).not.toContain('shallow')
})
