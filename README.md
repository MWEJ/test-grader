# test-grader

A Claude Code mod that grades how good your tests are. It lists every test in the project in a side pane. A model reviews each test, says in a sentence what it checks, and gives it a grade that names what is wrong with it, and so how to fix it. Claude is told up front how to write tests that grade strong. Its tests are graded as it writes them, and it checks the grades and fixes the flagged ones before it finishes.

## The grades

| Grade | Meaning | The fix |
| --- | --- | --- |
| **strong** | A plausible bug in the code makes it fail, and a correct change to how the code works does not | Keep it |
| **shallow** | It can fail, but misses the likely bugs: happy path only, defined or truthy checks, loose matchers | Add the case it misses: an edge, an error, a boundary |
| **brittle** | It checks real behaviour but also fails on correct changes: large snapshots, exact mock calls, implementation details, timing | Assert on behaviour, not on how the code does it |
| **hollow** | No real bug can make it fail: no assertion, a tautology, it tests the mock | Rewrite it to assert on what the code does |
| **duplicate** | Another test in the file already catches the same bugs. The reason starts `Repeats "…", keep "…"`, and of two tests that repeat each other only the one to delete is marked | Delete it, or merge it into the one to keep |

Shallow and brittle are opposite problems: a shallow test misses bugs, and a brittle one raises false alarms. Where more than one grade fits, the grader gives the first of hollow, duplicate, shallow, brittle, and lists and notes put them in that order, worst first. Shallow, brittle, hollow and duplicate tests are *flagged*. Grades kept from before (good, weak, useless) read as strong, shallow and hollow.

## What it does

### The Tests pane

The pane opens at session start, or with `/test-grader`. It shows:

