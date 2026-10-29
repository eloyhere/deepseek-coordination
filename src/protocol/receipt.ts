/**
 * AMP v0.1 — settlement objects: `receipt` | `event`.
 *
 * Receipts are the only ground truth for calibration; events are the
 * append-only log. A receipt is not a capability, and a `handle` on one is a
 * pointer to content the caller could already read — never an authorisation.
 *
 * Ported from `attention-manifest-protocol/src/receipt/receipt.ts`; the
 * factories below add the validation the reference leaves to its callers, so a
 * malformed settlement object is refused at construction instead of being
 * stored and discovered by a consumer.
 */
import type { Confidence, Digest, Handle, Id, Ref, Timestamp, Usage } from './types.js'
import { BudgetDimensions } from './types.js'
import { digestOf } from './canonical.js'
import { isId } from './ids.js'
import { BoundaryRejection } from './errors.js'

export type ReceiptOp = 'attend' | 'act' | 'ask' | 'note' | 'plan' | 'reflect' | 'read'

export type Outcome = 'success' | 'partial' | 'failure' | 'blocked'

export interface Receipt {
  amp: '0.1'
  kind: 'receipt'
  id: Id
  op: ReceiptOp
  target?: Ref
  at: Timestamp
  ms?: number
  usage: Usage
  outcome: Outcome
  /** Recorded before the action; compared with realized_voi to calibrate the controller. */
  predicted_voi?: Confidence
  realized_voi?: Confidence
  handle?: Handle
  note?: string
}

/** Named `AmpEvent` to avoid shadowing the DOM `Event`. */
export interface AmpEvent {
  amp: '0.1'
  kind: 'event'
  id: Id
  at: Timestamp
  actor: Ref
  type: string
  caused_by?: Id
  refs?: Ref[]
  digest: Digest
  payload?: Record<string, unknown>
}

export type SettlementObject = Receipt | AmpEvent

export const ReceiptOps: readonly ReceiptOp[] = ['attend', 'act', 'ask', 'note', 'plan', 'reflect', 'read']

