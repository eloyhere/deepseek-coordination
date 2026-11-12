/**
 * Retention channel: the host-side ledger of what a retainer omitted.
 *
 * DSH's `@deepseek-ai/dsh-output-retention` retainers bound a tool result
 * before it reaches the model and append a neutral notice such as
 * `Omitted 12 items.` or `Omitted 4096 bytes.`. Retention is a budget fact, not
 * a semantic judgment: wire.md §5.7 gives it no attention channel (channel
 * `retention` has `tokens: 0`), so this module never creates a wire item. It
 * records the omission in a bounded ledger and exposes host-side exclusions so
 * `/amp/context` can report retention separately from compiler exclusions.
 *
 * A spill notice also starts with `Omitted N bytes.`; that clause is followed
 * by `Full formatted result stored at:` and belongs to the spill channel, so
 * `parseRetentionNotice` skips it instead of double-counting the same event.
 */
import type { Omitted } from '@deepseek-ai/dsh-output-retention'
import { asRecord } from './json.js'
import { textOfMessage } from './channels/shared.js'
import type { WireExclusion } from './wire.js'

/** Maximum retention records retained in the ledger. */
export const MAX_RETENTION_RECORDS = 200

/** Longest text scanned for a notice, in characters. */
const MAX_SCAN_CHARS = 32 * 1024

/** How a retainer bounded the result. */
export type RetentionStrategy = 'head' | 'tail' | 'headTail'

/**
 * What was omitted.
 *
 * The `none`/`exact`/`unknown` variants are the library's {@link Omitted};
 * `bytes` is wire.md §4.6's byte-oriented retention variant. `unknown` is
 * recorded as-is — a caller must not turn it into a fabricated count.
 */
export type RetentionOmitted =
  | Omitted
  | { readonly kind: 'bytes'; readonly bytes: number }

/** One retention outcome, keyed by tool-call id. */
export interface RetentionRecord {
  readonly callId: string
  readonly tool: string
  readonly scope: string
  readonly strategy: RetentionStrategy
  readonly limit: number
  readonly kept: number
  readonly omitted: RetentionOmitted
  readonly at: string
}

/** The unit and exact count parsed from a retention notice. */
export interface ParsedRetentionNotice {
  readonly unit: 'items' | 'bytes'
  readonly count: number
}

/** Bounded status view for diagnostics and `/amp/context`. */
export interface RetentionStatus {
  readonly records: number
  readonly maxRecords: number
  readonly sessions: number
  readonly observed: number
  readonly parsed: number
  readonly duplicates: number
  readonly evicted: number
  readonly failures: number
  /** Sum of byte-denominated omissions; item counts stay separate. */
  readonly omittedBytes: number
  /** Sum of item-denominated omissions; one item is not one token. */
  readonly omittedItems: number
  /** Records whose omission amount the notice did not disclose. */
  readonly omittedUnknown: number
}

interface RetentionCounters {
  observed: number
  parsed: number
  duplicates: number
  evicted: number
  failures: number
}

/** Last `MAX_SCAN_CHARS` characters of a tool result. */
function tailWindow(text: string): string {
  return text.length > MAX_SCAN_CHARS ? text.slice(text.length - MAX_SCAN_CHARS) : text
}

/** Read `message.source.callId`, tolerating string and object sources. */
function callIdOf(message: unknown): string | undefined {
  const source = asRecord(asRecord(message)?.source)
  const callId = source?.callId
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined
}

/** One-line, bounded note for an exclusion; no fabricated precision. */
function omittedNote(omitted: RetentionOmitted): string {
  switch (omitted.kind) {
    case 'none':
      return 'nothing omitted'
    case 'exact':
      return `${omitted.count} omitted`
    case 'bytes':
      return `${omitted.bytes} bytes omitted`
    case 'unknown':
      return 'omitted amount unknown'
  }
}

/**
 * Parse the omission clause from a tool-result text.
 *
 * Recognizes `Omitted <n> items.` and `Omitted <n> bytes.`, including the
 * recovery sentence `formatRetentionNotice` appends after them. A spill
 * notice (`Omitted N bytes. Full formatted result stored at: …`) is not a
 * retention notice and yields `undefined`. An unrecognized or truncated
 * notice also yields `undefined`: unknown is never turned into a count.
 *
 * @param text - tool-result text, usually retained content plus a footer.
 * @returns the unit and exact count, or `undefined`.
 */
