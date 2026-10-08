import { TEST_FILE, caseLine, caseNames, casesIn, changedCases } from '../hooks/discovery'
import { caseTextOf } from '../hooks/excerpt'
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


// Two cases of one name, one inside a group and one after it: the group ends where its block
// does, so only the first is named by it. A line inside the group that holds a brace in text,
// or code that looks like text, must not move that end
const TWINS: [string, string, string][] = [
  ['a JS string with an escaped quote', 'src/a.test.ts', "describe('g', () => {\n  const s = 'it\\'s {'\n  it('same', () => {})\n})\nit('same', () => {})\n"],
  ['a JS regex after return', 'src/a.test.ts', "describe('g', () => {\n  const opens = (s) => { return /[{]/.test(s) }\n  it('same', () => {})\n})\nit('same', () => {})\n"],
  ['a JS regex with a slash in a class', 'src/a.test.ts', "describe('g', () => {\n  const r = /[/{]/\n  it('same', () => {})\n})\nit('same', () => {})\n"],
  ['a Rust char literal', 'tests/a.rs', "mod g {\n    fn open() -> char { '{' }\n    #[test]\n    fn same() {}\n}\n#[test]\nfn same() {}\n"],
  ['a Rust escaped char literal', 'tests/a.rs', "mod g {\n    fn quote() -> char { '\\\"' }\n    #[test]\n    fn same() {}\n}\n#[test]\nfn same() {}\n"],
  ['a Rust lifetime', 'tests/a.rs', "mod g {\n    fn first<'a>(s: &'a str) -> &'a str {\n        s\n    }\n    #[test]\n    fn same() {}\n}\n#[test]\nfn same() {}\n"],
]
for (const [what, file, text] of TWINS) {
  test(`a group holding ${what} ends at its own close`, () => {
    expect(caseNames(text, file)).toEqual(['g › same', 'same'])
  })
}


test('a test written inside a Rust raw string is not a test, however many hashes close it', () => {
  const text = 'const SRC: &str = r##"\nfn a() { "# }\n#[test]\nfn in_raw() {}\n"##;\n\n#[test]\nfn real() {}\n'
  expect(caseNames(text, 'tests/raw.rs')).toEqual(['real'])
})

test("a test written inside a Python ''' string is not a test", () => {
  const text = "FIXTURE = '''\ndef test_in_fixture():\n    pass\n'''\n\ndef test_real():\n    assert add(1, 2) == 3\n"
  expect(caseNames(text, 'tests/test_a.py')).toEqual(['test_real'])
})

test('a PHP method named under @test inside a comment is not a test', () => {
  const text = '<?php\nclass FooTest extends TestCase {\n  /*\n   * @test\n   * function commented_out() {}\n   */\n  /** @test */\n  public function it_works() {}\n}\n'
  expect(caseNames(text, 'tests/FooTest.php')).toEqual(['it_works'])
})

// a string, comment or template left open runs to the end of the file: what follows is text
const LEFT_OPEN: [string, string, string, string][] = [
  ['JS template', 'src/a.test.ts', "it('real', () => {})\nconst s = `\nit('in template', () => {})\n", 'real'],
  ['JS block comment', 'src/a.test.ts', "it('real', () => {})\n/*\nit('in comment', () => {})\n", 'real'],
  ['Python triple-quoted string', 'tests/test_a.py', 'def test_real():\n    pass\n\nDOC = """\ndef test_in_doc():\n    pass\n', 'test_real'],
  ['Go raw string', 'a_test.go', 'func TestReal(t *testing.T) {}\nconst s = `\nfunc TestInRaw(t *testing.T) {}\n', 'TestReal'],
  ['Rust raw string', 'tests/a.rs', '#[test]\nfn real() {}\nconst S: &str = r#"\n#[test]\nfn in_raw() {}\n', 'real'],
]
for (const [what, file, text, name] of LEFT_OPEN) {
  test(`a ${what} left open at the end of a file hides the tests after it`, () => {
    expect(caseNames(text, file)).toEqual([name])
  })
}


test("a Python test's text runs to the next line indented no deeper, past a string at the margin", () => {
  const text = 'def test_a():\n    s = """\nnot code\n"""\n    assert s\n\nHELPER = 2\n\ndef test_b():\n    assert HELPER == 2\n'
  expect(caseTextOf(text, 'test_a', 'tests/test_a.py')).toBe('def test_a():\n    s = """\nnot code\n"""\n    assert s')
})

test('what sits between two Python tests goes with the one below it', () => {
  const text = 'def test_a():\n    assert 1\n\nHELPER = 2\n\ndef test_b():\n    assert HELPER == 2\n'
  expect(caseTextOf(text, 'test_b', 'tests/test_a.py')).toBe('HELPER = 2\n\ndef test_b():\n    assert HELPER == 2')
})

test('an edit to the body of a Python test followed by a blank line names that test', () => {
  const before = 'def test_a():\n    assert f(1) == 1\n\ndef test_b():\n    assert f(2) == 2\n'
  const after = 'def test_a():\n    assert f(1) == 100\n\ndef test_b():\n    assert f(2) == 2\n'
  expect(changedCases(before, after, 'tests/test_a.py')).toEqual(['test_a'])
})

test("a Ruby test's text holds its closing end", () => {
  const text = 'class FooTest < Minitest::Test\n  def test_a\n    assert true\n  end\n\n  HELPER = 1\n\n  def test_b\n    assert HELPER\n  end\nend\n'
  expect(caseTextOf(text, 'test_a', 'test/foo_test.rb')).toBe('  def test_a\n    assert true\n  end')
})

test("a Go test's text runs to its closing brace, past a brace in a string", () => {
  const text = 'func TestA(t *testing.T) {\n\tif f() != 1 { t.Fatal("}") }\n}\n\nfunc helper() int { return 2 }\n\nfunc TestB(t *testing.T) {}\n'
  expect(caseTextOf(text, 'TestA', 'a_test.go')).toBe('func TestA(t *testing.T) {\n\tif f() != 1 { t.Fatal("}") }\n}')
})

test('a helper between two Go tests goes with the one below it', () => {
  const text = 'func TestA(t *testing.T) {}\n\nfunc helper() int { return 2 }\n\nfunc TestB(t *testing.T) {}\n'
  expect(caseTextOf(text, 'TestB', 'a_test.go')).toBe('\nfunc helper() int { return 2 }\n\nfunc TestB(t *testing.T) {}')
})


test('a case opens at its own line; one no longer in the file at the top', () => {
  const text = "import { add } from './add'\n\nit('adds', () => {})\n"
  expect(caseLine(text, 'adds', 'src/a.test.ts')).toBe(3)
  expect(caseLine(text, 'gone', 'src/a.test.ts')).toBe(1)
})


test("Go's TestMain sets a package's tests up and is not listed as one", () => {
  const text = 'package gitops\n\nfunc TestMain(m *testing.M) {\n\tos.Exit(m.Run())\n}\n\nfunc TestMainline(t *testing.T) {\n\tcheck(t)\n}\n'
  expect(caseNames(text, 'internal/gitops/main_test.go')).toEqual(['TestMainline'])
})
