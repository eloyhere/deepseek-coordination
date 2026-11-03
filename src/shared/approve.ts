/**
 * One agent-initiated approval dialog (`coordination_approve`).
 *
 * This is the synchronous counterpart of a notification: the agent asks the
 * human a yes/no question, the client renders a modal dialog, and the answer
 * travels back to the waiting tool call. The rules that keep it honest:
 *
 *  - the tool never invents a decision — an unanswered, cancelled or aborted
 *    window resolves as `cancelled` / `expired`, never `approved`;
 *  - the window is bound to the calling session, so one session's GUI can never
 *    answer another session's request;
 *  - the window is in-memory and bounded (at most
 *    {@link APPROVAL_LIMITS.pendingPerSession} waiting requests per session) and
 *    auto-expires, so a model cannot park the agent loop indefinitely;
 *  - nothing is persisted: a consent question belongs to the live conversation,
 *    not to the coordination database.
 */

/** Every way an approval window can settle. */
export const APPROVAL_OUTCOMES = ['approved', 'rejected', 'cancelled', 'expired'] as const
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number]

/** A validated approval request: every field the client renders is present. */
export interface ApprovalRequest {
  /** The question itself (the dialog body). */
  readonly message: string
  readonly title?: string
  /** Optional second paragraph: consequences, scope, a diff summary. */
  readonly detail?: string
  /** Verdict button labels; the client falls back to its localized defaults. */
  readonly approveLabel?: string
  readonly rejectLabel?: string
  /** Auto-cancel delay in milliseconds. */
  readonly timeout: number
}

/** One pending approval, as `/approve/pending` returns it. */
export interface ApprovalView extends ApprovalRequest {
  readonly id: string
  /** The DSH session the request is addressed to. */
  readonly session: string
  readonly created: number
  /** Absolute epoch ms after which the host cancels the window. */
  readonly expires: number
}

/** Hard limits; oversized or out-of-range input is rejected, never clamped. */
export const APPROVAL_LIMITS = {
  /** Characters in `message`. */
  message: 2000,
  /** Characters in `title`. */
  title: 200,
  /** Characters in `detail`. */
  detail: 4000,
  /** Characters in one button label. */
  label: 40,
  /** Waiting requests kept per session. */
  pendingPerSession: 4,
  /** Lower bound for an explicit `timeout`. */
  minTimeout: 5000,
  /** Applied when the model omits `timeout`. */
  defaultTimeout: 120000,
  /** Upper bound for `timeout` (ten minutes). */
  maxTimeout: 600000,
} as const
