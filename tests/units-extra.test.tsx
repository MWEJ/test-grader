import { expect, test } from 'claude-code/testing'
import { blockEnd, byCase, caseLine, caseNames, caseOf, casesAround, casesIn, ignoredBy, quotedMask, shortPath, uniqueRows, withoutTemplates } from '../hooks/discovery'
import { caseTextOf, caseTextsOf, excerptOf, loopsOf, MAX_BODY, MAX_HEAD, parseVerdicts, unratedWhy } from '../hooks/excerpt'
import { keep, unkeep } from '../hooks/kept'
import { goRanOf, jsRanOf, mergeRan, ranStateOf } from '../hooks/ran'
import { runArgv } from '../hooks/runner'
import { charCount, drawable, nodeCount, problemOf } from '../hooks/tree'
import { verdictOf } from '../hooks/verdicts'

// Bug: division after an identifier could consume code up to the next slash as a regex.
test('JavaScript division leaves the following test discoverable', () => {
  expect(caseNames("const half = value / 2\nit('halves', () => {})\n", 'a.test.ts')).toEqual(['halves'])
})

// Bug: a regex character class containing a slash or brace could close a describe too early.
test('regex character classes do not close the describe around duplicate test names', () => {
  expect(casesIn("describe('math', () => {\n  const r = /[}/]/\n  it('adds', () => {})\n})\nit('adds', () => {})\n", 'a.test.ts').map(c => [c.name, c.groups])).toEqual([['math › adds', ['math']], ['adds', []]])
})

// Bug: a regex after return could expose its braces as code and truncate the block.
test('regex after return keeps a brace in the pattern out of the enclosing block', () => {
  const source = 'function matcher() { return /}/ }\nnext()'
  expect(blockEnd(source, quotedMask(source, 'js'), 'js', 0)).toBe(source.indexOf('\n'))
})

// Bug: scanning an unfinished regex to EOF could hide a test on the next line.
test('an unfinished JavaScript regex stops masking at its newline', () => {
  expect(caseNames("const r = /unfinished\nit('after', () => {})\n", 'a.test.ts')).toEqual(['after'])
})

// Bug: an escaped regex delimiter could expose a later brace and truncate a group.
test('an escaped slash keeps the rest of the regex inside its enclosing group', () => {
  const source = String.raw`describe('math', () => {
  const r = /a\/}/
  it('adds', () => {})
})
it('adds', () => {})`
  expect(caseNames(source, 'a.test.ts')).toEqual(['math › adds', 'adds'])
})

// Bug: raw-string backslashes could escape the terminator and hide a real Go test.
test('a Go raw string ending after a backslash leaves the following test discoverable', () => {
  expect(caseNames('package x\nvar s = `fixture\\`\nfunc TestReal(t *testing.T) {}\n', 'x_test.go')).toEqual(['TestReal'])
})

// Bug: scanning an unterminated string or comment could reveal fixture tests inside it.
for (const [kind, file, prefix, fake] of [
  ['block comment', 'x_test.go', '/*', '\nfunc TestFake(t *testing.T) {}'],
  ['Go raw string', 'x_test.go', 'var s = `', '\nfunc TestFake(t *testing.T) {}'],
  ['Python triple string', 'test_x.py', 's = """', '\ndef test_fake(): pass'],
  ['Rust raw string', 'tests.rs', 'let s = r##"', '\n#[test]\nfn fake() {}'],
  ['JavaScript template', 'a.test.ts', 'const s = `', "\nit('fake', () => {})"],
] as const) {
  test(`an unterminated ${kind} keeps fixture tests out of discovery`, () => {
    expect(caseNames(prefix + fake, file)).toEqual([])
  })
}

// Bug: a quote inside a Rust raw string could expose fixture tests before the hash terminator.
test('Rust raw strings wait for the matching hashes before discovering real tests', () => {
  const source = 'let s = r##"quote "\n#[test]\nfn fake() {}\n"##;\n#[test]\nfn real() {}'
  expect(caseNames(source, 'tests.rs')).toEqual(['real'])
})

// Bug: a Rust lifetime could start a character string that hides real code on the same line.
test('Rust lifetimes leave braces in code while character literals hide theirs', () => {
  const source = "fn f<'a>() { let c = '\\''; let end = '}'; } next()"
  expect(blockEnd(source, quotedMask(source, 'c'), 'rs', 0)).toBe(source.indexOf(' next()'))
})

