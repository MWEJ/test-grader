import { TEST_FILE, casesIn } from '../hooks/discovery'
import { expect, mock, test } from 'claude-code/testing'
import { CONTENT, mount, project, ok, ASKED, DISCOVERED } from './helpers'

test('a test name with an escaped quote is read whole, so the grader\'s verdict finds it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = project(on, { 'src/q.test.ts': "it('the command\\'s status', () => { expect(f()).toBe(1) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)

  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(prompts[0]).toContain('["the command\'s status"]')
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 strong')
  expect(tree).not.toContain('unrated')
})


test('a test written inside a fixture string is not a test', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "it('real one', () => {\n  const files = { 'a.test.ts': \"it('inner fixture', () => {})\" }\n  expect(run(files)).toBe(1)\n})\n"
  project(on, { 'src/f.test.ts': content })
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  await $.tool.call({ tool: 'Write', file_path: '/proj/src/f.test.ts', content } as never)
  await clock.advance(10)

  const ui = await mount($)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('1 test · 1 strong · 1 new')
  expect(tree).toContain('real one')
  expect(tree).not.toContain('inner fixture')
})


test('a test written inside a string or a comment is not one of the file\'s tests', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const js = [
    "const FIXTURE = `",
    "it('in a template', () => { expect(true).toBe(true) })",
    "test(`nested ${`it('in a hole', () => {})`} still text`, () => {})",
    "`",
    "const GO = `func TestInGo(t *testing.T) {}`",
    "// it('in a line comment', () => {})",
    "/*",
    "it('in a block comment', () => {})",
    "*/",
    "const re = /it\\('in a regex'/",
    "it('real one', () => { expect(add(1, 2)).toBe(3) })",
    "it(`real after ${FIXTURE.length} chars`, () => { expect(1).toBe(1) })",
    "",
  ].join('\n')
  const go = "package q\n\nconst src = `\nfunc TestInRaw(t *testing.T) {}\n`\n\n// func TestInComment(t *testing.T) {}\n\nfunc TestRealGo(t *testing.T) {\n\tif add(1, 2) != 3 {\n\t\tt.Fatal(\"func TestInString(t *testing.T) {\")\n\t}\n}\n"
  const py = 'DOC = """\ndef test_in_docstring():\n    pass\n"""\n\n# def test_in_comment():\n\ndef test_real_py():\n    assert add(1, 2) == 3\n'
  const swift = 'final class MathTests: XCTestCase {\n  let src = """\n  func testInMultiline() {}\n  """\n  // func testInComment() {}\n  func testRealSwift() {\n    XCTAssertEqual(add(1, 2), 3, "func testInString() {")\n  }\n}\n'
  const { prompts } = project(on, { 'src/a.test.ts': js, 'q/a_test.go': go, 'test_a.py': py, 'Tests/MathTests.swift': swift })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  expect(ASKED(prompts)).toEqual(['TestRealGo', 'real after ${FIXTURE.length} chars', 'real one', 'testRealSwift', 'test_real_py'])
})


test('a fixture string an edit adds holding a test is not tracked as a new test', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const added = "const CONTENT = `\nit('fixture case', () => {})\n`\n"
  const after = `${added}it('real one', () => { expect(add(1, 2)).toBe(3) })\n`
  const { prompts } = project(on, { 'src/a.test.ts': after })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/a.test.ts', old_string: 'x', new_string: added } as never)
  await clock.advance(10)

  expect(prompts).toHaveLength(0)
  expect(JSON.stringify(await (await mount($)).drawn())).not.toContain('fixture case')
})


for (const [file, text, names] of DISCOVERED) {
  test(`${file} is a test file, and its cases are ${names.join(', ')}`, async () => {
    expect(TEST_FILE.test(file)).toBe(true)
    expect(casesIn(text, file).filter(c => !c.isRunner).map(c => c.name)).toEqual(names)
  })
}


test('source files of each language are not test files', async () => {
  for (const file of ['src/add.ts', 'pkg/add.go', 'app/models/user.rb', 'src/lib.rs', 'src/main/java/Foo.java', 'Foo.cs', 'src/Foo.php', 'Sources/Foo.swift', 'add.py']) {
    expect([file, TEST_FILE.test(file)]).toEqual([file, false])
  }
})

