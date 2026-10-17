/**
 * Cache optimizer (v23 §5).
 *
 * DeepSeek's prompt cache works in 64-token blocks, all-or-nothing, so a single
 * volatile prefix byte invalidates every block after it. This module performs
 * only the optimizations v23 §5.4 permits — stable message ordering, volatile
 * fragment normalisation, a content fingerprint, effort-change detection, and
 * usage accounting — and deliberately does *not* translate `reasoningEffort`
 * into provider parameters (that is the DSH adapter's job, v23 §4.4).
 *
 * Numbers are not estimated: cache hits and misses are whatever DSH's
 * `TokenUsage` reported, and `estimatedSavings` stays `0` because DSH owns
 * pricing (v23 §5.2: "cacheHits/cacheMisses come from DSH, not from
 * Coordination's own estimate").
 */
import { createHash } from 'node:crypto'
import { clamp, round } from './module.js'
import type { ModuleHost } from './module.js'
import type { CacheStrategy } from '../shared/entity.js'
import type { CacheStats, GenerateOptionsLike, MessageLike } from '../shared/service.js'
import { DEFAULT_CACHE_STRATEGY } from './provider.js'

/**
 * Volatile fragments that move a 64-token block boundary between two
 * otherwise-identical requests. Each pattern is deterministic: the same input
 * always yields the same output, and each fragment is replaced by a stable
 * placeholder rather than deleted, so the surrounding bytes keep their
 * positions. The patterns are deliberately narrow — no pattern removes prose,
 * code, or message structure, and nothing outside this list is touched.
 *
 * 1. ISO-8601 timestamps (`2026-01-02`, `2026-01-02T03:04:05.678Z`,
 *    `2026-01-02 03:04:05+08:00`) → `<timestamp>`.
 * 2. UUIDs → `<uuid>`.
 * 3. Long hex runs (32+ hex characters: request ids, content hashes) → `<hex>`.
 * 4. The *value* of a "current time is …" clause → `current time is <time>`,
 *    stopping at the clause boundary so the rest of the sentence survives.
 *
 * A timestamp a user typed is normalised too; that is intentional: a request
 * that echoes the clock must not move the cache prefix.
 */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi
const CURRENT_TIME = /\bcurrent time is[ \t]+[^.;\n]*/gi

const TIMESTAMP_PLACEHOLDER = '<timestamp>'
const UUID_PLACEHOLDER = '<uuid>'
const HEX_PLACEHOLDER = '<hex>'
const TIME_PLACEHOLDER = 'current time is <time>'

/**
 * Added to a decorated request when the provider breaks its cache on an effort
 * switch (v23 §5.3 rule 2). `decorate()` has no session identity, so it cannot
 * claim that *this* request changed the effort; it reports the provider-level
 * policy. `checkEffortCacheBreak(session, …)` is the authoritative detector for
 * a per-session change.
 */
const EFFORT_WARNING =
  'reasoningEffort changes invalidate this provider\'s prompt cache; keep the effort stable across a session'

interface CacheStatRow {
  requests?: unknown
  hits?: unknown
  misses?: unknown
  effortBreaks?: unknown
}

/** One request's usage as reported by DSH (`TokenUsage`). */
export interface UsageRecord {
  inputTokens?: number
  cacheReadTokens?: number
}

/**
 * Stable-prefix decorator and usage accountant for one coordination session.
 *
 * All ordering and stripping helpers are pure and provider-independent; the
 * policy argument is accepted for contract symmetry and for the eventual
 * provider-specific rules, but the fixed-prefix rule of v23 §5.3 applies to
 * every family this table describes. `decorate()` honours `config.cache.enabled`
 * and `config.cache.effortWarning`; the stateless helpers do not consult config.
 * Effort tracking and usage accounting also ignore the optimizer switch: the
 * switch disables request decoration, not measurement of what DSH reported.
 */
export class CacheModule {
  private readonly host: ModuleHost
  /** Last effort observed per coordination session identity. */
  private readonly efforts = new Map<number, string>()

  constructor(host: ModuleHost) {
    this.host = host
  }

  /**
   * Stable partition: `system`, then `developer`, then every other message in
   * its original relative order. Nothing is dropped, merged or rewritten and
   * the input array is not mutated. The rule is provider-independent, so
   * `strategy` is intentionally not used here.
   */
  reorderMessages(messages: MessageLike[], _strategy: CacheStrategy): MessageLike[] {
    const rank = (message: MessageLike): number => {
      const role = typeof message.role === 'string' ? message.role.toLowerCase() : ''
      if (role === 'system') return 0
      if (role === 'developer') return 1
      return 2
    }
    return messages
      .map((message, index) => ({ message, index }))
      .sort((left, right) => rank(left.message) - rank(right.message) || left.index - right.index)
      .map((entry) => entry.message)
  }

  /** Replace the volatile fragments documented above with stable placeholders. */
  stripDynamicContent(text: string): string {
    return text
      .replace(ISO_TIMESTAMP, TIMESTAMP_PLACEHOLDER)
      .replace(UUID, UUID_PLACEHOLDER)
      .replace(LONG_HEX, HEX_PLACEHOLDER)
      .replace(CURRENT_TIME, TIME_PLACEHOLDER)
  }