// Bug: a Python class on the final line could fail to terminate and loop during discovery.
test('a Python block with no trailing newline ends at the file boundary', () => {
  const source = 'class TestA:\n    def test_a(self): pass'
  expect(blockEnd(source, quotedMask(source, 'py'), 'py', 0)).toBe(source.length)
})

// Bug: comments at the class indentation could remove the class from its later test's name.
test('Python comments do not end the class around duplicate test names', () => {
  const source = 'class TestA:\n# a comment\n    def test_a(self): pass\n\nclass TestB:\n    def test_a(self): pass\n'
  expect(caseNames(source, 'test_x.py')).toEqual(['TestA › test_a', 'TestB › test_a'])
})

// Bug: Ruby end at EOF could leave the returned block boundary before its closing keyword.
test('a Ruby closing end without a newline belongs to its block', () => {
  const source = 'class MathTest\n  def test_adds\n  end\nend'
  expect(blockEnd(source, quotedMask(source, 'py'), 'rb', 0)).toBe(source.length)
})

// Bug: a broad table template could steal the concrete test's row or assign one row twice.
test('case rows prefer exact names and give overlapping templates each row only once', () => {
  const rows = [{ name: 'fixed', verdict: 'strong' }, { name: 'adds 1', verdict: 'hollow' }, { name: 'stray', verdict: 'shallow' }]
  const owned = byCase(['%s', 'adds %i', 'fixed'], rows)
  expect([...owned]).toEqual([['%s', [rows[1], rows[2]]], ['adds %i', []], ['fixed', [rows[0]]]])
})

// Bug: matching a broad template first could send evidence for a concrete test to the wrong case.
test('case lookup prefers a concrete name over a preceding broad template', () => {
  expect(caseOf(['%s', 'adds'], 'adds')).toBe('adds')
})

// Bug: evidence for an unrelated test could be assigned to a template that does not match it.
test('case lookup returns no case for a name that no template matches', () => {
  expect(caseOf(['adds %i'], 'subtracts')).toBeUndefined()
})

// Bug: deduplication by name alone could erase tests in other files.
test('duplicate rows are removed only for the same file and test name', () => {
  expect(uniqueRows([{ file: 'a', name: 'x', reason: 'first' }, { file: 'b', name: 'x', reason: 'second' }, { file: 'a', name: 'x', reason: 'duplicate' }])).toEqual([{ file: 'a', name: 'x', reason: 'first' }, { file: 'b', name: 'x', reason: 'second' }])
})

// Bug: expanded cases from a different file could erase an unrated template's row.
test('a template row gives way only to expanded cases from its own file', () => {
  const rows = [{ file: 'a', name: 'adds %i' }, { file: 'b', name: 'adds %i' }]
  expect(withoutTemplates(rows, [{ file: 'a', name: 'adds 1' }])).toEqual([{ file: 'b', name: 'adds %i' }])
})

// Bug: a similarly prefixed root could shorten an external file's path.
test('short paths require a folder boundary after the project root', () => {
  expect(shortPath('/project2/a', '/project')).toBe('/project2/a')
})

// Bug: an absent project root could strip the leading slash from an absolute file path.
test('short paths preserve an absolute file path when the project root is empty', () => {
  expect(shortPath('/a', '')).toBe('/a')
})

// Bug: a missing test name could acquire another test's line number.
test('a missing case falls back to line one', () => {
  expect(caseLine("\n\nit('adds', () => {})\n", 'gone', 'a.test.ts')).toBe(1)
})

// Bug: a zero-width edit at a case boundary could be assigned to the previous case.
test('a zero-width edit on the second test belongs only to the second test', () => {
  const source = "it('first', () => {\n})\nit('second', () => {\n})\n"
  const at = source.indexOf("it('second'")
  expect(casesAround(source, 'a.test.ts', at, at)).toEqual(['second'])
})

// Bug: an excerpt could omit transitive helpers declared between unselected tests.
test('a long excerpt includes helpers used transitively by the selected test', () => {
  const source = "it('other', () => {\n})\nconst base = 2\nconst helper = () => base\nit('unselected', () => {\n})\nit('chosen', () => {\n  expect(helper()).toBe(2)\n})\n" + '// padding\n'.repeat(5_000)
  const excerpt = excerptOf(source, ['chosen'], 'a.test.ts')
  expect(excerpt).toContain('const base = 2\nconst helper = () => base')
  expect(excerpt).not.toContain("it('unselected'")
  expect(excerpt).toContain("it('chosen'")
})

// Bug: a huge file without detected cases could send an unbounded head to the grader.
test('a long file with no cases sends a bounded head with an ellipsis', () => {
  expect(excerptOf('x'.repeat(40_001), [], 'a.test.ts')).toBe('x'.repeat(MAX_HEAD - 1) + '…')
})

