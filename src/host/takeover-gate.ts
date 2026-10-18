/**
 * Service-level takeover gate (v24 §16, §2.5).
 *
 * DSH resolves approvals and user questions through two waterfalls:
 * `approval/request` and `user-questions/request`. Each listener may answer for
 * the request's agent or call `next()` to delegate to the rest of the chain
 * (whose terminal answerer fails closed: approval resolves `unavailable`, a
 * question rejects `NO_PROVIDER`). This gate is that answerer when
 * `config.ui.takeover` is on.
 *
 * The gate never synthesizes a decision. It records a durable pending window
 * through `TakeoverModule`, announces it on the coordination event bus, and
 * waits for a human answer delivered through `answer()` (the HTTP route). A
 * timeout, an aborted request signal, an explicit `cancel()`, or plugin unload
 * cancels the window and delegates with `next()` — it never turns "nobody
 * answered" into `allowed-once` or into a fabricated question answer.
 *
 * Payloads are rebuilt from the waterfall event instead of forwarding it: the
 * event carries an agent object and an AbortSignal, while the takeover row is a
 * JSON column the Client reads later. Approval payloads therefore carry
 * `{ toolName, reason, displayReason, callId }` and question payloads carry
 * `{ questions, wait }` only.
 *
 * Events emitted on `host.events`:
 *
 * - `takeover/pending` with the `PendingTakeoverView` a Client renders
 *
 * The takeover module itself emits `takeover/requested` and `takeover/resolved`
 * when the row is created and settled; those stay the authoritative lifecycle.
 */
import type { CoordinationConfig } from './config.js'
import type { CoordinationEventBus } from './module.js'
import type { TakeoverModule } from './takeover.js'
import type { TakeoverPayload, TakeoverResult } from '../shared/service.js'
import { InvalidArgumentError } from '../shared/error.js'

/** The only answers a human (or the Client on their behalf) may deliver. */
export type TakeoverGateAnswer =
  | { kind: 'approval'; outcome: 'allowed-once' | 'rejected' | 'cancelled' }
  | { kind: 'question'; answers: { id: string; selected: string[]; custom?: string }[] }

/** One pending window as the Client sees it (v24 §16). */
export interface PendingTakeoverView {
  handle: string
  type: 'approval' | 'question'
  session?: number
  payload: unknown
  created: number
}

/** One open waterfall request: its view, validation data and settlement hook. */
interface PendingEntry {
  readonly view: PendingTakeoverView
  readonly type: 'approval' | 'question'
  readonly questions: readonly TakeoverQuestion[]
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
  removeAbort?: () => void
  resolve: (answer: TakeoverGateAnswer | undefined) => void
}

/** A question reduced to the fields the dialog and validation need. */
interface TakeoverQuestion {
  id: string
  question: string
  detail?: string
  header?: string
  options?: TakeoverOption[]
  multiSelect?: boolean
  intent?: { kind: string; approve: string }
}

interface TakeoverOption {
  label: string
  description?: string
}

/**
 * Intercept, surface and settle DSH approval/question requests.
 *
 * One instance belongs to one CoordinationService; `install()` owns the two
 * Cordis listeners and the returned disposer removes them and delegates every
 * still-pending request.
 */
export class TakeoverGate {
  private readonly takeover: TakeoverModule
  private readonly sessions: { ensure(handle: string): { identity: number } }
  private readonly config: CoordinationConfig
  private readonly events: CoordinationEventBus | undefined
  private readonly clock: { now(): number }
  private readonly pending = new Map<string, PendingEntry>()

  constructor(input: {
    takeover: TakeoverModule
    sessions: { ensure(handle: string): { identity: number } }
    config: CoordinationConfig
    events?: CoordinationEventBus
    clock?: { now(): number }
  }) {
    this.takeover = input.takeover
    this.sessions = input.sessions
    this.config = input.config
    this.events = input.events
    this.clock = input.clock ?? { now: () => Date.now() }
  }

