// The settings: what a value the person set comes to

// the oldest Haiku that grades: a setting naming an older one grades with this one instead
export const MIN_HAIKU = 'claude-haiku-5-5'

// A model setting as the grader uses it: an alias (haiku, sonnet, opus) or a model id as
// given, but a Haiku older than MIN_HAIKU (claude-haiku-4-5, claude-3-5-haiku-20241022) is
// MIN_HAIKU; blank or not text, the fallback
export const modelOf = (chosen: unknown, fallback: string): string => {
  const model = typeof chosen === 'string' ? chosen.trim() : ''
  if (model === '') return fallback
  const id = model.toLowerCase()
  // a provider's prefix (us.anthropic.) and suffixes (a date, a version) aside
  const version =
    id.match(/(?:^|[./])claude-haiku-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:-v\d+(?::\d+)?|@\d+)?$/) ??
    id.match(/(?:^|[./])claude-(\d+)(?:-(\d{1,2}))?-haiku(?:-\d{8})?(?:-v\d+(?::\d+)?|@\d+)?$/)
  if (!version) return model
  const [major, minor] = [Number(version[1]), Number(version[2] ?? 0)]
  return major < 5 || (major === 5 && minor < 5) ? MIN_HAIKU : model
}

// how many grader calls Grade all runs at once: 1 to MAX_WORKERS, 10 when unset
export const MAX_WORKERS = 20
export const workersOf = (chosen: unknown): number =>
  typeof chosen === 'number' && Number.isFinite(chosen) ? Math.min(MAX_WORKERS, Math.max(1, Math.floor(chosen))) : 10
