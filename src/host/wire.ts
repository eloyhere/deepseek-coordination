/**
 * Wire envelope: the stable contract between DSH facts and AMP attention.
 *
 * P0 defines the envelope, the id grammar, the default channel budgets and the
 * trust-class projection used by later channels. It deliberately imports no
 * Cordis or DSH runtime; `node:crypto` is the only runtime dependency and is
 * used for id truncation.
 */
import { createHash } from 'node:crypto'

/** The sixteen attention channels defined by wire.md §4. */
export const WIRE_CHANNELS = [
  'prompt',
  'goal',
  'plan',
  'tool',
  'workspace',
  'file',
  'attachment',
  'session-ref',
  'steer',
  'inject',
  'spill',
  'retention',
  'prune',
  'compaction',
  'fork',
  'subagent',
] as const

/** One attention channel. */
export type WireChannel = (typeof WIRE_CHANNELS)[number]

/** Wire trust levels. H0 (host-verified) is represented by `host` until a
 * separate verified receipt exists; H1 is the default host observation. */
export const WIRE_TRUSTS = ['host', 'user', 'workspace', 'external', 'derived'] as const

/** One wire trust level. */
export type WireTrust = (typeof WIRE_TRUSTS)[number]

/** The closed exclusion vocabulary from wire.md §4.6. */
export const WIRE_EXCLUSION_REASONS = ['scope', 'expired', 'stale', 'unmounted', 'version', 'budget'] as const

/** One exclusion reason accepted by the AMP compiler. */
export type WireExclusionReason = (typeof WIRE_EXCLUSION_REASONS)[number]

/** A pointer to a domain fact, never an authorization. */
export interface WirePointer {
  readonly kind: string
  readonly id: string
  readonly version: string
  readonly uri?: string
  readonly digest?: string
}

/** The AMP scope an attention item belongs to. */
export interface WireScope {
  readonly tenantId: string
  readonly principalId: string
  readonly sessionId: string
  readonly turnId: string
  readonly workspaceId?: string
}

/** Ranking inputs; AMP defaults `intensity` to 0.5 and sorts by the sum. */
export interface WireScores {
  readonly relevance: number
  readonly urgency: number
  readonly confidence: number
  readonly importance: number
}

/** Budget dimensions used by context compilation. */
export interface WireBudget {
  readonly tokens: number
  readonly bytes?: number
  readonly calls?: number
}

/** One attention candidate in the wire envelope. */
export interface WireItem {
  /** `dsh:<channel>:<sessionId>:<turn>:<slot>` */
  readonly id: string
  readonly channel: WireChannel
  readonly scope: WireScope
  /** Points at a domain fact, not an authorization. */
  readonly pointer: WirePointer
  /** Index information only; never a copy of the source text. */
  readonly summary: string
  readonly scores: WireScores
  readonly budget: WireBudget
  readonly expiresAt: string
  readonly reason: string
  readonly trust: WireTrust
}

/** One reason an item did not enter the compiled package. */
export interface WireExclusion {
  readonly id: string
  readonly version: number
  readonly reason: WireExclusionReason
  readonly pointer?: WirePointer
  readonly note?: string
}

/** How long an item stays eligible, matching the per-channel table. */
export type WireTtl = 'turn' | 'session' | 'step' | 'none'

/** Default budget and candidate cap for one channel. */
export interface ChannelBudget {
  /** Per-item token budget. */
  readonly tokens: number
  /** Candidate cap for one turn; `0` means the channel never creates items. */
  readonly maxItems: number
  /** Eligibility window. */
  readonly ttl: WireTtl
}

/**
 * Default channel budgets from wire.md §4.5.
 *
 * Every positive per-item budget is deliberately well above the serialized
 * projection of one short summary; a compressed item costs roughly its
 * summary plus envelope, and the compiler excludes rather than truncates.
 */
export const DEFAULT_CHANNEL_BUDGETS: Readonly<Record<WireChannel, ChannelBudget>> = {
  prompt: { tokens: 600, maxItems: 1, ttl: 'turn' },
  goal: { tokens: 300, maxItems: 1, ttl: 'session' },
  plan: { tokens: 600, maxItems: 1, ttl: 'session' },
  tool: { tokens: 400, maxItems: 3, ttl: 'turn' },
  workspace: { tokens: 256, maxItems: 1, ttl: 'session' },
  file: { tokens: 256, maxItems: 8, ttl: 'turn' },
  attachment: { tokens: 256, maxItems: 4, ttl: 'session' },
  'session-ref': { tokens: 256, maxItems: 3, ttl: 'turn' },
  steer: { tokens: 256, maxItems: 4, ttl: 'turn' },
  inject: { tokens: 256, maxItems: 4, ttl: 'step' },
  spill: { tokens: 256, maxItems: 4, ttl: 'session' },
  retention: { tokens: 0, maxItems: 0, ttl: 'none' },
  prune: { tokens: 256, maxItems: 2, ttl: 'session' },
  compaction: { tokens: 400, maxItems: 1, ttl: 'session' },
  fork: { tokens: 256, maxItems: 1, ttl: 'session' },
  subagent: { tokens: 256, maxItems: 8, ttl: 'session' },
}

