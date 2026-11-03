/** Durable, session-bound delegation. DSH owns agent spawning; this adapter records duties and review. */
import { canonical } from 'attention-manifest-protocol/semantic/canonical.js'
import { isId, makeEvent } from '../protocol/index.js'
import { ProfessionValues, type Profession } from '../shared/enum.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError, PermissionError } from '../shared/error.js'
import type { ModuleHost } from './module.js'
import { AmpStore } from './ampStore.js'

export type DutyStatus = 'assigned' | 'accepted' | 'working' | 'submitted' | 'verified' | 'rejected' | 'cancelled'
export interface DutyInput {
  id: string
  assigneeSession: string
  role: Profession
  responsibilities: string[]
  acceptance: string[]
  goal?: string
  plan?: string
  task?: string
}
export interface Duty extends DutyInput {
  ownerSession: string
  status: DutyStatus
  summary?: string
  evidence?: string[]
  review?: string
  created: number
  updated: number
}
export interface DutyTransitionInput { summary?: string; evidence?: string[]; review?: string }
interface BodyRow { body: string }
interface StoredDuty extends BodyRow { owner: number; assignee: number }
const STATUSES: readonly DutyStatus[] = ['assigned', 'accepted', 'working', 'submitted', 'verified', 'rejected', 'cancelled']
const TERMINAL: readonly DutyStatus[] = ['verified', 'cancelled']
const MAX_TEXT = 4_096
const MAX_LIST = 32

export class AmpCollaboration {
  private readonly store: AmpStore
  constructor(private readonly host: ModuleHost) { this.store = new AmpStore(host.db) }

  /** Returns only duties owned by or assigned to the authenticated calling session. */
  view(actorSession: string): Duty[] {
    const actor = this.sessionId(actorSession)
    return this.host.db.all<BodyRow>('SELECT body FROM amp_duty WHERE owner = ? OR assignee = ? ORDER BY created, id', actor, actor)
      .map(row => JSON.parse(row.body) as Duty)
  }

  assign(ownerSession: string, input: DutyInput): Duty {
    this.validateAssignment(input)
    return this.host.db.transaction(() => {
      const owner = this.sessionId(ownerSession)
      const assignee = this.sessionId(input.assigneeSession)
      if (owner === assignee) throw new InvalidArgumentError('delegation requires a different assignee session')
      if (this.host.db.get<{ id: string }>('SELECT id FROM amp_duty WHERE id = ?', input.id)) {
        throw new InvalidArgumentError(`duty ${input.id} already exists`)
      }
      this.validateReferences(owner, input)
      const now = this.host.clock.now()
      const duty: Duty = { ...input, ownerSession, status: 'assigned', created: now, updated: now }
      this.host.db.insert('amp_duty', { id: duty.id, owner, assignee, body: canonical(duty), created: now, updated: now })
      this.event(ownerSession, duty, 'duty.assigned')
      return this.read(ownerSession, duty.id).duty
    })
  }

  transition(actorSession: string, id: string, targetStatus: DutyStatus, input: DutyTransitionInput = {}): Duty {
    if (!isId(id)) throw new InvalidArgumentError('duty id must be a valid AMP id')
    if (!STATUSES.includes(targetStatus)) throw new InvalidArgumentError('unknown duty status')
    this.validateTransitionInput(input)
    return this.host.db.transaction(() => {
      const current = this.read(actorSession, id)
      const { duty } = current
      if (TERMINAL.includes(duty.status)) throw new InvalidStateError(`duty ${id} is ${duty.status}`)
      const ownerAction = targetStatus === 'cancelled' || targetStatus === 'verified' || targetStatus === 'rejected'
      const actor = this.sessionId(actorSession)
      if (ownerAction ? actor !== current.owner : actor !== current.assignee) {
        throw new PermissionError(ownerAction ? 'only the duty owner may review or cancel' : 'only the bound assignee may accept, start or submit')
      }
      const allowed: Record<DutyStatus, readonly DutyStatus[]> = {
        assigned: ['accepted', 'cancelled'], accepted: ['working', 'cancelled'],
        working: ['submitted', 'cancelled'], submitted: ['verified', 'rejected', 'cancelled'],
        rejected: ['working', 'cancelled'], verified: [], cancelled: [],
      }
      if (!allowed[duty.status].includes(targetStatus)) throw new InvalidStateError(`duty ${id}: ${duty.status} -> ${targetStatus} is not an edge`)
      if (targetStatus === 'submitted' && (input.summary === undefined || input.evidence === undefined || input.evidence.length === 0)) {
        throw new InvalidArgumentError('submission requires a nonempty summary and evidence list')
      }
      if ((targetStatus === 'verified' || targetStatus === 'rejected') && input.review === undefined) {
        throw new InvalidArgumentError('review requires nonempty review text')
      }
      const permitted = targetStatus === 'submitted' ? ['summary', 'evidence']
        : targetStatus === 'verified' || targetStatus === 'rejected' ? ['review'] : []
      for (const key of Object.keys(input)) if (!permitted.includes(key)) throw new InvalidArgumentError(`${key} is not accepted for ${targetStatus}`)
      const next: Duty = { ...duty, status: targetStatus, updated: this.host.clock.now() }
      if (targetStatus === 'submitted') {
        next.summary = input.summary!
        next.evidence = [...input.evidence!]
        delete next.review
      } else if (targetStatus === 'verified' || targetStatus === 'rejected') {
        next.review = input.review!
      }
      this.host.db.update('amp_duty', { body: canonical(next), updated: next.updated }, 'id = ?', id)
      this.event(actorSession, next, 'duty.transitioned', duty.status)
      return this.read(actorSession, id).duty
    })
  }

