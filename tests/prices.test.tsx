import { expect, test } from 'claude-code/testing'
import { priceKeyOf } from '../hooks/prices'

// a model name as a setting or a gateway gives it, and the prices it is charged at
for (const [model, key] of [
  ['haiku', 'haiku-5-5'],
  [' Sonnet ', 'sonnet-5-5'],
  ['claude-haiku-5-5', 'haiku-5-5'],
  ['us.anthropic.claude-haiku-5-5-20260101-v1:0', 'haiku-5-5'],
  ['claude-haiku-4-5-20251001', 'haiku-4-5'],
  ['claude-sonnet-5', 'sonnet-5'],
  ['claude-opus-5-5@20260301', 'opus-5-5'],
] as const) {
  test(`a model named ${JSON.stringify(model)} is priced as ${key}`, () => {
    expect(priceKeyOf(model)).toBe(key)
  })
}

test('a model with no listed price, or a version not listed, has none', () => {
  expect(priceKeyOf('my-gateway-model')).toBeNull()
  expect(priceKeyOf('claude-haiku-9-9')).toBeNull()
  expect(priceKeyOf('claude-3-5-haiku-20241022')).toBeNull()
})
