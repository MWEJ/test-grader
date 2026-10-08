import { expect, mock, test } from 'claude-code/testing'
import { mount, project, buttonsOf, appended, JEST_PROJECT, SUMMARY, jest } from './helpers'

test('Run coverage shows only in a project with a way to measure it; a report written by other means still shows its figures', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // a project of plugin tests: no coverage script, jest, vitest, pytest or Go
  const files: Record<string, string> = { 'package.json': '{ "name": "a-mod" }', 'tests/a.test.ts': "test('adds', () => { expect(add(1, 2)).toBe(3) })\n" }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  const heading = async () => (await ui.findAll({ type: 'Text' })).filter(t => t.text === 'Coverage')
  expect(buttonsOf(await ui.drawn()).has('run')).toBe(false)
  expect(await heading()).toEqual([])

  // a report written by other means: its figures show, still with no button to run one
  files['coverage/coverage-summary.json'] = SUMMARY
  await clock.advance(2_000)
  expect(await heading()).toHaveLength(1)
  expect(JSON.stringify(await ui.drawn())).toContain('82.5%')
  expect(buttonsOf(await ui.drawn()).has('run')).toBe(false)
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


test('folder rows show their line coverage, and a coverage run names the least covered folders', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const lcov = 'SF:src/a/x.ts\nLF:100\nLH:90\nend_of_record\nSF:src/b/y.ts\nLF:50\nLH:10\nend_of_record\n'
  const files: Record<string, string> = {
    'package.json': '{ "devDependencies": { "jest": "^29.0.0" } }',
    'src/a/x.test.ts': "it('x', () => { expect(x()).toBe(1) })\n",
    'src/b/y.test.ts': "it('y', () => { expect(y()).toBe(1) })\n",
  }
  const { logs } = project(on, files, { editor: argv => (argv[1] === 'jest' ? ((files['coverage/lcov.info'] = lcov), 0) : 1) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"90% lines"')
  expect(tree).toContain('"20% lines"')
  expect(appended(logs).at(-1)).toContain('Least covered folders (lines): src/b/ 20%, src/ 67%.')
})


test('a project with its own coverage script runs that, ahead of the runner it uses, and shows the figures it writes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {
    'package.json': '{ "scripts": { "coverage": "node scripts/coverage.mjs" }, "devDependencies": { "jest": "^29.0.0" } }',
    'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
  }
  const { runs } = project(on, files, {
    editor: () => {
      files['coverage/coverage-summary.json'] = SUMMARY
      return 0
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  expect(buttonsOf(await ui.drawn()).get('run')).toBe('Run coverage')

  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(runs).toEqual([['npm', 'run', '--silent', 'coverage']])
  expect(JSON.stringify(await ui.drawn())).toContain('82.5%')
})

test('a package.json that is not JSON falls back to the runner it names', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { runs } = project(on, { 'package.json': '{ "devDependencies": { "jest": "^29" }, ', 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { editor: () => 0 })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await (await mount($)).press({ key: 'run' })
  await clock.advance(10)
  expect(runs.map(argv => argv.slice(0, 3).join(' '))).toEqual(['npx jest --coverage'])
})

test('a coverage report written outside the pane shows within one watch period, with no turn ending', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...JEST_PROJECT }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).not.toContain('82.5%')

  // a run from the shell writes the report
  files['coverage/coverage-summary.json'] = SUMMARY
  await clock.advance(2_000)
  expect(JSON.stringify(await ui.drawn())).toContain('82.5%')

  // a newer report replaces it
  files['coverage/coverage-summary.json'] = SUMMARY.replace('82.5', '91.3')
  await clock.advance(2_000)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('91.3%')
  expect(tree).not.toContain('82.5%')
})


// a Go module of two packages, and the profile a coverage run writes for it: pkg/a has 10 of
// its 10 statements covered, pkg/b 0 of 30; a block of a covered once of two runs counts once
const GO_MODULE: Record<string, string> = {
  'go.mod': 'module example.com/shop\n\ngo 1.22\n',
  'pkg/a/a_test.go': 'package a\n\nfunc TestA(t *testing.T) {}\n',
  'pkg/b/b_test.go': 'package b\n\nfunc TestB(t *testing.T) {}\n',
}
const GO_PROFILE = [
  'mode: set',
  'example.com/shop/pkg/a/a.go:3.14,5.2 4 1',
  'example.com/shop/pkg/a/a.go:7.14,9.2 6 0',
  'example.com/shop/pkg/a/a.go:7.14,9.2 6 1',
  'example.com/shop/pkg/b/b.go:3.14,9.2 30 0',
  '',
].join('\n')

