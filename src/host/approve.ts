/**
 * The approval centre behind `coordination_approve`.
 *
 * It owns the round-trip a notification cannot do:
 *
 *  - `open` validates a model request, registers one waiting window for the
 *    calling session and returns a promise the tool awaits;
 *  - `list` is what the client polls — it never drains, because the dialog must
 *    keep showing the same request until the human answers it;
 *  - `answer` / `cancel` settle exactly one window, and `cancelAll` (plugin
 *    unload) settles every window as `cancelled`;
 *  - every window carries an expiry timer, so a model that asks a question the
 *    human never sees cannot block the agent loop forever.
 *
 * Invariants: the outcome is never invented (`approved` only from an explicit
 * `approved: true`), the session on the answer must match the session that
 * opened the window, and nothing is persisted or replayed after a restart.
 */
import { randomBytes } from 'node:crypto'
import { InvalidArgumentError, InvalidStateError } from '../shared/error.js'
import {
  APPROVAL_LIMITS,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalView,
} from '../shared/approve.js'
import { SystemClock, type Clock } from './handle.js'

/** One settled or waiting window. */
interface PendingApproval {
  readonly view: ApprovalView
  readonly resolve: (outcome: ApprovalOutcome) => void
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** What `open` hands back: the id the client answers and the promise to await. */
export interface ApprovalOpenResult {
  readonly id: string
  readonly expires: number
  readonly promise: Promise<ApprovalOutcome>
}

export interface ApprovalCenterOptions {
  /** Injected clock, so expiry metadata is deterministic in tests. */
  clock?: Clock
  /** Per-session waiting limit; defaults to {@link APPROVAL_LIMITS.pendingPerSession}. */
  pendingPerSession?: number
}

const REQUEST_KEYS = new Set(['title', 'message', 'detail', 'approveLabel', 'rejectLabel', 'timeout'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredMessage(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidArgumentError('message must be a string')
  const message = value.trim()
  if (message.length === 0) throw new InvalidArgumentError('message must not be empty')
  if (message.length > APPROVAL_LIMITS.message) {
    throw new InvalidArgumentError(`message must be at most ${APPROVAL_LIMITS.message} characters`, {
      length: message.length,
      limit: APPROVAL_LIMITS.message,
    })
  }
  return message
}

function optionalText(name: 'title' | 'detail' | 'approveLabel' | 'rejectLabel', value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new InvalidArgumentError(`${name} must be a string`)
  const text = value.trim()
  if (text.length === 0) return undefined
  const limit = name === 'detail'
    ? APPROVAL_LIMITS.detail
    : name === 'title' ? APPROVAL_LIMITS.title : APPROVAL_LIMITS.label
  if (text.length > limit) {
    throw new InvalidArgumentError(`${name} must be at most ${limit} characters`, {
      length: text.length,
      limit,
    })
  }
  return text
}

function optionalTimeout(value: unknown): number {
  if (value === undefined || value === null) return APPROVAL_LIMITS.defaultTimeout
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidArgumentError('timeout must be an integer number of milliseconds')
  }
  if (value < APPROVAL_LIMITS.minTimeout || value > APPROVAL_LIMITS.maxTimeout) {
    throw new InvalidArgumentError(
      `timeout must be between ${APPROVAL_LIMITS.minTimeout} and ${APPROVAL_LIMITS.maxTimeout} ms`,
      { timeout: value },
    )
  }
  return value
}

/**
 * Validate one model request into the shape the client renders.
 *
 * Unknown keys are refused except `session`, which the tool and the route strip
 * before calling here; a typo must surface as an error, not disappear.
 */
export function parseApprovalRequest(input: unknown): ApprovalRequest {
  const record = asRecord(input)
  if (record === undefined) throw new InvalidArgumentError('approval arguments must be a JSON object')
  for (const key of Object.keys(record)) {
    if (key === 'session') continue
    if (!REQUEST_KEYS.has(key)) {
      throw new InvalidArgumentError(`unknown approval parameter "${key}"`, { parameter: key })
    }
  }
  const message = requiredMessage(record.message)
  const title = optionalText('title', record.title)
  const detail = optionalText('detail', record.detail)
  const approveLabel = optionalText('approveLabel', record.approveLabel)
  const rejectLabel = optionalText('rejectLabel', record.rejectLabel)
  return {
    message,
    ...(title === undefined ? {} : { title }),
    ...(detail === undefined ? {} : { detail }),
    ...(approveLabel === undefined ? {} : { approveLabel }),
    ...(rejectLabel === undefined ? {} : { rejectLabel }),
    timeout: optionalTimeout(record.timeout),
  }
}

/** Resolve one session key; an empty id can never be addressed by a client. */
function sessionKey(session: unknown): string {
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new InvalidArgumentError('session must be a non-empty DSH session id')
  }
  return session.trim()
}

/** Keep a Node timer from holding the process open (the window is per-call). */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as unknown as { unref?: () => void }
  if (typeof candidate.unref === 'function') candidate.unref()
}

