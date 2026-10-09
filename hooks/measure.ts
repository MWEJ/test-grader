// Strong grades measured: each names a bug its test would catch, and where the grader saw the
// code under test, the change that makes it. A few at a time, while the session is idle, the
// change is made and the test run: one that still passes let its bug through. Pure: no engine
// calls

// a strong grade's change to measure, by file::name; textOf: the test's own text when graded
export type Proposed = { bug: string; file: string; find: string; replace: string; textOf: string }
// held: the test failed with the change; through: it passed; unmeasured: the run showed nothing
// (the test failed unchanged, or the change did not build), why saying which
export type Measured = { state: 'held' | 'through' | 'unmeasured'; change: string; textOf: string; why?: string }

// how many proposals are kept: the most recent, by when they were graded
export const MAX_PROPOSED = 3000

// The next tests to measure: strong now, with a change proposed for their text as it stands, and
// not measured at that text; a shuffled pick, so a big project's sample is spread over it
export const pickToMeasure = (
  strong: { key: string; textOf: string | undefined }[],
  proposed: Record<string, Proposed>,
  measured: Record<string, Measured>,
  count: number,
  random: () => number = Math.random,
): string[] => {
  const open = strong.filter(t => {
    const p = proposed[t.key]
    if (!p || (t.textOf !== undefined && p.textOf !== t.textOf)) return false
    return measured[t.key]?.textOf !== p.textOf
  })
  for (let i = open.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[open[i], open[j]] = [open[j]!, open[i]!]
  }
  return open.slice(0, Math.max(0, count)).map(t => t.key)
}

// the code with the change made, or why it cannot be: the text to find must be there exactly once
export const mutate = (code: string, find: string, replace: string): { code: string } | { why: string } => {
  const count = code.split(find).length - 1
  if (count !== 1) return { why: count === 0 ? 'the text to change is not in the file' : `the text to change is in the file ${count} times, not once` }
  return { code: code.replace(find, () => replace) }
}

// how a change is named, in notes and reasons
export const changeOf = (find: string, replace: string, file: string): string => `${JSON.stringify(find)} replaced by ${JSON.stringify(replace)} in ${file}`

// a Go build's overlay: the file built from another, the source left as it is
export const overlayOf = (file: string, replacement: string): string => JSON.stringify({ Replace: { [file]: replacement } })

// the grade a test that let its named bug through is given instead of strong
export const throughGrade = (bug: string, change: string): { verdict: 'shallow'; reason: string } => ({
  verdict: 'shallow',
  reason: `Measured: it still passes with ${change}, the bug its strong grade named. It would miss: ${bug}`,
})

// the pane's line: of the strong tests listed, how many a measured change made fail, and how
// many tests let theirs through (graded shallow since); null before any is measured
export const measuredLine = (strongKeys: string[], measured: Record<string, Measured>): string | null => {
  const results = Object.values(measured)
  const through = results.filter(m => m.state === 'through').length
  if (results.length === 0) return null
  const held = strongKeys.filter(k => measured[k]?.state === 'held').length
  return `measured: ${held} of ${strongKeys.length} strong${through > 0 ? ` · ${through} let their named bug through (now shallow)` : ''}`
}
