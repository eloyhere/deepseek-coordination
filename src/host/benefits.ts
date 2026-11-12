/**
 * Value quantification for the AMP surface.
 *
 * Everything here is derived from counters the host already keeps. The model is
 * deliberately conservative and explicit:
 *
 * - Token savings only count tool output that was actually omitted from the
 *   transcript (spill + retention) and attention entries the verified prune
 *   pipeline removed. Compile-cache reuse is reported but never counted: it
 *   saves serialization work, not model prompt tokens.
 * - Byte-only omissions are converted at four bytes per token. That is the
 *   conservative direction for ASCII and an undercount for CJK, never an
 *   overclaim.
 * - Cost reads the active provider/model from DSH and its actual prompt-cache
 *   hit rate from assistant usage. The effective input price is
 *   `hitRate * cacheHit + (1 - hitRate) * cacheMiss`; a provider without a
 *   published rate is left unpriced instead of borrowing another model's rate.
 * - Quality is a guardrail index, not a model benchmark. It averages four
 *   observable checks (fresh capture, budget fit, prune verification, compile
 *   reliability) and compares them with a neutral rubric baseline of 50.
 *
 * The UI labels all of this as an estimate, shows sample counts, and renders
 * the formulas. No number here is presented as a bill.
 */

import type { ModelPricing, ModelSelection } from './pricing.js'
import type { UsageSnapshot } from './usage.js'
import type { Effectiveness, ErrorSummary } from './effectiveness.js'
import type { BenefitHistory } from './benefitHistory.js'

/** Conservative conversion for byte-only omissions; CJK is undercounted. */
export const BENEFIT_BYTES_PER_TOKEN = 4

/** Neutral score of the quality rubric before any guardrail is applied. */
export const BENEFIT_QUALITY_BASELINE = 50

/** One of four readable bands for the quality index. */
export type BenefitBand = 'excellent' | 'good' | 'fair' | 'poor'

/** How much evidence backs the estimate. */
export type BenefitConfidence = 'none' | 'low' | 'medium' | 'high'

/** The four 25-point guardrail checks behind the quality index. */
export interface BenefitQuality {
  /** 0-100 index; the rounded mean of the four components. */
  readonly score: number
  /** Rubric anchor, not a measurement: 50 means "no guardrail applied". */
  readonly baseline: number
  /** `score - baseline`. */
  readonly delta: number
  readonly band: BenefitBand
  /** Successful compiles observed; the sample size for this index. */
  readonly samples: number
  readonly components: {
    /** 100 when the step used a pre-step capture, 50 otherwise. */
    readonly freshness: number
    /** 100 within budget, degrading with the overrun. */
    readonly budget: number
    /** Verified / (verified + failed) prune reviews; 75 when unreviewed. */
    readonly verification: number
    /** Successful / (successful + failed) compiles. */
    readonly reliability: number
  }
}

/** The token ledger, in estimated tokens. */
export interface BenefitTokens {
  /** Spill + retention + prune; the headline saving. */
  readonly saved: number
  /** Tool output omitted by the spill channel. */
  readonly spill: number
  /** Tool output omitted by the retention channel. */
  readonly retention: number
  /** Attention entries removed by the verified prune pipeline. */
  readonly prune: number
  /** Alias of `prune`: explicit name for the attention-only channel. */
  readonly attentionPrune: number
  /** Original tokens of tool results pruned by DSH; display-only, not net. */
  readonly contextPrune: number
  /** Original tokens of history ranges replaced by a compaction summary. */
  readonly compaction: number
  /** Number of DSH tool-result prune records. */
  readonly contextPruneRecords: number
  /** Number of completed compaction summaries. */
  readonly compactionRecords: number
  /** Compile-cache reuse; reported but excluded from `saved`. */
  readonly cacheReuse: number
  /** Attention payload injected across compiles (the denominator). */
  readonly injected: number
  /** `saved - injected`; negative is an honest net cost. */
  readonly net: number
  /** `saved / injected`; zero when nothing was injected. */
  readonly roi: number
  /** Retention omissions measured in items, which cannot become tokens. */
  readonly omittedItems: number
  /** Retention omissions with no usable amount. */
  readonly omittedUnknown: number
}

