/**
 * AMP v0.1 — the attention-request / interrupt pair.
 *
 * These are the two objects a host needs before it may spend a human's
 * attention: a request that says *why now* and *what happens if ignored*, and a
 * record that says what was actually decided and what it cost. The reference
 * keeps policy (quiet hours, cooldowns, debt) in `AttentionBroker`; this port
 * keeps the **objects** and their validation, which is what the boundary here
 * emits.
 *
 * Ported from `attention-manifest-protocol/src/attention/{socialTypes,interrupts}.ts`.
 * The interrupts an approval/question window produces are recorded as one
 * `InterruptRecord` plus one `ask` receipt, exactly as the reference's
 * `AttentionLedger.submit` does.
 */
import type { Budget, Confidence, Id, Ref, Timestamp } from './types.js'
import { BudgetDimensions } from './types.js'
import { isId } from './ids.js'
import { BoundaryRejection } from './errors.js'

export type InterruptClass = 'safety' | 'commitment' | 'opportunity' | 'curiosity'

export const InterruptClasses: readonly InterruptClass[] = [
  'safety',
  'commitment',
  'opportunity',
  'curiosity',
]

export type InterruptStatus =
  | 'granted'
  | 'deferred'
  | 'denied'
  | 'answered'
  | 'expired'
  | 'withdrawn'

export const InterruptStatuses: readonly InterruptStatus[] = [
  'granted',
  'deferred',
  'denied',
  'answered',
  'expired',
  'withdrawn',
]

/** A request to spend a human's attention, with the cost of ignoring it. */
export interface AttentionRequest {
  amp: '0.1'
  kind: 'attention-request'
  id: Id
  from: Ref
  to: Ref
  target: Ref
  class: InterruptClass
  urgency: 1 | 2 | 3 | 4 | 5
  why_now: string
  if_ignored: string
  cost: Budget
  expected_value?: Confidence
  expires?: Timestamp
  fallback: 'queue' | 'drop' | 'escalate'
}

/** What happened to that request: one record per settled window. */
export interface InterruptRecord {
  amp: '0.1'
  kind: 'interrupt'
  id: Id
  request: Id
  class: InterruptClass
  target: Ref
  urgency: number
  granted: boolean
  status: InterruptStatus
  cost: Budget
  at: Timestamp
  expires?: Timestamp
  debt_weight: number
  reason: string
  receipt: Id
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const checkBudget = (value: unknown, at: string, problems: string[]): void => {
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

const checkRef = (value: unknown, at: string, problems: string[]): void => {
  if (!isRecord(value) || typeof value.kind !== 'string' || !isId(value.id)) {
    problems.push(`${at} must be a Ref with a string kind and a valid id`)
  }
}

const checkTimestamp = (value: unknown, at: string, problems: string[]): void => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    problems.push(`${at} must be a date-time`)
  }
}

/** Every problem that makes an `AttentionRequest` unstorable. */
export function validateAttentionRequest(request: AttentionRequest): string[] {
  const problems: string[] = []
  if (request.amp !== '0.1' || request.kind !== 'attention-request') {
    problems.push('not an AMP v0.1 attention request')
  }
  if (!isId(request.id)) problems.push('id is not a valid AMP id')
  checkRef(request.from, 'from', problems)
  checkRef(request.to, 'to', problems)
  checkRef(request.target, 'target', problems)
  if (!InterruptClasses.includes(request.class)) problems.push('class is not an interrupt class')
  if (!Number.isInteger(request.urgency) || request.urgency < 1 || request.urgency > 5) {
    problems.push('urgency must be an integer in [1,5]')
  }
  if (typeof request.why_now !== 'string' || request.why_now.trim().length === 0) {
    problems.push('why_now is empty')
  }
  if (typeof request.if_ignored !== 'string' || request.if_ignored.trim().length === 0) {
    problems.push('if_ignored is empty')
  }
  checkBudget(request.cost, 'cost', problems)
  if (request.expected_value !== undefined) {
    if (
      typeof request.expected_value !== 'number' ||
      request.expected_value < 0 ||
      request.expected_value > 1
    ) {
      problems.push('expected_value must be in [0,1]')
    }
  }
  if (request.expires !== undefined) checkTimestamp(request.expires, 'expires', problems)
  if (request.fallback !== 'queue' && request.fallback !== 'drop' && request.fallback !== 'escalate') {
    problems.push('fallback is not queue|drop|escalate')
  }
  return problems
}

