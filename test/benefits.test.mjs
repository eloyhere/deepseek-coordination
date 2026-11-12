import assert from 'node:assert/strict'
import test from 'node:test'
import { computeBenefits } from '../src/host/benefits.ts'
import {
  historyFromBenefits,
  mergeBenefitInput,
  mergeErrorHistory,
} from '../src/host/benefitHistory.ts'
import { computeEffectiveness, summarizeErrors } from '../src/host/effectiveness.ts'
import { deepSeekPricing as resolvePricing } from '../src/host/pricingCore.ts'

const PRICING = {
  priced: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  method: 'deepseek-peak',
  currency: 'CNY',
  window: 'off-peak',
  inputMissPerMillion: 3,
  inputHitPerMillion: 0.025,
  outputPerMillion: 6,
  name: 'test model',
  cacheDiscount: true,
  tiers: [],
  source: 'test fixture',
}

const USAGE = {
  requests: 1,
  inputTokens: 2500,
  cacheReadTokens: 2500,
  cacheWriteTokens: 0,
  outputTokens: 100,
  totalInputTokens: 5000,
  hitRate: 0.5,
}

test('empty counters produce an unavailable, zeroed snapshot', () => {
  const snapshot = computeBenefits({})
  assert.equal(snapshot.available, false)
  assert.equal(snapshot.quality, null)
  assert.equal(snapshot.confidence, 'none')
  assert.equal(snapshot.tokens.saved, 0)
  assert.equal(snapshot.tokens.injected, 0)
  assert.equal(snapshot.tokens.net, 0)
  assert.equal(snapshot.tokens.roi, 0)
  assert.equal(snapshot.cost.saved, 0)
  assert.equal(snapshot.cost.injected, 0)
  assert.equal(snapshot.cost.net, 0)
  assert.equal(snapshot.cost.priced, false)
  assert.equal(snapshot.pricing, null)
})

test('token savings count spill, retention and prune but never cache reuse', () => {
  const snapshot = computeBenefits({
    compilations: 4,
    failures: 0,
    excluded: 2,
    lastTokens: 900,
    lastItems: 5,
    budgetTokens: 1200,
    tokensInjected: 3600,
    cache: { savedTokens: 99_999, hitRate: 0.5 },
    prune: { reviews: 2, verified: 2, failed: 0, savedTokens: 600 },
    outputs: {
      spill: { bytes: 4000 },
      retention: { omittedBytes: 2000, omittedItems: 3, omittedUnknown: 1 },
      prune: { records: 2, shadowedTokens: 800 },
      compaction: { records: 1, shadowedTokens: 1200 },
    },
  }, { lag: 0 }, PRICING, USAGE)

  assert.equal(snapshot.available, true)
  assert.equal(snapshot.tokens.spill, 1000)
  assert.equal(snapshot.tokens.retention, 500)
  assert.equal(snapshot.tokens.prune, 600)
  assert.equal(snapshot.tokens.attentionPrune, 600)
  assert.equal(snapshot.tokens.contextPrune, 800)
  assert.equal(snapshot.tokens.compaction, 1200)
  assert.equal(snapshot.tokens.contextPruneRecords, 2)
  assert.equal(snapshot.tokens.compactionRecords, 1)
  // Context prune/compaction are display-only; they do not inflate the net.
  assert.equal(snapshot.tokens.saved, 2100)
  assert.equal(snapshot.tokens.cacheReuse, 99_999)
  assert.equal(snapshot.tokens.injected, 3600)
  assert.equal(snapshot.tokens.net, -1500)
  assert.ok(Math.abs(snapshot.tokens.roi - 2100 / 3600) < 1e-9)
  assert.equal(snapshot.tokens.omittedItems, 3)
  assert.equal(snapshot.tokens.omittedUnknown, 1)
  // 50% cache hit blends 3.0 and 0.025 into 1.5125 per million.
  assert.ok(Math.abs(snapshot.cost.pricePerMillion - 1.5125) < 1e-12)
  assert.ok(Math.abs(snapshot.cost.saved - 2100 / 1_000_000 * 1.5125) < 1e-12)
  assert.ok(Math.abs(snapshot.cost.injected - 3600 / 1_000_000 * 1.5125) < 1e-12)
  assert.ok(Math.abs(snapshot.cost.net - (2100 - 3600) / 1_000_000 * 1.5125) < 1e-12)
  assert.equal(snapshot.pricing?.effectiveInputPerMillion, 1.5125)
  assert.equal(snapshot.cache.hitRate, 0.5)
})

