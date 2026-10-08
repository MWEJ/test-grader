import { expect, mock, test } from 'claude-code/testing'
import { parseVerdicts } from '../hooks/excerpt'
import { FILE, mount, project, verdictsDrawn, ok, gradeOnce, inFlight, ADDING, ASKED, REFUSED, askGrades } from './helpers'
import type { Engine, On } from './helpers'

test('a new test deep in a long file reaches the grader with its body, however far down it sits', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const helper = "const helper = (n: number) => n * 2\n"
  const old = Array.from({ length: 1200 }, (_, i) => `it('old case ${i}', () => { expect(add(${i}, 1)).toBe(${i + 1}) })\n`).join('')
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
  const old = Array.from({ length: 1200 }, (_, i) => `it('old case ${i}', () => {\n  expect(add(${i}, 1)).toBe(${i + 1})\n})\n`).join('')
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
  expect(prompts[0]).not.toContain('add(399, 1)')
})


test('in a long file, a looped test graded again by its cases\' names still reaches the grader with its loop, and is told which loop they come from', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const old = Array.from({ length: 1200 }, (_, i) => `it('old case ${i}', () => {\n  expect(add(${i}, 1)).toBe(${i + 1})\n})\n`).join('')
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
  expect(regrade).not.toContain('add(399, 1)')
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
  const old = (from: number) => Array.from({ length: 600 }, (_, i) => `it('old case ${from + i}', () => {\n  expect(add(${i}, 1)).toBe(${i + 1})\n})\n`).join('')
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
  expect(await texts()).toContain(`${why} Grade again to retry it.`)

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

test('a test named with a curly apostrophe is graded when the grader echoes it straight', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const straight = { isAnswered: true, text: '[{"name":"no nudges for a subagent\'s call","summary":"s","verdict":"brittle","reason":"Exact mock calls."}]', usage: {} }
  project(on, { 'src/a.test.ts': "it('no nudges for a subagent’s call', () => { expect(nudges()).toEqual([]) })\n" }, { reply: () => straight })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 0 strong · 1 brittle')
})

test('a Go table test the grader graded case by case is rated, worst case first, and the grader is asked for one verdict per test', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const T = 'TestRoleGating_BuildsItems'
  const perCase = { isAnswered: true, usage: {}, text: JSON.stringify([
    { name: `${T} › xdr role`, summary: 's', verdict: 'strong', reason: 'r' },
    { name: `${T} › overwatch role`, summary: 's', verdict: 'brittle', reason: 'Asserts exact mock calls.' },
  ]) }
  const { prompts, confirms } = project(on, { 'gitops/roles_test.go': `package gitops\n\nfunc ${T}(t *testing.T) {\n\tfor _, tc := range cases {\n\t\tt.Run(tc.name, func(t *testing.T) { check(t, tc) })\n\t}\n}\n` }, { reply: () => perCase })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts[0]).toContain('gets one verdict for all its cases together, under its own name')
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 0 strong · 1 brittle')
  // the flag goes to the second look under the test's name, with the case that earned it
  const why = 'Graded case by case ("xdr role", "overwatch role"); the case "overwatch role" is brittle: Asserts exact mock calls.'
  expect(confirms[0]!.prompt).toContain(JSON.stringify([{ name: T, verdict: 'brittle', reason: why }]))
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


// What the grader reads of the code under test, language by language: the files it was sent
// beside a test file Claude writes, by their path in the project, in the order sent
// the test file is new, not there before Claude writes it
const sentBeside = async ($: Engine, on: On, all: Record<string, string>, test: string): Promise<{ paths: string[]; prompt: string }> => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { [test]: content, ...files } = all
  const { prompts } = project(on, files)
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  files[test] = content!
  await $.tool.call({ tool: 'Write', file_path: `/proj/${test}`, content } as never)
  await clock.advance(10)
  expect(prompts).toHaveLength(1)
  return { paths: [...prompts[0]!.matchAll(/^--- (.+) ---$/gm)].map(m => m[1]!), prompt: prompts[0]! }
}

test('a JS test\'s imports reach the grader by their extension, as .js naming the .ts source, or as a folder\'s index; four files at most, none a test file or empty', async ($, on) => {
  const test = [
    "import { f } from './f.js'",
    "import { g } from './g.ts'",
    "import { h } from './lib'",
    "import { s } from './shared.test'",
    "const e = require('./empty')",
    "import { f as again } from './f.js'",
    "import { m } from './more'",
    "import { n } from './fifth'",
    '',
    "it('adds', () => { expect(f(1) + g(2)).toBe(3) })",
    '',
  ].join('\n')
  const { paths, prompt } = await sentBeside($, on, {
    'src/a.test.ts': test,
    'src/f.ts': 'export const f = (n: number) => n // F_MARK\n',
    'src/g.ts': 'export const g = (n: number) => n\n',
    'src/lib/index.ts': 'export const h = 1\n',
    'src/shared.test.ts': "it('shares', () => { expect(1).toBe(1) })\n",
    'src/empty.ts': '  \n',
    'src/more.ts': 'export const m = 1\n',
    'src/fifth.ts': 'export const n = 1 // FIFTH_MARK\n',
  }, 'src/a.test.ts')
  expect(paths).toEqual(['src/f.ts', 'src/g.ts', 'src/lib/index.ts', 'src/more.ts'])
  expect(prompt).toContain('export const f = (n: number) => n // F_MARK')
  expect(prompt).not.toContain('FIFTH_MARK')
})

