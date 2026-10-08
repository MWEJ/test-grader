import { expect, mock, test } from 'claude-code/testing'
import { mount, project, FOLLOW, appended, ok, E_TEST, EVIDENCE_TOOL, GRADES_TOOL, GRADED, JEST_PROJECT, SUMMARY, turns, turnStart, turnEnd } from './helpers'

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


test('a new test graded flagged as it is written is told to Claude in a note of those alone, starting no turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('a shallow check', () => { expect(f).toBeDefined() })\nit('does nothing', () => {})\n"
  const { notes, asked, logs } = project(on, { 'src/a.test.ts': content })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content } as never)
  await clock.advance(10)
  expect(asked).toEqual([])
  expect(notes).toEqual([
    'Tests that need work (test-grader):\n' +
      '- hollow · src/a.test.ts · does nothing — hollow because.\n' +
      '- shallow · src/a.test.ts · a shallow check — shallow because.\n' +
      FOLLOW,
  ])
  expect(appended(logs)).toEqual(notes)
})


test('a new test graded strong as it is written leaves no note', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.test.ts', content: "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" } as never)
  await clock.advance(10)
  expect(JSON.stringify(await (await mount($)).drawn())).toContain('1 strong')
  expect(notes).toEqual([])
})


// Claude is told ahead of any test it writes that its tests are graded, and how to follow up
test('the system prompt tells Claude how to write tests that grade strong, to check test_grades when done, and names the guide of each language the project tests in, readable unasked', async ($, on) => {
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
  expect(section.text).toContain('Fix each flagged test as its grade asks')
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


test('the note on shallow tests tells Claude it can send evidence', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notes } = project(on, { 'src/e.test.ts': E_TEST })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  // the hint, word for word, right after the flagged it is about
  const lines = notes.at(-1)!.split('\n')
  const lastFlagged = lines.findLastIndex(l => l.startsWith('- shallow ') || l.startsWith('- hollow '))
  expect(lastFlagged).toBeGreaterThan(-1)
  expect(lines[lastFlagged + 1]).toBe(
    'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.',
  )
})


test('the results of Grade all tests, Regrade all and a coverage run are notes too, and start no turn', async ($, on) => {
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

  // a shallow test written: its grade is a note, read by Claude, no turn started
  const shallow = "it('a shallow check', () => { expect(f).toBeDefined() })\n"
  files['src/b.test.ts'] = shallow
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/b.test.ts', content: shallow } as never)
  await clock.advance(10)
  expect(asked).toEqual([])
  expect(appended(logs).map(text => text.split('\n')[0])).toEqual(['Tests that need work (test-grader):'])
  const added = () => appended(logs).slice(1)

  for (const key of ['gradeAll', 'regradeAll', 'run']) {
    await ui.press({ key })
    await clock.advance(10)
  }
  expect(asked).toEqual([])
  // each whole: the counts, then what needs work and how to dispute it; the coverage figures
  const graded = [
    'Test grading (test-grader) finished: 2 graded · 1 strong · 1 shallow.',
    'Need work, worst first:',
    '- shallow · src/b.test.ts · a shallow check — shallow because.',
    'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.',
  ].join('\n')
  expect(added()).toEqual([graded, graded, 'Coverage run (test-grader) finished: lines 82.5% · statements 80% · branches 61.2% · functions 75% (coverage-summary.json).'])
  // none asks Claude to answer it
  for (const text of added()) expect(text).not.toContain('Respond to this now')
})


test('shallow tests graded together, over several files, reach Claude as one note while its turn still runs', async ($, on) => {
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
    '- hollow · src/a.test.ts · does nothing — hollow because.',
    '- shallow · src/a.test.ts · a shallow check — shallow because.',
    '- shallow · src/b.test.ts · another shallow one — shallow because.',
  ])
  expect(lines.at(-1)).toBe(FOLLOW)
  await turnEnd($, 't1')
  expect(appended(logs)).toHaveLength(1)
})