  private read(session: string, id: string): { duty: Duty; owner: number; assignee: number } {
    const actor = this.sessionId(session)
    // Filtering before lookup prevents unrelated sessions learning whether an id exists.
    const row = this.host.db.get<StoredDuty>('SELECT body, owner, assignee FROM amp_duty WHERE id = ? AND (owner = ? OR assignee = ?)', id, actor, actor)
    if (row === undefined) throw new NotFoundError('duty', id)
    return { duty: JSON.parse(row.body) as Duty, owner: row.owner, assignee: row.assignee }
  }

  private validateReferences(owner: number, input: DutyInput): void {
    let planGoal: string | undefined
    if (input.plan !== undefined) {
      const plan = this.host.db.get<{ body: string; goal: string }>('SELECT body, goal FROM amp_planning_plan WHERE id = ? AND session = ?', input.plan, owner)
      if (plan === undefined) throw new NotFoundError('owner AMP plan', input.plan)
      planGoal = plan.goal
      const parsed = JSON.parse(plan.body) as { status: string; tasks: Array<{ id: string; status: string }> }
      if (parsed.status === 'done' || parsed.status === 'abandoned') throw new InvalidStateError('cannot assign work from a terminal plan')
      if (input.task !== undefined) {
        const task = parsed.tasks.find(task => task.id === input.task)
        if (task === undefined) throw new NotFoundError('owner plan task', input.task)
        if (task.status === 'done' || task.status === 'skipped') throw new InvalidStateError('cannot assign a terminal task')
      }
    }
    const goalId = input.goal ?? planGoal
    if (input.goal !== undefined && planGoal !== undefined && input.goal !== planGoal) throw new InvalidArgumentError('goal does not match the referenced plan')
    if (goalId !== undefined) {
      const goal = this.host.db.get<BodyRow>('SELECT body FROM amp_planning_goal WHERE id = ? AND session = ?', goalId, owner)
      if (goal === undefined) throw new NotFoundError('owner AMP goal', goalId)
      const lifecycle = JSON.parse(goal.body) as { state: string }
      if (lifecycle.state === 'achieved' || lifecycle.state === 'abandoned') throw new InvalidStateError('cannot assign work from a terminal goal')
    }
  }

  private validateAssignment(input: DutyInput): void {
    const record = asRecord(input, 'duty')
    const fields = ['id', 'assigneeSession', 'role', 'responsibilities', 'acceptance', 'goal', 'plan', 'task']
    for (const key of Object.keys(record)) if (!fields.includes(key)) throw new InvalidArgumentError(`unknown duty field ${key}`)
    if (!isId(input.id)) throw new InvalidArgumentError('duty id must be a valid AMP id')
    text(input.assigneeSession, 'assigneeSession')
    if (input.assigneeSession.length > 256) throw new InvalidArgumentError('assigneeSession must be at most 256 characters')
    if (!ProfessionValues.includes(input.role)) throw new InvalidArgumentError('role must be a coordination profession')
    textList(input.responsibilities, 'responsibilities')
    textList(input.acceptance, 'acceptance')
    for (const field of ['goal', 'plan', 'task'] as const) {
      if (input[field] !== undefined && !isId(input[field])) throw new InvalidArgumentError(`${field} must be a valid AMP id`)
    }
    if (input.task !== undefined && input.plan === undefined) throw new InvalidArgumentError('task reference requires its plan')
    if (canonical(input).length > 128_000) throw new InvalidArgumentError('duty exceeds 128000 characters')
  }

  private validateTransitionInput(input: DutyTransitionInput): void {
    const record = asRecord(input, 'transition input')
    for (const key of Object.keys(record)) if (!['summary', 'evidence', 'review'].includes(key)) throw new InvalidArgumentError(`unknown transition field ${key}`)
    if (input.summary !== undefined) text(input.summary, 'summary')
    if (input.evidence !== undefined) textList(input.evidence, 'evidence')
    if (input.review !== undefined) text(input.review, 'review')
  }

  private sessionId(session: string): number {
    text(session, 'session')
    const row = this.host.db.get<{ identity: number }>('SELECT identity FROM session WHERE handle = ?', session)
    if (row === undefined) throw new NotFoundError('session', session)
    return row.identity
  }

  private event(session: string, duty: Duty, type: string, previous?: DutyStatus): void {
    const at = new Date(this.host.clock.now()).toISOString()
    this.store.append('event', makeEvent({
      id: this.host.handles.next('amp-event'), actor: { kind: 'agent', id: 'deepseek-coordination' }, at, type,
      payload: { session, ownerSession: duty.ownerSession, assigneeSession: duty.assigneeSession, duty: duty.id, role: duty.role, status: duty.status, ...(previous === undefined ? {} : { previous }),
        ...(duty.summary === undefined ? {} : { summary: duty.summary }), ...(duty.evidence === undefined ? {} : { evidence: duty.evidence }), ...(duty.review === undefined ? {} : { review: duty.review }) },
    }), at)
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidArgumentError(`${field} must be an object`)
  return value as Record<string, unknown>
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT) throw new InvalidArgumentError(`${field} must be nonempty text of at most ${MAX_TEXT} characters`)
}
function textList(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) throw new InvalidArgumentError(`${field} requires 1-${MAX_LIST} entries`)
  for (const item of value) text(item, field)
}
