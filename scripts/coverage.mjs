#!/usr/bin/env node
// Coverage for this mod: `claude plugin test` has no coverage of its own, so this copies the mod,
// instruments its hooks with Istanbul, runs the tests there, and has each test hand back the
// counters (the module's through a command it answers, the test file's own from its global).
// Usage: node scripts/coverage.mjs   (writes coverage/lcov.info and prints a table)
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism, tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'test-grader-cov-'))
// Istanbul, installed once and kept for later runs
const deps = join(tmpdir(), 'test-grader-cov-deps')
if (!existsSync(join(deps, 'node_modules', 'istanbul-reports'))) {
  mkdirSync(deps, { recursive: true })
  execFileSync('npm', ['install', '--silent', '--prefix', deps, 'istanbul-lib-instrument@6', 'istanbul-lib-coverage@3', 'istanbul-lib-report@3', 'istanbul-reports@3'], { stdio: 'inherit' })
}
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

// each test file in a process of its own (--file), as many at once as the machine has cores:
// one process's output is its file's alone, so the long counter lines of two files never
// interleave. The kit writes its report to stderr, so both streams are read
const files = readdirSync(tests).filter(f => /\.test\.tsx?$/.test(f))
const runFile = name =>
  new Promise(resolve => {
    const child = spawn('claude', ['plugin', 'test', '--file', join(tests, name), copy])
    // each stream on its own, so a line of one is never split by the other's
    const out = []
    const err = []
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('close', () => resolve(`${Buffer.concat(out).toString('utf8')}\n${Buffer.concat(err).toString('utf8')}`))
    child.on('error', err => resolve(`(fail) ${name}: ${err.message}`))
  })
const outputs = new Array(files.length)
let next = 0
const worker = async () => {
  while (next < files.length) {
    const at = next++
    outputs[at] = await runFile(files[at])
  }
}
await Promise.all(Array.from({ length: Math.min(files.length, availableParallelism()) }, worker))
// a file's results, from the report line the kit prints for --file
const results = outputs.flatMap(out => {
  const line = out.split('\n').find(l => l.startsWith('claude-plugin-test-report '))
  return line ? JSON.parse(line.slice('claude-plugin-test-report '.length)).results : []
})
const passed = results.filter(r => r.failure === null).length
const failedCount = results.length - passed
const output = outputs.join('\n')
const failed = [...results.filter(r => r.failure !== null).map(r => `(fail) ${r.title}`), ...output.split('\n').filter(line => line.startsWith('(fail)'))]
if (failed.length > 0) process.stderr.write(`${failed.join('\n')}\nthe tests failed under instrumentation: coverage is of the runs that finished\n`)
const map = libCoverage.createCoverageMap({})
// a line the kit's output cut off or interleaved is passed over: the counters only grow, so a
// later line from the same file holds what it did
let cut = 0
for (const line of output.split('\n')) {
  if (!line.startsWith('__COV__')) continue
  try {
    map.merge(JSON.parse(line.slice('__COV__'.length)))
  } catch {
    cut += 1
  }
}
if (cut > 0) process.stderr.write(`${cut} counter lines arrived cut off and were passed over\n`)
console.log(`${passed} pass, ${failedCount} fail, over ${files.length} test files`)
const dir = join(root, 'coverage')
rmSync(dir, { recursive: true, force: true })
const context = libReport.createContext({ dir, coverageMap: map, defaultSummarizer: 'nested' })
for (const kind of ['text', 'lcov', 'json-summary']) reports.create(kind).execute(context)
console.log(`\nWrote ${relative(process.cwd(), dir)}/lcov.info and coverage-summary.json`)
if (!process.env.KEEP) rmSync(work, { recursive: true, force: true })
else console.log(work)
