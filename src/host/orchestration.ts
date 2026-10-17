/**
 * Verify-gated multi-agent orchestration (v23 §8, §3.4/§3.6, §6.1, §11.7-11.8,
 * §17.1).
 *
 * Three separations are enforced here instead of merely documented:
 *
 * - the **parent** decomposes the plan, dispatches, decides recovery and
 *   synthesises the Answer;
 * - the **worker** executes in its isolated context and submits its own result
 *   plus self-check evidence;
 * - the **verifier** is a different agent instance: `verify` refuses when the
 *   verifier equals the actor of the latest `submit` event, so the agent that
 *   did the work can never mark the task complete.
 *
 * Verification is layered. A deterministic ground truth is evaluated first and
 * may verify a subtask on its own (`exists:`, `contains:`, `not-contains:`,
 * `regex:`, `equals:`). Anything the deterministic layer cannot cover is never
 * guessed: this composition has no judge-model port, so the verdict is
 * `unverifiable` and the subtask is recorded as `rejected` (fail-closed, §8.5);
 * the parent then sees a RecoveryPacket and decides. `exit:` is never executed:
 * shell ground truth has no execution port here and
 * `config.orchestration.allowShellGroundTruth` defaults to false.
 *
 * Terminal subtask states (`verified`, `rejected`, `partial`, `abandoned`) are
 * irreversible. The single lawful loop is `verify` -> `rejected` ->
 * `recover` (parent only) -> `pending`, bounded by `maxReject`.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type {
  Answer,
  OrchestrationTrace,
  Plan,
  RecoveryDecision,
  RecoveryPacket,
  SubTask,
  Turn,
} from '../shared/entity.js'
import type {
  Profession,
  ProfessionStatus,
  RecoverySuggestion,
  SubTaskStatus,
  TraceEvent,
  Validation,
  Verdict,
} from '../shared/enum.js'
import {
  InvalidArgumentError,
  InvalidStateError,
  ProfessionRequiredError,
  VerificationError,
} from '../shared/error.js'
import type { ModuleHost } from './module.js'
import { assertProfession } from './profession.js'
import type { ProfessionModule } from './profession.js'
import { mapPlan, mapSubTask, mapTrace, mapTurn, number, text } from './row.js'
import type { Row } from './row.js'

/** A subtask that is finished for better or worse; no dispatch/submit/verify. */
const TerminalSubTask: ReadonlySet<SubTaskStatus> = new Set<SubTaskStatus>([
  'verified',
  'rejected',
  'partial',
  'abandoned',
])

const RecoverySuggestionValues: readonly RecoverySuggestion[] = [
  'retry',
  'revise_criteria',
  'accept_partial',
  'escalate',
]

/** The fields a draft in `plan.step` may carry (v23 §8.2 plus the routing reason). */
const SubTaskDraftFields: ReadonlySet<string> = new Set<string>([
  'model',
  'effort',
  'task',
  'tools',
  'context',
  'acceptance',
  'groundTruth',
  'profession',
  'blockedBy',
  'reason',
])

/**
 * Recorded in `subtask.model` when neither the parent Organization nor the
 * session names a model. A subtask always has a model, but the parent model is
 * not a column of `turn` in the v23 schema, so the least surprising value is an
 * explicit "inherit the parent model" sentinel rather than an invented id.
 */
const InheritedModel = 'inherit'

/** One draft of `plan.step` (v23 §8.2). */
export interface SubTaskDraft {
  model?: string
  effort?: string
  task: string
  tools?: string[]
  context?: string
  acceptance: string
  groundTruth?: string
  profession?: Profession
  blockedBy?: number[]
  /** Why this subtask routes to a different model; audited in the lock trace. */
  reason?: string
}

/** The deterministic layer's answer for one result. */
interface GroundTruthOutcome {
  verdict: Verdict
  reason: string
  /** How the parent could recover; `retry` is the fallback when omitted. */
  suggestion?: RecoverySuggestion
}

/** A draft after validation and defaulting, before it becomes a row. */
interface NormalisedDraft {
  model: string
  modelOverridden: boolean
  effort: string
  task: string
  tools: string[]
  context: string
  acceptance: string
  groundTruth?: string
  profession: Profession
  blockedBy: number[]
  reason?: string
}

export class OrchestrationModule {
  private readonly host: ModuleHost
  private readonly profession: ProfessionModule

  constructor(host: ModuleHost, profession: ProfessionModule) {
    this.host = host
    this.profession = profession
  }

