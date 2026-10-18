/**
 * Cache strategy table audit.
 *
 * The table is data, so the tests are about the invariants the proxy will rely
 * on: every citation resolves, every researched brand has a row, lookup is
 * deterministic and never throws, and specificity really is
 * agent+model > model > brand > unknown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_PRESETS,
  CACHE_SOURCES,
  presetFor,
  type CacheMode,
  type CacheStrategyPreset,
} from '../src/host/cache-strategy.js'

const BRANDS = [
  'deepseek',
  'openai',
  'anthropic',
  'google',
  'xai',
  'moonshot',
  'qwen',
  'zhipu',
  'meta',
  'unknown',
] as const

const MODES: readonly CacheMode[] = [
  'automatic-prefix',
  'explicit-breakpoints',
  'hybrid',
  'none',
  'unknown',
]

/** A brand row is the preset without model or agent patterns. */
function brandRow(brand: string): CacheStrategyPreset | undefined {
  return CACHE_PRESETS.find(
    (preset) =>
      preset.brand === brand && preset.models === undefined && preset.agents === undefined,
  )
}

test('every researched brand has a brand-level preset', () => {
  for (const brand of BRANDS) {
    const row = brandRow(brand)
    assert.ok(row, `missing brand row for ${brand}`)
    assert.equal(row.brand, brand)
  }
})

test('every preset cites only ids that exist in the source table', () => {
  const ids = new Set(CACHE_SOURCES.map((source) => source.id))
  for (const preset of CACHE_PRESETS) {
    assert.ok(preset.sourceIds.length > 0, `${preset.id} cites no source`)
    for (const id of preset.sourceIds) {
      assert.ok(ids.has(id), `${preset.id} cites unknown source ${id}`)
    }
  }
})

test('preset and source ids are unique', () => {
  assert.equal(new Set(CACHE_PRESETS.map((preset) => preset.id)).size, CACHE_PRESETS.length)
  assert.equal(new Set(CACHE_SOURCES.map((source) => source.id)).size, CACHE_SOURCES.length)
})

test('presetFor prefers agent+model over model over brand over unknown', () => {
  assert.equal(
    presetFor({ agent: 'claude-code', model: 'claude-sonnet-4.5', brand: 'anthropic' }).id,
    'anthropic/claude-code-agent',
  )
  assert.equal(
    presetFor({ model: 'claude-opus-4-7', brand: 'anthropic' }).id,
    'anthropic/claude-high-minimum',
  )
  assert.equal(presetFor({ brand: 'anthropic' }).id, 'anthropic/breakpoints')
  assert.equal(presetFor({}).id, 'unknown/conservative')
})

test('a model wildcard matches prefix, dotted and provider-prefixed ids', () => {
  for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-6.1-sol', 'openai/gpt-5.6-terra']) {
    assert.equal(presetFor({ model }).id, 'openai/gpt-5-6', model)
  }
  // `4.5` and `4-5` are the same family after normalisation.
  assert.equal(presetFor({ model: 'claude-sonnet-4.5' }).id, 'anthropic/claude-4-x')
  assert.equal(presetFor({ model: 'claude-sonnet-4-5-20250929' }).id, 'anthropic/claude-4-x')
  // The bare `*` pattern in the Claude Code row matches every Claude model.
  assert.equal(presetFor({ agent: 'claude-code', model: 'claude-3-5-sonnet' }).id, 'anthropic/claude-code-agent')
})

test('an agent row does not leak to a different model family', () => {
  // claude-code is paired with claude-*; a GPT model must fall through to the
  // OpenAI model row instead of inheriting Anthropic rules.
  assert.equal(presetFor({ agent: 'claude-code', model: 'gpt-5.6-sol' }).id, 'openai/gpt-5-6')
  // codex is paired with gpt-*; a Claude model must fall through to Anthropic.
  assert.equal(presetFor({ agent: 'codex', model: 'claude-opus-4-7' }).id, 'anthropic/claude-high-minimum')
})

