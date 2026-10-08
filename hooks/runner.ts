// The command that runs one test, by its language and the project's runner: pure, so the
// engine calls stay in register.tsx
import type { Kind } from './discovery'

// what the project runs its tests with, as found at its root
export type Runners = {
  js?: 'vitest' | 'jest' | 'node' | 'playwright'
  /** node: its script loads TypeScript with tsx */
  isTsx?: boolean
  /** node: the package has Playwright too, for its .spec files */
  hasPlaywright?: boolean
  jvm?: 'gradle' | 'maven'
  isBundled?: boolean
  isPest?: boolean
}

// a test as its runner names it: its file (in the project), its own name, the groups around
// it, its line, and a Go suite test's suite
export type RunTarget = { rel: string; kind: Kind; plain: string; groups: string[]; line: number; suite?: string; tags?: string[] }

// a Go file's build tags its tests need: the names its //go:build line asks for, not those it
// rules out (//go:build integration && !short needs integration)
export const goTagsOf = (text: string): string[] => {
  const line = /^\/\/go:build (.+)$/m.exec(text.slice(0, text.search(/^package /m) >>> 0))?.[1] ?? ''
  return [...new Set([...line.matchAll(/(!?)\b([A-Za-z_][\w.]*)/g)].filter(m => m[1] === '').map(m => m[2]!))]
}

const SPEC = /\.spec\.[cm]?[jt]sx?$/
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
      // node's own runner, for a package whose scripts run node --test; its Playwright, if it has
      // one, runs the .spec files
      if (runners.js === 'node' && !(runners.hasPlaywright && SPEC.test(t.rel)))
        return ['node', ...(runners.isTsx ? ['--import', 'tsx'] : []), '--test', '--test-name-pattern', `${escapeRegex(t.plain)}$`, t.rel]
      if (runners.js === 'playwright' || runners.js === 'node') return ['npx', 'playwright', 'test', `${t.rel}:${t.line}`]
      return null
    }
    case 'py':
      return ['python3', '-m', 'pytest', '-q', [t.rel, ...t.groups, t.plain].join('::')]
    case 'go':
      return ['go', 'test', `./${dir}`, '-count=1', ...(t.tags?.length ? ['-tags', t.tags.join(',')] : []), '-run', t.suite ? `/^${t.plain}$` : `^${t.plain}$`]
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

// a run's output that says the code did not build or load, not that a test failed: Go's
// [build failed] and compiler lines, TypeScript's error TS, a SyntaxError, Rust's error[E…],
// javac's and Kotlin's compilation errors, Swift's and C#'s compiler errors
// the files that mark where a language's project starts, its tests run from there: a Go module
// in backend/, a jest app in mobile/
export const PROJECT_MARKS: Partial<Record<Kind, string[]>> = {
  go: ['go.mod'],
  js: ['package.json'],
  py: ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'setup.py'],
  rs: ['Cargo.toml'],
  jvm: ['build.gradle', 'build.gradle.kts', 'pom.xml'],
  rb: ['Gemfile'],
  php: ['composer.json'],
  swift: ['Package.swift'],
}

// a run's output that says the test could not be run at all: no module, no runner, no test found
export const isSetupFailure = (tail: string): boolean =>
  /cannot find main module|go\.mod file not found|no Go files in|command not found|No tests found|no tests ran|no tests to run|no test files|ENOENT|Cannot find module|could not be found|not recognized as an internal or external command/i.test(tail)

// a run's output that says it ran no test at all, though it exited 0: Go's [no tests to run]
export const isNoneRun = (output: string): boolean => /\[no tests to run\]|testing: warning: no tests to run|^ok\s.*\[no test files\]/m.test(output)

export const isBuildFailure = (tail: string): boolean =>
  /\[build failed\]|\[setup failed\]|^# \S+\n\S+\.go:\d+:\d+: |\berror TS\d+:|\bSyntaxError\b|\bIndentationError\b|\berror\[E\d+\]|COMPILATION ERROR|Compilation failed|\berror CS\d+:|\berror: cannot find symbol|^e: .*\.kt:/m.test(tail)