  /**
   * Register both waterfall listeners on one Cordis context. Scope filtering is
   * Cordis' job: the plugin's unscoped context observes every agent's request,
   * and a deployment that scopes this plugin to one agent observes only that
   * agent. Returns a disposer; unload delegates every open request.
   */
  install(context: unknown): () => void {
    const register = asFunction(asRecord(context)?.on)
    if (register === undefined) return () => {}

    const disposers: Array<() => void> = []
    const subscribe = (
      name: string,
      listener: (request: unknown, next: () => Promise<unknown>) => unknown,
    ): void => {
      try {
        // `prepend` matters: DSH's own GUI answers the same waterfall
        // (`dsh-client-ui-approval` / `-user-questions`). A listener registered
        // later never runs once the GUI has claimed the request, which is why
        // the takeover dialog stayed empty. Running first lets this plugin
        // either answer or delegate with `next()`.
        const dispose = register.call(context, name, listener, { prepend: true })
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
      } catch {
        // A context without a working event bus simply gets no takeover.
      }
    }

    subscribe('approval/request', (request, next) =>
      this.handleApproval(request, next as () => Promise<string>))
    subscribe('user-questions/request', (request, next) => this.handleQuestion(request, next))

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A second disposal is harmless during plugin unload.
        }
      }
      this.disposeAll()
    }
  }

  /** Every pending window, oldest first; one coordination session when given. */
  list(session?: number): PendingTakeoverView[] {
    const views: PendingTakeoverView[] = []
    for (const entry of this.pending.values()) {
      if (session !== undefined && entry.view.session !== session) continue
      views.push({ ...entry.view })
    }
    return views.sort((left, right) => left.created - right.created)
  }

  /**
   * Deliver a human answer. Returns `false` when the handle is unknown or
   * already settled, and when the answer is invalid for this window — an
   * invalid answer never closes the window, so the caller may try again.
   */
  answer(handle: string, answer: TakeoverGateAnswer): boolean {
    if (typeof handle !== 'string' || handle.length === 0) return false
    const entry = this.pending.get(handle)
    if (entry === undefined) return false

    let validated: TakeoverGateAnswer
    try {
      validated = validateAnswer(entry, answer)
    } catch {
      // InvalidArgumentError is the internal signal; the boolean API keeps the
      // window open and lets the HTTP route report 400.
      return false
    }

    if (!this.settle(entry)) return false
    const result: TakeoverResult = {
      accepted: true,
      value: validated.kind === 'approval' ? { outcome: validated.outcome } : { answers: validated.answers },
    }
    try {
      this.takeover.resolve(handle, result)
    } catch {
      // The row disappeared or was settled elsewhere; never leave the handler
      // hanging, and let the host default answer instead.
      try {
        this.takeover.cancel(handle)
      } catch {
        // Already terminal.
      }
      entry.resolve(undefined)
      return false
    }
    entry.resolve(validated)
    return true
  }

  /**
   * Cancel one pending window and delegate to the host. Returns `false` when the
   * handle is unknown or already settled, so a double click cannot fail loudly.
   */
  cancel(handle: string): boolean {
    if (typeof handle !== 'string' || handle.length === 0) return false
    const entry = this.pending.get(handle)
    if (entry === undefined) return false
    this.settle(entry)
    try {
      this.takeover.cancel(handle)
    } catch {
      // Already terminal.
    }
    entry.resolve(undefined)
    return true
  }

  /**
   * `approval/request` listener body. With interception disabled this is a
   * pass-through: no row, no event, no timer.
   */
  async handleApproval(
    request: unknown,
    next: () => Promise<string>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.config.ui?.takeover !== true) return next()
    const event = asRecord(request)
    if (event === undefined) return next()

    const abortSignal = signal ?? abortSignalOf(event.signal)
    if (abortSignal?.aborted === true) return next()

    const pending = this.open(
      'approval',
      approvalPayloadOf(event),
      this.sessionOf(event),
      abortSignal,
      [],
    )
    if (pending === undefined) return next()

    const answered = await pending
    if (answered === undefined || answered.kind !== 'approval') return next()
    return answered.outcome
  }

  /**
   * `user-questions/request` listener body. With interception disabled this is a
   * pass-through: no row, no event, no timer.
   */
  async handleQuestion(
    request: unknown,
    next: () => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.config.ui?.takeover !== true) return next()
    const event = asRecord(request)
    if (event === undefined) return next()

    const abortSignal = signal ?? abortSignalOf(event.signal)
    if (abortSignal?.aborted === true) return next()

    const questions = questionSpecsOf(event.questions)
    const wait = waitOf(event.wait)
    const payload: TakeoverPayload = {
      questions,
      ...(wait === undefined ? {} : { wait }),
    }
    const pending = this.open('question', payload, this.sessionOf(event), abortSignal, questions)
    if (pending === undefined) return next()

    const answered = await pending
    if (answered === undefined || answered.kind !== 'question') return next()
    return { answers: answered.answers }
  }

  /* ----------------------------------------------------------------------- *
   * Pending-window mechanics
   * ----------------------------------------------------------------------- */

  /**
   * Record the row, announce the view and arm the timeout and abort listener.
   * Returns `undefined` when no durable window could be recorded; every such
   * failure delegates to the host rather than answering on the user's behalf.
   */
  private open(
    type: 'approval' | 'question',
    payload: TakeoverPayload,
    session: number | undefined,
    signal: AbortSignal | undefined,
    questions: readonly TakeoverQuestion[],
  ): Promise<TakeoverGateAnswer | undefined> | undefined {
    if (signal?.aborted === true) return undefined

    let requested: TakeoverResult
    try {
      requested = this.takeover.request({
        type,
        payload,
        ...(session === undefined ? {} : { session }),
      })
    } catch {
      return undefined
    }
    if (requested.accepted !== true) return undefined
    const handle = handleOf(requested.value)
    if (handle === undefined) return undefined

    const view: PendingTakeoverView = {
      handle,
      type,
      ...(session === undefined ? {} : { session }),
      payload,
      created: this.clock.now(),
    }
    let resolveAnswer!: (answer: TakeoverGateAnswer | undefined) => void
    const promise = new Promise<TakeoverGateAnswer | undefined>((resolve) => {
      resolveAnswer = resolve
    })
    const entry: PendingEntry = {
      view,
      type,
      questions,
      settled: false,
      resolve: resolveAnswer,
    }
    this.pending.set(handle, entry)

    if (signal !== undefined) {
      const onAbort = (): void => {
        this.delegate(entry)
      }
      try {
        signal.addEventListener('abort', onAbort, { once: true })
        entry.removeAbort = () => {
          signal.removeEventListener('abort', onAbort)
        }
      } catch {
        // A foreign AbortSignal-like object may not support listeners; the
        // timeout still bounds the wait.
      }
    }

    entry.timer = setTimeout(() => {
      this.delegate(entry)
    }, this.timeoutMilliseconds())
    unrefTimer(entry.timer)

    // Announce last: a listener may answer synchronously, and settlement then
    // clears the timer and abort listener installed above.
    this.events?.emit('takeover/pending', { ...view })
    return promise
  }

  /** Cancel the row, detach every listener and let the handler call `next()`. */
  private delegate(entry: PendingEntry): void {
    if (!this.settle(entry)) return
    try {
      this.takeover.cancel(entry.view.handle)
    } catch {
      // The row is already terminal; delegation is still the correct outcome.
    }
    entry.resolve(undefined)
  }

  /**
   * Claim one entry exactly once: remove it from the map, clear the timer and
   * detach the abort listener. A second claim returns `false`.
   */
  private settle(entry: PendingEntry): boolean {
    if (entry.settled) return false
    entry.settled = true
    if (this.pending.get(entry.view.handle) === entry) this.pending.delete(entry.view.handle)
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (entry.removeAbort !== undefined) {
      try {
        entry.removeAbort()
      } catch {
        // Detaching a listener twice is harmless.
      }
      entry.removeAbort = undefined
    }
    return true
  }

  /** Delegate every open request; used when the plugin unloads. */
  private disposeAll(): void {
    for (const entry of [...this.pending.values()]) this.delegate(entry)
  }

  /** `clarifyTimeout` bounds a real event; a non-finite value falls back to 30s. */
  private timeoutMilliseconds(): number {
    const configured = this.config.clarifyTimeout
    if (!Number.isFinite(configured)) return 30000
    return Math.min(Math.max(0, Math.floor(configured)), 2_147_483_647)
  }

  /**
   * Resolve the coordination session identity behind an event agent id. DSH
   * keeps `agent.id === session.id`; the coordination row is created on demand.
   * A missing or unusable id leaves the window without a session rather than
   * dropping an otherwise answerable request.
   */
  private sessionOf(event: Record<string, unknown>): number | undefined {
    const agent = asRecord(event.agent)
    const handle = agent === undefined ? '' : typeof agent.id === 'string' ? agent.id : ''
    if (handle.length === 0) return undefined
    try {
      return this.sessions.ensure(handle).identity
    } catch {
      return undefined
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Event-shape helpers
 * ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asFunction(value: unknown): ((...parameters: unknown[]) => unknown) | undefined {
  return typeof value === 'function' ? (value as (...parameters: unknown[]) => unknown) : undefined
}

/** Forward the event signal only when it behaves like one. */
function abortSignalOf(value: unknown): AbortSignal | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (typeof record.aborted !== 'boolean' || typeof record.addEventListener !== 'function') return undefined
  return value as AbortSignal
}

function handleOf(value: unknown): string | undefined {
  const record = asRecord(value)
  return typeof record?.handle === 'string' && record.handle.length > 0 ? record.handle : undefined
}

/** Build the JSON-safe approval payload the Client renders. */
function approvalPayloadOf(event: Record<string, unknown>): TakeoverPayload {
  const displayReason = displayReasonOf(event.displayReason)
  return {
    toolName: typeof event.toolName === 'string' ? event.toolName : '',
    ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
    ...(displayReason === undefined ? {} : { displayReason }),
    ...(typeof event.callId === 'string' ? { callId: event.callId } : {}),
  }
}

function displayReasonOf(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const localized: Record<string, string> = {}
  for (const [locale, copy] of Object.entries(record)) {
    if (typeof copy === 'string') localized[locale] = copy
  }
  return Object.keys(localized).length === 0 ? undefined : localized
}

/** Build the JSON-safe question list the Client renders and the gate validates. */
function questionSpecsOf(value: unknown): TakeoverQuestion[] {
  if (!Array.isArray(value)) return []
  const questions: TakeoverQuestion[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    const record = asRecord(candidate)
    if (record === undefined) continue
    const id = typeof record.id === 'string' ? record.id : ''
    const question = typeof record.question === 'string' ? record.question : ''
    if (id.length === 0 || question.length === 0 || seen.has(id)) continue
    seen.add(id)
    const options = optionsOf(record.options)
    const intent = intentOf(record.intent)
    questions.push({
      id,
      question,
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
      ...(typeof record.header === 'string' ? { header: record.header } : {}),
      ...(options.length === 0 ? {} : { options }),
      ...(typeof record.multiSelect === 'boolean' ? { multiSelect: record.multiSelect } : {}),
      ...(intent === undefined ? {} : { intent }),
    })
  }
  return questions
}

function optionsOf(value: unknown): TakeoverOption[] {
  if (!Array.isArray(value)) return []
  const options: TakeoverOption[] = []
  for (const candidate of value) {
    const record = asRecord(candidate)
    if (record === undefined) continue
    const label = typeof record.label === 'string' ? record.label : ''
    if (label.length === 0) continue
    options.push({
      label,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
    })
  }
  return options
}

function intentOf(value: unknown): { kind: string; approve: string } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (typeof record.kind !== 'string' || typeof record.approve !== 'string') return undefined
  return { kind: record.kind, approve: record.approve }
}

