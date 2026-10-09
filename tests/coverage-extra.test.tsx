import { expect, test } from 'claude-code/testing'
import type { Coverage } from '../types'
import { attr, coverageAnswer, coverageNote, kindAt, kindOf, mergeParts } from '../hooks/coverage'
import { goProfileOf, mergeProfile } from '../hooks/gocover'

const report = (extra: Partial<Coverage> = {}): Coverage => ({
  lines: null, statements: null, branches: null, functions: null,
  source: 'lcov.info', updatedAt: null, ...extra,
})
const command = { argv: ['npm', 'test'], label: 'npm test' }

// Bug: treating the absence of parts as an empty report would advertise measured code.
test('merging no coverage reports returns no report', () => {
  expect(mergeParts([])).toBeNull()
})

// Bug: a single part could lose its figures or treat a missing timestamp as a real time.
test('one coverage part keeps its figures and prefixes its root folder', () => {
  expect(mergeParts([{ dir: 'web', cov: report({ lines: 75, branches: 50, byDir: { '': { total: 4, covered: 3 } } }) }])).toEqual(report({
    lines: 75, branches: 50, source: 'web/: lcov.info',
    byDir: { web: { total: 4, covered: 3 } },
    parts: [{ dir: 'web', lines: 75, statements: null, branches: 50, functions: null, source: 'lcov.info' }],
  }))
})

// Bug: combining unlike measurements into a project percentage would misreport coverage.
test('mixed coverage parts keep their measurements separate and qualify their packages', () => {
  expect(mergeParts([
    { dir: 'api', cov: report({ statements: 40, source: 'go test -coverprofile', updatedAt: 10, byPackage: [{ name: './', total: 5, covered: 2 }, { name: 'pkg/', total: 2, covered: 1 }] }) },
    { dir: 'web', cov: report({ lines: 80, updatedAt: 20, byDir: { src: { total: 5, covered: 4 } } }) },
  ])).toEqual(report({
    source: 'api/: go test -coverprofile · web/: lcov.info', updatedAt: 20,
    byDir: { 'web/src': { total: 5, covered: 4 } },
    byPackage: [{ name: 'api/', total: 5, covered: 2 }, { name: 'api/pkg/', total: 2, covered: 1 }],
    parts: [
      { dir: 'api', lines: null, statements: 40, branches: null, functions: null, source: 'go test -coverprofile' },
      { dir: 'web', lines: 80, statements: null, branches: null, functions: null, source: 'lcov.info' },
    ],
  }))
})

// Bug: a path prefix without a folder boundary could take the neighbouring part's units.
test('coverage units use the containing part and leave similarly prefixed folders outside it', () => {
  const cov = mergeParts([{ dir: 'api', cov: report({ statements: 40 }) }, { dir: 'web', cov: report({ lines: 80 }) }])
  expect(kindAt(cov, 'api')).toBe('statements')
  expect(kindAt(cov, 'api/pkg')).toBe('statements')
  expect(kindAt(cov, 'apiary')).toBe('statements or lines')
})

// Bug: repeated measurement types could be listed as different project units.
test('coverage units deduplicate parts measuring the same kind', () => {
  expect(kindOf(mergeParts([{ dir: 'a', cov: report({ statements: 30 }) }, { dir: 'b', cov: report({ statements: 40 }) }]))).toBe('statements')
})

// Bug: the absence of a report could be described as a statement measurement.
test('coverage units default to lines without a report', () => {
  expect(kindOf(null)).toBe('lines')
})

// Bug: Number of a malformed rate could propagate NaN into the pane.
test('a malformed numeric Cobertura rate gives no percentage', () => {
  expect(attr('<coverage line-rate="0..5">', 'line-rate')).toBeNull()
})

// Bug: an empty report could be announced as measured coverage.
test('a successful coverage run with no measured figures explains that no report was written', () => {
  expect(coverageNote(command, 0, '', report())).toBe('Coverage run (test-grader) finished, but npm test wrote no report test-grader reads.')
})

// Bug: the least-covered list could include the project, tiny folders, or the 80% boundary.
test('a coverage note lists at most five substantial folders below eighty percent, lowest first', () => {
  const cov = report({ lines: 50, byDir: {
    '': { total: 100, covered: 0 }, tiny: { total: 19, covered: 0 }, boundary: { total: 20, covered: 16 },
    a: { total: 20, covered: 1 }, b: { total: 20, covered: 2 }, c: { total: 20, covered: 3 },
    d: { total: 20, covered: 4 }, e: { total: 20, covered: 5 }, f: { total: 20, covered: 6 },
  } })
  expect(coverageNote(command, 0, '', cov)).toBe('Coverage run (test-grader) finished: lines 50% (lcov.info).\nLeast covered folders (lines): a/ 5%, b/ 10%, c/ 15%, d/ 20%, e/ 25%.')
})

// Bug: a failed Go package printed twice could be counted twice, or an unbounded list sent.
test('a failed coverage note deduplicates packages and caps the list at ten', () => {
  const packages = Array.from({ length: 12 }, (_, i) => `example.org/p${i}`)
  const output = ['FAIL', ...packages.map(p => `FAIL\t${p} [build failed]`), `FAIL\t${packages[0]}`].join('\n')
  expect(coverageNote(command, 1, output, report({ statements: 30 }))).toBe(
    'Coverage run (test-grader) finished with failing tests (npm test exited with 1): statements 30% (lcov.info). The figures are from the tests that ran.\n' +
    `Failed: ${packages.slice(0, 10).join(', ')} and 2 more.`,
  )
})

