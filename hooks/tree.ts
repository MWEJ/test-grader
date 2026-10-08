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

// What the engine would refuse in a tree, as far as test-grader knows its rules, said with where
// it is; undefined for a tree it takes
const MAX_NODES = 20_000
const MAX_DEPTH = 32
const HAS_REFUSED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u{10eeee}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u
export const problemOf = (tree: unknown): string | undefined => {
  let nodes = 0
  const walk = (n: unknown, depth: number, at: string): string | undefined => {
    if ((nodes += 1) > MAX_NODES) return `more than ${MAX_NODES} elements`
    if (depth > MAX_DEPTH) return `nested deeper than ${MAX_DEPTH} at ${at}`
    if (typeof n === 'string') return HAS_REFUSED.test(n) ? `a text holds a control character at ${at}: ${JSON.stringify(n.slice(0, 80))}` : undefined
    if (!n || typeof n !== 'object' || Array.isArray(n)) return `a child is ${Array.isArray(n) ? 'an array' : String(n)} at ${at}`
    const el = n as Element
    const here = `${at} > ${String(el.type)}${typeof el.props?.key === 'string' ? ` "${el.props.key.slice(0, 80)}"` : ''}`
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (!(typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) return `prop ${k} is ${v === null ? 'null' : typeof v === 'number' ? String(v) : typeof v} at ${here}`
      if (typeof v === 'string' && HAS_REFUSED.test(v)) return `prop ${k} holds a control character at ${here}`
    }
    if (el.type === 'Button' && (typeof el.props?.key !== 'string' || el.props.key === '' || typeof el.props?.label !== 'string')) return `a Button without a key and a label at ${here}`
    for (const c of el.children ?? []) {
      const problem = walk(c, depth + 1, here)
      if (problem) return problem
    }
    return undefined
  }
  return walk(tree, 0, 'pane')
}