  /* ----------------------------------------------------------------------- *
   * Decompose: Plan.step -> locked SubTask rows
   * ----------------------------------------------------------------------- */

  /**
   * Parse `plan.step` (a JSON array of drafts) into locked subtasks.
   *
   * Every draft must carry a non-empty `acceptance` before the subtask exists
   * (§8.2: criteria cannot be added after dispatch). `effort` is strictly
   * inherited from the parent turn: a draft that names a different effort is
   * rejected rather than silently normalised (§8.7). `model` may differ so the
   * parent can route cheaper work, and a draft `reason` is recorded on the lock
   * trace and the profession record.
   *
   * `blockedBy` entries must be identities of subtasks that already exist for
   * the same turn: identities of drafts inside this same array are not knowable
   * before insertion, so forward references are refused instead of guessed.
   */
  decompose(plan: number): SubTask[] {
    const planRecord = this.requirePlan(plan)
    const turn = this.requireTurn(planRecord.turn)
    if (!turn.locked) {
      // Fail-closed (§3.9): the parent must have locked one profession first.
      throw new ProfessionRequiredError({ turn: turn.identity })
    }

    const drafts = this.readDrafts(planRecord.step)
    if (drafts.length === 0) {
      throw new InvalidArgumentError(`plan ${plan} has no steps to decompose`, { plan })
    }

    const maximumSubTask = this.host.config.orchestration.maxSubTask
    const existingSubTask = this.host.db.count('subtask', 'parent = ?', turn.identity)
    if (existingSubTask + drafts.length > maximumSubTask) {
      throw new InvalidArgumentError(
        `plan ${plan} would create ${existingSubTask + drafts.length} subtasks, exceeding maxSubTask ${maximumSubTask}`,
        {
          plan,
          turn: turn.identity,
          existing: existingSubTask,
          requested: drafts.length,
          maxSubTask: maximumSubTask,
        },
      )
    }

    const parentModel = this.parentModel(turn)
    const normalised = drafts.map((draft, index) => this.normaliseDraft(draft, index, turn, parentModel))
    for (const draft of normalised) this.assertDependencies(draft.blockedBy, turn.identity)

    return this.host.db.transaction(() => normalised.map((draft) => this.insertSubTask(planRecord, turn, draft)))
  }

  /* ----------------------------------------------------------------------- *
   * Dispatch: pending -> running (dependencies verified, fail-closed)
   * ----------------------------------------------------------------------- */

  dispatch(subtask: number): SubTask {
    const current = this.requireSubTask(subtask)
    const turn = this.requireTurn(current.parent)

    if (TerminalSubTask.has(current.status)) {
      throw new InvalidStateError(`subtask ${subtask} is already ${current.status}; terminal states are irreversible`, {
        subtask,
        status: current.status,
      })
    }
    if (current.status !== 'pending') {
      throw new InvalidStateError(`subtask ${subtask} must be pending to dispatch (current: ${current.status})`, {
        subtask,
        status: current.status,
      })
    }
    if (!current.locked) {
      throw new ProfessionRequiredError({ turn: current.parent, subtask })
    }
    if (current.effort !== turn.effort) {
      throw new InvalidStateError(
        `subtask ${subtask} effort "${current.effort}" does not match parent effort "${turn.effort}"; effort cannot be downgraded`,
        { subtask, turn: current.parent, effort: current.effort, inherited: turn.effort },
      )
    }
    for (const dependency of current.blockedBy) {
      const row = this.host.db.get<Row>('SELECT parent, status FROM subtask WHERE identity = ?', dependency)
      if (row === undefined) {
        throw new InvalidStateError(`subtask ${subtask} is blocked by missing subtask ${dependency}`, {
          subtask,
          blockedBy: dependency,
        })
      }
      if (number(row, 'parent') !== current.parent) {
        throw new InvalidStateError(`subtask ${subtask} is blocked by subtask ${dependency} of another turn`, {
          subtask,
          blockedBy: dependency,
          turn: current.parent,
        })
      }
      const status = text(row, 'status') as SubTaskStatus
      if (status !== 'verified') {
        throw new InvalidStateError(
          `subtask ${subtask} is blocked by subtask ${dependency} (status: ${status}); dependencies must be verified`,
          { subtask, blockedBy: dependency, status },
        )
      }
    }

    const lockTrace = this.latestTrace(current.parent, 'lock', subtask)
    this.host.db.transaction(() => {
      this.host.db.update('subtask', { status: 'running', finished: null }, 'identity = ?', subtask)
      this.profession.recordProfession(current.parent, current.profession, 'host', 'running', { subtask })
      this.host.trace.append({
        turn: current.parent,
        event: 'dispatch',
        subtask,
        actor: 'host',
        profession: current.profession,
        ...(lockTrace === undefined ? {} : { parentEvent: lockTrace.identity }),
        detail: {
          model: current.model,
          effort: current.effort,
          profession: current.profession,
          blockedBy: current.blockedBy,
        },
      })
    })
    return this.requireSubTask(subtask)
  }

