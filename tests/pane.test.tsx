import { expect, mock, test } from 'claude-code/testing'
import { FILE, CONTENT, mount, project, nodesOf, holdsKey, ok, QUOTA_TEST, OTHER_TEST, TREE, groupRows } from './helpers'
import { placedOf } from './helpers'
import type { Placed } from './helpers'
import type { Node } from './helpers'

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
          { name: 'adds numbers', summary: 'Checks add(1,2) is 3.', verdict: 'strong', reason: 'Asserts a real result.' },
          { name: 'does nothing', summary: 'Asserts true is true.', verdict: 'hollow', reason: 'Tautology.' },
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
    expect(tree).toContain('2 tests · 1 strong · 1 hollow · 2 new')
    expect(tree).toContain('adds numbers')
    expect(tree).toContain('Tautology.')
    expect(tree).toContain('1 hollow')
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
  expect(JSON.stringify(await ui.drawn())).toContain('0 tests · 0 strong"')
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
  expect(closed).not.toContain('shallow because.')
  expect(closed).not.toContain('Checks a shallow check.')

  await ui.press({ key: 'r:/proj/src/more.test.ts:a shallow check' })
  const open = JSON.stringify(await ui.drawn())
  expect(open).toContain('src/more.test.ts')
  expect(open).toContain('Checks a shallow check.')
  expect(open).toContain('shallow because.')

  await ui.press({ key: 'r:/proj/src/more.test.ts:a shallow check' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('shallow because.')
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
  expect(tree).toContain('4 tests · 3 strong · 1 shallow')
  // b has the shallow test, so it comes first; both closed, counted on their header lines
  expect(tree.indexOf('▸ src/b.test.ts')).toBeGreaterThan(-1)
  expect(tree.indexOf('▸ src/b.test.ts')).toBeLessThan(tree.indexOf('▸ src/a.test.ts'))
  expect(tree).toContain('2 · 1 strong · 1 shallow')
  // an all-strong file's counts in green
  expect(tree).toContain('{"color":"#4ade80"},"children":["2 · 2 strong"]')
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
  // shallow when written, strong by the time Grade all tests reads it
  let isLater = false
  project(on, files, { rule: () => (isLater ? 'strong' : 'shallow') })
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/c.test.ts', content: files['src/c.test.ts'] } as never)
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 0 strong · 1 shallow · 1 new')

  isLater = true
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 strong · 1 new')
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
  expect(tree).toContain('0 tests · 0 strong"')
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
  expect(tree).toContain('1 test · 1 strong')
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
  for (const label of labels) expect(label.length).toBeLessThanOrEqual(80 - 2 - 'strong'.length - 1)
})


test('each verdict sits in one column on its title\'s first line, and an opened row\'s details sit under the title', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // long enough to wrap onto three lines or more: centred beside it, a verdict would sit lower
  const long = 'keeps the quota band steady while the session compacts and the five hour window rolls over into the next one, and the band shows the same figures before and after the compaction, with no flicker'
  project(on, { 'src/v.test.ts': `it('${long}', () => { expect(band()).toEqual(steady) })\nit('a shallow check', () => { expect(f).toBeDefined() })\nit('checks nothing', () => {})\n` })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'r:/proj/src/v.test.ts:a shallow check' })

  // where each piece of text lands, as a terminal lays the pane out
  const placed = placedOf(await ui.drawn())
  const at = (key: string): Placed => placed.find(p => p.key === key)!
  const titles = new Map<string, Placed>()
  for (const [name, verdict] of [[long, 'strong'], ['a shallow check', 'shallow'], ['checks nothing', 'hollow']] as const) {
    const title = at(`r:/proj/src/v.test.ts:${name}`)
    titles.set(name, title)
    // the verdict on the title's first line, to its left
    expect(placed.some(p => p.text === verdict && p.y === title.y && p.x < title.x)).toBe(true)
    expect(name.startsWith(title.text)).toBe(true)
  }
  // every title starts in the same column, whatever its verdict's length
  expect(new Set([...titles.values()].map(t => t.x)).size).toBe(1)
  const column = titles.get(long)!.x
  // a title that wraps goes on under its own first line, its verdict beside the first line only
  const second = at(`r:/proj/src/v.test.ts:${long}#1`)
  expect(at(`r:/proj/src/v.test.ts:${long}#2`)).toMatchObject({ x: column, y: titles.get(long)!.y + 2 })
  expect(second).toMatchObject({ x: column, y: titles.get(long)!.y + 1 })
  expect(placed.some(p => p.y === second.y && p.x < column && p.text.trim() !== '')).toBe(false)

  // the opened row's details start under its title, not under its verdict
  const shallow = titles.get('a shallow check')!
  const summary = placed.find(p => p.text === 'Checks a shallow check.')!
  expect(summary).toMatchObject({ x: column })
  expect(summary.y).toBeGreaterThan(shallow.y)
  expect(at('o:/proj/src/v.test.ts:a shallow check').x).toBe(column)
})

