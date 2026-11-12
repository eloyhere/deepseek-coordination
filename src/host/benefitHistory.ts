/**
 * Durable, cumulative benefit ledger.
 *
 * The live counters in the context optimizer are per-process: a DSH restart
 * resets spill/prune/compile counters to zero. That made the value panel look
 * empty even though the workspace already had a long history. This ledger keeps
 * high-water marks on disk and merges them with the live counters, so a restart
 * cannot erase what the plugin already saved.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BenefitInput } from './benefits.js'
import type { ErrorSummary } from './effectiveness.js'

/** One observed snapshot, reduced to the counters that are meaningful to keep. */
export interface BenefitHistory {
  readonly version: 1
  readonly saved: number
  readonly spill: number
  readonly retention: number
  readonly prune: number
  readonly contextPrune: number
  readonly compaction: number
  readonly cacheReuse: number
  readonly injected: number
  readonly contextPruneRecords: number
  readonly compactionRecords: number
  readonly compilations: number
  readonly failures: number
  readonly pruneReviews: number
  readonly pruneVerified: number
  readonly pruneFailed: number
  readonly errorCalls: number
  readonly errorFailures: number
  readonly errorP95DurationMs: number
  readonly updatedAt: string
}

export const BENEFIT_HISTORY_FILE = 'benefit-history.json'

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function maximum(...values: unknown[]): number {
  let best = 0
  for (const value of values) best = Math.max(best, count(value))
  return best
}

/** Parse without throwing; an unreadable ledger is simply absent. */
export function loadBenefitHistory(file: string): BenefitHistory | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return null
    return {
      version: 1,
      saved: count(parsed.saved),
      spill: count(parsed.spill),
      retention: count(parsed.retention),
      prune: count(parsed.prune),
      contextPrune: count(parsed.contextPrune),
      compaction: count(parsed.compaction),
      cacheReuse: count(parsed.cacheReuse),
      injected: count(parsed.injected),
      contextPruneRecords: count(parsed.contextPruneRecords),
      compactionRecords: count(parsed.compactionRecords),
      compilations: count(parsed.compilations),
      failures: count(parsed.failures),
      pruneReviews: count(parsed.pruneReviews),
      pruneVerified: count(parsed.pruneVerified),
      pruneFailed: count(parsed.pruneFailed),
      errorCalls: count(parsed.errorCalls),
      errorFailures: count(parsed.errorFailures),
      errorP95DurationMs: count(parsed.errorP95DurationMs),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  } catch {
    return null
  }
}

/** Atomic best-effort write; a read-only workspace must not fail the route. */
export function saveBenefitHistory(file: string, history: BenefitHistory): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  } catch {
    // History is an optimization; never fail a context request because of it.
  }
}

/**
 * Merge live counters with the high-water ledger.
 *
 * Every live counter is monotonic within one process and resets at startup, so
 * per-field maxima is the correct union: no double counting across requests.
 */
export function mergeBenefitInput(input: BenefitInput, history: BenefitHistory | null): BenefitInput {
  if (history === null) return input
  const prune = input.prune ?? {}
  const outputs = input.outputs ?? {}
  const spill = outputs.spill ?? {}
  const retention = outputs.retention ?? {}
  const contextPrune = outputs.prune ?? {}
  const compaction = outputs.compaction ?? {}
  return {
    ...input,
    compilations: maximum(input.compilations, history.compilations),
    failures: maximum(input.failures, history.failures),
    tokensInjected: maximum(input.tokensInjected, history.injected),
    prune: {
      ...prune,
      savedTokens: maximum(prune.savedTokens, history.prune),
      reviews: maximum(prune.reviews, history.pruneReviews),
      verified: maximum(prune.verified, history.pruneVerified),
      failed: maximum(prune.failed, history.pruneFailed),
    },
    outputs: {
      ...outputs,
      // Byte fields are converted back from the ledger's token counts. The
      // conversion constant is documented on `computeBenefits`.
      spill: { ...spill, bytes: maximum(spill.bytes, history.spill * 4) },
      retention: { ...retention, omittedBytes: maximum(retention.omittedBytes, history.retention * 4) },
      prune: {
        ...contextPrune,
        records: maximum(contextPrune.records, history.contextPruneRecords),
        shadowedTokens: maximum(contextPrune.shadowedTokens, history.contextPrune),
      },
      compaction: {
        ...compaction,
        records: maximum(compaction.records, history.compactionRecords),
        shadowedTokens: maximum(compaction.shadowedTokens, history.compaction),
      },
    },
  }
}

