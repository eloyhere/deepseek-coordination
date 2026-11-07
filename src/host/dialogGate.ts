/** Own the public answerer waterfalls before Harness opens its native dialogs. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AmpHost } from './amp.js'
import { asRecord } from './json.js'

export type DialogApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export interface DialogQuestion {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
  intent?: Record<string, unknown>
}
export interface DialogAnswers {
  answers: { id: string; selected: string[]; custom?: string }[]
}
export interface PendingDialogView {
  id: string
  kind: 'approval' | 'questions'
  toolName?: string
  reason?: string
  displayReason?: Record<string, string>
  questions?: DialogQuestion[]
}

interface DialogRequest {
  agent?: { id: string }
  signal?: AbortSignal
  toolName?: string
  reason?: string
  displayReason?: Record<string, string>
  questions?: DialogQuestion[]
  wait?: { callId: string; timed?: boolean }
}
interface QuestionWaitService {
  attachWait(agent: { id: string }, callId: string, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>
}
interface PendingDialog {
  session: string
  view: PendingDialogView
  resolve: (answer: DialogApprovalOutcome | DialogAnswers) => void
  reject: (reason: unknown) => void
  removeAbort?: () => void
}
/** Structural seam: no runtime imports of optional Harness question services. */
interface DialogContext {
  on(name: 'approval/request', handler: (request: DialogRequest, next: () => Promise<DialogApprovalOutcome>) => Promise<DialogApprovalOutcome>, options: { prepend: true }): () => void
  on(name: 'user-questions/request', handler: (request: DialogRequest, next: () => Promise<DialogAnswers>) => Promise<DialogAnswers>, options: { prepend: true }): () => void
  effect(factory: () => () => void, label: string): unknown
  get(name: 'userQuestions'): QuestionWaitService | undefined
}

export class DialogGate {
  private readonly pending = new Map<string, PendingDialog>()
  private disposed = false

  constructor(private readonly host: Pick<AmpHost, 'preferencesForSession'>) {}

  /** Cordis effects own both listeners and all in-flight requests. */
  attach(context: Context): void {
    const ctx = context as unknown as DialogContext
    ctx.effect(() => {
      const disposers: (() => void)[] = []
      try {
        disposers.push(ctx.on('approval/request', async (request, next) => {
          const session = request.agent?.id
          if (!session || !this.enabled(session)) return next()
          if (this.disposed || request.signal?.aborted) return 'cancelled'
          const view: PendingDialogView = {
            id: randomUUID(), kind: 'approval',
            ...(typeof request.toolName === 'string' ? { toolName: request.toolName } : {}),
            ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
            ...(request.displayReason === undefined ? {} : { displayReason: { ...request.displayReason } }),
          }
          return await this.open(session, view, request.signal) as DialogApprovalOutcome
        }, { prepend: true }))
        disposers.push(ctx.on('user-questions/request', async (request, next) => {
          const session = request.agent?.id
          if (!session || !this.enabled(session)) return next()
          if (request.signal?.aborted && asRecord(request.signal.reason)?.code === 'ASK_TIMED_OUT') throw request.signal.reason
          if (this.disposed || request.signal?.aborted) return { answers: [] }
          const view: PendingDialogView = {
            id: randomUUID(), kind: 'questions', questions: structuredClone(request.questions ?? []),
          }
          const releaseWait = this.claimWait(ctx, request)
          try {
            return await this.open(session, view, request.signal) as DialogAnswers
          } finally {
            releaseWait?.()
          }
        }, { prepend: true }))
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        this.dispose()
        throw error
      }
      return () => {
        try {
          for (const dispose of disposers.reverse()) dispose()
        } finally {
          this.dispose()
        }
      }
    }, 'deepseek-coordination: dialog takeover')
  }

  /** Polling also retires dialogs whose workspace takeover was switched off. */
  list(session: string): PendingDialogView[] {
    this.checkPreferences()
    return [...this.pending.values()]
      .filter((entry) => entry.session === session)
      .map((entry) => structuredClone(entry.view))
  }

  /** Invalid answers throw without closing the window; unknown ids return false. */
  answer(session: string, id: string, value: unknown): boolean {
    this.checkPreferences()
    const entry = this.pending.get(id)
    if (entry === undefined || entry.session !== session) return false
    const body = asRecord(value)
    if (body === undefined) throw new Error('answer must be a JSON object')
    let answer: DialogApprovalOutcome | DialogAnswers
    if (entry.view.kind === 'approval') {
      if (body.answers !== undefined) throw new Error('approval answers cannot contain questions')
      if (body.outcome !== 'allowed-once' && body.outcome !== 'rejected' && body.outcome !== 'cancelled') {
        throw new Error('outcome must be allowed-once, rejected or cancelled')
      }
      answer = body.outcome
    } else {
      if (body.outcome !== undefined) throw new Error('question answers cannot contain an approval outcome')
      answer = { answers: validateAnswers(entry.view.questions ?? [], body.answers) }
    }
    this.settle(entry, answer)
    return true
  }