// Bug: trimming an oversized Python body could use the wrong comment syntax or omit the warning.
test('a long Python test body is capped and says the rest was left out', () => {
  const source = 'def test_long():\n' + '    assert f() == 1\n'.repeat(3_000)
  expect(excerptOf(source, ['test_long'], 'test_x.py')).toBe('\n\n' + source.trimEnd().slice(0, MAX_BODY) + '\n# … the rest of this test is left out: it is too long to send …')
})

// Bug: case text extraction could attach the next test's body to the selected test.
test('case text lookup stops at the next test', () => {
  const source = "it('one', () => {\n  expect(1).toBe(1)\n})\nit('two', () => {\n})\n"
  const read = caseTextsOf(source, 'a.test.ts')
  expect(read('one')).toBe("it('one', () => {\n  expect(1).toBe(1)\n})")
})

// Bug: the final test's body could be lost when there is no next case boundary.
test('case text lookup includes the last test through the end of the file', () => {
  const source = "it('one', () => {\n})\nit('two', () => {\n})\n"
  expect(caseTextOf(source, 'two', 'a.test.ts')).toBe("it('two', () => {\n})")
})

// Bug: a removed name could be matched to an unrelated test's body.
test('case text lookup returns null for a removed test', () => {
  expect(caseTextsOf("it('one', () => {})\n", 'a.test.ts')('gone')).toBeNull()
})

// Bug: case grouping could treat template names or unrelated tests as expanded loop cases.
test('loop notes group expanded cases and omit templates and unrelated names', () => {
  const source = "for (const n of [1, 2]) {\n  it(`adds ${n}`, () => {})\n}\n"
  expect(loopsOf(source, ['adds 1', 'adds 2', 'adds ${n}', 'other'], 'a.test.ts')).toEqual(['"adds 1", "adds 2" are cases of the loop that declares the test "adds ${n}": judge each by that loop\'s body, its variable bound to the case\'s value.'])
})

// Bug: singular loop notes could claim several cases were reviewed for just one.
test('a single expanded loop case is described in the singular', () => {
  expect(loopsOf("it.each([1])('adds %i', () => {})", ['adds 1'], 'a.test.ts')).toEqual(['"adds 1" is a case of the loop that declares the test "adds %i": judge it by that loop\'s body, its variable bound to the case\'s value.'])
})

// Bug: confidence parsing could retain surrounding whitespace or discard confidence on promotion.
test('a shallow verdict promoted for lacking a missed bug keeps normalized medium confidence', () => {
  expect(parseVerdicts('[{"name":"adds","verdict":"shallow","confidence":" Medium "}]')).toEqual({ verdicts: [{ name: 'adds', summary: '', verdict: 'strong', reason: '(Graded strong: no bug it would miss was named.)', confidence: 'medium' }], isCut: false })
})

// Bug: long unreadable replies could make the diagnostic note unbounded.
test('an unreadable reply is quoted only through its first hundred sixty characters', () => {
  expect(unratedWhy('x'.repeat(200), [], false, ['adds'], 'adds', 'haiku')).toBe(`The grader (haiku) answered with no verdict it could read: "${'x'.repeat(160)}…".`)
})

// Bug: persisting an ungraded row's old fingerprint could falsely validate a stale grade later.
test('an ungraded row does not keep its source fingerprint', () => {
  expect(keep({ results: [{ file: 'a.test.ts', name: 'pending', textOf: 'old-text' }], hashes: {} }, false)).toEqual({ v: 2, files: { 'a.test.ts': { tests: [['pending', '']] } } })
})

// Bug: an unknown stored verdict code could invent a grade or discard other row information.
test('an unknown stored verdict is read as unrated while its explanation is preserved', () => {
  expect(unkeep({ v: 2, files: { 'a.test.ts': { tests: [['adds', '?', '', 'needs review']] } } })).toEqual({ results: [{ file: 'a.test.ts', name: 'adds', reason: 'needs review' }], hashes: {} })
})

// Bug: a nontext model verdict could be coerced into an old grade word.
test('a nontext verdict does not become a grade', () => {
  expect(verdictOf({ toString: () => 'strong' })).toBeUndefined()
})

