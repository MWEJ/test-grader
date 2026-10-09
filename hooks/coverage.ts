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
  // statements add up across parts, Go's and jest's alike: the project's figure where every part
  // counted them
  const counts = found.map(f => f.cov.statementCount)
  const statementCount = counts.every(c => c !== undefined) ? counts.reduce((a, c) => ({ total: a.total + c!.total, covered: a.covered + c!.covered }), { total: 0, covered: 0 }) : undefined
  return {
    lines: only?.lines ?? null,
    statements: only?.statements ?? (statementCount && statementCount.total > 0 ? pct((statementCount.covered / statementCount.total) * 100) : null),
    branches: only?.branches ?? null,
    functions: only?.functions ?? null,
    source: parts.map(p => `${p.dir}/: ${p.source}`).join(' · '),
    updatedAt: Math.max(...found.map(f => f.cov.updatedAt ?? 0)) || null,
    byDir,
    ...(byPackage.length > 0 ? { byPackage } : {}),
    ...(statementCount ? { statementCount } : {}),
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

// Go's packages as the figure should read them: tested (tests of it were built and run, some of
// its tests maybe not built), not built (every test of it has a build tag the run was not given:
// unmeasured, not low), no tests, a command with no tests, or a test helper. tests: by package
// name, how many listed tests it has and how many of them were not built
export type PackageTests = { tests: number; unbuilt: number }
export type PackageState = 'tested' | 'not built' | 'no tests' | 'command' | 'helper'
export type PackageView = { name: string; total: number; covered: number; pct: number; state: PackageState; unbuilt: number }
// where no package has a listed test the list is not known yet, and a package is taken as tested
// unless its role says otherwise
export const packageViews = (packages: { name: string; total: number; covered: number; role?: 'command' | 'helper' }[], tests: Record<string, PackageTests>): PackageView[] => {
  const isListed = packages.some(p => (tests[p.name]?.tests ?? 0) > 0)
  return packages
    .filter(p => p.total > 0)
    .map(p => {
      const t = tests[p.name] ?? { tests: 0, unbuilt: 0 }
      const state: PackageState =
        p.role === 'helper' ? 'helper' : t.tests > t.unbuilt ? 'tested' : t.unbuilt > 0 ? 'not built' : p.role === 'command' ? 'command' : isListed ? 'no tests' : 'tested'
      return { name: p.name, total: p.total, covered: p.covered, pct: pct((p.covered / p.total) * 100)!, state, unbuilt: t.unbuilt }
    })
}

// what a statements total over every package hides: the figure over the tested packages, their
// median, and what the total counts that no test is meant for or no test was built for; null
// where every package is tested
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
export const testedLine = (views: PackageView[]): string | null => {
  const tested = views.filter(v => v.state === 'tested')
  if (tested.length === views.length || tested.length === 0) return null
  const total = tested.reduce((s, v) => s + v.total, 0)
  const covered = tested.reduce((s, v) => s + v.covered, 0)
  const sorted = tested.map(v => v.pct).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid]! : pct((sorted[mid - 1]! + sorted[mid]!) / 2)!
  const count = (state: PackageState): number => views.filter(v => v.state === state).length
  const unbuilt = views.filter(v => v.state === 'not built')
  const left = [
    ...(count('command') > 0 ? [`${plural(count('command'), 'command')} (package main) with no tests`] : []),
    ...(count('no tests') > 0 ? [`${plural(count('no tests'), 'other package')} with no tests`] : []),
    ...(count('helper') > 0 ? [`${plural(count('helper'), 'test helper')}`] : []),
    ...(unbuilt.length > 0 ? (n => [`${plural(unbuilt.length, 'package')} whose ${plural(n, 'test')} ${n === 1 ? 'was' : 'were'} not built (unmeasured, not low)`])(unbuilt.reduce((s, v) => s + v.unbuilt, 0)) : []),
  ]
  return `${pct((covered / total) * 100)}% over the ${plural(tested.length, 'package')} whose tests ran (median package ${median}%); the total also counts ${left.join(', ')}.`
}