test('a Python test\'s from-imports reach the grader: relative ones beside it or above it, as a module or a package, and absolute ones at the root, in src/ or beside it', async ($, on) => {
  const test = [
    'from .helpers import make_cart',
    'from ..shared import base',
    'from shop.cart import Cart',
    'from pricing import rate',
    'from . import conftest',
    '',
    'def test_total():',
    '    assert Cart([2, 3]).total() == 5',
    '',
  ].join('\n')
  const { paths } = await sentBeside($, on, {
    'tests/unit/test_cart.py': test,
    'tests/unit/helpers.py': 'def make_cart(): ...\n',
    'tests/shared/__init__.py': 'base = 1\n',
    'src/shop/cart.py': 'class Cart: ...\n',
    'tests/unit/pricing.py': 'rate = 2\n',
  }, 'tests/unit/test_cart.py')
  expect(paths).toEqual(['tests/unit/helpers.py', 'tests/shared/__init__.py', 'src/shop/cart.py', 'tests/unit/pricing.py'])
})

test('a Ruby test\'s require_relative files reach the grader, named with .rb or without', async ($, on) => {
  const test = ["require 'json'", "require_relative '../../app/models/cart'", "require_relative 'support/money.rb'", '', 'class CartTest < Minitest::Test', '  def test_total', '    assert_equal 5, Cart.new([2, 3]).total', '  end', 'end', ''].join('\n')
  const { paths } = await sentBeside($, on, {
    'spec/models/cart_test.rb': test,
    'app/models/cart.rb': 'class Cart; end\n',
    'spec/models/support/money.rb': 'module Money; end\n',
  }, 'spec/models/cart_test.rb')
  expect(paths).toEqual(['app/models/cart.rb', 'spec/models/support/money.rb'])
})

test('a Go test\'s package reaches the grader: its other .go files, not its tests or what else the folder holds', async ($, on) => {
  on('fs.list', async (_$, e) => {
    if ((e as { path: string }).path !== '/proj/pkg/quota') throw new Error('missing')
    const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 1 })
    return { value: [entry('quota.go', 'file'), entry('quota_test.go', 'file'), entry('store.go', 'file'), entry('store_test.go', 'file'), entry('README.md', 'file'), entry('internal.go', 'dir')] } as never
  })
  const { paths } = await sentBeside($, on, {
    'pkg/quota/quota_test.go': 'package quota\n\nfunc TestRollover(t *testing.T) {\n\tif rollover(4) != 5 {\n\t\tt.Fatal("rollover")\n\t}\n}\n',
    'pkg/quota/quota.go': 'package quota\n\nfunc rollover(n int) int { return n + 1 }\n',
    'pkg/quota/store.go': 'package quota\n\ntype Store struct{}\n',
    'pkg/quota/store_test.go': 'package quota\n\nfunc TestStore(t *testing.T) {}\n',
    'pkg/quota/README.md': '# quota\n',
  }, 'pkg/quota/quota_test.go')
  expect(paths).toEqual(['pkg/quota/quota.go', 'pkg/quota/store.go'])
})

test('a Kotlin or Java test under src/test reaches the grader with the class it is named for under src/main', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the tests Claude writes, not there before
  const written: Record<string, string> = {
    'src/test/kotlin/shop/CartTest.kt': 'class CartTest {\n  @Test fun totals() { assertEquals(5, Cart(listOf(2, 3)).total()) }\n}\n',
    'src/test/java/shop/CartTests.java': 'class CartTests {\n  @Test void totals() { assertEquals(5, new Cart(2, 3).total()); }\n}\n',
  }
  const files: Record<string, string> = { 'src/main/kotlin/shop/Cart.kt': 'class Cart(val items: List<Int>) // KOTLIN_CART\n', 'src/main/java/shop/Cart.java': 'class Cart {} // JAVA_CART\n' }
  const { prompts } = project(on, files)
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  for (const [test, content] of Object.entries(written)) {
    files[test] = content
    await $.tool.call({ tool: 'Write', file_path: `/proj/${test}`, content } as never)
    await clock.advance(10)
  }
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).toContain('--- src/main/kotlin/shop/Cart.kt ---\n```\nclass Cart(val items: List<Int>) // KOTLIN_CART')
  expect(prompts[0]).not.toContain('JAVA_CART')
  expect(prompts[1]).toContain('--- src/main/java/shop/Cart.java ---\n```\nclass Cart {} // JAVA_CART')
})