/** Every problem that makes an `InterruptRecord` unstorable. */
export function validateInterruptRecord(record: InterruptRecord): string[] {
  const problems: string[] = []
  if (record.amp !== '0.1' || record.kind !== 'interrupt') {
    problems.push('not an AMP v0.1 interrupt record')
  }
  if (!isId(record.id)) problems.push('id is not a valid AMP id')
  if (!isId(record.request)) problems.push('request is not a valid AMP id')
  if (!isId(record.receipt)) problems.push('receipt is not a valid AMP id')
  if (!InterruptClasses.includes(record.class)) problems.push('class is not an interrupt class')
  checkRef(record.target, 'target', problems)
  if (!Number.isInteger(record.urgency) || record.urgency < 1 || record.urgency > 5) {
    problems.push('urgency must be an integer in [1,5]')
  }
  if (typeof record.granted !== 'boolean') problems.push('granted must be a boolean')
  if (!InterruptStatuses.includes(record.status)) problems.push('status is not an interrupt status')
  checkBudget(record.cost, 'cost', problems)
  checkTimestamp(record.at, 'at', problems)
  if (record.expires !== undefined) checkTimestamp(record.expires, 'expires', problems)
  if (typeof record.debt_weight !== 'number' || !Number.isFinite(record.debt_weight) || record.debt_weight < 0) {
    problems.push('debt_weight must be a non-negative finite number')
  }
  if (typeof record.reason !== 'string' || record.reason.trim().length === 0) {
    problems.push('reason is empty')
  }
  // The status and the boolean must agree; a "denied" record cannot be granted.
  const grantedStatuses: InterruptStatus[] = ['granted', 'answered']
  if (grantedStatuses.includes(record.status) !== record.granted) {
    problems.push('granted disagrees with status')
  }
  return problems
}

/** Input of {@link buildAttentionRequest}; `amp`/`kind` are filled here. */
export interface AttentionRequestInput {
  id: Id
  from: Ref
  to: Ref
  target: Ref
  class: InterruptClass
  urgency: 1 | 2 | 3 | 4 | 5
  why_now: string
  if_ignored: string
  cost?: Budget
  expected_value?: Confidence
  expires?: Timestamp
  fallback?: 'queue' | 'drop' | 'escalate'
}

/** Builds and validates one attention request. */
export function buildAttentionRequest(input: AttentionRequestInput): AttentionRequest {
  const request: AttentionRequest = {
    amp: '0.1',
    kind: 'attention-request',
    id: input.id,
    from: input.from,
    to: input.to,
    target: input.target,
    class: input.class,
    urgency: input.urgency,
    why_now: input.why_now,
    if_ignored: input.if_ignored,
    cost: input.cost ?? { interrupts: 1 },
    fallback: input.fallback ?? 'escalate',
    ...(input.expected_value === undefined ? {} : { expected_value: input.expected_value }),
    ...(input.expires === undefined ? {} : { expires: input.expires }),
  }
  const problems = validateAttentionRequest(request)
  if (problems.length > 0) throw new BoundaryRejection('invalid_tool_args', problems)
  return request
}

/** Input of {@link buildInterruptRecord}; `amp`/`kind` are filled here. */
export interface InterruptRecordInput {
  id: Id
  request: Id
  class: InterruptClass
  target: Ref
  urgency: number
  status: InterruptStatus
  at: Timestamp
  cost?: Budget
  expires?: Timestamp
  debt_weight?: number
  reason: string
  receipt: Id
}

/**
 * Builds one interrupt record. `granted` is derived from `status` — the two can
 * never disagree, which is what W-4-style validation checks for.
 */
export function buildInterruptRecord(input: InterruptRecordInput): InterruptRecord {
  const granted = input.status === 'granted' || input.status === 'answered'
  const record: InterruptRecord = {
    amp: '0.1',
    kind: 'interrupt',
    id: input.id,
    request: input.request,
    class: input.class,
    target: input.target,
    urgency: input.urgency,
    granted,
    status: input.status,
    cost: input.cost ?? { interrupts: granted ? 1 : 0 },
    at: input.at,
    debt_weight: input.debt_weight ?? input.urgency,
    reason: input.reason,
    receipt: input.receipt,
    ...(input.expires === undefined ? {} : { expires: input.expires }),
  }
  const problems = validateInterruptRecord(record)
  if (problems.length > 0) throw new BoundaryRejection('invalid_tool_args', problems)
  return record
}

/** The receipt outcome an interrupt status settles to (reference mapping). */
export function interruptOutcome(status: InterruptStatus): 'success' | 'partial' | 'blocked' {
  if (status === 'granted' || status === 'answered') return 'success'
  if (status === 'deferred' || status === 'expired' || status === 'withdrawn') return 'partial'
  return 'blocked'
}
