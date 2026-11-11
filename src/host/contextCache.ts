/**
 * AMP context cache port for the kernel.
 *
 * `compileTurnContext` builds a fresh payload on every assembly, and AMP ships
 * a compiled-context cache (`ContextCache`: LRU + TTL, hit/eviction counters,
 * `savedTokens`). This module wires that cache in through the kernel's public
 * `KernelOverrides.context` seam, so the host keeps one AMP cache per store
 * slot instead of the previous ad-hoc `Map<string, string>` inside the
 * optimizer.
 *
 * ## Why a compile clock is remembered
 *
 * AMP's `cachedContextSignature` folds `options.now` into the cache identity
 * because `now` participates in expiry and in `compiledAt`. `compileTurnContext`
 * passes the kernel clock, which changes on every call, so passing it through
 * unchanged would miss on every assembly. The port therefore remembers the first
 * compile clock of each batch and reuses it for that batch's repeats: the
 * identity stays stable, while `compiledAt` and expiry remain the moment the
 * batch was actually assembled. The local signature below only identifies the
 * batch for that memo; AMP remains the authority on the cache key.
 *
 * Fail-open contract: a cache failure never fails a compile. Selection stays
 * with AMP's `compileContext`; this module only decides whether to reuse a
 * previously compiled payload.
 */
import { createHash } from 'node:crypto'
import type { AttentionObject } from 'attention-manifest-protocol/attention'
import { attentionPriority, compileContext, ContextCache } from 'attention-manifest-protocol/context'
// `context/index.js` does not re-export the cached compiler; the package export
// map exposes it at this deep path (`./*.js` -> `./lib/*.js`), types included.
import { compileContextCached } from 'attention-manifest-protocol/context/cached.js'
import type { ContextOperations } from 'attention-manifest-protocol/kernel'

type Compile = ContextOperations['compileContext']
type CompileOptions = Parameters<Compile>[1]
type Compiled = ReturnType<Compile>

/** Cache capacities; every bound is a deployment knob. */
export interface ContextCachePolicy {
  /** Compiled payloads retained before the least recently used is evicted. */
  readonly maxEntries: number
  /** Compiled payload tokens retained across all entries. */
  readonly maxTokens: number
  /** Milliseconds since last access after which an entry is discarded. */
  readonly ttlMilliseconds: number
}

/**
 * Instantaneous cache counters, projected from AMP's `ContextCache.stats()`.
 *
 * `hitRate` and `savedTokens` are the two numbers that justify the wiring: the
 * former shows reuse, the latter how much serialized payload was never rebuilt.
 */
export interface ContextCacheStats {
  readonly entries: number
  readonly tokens: number
  readonly bytes: number
  readonly hits: number
  readonly misses: number
  readonly evictions: number
  readonly expirations: number
  readonly hitRate: number
  readonly utilisation: number
  readonly savedTokens: number
}

/** Stable identity for a compile that ignores the wall clock; see module docs. */
function signatureOf(objects: readonly AttentionObject[], options: CompileOptions, tokenizer: string): string {  const hash = createHash('sha256')
  const scope = options.scope
  hash.update(
    JSON.stringify([
      scope.tenantId,
      scope.principalId,
      scope.sessionId,
      scope.turnId,
      scope.workspaceId ?? null,
      scope.projectId ?? null,
      tokenizer,
      [
        options.budget.tokens ?? null,
        options.budget.bytes ?? null,
        options.budget.milliseconds ?? null,
        options.budget.calls ?? null,
      ],
    ]),
    'utf8',
  )
  for (const object of objects) {
    // A summary can change without a version bump in this host (step-scoped
    // slots are re-created, but a defensive digest keeps a stale hit impossible).
    const summary = createHash('sha256').update(String(object.summary), 'utf8').digest('hex')
    hash.update(
      JSON.stringify([
        object.id,
        object.version,
        object.pointer.kind,
        object.pointer.id,
        object.pointer.version,
        object.mounted,
        object.stale,
        object.expiresAt,
        object.budget.tokens ?? null,
        object.budget.bytes ?? null,
        object.lastReason ?? null,
        summary,
      ]),
      'utf8',
    )
  }
  return hash.digest('hex')
}

/** Capacities used when a deployment (or a test fixture) omits them. */
export const DEFAULT_CONTEXT_CACHE_POLICY: ContextCachePolicy = {
  maxEntries: 128,
  maxTokens: 64_000,
  ttlMilliseconds: 300_000,
}

/** Per-batch compile clocks retained; bounded so a long session cannot grow it. */
export const MAX_COMPILE_CLOCKS = 256