// Bug: absent result arrays or malformed title rows could crash instead of yielding an empty record.
for (const [caseName, json, expected] of [
  ['no testResults', '{}', {}],
  ['unnamed files', '{"testResults":[{"name":3},{"assertionResults":[]}]}', {}],
  ['no assertionResults', '{"testResults":[{"name":"/p/a.test.ts"}]}', { '/p/a.test.ts': {} }],
  ['nonnumeric title required', '{"testResults":[{"name":"/p/a.test.ts","assertionResults":[{"title":3,"status":"passed"}]}]}', { '/p/a.test.ts': {} }],
] as const) {
  test(`a JavaScript run report with ${caseName} has no invented test outcomes`, () => {
    expect(jsRanOf(json)).toEqual(expected)
  })
}

// Bug: invalid JSON could silently be interpreted as an empty, successful test run.
test('a malformed JavaScript run report throws its parse error', () => {
  expect(() => jsRanOf('{')).toThrow()
})

// Bug: a later skip of an already executed Go test could replace its run outcome.
test('a repeated Go package keeps an executed test ahead of its later skip', () => {
  expect(goRanOf('--- PASS: TestA\nok ex.org/m/pkg 0.1s\n--- SKIP: TestA\nok ex.org/m/pkg 0.1s\n', '/p', 'ex.org/m')).toEqual({ '/p/pkg': { TestA: 'passed' } })
})

// Bug: replacing the entire measured root could leave obsolete child measurements behind.
test('a new whole-project run replaces earlier nested measurements and preserves neighbouring roots', () => {
  expect(mergeRan({ at: 1, measured: ['/p/sub', '/p2'], by: { '/p/sub/a': { TestOld: 'passed' }, '/p2/a': { TestOther: 'passed' } } }, { at: 2, measured: ['/p'], by: {} })).toEqual({ at: 2, measured: ['/p2', '/p'], by: { '/p2/a': { TestOther: 'passed' } } })
})

// Bug: a table with only skipped cases could be marked never run or run successfully.
test('a Go table with only skipped subtests is marked skipped', () => {
  expect(ranStateOf({ at: 1, measured: ['/p'], by: { '/p': { 'TestTable/a': 'skipped', 'TestTable/b': 'skipped' } } }, '/p/x_test.go', 'TestTable')).toBe('skipped')
})

// Bug: a nonbundled RSpec project could be forced through an unavailable bundle executable.
test('RSpec without bundler runs directly at the test line', () => {
  expect(runArgv({ rel: 'spec/a_spec.rb', kind: 'rb', plain: 'works', groups: [], line: 7 }, {})).toEqual(['rspec', 'spec/a_spec.rb:7'])
})

// Bug: drawable could sanitize child text but leave an invalid button label in the tree.
test('drawable sanitizes nested text and string props without changing numeric or boolean props', () => {
  expect(drawable({ type: 'Box', children: [{ type: 'Button', props: { key: 'run', label: '\u001b[31mRun\u001b[0m', width: 7, plain: false } }, 'bad\ud83c'] })).toEqual({ type: 'Box', children: [{ type: 'Button', props: { key: 'run', label: 'Run', width: 7, plain: false } }, 'bad�'] })
})

// Bug: a root text node could bypass sanitizing because it is not an element.
test('drawable sanitizes a root text node', () => {
  expect(drawable('ok\u0000')).toBe('ok')
})

// Bug: the node and text budgets could count unsupported child values as rendered content.
for (const value of [null, undefined, 42, false, ['not an element']]) {
  test(`render budgets ignore an unsupported ${Array.isArray(value) ? 'array' : String(value)} child`, () => {
    expect(nodeCount(value)).toBe(0)
    expect(charCount(value)).toBe(0)
  })
}

// Bug: diagnostics could accept unsupported children and let the engine blank the entire pane.
for (const [value, label] of [[null, 'null'], [undefined, 'undefined'], [42, '42'], [[], 'an array']] as const) {
  test(`pane validation explains an unsupported ${label} child`, () => {
    expect(problemOf({ type: 'Box', children: [value] })).toBe(`a child is ${label} at pane > Box`)
  })
}

// Bug: validation could accept an unserializable prop and cause a blank pane.
for (const [value, label] of [[null, 'null'], [Infinity, 'Infinity'], [{}, 'object'], [() => 1, 'function']] as const) {
  test(`pane validation explains an unsupported ${label} prop`, () => {
    expect(problemOf({ type: 'Box', props: { width: value } })).toBe(`prop width is ${label} at pane > Box`)
  })
}

// Bug: a button missing its label could be accepted even though the engine cannot draw it.
test('pane validation refuses a button whose label is not text', () => {
  expect(problemOf({ type: 'Button', props: { key: 'run', label: 1 } })).toBe('a Button without a key and a label at pane > Button "run"')
})

