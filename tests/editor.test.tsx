import { expect, mock, test } from 'claude-code/testing'
import { mount, project, E_TEST, E_FILE, openShallow, macDefault, linux, windows } from './helpers'

test('on macOS the default app is asked by the file, and a VS Code fork opens at the line through its own bundled command', async ($, on) => {
  const app = '/Applications/Antigravity IDE.app'
  const { runs } = await openShallow($, on, {
    editor: macDefault({ app, id: 'com.google.antigravity-ide', exe: `${app}/Contents/MacOS/Electron` }),
    outside: { [`${app}/Contents/Resources/app/product.json`]: '{"applicationName": "antigravity-ide"}' },
  })

  expect(runs[0]![0]).toBe('osascript')
  expect(runs[0]!.at(-1)).toBe(E_FILE)
  expect(runs.slice(1)).toEqual([[`${app}/Contents/Resources/app/bin/antigravity-ide`, '--goto', `${E_FILE}:5`]])
})


test('on macOS Zed, Sublime Text and a JetBrains IDE each open at the line their own way', async ($, on) => {
  let current: { app: string; id: string; exe: string } = { app: '/Applications/Zed.app', id: 'dev.zed.Zed', exe: '/Applications/Zed.app/Contents/MacOS/zed' }
  const clock = mock.clock(on, { now: 1_000_000 })
  const { runs } = project(on, { 'src/e.test.ts': E_TEST }, { editor: argv => macDefault(current)(argv) })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)
  await ui.press({ key: `r:${E_FILE}:a shallow check` })
  const opened: string[][] = []
  for (const app of [
    current,
    { app: '/Applications/Sublime Text.app', id: 'com.sublimetext.4', exe: '/Applications/Sublime Text.app/Contents/MacOS/sublime_text' },
    { app: '/Applications/WebStorm.app', id: 'com.jetbrains.WebStorm', exe: '/Applications/WebStorm.app/Contents/MacOS/webstorm' },
  ]) {
    current = app
    await ui.press({ key: `o:${E_FILE}:a shallow check` })
    await clock.advance(10)
    opened.push(runs.at(-1)!)
  }

  expect(opened).toEqual([
    ['/Applications/Zed.app/Contents/MacOS/cli', `${E_FILE}:5`],
    ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl', `${E_FILE}:5`],
    ['/Applications/WebStorm.app/Contents/MacOS/webstorm', '--line', '5', E_FILE],
  ])
})


test('on macOS an app with no way to go to a line opens the file itself, and so does a line command that fails', async ($, on) => {
  const app = '/Applications/Cursor.app'
  const { runs } = await openShallow($, on, {
    editor: argv => (argv[0] === 'osascript' ? { stdout: JSON.stringify({ app, id: 'com.todesktop.cursor', exe: `${app}/Contents/MacOS/Cursor` }) } : argv.includes('--goto') ? 1 : 0),
    outside: { [`${app}/Contents/Resources/app/product.json`]: '{"applicationName": "cursor"}' },
  })

  expect(runs.slice(1)).toEqual([
    [`${app}/Contents/Resources/app/bin/cursor`, '--goto', `${E_FILE}:5`],
    ['open', '-a', app, E_FILE],
  ])
})


test('on macOS with no app for the file, it opens as the system would', async ($, on) => {
  const { runs, ui } = await openShallow($, on, { editor: macDefault(null) })

  expect(runs.slice(1)).toEqual([['open', E_FILE]])
  expect(JSON.stringify(await ui.drawn())).not.toContain("Couldn't open")
})


test('an EDITOR naming a GUI editor wins over the default app', async ($, on) => {
  const { runs } = await openShallow($, on, { env: { EDITOR: 'cursor --wait' }, editor: () => 0 })
  expect(runs).toEqual([['cursor', '--goto', `${E_FILE}:5`]])
})


test('a terminal EDITOR is passed over for the default app', async ($, on) => {
  const { runs } = await openShallow($, on, { env: { VISUAL: 'nvim', EDITOR: 'vim' }, editor: macDefault(null) })
  expect(runs.map(argv => argv[0])).toEqual(['osascript', 'open'])
})