test('a Go coverage run reads the profile it writes: statements weighted by each file\'s size, a block run twice counted once, and each folder\'s own figure', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GO_MODULE }
  const { notes, runs } = project(on, files, {
    editor: () => {
      files['.test-grader-go-cover.out'] = GO_PROFILE
      // per package, as go test prints it: their plain mean would be 50%
      return { stdout: 'ok  example.com/shop/pkg/a  coverage: 100.0% of statements\nok  example.com/shop/pkg/b  coverage: 0.0% of statements\n', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(runs).toEqual([['go', 'test', './...', '-cover', '-coverprofile=.test-grader-go-cover.out']])
  expect(notes).toEqual(['Coverage run (test-grader) finished: statements 25% (go test -coverprofile).\nLeast covered folders (statements): pkg/b/ 0%, pkg/ 25%.'])
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"100% statements"')
  expect(tree).toContain('"0% statements"')
  expect(tree).not.toContain('% lines')
})

test('a Go coverage run shows a statements bar for each package under the total, lowest first, and says how many it leaves out', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // ten packages: pkg/p0 has 0 of its 10 statements covered, pkg/p9 9; the root package all 10
  const files: Record<string, string> = { ...GO_MODULE }
  const blocks = Array.from({ length: 10 }, (_, i) => [
    `example.com/shop/pkg/p${i}/p.go:1.1,2.2 ${i} 1`,
    `example.com/shop/pkg/p${i}/p.go:3.1,4.2 ${10 - i} 0`,
  ]).flat()
  const { notes } = project(on, files, {
    editor: () => {
      files['.test-grader-go-cover.out'] = ['mode: set', 'example.com/shop/main.go:1.1,2.2 10 1', ...blocks, ''].join('\n')
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(notes[0]).toContain('statements 50% (go test -coverprofile)')
  // the words drawn, not the bars' blank cells
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim() !== '')
  // the total first, then the eight least covered packages, each with its own figure
  const at = texts.indexOf('Statements')
  expect(texts.slice(at, at + 2)).toEqual(['Statements', '50%'])
  const packages = texts.slice(at + 2).filter(t => /^pkg\/|^\.\/$/.test(t))
  expect(packages).toEqual(['pkg/p0/', 'pkg/p1/', 'pkg/p2/', 'pkg/p3/', 'pkg/p4/', 'pkg/p5/', 'pkg/p6/', 'pkg/p7/'])
  expect(texts).toContain('0%')
  expect(texts).toContain('70%')
  expect(texts).toContain('3 more packages, up to 100%')
  expect(texts).not.toContain('pkg/p9/')
})

test('a Go coverage run that wrote no profile falls back to the mean of the figures it printed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GO_MODULE }
  const { notes } = project(on, files, { editor: () => ({ stdout: 'ok  a  coverage: 40.0% of statements\nok  b  coverage: 60.0% of statements\n', exitCode: 0 }) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(notes).toEqual(['Coverage run (test-grader) finished: statements 50% (go test -cover).'])
})


// the coverage figures drawn, each label followed by its figure
const FIGURES = ['Lines', 'Statements', 'Branches', 'Functions']
const figuresDrawn = async (ui: Awaited<ReturnType<typeof mount>>): Promise<string[]> => {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim() !== '')
  return texts.flatMap((t, i) => (FIGURES.includes(t) ? [t, texts[i + 1]!] : []))
}

test('an lcov.info report shows its lines, branches and functions, and each folder its lines, a file named from the root or from the project alike', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // src/a/x.ts named by its full path: 9 of 10 lines; src/b/y.ts from the project: 3 of 10
  const lcov = 'SF:/proj/src/a/x.ts\nFNF:2\nFNH:2\nBRF:4\nBRH:1\nLF:10\nLH:9\nend_of_record\nSF:src/b/y.ts\nFNF:2\nFNH:1\nLF:10\nLH:3\nend_of_record\n'
  const files: Record<string, string> = {
    'src/a/x.test.ts': "it('x', () => { expect(x()).toBe(1) })\n",
    'src/b/y.test.ts': "it('y', () => { expect(y()).toBe(1) })\n",
    'coverage/lcov.info': lcov,
  }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)

  // lines 12 of 20, branches 1 of 4, functions 3 of 4; lcov has no statements
  expect(await figuresDrawn(ui)).toEqual(['Lines', '60%', 'Branches', '25%', 'Functions', '75%'])
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"90% lines"')
  expect(tree).toContain('"30% lines"')
})


test('a Cobertura coverage.xml from a pytest run shows its line and branch rates as lines and branches', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'pytest.ini': '[pytest]\n', 'tests/test_cart.py': 'def test_total():\n    assert total([2, 3]) == 5\n' }
  const { notes, runs } = project(on, files, {
    editor: () => {
      files['coverage.xml'] = '<?xml version="1.0" ?>\n<coverage version="7.4" line-rate="0.875" branch-rate="0.5" lines-valid="8" lines-covered="7">\n</coverage>\n'
      return 0
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  expect(runs).toEqual([['python3', '-m', 'pytest', '--cov', '--cov-report=xml']])
  expect(await figuresDrawn(ui)).toEqual(['Lines', '87.5%', 'Branches', '50%'])
  expect(notes).toEqual(['Coverage run (test-grader) finished: lines 87.5% · branches 50% (coverage.xml).'])
})


for (const marker of ['pytest.ini', 'pyproject.toml', 'setup.cfg']) {
  test(`a Python project marked by ${marker} measures its coverage with pytest --cov`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const { runs } = project(on, { [marker]: '', 'tests/test_cart.py': 'def test_total():\n    assert total([2, 3]) == 5\n' }, { editor: () => 0 })
    await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
    await (await mount($)).press({ key: 'run' })
    await clock.advance(10)
    expect(runs).toEqual([['python3', '-m', 'pytest', '--cov', '--cov-report=xml']])
  })
}


test('a package.json naming vitest runs vitest\'s coverage, ahead of jest it also names', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = { 'package.json': '{ "devDependencies": { "jest": "^29.0.0", "vitest": "^2.0.0" } }', 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }
  const { runs, notes } = project(on, files, { editor: () => ({ stdout: 'FAIL src/a.test.ts', exitCode: 1 }) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  expect(runs).toEqual([['npx', 'vitest', 'run', '--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=lcov']])
  expect(notes[0]!.split('\n')[0]).toBe('Coverage run (test-grader) failed: npx vitest run --coverage exited with 1. The last 1 lines it printed:')
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('Tests exited with 1.')
})


test('Run coverage in a project that has since lost its way to measure it runs nothing, and the pane says so', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...JEST_PROJECT }
  const { runs } = project(on, files, { editor: () => 0 })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  delete files['package.json']
  await ui.press({ key: 'run' })
  await clock.advance(10)

  expect(runs).toEqual([])
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('No coverage script, jest, vitest, pytest or Go project found here.')
})