- **Every test in the project.** It lists them from the start: tests in files git tracks, and new files git would track. They show as ungraded until they are graded. A `.test-grader-ignore` file at the project's root leaves test files out of the list and of grading, one pattern per line as `.gitignore` reads them: `.agents/` (a folder at any depth), `/legacy/old/` (from the root), `**/*.snap.test.ts`, and `#` for a comment.
- **Tests grouped by folder and file, worst first.** The pane draws the project's folders as a tree. Each folder's row shows the counts for every test beneath it, and its line coverage when a coverage report has it. A folder holding only one subfolder shares its row, as in `gateways/api/`. When tests sit in a single folder, no folder row is drawn, and the list reads flat.
- **Folders and files start closed among siblings.** One alone at its level starts open. Each opens with a press. What you open stays open across a reload of the mod or a compaction. A new session starts everything closed again.
- **Go testify suites as their own group.** A suite spread over several files is one group, listing its files. A `Test…` function that only runs the suite is not counted as a test.
- **A verdict per test.** Each test gets a one-line summary and a one-line reason. Verdicts sit in one column on the first line of the title. Pressing a row shows its details.
- **Badges.** *new* marks a test written this session, and *modified* a test that was there before and was edited this session. A file or folder row carries a badge when a test beneath it does.
- **A summary line.** It shows the counts of tests and strong ones, then each other grade, new and modified when there are any.
- **The last run.** Below the summary: how many tests it graded and how many it remembered, and what its grader calls cost: in tokens (in, of them from the prompt cache, and out), and in dollars at the Claude API's list prices for the model asked for. Haiku 5.5 is priced by each call's prompt length, higher over 100,000 tokens. An alias is priced as its family's latest model, and a call to a model with no listed price, such as a gateway's own, is counted as unpriced.
- **Open in editor.** This button opens the test at its line (see [Opening a test in your editor](#opening-a-test-in-your-editor)).
- **Run test.** This button runs the one test with the project's runner. The row then says whether it passed, with the command, and, when it failed, the end of what it printed (see [Running one test](#running-one-test)).
- **Coverage figures.** These show when the project has a coverage report (see [Coverage](#coverage)).

### Grading

- **Claude is told in advance.** A section of the system prompt tells Claude how to write a test that grades strong:
  - assert on behaviour, not on mocks;
  - ask which bug would make the test fail;
  - one behaviour per test;
  - cover edges and errors;
  - mock only I/O, time and randomness;
  - stay deterministic.

  The section also points Claude to the guide for each language the project's tests are in (see [Language guides](#language-guides)). Once it is done writing tests, Claude calls `test_grades` with `written: true` and fixes each flagged test as its grade asks, or proves it is better than rated.
- **New tests are graded as they are written.** When Claude writes or edits a test file, each new test is sent to the grader and tracked in the pane as new.
- **Edited tests are graded again.** test-grader compares the file before and after an edit, and each test whose text changed is graded again, strong ones too. That includes an edit inside a test's body that never touches its name, and an edit that only removes lines. A test that is deleted leaves the pane.
- **Grades arrive as notes, never as prompts.** A flagged grade on a test Claude wrote or edited is added to the conversation as a note, with the fix for each grade. So are the results of Grade all, Regrade all, `/test-grader diff` and a coverage run. No new turn starts for it. Claude reads the note in the turn under way, or in the next one.
- **One note per round.** Grades wait while grading is still under way, then go out together as one note. A test graded twice before then is listed once, with its latest grade. A flagged test regraded strong before its note goes out drops out of the note: it is not told as flagged.
- **Accepted tests are told too.** When a test that was flagged is graded strong, the note says so.
- **A regrade shows the grade before.** When an edited test is graded again, the grader is shown its grade before the edit and asked to say whether the change met that concern, and to flag it again only for a real gap, naming a new concern as new. When it is flagged again, the note and `test_grades` show its grade before under the new one (`Before: shallow — …`), unless the two are word for word the same.
- **Notes wait for subagents.** While a subagent is still running, the grades of the tests it is changing wait. They go as one note when it finishes, or after 10 minutes at most.
- **Three rounds per test.** A test still flagged after three rounds is reported once more, telling Claude to tell you what is left. After that, test-grader stops on it. Evidence the grader rejects counts as a round too.
- **A suggestion after the turn.** When a turn ends with flagged tests Claude wrote, the prompt box offers "Fix the 2 flagged tests you wrote this session", once for each set of such tests. It is only a suggestion: nothing is sent unless you send it.
- **The pane follows the files as they change.** Every 2 seconds, the listed test files are checked for changes made outside Claude's Write and Edit: by the shell, an editor or a checkout. Their new and removed tests show at once, and changed tests are graded again. A file whose modification time has not changed is not read again. Right after each shell command, and every 10 seconds otherwise, the project's test files are listed again. A new one is graded as if Claude had written it: a test file made by the shell, or by a subagent whose worktree was merged in, is graded and shows as new. When more than 10 new test files turn up at once, a checkout or a pull brought them: they show ungraded, with no grader call, for Grade all to grade. A removed file leaves the pane with its grades. If the watcher lists a file before Claude's write of it is seen, the write still grades its tests. The same check runs at the end of each turn.
- **Grade all tests** grades the whole project. It grades only the tests not rated yet: in a file changed since its last grading, the tests whose own text changed (a test whose own text is as it was graded keeps its grade, so fixing one test does not regrade its neighbours), and in an unchanged file only the tests with no verdict (the rated ones keep theirs). Grades from before 0.7.2 have no record of their test's text, so their changed files are graded whole once more. Rows waiting for the grader are marked *reviewing*. Files are read while the first ones are already being graded. A file git lists but that cannot be read (deleted, or too large) is passed over, and the pane says so. When the run finishes, its result goes to Claude as a note: the counts, the files changed since their last grading and those graded for the first time (once the project has been graded before), then the flagged tests, worst first: hollow, then duplicate, shallow and brittle. No turn starts for it. A big run lists 40 flagged and 40 unrated tests by name and counts the rest by file, so the note doesn't fill Claude's context. `test_grades` with `path` lists a file's or folder's in full.
- **Stop** cuts a run short. No more grader calls start, the tests not yet graded keep what they had, and the pane says how far the run got. The next run grades the rest.
- **Regrade all** grades every file again, unchanged ones included.
- **↻ Regrade** on a folder's, a file's or a suite's row grades just those files again, the rest of the project's grades left as they are. Claude's note names what was graded, as in "finished for src/api/".
- **`/test-grader diff`** grades only the test files changed on this branch: against where it left `main` (or `master`), with the changes not committed yet and new files. The rest of the project's grades stay as they are.
- **Looped tests are graded case by case.** A test whose name is a template, like `` it(`rounds ${name}`) `` inside a loop, or `it.each`'s `'adds %i and %i'` and `'$label maps to $code'`, becomes one entry per case the loop or table generates. Graded again, each case is sent with its loop's code, and the grader is told which loop the case comes from.
- **Tests of one name are told apart.** Two tests named alike in one file are named by the groups around them, as in `parser › empty input` and `lexer › empty input`. Failing that, they are named by their order: `works`, `works (2)`.

The grader is `haiku` by default: the alias, which Claude Code resolves to the Haiku its account, provider or gateway is set up with. It reviews up to 10 tests per call, with up to 10 calls at once.

#### Keeping false flags down

- **Strong unless shown otherwise.** The grader defaults to strong, and where it is unsure it answers strong. It judges a test against the whole file: one case is enough when other tests cover the edges, or when that case is all the test's name promises. It never marks a test down for code it cannot see.
- **Shallow needs a named bug.** A shallow grade must name a bug the test would let through: an input, and the wrong result it would still pass. That bug is added to the reason, as the case to add. A shallow grade with none counts as strong.
- **A flag is confirmed before it is told.** When a first, quick pass flags a test, a second, more careful call checks it: the second-look model when one is set, else the grader model at its own effort. The flag stands only if that call agrees, and its grade and reason are the ones given. If that call fails, the first grade stands, and the pane says the call failed. Tests graded strong cost no second call.
- **Strict mocks count as assertions.** A gomock controller fails a test on any call it was not told to expect, and an `EXPECT()` with no `Times` means exactly once; mockery and Mockito's strict stubs work the same way. The grader is told so, and never calls such a test hollow or shallow for passing if the mock is never called.
- **A contract is not an implementation detail.** Exact names, order or shapes that callers rely on, such as the steps a plan holds or the keys of a payload, are behaviour: asserting them is not brittle.
- **Each grade says how sure it is.** The grader rates its confidence: high when the source shows the verdict plainly, medium when it rests on code it can only partly see or on a judgement call, low when another careful reviewer could fairly grade it otherwise. A medium or low grade says so on its row ("low confidence"), in `test_grades` and in Claude's notes, so a grade that may read otherwise on a regrade can be told from a settled one.
- **A regrade keeps grades steady.** The grader gives no fixed answers, so the same test can read differently from one run to the next. When Regrade all, a row's Regrade or `test_grade` with `again` grades a file unchanged since its last grading, the grader is shown each test's last grade and reason, and is told to keep it unless it finds it wrong, saying what the last grade got wrong.
- **A grade is for the text it read.** If a test's own code changes while it is being graded, by an outside edit, the grade is thrown away and the test is graded again on its new code. A change elsewhere in the file leaves the grade be.

#### What the grader reads

- **The test file.** A file under 40,000 characters is sent whole, so the grader sees what the other tests cover. A longer file is sent as an excerpt: the file's head, every test under review in full, and the helpers and constants those tests use, wherever in the file they are declared. Other tests are left out, but named (up to 80): the grader is told a case one of them covers by its name, such as `TestDelta_ThresholdBoundary`, is not missing.
- **The code under test.** The grader judges each assertion against what that code really does. It reads up to four files, 16,000 characters in all:
  - in JavaScript and TypeScript, the files the test imports by a relative path;
  - in Python, `from … import` modules;
  - in Ruby, `require_relative` files;
  - in Go, the package's other files;
  - in Java and Kotlin, the class under `src/main` the test is named for.
- **Your project's rules.** A `.test-grader.md` file at the project's root is read at session start and at the end of each turn, and the grader is told its rules after its own. Use it to allow snapshots, or to ask for property tests.

The rubric and the file go first in each call, marked for the prompt cache, so the next batch of the same file reads them from the cache. The first grade asks for little thought (`effort: low`).

#### When the API fails

A grader call that the API answers with *overloaded*, *rate limited* or a server error is tried again up to three times. The waits are 2, 4 and then 8 seconds, each with up to a second more, so parallel calls do not retry together. Any other error leaves the tests unrated, and the pane says why in red above the list and on each unrated row: the model it asked and the API's answer, such as `The grader (haiku) gave no answer: api-error 404 not_found_error.` It stays until a grader call answers. A model the account or its provider does not offer is the usual cause: set `graderModel` to one it does. A call the engine refuses to send, as it does a model blocked by the account's settings or a gateway's, fails at once and says so the same way. An older Claude Code that takes less of a request (`model.complete: takes { model, prompt }`) is asked again plainly: the texts unmarked and no effort, then the model and one prompt alone, the rubric leading it; the first form it takes is kept for the session. An answer holding no verdict for the tests asked about leaves them unrated too, and the pane quotes the start of what came back; the debug log has more of it. Each call may take two minutes at most.

#### Why a test is unrated

An unrated test says why on its row, in `test_grades` and in the report, as its last grader call left it:

| What happened | What the row says |
| --- | --- |
| The engine refused the call | the model and the refusal, such as a blocked model |
| The API gave no answer | the model, the status and the API's error |
| The reply was cut off at its 8,000-token limit | that, and how many of the batch's tests it answered (a table test's many cases count as one) |
| The reply held no verdict at all | the start of what came back |
| The reply held a verdict for the test that could not be read | that verdict as it came back, such as one with an unknown grade |
| The grader answered under a name no test was asked by | the names it used |
| The grader left the test out | how many of the batch's verdicts it gave |
| The grading failed outright | the error |

A test whose cases run inside it, such as a Go table test with `t.Run` subtests, gets one verdict. The grader is asked for one verdict per test. When it still grades case by case (`TestX › xdr role`, `TestX/xdr_role`), the cases' verdicts count for the test: the worst of them, its reason naming the case that earned it. A verdict under the test's own name wins over its cases'.

A verdict whose name differs from one test's only in its quotes, dashes, escapes or spacing counts for that test: a grader often echoes `subagent’s` as `subagent's`. Two tests that read alike that way get neither verdict. A verdict named with the `describe` groups around its test, such as `ApiClient › post › retries` for `retries`, counts for the test asked whose name the verdict's ends with, when only one test has that ending. So does one whose group is joined by a space or a colon (`parseDebugId reads the debug ID` for `reads the debug ID`): the longest test asked the name ends with, where a space or a colon comes before it.

The reason is kept with the grades, and goes once the test is graded. `test_evidence` answers with it too, when the grader gives no verdict on the evidence.

#### Grader settings

| Setting | Values | Default | What it does |
| --- | --- | --- | --- |
| **Grader model** (`graderModel`) | an alias (`haiku`, `sonnet`, `opus`) or a model id | `haiku` | the model that grades; the alias follows the Haiku Claude Code is set up with. A model id is used exactly as set, so a gateway's own ids work. |
| **Second-look model** (`graderEscalate`) | `off`, an alias or a model id | `off` | a model that grades again what the first grade flagged: it confirms a first flag before Claude is told, and grades an edited test whose last grade was flagged, evidence and verified mutations. An edited test graded strong stays with the grader model. |
| **Grader workers** (`graderWorkers`) | 1 to 20 | 10 | how many grader calls Grade all tests runs at once |

Change them in the `/config` menu, where a change applies to the next grader call, or in `~/.claude/settings.json`, read when Claude Code starts:

```json
{ "pluginConfigs": { "test-grader": { "graderModel": "haiku", "graderEscalate": "sonnet", "graderWorkers": 4 } } }
```

When the mod is loaded straight from its folder, the key is `test-grader@inline` instead. Every grading after a change uses the new settings.

#### Which tests are found

Only code counts. A test written inside a string literal or a comment, such as a fixture in a test of a test tool, is not taken for one of the file's tests. Each language's patterns are used only in that language's files.

| Language | Test files | Tests |
| --- | --- | --- |
| JavaScript and TypeScript | `*.test.*`, `*.spec.*`, files in `__tests__/`, `test/` or `tests/` | `it(…)`, `test(…)` and `Deno.test(…)`, with `.only`, `.skip`, `.concurrent`, `.todo`, `.fails` and `.each` |
| Go | `*_test.go` | `func TestX(…)`, and testify suite methods `func (s *Suite) TestX()`; not `TestMain`, which sets the package's tests up |
| Python | `test_*.py`, `*_test.py` | `def test_x`, in a class or not |
| Ruby | `*_test.rb`, `test_*.rb`, `*_spec.rb` | `def test_x`, `test "…" do`, and RSpec's `it`, `specify`, `example` and `scenario` |
| Swift | `*Test.swift`, `*Tests.swift` | `func testX()`, and Swift Testing's `@Test func` |
| Java and Kotlin | `*Test`, `*Tests`, `*Spec`, `*IT` `.java`/`.kt`, and files under `src/test/` | methods under `@Test`, `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory` |
| C# | `*Test.cs`, `*Tests.cs` | methods under `[Fact]`, `[Theory]`, `[Test]`, `[TestMethod]`, `[TestCase]` |
| PHP | `*Test.php`, `*Tests.php` | `function testX`, methods under `#[Test]` or `@test`, and Pest's `it(…)` and `test(…)` |
| Rust | files in `tests/`, `tests.rs`, `test.rs`, `*_test.rs` | functions under `#[test]`, `#[tokio::test]`, `#[rstest]`, `#[test_case]` |

### Language guides

The `guides/` folder holds a short guide to writing tests that grade strong for each language:

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

Claude can look up flagged tests itself instead of waiting to be told. The system prompt tells it to call `test_grades` once it is done writing tests.

By default the tool lists the flagged tests, worst first, after a line of counts. Each test comes with its file and line, what it checks, and why it got its verdict. A test Claude is strengthening also shows its round, or that its rounds are spent.

| Input | What it does |
| --- | --- |
| `verdicts` | which tests to list: `hollow`, `duplicate`, `shallow`, `brittle`, `unrated`, `reviewing`, `ungraded`, `strong`. The default is the four flagged grades and `unrated`. |
| `path` | only the tests in this file or folder |
| `written` | only the tests written or edited this session |
| `limit` | how many tests to list at most, 50 by default. The answer says how many it left out. |

The tool reads the grades the pane shows and starts no grading. Tests still being graded are counted, and the answer says to ask again in a moment. After the counts, it names the files the last grading run graded again because they changed, and those it graded for the first time, within `path` (not with `written`).

If the session loses test-grader's tools during a long run, they are registered again at the end of the turn, so the next prompt has them back.

#### Grading now: `test_grade`

Claude can grade tests itself, as Grade all tests does, and wait for the result: the counts, then every flagged and unrated test. That answer is the tool's result, so no note follows. It asks for no permission.

| Input | What it does |
| --- | --- |
| `path` | only the test files in this file or folder. The default is the whole project. |
| `again` | grade every test in scope again, the rated ones too, as Regrade all does |

By default it grades the tests not rated yet and keeps the grades that stand, so it is the way to retry unrated tests. While another run is under way it says so and grades nothing.

#### Measuring coverage now: `test_coverage`

Claude can run the project's coverage itself and wait for the figures, for instance after writing tests to raise a folder's coverage. The answer gives the folder's figure before and after the run, the project's figure, and the least covered folders under it. Claude is told to call it, with the folder, once it is done writing tests for coverage. The pane shows the run as Run coverage does.

| Input | What it does |
| --- | --- |
| `path` | a folder, absolute or relative to the project. The default is the whole project. |

In a Go project a folder's run measures its packages alone (`go test ./<folder>/... -cover -coverprofile=…`), far faster than the whole module. Its blocks replace that folder's in the last profile, so every other package keeps its last figures. Elsewhere the project's whole coverage run is made, and the folder's figure is read from its report. If the tests fail, the answer gives the figures of what ran and the end of what it printed. The tool runs the project's tests, so Claude Code asks you before it runs.

#### What the grader read: `test_context`

When a grade looks wrong, `test_context` shows exactly what a plain grade of that test sends the grader: the test file (whole, or the excerpt and the names of the tests it leaves out), the code under test it was given, the project's rules, what it is asked, and the test's last grade. It tells a misjudged test from a grader that could not see the helper or the sibling test it needed. It asks for no permission.

| Input | What it does |
| --- | --- |
| `file` | the test file, absolute or relative to the project |
| `test` | the test's name, as `test_grades` lists it |

#### Sending evidence: `test_evidence`

When a test is better or worse than its rating, Claude can send evidence. The best evidence is a mutation of the code that makes this test fail, with the command run and the output before and after. The grader cannot run code. It checks each claim against the source and the code under test, and it rejects evidence that only says the test passes, or that it has coverage. A verdict given on evidence is marked as such in the pane, and it holds while the test's own code is unchanged: edits to other tests, Grade all and Regrade all leave it be. An edit to the test itself grades it again, without the evidence.

#### Measured evidence: `test_verify`

`test_verify` measures the evidence instead of taking Claude's word for it:

1. It runs the test unchanged with the project's runner. The test must pass.
2. It replaces one exact piece of text (`find`) in the `mutate` file, the code under test. The piece must be found in that file exactly once, and the file must not be a test file.
3. It runs the test again.
4. It puts the file back as it was, and checks that it is.

If the mutated code did not build (Go's `[build failed]` or a compiler error, TypeScript's `error TS…`, a `SyntaxError`, Rust's `error[E…]`, a Java, Kotlin or C# compilation error), the test never ran, so the tool refuses it as measuring nothing and asks for a change that compiles. If the test failed with the mutation, the commands and their output go to the grader as evidence, and the test is regraded. A test a measured mutation made fail is never graded hollow. If the test still passed, nothing is regraded, and the tool says the test does not catch that change. With `siblings: true`, the file's other tests (up to 20) are run too while the mutation is in place, and the answer and the evidence say which of them also fail: "this test alone catches the change", or which others do. A test that also fails on the unchanged code is run again to check, and is not counted. This tool runs commands and changes a file for a moment, so Claude Code asks you before it runs.

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

The pane offers **Run coverage** when it finds a way to measure it, in this order:

| Project | Command |
| --- | --- |
| `package.json` with a `coverage` script | `npm run coverage` |
| `package.json` with vitest | `npx vitest run --coverage` |
| `package.json` with jest | `npx jest --coverage` |
| `pytest.ini`, `pyproject.toml` or `setup.cfg` | `pytest --cov` |
| `go.mod` | `go test ./... -cover -coverprofile=.test-grader-go-cover.out` |

**A project of parts.** When the root has none of these, each top-level folder that holds tests and has one of its own is a part: a Go `backend/` and a jest `mobile/`, say. Run coverage runs every part's in its own folder, at once. The pane shows each part's figures under its folder (Go's statements and jest's lines don't add up to one figure), each folder's row shows its part's kind of figure, and Go's packages are named by their path in the project. `test_coverage` on a folder runs only the part it's in, a Go folder by its packages.

It reads the figures from `coverage/coverage-summary.json`, `coverage/lcov.info`, `coverage.xml` or Go's coverage profile. It shows lines, statements, branches and functions where the report has them. From a per-file report, `coverage-summary.json` or `lcov.info`, it also sums the line coverage of each folder and shows it on the folder's row.

Go measures statements alone, so a Go project shows statements and nothing else: Go has no line, branch or function figures to show. From the profile, the total is weighted by each file's statements, a block two test runs both cover counts once, and each folder's row shows its own statement coverage. Under the total, each package gets its own Statements bar, least covered first: the first eight, then how many more there are and the best of them. Press that line to show every package; press again for the eight alone. A package's bar is the coverage of all its tests together: Go measures a package's tests as one run, so a testify suite gets no figure of its own. A run that wrote no profile falls back to the plain mean of the per-package figures `go test` printed.

The pane follows the report: one written by a run outside the pane, from the shell or CI, shows within 2 seconds. The run is found as the session starts.

#### The project is the folder the session started in

The pane lists, grades and measures coverage for the folder the session started in. A session that later moves into a subfolder, as when Claude changes directory to run a command, keeps that folder: its tests, its coverage run and its rules. A reload of the mod or a compaction keeps it too. A new session takes the folder it starts in.

When a run finishes, Claude is told the figures in a note, along with the least covered folders: up to five of them, each under 80% with at least 20 lines. When a run fails, Claude is told how it failed, with the last lines it printed.

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

- **From this repository:** the repository is its own marketplace (`.claude-plugin/marketplace.json`). At the prompt of a terminal session, run:

  ```
  /plugin install test-grader --marketplace MWEJ/test-grader
  ```

  Answer `y` to add the marketplace, then choose a scope (user scope loads it in every session, the desktop app's included), then set the options. It is active at once.
- **For one session:** run `claude --plugin-dir /path/to/test-grader`.

## Development

```
claude plugin validate .
claude plugin test .
npm run coverage
```

The tests live in `tests/`, one file per area: the pane, Grade all, the grader, the notes, the tools, changes to test files, coverage, Open in editor, discovery and the runner commands. `tests/helpers.tsx` holds what they share: a project the mod runs in, its pane, and fixtures. They run in the engine's test kit, with the file system, processes and the model mocked. The state the mod keeps is declared in `types/index.d.ts`.

`claude plugin test` has no coverage of its own, so `scripts/coverage.mjs` measures it:

1. It copies the mod to a temporary folder.
2. It instruments the hooks with Istanbul.
3. It runs each test file in a process of its own (`claude plugin test --file`), as many at once as the machine has cores, with each test handing back the counters. One process's output is one file's alone, so the long counter lines never interleave.
4. It prints a table, and writes `coverage/lcov.info` and `coverage/coverage-summary.json`.

It needs Node and npm. It installs the Istanbul libraries once, into `test-grader-cov-deps` in the system's temporary folder, and reuses them on later runs.

The engine keeps every function that is handed the engine interface `$` in `hooks/register.tsx`, so only code that never touches `$` lives in other files.

| Path | What it holds |
| --- | --- |
| `hooks/register.tsx` | the hooks: grading, the notes, the pane, coverage, running tests, the tools, the commands |
| `hooks/prompts.ts` | what the models read: the grader's rubric, the system prompt's section, the notes' follow-ups, and the tools' descriptions and schemas |
| `hooks/discovery.ts` | which files hold tests, and which cases each declares, by language |
| `hooks/excerpt.ts` | what the grader reads of a long file, and what its reply holds |
| `hooks/kept.ts` | the grades as the store keeps them |
| `hooks/coverage.ts` | coverage figures by folder, the least covered, and the note a run sends |
| `hooks/gocover.ts` | Go's coverage profile, by file and package |
| `hooks/prices.ts` | what a grader call costs, at the Claude API's list prices |
| `hooks/runner.ts` | the command that runs one test |
| `hooks/settings.ts` | what a setting comes to: the grader model, the worker count |
| `hooks/verdicts.ts` | the grades, their order and fixes, the states a list shows, and the old grades' new names |
| `hooks/hooks.json` | names the module |
| `guides/` | the guide for each language that Claude reads before writing tests |
| `types/index.d.ts` | the state contract |
| `tests/*.test.tsx` | the test suite, by area |
| `tests/helpers.tsx` | what the test files share |
| `scripts/coverage.mjs` | the test suite's coverage |