test('a shallow test edited and graded shallow again comes back in a note as the next round; graded strong, it is told as accepted', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" }
  // shallow until its body asserts a value
  const { asked, notes } = project(on, files, { rule: (_name, prompt) => (prompt.includes('toBe(42)') ? 'strong' : 'shallow') })
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
  expect(notes[1]).toContain('- shallow · src/a.test.ts · a shallow check')
  expect(notes[1]!.split('\n').at(-1)).toBe(FOLLOW)

  await edit('expect(f()).toBe(42)')
  expect(notes.at(-1)).toBe('Now graded strong (test-grader):\n- strong · src/a.test.ts · a shallow check')
  expect(asked).toHaveLength(length)
})


test('a test still shallow after three rounds is told once, asking Claude to tell the person, and then no more', async ($, on) => {
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

  // rounds one to three ask for a fix, the fourth shallow grade asks Claude to tell the person, the fifth nothing
  expect(notes.map(text => text.split('\n').at(-1))).toEqual([FOLLOW, FOLLOW, FOLLOW, 'Tell the person which of these still need work and why.'])
  expect(notes[3]).toContain('Still flagged after 3 rounds')
  expect(asked).toEqual([])
})


test('a test Grade all listed shallow, edited by Claude, has its new grade told in a note too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" }
  // shallow until its body asserts a value
  const { asked, logs } = project(on, files, { rule: (_name, prompt) => (prompt.includes('toBe(42)') ? 'strong' : 'shallow') })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(appended(logs)).toHaveLength(1)

  const before = files['src/a.test.ts']!
  files['src/a.test.ts'] = "it('a shallow check', () => { expect(f()).toBeTruthy() })\n"
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: before, new_string: files['src/a.test.ts'] } as never)
  await clock.advance(10)

  expect(asked).toEqual([])
  expect(appended(logs)).toHaveLength(2)
  // the whole note: round one of a test Claude did not write, the fix for its grade with it
  expect(appended(logs)[1]).toBe(['Tests that need work (test-grader):', '- shallow · src/a.test.ts · a shallow check — shallow because.', FOLLOW].join('\n'))

  // that round was counted: graded strong after the next edit, it is told as accepted
  const second = files['src/a.test.ts']!
  files['src/a.test.ts'] = "it('a shallow check', () => { expect(f()).toBe(42) })\n"
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: second, new_string: files['src/a.test.ts'] } as never)
  await clock.advance(10)
  expect(appended(logs)).toHaveLength(3)
  expect(appended(logs)[2]).toBe('Now graded strong (test-grader):\n- strong · src/a.test.ts · a shallow check')
})


test('after a turn that leaves flagged tests it wrote, the prompt box offers to fix them, once for each set; strong tests bring no offer', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {}
  const { suggested } = project(on, files)
  turns(on)
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const turn = async (id: string, file?: string, content?: string) => {
    await turnStart($, id)
    if (file && content) {
      files[file] = content
      await $.tool.call({ tool: 'Write', file_path: `/proj/${file}`, content } as never)
      await clock.advance(10)
    }
    await turnEnd($, id)
  }

  // a turn that wrote only a strong test: nothing offered
  await turn('t1', 'src/s.test.ts', "it('adds', () => { expect(add(1, 2)).toBe(3) })\n")
  expect(suggested).toEqual([])

  // a shallow one: offered once, not again on a turn that changes nothing
  await turn('t2', 'src/a.test.ts', "it('a shallow check', () => { expect(f).toBeDefined() })\n")
  await turn('t3')
  expect(suggested).toEqual(['Fix the shallow test you wrote this session (test_grades lists them)'])

  // another flagged test: a new set, offered again, counting both
  await turn('t4', 'src/b.test.ts', "it('checks nothing', () => {})\n")
  expect(suggested).toEqual(['Fix the shallow test you wrote this session (test_grades lists them)', 'Fix the 2 flagged tests you wrote this session (test_grades lists them)'])
})

