/**
 * DSH → AMP projection.
 *
 * The harness owns sessions, turns, goals, plans (todo list) and tool calls.
 * AMP owns the same lifecycle vocabulary. This module mirrors the harness facts
 * into the AMP kernel so the AMP panel, kernel snapshot and protocol tools see
 * real work instead of an empty database.
 *
 * Every projection is best-effort: a sync failure is recorded and never thrown
 * into a DSH session/event listener, because the agent turn must not fail
 * because an audit projection could not be written.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Kernel } from 'attention-manifest-protocol/kernel'
import type { AmpHost } from './amp.js'
import { asRecord } from './json.js'

const ACTOR = 'dsh-sync'

interface SyncChain {
  readonly goalId: string
  readonly planId: string
  readonly taskId: string
}

interface ActionRecord {
  readonly actionId: string
  readonly attemptId: string
}

/** One `compaction/summary` observation; an audit index, not an AMP entity. */
interface CompactionObservation {
  readonly sessionId: string
  readonly compactionId: string
  readonly summarySeq?: number
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount?: number
  readonly at: string
}

/** One seeded-fork or subagent lineage observation; never a workflow write. */
interface ForkObservation {
  readonly sessionId: string
  readonly sourceSessionId?: string
  readonly boundary: number
  readonly at: string
  readonly kind: 'fork' | 'subagent'
}

/** In-process cap for the bounded compaction audit ledger. */
const MAX_COMPACTION_LEDGER = 50

/** In-process cap for the bounded fork/subagent audit ledger. */
const MAX_FORK_LEDGER = 50

function has(service: { find(id: string): { isPresent(): boolean } }, id: string): boolean {
  try {
    return service.find(id).isPresent()
  } catch {
    return false
  }
}

function acceptanceOf(goalId: string): Record<string, unknown> {
  return {
    contractVersion: 'dsh-goal',
    verificationId: `dsh-goal:${goalId}`,
    evidenceIds: [],
    valid: true,
  }
}

/** Read a non-empty string, or `undefined`. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read a non-negative safe integer, or `undefined`. */
function integerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Read a numeric list defensively, dropping malformed members. */
function integerListOf(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const integers: number[] = []
  for (const entry of value) {
    const integer = integerOf(entry)
    if (integer !== undefined) integers.push(integer)
  }
  return integers
}

/** Current wall-clock time as an ISO string. */
function nowIso(): string {
  return new Date().toISOString()
}

export class AmpSync {
  private readonly ctx: Context
  private readonly host: AmpHost
  private readonly goals = new Map<string, string>()
  private readonly chains = new Map<string, SyncChain>()
  private readonly actions = new Map<string, ActionRecord>()
  private readonly errors: string[] = []
  private readonly deferred: unknown[] = []
  /** Bounded audit ledger of compaction summaries observed from session events. */
  private readonly compactions: CompactionObservation[] = []
  /** Bounded audit ledger of seeded forks and subagent children. */
  private readonly forks: ForkObservation[] = []
  private readonly counters = { session: 0, turn: 0, goal: 0, plan: 0, task: 0, action: 0, result: 0, compaction: 0, fork: 0, subagent: 0 }

  constructor(ctx: Context, host: AmpHost) {
    this.ctx = ctx
    this.host = host
  }

  attach(): void {
    const on = this.ctx.on.bind(this.ctx) as unknown as (name: string, handler: (payload: unknown) => void) => void
    on('agent/created', (payload) => {
      this.safe('agent/created', () => this.onAgentCreated((payload as { agent: Agent }).agent))
    })
    on('goal/changed', (payload) => {
      const value = payload as { agent: Agent; change: { goal?: { id: string; objective: string; phase: string; revision: number } } }
      this.safe('goal/changed', () => this.onGoalChanged(value.agent, value.change))
    })
  }

  status(): Record<string, unknown> {
    return {
      counters: { ...this.counters },
      goals: this.goals.size,
      chains: this.chains.size,
      actions: this.actions.size,
      errors: this.errors.slice(-20),
      deferred: this.deferred.slice(-20),
      compactions: this.compactions.slice(-20),
      forks: this.forks.slice(-20),
    }
  }

  onAgentCreated(agent: Agent): void {
    this.host.ensureSession(agent.id, this.host.rootOfAgent(agent))
    this.counters.session += 1
    this.observeLineage(agent)
  }

