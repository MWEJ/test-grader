import { expect, test } from 'claude-code/testing'
import type { ExistingTest } from '../types'
import { attr, byDirOf, pct } from '../hooks/coverage'
import { asAsked, excerptOf, parseVerdicts, unratedWhy } from '../hooks/excerpt'
import { goProfileOf, moduleOf } from '../hooks/gocover'
import { keep, unkeep, type SavedGrades } from '../hooks/kept'
import { modelOf, workersOf } from '../hooks/settings'

// The pure modules, each behaviour on its own: what a setting comes to, Go's profile read,
// the grades as the store keeps them, coverage figures, and the grader's text work

test('a grader model set blank or not as text falls back to the default', () => {
  expect(modelOf(undefined, 'haiku')).toBe('haiku')
  expect(modelOf('   ', 'haiku')).toBe('haiku')
  expect(modelOf(42, 'haiku')).toBe('haiku')
  expect(modelOf({ model: 'opus' }, 'haiku')).toBe('haiku')
})

test('a grader model set as text is used as given, less the spaces around it', () => {
  expect(modelOf(' sonnet ', 'haiku')).toBe('sonnet')
  expect(modelOf('us.anthropic.claude-haiku-5-5-20260101-v1:0', 'haiku')).toBe('us.anthropic.claude-haiku-5-5-20260101-v1:0')
})

// the worker count as set, and what Grade all tests runs with: 1 to 20, a fraction rounded down
for (const [chosen, workers] of [
  [4, 4],
  [1, 1],
  [20, 20],
  [3.7, 3],
  [0, 1],
  [-5, 1],
  [25, 20],
] as const) {
  test(`grader workers set to ${chosen} run ${workers} at once`, () => {
    expect(workersOf(chosen)).toBe(workers)
  })
}

test('grader workers unset, or set to what is not a finite number, run the default 10', () => {
  for (const chosen of [undefined, null, NaN, Infinity, '4', true]) {
    expect([chosen, workersOf(chosen)]).toEqual([chosen, 10])
  }
})


test('a go.mod module path in quotes is read without them', () => {
  expect(moduleOf('// the service\nmodule "example.com/svc"\n\ngo 1.22\n')).toBe('example.com/svc')
})

test('a go.mod with no module line has no module path', () => {
  expect(moduleOf('go 1.22\n\nrequire example.com/dep v1.0.0\n')).toBeNull()
})

test('a profile\'s files inside the module are named by their path in the project, and their packages by their folder (\'./\' the root)', () => {
  const profile = 'mode: set\nexample.com/svc/main.go:3.1,5.2 2 1\nexample.com/svc/pkg/a.go:1.1,2.2 4 0\n'
  expect(goProfileOf(profile, 'example.com/svc', '/proj')).toEqual({
    statements: (2 / 6) * 100,
    byFile: [
      { file: '/proj/main.go', total: 2, covered: 2 },
      { file: '/proj/pkg/a.go', total: 4, covered: 0 },
    ],
    byPackage: [
      { name: './', total: 2, covered: 2 },
      { name: 'pkg/', total: 4, covered: 0 },
    ],
  })
})

test('a profile whose files lie outside the module keeps their import path, and its package is the import path\'s folder', () => {
  const profile = 'mode: set\nother.org/lib/x/y.go:1.1,2.2 3 1\nexample.com/svc/a.go:1.1,2.2 1 0\n'
  expect(goProfileOf(profile, 'example.com/svc', '/proj')).toEqual({
    statements: 75,
    byFile: [
      { file: 'other.org/lib/x/y.go', total: 3, covered: 3 },
      { file: '/proj/a.go', total: 1, covered: 0 },
    ],
    byPackage: [
      { name: 'other.org/lib/x/', total: 3, covered: 3 },
      { name: './', total: 1, covered: 0 },
    ],
  })
})

test('a profile read with no module path keeps every file\'s import path', () => {
  const { byFile, byPackage } = goProfileOf('mode: set\nexample.com/svc/a.go:1.1,2.2 1 1\n', null, '/proj')
  expect(byFile).toEqual([{ file: 'example.com/svc/a.go', total: 1, covered: 1 }])
  expect(byPackage).toEqual([{ name: 'example.com/svc/', total: 1, covered: 1 }])
})

test('an empty profile, or one with only its mode line, has no statement figure', () => {
  for (const profile of ['', 'mode: set\n', 'mode: atomic\n\n']) {
    expect(goProfileOf(profile, 'example.com/svc', '/proj')).toEqual({ statements: null, byFile: [], byPackage: [] })
  }
})

