// What a grader call costs, at the Claude API's list prices (USD per million tokens, from
// platform.claude.com/docs/en/about-claude/pricing): pure, so the engine calls stay in register.tsx

type Price = { input: number; write: number; read: number; output: number }
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

// Haiku 5.5 is priced by the prompt's length: one of over 100,000 tokens pays the higher prices
const HAIKU_5_5: Price = { input: 0.1, write: 0.125, read: 0.01, output: 0.5 }
const HAIKU_5_5_LONG: Price = { input: 0.5, write: 0.625, read: 0.05, output: 2.5 }
export const LONG_PROMPT = 100_000

// by family and version; a family's alias (haiku, sonnet, opus) is its latest, as Claude Code maps it
const PRICES: Record<string, Price> = {
  'haiku-5-5': HAIKU_5_5,
  'haiku-4-5': { input: 1, write: 1.25, read: 0.1, output: 5 },
  'sonnet-5-5': { input: 2, write: 2.5, read: 0.1, output: 10 },
  'sonnet-5': { input: 2, write: 2.5, read: 0.2, output: 10 },
  'sonnet-4-6': { input: 3, write: 3.75, read: 0.3, output: 15 },
  'sonnet-4-5': { input: 3, write: 3.75, read: 0.3, output: 15 },
  'opus-5-5': { input: 4, write: 5, read: 0.2, output: 20 },
  'opus-5': { input: 5, write: 6.25, read: 0.5, output: 25 },
  'opus-4-8': { input: 5, write: 6.25, read: 0.5, output: 25 },
  'opus-4-7': { input: 5, write: 6.25, read: 0.5, output: 25 },
  'opus-4-6': { input: 5, write: 6.25, read: 0.5, output: 25 },
  'opus-4-5': { input: 5, write: 6.25, read: 0.5, output: 25 },
  'fable-5-1': { input: 10, write: 12.5, read: 0.25, output: 50 },
  'fable-5': { input: 10, write: 12.5, read: 1, output: 50 },
}
const ALIASES: Record<string, string> = { haiku: 'haiku-5-5', sonnet: 'sonnet-5-5', opus: 'opus-5-5', fable: 'fable-5-1' }

// the price key a model name comes to: an alias, or an id with a provider's prefix and a date or
// version after it (us.anthropic.claude-haiku-5-5-20260101-v1:0); null for a model not listed
export const priceKeyOf = (model: string): string | null => {
  const id = model.trim().toLowerCase()
  if (ALIASES[id]) return ALIASES[id]!
  const m = id.match(/claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d))?(?!\d)/)
  if (!m) return null
  const key = m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`
  return PRICES[key] ? key : null
}

// one call's cost in USD, or null when the model's price is not known
export const costOf = (model: string, usage: Usage): number | null => {
  const key = priceKeyOf(model)
  if (key === null) return null
  const input = usage.input_tokens ?? 0
  const write = usage.cache_creation_input_tokens ?? 0
  const read = usage.cache_read_input_tokens ?? 0
  const price = key === 'haiku-5-5' && input + write + read > LONG_PROMPT ? HAIKU_5_5_LONG : PRICES[key]!
  return (input * price.input + write * price.write + read * price.read + (usage.output_tokens ?? 0) * price.output) / 1e6
}
