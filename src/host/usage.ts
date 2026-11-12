/**
 * Token usage accumulated from DSH `assistant/message` events.
 *
 * The adapter reports cache reads and writes separately from ordinary input:
 * `inputTokens` is the uncached portion, `cacheReadTokens` the provider's
 * prompt-cache hit, and `cacheWriteTokens` the cache creation. The hit rate is
 * therefore `cacheRead / (input + cacheRead + cacheWrite)`. Providers that do
 * not report cache fields leave the rate at zero, which prices every avoided
 * input token at the miss rate instead of inventing a discount.
 */

export interface UsageSnapshot {
  readonly requests: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly totalInputTokens: number
  /** Cache-read share of all input tokens, in [0, 1]. */
  readonly hitRate: number
}

const EMPTY: UsageSnapshot = {
  requests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  totalInputTokens: 0,
  hitRate: 0,
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Mutable totals for one provider/model key. */
class Totals {
  requests = 0
  inputTokens = 0
  cacheReadTokens = 0
  cacheWriteTokens = 0
  outputTokens = 0

  add(usage: Record<string, unknown>): void {
    this.requests += 1
    this.inputTokens += count(usage.inputTokens)
    this.cacheReadTokens += count(usage.cacheReadTokens)
    this.cacheWriteTokens += count(usage.cacheWriteTokens)
    this.outputTokens += count(usage.outputTokens)
  }

  snapshot(): UsageSnapshot {
    const totalInputTokens = this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens
    return {
      requests: this.requests,
      inputTokens: this.inputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      outputTokens: this.outputTokens,
      totalInputTokens,
      hitRate: totalInputTokens === 0 ? 0 : this.cacheReadTokens / totalInputTokens,
    }
  }
}

/** Bounded per-route usage ledger; the active route is read, the rest is history. */
export class UsageLedger {
  private readonly byRoute = new Map<string, Totals>()

  /** Record one assistant message's usage for a provider/model pair. */
  record(provider: string | undefined, model: string | undefined, usage: unknown): void {
    if (typeof usage !== 'object' || usage === null) return
    const key = `${provider ?? ''}\u0000${model ?? ''}`
    let totals = this.byRoute.get(key)
    if (totals === undefined) {
      totals = new Totals()
      this.byRoute.set(key, totals)
      // Keep the ledger bounded when a user switches models repeatedly.
      if (this.byRoute.size > 16) {
        const oldest = this.byRoute.keys().next().value
        if (typeof oldest === 'string' && oldest !== key) this.byRoute.delete(oldest)
      }
    }
    totals.add(usage as Record<string, unknown>)
  }

  /** Totals for one route, or an empty snapshot. */
  snapshot(provider?: string, model?: string): UsageSnapshot {
    return this.byRoute.get(`${provider ?? ''}\u0000${model ?? ''}`)?.snapshot() ?? EMPTY
  }
}