test('a package whose blocks hold no statements gets no bar', () => {
  const profile = 'mode: set\nexample.com/svc/empty/e.go:1.1,1.2 0 0\nexample.com/svc/a.go:1.1,2.2 2 1\n'
  expect(goProfileOf(profile, 'example.com/svc', '/proj').byPackage).toEqual([{ name: './', total: 2, covered: 2 }])
})


// a project's grades as a run leaves them: graded tests of two files, one test unrated
const GRADES: SavedGrades = {
  results: [
    { file: '/proj/a.test.ts', name: 'adds', verdict: 'strong', summary: 'Checks adds.', reason: 'Asserts the sum.' },
    { file: '/proj/a.test.ts', name: 'totals', verdict: 'shallow', summary: 'Checks totals.', reason: 'Empty only. It would miss: a wrong sum', evidence: 'mutated total', evidenceOf: 'a mutation' },
    { file: '/proj/b_test.go', name: 'TestB', verdict: 'duplicate', summary: 'Checks B.', reason: 'Repeats TestA.', suite: 'MathSuite' },
    { file: '/proj/b_test.go', name: 'TestC' },
  ],
  hashes: { '/proj/a.test.ts': 'h-a', '/proj/b_test.go': 'h-b' },
  finishedAt: 1_000_000,
}

test('grades kept and read back are the grades as they were', () => {
  expect(unkeep(keep(GRADES, false))).toEqual(GRADES)
})

test('grades kept lean are read back without their summaries, all else whole', () => {
  const withoutSummaries = GRADES.results.map(({ summary: _, ...t }) => t)
  expect(unkeep(keep(GRADES, true))).toEqual({ ...GRADES, results: withoutSummaries })
})

test('grades are kept short: each file once with its fingerprint, each verdict a letter, the empty fields at a row\'s end left off', () => {
  const saved: SavedGrades = {
    results: [
      { file: '/proj/a.test.ts', name: 'adds', verdict: 'brittle' },
      { file: '/proj/a.test.ts', name: 'subtracts', verdict: 'hollow', reason: 'Asserts nothing.' },
      { file: '/proj/a.test.ts', name: 'later' },
    ],
    hashes: { '/proj/a.test.ts': 'h-a' },
  }
  expect(keep(saved, false)).toEqual({ v: 2, files: { '/proj/a.test.ts': { hash: 'h-a', tests: [['adds', 'b'], ['subtracts', 'u', '', 'Asserts nothing.'], ['later', '']] } } })
})

test('a test kept with no grade is read back unrated', () => {
  const back = unkeep(keep({ results: [{ file: '/proj/a.test.ts', name: 'later' }], hashes: {} }, false))
  expect(back.results).toEqual([{ file: '/proj/a.test.ts', name: 'later' }])
})

test('grades kept with no finish time are read back with none', () => {
  const back = unkeep(keep({ results: [], hashes: { '/proj/a.test.ts': 'h-a' } }, false))
  expect(back).toEqual({ results: [], hashes: { '/proj/a.test.ts': 'h-a' } })
  expect('finishedAt' in back).toBe(false)
})

test('a test\'s evidence source is kept only along with its evidence', () => {
  const kept = keep({ results: [{ file: '/proj/a.test.ts', name: 'adds', verdict: 'strong', evidenceOf: 'a mutation' }], hashes: {} }, false)
  expect(kept.files['/proj/a.test.ts']!.tests).toEqual([['adds', 'g']])
})

test('a file whose tests are kept without its fingerprint is read back with no fingerprint', () => {
  const back = unkeep({ v: 2, files: { '/proj/a.test.ts': { tests: [['adds', 'g']] } } })
  expect(back).toEqual({ results: [{ file: '/proj/a.test.ts', name: 'adds', verdict: 'strong' }], hashes: {} })
})

test('grades kept in the oldest form read their old words as the nearest grade, and an unknown word as unrated', () => {
  const old = {
    results: [
      { file: '/proj/a.test.ts', name: 'a', verdict: 'good', reason: 'r' },
      { file: '/proj/a.test.ts', name: 'b', verdict: 'weak' },
      { file: '/proj/a.test.ts', name: 'c', verdict: 'useless' },
      { file: '/proj/a.test.ts', name: 'd', verdict: 'brittle' },
      { file: '/proj/a.test.ts', name: 'e', verdict: 'excellent' },
    ],
    hashes: { '/proj/a.test.ts': 'h-a' },
    finishedAt: 5,
  } as unknown as SavedGrades
  const expected: ExistingTest[] = [
    { file: '/proj/a.test.ts', name: 'a', verdict: 'strong', reason: 'r' },
    { file: '/proj/a.test.ts', name: 'b', verdict: 'shallow' },
    { file: '/proj/a.test.ts', name: 'c', verdict: 'hollow' },
    { file: '/proj/a.test.ts', name: 'd', verdict: 'brittle' },
    { file: '/proj/a.test.ts', name: 'e' },
  ]
  expect(unkeep(old)).toEqual({ results: expected, hashes: { '/proj/a.test.ts': 'h-a' }, finishedAt: 5 })
})