  /* ----------------------------------------------------------------------- *
   * Submit: running -> submitted (worker declares completion with evidence)
   * ----------------------------------------------------------------------- */

  /**
   * Record a worker's completion claim. The result and evidence are mandatory;
   * the submitting actor is the executor handle used by `verify` to refuse
   * self-verification. It defaults to `worker` when the caller has no handle.
   */
  submit(subtask: number, result: string, evidence: string, actor?: string): SubTask {
    const current = this.requireSubTask(subtask)

    if (TerminalSubTask.has(current.status)) {
      throw new InvalidStateError(`subtask ${subtask} is already ${current.status}; terminal states are irreversible`, {
        subtask,
        status: current.status,
      })
    }
    if (current.status !== 'running') {
      throw new InvalidStateError(`subtask ${subtask} must be running to submit (current: ${current.status})`, {
        subtask,
        status: current.status,
      })
    }

    const submittedResult = requireText(result, 'submit requires a non-empty result')
    const submittedEvidence = requireText(evidence, 'submit requires non-empty evidence')
    const executor =
      actor === undefined
        ? 'worker'
        : requireText(actor, 'submit actor must be a non-empty handle when provided').trim()

    const dispatchTrace = this.latestTrace(current.parent, 'dispatch', subtask)
    this.host.db.transaction(() => {
      this.host.db.update(
        'subtask',
        { status: 'submitted', result: submittedResult, evidence: submittedEvidence },
        'identity = ?',
        subtask,
      )
      this.profession.recordProfession(current.parent, current.profession, executor, 'running', {
        subtask,
        output: submittedResult,
      })
      this.host.trace.append({
        turn: current.parent,
        event: 'submit',
        subtask,
        actor: executor,
        profession: current.profession,
        ...(dispatchTrace === undefined ? {} : { parentEvent: dispatchTrace.identity }),
        detail: { result: submittedResult, evidence: submittedEvidence },
      })
    })
    return this.requireSubTask(subtask)
  }

  /* ----------------------------------------------------------------------- *
   * Verify: submitted -> verified | rejected (independent verifier)
   * ----------------------------------------------------------------------- */

  /**
   * Independently judge one submission.
   *
   * The verifier must differ from the actor of the latest `submit` trace; that
   * is the v23 "the agent doing the work never marks the task complete" rule.
   * Deterministic ground truth decides first. Without it (or with unknown
   * syntax / disabled checks / `exit:`) the verdict is `unverifiable` and the
   * status is `rejected` with a RecoveryPacket for the parent: fail-closed.
   */
  verify(subtask: number, verifier: string): SubTask {
    const current = this.requireSubTask(subtask)

    if (TerminalSubTask.has(current.status)) {
      throw new InvalidStateError(`subtask ${subtask} is already ${current.status}; terminal states are irreversible`, {
        subtask,
        status: current.status,
      })
    }
    if (current.status !== 'submitted') {
      throw new InvalidStateError(`subtask ${subtask} must be submitted before it can be verified (current: ${current.status})`, {
        subtask,
        status: current.status,
      })
    }

    const verifying = requireText(verifier, 'verify requires a non-empty verifier handle').trim()
    const submitTrace = this.latestTrace(current.parent, 'submit', subtask)
    if (submitTrace === undefined) {
      throw new InvalidStateError(`subtask ${subtask} has no submit event, so verification cannot be attributed`, {
        subtask,
        turn: current.parent,
      })
    }
    if (submitTrace.actor === verifying) {
      throw new VerificationError(
        `verifier "${verifying}" submitted subtask ${subtask}; the worker cannot mark its own task complete`,
        { subtask, turn: current.parent, actor: verifying },
      )
    }

    const groundTruth = current.groundTruth
    const outcome = this.evaluateGroundTruth(current, groundTruth, current.result ?? '')
    const passed = outcome.verdict === 'pass'
    const reason = outcome.reason
    const recovery: RecoveryPacket = {
      failedCriteria: current.acceptance,
      cause: reason,
      suggestion: outcome.suggestion ?? 'retry',
      detail: groundTruth === undefined ? 'no ground truth declared' : `groundTruth=${groundTruth}`,
    }
    const now = this.host.clock.now()

    this.host.db.transaction(() => {
      this.host.db.update(
        'subtask',
        {
          status: passed ? 'verified' : 'rejected',
          verdict: outcome.verdict,
          reason,
          recovery: passed ? null : recovery,
          finished: now,
        },
        'identity = ?',
        subtask,
      )
      this.profession.recordProfession(current.parent, current.profession, verifying, passed ? 'done' : 'failed', {
        subtask,
        output: current.result,
        reason,
      })
      this.host.trace.append({
        turn: current.parent,
        event: 'verify',
        subtask,
        actor: verifying,
        parentEvent: submitTrace.identity,
        detail: {
          verdict: outcome.verdict,
          groundTruth: groundTruth ?? null,
          reason,
          recovery: passed ? null : recovery,
          status: passed ? 'verified' : 'rejected',
        },
      })
    })
    return this.requireSubTask(subtask)
  }