/** Coerce one capacity, falling back instead of handing AMP a `NaN`. */
function capacityOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.trunc(value))
}

/**
 * One AMP `ContextCache` plus the port the kernel calls.
 *
 * The instance is per store slot: sessions in different workspaces must not
 * share entries, and closing a slot drops its cache with the kernel.
 */
export class AmpContextCache {
  private readonly cache: ContextCache
  private readonly now: () => string
  private readonly tokenizer: string
  private readonly compileClocks = new Map<string, string>()
  private failures = 0

  /**
   * @param policy - capacities and TTL; missing or invalid values fall back to
   * {@link DEFAULT_CONTEXT_CACHE_POLICY} so a partial config never breaks boot.
   * @param options - clock and the tokenizer identity folded into the signature.
   */
  constructor(policy: Partial<ContextCachePolicy> = {}, options: { now?: () => string; tokenizer?: string } = {}) {
    this.cache = new ContextCache({
      maxEntries: capacityOf(policy.maxEntries, DEFAULT_CONTEXT_CACHE_POLICY.maxEntries),
      maxTokens: capacityOf(policy.maxTokens, DEFAULT_CONTEXT_CACHE_POLICY.maxTokens),
      ttlMilliseconds: capacityOf(policy.ttlMilliseconds, DEFAULT_CONTEXT_CACHE_POLICY.ttlMilliseconds),
    })
    this.now = options.now ?? (() => new Date().toISOString())
    this.tokenizer = options.tokenizer ?? 'len4'
  }

  /** The `KernelOverrides.context` value; stable per cache instance. */
  port(): ContextOperations {
    return {
      attentionPriority,
      compileContext: (objects: readonly AttentionObject[], options: CompileOptions): Compiled => this.compile(objects, options),
    }
  }

  /**
   * Compile through AMP's cached compiler.
   *
   * AMP's cache signature folds in the compile clock, so an unchanged batch
   * would miss if we kept handing it the live one. The first assembly of a batch
   * remembers its clock; repeats reuse it, which is both stable for the
   * signature and semantically right — `compiledAt` and expiry are evaluated at
   * the time that batch was first assembled.
   *
   * Host invariant: an attention object's summary is immutable for a given
   * `(id, version)`; a content change bumps the version. AMP's signature covers
   * the version, so it is sound here. Any failure of the cache layer falls back
   * to the plain compiler — a compile never fails because the cache did.
   */
  compile(objects: readonly AttentionObject[], options: CompileOptions): Compiled {
    const cacheNow = this.now()
    let compileNow = options.now
    try {
      const key = signatureOf(objects, options, this.tokenizer)
      const remembered = this.compileClocks.get(key)
      if (remembered === undefined) {
        this.compileClocks.set(key, compileNow)
        while (this.compileClocks.size > MAX_COMPILE_CLOCKS) {
          const oldest = this.compileClocks.keys().next().value
          if (typeof oldest !== 'string') break
          this.compileClocks.delete(oldest)
        }
      } else {
        compileNow = remembered
      }
    } catch {
      this.failures += 1
    }
    try {
      const cached = compileContextCached(this.cache, objects, { ...options, now: compileNow }, cacheNow)
      return cached.context
    } catch {
      this.failures += 1
      return compileContext(objects, options)
    }
  }

  /** Counters for `/amp/context`; never throws. */
  stats(): ContextCacheStats & { failures: number } {
    try {
      const stats = this.cache.stats()
      return {
        entries: stats.entries,
        tokens: stats.tokens,
        bytes: stats.bytes,
        hits: stats.hits,
        misses: stats.misses,
        evictions: stats.evictions,
        expirations: stats.expirations,
        hitRate: stats.hitRate,
        utilisation: stats.utilisation,
        savedTokens: stats.savedTokens,
        failures: this.failures,
      }
    } catch {
      return {
        entries: 0,
        tokens: 0,
        bytes: 0,
        hits: 0,
        misses: 0,
        evictions: 0,
        expirations: 0,
        hitRate: 0,
        utilisation: 0,
        savedTokens: 0,
        failures: this.failures + 1,
      }
    }
  }

  /** Drop every entry; used when the deployment disables optimization. */
  clear(): void {
    try {
      this.cache.clear()
    } catch {
      this.failures += 1
    }
  }

  /** Drop one session's entries; O(entries), so callers batch it. */
  evictSession(sessionId: string): number {
    try {
      return this.cache.invalidateWhere((entry) => entry.context.scope.sessionId === sessionId)
    } catch {
      this.failures += 1
      return 0
    }
  }
}
