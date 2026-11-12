/**
 * Compaction channel: `CompactionRecord` bookkeeping and the AMP backend seam.
 *
 * DSH emits `compaction/start`, `compaction/summary` and `compaction/end` as
 * log-only session events around one surface replacement. This module folds
 * that lifecycle into bounded, idempotent records and projects the finished
 * ones into compaction-channel attention items. It never appends compaction
 * events, never calls `recordReceipt()`/`recordEvidence()` and never treats a
 * summary as verified business state.
 *
 * `AmpCompactionBackend` is the optional P4 composition seam: it extends
 * `CompactionEngine` and forwards the three abstract operations to a real
 * backend without summarizing anything itself. Registering it is deliberately
 * left to the composition that replaces the base `ctx.compaction` service.
 */
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { asRecord } from './json.js'
import { scopeOf, sessionExpiry } from './channels/shared.js'
import { wireId } from './wire.js'
import type { WireItem } from './wire.js'

/** Maximum compaction records retained per session. */
export const MAX_COMPACTION_RECORDS = 64

/** Open lifecycles retained while waiting for their summary/end event. */
const MAX_OPEN_COMPACTIONS = 64

/** Stored summary text is bounded; the digest still covers the full text. */
const MAX_SUMMARY_CHARS = 2000

/** The surface-position range that was shadowed. */
export interface CompactionShadowedRange {
  readonly start: number
  readonly end: number
}

/**
 * One completed compaction, keyed by `compactionId`.
 *
 * This mirrors the `compaction/summary` payload (summary text joined from its
 * content blocks, shadowed range/seqs, token count, provider/model/usage and
 * source command) plus the enclosing `compaction/start`/`compaction/end` seqs.
 * `summaryDigest` covers the full joined summary even though `summary` is
 * bounded; `error` is the unsuccessful attempt's message when the `end` event
 * carried one.
 */
export interface CompactionRecord {
  readonly compactionId: string
  readonly sessionId: string
  readonly startSeq: number
  readonly summarySeq: number
  readonly endSeq?: number
  readonly summary: string
  readonly summaryDigest: string
  readonly shadowedRange: CompactionShadowedRange
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly provider: string
  readonly model: string
  readonly usage?: Readonly<Record<string, unknown>>
  readonly sourceCommandId?: string
  readonly error?: string
  readonly at: string
}

/** Bounded status view for diagnostics and `/amp/context`. */
export interface CompactionStatus {
  readonly sessions: number
  readonly records: number
  readonly open: number
  readonly observed: number
  readonly starts: number
  readonly summaries: number
  readonly ends: number
  readonly failures: number
  /** Sum of compacted ranges' original token counts; display-only. */
  readonly shadowedTokens: number
}

interface OpenCompaction {
  readonly sessionId: string
  readonly compactionId: string
  readonly startSeq: number
  readonly sourceCommandId?: string
}

interface CompactionCounters {
  observed: number
  starts: number
  summaries: number
  ends: number
  failures: number
}

/** Read a finite non-negative integer, or `undefined`. */
function seqOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Read a numeric seq list, dropping malformed members instead of throwing. */
function seqListOf(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seqs: number[] = []
  for (const entry of value) {
    const seq = seqOf(entry)
    if (seq !== undefined) seqs.push(seq)
  }
  return seqs
}

/** Read a non-empty string, or `undefined`. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Join the `text` blocks of a content-block array into one summary string. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const raw of value) {
    const block = asRecord(raw)
    if (block === undefined) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Stable digest of the full summary text: `sha256:<64 hex>`. */
function digestOf(text: string): string {
  try {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
  } catch {
    return 'sha256:'
  }
}

/** One-line summary for the wire item; never the full content blocks. */
function itemSummary(record: CompactionRecord): string {
  return `compacted ${record.shadowedSeqs.length} events into a summary (${record.shadowedTokenCount} tokens); detail at seq ${record.summarySeq}`
}

