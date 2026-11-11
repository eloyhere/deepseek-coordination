/**
 * AMP `ContextCache` wiring.
 *
 * The kernel override must compile through AMP and reuse an identical payload,
 * and must never serve a stale one after a summary or version change. These
 * tests exercise the real AMP compiler and the real AMP cache class — no fake
 * selection layer — so a future AMP upgrade that changes the contract fails
 * here instead of silently disabling reuse.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAttention, mount } from 'attention-manifest-protocol/attention'
import { AmpContextCache } from '../src/host/contextCache.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const SCOPE = {
  tenantId: 'tenant-1',
  principalId: 'session-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
}

/** One mounted attention object, exactly as the kernel would hand it to AMP. */
function item(id, summary) {
  const created = createAttention({
    id,
    scope: { ...SCOPE },
    pointer: { kind: 'turn', id: `pointer-${id}`, version: '1' },
    summary,
    budget: { tokens: 512 },
    expiresAt: '2026-01-01T01:00:00.000Z',
    reason: 'cache fixture',
  }, NOW)
  return mount(created, { expectedVersion: created.version, now: NOW, reason: 'cache fixture' })
}

function options(overrides = {}) {
  return {
    now: NOW,
    scope: { ...SCOPE },
    budget: { tokens: 1000 },
    currentVersion: (pointer) => pointer.version,
    countTokens: (text) => Math.ceil(text.length / 4),
    ...overrides,
  }
}

const POLICY = { maxEntries: 8, maxTokens: 10_000, ttlMilliseconds: 60_000 }

test('an identical batch is compiled once and then served from AMP ContextCache', () => {
  const cache = new AmpContextCache(POLICY, { now: () => NOW })
  const objects = [item('attention:a', 'alpha'), item('attention:b', 'beta')]

  const first = cache.compile(objects, options())
  const second = cache.compile(objects, options())

  assert.equal(first.items.length, 2)
  assert.equal(second, first, 'a hit returns the payload AMP compiled earlier')
  const stats = cache.stats()
  assert.equal(stats.misses, 1)
  assert.equal(stats.hits, 1)
  assert.equal(stats.hitRate, 0.5)
  assert.ok(stats.savedTokens > 0, 'a hit records the tokens that were not rebuilt')
  assert.equal(stats.failures, 0)
})

test('a changed version misses instead of serving a stale payload', () => {
  const cache = new AmpContextCache(POLICY, { now: () => NOW })
  const base = item('attention:a', 'alpha')

  cache.compile([base], options())
  // Host invariant: a summary change bumps the version; AMP's signature covers it.
  const bumped = mount(base, { expectedVersion: base.version, now: NOW, reason: 'bump' })
  cache.compile([{ ...bumped, summary: 'alpha changed' }], options())

  const stats = cache.stats()
  assert.equal(stats.hits, 0)
  assert.equal(stats.misses, 2)
})

test('the kernel port exposes attentionPriority and compileContext from AMP', () => {
  const cache = new AmpContextCache(POLICY, { now: () => NOW })
  const port = cache.port()

  assert.equal(typeof port.attentionPriority, 'function')
  // intensity 0.5 from `createAttention` + four zero scores.
  assert.equal(port.attentionPriority(item('attention:a', 'alpha')), 0.5)
  const compiled = port.compileContext([item('attention:a', 'alpha')], options())
  assert.equal(compiled.items.length, 1)
  assert.equal(compiled.items[0].summary, 'alpha')
})

test('TTL expiry and session eviction free entries', () => {
  let clock = NOW
  const cache = new AmpContextCache({ ...POLICY, ttlMilliseconds: 1 }, { now: () => clock })
  const objects = [item('attention:a', 'alpha')]

  cache.compile(objects, options())
  clock = '2026-01-01T00:00:01.000Z'
  cache.compile(objects, options())
  assert.equal(cache.stats().expirations, 1)

  assert.equal(cache.evictSession('session-1'), 1)
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.evictSession('unknown'), 0)
})

test('a real compile failure still surfaces instead of being swallowed', () => {
  const cache = new AmpContextCache(POLICY, { now: () => NOW })
  assert.throws(() => cache.compile([item('attention:a', 'alpha'), item('attention:a', 'alpha')], options()))
})
