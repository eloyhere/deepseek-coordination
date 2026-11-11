/**
 * AMP context-prune state machine for the plugin's own attention entries.
 *
 * Every step mints step-scoped attention objects, and AMP persists each one.
 * Nothing ever decided which of those entries were still worth keeping, so the
 * store grew one step at a time and `/amp/context` could only say "they were
 * created". This module runs AMP's planner over the entries a session actually
 * submitted and records the resulting checkpoint.
 *
 * ## The one mirrored transition
 *
 * AMP 0.9.1 exports `planContextPrune`, `approveContextPrune` and
 * `rejectContextPrune`, and its exported `CONTEXT_PRUNE_TRANSITIONS` declares
 * `approved -> applied`, but no function performs that edge — `planState` is
 * private — while `compactContext` requires `state === "applied"`. The plugin
 * therefore validates the edge against AMP's own exported transition table and
 * bumps the plan version exactly like AMP's internal `planState`. This is the
 * smallest possible shim: it invents no state and no digest.
 *
 * Fail-open contract: `review` returns `undefined` on any planner or
 * compaction error and counts it; a prune review can never fail a turn.
 */
import type { AttentionObject } from 'attention-manifest-protocol/attention'
import {
  CONTEXT_PRUNE_TRANSITIONS,
  advanceContextCheckpoint,
  approveContextPrune,
  attentionPriority,
  compactContext,
  planContextPrune,
  verifyContextCompaction,
} from 'attention-manifest-protocol/context'
import type {
  ContextCheckpoint,
  ContextPruneCandidate,
  ContextPruneDecision,
  ContextPrunePlan,
  ContextPrunePolicy,
} from 'attention-manifest-protocol/context'
import type { PruneRecord } from './prune.js'

/** Decisions projected into diagnostics; the counts still report every one. */
export const MAX_PRUNE_DECISIONS = 50

/** Entries a session may accumulate before the oldest are forgotten host-side. */
export const MAX_SUBMITTED_ENTRIES = 400

/** Defaults when a deployment (or a test fixture) omits the policy. */
export const DEFAULT_CONTEXT_PRUNE_POLICY = {
  keepRecent: 24,
  maxEntries: 200,
  maxTokens: 20_000,
} as const

/** A compact, JSON-safe view of one prune outcome for diagnostics. */
export interface ContextPruneOutcome {
  readonly planId: string
  readonly state: ContextPrunePlan['state']
  readonly verified: boolean
  readonly checkpoint: ContextCheckpoint
  readonly savedTokens: number
  readonly kept: number
  readonly pruned: number
  /** Total decisions; `decisions` is capped for diagnostics. */
  readonly decisionCount: number
  readonly decisions: readonly ContextPruneDecision[]
  readonly at: string
}

/** Counters for `/amp/context`; cumulative for the process. */
export interface ContextPruneStats {
  readonly reviews: number
  readonly applied: number
  readonly verified: number
  readonly failed: number
  readonly savedTokens: number
  readonly lastPruned: number
  readonly lastKept: number
  readonly lastAt?: string
}

/** Coerce one policy bound; invalid values fall back instead of throwing later. */
function boundOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.trunc(value)
}

/**
 * Advance an approved plan to `applied`.
 *
 * Mirrors AMP's private `planState` for the one edge AMP publishes but does not
 * expose; see the module comment.
 */
export function applyContextPrune(plan: ContextPrunePlan): ContextPrunePlan {
  if (!CONTEXT_PRUNE_TRANSITIONS[plan.state]?.includes('applied')) {
    throw new TypeError(`cannot apply a context prune plan in state ${plan.state}`)
  }
  return { ...plan, state: 'applied', version: plan.version + 1 }
}

/** Flatten the pointer ids an attention object references. */
function referencesOf(object: AttentionObject): string[] {
  const ids: string[] = []
  const groups = object.references as unknown as Record<string, readonly { id?: unknown }[]> | undefined
  if (groups === undefined || groups === null) return ids
  for (const group of Object.values(groups)) {
    if (!Array.isArray(group)) continue
    for (const pointer of group) {
      if (typeof pointer?.id === 'string') ids.push(pointer.id)
    }
  }
  return ids
}

/**
 * Project one attention object into an AMP prune candidate.
 *
 * `tokens` approximates the serialized projection AMP charges for one item
 * (summary + envelope), matching the compiler's accounting order of magnitude.
 * `active` must come from the caller: every persisted attention object is
 * mounted, so deriving it from `mounted` would protect the whole queue and make
 * the planner a no-op. The optimizer marks only the current step's entries.
 */
