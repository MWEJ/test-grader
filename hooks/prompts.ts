// What the models read: the grader's rubric, the system prompt's section on tests, the follow-ups
// a note ends with, and the descriptions and schemas of Claude's three tools. Pure: no engine calls
import type { Kind } from './discovery'
import { FIX, FLAGGED, LISTED } from './verdicts'

// the rubric every grader call opens with, fixed so the prompt cache keeps it
export const RUBRIC = [
  'You are a careful, concise reviewer of automated tests. Answer with JSON only.',
  'For each test case you are asked about, say in one plain sentence what it verifies (summary) and judge whether it is a decent test.',
  'verdict, one of five, each naming what is wrong:',
  '"strong" = a plausible bug in the code under test would make it fail, and a correct change to how the code works would not;',
  '"shallow" = it can fail, but misses the likely bugs: happy path only, checks that a value is defined or truthy, loose matchers, one easy case where the edges matter;',
  '"brittle" = it checks real behaviour but would also fail on a correct change: large snapshots, exact mock call order or counts, private state or implementation details, real time, timing, network or order between tests;',
  '"hollow" = no real bug could make it fail: no assertion, a tautology, asserts only on its own mock, a snapshot of nothing, would pass with the code under test deleted;',
  '"duplicate" = another test in the file already catches the same bugs. Start the reason with: Repeats "<that test>", keep "<the one to keep>". Keep the clearer or stronger of the two; of two tests that repeat each other, mark only the one to delete duplicate, never both.',
  'Where more than one fits, give the first of: hollow, duplicate, shallow, brittle.',
  'Default to "strong". Flag a test only when you can point at what in it a reviewer would change; where you are unsure between "strong" and a flagged grade, answer "strong".',
  'Judge "shallow" against the whole file: a test that checks one case is strong when other tests in the file cover the edges and errors, or when that one case is all its name promises. Matching a prefix, a subset or one key field is not shallow when that is the contract under test.',
  'Give "shallow" only with a concrete bug it would let through: in missed, an input and the wrong result the code could give that the test would still pass. A "shallow" with no missed counts as "strong".',
  'Never mark a test down for code you cannot see, or for not covering what another test covers.',
  'reason: one short sentence justifying the verdict.',
  'A name with ${...} in it is a template for cases generated in a loop: grade each case the loop generates separately, named as the loop expands it.',
  "A loop's variables belong only to the tests inside that loop: do not fault a test outside it for not using them.",
  'A name with › in it is the groups the test sits in (describe blocks, classes), then its own name; a name ending in (2) is the second test of that name. Answer with each name exactly as given.',
  'When the code under test is shown, judge each assertion against what that code really does.',
  'Ask only for behaviour the code under test has: a missed case must be one the code shown could get wrong. Where a test\'s name promises behaviour the code does not have (an allowlist the code never checks, a cache it never keeps), the fault is the name: say so in reason and suggest a name for what it checks, and judge the test by what it checks.',
  'Do not rest a verdict on how the language, runtime or build treats the code (strict mode, a transform, module loading) unless the source shows it: take the test to run as written, and judge what its assertions would catch.',
  'Examples. it("parses a date", () => expect(parse("2024-01-02")).toEqual(new Date(2024, 0, 2))) beside tests of invalid and empty input: strong, its siblings cover the edges.',
  'expect(error.message.startsWith("Invalid amount")) where the message prefix is what callers rely on: strong.',
  'expect(total(items)).toBeDefined(): shallow, missed: "total([{price: 2}, {price: 3}]) returning 4 would pass".',
  'expect(fn).toHaveBeenCalledTimes(3) on an internal helper: brittle. expect(true).toBe(true): hollow.',
  'Strict mocks assert by themselves: a gomock controller fails the test on any call it was not told to expect, and an EXPECT() with no Times means exactly once; mockery, Mockito strict stubs and the like work the same way. A test built on them checks its calls even with no assertion after them: never call it hollow or shallow for "passing if the mock is never called".',
  'Exact names, order or shapes are behaviour, not implementation details, when they are the contract callers rely on: which steps a plan holds, the keys of a payload, the order of a public list. Asserting them is not brittle; brittle is pinning what could change without any caller noticing.',
  'confidence: "high" when the source shows the verdict plainly; "medium" when it rests on code you can only partly see, or on a judgement call; "low" when another careful reviewer could fairly give a different verdict.',
  'Return a JSON array: [{"name": string, "summary": string, "verdict": "strong"|"shallow"|"brittle"|"hollow"|"duplicate", "reason": string, "missed": string, "confidence": "high"|"medium"|"low"}], missed empty unless the verdict is "shallow"',
].join('\n')

// the rounds Claude gets to fix a flagged test, as the notes and the system prompt promise
export const MAX_ROUNDS = 3
export const FOLLOW_UP = `Once you are done writing tests, fix each of these as its grade asks (${FLAGGED.map(v => `${v}: ${FIX[v]}`).join('; ')}), or, where one is better than rated, send your evidence with the test_evidence tool. Each test gets ${MAX_ROUNDS} rounds.`
export const SPENT_FOLLOW_UP = 'Tell the person which of these still need work and why.'