  /* ----------------------------------------------------------------------- *
   * Recover: rejected -> pending | partial | rejected (parent decision only)
   * ----------------------------------------------------------------------- */

  /**
   * Apply the parent's recovery decision after a FAIL/UNVERIFIABLE verdict.
   *
   * The verifier only produced the packet; the decision belongs to the parent,
   * which is why this method is the only writer of `rejectCount`. `retry` and
   * `revise_criteria` re-open the subtask and increment the counter; once the
   * counter would exceed `config.orchestration.maxReject` the loop is closed
   * and only `accept_partial` or `escalate` remain (§8.6).
   */
  recover(subtask: number, decision: RecoveryDecision): SubTask {
    const current = this.requireSubTask(subtask)

    if (current.status !== 'rejected') {
      throw new InvalidStateError(
        `subtask ${subtask} must be rejected before a recovery decision (current: ${current.status})`,
        { subtask, status: current.status },
      )
    }
    if (current.reason === 'escalated to human') {
      throw new InvalidStateError(`subtask ${subtask} is already escalated to a human`, { subtask })
    }

    if (decision === null || typeof decision !== 'object') {
      throw new InvalidArgumentError('recover requires a recovery decision', { subtask })
    }
    if (!RecoverySuggestionValues.includes(decision.suggestion)) {
      throw new InvalidArgumentError(`unknown recovery suggestion: ${String(decision.suggestion)}`, {
        subtask,
        allowed: RecoverySuggestionValues,
      })
    }

    const maximumReject = this.host.config.orchestration.maxReject
    const nextReject = current.rejectCount + 1
    const reopens = decision.suggestion === 'retry' || decision.suggestion === 'revise_criteria'
    if (reopens && nextReject > maximumReject) {
      throw new InvalidStateError(
        `subtask ${subtask} reached maxReject ${maximumReject}; only accept_partial or escalate remain`,
        { subtask, rejectCount: current.rejectCount, maxReject: maximumReject },
      )
    }

    const acceptance =
      decision.suggestion === 'revise_criteria'
        ? requireText(decision.criteria, 'revise_criteria requires non-empty criteria')
        : current.acceptance
    const now = this.host.clock.now()
    const verifyTrace = this.latestTrace(current.parent, 'verify', subtask)

    let patch: Record<string, unknown>
    let recordStatus: ProfessionStatus
    let recordReason: string
    switch (decision.suggestion) {
      case 'retry':
        patch = {
          status: 'pending',
          rejectCount: nextReject,
          verdict: null,
          reason: null,
          recovery: null,
          finished: null,
        }
        recordStatus = 'pending'
        recordReason = 'retry requested by parent'
        break
      case 'revise_criteria':
        patch = {
          status: 'pending',
          rejectCount: nextReject,
          acceptance,
          verdict: null,
          reason: null,
          recovery: null,
          finished: null,
        }
        recordStatus = 'pending'
        recordReason = `criteria revised by parent: ${acceptance}`
        break
      case 'accept_partial':
        patch = {
          status: 'partial',
          verdict: 'partial',
          reason: decision.detail === undefined ? 'accepted partial by parent' : decision.detail,
          finished: now,
        }
        recordStatus = 'done'
        recordReason = decision.detail === undefined ? 'accepted partial by parent' : decision.detail
        break
      case 'escalate':
        patch = { status: 'rejected', reason: 'escalated to human', finished: now }
        recordStatus = 'failed'
        recordReason = 'escalated to human'
        break
    }

    this.host.db.transaction(() => {
      this.host.db.update('subtask', patch, 'identity = ?', subtask)
      this.profession.recordProfession(current.parent, current.profession, 'parent', recordStatus, {
        subtask,
        output: current.result,
        reason: recordReason,
      })
      this.host.trace.append({
        turn: current.parent,
        event: 'recover',
        subtask,
        actor: 'parent',
        ...(verifyTrace === undefined ? {} : { parentEvent: verifyTrace.identity }),
        detail: {
          from: current.status,
          verdict: current.verdict ?? null,
          suggestion: decision.suggestion,
          criteria: decision.suggestion === 'revise_criteria' ? acceptance : (decision.criteria ?? null),
          detail: decision.detail ?? null,
          rejectCount: reopens ? nextReject : current.rejectCount,
          status: patch.status,
        },
      })
    })
    return this.requireSubTask(subtask)
  }