  /**
   * SHA-256 over the canonical JSON of each message's `role` and `content`.
   *
   * Object keys are sorted recursively and absent values are treated like JSON
   * absence, so two structurally equal requests fingerprint identically no
   * matter how their object literals were ordered. The digest is hexadecimal
   * and lowercase.
   */
  fingerprint(messages: MessageLike[]): string {
    const body = `[${messages
      .map((message) => `[${jsonLiteral(String(message.role))},${canonical(message.content)}]`)
      .join(',')}]`
    return createHash('sha256').update(body).digest('hex')
  }

  /**
   * Record a new effort for a session and report whether it breaks the cache.
   *
   * The first effort observed for a session is not a change. The new effort is
   * recorded even when it does not break the cache, and a break is counted in
   * `cache_stat.effortBreaks` (upserted per session) only when the strategy says
   * the provider's cache key includes effort. An omitted strategy uses the
   * conservative `DEFAULT_CACHE_STRATEGY`.
   */
  checkEffortCacheBreak(session: number, newEffort: string, strategy?: CacheStrategy): boolean {
    const effective = strategy ?? DEFAULT_CACHE_STRATEGY
    const previous = this.efforts.get(session)
    const now = this.host.clock.now()
    this.efforts.set(session, newEffort)
    if (previous === undefined || previous === newEffort) return false
    if (!effective.effortCacheBreak) return false
    this.host.db.run(
      `INSERT INTO cache_stat (session, requests, hits, misses, effortBreaks, created, changed)
       VALUES (?, 0, 0, 0, 1, ?, ?)
       ON CONFLICT(session) DO UPDATE SET
         effortBreaks = effortBreaks + 1,
         changed = excluded.changed`,
      session,
      now,
      now,
    )
    return true
  }

  /**
   * Account one request from DSH's `TokenUsage`.
   *
   * `requests` increments by one, `hits` by the reported `cacheReadTokens`, and
   * `misses` by `max(0, inputTokens - cacheReadTokens)` — the uncached part of
   * the prompt. No token count is estimated; a request without usage still
   * counts as a request.
   */
  recordUsage(session: number, usage: UsageRecord): void {
    const hits = tokenCount(usage.cacheReadTokens)
    const misses = Math.max(0, tokenCount(usage.inputTokens) - hits)
    const now = this.host.clock.now()
    this.host.db.run(
      `INSERT INTO cache_stat (session, requests, hits, misses, effortBreaks, created, changed)
       VALUES (?, 1, ?, ?, 0, ?, ?)
       ON CONFLICT(session) DO UPDATE SET
         requests = requests + 1,
         hits = hits + excluded.hits,
         misses = misses + excluded.misses,
         changed = excluded.changed`,
      session,
      hits,
      misses,
      now,
      now,
    )
  }

  /**
   * The session's cache statistics, read from `cache_stat`.
   *
   * `hitRate` is `cacheHits / (cacheHits + cacheMisses)`, clamped to `[0, 1]`
   * and rounded to four decimals; a session with no measured tokens reports
   * `0`. `estimatedSavings` is always `0`: the field is part of the contract
   * (v23 §5.2) but DSH owns pricing, so Coordination does not estimate cost.
   */
  stats(session: number): CacheStats {
    const row = this.host.db.get<CacheStatRow>('SELECT * FROM cache_stat WHERE session = ?', session)
    const totalRequests = count(row?.requests)
    const cacheHits = count(row?.hits)
    const cacheMisses = count(row?.misses)
    const effortBreaks = count(row?.effortBreaks)
    const measured = cacheHits + cacheMisses
    return {
      totalRequests,
      cacheHits,
      cacheMisses,
      hitRate: measured === 0 ? 0 : round(clamp(cacheHits / measured, 0, 1), 4),
      estimatedSavings: 0,
      effortBreaks,
    }
  }

  /**
   * Return a decorated copy of a generation request: fixed content first, then
   * the same messages in order with volatile fragments normalised.
   *
   * Every other field is preserved by reference and `reasoningEffort` is passed
   * through exactly as given — this decorator is not a parameter adapter (v23
   * §5.4). The input object and its messages are never mutated. When
   * `config.cache.effortWarning` is on and the strategy says effort changes
   * break the cache, a plain `cacheWarning` string is added; the index
   * signature of `GenerateOptionsLike` allows the extra key.
   */
  decorate(options: GenerateOptionsLike, strategy: CacheStrategy): GenerateOptionsLike {
    const messages = Array.isArray(options.messages) ? options.messages : []
    if (!this.host.config.cache.enabled) return { ...options, messages: [...messages] }
    const ordered = this.reorderMessages(messages, strategy).map((message) =>
      typeof message.content === 'string'
        ? { ...message, content: this.stripDynamicContent(message.content) }
        : { ...message },
    )
    const decorated: GenerateOptionsLike = { ...options, messages: ordered }
    const effort = options.reasoningEffort
    if (
      this.host.config.cache.effortWarning &&
      strategy.effortCacheBreak &&
      typeof effort === 'string' &&
      effort.length > 0
    ) {
      decorated.cacheWarning = EFFORT_WARNING
    }
    return decorated
  }
}

/** Canonical JSON text: keys sorted, `undefined` treated like JSON absence. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return jsonLiteral(value)
  }
  if (typeof value === 'bigint') return jsonLiteral(String(value))
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const fields = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${jsonLiteral(key)}:${canonical(record[key])}`)
    return `{${fields.join(',')}}`
  }
  // Functions and symbols do not survive a JSON round trip.
  return 'null'
}

function jsonLiteral(value: string | number | boolean): string {
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}