test('an opened row\'s description is drawn apart from its title, so it shows where the title ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'src/v.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'r:/proj/src/v.test.ts:a shallow check' })

  const nodes = nodesOf(await ui.drawn())
  const title = nodes.find(n => n.props?.key === 'r:/proj/src/v.test.ts:a shallow check')!
  const summary = nodes.find(n => n.type === 'Text' && (n.children ?? []).includes('Checks a shallow check.'))!
  const style = (props: Record<string, unknown> | undefined) => JSON.stringify([props?.color ?? null, props?.italic ?? false, props?.dimColor ?? false, props?.bold ?? false])
  // the title in the plain style a name is drawn in, the description in another: they cannot be
  // told apart only when both are drawn alike
  expect(style(title.props)).toBe(style({}))
  expect(style(summary.props)).not.toBe(style(title.props))
})


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
  project(on, { 'pkg/quota/quota_test.go': QUOTA_TEST, 'pkg/quota/other_test.go': OTHER_TEST }, { rule: name => (name.includes('Shallow') ? 'shallow' : 'strong') })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // two groups at the top, both closed: the suite (shallow, so first) and the plain test's file
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
  ['terminal', 50 - 2 - 'strong'.length - 1],
  // a desktop's proportional font fits a fifth more characters than the pane has cells
  ['desktop', Math.floor((50 - 2 - 'strong'.length - 1) * 1.2)],
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


test('tests in folders are grouped by folder, the worst folder first, each with the counts of all beneath it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, TREE)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // the top level: internal (a hollow and a shallow beneath it), then cmd/exporter, merged as it
  // holds nothing but one folder, then the file at the root; several, so each starts closed
  expect(await groupRows(ui)).toEqual([
    ['d:internal', '▸ internal/'],
    ['d:cmd/exporter', '▸ cmd/exporter/'],
    ['f:/proj/root.test.ts', '▸ root.test.ts'],
  ])
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"4 · 2 strong · 1 hollow · 1 shallow"')

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


test('more than 60 tests written in a session are all listed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = Array.from({ length: 70 }, (_, i) => `it('case ${i}', () => { expect(f(${i})).toBe(${i}) })\n`).join('')
  project(on, { 'src/many.test.ts': content })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/many.test.ts', content } as never)
  await clock.advance(10)
  expect(JSON.stringify(await (await mount($)).drawn())).toContain('70 tests · 70 strong · 70 new')
})


test('an opened row\'s actions are drawn as buttons, apart from its text; the title stays plain', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'package.json': '{ "devDependencies": { "jest": "^29.0.0" } }', 'src/v.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'r:/proj/src/v.test.ts:a shallow check' })

  // each button drawn, by key: its label, and whether it is drawn plain, as text
  const buttons = new Map(nodesOf(await ui.drawn()).filter(n => n.type === 'Button').map(b => [String(b.props?.key), { label: b.props?.label, plain: b.props?.plain === true }]))
  // Open in editor and Run test as [ Open in editor ] and [ Run test ], as Grade all tests is
  expect(buttons.get('o:/proj/src/v.test.ts:a shallow check')).toEqual({ label: 'Open in editor', plain: false })
  expect(buttons.get('x:/proj/src/v.test.ts:a shallow check')).toEqual({ label: 'Run test', plain: false })
  expect(buttons.get('gradeAll')).toEqual({ label: 'Grade all tests', plain: false })
  // the title that opens the row is read as text, not as a button
  expect(buttons.get('r:/proj/src/v.test.ts:a shallow check')).toEqual({ label: 'a shallow check', plain: true })
})
