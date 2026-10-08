import { runArgv, shown as shownCommand, tailOf } from '../hooks/runner'
import { expect, test } from 'claude-code/testing'
import { jest, RUNS } from './helpers'

for (const [label, target, found, argv] of RUNS) {
  test(`one test runs with ${label}: ${argv ? shownCommand(argv) : 'no command'}`, async () => {
    expect(runArgv(target, found)).toEqual(argv)
  })
}


test('a command is shown as typed, quoting what the shell would split', async () => {
  expect(shownCommand(['npx', 'jest', 'src/a.test.ts', '-t', "^it's (1)$"])).toBe("npx jest src/a.test.ts -t '^it'\\''s (1)$'")
  expect(tailOf('a\n\n  \nb\nc\n', 2)).toBe('b\nc')
})