export function candidateOf(object: AttentionObject, active = false): ContextPruneCandidate {
  const summary = typeof object.summary === 'string' ? object.summary : ''
  return {
    id: object.id,
    tokens: Math.max(1, Math.ceil((summary.length + 160) / 4)),
    score: attentionPriority(object),
    createdAt: object.createdAt,
    lastAccessAt: typeof object.updatedAt === 'string' ? object.updatedAt : object.createdAt,
    expiresAt: object.expiresAt,
    ...(active ? { active: true } : {}),
    references: referencesOf(object),
  }
}

/**
 * Project one DSH `compaction/prune` record into an AMP prune candidate.
 *
 * `prune.ts` observes what DSH's own pruner did; this makes those facts enter
 * AMP's decision instead of sitting in a side ledger. The record is marked
 * `superseded` when its replacement was observed, so AMP reports that exact
 * reason rather than a generic `cold`.
 *
 * @param sessionId - owning session, part of the stable candidate id.
 * @param record - one retained DSH prune record.
 */
export function pruneRecordCandidate(sessionId: string, record: PruneRecord): ContextPruneCandidate {
  const start = record.shadowedRange.start
  const end = record.shadowedRange.end
  return {
    id: `dsh:prune:${sessionId}:${start}`,
    tokens: record.shadowedTokenCount > 0
      ? record.shadowedTokenCount
      : Math.max(1, Math.ceil(Math.max(0, end - start) / 4)),
    score: 0,
    createdAt: record.at,
    lastAccessAt: record.at,
    ...(record.replacementSeq === undefined ? {} : { supersededBy: `dsh:prune:${sessionId}:${record.replacementSeq}` }),
    ...(record.callId === undefined ? {} : { references: [`dsh:tool:${record.callId}`] }),
  }
}

/** Runs AMP's prune pipeline and remembers the counters. */export class ContextPruner {
  private readonly policy: ContextPrunePolicy
  private readonly now: () => string
  private reviews = 0
  private applied = 0
  private verified = 0
  private failed = 0
  private savedTokens = 0
  private lastPruned = 0
  private lastKept = 0
  private lastAt: string | undefined

  constructor(policy: Partial<ContextPrunePolicy> = {}, options: { now?: () => string } = {}) {
    this.policy = {
      keepRecent: boundOf(policy.keepRecent, DEFAULT_CONTEXT_PRUNE_POLICY.keepRecent),
      maxEntries: boundOf(policy.maxEntries, DEFAULT_CONTEXT_PRUNE_POLICY.maxEntries),
      maxTokens: boundOf(policy.maxTokens, DEFAULT_CONTEXT_PRUNE_POLICY.maxTokens),
      ...(typeof policy.minScore === 'number' && Number.isFinite(policy.minScore) ? { minScore: policy.minScore } : {}),
    }
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** The effective policy, for status and tests. */
  get effectivePolicy(): ContextPrunePolicy {
    return { ...this.policy }
  }

  /**
   * Plan, approve, apply, compact and verify one session's entries.
   *
   * @returns the outcome, or `undefined` when there is nothing to decide or
   * AMP rejected the compaction (counted in `failed`).
   */
  review(candidates: readonly ContextPruneCandidate[], reason = 'context budget maintenance'): ContextPruneOutcome | undefined {
    if (candidates.length === 0) return undefined
    const now = this.now()
    this.reviews += 1
    try {
      const draft = planContextPrune(candidates, this.policy, { now, reason })
      const applied = applyContextPrune(approveContextPrune(draft))
      const compaction = compactContext(candidates, applied, {
        now,
        summary: `pruned ${applied.pruned.length} attention entries for ${reason}`,
      })
      const verified = verifyContextCompaction(candidates, compaction.checkpoint)
      const checkpoint = verified
        ? advanceContextCheckpoint(compaction.checkpoint, 'verified')
        : compaction.checkpoint
      this.applied += 1
      if (verified) this.verified += 1
      this.savedTokens += checkpoint.savedTokens
      this.lastPruned = applied.pruned.length
      this.lastKept = applied.kept.length
      this.lastAt = now
      return {
        planId: applied.id,
        state: applied.state,
        verified,
        checkpoint,
        savedTokens: checkpoint.savedTokens,
        kept: applied.kept.length,
        pruned: applied.pruned.length,
        decisionCount: applied.decisions.length,
        decisions: applied.decisions.slice(0, MAX_PRUNE_DECISIONS),
        at: now,
      }
    } catch {
      this.failed += 1
      return undefined
    }
  }

  /** Counters for `/amp/context`; never throws. */
  stats(): ContextPruneStats {
    return {
      reviews: this.reviews,
      applied: this.applied,
      verified: this.verified,
      failed: this.failed,
      savedTokens: this.savedTokens,
      lastPruned: this.lastPruned,
      lastKept: this.lastKept,
      ...(this.lastAt === undefined ? {} : { lastAt: this.lastAt }),
    }
  }
}