/** Largest candidate set allowed by the default per-channel caps. */
export const DEFAULT_MAX_ITEMS: number = Object.values(DEFAULT_CHANNEL_BUDGETS).reduce(
  (total: number, budget: ChannelBudget): number => total + budget.maxItems,
  0,
)

const SLOT_PATTERN = /^[a-z0-9_-]+$/
const MAX_WIRE_ID_LENGTH = 200
const DIGEST_LENGTH = 12

/**
 * Build one stable wire id: `dsh:<channel>:<sessionId>:<turn>:<slot>`.
 *
 * The slot is the only structural segment the caller chooses freely, so it is
 * restricted to `[a-z0-9_-]`; user text, paths and spaces must never leak into
 * an id. Ids longer than 200 characters keep their semantic prefix and append
 * the first 12 hex characters of the sha256 of the full id.
 *
 * @throws TypeError when the channel, session id, turn or slot is invalid.
 */
export function wireId(channel: WireChannel, sessionId: string, turn: number, slot: string): string {
  if (typeof channel !== 'string' || !(WIRE_CHANNELS as readonly string[]).includes(channel)) {
    throw new TypeError(`wireId: unknown channel ${String(channel)}`)
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('wireId: sessionId must be a non-empty string')
  }
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    throw new TypeError('wireId: turn must be a non-negative integer')
  }
  if (typeof slot !== 'string' || !SLOT_PATTERN.test(slot)) {
    throw new TypeError('wireId: slot must match /^[a-z0-9_-]+$/')
  }
  const base = `dsh:${channel}:${sessionId}:${turn}:${slot}`
  if (base.length <= MAX_WIRE_ID_LENGTH) return base
  const digest = createHash('sha256').update(base).digest('hex').slice(0, DIGEST_LENGTH)
  const keep = MAX_WIRE_ID_LENGTH - DIGEST_LENGTH - 1
  return `${base.slice(0, keep)}-${digest}`
}

/**
 * The subset of AMP `CreateAttentionInput` this host writes.
 *
 * It is declared locally so `wire.ts` never imports the AMP runtime; the shape
 * is structurally identical to `attention-manifest-protocol` 0.7.9 and can be
 * passed to `kernel.flow.compileTurnContext({ create })` unchanged.
 */
export interface CreateAttentionInput {
  readonly id: string
  readonly summary: string
  readonly pointer: WirePointer
  readonly scope: WireScope
  readonly scores: WireScores
  readonly budget: WireBudget
  readonly expiresAt: string
  readonly reason: string
}

/**
 * Map one wire item to an AMP attention declaration.
 *
 * Pure projection: no clock, store or global state is read. `turnId` is
 * authoritative for `scope.turnId`, so a captured item cannot be compiled into
 * a different AMP turn. `trust` stays host-side and is never written into the
 * model payload.
 */
export function toCreateAttention(item: WireItem, turnId: string): CreateAttentionInput {
  return {
    id: item.id,
    summary: item.summary,
    pointer: { ...item.pointer },
    scope: { ...item.scope, turnId },
    scores: { ...item.scores },
    budget: { ...item.budget },
    expiresAt: item.expiresAt,
    reason: item.reason,
  }
}

/** The H0–H5 class AMP evidence uses for one wire trust level. */
export interface TrustClass {
  readonly level: 'H0' | 'H1' | 'H2' | 'H3' | 'H4' | 'H5'
  readonly source: 'operation_history' | 'user_confirmation' | 'system_rule' | 'dialogue' | 'web_search'
  readonly reliability: number
  readonly origin: 'original' | 'secondary'
  /** Only H2 user text and the host contract are trusted instructions. */
  readonly instruction: boolean
}

/**
 * Trust-class projection from wire.md §4.4.
 *
 * `host` maps to H1: a host observation is reliable but neither an independently
 * verified H0 receipt nor a trusted instruction. The host *contract* is a
 * separate trusted-instruction source; an ordinary host observation is data.
 * `derived` is always H4 untrusted data (session snapshots, compaction
 * summaries, inherited subagent transcripts).
 */
export const TRUST_CLASSES: Readonly<Record<WireTrust, TrustClass>> = {
  host: { level: 'H1', source: 'operation_history', reliability: 0.9, origin: 'original', instruction: false },
  user: { level: 'H2', source: 'user_confirmation', reliability: 1, origin: 'original', instruction: true },
  workspace: { level: 'H3', source: 'system_rule', reliability: 0.8, origin: 'original', instruction: false },
  external: { level: 'H5', source: 'web_search', reliability: 0.6, origin: 'original', instruction: false },
  derived: { level: 'H4', source: 'dialogue', reliability: 0.5, origin: 'secondary', instruction: false },
}

/**
 * Resolve one wire trust level to its AMP evidence class.
 *
 * @throws TypeError for an unknown trust value passed from untyped code.
 */
export function trustClass(trust: WireTrust): TrustClass {
  const value = TRUST_CLASSES[trust]
  if (value === undefined) throw new TypeError(`trustClass: unknown trust ${String(trust)}`)
  return value
}