  onSessionEvent(session: { id: string }, event: { type: string; data?: unknown }): void {
    this.safe(`session/event ${event.type}`, () => {
      const raw = asRecord(event)
      const data = asRecord(event.data)
      if (raw === undefined || data === undefined) return
      const turn = typeof data.turn === 'number' ? data.turn : undefined
      const seq = integerOf(raw.seq)
      switch (event.type) {
        case 'turn/start':
          if (turn !== undefined) {
            const root = this.host.rootOfSession(session.id)
            this.host.ensureSession(session.id, root)
            this.host.ensureTurn(session.id, turn, root)
            this.counters.session += 1
            this.counters.turn += 1
          }
          break
        case 'turn/end':
          if (turn !== undefined) this.settleTurn(session.id, turn, data.reason)
          break
        case 'tool/call':
          this.startAction(session.id, turn, data)
          break
        case 'tool/result':
          this.settleAction(session.id, data)
          break
        case 'todo/write':
          this.syncTodos(session.id, turn, data)
          break
        case 'compaction/summary':
          this.observeCompaction(session.id, data, seq)
          break
        case 'compaction/start':
        case 'compaction/end':
          // Lifecycle brackets are observed but the audit fact is the summary.
          break
        default:
          break
      }
    })
  }

  onGoalChanged(agent: Agent, change: { goal?: { id: string; objective: string; phase: string; revision: number } }): void {
    const sessionId = agent.id
    const view = change.goal
    const key = view === undefined ? null : `${sessionId}:${view.id}`
    if (view === undefined || key === null) return
    this.ensureChain(sessionId, view.objective)
    const ampGoalId = this.goals.get(key) ?? `dsh:goal:${sessionId}:${view.id}`
    const service = this.kernelFor(sessionId).ports.services.goal
    try {
      if (!has(service as never, ampGoalId)) {
        this.kernelFor(sessionId).flow.createGoal({
          goalId: ampGoalId,
          missionId: `dsh:mission:${sessionId}`,
          contractVersion: `dsh-goal:v${view.revision}`,
          acceptanceCriteria: [view.objective],
          actor: ACTOR,
        })
        this.goals.set(key, ampGoalId)
        this.counters.goal += 1
      }
      const goal = service.get(ampGoalId)
      if ((view.phase === 'complete' || view.phase === 'blocked') && goal.state !== 'achieved') {
        // AMP requires an independent verification and evidence before it
        // settles a goal. DSH goal completion is therefore recorded as a
        // deferred settlement instead of fabricating that evidence.
        this.deferred.push({ kind: 'goal', goalId: ampGoalId, phase: view.phase, revision: view.revision })
      }
    } catch (error) {
      this.fail('goal', error)
    }
  }

  /**
   * Append one compaction summary to the audit ledger.
   *
   * Only `compactionId` is required; every other field degrades to absent or
   * empty so a malformed payload never throws or touches AMP workflow state.
   */
  private observeCompaction(sessionId: string, data: Record<string, unknown>, seq: number | undefined): void {
    const compactionId = stringOf(data.compactionId)
    if (compactionId === undefined) return
    const shadowedTokenCount = integerOf(data.shadowedTokenCount)
    this.compactions.push({
      sessionId,
      compactionId,
      ...(seq === undefined ? {} : { summarySeq: seq }),
      shadowedSeqs: integerListOf(data.shadowedSeqs),
      ...(shadowedTokenCount === undefined ? {} : { shadowedTokenCount }),
      at: nowIso(),
    })
    this.counters.compaction += 1
    while (this.compactions.length > MAX_COMPACTION_LEDGER) this.compactions.shift()
  }

  /**
   * Classify an agent's durable header into the lineage audit ledger.
   *
   * A seeded ordinary session records a `fork`; an `origin: 'subagent'` child
   * records a `subagent` regardless of seeding. Missing headers and malformed
   * fields are ignored: no AMP workflow entity or receipt is ever created.
   */
  private observeLineage(agent: Agent): void {
    try {
      const handle = asRecord(agent)
      const session = asRecord(handle?.session)
      const header = asRecord(session?.header)
      if (header === undefined) return
      const sessionId = stringOf(handle?.id) ?? stringOf(header.id)
      if (sessionId === undefined) return
      const subagent = header.origin === 'subagent'
      if (!subagent && header.isSeeded !== true) return
      const sourceSessionId = stringOf(header.parentSession)
      this.forks.push({
        sessionId,
        ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
        boundary: integerOf(session?.inheritedEventCount) ?? 0,
        at: nowIso(),
        kind: subagent ? 'subagent' : 'fork',
      })
      if (subagent) this.counters.subagent += 1
      else this.counters.fork += 1
      while (this.forks.length > MAX_FORK_LEDGER) this.forks.shift()
    } catch {
      // A malformed header must not disturb the session projection.
    }
  }