function waitOf(value: unknown): { callId: string; timed?: boolean } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (typeof record.callId !== 'string' || record.callId.length === 0) return undefined
  return {
    callId: record.callId,
    ...(typeof record.timed === 'boolean' ? { timed: record.timed } : {}),
  }
}

/* ------------------------------------------------------------------------- *
 * Answer validation
 * ------------------------------------------------------------------------- */

function validateAnswer(entry: PendingEntry, answer: unknown): TakeoverGateAnswer {
  const record = asRecord(answer)
  if (record === undefined) throw new InvalidArgumentError('takeover answer must be an object')
  if (record.kind !== entry.type) {
    throw new InvalidArgumentError(`takeover answer kind must be "${entry.type}"`, { kind: record.kind })
  }
  if (entry.type === 'approval') {
    return { kind: 'approval', outcome: approvalOutcomeOf(record.outcome) }
  }
  return { kind: 'question', answers: questionAnswersOf(entry.questions, record.answers) }
}

/** Only a human decision is an approval answer; `unavailable` is not one. */
function approvalOutcomeOf(value: unknown): 'allowed-once' | 'rejected' | 'cancelled' {
  if (value === 'unavailable') {
    throw new InvalidArgumentError('"unavailable" is the host fail-closed outcome, not a user decision')
  }
  if (value === 'allowed-once' || value === 'rejected' || value === 'cancelled') return value
  throw new InvalidArgumentError('approval outcome must be "allowed-once", "rejected" or "cancelled"', {
    outcome: value,
  })
}