export const Outcomes: readonly Outcome[] = ['success', 'partial', 'failure', 'blocked']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const checkBudgetShape = (value: unknown, at: string, problems: string[]): void => {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object`)
    return
  }
  for (const key of Object.keys(value)) {
    const amount = value[key]
    if (!(BudgetDimensions as readonly string[]).includes(key)) {
      problems.push(`${at}.${key} is not a budget dimension`)
      continue
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      problems.push(`${at}.${key} must be a non-negative finite number`)
    }
  }
}

/**
 * Every problem that makes `receipt` unstorable. Empty means admissible.
 *
 * A receipt with no `at`, an unknown `op`/`outcome`, a negative `ms` or a VOI
 * outside [0, 1] is refused: calibration reads these fields numerically, so a
 * malformed one corrupts every aggregate built on it.
 */
export function validateReceipt(receipt: Receipt): string[] {
  const problems: string[] = []
  if (receipt.amp !== '0.1' || receipt.kind !== 'receipt') {
    problems.push('not an AMP v0.1 receipt')
  }
  if (!isId(receipt.id)) {
    problems.push('id is not a valid AMP id')
  }
  if (!ReceiptOps.includes(receipt.op)) {
    problems.push('op is not a receipt op')
  }
  if (!Outcomes.includes(receipt.outcome)) {
    problems.push('outcome is not success|partial|failure|blocked')
  }
  if (typeof receipt.at !== 'string' || Number.isNaN(Date.parse(receipt.at))) {
    problems.push('at is not a date-time')
  }
  if (receipt.ms !== undefined && (typeof receipt.ms !== 'number' || !Number.isFinite(receipt.ms) || receipt.ms < 0)) {
    problems.push('ms must be a non-negative finite number')
  }
  checkBudgetShape(receipt.usage, 'usage', problems)
  for (const field of ['predicted_voi', 'realized_voi'] as const) {
    const value = receipt[field]
    if (value !== undefined && (typeof value !== 'number' || value < 0 || value > 1)) {
      problems.push(`${field} must be in [0,1]`)
    }
  }
  if (receipt.target !== undefined) {
    if (typeof receipt.target !== 'object' || receipt.target === null) {
      problems.push('target must be a Ref object')
    } else if (typeof receipt.target.kind !== 'string' || !isId(receipt.target.id)) {
      problems.push('target must have a string kind and a valid id')
    }
  }
  if (receipt.handle !== undefined && !isId(receipt.handle.id)) {
    problems.push('handle.id is not a valid AMP id')
  }
  if (receipt.handle !== undefined) {
    const kind = receipt.handle.kind
    if (kind !== 'table' && kind !== 'text' && kind !== 'tree' && kind !== 'blob' && kind !== 'graph') {
      problems.push('handle.kind is not table|text|tree|blob|graph')
    }
    const scope = receipt.handle.scope
    if (scope !== 'turn' && scope !== 'session' && scope !== 'task') {
      problems.push('handle.scope is not turn|session|task')
    }
  }
  return problems
}

/** Throws `BoundaryRejection` with every problem when the receipt is malformed. */
export function assertReceipt(receipt: Receipt): Receipt {
  const problems = validateReceipt(receipt)
  if (problems.length > 0) {
    throw new BoundaryRejection('invalid_tool_args', problems)
  }
  return receipt
}

/** Input accepted by {@link makeReceipt}; `amp`/`kind`/`at` are filled here. */
export interface ReceiptInput {
  id: Id
  op: ReceiptOp
  outcome: Outcome
  at?: Timestamp
  target?: Ref
  ms?: number
  usage?: Usage
  predicted_voi?: Confidence
  realized_voi?: Confidence
  handle?: Handle
  note?: string
}

/**
 * Builds and validates one receipt.
 *
 * `usage` defaults to `{}` — an empty usage map is honest ("nothing measured"),
 * whereas `{tokens: 0}` would claim a measurement that was never taken.
 */
export function makeReceipt(input: ReceiptInput): Receipt {
  const receipt: Receipt = {
    amp: '0.1',
    kind: 'receipt',
    id: input.id,
    op: input.op,
    at: input.at ?? new Date().toISOString(),
    usage: input.usage ?? {},
    outcome: input.outcome,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.ms === undefined ? {} : { ms: input.ms }),
    ...(input.predicted_voi === undefined ? {} : { predicted_voi: input.predicted_voi }),
    ...(input.realized_voi === undefined ? {} : { realized_voi: input.realized_voi }),
    ...(input.handle === undefined ? {} : { handle: input.handle }),
    ...(input.note === undefined ? {} : { note: input.note }),
  }
  return assertReceipt(receipt)
}

/** Input accepted by {@link makeEvent}. */
export interface EventInput {
  id: Id
  actor: Ref
  type: string
  at?: Timestamp
  caused_by?: Id
  refs?: Ref[]
  payload?: Record<string, unknown>
}

/** Digest of an event body: every field except `digest`. */
export function eventDigest(event: Omit<AmpEvent, 'digest'>): Digest {
  return digestOf(event)
}

/**
 * Builds one append-only log event. `type` is open-ended by design (AMP treats
 * event types as data), but it must be non-empty so a reader never sees an
 * untyped row.
 */
export function makeEvent(input: EventInput): AmpEvent {
  if (!isId(input.id)) {
    throw new BoundaryRejection('invalid_id', [`${input.id} is not a valid AMP id`])
  }
  if (input.type.trim().length === 0) {
    throw new BoundaryRejection('invalid_id', ['event type must be non-empty'])
  }
  if (typeof input.actor !== 'object' || input.actor === null || !isId(input.actor.id)) {
    throw new BoundaryRejection('invalid_id', ['event actor must be a Ref with a valid id'])
  }
  const body: Omit<AmpEvent, 'digest'> = {
    amp: '0.1',
    kind: 'event',
    id: input.id,
    at: input.at ?? new Date().toISOString(),
    actor: input.actor,
    type: input.type,
    ...(input.caused_by === undefined ? {} : { caused_by: input.caused_by }),
    ...(input.refs === undefined ? {} : { refs: input.refs }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  }
  return { ...body, digest: eventDigest(body) }
}

/** Recomputes an event digest; `false` means the row was rewritten. */
export function verifyEventDigest(event: AmpEvent): boolean {
  const { digest, ...body } = event
  return eventDigest(body) === digest
}
