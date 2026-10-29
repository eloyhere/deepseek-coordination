/**
 * AMP v0.1 — common primitives (mirrors `docs/schemas/common.schema.json`).
 *
 * This module is a faithful port of the normative reference in
 * `attention-manifest-protocol/src/types/common.ts`. Field names, literal
 * unions and nullability are part of the wire contract: a consumer of this
 * plugin may compare objects against the reference implementation byte for
 * byte, so nothing here may be renamed or extended.
 *
 * Do not add fields. The schemas set `additionalProperties: false` on the
 * artifacts built from these primitives; an extra property is a rejection, not
 * a tolerated extension.
 */

/** Stable string identifier; see {@link file://./ids.ts} for the grammar. */
export type Id = string

/** `sha256:<64 lowercase hex>` produced by {@link file://./canonical.ts}. */
export type Digest = string

/** RFC 3339 date-time, always UTC (`2026-10-29T04:22:04.000Z`). */
export type Timestamp = string

/** Process id: in AMP a process is an agent, i.e. a person. */
export type Pid = number

/**
 * Credence in [0, 1]. For claims this is DERIVED from tier + evidence, never
 * authored by the model (M-1).
 */
export type Confidence = number

/**
 * Where evidence came from, which caps how far it can promote a claim.
 */
export type Trust = 'self' | 'verified' | 'trusted' | 'asserted' | 'inferred' | 'external'

/**
 * Epistemic investment tier.
 * T0 assumed · T1 sourced (entailment) · T2 observed · T3 tested · T4 replicated
 */
export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4'

/** The tier order, weakest first. Comparisons must use this array, not `localeCompare`. */
export const TierOrder: readonly Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4']

export type RefKind =
  | 'entity'
  | 'concept'
  | 'process'
  | 'thread'
  | 'question'
  | 'hypothesis'
  | 'claim'
  | 'evidence'
  | 'goal'
  | 'plan'
  | 'task'
  | 'tool'
  | 'memory'
  | 'other'
  | 'human'
  | 'agent'
  | 'event'
  | 'handle'
  | 'frame'
  | 'self'
  | 'unknown'
  | 'common-ground'
  | 'capability'
  | 'receipt'
  | 'org'

/** A pointer, not a copy. The ledger stores ids; content lives wherever it lives. */
export interface Ref {
  kind: RefKind
  id: Id
  label?: string
}

export type ProvenanceKind =
  | 'observation'
  | 'testimony'
  | 'inference'
  | 'tool'
  | 'memory'
  | 'document'
  | 'simulation'

export interface Provenance {
  source: string
  kind?: ProvenanceKind
  trust?: Trust
  at?: Timestamp
  digest?: Digest
  note?: string
}

/**
 * Five-dimension attention budget. Dimensions do not convert into each other:
 * spending tokens never buys an extra interrupt.
 */
export interface Budget {
  tokens?: number
  ms?: number
  calls?: number
  interrupts?: number
  money?: number
}

/** What was actually consumed; same five dimensions as {@link Budget}. */
export type Usage = Budget

/** Every budget dimension, in the canonical order used by validation. */
export const BudgetDimensions: readonly (keyof Budget)[] = ['tokens', 'ms', 'calls', 'interrupts', 'money']

export interface Signature {
  role: 'self' | 'host' | 'registry' | 'org' | 'tenant'
  alg: 'ed25519'
  kid: string
  sig: string
}

/** An observable success / abandonment condition. `check` must be executable. */
export interface Criterion {
  id: Id
  statement: string
  check: string
  kind?: 'observe' | 'query' | 'assert'
}

/**
 * Opaque reference to an oversized result. Never a capability token: holding a
 * handle grants no authority the caller did not already have.
 */
export interface Handle {
  id: string
  kind: 'table' | 'text' | 'tree' | 'blob' | 'graph'
  tokens?: number
  bytes?: number
  preview?: string
  scope: 'turn' | 'session' | 'task'
  ttl_ms?: number
}
