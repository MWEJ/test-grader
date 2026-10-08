// What the test files share: a project the mod runs in, its pane, and fixtures
import { fingerprint } from '../hooks/register'
import { TEST_FILE, casesIn } from '../hooks/discovery'
import { runArgv, shown as shownCommand, tailOf } from '../hooks/runner'
import type { RunTarget, Runners } from '../hooks/runner'
import { expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { Verdict } from '../types'

// a test's engine and its hook registrar, as the kit hands them to a test body
export type Engine = Parameters<TestBody>[0]
export type On = Parameters<TestBody>[1]

export const FILE = '/proj/src/math.test.ts'

export const CONTENT = `
it('adds numbers', () => { expect(add(1, 2)).toBe(3) })
it('does nothing', () => { expect(true).toBe(true) })
`


// Grade all tests: the project as git tracks it, every case graded, the flagged listed
export const PANE_PROPS = { title: 'Tests', isFocused: false, bodyColumns: 80, placement: 'inline' } as never

export const mount = ($: Engine, rows = 60) =>
  $.ui.mount({ plugin: 'test-grader', surface: 'terminal', component: 'Pane', requestId: 'test-grader', props: PANE_PROPS, viewport: { columns: 80, rows } } as never)


// gate: the first grader call waits on it; held: every call waits until it is released
// rule: a verdict from the name and the prompt, in place of the name-only default
export type Project = { isGit?: boolean; gate?: () => Promise<void>; expand?: Record<string, string[]>; held?: { calls: number; release: () => void }; rule?: (name: string, prompt: string) => Verdict; editor?: Shell; env?: Record<string, string>; outside?: Record<string, string>; cut?: (reply: string) => string; refuse?: string; room?: { limit: number }; git?: (argv: string[]) => { stdout: string; exitCode?: number } | undefined; reply?: (call: number) => unknown; older?: (request: Record<string, unknown>) => boolean; confirm?: (name: string, first: Verdict) => Verdict }

// a command's answer: its exit code, or what it printed too
export type Shell = (argv: string[]) => number | { stdout?: string; stderr?: string; exitCode?: number }

// env: the variables the mod reads; outside: files by their full path, outside the project
export function project(on: On, files: Record<string, string>, { isGit = true, gate, expand = {}, held, rule, editor, env = {}, outside = {}, cut, refuse, room, git, reply, older, confirm }: Project = {}) {
  const prompts: string[] = []
  // every command but git, as run; editor answers it
  const runs: string[][] = []
  // every git command, as run
  const gits: string[][] = []
  mock.env(on, env)
  // the notes for Claude, as the debug log has them: a row a mod appends reaches no test
  // hook (the kit answers it "no implementation"), so the log line is what a test can see
  const notes: string[] = []
  // every debug line, as logged
  const logs: string[] = []
  // each grader call's room for its reply
  const budgets: number[] = []
  const refused: Record<string, unknown>[] = []
  const confirms: { prompt: string; model: string }[] = []
  // each grader call's model, and its system prompt
  const models: string[] = []
  const systems: string[] = []
  on('ui.log', async (_$, e) => {
    const text = String((e as { text?: unknown }).text)
    logs.push(text)
    if (text.startsWith('test-grader: note to Claude')) notes.push(text.replace(/^[^)]*\): /, ''))
    return { value: undefined } as never
  })
  on('command.register', async () => ({ value: {} }) as never)
  // the tools the mod registers for the session, by name
  const tools: string[] = []
  on('tool.register', async (_$, e) => {
    tools.push((e as { name: string }).name)
    return { value: { tool: `mcp__test-grader__${(e as { name: string }).name}` } } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('session.start', async () => ({ cwd: '/proj' }) as never)
  on('session.cwd', async () => ({ value: '/proj' }) as never)
  // the session's id: a test sets another to start a new session, the same for a reload
  const session = { id: 's1' }
  on('session.id', async () => ({ value: session.id }) as never)
  // a file the project holds is there, written at the kit's start; any other is missing
  on('fs.stat', async (_$, e) => {
    const path = (e as { path: string }).path.replace(/^\/proj\//, '')
    if (!(path in files)) throw new Error('missing')
    // modified when its text changes, as a file on disk is
    return { value: { mtimeMs: 1_000_000 + Number.parseInt(fingerprint(files[path]!).split('-')[0]!, 16), size: files[path]!.length, isFile: true, isDirectory: false } } as never
  })
  on('process.run', async (_$, e) => {
    const { argv } = e as { argv: string[] }
    if (argv[0] === 'git') gits.push(argv)
    const answered = argv[0] === 'git' ? git?.(argv) : undefined
    if (answered) return { value: { stderr: '', exitCode: 0, ...answered } } as never
    if (argv[0] !== 'git') {
      if (!editor) throw new Error(`unexpected ${argv.join(' ')}`)
      runs.push(argv)
      const said = editor(argv)
      return { value: typeof said === 'number' ? { stdout: '', stderr: 'no such command', exitCode: said } : { stdout: '', stderr: '', exitCode: 0, ...said } } as never
    }
    return { value: isGit ? { stdout: ['README.md', 'src/math.ts', ...Object.keys(files)].join('\n'), stderr: '', exitCode: 0 } : { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 } } as never
  })
  on('fs.read', async (_$, e) => {
    const full = (e as { path: string }).path
    // a Windows path reaches the hook resolved under the kit's own folder: matched by its tail
    const known = Object.keys(outside).find(path => full === path || full.endsWith(`/${path}`))
    if (known) return { value: outside[known] } as never
    const path = full.replace(/^\/proj\//, '')
    if (!(path in files)) throw new Error(`no ${path}`)
    return { value: files[path] } as never
  })
  // grades by the body: a test asserting true is hollow, one with "shallow" in its name shallow, else strong
  on('model.complete', async (_$, e, next) => {
    // an older host that does not take this form of request: it will not send it, so the call rejects
    if (older?.(e as never)) {
      refused.push(e as never)
      return next({ ...e, maxTokens: 0 } as never)
    }
    const prompt = String((e as { prompt?: unknown }).prompt)
    // a confirm pass over a first pass's flags: kept apart, and by default it agrees
    if (prompt.includes('A first, quick pass flagged these')) {
      const first = JSON.parse(prompt.match(/A first, quick pass flagged these: (\[.*\])/)![1]!) as { name: string; verdict: Verdict; reason: string }[]
      confirms.push({ prompt, model: String((e as { model?: unknown }).model) })
      const answer = first.map(v => {
        const verdict = confirm ? confirm(v.name, v.verdict) : v.verdict
        return { name: v.name, summary: `Checks ${v.name}.`, verdict, reason: verdict === v.verdict ? `${verdict} because.` : `${verdict} on a closer look.`, missed: verdict === 'shallow' ? 'a wrong edge.' : '' }
      })
      return { value: { isAnswered: true, usage: {}, text: JSON.stringify(answer) } } as never
    }
    budgets.push(Number((e as { maxTokens?: unknown }).maxTokens))
    models.push(String((e as { model?: unknown }).model))
    systems.push(String((e as { system?: unknown }).system))
    if (gate && prompts.length === 0) {
      prompts.push(prompt)
      await gate()
    } else prompts.push(prompt)
    if (held) {
      held.calls += 1
      await new Promise<void>(r => {
        const before = held.release
        held.release = () => (before(), r())
      })
    }
    // a reply set by the test, by the call's number: an API error, say
    const set = reply?.(prompts.length)
    // a request the engine will not send, as a blocked model is: the call rejects
    if (set === REFUSED) return next({ ...e, maxTokens: 0 } as never)
    if (set !== undefined) return { value: set } as never
    const names = JSON.parse(prompt.match(/test cases: (\[.*\])/)![1]!) as string[]
    return {
      value: {
        isAnswered: true,
        usage: {},
        text: (cut ?? (t => t))(
          JSON.stringify(
            names.flatMap(name => expand[name] ?? [name]).map(name => {
              const verdict = rule ? rule(name, prompt) : name.includes('shallow') ? 'shallow' : name.includes('nothing') ? 'hollow' : 'strong'
              return { name, summary: `Checks ${name}.`, verdict, reason: `${verdict} because.`, missed: verdict === 'shallow' ? 'a wrong edge.' : '' }
            }),
          ),
        ),
      },
    } as never
  })
  // the notes sent as a prompt, which starts a turn once Claude is idle; a note only added
  // to the conversation is a row mock.session reads back
  const asked: string[] = []
  on('prompt.submit', async (_$, e) => {
    const { text } = e as { text: string }
    if (refuse !== undefined) return { drop: refuse } as never
    asked.push(text)
    return { text } as never
  })
  // a note the session will not take: the conversation refuses the row
  if (refuse !== undefined) on('session.append', async () => ({ deny: refuse }) as never)
  // files the mod writes land in the project, and are listed in the order written
  const writes: string[] = []
  on('fs.write', async (_$, e) => {
    const { path, text } = e as { path: string; text: string }
    writes.push(path)
    files[path.replace(/^\/proj\//, '')] = text
    return { value: undefined } as never
  })
  // the prompts the mod proposes in the box
  const suggested: string[] = []
  on('prompt.suggest', async (_$, e) => {
    suggested.push((e as { text: string }).text)
    return { isShown: true } as never
  })
  // the plugin's store, kept across sessions, as JSON reads it back
  const store: Record<string, unknown> = {}
  on('store.get', async (_$, e) => ({ value: store[(e as { key: string }).key] }) as never)
  on('store.set', async (_$, e) => {
    const { key, value } = e as { key: string; value: unknown }
    if (room && JSON.stringify(value).length > room.limit) return { deny: 'the store is full' } as never
    store[key] = JSON.parse(JSON.stringify(value))
    return { value: undefined } as never
  })
  return { prompts, notes, runs, logs, budgets, tools, session, asked, store, gits, models, systems, writes, suggested, refused, confirms }
}


// each test row's verdict, as the pane draws it, by the test's name
export const verdictsDrawn = async (ui: { drawn: () => Promise<unknown> }): Promise<Record<string, string>> => {
  const json = JSON.stringify(await ui.drawn())
  return Object.fromEntries(
    [...json.matchAll(/"children":\["(\w+)"\]\}\]\},\{"type":"Box","props":\{"flexDirection":"column"\},"children":\[\{"type":"Button","props":\{"key":"r:[^"]*?:([^"]*)"/g)].map(m => [m[2]!, m[1]!]),
  )
}


// the pane's drawing as nodes, every one in drawing order
export type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

export const nodesOf = (tree: unknown): Node[] => {
  const nodes: Node[] = []
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    nodes.push(n as Node)
    for (const c of (n as Node).children ?? []) walk(c)
  }
  walk(tree)
  return nodes
}

// whether a node draws a button with this key, at any depth
export const holdsKey = (n: Node, key: string): boolean => JSON.stringify(n).includes(`"key":${JSON.stringify(key)}`)

// the buttons drawn, by key, with their labels
export const buttonsOf = (tree: unknown): Map<string, string> =>
  new Map(nodesOf(tree).filter(n => n.type === 'Button').map(n => [String(n.props?.key), String(n.props?.label)]))


// what a shallow grade asks of Claude, in its note; and the notes only added to the conversation,
// as the mod's debug line says (a row a mod appends reaches no test hook: the kit refuses it)
export const FOLLOW =
  'Once you are done writing tests, fix each of these as its grade asks (hollow: rewrite it to assert on what the code does; duplicate: delete it, or merge it into the test it repeats; shallow: add the case it misses: an edge, an error, a boundary; brittle: assert on behaviour, not on how the code does it), or, where one is better than rated, send your evidence with the test_evidence tool. Each test gets 3 rounds.'

export const appended = (logs: string[]): string[] =>
  logs.filter(l => /^test-grader: note to Claude \((appended|not appended: no implementation for session\.append)\): /.test(l)).map(l => l.replace(/^[^)]*\): /, ''))


// one line per test, pressed open for the details; names read whole; the lists follow the session's edits
export const ok = { result: {}, text: 'ok', isError: false, isReadOnly: false }


// opens 'a shallow check' (line 5 of src/e.test.ts) from the pane; the commands run, in order
export const E_TEST = "import { f } from './f'\n\nit('first', () => { expect(f(1)).toBe(1) })\n\nit('a shallow check', () => {\n  expect(f).toBeDefined()\n})\n"

export const E_FILE = '/proj/src/e.test.ts'

export async function openShallow($: Engine, on: On, world: Pick<Project, 'editor' | 'env' | 'outside'>) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { runs } = project(on, { 'src/e.test.ts': E_TEST }, world)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: `r:${E_FILE}:a shallow check` })
  await ui.press({ key: `o:${E_FILE}:a shallow check` })
  await clock.advance(10)
  return { runs, ui }
}


// macOS: what osascript says opens the file, as the mod's script prints it
export const macDefault = (app: { app: string; id: string; exe: string } | null): Shell => argv =>
  argv[0] === 'osascript' ? { stdout: app ? JSON.stringify(app) : '' } : 0


// Linux: no osascript; xdg-mime names the file's type, then the .desktop file that opens it
export const linux = (desktop: string | null): Shell => argv => {
  if (argv[0] === 'osascript') return { stderr: 'osascript: command not found', exitCode: 127 }
  if (argv.join(' ') === `xdg-mime query filetype ${E_FILE}`) return { stdout: 'text/vnd.trolltech.linguist\n' }
  if (argv.join(' ') === 'xdg-mime query default text/vnd.trolltech.linguist') return { stdout: desktop ? `${desktop}\n` : '' }
  return 0
}


// Windows: the user's choice for the extension, then that choice's open command, from the registry
export const windows = (command: string | null): Shell => argv => {
  const asked = argv.join(' ')
  if (asked === 'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.ts\\UserChoice /v ProgId')
    return command ? { stdout: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.ts\\UserChoice\r\n    ProgId    REG_SZ    VSCode.ts\r\n\r\n' } : 1
  if (asked === 'reg query HKCR\\.ts /ve') return 1
  if (asked === 'reg query HKCR\\VSCode.ts\\shell\\open\\command /ve') return { stdout: `\r\nHKEY_CLASSES_ROOT\\VSCode.ts\\shell\\open\\command\r\n    (Default)    REG_SZ    ${command}\r\n\r\n` }
  return 0
}


// a testify suite spread over two files, its runner, and a plain test beside it
export const QUOTA_TEST = `package quota

type QuotaSuite struct{ suite.Suite }

func TestQuotaSuite(t *testing.T) {
	suite.Run(t, new(QuotaSuite))
}

func (s *QuotaSuite) TestRollover() {
	s.Equal(5, rollover(4))
}

func TestPlain(t *testing.T) {
	if plain() != 1 {
		t.Fatal("plain")
	}
}
`

export const OTHER_TEST = `package quota

func (s *QuotaSuite) TestShallowCheck() {
	s.NotNil(New())
}
`


// a test file changed some other way than Claude's Write or Edit: the shell, an editor, a checkout
export const SUM_BEFORE = "it('a shallow check', () => { expect(sum).toBeDefined() })\nit('adds', () => { expect(sum(1, 2)).toBe(3) })\n"

export const SUM_AFTER = "it('checks the sum and the carry', () => { expect(sum(9, 1)).toBe(10) })\nit('adds', () => { expect(sum(1, 2)).toBe(3) })\n"

export const TURN = { answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as never


// the session's evidence for a test, sent through the mod's tool; what the tool answers
export const EVIDENCE_TOOL = 'mcp__test-grader__test_evidence'

export const sendEvidence = async ($: Engine, input: { file: string; test: string; evidence: string }) =>
  String((await $.tool.call({ tool: EVIDENCE_TOOL, ...input } as never)).result)

export const MUTATION = 'Removing the default export of f makes this test fail; no other test fails.'

// the grader is swayed by the mutation, when it is sent; else a shallow test stays shallow
export const swayed = (name: string, prompt: string): 'strong' | 'shallow' => (name.includes('shallow') && !prompt.includes(MUTATION) ? 'shallow' : 'strong')


// the session asks for the grades as they stand, through the mod's tool
export const GRADES_TOOL = 'mcp__test-grader__test_grades'

export const askGrades = async ($: Engine, input: { verdicts?: string[]; path?: string; limit?: number; written?: boolean } = {}) =>
  String((await $.tool.call({ tool: GRADES_TOOL, ...input } as never)).result)

export const GRADED = {
  'src/math.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\nit('does nothing', () => { expect(true).toBe(true) })\n",
  'src/deep/more.test.ts': "import { f } from './f'\n\nit('a shallow check', () => { expect(f).toBeDefined() })\nit('another shallow one', () => { expect(f).toBeTruthy() })\n",
}


// a jest project, and the summary its coverage run writes
export const JEST_PROJECT = { 'package.json': '{ "devDependencies": { "jest": "^29.0.0" } }', 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" }

export const SUMMARY = JSON.stringify({ total: { lines: { pct: 82.5 }, statements: { pct: 80 }, branches: { pct: 61.2 }, functions: { pct: 75 } } })


// Test discovery reads code, not text: a test written inside a string or a comment is a
// fixture or a note, not one of the file's tests
export const ASKED = (prompts: string[]): string[] => prompts.map(p => JSON.parse(p.match(/test cases: (\[.*\])/)![1]!) as string[]).flat().sort()


// A reload of the mod drops the grading under way, and the host keeps its marks: the run left
// running, its rows reviewing. Here the host holds them as the cut-off load left them: each
// read answers with them until the mod first writes the value
export function seedState(on: On, seeds: Record<string, unknown>) {
  const written = new Set<string>()
  on('state.set', async (_$, e, next) => {
    written.add((e as { key: string }).key)
    return next(e)
  })
  on('state.get', async (_$, e, next) => {
    const { plugin, key } = e as { plugin: string; key: string }
    const held = await next(e)
    if (plugin !== 'test-grader' || !(key in seeds) || written.has(key)) return held
    // a hook's answer comes wrapped: { value: { value, version } }
    return { value: { value: seeds[key], version: (held as { value: { version: number } }).value.version } } as never
  })
}


// A flagged grade on a test Claude wrote or edited is told to Claude in a note, never a
// prompt; each new grade comes the same way, until the test is strong or has had three rounds
// a turn of Claude's, its start and end as the engine raises them
export const turns = (on: On) => {
  on('turn.start', async (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', async () => ({ text: 'done' }) as never)
}

export const turnStart = ($: Engine, turnId: string) => $.turn.start({ text: '', turnId } as never)

export const turnEnd = ($: Engine, turnId: string) => $.turn.complete({ turnId, reason: 'answer', text: 'done' } as never)


// The grader model is a setting: the haiku alias unless the person picks another
export const gradeOnce = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { models } = project(on, { 'src/a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  return models
}


// A project with tests in folders and subfolders: the pane draws its folders as a tree
export const TREE = {
  'internal/domain/user.test.ts': "it('does nothing', () => {})\n",
  'internal/gateways/api/api.test.ts': "it('a shallow check', () => { expect(f).toBeDefined() })\nit('lists clusters', () => { expect(list()).toEqual([1]) })\n",
  'internal/gateways/api/query.test.ts': "it('parses a query', () => { expect(parse('a=1')).toEqual({ a: '1' }) })\n",
  'cmd/exporter/exporter.test.ts': "it('another shallow one', () => { expect(g).toBeDefined() })\n",
  'root.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n",
}

// the group rows drawn, folders and files, in drawing order, by key with their labels
export const groupRows = async (ui: { drawn: () => Promise<unknown> }): Promise<[string, string][]> =>
  [...buttonsOf(await ui.drawn()).entries()].filter(([key]) => /^(d|f|s):/.test(key))


// How many grader calls Grade all tests has in flight at once: the graderWorkers setting
export const inFlight = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // 25 batches of 10: more than any setting lets run at once
  const many = Array.from({ length: 250 }, (_, i) => `it('case ${i}', () => { expect(f(${i})).toBe(${i}) })\n`).join('')
  const held = { calls: 0, release: () => {} }
  project(on, { 'a.test.ts': many }, { held })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  return held.calls
}


// Discovery, language by language: the cases each declares in code, two of one name told apart
// by the groups around them; none that sits in a string or a comment
export const DISCOVERED: [string, string, string[]][] = [
  [
    'src/a.test.ts',
    "describe('one', () => {\n  it('works', () => {})\n  it.each([[1, f(2)]])('row %s', () => {})\n})\ndescribe('two', () => {\n  it('works', () => {})\n  test.concurrent.each`a`('tmpl', () => {})\n})\nit('works', () => {})\nDeno.test(\"deno one\", () => {})\ntest.describe('pw', () => {})\n",
    ['one › works', 'row %s', 'two › works', 'tmpl', 'works', 'deno one'],
  ],
  ['tests/test_x.py', 'class TestA:\n    def test_a(self):\n        pass\n\nclass TestB:\n    def test_a(self):\n        pass\n\ndef test_free():\n    s = "def test_fake"\n', ['TestA › test_a', 'TestB › test_a', 'test_free']],
  [
    'spec/x_spec.rb',
    "RSpec.describe Foo do\n  context 'when a' do\n    it 'works' do\n    end\n  end\n  context 'when b' do\n    it \"works\" do\n    end\n  end\n  specify('x') { }\nend\nclass FooTest < Minitest::Test\n  def test_one\n  end\n  test \"rails way\" do\n  end\nend\n",
    ['Foo › when a › works', 'Foo › when b › works', 'x', 'test_one', 'rails way'],
  ],
  ['src/lib/tests.rs', '#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {}\n    #[tokio::test]\n    #[ignore]\n    async fn later() {}\n    #[rstest]\n    #[case(1)]\n    fn param(#[case] n: u32) {}\n}\nconst S: &str = "#[test]\\nfn fake() {}";\n', ['adds', 'later', 'param']],
  [
    'src/test/java/FooTest.java',
    'class FooTest {\n  @Test\n  void adds() {}\n  @ParameterizedTest\n  @ValueSource(ints = {1, 2})\n  public void many(int n) {}\n  @Nested\n  class Inner {\n    @Test void adds() {}\n  }\n}\n',
    ['FooTest › adds', 'many', 'FooTest › Inner › adds'],
  ],
  ['FooTest.kt', 'class FooTest {\n  @Test\n  fun `adds two numbers`() {}\n  @Test suspend fun later() {}\n}\n', ['adds two numbers', 'later']],
  ['FooTests.cs', 'public class FooTests {\n  [Fact]\n  public void Adds() {}\n  [Theory]\n  [InlineData(1)]\n  public async Task Many(int n) {}\n  [Test, Category("x")]\n  public void Nunit() {}\n}\n', ['Adds', 'Many', 'Nunit']],
  [
    'tests/FooTest.php',
    "<?php\nclass FooTest extends TestCase {\n  public function testAdds(): void {}\n  /** @test */\n  public function it_works() {}\n  #[Test]\n  public function attributed() {}\n  # public function testHidden() {}\n}\nit('pest case', function () {});\n",
    ['testAdds', 'it_works', 'attributed', 'pest case'],
  ],
  ['Tests/FooTests.swift', 'final class FooTests: XCTestCase {\n  func testAdds() {}\n}\n@Suite struct Bar {\n  @Test("shown") func baz() {}\n  @Test func qux() async throws {}\n}\n', ['testAdds', 'baz', 'qux']],
  ['pkg/a_test.go', 'func TestA(t *testing.T) {}\nfunc testHelper(t *testing.T) {}\nfunc (s *Suite) TestB() {}\n', ['TestA', 'TestB']],
  ['src/same.test.ts', "it('twin', () => {})\nit('twin', () => {})\n", ['twin', 'twin (2)']],
]

// the branch's changes, as git answers: main is where it left, a.test.ts changed on it, b.test.ts
// changed and not committed, c.test.ts new; d.test.ts unchanged
export const BRANCH: Record<string, string> = {
  'src/a.test.ts': "it('a', () => { expect(f(1)).toBe(1) })\n",
  'src/b.test.ts': "it('b', () => { expect(f(2)).toBe(2) })\n",
  'src/c.test.ts': "it('c shallow', () => { expect(f).toBeDefined() })\n",
  'src/d.test.ts': "it('d', () => { expect(f(4)).toBe(4) })\n",
}

export const branchGit = (argv: string[]) => {
  const args = argv.slice(1).join(' ')
  if (args === 'merge-base HEAD origin/HEAD') return { stdout: '', exitCode: 1 }
  if (args === 'merge-base HEAD main') return { stdout: 'abc123\n' }
  if (args === 'diff --name-only --diff-filter=d main...') return { stdout: 'src/a.test.ts\nsrc/lib.ts\n' }
  if (args === 'diff --name-only --diff-filter=d HEAD') return { stdout: 'src/b.test.ts\n' }
  if (args === 'ls-files --others --exclude-standard') return { stdout: 'src/c.test.ts\n' }
  return undefined
}


// a jest project whose tests fail when add subtracts
export const ADDING: Record<string, string> = {
  'package.json': '{ "devDependencies": { "jest": "^29.0.0" } }',
  'src/add.ts': 'export const add = (a: number, b: number) => a + b\n',
  'src/a.test.ts': "import { add } from './add'\n\nit('a shallow check', () => {\n  expect(add(1, 2)).toBeDefined()\n})\n",
}

export const jest = (files: Record<string, string>): Shell => argv =>
  argv[1] === 'jest' ? (files['src/add.ts']!.includes('a - b') ? { stdout: 'FAIL src/a.test.ts\n  ● a shallow check\n    expected 3', exitCode: 1 } : { stdout: 'PASS src/a.test.ts', exitCode: 0 }) : 1


// The command that runs one test, by its language and the project's runner
export const RUNS: [string, RunTarget, Runners, string[] | null][] = [
  ['vitest', { rel: 'src/a.test.ts', kind: 'js', plain: 'adds (1+1)', groups: ['math'], line: 3 }, { js: 'vitest' }, ['npx', 'vitest', 'run', 'src/a.test.ts', '-t', '^math adds \\(1\\+1\\)$']],
  ['playwright', { rel: 'e2e/a.spec.ts', kind: 'js', plain: 'logs in', groups: [], line: 7 }, { js: 'playwright' }, ['npx', 'playwright', 'test', 'e2e/a.spec.ts:7']],
  ['no JS runner', { rel: 'src/a.test.ts', kind: 'js', plain: 'x', groups: [], line: 1 }, {}, null],
  ['pytest in a class', { rel: 'tests/test_a.py', kind: 'py', plain: 'test_a', groups: ['TestA'], line: 2 }, {}, ['python3', '-m', 'pytest', '-q', 'tests/test_a.py::TestA::test_a']],
  ['go', { rel: 'pkg/a_test.go', kind: 'go', plain: 'TestA', groups: [], line: 1 }, {}, ['go', 'test', './pkg', '-count=1', '-run', '^TestA$']],
  ['go suite', { rel: 'pkg/a_test.go', kind: 'go', plain: 'TestB', groups: [], line: 1, suite: 'Suite' }, {}, ['go', 'test', './pkg', '-count=1', '-run', '/^TestB$']],
  ['rspec', { rel: 'spec/a_spec.rb', kind: 'rb', plain: 'works', groups: ['Foo'], line: 4 }, { isBundled: true }, ['bundle', 'exec', 'rspec', 'spec/a_spec.rb:4']],
  ['minitest', { rel: 'test/a_test.rb', kind: 'rb', plain: 'rails way', groups: [], line: 4 }, {}, ['ruby', '-Itest', 'test/a_test.rb', '-n', '/^rails_way$|^test_rails_way$/']],
  ['cargo', { rel: 'tests/a.rs', kind: 'rs', plain: 'adds', groups: ['tests'], line: 3 }, {}, ['cargo', 'test', 'adds']],
  ['gradle', { rel: 'src/test/java/FooTest.java', kind: 'jvm', plain: 'adds', groups: ['FooTest'], line: 3 }, { jvm: 'gradle' }, ['./gradlew', 'test', '--tests', '*FooTest.adds']],
  ['maven', { rel: 'src/test/java/FooTest.java', kind: 'jvm', plain: 'adds', groups: [], line: 3 }, { jvm: 'maven' }, ['mvn', '-q', 'test', '-Dtest=FooTest#adds']],
  ['no JVM build', { rel: 'FooTest.kt', kind: 'jvm', plain: 'adds', groups: [], line: 3 }, {}, null],
  ['dotnet', { rel: 'FooTests.cs', kind: 'cs', plain: 'Adds', groups: ['FooTests'], line: 3 }, {}, ['dotnet', 'test', '--filter', 'FullyQualifiedName~FooTests.Adds']],
  ['phpunit', { rel: 'tests/FooTest.php', kind: 'php', plain: 'testAdds', groups: [], line: 3 }, {}, ['vendor/bin/phpunit', '--filter', '/::testAdds$/', 'tests/FooTest.php']],
  ['pest', { rel: 'tests/FooTest.php', kind: 'php', plain: 'pest case', groups: [], line: 3 }, { isPest: true }, ['vendor/bin/pest', 'tests/FooTest.php', '--filter', 'pest case']],
  ['swift', { rel: 'Tests/FooTests.swift', kind: 'swift', plain: 'testAdds', groups: ['FooTests'], line: 2 }, {}, ['swift', 'test', '--filter', 'FooTests/testAdds']],
]

// Where each piece of text lands on the terminal, worked out from the drawn tree as a terminal
// lays it out: rows side by side with their gaps, columns one under another, margins and padding
// moving a box in, a fixed width holding its place, and a row's children at its top or centred.
// The kit draws no surface, so this is how a test reads layout without pinning which props make it
export type Placed = { x: number; y: number; text: string; key?: string }
export const placedOf = (tree: unknown): Placed[] => {
  const placed: Placed[] = []
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const textOf = (n: Node): string =>
    typeof n.props?.label === 'string' ? n.props.label : (n.children ?? []).map(c => (typeof c === 'string' || typeof c === 'number' ? String(c) : textOf(c as Node))).join('')
  const isBox = (n: Node): boolean => n.type === 'Box'
  const inset = (n: Node): number => num(n.props?.marginLeft) + num(n.props?.paddingLeft) + num(n.props?.paddingX) + num(n.props?.marginX)
  const top = (n: Node): number => num(n.props?.marginTop) + num(n.props?.paddingTop) + num(n.props?.paddingY) + num(n.props?.marginY)
  const kids = (n: Node): Node[] => (n.children ?? []).filter((c): c is Node => !!c && typeof c === 'object')
  // a box's size, before it is placed: one line a text, rows side by side, columns stacked
  const size = (n: Node): { w: number; h: number } => {
    if (!isBox(n)) return { w: textOf(n).length, h: textOf(n).split('\n').length }
    const sizes = kids(n).map(size)
    const gap = num(n.props?.gap)
    const isRow = n.props?.flexDirection === 'row'
    const w = isRow ? sizes.reduce((a, s) => a + s.w, 0) + gap * Math.max(0, sizes.length - 1) : Math.max(0, ...sizes.map(s => s.w))
    const h = isRow ? Math.max(0, ...sizes.map(s => s.h)) : sizes.reduce((a, s) => a + s.h, 0) + gap * Math.max(0, sizes.length - 1)
    return { w: (typeof n.props?.width === 'number' ? n.props.width : w) + inset(n), h: h + top(n) }
  }
  const place = (n: Node, x: number, y: number): void => {
    if (!isBox(n)) {
      placed.push({ x, y, text: textOf(n), ...(typeof n.props?.key === 'string' ? { key: n.props.key } : {}) })
      return
    }
    const x0 = x + inset(n)
    const y0 = y + top(n)
    const gap = num(n.props?.gap)
    const isRow = n.props?.flexDirection === 'row'
    const height = size(n).h - top(n)
    let at = isRow ? x0 : y0
    for (const c of kids(n)) {
      const s = size(c)
      if (isRow) {
        const dy = n.props?.alignItems === 'center' ? Math.floor((height - s.h) / 2) : n.props?.alignItems === 'flex-end' ? height - s.h : 0
        place(c, at, y0 + dy)
        at += s.w + gap
      } else {
        place(c, x0, at)
        at += s.h + gap
      }
    }
  }
  place(tree as Node, 0, 0)
  return placed
}

// a grader reply that stands for a request the engine refuses to send
export const REFUSED = Symbol('refused')