// Bug: a failed run without package lines could discard the useful failure output.
test('a failed coverage note with figures keeps the last twenty nonblank output lines', () => {
  const output = Array.from({ length: 25 }, (_, i) => `error ${i}`).join('\n\n')
  expect(coverageNote(command, 2, output, report({ functions: 0 }))).toBe(
    'Coverage run (test-grader) finished with failing tests (npm test exited with 2): functions 0% (lcov.info). The figures are from the tests that ran.\nThe last 20 lines it printed:\n' +
    Array.from({ length: 20 }, (_, i) => `error ${i + 5}`).join('\n'),
  )
})

// Bug: the answer could retain stale percentages when the new run wrote no report.
test('a coverage answer without a new report removes stale figures and retains the failure', () => {
  expect(coverageAnswer('src', command, 3, '\n failure \n\n', report({ byDir: { src: { total: 10, covered: 9 } } }), null)).toBe(
    'Coverage (test-grader), by npm test:\nnpm test wrote no report test-grader reads.\nThe last 1 lines it printed:\n failure ',
  )
})

// Bug: a zero-line folder could get a NaN or fabricated 0% coverage figure.
test('an unmeasured folder has no figure even when the project was measured', () => {
  expect(coverageAnswer('empty', command, 0, '', null, report({ byDir: { '': { total: 10, covered: 8 }, empty: { total: 0, covered: 0 } } }))).toBe(
    'Coverage (test-grader), by npm test:\nempty/ has no figure in the report: none of its code was measured.\nThe project: 80% lines.',
  )
})

// Bug: absent old measurement could be called unchanged or compared against zero.
test('a newly measured folder reports its figure without inventing a previous value', () => {
  expect(coverageAnswer('', command, 0, '', null, report({ byDir: { '': { total: 3, covered: 2 } } }))).toBe('Coverage (test-grader), by npm test:\nThe project: 66.7% lines.')
})

// Bug: a folder answer could rank unrelated folders or ignore its prior measurement.
test('a folder coverage answer compares its previous figure and ranks only descendants', () => {
  const before = report({ byDir: { '': { total: 20, covered: 10 }, src: { total: 10, covered: 2 } } })
  const after = report({ byDir: { '': { total: 20, covered: 10 }, src: { total: 10, covered: 6 }, 'src/b': { total: 4, covered: 2 }, 'src/a': { total: 2, covered: 1 }, 'src2': { total: 2, covered: 0 } } })
  expect(coverageAnswer('src', command, 0, '', before, after)).toBe('Coverage (test-grader), by npm test:\nsrc/: 60% lines, was 20%.\nThe project: 50% lines, unchanged.\nLeast covered folders in src/ (lines): src/a/ 50% (1 of 2), src/b/ 50% (2 of 4).')
})

// Bug: a whole mixed project could present one percentage combining lines and statements.
test('a mixed-project coverage answer lists each part with its own measurement units', () => {
  const after = mergeParts([
    { dir: 'api', cov: report({ statements: 40, byDir: { '': { total: 5, covered: 2 } } }) },
    { dir: 'web', cov: report({ lines: 80, byDir: { '': { total: 5, covered: 4 } } }) },
  ])
  expect(coverageAnswer('', command, 0, '', null, after)).toBe('Coverage (test-grader), by npm test:\napi/: 40% statements.\nweb/: 80% lines.\nLeast covered folders (statements or lines): api/ 40% (2 of 5), web/ 80% (4 of 5).')
})

// Bug: replacing a folder's profile could also delete a sibling with the same prefix.
test('a partial Go profile replaces the folder and its descendants but preserves similarly named siblings', () => {
  const whole = 'mode: set\nex.org/m/pkg/a.go:1.1,2.1 2 0\nex.org/m/pkg/sub/b.go:1.1,2.1 1 1\nex.org/m/pkg2/c.go:1.1,2.1 3 1\n\n'
  const part = 'mode: atomic\nex.org/m/pkg/a.go:1.1,2.1 2 1\n'
  expect(mergeProfile(whole, part, 'ex.org/m', 'pkg')).toBe('mode: atomic\nex.org/m/pkg2/c.go:1.1,2.1 3 1\nex.org/m/pkg/a.go:1.1,2.1 2 1\n')
})

// Bug: missing module information could make merging erase blocks it cannot attribute.
test('a partial Go profile without a module path preserves the existing blocks', () => {
  expect(mergeProfile('mode: count\nother/a.go:1.1,2.1 1 1\n', 'new/b.go:1.1,2.1 2 0\n', null, 'pkg')).toBe('mode: count\nother/a.go:1.1,2.1 1 1\nnew/b.go:1.1,2.1 2 0\n')
})

// Bug: merging profiles without headers could omit the mode required by Go's reader.
test('Go profile merging supplies set mode when neither profile names a mode', () => {
  expect(mergeProfile('', '', 'ex.org/m', 'pkg')).toBe('mode: set\n')
})

// Bug: excluding a file after tallying could still inflate the project's statement figure.
test('ignored Go profile files contribute neither statements nor packages', () => {
  expect(goProfileOf('mode: set\nex.org/m/tmp/a.go:1.1,2.1 100 1\nex.org/m/pkg/b.go:1.1,2.1 4 0\n', 'ex.org/m', '/proj', file => !file.startsWith('/proj/tmp/'))).toEqual({
    statements: 0, byFile: [{ file: '/proj/pkg/b.go', total: 4, covered: 0 }], byPackage: [{ name: 'pkg/', total: 4, covered: 0 }],
  })
})
