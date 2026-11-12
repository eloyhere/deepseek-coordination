import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_REGISTRY, MODEL_REGISTRY_MODELS, MODEL_REGISTRY_PROVIDERS } from '../src/host/modelRegistry.ts'
import { OPENROUTER_REGISTRY, OPENROUTER_REGISTRY_MODELS } from '../src/host/openRouterRegistry.ts'

function find(provider, model) {
  return MODEL_REGISTRY.find((row) => row[0] === provider && row[1] === model)
}

test('pi-ai registry covers 41 providers and 1,614 chat models', () => {
  assert.equal(MODEL_REGISTRY_PROVIDERS, 41)
  assert.equal(MODEL_REGISTRY_MODELS, 1614)
  assert.equal(MODEL_REGISTRY.length, 1614)
  assert.equal(new Set(MODEL_REGISTRY.map((row) => row[0])).size, 41)
})

test('OpenRouter adds 467 current models including non-US vendors', () => {
  assert.equal(OPENROUTER_REGISTRY_MODELS, 467)
  assert.equal(OPENROUTER_REGISTRY.length, 467)
  const baidu = OPENROUTER_REGISTRY.find((row) => row[0].startsWith('baidu/'))
  assert.ok(baidu !== undefined)
  assert.ok(OPENROUTER_REGISTRY.some((row) => row[0].startsWith('tencent/')) || OPENROUTER_REGISTRY.some((row) => row[0].startsWith('meta/')))
})

test('registry rates are per million tokens and preserve cache tiers', () => {
  const gpt = find('openai', 'gpt-4.1')
  assert.ok(gpt !== undefined)
  assert.equal(gpt[3], 2)
  assert.equal(gpt[4], 8)
  assert.equal(gpt[5], 0.5)

  const haiku = find('anthropic', 'claude-haiku-4-5')
  assert.ok(haiku !== undefined)
  assert.equal(haiku[3], 1)
  assert.equal(haiku[4], 5)
  assert.equal(haiku[5], 0.1)

  const gemini = find('google', 'deep-research-max-preview-04-2026')
  assert.ok(gemini !== undefined)
  assert.ok(gemini[11].includes('200000'))
})