test('quality averages freshness, budget, verification and reliability', () => {
  const snapshot = computeBenefits({
    compilations: 4,
    failures: 0,
    lastTokens: 900,
    budgetTokens: 1200,
    tokensInjected: 3600,
    prune: { reviews: 2, verified: 2, failed: 0 },
  }, { lag: 0 })

  assert.deepEqual(snapshot.quality?.components, {
    freshness: 100,
    budget: 100,
    verification: 100,
    reliability: 100,
  })
  assert.equal(snapshot.quality?.score, 100)
  assert.equal(snapshot.quality?.delta, 50)
  assert.equal(snapshot.quality?.band, 'excellent')
  assert.equal(snapshot.quality?.samples, 4)
  assert.equal(snapshot.confidence, 'medium')
})

test('budget overrun and a stale capture lower the quality index', () => {
  const snapshot = computeBenefits({
    compilations: 1,
    failures: 0,
    lastTokens: 2400,
    budgetTokens: 1200,
  }, { lag: 1 })

  assert.deepEqual(snapshot.quality?.components, {
    freshness: 50,
    budget: 50,
    verification: 75,
    reliability: 100,
  })
  // One sample is shrunk toward the 50 anchor: 50 + (69 - 50) / 4 = 54.75.
  assert.equal(snapshot.quality?.score, 55)
  assert.equal(snapshot.quality?.delta, 5)
  assert.equal(snapshot.quality?.band, 'fair')
  assert.equal(snapshot.confidence, 'low')
})

test('invalid and negative counters degrade to zero instead of NaN', () => {
  const snapshot = computeBenefits({
    compilations: Number.NaN,
    failures: -3,
    lastTokens: -1,
    budgetTokens: 0,
    tokensInjected: Number.POSITIVE_INFINITY,
    cache: { savedTokens: Number.NaN },
    prune: { reviews: -1, savedTokens: -2 },
    outputs: { spill: { bytes: -4 }, retention: { omittedBytes: Number.NaN } },
  })

  assert.equal(snapshot.available, false)
  assert.equal(snapshot.tokens.saved, 0)
  assert.equal(snapshot.tokens.injected, 0)
  assert.equal(snapshot.cost.saved, 0)
  assert.equal(snapshot.quality, null)
  assert.equal(snapshot.confidence, 'none')
})

test('item-only retention is reported but cannot become tokens', () => {
  const snapshot = computeBenefits({
    compilations: 1,
    lastTokens: 500,
    budgetTokens: 1200,
    outputs: { retention: { omittedItems: 7 } },
  }, { lag: 0 })

  assert.equal(snapshot.tokens.retention, 0)
  assert.equal(snapshot.tokens.omittedItems, 7)
  assert.equal(snapshot.tokens.saved, 0)
  assert.equal(snapshot.available, true)
})

test('DeepSeek flash uses the Beijing peak window and the flash tariff', () => {
  const peak = resolvePricing({ provider: 'deepseek-official', model: 'deepseek-flash' }, new Date('2026-11-12T03:00:00Z'))
  assert.equal(peak.priced, true)
  assert.equal(peak.window, 'peak')
  assert.equal(peak.inputMissPerMillion, 2)
  assert.equal(peak.inputHitPerMillion, 0.04)
  assert.equal(peak.outputPerMillion, 8)

  const offPeak = resolvePricing({ provider: 'deepseek-official', model: 'deepseek-flash' }, new Date('2026-11-12T12:00:00Z'))
  assert.equal(offPeak.window, 'off-peak')
  assert.equal(offPeak.inputMissPerMillion, 1)
  assert.equal(offPeak.inputHitPerMillion, 0.02)
  assert.equal(offPeak.outputPerMillion, 4)
})

