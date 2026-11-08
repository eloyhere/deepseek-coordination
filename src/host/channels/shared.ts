/**
 * Shared helpers for the P1 input-channel extractors (`file`, `attachment`,
 * `session`, `message`).
 *
 * Every helper is fail-open: a malformed agent, message or content block yields
 * an empty value or `undefined` instead of throwing into `agent/pre-step`. The
 * extractors run synchronously on the step-critical path, so the only runtime
 * dependencies here are `node:path` and `wireId`; nothing performs network,
 * store or attachment-byte access.
 *
 * The message vocabulary is narrowed structurally rather than imported so the
 * helpers tolerate both live DSH values and the plain fixtures used by the
 * unit tests. DSH's own types are `UserMessage`, `ImageBlock`, `FileBlock`,
 * `ImageAttachmentRef` and `FileAttachmentRef`.
 */
import path from 'node:path'

import { wireId } from '../wire.js'
import type {
  WireBudget,
  WireChannel,
  WireItem,
  WirePointer,
  WireScope,
  WireScores,
  WireTrust,
} from '../wire.js'

/** Tenant used when a fake or headless agent cannot expose the AMP host config. */
export const DEFAULT_TENANT = 'dsh-desktop'

/** Turn-scoped TTL used by file, session-reference and steer items. */
export const TURN_TTL_MS = 60 * 60 * 1000

/** Session-scoped TTL used by attachment items. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000

/** Per-item token budget mandated by wire.md §4.5 for every P1 channel. */
export const ITEM_BUDGET_TOKENS = 256

/** One wire item before its id and scope are computed. */
export interface ItemDraft {
  readonly channel: WireChannel
  /** Stable channel-local slot matching `/^[a-z0-9_-]+$/`. */
  readonly slot: string
  readonly pointer: WirePointer
  readonly summary: string
  readonly scores: WireScores
  readonly budget?: WireBudget
  readonly expiresAt: string
  readonly reason: string
  readonly trust: WireTrust
}

/** Narrow a value to a string-keyed record without throwing on hostile getters. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Read `message.source` as a record; `undefined` for string or missing sources. */
export function sourceRecordOf(message: unknown): Record<string, unknown> | undefined {
  try {
    return asRecord(asRecord(message)?.source)
  } catch {
    return undefined
  }
}

/**
 * Read the message source kind.
 *
 * DSH's `MessageSource` is an object with `kind`; older/fake inputs sometimes
 * carry the kind as a bare string. Both shapes are accepted.
 */
export function sourceKindOf(message: unknown): string {
  try {
    const source = asRecord(message)?.source
    if (typeof source === 'string') return source
    const kind = asRecord(source)?.kind
    return typeof kind === 'string' ? kind : ''
  } catch {
    return ''
  }
}

/** Read the message role; `''` when the value carries none. */
export function roleOf(message: unknown): string {
  try {
    const role = asRecord(message)?.role
    return typeof role === 'string' ? role : ''
  } catch {
    return ''
  }
}

/** Whether a message is user content; a missing role is treated as user. */
export function isUserRole(message: unknown): boolean {
  const role = roleOf(message)
  return role === '' || role === 'user'
}

