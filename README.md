# test-grader

A Claude Code mod that grades how good your tests are. It lists every test in the project in a side pane. A model reviews each test, says in a sentence what it checks, and rates it **good**, **weak** or **useless**. Claude is told up front how to write tests that grade good. Its tests are graded as it writes them, and it checks the grades and strengthens the weak ones before it finishes.

## What it does

### The Tests pane

The pane opens at session start, or with `/test-grader`. It shows:

- **Every test in the project.** It lists them from the start: tests in files git tracks, and new files git would track. They show as ungraded until they are graded.
- **Tests grouped by folder and file, worst first.** The pane draws the project's folders as a tree. Each folder's row shows the counts for every test beneath it, and its line coverage when a coverage report has it. A folder holding only one subfolder shares its row, as in `gateways/api/`. When tests sit in a single folder, no folder row is drawn, and the list reads flat.
- **Folders and files start closed among siblings.** One alone at its level starts open. Each opens with a press. What you open stays open across a reload of the mod or a compaction. A new session starts everything closed again.
- **Go testify suites as their own group.** A suite spread over several files is one group, listing its files. A `Test…` function that only runs the suite is not counted as a test.
- **A verdict per test.** Each test gets a one-line summary and a one-line reason. Verdicts sit in one column on the first line of the title. Pressing a row shows its details.
- **Badges.** *new* marks a test written this session, and *modified* a test that was there before and was edited this session. A file or folder row carries a badge when a test beneath it does.
- **A summary line.** It shows the counts of tests, good, weak, useless, new and modified.
- **The last run.** Below the summary: how many tests it graded and how many it remembered, and what its grader calls cost in tokens (in, of them from the prompt cache, and out).
- **Open in editor.** This button opens the test at its line (see [Opening a test in your editor](#opening-a-test-in-your-editor)).
- **Run test.** This button runs the one test with the project's runner. The row then says whether it passed, with the command, and, when it failed, the end of what it printed (see [Running one test](#running-one-test)).
- **Coverage figures.** These show when the project has a coverage report (see [Coverage](#coverage)).

### Grading

- **Claude is told in advance.** A section of the system prompt tells Claude how to write a test that grades good:
  - assert on behaviour, not on mocks;
  - ask which bug would make the test fail;
  - one behaviour per test;
  - cover edges and errors;
  - mock only I/O, time and randomness;
  - stay deterministic.

  The section also points Claude to the guide for each language the project's tests are in (see [Language guides](#language-guides)). Once it is done writing tests, Claude calls `test_grades` with `written: true` and strengthens each weak or useless test, or proves it is better than rated.
- **New tests are graded as they are written.** When Claude writes or edits a test file, each new test is sent to the grader and tracked in the pane as new.
- **Edited tests are graded again.** test-grader compares the file before and after an edit, and each test whose text changed is graded again, good ones too. That includes an edit inside a test's body that never touches its name, and an edit that only removes lines. A test that is deleted leaves the pane.
- **Grades arrive as notes, never as prompts.** A weak or useless grade on a test Claude wrote or edited is added to the conversation as a note. No new turn starts for it. Claude reads the note in the turn under way, or in the next one.
- **One note per round.** Grades wait while grading is still under way, then go out together as one note. A test graded twice before then is listed once, with its latest grade. A weak test regraded good before its note goes out drops out of the note: it is not told as weak.
- **Accepted tests are told too.** When a test that was weak is graded good, the note says so.
- **Three rounds per test.** A test still weak or useless after three rounds is reported once more, telling Claude to tell you what is left. After that, test-grader stops on it. Evidence the grader rejects counts as a round too.
- **A suggestion after the turn.** When a turn ends with weak tests Claude wrote, the prompt box offers "Strengthen the weak tests you wrote this session", once for each set of such tests.
- **Changes made outside Claude are caught.** At the end of each turn, test files that changed since they were last seen are checked for new and removed tests. A file whose modification time has not changed is not read again.
- **Grade all tests** grades the whole project. It grades only the files that changed since their last grading. Rows waiting for the grader are marked *reviewing*. Files are read while the first ones are already being graded. A file git lists but that cannot be read (deleted, or too large) is passed over, and the pane says so. When the run finishes, Claude is asked to report the result and offer to strengthen the weak and useless tests, worst first.
- **Stop** cuts a run short. No more grader calls start, the tests not yet graded keep what they had, and the pane says how far the run got. The next run grades the rest.
- **Regrade all** grades every file again, unchanged ones included.
- **`/test-grader diff`** grades only the test files changed on this branch: against where it left `main` (or `master`), with the changes not committed yet and new files. The rest of the project's grades stay as they are.
- **Looped tests are graded case by case.** A test whose name is a template, like `` it(`rounds ${name}`) `` inside a loop, becomes one entry per case the loop generates.
- **Tests of one name are told apart.** Two tests named alike in one file are named by the groups around them, as in `parser › empty input` and `lexer › empty input`. Failing that, they are named by their order: `works`, `works (2)`.

The grader is the `haiku` model by default. It reviews up to 10 tests per call, with up to 10 calls at once.

#### What the grader reads

- **The test file.** A file under 12,000 characters is sent whole. A longer file is sent as an excerpt: the file's head, every test under review in full, and the helpers and constants those tests use, wherever in the file they are declared. Other tests are left out, and the grader is told it is reading an excerpt.
- **The code under test.** The grader judges each assertion against what that code really does. It reads up to four files, 16,000 characters in all:
  - in JavaScript and TypeScript, the files the test imports by a relative path;
  - in Python, `from … import` modules;
  - in Ruby, `require_relative` files;
  - in Go, the package's other files;
  - in Java and Kotlin, the class under `src/main` the test is named for.
- **Your project's rules.** A `.test-grader.md` file at the project's root is read at session start and at the end of each turn, and the grader is told its rules after its own. Use it to allow snapshots, or to ask for property tests.

The rubric and the file go first in each call, marked for the prompt cache, so the next batch of the same file reads them from the cache. The first grade asks for little thought (`effort: low`).

#### When the API fails

A grader call that the API answers with *overloaded*, *rate limited* or a server error is tried again up to three times. The waits are 2, 4 and then 8 seconds, each with up to a second more, so parallel calls do not retry together. Any other error leaves the tests unrated, and the debug log says why. Each call may take two minutes at most.

#### Grader settings

| Setting | Values | Default | What it does |
| --- | --- | --- | --- |
| **Grader model** (`graderModel`) | an alias (`haiku`, `sonnet`, `opus`) or a model id | `haiku` | the model that grades. A Haiku older than 5.5, such as `claude-haiku-4-5` or `claude-3-5-haiku-20241022`, grades as `claude-haiku-5-5`. Any other model grades as set. |
| **Second-look model** (`graderEscalate`) | `off`, an alias or a model id | `off` | a model that grades again what the first grade left weak: regrades after an edit, evidence and verified mutations. Older Haikus are raised to 5.5 here too. |
| **Grader workers** (`graderWorkers`) | 1 to 20 | 10 | how many grader calls Grade all tests runs at once |

Change them in the `/config` menu, or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "test-grader": { "graderModel": "haiku", "graderEscalate": "sonnet", "graderWorkers": 4 } } }
```

When the mod is loaded straight from its folder, the key is `test-grader@inline` instead. A change reloads the mod, and every grading after it uses the new settings.

#### Which tests are found

Only code counts. A test written inside a string literal or a comment, such as a fixture in a test of a test tool, is not taken for one of the file's tests. Each language's patterns are used only in that language's files.

| Language | Test files | Tests |
| --- | --- | --- |
| JavaScript and TypeScript | `*.test.*`, `*.spec.*`, files in `__tests__/`, `test/` or `tests/` | `it(…)`, `test(…)` and `Deno.test(…)`, with `.only`, `.skip`, `.concurrent`, `.todo`, `.fails` and `.each` |
| Go | `*_test.go` | `func TestX(…)`, and testify suite methods `func (s *Suite) TestX()` |
| Python | `test_*.py`, `*_test.py` | `def test_x`, in a class or not |
| Ruby | `*_test.rb`, `test_*.rb`, `*_spec.rb` | `def test_x`, `test "…" do`, and RSpec's `it`, `specify`, `example` and `scenario` |
| Swift | `*Test.swift`, `*Tests.swift` | `func testX()`, and Swift Testing's `@Test func` |
| Java and Kotlin | `*Test`, `*Tests`, `*Spec`, `*IT` `.java`/`.kt`, and files under `src/test/` | methods under `@Test`, `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory` |
| C# | `*Test.cs`, `*Tests.cs` | methods under `[Fact]`, `[Theory]`, `[Test]`, `[TestMethod]`, `[TestCase]` |
| PHP | `*Test.php`, `*Tests.php` | `function testX`, methods under `#[Test]` or `@test`, and Pest's `it(…)` and `test(…)` |
| Rust | files in `tests/`, `tests.rs`, `test.rs`, `*_test.rs` | functions under `#[test]`, `#[tokio::test]`, `#[rstest]`, `#[test_case]` |

### Language guides

The `guides/` folder holds a short guide to writing tests that grade good for each language:

| Language | Guide |
| --- | --- |
| JavaScript and TypeScript | `js.md` |
| Go | `go.md` |
| Python | `py.md` |
| Ruby | `rb.md` |
| Swift | `swift.md` |
| Java and Kotlin | `jvm.md` |
| C# | `cs.md` |
| PHP | `php.md` |
| Rust | `rs.md` |

The system prompt names only the guides for the languages your project's tests are in, with their full paths. Claude reads those guides once a session, before it writes tests, and never the others. Reading a guide asks for no permission: it is the mod's own read-only file. Edit a guide to change what Claude is told for that language.

### Claude's tools

#### Asking for the grades: `test_grades`

Claude can look up weak tests itself instead of waiting to be told. The system prompt tells it to call `test_grades` once it is done writing tests.

By default the tool lists the useless and weak tests, worst first, after a line of counts. Each test comes with its file and line, what it checks, and why it got its verdict. A test Claude is strengthening also shows its round, or that its rounds are spent.

| Input | What it does |
| --- | --- |
| `verdicts` | which tests to list: `useless`, `weak`, `unrated`, `reviewing`, `ungraded`, `good`. The default is `useless` and `weak`. |
| `path` | only the tests in this file or folder |
| `written` | only the tests written or edited this session |
| `limit` | how many tests to list at most, 50 by default. The answer says how many it left out. |

The tool reads the grades the pane shows and starts no grading. Tests still being graded are counted, and the answer says to ask again in a moment.

#### Sending evidence: `test_evidence`

When a test is better or worse than its rating, Claude can send evidence. The best evidence is a mutation of the code that makes this test fail, with the command run and the output before and after. The grader cannot run code. It checks each claim against the source and the code under test, and it rejects evidence that only says the test passes, or that it has coverage. A verdict given on evidence is marked as such in the pane, and it holds while the file is unchanged.

#### Measured evidence: `test_verify`

`test_verify` measures the evidence instead of taking Claude's word for it:

1. It runs the test unchanged with the project's runner. The test must pass.
2. It replaces one exact piece of text in one file of the code under test. The piece must be found exactly once, and the file must not be a test file.
3. It runs the test again.
4. It puts the file back as it was, and checks that it is.

If the test failed with the mutation, the commands and their output go to the grader as evidence, and the test is regraded. If the test still passed, nothing is regraded, and the tool says the test does not catch that change. This tool runs commands and changes a file for a moment, so Claude Code asks you before it runs.

### Running one test

**Run test** in the pane, and `test_verify`, run one test with the project's runner:

| Project | Command |
| --- | --- |
| Vitest | `npx vitest run <file> -t '^<groups> <name>$'` |
| Jest | `npx jest <file> -t '^<groups> <name>$'` |
| Playwright | `npx playwright test <file>:<line>` |
| pytest | `python3 -m pytest -q <file>::<Class>::<name>` |
| Go | `go test ./<dir> -count=1 -run '^<name>$'` (a suite test: `-run '/^<name>$'`) |
| RSpec | `rspec <file>:<line>`, through `bundle exec` with a Gemfile |
| Minitest | `ruby -Itest <file> -n /…/` |
| Rust | `cargo test <name>` |
| Gradle, Maven | `./gradlew test --tests '*<Class>.<name>'`, `mvn -q test -Dtest=<Class>#<name>` |
| .NET | `dotnet test --filter FullyQualifiedName~<Class>.<name>` |
| PHPUnit, Pest | `vendor/bin/phpunit --filter …`, `vendor/bin/pest <file> --filter <name>` |
| Swift | `swift test --filter <Class>/<name>` |

The runner is found at session start: `package.json` for Vitest, Jest and Playwright, `build.gradle` or `pom.xml`, a `Gemfile`, and `composer.json` for Pest. Where test-grader knows no runner for a test, the pane shows no **Run test** button for it.

### Writing the grades out: `/test-grader report`

`/test-grader report` writes `test-grader-report.md` and `test-grader-report.json` at the project's root.

- **The Markdown page** lists the counts, the line coverage, and every test worst first, each at its file and line, with the reason for its verdict.
- **The JSON** holds the same data, for CI or a review.

### Coverage

The pane offers **Run coverage** when it finds a runner it knows:

| Project | Command |
| --- | --- |
| `package.json` with vitest | `npx vitest run --coverage` |
| `package.json` with jest | `npx jest --coverage` |
| `pytest.ini`, `pyproject.toml` or `setup.cfg` | `pytest --cov` |
| `go.mod` | `go test ./... -cover` |

It reads the figures from `coverage/coverage-summary.json`, `coverage/lcov.info`, `coverage.xml` or the Go output. It shows lines, statements, branches and functions where the report has them. From a per-file report, `coverage-summary.json` or `lcov.info`, it also sums the line coverage of each folder and shows it on the folder's row.

When a run finishes, Claude is told the figures, along with the least covered folders: up to five of them, each under 80% with at least 20 lines. When a run fails, Claude is told how it failed, with the last lines it printed.

### Opening a test in your editor

**Open in editor** tries these in order:

1. The editor named by `VISUAL` or `EDITOR`, when it can go to a line. A terminal editor is passed over.
2. The system's default app for the file, at the test's line. On macOS this comes from Launch Services, on Windows from the registry, and on Linux from the file's `.desktop` handler.
3. The file as the system opens it: `open`, `xdg-open` or `start`.

Editors that open at a line include VS Code and its forks (Cursor, Windsurf, VSCodium, Antigravity), Zed, Sublime Text and the JetBrains IDEs. If nothing opens, the pane says why.

### Grades outlive the session

Grades are saved per project, with a fingerprint of each file. Each file's path is written once in the saved form. A new session lists the grades straight away, and **Grade all tests** then grades only the files that changed. Tests removed while no session was watching are pruned at session start.

If a project's grades are too many to save whole, they are saved without their one-line summaries. If even that fails, the pane says the grades will not outlive the session.

A reload of the mod does not lose grading in progress. If a run, a regrade or a new test's grading was cut off, it starts again at the next session start. A Regrade all that was cut off resumes as a Regrade all, and a `diff` run as a `diff` run.

## Install

The mod is a Claude Code plugin made of one hooks module.

- **For one session:** run `claude --plugin-dir /path/to/test-grader`.
- **From this repository:** run `/plugin install test-grader --marketplace MWEJ/test-grader`. This needs a marketplace file in the repository.

## Development

```
claude plugin validate .
claude plugin test .
node scripts/coverage.mjs
```

The tests live in `tests/pane.test.tsx`. They run in the engine's test kit, with the file system, processes and the model mocked. The state the mod keeps is declared in `types/index.d.ts`.

`claude plugin test` has no coverage of its own, so `scripts/coverage.mjs` measures it:

1. It copies the mod to a temporary folder.
2. It instruments the hooks with Istanbul.
3. It runs the tests there, with each test handing back the counters.
4. It prints a table, and writes `coverage/lcov.info` and `coverage/coverage-summary.json`.

It needs Node and npm, and installs the Istanbul libraries into the temporary folder.

The engine keeps every function that is handed the engine interface `$` in `hooks/register.tsx`, so only code that never touches `$` lives in other files.

| Path | What it holds |
| --- | --- |
| `hooks/register.tsx` | the hooks: grading, the notes, the pane, coverage, running tests, the tools, the commands |
| `hooks/discovery.ts` | which files hold tests, and which cases each declares, by language |
| `hooks/excerpt.ts` | what the grader reads of a long file, and what its reply holds |
| `hooks/runner.ts` | the command that runs one test |
| `hooks/settings.ts` | what a setting comes to: the grader model, the worker count |
| `hooks/hooks.json` | names the module |
| `guides/` | the guide for each language that Claude reads before writing tests |
| `types/index.d.ts` | the state contract |
| `tests/pane.test.tsx` | the test suite |
| `scripts/coverage.mjs` | the test suite's coverage |
