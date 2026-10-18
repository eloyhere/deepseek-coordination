/**
 * Brand cache profile audit.
 *
 * The proxy can only optimize what it can name: the harness reports a provider
 * route plus a model id and display name, and this module maps that identity
 * onto one of a handful of known cache behaviours. These tests pin the mapping
 * and the honesty of the profiles — an explicit-breakpoint family must not claim
 * a local lever it cannot use.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRAND_PROFILES,
  brandProfileOf,
  classifyModelBrand,
  hasLocalCacheLever,
  shouldDecorate,
} from '../src/host/model-brand.js'

test('the host identity fields classify onto the mainstream brands', () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ provider: 'deepseek-account', model: 'deepseek-flash' }, 'deepseek'],
    [{ provider: 'acme', model: 'gpt-5.2' }, 'openai'],
    [{ provider: 'acme', model: 'claude-sonnet-4.5' }, 'anthropic'],
    [{ provider: 'vertex', model: 'gemini-3-pro' }, 'google'],
    [{ provider: 'acme', model: 'grok-5' }, 'xai'],
    [{ provider: 'acme', model: 'kimi-k2' }, 'moonshot'],
    [{ provider: 'dashscope', model: 'qwen3-max' }, 'qwen'],
    [{ provider: 'acme', model: 'glm-5' }, 'zhipu'],
    [{ provider: 'acme', model: 'mistral-large-3' }, 'mistral'],
    [{ provider: 'acme', model: 'llama-4-405b' }, 'meta'],
    [{ provider: 'acme', model: 'some-local-7b' }, 'unknown'],
  ]
  for (const [identity, expected] of cases) {
    assert.equal(classifyModelBrand(identity), expected, JSON.stringify(identity))
  }
})

test('a reseller route named after its model still classifies by the model', () => {
  // The route says nothing; the model id carries the brand.
  assert.equal(classifyModelBrand({ provider: 'proxy-a', model: 'claude-haiku-4' }), 'anthropic')
  assert.equal(classifyModelBrand({ provider: 'proxy-b', model: 'deepseek-v4' }), 'deepseek')
  // A display name is enough when the id is opaque.
  assert.equal(classifyModelBrand({ provider: 'p', model: 'm-1', name: 'Claude Opus 4.6' }), 'anthropic')
})

test('an empty identity is unknown, never a guessed brand', () => {
  assert.equal(classifyModelBrand({}), 'unknown')
  assert.equal(classifyModelBrand({ provider: '', model: '' }), 'unknown')
  assert.equal(brandProfileOf({}).brand, 'unknown')
})

test('every profile states its own behaviour and is internally consistent', () => {
  for (const [brand, profile] of Object.entries(BRAND_PROFILES)) {
    assert.equal(profile.brand, brand)
    assert.ok(profile.label.length > 0, `${brand} needs a label`)
    assert.ok(profile.note.length > 0, `${brand} needs a note`)
    assert.ok(Number.isInteger(profile.minPrefixTokens) && profile.minPrefixTokens >= 0, `${brand} minimum`)
    // A marker-only family cannot claim that byte-stable text is the lever: with
    // explicit breakpoints, reuse is decided by markers this plugin cannot emit.
    if (!profile.automaticPrefixCache) {
      assert.equal(profile.stripVolatileHelps, false, `${brand}: explicit-only family cannot claim stripping helps`)
      assert.equal(hasLocalCacheLever(profile), false, `${brand}: no local lever without automatic caching`)
    }
  }
})

test('the conservative unknown row assumes automatic caching', () => {
  const profile = BRAND_PROFILES.unknown
  assert.equal(profile.automaticPrefixCache, true)
  assert.equal(profile.stripVolatileHelps, true)
  assert.equal(profile.effortBreaksCache, true)
  assert.equal(hasLocalCacheLever(profile), true)
})

test('explicit-breakpoint families report no local lever', () => {
  const anthropic = brandProfileOf({ model: 'claude-sonnet-4' })
  assert.equal(anthropic.brand, 'anthropic')
  assert.equal(anthropic.explicitCacheBreakpoints, true)
  assert.equal(anthropic.automaticPrefixCache, false)
  assert.equal(anthropic.stripVolatileHelps, false)
  assert.equal(hasLocalCacheLever(anthropic), false)
})

test('automatic-cache families expose the levers the proxy can use', () => {
  for (const identity of [{ model: 'deepseek-v4' }, { model: 'gpt-5.2' }, { model: 'gemini-3-pro' }]) {
    const profile = brandProfileOf(identity)
    assert.equal(profile.automaticPrefixCache, true)
    assert.equal(hasLocalCacheLever(profile), true)
    assert.ok(profile.minPrefixTokens > 0)
  }
})

test('effort sensitivity matches the documented family behaviour', () => {
  // Reasoning effort participates in the cache key where the provider says so.
  assert.equal(BRAND_PROFILES.deepseek.effortBreaksCache, true)
  assert.equal(BRAND_PROFILES.anthropic.effortBreaksCache, true)
  assert.equal(BRAND_PROFILES.openai.effortBreaksCache, false)
  assert.equal(BRAND_PROFILES.google.effortBreaksCache, false)
})

test('the decorator is gated by the operator switch and the brand lever', () => {
  const deepseek = BRAND_PROFILES.deepseek
  assert.equal(shouldDecorate(deepseek, true), true)
  assert.equal(shouldDecorate(deepseek, false), false, 'the live switch wins')

  const anthropic = BRAND_PROFILES.anthropic
  assert.equal(shouldDecorate(anthropic, true), false, 'no rewrite without an automatic cache')

  assert.equal(shouldDecorate(BRAND_PROFILES.unknown, true), true, 'the conservative row keeps the lever')
})