/** Map key; NUL cannot occur in a session id or a compaction brand id. */
function keyOf(sessionId: string, compactionId: string): string {
  return `${sessionId}\u0000${compactionId}`
}

/**
 * Fold the `compaction/*` lifecycle into bounded records.
 *
 * Observation is idempotent by `compactionId`: a repeated `compaction/start`
 * does not move the recorded start seq, and a repeated `compaction/summary`
 * does not replace an existing record. A compaction that ends without a
 * summary leaves no record (and therefore no attention item), matching
 * wire.md's "summary failure creates no record" rule.
 */
export class CompactionTracker {
  private readonly recordsById = new Map<string, CompactionRecord>()
  private readonly open = new Map<string, OpenCompaction>()
  private readonly turns = new Map<string, number>()
  private readonly counters: CompactionCounters = { observed: 0, starts: 0, summaries: 0, ends: 0, failures: 0 }

  /**
   * Observe one session event.
   *
   * @param sessionId - owning session.
   * @param event - a `SessionEvent` or a plain fixture with `type`/`data`.
   */
  observe(sessionId: string, event: unknown): void {
    try {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const record = asRecord(event)
      if (record === undefined) return
      const type = record.type
      const data = asRecord(record.data)
      if (typeof type !== 'string' || data === undefined) return
      this.observeTurn(sessionId, data)
      const compactionId = stringOf(data.compactionId)
      if (compactionId === undefined) return
      this.counters.observed += 1
      const seq = seqOf(record.seq)
      switch (type) {
        case 'compaction/start': {
          if (seq === undefined) return
          const key = keyOf(sessionId, compactionId)
          if (!this.open.has(key)) {
            const sourceCommandId = stringOf(data.sourceCommandId)
            this.open.set(key, {
              sessionId,
              compactionId,
              startSeq: seq,
              ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
            })
          }
          while (this.open.size > MAX_OPEN_COMPACTIONS) {
            const oldest = this.open.keys().next().value
            if (typeof oldest !== 'string') break
            this.open.delete(oldest)
          }
          this.counters.starts += 1
          return
        }
        case 'compaction/summary': {
          this.recordSummary(sessionId, compactionId, data, seq)
          return
        }
        case 'compaction/end': {
          this.finish(sessionId, compactionId, data, seq)
          return
        }
        default:
          return
      }
    } catch {
      this.counters.failures += 1
    }
  }

  /**
   * Records in observation order.
   *
   * @param sessionId - optional session filter; omitted reads every session.
   */
  records(sessionId?: string): readonly CompactionRecord[] {
    const records = [...this.recordsById.values()]
    return sessionId === undefined ? records : records.filter((record) => record.sessionId === sessionId)
  }

  /**
   * Project this session's compactions into wire items.
   *
   * The id carries the latest observed turn, because AMP reuses an object by
   * id and excludes a scope whose turn no longer matches. The optimizer
   * appends the step suffix and replaces `scope` with the live compile scope.
   * A record whose summary projection is empty yields no item.
   *
   * @param agent - the agent whose session is being compiled.
   * @returns compaction-channel items, possibly empty.
   */
  itemsFor(agent: Agent): readonly WireItem[] {
    const sessionId = asRecord(agent)?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return []
    const records = this.records(sessionId)
    if (records.length === 0) return []
    // AMP reuses an object by id and the compiler excludes a scope whose turn
    // no longer matches, so the id carries the current turn.
    const turn = this.turns.get(sessionId) ?? 0
    const scope = scopeOf(agent, sessionId, turn)
    const expiresAt = sessionExpiry()
    const items: WireItem[] = []
    for (const record of records) {
      try {
        if (record.summary.length === 0) continue
        items.push({
          id: wireId('compaction', sessionId, turn, `compaction-${record.summarySeq}`),
          channel: 'compaction',
          scope: { ...scope },
          pointer: { kind: 'compaction', id: String(record.summarySeq), version: '1' },
          summary: itemSummary(record),
          scores: { relevance: 0.8, urgency: 0.5, confidence: 0.9, importance: 0.9 },
          budget: { tokens: 400 },
          expiresAt,
          reason: 'a history range was compacted into a summary',
          trust: 'host',
        })
      } catch {
        this.counters.failures += 1
      }
    }
    return items
  }

