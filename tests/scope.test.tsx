import { expect, mock, test } from 'claude-code/testing'
import { mount, project } from './helpers'
import type { Engine } from './helpers'

// Grading part of the project: a folder's, a file's or a suite's Regrade in the pane, and
// Claude's test_grade tool, which grades what is not rated yet, or with again all of it

const TWO_FOLDERS = {
  'src/a/x.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
  'src/b/y.test.ts': "it('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n",
}
const start = ($: Engine) => $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
const askGrade = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, input: { path?: string; again?: boolean } = {}) => {
  const answer = $.tool.call({ tool: 'mcp__test-grader__test_grade', ...input } as never)
  await clock.advance(10)
  return String((await answer).result)
}
// the files each grader call was about
const filesOf = (prompts: string[]) => prompts.map(p => p.match(/Test file: (\S+)/)?.[1])

test("a folder's Regrade grades that folder's files again and no others", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, notes } = project(on, TWO_FOLDERS)
  await start($)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(prompts).toHaveLength(2)

  await ui.press({ key: 'g-d:src/a' })
  await clock.advance(10)
  expect(filesOf(prompts.slice(2))).toEqual(['/proj/src/a/x.test.ts'])
  expect(notes.at(-1)).toMatch(/^Test grading \(test-grader\) finished for src\/a\/: 1 graded · 1 strong\./)
  // the other folder's grade stands
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 2 strong')
})

test("a file's Regrade grades that file alone again", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, notes } = project(on, TWO_FOLDERS)
  await start($)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'd:src/b' })

  await ui.press({ key: 'g-f:/proj/src/b/y.test.ts' })
  await clock.advance(10)
  expect(filesOf(prompts.slice(2))).toEqual(['/proj/src/b/y.test.ts'])
  expect(notes.at(-1)).toContain('finished for src/b/y.test.ts: 1 graded')
})

test('test_grade on a folder grades its test files alone, not a sibling sharing its name\'s start, and answers with what it found, sending no note', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, notes } = project(on, { ...TWO_FOLDERS, 'src/a/z.test.ts': "it('does nothing', () => { expect(true).toBe(true) })\n", 'src/ab/w.test.ts': "it('multiplies', () => { expect(mul(2, 3)).toBe(6) })\n" })
  await start($)

  const answer = await askGrade($, clock, { path: 'src/a/' })
  expect(filesOf(prompts).sort()).toEqual(['/proj/src/a/x.test.ts', '/proj/src/a/z.test.ts'])
  expect(answer).toMatch(/^Test grading \(test-grader\) finished for src\/a\/: 2 graded · 1 strong · 1 hollow\./)
  expect(answer).toContain('src/a/z.test.ts')
  expect(notes).toEqual([])
})

test('test_grade grades only the tests with no verdict in a file unchanged since, keeping the rated ones', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const file = { 'src/m.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('subtracts', () => { expect(sub(3, 2)).toBe(1) })\n" }
  // the first answer leaves subtracts out
  const first = { isAnswered: true, usage: {}, text: '[{"name":"adds","summary":"s","verdict":"brittle","reason":"Exact mock calls."}]' }
  const answers: unknown[] = [first]
  const { prompts } = project(on, file, { reply: n => answers[n - 1] })
  await start($)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  expect(JSON.stringify(await ui.drawn())).toContain('2 tests · 0 strong · 1 brittle · 1 unrated')

  const answer = await askGrade($, clock)
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('Review ONLY these test cases: ["subtracts"]')
  // the brittle grade stands; subtracts is rated now
  expect(answer).toContain('2 graded · 1 strong · 1 brittle')
})

test('test_grade with again grades the rated tests too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, TWO_FOLDERS)
  await start($)
  await askGrade($, clock)
  expect(prompts).toHaveLength(2)

  expect(await askGrade($, clock)).toContain('2 graded · 2 strong')
  expect(prompts).toHaveLength(2)
  await askGrade($, clock, { again: true, path: '/proj/src/b' })
  expect(filesOf(prompts.slice(2))).toEqual(['/proj/src/b/y.test.ts'])
})

test('test_grade on a path with no test files, or outside the project, says so and grades nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, TWO_FOLDERS)
  await start($)
  expect(await askGrade($, clock, { path: 'docs' })).toBe('No test files in docs.')
  expect(await askGrade($, clock, { path: '/elsewhere/src' })).toBe('/elsewhere/src is outside the project (/proj).')
  expect(prompts).toEqual([])
})


test('a run with more flagged tests than a note lists names forty and counts the rest by file', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const hollow = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `it('does nothing ${tag} ${i}', () => { expect(true).toBe(true) })\n`).join('')
  project(on, { 'src/a.test.ts': hollow(40, 'a'), 'src/b.test.ts': hollow(3, 'b'), 'src/c.test.ts': hollow(2, 'c') })
  await start($)

  const answer = await askGrade($, clock)
  expect(answer).toContain('45 graded · 0 strong · 45 hollow')
  expect(answer.split('\n').filter(l => l.startsWith('- hollow'))).toHaveLength(40)
  expect(answer).toContain('5 more not listed, by file: src/b.test.ts (3 hollow); src/c.test.ts (2 hollow).')
})

test('test_grades names the files the last run found changed, within the path asked', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { ...TWO_FOLDERS }
  project(on, files)
  await start($)
  await askGrade($, clock)

  files['src/a/x.test.ts'] = "it('adds', () => { expect(add(2, 2)).toBe(4) })\n"
  await askGrade($, clock)
  const grades = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__test-grader__test_grades', ...input } as never).then(r => String(r.result))
  expect(await grades({})).toContain('The last run graded again, changed since their last grading: src/a/x.test.ts.')
  expect(await grades({ path: 'src/b' })).not.toContain('changed since')
})


test('test_grade on a changed file shows, for a test flagged anew, its grade before the change', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'src/a.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\n" }
  project(on, files, { rule: (_name, prompt) => (prompt.includes('toBeTruthy') ? 'brittle' : 'shallow') })
  await start($)
  await askGrade($, clock)

  files['src/a.test.ts'] = "it('a shallow check', () => { expect(f()).toBeTruthy() })\n"
  const answer = await askGrade($, clock)
  expect(answer).toContain('- brittle · src/a.test.ts · a shallow check — brittle because.\n  Before: shallow — shallow because. It would miss: a wrong edge.')
})
