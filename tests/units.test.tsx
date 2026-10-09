import { expect, test } from 'claude-code/testing'
import type { ExistingTest } from '../types'
import { attr, byDirOf, coverageNote, mergeParts, packageViews, pct, testedLine } from '../hooks/coverage'
import { asAsked, excerptOf, foldCases, othersOf, parseVerdicts, unratedWhy } from '../hooks/excerpt'
import { goTagsOf, isBuildFailure, isNoneRun, runArgv } from '../hooks/runner'
import { charCount, nodeCount, printable, problemOf } from '../hooks/tree'
import { layerOf, layerRulesOf } from '../hooks/layers'
import { goRanOf, jsRanOf, mergeRan, ranStateOf, tagsOfArgv } from '../hooks/ran'
import { fits, ignoredBy, isTemplate } from '../hooks/discovery'
import { goProfileOf, isGenerated, isHelperName, moduleOf, roleOf } from '../hooks/gocover'
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
  const cases = Array.from({ length: 1500 }, (_, i) => `def test_${i}():\n    assert f(${i}) == ${i}\n`).join('')
  const source = `import f\n\n${cases}`
  expect(source.length).toBeGreaterThan(40_000)
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
    "The grader's (haiku) reply was cut off at its 8000-token limit before it reached this test: it gave 1 of the 2 verdicts asked for.",
  )
})