/** Merge the live gateway error sample with its historical high-water marks. */
export function mergeErrorHistory(errors: ErrorSummary, history: BenefitHistory | null): ErrorSummary {
  if (history === null) return errors
  const calls = maximum(errors.calls, history.errorCalls)
  const failures = Math.min(calls, maximum(errors.failures, history.errorFailures))
  const p95 = maximum(errors.p95DurationMs, history.errorP95DurationMs)
  const target = errors.durationTargetMs > 0 ? errors.durationTargetMs : 250
  const errorRate = calls === 0 ? 0 : failures / calls
  return {
    ...errors,
    available: calls > 0,
    calls,
    failures,
    errorRate,
    errorFree: Math.max(0, Math.min(100, 100 * (1 - errorRate))),
    p95DurationMs: p95,
    durationScore: p95 <= 0 ? 50 : Math.max(0, Math.min(100, (100 * target) / p95)),
  }
}

/** Build the next ledger from the merged snapshot. */
export function historyFromBenefits(
  benefits: {
    readonly tokens: {
      readonly saved: number
      readonly spill: number
      readonly retention: number
      readonly prune: number
      readonly contextPrune: number
      readonly compaction: number
      readonly cacheReuse: number
      readonly injected: number
      readonly contextPruneRecords: number
      readonly compactionRecords: number
    }
    readonly quality: { readonly samples: number } | null
  },
  errors: ErrorSummary,
  failures: number,
  now = new Date(),
  prune: { readonly reviews?: number; readonly verified?: number; readonly failed?: number } = {},
): BenefitHistory {
  return {
    version: 1,
    saved: count(benefits.tokens.saved),
    spill: count(benefits.tokens.spill),
    retention: count(benefits.tokens.retention),
    prune: count(benefits.tokens.prune),
    contextPrune: count(benefits.tokens.contextPrune),
    compaction: count(benefits.tokens.compaction),
    cacheReuse: count(benefits.tokens.cacheReuse),
    injected: count(benefits.tokens.injected),
    contextPruneRecords: count(benefits.tokens.contextPruneRecords),
    compactionRecords: count(benefits.tokens.compactionRecords),
    compilations: count(benefits.quality?.samples),
    failures: count(failures),
    pruneReviews: count(prune.reviews),
    pruneVerified: count(prune.verified),
    pruneFailed: count(prune.failed),
    errorCalls: count(errors.calls),
    errorFailures: count(errors.failures),
    errorP95DurationMs: count(errors.p95DurationMs),
    updatedAt: now.toISOString(),
  }
}

/**
 * Combine ledgers from several storage roots (user storage and the workspace
 * root can both answer early in a process). The union is per-field maxima, so
 * neither copy can erase the other.
 */
export function mergeHistories(histories: readonly (BenefitHistory | null)[]): BenefitHistory | null {
  let merged: BenefitHistory | null = null
  for (const history of histories) {
    if (history === null) continue
    if (merged === null) {
      merged = { ...history }
      continue
    }
    merged = {
      version: 1,
      saved: maximum(merged.saved, history.saved),
      spill: maximum(merged.spill, history.spill),
      retention: maximum(merged.retention, history.retention),
      prune: maximum(merged.prune, history.prune),
      contextPrune: maximum(merged.contextPrune, history.contextPrune),
      compaction: maximum(merged.compaction, history.compaction),
      cacheReuse: maximum(merged.cacheReuse, history.cacheReuse),
      injected: maximum(merged.injected, history.injected),
      contextPruneRecords: maximum(merged.contextPruneRecords, history.contextPruneRecords),
      compactionRecords: maximum(merged.compactionRecords, history.compactionRecords),
      compilations: maximum(merged.compilations, history.compilations),
      failures: maximum(merged.failures, history.failures),
      pruneReviews: maximum(merged.pruneReviews, history.pruneReviews),
      pruneVerified: maximum(merged.pruneVerified, history.pruneVerified),
      pruneFailed: maximum(merged.pruneFailed, history.pruneFailed),
      errorCalls: maximum(merged.errorCalls, history.errorCalls),
      errorFailures: maximum(merged.errorFailures, history.errorFailures),
      errorP95DurationMs: maximum(merged.errorP95DurationMs, history.errorP95DurationMs),
      updatedAt: merged.updatedAt > history.updatedAt ? merged.updatedAt : history.updatedAt,
    }
  }
  return merged
}

/** True when the ledger changed enough to need a write. */
export function historyChanged(a: BenefitHistory | null, b: BenefitHistory): boolean {
  if (a === null) return true
  for (const key of ['saved', 'spill', 'retention', 'prune', 'contextPrune', 'compaction', 'cacheReuse', 'injected', 'contextPruneRecords', 'compactionRecords', 'compilations', 'failures', 'errorCalls', 'errorFailures', 'errorP95DurationMs'] as const) {
    if (a[key] !== b[key]) return true
  }
  return a.pruneReviews !== b.pruneReviews || a.pruneVerified !== b.pruneVerified || a.pruneFailed !== b.pruneFailed
}