test('a coverage figure is rounded to one decimal', () => {
  expect(pct(66.666)).toBe(66.7)
  expect(pct(80)).toBe(80)
})

test('a coverage figure that is not a finite number is no figure', () => {
  for (const v of ['80', null, undefined, NaN, Infinity, -Infinity]) expect([v, pct(v)]).toEqual([v, null])
})

test('a Cobertura rate attribute reads as a percentage, and a missing one as none', () => {
  const xml = '<coverage line-rate="0.8567" branch-rate="0.5" version="1">'
  expect(attr(xml, 'line-rate')).toBe(85.7)
  expect(attr(xml, 'branch-rate')).toBe(50)
  expect(attr(xml, 'function-rate')).toBeNull()
})

test('a file with no lines adds no folder to the coverage by folder', () => {
  const files = [
    { file: '/proj/lib/empty.ts', total: 0, covered: 0 },
    { file: '/proj/src/b/c.ts', total: 10, covered: 4 },
  ]
  expect(byDirOf(files, '/proj')).toEqual({ '': { total: 10, covered: 4 }, src: { total: 10, covered: 4 }, 'src/b': { total: 10, covered: 4 } })
})


test('a long Python file is excerpted with its left-out tests noted in a Python comment', () => {
  const cases = Array.from({ length: 400 }, (_, i) => `def test_${i}():\n    assert f(${i}) == ${i}\n`).join('')
  const source = `import f\n\n${cases}`
  expect(source.length).toBeGreaterThan(12_000)
  expect(excerptOf(source, ['test_5'], 'tests/test_f.py')).toBe(['import f', '# … other tests left out …', 'def test_5():\n    assert f(5) == 5', '# … other tests left out …'].join('\n\n'))
})


test('a reply with no list in it holds no verdicts and is not cut off', () => {
  expect(parseVerdicts('I could not grade these tests.')).toEqual({ verdicts: [], isCut: false })
})

test('a verdict whose text holds quotes, braces and brackets is read whole', () => {
  const reply = String.raw`Here: [{"name": "says \"}\" then ]", "summary": "s {", "verdict": "strong", "reason": "r"}]`
  expect(parseVerdicts(reply)).toEqual({ verdicts: [{ name: 'says "}" then ]', summary: 's {', verdict: 'strong', reason: 'r' }], isCut: false })
})

test('a verdict holding a nested object is read whole', () => {
  const reply = '[{"name": "a", "verdict": "brittle", "reason": "r", "extra": {"lines": [1, 2]}}]'
  expect(parseVerdicts(reply).verdicts).toEqual([{ name: 'a', summary: '', verdict: 'brittle', reason: 'r' }])
})

test('a reply cut off before its closing bracket keeps the verdicts that arrived whole', () => {
  const reply = '[{"name": "a", "verdict": "strong", "reason": "r"}, {"name": "b", "verdict": "hol'
  expect(parseVerdicts(reply)).toEqual({ verdicts: [{ name: 'a', summary: '', verdict: 'strong', reason: 'r' }], isCut: true })
})

test('a malformed verdict is skipped and the rest still count', () => {
  const reply = '[{"name": "a",, "verdict": "strong"}, {"name": "b", "verdict": "hollow", "reason": "r"}]'
  expect(parseVerdicts(reply).verdicts).toEqual([{ name: 'b', summary: '', verdict: 'hollow', reason: 'r' }])
})

test('a verdict with no name, a name not text, or an unknown grade is dropped', () => {
  const reply = JSON.stringify([
    { verdict: 'strong', reason: 'no name' },
    { name: 3, verdict: 'strong' },
    { name: 'graded oddly', verdict: 'excellent' },
    { name: 'kept', verdict: 'hollow', reason: 'r' },
  ])
  expect(parseVerdicts(reply).verdicts).toEqual([{ name: 'kept', summary: '', verdict: 'hollow', reason: 'r' }])
})

test('an old grade word in a reply reads as the nearest grade', () => {
  const reply = JSON.stringify([
    { name: 'a', verdict: 'good', reason: 'r' },
    { name: 'b', verdict: 'useless', reason: 'r' },
  ])
  expect(parseVerdicts(reply).verdicts.map(v => [v.name, v.verdict])).toEqual([['a', 'strong'], ['b', 'hollow']])
})