  /**
   * Close one DSH turn in the AMP workflow.
   *
   * Live `turn/end` events call this directly. Recovery also calls it for
   * historical `turn/end` events after a reload so turns created before the
   * reload do not stay `interpreting` forever. The method is idempotent: it
   * leaves an already-settled turn untouched and never creates a turn.
   */
  settleTurn(sessionId: string, turn: number, reason: unknown): void {
    const id = this.host.turnId(sessionId, turn)
    const service = this.kernelFor(sessionId).ports.services.turn
    try {
      if (!has(service as never, id)) return
      const current = service.get(id)
      const reasonText = typeof reason === 'string' ? reason : asRecord(reason)?.kind ?? asRecord(reason)?.reason
      const aborted = reasonText === 'aborted' || reasonText === 'error' || reasonText === 'interrupted'
      if (aborted) {
        try {
          service.abandon(id, { expectedVersion: current.version, actor: ACTOR } as never)
        } catch {
          service.complete(id, { expectedVersion: current.version, actor: ACTOR } as never)
        }
        return
      }
      let state = service.get(id)
      if (state.state === 'interpreting') {
        state = service.respond(id, { expectedVersion: state.version, actor: ACTOR } as never)
      } else if (state.state === 'received') {
        state = service.interpret(id, { expectedVersion: state.version, actor: ACTOR } as never)
        state = service.respond(id, { expectedVersion: state.version, actor: ACTOR } as never)
      } else if (state.state === 'acting') {
        state = service.respond(id, { expectedVersion: state.version, actor: ACTOR } as never)
      }
      if (state.state !== 'completed') {
        service.complete(id, { expectedVersion: state.version, actor: ACTOR } as never)
      }
    } catch (error) {
      this.fail('turn', error)
    }
  }

  private startAction(sessionId: string, turn: number | undefined, data: Record<string, unknown>): void {
    const callId = typeof data.callId === 'string' ? data.callId : undefined
    const name = typeof data.name === 'string' ? data.name : 'tool'
    if (callId === undefined || this.actions.has(callId)) return
    const chain = this.ensureChain(sessionId, `DSH session ${sessionId} tool work`, turn)
    const service = this.kernelFor(sessionId).ports.services.action
    const actionId = `dsh:action:${callId}`
    try {
      if (!has(service as never, actionId)) {
        let action = service.create({
          id: actionId,
          sessionId,
          originTurnId: this.host.turnId(sessionId, turn ?? this.host.currentTurn(sessionId) ?? 0),
          taskId: chain.taskId,
          operationId: `dsh:op:${callId}`,
          effect: `tool:${name}`,
          required: true,
          sideEffect: true,
          recovery: 'idempotent',
        } as never, ACTOR)
        action = service.pend(action.id, { expectedVersion: action.version, actor: ACTOR } as never)
        action = service.ready(action.id, { expectedVersion: action.version, actor: ACTOR } as never)
        const attempt = service.startAttempt(action.id, {
          expectedVersion: action.version,
          cancellationEpoch: action.cancellationEpoch,
          executionId: `dsh:exec:${callId}`,
          attemptId: `dsh:attempt:${callId}`,
          actor: ACTOR,
        } as never)
        this.actions.set(callId, { actionId, attemptId: attempt.attemptId })
        this.counters.action += 1
      }
    } catch (error) {
      this.fail('action', error)
    }
  }

