/**
 * Value read-model cache tests.
 *
 * `benefitCache.ts` only imports types and AMP's cache component at runtime, so
 * Node's type stripping imports the TypeScript source directly, like the pure
 * benefit-model tests.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { benefitCacheKey, createBenefitCache } = await import('../src/host/benefitCache.ts')

const USAGE = {
  requests: 2,
  inputTokens: 10,
  cacheReadTokens: 5,
  cacheWriteTokens: 1,
  outputTokens: 7,
  totalInputTokens: 16,
  hitRate: 5 / 16,
}

function inputs(overrides = {}) {
  return {
    selection: { provider: 'deepseek', model: 'deepseek-flash' },
    compilations: 3,
    failures: 0,
    excluded: 1,
    lastItems: 2,
    tokensInjected: 120,
    lastCompileAt: '2026-11-18T00:00:00.000Z',
    compilerExclusions: 1,
    usage: USAGE,
    journalLength: 4,
    ...overrides,
  }
}

test('the value cache key is stable and changes with every counter', () => {
  const base = benefitCacheKey(inputs())
  assert.equal(benefitCacheKey(inputs()), base)
  const patches = [
    { selection: undefined },
    { compilations: 4 },
    { failures: 1 },
    { excluded: 2 },
    { lastItems: 3 },
    { tokensInjected: 121 },
    { lastCompileAt: '2026-11-18T00:00:01.000Z' },
    { compilerExclusions: 2 },
    { usage: { ...USAGE, requests: 3 } },
    { journalLength: 5 },
  ]
  for (const patch of patches) {
    assert.notEqual(benefitCacheKey(inputs(patch)), base, JSON.stringify(patch))
  }
})

test('the AMP LRU serves repeats, expires by TTL and evicts by capacity', () => {
  const cache = createBenefitCache(2, 30_000)
  const t0 = '2026-11-18T00:00:00.000Z'
  const fresh = '2026-11-18T00:00:10.000Z'
  const stale = '2026-11-18T00:00:31.000Z'

  cache.set('a', { n: 1 }, t0)
  assert.deepEqual(cache.get('a', fresh), { n: 1 })
  assert.equal(cache.get('a', stale), undefined)
  assert.ok(cache.stats().expirations >= 1)

  cache.set('a', { n: 1 }, t0)
  cache.set('b', { n: 2 }, t0)
  cache.set('c', { n: 3 }, t0)
  assert.equal(cache.stats().entries, 2)
  assert.ok(cache.stats().evictions >= 1)
  assert.equal(cache.get('a', fresh), undefined)
  assert.deepEqual(cache.get('c', fresh), { n: 3 })
})
