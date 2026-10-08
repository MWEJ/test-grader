// A test's layer: unit, integration or end-to-end, read from its file's path and text; pure,
// so the engine calls stay in register.tsx
import { ignoredBy } from './discovery'
import { goTagsOf } from './runner'

export type Layer = 'unit' | 'integration' | 'e2e'
export const LAYERS: readonly Layer[] = ['unit', 'integration', 'e2e']
export const LAYER_NAMES: Record<Layer, string> = { unit: 'unit', integration: 'integration', e2e: 'end-to-end' }

// a project's own rules, one a line, the first that matches a file's path winning:
//   integration: **/*.sqlite.test.ts
//   e2e: maestro/
export const LAYERS_FILE = '.test-grader-layers'
export type LayerRules = { layer: Layer; matches: (path: string) => boolean }[]
export const layerRulesOf = (text: string): LayerRules =>
  text.split('\n').flatMap(line => {
    const m = /^\s*(unit|integration|e2e|end-to-end)\s*:\s*(\S.*?)\s*$/.exec(line)
    return m ? [{ layer: (m[1] === 'end-to-end' ? 'e2e' : m[1]) as Layer, matches: ignoredBy(m[2]!) }] : []
  })

const E2E_PATH = /(^|\/)(e2e|end-to-end|acceptance|playwright|cypress)(\/|$)|[._-]e2e([._-]|$)|\.cy\.[cm]?[jt]sx?$/i
const INTEGRATION_PATH = /(^|\/)(integration|integration[-_]tests?|it)(\/|$)|[._-]integration([._-]|$)|\.int\.(test|spec)\.|IT\.(java|kt)$/i
// a browser or device driven from the test: Playwright, Cypress, Detox, WebdriverIO, Selenium
const E2E_TEXT = /\bfrom\s+['"](@playwright\/test|cypress|detox|webdriverio|selenium-webdriver)['"]|\brequire\(\s*['"](@playwright\/test|cypress|detox|webdriverio|selenium-webdriver)['"]\s*\)/
// a real database or service started for the test, or a marker that says so
const INTEGRATION_TEXT = /@pytest\.mark\.integration\b|\btestcontainers\b|@Tag\(\s*"integration"\s*\)|@SpringBootTest\b/

// rel: the file's path in the project; text: its source, when read
export const layerOf = (rel: string, text: string | null, rules: LayerRules = []): Layer => {
  const own = rules.find(r => r.matches(rel))
  if (own) return own.layer
  const tags = text !== null && rel.endsWith('.go') ? goTagsOf(text) : []
  if (E2E_PATH.test(rel) || tags.includes('e2e') || (text !== null && E2E_TEXT.test(text))) return 'e2e'
  if (INTEGRATION_PATH.test(rel) || tags.includes('integration') || (text !== null && INTEGRATION_TEXT.test(text))) return 'integration'
  return 'unit'
}