  private settleAction(sessionId: string, data: Record<string, unknown>): void {
    const message = asRecord(data.message)
    const callId = typeof data.callId === 'string'
      ? data.callId
      : typeof message?.toolCallId === 'string'
        ? message.toolCallId
        : typeof message?.callId === 'string'
          ? message.callId
          : undefined
    if (callId === undefined) return
    const record = this.actions.get(callId)
    if (record === undefined) return
    const service = this.kernelFor(sessionId).ports.services.action
    try {
      const action = service.get(record.actionId)
      const attempt = service.getAttempt(record.attemptId)
      // Session feeds can replay an already delivered result after reattachment.
      // Unknown outcomes require explicit reconciliation; never settle them here.
      if (attempt.state !== 'running') return
      const failed = message?.isError === true || data.error !== undefined
      service.settleAttempt(record.attemptId, {
        expectedVersion: attempt.version,
        expectedActionVersion: action.version,
        outcome: failed ? 'failed' : 'succeeded',
        actor: ACTOR,
      } as never)
      this.counters.result += 1
    } catch (error) {
      this.fail('result', error)
    }
  }

  private syncTodos(sessionId: string, turn: number | undefined, data: Record<string, unknown>): void {
    const todos = Array.isArray(data.todos) ? data.todos : []
    const chain = this.ensureChain(sessionId, `DSH session ${sessionId} plan work`, turn)
    const planId = `dsh:plan:todos:${sessionId}`
    const services = this.kernelFor(sessionId).ports.services
    try {
      if (!has(services.plan as never, planId)) {
        this.kernelFor(sessionId).flow.createPlan({
          planId,
          goalId: chain.goalId,
          bounds: {
            maxAttempts: 5,
            deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            progressMetric: 'todos',
            deadLetterOwner: 'dsh-host',
          },
          tasks: todos.length === 0
            ? [{ taskId: `dsh:task:todos:${sessionId}:empty` }]
            : todos.map((_, index) => ({ taskId: `dsh:task:todos:${sessionId}:${index}` })),
          actor: ACTOR,
        } as never)
        this.counters.plan += 1
        try {
          let plan = services.plan.get(planId)
          plan = services.plan.approve(planId, { expectedVersion: plan.version, actor: ACTOR } as never)
          services.plan.execute(planId, { expectedVersion: plan.version, actor: ACTOR } as never)
        } catch {
          // A plan can stay draft; tasks below are still mirrored.
        }
      }
      todos.forEach((raw, index) => {
        const item = asRecord(raw)
        if (item === undefined) return
        const taskId = `dsh:task:todos:${sessionId}:${index}`
        const status = typeof item.status === 'string' ? item.status : 'pending'
        try {
          if (!has(services.task as never, taskId)) {
            // Executing plans have a fixed task DAG. Mirror appended todos in
            // a supplemental plan instead of trying to mutate the original DAG.
            const extensionId = `${planId}:extension:${index}`
            if (!has(services.plan as never, extensionId)) {
              this.kernelFor(sessionId).flow.createPlan({
                planId: extensionId,
                goalId: chain.goalId,
                bounds: services.plan.get(planId).bounds,
                tasks: [{ taskId }],
                actor: ACTOR,
              } as never)
              this.counters.plan += 1
            }
            let extension = services.plan.get(extensionId)
            if (extension.state === 'draft') extension = services.plan.approve(extensionId, { expectedVersion: extension.version, actor: ACTOR } as never)
            if (extension.state === 'approved') services.plan.execute(extensionId, { expectedVersion: extension.version, actor: ACTOR } as never)
          }
          let task = services.task.get(taskId)
          // Existing stores may contain draft/approved plans from an interrupted
          // projection. Recover the owning plan before advancing its task.
          let owningPlan = services.plan.get(task.planId)
          if (owningPlan.state === 'draft') owningPlan = services.plan.approve(owningPlan.id, { expectedVersion: owningPlan.version, actor: ACTOR } as never)
          if (owningPlan.state === 'approved' || owningPlan.state === 'ready') services.plan.execute(owningPlan.id, { expectedVersion: owningPlan.version, actor: ACTOR } as never)
          if (status === 'in_progress' && task.state === 'pending') {
            task = services.task.ready(taskId, { expectedVersion: task.version, actor: ACTOR } as never)
          }
          if (status === 'in_progress' && task.state === 'ready') {
            task = services.task.activate(taskId, { expectedVersion: task.version, actor: ACTOR } as never)
          }
          if (status === 'completed' && task.state !== 'completed') {
            if (task.state === 'pending') task = services.task.ready(taskId, { expectedVersion: task.version, actor: ACTOR } as never)
            if (task.state === 'ready') task = services.task.activate(taskId, { expectedVersion: task.version, actor: ACTOR } as never)
            try {
              services.task.complete(taskId, acceptanceOf(taskId) as never, { expectedVersion: task.version, actor: ACTOR, cancellationEpoch: task.cancellationEpoch } as never)
            } catch {
              this.deferred.push({ kind: 'task', taskId, state: task.state, reason: 'verification-required' })
            }
          }
        } catch (error) {
          this.fail('todo-task', error)
        }
      })
      this.counters.task = Math.max(this.counters.task, todos.length)
    } catch (error) {
      this.fail('todos', error)
    }
  }

