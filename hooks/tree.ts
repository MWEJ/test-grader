// A drawing as the engine takes it: it refuses a whole tree with a text holding a control
// character, a lone surrogate or its placeholder character, or with more than 20,000 nodes,
// and draws its own placeholder instead, so the pane shows nothing at all; past 100,000
// characters of text it draws the rest blank

// the engine's limits, less room for the counts above the tests and the coverage below them
export const NODE_BUDGET = 16_000
export const CHAR_BUDGET = 80_000

type Element = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
const REFUSED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u{10eeee}]/gu
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

// a text the engine draws: a run's colours dropped, other control characters and broken
// surrogate halves (a name cut inside an emoji) replaced
export const printable = (s: string): string => s.replace(ANSI, '').replace(REFUSED, '').replace(LONE, '\uFFFD')

// the tree with every text and string prop printable; the same object where nothing changed
export const drawable = <T>(tree: T): T => {
  if (typeof tree === 'string') return printable(tree) as T
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return tree
  const el = tree as Element
  const props = el.props && Object.fromEntries(Object.entries(el.props).map(([k, v]) => [k, typeof v === 'string' ? printable(v) : v]))
  const children = el.children?.map(c => drawable(c))
  const isSame = (!el.props || Object.entries(el.props).every(([k, v]) => props![k] === v)) && (!el.children || el.children.every((c, i) => children![i] === c))
  return isSame ? tree : ({ ...el, ...(props ? { props } : {}), ...(children ? { children } : {}) } as T)
}

// the nodes the engine counts in a tree: every element and every text
export const nodeCount = (tree: unknown): number => {
  if (typeof tree === 'string') return 1
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return 0
  return 1 + ((tree as Element).children ?? []).reduce((n: number, c) => n + nodeCount(c), 0)
}

// the characters a tree's texts and string props hold, as the engine spends its budget on them
export const charCount = (tree: unknown): number => {
  if (typeof tree === 'string') return tree.length
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return 0
  const el = tree as Element
  const props = Object.values(el.props ?? {}).reduce((n: number, v) => n + (typeof v === 'string' ? v.length : 0), 0)
  return props + (el.children ?? []).reduce((n: number, c) => n + charCount(c), 0)
}