test('on Linux the default app comes from xdg-mime and its .desktop file, the user\'s own first', async ($, on) => {
  const { runs } = await openShallow($, on, {
    env: { HOME: '/home/m' },
    editor: linux('code.desktop'),
    outside: {
      '/home/m/.local/share/applications/code.desktop': '[Desktop Entry]\nName=Visual Studio Code\nExec=/usr/share/code/code --unity-launch %F\nIcon=code\n',
      '/usr/share/applications/code.desktop': '[Desktop Entry]\nExec=/usr/bin/other %F\n',
    },
  })

  expect(runs.at(-1)).toEqual(['/usr/share/code/code', '--goto', `${E_FILE}:5`])
})


test('on Linux with no app for the file, xdg-open opens it', async ($, on) => {
  const { runs } = await openShallow($, on, { env: { HOME: '/home/m' }, editor: linux(null) })
  expect(runs.at(-1)).toEqual(['xdg-open', E_FILE])
})


test('on Windows the default app comes from the registry, and VS Code opens at the line through its code.cmd', async ($, on) => {
  const dir = 'C:\\Users\\m\\AppData\\Local\\Programs\\Microsoft VS Code'
  const { runs } = await openShallow($, on, {
    env: { OS: 'Windows_NT' },
    editor: windows(`"${dir}\\Code.exe" "%1"`),
    outside: { [`${dir}\\resources\\app\\product.json`]: '{"applicationName": "code"}' },
  })

  expect(runs.some(argv => argv[0] === 'osascript')).toBe(false)
  expect(runs.at(-1)).toEqual(['cmd', '/c', `${dir}\\bin\\code.cmd`, '--goto', `${E_FILE}:5`])
})


test('on Windows with no app for the file, start opens it', async ($, on) => {
  const { runs } = await openShallow($, on, { env: { OS: 'Windows_NT' }, editor: windows(null) })
  expect(runs.at(-1)).toEqual(['cmd', '/c', 'start', '', E_FILE])
})


test('a looped test opens at its loop\'s line', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const content = "const SIZES = ['tiny']\nfor (const name of SIZES) {\n  it(`rounds ${name}`, () => { expect(round(name)).toBeDefined() })\n}\n"
  const { runs } = project(on, { 'src/l.test.ts': content }, { expand: { 'rounds ${name}': ['rounds tiny'] }, env: { EDITOR: 'code' }, editor: () => 0 })
  await $.session.start({ source: 'startup', cwd: '/proj', surface: null, isInteractive: true } as never)
  const ui = await mount($)
  await ui.press({ key: 'gradeAll' })
  await clock.advance(10)

  await ui.press({ key: 'r:/proj/src/l.test.ts:rounds tiny' })
  await ui.press({ key: 'o:/proj/src/l.test.ts:rounds tiny' })
  await clock.advance(10)

  expect(runs).toEqual([['code', '--goto', '/proj/src/l.test.ts:3']])
})


test('when nothing opens the file, the pane says so', async ($, on) => {
  const { ui } = await openShallow($, on, { editor: () => 1 })
  expect(JSON.stringify(await ui.drawn())).toContain("Couldn't open src/e.test.ts in an editor: no such command")
})



// an EDITOR naming an editor that goes to a line, and the command that opens the test with it
const NAMED: [string, string[]][] = [
  ['zed', ['zed', `${E_FILE}:5`]],
  ['subl -w', ['subl', `${E_FILE}:5`]],
  ['/opt/idea/bin/idea64.sh', ['/opt/idea/bin/idea64.sh', '--line', '5', E_FILE]],
]

for (const [editor, opened] of NAMED) {
  test(`an EDITOR of ${editor} opens the test at its line with ${opened[0]}`, async ($, on) => {
    const { runs } = await openShallow($, on, { env: { EDITOR: editor }, editor: () => 0 })
    expect(runs).toEqual([opened])
  })
}