test('DeepSeek Pro has its own peak and off-peak rates', () => {
  const peak = resolvePricing({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, new Date('2026-11-12T03:00:00Z'))
  assert.equal(peak.inputMissPerMillion, 9)
  assert.equal(peak.inputHitPerMillion, 0.3)
  assert.equal(peak.outputPerMillion, 27)

  const offPeak = resolvePricing({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, new Date('2026-11-12T12:00:00Z'))
  assert.equal(offPeak.inputMissPerMillion, 4.5)
  assert.equal(offPeak.inputHitPerMillion, 0.15)
  assert.equal(offPeak.outputPerMillion, 13.5)
})

test('an unknown model is explicitly unpriced rather than borrowing a rate', () => {
  const snapshot = computeBenefits({ compilations: 1, tokensInjected: 100 }, { lag: 0 }, null)
  assert.equal(snapshot.cost.priced, false)
  assert.equal(snapshot.cost.saved, 0)
})

test('error summary counts failures and derives p95 latency', () => {
  const errors = summarizeErrors([
    { ok: true, durationMs: 10 },
    { ok: false, durationMs: 20 },
    { ok: true, durationMs: 30 },
    { ok: true, durationMs: 1000 },
  ])
  assert.equal(errors.available, true)
  assert.equal(errors.calls, 4)
  assert.equal(errors.failures, 1)
  assert.equal(errors.errorRate, 0.25)
  assert.equal(errors.errorFree, 75)
  assert.equal(errors.medianDurationMs, 20)
  assert.equal(errors.p95DurationMs, 1000)
  assert.equal(errors.durationScore, 25)
})

test('effectiveness is quality, duration and ROI gated by error-free rate', () => {
  const errors = summarizeErrors([
    { ok: true, durationMs: 10 },
    { ok: false, durationMs: 20 },
    { ok: true, durationMs: 30 },
    { ok: true, durationMs: 1000 },
  ])
  const effectiveness = computeEffectiveness(100, errors, 3)
  assert.ok(effectiveness !== null)
  // 0.45*100 + 0.25*25 + 0.30*100 = 81.25; gated by 75% error-free = 60.94.
  assert.equal(effectiveness.score, 61)
  assert.deepEqual(effectiveness.components, { quality: 100, duration: 25, errorFree: 75, roi: 100 })
  assert.equal(effectiveness.errorRate, 0.25)
  // No journal sample uses a neutral 50 duration and a 100% error-free prior.
  assert.equal(computeEffectiveness(100, summarizeErrors([]), 3)?.score, 88)
})

test('a restarted host keeps its historical high-water counters', () => {
  const history = {
    version: 1,
    saved: 92987,
    spill: 92987,
    retention: 0,
    prune: 0,
    contextPrune: 524292,
    compaction: 1351752,
    cacheReuse: 0,
    injected: 14004,
    contextPruneRecords: 106,
    compactionRecords: 3,
    compilations: 12,
    failures: 0,
    pruneReviews: 0,
    pruneVerified: 0,
    pruneFailed: 0,
    errorCalls: 10,
    errorFailures: 1,
    errorP95DurationMs: 1000,
    updatedAt: '2026-11-12T03:00:00.000Z',
  }
  const merged = mergeBenefitInput({ compilations: 1, tokensInjected: 200 }, history)
  const errors = mergeErrorHistory(summarizeErrors([]), history)
  const snapshot = computeBenefits(merged, { lag: 0 }, PRICING, USAGE, null, errors, null, history)
  assert.equal(snapshot.tokens.saved, 92987)
  assert.equal(snapshot.tokens.contextPrune, 524292)
  assert.equal(snapshot.tokens.compaction, 1351752)
  assert.equal(snapshot.quality?.samples, 12)
  assert.equal(snapshot.history.persisted, true)
  assert.equal(errors.calls, 10)
  assert.equal(errors.failures, 1)
  assert.equal(errors.errorRate, 0.1)
  assert.equal(errors.durationScore, 25)
  const next = historyFromBenefits(snapshot, errors, 0)
  assert.equal(next.saved, 92987)
  assert.equal(next.errorFailures, 1)
})
