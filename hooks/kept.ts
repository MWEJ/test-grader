// The project's grades as the store keeps them: short codes, no summaries when room runs out. Pure
import type { Confidence, ExistingTest, Verdict } from '../types'

import { verdictOf } from './verdicts'

// The project's grades outlive the session: kept in the store under the project's folder,
// with each graded file's fingerprint, so a later session lists them and Grade all tests
// grades again only the files changed since. Listed-but-ungraded rows are not kept
export type SavedGrades = { results: ExistingTest[]; hashes: Record<string, string>; finishedAt?: number }
// as kept: by file, each file's fingerprint and its tests as [name, verdict, summary, reason,
// suite, evidence, evidenceOf, confidence (m or l; high left out), textOf], verdicts as g (strong), w (shallow), b (brittle), u (hollow), d (duplicate)
// (none: unrated), the first three as the grades before these were kept; a file's path is
// written once
type KeptTest = [string, string, string?, string?, string?, string?, string?, string?, string?]
export type KeptGrades = { v: 2; files: Record<string, { hash?: string; tests: KeptTest[] }>; finishedAt?: number }
export const gradesKey = (cwd: string): string => `grades:${cwd}`
const VERDICT_CODE: Record<Verdict, string> = { strong: 'g', shallow: 'w', brittle: 'b', hollow: 'u', duplicate: 'd' }
const CODE_VERDICT: Record<string, Verdict> = Object.fromEntries(Object.entries(VERDICT_CODE).map(([v, c]) => [c, v as Verdict]))

// lean: the summaries left out, for a project whose grades are too many to keep whole
export const keep = (saved: SavedGrades, isLean: boolean): KeptGrades => {
  const files: KeptGrades['files'] = {}
  for (const [file, hash] of Object.entries(saved.hashes)) files[file] = { hash, tests: [] }
  for (const t of saved.results) {
    const row: KeptTest = [t.name, t.verdict ? VERDICT_CODE[t.verdict] : '', isLean ? '' : (t.summary ?? ''), t.reason ?? '', t.suite ?? '', t.evidence ?? '', t.evidence ? (t.evidenceOf ?? '') : '', t.confidence === 'medium' ? 'm' : t.confidence === 'low' ? 'l' : '', t.verdict ? (t.textOf ?? '') : '']
    while (row.length > 2 && !row[row.length - 1]) row.pop()
    ;(files[t.file] ??= { tests: [] }).tests.push(row)
  }
  return { v: 2, files, ...(saved.finishedAt === undefined ? {} : { finishedAt: saved.finishedAt }) }
}
export const unkeep = (kept: KeptGrades | SavedGrades): SavedGrades => {
  // the oldest form, verdicts in words: the old words read as the nearest grade
  if (!('v' in kept)) return { ...kept, results: kept.results.map(({ verdict, ...t }) => (verdictOf(verdict) ? { ...t, verdict: verdictOf(verdict)! } : t)) }
  const results: ExistingTest[] = []
  const hashes: Record<string, string> = {}
  for (const [file, { hash, tests }] of Object.entries(kept.files)) {
    if (hash) hashes[file] = hash
    for (const [name, code, summary, reason, suite, evidence, evidenceOf, sure, textOf] of tests) {
      const confidence: Confidence | undefined = sure === 'm' ? 'medium' : sure === 'l' ? 'low' : undefined
      results.push({ file, name, ...(CODE_VERDICT[code] ? { verdict: CODE_VERDICT[code] } : {}), ...(summary ? { summary } : {}), ...(reason ? { reason } : {}), ...(suite ? { suite } : {}), ...(evidence ? { evidence } : {}), ...(evidence && evidenceOf ? { evidenceOf } : {}), ...(confidence ? { confidence } : {}), ...(textOf ? { textOf } : {}) })
    }
  }
  return { results, hashes, ...(kept.finishedAt === undefined ? {} : { finishedAt: kept.finishedAt }) }
}