/** The whole read model served under `benefits` by `/amp/context`. */
export interface BenefitSnapshot {
  /** False before the first compile or saving; the UI shows an empty state. */
  readonly available: boolean
  readonly currency: string
  /** Provider/model DSH reports for the active route, when known. */
  readonly model: ModelSelection | null
  /** Resolved tariff, including whether this model has a price at all. */
  readonly pricing: (ModelPricing & { readonly effectiveInputPerMillion: number }) | null
  /** Actual prompt-cache usage behind `pricing.effectiveInputPerMillion`. */
  readonly cache: UsageSnapshot
  /** Static registry size and provenance, when the host supplies it. */
  readonly registry: {
    readonly providers: number
    readonly models: number
    readonly priced: number
    readonly sources: readonly string[]
  } | null
  /** Null until at least one compile has succeeded. */
  readonly quality: BenefitQuality | null
  /** Execution errors and latency from the AMP gateway journal. */
  readonly errors: ErrorSummary | null
  /** Composite percentage: quality, latency, error-free gate and ROI. */
  readonly effectiveness: Effectiveness | null
  /** Whether a durable high-water ledger was loaded for this workspace. */
  readonly history: {
    readonly persisted: boolean
    readonly updatedAt: string | null
  }
  readonly tokens: BenefitTokens
  readonly cost: {
    /** Gross value of the saved tokens. */
    readonly saved: number
    /** Cost of the attention payload that produced the saving. */
    readonly injected: number
    /** `saved - injected`; negative is an honest net cost. */
    readonly net: number
    /** Blended input rate, per million tokens. */
    readonly pricePerMillion: number
    readonly currency: string
    /** False when the model has no published text-token tariff. */
    readonly priced: boolean
  }
  readonly confidence: BenefitConfidence
  readonly assumptions: {
    readonly bytesPerToken: number
    readonly qualityBaseline: number
    readonly qualityWeights: readonly number[]
    readonly countedSources: readonly string[]
    readonly excludedSources: readonly string[]
  }
}

/** Structural subset of `optimizer.status()` the estimate reads. */
export interface BenefitInput {
  readonly compilations?: number
  readonly failures?: number
  readonly excluded?: number
  readonly lastTokens?: number
  readonly lastItems?: number
  readonly budgetTokens?: number
  readonly tokensInjected?: number
  readonly cache?: {
    readonly hits?: number
    readonly misses?: number
    readonly hitRate?: number
    readonly savedTokens?: number
  }
  readonly prune?: {
    readonly reviews?: number
    readonly verified?: number
    readonly failed?: number
    readonly savedTokens?: number
  }
  readonly outputs?: {
    readonly spill?: { readonly bytes?: number }
    readonly retention?: {
      readonly omittedBytes?: number
      readonly omittedItems?: number
      readonly omittedUnknown?: number
    }
    readonly prune?: {
      readonly records?: number
      readonly shadowedTokens?: number
    }
    readonly compaction?: {
      readonly records?: number
      readonly shadowedTokens?: number
    }
  }
}

