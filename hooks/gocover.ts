// Go's coverage profile (go test -coverprofile) read: pure, so the engine calls stay in register.tsx
//
// Each line after the mode is one block: `<import path>/<file>.go:<from>,<to> <statements> <count>`.
// A block can appear more than once (a package tested by several test binaries): it counts once,
// covered when any run covered it. Go measures statements alone: no lines, branches or functions

// the module path go.mod declares, which every import path in the profile starts with
export const moduleOf = (goMod: string): string | null => goMod.match(/^module\s+(\S+)/m)?.[1]?.replace(/^"|"$/g, '') ?? null

type Tally = { total: number; covered: number }

export const goProfileOf = (profile: string, module: string | null, cwd: string): { statements: number | null; byFile: ({ file: string } & Tally)[]; byPackage: ({ name: string } & Tally)[] } => {
  const blocks = new Map<string, { file: string; statements: number; isCovered: boolean }>()
  for (const line of profile.split('\n')) {
    const m = line.trim().match(/^(.+\.go):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/)
    if (!m) continue
    const [, path, span, statements, count] = m
    const key = `${path}:${span}`
    const was = blocks.get(key)
    blocks.set(key, { file: path!, statements: Number(statements), isCovered: (was?.isCovered ?? false) || Number(count) > 0 })
  }
  // an import path inside the module is a file in the project; one outside it keeps its path
  const local = (path: string): string => (module && path.startsWith(`${module}/`) ? `${cwd}/${path.slice(module.length + 1)}` : path)
  const files = new Map<string, Tally>()
  for (const b of blocks.values()) {
    const f = files.get(b.file) ?? { total: 0, covered: 0 }
    f.total += b.statements
    if (b.isCovered) f.covered += b.statements
    files.set(b.file, f)
  }
  const byFile = [...files].map(([path, f]) => ({ file: local(path), ...f }))
  const total = byFile.reduce((s, f) => s + f.total, 0)
  const covered = byFile.reduce((s, f) => s + f.covered, 0)
  // a package is its files' folder: by its path in the project ('./' the module's root), one
  // outside the module by its import path
  const packages = new Map<string, Tally>()
  for (const f of byFile) {
    const dir = f.file.slice(0, f.file.lastIndexOf('/'))
    const name = dir === cwd ? './' : `${dir.startsWith(`${cwd}/`) ? dir.slice(cwd.length + 1) : dir}/`
    const p = packages.get(name) ?? { total: 0, covered: 0 }
    p.total += f.total
    p.covered += f.covered
    packages.set(name, p)
  }
  const byPackage = [...packages].filter(([, p]) => p.total > 0).map(([name, p]) => ({ name, ...p }))
  return { statements: total > 0 ? (covered / total) * 100 : null, byFile, byPackage }
}

// A folder's run (go test ./<folder>/...) merged into the module's last profile: the blocks of
// the folder's files, and of every folder under it, are the new run's; the rest are kept
export const mergeProfile = (whole: string, part: string, module: string | null, rel: string): string => {
  const isInFolder = (line: string): boolean => module !== null && (line.match(/^(.+\.go):/)?.[1] ?? '').startsWith(`${module}/${rel}/`)
  const blocks = (profile: string): string[] => profile.split('\n').filter(l => l.trim() !== '' && !l.startsWith('mode:'))
  const mode = part.match(/^mode: .+$/m)?.[0] ?? whole.match(/^mode: .+$/m)?.[0] ?? 'mode: set'
  return [mode, ...blocks(whole).filter(l => !isInFolder(l)), ...blocks(part), ''].join('\n')
}
