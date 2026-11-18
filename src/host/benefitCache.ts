/**
 * LRU + TTL policy for the on-demand value read model.
 *
 * The value model is expensive (gateway-journal scan, benefit-history file I/O,
 * model pricing) and is requested twice in quick succession in practice: the
 * composer strip prefetches it, then the details dialog opens. AMP ships the
 * LRU entity cache used elsewhere in this plugin for compiled context; the same
 * component answers repeats here while a changed counter (or the TTL) forces a
 * fresh aggregation instead of a stale number.
 */
import { createEntityCache, type EntityCache } from 'attention-manifest-protocol/cache'
import type { ModelSelection } from './pricing.js'
import type { UsageSnapshot } from './usage.js'

/** Every input the value read model derives from; the key projects all of them. */
export interface BenefitCacheInputs {
  readonly selection: ModelSelection | undefined
  readonly compilations: number
  readonly failures: number
  readonly excluded: number
  readonly lastItems: number
  readonly tokensInjected: number
  readonly lastCompileAt: string | undefined
  readonly compilerExclusions: number
  readonly usage: UsageSnapshot
  readonly journalLength: number
}

/** Stable key: any changed counter misses instead of serving a stale read model. */
export function benefitCacheKey(input: BenefitCacheInputs): string {
  return JSON.stringify([
    input.selection?.provider ?? null,
    input.selection?.model ?? null,
    input.compilations,
    input.failures,
    input.excluded,
    input.lastItems,
    input.tokensInjected,
    input.lastCompileAt ?? null,
    input.compilerExclusions,
    input.usage.requests,
    input.usage.inputTokens,
    input.usage.cacheReadTokens,
    input.usage.cacheWriteTokens,
    input.usage.outputTokens,
    input.journalLength,
  ])
}

/** One value read model per key, bounded and expired by AMP's LRU entity cache. */
export function createBenefitCache(maxEntries = 8, ttlMilliseconds = 30_000): EntityCache {
  return createEntityCache({ maxEntries, ttlMilliseconds })
}
