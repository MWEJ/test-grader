import { expect, mock, test } from 'claude-code/testing'
import { askGrades, FOLLOW, ok, project, TURN, turns } from './helpers'

const first = "it('a shallow check', () => { expect(f).toBeDefined() })\n"

// Bug: two edits before a held note is sent could spend two rounds for one reported concern.
test('a held flagged grade updated by another edit is reported once at its latest grade', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {}
  const { notes } = project(on, files, { rule: (_name, prompt) => prompt.includes('toBeTruthy') ? 'brittle' : 'shallow' })
  turns(on)
  let active = true
  on('agent.list', async () => ({ value: active ? [{ id: 'a1', description: 'fix tests', type: 'general-purpose', status: 'running' }] : [] }) as never)
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  files['a.test.ts'] = first
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.test.ts', content: first } as never)
  await clock.advance(10)
  files['a.test.ts'] = first.replace('toBeDefined', 'toBeTruthy')
  await $.tool.call({ tool: 'Edit', file_path: '/proj/a.test.ts', old_string: 'toBeDefined', new_string: 'toBeTruthy' } as never)
  await clock.advance(10)
  expect(await askGrades($)).toContain('"a shallow check": brittle (round 1 of 3)')
  active = false
  await $.turn.complete(TURN)
  expect(notes).toEqual(['Tests that need work (test-grader):\n- brittle · a.test.ts · a shallow check — brittle because.\n  Before: shallow — shallow because. It would miss: a wrong edge.\n' + FOLLOW])
})

// Bug: a test fixed while its first flagged note is held could send Claude a stale fix request.
test('a held first-round flag that becomes strong sends no stale fix request', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {}
  const { notes } = project(on, files, { rule: (_name, prompt) => prompt.includes('toBe(42)') ? 'strong' : 'shallow' })
  turns(on)
  let active = true
  on('agent.list', async () => ({ value: active ? [{ id: 'a1', description: 'fix tests', type: 'general-purpose', status: 'running' }] : [] }) as never)
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  files['a.test.ts'] = first
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.test.ts', content: first } as never)
  await clock.advance(10)
  files['a.test.ts'] = first.replace('toBeDefined()', 'toBe(42)')
  await $.tool.call({ tool: 'Edit', file_path: '/proj/a.test.ts', old_string: 'toBeDefined()', new_string: 'toBe(42)' } as never)
  await clock.advance(10)
  active = false
  await $.turn.complete(TURN)
  expect(await askGrades($, { verdicts: ['strong'] })).toContain('"a shallow check": strong')
  expect(notes).toEqual([])
})

// Bug: changing a held flag to strong could lose an acceptance earned after an earlier round.
test('a held later-round flag that becomes strong reports acceptance', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = {}
  const { notes } = project(on, files, { rule: (_name, prompt) => prompt.includes('toBe(42)') ? 'strong' : 'shallow' })
  turns(on)
  let active = false
  on('agent.list', async () => ({ value: active ? [{ id: 'a1', description: 'fix tests', type: 'general-purpose', status: 'running' }] : [] }) as never)
  on('tool.call', async () => ok as never)
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  files['a.test.ts'] = first
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.test.ts', content: first } as never)
  await clock.advance(10)
  active = true
  files['a.test.ts'] = first.replace('toBeDefined()', 'toBeTruthy()')
  await $.tool.call({ tool: 'Edit', file_path: '/proj/a.test.ts', old_string: 'toBeDefined()', new_string: 'toBeTruthy()' } as never)
  await clock.advance(10)
  files['a.test.ts'] = first.replace('toBeDefined()', 'toBe(42)')
  await $.tool.call({ tool: 'Edit', file_path: '/proj/a.test.ts', old_string: 'toBeTruthy()', new_string: 'toBe(42)' } as never)
  await clock.advance(10)
  active = false
  await $.turn.complete(TURN)
  expect(notes.at(-1)).toBe('Now graded strong (test-grader):\n- strong · a.test.ts · a shallow check')
  expect(notes).toHaveLength(2)
})
