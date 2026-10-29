/**
 * AMP v0.1 — Warrant Ledger objects and the derivation rules over them.
 *
 * The two rules this module exists for:
 *  - **M-1**: confidence is DERIVED from tier + evidence, never authored.
 *  - **W-5**: tier inflation is a validation failure, not a style issue, and
 *    social pressure without new evidence must not change confidence.
 *
 * Ported from `attention-manifest-protocol/src/warrant/{epistemic,warrant}.ts`.
 * The numeric constants are normative for reproducibility: an implementation
 * that derives 0.712 where the reference derives 0.72 cannot compare receipts.
 */
import type {
  Budget,
  Confidence,
  Digest,
  Id,
  Provenance,
  Ref,
  Tier,
  Timestamp,
  Trust,
} from './types.js'
import { TierOrder } from './types.js'

export type ClaimScope = 'associational' | 'interventional' | 'counterfactual' | 'definitional'

export type ClaimStatus = 'conjecture' | 'held' | 'doubted' | 'contested' | 'retracted'

export type EvidenceKind = 'observation' | 'test' | 'document' | 'testimony' | 'memory' | 'inference'

export type Inference = 'observation' | 'deduction' | 'induction' | 'abduction' | 'testimony' | 'simulation'

export interface EvidenceItem {
  id: Id
  kind: EvidenceKind
  trust: Trust
  /** 0 = same origin as another item, 1 = fully independent. Duplicates are not corroboration. */
  independence: Confidence
  /** Whether this evidence helps, undercuts, or contradicts the claim. */
  relation?: 'supports' | 'undercuts' | 'contradicts'
  /** T1 requires `true`: the source must entail the claim, not merely mention it. */
  entails?: boolean
  /** Provenance root; items sharing an origin count as one effective source. */
  origin?: string
  ref?: Ref
  excerpt?: string
  digest?: Digest
  at: Timestamp
}

export interface Warrant {
  evidence: EvidenceItem[]
  inference: Inference
  /** Duhem–Quine: a refutation always hits a conjunction. Empty array is malformed for a negative result. */
  auxiliary_assumptions?: string[]
  strength: Confidence
}

export interface CausalClaim {
  assignment_mechanism: 'observed' | 'assigned' | 'randomized' | 'natural_experiment'
  identification_strategy?: string
  identifying_assumption?: string
  adjustment_set?: string[]
  dag_digest?: Digest
}

export interface Alternative {
  statement: string
  confidence: Confidence
  reason_rejected?: string
}

export interface BaseRate {
  value: Confidence
  source?: string
}

export interface Claim {
  amp: '0.1'
  kind: 'claim'
  id: Id
  statement: string
  structured?: {
    subject?: Ref
    relation?: string
    value?: unknown
  }
  claim_scope?: ClaimScope
  tier: Tier
  confidence?: Confidence
  status: ClaimStatus
  would_be_false_if?: string
  check_run_id?: string
  causal?: CausalClaim
  warrant: Warrant
  alternatives?: Alternative[]
  disconfirming?: Ref[]
  base_rate?: BaseRate
  looks?: number
  scope?: string
  provenance: Provenance
  created: Timestamp
  expires?: Timestamp
  supersedes?: Ref
  revision?: {
    reason: string
    at: Timestamp
  }
}

export type HypothesisStatus =
  | 'proposed'
  | 'testing'
  | 'supported'
  | 'refuted'
  | 'inconclusive'
  | 'out_of_scope'

export interface Prereg {
  hash: Digest
  registered_at: Timestamp
  metric: string
  stopping: string
  exclusions?: string[]
  looks?: number
}

export interface TestSpec {
  method: string
  observation: string
  cost?: Budget
}

export interface Hypothesis {
  amp: '0.1'
  kind: 'hypothesis'
  id: Id
  question: Ref
  statement: string
  prediction: string
  /** The observation that would overturn it. Without this, it is a position, not a hypothesis. */
  refutes_if: string
  auxiliary_assumptions?: string[]
  prereg?: Prereg
  test?: TestSpec
  labels?: Array<'confirmatory' | 'exploratory' | 'replication'>
  status: HypothesisStatus
  evidence?: Ref[]
  created: Timestamp
  closed?: Timestamp
}

export interface UnknownItem {
  amp: '0.1'
  kind: 'unknown'
  id: Id
  question: string
  importance: Confidence
  blocking: boolean
  since: Timestamp
  resolve_cost?: Budget
  attempts?: Ref[]
  status?: 'open' | 'probing' | 'assumed' | 'resolved' | 'abandoned'
}

export type EpistemicObject = Claim | Hypothesis | UnknownItem

/* ------------------------------------------------------------------------- *
 * Derivation
 * ------------------------------------------------------------------------- */

const TierBase: Record<Tier, number> = {
  T0: 0.35,
  T1: 0.55,
  T2: 0.72,
  T3: 0.85,
  T4: 0.92,
}

/** A chain is as strong as its weakest source, so the cap is the minimum. */
const TrustCap: Record<EvidenceItem['trust'], number> = {
  self: 0.9,
  verified: 0.95,
  trusted: 0.85,
  asserted: 0.7,
  inferred: 0.6,
  external: 0.5,
}

const round = (n: number): number => Math.round(n * 1000) / 1000

