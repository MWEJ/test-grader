import { expect, mock, test } from 'claude-code/testing'
import { mount, project, buttonsOf, nodesOf, appended, JEST_PROJECT, SUMMARY, jest } from './helpers'
import type { Engine, On } from './helpers'

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
      return { stdout: '--- PASS: TestA (0.00s)\nok  example.com/shop/pkg/a  coverage: 100.0% of statements\n--- PASS: TestB (0.00s)\nok  example.com/shop/pkg/b  coverage: 0.0% of statements\n', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(runs).toEqual([['go', 'test', './...', '-cover', '-coverprofile=.test-grader-go-cover.out', '-v']])
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
  expect(buttonsOf(await ui.drawn()).get('cov:packages')).toBe('▸ 3 more packages, up to 100%')
  expect(texts).not.toContain('pkg/p9/')
})

// a Go project of ten packages and a root one, its coverage run done and drawn
const runTenPackages = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GO_MODULE }
  const blocks = Array.from({ length: 10 }, (_, i) => [`example.com/shop/pkg/p${i}/p.go:1.1,2.2 ${i} 1`, `example.com/shop/pkg/p${i}/p.go:3.1,4.2 ${10 - i} 0`]).flat()
  project(on, files, {
    editor: () => {
      files['.test-grader-go-cover.out'] = ['mode: set', 'example.com/shop/main.go:1.1,2.2 10 1', ...blocks, ''].join('\n')
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  return ui
}
const packagesDrawn = async (ui: Awaited<ReturnType<typeof mount>>) => (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => /^pkg\/|^\.\/$/.test(t))

test('pressing the packages left out shows every package, lowest first, and pressing again only the eight', async ($, on) => {
  const ui = await runTenPackages($, on)
  await ui.press({ key: 'cov:packages' })
  expect(await packagesDrawn(ui)).toEqual(['pkg/p0/', 'pkg/p1/', 'pkg/p2/', 'pkg/p3/', 'pkg/p4/', 'pkg/p5/', 'pkg/p6/', 'pkg/p7/', 'pkg/p8/', 'pkg/p9/', './'])
  expect(buttonsOf(await ui.drawn()).get('cov:packages')).toBe('▾ the 8 least covered only')

  await ui.press({ key: 'cov:packages' })
  expect(await packagesDrawn(ui)).toHaveLength(8)
  expect(buttonsOf(await ui.drawn()).get('cov:packages')).toBe('▸ 3 more packages, up to 100%')
})

test('a Go coverage run that wrote no profile falls back to the mean of the figures it printed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GO_MODULE }
  const { notes } = project(on, files, { editor: () => ({ stdout: '--- PASS: TestA (0.00s)\nok  example.com/shop/pkg/a  coverage: 40.0% of statements\n--- PASS: TestB (0.00s)\nok  example.com/shop/pkg/b  coverage: 60.0% of statements\n', exitCode: 0 }) })
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

// a project whose coverage script is in its root, and one test file
const SCRIPTED = { 'package.json': '{ "scripts": { "coverage": "node scripts/coverage.mjs" } }', 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }

test('a session that moves into a subfolder keeps the folder it started in: its coverage run and its tests', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let where = '/proj'
  const { prompts } = project(on, SCRIPTED, { cwd: () => where })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  where = '/proj/src'
  await clock.advance(2_000)
  expect(buttonsOf(await ui.drawn()).get('run')).toBe('Run coverage')
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts.map(p => p.match(/Test file: (\S+)/)?.[1])).toEqual(['/proj/src/a.test.ts'])

  // a reload of the mod starts the same session again: still the folder it started in
  await $.session.start({ source: 'startup', cwd: '/proj/src', surface: null, isInteractive: true } as never)
  expect(buttonsOf(await ui.drawn()).get('run')).toBe('Run coverage')
})

test('a new session takes the folder it starts in, not the last one\'s', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let where = '/proj'
  const { session } = project(on, SCRIPTED, { cwd: () => where })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  expect(buttonsOf(await ui.drawn()).get('run')).toBe('Run coverage')

  // started in the report's folder, which holds no package.json: no coverage run to offer
  session.id = 's2'
  where = '/proj/coverage'
  await $.session.start({ source: 'startup', cwd: '/proj/coverage', surface: null, isInteractive: true } as never)
  expect(buttonsOf(await ui.drawn()).has('run')).toBe(false)
})


// Claude's coverage tool: a run waited for, answered with a folder's figure before and after
const askCoverage = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, path?: string) => {
  const answer = $.tool.call({ tool: 'mcp__test-grader__test_coverage', ...(path === undefined ? {} : { path }) } as never)
  await clock.advance(10)
  return String((await answer).result)
}
const PROFILE = '.test-grader-go-cover.out'