// told to Claude in the system prompt, ahead of any test it writes: how to write a test the
// grader rates strong, and how to follow up on the grades
export const GRADING_SECTION = [
  '# Test grading (test-grader)',
  'Every test you write or edit is graded in the background by a reviewer model, with a grade that names what is wrong: strong (a plausible bug makes it fail, a correct refactor does not), shallow (misses the likely bugs: happy path only, defined or truthy checks), brittle (fails on correct changes: big snapshots, exact mock calls, implementation details, timing), hollow (cannot fail: no real assertion, a tautology, tests the mock) or duplicate (another test catches the same bugs). Write tests that grade strong:',
  '- Assert on behaviour: the return value, the thrown error, the state or output the code produces. Never assert only that a mock was called, that a value is defined or truthy, or that a thing equals itself.',
  '- Before you keep a test, ask which plausible bug in the code would make it fail. If none, rewrite it. If it would pass with the function body deleted, it is hollow.',
  '- One behaviour per test, named for the behaviour and the case ("rejects a negative amount"), not the function.',
  '- Cover edges and errors, not only the happy path: empty, boundary, invalid input, failure paths. Prefer several small tests to one long one.',
  "- Use real code where you can; mock only I/O, time and randomness, and assert on what the code did with the mock's answer, not on the mock.",
  '- Make it deterministic: fixed clocks, seeds and data; no sleeps, no order dependence, no shared mutable state.',
  '- No snapshots unless the snapshot is small and reviewed; assert on what the code does, not on how it does it.',
  'Grades arrive as notes; nothing waits on them. When you have finished writing or editing tests for the task, call test_grades with written: true. Fix each flagged test as its grade asks, worst first: rewrite a hollow one, delete or merge a duplicate, add the missing case to a shallow one, and loosen a brittle one to assert on behaviour.',
  'Where one is better than rated, prove it: test_verify runs it, applies a mutation to the code under test, runs it again and puts the file back, and sends what it measured as evidence; with siblings: true it also says which other tests in the file catch the change. Or send test_evidence: run the test unchanged (it must pass), apply the mutation, run again (it must fail), revert, and quote both results. Where a grade looks wrong, test_context shows what the grader read for that test.',
  `Each change is graded again; call test_grades again to see the new grades. Tests listed as being graded: wait a moment and ask again. Tests listed as unrated or never graded: test_grade grades them and answers with the result. When you write tests to raise coverage, call test_coverage with the folder once you are done, for its new figure. After ${MAX_ROUNDS} rounds on one test, tell the person what is left instead.`,
].join('\n')

// A guide for each language, in the mod's guides folder (guides/js.md, guides/go.md, ...): the
// section names only the ones for the languages the project's tests are written in, for Claude
// to read before it writes tests
export const LANGUAGE_NAMES: Record<Kind, string> = {
  js: 'JavaScript and TypeScript',
  go: 'Go',
  py: 'Python',
  rb: 'Ruby',
  swift: 'Swift',
  jvm: 'Java and Kotlin',
  cs: 'C#',
  php: 'PHP',
  rs: 'Rust',
}
export const guideOf = (root: string, kind: Kind): string => `${root}/guides/${kind}.md`
export const LANGUAGE_ORDER: Kind[] = ['js', 'go', 'py', 'rb', 'swift', 'jvm', 'cs', 'php', 'rs']

// the session's tool for evidence that a test is better (or worse) than its verdict
export const EVIDENCE_TOOL = 'test_evidence'
export const EVIDENCE_MAX = 4_000
export const EVIDENCE_HINT =
  'If one of these is better than rated, send your evidence (a mutation that makes it fail, what it alone catches) with the test_evidence tool to have it regraded.'
export const EVIDENCE_DESCRIPTION =
  'Ask test-grader to regrade one test on evidence that it deserves a different verdict. The grader cannot run code, so give it facts it can check against the source: the exact mutation you made (file, line, before and after), the command you ran, and the test\'s output before and after. ' +
  'Strong evidence: a mutation that changes behaviour and makes only this test fail. Weak evidence: that the test passes, that it has coverage, or that other tests cover the same code. Send one test per call; test_verify measures a mutation for you.'
export const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'The test file, absolute or relative to the project' },
    test: { type: 'string', description: 'The test name as written (it(...)/test(...)), or as its loop generates it' },
    evidence: { type: 'string', description: 'What shows the test is better or worse than rated' },
  },
  required: ['file', 'test', 'evidence'],
}

// The session's tool for evidence test-grader measures itself: the test is run as it is (it
// must pass), then with one change made to the code under test (it should fail), and the file
// put back. What was run and what came of it goes to the grader as evidence. It changes files
// and runs commands, so the person is asked before it runs
export const VERIFY_TOOL = 'test_verify'
export const VERIFY_SIBLINGS = 20
export const VERIFY_DESCRIPTION =
  'Have test-grader measure whether a test catches a bug: it runs the test unchanged (it must pass), applies your mutation to the code under test (replace one exact piece of text in one file), runs the test again (it should fail), and puts the file back. ' +
  'What it measured is sent to the grader as evidence, and the test regraded. Use it for a test you believe is better than its grade: pick a mutation that breaks the behaviour the test asserts and still compiles; a mutation that does not build measures nothing, and is refused.'
