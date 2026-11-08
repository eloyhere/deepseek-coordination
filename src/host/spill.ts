/**
 * Spill channel: parse `dsh-spill-policy` notices and index spilled artifacts.
 *
 * A spilled tool result keeps a bounded preview in the session log and appends
 * one notice naming the locator, byte count and retrieval hint. This module
 * records only that pointer metadata; the full spilled text is never copied
 * into an attention summary. Parsing is pure and never throws — a result that
 * merely happens to contain the word "Omitted" must not create an item.
 *
 * wire.md §5.6: `pointer = { kind: 'spill', id: locator, version:
 * 'bytes:<n>', uri: locator }`, scores 0.8 / 0.5 / 0.6 / 1.0, budget 256,
 * session TTL, `trust = 'host'`.
 */
import { asRecord } from './json.js'
import { oneLine, scopeOf, sessionExpiry, textOfMessage } from './channels/shared.js'
import { wireId } from './wire.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WireItem } from './wire.js'

/** Maximum records retained per session; older spills are evicted. */
export const MAX_SPILL_RECORDS = 64

/** Longest summary emitted for one spill item, in characters. */
const MAX_SUMMARY_CHARS = 300

/**
 * Bounded scan window. The notice names the artifact the tool result was
 * replaced with, so it sits at the end of the text; scanning megabytes of
 * preview only costs time.
 */
const MAX_SCAN_CHARS = 64 * 1024

/**
 * One parsed spill notice.
 *
 * `omittedBytes` is the size of the full spilled text and `retrievalHint` is
 * the backend's guidance. `omittedImages` is present only when the notice also
 * states an image count.
 */
export interface SpillNotice {
  readonly locator: string
  readonly retrievalHint: string
  readonly omittedBytes?: number
  readonly omittedImages?: number
}

/**
 * The documented notice shape:
 * `(Omitted 1234 bytes. Full formatted result stored at: <locator>. <hint>)`.
 *
 * The locator is matched non-greedily up to the first `. ` separator; the
 * hint runs to the enclosing `)`. Both are required, so a truncated notice
 * yields no record instead of a guessed locator.
 */
const SPILL_NOTICE = /Omitted (\d+) bytes\.\s+Full formatted result stored at:\s*(.+?)\.\s+([\s\S]*?)\)/

/** Optional trailing `Omitted N images.` clause inside the same notice. */
const SPILL_IMAGES = /Omitted (\d+) images?\./

/**
 * Parse one spill notice from tool-result text.
 *
 * Pure and fail-open: an empty, non-string or unrelated text returns
 * `undefined`. The first complete notice wins; surrounding prose is ignored.
 *
 * @param text - tool-result text, usually a bounded preview plus notice.
 * @returns the locator, retrieval hint and optional counts, or `undefined`.
 */
export function parseSpillNotice(text: string): SpillNotice | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined
  try {
    const match = SPILL_NOTICE.exec(text)
    if (match === null) return undefined
    const locator = match[2].trim()
    if (locator.length === 0) return undefined
    let retrievalHint = match[3].trim()
    let omittedImages: number | undefined
    const images = SPILL_IMAGES.exec(match[0])
    if (images !== null) {
      const parsed = Number(images[1])
      if (Number.isSafeInteger(parsed) && parsed >= 0) omittedImages = parsed
      // The image clause belongs to the notice envelope, not to the hint.
      retrievalHint = retrievalHint.replace(/\s*Omitted \d+ images?\.\s*$/, '').trim()
    }
    const bytes = Number(match[1])
    return {
      locator,
      retrievalHint,
      ...(Number.isSafeInteger(bytes) && bytes >= 0 ? { omittedBytes: bytes } : {}),
      ...(omittedImages === undefined ? {} : { omittedImages }),
    }
  } catch {
    return undefined
  }
}

/** One observed spill: pointer metadata only, never the spilled text. */
export interface SpillRecord {
  readonly sessionId: string
  /** The tool whose result spilled; `tool` when the call was not observed. */
  readonly tool: string
  readonly callId?: string
  readonly locator: string
  readonly bytes: number
  readonly retrievalHint: string
  readonly omittedImages?: number
  /** Stable per-session channel slot (`spill-<n>`), not the locator. */
  readonly slot: string
  readonly at: string
}

/** Bounded status view for diagnostics and `/amp/context`. */
export interface SpillStatus {
  readonly sessions: number
  readonly records: number
  readonly observed: number
  readonly parsed: number
  readonly duplicates: number
  readonly evicted: number
  readonly failures: number
}