/** Bounded, expiring approval windows per session. */
export class ApprovalCenter {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly clock: Clock
  private readonly pendingPerSession: number
  private sequence = 0

  constructor(options: ApprovalCenterOptions = {}) {
    this.clock = options.clock ?? SystemClock
    this.pendingPerSession = options.pendingPerSession ?? APPROVAL_LIMITS.pendingPerSession
    if (!Number.isInteger(this.pendingPerSession) || this.pendingPerSession <= 0) {
      throw new InvalidArgumentError('pendingPerSession must be a positive integer')
    }
  }

  /**
   * Register one waiting window and return the promise the tool awaits.
   *
   * The timer starts immediately; the caller is responsible for awaiting (the
   * tool does) or cancelling (plugin unload does).
   */
  open(session: unknown, input: unknown): ApprovalOpenResult {
    const key = sessionKey(session)
    if (this.size(key) >= this.pendingPerSession) {
      throw new InvalidStateError(
        `${this.pendingPerSession} approval request(s) for this session are already waiting for the user`,
        { pending: this.pendingPerSession },
      )
    }
    const request = parseApprovalRequest(input)
    const created = this.clock.now()
    const expires = created + request.timeout
    this.sequence += 1
    const id = `coordination-approval-${this.sequence.toString(36)}-${randomBytes(3).toString('hex')}`
    const view: ApprovalView = { ...request, id, session: key, created, expires }
    let resolve!: (outcome: ApprovalOutcome) => void
    const promise = new Promise<ApprovalOutcome>((settle) => { resolve = settle })
    const entry: PendingApproval = { view, resolve, settled: false }
    entry.timer = setTimeout(() => { this.settle(id, 'expired') }, request.timeout)
    unrefTimer(entry.timer)
    this.pending.set(id, entry)
    return { id, expires, promise }
  }

  /** Every waiting window for one session, oldest first. */
  list(session: unknown): ApprovalView[] {
    const key = sessionKey(session)
    return [...this.pending.values()]
      .filter((entry) => !entry.settled && entry.view.session === key)
      .sort((left, right) => left.view.created - right.view.created || left.view.id.localeCompare(right.view.id))
      .map((entry) => ({ ...entry.view }))
  }

  /**
   * Deliver one human decision. Returns `false` for an unknown id, an expired
   * window or a session mismatch — never settles a window the caller cannot see.
   */
  answer(session: unknown, id: string, approved: boolean): boolean {
    const key = sessionKey(session)
    const entry = this.pending.get(id)
    if (entry === undefined || entry.settled || entry.view.session !== key) return false
    this.settle(id, approved ? 'approved' : 'rejected')
    return true
  }

  /** Withdraw one window (the client's 取消 button). */
  cancel(session: unknown, id: string): boolean {
    const key = sessionKey(session)
    const entry = this.pending.get(id)
    if (entry === undefined || entry.settled || entry.view.session !== key) return false
    this.settle(id, 'cancelled')
    return true
  }

  /** Settle every waiting window as `cancelled`; used on plugin unload. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, 'cancelled')
  }

  /** How many windows one session is waiting on. */
  size(session: unknown): number {
    const key = sessionKey(session)
    let count = 0
    for (const entry of this.pending.values()) {
      if (!entry.settled && entry.view.session === key) count += 1
    }
    return count
  }

  /** Claim one entry exactly once: clear its timer, delete it, resolve it. */
  private settle(id: string, outcome: ApprovalOutcome): void {
    const entry = this.pending.get(id)
    if (entry === undefined || entry.settled) return
    entry.settled = true
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    this.pending.delete(id)
    entry.resolve(outcome)
  }
}