/** Coerce one counter to a finite, non-negative number. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Clamp a percentage to 0-100; a non-positive denominator yields 0. */
function percent(part: number, whole: number): number {
  if (whole <= 0) return 0
  const value = (part / whole) * 100
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

/** One readable band; thresholds are fixed so the label never drifts. */
function bandOf(score: number): BenefitBand {
  if (score >= 85) return 'excellent'
  if (score >= 70) return 'good'
  if (score >= 50) return 'fair'
  return 'poor'
}

/** Evidence level from the number of compiles, not from savings volume. */
function confidenceOf(samples: number): BenefitConfidence {
  if (samples <= 0) return 'none'
  if (samples < 3) return 'low'
  if (samples < 10) return 'medium'
  return 'high'
}

const EMPTY_USAGE: UsageSnapshot = {
  requests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  totalInputTokens: 0,
  hitRate: 0,
}

/**
 * Build the value snapshot from the optimizer's counters.
 *
 * @param input - the subset of `optimizer.status()` this model reads.
 * @param diagnostics - last compile diagnostics; only `lag` is used.
 * @param pricing - tariff resolved from the active host model, or null.
 * @param usage - actual prompt-cache usage for that route.
 * @returns a fully populated, serializable snapshot; never throws.
 */
export function computeBenefits(
  input: BenefitInput,
  diagnostics: { readonly lag?: number } = {},
  pricing: ModelPricing | null = null,
  usage: UsageSnapshot = EMPTY_USAGE,
  registry: BenefitSnapshot['registry'] = null,
  errors: ErrorSummary | null = null,
  effectivenessInput: Effectiveness | null = null,
  history: BenefitHistory | null = null,
): BenefitSnapshot {
  const compilations = count(input.compilations)
  const failures = count(input.failures)
  const lastTokens = count(input.lastTokens)
  const budgetTokens = count(input.budgetTokens)
  const lag = typeof diagnostics.lag === 'number' && diagnostics.lag === 0 ? 0 : 1

  const spillBytes = count(input.outputs?.spill?.bytes)
  const retentionBytes = count(input.outputs?.retention?.omittedBytes)
  const spill = Math.round(spillBytes / BENEFIT_BYTES_PER_TOKEN)
  const retention = Math.round(retentionBytes / BENEFIT_BYTES_PER_TOKEN)
  const prune = count(input.prune?.savedTokens)
  const contextPrune = count(input.outputs?.prune?.shadowedTokens)
  const compaction = count(input.outputs?.compaction?.shadowedTokens)
  const cacheReuse = count(input.cache?.savedTokens)
  // Only the spill, retention and verified attention-prune channels are
  // measured net savings. Context-tool pruning and compaction report the
  // original tokens they replaced; their replacement text is still present.
  const saved = spill + retention + prune

  // `tokensInjected` is cumulative and added by this build; an older host may
  // only expose the last compile. Fall back to that rather than to zero.
  const injected = count(input.tokensInjected) || lastTokens
  const net = saved - injected
  const roi = injected > 0 ? saved / injected : 0

  const freshness = lag === 0 ? 100 : 50
  const budget = budgetTokens <= 0
    ? 50
    : lastTokens <= budgetTokens
      ? 100
      : Math.round(percent(budgetTokens, lastTokens))
  const reviews = count(input.prune?.reviews)
  const verified = count(input.prune?.verified)
  const pruneFailed = count(input.prune?.failed)
  const verification = reviews > 0 ? Math.round(percent(verified, verified + pruneFailed)) : 75
  const reliability = compilations + failures > 0
    ? Math.round(percent(compilations, compilations + failures))
    : 0

  const rawQuality = Math.round((freshness + budget + verification + reliability) / 4)
  // Four successful compiles are enough to trust the raw score; fewer samples
  // shrink toward the neutral 50 anchor instead of claiming 100 from one run.
  const qualityConfidence = Math.min(1, compilations / 4)
  const qualityScore = Math.round(BENEFIT_QUALITY_BASELINE + (rawQuality - BENEFIT_QUALITY_BASELINE) * qualityConfidence)
  const quality = compilations > 0
    ? {
        score: qualityScore,
        baseline: BENEFIT_QUALITY_BASELINE,
        delta: qualityScore - BENEFIT_QUALITY_BASELINE,
        band: bandOf(qualityScore),
        samples: compilations,
        components: { freshness, budget, verification, reliability },
      }
    : null
  const effectiveness = effectivenessInput

  // Cache-hit and cache-miss inputs have different rates. Only blend when the
  // provider publishes a cache-read price; a zero cacheRead means "no discount",
  // not "free". Tiered models switch rates at their published input threshold.
  const hitRate = usage.totalInputTokens > 0 ? usage.hitRate : 0
  const tier = pricing?.tiers
    ?.filter((candidate) => usage.totalInputTokens >= candidate.above)
    .at(-1)
  const inputMiss = tier?.input ?? pricing?.inputMissPerMillion ?? 0
  const inputHit = tier?.cacheRead ?? pricing?.inputHitPerMillion ?? 0
  const effectiveInput = pricing?.priced === true
    ? pricing.cacheDiscount
      ? hitRate * inputHit + (1 - hitRate) * inputMiss
      : inputMiss
    : 0
  const priced = pricing?.priced === true
  const costSaved = priced ? (saved / 1_000_000) * effectiveInput : 0
  const costInjected = priced ? (injected / 1_000_000) * effectiveInput : 0
  const costNet = costSaved - costInjected

  return {
    available: compilations > 0 || saved > 0,
    currency: pricing?.currency ?? 'CNY',
    model: pricing === null ? null : { provider: pricing.provider, model: pricing.model },
    pricing: pricing === null ? null : { ...pricing, effectiveInputPerMillion: effectiveInput },
    cache: usage,
    registry,
    quality,
    errors,
    effectiveness,
    history: {
      persisted: history !== null && history.updatedAt.length > 0,
      updatedAt: history?.updatedAt ?? null,
    },
    tokens: {
      saved,
      spill,
      retention,
      prune,
      attentionPrune: prune,
      contextPrune,
      compaction,
      contextPruneRecords: count(input.outputs?.prune?.records),
      compactionRecords: count(input.outputs?.compaction?.records),
      cacheReuse,
      injected,
      net,
      roi,
      omittedItems: count(input.outputs?.retention?.omittedItems),
      omittedUnknown: count(input.outputs?.retention?.omittedUnknown),
    },
    cost: {
      saved: costSaved,
      injected: costInjected,
      net: costNet,
      pricePerMillion: effectiveInput,
      currency: pricing?.currency ?? 'CNY',
      priced,
    },
    confidence: confidenceOf(compilations),
    assumptions: {
      bytesPerToken: BENEFIT_BYTES_PER_TOKEN,
      qualityBaseline: BENEFIT_QUALITY_BASELINE,
      qualityWeights: [0.25, 0.25, 0.25, 0.25],
      countedSources: ['spill', 'retention', 'prune'],
      excludedSources: ['cache'],
    },
  }
}