test('Anthropic model rows carry the per-model Bedrock minimums', () => {
  // The fetched AWS table is not uniform across the family, so the rows are not
  // either: 512 for the newest Opus/Fable/Mythos, 1,024 for Sonnet 5, 4,096 for
  // the 4.5-4.7 Opus generation and Haiku 4.5.
  assert.equal(presetFor({ model: 'claude-opus-5' }).minPrefixTokens, 512)
  assert.equal(presetFor({ model: 'claude-sonnet-5' }).minPrefixTokens, 1024)
  assert.equal(presetFor({ model: 'claude-opus-4-7' }).minPrefixTokens, 4096)
  assert.equal(presetFor({ model: 'claude-haiku-4-5' }).minPrefixTokens, 4096)
  assert.equal(presetFor({ model: 'claude-sonnet-4-5' }).minPrefixTokens, 1024)
  assert.equal(presetFor({ model: 'claude-sonnet-5' }).id, 'anthropic/claude-sonnet-5')
})

test('unknown input never throws and resolves to the conservative row', () => {
  const cases: unknown[] = [
    undefined,
    null,
    {},
    { brand: '', model: '', agent: '' },
    { brand: 'acme', model: 'mystery-1' },
    // No brand and no model row: the table refuses to infer a family from a bare
    // model id, so the conservative row wins.
    { model: 'glm-5.3' },
    { brand: 42, model: [], agent: {} },
    { model: '   ' },
  ]
  for (const input of cases) {
    const preset = presetFor(input as { brand?: string; model?: string; agent?: string })
    assert.equal(preset.id, 'unknown/conservative', JSON.stringify(input))
    assert.equal(preset.mode, 'unknown')
  }
})

test('unknown rows never claim a local lever', () => {
  const row = presetFor({})
  assert.equal(row.volatileStrippingHelps, false)
  assert.equal(row.compactionPolicy, 'unknown')
  assert.equal(row.effortBreaksPrefix, 'unknown')
  assert.equal(row.effortEvidence, 'assumed')
})

test('lookup is deterministic for the same input', () => {
  const input = { agent: 'codex', model: 'gpt-5.6-sol', brand: 'openai' }
  const first = presetFor(input)
  for (let index = 0; index < 5; index += 1) {
    assert.equal(presetFor(input).id, first.id)
  }
})

test('every preset has a positive minimum and a valid mode', () => {
  for (const preset of CACHE_PRESETS) {
    assert.ok(preset.minPrefixTokens > 0, `${preset.id} has a non-positive minimum`)
    assert.ok(Number.isInteger(preset.minPrefixTokens), `${preset.id} has a fractional minimum`)
    assert.ok(MODES.includes(preset.mode), `${preset.id} has mode ${preset.mode}`)
    if (preset.ttlSeconds !== undefined) {
      assert.ok(preset.ttlSeconds > 0, `${preset.id} has a non-positive TTL`)
    }
    assert.ok(preset.stablePrefixRules.length > 0, `${preset.id} has no rules`)
    assert.ok(
      preset.compactionPolicy === 'avoid-mid-prefix' ||
        preset.compactionPolicy === 'safe' ||
        preset.compactionPolicy === 'unknown',
      `${preset.id} has compaction policy ${preset.compactionPolicy}`,
    )
  }
})

test('the source table keeps fetched claims short and urls absolute', () => {
  for (const source of CACHE_SOURCES) {
    assert.match(source.url, /^https:\/\//, `${source.id} has a non-absolute url`)
    assert.ok(source.title.length > 0, `${source.id} has no title`)
    assert.ok(source.authors.length > 0, `${source.id} has no authors`)
    assert.ok(source.year >= 2023 && source.year <= 2027, `${source.id} has year ${source.year}`)
    // An unfetched page is allowed, but it must say so instead of carrying a claim.
    const unfetched = source.claim.startsWith('UNFETCHED')
    if (!unfetched) {
      const words = source.claim.trim().split(/\s+/).length
      assert.ok(words <= 25, `${source.id} claim is ${words} words`)
    }
  }
})

test('exactly the blocked origins are recorded as unfetched', () => {
  const unfetched = CACHE_SOURCES.filter((source) => source.claim.startsWith('UNFETCHED')).map(
    (source) => source.id,
  )
  assert.deepEqual(unfetched.sort(), [
    'anthropic-prompt-caching-docs',
    'gemini-context-caching-docs',
    'openai-prompt-caching-docs',
    'xai-prompt-caching-docs',
  ])
})