test('a Kotlin test outside src/test reaches the grader with no code under test, even with its class beside it', async ($, on) => {
  const { paths, prompt } = await sentBeside($, on, {
    'CartTest.kt': 'class CartTest {\n  @Test fun totals() { assertEquals(5, Cart(listOf(2, 3)).total()) }\n}\n',
    'Cart.kt': 'class Cart(val items: List<Int>)\n',
  }, 'CartTest.kt')
  expect(paths).toEqual([])
  expect(prompt).not.toContain('The code under test')
})


test('a grader call that ends with a reason and no status says that reason in the pane, and is not tried again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { reply: () => ({ isAnswered: false, reason: 'max-turns', usage: {} }) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10_000)
  expect(prompts).toHaveLength(1)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('The grader (haiku) gave no answer: max-turns.')
})

test('a grader call stopped while it waits to try again is not tried again, and the pane shows no grader error', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const overloaded = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} }
  const { prompts } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { reply: () => overloaded })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(1)
  await ui.press({ key: 'stopGrading' })
  await clock.advance(10_000)
  expect(prompts).toHaveLength(1)
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text.startsWith('The grader'))).toBe(false)
})

test('a confirm pass that leaves out a flagged test keeps the first pass\'s grade for it, and takes its own for the rest', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the confirm pass overturns one flag, and gives no grade it can read for the other
  const confirm = (name: string) => (name === 'a shallow check' ? 'strong' : 'unknown') as never
  const { confirms } = project(on, { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\nit('another shallow one', () => { expect(g).toBeTruthy() })\nit('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { confirm })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(ASKED(confirms.map(c => c.prompt))).toEqual(['a shallow check', 'another shallow one'])
  expect(await verdictsDrawn(ui)).toEqual({ 'a shallow check': 'strong', 'another shallow one': 'shallow', adds: 'strong' })
})

test('a confirm pass that gets no answer leaves the first pass\'s flag standing, and the pane says the call failed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the host refuses every form of the confirm call
  const older = (r: Record<string, unknown>): boolean => JSON.stringify(r).includes('A first, quick pass flagged these')
  project(on, { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\nit('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { older })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(await verdictsDrawn(ui)).toEqual({ 'a shallow check': 'shallow', adds: 'strong' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('The grader (haiku) call failed: no implementation for model.complete')
})

test('a test file Grade all graded, written over by Claude with one test changed, has that test graded once more and marked modified, and the rest left be', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n" }
  const { prompts } = project(on, files)
  // Write writes the file, as the real tool does once it runs
  on('tool.call', async (_$, e) => {
    const { file_path, content } = e as unknown as { file_path: string; content: string }
    files[file_path.replace('/proj/', '')] = content
    return ok as never
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(ASKED(prompts)).toEqual(['adds', 'subtracts'])

  const content = files['src/a.test.ts']!.replace('toBe(3)', 'toEqual(3)')
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content } as never)
  await clock.advance(10)
  expect(ASKED(prompts.slice(1))).toEqual(['adds'])
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 2 strong · 1 modified"')
})


test('a test the grader gives no verdict says why on its row and in test_grades, and loses the reason once graded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the first answer leaves subtracts out; the next is the grader's usual one
  const partial = { isAnswered: true, usage: {}, text: '[{"name":"adds","summary":"Checks adds.","verdict":"strong","reason":"r"}]' }
  project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n" }, { reply: n => (n === 1 ? partial : undefined) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  const why = 'The grader (haiku) left this test out of its answer: it gave 1 of the 2 verdicts asked for.'
  expect(await askGrades($, { verdicts: ['unrated'] })).toContain(`"subtracts": unrated\n  Why: ${why}`)
  await ui.press({ key: 'r:/proj/src/a.test.ts:subtracts' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain(`${why} Grade again to retry it.`)

  await ui.press({ key: 'regradeAll' })
  await clock.advance(10)
  expect(await askGrades($, { verdicts: ['unrated'] })).not.toContain(why)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 2 strong')
})

test('a grader call the engine refuses leaves each of its tests unrated with the refusal as the reason', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { reply: () => REFUSED })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  // the refusal's words are the host's (here the test kit's): the row gives the very refusal the pane does
  const refusal = (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => t.startsWith('The grader (haiku) call failed: '))
  expect(refusal!.length).toBeGreaterThan('The grader (haiku) call failed: '.length)
  expect(await askGrades($, { verdicts: ['unrated'] })).toBe(`1 tests: 0 strong, 1 with no verdict.\nUnrated, worst first:\n- src/a.test.ts:1 "adds": unrated\n  Why: ${refusal}`)
})

test('a test Claude writes that the grader gives no verdict says why in test_grades, listed with no filter asked', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n"
  // the reply is cut off after the first verdict
  project(on, { 'src/a.test.ts': content }, { cut: reply => reply.slice(0, reply.indexOf('},') + 2) })
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content } as never)
  await clock.advance(10)
  expect(await askGrades($)).toContain(
    '"subtracts": unrated\n  Why: The grader\'s (haiku) reply was cut off at its 8000-token limit before it reached this test: it gave 1 of the 2 verdicts asked for.',
  )
})
