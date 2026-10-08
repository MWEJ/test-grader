// The settings: what a value the person set comes to

// the model that grades when the person sets none: the alias, which Claude Code resolves to
// the Haiku its account or gateway is set up with
export const DEFAULT_MODEL = 'haiku'

// A model setting as the grader uses it: an alias (haiku, sonnet, opus) or a model id, as
// given, so a gateway's own ids reach it unchanged; blank or not text, the fallback
export const modelOf = (chosen: unknown, fallback: string): string => {
  const model = typeof chosen === 'string' ? chosen.trim() : ''
  return model === '' ? fallback : model
}

// how many grader calls Grade all runs at once: 1 to MAX_WORKERS, 10 when unset
export const MAX_WORKERS = 20
export const workersOf = (chosen: unknown): number =>
  typeof chosen === 'number' && Number.isFinite(chosen) ? Math.min(MAX_WORKERS, Math.max(1, Math.floor(chosen))) : 10