/** Distinct origins, not distinct URLs. Ten retellings of one source are one source. */
export function effectiveOrigins(evidence: EvidenceItem[]): number {
  return new Set(evidence.map((item) => item.origin ?? item.id)).size
}

/**
 * Confidence is DERIVED (M-1), never authored by the model.
 * Tier sets the base, evidence quality moves it, the weakest source caps it.
 */
export function deriveConfidence(claim: Pick<Claim, 'tier' | 'warrant'>): number {
  const base = TierBase[claim.tier]
  const evidence = claim.warrant.evidence
  if (evidence.length === 0) {
    return round(Math.min(base, 0.6))
  }

  const origins = effectiveOrigins(evidence)
  const avgIndependence = evidence.reduce((sum, item) => sum + (item.independence ?? 0.5), 0) / evidence.length
  const corroboration = Math.min(1, (origins - 1) / 2)
  const support =
    evidence.reduce((sum, item) => {
      const weight = item.independence ?? 0.5
      if (item.relation === 'contradicts') {
        return sum - weight
      }
      if (item.relation === 'undercuts') {
        return sum - 0.5 * weight
      }
      return sum + weight
    }, 0) / evidence.length
  const cap = Math.min(...evidence.map((item) => TrustCap[item.trust]))

  const raw = base + 0.12 * corroboration + 0.1 * avgIndependence + 0.08 * support
  return round(Math.max(0, Math.min(raw, cap)))
}

/**
 * Tier inflation is a validation failure, not a style issue (W-5).
 * Returns human-readable violations; empty means admissible.
 */
export function validateClaim(claim: Claim): string[] {
  const problems: string[] = []
  const evidence = claim.warrant.evidence

  if (claim.tier !== 'T0' && evidence.length === 0) {
    problems.push(`${claim.tier} requires at least one evidence item`)
  }
  if (claim.tier === 'T1' && !evidence.some((item) => item.entails === true)) {
    problems.push('T1 requires a source that entails the claim (entails: true)')
  }
  if (claim.tier === 'T2' && !evidence.some((item) => item.trust === 'self' || item.trust === 'verified')) {
    problems.push('T2 requires an observation recorded by this agent')
  }
  if (claim.tier === 'T3') {
    if (!claim.causal || claim.causal.assignment_mechanism === 'observed') {
      problems.push('T3 requires an intervention, randomization, or named identification strategy')
    }
  }
  if (claim.tier === 'T4' && effectiveOrigins(evidence) < 2) {
    problems.push('T4 requires an independent replication (at least two origins)')
  }
  if (
    claim.causal &&
    claim.causal.assignment_mechanism === 'observed' &&
    claim.claim_scope === 'interventional'
  ) {
    problems.push(
      'observational data cannot support an interventional claim without an identification strategy',
    )
  }

  return problems
}

/** A hypothesis without a refutation condition is a position, not a hypothesis (W-2). */
export function validateHypothesis(hypothesis: Hypothesis): string[] {
  const problems: string[] = []
  if (!hypothesis.refutes_if || hypothesis.refutes_if.trim().length === 0) {
    problems.push('refutes_if is required')
  }
  if (!hypothesis.prediction || hypothesis.prediction.trim().length === 0) {
    problems.push('prediction is required')
  }
  return problems
}

type HypothesisClass = 'confirmatory' | 'exploratory'

/** Registered before data access → confirmatory; otherwise → exploratory (no HARKing). */
export function classifyHypothesis(hypothesis: Hypothesis): HypothesisClass {
  return hypothesis.prereg ? 'confirmatory' : 'exploratory'
}

/**
 * Contested or doubted claims may enter a Frame but must not authorize effects.
 * Returns false whenever the claim is not carried beyond reasonable doubt.
 */
export function canAuthorizeEffect(claim: Claim, minTier: Tier): boolean {
  if (claim.status !== 'held') {
    return false
  }
  const rank = TierOrder.indexOf(claim.tier)
  if (rank < TierOrder.indexOf(minTier)) {
    return false
  }
  const confidence = claim.confidence ?? deriveConfidence(claim)
  return confidence >= 0.6
}

/**
 * Minimal-change revision: the old claim is kept and referenced, never
 * overwritten (W-3).
 */
export function reviseClaim(previous: Claim, patch: Partial<Claim>, reason: string, at: string): Claim {
  return {
    ...previous,
    ...patch,
    id: `${previous.id}.r${(previous.revision ? 1 : 0) + 1}`,
    supersedes: { kind: 'claim', id: previous.id },
    revision: { reason, at },
    created: previous.created,
  }
}

/** Suggested tier for a claim — used only to warn, never to promote silently. */
export function suggestTier(evidence: EvidenceItem[]): Tier {
  if (evidence.length === 0) {
    return 'T0'
  }
  if (effectiveOrigins(evidence) >= 2 && evidence.some((item) => item.trust === 'verified')) {
    return 'T4'
  }
  if (evidence.some((item) => item.trust === 'self' || item.trust === 'verified')) {
    return 'T2'
  }
  if (evidence.some((item) => item.entails === true)) {
    return 'T1'
  }
  return 'T0'
}

/**
 * Social pressure without new evidence must not change confidence (W-5).
 * The runtime calls this before appending a claim.
 */
export function pressureBlocked(
  existing: Claim | undefined,
  evidence: EvidenceItem[],
  underPressure: boolean,
): boolean {
  return underPressure && existing !== undefined && evidence.length === 0
}