test("test_coverage on a Go folder runs that folder's packages alone and keeps the rest of the module's last figures", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the last whole run: pkg/a 10 of 10, pkg/b 0 of 30
  const files: Record<string, string> = { ...GO_MODULE, [PROFILE]: GO_PROFILE }
  const { runs } = project(on, files, {
    editor: () => {
      // the folder's run: its profile holds pkg/b alone, now 10 of its 30 covered
      files[PROFILE] = ['mode: set', 'example.com/shop/pkg/b/b.go:3.14,5.2 10 1', 'example.com/shop/pkg/b/b.go:6.1,9.2 20 0', ''].join('\n')
      return { stdout: 'ok  example.com/shop/pkg/b  coverage: 33.3% of statements\n', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await askCoverage($, clock, 'pkg/b/')
  expect(runs).toEqual([['go', 'test', './pkg/b/...', '-cover', `-coverprofile=${PROFILE}`, '-v']])
  expect(answer).toContain('pkg/b/: 33.3% statements, was 0%.')
  // pkg/a's 10 covered statements are kept from the last run: 20 of 40
  expect(answer).toContain('The project: 50% statements, was 25%.')
  expect(files[PROFILE]).toContain('example.com/shop/pkg/a/a.go:3.14,5.2 4 1')
  expect(files[PROFILE]).not.toContain('example.com/shop/pkg/b/b.go:3.14,9.2 30 0')
})

test("test_coverage on a folder of a jest project runs the whole coverage and answers with the folder's figure and its least covered folders", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const lcov = (a: number) => `SF:src/a/x.ts\nLF:10\nLH:${a}\nend_of_record\nSF:src/a/deep/z.ts\nLF:10\nLH:2\nend_of_record\nSF:src/b/y.ts\nLF:10\nLH:3\nend_of_record\n`
  const files: Record<string, string> = { ...JEST_PROJECT, 'coverage/lcov.info': lcov(5) }
  const { runs } = project(on, files, {
    editor: () => {
      files['coverage/lcov.info'] = lcov(9)
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await askCoverage($, clock, '/proj/src/a')
  expect(runs.map(argv => argv.slice(0, 3).join(' '))).toEqual(['npx jest --coverage'])
  expect(answer).toContain('src/a/: 55% lines, was 35%.')
  expect(answer).toContain('The project: 46.7% lines, was 33.3%.')
  // the folders under it alone, not src/b
  expect(answer).toContain('Least covered folders in src/a/ (lines): src/a/deep/ 20% (2 of 10).')
  expect(answer).not.toContain('src/b/')
})

test('test_coverage says when a folder has no measured code, and runs nothing for a path outside the project', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...JEST_PROJECT }
  const { runs } = project(on, files, {
    editor: () => {
      files['coverage/lcov.info'] = 'SF:src/a/x.ts\nLF:10\nLH:9\nend_of_record\n'
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  expect(await askCoverage($, clock, '/elsewhere')).toBe('/elsewhere is outside the project (/proj).')
  expect(runs).toEqual([])
  expect(await askCoverage($, clock, 'docs')).toContain('docs/ has no figure in the report: none of its code was measured.')
})

test('test_coverage whose tests fail gives the figures of what ran and the end of what it printed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...JEST_PROJECT }
  project(on, files, {
    editor: () => {
      files['coverage/lcov.info'] = 'SF:src/a/x.ts\nLF:10\nLH:4\nend_of_record\n'
      // thirty lines of setup before the failure: only the last twenty are kept
      return { stdout: [...Array.from({ length: 30 }, (_, i) => `setup ${i + 1}`), 'FAIL src/a.test.ts', '  ● adds › expected 3, got 4'].join('\n'), exitCode: 1 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)

  const answer = await askCoverage($, clock)
  expect(answer).toContain('It exited with 1: the figures are from the tests that ran.')
  expect(answer).toContain('The project: 40% lines.')
  const printed = answer.slice(answer.indexOf('The last 20 lines it printed:\n') + 'The last 20 lines it printed:\n'.length).split('\n')
  expect(printed).toEqual([...Array.from({ length: 18 }, (_, i) => `setup ${i + 13}`), 'FAIL src/a.test.ts', '  ● adds › expected 3, got 4'])
  expect(JSON.stringify(await ui.drawn())).toContain('Tests exited with 1: the figures are from the tests that ran.')
})


// a project of two parts, each measured on its own: a Go backend/ and a jest mobile/
const PARTS: Record<string, string> = {
  'backend/go.mod': 'module example.com/shop\n\ngo 1.22\n',
  'backend/pkg/a/a_test.go': 'package a\n\nfunc TestA(t *testing.T) {}\n',
  'backend/pkg/b/b_test.go': 'package b\n\nfunc TestB(t *testing.T) {}\n',
  'mobile/package.json': '{ "devDependencies": { "jest": "^29.0.0" } }',
  'mobile/src/x.test.ts': "it('x', () => { expect(x()).toBe(1) })\n",
}
// each part's run writes its own report: pkg/a 10 of 10 and pkg/b 0 of 30 statements; mobile 6 of 10 lines
const partsRun = (files: Record<string, string>) => (argv: string[]) => {
  if (argv[0] === 'go') {
    files['backend/.test-grader-go-cover.out'] = argv[2] === './...' ? ['mode: set', 'example.com/shop/pkg/a/a.go:1.1,2.2 10 1', 'example.com/shop/pkg/b/b.go:1.1,2.2 30 0', ''].join('\n') : ['mode: set', 'example.com/shop/pkg/b/b.go:1.1,2.2 30 1', ''].join('\n')
  } else files['mobile/coverage/lcov.info'] = 'SF:src/x.ts\nLF:10\nLH:6\nend_of_record\n'
  return { stdout: '', exitCode: 0 }
}

test('a project of parts with no way to measure at its root runs each part\'s coverage, and shows each part\'s figures under its folder', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...PARTS }
  const { runs, notes } = project(on, files, { editor: partsRun(files) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  expect(buttonsOf(await ui.drawn()).get('run')).toBe('Run coverage')
  await ui.press({ key: 'run' })
  await clock.advance(10)

  expect(runs.map(argv => argv.slice(0, 3).join(' ')).sort()).toEqual(['go test ./...', 'npx jest --coverage'])
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  // each part's packages under its own figures, named within it
  const backendAt = texts.indexOf('backend/ · go test -coverprofile')
  const mobileAt = texts.indexOf('mobile/ · lcov.info')
  expect(backendAt).toBeGreaterThanOrEqual(0)
  expect(mobileAt).toBeGreaterThan(backendAt)
  const packageAt = (name: string) => texts.indexOf(name)
  expect(packageAt('pkg/b/')).toBeGreaterThan(backendAt)
  expect(packageAt('pkg/b/')).toBeLessThan(mobileAt)
  expect(texts).not.toContain('backend/pkg/b/')
  // each folder's figure in its part's kind
  expect(texts).toContain('25% statements')
  expect(texts).toContain('60% lines')
  expect(notes.at(-1)).toContain('backend/ statements 25% (go test -coverprofile); mobile/ lines 60% (lcov.info)')
})

test("a part's packages left out show at a press, their bars in line with the part's figures, the heading naming only the age", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...PARTS }
  const blocks = Array.from({ length: 10 }, (_, i) => `example.com/shop/cmd/generate-image-${i}/m.go:1.1,2.2 10 ${i % 2}`)
  project(on, files, {
    editor: (argv: string[]) => {
      if (argv[0] === 'go') files['backend/.test-grader-go-cover.out'] = ['mode: set', ...blocks, ''].join('\n')
      else files['mobile/coverage/lcov.info'] = 'SF:src/x.ts\nLF:10\nLH:6\nend_of_record\n'
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  const named = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.startsWith('cmd/'))
  expect(await named()).toHaveLength(8)
  await ui.press({ key: 'cov:packages:backend' })
  expect(await named()).toHaveLength(10)
  // the label column of a package and of the part's figure is one width, so the bars start in line
  const widthOf = (label: string) => {
    const box = nodesOf(tree).find(n => n.type === 'Box' && n.props?.width !== undefined && JSON.stringify(n.children ?? []).includes(JSON.stringify(label)))
    return box?.props?.width
  }
  const tree = await ui.drawn()
  expect(widthOf('cmd/generate-image-0/')).toBe(widthOf('Statements'))
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  // each part names its source under its own heading: the pane's heading is followed by the age alone
  expect(texts[texts.indexOf('Coverage') + 1]).toBe('0m ago')
})


test('test_coverage on a folder of a part runs that part alone, a Go folder by its packages, and answers with the part\'s figure', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...PARTS }
  const { runs } = project(on, files, { editor: partsRun(files) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await askCoverage($, clock)
  runs.length = 0

  const answer = await askCoverage($, clock, 'backend/pkg/b')
  expect(runs).toEqual([['go', 'test', './pkg/b/...', '-cover', `-coverprofile=${PROFILE}`, '-v']])
  expect(answer).toContain('backend/pkg/b/: 100% statements, was 0%.')
  expect(answer).toContain('backend/: 100% statements, was 25%.')
  expect(answer).not.toContain('mobile/')
})

test('test_coverage on a folder no part measures runs nothing and names the parts that are measured', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...PARTS, 'docs/a.test.ts': "it('d', () => { expect(d()).toBe(1) })\n" }
  const { runs } = project(on, files, { editor: partsRun(files) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  expect(await askCoverage($, clock, 'docs')).toBe('Coverage could not be measured: No part of the project measures docs/: coverage is measured in backend/, mobile/.')
  expect(runs).toEqual([])
})


test('a Go coverage run whose tests fail still gives the figures it left, naming the failed packages, and the pane warns', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GO_MODULE }
  const { notes } = project(on, files, {
    editor: () => {
      files['.test-grader-go-cover.out'] = GO_PROFILE
      return { stdout: '--- PASS: TestA (0.00s)\nok  \texample.com/shop/pkg/a\t0.1s\n--- FAIL: TestB (0.00s)\nFAIL\nFAIL\texample.com/shop/pkg/b\t0.2s\nFAIL\n', exitCode: 1 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  expect(notes).toEqual(['Coverage run (test-grader) finished with failing tests (go test ./... -coverprofile exited with 1): statements 25% (go test -coverprofile). The figures are from the tests that ran.\nFailed: example.com/shop/pkg/b.'])
  const warning = (await ui.findAll({ type: 'Text' })).find(t => t.text === 'Tests exited with 1: the figures are from the tests that ran.')
  expect(warning?.props?.color).toBe('#fbbf24')
})

test('coverage leaves out the files the project\'s ignore list names, in the totals and the packages', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // pkg/a 10 of 10 covered; tmp/scratch 0 of 30, ignored
  const profile = ['mode: set', 'example.com/shop/pkg/a/a.go:1.1,2.2 10 1', 'example.com/shop/tmp/scratch/s.go:1.1,2.2 30 0', 'example.com/shop/pkg/b/b.go:1.1,2.2 10 0', ''].join('\n')
  const files: Record<string, string> = { ...GO_MODULE, '.test-grader-ignore': 'tmp/\n' }
  const { notes } = project(on, files, {
    editor: () => {
      files['.test-grader-go-cover.out'] = profile
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  expect(notes[0]).toContain('statements 50% (go test -coverprofile)')
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('pkg/b/')
  expect(texts).not.toContain('tmp/scratch/')
})


// A Go module whose pkg/store test go test ./... runs none of: its TestMain leaves before
// running a test
const UNRUN_MODULE: Record<string, string> = {
  'go.mod': 'module example.com/shop\n\ngo 1.22\n',
  'pkg/a/a_test.go': 'package a\n\nfunc TestA(t *testing.T) {\n\tif a() != 1 {\n\t\tt.Fatal("a")\n\t}\n}\n',
  'pkg/store/store_test.go': 'package store\n\nfunc TestStore(t *testing.T) {\n\tif store() != 1 {\n\t\tt.Fatal("store")\n\t}\n}\n',
}
const UNRUN_RUN = '=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\nok  \texample.com/shop/pkg/a\t0.01s\tcoverage: 100.0% of statements\nok  \texample.com/shop/pkg/store\t0.01s [no tests to run]\n'
// the same, its store test behind the integration build tag: go test ./... compiles it out
const TAGGED_MODULE: Record<string, string> = { ...UNRUN_MODULE, 'pkg/store/store_test.go': `//go:build integration\n\n${UNRUN_MODULE['pkg/store/store_test.go']}` }
const TAGGED_RUN = '=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\nok  \texample.com/shop/pkg/a\t0.01s\tcoverage: 100.0% of statements\n?   \texample.com/shop/pkg/store\t[no test files]\n'

test('a coverage run marks the graded tests it never ran: in the pane, in test_grades and in its note to Claude', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...UNRUN_MODULE }
  const { notes } = project(on, files, { editor: () => ({ stdout: UNRUN_RUN, exitCode: 0 }) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  expect(notes.at(-1)).toContain('\nOf the graded tests this run reached, 1 never ran: their grades say nothing of whether they pass. In pkg/store/store_test.go (1). test_grades with ran: "never ran" lists them.')
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('The last coverage run (0m ago): 1 never ran')
  // the row of the test that never ran says so, the one that ran does not: both folders opened
  await ui.press({ key: 'd:pkg/a' })
  await ui.press({ key: 'd:pkg/store' })
  const rows = nodesOf(await ui.drawn()).filter(n => n.type === 'Box' && String(n.props?.key ?? '').startsWith('row-r:'))
  const marked = rows.filter(r => JSON.stringify(r).includes('"never ran"')).map(r => String(r.props?.key))
  expect(rows).toHaveLength(2)
  expect(marked).toEqual(['row-r:/proj/pkg/store/store_test.go:TestStore'])
  const listed = await $.tool.call({ tool: 'mcp__test-grader__test_grades', ran: 'never ran' } as never).then(r => String((r as { result: unknown }).result))
  expect(listed).toContain('Never run by the last coverage run, worst first:\n- pkg/store/store_test.go:3 "TestStore": ungraded (never ran)')
  expect(listed).not.toContain('TestA')
})

test('the tests a coverage run ran outlive the session, in a file of test-grader\'s own', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...UNRUN_MODULE }
  const dir = '/home/u/.claude/test-grader/ran/-proj'
  files[`${dir}/ran.json`] = JSON.stringify({ at: 400_000, measured: ['/proj'], by: { '/proj/pkg/a': { TestA: 'passed' } } })
  project(on, files, { env: { HOME: '/home/u' } })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)

  const answer = await $.tool.call({ tool: 'mcp__test-grader__test_grades', verdicts: ['ungraded'] } as never).then(r => String((r as { result: unknown }).result))
  expect(answer).toContain('\nThe last coverage run (10m ago): 1 never ran: test_grades with ran lists them.')
  expect(answer).toContain('"TestStore": ungraded (never ran)')
  expect(answer).toContain('"TestA": ungraded\n')
})

test('a test behind a build tag the coverage run was not given is not built, told apart from one that never ran, and runs once .test-grader-env gives the tag', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...TAGGED_MODULE }
  const { notes, runs } = project(on, files, {
    editor: (argv, env) => ({ stdout: env?.GOFLAGS === '-tags=integration -p=1' ? TAGGED_RUN.replace('?   \texample.com/shop/pkg/store\t[no test files]', '--- PASS: TestStore (0.00s)\nok  \texample.com/shop/pkg/store\t0.01s') : TAGGED_RUN, exitCode: 0 }),
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  expect(notes.at(-1)).toContain('\n1 graded test is in files with a build tag the run was not given (integration), so it was not compiled: the coverage command leaves that tag out, which says nothing of the tests. To measure them too, put GOFLAGS="-tags=integration -p=1" in .test-grader-env')
  expect(notes.at(-1)).not.toContain('never ran')
  // the line is muted, not the amber of a test that should have run
  const line = (await ui.findAll({ type: 'Text' })).find(t => t.text === 'The last coverage run (0m ago): 1 not built (no -tags integration)')
  expect(line?.props?.color).toBe('#8b90a0')
  const listed = await $.tool.call({ tool: 'mcp__test-grader__test_grades', ran: 'not built' } as never).then(r => String((r as { result: unknown }).result))
  expect(listed).toContain('- pkg/store/store_test.go:5 "TestStore": ungraded (integration, not built)')
  expect(listed).not.toContain('TestA')

  // with the tag given through the project's run variables, the test runs
  files['.test-grader-env'] = 'GOFLAGS="-tags=integration -p=1"\n'
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(runs).toHaveLength(2)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.startsWith('The last coverage run'))).toEqual([])
})

test('a Go total measured with build tags names them beside its figures, and one measured without names none', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...TAGGED_MODULE }
  const { notes } = project(on, files, {
    editor: () => {
      files['.test-grader-go-cover.out'] = ['mode: set', 'example.com/shop/pkg/a/a.go:1.1,2.2 10 1', ''].join('\n')
      return { stdout: TAGGED_RUN, exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(notes.at(-1)).toContain('statements 100% (go test -coverprofile).')

  files['.test-grader-env'] = 'GOFLAGS="-tags=integration -p=1"\n'
  await ui.press({ key: 'run' })
  await clock.advance(10)
  expect(notes.at(-1)).toContain('statements 100% (go test -coverprofile -tags=integration).')
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('go test -coverprofile -tags=integration – 0m ago')
})

// a module whose total is held down by code no test is meant for, and by a package whose tests
// the run did not build: pkg/a 9 of 10 tested; pkg/store 1 of 40, its test behind a tag; cmd/seed
// 0 of 30, a command; internal/mocks 0 of 20, a helper
const MIXED_MODULE: Record<string, string> = {
  ...TAGGED_MODULE,
  'pkg/a/a.go': 'package a\n\nfunc a() int { return 1 }\n',
  'pkg/store/store.go': 'package store\n\nfunc store() int { return 1 }\n',
  'cmd/seed/main.go': 'package main\n\nfunc main() {}\n',
  'internal/mocks/store.go': 'package mocks\n\nimport "github.com/stretchr/testify/mock"\n',
}
const MIXED_PROFILE = ['mode: set', 'example.com/shop/pkg/a/a.go:1.1,2.2 9 1', 'example.com/shop/pkg/a/a.go:3.1,4.2 1 0', 'example.com/shop/pkg/store/store.go:1.1,2.2 1 1', 'example.com/shop/pkg/store/store.go:3.1,4.2 39 0', 'example.com/shop/cmd/seed/main.go:1.1,2.2 30 0', 'example.com/shop/internal/mocks/store.go:1.1,2.2 20 0', ''].join('\n')

test('a Go coverage run says which packages hold its total down without wanting tests: the pane and its note name them, and the figure over tested packages', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...MIXED_MODULE }
  const { notes } = project(on, files, {
    editor: () => {
      files['.test-grader-go-cover.out'] = MIXED_PROFILE
      return { stdout: TAGGED_RUN, exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  // the bars' cells are texts of spaces, passed over
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim() !== '')
  // the tested package first, its figure its own; the one not built after it, muted and named for
  // what it is; the command and the helper on one line after them, drawn as no bars
  const at = (name: string) => texts.indexOf(name)
  const aside = '1 command with no tests and 1 test helper: not code a test is meant for, left out of the tested figure'
  expect(at('pkg/a/')).toBeGreaterThanOrEqual(0)
  expect(at('pkg/a/')).toBeLessThan(at('pkg/store/'))
  expect(at('pkg/store/')).toBeLessThan(at(aside))
  expect([at('cmd/seed/'), at('internal/mocks/')]).toEqual([-1, -1])
  expect(texts[at('pkg/store/') + 1]).toBe('2.5%')
  expect(texts[at('pkg/store/') + 2]).toBe('unmeasured: its 1 test not built')
  const figure = (await ui.findAll({ type: 'Text' })).find(t => t.text === '2.5%')
  expect(figure?.props?.color).toBe('#8b90a0')
  const tested = '90% over the 1 package whose tests ran (median package 90%); the total also counts 1 command (package main) with no tests, 1 test helper, 1 package whose 1 test was not built (unmeasured, not low).'
  expect(texts).toContain(tested)
  // Claude's note gives the same, and ranks no folder by packages that want no tests: pkg/ is
  // pkg/a's 90% once pkg/store is left out, not 20%
  expect(notes.at(-1)).toContain(`statements 10% (go test -coverprofile).\n${tested}`)
  expect(notes.at(-1)).not.toContain('Least covered folders')
})

test('a package whose figure has a note is drawn with grey cells, however much of it ran; a plain one in its figure\'s colour', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...MIXED_MODULE }
  // pkg/store 30 of 40 run, its own test not built: 75%, not a figure to read as good or bad
  const profile = MIXED_PROFILE.replace('pkg/store/store.go:3.1,4.2 39 0', 'pkg/store/store.go:3.1,4.2 29 1\nexample.com/shop/pkg/store/store.go:5.1,6.2 10 0')
  project(on, files, {
    editor: () => {
      files['.test-grader-go-cover.out'] = profile
      return { stdout: TAGGED_RUN, exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  // the filled cells of a package's bar, by their colour; the empty track left out
  const tree = await ui.drawn()
  const cells = (key: string) =>
    nodesOf(nodesOf(tree).find(n => n.props?.key === key))
      .filter(n => n.type === 'Text' && typeof n.props?.backgroundColor === 'string' && n.props.backgroundColor !== '#343848')
      .map(n => n.props!.backgroundColor)
  expect(cells('cov-pkg-pkg/store/')).toEqual(['#8b90a0'])
  expect(cells('cov-pkg-pkg/a/')).toHaveLength(1)
  expect(cells('cov-pkg-pkg/a/')).not.toEqual(['#8b90a0'])
})

test("a Go total leaves out generated files, a part's gitignored folders and its own ignore list, and treats a folder named as test code as a helper", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {
    ...PARTS,
    'backend/.gitignore': 'tmp/\n!keep/\n',
    'backend/.test-grader-ignore': 'scratch/\n',
    'backend/internal/mocks/store.go': '// Code generated by mockery v2.42.0. DO NOT EDIT.\n\npackage mocks\n',
    'backend/internal/mocks/hand.go': 'package mocks\n',
    'backend/internal/receipttest/r.go': 'package receipttest\n',
  }
  // pkg/a 10 of 10, pkg/b 0 of 30; tmp/ 50 and scratch/ 40 ignored; 100 of mocks generated, 20 hand
  // written; receipttest 5 of 10, run but a helper
  const blocks = ['example.com/shop/pkg/a/a.go:1.1,2.2 10 1', 'example.com/shop/pkg/b/b.go:1.1,2.2 30 0', 'example.com/shop/tmp/audit/main.go:1.1,2.2 50 0', 'example.com/shop/scratch/x.go:1.1,2.2 40 0', 'example.com/shop/internal/mocks/store.go:1.1,2.2 100 0', 'example.com/shop/internal/mocks/hand.go:1.1,2.2 20 0', 'example.com/shop/internal/receipttest/r.go:1.1,2.2 5 1', 'example.com/shop/internal/receipttest/r.go:3.1,4.2 5 0']
  const { notes } = project(on, files, {
    editor: (argv: string[]) => {
      if (argv[0] === 'go') files['backend/.test-grader-go-cover.out'] = ['mode: set', ...blocks, ''].join('\n')
      else files['mobile/coverage/lcov.info'] = 'SF:src/x.ts\nLF:10\nLH:6\nend_of_record\n'
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  // 15 of 70: pkg/a, pkg/b, the hand-written mock and receipttest
  expect(notes.at(-1)).toContain('backend/ statements 21.4% (go test -coverprofile)')
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim() !== '')
  expect(texts.filter(t => /^(tmp|scratch)\//.test(t))).toEqual([])
  // the hand-written mocks and receipttest, run or not, are counted as helpers, not drawn as packages
  expect(texts.filter(t => /^internal\/(mocks|receipttest)\//.test(t))).toEqual([])
  expect(texts).toContain('2 test helpers: not code a test is meant for, left out of the tested figure')
})

for (const list of ['.gitignore', '.test-grader-ignore']) {
  test(`a root ${list} rule with no slash before its end leaves a part's folder of that name out at any depth`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = { ...PARTS, [list]: 'tmp/\n' }
    // pkg/a 10 of 10; backend/tmp, backend/tmp/coverage-audit and the deeper backend/pkg/tmp 0 of
    // 110, all ignored: a rule anchored to the part's root would leave pkg/tmp in, at 8.3%
    const { notes } = project(on, files, {
      editor: (argv: string[]) => {
        if (argv[0] === 'go') files['backend/.test-grader-go-cover.out'] = ['mode: set', 'example.com/shop/pkg/a/a.go:1.1,2.2 10 1', 'example.com/shop/tmp/test_fs.go:1.1,2.2 40 0', 'example.com/shop/tmp/coverage-audit/main.go:1.1,2.2 50 0', 'example.com/shop/pkg/tmp/t.go:1.1,2.2 20 0', ''].join('\n')
        else files['mobile/coverage/lcov.info'] = 'SF:src/x.ts\nLF:10\nLH:6\nend_of_record\n'
        return { stdout: '', exitCode: 0 }
      },
    })
    await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
    const ui = await mount($)
    await ui.press({ key: 'run' })
    await clock.advance(10)
    expect(notes.at(-1)).toContain('backend/ statements 100% (go test -coverprofile)')
  })
}

test('a project of parts that each counted statements shows the whole project\'s, their counts added up, above the parts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...PARTS }
  // backend 10 of 40 statements; mobile 12 of 20: 22 of 60 in all, not the 42.5% the two figures' mean would give
  const { notes } = project(on, files, {
    editor: (argv: string[]) => {
      if (argv[0] === 'go') files['backend/.test-grader-go-cover.out'] = ['mode: set', 'example.com/shop/pkg/a/a.go:1.1,2.2 10 1', 'example.com/shop/pkg/b/b.go:1.1,2.2 30 0', ''].join('\n')
      else files['mobile/coverage/coverage-summary.json'] = JSON.stringify({ total: { lines: { pct: 60, total: 10, covered: 6 }, statements: { pct: 60, total: 20, covered: 12 }, branches: { pct: 50 }, functions: { pct: 50 } } })
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  // the bars' cells are texts of spaces, passed over
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim() !== '')
  const wholeAt = texts.indexOf('All statements')
  expect(texts[wholeAt + 1]).toBe('36.7%')
  expect(wholeAt).toBeLessThan(texts.indexOf('backend/ · go test -coverprofile'))
  expect(notes.at(-1)).toContain('finished: the whole project 36.7% of statements (its parts\' added up); backend/ statements 25%')
  const answer = await $.tool.call({ tool: 'mcp__test-grader__test_coverage' } as never).then(r => String((r as { result: unknown }).result))
  expect(answer).toContain('The whole project: 36.7% of statements, its parts\' added up.')
})

test('a project of parts one of which counted no statements shows no whole-project figure', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...PARTS }
  project(on, files, { editor: partsRun(files) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'run' })
  await clock.advance(10)
  // the bars' cells are texts of spaces, passed over
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim() !== '')
  expect(texts).toContain('backend/ · go test -coverprofile')
  expect(texts).not.toContain('All statements')
})

test("a Go profile half written by a run under way is not drawn: the pane keeps the last figures, said to be the previous run's, until the run ends", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...GO_MODULE, '.test-grader-go-cover.out': ['mode: set', 'example.com/shop/pkg/a/a.go:1.1,2.2 10 1', 'example.com/shop/pkg/b/b.go:1.1,2.2 10 1', ''].join('\n') }
  let finish = () => {}
  project(on, files, {
    editor: async () => {
      // the first package done, pkg/a now 0 of 10; pkg/b not yet reached
      files['.test-grader-go-cover.out'] = ['mode: set', 'example.com/shop/pkg/a/a.go:1.1,2.2 10 0', ''].join('\n')
      await new Promise<void>(r => (finish = r))
      files['.test-grader-go-cover.out'] = ['mode: set', 'example.com/shop/pkg/a/a.go:1.1,2.2 10 0', 'example.com/shop/pkg/b/b.go:1.1,2.2 10 1', ''].join('\n')
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)
  const statements = async () => {
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim() !== '')
    return texts[texts.indexOf('Statements') + 1]
  }
  expect(await statements()).toBe('100%')

  const pressed = ui.press({ key: 'run' })
  // three watch periods while the run holds: the half-written profile's 0% is not drawn
  await clock.advance(6_500)
  expect(await statements()).toBe('100%')
  const isPrevious = async () => (await ui.findAll({ type: 'Text' })).some(t => t.text.startsWith('previous run, a new one under way'))
  expect(await isPrevious()).toBe(true)

  finish()
  await pressed
  await clock.advance(10)
  expect(await statements()).toBe('50%')
  expect(await isPrevious()).toBe(false)
})

test('a Jest coverage run reports which tests it ran, in a file of test-grader\'s own, and a skipped test is told apart', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {
    'package.json': '{ "devDependencies": { "jest": "^29.0.0" } }',
    'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit.skip('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n",
    'e2e/login.test.ts': "import { test } from '@playwright/test'\ntest('logs in', async () => { expect(await login()).toBe(true) })\n",
  }
  const { runs } = project(on, files, {
    env: { HOME: '/home/u' },
    editor: argv => {
      const out = argv.find(a => a.startsWith('--outputFile='))?.slice('--outputFile='.length)
      if (out) files[out] = JSON.stringify({ testResults: [{ name: '/proj/src/a.test.ts', assertionResults: [{ title: 'adds', status: 'passed' }, { title: 'subtracts', status: 'pending' }] }] })
      return { stdout: '', exitCode: 0 }
    },
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)
  await ui.press({ key: 'run' })
  await clock.advance(10)

  expect(runs.at(-1)!.slice(-2)).toEqual(['--json', '--outputFile=/home/u/.claude/test-grader/ran/-proj/root.results.json'])
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('The last coverage run (0m ago): 1 never ran · 1 skipped')
  expect(texts).toContain('Layers: 2 unit · 0 integration · 1 end-to-end')
  const skipped = await $.tool.call({ tool: 'mcp__test-grader__test_grades', ran: 'skipped' } as never).then(r => String((r as { result: unknown }).result))
  expect(skipped).toContain('- src/a.test.ts:2 "subtracts": ungraded (skipped)')
  expect(skipped).not.toContain('logs in')
})

test('a project\'s .test-grader-layers names a layer its paths do not show, and test_grades narrows to a layer', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {
    '.test-grader-layers': '# the sqlite tests start a real database\nintegration: **/*.sqlite.test.ts\nnot a rule\n',
    'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
    'src/store.sqlite.test.ts': "it('saves', () => { expect(save(1)).toBe(1) })\n",
  }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)

  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('Layers: 1 unit · 1 integration · 0 end-to-end')
  const answer = await $.tool.call({ tool: 'mcp__test-grader__test_grades', verdicts: ['ungraded'], layer: 'integration' } as never).then(r => String((r as { result: unknown }).result))
  expect(answer).toContain('1 tests of the integration layer: 0 strong, 1 never graded.')
  expect(answer).toContain('"saves": ungraded (integration)')
  expect(answer).not.toContain('"adds"')
})

test('a pane whose drawing the engine would refuse whole says why in red, in place of the engine\'s blank placeholder', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // 2,500 packages, each a bar once every package is shown: past the engine's 20,000 elements
  const profile = ['mode: set', ...Array.from({ length: 2500 }, (_, i) => `example.com/shop/pkg/p${i}/a.go:3.14,5.2 4 ${i % 2}`), ''].join('\n')
  const files: Record<string, string> = { 'go.mod': 'module example.com/shop\n\ngo 1.22\n', 'pkg/p0/a_test.go': 'package p0\n\nfunc TestA(t *testing.T) {}\n', '.test-grader-go-cover.out': profile }
  const { logs } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('Coverage')

  await ui.press({ key: 'cov:packages' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toEqual(['test-grader could not draw this pane: more than 20000 elements. Please report it; /test-grader reset-view closes every row and clears the runs shown, and the tools still work.'])
  expect(logs).toContain("test-grader: the pane's drawing would be refused: more than 20000 elements")
  // reset-view closes the list again, and the pane draws
  await $.command.run({ command: 'test-grader', args: 'reset-view' } as never)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('Coverage')
})
