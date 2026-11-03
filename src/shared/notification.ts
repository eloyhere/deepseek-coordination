/**
 * One model-triggered UI notification.
 *
 * The model calls `coordination_notification`; the host stores one bounded item
 * per call; the client polls `/deepseek-coordination/notify/pending` and renders
 * it as one of four surfaces (`snackbar`, `alert`, `dialog`, `popover`). The
 * wire shape lives here so the host tool, the HTTP route and the client
 * component validate against the same table instead of three copies of it.
 *
 * Delivery is one-way by design: a notification is a visible message, not a
 * question. The tool returns as soon as the item is queued, so a dialog that
 * nobody closes can never block the agent loop. Interactive decisions stay with
 * `ask_user_question` / the takeover gate, which do return answers.
 *
 * Nothing here is persisted: a queue is in-memory, bounded and short-lived, so
 * a notification can never accumulate in the coordination database.
 */

/** The four surfaces the client renders. */
export const NOTIFICATION_SURFACES = ['snackbar', 'alert', 'dialog', 'popover'] as const
export type NotificationSurface = (typeof NOTIFICATION_SURFACES)[number]

/** MUI's four alert severities, reused verbatim. */
export const NOTIFICATION_SEVERITIES = ['success', 'info', 'warning', 'error'] as const
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

/** Where an anchored surface (snackbar, popover, banner) attaches. */
export const NOTIFICATION_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const
export type NotificationAnchor = (typeof NOTIFICATION_ANCHORS)[number]

/** One optional button; clicking it only closes the surface. */
export interface NotificationAction {
  readonly id: string
  readonly label: string
}

/**
 * A fully normalised request: every field the client reads is present, so the
 * renderer never has to re-apply defaults.
 */
export interface NotificationRequest {
  readonly surface: NotificationSurface
  readonly severity: NotificationSeverity
  readonly title?: string
  readonly message: string
  /** Auto-close delay in milliseconds; `0` means "wait for the user". */
  readonly duration: number
  readonly anchor: NotificationAnchor
  readonly actions: readonly NotificationAction[]
}

/** One queued notification, as `/notify/pending` returns it. */
export interface NotificationItem extends NotificationRequest {
  readonly id: string
  /** Monotonic host-wide order; also the tie-breaker across sessions. */
  readonly sequence: number
  /** The DSH session id the notification is addressed to. */
  readonly session: string
  readonly created: number
}

/** Hard limits. Every one of them rejects or caps an oversized model request. */
export const NOTIFICATION_LIMITS = {
  /** Characters in `message`. */
  message: 4000,
  /** Characters in `title`. */
  title: 200,
  /** Buttons on one surface. */
  actions: 4,
  /** Characters in one action label or id. */
  actionLabel: 60,
  /** Pending items kept per session; the oldest is dropped beyond this. */
  queue: 20,
  /** How long an undelivered item stays queued. */
  ttl: 5 * 60 * 1000,
  /** Lower bound for an explicit `duration` (below it a snackbar is a flicker). */
  minDuration: 1000,
  /** Upper bound for an explicit `duration`. */
  maxDuration: 60 * 1000,
} as const

/** Auto-close delay applied when the model omits `duration`. */
export const NOTIFICATION_DEFAULT_DURATION: Readonly<Record<NotificationSurface, number>> = {
  snackbar: 6000,
  alert: 8000,
  dialog: 0,
  popover: 8000,
}

/** Attachment point applied when the model omits `anchor`. */
export const NOTIFICATION_DEFAULT_ANCHOR: Readonly<Record<NotificationSurface, NotificationAnchor>> = {
  snackbar: 'bottom-right',
  alert: 'top-center',
  dialog: 'top-center',
  popover: 'bottom-right',
}
