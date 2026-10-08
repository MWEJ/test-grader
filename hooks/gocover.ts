// Go's coverage profile (go test -coverprofile) read: pure, so the engine calls stay in register.tsx
//
// Each line after the mode is one block: `<import path>/<file>.go:<from>,<to> <statements> <count>`.
// A block can appear more than once (a package tested by several test binaries): it counts once,
// covered when any run covered it. Go measures statements alone: no lines, branches or functions

// the module path go.mod declares, which every import path in the profile starts with
export const moduleOf = (goMod: string): string | null => goMod.match(/^module\s+(\S+)/m)?.[1]?.replace(/^"|"$/g, '') ?? null

export const goProfileOf = (profile: string, module: string | null, cwd: string): { statements: number | null; byFile: { file: string; total: number; covered: number }[] } => {
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
  const files = new Map<string, { total: number; covered: number }>()
  for (const b of blocks.values()) {
    const f = files.get(b.file) ?? { total: 0, covered: 0 }
    f.total += b.statements
    if (b.isCovered) f.covered += b.statements
    files.set(b.file, f)
  }
  const byFile = [...files].map(([path, f]) => ({ file: local(path), ...f }))
  const total = byFile.reduce((s, f) => s + f.total, 0)
  const covered = byFile.reduce((s, f) => s + f.covered, 0)
  return { statements: total > 0 ? (covered / total) * 100 : null, byFile }
}