  /** Create the DSH-session AMP chain once: intent → mission → goal → tools plan/task. */
  private ensureChain(sessionId: string, objective: string, turn?: number): SyncChain {
    const cached = this.chains.get(sessionId)
    if (cached !== undefined) {
      this.activateChain(sessionId, cached.planId, cached.taskId)
      return cached
    }
    this.host.ensureSession(sessionId)
    const turnId = this.host.ensureTurn(sessionId, turn)
    const kernel = this.kernelFor(sessionId)
    const services = kernel.ports.services
    const intentId = `dsh:intent:${sessionId}`
    if (!has(services.intent as never, intentId)) {
      kernel.flow.captureIntent({ intentId, turnId, text: objective, actor: ACTOR })
      try {
        kernel.flow.confirmIntent({ intentId, actor: ACTOR })
      } catch {
        // Some intents stay captured; the mission projection below is still useful.
      }
    }
    const missionId = `dsh:mission:${sessionId}`
    if (!has(services.mission as never, missionId)) {
      kernel.flow.createMission({ missionId, intentId, actor: ACTOR })
    }
    const goalId = `dsh:goal:session:${sessionId}`
    if (!has(services.goal as never, goalId)) {
      kernel.flow.createGoal({
        goalId,
        missionId,
        contractVersion: 'dsh-session',
        acceptanceCriteria: [objective],
        actor: ACTOR,
      })
    }
    const planId = `dsh:plan:tools:${sessionId}`
    const taskId = `dsh:task:tools:${sessionId}`
    if (!has(services.plan as never, planId)) {
      kernel.flow.createPlan({
        planId,
        goalId,
        bounds: {
          maxAttempts: 1000,
          deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          progressMetric: 'tool-calls',
          deadLetterOwner: 'dsh-host',
        },
        tasks: [{ taskId }],
        actor: ACTOR,
      })
      try {
        let plan = services.plan.get(planId)
        plan = services.plan.approve(planId, { expectedVersion: plan.version, actor: ACTOR } as never)
        services.plan.execute(planId, { expectedVersion: plan.version, actor: ACTOR } as never)
        let task = services.task.get(taskId)
        task = services.task.ready(taskId, { expectedVersion: task.version, actor: ACTOR } as never)
        services.task.activate(taskId, { expectedVersion: task.version, actor: ACTOR } as never)
      } catch {
        // Tasks remain pending; action attempts below will report the guard.
      }
    }
    const chain: SyncChain = { goalId, planId, taskId }
    this.chains.set(sessionId, chain)
    this.activateChain(sessionId, planId, taskId)
    return chain
  }

  /** Drive an existing plan/task to executable states after a host restart. */
  private activateChain(sessionId: string, planId: string, taskId: string): void {
    const services = this.kernelFor(sessionId).ports.services
    try {
      let plan = services.plan.get(planId)
      if (plan.state === 'draft') plan = services.plan.approve(planId, { expectedVersion: plan.version, actor: ACTOR } as never)
      if (plan.state === 'approved') services.plan.execute(planId, { expectedVersion: plan.version, actor: ACTOR } as never)
    } catch {
      // The plan may already be executing or completed.
    }
    try {
      let task = services.task.get(taskId)
      if (task.state === 'pending') task = services.task.ready(taskId, { expectedVersion: task.version, actor: ACTOR } as never)
      if (task.state === 'ready') services.task.activate(taskId, { expectedVersion: task.version, actor: ACTOR } as never)
    } catch {
      // A completed or cancelled task is terminal; the action guard will report it.
    }
  }

  /** The kernel store owned by one session's workspace root. */
  private kernelFor(sessionId: string): Kernel {
    return this.host.kernel(this.host.rootOfSession(sessionId))
  }

  private safe(label: string, run: () => void): void {
    try {
      run()
    } catch (error) {
      this.fail(label, error)
    }
  }

  private fail(label: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.errors.push(`${label}: ${message}`)
    while (this.errors.length > 50) this.errors.shift()
  }
}


