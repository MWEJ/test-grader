#!/usr/bin/env node
// Coverage for this mod: `claude plugin test` has no coverage of its own, so this copies the mod,
// instruments its hooks with Istanbul, runs the tests there, and has each test hand back the
// counters (the module's through a command it answers, the test file's own from its global).
// Usage: node scripts/coverage.mjs   (writes coverage/lcov.info and prints a table)
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'test-grader-cov-'))
const deps = join(work, 'deps')
mkdirSync(deps)
execFileSync('npm', ['install', '--silent', '--prefix', deps, 'istanbul-lib-instrument@6', 'istanbul-lib-coverage@3', 'istanbul-lib-report@3', 'istanbul-reports@3'], { stdio: 'inherit' })
const require = createRequire(join(deps, 'node_modules', 'x.js'))
const { createInstrumenter } = require('istanbul-lib-instrument')
const libCoverage = require('istanbul-lib-coverage')
const libReport = require('istanbul-lib-report')
const reports = require('istanbul-reports')

// the mod, copied, its hooks instrumented under their real paths
const copy = join(work, 'mod')
cpSync(root, copy, { recursive: true, filter: src => !/\/(\.git|coverage|node_modules)(\/|$)/.test(src) })
const instrumenter = createInstrumenter({ esModules: true, parserPlugins: ['typescript', 'jsx'], coverageGlobalScope: 'globalThis', coverageGlobalScopeFunc: false, produceSourceMap: false })
const hooks = join(copy, 'hooks')
for (const name of readdirSync(hooks).filter(f => /\.tsx?$/.test(f))) {
  const path = join(hooks, name)
  // the engine reads its state atoms as written (atom({ plugin, key })): left uncounted
  let source = readFileSync(path, 'utf8').replace(/^const \w+ = atom\(/gm, m => `/* istanbul ignore next */ ${m}`)
  // the module answers a command with its counters
  if (name === 'register.tsx') {
    source = source.replace(
      /export const register(: Register)? = \(on, options\) => \{/,
      m => `${m}\n  /* istanbul ignore next */ on('command.run', { command: '__coverage__' }, async () => ({ text: JSON.stringify((globalThis as any).__coverage__ ?? {}) }))`,
    )
  }
  writeFileSync(path, instrumenter.instrumentSync(source, join(root, 'hooks', name)))
}
// each test, once its body is done, prints the module's counters and its own
const tests = join(copy, 'tests')
for (const name of readdirSync(tests).filter(f => /\.test\.tsx?$/.test(f))) {
  const path = join(tests, name)
  const wrap = `
import { test as kitTest } from 'claude-code/testing'
const test = ((name: string, ...rest: any[]) => {
  const body = rest[rest.length - 1]
  const dumped = async ($: any, on: any) => {
    try {
      return await body($, on)
    } finally {
      try {
        const r = await $.command.run({ command: '__coverage__', args: '' })
        console.log('__COV__' + r.text)
      } catch {}
      console.log('__COV__' + JSON.stringify((globalThis as any).__coverage__ ?? {}))
    }
  }
  return (kitTest as any)(name, ...rest.slice(0, -1), dumped)
}) as typeof kitTest
`
  writeFileSync(path, readFileSync(path, 'utf8').replace(/import \{ ([^}]*)\btest\b,? ?([^}]*)\} from 'claude-code\/testing'/, (_m, a, b) => `import { ${a}${b}} from 'claude-code/testing'${wrap}`))
}

// the kit writes its report to stderr: both streams are read
const ran = spawnSync('claude', ['plugin', 'test', copy], { encoding: 'utf8', maxBuffer: 1 << 30 })
const output = `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`
const failed = output.split('\n').filter(line => line.startsWith('(fail)'))
if (ran.status !== 0) process.stderr.write(`${failed.join('\n')}\nthe tests failed under instrumentation: coverage is of the runs that finished\n`)
const map = libCoverage.createCoverageMap({})
for (const line of output.split('\n')) if (line.startsWith('__COV__')) map.merge(JSON.parse(line.slice('__COV__'.length)))
const summary = output.match(/^ *\d+ pass\n *\d+ fail\n.*Ran .*$/m)?.[0]
if (summary) console.log(summary.trim())

const dir = join(root, 'coverage')
rmSync(dir, { recursive: true, force: true })
const context = libReport.createContext({ dir, coverageMap: map, defaultSummarizer: 'nested' })
for (const kind of ['text', 'lcov', 'json-summary']) reports.create(kind).execute(context)
console.log(`\nWrote ${relative(process.cwd(), dir)}/lcov.info and coverage-summary.json`)
if (!process.env.KEEP) rmSync(work, { recursive: true, force: true })
else console.log(work)