/** Read the stable DSH message id, if any. */
export function messageIdOf(message: unknown): string | undefined {
  try {
    const id = asRecord(message)?.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Join every `text` block of a message with `\n`.
 *
 * A plain string content is returned as-is so fixtures and headless paths work.
 * Non-text blocks (`image`, `file`, `tool-call`, ...) are ignored; their bytes
 * or arguments are never read.
 */
export function textOfMessage(message: unknown): string {
  try {
    const record = asRecord(message)
    if (record === undefined) return ''
    const content = record.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const raw of content) {
      const block = asRecord(raw)
      if (block === undefined) continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  } catch {
    return ''
  }
}

/** Read `agent.session.header.cwd`; `undefined` when absent or malformed. */
export function cwdOf(agent: unknown): string | undefined {
  try {
    const header = asRecord(asRecord(asRecord(agent)?.session)?.header)
    const cwd = header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the AMP tenant for one item.
 *
 * `WireItem.scope` must match the compile scope, but an extractor receives only
 * the agent and the capture context. The live agent's scoped Cordis context can
 * reach the provided `amp` service, so a configured tenant is honored; fake and
 * headless agents fall back to the AMP host default. P2 should pass the tenant
 * through `WireCapture` options instead of probing the agent.
 */
export function tenantOf(agent: unknown): string {
  try {
    const ctx = asRecord(agent)?.ctx as { get?: (name: string) => unknown } | undefined
    const host = typeof ctx?.get === 'function' ? ctx.get('amp') : undefined
    const tenantId = asRecord(asRecord(host)?.config)?.tenantId
    return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : DEFAULT_TENANT
  } catch {
    return DEFAULT_TENANT
  }
}

/**
 * Build the scope for an extractor item.
 *
 * `turnId` is a placeholder: `AmpContextOptimizer` overwrites it with the AMP
 * turn id when it maps the item through `toCreateAttention`. `workspaceId` and
 * `projectId` stay unset because the compile scope does not set them either.
 */
export function scopeOf(agent: unknown, sessionId: string, turn: number): WireScope {
  return {
    tenantId: tenantOf(agent),
    principalId: sessionId,
    sessionId,
    turnId: `turn:${sessionId}:${turn}`,
  }
}

/** Fixed score tuple in `WireScores` order: relevance, urgency, confidence, importance. */
export function scoresOf(relevance: number, urgency: number, confidence: number, importance: number): WireScores {
  return { relevance, urgency, confidence, importance }
}

/** ISO instant `ttl` milliseconds after `now`; never throws. */
function expiryAfter(now: number, ttl: number): string {
  try {
    const base = Number.isFinite(now) ? now : Date.now()
    return new Date(base + ttl).toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

/** Turn-scoped expiry (one hour); pass `now` only in tests. */
export function turnExpiry(now: number = Date.now()): string {
  return expiryAfter(now, TURN_TTL_MS)
}

/** Session-scoped expiry (24 hours); pass `now` only in tests. */
export function sessionExpiry(now: number = Date.now()): string {
  return expiryAfter(now, SESSION_TTL_MS)
}

/**
 * Step-scoped expiry for injected context.
 *
 * The wire envelope only carries an absolute instant, so "next step" is
 * represented by the same one-hour window as a turn; a real step boundary is
 * handled by `WireCapture` dropping the pending entry.
 */
export function stepExpiry(now: number = Date.now()): string {
  return expiryAfter(now, TURN_TTL_MS)
}

/**
 * Build a channel slot from a channel prefix and a numeric index.
 *
 * `wireId` accepts only `/^[a-z0-9_-]+$/`, so non-finite, negative and unsafe
 * indexes are clamped and an invalid prefix degrades to `item`. Never throws.
 */
export function safeSlot(prefix: string, index: number): string {
  try {
    const head = typeof prefix === 'string' && /^[a-z0-9_-]+$/.test(prefix) ? prefix : 'item'
    const finite = typeof index === 'number' && Number.isFinite(index) ? Math.trunc(index) : 0
    const value = Math.min(Math.max(finite, 0), Number.MAX_SAFE_INTEGER)
    return `${head}-${value}`
  } catch {
    return 'item-0'
  }
}

/**
 * Whether `target` is the root itself or lies inside it.
 *
 * `path.relative` handles Windows drive and case differences; an absolute
 * relative result (another volume) and any leading `..` segment are outside.
 */
export function isInside(root: string, target: string): boolean {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(target))
    if (relative.length === 0) return true
    if (path.isAbsolute(relative)) return false
    if (relative === '..') return false
    return !relative.startsWith(`..${path.sep}`)
  } catch {
    return false
  }
}

/** Convert a path-relative value to the forward-slash form used in wire ids. */
export function toPosix(value: string): string {
  try {
    return value.replaceAll('\\', '/')
  } catch {
    return value
  }
}

/**
 * Collapse CR/LF so a user- or resolver-supplied label cannot forge an extra
 * line in the compiled `<amp_attention>` list. Other characters are preserved.
 */
export function oneLine(value: string): string {
  try {
    return value.replaceAll('\r', ' ').replaceAll('\n', ' ')
  } catch {
    return value
  }
}

/**
 * Human byte size for attachment summaries: `512 B`, `84 KB`, `2.1 MB`.
 *
 * Deliberately bounded and deterministic; never reads a byte array.
 */
export function formatBytes(bytes: number): string {
  try {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
    if (bytes < 1024) return `${Math.trunc(bytes)} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  } catch {
    return '0 B'
  }
}

/**
 * Assemble one `WireItem` from a channel draft.
 *
 * Returns `undefined` when the session id is empty, the summary is blank or
 * `wireId` rejects the channel/slot pair, so a single bad mention can never
 * break the capture batch.
 */
export function wireItem(
  agent: unknown,
  sessionId: string,
  turn: number,
  draft: ItemDraft,
): WireItem | undefined {
  try {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const summary = draft.summary.trim()
    if (summary.length === 0) return undefined
    return {
      id: wireId(draft.channel, sessionId, turn, draft.slot),
      channel: draft.channel,
      scope: scopeOf(agent, sessionId, turn),
      pointer: { ...draft.pointer },
      summary,
      scores: { ...draft.scores },
      budget: draft.budget === undefined ? { tokens: ITEM_BUDGET_TOKENS } : { ...draft.budget },
      expiresAt: draft.expiresAt,
      reason: draft.reason,
      trust: draft.trust,
    }
  } catch {
    return undefined
  }
}