export function parseRetentionNotice(text: string): ParsedRetentionNotice | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined
  try {
    const pattern = /Omitted (\d+) (items|bytes)\./g
    let match: RegExpExecArray | null = pattern.exec(text)
    while (match !== null) {
      const rest = text.slice(match.index + match[0].length)
      // `dsh-spill-policy` uses the same leading clause; the locator sentence
      // is what distinguishes it. Its bytes are the spill size, not a
      // retention omission, so skip and look for a real retention clause.
      if (!/^\s+Full formatted result stored at:/.test(rest)) {
        const count = Number(match[1])
        if (!Number.isSafeInteger(count) || count < 0) return undefined
        const unit: 'items' | 'bytes' = match[2] === 'bytes' ? 'bytes' : 'items'
        return { unit, count }
      }
      match = pattern.exec(text)
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Bounded ledger of retention outcomes, keyed by tool-call id.
 *
 * `observe` feeds it from the `session/event` listener; `record` is the direct
 * API used by tests and richer callers. The earliest record is evicted once
 * {@link MAX_RETENTION_RECORDS} is reached. This class creates no attention
 * items and no evidence.
 */
export class RetentionLedger {
  private readonly byCall = new Map<string, RetentionRecord>()
  private readonly sessionOf = new Map<string, string>()
  private readonly toolNames = new Map<string, string>()
  private readonly counters: RetentionCounters = { observed: 0, parsed: 0, duplicates: 0, evicted: 0, failures: 0 }

  /**
   * Record one retention outcome.
   *
   * @param record - the outcome; `callId` keys the ledger.
   * @param sessionId - owning session, used by `list`/`exclusionsFor`.
   * @returns `true` when the record was stored; `false` for an empty call id.
   */
  record(record: RetentionRecord, sessionId?: string): boolean {
    try {
      if (typeof record.callId !== 'string' || record.callId.length === 0) return false
      this.byCall.set(record.callId, record)
      if (sessionId !== undefined && sessionId.length > 0) this.sessionOf.set(record.callId, sessionId)
      while (this.byCall.size > MAX_RETENTION_RECORDS) {
        const oldest = this.byCall.keys().next().value
        if (typeof oldest !== 'string') break
        this.byCall.delete(oldest)
        this.sessionOf.delete(oldest)
        this.counters.evicted += 1
      }
      return true
    } catch {
      this.counters.failures += 1
      return false
    }
  }

  /** One record by tool-call id. */
  get(callId: string): RetentionRecord | undefined {
    return this.byCall.get(callId)
  }

  /**
   * Records in insertion order.
   *
   * @param sessionId - optional session filter; omitted reads every session.
   */
  list(sessionId?: string): readonly RetentionRecord[] {
    const records = [...this.byCall.values()]
    if (sessionId === undefined) return records
    return records.filter((record) => this.sessionOf.get(record.callId) === sessionId)
  }

  /** Bounded status for diagnostics; never throws. */
  status(): RetentionStatus {
    let omittedBytes = 0
    let omittedItems = 0
    let omittedUnknown = 0
    for (const record of this.byCall.values()) {
      if (record.omitted.kind === 'bytes') omittedBytes += record.omitted.bytes
      else if (record.omitted.kind === 'exact') omittedItems += record.omitted.count
      else if (record.omitted.kind === 'unknown') omittedUnknown += 1
    }
    return {
      records: this.byCall.size,
      maxRecords: MAX_RETENTION_RECORDS,
      sessions: new Set(this.sessionOf.values()).size,
      observed: this.counters.observed,
      parsed: this.counters.parsed,
      duplicates: this.counters.duplicates,
      evicted: this.counters.evicted,
      failures: this.counters.failures,
      omittedBytes,
      omittedItems,
      omittedUnknown,
    }
  }

  /**
   * Observe one session event.
   *
   * Only `tool/result` can carry a retention footer. The notice supplies the
   * unit and count; `strategy`/`limit`/`kept` are not present in the model-
   * facing text, so they stay at their neutral defaults instead of being
   * guessed.
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
      if (typeof type !== 'string') return
      const data = asRecord(record.data)
      if (data === undefined) return
      if (type === 'tool/call') {
        const callId = data.callId
        const name = data.name
        if (typeof callId === 'string' && callId.length > 0 && typeof name === 'string' && name.length > 0) {
          this.toolNames.set(callId, name)
        }
        return
      }
      if (type !== 'tool/result') return
      this.counters.observed += 1
      const message = data.message
      const text = textOfMessage(message)
      if (text.length === 0) return
      const parsed = parseRetentionNotice(tailWindow(text))
      if (parsed === undefined) return
      const seq = record.seq
      const callId = callIdOf(message) ?? (typeof seq === 'number' ? `seq:${seq}` : undefined)
      if (callId === undefined) return
      if (this.byCall.has(callId)) {
        this.counters.duplicates += 1
        return
      }
      const tool = this.toolNames.get(callId) ?? 'tool'
      const stored = this.record(
        {
          callId,
          tool,
          scope: tool,
          strategy: 'head',
          limit: 0,
          kept: 0,
          omitted: parsed.unit === 'items'
            ? { kind: 'exact', count: parsed.count }
            : { kind: 'bytes', bytes: parsed.count },
          at: new Date().toISOString(),
        },
        sessionId,
      )
      if (stored) this.counters.parsed += 1
    } catch {
      this.counters.failures += 1
    }
  }

  /**
   * Host-side exclusions for one session's retention records.
   *
   * These never pass through `compileTurnContext` because retention creates no
   * attention object; they are reported next to compiler exclusions.
   *
   * @param sessionId - session whose retention records are reported.
   * @returns one `budget` exclusion per record.
   */
  exclusionsFor(sessionId: string): readonly WireExclusion[] {
    return this.exclusionsOf(this.list(sessionId))
  }

  /** Host-side exclusions across every session, for diagnostics. */
  allExclusions(): readonly WireExclusion[] {
    return this.exclusionsOf(this.list())
  }

  /** Build ordered exclusions; `<n>` is the 1-based position in the ledger view. */
  private exclusionsOf(records: readonly RetentionRecord[]): readonly WireExclusion[] {
    const exclusions: WireExclusion[] = []
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      exclusions.push({
        id: `dsh:retention:${record.callId}:${index + 1}`,
        version: 1,
        reason: 'budget',
        note: `retention ${record.scope}: ${omittedNote(record.omitted)}`,
      })
    }
    return exclusions
  }
}