test('a cut-off reply counts the tests it answered, not the verdicts a table test\'s cases gave', () => {
  const rows = Array.from({ length: 5 }, (_, i) => `{"name":"adds ${i}","summary":"s","verdict":"strong","reason":"r"}`).join(',')
  const { verdicts, isCut } = parseVerdicts(`[${rows},{"name":"subtr`)
  expect(unratedWhy('', verdicts, isCut, ['adds ${n}', 'subtracts', 'multiplies'], 'subtracts', 'haiku')).toContain('it gave 1 of the 3 verdicts asked for.')
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

test('a verdict named with its describe groups answers for the test asked by the end of the name', () => {
  const asked = ['appends every file', 'sends the body']
  expect(asAsked(asked, [v('ApiClient.postMultipart › appends every file'), v('ApiClient › post › sends the body')]).map(x => x.name)).toEqual(asked)
})

test('a describe-prefixed verdict whose end is a group-qualified test asked answers for that test', () => {
  expect(asAsked(['post › retries'], [v('ApiClient › post › retries')]).map(x => x.name)).toEqual(['post › retries'])
})

test('a describe-prefixed verdict whose end fits two tests asked, or none, keeps its own name', () => {
  expect(asAsked(['retries', 'retries (2)', 'other'], [v('A › retries x')]).map(x => x.name)).toEqual(['A › retries x'])
  expect(asAsked(['adds ${n}', 'adds ${m} twice'], [v('Math › adds 1 twice')]).map(x => x.name)).toEqual(['Math › adds 1 twice'])
  // two fit its longer end: a shorter end that one test has does not settle it
  expect(asAsked(['adds ${n} › x', 'adds 1 › ${m}', 'x'], [v('Math › adds 1 › x')]).map(x => x.name)).toEqual(['Math › adds 1 › x'])
})

test('a case of a table test asked keeps its name, not taken for a group around another test', () => {
  // "parses › empty" is parses' case, though a test named empty was asked too
  expect(asAsked(['parses', 'empty'], [v('parses › empty')]).map(x => x.name)).toEqual(['parses › empty'])
})

test('a describe-prefixed verdict for an it.each case keeps the expanded case\'s name', () => {
  expect(asAsked(['adds %i and %i'], [v('Math › adds 1 and 2')]).map(x => x.name)).toEqual(['adds 1 and 2'])
})

test('a verdict named with its describe group joined by a space or a colon answers for the test it ends with', () => {
  const asked = ['reads the debug ID from the trailing //# debugId comment', 'targets a semantic version above 1.1.0']
  expect(asAsked(asked, [v('parseDebugId reads the debug ID from the trailing //# debugId comment'), v('release marketing version: targets a semantic version above 1.1.0')]).map(x => x.name)).toEqual(asked)
})

test('a name a test asked ends only part way into a word, or a test asked whole, is not taken for a group\'s prefix', () => {
  // "preads x" ends with "reads x" mid-word; the longest of two endings wins
  expect(asAsked(['reads x', 'x'], [v('preads x')]).map(x => x.name)).toEqual(['preads x'])
  expect(asAsked(['reads x', 'x'], [v('Group reads x')]).map(x => x.name)).toEqual(['reads x'])
})

test('an ignore list skips a folder at any depth, a rooted path, a glob, and keeps the rest; comments and blanks are no rules', () => {
  const isIgnored = ignoredBy('# agents\n.agents\n\n/legacy/old/\n**/*.snap.test.ts\nfixtures/\n')
  expect(isIgnored('.agents/skills/helper.test.js')).toBe(true)
  expect(isIgnored('mobile/.agents/a.test.ts')).toBe(true)
  expect(isIgnored('legacy/old/a.test.ts')).toBe(true)
  expect(isIgnored('src/legacy/old/a.test.ts')).toBe(false)
  expect(isIgnored('src/deep/view.snap.test.ts')).toBe(true)
  expect(isIgnored('src/fixtures/a.test.ts')).toBe(true)
  // a file named like a folder rule is not a folder
  expect(isIgnored('src/fixtures')).toBe(false)
  expect(isIgnored('src/agents/a.test.ts')).toBe(false)
  expect(isIgnored('# agents')).toBe(false)
})

test('an it.each name with printf marks or $fields is a template its expanded cases fit', () => {
  expect(fits('formats %s as %p', 'formats a as "a"')).toBe(true)
  expect(fits('row %# of %d', 'row 0 of 3')).toBe(true)
  expect(fits('$label maps to $out.code', 'empty maps to 404')).toBe(true)
  expect(fits('formats %s as %p', 'parses a as "a"')).toBe(false)
  expect(isTemplate('costs 5% more')).toBe(false)
  expect(isTemplate('pays $5')).toBe(false)
})

// a test the grader graded case by case, as one verdict under the test's own name
const TABLE = 'TestRoleGating_BuildsItems'
const graded = (name: string, verdict: 'strong' | 'shallow' | 'hollow' | 'brittle' | 'duplicate', reason = `${verdict} reason.`) => ({ name, summary: `Checks ${name}.`, verdict, reason })

test('a table test graded per case takes its worst case\'s verdict, the reason naming that case', () => {
  const folded = foldCases([TABLE], [graded(`${TABLE} › xdr role`, 'strong'), graded(`${TABLE} › overwatch role`, 'shallow', 'Misses an empty role.'), graded(`${TABLE} › falcon role`, 'brittle')])
  expect(folded).toHaveLength(1)
  expect(folded[0]!.name).toBe(TABLE)
  expect(folded[0]!.verdict).toBe('shallow')
  expect(folded[0]!.reason).toBe('Graded case by case ("xdr role", "overwatch role", "falcon role"); the case "overwatch role" is shallow: Misses an empty role.')
})

test('a table test whose cases are all strong is strong', () => {
  const folded = foldCases([TABLE], [graded(`${TABLE}/xdr_role`, 'strong'), graded(`${TABLE} > falcon role`, 'strong')])
  expect(folded.map(v => [v.name, v.verdict])).toEqual([[TABLE, 'strong']])
  expect(folded[0]!.reason).toMatch(/^Graded case by case \("xdr_role", "falcon role"\), each strong\./)
})

test('a verdict under the test\'s own name stands, and its cases\' are set aside', () => {
  const own = graded(TABLE, 'strong')
  expect(foldCases([TABLE], [own, graded(`${TABLE} › xdr role`, 'hollow')])).toEqual([own])
})

test('a case goes to the longest asked name it extends, not to a shorter name it starts with', () => {
  const folded = foldCases(['TestA', 'TestA_B'], [graded('TestA_B › one', 'hollow'), graded('TestA › two', 'strong')])
  expect(Object.fromEntries(folded.map(v => [v.name, v.verdict]))).toEqual({ TestA: 'strong', TestA_B: 'hollow' })
})

test('a name that only starts like an asked test, with no case mark after it, is left as it is', () => {
  const stray = graded(`${TABLE}Extra`, 'hollow')
  expect(foldCases([TABLE], [stray, graded(`${TABLE} more words`, 'strong')]).map(v => v.name)).toEqual([`${TABLE}Extra`, `${TABLE} more words`])
})

// of a file sent as an excerpt, the tests left out, named for the grader
const GO_FILE = 'internal/scale_test.go'
const goTests = (names: string[]) => names.map(n => `func ${n}(t *testing.T) {\n\tcheck(t)\n}\n`).join('\n')

test('an excerpt names the tests it leaves out, not the ones asked about', () => {
  const source = goTests(['TestDelta_LargeIncrease', 'TestDelta_ThresholdBoundary', 'TestDelta_Zero'])
  expect(othersOf(source, ['TestDelta_LargeIncrease'], GO_FILE)).toEqual([
    'The tests left out, by name: "TestDelta_ThresholdBoundary", "TestDelta_Zero". A case one of them covers by its name is not missing.',
  ])
})

test('an excerpt of a file whose every test is asked about names none left out', () => {
  expect(othersOf(goTests(['TestA', 'TestB']), ['TestA', 'TestB'], GO_FILE)).toEqual([])
})

test('an excerpt names at most 80 tests left out, and counts the rest', () => {
  const names = Array.from({ length: 83 }, (_, i) => `TestCase${i}`)
  const [line] = othersOf(goTests(['TestAsked', ...names]), ['TestAsked'], GO_FILE)
  expect(line).toContain('"TestCase79" and 3 more.')
  expect(line).not.toContain('"TestCase80"')
})

// a mutated run's output, told apart: the code did not build, or a test failed
for (const [what, tail] of [
  ['Go', 'FAIL\texample.com/shop/internal/gitops [build failed]'],
  ['Go compiler', '# example.com/shop/internal/gitops\ninternal/gitops/plan.go:12:3: undefined: stepss'],
  ['TypeScript', "src/add.ts(1,40): error TS2304: Cannot find name 'c'."],
  ['JavaScript', 'SyntaxError: Unexpected token )'],
  ['Rust', 'error[E0425]: cannot find value `x` in this scope'],
] as const) {
  test(`a ${what} build failure is told apart from a failing test`, () => {
    expect(isBuildFailure(tail)).toBe(true)
  })
}

test('a failing test is not taken for a build failure', () => {
  expect(isBuildFailure('--- FAIL: TestPlan (0.00s)\n    plan_test.go:40: got 3 steps, want 4\nFAIL\texample.com/shop/internal/gitops\t0.012s')).toBe(false)
  expect(isBuildFailure('FAIL src/a.test.ts\n  ● adds\n    Expected: 3\n    Received: -1')).toBe(false)
})

// how sure the grader was, read from its reply and kept with the grades
test('a verdict keeps the confidence the grader gave, whatever its case', () => {
  const { verdicts } = parseVerdicts('[{"name":"a","summary":"s","verdict":"brittle","reason":"r","confidence":"Low"},{"name":"b","summary":"s","verdict":"strong","reason":"r","confidence":"high"}]')
  expect(verdicts.map(v => v.confidence)).toEqual(['low', 'high'])
})

test('a confidence the grader left out or wrote as no known level is left off the verdict', () => {
  const { verdicts } = parseVerdicts('[{"name":"a","summary":"s","verdict":"strong","reason":"r"},{"name":"b","summary":"s","verdict":"strong","reason":"r","confidence":"very"}]')
  expect(verdicts.map(v => 'confidence' in v)).toEqual([false, false])
})

test('a medium or low confidence is kept with the grades, and a high one left out as the default', () => {
  const saved: SavedGrades = {
    results: [
      { file: '/p/a.test.ts', name: 'low', verdict: 'shallow', reason: 'r', confidence: 'low' },
      { file: '/p/a.test.ts', name: 'medium', verdict: 'strong', confidence: 'medium' },
      { file: '/p/a.test.ts', name: 'high', verdict: 'strong', confidence: 'high' },
    ],
    hashes: { '/p/a.test.ts': 'h' },
  }
  const back = unkeep(JSON.parse(JSON.stringify(keep(saved, false))))
  expect(back.results.map(t => [t.name, t.confidence])).toEqual([['low', 'low'], ['medium', 'medium'], ['high', undefined]])
})


// what the engine draws: it refuses a whole tree over an escape or half an emoji
test('a text cut inside an emoji keeps no half of it, the whole emoji kept', async () => {
  const cut = '🍅🍅'.slice(0, 3)
  expect(printable(`a${cut}b`)).toBe('a🍅\uFFFDb')
  expect(printable('\udc45 tail')).toBe('\uFFFD tail')
})

test('a run\'s colour codes and other control characters are dropped, its lines and tabs kept', async () => {
  expect(printable('\u001b[31mFAIL\u001b[39m a\n\tb\u0007\u001b]8;;https://x\u0007link')).toBe('FAIL a\n\tblink')
})

test('a tree counts each element and each text as a node, and the characters of its texts and string props', async () => {
  const tree = { type: 'Box', props: { key: 'k1', width: 3 }, children: [{ type: 'Text', props: {}, children: ['abc'] }, 'de'] }
  expect(nodeCount(tree)).toBe(4)
  expect(charCount(tree)).toBe(7)
})

test('a Go file\'s build tags are the ones its //go:build line asks for, not those it rules out', async () => {
  expect(goTagsOf('//go:build integration && !short\n\npackage x\n')).toEqual(['integration'])
  expect(goTagsOf('//go:build e2e || (integration && linux)\npackage x\n')).toEqual(['e2e', 'integration', 'linux'])
  // only above the package clause: a comment in the body is no constraint
  expect(goTagsOf('package x\n\n//go:build integration\n')).toEqual([])
})

test('a run that exited 0 having run no test is told apart from one that passed', async () => {
  expect(isNoneRun('ok  \texample.com/shop/x\t0.01s [no tests to run]')).toBe(true)
  expect(isNoneRun('testing: warning: no tests to run\nPASS\nok  \tx\t0.1s')).toBe(true)
  expect(isNoneRun('ok  \texample.com/shop/x\t0.01s')).toBe(false)
})

test('a run every test of which was skipped, or none matched, ran no test, whatever the runner', async () => {
  // Go -v: the test skipped itself
  expect(isNoneRun('=== RUN   TestA\n--- SKIP: TestA (0.00s)\nPASS\nok  \tx\t0.1s')).toBe(true)
  expect(isNoneRun('=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\nok  \tx\t0.1s')).toBe(false)
  // Jest, Vitest and pytest summaries with nothing passed or failed
  expect(isNoneRun('Tests:       16 skipped, 16 total')).toBe(true)
  expect(isNoneRun('Tests:       16 skipped, 1 passed, 17 total')).toBe(false)
  expect(isNoneRun('      Tests  17 skipped (17)')).toBe(true)
  expect(isNoneRun('      Tests  1 failed | 16 skipped (17)')).toBe(false)
  expect(isNoneRun('============ 3 deselected in 0.02s ============')).toBe(true)
  expect(isNoneRun('============ 1 passed, 3 deselected in 0.02s ============')).toBe(false)
  // Node's runner
  expect(isNoneRun('# tests 0\n# pass 0\n# fail 0')).toBe(true)
  expect(isNoneRun('# tests 1\n# pass 1\n# fail 0')).toBe(false)
})

test('a loop\'s template as a runner\'s pattern matches each of its cases, the rest of the name kept literal', async () => {
  const [argv] = [runArgv({ rel: 'src/q.test.ts', kind: 'js', plain: '%s -> %s', groups: ['is (q)'], line: 2 }, { js: 'jest' })]
  const pattern = new RegExp(argv![4]!)
  expect(pattern.test('is (q)   what now -> true')).toBe(true)
  expect(pattern.test('is (q) what now => true')).toBe(false)
  expect(pattern.test('is q what now -> true')).toBe(false)
})


// a test's layer, by its path, its text, and the project's rules
test('a test file under an e2e folder, or named for end-to-end, or driving a browser, is end-to-end', async () => {
  expect(layerOf('backend/tests/e2e/share_test.go', null)).toBe('e2e')
  expect(layerOf('backend/internal/server/recipe_share_e2e_test.go', null)).toBe('e2e')
  expect(layerOf('web/cypress/login.cy.ts', null)).toBe('e2e')
  expect(layerOf('web/tests/login.spec.ts', "import { test, expect } from '@playwright/test'\n")).toBe('e2e')
  // an e2e tag beats an integration one
  expect(layerOf('pkg/x_test.go', '//go:build integration || e2e\n\npackage x\n')).toBe('e2e')
})

test('a test file behind an integration tag, under an integration folder or named for it is integration; any other is unit', async () => {
  expect(layerOf('backend/internal/data/rate_test.go', '//go:build integration\n\npackage data\n')).toBe('integration')
  expect(layerOf('backend/cmd/x/delete_integration_test.go', null)).toBe('integration')
  expect(layerOf('tests/integration/test_db.py', null)).toBe('integration')
  expect(layerOf('src/test/java/StoreIT.java', null)).toBe('integration')
  expect(layerOf('tests/test_db.py', 'import pytest\n@pytest.mark.integration\ndef test_x(): pass\n')).toBe('integration')
  // a tag it rules out is no constraint to run under
  expect(layerOf('pkg/x_test.go', '//go:build !integration\n\npackage x\n')).toBe('unit')
  expect(layerOf('src/a.test.ts', "it('adds', () => {})\n")).toBe('unit')
  // a word inside a name is not a folder: "edit" is no "it"
  expect(layerOf('src/edit/form.test.ts', null)).toBe('unit')
})

test('a project\'s layer rules come first, the first that matches winning, its lines not rules passed over', async () => {
  const rules = layerRulesOf('# ours\nintegration: **/*.sqlite.test.ts\nend-to-end: maestro/\nunit: e2e/fakes/\nnonsense\n')
  expect(rules.map(r => r.layer)).toEqual(['integration', 'e2e', 'unit'])
  expect(layerOf('mobile/src/store.sqlite.test.ts', null, rules)).toBe('integration')
  expect(layerOf('maestro/flows/login.test.ts', null, rules)).toBe('e2e')
  expect(layerOf('e2e/fakes/clock.test.ts', null, rules)).toBe('unit')
  expect(layerOf('e2e/login.test.ts', null, rules)).toBe('e2e')
})

// which tests a coverage run ran
test('go test -v lines are read by the package line that ends them, subtests too, a package outside the module passed over', async () => {
  const out = ['=== RUN   TestA', '=== RUN   TestA/case_1', '    --- PASS: TestA/case_1 (0.00s)', '--- PASS: TestA (0.00s)', '=== RUN   TestB', '--- SKIP: TestB (0.00s)', 'PASS', 'ok  \tex.com/m/pkg/a\t0.1s', '--- FAIL: TestC (0.00s)', 'FAIL\tex.com/m\t0.1s', '--- PASS: TestD (0.00s)', 'ok  \tother.com/x\t0.1s', '?   \tex.com/m/pkg/none\t[no test files]'].join('\n')
  expect(goRanOf(out, '/p', 'ex.com/m')).toEqual({ '/p/pkg/a': { TestA: 'passed', 'TestA/case_1': 'passed', TestB: 'skipped' }, '/p': { TestC: 'failed' }, '/p/pkg/none': {} })
})

test('Jest\'s JSON results are read by file and title, a pending or todo test skipped, a title that also ran counted as run', async () => {
  const json = JSON.stringify({ testResults: [{ name: '/p/a.test.ts', assertionResults: [{ title: 'adds', status: 'passed' }, { title: 'later', status: 'todo' }, { title: 'twice', status: 'pending' }, { title: 'twice', status: 'failed' }, { title: 'ran first', status: 'passed' }, { title: 'ran first', status: 'skipped' }] }] })
  expect(jsRanOf(json)).toEqual({ '/p/a.test.ts': { adds: 'passed', later: 'skipped', twice: 'failed', 'ran first': 'passed' } })
})

test('a run of one folder replaces what the record held there and keeps the rest', async () => {
  const before = { at: 1, measured: ['/p'], by: { '/p/a': { TestA: 'passed' as const }, '/p/b': { TestB: 'passed' as const } } }
  // a package under the folder run again that the run no longer lists is gone with the rest
  const merged = mergeRan({ ...before, by: { ...before.by, '/p/b/old': { TestOld: 'passed' } } }, { at: 2, measured: ['/p/b'], by: { '/p/b': { TestB2: 'failed' } } })
  expect(merged).toEqual({ at: 2, measured: ['/p', '/p/b'], by: { '/p/a': { TestA: 'passed' }, '/p/b': { TestB2: 'failed' } } })
  expect(mergeRan(null, before)).toBe(before)
})

test('a graded test is run, skipped or never run by the record, and unknown where the run did not reach it', async () => {
  const record = { at: 1, measured: ['/p/go', '/p/js'], by: { '/p/go/pkg': { 'TestSuite/TestSaves': 'passed' as const, 'TestTable/row_1': 'failed' as const, TestOff: 'skipped' as const }, '/p/js/a.test.ts': { '  what now -> true': 'passed' as const } } }
  // a suite's method under its suite, a table test by its rows
  expect(ranStateOf(record, '/p/go/pkg/s_test.go', 'TestSaves')).toBe('ran')
  expect(ranStateOf(record, '/p/go/pkg/s_test.go', 'TestTable')).toBe('ran')
  expect(ranStateOf(record, '/p/go/pkg/s_test.go', 'TestOff')).toBe('skipped')
  expect(ranStateOf(record, '/p/go/pkg/s_test.go', 'TestGone')).toBe('never ran')
  // a loop by its template
  expect(ranStateOf(record, '/p/js/a.test.ts', '%s -> %s')).toBe('ran')
  expect(ranStateOf(record, '/p/js/b.test.ts', 'adds')).toBe('never ran')
  expect(ranStateOf(record, '/p/other/c.test.ts', 'adds')).toBeUndefined()
  expect(ranStateOf(null, '/p/js/a.test.ts', 'adds')).toBeUndefined()
})


test('a Go file behind a build tag the run was not given is not built, and never ran once the run had the tag', async () => {
  const record = { at: 1, measured: ['/p/go'], by: { '/p/go/pkg': { TestA: 'passed' as const } }, tagsBy: { '/p/go': [] } }
  expect(ranStateOf(record, '/p/go/pkg/store_test.go', 'TestStore', ['integration'])).toBe('not built')
  // an untagged file the run did not run is still never ran, and a tagged test that ran, ran
  expect(ranStateOf(record, '/p/go/pkg/plain_test.go', 'TestPlain')).toBe('never ran')
  expect(ranStateOf(record, '/p/go/pkg/a_test.go', 'TestA', ['integration'])).toBe('ran')
  const tagged = { ...record, tagsBy: { '/p/go': ['integration'] } }
  expect(ranStateOf(tagged, '/p/go/pkg/store_test.go', 'TestStore', ['integration'])).toBe('never ran')
  // a JS file has no build tags to miss
  expect(ranStateOf({ ...record, measured: ['/p/js'], by: {} }, '/p/js/a.test.ts', 'adds', ['integration'])).toBe('never ran')
})

for (const [name, argv, tags] of [
  ['-tags a,b', ['go', 'test', './...', '-tags', 'a,b'], ['a', 'b']],
  ['-tags=a', ['go', 'test', '-tags=a', './...'], ['a']],
  ['GOFLAGS style --tags=a b', ['go', 'test', '--tags=a b'], ['a', 'b']],
  ['no tags', ['go', 'test', './...', '-cover'], []],
] as const) {
  test(`the build tags a go test argv gives: ${name}`, async () => {
    expect(tagsOfArgv([...argv])).toEqual([...tags])
  })
}

test('a later run keeps the tags of the folders it did not reach and replaces the rest', async () => {
  const before = { at: 1, measured: ['/p/a', '/p/b'], by: {}, tagsBy: { '/p/a': ['integration'], '/p/b': ['integration'] } }
  expect(mergeRan(before, { at: 2, measured: ['/p/b'], by: {}, tagsBy: { '/p/b': [] } }).tagsBy).toEqual({ '/p/a': ['integration'], '/p/b': [] })
})

test('a test file that imports a database driver, or is named for a database, is integration', async () => {
  expect(layerOf('mobile/src/store.sqlite.test.ts', null)).toBe('integration')
  expect(layerOf('mobile/src/store.sqlite.test.tsx', null)).toBe('integration')
  expect(layerOf('mobile/src/store.test.ts', "import Database from 'better-sqlite3'\n")).toBe('integration')
  expect(layerOf('api/users.test.js', "const { Pool } = require('pg')\n")).toBe('integration')
  // a name that only holds the word is no driver
  expect(layerOf('src/pgformat.test.ts', "import { format } from './pgformat'\n")).toBe('unit')
  expect(layerOf('src/sqlite-ui.test.ts', null)).toBe('unit')
})

// what the engine would refuse whole, said with where it is
const box = (props: Record<string, unknown>, children: unknown[] = []) => ({ type: 'Box', props, children })
test('a tree the engine takes has no problem; one it would refuse names what and where', async () => {
  expect(problemOf(box({ flexDirection: 'column' }, [box({ key: 'k' }, ['text', { type: 'Button', props: { key: 'b', label: '' } }])]))).toBeUndefined()
  expect(problemOf(box({ width: Number.NaN }))).toBe('prop width is NaN at pane > Box')
  expect(problemOf(box({}, [box({ key: 'row', color: undefined })]))).toBe('prop color is undefined at pane > Box > Box "row"')
  expect(problemOf(box({}, [box({ key: 'row' }, ['ok \u001b[31m'])]))).toBe('a text holds a control character at pane > Box > Box "row": "ok \\u001b[31m"')
  // half an emoji, and the engine's placeholder character, are refused as control characters are
  expect(problemOf(box({}, ['cut \ud83c']))).toBe('a text holds a control character at pane > Box: "cut \\ud83c"')
  expect(problemOf(box({ label: 'x\u{10eeee}' }))).toBe('prop label holds a control character at pane > Box')
  expect(problemOf(box({}, ['a whole 🍅']))).toBeUndefined()
  expect(problemOf(box({}, [{ type: 'Button', props: { key: '', label: 'Run' } }]))).toBe('a Button without a key and a label at pane > Box > Button ""')
})

test('a size below 0, an offset not a whole number or a colour that is no colour is a problem', async () => {
  expect(problemOf(box({ width: -3 }))).toBe('prop width is -3, not from 0 to 10000 at pane > Box')
  expect(problemOf(box({ width: '50%', minHeight: 0, marginLeft: -2 }))).toBeUndefined()
  expect(problemOf(box({ height: 'tall' }))).toBe('prop height is not a number or a percentage at pane > Box')
  expect(problemOf(box({ gap: 20_000 }))).toBe('prop gap is 20000, not a number within 10000 at pane > Box')
  expect(problemOf(box({ top: 1.5 }))).toBe('prop top is 1.5, not a whole number within 10000 at pane > Box')
  expect(problemOf(box({}, [{ type: 'Text', props: { color: 'red;' }, children: ['x'] }]))).toBe('prop color is "red;", not a colour at pane > Box > Text')
  expect(problemOf(box({ backgroundColor: '#343848' }))).toBeUndefined()
})

test('a tree past the engine\'s node or depth limit is a problem, one at the limit is not', async () => {
  expect(problemOf(box({}, Array.from({ length: 19_999 }, () => box({}))))).toBeUndefined()
  expect(problemOf(box({}, Array.from({ length: 20_000 }, () => box({}))))).toBe('more than 20000 elements')
  const deep = (n: number): unknown => (n === 0 ? 'leaf' : box({}, [deep(n - 1)]))
  expect(problemOf(deep(32))).toBeUndefined()
  expect(problemOf(deep(33))).toMatch(/^nested deeper than 32 at pane( > Box)+$/)
})

// what a Go package is for, from one of its files
test('a package main is a command; mocks, or code importing testing or a mocking library, is a test helper', () => {
  expect(roleOf('// Command seed fills the database\npackage main\n\nfunc main() {}\n')).toBe('command')
  expect(roleOf('package mocks\n\ntype Store struct{}\n')).toBe('helper')
  expect(roleOf('package monitoringtest\n\nimport (\n\t"context"\n\t"testing"\n)\n')).toBe('helper')
  expect(roleOf('package fakes\n\nimport "github.com/stretchr/testify/mock"\n')).toBe('helper')
  expect(roleOf('package store\n\nimport gomock "go.uber.org/mock/gomock"\n')).toBe('helper')
})

test('ordinary code is neither command nor helper, even when it names testing in a string or comment', () => {
  expect(roleOf('package data\n\nimport "context"\n\n// used by testing\nvar s = "testing"\n')).toBeUndefined()
  expect(roleOf('package latest\n')).toBeUndefined()
  expect(roleOf('no package clause here')).toBeUndefined()
})

test('a folder named as test code is a helper: mocks, fakes, testutil, fixtures, or a name ending in test', () => {
  for (const name of ['mocks', 'gomocks', 'mock', 'fakes', 'testutil', 'testhelpers', 'fixtures', 'receipttest', 'monitoringtest', 'httptest']) expect([name, isHelperName(name)]).toEqual([name, true])
  for (const name of ['latest', 'contest', 'test', 'data', 'testable', 'mockingbird', 'protest']) expect([name, isHelperName(name)]).toEqual([name, false])
})

test("a file with Go's generated-code header before its package clause is generated; one that mentions it later is not", () => {
  expect(isGenerated('// Code generated by mockery v2.42.0. DO NOT EDIT.\n\npackage mocks\n')).toBe(true)
  expect(isGenerated('// Copyright 2026\n\n// Code generated by protoc-gen-go. DO NOT EDIT.\n// versions:\npackage pb\n')).toBe(true)
  expect(isGenerated('package data\n\n// Code generated by hand. DO NOT EDIT.\n')).toBe(false)
  expect(isGenerated('// Code generated by mockery\npackage mocks\n')).toBe(false)
  expect(isGenerated('package data\n')).toBe(false)
})

const PACKAGES = [
  { name: 'backend/internal/api/', total: 100, covered: 90 },
  { name: 'backend/internal/core/', total: 300, covered: 240 },
  { name: 'backend/internal/data/', total: 400, covered: 30 },
  { name: 'backend/internal/util/', total: 100, covered: 0 },
  { name: 'backend/cmd/seed/', total: 200, covered: 0, role: 'command' as const },
  { name: 'backend/internal/mocks/', total: 50, covered: 0, role: 'helper' as const },
]
const TESTS = {
  'backend/internal/api/': { tests: 4, unbuilt: 0 },
  'backend/internal/core/': { tests: 6, unbuilt: 2 },
  'backend/internal/data/': { tests: 312, unbuilt: 312 },
}

test('a package is tested, not built, without tests, a command or a helper by its listed tests and role', () => {
  const views = packageViews(PACKAGES, TESTS)
  expect(views.map(v => [v.name.slice('backend/'.length), v.state, v.unbuilt])).toEqual([
    ['internal/api/', 'tested', 0],
    ['internal/core/', 'tested', 2],
    ['internal/data/', 'not built', 312],
    ['internal/util/', 'no tests', 0],
    ['cmd/seed/', 'command', 0],
    ['internal/mocks/', 'helper', 0],
  ])
  expect(views.find(v => v.name.endsWith('data/'))!.pct).toBe(7.5)
})

test('with no test listed in any package, every package but a command or helper is taken as tested', () => {
  expect(packageViews(PACKAGES, {}).map(v => v.state)).toEqual(['tested', 'tested', 'tested', 'tested', 'command', 'helper'])
})

test('the tested line gives the figure and median over tested packages and names what the total also counts', () => {
  const line = testedLine(packageViews(PACKAGES, TESTS))
  // api 90 of 100 and core 240 of 300: 330 of 400; median of 80 and 90
  expect(line).toBe(
    '82.5% over the 2 packages whose tests ran (median package 85%); the total also counts 1 command (package main) with no tests, 1 other package with no tests, 1 test helper, 1 package whose 312 tests were not built (unmeasured, not low).',
  )
})

test('there is no tested line when every package is tested, or none is', () => {
  expect(testedLine(packageViews(PACKAGES.slice(0, 2), TESTS))).toBeNull()
  // not built, no tests and a command: nothing ran to give a figure over
  expect(testedLine(packageViews(PACKAGES.slice(2, 5), TESTS))).toBeNull()
})

test('the finished note leaves folders with no tested package out of the least covered and adds the tested line', () => {
  const byDir = {
    'backend/cmd': { total: 200, covered: 0 },
    'backend/internal/data': { total: 400, covered: 30 },
    'backend/internal/core': { total: 300, covered: 210 },
  }
  const cov = { lines: null, statements: 44, branches: null, functions: null, source: 'go test -coverprofile', updatedAt: 1, byDir, byPackage: PACKAGES }
  const note = coverageNote({ argv: ['go'], label: 'go test' }, 0, '', cov, packageViews(PACKAGES, TESTS))
  expect(note).toContain('\n82.5% over the 2 packages whose tests ran')
  expect(note).toContain('Least covered folders (statements): backend/internal/core/ 70%.')
  expect(note).not.toContain('backend/cmd/')
  expect(note).not.toContain('backend/internal/data/ ')
})

test('parts that each counted statements add up to the whole project\'s figure; one that did not leaves it out', () => {
  const part = (total: number, covered: number, counted = true) => ({
    lines: null, statements: pct((covered / total) * 100), branches: null, functions: null, source: 's', updatedAt: 1,
    ...(counted ? { statementCount: { total, covered } } : {}),
  })
  // 600 of 1000 and 900 of 1000: 75%, not the 75% a plain mean would also give, so weight it unevenly
  const merged = mergeParts([{ dir: 'backend', cov: part(1000, 600) }, { dir: 'mobile', cov: part(3000, 2700) }])!
  expect(merged.statements).toBe(82.5)
  expect(merged.statementCount).toEqual({ total: 4000, covered: 3300 })
  expect(mergeParts([{ dir: 'backend', cov: part(1000, 600) }, { dir: 'mobile', cov: part(3000, 2700, false) }])!.statements).toBeNull()
})
