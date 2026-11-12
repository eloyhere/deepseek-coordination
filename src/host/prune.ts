/**
 * Prune channel: observe `compaction/prune` and its replacement tool result.
 *
 * `dsh-compaction-tool-result-pruner` appends a log-only `compaction/prune`
 * event (shadow price of the exact replaced range) and then, synchronously, a
 * surface-replacing `tool/result` whose `sourceEventSeqs` cites the shadowed
 * node. Pairing the two is contractual and adjacency-based: after a prune the
 * very next `tool/result` either covers the shadowed seq — and is the
 * replacement — or the association is abandoned rather than guessed.
 *
 * wire.md §5.8: one prune-channel item per record with a tool pointer at the
 * replacement seq, host trust and a session TTL. Shadowed originals become
 * host-side `version` exclusions because this host never mounted them as
 * attention objects in the first place; no evidence is fabricated.
 */
import { asRecord } from './json.js'
import { scopeOf, sessionExpiry, textOfMessage } from './channels/shared.js'
import { wireId } from './wire.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WireExclusion, WireItem } from './wire.js'

/** Maximum prune records retained per session. */
export const MAX_PRUNE_RECORDS = 64

/** Maximum host-side exclusions emitted for diagnostics. */
const MAX_HOST_EXCLUSIONS = 256

/** The replaced surface-position span. */
export interface PruneShadowedRange {
  readonly start: number
  readonly end: number
}

/**
 * One prune outcome.
 *
 * `replacementSeq`, `callId` and `charsAfter` stay unset until the adjacent
 * replacement result is observed; an unlinked record still describes the
 * prune, it just cannot point at the replacement. `charsAfter` is the
 * replacement's text length, which is the only source for the summary's "to
 * `<n>` chars" figure.
 */
export interface PruneRecord {
  readonly sessionId: string
  readonly shadowedRange: PruneShadowedRange
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly replacementSeq?: number
  readonly callId?: string
  readonly charsAfter?: number
  readonly at: string
}

/** Bounded status view for diagnostics and `/amp/context`. */
export interface PruneStatus {
  readonly sessions: number
  readonly records: number
  readonly linked: number
  readonly pending: number
  readonly observed: number
  readonly pruned: number
  readonly unlinked: number
  readonly failures: number
  /** Sum of originals' token counts; display-only, not a net saving. */
  readonly shadowedTokens: number
}

interface PruneCounters {
  observed: number
  pruned: number
  unlinked: number
  failures: number
}

/** Read a finite non-negative integer, or `undefined`. */
function seqOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Read a numeric list, dropping malformed members instead of throwing. */
function seqListOf(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seqs: number[] = []
  for (const entry of value) {
    const seq = seqOf(entry)
    if (seq !== undefined) seqs.push(seq)
  }
  return seqs
}

/** Read `message.source.callId`, tolerating missing or string sources. */
function callIdOf(message: unknown): string | undefined {
  const source = asRecord(asRecord(message)?.source)
  const callId = source?.callId
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined
}

/** How many replacements were paired with their prune event. */
function linkedCount(records: readonly PruneRecord[]): number {
  return records.reduce((total, record) => (record.replacementSeq === undefined ? total : total + 1), 0)
}

/**
 * Track `compaction/prune` events and their adjacent replacement results.
 *
 * The pending association is tracked per session, so interleaved events from
 * another session do not break it. The one-event adjacency window is
 * deliberate: a prune followed by anything other than its replacement is
 * retained as an unlinked record, never paired with a later result.
 */
