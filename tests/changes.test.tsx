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
  await clock.advance(12_000)

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
test('a listed test file changed by other means shows its new tests once it has stood still a quiet period, with no turn ending', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/c.test.ts': SUM_BEFORE }
  project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(JSON.stringify(await ui.drawn())).toContain('"a shallow check"')
  files['src/c.test.ts'] = SUM_AFTER
  await clock.advance(12_000)

  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toContain('"a shallow check"')
  expect(tree).toContain('"checks the sum and the carry"')
  expect(tree).toContain('2 tests · 2 strong · 1 new')
})


test('a test file a shell command makes is graded as soon as the command ends, as a written one is', async ($, on) => {
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
  expect(tree).toContain('4 tests · 2 strong · 2 ungraded · 2 new')
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Test file: /proj/src/d.test.ts')
  expect(prompts[0]).toContain('["subtracts","negates"]')
})


test('test files a checkout brings, more than a session writes at once, are listed ungraded with no grader call', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  const files: Record<string, string> = { 'src/c.test.ts': SUM_BEFORE }
  const { prompts } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)

  for (let i = 0; i < 11; i++) files[`src/n${i}.test.ts`] = `it('case ${i}', () => { expect(f(${i})).toBe(${i}) })\n`
  await $.tool.call({ tool: 'Bash', command: 'git checkout other' } as never)
  await clock.advance(10)

  expect(JSON.stringify(await ui.drawn())).toContain('13 tests · 0 strong · 13 ungraded')
  expect(prompts).toEqual([])
})


test('a test file the watcher listed ungraded before Claude\'s write of it was seen is still graded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/c.test.ts': SUM_BEFORE }
  const { prompts } = project(on, files)
  // the write lands with ten more files from a checkout, and the watcher lists them all before
  // the write's hook goes on: too many to grade unasked, all listed ungraded
  on('tool.call', async (_$, e) => {
    if ((e as { tool: string }).tool === 'Write') {
      for (let i = 0; i < 11; i++) files[`src/n${i}.test.ts`] = `it('case ${i}', () => { expect(f(${i})).toBe(${i}) })\n`
      await $.tool.call({ tool: 'Bash', command: 'true' } as never)
      await clock.advance(10)
    }
    return { result: {}, text: 'ok', isError: false, isReadOnly: false } as never
  })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await clock.advance(10)

  await $.tool.call({ tool: 'Write', file_path: '/proj/src/n0.test.ts', content: "it('case 0', () => { expect(f(0)).toBe(0) })\n" } as never)
  await clock.advance(10)

  expect(prompts.map(p => p.match(/Test file: (\S+)/)?.[1])).toEqual(['/proj/src/n0.test.ts'])
  // graded as the test Claude wrote: new, not as one of the project's
  expect(JSON.stringify(await ui.drawn())).toContain('13 tests · 1 strong · 12 ungraded · 1 new')
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
  await clock.advance(12_000)

  expect(ASKED(prompts)).toEqual(['a shallow check', 'subtracts'])
  expect(JSON.stringify(await ui.drawn())).toContain('4 tests')
})


test('a file another program is still writing is graded once it has stood still, on its last text only', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/c.test.ts': "it('adds', () => { expect(sum(1, 2)).toBe(3) })\n" }
  const { prompts } = project(on, files)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  prompts.length = 0

  // half way through: a test begun, its assertion not written yet
  files['src/c.test.ts'] += "it('subtracts', () => { expect(sum(3, -1)) })\n"
  await clock.advance(6_000)
  files['src/c.test.ts'] = files['src/c.test.ts']!.replace('expect(sum(3, -1)) })', 'expect(sum(3, -1)).toBe(2) })')
  await clock.advance(8_000)
  // ten seconds since the first change, but only eight since the last: still not graded
  expect(prompts).toHaveLength(0)

  await clock.advance(4_000)
  expect(ASKED(prompts)).toEqual(['subtracts'])
  expect(prompts[0]).toContain('expect(sum(3, -1)).toBe(2)')
})
