/**
 * The notification centre behind `coordination_notification`.
 *
 * One bounded, in-memory queue per DSH session:
 *
 *  - `push` validates and normalises a model request into a `NotificationItem`;
 *  - `drain` hands every pending item to one client poll and clears the queue,
 *    so a notification is delivered at most once;
 *  - items expire after {@link NOTIFICATION_LIMITS.ttl}, and a queue keeps only
 *    its newest {@link NOTIFICATION_LIMITS.queue} items.
 *
 * Nothing is persisted: a notification is a visible message, not coordination
 * state, and a restart is allowed to forget one. The whole class is synchronous
 * and clock-injectable, so the tests drive expiry and ordering without timers.
 *
 * Validation is strict rather than silently clamped. An oversized message, an
 * unknown surface or a fifth action is an `INVALID_ARGUMENT` the model can read
 * and correct; nothing is truncated behind its back.
 */
import { randomBytes } from 'node:crypto'
import { InvalidArgumentError } from '../shared/error.js'
import {
  NOTIFICATION_ANCHORS,
  NOTIFICATION_DEFAULT_ANCHOR,
  NOTIFICATION_DEFAULT_DURATION,
  NOTIFICATION_LIMITS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SURFACES,
  type NotificationAction,
  type NotificationAnchor,
  type NotificationItem,
  type NotificationRequest,
  type NotificationSeverity,
  type NotificationSurface,
} from '../shared/notification.js'
import { SystemClock, type Clock } from './handle.js'

/** The fields a caller may supply; `session` is consumed by the tool/route. */
const REQUEST_KEYS = new Set([
  'surface',
  'severity',
  'title',
  'message',
  'duration',
  'anchor',
  'actions',
])

/** Result of one enqueue: the item plus the queue state the model may report. */
export interface NotificationPushResult {
  readonly item: NotificationItem
  readonly queued: number
  /** How many older items the bounded queue dropped to admit this one. */
  readonly dropped: number
}

export interface NotificationCenterOptions {
  /** Injected clock, so tests can advance past the TTL deterministically. */
  clock?: Clock
  /** Per-session queue bound; defaults to {@link NOTIFICATION_LIMITS.queue}. */
  queueLimit?: number
  /** Undelivered TTL in ms; defaults to {@link NOTIFICATION_LIMITS.ttl}. */
  ttl?: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function oneOf<T extends string>(
  name: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`${name} must be one of ${allowed.join(', ')}`, {
      [name]: value,
    })
  }
  return value as T
}

function requiredSurface(value: unknown): NotificationSurface {
  const surface = oneOf('surface', value, NOTIFICATION_SURFACES)
  if (surface === undefined) {
    throw new InvalidArgumentError(`surface is required (one of ${NOTIFICATION_SURFACES.join(', ')})`)
  }
  return surface
}

function requiredMessage(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('message must be a string')
  }
  const message = value.trim()
  if (message.length === 0) throw new InvalidArgumentError('message must not be empty')
  if (message.length > NOTIFICATION_LIMITS.message) {
    throw new InvalidArgumentError(
      `message must be at most ${NOTIFICATION_LIMITS.message} characters`,
      { length: message.length, limit: NOTIFICATION_LIMITS.message },
    )
  }
  return message
}

function optionalTitle(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new InvalidArgumentError('title must be a string')
  const title = value.trim()
  if (title.length === 0) return undefined
  if (title.length > NOTIFICATION_LIMITS.title) {
    throw new InvalidArgumentError(`title must be at most ${NOTIFICATION_LIMITS.title} characters`, {
      length: title.length,
      limit: NOTIFICATION_LIMITS.title,
    })
  }
  return title
}

function optionalDuration(value: unknown, surface: NotificationSurface): number {
  if (value === undefined || value === null) return NOTIFICATION_DEFAULT_DURATION[surface]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidArgumentError('duration must be an integer number of milliseconds')
  }
  // `0` is the explicit "wait for the user" choice; anything else is bounded.
  if (value < 0) throw new InvalidArgumentError('duration must not be negative')
  if (value > 0 && value < NOTIFICATION_LIMITS.minDuration) {
    throw new InvalidArgumentError(
      `duration must be 0 or between ${NOTIFICATION_LIMITS.minDuration} and ${NOTIFICATION_LIMITS.maxDuration} ms`,
      { duration: value },
    )
  }
  if (value > NOTIFICATION_LIMITS.maxDuration) {
    throw new InvalidArgumentError(`duration must be at most ${NOTIFICATION_LIMITS.maxDuration} ms`, {
      duration: value,
    })
  }
  return value
}

function optionalAnchor(value: unknown, surface: NotificationSurface): NotificationAnchor {
  const anchor = oneOf('anchor', value, NOTIFICATION_ANCHORS)
  return anchor ?? NOTIFICATION_DEFAULT_ANCHOR[surface]
}