export class PruneTracker {
  private readonly bySession = new Map<string, PruneRecord[]>()
  private readonly pending = new Map<string, PruneRecord>()
  private readonly turns = new Map<string, number>()
  private readonly counters: PruneCounters = { observed: 0, pruned: 0, unlinked: 0, failures: 0 }

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
      if (typeof type !== 'string') return
      const data = asRecord(record.data)
      if (data !== undefined) this.observeTurn(sessionId, data)
      this.counters.observed += 1
      if (type === 'compaction/prune') {
        const parsed = data === undefined ? undefined : this.recordOf(sessionId, data)
        if (parsed === undefined) return
        if (this.pending.has(sessionId)) this.counters.unlinked += 1
        const list = this.bySession.get(sessionId) ?? []
        list.push(parsed)
        while (list.length > MAX_PRUNE_RECORDS) list.shift()
        this.bySession.set(sessionId, list)
        this.pending.set(sessionId, parsed)
        this.counters.pruned += 1
        return
      }
      const pending = this.pending.get(sessionId)
      if (pending === undefined) return
      this.pending.delete(sessionId)
      if (type !== 'tool/result') {
        this.counters.unlinked += 1
        return
      }
      this.attach(pending, record)
    } catch {
      this.counters.failures += 1
    }
  }

  /** The retained prune records for one session, oldest first. */
  list(sessionId: string): readonly PruneRecord[] {
    const records = this.bySession.get(sessionId)
    return records === undefined ? [] : records.slice()
  }

  /**
   * Project this session's prune records into wire items.
   *
   * The id carries the latest observed turn, because AMP reuses an object by
   * id and excludes a scope whose turn no longer matches. The optimizer
   * appends the step suffix and replaces `scope` with the live compile scope.
   * The slot is the record's position in this session's bounded list.
   *
   * @param agent - the agent whose session is being compiled.
   * @returns prune-channel items, possibly empty.
   */
  itemsFor(agent: Agent): readonly WireItem[] {
    const sessionId = asRecord(agent)?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return []
    const records = this.bySession.get(sessionId)
    if (records === undefined || records.length === 0) return []
    // AMP reuses an object by id and the compiler excludes a scope whose turn
    // no longer matches, so the id carries the current turn.
    const turn = this.turns.get(sessionId) ?? 0
    const scope = scopeOf(agent, sessionId, turn)
    const expiresAt = sessionExpiry()
    const items: WireItem[] = []
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      try {
        const start = record.shadowedRange.start
        const versionSeq = record.replacementSeq ?? start
        const summary = record.charsAfter === undefined
          ? `pruned (head/tail); original at seq ${start}`
          : `pruned to ${record.charsAfter} chars (head/tail); original at seq ${start}`
        items.push({
          id: wireId('prune', sessionId, turn, `prune-${index}`),
          channel: 'prune',
          scope: { ...scope },
          pointer: {
            kind: 'tool',
            id: record.callId ?? `seq:${start}`,
            version: `seq:${versionSeq}`,
          },
          summary,
          scores: { relevance: 0.6, urgency: 0.4, confidence: 0.6, importance: 1 },
          budget: { tokens: 256 },
          expiresAt,
          reason: 'a tool result was pruned and its replacement is available',
          trust: 'host',
        })
      } catch {
        this.counters.failures += 1
      }
    }
    return items
  }

  /**
   * Host-side exclusions for pruned originals.
   *
   * The originals were never mounted as attention objects by this host, so the
   * compiler cannot report them; `/amp/context` lists them separately with
   * reason `version`. No evidence or receipt is created here.
   */
  hostExclusions(): readonly WireExclusion[] {
    const exclusions: WireExclusion[] = []
    for (const records of this.bySession.values()) {
      for (const record of records) {
        const seqs = record.shadowedSeqs.length > 0 ? record.shadowedSeqs : [record.shadowedRange.start]
        for (const seq of seqs) {
          if (exclusions.length >= MAX_HOST_EXCLUSIONS) return exclusions
          exclusions.push({
            id: `dsh:prune:${record.sessionId}:${seq}`,
            version: 1,
            reason: 'version',
            pointer: {
              kind: 'tool',
              id: record.callId ?? `seq:${seq}`,
              version: `seq:${record.replacementSeq ?? record.shadowedRange.start}`,
            },
            note: record.replacementSeq === undefined
              ? 'pruned result; replacement was not observed'
              : `pruned result replaced at seq ${record.replacementSeq}`,
          })
        }
      }
    }
    return exclusions
  }

  /** Bounded status for diagnostics; never throws. */
  status(): PruneStatus {
    let records = 0
    let linked = 0
    let shadowedTokens = 0
    for (const list of this.bySession.values()) {
      records += list.length
      linked += linkedCount(list)
      for (const record of list) shadowedTokens += record.shadowedTokenCount
    }
    return {
      sessions: this.bySession.size,
      records,
      linked,
      pending: this.pending.size,
      observed: this.counters.observed,
      pruned: this.counters.pruned,
      unlinked: this.counters.unlinked,
      failures: this.counters.failures,
      shadowedTokens,
    }
  }

  /** Retain the latest turn number so item ids stay turn-qualified. */
  private observeTurn(sessionId: string, data: Record<string, unknown>): void {
    const turn = data.turn
    if (typeof turn === 'number' && Number.isInteger(turn) && turn >= 0) this.turns.set(sessionId, turn)
  }

  /** Build one record from a `compaction/prune` payload; no range, no record. */
  private recordOf(sessionId: string, data: Record<string, unknown>): PruneRecord | undefined {
    const range = asRecord(data.shadowedRange)
    const start = seqOf(range?.start)
    const end = seqOf(range?.end)
    if (start === undefined || end === undefined) return undefined
    return {
      sessionId,
      shadowedRange: { start, end },
      shadowedSeqs: seqListOf(data.shadowedSeqs),
      shadowedTokenCount: seqOf(data.shadowedTokenCount) ?? 0,
      at: new Date().toISOString(),
    }
  }

  /** Pair the adjacent replacement with its prune record, or leave it unlinked. */
  private attach(record: PruneRecord, event: Record<string, unknown>): void {
    const cited = seqListOf(event.sourceEventSeqs)
    const shadowed = record.shadowedSeqs.length > 0 ? record.shadowedSeqs : [record.shadowedRange.start]
    const covers = cited.some((seq) => shadowed.includes(seq))
    const replacementSeq = seqOf(event.seq)
    if (!covers || replacementSeq === undefined) {
      this.counters.unlinked += 1
      return
    }
    const data = asRecord(event.data)
    const message = data?.message
    const text = textOfMessage(message)
    const callId = callIdOf(message)
    const linked: PruneRecord = {
      ...record,
      replacementSeq,
      ...(record.callId === undefined && callId !== undefined ? { callId } : {}),
      ...(record.charsAfter === undefined && text.length > 0 ? { charsAfter: text.length } : {}),
    }
    const list = this.bySession.get(record.sessionId)
    if (list === undefined) {
      this.counters.unlinked += 1
      return
    }
    const index = list.indexOf(record)
    if (index < 0) {
      this.counters.unlinked += 1
      return
    }
    list[index] = linked
  }
}
