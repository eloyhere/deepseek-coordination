/**
 * Tombstones for attention items that disappeared between two compiles.
 *
 * `compileTurnContext` only records a `ContextExclusion` for an object it was
 * given. Dropping an item from `create` therefore makes it vanish silently.
 * This module diffs the previous step's wire items against the current batch
 * and builds one unmounted `AttentionObject` per removed base id, so passing
 * the result as `objects` makes the compiler record `unmounted`.
 *
 * The diff keys on {@link baseWireId}: prompt/plan/tool slots and captured
 * channel items are step-qualified (`...-s3`), and a step change replaces an
 * item instead of removing it. The module is pure and fail-open: it reads the
 * clock only when `now` is omitted, and no input can throw.
 */
import type { AttentionObject } from 'attention-manifest-protocol/attention'
import type { WireItem, WireScope } from './wire.js'

/** Maximum tombstones emitted by one compile; keeps `exclusions` bounded. */
export const MAX_TOMBSTONES = 50

/**
 * Maximum base ids carried into the next diff. The oldest insertions are
 * evicted, so a huge or adversarial current batch cannot grow the map without
 * bound; the previous scan is capped to the same number of newest entries.
 */
export const MAX_PREVIOUS_ITEMS = 1000

/** Longest summary copied onto a tombstone; exclusions are audit data only. */
const MAX_SUMMARY_LENGTH = 600

/** A tombstone stays valid long enough to be recorded, then ages out. */
const TOMBSTONE_TTL_MS = 60 * 60 * 1000

/** Base wire ids mapped to the most recent wire item seen for that base id. */
export type TombstoneMap = Map<string, WireItem>

/**
 * Strip one trailing step qualifier (`-s<digits>`) from a wire id.
 *
 * Only the final suffix is structural: the turn-scoped id is the base and the
 * step is an extension. An id without a numeric suffix is returned unchanged.
 *
 * @param id - a wire id, possibly step-qualified.
 * @returns the base wire id, or `''` for a non-string input.
 */
export function baseWireId(id: string): string {
  if (typeof id !== 'string') return ''
  return id.replace(/-s\d+$/, '')
}