  /** Bounded status for diagnostics; never throws. */
  status(): CompactionStatus {
    let shadowedTokens = 0
    for (const record of this.recordsById.values()) shadowedTokens += record.shadowedTokenCount
    return {
      sessions: new Set([...this.recordsById.values()].map((record) => record.sessionId)).size,
      records: this.recordsById.size,
      open: this.open.size,
      observed: this.counters.observed,
      starts: this.counters.starts,
      summaries: this.counters.summaries,
      ends: this.counters.ends,
      failures: this.counters.failures,
      shadowedTokens,
    }
  }

  /** Retain the latest turn number so item ids stay turn-qualified. */
  private observeTurn(sessionId: string, data: Record<string, unknown>): void {
    const turn = data.turn
    if (typeof turn === 'number' && Number.isInteger(turn) && turn >= 0) this.turns.set(sessionId, turn)
  }

  /** Create one record from a summary payload; repeated summaries are ignored. */
  private recordSummary(sessionId: string, compactionId: string, data: Record<string, unknown>, seq: number | undefined): void {
    const key = keyOf(sessionId, compactionId)
    if (this.recordsById.has(key)) return
    const open = this.open.get(key)
    const summarySeq = seq ?? open?.startSeq
    if (summarySeq === undefined) return
    const range = asRecord(data.shadowedRange)
    const start = seqOf(range?.start)
    const end = seqOf(range?.end)
    if (start === undefined || end === undefined) return
    const fullSummary = contentText(data.summary)
    const summary = fullSummary.length > MAX_SUMMARY_CHARS
      ? `${fullSummary.slice(0, MAX_SUMMARY_CHARS)}…`
      : fullSummary
    const sourceCommandId = stringOf(data.sourceCommandId) ?? open?.sourceCommandId
    const usage = asRecord(data.usage)
    const record: CompactionRecord = {
      compactionId,
      sessionId,
      startSeq: open?.startSeq ?? summarySeq,
      summarySeq,
      summary,
      summaryDigest: digestOf(fullSummary),
      shadowedRange: { start, end },
      shadowedSeqs: seqListOf(data.shadowedSeqs),
      shadowedTokenCount: seqOf(data.shadowedTokenCount) ?? 0,
      provider: stringOf(data.provider) ?? '',
      model: stringOf(data.model) ?? '',
      ...(usage === undefined ? {} : { usage }),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      at: new Date().toISOString(),
    }
    this.recordsById.set(key, record)
    this.evict(sessionId)
    this.counters.summaries += 1
  }

  /** Attach `endSeq`/`error` to a completed record; failed compactions keep none. */
  private finish(sessionId: string, compactionId: string, data: Record<string, unknown>, seq: number | undefined): void {
    const key = keyOf(sessionId, compactionId)
    this.open.delete(key)
    const record = this.recordsById.get(key)
    if (record === undefined) return
    const error = stringOf(data.error)
    this.recordsById.set(key, {
      ...record,
      ...(seq === undefined ? {} : { endSeq: seq }),
      ...(error === undefined ? {} : { error }),
    })
    this.counters.ends += 1
  }

  /** Evict the oldest record of one session beyond the per-session cap. */
  private evict(sessionId: string): void {
    const keys = [...this.recordsById.entries()]
      .filter(([, record]) => record.sessionId === sessionId)
      .map(([key]) => key)
    while (keys.length > MAX_COMPACTION_RECORDS) {
      const oldest = keys.shift()
      if (oldest !== undefined) this.recordsById.delete(oldest)
    }
  }
}