/** Counters kept allocation-bounded; failures retain only a count. */
interface SpillCounters {
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

/** Read `message.source.callId` from a tool result, tolerating other shapes. */
function callIdOf(message: unknown): string | undefined {
  const source = asRecord(asRecord(message)?.source)
  const callId = source?.callId
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined
}

/** Short, single-line summary; the full text never enters the envelope. */
function summaryOf(record: SpillRecord): string {
  const size = Number.isFinite(record.bytes) && record.bytes >= 0 ? `${record.bytes} bytes` : 'unknown bytes'
  const hint = oneLine(record.retrievalHint).slice(0, 160)
  const head = `${record.tool} output spilled: ${size}`
  const summary = hint.length > 0 ? `${head}; ${hint}` : head
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary
}

/**
 * Index spilled tool results per session.
 *
 * `observe` is called from the `session/event` listener for every event; it
 * reads `tool/call` to learn tool names and scans each `tool/result` text once
 * for a notice. `itemsFor` projects the retained records into wire items on
 * demand, so a later step sees a spill observed during the previous step.
 */
export class SpillIndex {
  private readonly bySession = new Map<string, SpillRecord[]>()
  private readonly toolNames = new Map<string, string>()
  private readonly turns = new Map<string, number>()
  private readonly counters: SpillCounters = { observed: 0, parsed: 0, duplicates: 0, evicted: 0, failures: 0 }
  private nextSlot = 0

  /**
   * Observe one session event.
   *
   * @param sessionId - owning session; required for every retained record.
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
      this.observeTurn(sessionId, data)
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
      const notice = parseSpillNotice(tailWindow(text))
      if (notice === undefined) return
      this.record(sessionId, message, notice)
    } catch {
      this.counters.failures += 1
    }
  }

  /**
   * The retained spill records for one session, oldest first.
   *
   * @param sessionId - session to read.
   */
  list(sessionId: string): readonly SpillRecord[] {
    const records = this.bySession.get(sessionId)
    return records === undefined ? [] : records.slice()
  }

  /**
   * Project this session's spills into wire items.
   *
   * The id carries the latest observed turn, because AMP reuses an attention
   * object by id and excludes a scope whose turn no longer matches. The
   * optimizer additionally appends the step suffix and replaces `scope` with
   * the live compile scope. One malformed record never drops the rest.
   *
   * @param agent - the agent whose session is being compiled.
   * @returns spill-channel items, possibly empty.
   */
  itemsFor(agent: Agent): readonly WireItem[] {
    const sessionId = asRecord(agent)?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return []
    const records = this.bySession.get(sessionId)
    if (records === undefined || records.length === 0) return []
    // AMP reuses an attention object by id and the compiler excludes a scope
    // whose turn no longer matches, so the id must carry the current turn —
    // the same turn-qualified id rule the P1 channels follow.
    const turn = this.turns.get(sessionId) ?? 0
    const scope = scopeOf(agent, sessionId, turn)
    const expiresAt = sessionExpiry()
    const items: WireItem[] = []
    for (const record of records) {
      try {
        items.push({
          id: wireId('spill', sessionId, turn, record.slot),
          channel: 'spill',
          scope: { ...scope },
          pointer: {
            kind: 'spill',
            id: record.locator,
            version: record.bytes > 0 ? `bytes:${record.bytes}` : 'notice',
            uri: record.locator,
          },
          summary: summaryOf(record),
          scores: { relevance: 0.8, urgency: 0.5, confidence: 0.6, importance: 1 },
          budget: { tokens: 256 },
          expiresAt,
          reason: 'a tool result was spilled to a retrievable artifact',
          trust: 'host',
        })
      } catch {
        this.counters.failures += 1
      }
    }
    return items
  }

  /** Bounded status for diagnostics; never throws. */
  status(): SpillStatus {
    let records = 0
    for (const list of this.bySession.values()) records += list.length
    return {
      sessions: this.bySession.size,
      records,
      observed: this.counters.observed,
      parsed: this.counters.parsed,
      duplicates: this.counters.duplicates,
      evicted: this.counters.evicted,
      failures: this.counters.failures,
    }
  }

  /** Retain the latest turn number so item ids stay turn-qualified. */
  private observeTurn(sessionId: string, data: Record<string, unknown>): void {
    const turn = data.turn
    if (typeof turn === 'number' && Number.isInteger(turn) && turn >= 0) this.turns.set(sessionId, turn)
  }

  /** Retain one parsed spill; duplicate call/locator pairs are ignored. */
  private record(sessionId: string, message: unknown, notice: SpillNotice): void {
    const callId = callIdOf(message)
    const existing = this.bySession.get(sessionId) ?? []
    const duplicate = existing.some((entry) => entry.locator === notice.locator && entry.callId === callId)
    if (duplicate) {
      this.counters.duplicates += 1
      return
    }
    const tool = callId === undefined ? undefined : this.toolNames.get(callId)
    const record: SpillRecord = {
      sessionId,
      tool: tool ?? 'tool',
      ...(callId === undefined ? {} : { callId }),
      locator: notice.locator,
      bytes: notice.omittedBytes ?? 0,
      retrievalHint: notice.retrievalHint,
      ...(notice.omittedImages === undefined ? {} : { omittedImages: notice.omittedImages }),
      slot: `spill-${this.nextSlot}`,
      at: new Date().toISOString(),
    }
    this.nextSlot += 1
    existing.push(record)
    while (existing.length > MAX_SPILL_RECORDS) {
      existing.shift()
      this.counters.evicted += 1
    }
    this.bySession.set(sessionId, existing)
    this.counters.parsed += 1
  }
}
