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
