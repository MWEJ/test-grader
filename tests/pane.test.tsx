import { expect, mock, test } from 'claude-code/testing'

const FILE = '/proj/src/math.test.ts'
const CONTENT = `
it('adds numbers', () => { expect(add(1, 2)).toBe(3) })
it('does nothing', () => { expect(true).toBe(true) })
`

for (const surface of ['desktop', 'terminal'] as const) {
  test(`pane tracks and rates new tests on ${surface}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    on('command.register', async () => ({ value: {} }) as never)
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('session.start', async () => ({ cwd: '/proj' }) as never)
    on('session.cwd', async () => ({ value: '/proj' }) as never)
    on('fs.stat', async () => {
      throw new Error('missing')
    })
    on('fs.read', async () => ({ value: CONTENT }) as never)
    on('model.complete', async () => ({
      value: {
        isAnswered: true,
        usage: {},
        text: JSON.stringify([
          { name: 'adds numbers', summary: 'Checks add(1,2) is 3.', verdict: 'good', reason: 'Asserts a real result.' },
          { name: 'does nothing', summary: 'Asserts true is true.', verdict: 'useless', reason: 'Tautology.' },
        ]),
      },
    }) as never)
    on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
    await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)

    await $.tool.call({ tool: 'Write', file_path: FILE, content: CONTENT } as never)
    await clock.advance(10)

    const ui = await $.ui.mount({
      plugin: 'test-watch',
      surface,
      component: 'Pane',
      requestId: 'test-watch',
      props: { title: 'Tests', isFocused: false, bodyColumns: 60, placement: 'inline' } as never,
    })
    const tree = JSON.stringify(await ui.drawn())
    expect(tree).toContain('2 new tests')
    expect(tree).toContain('adds numbers')
    expect(tree).toContain('Tautology.')
    expect(tree).toContain('1 useless')
    expect(tree).toContain('no report found')
  })
}

test('a non-test file is ignored', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', async () => ({ result: {}, text: 'ok', isError: false, isReadOnly: false }) as never)
  on('session.cwd', async () => ({ value: '/proj' }) as never)
  on('fs.stat', async () => {
    throw new Error('missing')
  })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/math.ts', content: "it('x', () => {})" } as never)
  const ui = await $.ui.mount({
    plugin: 'test-watch',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'test-watch',
    props: { title: 'Tests', isFocused: false, bodyColumns: 60, placement: 'inline' } as never,
  })
  expect(JSON.stringify(await ui.drawn())).toContain('0 new tests')
})