// Bug: unterminated single-line quotes could hide real tests on subsequent lines.
test('an unfinished JavaScript quoted string stops masking at its newline', () => {
  expect(caseNames("const s = \"unfinished\nit('real', () => {})\n", 'a.test.ts')).toEqual(['real'])
})

// Bug: a regex at the start of a source fragment could be treated as division.
test('a source fragment beginning with a regex masks its pattern', () => {
  expect(Array.from(quotedMask('/a{2}/', 'js'))).toEqual([1, 1, 1, 1, 1, 1])
})

// Bug: a regex with no closing delimiter could expose its last brace as code.
test('an unfinished regex without a newline masks through the file boundary', () => {
  expect(Array.from(quotedMask('/a{2}', 'js'))).toEqual([1, 1, 1, 1, 1])
})

// Bug: the two wildcard forms could match too broadly or fail to cover nested ignored files.
test('ignore globs match recursive folders and exactly one character in a file name', () => {
  const ignored = ignoredBy('cache/**\ngenerated/?.test.ts\n')
  expect(['cache/deep/data.json', 'generated/a.test.ts', 'generated/ab.test.ts', 'other/cache/data.json'].map(p => [p, ignored(p)])).toEqual([
    ['cache/deep/data.json', true], ['generated/a.test.ts', true], ['generated/ab.test.ts', false], ['other/cache/data.json', false],
  ])
})

// Bug: Python assignment helpers could be omitted because only declaration keywords are recognized.
test('a long Python excerpt keeps an assignment fixture used by a selected test', () => {
  const source = 'def test_other():\n    pass\n\nfixture = 42\ndef test_middle():\n    pass\n\ndef test_chosen():\n    assert f(fixture) == 42\n' + '# padding\n'.repeat(5_000)
  const shown = excerptOf(source, ['test_chosen'], 'test_x.py')
  expect(shown).toContain('fixture = 42')
  expect(shown).not.toContain('def test_middle')
  expect(shown).toContain('assert f(fixture) == 42')
})

// Bug: a long malformed object could overflow the diagnostic note with a full model reply.
test('an unreadable verdict object is quoted only through two hundred forty characters', () => {
  const own = JSON.stringify({ name: 'missing', verdict: 'excellent', reason: 'x'.repeat(300) })
  const verdicts = [{ name: 'adds', verdict: 'strong' as const, summary: '', reason: '' }]
  expect(unratedWhy(`[${own}]`, verdicts, false, ['adds', 'missing'], 'missing', 'haiku')).toBe('The grader (haiku) answered for this test, but its verdict could not be read: ' + own.slice(0, 240) + '…')
})

// Bug: incomplete objects without a brace could lose the visible malformed verdict text.
test('a malformed verdict without surrounding braces still explains the name the grader answered', () => {
  expect(unratedWhy('"missing": excellent', [{ name: 'adds', verdict: 'strong', summary: '', reason: '' }], false, ['adds', 'missing'], 'missing', 'haiku')).toBe('The grader (haiku) answered for this test, but its verdict could not be read: "missing": excellent')
})

// Bug: a long stray-name list could flood the note instead of saying how many were left out.
test('an unrated diagnostic lists only three stray names and counts the rest', () => {
  const verdicts = ['one', 'two', 'three', 'four', 'five'].map(name => ({ name, verdict: 'strong' as const, summary: '', reason: '' }))
  expect(unratedWhy('[]', verdicts, false, ['missing'], 'missing', 'haiku')).toBe('The grader (haiku) gave no verdict under this test\'s name; it answered for "one", "two", "three" and 2 more, which no test asked about is named.')
})

// Bug: render-budget counting could miss text in a leaf's props when it has no children.
test('a leaf without children spends only the characters of its string props', () => {
  expect(charCount({ type: 'Button', props: { label: 'Run', width: 7 } })).toBe(3)
  expect(nodeCount({ type: 'Button', props: { label: 'Run', width: 7 } })).toBe(1)
})

// Bug: drawable could attempt to treat an unsupported root as an element and throw.
test('drawable passes a null root through for the validator to diagnose', () => {
  expect(drawable(null)).toBeNull()
  expect(problemOf(drawable(null))).toBe('a child is null at pane')
})

// Bug: old evidence without a source fingerprint could be discarded or gain a false fingerprint.
test('stored evidence without its source fingerprint is preserved without inventing a source', () => {
  const saved = { results: [{ file: 'a.test.ts', name: 'adds', verdict: 'strong' as const, evidence: 'Subtracting made it fail.' }], hashes: {} }
  expect(unkeep(keep(saved, false))).toEqual(saved)
})
