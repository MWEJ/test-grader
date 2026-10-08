// The grades a test can get, each naming what is wrong with it and so what to do: pure, so the
// engine calls stay in register.tsx
import type { Verdict } from '../types'

// the grades that ask for work, worst first: as the grader picks among them when more than one
// fits, and as lists and notes order them
export const FLAGGED = ['hollow', 'duplicate', 'shallow', 'brittle'] as const satisfies readonly Verdict[]
export const VERDICTS: readonly Verdict[] = [...FLAGGED, 'strong']

export const isFlagged = (v: Verdict | undefined): boolean => v !== undefined && v !== 'strong'

// what each grade asks of whoever fixes the test
export const FIX: Record<Verdict, string> = {
  hollow: 'rewrite it to assert on what the code does',
  duplicate: 'delete it, or merge it into the test it repeats',
  shallow: 'add the case it misses: an edge, an error, a boundary',
  brittle: 'assert on behaviour, not on how the code does it',
  strong: 'keep it',
}

// a grade as the grader or an older store gave it: the three grades before these (good, weak,
// useless) read as the nearest of these
const OLD: Record<string, Verdict> = { good: 'strong', weak: 'shallow', useless: 'hollow' }
export const verdictOf = (v: unknown): Verdict | undefined =>
  typeof v !== 'string' ? undefined : (VERDICTS as readonly string[]).includes(v) ? (v as Verdict) : OLD[v]
