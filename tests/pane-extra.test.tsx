import { expect, mock, test } from 'claude-code/testing'
import { charCount } from '../hooks/tree'
import { mount, nodesOf, placedOf, project } from './helpers'

// Bug: a test name longer than a line with no spaces could overflow the pane or lose characters.
for (const [label, props] of [
  ['its body width ahead of the viewport', { bodyColumns: 24 }],
  ['the viewport when no body width was supplied', {}],
] as const) {
  test(`a pane using ${label} wraps an unbroken test name without losing it`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const name = 'x'.repeat(200)
    project(on, { 'a.test.ts': `it('${name}', () => { expect(f()).toBe(1) })\n` })
    await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
    await clock.advance(10)
    const ui = await $.ui.mount({ plugin: 'test-grader', surface: 'terminal', component: 'Pane', requestId: 'test-grader', props: { title: 'Test Grader', isFocused: false, placement: 'inline', ...props }, viewport: { columns: label.startsWith('its') ? 80 : 24, rows: 60 } } as never)
    const tree = await ui.drawn()
    const pieces = nodesOf(tree).filter(n => n.type === 'Button' && String(n.props?.key).startsWith(`r:/proj/a.test.ts:${name}`)).map(n => String(n.props?.label))
    expect(pieces.join('')).toBe(name)
    const titles = placedOf(tree).filter(p => p.key?.startsWith(`r:/proj/a.test.ts:${name}`))
    expect(Math.max(...titles.map(p => p.x + p.text.length))).toBeLessThanOrEqual(24)
  })
}

// Bug: pressing an open row again could append another key instead of closing its details.
test('pressing an open test title again closes its grading details', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  project(on, { 'a.test.ts': "it('adds', () => { expect(add(1, 2)).toBe(3) })\n" })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: 'r:/proj/a.test.ts:adds' })
  expect((await ui.findAll({ type: 'Text' })).map(n => n.text)).toContain('strong because.')
  await ui.press({ key: 'r:/proj/a.test.ts:adds' })
  expect((await ui.findAll({ type: 'Text' })).map(n => n.text)).not.toContain('strong because.')
  expect((await ui.findAll({ type: 'Button' })).map(n => n.props?.label)).toContain('adds')
})

// Bug: applying only the node budget could blank the end of a pane with long test names.
test('long test names reaching the text budget leave out rows and account for every omitted row', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const names = Array.from({ length: 500 }, (_, i) => `case ${i} ${'long name '.repeat(24)}`.trim())
  project(on, { 'a.test.ts': names.map(name => `it('${name}', () => { expect(f()).toBe(1) })`).join('\n') })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  await clock.advance(10)
  const ui = await mount($)
  const tree = await ui.drawn()
  const shown = nodesOf(tree).filter(n => n.type === 'Button' && String(n.props?.key).startsWith('r:/proj/a.test.ts:') && !/#\d+$/.test(String(n.props?.key))).length
  const cut = (await ui.findAll({ type: 'Text' })).map(n => n.text).find(t => t.includes('more rows not drawn'))
  expect(cut).toMatch(/^\d+ more rows not drawn: too many folders and files are open at once\. Close one to see the rest\.$/)
  expect(shown + Number(cut!.split(' ')[0])).toBe(names.length)
  expect(shown).toBeGreaterThan(0)
  expect(charCount(tree)).toBeLessThanOrEqual(100_000)
})