function optionalActions(value: unknown): NotificationAction[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new InvalidArgumentError('actions must be an array')
  if (value.length > NOTIFICATION_LIMITS.actions) {
    throw new InvalidArgumentError(`actions must hold at most ${NOTIFICATION_LIMITS.actions} items`, {
      length: value.length,
      limit: NOTIFICATION_LIMITS.actions,
    })
  }
  const actions: NotificationAction[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const record = asRecord(raw)
    if (record === undefined) throw new InvalidArgumentError('each action must be an object with id and label')
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (id.length === 0 || label.length === 0) {
      throw new InvalidArgumentError('each action needs a non-empty id and label')
    }
    if (id.length > NOTIFICATION_LIMITS.actionLabel || label.length > NOTIFICATION_LIMITS.actionLabel) {
      throw new InvalidArgumentError(
        `action id and label must be at most ${NOTIFICATION_LIMITS.actionLabel} characters`,
      )
    }
    if (seen.has(id)) throw new InvalidArgumentError(`action id "${id}" is duplicated`)
    seen.add(id)
    actions.push({ id, label })
  }
  return actions
}

/**
 * Validate one model request into the shape the client renders.
 *
 * Unknown keys are refused except `session`, which the tool and the route strip
 * before calling here; a typo must surface as an error, not disappear.
 */
export function parseNotificationRequest(input: unknown): NotificationRequest {
  const record = asRecord(input)
  if (record === undefined) throw new InvalidArgumentError('notification arguments must be a JSON object')
  for (const key of Object.keys(record)) {
    if (key === 'session') continue
    if (!REQUEST_KEYS.has(key)) {
      throw new InvalidArgumentError(`unknown notification parameter "${key}"`, { parameter: key })
    }
  }
  const surface = requiredSurface(record.surface)
  const message = requiredMessage(record.message)
  const severity: NotificationSeverity = oneOf('severity', record.severity, NOTIFICATION_SEVERITIES) ?? 'info'
  const title = optionalTitle(record.title)
  return {
    surface,
    severity,
    ...(title === undefined ? {} : { title }),
    message,
    // A dialog is a decision surface: it never auto-closes, even if the model
    // supplies a duration. Only transient surfaces honour the delay.
    duration: surface === 'dialog' ? 0 : optionalDuration(record.duration, surface),
    anchor: optionalAnchor(record.anchor, surface),
    actions: optionalActions(record.actions),
  }
}

/** Resolve one session key; an empty id can never be addressed by a client. */
function sessionKey(session: unknown): string {
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new InvalidArgumentError('session must be a non-empty DSH session id')
  }
  return session.trim()
}

/** Bounded, expiring per-session notification queues. */
export class NotificationCenter {
  private readonly queues = new Map<string, NotificationItem[]>()
  private readonly clock: Clock
  private readonly queueLimit: number
  private readonly ttl: number
  private sequence = 0
  private counter = 0

  constructor(options: NotificationCenterOptions = {}) {
    this.clock = options.clock ?? SystemClock
    this.queueLimit = options.queueLimit ?? NOTIFICATION_LIMITS.queue
    this.ttl = options.ttl ?? NOTIFICATION_LIMITS.ttl
    if (!Number.isInteger(this.queueLimit) || this.queueLimit <= 0) {
      throw new InvalidArgumentError('queueLimit must be a positive integer')
    }
    if (!Number.isInteger(this.ttl) || this.ttl <= 0) {
      throw new InvalidArgumentError('ttl must be a positive integer')
    }
  }

  /** Validate, enqueue and report the queue state. Throws on invalid input. */
  push(session: unknown, input: unknown): NotificationPushResult {
    const key = sessionKey(session)
    const request = parseNotificationRequest(input)
    const now = this.clock.now()
    const queue = this.prune(key, now)
    this.counter = (this.counter + 1) % 0xffffff
    this.sequence += 1
    const item: NotificationItem = {
      ...request,
      id: `coordination-notification-${this.sequence.toString(36)}-${this.counter.toString(36)}-${randomBytes(3).toString('hex')}`,
      sequence: this.sequence,
      session: key,
      created: now,
    }
    queue.push(item)
    let dropped = 0
    while (queue.length > this.queueLimit) {
      queue.shift()
      dropped += 1
    }
    this.queues.set(key, queue)
    return { item, queued: queue.length, dropped }
  }

  /**
   * Hand every pending item to one client poll and clear the session's queue.
   * Delivery is at most once: a client that polls again gets only newer items.
   */
  drain(session: unknown): NotificationItem[] {
    const key = sessionKey(session)
    const queue = this.prune(key, this.clock.now())
    this.queues.delete(key)
    return queue
  }

  /** How many items are waiting for one session (expired items do not count). */
  size(session: unknown): number {
    return this.prune(sessionKey(session), this.clock.now()).length
  }

  /** Drop every queue, or one session's queue. */
  clear(session?: unknown): void {
    if (session === undefined) {
      this.queues.clear()
      return
    }
    this.queues.delete(sessionKey(session))
  }

  /** Read, prune and store one session's queue; an empty queue is deleted. */
  private prune(key: string, now: number): NotificationItem[] {
    const queue = this.queues.get(key)
    if (queue === undefined) return []
    if (queue.length === 0) {
      this.queues.delete(key)
      return []
    }
    // Dialogs wait for the operator: TTL never expires one. Transient surfaces
    // keep the bounded TTL so an undelivered toast cannot accumulate forever.
    const alive = queue.filter((item) => item.surface === 'dialog' || now - item.created <= this.ttl)
    if (alive.length === 0) {
      this.queues.delete(key)
    } else if (alive.length !== queue.length) {
      // Write the survivors back: an expired item must not stay reachable.
      this.queues.set(key, alive)
    }
    return alive
  }
}