test('a shallow verdict naming no bug it would miss is graded strong, and its reason says so', () => {
  const reply = JSON.stringify([
    { name: 'a', summary: 's', verdict: 'shallow', reason: 'Only checks it is defined.' },
    { name: 'b', summary: 's', verdict: 'shallow', reason: 'Thin.', missed: 5 },
    { name: 'c', summary: 's', verdict: 'shallow', missed: '   ' },
  ])
  expect(parseVerdicts(reply).verdicts).toEqual([
    { name: 'a', summary: 's', verdict: 'strong', reason: 'Only checks it is defined. (Graded strong: no bug it would miss was named.)' },
    { name: 'b', summary: 's', verdict: 'strong', reason: 'Thin. (Graded strong: no bug it would miss was named.)' },
    { name: 'c', summary: 's', verdict: 'strong', reason: '(Graded strong: no bug it would miss was named.)' },
  ])
})


// why a test asked about got no verdict, from the reply: what its row says, so it can be fixed
const ASKED = ['adds', 'subtracts']
const whyOf = (text: string, name: string): string | null => {
  const { verdicts, isCut } = parseVerdicts(text)
  return unratedWhy(text, verdicts, isCut, ASKED, name, 'haiku')
}

test('a test the grader gave a verdict for has no reason to be unrated', () => {
  expect(whyOf('[{"name":"adds","summary":"s","verdict":"strong","reason":"r"}]', 'adds')).toBe(null)
})

test('a test a cut-off reply did not reach is unrated for the reply\'s limit, with how far it got', () => {
  expect(whyOf('[{"name":"adds","summary":"s","verdict":"strong","reason":"r"},{"name":"subtr', 'subtracts')).toBe(
    "The grader's (haiku) reply was cut off at its 4000-token limit before it reached this test: it gave 1 of the 2 verdicts asked for.",
  )
})

test('a reply with no verdict in it says what came back', () => {
  expect(whyOf('I cannot   help\nwith that.', 'adds')).toBe('The grader (haiku) answered with no verdict it could read: "I cannot help with that.".')
})

test('a verdict for the test that could not be read is quoted as it came back', () => {
  expect(whyOf('[{"name":"adds","summary":"s","verdict":"strong","reason":"r"},{"name":"subtracts","summary":"s","verdict":"excellent","reason":"r"}]', 'subtracts')).toBe(
    'The grader (haiku) answered for this test, but its verdict could not be read: {"name":"subtracts","summary":"s","verdict":"excellent","reason":"r"}',
  )
})

test('a verdict under a name no test was asked by names what the grader called it', () => {
  expect(whyOf('[{"name":"adds","summary":"s","verdict":"strong","reason":"r"},{"name":"math › subtracts","summary":"s","verdict":"strong","reason":"r"}]', 'subtracts')).toBe(
    'The grader (haiku) gave no verdict under this test\'s name; it answered for "math › subtracts", which no test asked about is named.',
  )
})

test('a test the grader left out says how many of the batch it answered', () => {
  expect(whyOf('[{"name":"adds","summary":"s","verdict":"strong","reason":"r"}]', 'subtracts')).toBe(
    'The grader (haiku) left this test out of its answer: it gave 1 of the 2 verdicts asked for.',
  )
})

// the name a verdict came back under, against the names asked: a model echoing a name with
// its quotes, dashes, escapes or spacing changed still answers for that test
const v = (name: string) => ({ name, verdict: 'strong' as const })

test('a verdict echoing a curly apostrophe as a straight one answers for the test asked', () => {
  expect(asAsked(['no nudges for a subagent’s call'], [v("no nudges for a subagent's call")])).toEqual([v('no nudges for a subagent’s call')])
})

test('a verdict echoing a straight apostrophe as a curly one answers for the test asked', () => {
  expect(asAsked(["the engine's cap"], [v('the engine’s cap')])).toEqual([v("the engine's cap")])
})

test('a verdict with an escaped quote, a long dash or doubled spaces answers for the test asked', () => {
  const asked = ['keeps "quoted" text - as is', 'reads a file\'s tail']
  expect(asAsked(asked, [v('keeps \\"quoted\\" text — as  is'), v("reads a file\\'s tail")]).map(x => x.name)).toEqual(asked)
})

test('a verdict that differs from the test asked by more than its punctuation keeps its own name', () => {
  expect(asAsked(['adds two numbers'], [v('adds two number'), v('Adds two numbers')]).map(x => x.name)).toEqual(['adds two number', 'Adds two numbers'])
})

test('a verdict alike to two tests asked is given to neither', () => {
  expect(asAsked(["it's done", 'it’s done'], [v('it‘s done')]).map(x => x.name)).toEqual(['it‘s done'])
})

test('a verdict under a loop\'s case keeps the case\'s name', () => {
  expect(asAsked(['adds ${a} and ${b}'], [v('adds 1 and 2')]).map(x => x.name)).toEqual(['adds 1 and 2'])
})