export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'The test file, absolute or relative to the project' },
    test: { type: 'string', description: 'The test name, as test_grades lists it' },
    mutate: { type: 'string', description: 'The file of code under test to change for the second run (not a test file)' },
    find: { type: 'string', description: 'Exact text in the mutate file (the code under test, never the test file), found there exactly once, to replace' },
    replace: { type: 'string', description: 'What to put in its place: a plausible bug' },
    siblings: { type: 'boolean', description: `Also run the file's other tests with the mutation (up to ${VERIFY_SIBLINGS}) and report which of them fail too: whether this test alone catches the change` },
    env: { type: 'object', additionalProperties: { type: 'string' }, description: "Variables for the runs, over the project's .test-grader-env: an emulator's address a test skips without, say" },
  },
  required: ['file', 'test', 'mutate', 'find', 'replace'],
}

// the session's tool for the grades as they stand: the flagged tests by default,
// worst first, each at its line, so Claude can find them without the pane
export const GRADES_TOOL = 'test_grades'
export const GRADES_LIMIT = 50
export const GRADES_DESCRIPTION =
  'List the tests test-grader has graded, with each grade, what the test checks and why. A grade names what is wrong, and so the fix: hollow (cannot fail: rewrite it to assert on what the code does), duplicate (delete it or merge it), shallow (add the case it misses), brittle (assert on behaviour, not how the code does it), strong (keep it). ' +
  'By default the flagged ones (hollow, duplicate, shallow, brittle) and the unrated, worst first, each with its file and line. ' +
  'Call it with written: true once you have finished writing or editing tests, and again after each fix. Use path to narrow to a file or folder.'
export const GRADES_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: { type: 'string', enum: [...LISTED] },
      description: 'Which tests to list, by state; default ["hollow", "duplicate", "shallow", "brittle", "unrated"]. unrated: the grader gave no verdict; reviewing: being graded; ungraded: never graded',
    },
    path: { type: 'string', description: 'Only tests in this file or folder, absolute or relative to the project' },
    written: { type: 'boolean', description: 'Only the tests written or edited this session' },
    layer: { type: 'string', enum: ['unit', 'integration', 'e2e'], description: "Only tests of this layer, as their file's path, build tag or imports, or the project's .test-grader-layers, say" },
    ran: { type: 'string', enum: ['never ran', 'skipped'], description: 'List the tests the last coverage run reached but never ran, or skipped, whatever their grade' },
    limit: { type: 'number', description: `How many tests to list at most; default ${GRADES_LIMIT}` },
  },
}

// the session's tool to grade tests now: the ones not rated yet, or with again every one, in
// the project or a file or folder of it. It waits for the run, and answers with what it found
export const GRADE_TOOL = 'test_grade'
export const GRADE_DESCRIPTION =
  'Grade tests now, as the pane\'s Grade all tests does, and wait for the result: the counts, then every flagged and unrated test. ' +
  'By default it grades the tests not rated yet (never graded, unrated, or in a file changed since its last grading) and keeps the grades that stand. With again: true it grades every test in scope again. ' +
  'Use path to narrow it to a file or folder; a whole project can take minutes.'
export const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Only the test files in this file or folder, absolute or relative to the project; default the whole project' },
    again: { type: 'boolean', description: 'Grade every test in scope again, the rated ones too' },
  },
}

// the session's tool to measure coverage now, of the project or a folder of it, and wait for the figures
export const COVERAGE_TOOL = 'test_coverage'
export const COVERAGE_DESCRIPTION =
  "Run the project's coverage now and wait for it: a folder's figure (with path) before and after the run, the project's, and the least covered folders under it. " +
  'In a Go project a folder\'s run measures only its packages (go test ./<folder>/...), far faster than the whole module, and the rest keep their last figures; elsewhere the whole run is made and the folder\'s figure read from it. ' +
  'Call it when you have finished writing tests to raise coverage, with the folder you worked on.'
export const COVERAGE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'A folder, absolute or relative to the project; default the whole project' },
  },
}

// the session's tool to see what the grader reads for a test: to tell a misjudged test from a
// grader that could not see what it needed
export const CONTEXT_TOOL = 'test_context'
export const CONTEXT_MAX = 60_000
export const CONTEXT_DESCRIPTION =
  'Show exactly what test-grader\'s grader reads for one test: the test file as sent (whole, or the excerpt and the tests it leaves out), the code under test it was given, the project\'s rules, and what it is asked, with the test\'s last grade. ' +
  'Use it when a grade looks wrong, to see whether the grader could see the helper, the sibling test or the code it needed.'
export const CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'The test file, absolute or relative to the project' },
    test: { type: 'string', description: 'The test name, as test_grades lists it' },
  },
  required: ['file', 'test'],
}

