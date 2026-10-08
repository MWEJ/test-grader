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

// what Claude's coverage tool answers: a folder's figure (the project's, rel '') now and before
// the run, the project's beside it, and the least covered folders under it, lowest first
const UNDER = 8
export const coverageAnswer = (rel: string, command: CoverCommand, exitCode: number, output: string, before: Coverage | null, after: Coverage | null): string => {
  const kind = after && after.lines === null && after.statements !== null ? 'statements' : 'lines'
  const of = (cov: Coverage | null, dir: string): number | null => {
    const d = cov?.byDir?.[dir]
    return d && d.total > 0 ? pct((d.covered / d.total) * 100) : null
  }
  const figure = (where: string, dir: string): string => {
    const now = of(after, dir)
    const was = of(before, dir)
    if (now === null) return `${where} has no figure in the report: none of its code was measured.`
    return `${where}: ${now}% ${kind}${was === null ? '' : was === now ? ', unchanged' : `, was ${was}%`}.`
  }
  const where = rel === '' ? 'The project' : `${rel}/`
  const lines = [`Coverage (test-grader), by ${command.label}:`]
  if (exitCode !== 0) lines.push(`It exited with ${exitCode}: the figures are from the tests that ran.`)
  lines.push(figure(where, rel))
  if (rel !== '') lines.push(figure('The project', ''))
  const under = Object.entries(after?.byDir ?? {})
    .filter(([dir, d]) => d.total > 0 && dir !== rel && (rel === '' ? dir !== '' : dir.startsWith(`${rel}/`)))
    .map(([dir, d]) => ({ dir, p: (d.covered / d.total) * 100, d }))
    .sort((a, b) => a.p - b.p || a.dir.localeCompare(b.dir))
    .slice(0, UNDER)
  if (under.length > 0) lines.push(`Least covered folders${rel === '' ? '' : ` in ${rel}/`} (${kind}): ${under.map(u => `${u.dir}/ ${Math.round(u.p)}% (${u.d.covered} of ${u.d.total})`).join(', ')}.`)
  if (!after) lines.splice(1, lines.length - 1, `${command.label} wrote no report test-grader reads.`)
  if (exitCode !== 0) {
    const tail = output.split('\n').filter(l => l.trim() !== '').slice(-COVER_TAIL)
    lines.push(`The last ${tail.length} lines it printed:`, ...tail)
  }
  return lines.join('\n')
}
