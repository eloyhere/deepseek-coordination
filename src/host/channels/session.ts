/**
 * `@session` input channel (`source.kind === 'session-reference'`).
 *
 * DSH's session-reference resolver inserts a bounded snapshot of another
 * session as a second user message and tags it with the `session-reference`
 * source. The snapshot body stays in DSH's own message; this extractor keeps
 * only the reference metadata so AMP can index the mention without copying the
 * transcript. Its trust is `derived` (H4, untrusted background): a referenced
 * session can never become a trusted instruction.
 */
import type { CaptureExtractor, CaptureExtractorInput } from '../prestep.js'
import type { WireItem } from '../wire.js'
import {
  asRecord,
  oneLine,
  safeSlot,
  scoresOf,
  sourceKindOf,
  sourceRecordOf,
  turnExpiry,
  wireItem,
} from './shared.js'

/** Candidate cap for the session-ref channel: three references per turn. */
export const MAX_SESSION_ITEMS = 3

/** The source kind DSH uses for an inserted session snapshot. */
export const SESSION_REFERENCE_SOURCE = 'session-reference'

/** One normalized reference read from a `session-reference` source. */
export interface SessionReference {
  readonly sessionId: string
  readonly label: string
  readonly capturedThroughSeq: number
  readonly inputIndex?: number
}

/** Non-negative integer from untyped input, or `undefined`. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

/**
 * Normalize one raw reference object.
 *
 * DSH 0.2.2-rc.1 sends `{ sessionId, label, capturedFormatVersion,
 * capturedThroughSeq, inputIndex, ...stats }`; only the id, label, sequence and
 * input index are needed here. A missing label falls back to the id and a
 * missing sequence to `0`, matching the pointer version contract.
 */
function referenceOf(value: unknown): SessionReference | undefined {
  try {
    const record = asRecord(value)
    if (record === undefined) return undefined
    const sessionId = record.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const rawLabel = record.label
    const label = typeof rawLabel === 'string' && rawLabel.length > 0 ? oneLine(rawLabel) : oneLine(sessionId)
    const capturedThroughSeq = countOf(record.capturedThroughSeq) ?? 0
    const inputIndex = countOf(record.inputIndex)
    return {
      sessionId,
      label,
      capturedThroughSeq,
      ...(inputIndex === undefined ? {} : { inputIndex }),
    }
  } catch {
    return undefined
  }
}

/**
 * Read every session reference carried by one message source.
 *
 * The `references` array is authoritative. When it is absent or empty (older
 * producers, fixtures, a future shape), the source-level
 * `sessionId`/`label`/`capturedThroughSeq` fields are used as a single
 * reference. Anything malformed yields `[]`.
 */
export function referencesOf(message: unknown): readonly SessionReference[] {
  const references: SessionReference[] = []
  try {
    if (sourceKindOf(message) !== SESSION_REFERENCE_SOURCE) return references
    const source = sourceRecordOf(message)
    if (source === undefined) return references
    const raw = source.references
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const reference = referenceOf(entry)
        if (reference !== undefined) references.push(reference)
      }
    }
    if (references.length > 0) return references
    const fallback = referenceOf({
      sessionId: source.sessionId,
      label: source.label,
      capturedThroughSeq: source.capturedThroughSeq,
      inputIndex: source.inputIndex,
    })
    if (fallback !== undefined) references.push(fallback)
  } catch {
    return []
  }
  return references
}

/** Canonical base64url form of one session id, as used in `dsh-session:` URIs. */
export function sessionUri(sessionId: string): string {
  return `dsh-session:${Buffer.from(sessionId, 'utf8').toString('base64url')}`
}

/**
 * Extract one `session-ref` wire item per referenced session.
 *
 * The slot is `session-<inputIndex>` when the reference carries one; otherwise
 * (and on a slot collision) a running ordinal is used. Duplicate references to
 * the same session collapse to one item. The summary mirrors wire.md §5.3 and
 * always carries the `untrusted background` warning.
 */
export function extractSessionItems(input: CaptureExtractorInput): readonly WireItem[] {
  const items: WireItem[] = []
  try {
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return items
    const expiresAt = turnExpiry()
    const seenSessions = new Set<string>()
    const usedSlots = new Set<string>()
    let nextSlot = 1
    for (const message of input.messages) {
      for (const reference of referencesOf(message)) {
        if (items.length >= MAX_SESSION_ITEMS) break
        if (seenSessions.has(reference.sessionId)) continue
        let slot = safeSlot('session', reference.inputIndex ?? nextSlot)
        while (usedSlots.has(slot)) {
          nextSlot += 1
          slot = safeSlot('session', nextSlot)
        }
        const item = wireItem(input.agent, input.sessionId, input.turn, {
          channel: 'session-ref',
          slot,
          pointer: {
            kind: 'session',
            id: reference.sessionId,
            version: `seq:${String(reference.capturedThroughSeq)}`,
            uri: sessionUri(reference.sessionId),
          },
          summary:
            `@${reference.label} (session ${reference.sessionId}) ` +
            `captured through seq ${String(reference.capturedThroughSeq)}; untrusted background`,
          scores: scoresOf(0.7, 0.3, 0.6, 0.6),
          expiresAt,
          reason: 'the user referenced another session; its snapshot is untrusted background',
          trust: 'derived',
        })
        if (item === undefined) continue
        seenSessions.add(reference.sessionId)
        usedSlots.add(slot)
        nextSlot += 1
        items.push(item)
      }
      if (items.length >= MAX_SESSION_ITEMS) break
    }
  } catch {
    // wire.md §5.3: a snapshot that cannot be read yields no item at all.
    return []
  }
  return items
}

/** The `session-ref` channel extractor registered by `registerInputExtractors`. */
export const sessionExtractor: CaptureExtractor = {
  name: 'session',
  extract: extractSessionItems,
}