// the least covered folders, a few lines each at least, lowest first: where more tests would pay;
// a folder of Go packages none of which is tested is left out: more tests are not what it lacks
const LEAST_COVERED = 5
const MIN_LINES = 20
// whether a folder holds packages and none of them tested
export const isUntestedDir = (views: PackageView[], dir: string): boolean => {
  const under = views.filter(v => v.name === `${dir}/` || v.name.startsWith(`${dir}/`))
  return under.length > 0 && under.every(v => v.state !== 'tested')
}
// a folder's figure less its packages that are not tested, which would rank it low for code no
// test is meant for
const testedOf = (views: PackageView[], dir: string, d: { total: number; covered: number }): { total: number; covered: number } =>
  views
    .filter(v => v.state !== 'tested' && (v.name === `${dir}/` || v.name.startsWith(`${dir}/`)))
    .reduce((t, v) => ({ total: t.total - v.total, covered: t.covered - v.covered }), d)
const leastCovered = (cov: Coverage | null, views: PackageView[]): string[] =>
  Object.entries(cov?.byDir ?? {})
    .map(([dir, d]) => [dir, testedOf(views, dir, d)] as const)
    .filter(([dir, d]) => dir !== '' && d.total >= MIN_LINES && !isUntestedDir(views, dir))
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
// views: Go's packages, as packageViews reads them
// a Go total's tested line, under the part it is of where there are parts
const testedNote = (cov: Coverage | null, views: PackageView[]): string => {
  const parts = cov?.parts && cov.parts.length > 1 ? cov.parts : null
  const lines = parts
    ? parts.flatMap(p => {
        const line = testedLine(views.filter(v => v.name.startsWith(`${p.dir}/`)))
        return line ? [`${p.dir}/: ${line}`] : []
      })
    : [testedLine(views)].filter((l): l is string => l !== null)
  return lines.map(l => `\n${l}`).join('')
}
export const coverageNote = (command: CoverCommand, exitCode: number, output: string, cov: Coverage | null, views: PackageView[] = []): string => {
  const figures = !cov
    ? ''
    : cov.parts && cov.parts.length > 1
      ? (cov.statements !== null ? `the whole project ${cov.statements}% of statements (its parts' added up); ` : '') + cov.parts.map(p => `${p.dir}/ ${figuresOf(p)} (${p.source})`).join('; ')
      : figuresOf(cov) && `${figuresOf(cov)} (${cov.source})`
  if (exitCode === 0) {
    const least = leastCovered(cov, views)
    return figures
      ? `Coverage run (test-grader) finished: ${figures}.${testedNote(cov, views)}${least.length > 0 ? `\nLeast covered folders (${kindOf(cov)}): ${least.join(', ')}.` : ''}`
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
export const coverageAnswer = (rel: string, command: CoverCommand, exitCode: number, output: string, before: Coverage | null, after: Coverage | null, views: PackageView[] = []): string => {
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
  else if (after?.statements != null) lines.push(`The whole project: ${after.statements}% of statements, its parts' added up${before?.statements != null && before.statements !== after.statements ? `, was ${before.statements}%` : ''}.`)
  if (parts) lines.push(...parts.filter(p => rel === '' || rel.startsWith(`${p.dir}/`)).map(p => figure(`${p.dir}/`, p.dir)))
  else if (rel !== '') lines.push(figure('The project', ''))
  if (rel === '') lines.push(...testedNote(after, views).split('\n').filter(Boolean))
  const under = Object.entries(after?.byDir ?? {})
    .map(([dir, d]) => [dir, testedOf(views, dir, d)] as const)
    .filter(([dir, d]) => d.total > 0 && dir !== rel && (rel === '' ? dir !== '' : dir.startsWith(`${rel}/`)) && !isUntestedDir(views, dir))
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
