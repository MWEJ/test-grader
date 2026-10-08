// The command that runs one test, by its language and the project's runner: pure, so the
// engine calls stay in register.tsx
import type { Kind } from './discovery'

// what the project runs its tests with, as found at its root
export type Runners = {
  js?: 'vitest' | 'jest' | 'playwright'
  jvm?: 'gradle' | 'maven'
  isBundled?: boolean
  isPest?: boolean
}

// a test as its runner names it: its file (in the project), its own name, the groups around
// it, its line, and a Go suite test's suite
export type RunTarget = { rel: string; kind: Kind; plain: string; groups: string[]; line: number; suite?: string }

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// a test's class: its innermost group, else the file's name less its extension
const classOf = (t: RunTarget): string => t.groups[t.groups.length - 1] ?? t.rel.slice(t.rel.lastIndexOf('/') + 1).replace(/\.\w+$/, '')

// the argv that runs this one test, or null where test-grader knows no runner for it
export const runArgv = (t: RunTarget, runners: Runners): string[] | null => {
  const dir = t.rel.includes('/') ? t.rel.slice(0, t.rel.lastIndexOf('/')) : '.'
  switch (t.kind) {
    case 'js': {
      const full = escapeRegex([...t.groups, t.plain].join(' '))
      if (runners.js === 'vitest') return ['npx', 'vitest', 'run', t.rel, '-t', `^${full}$`]
      if (runners.js === 'jest') return ['npx', 'jest', t.rel, '-t', `^${full}$`]
      if (runners.js === 'playwright') return ['npx', 'playwright', 'test', `${t.rel}:${t.line}`]
      return null
    }
    case 'py':
      return ['python3', '-m', 'pytest', '-q', [t.rel, ...t.groups, t.plain].join('::')]
    case 'go':
      return ['go', 'test', `./${dir}`, '-count=1', '-run', t.suite ? `/^${t.plain}$` : `^${t.plain}$`]
    case 'rb':
      if (t.rel.endsWith('_spec.rb')) return [...(runners.isBundled ? ['bundle', 'exec'] : []), 'rspec', `${t.rel}:${t.line}`]
      return ['ruby', '-Itest', t.rel, '-n', `/^${escapeRegex(t.plain.replace(/ /g, '_'))}$|^test_${escapeRegex(t.plain.replace(/ /g, '_'))}$/`]
    case 'rs':
      return ['cargo', 'test', t.plain]
    case 'jvm':
      if (runners.jvm === 'gradle') return ['./gradlew', 'test', '--tests', `*${classOf(t)}.${t.plain}`]
      if (runners.jvm === 'maven') return ['mvn', '-q', 'test', `-Dtest=${classOf(t)}#${t.plain}`]
      return null
    case 'cs':
      return ['dotnet', 'test', '--filter', `FullyQualifiedName~${classOf(t)}.${t.plain}`]
    case 'php':
      return runners.isPest ? ['vendor/bin/pest', t.rel, '--filter', t.plain] : ['vendor/bin/phpunit', '--filter', `/::${escapeRegex(t.plain)}$/`, t.rel]
    case 'swift':
      return ['swift', 'test', '--filter', `${classOf(t)}/${t.plain}`]
  }
}

// a command as a person would type it
export const shown = (argv: readonly string[]): string => argv.map(a => (/^[\w./:=@%^+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')

// the last lines a run printed, the empty ones left out
export const tailOf = (output: string, lines: number): string => output.split('\n').filter(l => l.trim() !== '').slice(-lines).join('\n')