  cancel(session: string, id: string): boolean {
    this.checkPreferences()
    const entry = this.pending.get(id)
    if (entry === undefined || entry.session !== session) return false
    this.settle(entry, this.cancelled(entry))
    return true
  }

  /** Close every request fail-closed on unload; never invoke the native answerer. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.pending.values()) this.settle(entry, this.cancelled(entry))
  }

  private enabled(session: string): boolean {
    return this.host.preferencesForSession(session).get().takeoverNotifications === true
  }

  checkPreferences(): void {
    for (const entry of this.pending.values()) {
      if (!this.enabled(entry.session)) this.settle(entry, this.cancelled(entry))
    }
  }

  private cancelled(entry: PendingDialog): DialogApprovalOutcome | DialogAnswers {
    return entry.view.kind === 'approval' ? 'cancelled' : { answers: [] }
  }

  /** A Host claim pauses the SDK's unattended timer for our indefinite dialog. */
  private claimWait(ctx: DialogContext, request: DialogRequest): (() => void) | undefined {
    if (request.wait?.timed !== true || request.agent === undefined) return undefined
    const service = ctx.get('userQuestions')
    if (service === undefined || typeof service.attachWait !== 'function') return undefined
    const controller = new AbortController()
    const stream = service.attachWait(request.agent, request.wait.callId, controller.signal)
    // Consume the stream so its claim stays held, and contain cancellation errors.
    void (async () => {
      try {
        for await (const _frame of stream) { /* No local countdown: wait for the human. */ }
      } catch {
        // An aborted owning request closes through the request's signal listener.
      }
    })()
    return () => controller.abort()
  }

  private open(session: string, view: PendingDialogView, signal?: AbortSignal): Promise<DialogApprovalOutcome | DialogAnswers> {
    return new Promise((resolve, reject) => {
      const entry: PendingDialog = { session, view, resolve, reject }
      this.pending.set(view.id, entry)
      if (signal !== undefined) {
        const abort = (): void => {
          if (view.kind === 'questions' && asRecord(signal.reason)?.code === 'ASK_TIMED_OUT') {
            // Preserve askTimed's business outcome if its deadline won the claim race.
            if (!this.remove(entry)) return
            entry.reject(signal.reason)
          } else {
            this.settle(entry, this.cancelled(entry))
          }
        }
        entry.removeAbort = () => signal.removeEventListener('abort', abort)
        signal.addEventListener('abort', abort, { once: true })
        // The request may have been aborted between the first check and subscribe.
        if (signal.aborted) abort()
      }
    })
  }

  private settle(entry: PendingDialog, answer: DialogApprovalOutcome | DialogAnswers): void {
    if (this.remove(entry)) entry.resolve(answer)
  }

  private remove(entry: PendingDialog): boolean {
    if (this.pending.get(entry.view.id) !== entry) return false
    this.pending.delete(entry.view.id)
    entry.removeAbort?.()
    return true
  }
}

function validateAnswers(questions: readonly DialogQuestion[], value: unknown): DialogAnswers['answers'] {
  if (!Array.isArray(value)) throw new Error('answers must be an array')
  const byId = new Map(questions.map((question) => [question.id, question]))
  const seen = new Set<string>()
  const answers: DialogAnswers['answers'] = []
  for (const candidate of value) {
    const item = asRecord(candidate)
    if (item === undefined || typeof item.id !== 'string' || !byId.has(item.id) || seen.has(item.id)) {
      throw new Error('each answer must name a unique question in this dialog')
    }
    if (Object.keys(item).some((key) => key !== 'id' && key !== 'selected' && key !== 'custom')) {
      throw new Error('answer items accept only id, selected and custom')
    }
    seen.add(item.id)
    const question = byId.get(item.id)!
    if (!Array.isArray(item.selected)) throw new Error('selected must be an array of option labels')
    const offered = new Set((question.options ?? []).map((option) => option.label))
    const selected: string[] = []
    for (const label of item.selected) {
      if (typeof label !== 'string' || !offered.has(label) || selected.includes(label)) {
        throw new Error('selected must contain unique offered option labels')
      }
      selected.push(label)
    }
    if (question.multiSelect !== true && selected.length > 1) throw new Error('single-select questions accept at most one option')
    if (item.custom !== undefined && typeof item.custom !== 'string') throw new Error('custom must be a string')
    const custom = typeof item.custom === 'string' && item.custom.length > 0 ? item.custom : undefined
    if (custom !== undefined && selected.length > 0 && question.multiSelect !== true) {
      throw new Error('single-select questions cannot combine an option with custom text')
    }
    if (custom !== undefined && question.intent?.kind === 'approval') throw new Error('approval questions do not accept custom text')
    answers.push({ id: item.id, selected, ...(custom === undefined ? {} : { custom }) })
  }
  if (seen.size !== questions.length) throw new Error('every question must be answered exactly once; an empty selection skips it')
  return answers
}