test('on Windows an EDITOR that fails falls back to start, with no registry asked', async ($, on) => {
  const { runs } = await openShallow($, on, { env: { OS: 'Windows_NT', EDITOR: 'code' }, editor: argv => (argv[0] === 'code' ? 1 : 0) })
  expect(runs).toEqual([
    ['code', '--goto', `${E_FILE}:5`],
    ['cmd', '/c', 'start', '', E_FILE],
  ])
})


test('on Windows with no choice of the user\'s for the extension, its class\'s open command is the default app', async ($, on) => {
  const exe = 'C:\\Program Files\\Sublime Text\\sublime_text.exe'
  const { runs } = await openShallow($, on, {
    env: { OS: 'Windows_NT' },
    editor: argv => {
      const asked = argv.join(' ')
      if (asked.endsWith('\\.ts\\UserChoice /v ProgId')) return 1
      if (asked === 'reg query HKCR\\.ts /ve') return { stdout: '\r\nHKEY_CLASSES_ROOT\\.ts\r\n    (Default)    REG_SZ    TypeScriptFile\r\n\r\n' }
      if (asked === 'reg query HKCR\\TypeScriptFile\\shell\\open\\command /ve') return { stdout: `\r\nHKEY_CLASSES_ROOT\\TypeScriptFile\\shell\\open\\command\r\n    (Default)    REG_EXPAND_SZ    "${exe}" "%1"\r\n\r\n` }
      return 0
    },
  })
  expect(runs.at(-1)).toEqual([exe, `${E_FILE}:5`])
})


test('on Linux a VS Code fork in its own folder opens at the line through the command its product.json names', async ($, on) => {
  const { runs } = await openShallow($, on, {
    env: { HOME: '/home/m' },
    editor: linux('codium.desktop'),
    outside: {
      '/usr/share/applications/codium.desktop': '[Desktop Entry]\nExec=/opt/vscodium/codium --no-sandbox %F\n',
      '/opt/vscodium/resources/app/product.json': '{"applicationName": "codium"}',
    },
  })
  expect(runs.at(-1)).toEqual(['/opt/vscodium/bin/codium', '--goto', `${E_FILE}:5`])
})


test('on Linux XDG_DATA_HOME is read ahead of ~/.local/share, and an Exec run through env opens its program', async ($, on) => {
  const { runs } = await openShallow($, on, {
    env: { HOME: '/home/m', XDG_DATA_HOME: '/data/m' },
    editor: linux('zed.desktop'),
    outside: {
      '/data/m/applications/zed.desktop': '[Desktop Entry]\nExec=env BAMF_DESKTOP_FILE_HINT=/x GDK_BACKEND=x11 /usr/bin/zeditor %U\n',
      '/home/m/.local/share/applications/zed.desktop': '[Desktop Entry]\nExec=/usr/bin/subl %F\n',
    },
  })
  expect(runs.at(-1)).toEqual(['/usr/bin/zeditor', `${E_FILE}:5`])
})


test('on Linux with no HOME the system\'s applications folder names the default app', async ($, on) => {
  const { runs } = await openShallow($, on, {
    editor: linux('subl.desktop'),
    outside: { '/usr/share/applications/subl.desktop': '[Desktop Entry]\nExec=subl %F\n' },
  })
  expect(runs.at(-1)).toEqual(['subl', `${E_FILE}:5`])
})


test('when nothing opens the file and none says why, the pane gives the last exit code', async ($, on) => {
  const { ui } = await openShallow($, on, { editor: argv => (argv[0] === 'osascript' ? { stdout: '' } : { exitCode: 2 }) })
  expect(JSON.stringify(await ui.drawn())).toContain("Couldn't open src/e.test.ts in an editor: exit 2")
})


test('when no command can be started, the pane says which file it could not open, and why', async ($, on) => {
  const { ui } = await openShallow($, on, {
    editor: () => {
      throw new Error('spawn ENOENT')
    },
  })
  // the reason is the host's own, its words not the mod's: the pane names the file and gives one
  const said = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.startsWith("Couldn't open src/e.test.ts in an editor: "))
  expect(said).toHaveLength(1)
  expect(said[0]!.length).toBeGreaterThan("Couldn't open src/e.test.ts in an editor: ".length)
})
