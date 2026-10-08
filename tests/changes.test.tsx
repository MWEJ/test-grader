import { expect, mock, test } from 'claude-code/testing'
import { mount, project, ok, SUM_BEFORE, SUM_AFTER, TURN, askGrades, ASKED } from './helpers'

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
  expect(tree).toContain('1 test · 1 strong · 1 new')
})


test('a shallow test the session edits is graded again, and its new verdict replaces the old', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const before = "it('a shallow check', () => { expect(f).toBeDefined() })\n"
  const after = "it('a shallow check', () => { expect(f()).toBe(3) })\n"
  const files: Record<string, string> = { 'src/more.test.ts': before }
  // shallow while the file still holds the shallow assertion, strong once it is gone
  const { prompts } = project(on, files, { rule: (_name, prompt) => (prompt.includes('toBeDefined()') ? 'shallow' : 'strong') })
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('1 test · 0 strong · 1 shallow')

  files['src/more.test.ts'] = after
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/more.test.ts', old_string: before, new_string: after } as never)
  await clock.advance(10)

  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('["a shallow check"]')
  const tree = JSON.stringify(await ui.drawn())
  // an edit to a test already there is no new test
  expect(tree).toContain('1 test · 1 strong · 1 modified"')
})


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
  expect(tree).toContain('2 tests · 2 strong · 1 new')
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


// The pane follows the files as they change, not only at a turn's end
test('a listed test file changed by other means shows its new tests within one watch period, with no turn ending', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/c.test.ts': SUM_BEFORE }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(JSON.stringify(await ui.drawn())).toContain('"a shallow check"')
  files['src/c.test.ts'] = SUM_AFTER
  await clock.advance(2_000)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toContain('"a shallow check"')
  expect(tree).toContain('"checks the sum and the carry"')
  expect(tree).toContain('2 tests · 2 strong · 1 new')
})


test('a test file a shell command makes is listed ungraded as soon as the command ends, with no grader call', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  const files: Record<string, string> = { 'src/c.test.ts': SUM_BEFORE }
  const { prompts } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests')

  files['src/d.test.ts'] = "it('subtracts', () => { expect(sub(3, 1)).toBe(2) })\nit('negates', () => { expect(sub(0, 1)).toBe(-1) })\n"
  await $.tool.call({ tool: 'Bash', command: 'cp /tmp/d.test.ts src/' } as never)
  await clock.advance(10)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('4 tests')
  expect(tree).toContain('d.test.ts')
  expect(prompts).toEqual([])
})


test('a test file a shell command removes leaves the pane, its grades with it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  const files: Record<string, string> = { 'src/c.test.ts': SUM_BEFORE, 'src/d.test.ts': "it('subtracts', () => { expect(sub(3, 1)).toBe(2) })\n" }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('3 tests · 2 strong · 1 shallow')

  delete files['src/c.test.ts']
  await $.tool.call({ tool: 'Bash', command: 'rm src/c.test.ts' } as never)
  await clock.advance(10)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 strong')
  expect(tree).not.toContain('c.test.ts')
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


test('a test that was there, edited this session, is graded again even if it was strong, and marked modified; a new one is new, not modified', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n" }
  const { prompts } = project(on, files, { rule: (name, prompt) => (name === 'adds' && prompt.includes('toBeDefined') ? 'shallow' : 'strong') })
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

  // a strong test's body changed: it is graded again, and its new grade shows
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: 'expect(add(1, 2)).toBe(3)', new_string: 'expect(add(1, 2)).toBeDefined()' } as never)
  await clock.advance(10)
  expect(ASKED(prompts)).toEqual(['adds'])
  // and a test added after it
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: "it('subtracts'", new_string: "it('multiplies', () => { expect(mul(2, 3)).toBe(6) })\nit('subtracts'" } as never)
  await clock.advance(10)

  await ui.press({ key: 'r:/proj/src/a.test.ts:adds' })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('3 tests · 2 strong · 1 shallow · 1 new · 1 modified')
  // the badges sit on their rows: adds modified, multiplies new, subtracts neither
  const rowOf = (name: string): string => tree.slice(tree.indexOf(`"key":"row-r:/proj/src/a.test.ts:${name}"`)).split('"key":"row-r:')[1]!
  expect(rowOf('adds')).toContain('"modified"')
  expect(rowOf('adds')).not.toContain('"new"')
  expect(rowOf('multiplies')).toContain('"new"')
  expect(rowOf('multiplies')).not.toContain('"modified"')
  expect(rowOf('subtracts')).not.toMatch(/"(new|modified)"/)
  // test_grades counts both as the session's own
  expect(await askGrades($, { written: true, verdicts: ['shallow', 'strong'] })).toMatch(/^2 tests written or edited this session: 1 strong, 1 shallow\./)
})


test('a file changed by other means has only the tests whose text changed graded again, not the rest of the file', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {
    'src/c.test.ts': "it('adds', () => { expect(sum(1, 2)).toBe(3) })\nit('a shallow check', () => { expect(sum).toBeDefined() })\nit('carries', () => { expect(sum(9, 1)).toBe(10) })\n",
  }
  const { prompts } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  prompts.length = 0

  // the shell rewrites one test's body, and adds one
  files['src/c.test.ts'] = files['src/c.test.ts']!.replace('expect(sum).toBeDefined()', 'expect(sum(0, 0)).toBe(0)') + "it('subtracts', () => { expect(sum(3, -1)).toBe(2) })\n"
  await clock.advance(2_000)

  expect(ASKED(prompts)).toEqual(['a shallow check', 'subtracts'])
  expect(JSON.stringify(await ui.drawn())).toContain('4 tests')
})