  /* ----------------------------------------------------------------------- *
   * Synthesize: verified/partial subtasks -> one Answer
   * ----------------------------------------------------------------------- */

  /**
   * Combine accepted subtask results into one Answer.
   *
   * Every subtask must be `verified` or `partial`; a single pending, running,
   * submitted or rejected subtask refuses synthesis. The turn itself is *not*
   * finished here (the DSH bridge owns the turn lifecycle). The Answer table has
   * no evidence column in v23 §17.1, so the aggregate evidence package is
   * written to the `synthesize` trace detail rather than dropped.
   */
  synthesize(turn: number, actor?: string): Answer {
    const current = this.requireTurn(turn)
    const synthesizing =
      actor === undefined
        ? 'parent'
        : requireText(actor, 'synthesize actor must be a non-empty handle when provided').trim()
    const subtasks = this.list(turn)
    if (subtasks.length === 0) {
      throw new InvalidStateError(`turn ${turn} has no subtasks to synthesize`, { turn })
    }
    const unfinished = subtasks.filter((item) => item.status !== 'verified' && item.status !== 'partial')
    if (unfinished.length > 0) {
      throw new InvalidStateError(
        `turn ${turn} still has unverified subtasks: ${unfinished
          .map((item) => `${item.identity} (${item.status})`)
          .join(', ')}`,
        {
          turn,
          subtasks: unfinished.map((item) => ({ subtask: item.identity, status: item.status })),
        },
      )
    }

    const content = subtasks
      .map((item, index) => `## ${index + 1}. ${item.task}\n\nStatus: ${item.status}\n\n${item.result ?? ''}`)
      .join('\n\n')
    const evidence = subtasks.map((item) => ({
      subtask: item.identity,
      handle: item.handle,
      status: item.status,
      verdict: item.verdict ?? null,
      groundTruth: item.groundTruth ?? null,
      evidence: item.evidence ?? null,
    }))
    const now = this.host.clock.now()

    const identity = this.host.db.transaction(() => {
      const answerIdentity = this.host.db.insert('answer', {
        handle: this.host.handles.next('answer'),
        turn,
        content,
        validation: current.validation,
        created: now,
      })
      this.host.trace.append({
        turn,
        event: 'synthesize',
        actor: synthesizing,
        detail: {
          subtasks: subtasks.map((item) => ({
            subtask: item.identity,
            status: item.status,
            verdict: item.verdict ?? null,
          })),
          evidence,
          contentLength: content.length,
        },
      })
      return answerIdentity
    })
    return mapAnswer(this.host.db.require<Row>('answer', identity, 'answer'))
  }

  /* ----------------------------------------------------------------------- *
   * Read surface
   * ----------------------------------------------------------------------- */

  list(turn: number): SubTask[] {
    this.requireTurn(turn)
    return this.host.db
      .all<Row>('SELECT * FROM subtask WHERE parent = ? ORDER BY identity ASC', turn)
      .map(mapSubTask)
  }

  get(subtask: number): SubTask {
    return this.requireSubTask(subtask)
  }

