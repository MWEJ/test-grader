# test-grader

A Claude Code mod that grades how good your tests are. It lists every test in the project in a side pane. A model reviews each test, says in a sentence what it checks, and rates it **good**, **weak** or **useless**. Tests are graded as Claude writes them, and Claude is told about the weak ones so it can strengthen them.

## What it does

### The Tests pane

The pane opens at session start, or with `/test-grader`. It shows:

- **Every test in the project.** It lists them from the start: tests in files git tracks, ungraded until they are graded.
- **Tests grouped by folder and file, worst first.** The pane draws the project's folders as a tree. Each folder's row shows the counts for every test beneath it. A folder holding only one subfolder shares its row, as in `gateways/api/`. When tests sit in a single folder, no folder row is drawn, and the list reads flat.
- **Folders and files start closed among siblings.** One alone at its level starts open. Each opens with a press. What you open stays open across a reload of the mod or a compaction. A new session starts everything closed again.
- **Go testify suites as their own group.** A suite spread over several files is one group, listing its files. A `Test…` function that only runs the suite is not counted as a test.
- **A verdict per test.** Each test gets a one-line summary and a one-line reason. Verdicts sit in one column on the first line of the title. Pressing a row shows its details.
- **A summary line.** It shows the counts of tests, good, weak, useless and new.
- **Open in editor.** This button opens the test at its line (see [Opening a test in your editor](#opening-a-test-in-your-editor)).
- **Coverage figures.** These show when the project has a coverage report (see [Coverage](#coverage)).

### Grading

- **New tests are graded as they are written.** When Claude writes or edits a test file, each new test is sent to the grader and tracked in the pane as new.
- **Edits regrade weak tests.** Editing a test rated weak or useless grades it again, whether it was written this session or listed by Grade all tests. A test that is deleted leaves the pane.
- **Claude keeps going until the test is good.** A weak or useless grade on a test Claude wrote or edited goes back to Claude as a prompt. Claude then strengthens the test or sends evidence. Each new grade comes back the same way, so nobody has to pass grades on.
- **One prompt per round.** Grades wait while grading or a turn of Claude's is still running, then go out together as one prompt. A test graded twice before then is listed once, with its latest grade.
- **Accepted tests are told, not prompted.** When a test that was weak is graded good, Claude is told in the conversation, and no new turn starts.
- **Three rounds per test.** A test still weak or useless after three rounds is reported once more, asking Claude to tell you what is left. After that, test-grader stops asking about it. Evidence the grader rejects counts as a round too.
- **Changes made outside Claude are caught.** At the end of each turn, test files that changed since they were last seen are checked for new and removed tests.
- **Grade all tests** grades the whole project. It grades only the files that changed since their last grading. Rows waiting for the grader are marked *reviewing*. When the run finishes, Claude is asked to report the result and offer to strengthen the weak and useless tests, worst first.
- **Regrade all** grades every file again, unchanged ones included.
- **Looped tests are graded case by case.** A test whose name is a template, like `` it(`rounds ${name}`) `` inside a loop, becomes one entry per case the loop generates.

The grader is the `haiku` model by default. It reviews up to 10 tests per call, with up to 10 calls at once.

#### Grader settings

| Setting | Values | Default | What it does |
| --- | --- | --- | --- |
| **Grader model** (`graderModel`) | `haiku`, `sonnet`, `opus` | `haiku` | the model that grades |
| **Grader workers** (`graderWorkers`) | 1 to 20 | 10 | how many grader calls Grade all tests runs at once |

#### Choosing the grader model

The **Grader model** setting picks the model that grades: `haiku`, `sonnet` or `opus`. It defaults to `haiku`, the fastest and cheapest. Change it in the `/config` menu, or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "test-grader": { "graderModel": "sonnet", "graderWorkers": 4 } } }
```

When the mod is loaded straight from its folder, the key is `test-grader@inline` instead. A change reloads the mod, and every grading after it uses the new model. That includes new tests, regrades, Grade all and evidence.

#### What the grader reads

- A test file under 12,000 characters is sent whole.
- A longer file is sent as an excerpt. The excerpt has the file's head, every test under review in full, and the helpers and constants those tests use, wherever in the file they are declared. Other tests are left out, and the grader is told it is reading an excerpt.

#### Which tests are found

| Language | Test files | Tests |
| --- | --- | --- |
| JavaScript and TypeScript | `*.test.*`, `*.spec.*`, files in `__tests__/`, `test/` or `tests/` | `it(…)` and `test(…)`, including `.only`, `.skip` and `.each` |
| Go | `*_test.go` | `func TestX(…)`, and testify suite methods `func (s *Suite) TestX()` |
| Python | `test_*.py`, `*_test.py` | `def test_x` |
| Ruby | `*_test.rb` | `def test_x` |
| Swift | `*Test.swift`, `*Tests.swift` | `func testX()` |

Only code counts. A test written inside a string literal or a comment, such as a fixture in a test of a test tool, is not taken for one of the file's tests.

### Sending evidence to change a verdict

The mod gives Claude a `test_evidence` tool. When a test is better or worse than its rating, Claude can send evidence, such as a mutation of the code that makes the test fail, or what the test alone catches. The grader weighs the evidence against the test's source and answers with a new verdict and why. It cannot run code, so the evidence has to say what was run and what happened. A verdict given on evidence is marked as such in the pane. It holds while the file is unchanged.

### Coverage

The pane offers **Run coverage** when it finds a runner it knows:

| Project | Command |
| --- | --- |
| `package.json` with vitest | `npx vitest run --coverage` |
| `package.json` with jest | `npx jest --coverage` |
| `pytest.ini`, `pyproject.toml` or `setup.cfg` | `pytest --cov` |
| `go.mod` | `go test ./... -cover` |

It reads the figures from `coverage/coverage-summary.json`, `coverage/lcov.info`, `coverage.xml` or the Go output. It then shows lines, statements, branches and functions where the report has them. When a run finishes, Claude is told the figures, or how the run failed with the last lines it printed.

### Opening a test in your editor

**Open in editor** tries these in order:

1. The editor named by `VISUAL` or `EDITOR`, when it can go to a line. A terminal editor is passed over.
2. The system's default app for the file, at the test's line. On macOS this comes from Launch Services, on Windows from the registry, and on Linux from the file's `.desktop` handler.
3. The file as the system opens it: `open`, `xdg-open` or `start`.

Editors that open at a line include VS Code and its forks (Cursor, Windsurf, VSCodium, Antigravity), Zed, Sublime Text and the JetBrains IDEs. If nothing opens, the pane says why.

### Grades outlive the session

Grades are saved per project, with a fingerprint of each file. A new session lists them straight away, and **Grade all tests** then grades only the files that changed. Tests removed while no session was watching are pruned at session start.

A reload of the mod does not lose grading in progress. If a run, a regrade or a new test's grading was cut off, it starts again at the next session start. A Regrade all that was cut off resumes as a Regrade all.

## Install

The mod is a Claude Code plugin made of one hooks module.

- **For one session:** run `claude --plugin-dir /path/to/test-grader`.
- **From this repository:** run `/plugin install test-grader --marketplace MWEJ/test-grader`. This needs a marketplace file in the repository.

## Development

```
claude plugin validate .
claude plugin test .
```

The tests live in `tests/pane.test.tsx` and run in the engine's test kit, with the file system, processes and the model mocked. The state the mod keeps is declared in `types/index.d.ts`.

| Path | What it holds |
| --- | --- |
| `hooks/register.tsx` | the whole mod: discovery, grading, the pane, coverage, the evidence tool |
| `hooks/hooks.json` | names the module |
| `types/index.d.ts` | the state contract |
| `tests/pane.test.tsx` | the test suite |
