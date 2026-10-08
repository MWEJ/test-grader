// Coverage figures worked out from a report: by folder, the least covered, and the note a run
// sends Claude. Pure: reading the report stays in register.tsx
import type { Coverage, CoveragePart } from '../types'

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

// The parts' reports as one: each part's figures kept apart (Go's statements and jest's lines do
// not add up), its folders and packages by their path in the project. A project of one part is
// that part's report, its paths under the part's folder
export const mergeParts = (found: { dir: string; cov: Coverage }[]): Coverage | null => {
  if (found.length === 0) return null
  const inPart = (dir: string, path: string): string => (path === '' ? dir : `${dir}/${path}`)
  const byDir: Record<string, { total: number; covered: number }> = {}
  for (const { dir, cov } of found) for (const [path, d] of Object.entries(cov.byDir ?? {})) byDir[inPart(dir, path)] = d
  const byPackage = found.flatMap(({ dir, cov }) => (cov.byPackage ?? []).map(p => ({ ...p, name: p.name === './' ? `${dir}/` : `${dir}/${p.name}` })))
  const parts: CoveragePart[] = found.map(({ dir, cov }) => ({ dir, lines: cov.lines, statements: cov.statements, branches: cov.branches, functions: cov.functions, source: cov.source }))
  const only = found.length === 1 ? found[0]!.cov : null
  return {
    lines: only?.lines ?? null,
    statements: only?.statements ?? null,
    branches: only?.branches ?? null,
    functions: only?.functions ?? null,
    source: parts.map(p => `${p.dir}/: ${p.source}`).join(' · '),
    updatedAt: Math.max(...found.map(f => f.cov.updatedAt ?? 0)) || null,
    byDir,
    ...(byPackage.length > 0 ? { byPackage } : {}),
    parts,
  }
}

// what a report measures: Go's statements, else lines; a project of parts names each kind it has
const kindOfFigures = (c: { lines: number | null; statements: number | null }): string => (c.lines === null && c.statements !== null ? 'statements' : 'lines')
export const kindOf = (cov: Coverage | null): string => (cov?.parts && cov.parts.length > 1 ? [...new Set(cov.parts.map(kindOfFigures))].join(' or ') : cov ? kindOfFigures(cov) : 'lines')
// the kind of the part a folder is in, by its path in the project
export const kindAt = (cov: Coverage | null, path: string): string => {
  const part = cov?.parts?.find(p => path === p.dir || path.startsWith(`${p.dir}/`))
  return part ? kindOfFigures(part) : kindOf(cov)
}
// a report's figures as a note says them
const figuresOf = (c: { lines: number | null; statements: number | null; branches: number | null; functions: number | null }): string =>
  ([['lines', c.lines], ['statements', c.statements], ['branches', c.branches], ['functions', c.functions]] as const)
    .filter(([, v]) => v !== null)
    .map(([name, v]) => `${name} ${v}%`)
    .join(' · ')

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
  const figures = !cov
    ? ''
    : cov.parts && cov.parts.length > 1
      ? cov.parts.map(p => `${p.dir}/ ${figuresOf(p)} (${p.source})`).join('; ')
      : figuresOf(cov) && `${figuresOf(cov)} (${cov.source})`
  if (exitCode === 0) {
    const least = leastCovered(cov)
    return figures
      ? `Coverage run (test-grader) finished: ${figures}.${least.length > 0 ? `\nLeast covered folders (${kindOf(cov)}): ${least.join(', ')}.` : ''}`
      : `Coverage run (test-grader) finished, but ${command.label} wrote no report test-grader reads.`
  }
  const lines = output.split('\n').filter(l => l.trim() !== '').slice(-COVER_TAIL)
  // tests failed, but the run left figures: they are given, with what failed (Go's FAIL lines)
  if (figures) {
    const failed = [...new Set(output.split('\n').flatMap(l => l.match(/^FAIL\s+(\S+)/)?.[1] ?? []).filter(p => p !== 'FAIL'))]
    return [
      `Coverage run (test-grader) finished with failing tests (${command.label} exited with ${exitCode}): ${figures}. The figures are from the tests that ran.`,
      ...(failed.length > 0 ? [`Failed: ${failed.slice(0, 10).join(', ')}${failed.length > 10 ? ` and ${failed.length - 10} more` : ''}.`] : [`The last ${lines.length} lines it printed:`, ...lines]),
    ].join('\n')
  }
  return [`Coverage run (test-grader) failed: ${command.label} exited with ${exitCode}. The last ${lines.length} lines it printed:`, ...lines].join('\n')
}

// what Claude's coverage tool answers: a folder's figure (the project's, rel '') now and before
// the run, the project's beside it, and the least covered folders under it, lowest first
const UNDER = 8
export const coverageAnswer = (rel: string, command: CoverCommand, exitCode: number, output: string, before: Coverage | null, after: Coverage | null): string => {
  const of = (cov: Coverage | null, dir: string): number | null => {
    const d = cov?.byDir?.[dir]
    return d && d.total > 0 ? pct((d.covered / d.total) * 100) : null
  }
  const figure = (where: string, dir: string): string => {
    const now = of(after, dir)
    const was = of(before, dir)
    if (now === null) return `${where} has no figure in the report: none of its code was measured.`
    return `${where}: ${now}% ${kindAt(after, dir)}${was === null ? '' : was === now ? ', unchanged' : `, was ${was}%`}.`
  }
  const where = rel === '' ? 'The project' : `${rel}/`
  const lines = [`Coverage (test-grader), by ${command.label}:`]
  if (exitCode !== 0) lines.push(`It exited with ${exitCode}: the figures are from the tests that ran.`)
  // a project of parts has no one figure: each part's, or the part the folder is in
  const parts = after?.parts && after.parts.length > 1 ? after.parts : null
  if (!(parts && rel === '')) lines.push(figure(where, rel))
  if (parts) lines.push(...parts.filter(p => rel === '' || rel.startsWith(`${p.dir}/`)).map(p => figure(`${p.dir}/`, p.dir)))
  else if (rel !== '') lines.push(figure('The project', ''))
  const under = Object.entries(after?.byDir ?? {})
    .filter(([dir, d]) => d.total > 0 && dir !== rel && (rel === '' ? dir !== '' : dir.startsWith(`${rel}/`)))
    .map(([dir, d]) => ({ dir, p: (d.covered / d.total) * 100, d }))
    .sort((a, b) => a.p - b.p || a.dir.localeCompare(b.dir))
    .slice(0, UNDER)
  if (under.length > 0) lines.push(`Least covered folders${rel === '' ? '' : ` in ${rel}/`} (${rel === '' ? kindOf(after) : kindAt(after, rel)}): ${under.map(u => `${u.dir}/ ${Math.round(u.p)}% (${u.d.covered} of ${u.d.total})`).join(', ')}.`)
  if (!after) lines.splice(1, lines.length - 1, `${command.label} wrote no report test-grader reads.`)
  if (exitCode !== 0) {
    const tail = output.split('\n').filter(l => l.trim() !== '').slice(-COVER_TAIL)
    lines.push(`The last ${tail.length} lines it printed:`, ...tail)
  }
  return lines.join('\n')
}