  trace(turn: number): OrchestrationTrace[] {
    return this.host.trace.list(turn)
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  private requireTurn(turn: number): Turn {
    return mapTurn(this.host.db.require<Row>('turn', turn, 'turn'))
  }

  private requireSubTask(subtask: number): SubTask {
    return mapSubTask(this.host.db.require<Row>('subtask', subtask, 'subtask'))
  }

  private requirePlan(plan: number): Plan {
    return mapPlan(this.host.db.require<Row>('plan', plan, 'plan'))
  }

  /** Parse `plan.step`; malformed JSON or a non-array is an argument error. */
  private readDrafts(step: string): unknown[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(step)
    } catch (error) {
      throw new InvalidArgumentError('plan.step is not valid JSON', {
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    if (!Array.isArray(parsed)) {
      throw new InvalidArgumentError('plan.step must be a JSON array of subtask drafts', {
        received: parsed === null ? 'null' : typeof parsed,
      })
    }
    return parsed
  }

  /**
   * The parent model a draft inherits. `turn` has no model column in the v23
   * schema, so the last model the parent recorded in `organization` wins; the
   * session profile route is the only other per-session candidate; otherwise
   * the explicit `inherit` sentinel is stored.
   */
  private parentModel(turn: Turn): string {
    const organization = this.host.db.get<Row>(
      `SELECT model FROM organization
       WHERE turn = ? AND model IS NOT NULL AND model <> ''
       ORDER BY identity DESC LIMIT 1`,
      turn.identity,
    )
    const recorded = organization === undefined ? '' : text(organization, 'model').trim()
    if (recorded.length > 0) return recorded

    const session = this.host.db.get<Row>('SELECT profile FROM session WHERE identity = ?', turn.session)
    const profile = session === undefined ? '' : text(session, 'profile').trim()
    return profile.length > 0 ? profile : InheritedModel
  }

  /** Validate one draft and apply the v23 defaults. */
  private normaliseDraft(draft: unknown, index: number, turn: Turn, parentModel: string): NormalisedDraft {
    if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
      throw new InvalidArgumentError(`plan step ${index + 1} must be a JSON object`, { index })
    }
    const candidate = draft as SubTaskDraft & Record<string, unknown>
    for (const field of Object.keys(candidate)) {
      if (!SubTaskDraftFields.has(field)) {
        throw new InvalidArgumentError(`plan step ${index + 1} has an unknown field "${field}"`, {
          index,
          allowed: [...SubTaskDraftFields],
        })
      }
    }

    const task = requireText(candidate.task, `plan step ${index + 1} requires a non-empty "task"`)
    const acceptance = requireText(
      candidate.acceptance,
      `plan step ${index + 1} requires a non-empty "acceptance" before the subtask can be dispatched`,
    )

    const reason =
      candidate.reason === undefined
        ? undefined
        : requireText(candidate.reason, `plan step ${index + 1} "reason" must be a non-empty string when provided`)

    let model = parentModel
    let modelOverridden = false
    if (candidate.model !== undefined) {
      const requestedModel = requireText(
        candidate.model,
        `plan step ${index + 1} "model" must be a non-empty string when provided`,
      ).trim()
      if (requestedModel !== parentModel) {
        if (!this.host.config.orchestration.modelRouting) {
          throw new InvalidArgumentError(
            `plan step ${index + 1} requests model "${requestedModel}" but model routing is disabled by config.orchestration.modelRouting`,
            { index, requested: requestedModel, parentModel },
          )
        }
        model = requestedModel
        modelOverridden = true
      }
    }

    if (candidate.effort !== undefined) {
      const requestedEffort = requireText(
        candidate.effort,
        `plan step ${index + 1} "effort" must be a non-empty string when provided`,
      ).trim()
      if (requestedEffort !== turn.effort) {
        throw new InvalidArgumentError(
          `plan step ${index + 1} requests effort "${requestedEffort}" but a subtask strictly inherits the parent effort "${turn.effort}"`,
          { index, turn: turn.identity, requested: requestedEffort, inherited: turn.effort },
        )
      }
    }

    let tools: string[] = []
    if (candidate.tools !== undefined) {
      if (!Array.isArray(candidate.tools)) {
        throw new InvalidArgumentError(`plan step ${index + 1} "tools" must be an array of non-empty strings`, { index })
      }
      for (const tool of candidate.tools) {
        if (typeof tool !== 'string' || tool.trim().length === 0) {
          throw new InvalidArgumentError(`plan step ${index + 1} "tools" must be an array of non-empty strings`, {
            index,
          })
        }
      }
      tools = [...candidate.tools]
    }

    let context = ''
    if (candidate.context !== undefined) {
      if (typeof candidate.context !== 'string') {
        throw new InvalidArgumentError(`plan step ${index + 1} "context" must be a string`, { index })
      }
      context = candidate.context
    }

    let groundTruth: string | undefined
    if (candidate.groundTruth !== undefined) {
      groundTruth = requireText(
        candidate.groundTruth,
        `plan step ${index + 1} "groundTruth" must be a non-empty string when provided`,
      )
    }

    const profession = candidate.profession ?? 'execution'
    assertProfession(profession)

    let blockedBy: number[] = []
    if (candidate.blockedBy !== undefined) {
      if (!Array.isArray(candidate.blockedBy)) {
        throw new InvalidArgumentError(`plan step ${index + 1} "blockedBy" must be an array of subtask identities`, {
          index,
        })
      }
      for (const dependency of candidate.blockedBy) {
        if (typeof dependency !== 'number' || !Number.isInteger(dependency) || dependency <= 0) {
          throw new InvalidArgumentError(
            `plan step ${index + 1} "blockedBy" must be an array of positive subtask identities`,
            { index, blockedBy: dependency },
          )
        }
      }
      blockedBy = [...candidate.blockedBy]
      if (new Set(blockedBy).size !== blockedBy.length) {
        throw new InvalidArgumentError(`plan step ${index + 1} "blockedBy" contains duplicates`, { index })
      }
    }

    return {
      model,
      modelOverridden,
      effort: turn.effort,
      task,
      tools,
      context,
      acceptance,
      ...(groundTruth === undefined ? {} : { groundTruth }),
      profession,
      blockedBy,
      ...(reason === undefined ? {} : { reason }),
    }
  }

  /** Every dependency must already exist for the same parent turn. */
  private assertDependencies(blockedBy: number[], turn: number): void {
    for (const dependency of blockedBy) {
      const row = this.host.db.get<Row>('SELECT parent FROM subtask WHERE identity = ?', dependency)
      if (row === undefined) {
        throw new InvalidArgumentError(`blockedBy ${dependency} does not exist`, { turn, blockedBy: dependency })
      }
      if (number(row, 'parent') !== turn) {
        throw new InvalidArgumentError(`blockedBy ${dependency} belongs to another turn`, {
          turn,
          blockedBy: dependency,
        })
      }
    }
  }

  /** Insert one locked subtask, its single profession record and its lock trace. */
  private insertSubTask(planRecord: Plan, turn: Turn, draft: NormalisedDraft): SubTask {
    const now = this.host.clock.now()
    const identity = this.host.db.insert('subtask', {
      handle: this.host.handles.next('subtask'),
      parent: turn.identity,
      model: draft.model,
      effort: draft.effort,
      task: draft.task,
      tools: draft.tools,
      context: draft.context,
      acceptance: draft.acceptance,
      groundTruth: draft.groundTruth,
      profession: draft.profession,
      locked: 1,
      lockedAt: now,
      blockedBy: draft.blockedBy,
      status: 'pending',
      rejectCount: 0,
      created: now,
    })

    // `recordProfession` upserts by (turn, subtask), so a rebuilt subtask can
    // never end up with a second profession record.
    this.profession.recordProfession(turn.identity, draft.profession, 'host', 'pending', {
      subtask: identity,
      input: draft.task,
      ...(draft.reason === undefined ? {} : { reason: draft.reason }),
    })
    this.host.trace.append({
      turn: turn.identity,
      event: 'lock',
      subtask: identity,
      actor: 'host',
      profession: draft.profession,
      detail: {
        plan: planRecord.identity,
        model: draft.model,
        modelOverridden: draft.modelOverridden,
        effort: draft.effort,
        profession: draft.profession,
        acceptance: draft.acceptance,
        blockedBy: draft.blockedBy,
        ...(draft.reason === undefined ? {} : { reason: draft.reason }),
      },
    })
    return this.requireSubTask(identity)
  }

  /** Latest trace row of one event and (optionally) one subtask, if any. */
  private latestTrace(turn: number, event: TraceEvent, subtask?: number): OrchestrationTrace | undefined {
    const row =
      subtask === undefined
        ? this.host.db.get<Row>(
            'SELECT * FROM orchestration_trace WHERE turn = ? AND event = ? ORDER BY identity DESC LIMIT 1',
            turn,
            event,
          )
        : this.host.db.get<Row>(
            'SELECT * FROM orchestration_trace WHERE turn = ? AND event = ? AND subtask = ? ORDER BY identity DESC LIMIT 1',
            turn,
            event,
            subtask,
          )
    return row === undefined ? undefined : mapTrace(row)
  }

  /** The base directory of a relative `exists:` check: the turn session sandbox. */
  private sandboxOf(turn: number): string {
    const row = this.host.db.get<Row>(
      `SELECT s.sandbox AS sandbox FROM turn t
       JOIN session s ON s.identity = t.session
       WHERE t.identity = ?`,
      turn,
    )
    const sandbox = row === undefined ? '' : text(row, 'sandbox').trim()
    return sandbox.length > 0 ? sandbox : process.cwd()
  }

  /**
   * The deterministic verification layer (§8.4). It never guesses: anything it
   * cannot decide is `unverifiable`, which `verify` records as `rejected`.
   */
  private evaluateGroundTruth(subtask: SubTask, groundTruth: string | undefined, result: string): GroundTruthOutcome {
    if (groundTruth === undefined || groundTruth.trim().length === 0) {
      return {
        verdict: 'unverifiable',
        reason:
          'no deterministic ground truth was declared and no judge model port is available; the result cannot be verified (fail-closed)',
        suggestion: 'revise_criteria',
      }
    }
    if (!this.host.config.orchestration.groundTruth) {
      return {
        verdict: 'unverifiable',
        reason: 'deterministic ground truth is disabled by config.orchestration.groundTruth (fail-closed)',
        suggestion: 'revise_criteria',
      }
    }

    const declaration = groundTruth.trim()
    const separator = declaration.indexOf(':')
    if (separator <= 0) return unverifiableSyntax(declaration)
    const operator = declaration.slice(0, separator).trim().toLowerCase()
    const operand = declaration.slice(separator + 1)
    if (operand.length === 0) {
      return {
        verdict: 'unverifiable',
        reason: `ground truth "${operator}:" has an empty operand (fail-closed)`,
        suggestion: 'revise_criteria',
      }
    }

    switch (operator) {
      case 'exists': {
        const base = this.sandboxOf(subtask.parent)
        const target = isAbsolute(operand) ? operand : resolve(base, operand)
        let found = false
        try {
          found = existsSync(target)
        } catch {
          found = false
        }
        return found
          ? { verdict: 'pass', reason: `ground truth "${declaration}" passed` }
          : {
              verdict: 'fail',
              reason: `ground truth "${declaration}" failed: ${target} does not exist`,
              suggestion: 'retry',
            }
      }
      case 'contains':
        return result.includes(operand)
          ? { verdict: 'pass', reason: `ground truth "${declaration}" passed` }
          : {
              verdict: 'fail',
              reason: `ground truth "${declaration}" failed: the result does not contain the expected text`,
              suggestion: 'retry',
            }
      case 'not-contains':
        return !result.includes(operand)
          ? { verdict: 'pass', reason: `ground truth "${declaration}" passed` }
          : {
              verdict: 'fail',
              reason: `ground truth "${declaration}" failed: the result contains the forbidden text`,
              suggestion: 'retry',
            }
      case 'regex': {
        let expression: RegExp
        try {
          expression = new RegExp(operand)
        } catch (error) {
          return {
            verdict: 'unverifiable',
            reason: `ground truth "${declaration}" is not a valid regular expression: ${
              error instanceof Error ? error.message : String(error)
            } (fail-closed)`,
            suggestion: 'revise_criteria',
          }
        }
        return expression.test(result)
          ? { verdict: 'pass', reason: `ground truth "${declaration}" passed` }
          : {
              verdict: 'fail',
              reason: `ground truth "${declaration}" failed: the result does not match the pattern`,
              suggestion: 'retry',
            }
      }
      case 'equals':
        return result === operand
          ? { verdict: 'pass', reason: `ground truth "${declaration}" passed` }
          : {
              verdict: 'fail',
              reason: `ground truth "${declaration}" failed: the result is not exactly equal to the expected text`,
              suggestion: 'retry',
            }
      case 'exit':
        return {
          verdict: 'unverifiable',
          reason: this.host.config.orchestration.allowShellGroundTruth
            ? `ground truth "${declaration}" was not executed: this composition has no shell execution port (fail-closed)`
            : `ground truth "${declaration}" was not executed: shell ground truth is disabled by config.orchestration.allowShellGroundTruth (fail-closed)`,
          suggestion: 'revise_criteria',
        }
      default:
        return unverifiableSyntax(declaration)
    }
  }
}

/** Fail-closed answer for a ground truth keyword this module does not implement. */
function unverifiableSyntax(declaration: string): GroundTruthOutcome {
  return {
    verdict: 'unverifiable',
    reason: `unknown ground truth syntax "${declaration}"; supported forms are exists:, contains:, not-contains:, regex:, equals: (fail-closed)`,
    suggestion: 'revise_criteria',
  }
}

/** A required string argument; whitespace-only is empty. */
function requireText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(message)
  }
  return value
}

/** The Answer entity has no row mapper (it is normally written by the Answer module). */
function mapAnswer(row: Row): Answer {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    content: text(row, 'content'),
    validation: text(row, 'validation', 'medium') as Validation,
    created: number(row, 'created'),
  }
}