test('a coverage command that cannot be started shows why in the pane, and can be run again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // a command the host will not start: the run rejects
  const { runs } = project(on, JEST_PROJECT, {
    editor: () => {
      throw new Error('spawn npx ENOENT')
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  const tried = runs.length
  expect(tried).toBeGreaterThan(0)

  // the reason is the host's own, whole: the error the command could not start with
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.filter(t => t.includes('spawn npx ENOENT'))).toHaveLength(1)
  expect(texts).not.toContain('Coverage run failed.')
  expect(buttonsOf(await ui.drawn()).get('run')).toBe('Run coverage')

  // pressed again, the command is tried again
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(runs.length).toBe(tried * 2)
})


test('Run coverage pressed again while a run is under way starts no second run', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // a jest project whose coverage run holds until it is let go
  let finish = () => {}
  const started: string[][] = []
  // the session, as the project helper answers it, with no process of its own
  on('session.start', async () => ({ cwd: '/proj' }) as never)
  on('session.cwd', async () => ({ value: '/proj' }) as never)
  on('command.register', async () => ({ value: {} }) as never)
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__test-grader__${(e as { name: string }).name}` } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('fs.stat', async (_$, e) => {
    if ((e as { path: string }).path !== '/proj/package.json') throw new Error('missing')
    return { value: { mtimeMs: 1, size: 1, isFile: true, isDirectory: false } } as never
  })
  on('fs.read', async () => ({ value: JEST_PROJECT['package.json'] }) as never)
  on('process.run', async (_$, e) => {
    const { argv } = e as { argv: string[] }
    if (argv[0] === 'git') return { value: { stdout: '', stderr: '', exitCode: 0 } } as never
    started.push(argv)
    await new Promise<void>(r => (finish = r))
    return { value: { stdout: '', stderr: '', exitCode: 0 } } as never
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  // the press lasts as long as the run
  const first = ui.press({ key: 'run' })
  await clock.advance(10)
  expect(started).toHaveLength(1)
  expect(buttonsOf(await ui.drawn()).get('run')).toBe('Running…')

  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(started).toHaveLength(1)

  // once it ends, the button runs again
  finish()
  await first
  expect(buttonsOf(await ui.drawn()).get('run')).toBe('Run coverage')
  const second = ui.press({ key: 'run' })
  await clock.advance(10)
  expect(started).toHaveLength(2)
  finish()
  await second
})

test('a session moved from a folder with no way to measure coverage to the project root offers Run coverage within one watch period', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the session opens in the coverage report's folder, which holds no package.json
  let where = '/proj/coverage'
  project(on, { 'package.json': '{ "scripts": { "coverage": "node scripts/coverage.mjs" } }', 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }, { cwd: () => where })
  await $.session.start({ source: 'startup', cwd: '/proj/coverage', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  expect(buttonsOf(await ui.drawn()).has('run')).toBe(false)

  where = '/proj'
  await clock.advance(2_000)
  expect(buttonsOf(await ui.drawn()).get('run')).toBe('Run coverage')
})