/** Bound one summary, preserving a nonempty audit string. */
function boundedSummary(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH)}…` : text
}

/** A pointer the AMP validator will accept; malformed items produce no tombstone. */
function isPointerLike(value: unknown): value is WireItem['pointer'] {
  if (value === null || typeof value !== 'object') return false
  const pointer = value as { kind?: unknown; id?: unknown; version?: unknown }
  return typeof pointer.kind === 'string' && pointer.kind.length > 0
    && typeof pointer.id === 'string' && pointer.id.length > 0
    && typeof pointer.version === 'string' && pointer.version.length > 0
}

/** The compile scope must be valid before it can be copied onto an object. */
function isScopeLike(scope: unknown): scope is WireScope {
  if (scope === null || typeof scope !== 'object') return false
  const value = scope as { tenantId?: unknown; principalId?: unknown; sessionId?: unknown; workspaceId?: unknown }
  if (typeof value.tenantId !== 'string' || value.tenantId.length === 0) return false
  if (typeof value.principalId !== 'string' || value.principalId.length === 0) return false
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return false
  if (value.workspaceId !== undefined && (typeof value.workspaceId !== 'string' || value.workspaceId.length === 0)) return false
  return true
}

/** Preserve a caller-supplied timestamp; fall back to the clock when it is invalid. */
function normalizeNow(now: string | undefined): string {
  if (typeof now === 'string' && Number.isFinite(Date.parse(now))) return now
  return new Date().toISOString()
}

/**
 * Build one compiler-visible tombstone from a removed wire item.
 *
 * `mounted: false` is deliberate: the compiler's first residency check then
 * yields `unmounted`, which is in the closed `ContextExclusion` vocabulary.
 * `superseded` is an attention lifecycle reason and would be rejected.
 *
 * @param item - the wire item that is no longer in the current batch.
 * @param scope - the optimizer's compile scope.
 * @param turnId - the compile turn; it overrides the item's stale turn.
 * @param at - the shared creation/update timestamp.
 * @param expiresAt - the shared expiry, already one hour after `at`.
 * @returns a valid `AttentionObject`, or `undefined` when the item cannot be
 *   projected without inventing a summary or pointer.
 */
function tombstoneOf(
  item: WireItem,
  scope: WireScope,
  turnId: string,
  at: string,
  expiresAt: string,
): AttentionObject | undefined {
  if (typeof item.id !== 'string' || item.id.length === 0) return undefined
  if (!isPointerLike(item.pointer)) return undefined
  const summary = boundedSummary(item.summary)
  if (summary.length === 0) return undefined
  return {
    id: item.id,
    version: 1,
    summary,
    pointer: { ...item.pointer },
    sources: [],
    references: { evidence: [], receipts: [], capabilities: [], behaviors: [] },
    scope: { ...scope, turnId },
    scores: { relevance: 0, urgency: 0, confidence: 0, importance: 0 },
    intensity: 0,
    mounted: false,
    budget: { tokens: 1 },
    expiresAt,
    stale: false,
    createdAt: at,
    updatedAt: at,
    lastReason: 'replaced or removed from the next step',
  }
}

/**
 * Compute the tombstones and the bookkeeping map for the next step.
 *
 * `current` is indexed by {@link baseWireId}: a later item wins over an earlier
 * one with the same base id, so a step-qualified replacement is not a removal.
 * The returned map is capped at {@link MAX_PREVIOUS_ITEMS} newest keys.
 * `previous` is read in insertion order but only its newest
 * {@link MAX_PREVIOUS_ITEMS} entries are examined; when more than
 * {@link MAX_TOMBSTONES} items disappeared, only the most recent ones are
 * emitted.
 *
 * @param previous - the base-id map returned by the previous compile.
 * @param current - every wire item submitted to this compile, candidates first.
 * @param scope - the optimizer's compile scope.
 * @param turnId - the current turn, forced onto every tombstone scope.
 * @param now - optional fixed timestamp; the clock is read when omitted.
 * @returns tombstones for removed items and the map for the next diff.
 */
export function diffTombstones(
  previous: ReadonlyMap<string, WireItem>,
  current: readonly WireItem[],
  scope: WireScope,
  turnId: string,
  now?: string,
): { tombstones: AttentionObject[]; next: Map<string, WireItem> } {
  try {
    return computeDiff(previous, current, scope, turnId, now)
  } catch {
    // Fail-open: a malformed previous map must never cost the step its context.
    return { tombstones: [], next: new Map<string, WireItem>() }
  }
}

/** The throwing body of {@link diffTombstones}; called inside its guard. */
function computeDiff(
  previous: ReadonlyMap<string, WireItem>,
  current: readonly WireItem[],
  scope: WireScope,
  turnId: string,
  now: string | undefined,
): { tombstones: AttentionObject[]; next: Map<string, WireItem> } {
  if (!Array.isArray(current)) return { tombstones: [], next: new Map<string, WireItem>() }
  const previousMap = previous instanceof Map ? previous : undefined
  if (previous !== undefined && previous !== null && previousMap === undefined) {
    return { tombstones: [], next: new Map<string, WireItem>() }
  }

  const next = new Map<string, WireItem>()
  for (const candidate of current) {
    if (candidate === null || typeof candidate !== 'object') continue
    const item = candidate as WireItem
    if (typeof item.id !== 'string' || item.id.length === 0) continue
    const base = baseWireId(item.id)
    if (base.length === 0) continue
    // Re-insert so Map order tracks recency: a duplicate base id must not be
    // evicted ahead of keys that were first seen earlier.
    next.delete(base)
    next.set(base, item)
    // Bound memory even while a malformed caller passes an oversized batch.
    while (next.size > MAX_PREVIOUS_ITEMS) {
      const oldest = next.keys().next().value
      if (typeof oldest !== 'string') break
      next.delete(oldest)
    }
  }

  if (!isScopeLike(scope) || typeof turnId !== 'string' || turnId.length === 0) {
    return { tombstones: [], next }
  }

  const removed: WireItem[] = []
  if (previousMap !== undefined) {
    // A malformed or adversarial caller can pass an oversized map. Processing
    // is bounded to its newest MAX_PREVIOUS_ITEMS entries; the older prefix is
    // skipped without touching entry values (which may themselves throw).
    const skip = previousMap.size > MAX_PREVIOUS_ITEMS
      ? previousMap.size - MAX_PREVIOUS_ITEMS
      : 0
    let position = 0
    for (const entry of previousMap) {
      if (position < skip) {
        position += 1
        continue
      }
      position += 1
      const key = entry[0]
      const item = entry[1]
      if (typeof key !== 'string' || key.length === 0) continue
      if (next.has(key)) continue
      if (item === null || typeof item !== 'object') continue
      removed.push(item)
    }
  }

  const at = normalizeNow(now)
  const expiresAt = new Date(Date.parse(at) + TOMBSTONE_TTL_MS).toISOString()
  const recent = removed.length > MAX_TOMBSTONES ? removed.slice(removed.length - MAX_TOMBSTONES) : removed
  const tombstones: AttentionObject[] = []
  const seen = new Set<string>()
  for (const item of recent) {
    const tombstone = tombstoneOf(item, scope, turnId, at, expiresAt)
    if (tombstone === undefined || seen.has(tombstone.id)) continue
    seen.add(tombstone.id)
    tombstones.push(tombstone)
  }
  return { tombstones, next }
}