function questionAnswersOf(
  questions: readonly TakeoverQuestion[],
  value: unknown,
): { id: string; selected: string[]; custom?: string }[] {
  if (!Array.isArray(value)) {
    throw new InvalidArgumentError('question answer must carry an "answers" array')
  }
  const byId = new Map<string, TakeoverQuestion>()
  for (const question of questions) byId.set(question.id, question)

  const seen = new Set<string>()
  const answers: { id: string; selected: string[]; custom?: string }[] = []
  for (const candidate of value) {
    const record = asRecord(candidate)
    if (record === undefined) throw new InvalidArgumentError('question answer entry must be an object')
    const id = record.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidArgumentError('question answer entry must carry a non-empty id')
    }
    const question = byId.get(id)
    if (question === undefined) {
      throw new InvalidArgumentError(`question "${id}" is not part of this takeover`)
    }
    if (seen.has(id)) throw new InvalidArgumentError(`question "${id}" is answered more than once`)
    seen.add(id)

    const selected = selectedLabelsOf(question, record.selected)
    const custom = customOf(record.custom)
    if (custom !== undefined && selected.length > 0 && (question.options?.length ?? 0) > 0) {
      throw new InvalidArgumentError(
        `question "${id}" accepts custom text only when no offered option is selected`,
      )
    }
    answers.push({ id, selected, ...(custom === undefined ? {} : { custom }) })
  }

  const missing = questions.filter((question) => !seen.has(question.id)).map((question) => question.id)
  if (missing.length > 0) {
    throw new InvalidArgumentError('every question must be answered exactly once', { missing })
  }
  return answers
}

function selectedLabelsOf(question: TakeoverQuestion, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new InvalidArgumentError(`question "${question.id}" must carry a "selected" array`)
  }
  const offered = new Set((question.options ?? []).map((option) => option.label))
  const selected: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new InvalidArgumentError(`question "${question.id}" selected entries must be option labels`)
    }
    if (!offered.has(candidate)) {
      throw new InvalidArgumentError(
        `option "${candidate}" is not offered by question "${question.id}"`,
        { question: question.id, option: candidate },
      )
    }
    if (!selected.includes(candidate)) selected.push(candidate)
  }
  return selected
}

function customOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('question custom text must be a string')
  }
  return value.length === 0 ? undefined : value
}

/* ------------------------------------------------------------------------- *
 * Timer helpers
 * ------------------------------------------------------------------------- */

/** Do not let a pending window's timeout hold a short-lived process open. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as unknown as { unref?: () => void }
  if (typeof candidate.unref === 'function') candidate.unref()
}
