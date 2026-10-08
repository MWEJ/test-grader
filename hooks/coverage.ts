// Coverage figures worked out from a report: by folder, the least covered, and the note a run
// sends Claude. Pure: reading the report stays in register.tsx
import type { Coverage } from '../types'

import { shortPath } from './discovery'

export const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null)

export const attr = (xml: string, name: string): number | null => {
  const m = xml.match(new RegExp(`${name}="([0-9.]+)"`))
  return m ? pct(Number(m[1]) * 100) : null
}

// Line coverage by folder, every folder holding the lines of all beneath it: by its path in
// the project ('' the project itself)
export const byDirOf = (files: { file: string; total: number; covered: number }[], cwd: string): Record<string, { total: number; covered: number }> => {
  const dirs: Record<string, { total: number; covered: number }> = {}
  for (const f of files) {
    if (f.total <= 0) continue
    const rel = shortPath(f.file, cwd)
    const parts = rel.split('/').slice(0, -1)
    for (let i = 0; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const d = (dirs[dir] ??= { total: 0, covered: 0 })
      d.total += f.total
      d.covered += f.covered
    }
  }
  return dirs
}

// the least covered folders, a few lines each at least, lowest first: where more tests would pay
const LEAST_COVERED = 5
const MIN_LINES = 20
const leastCovered = (cov: Coverage | null): string[] =>
  Object.entries(cov?.byDir ?? {})
    .filter(([dir, d]) => dir !== '' && d.total >= MIN_LINES)
    .map(([dir, d]) => ({ dir, p: (d.covered / d.total) * 100 }))
    .filter(d => d.p < 80)
    .sort((a, b) => a.p - b.p)
    .slice(0, LEAST_COVERED)
    .map(d => `${d.dir}/ ${Math.round(d.p)}%`)

// a coverage run: its command, how a note to Claude names it, and where Go prints its figures
export type CoverCommand = { argv: string[]; label: string; goOutput?: string }

// what a finished coverage run tells Claude: the figures it left, or how it failed and
// the end of what it printed
const COVER_TAIL = 20
export const coverageNote = (command: CoverCommand, exitCode: number, output: string, cov: Coverage | null): string => {
  const figures = cov
    ? ([['lines', cov.lines], ['statements', cov.statements], ['branches', cov.branches], ['functions', cov.functions]] as const)
        .filter(([, v]) => v !== null)
        .map(([name, v]) => `${name} ${v}%`)
        .join(' · ')
    : ''
  if (exitCode === 0) {
    const least = leastCovered(cov)
    return figures
      ? `Coverage run (test-grader) finished: ${figures} (${cov!.source}).${least.length > 0 ? `\nLeast covered folders (${cov!.lines === null && cov!.statements !== null ? 'statements' : 'lines'}): ${least.join(', ')}.` : ''}`
      : `Coverage run (test-grader) finished, but ${command.label} wrote no report test-grader reads.`
  }
  const lines = output.split('\n').filter(l => l.trim() !== '').slice(-COVER_TAIL)
  return [`Coverage run (test-grader) failed: ${command.label} exited with ${exitCode}. The last ${lines.length} lines it printed:`, ...lines].join('\n')
}
