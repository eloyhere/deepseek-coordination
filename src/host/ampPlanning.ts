/** Durable host adapter for AMP's mission queue, goal lifecycle and plans. */
import { MissionQueue } from 'attention-manifest-protocol/mission'
import { createGoalLifecycle, transitionGoal as moveGoal, type GoalLifecycle, type GoalState } from 'attention-manifest-protocol/goal'
import { validatePlanInput, type Goal, type Plan, type PlanTask } from 'attention-manifest-protocol/goal/plan.js'
import { canonical } from 'attention-manifest-protocol/semantic/canonical.js'
import { validateGoal, validatePlan, makeEvent } from '../protocol/index.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError } from '../shared/error.js'
import type { ModuleHost } from './module.js'
import { AmpStore } from './ampStore.js'
import {
  HarnessPlanningSync,
  ampIdOfRemote,
  type HarnessGoalLink,
  type HarnessGoalPhase,
  type HarnessRemoteGoal,
  type HarnessSyncStatus,
} from './harnessSync.js'

/** Host scheduling projection. AMP 0.4.5 defines MissionQueue, not a mission artifact. */
export interface Mission {
  id: string
  session: string
  goal: string
  priority: number
  status: 'queued' | 'active' | 'done' | 'abandoned'
  created: number
  updated: number
}

/** What one projection import of the Harness goal observed. */
export interface HarnessImportSummary {
  /** The normalised Harness goal that was projected. */
  remote: HarnessRemoteGoal
  /** AMP goal id holding the projection. */
  goal: string
  /** True only when this call created the AMP goal (and its ledger entry). */
  created: boolean
}

interface MissionRow extends Omit<Mission, 'session'> { identity: number; session: number }
interface BodyRow { body: string }
const terminalGoal = (state: GoalState): boolean => state === 'achieved' || state === 'abandoned'
const terminalPlan = (state: Plan['status']): boolean => state === 'done' || state === 'abandoned'

/**
 * The legal intermediate AMP states from `state` to a Harness-mapped target.
 *
 * The projection cannot jump to `achieved` directly: the lifecycle is an
 * admission state machine, and walking it (committed, active, achieved) is what
 * keeps an imported goal indistinguishable from one admitted locally.
 */
function pathTo(state: GoalState, target: 'active' | 'achieved'): GoalState[] {
  if (target === 'active') {
    if (state === 'proposed') return ['committed', 'active']
    return state === 'committed' ? ['active'] : []
  }
  if (state === 'proposed') return ['committed', 'active', 'achieved']
  return state === 'committed' ? ['active', 'achieved'] : ['achieved']
}

/** One bounded note for a failed import, matching the link row's note budget. */
function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240)
}

export class AmpPlanning {
  private readonly store: AmpStore
  /** Bridges this queue/lifecycle onto `ctx.goals` and `ctx.planMode`. */
  readonly harness: HarnessPlanningSync
  /**
   * True while a projection import applies a phase the Harness already owns.
   *
   * Pushing that transition back would echo the fact the import is reading:
   * `active` would call `resume` on a goal the Harness already reports active,
   * and `complete` would complete an already completed one. The Harness is the
   * authority in this direction, so the import is read-and-store only.
   */
  private syncingFromHarness = false
  constructor(private readonly host: ModuleHost) {
    this.store = new AmpStore(host.db)
    this.harness = new HarnessPlanningSync(host)
  }

  /** Sync state of one session: the planning payload and the panel report it. */
  syncStatus(session: string): HarnessSyncStatus {
    // `view` and `goals` import first; this report only needs what is stored.
    return this.harness.status(session, this.readGoals(session).map(goal => goal.goal.id))
  }

  /** The recorded Harness link of one AMP goal, when a push happened. */
  harnessLink(session: string, goal: string): HarnessGoalLink | undefined {
    return this.harness.link(session, goal)
  }

  view(session: string): { missions: Mission[]; goals: GoalLifecycle[]; plans: Plan[] } {
    // The navigation payload is the surface that stayed empty while the Harness
    // held a goal, so the projection import runs before either list is read.
    this.syncFromHarness(session)
    return { missions: this.missions(session), goals: this.readGoals(session), plans: this.plans(session) }
  }

  /**
   * Goals of one session, after projecting the Harness's current goal.
   *
   * Importing first is what makes a goal created by the Harness itself
   * (`create_goal`, `/goal`) visible here. The import is idempotent and
   * fail-open, so a repeated read costs one link lookup and a broken Harness
   * port cannot fail the read.
   */
  goals(session: string): GoalLifecycle[] {
    this.syncFromHarness(session)
    return this.readGoals(session)
  }

  /**
   * Project the Harness's current goal into this plugin's planning records.
   *
   * This is a **projection import, not a second source of truth**: the Harness
   * owns the goal lifecycle (`active | paused | blocked | complete`), and AMP
   * keeps the artifact — statement, observable success criterion and the plan
   * links that may follow. A goal the Harness created on its own therefore
   * becomes visible in the goals/missions/plans navigation instead of being
   * invisible just because no AMP tool wrote it.
   *
   * Idempotency has two halves: the `harness_link` row found by `remote_id`
   * marks "this remote goal was already adopted", and the AMP id is derived
   * deterministically from the remote id ({@link ampIdOfRemote}). A second read
   * adds neither a goal row nor a ledger entry.
   *
   * Deletion is deliberately not mirrored: a Harness goal that disappears
   * leaves the imported AMP goal as history (AMP has no delete), and
   * `pullGoal` reports the divergence instead of this method guessing that the
   * record should vanish.
   *
   * Fail-open: a missing port, missing agent, unreadable goal or refused AMP
   * write records at most one `harness_link.note`; the listing request itself
   * keeps working with whatever is stored.
   */
  syncFromHarness(session: string): HarnessImportSummary | undefined {
    let remote: HarnessRemoteGoal | undefined
    let goal: string | undefined
    try {
      remote = this.harness.normalisedRemoteGoalOf(session)
      if (remote === undefined) return undefined
      // A projection needs a registered session to attach to. An unknown handle
      // is the caller's read problem (it reports not-found), not a sync failure.
      if (this.host.db.get<{ identity: number }>('SELECT identity FROM session WHERE handle = ?', session) === undefined) {
        return undefined
      }
      const linked = this.harness.linkOfRemote(session, remote.id)
      goal = linked?.goal ?? remote.ampId
      let created = false
      if (this.storedGoal(session, goal) === undefined) {
        // The derived id may already belong to an authored goal, or to another
        // session's import. Disambiguate with the same deterministic translation
        // (seeded with the session) instead of failing the import. A previous
        // failed attempt may have left a link row for the taken id, so the
        // fallback is re-checked before it is written.
        if (this.host.db.get<{ id: string }>('SELECT id FROM amp_planning_goal WHERE id = ?', goal) !== undefined) {
          goal = ampIdOfRemote(`${remote.id}#${session}`)
        }
        if (this.storedGoal(session, goal) === undefined) {
          this.putGoal(session, this.importedGoal(remote, goal))
          created = true
        }
      }
      this.recordImport(session, goal, remote, this.phaseNote(remote.phase))
      this.alignImportedGoal(session, goal, remote.phase)
      return { remote, goal, created }
    } catch (error) {
      this.noteImportFailure(session, remote, goal, error)
      return undefined
    }
  }

  plans(session: string): Plan[] {
    return this.host.db.all<BodyRow>('SELECT body FROM amp_planning_plan WHERE session = ? ORDER BY created, id', this.sessionId(session))
      .map(row => JSON.parse(row.body) as Plan)
  }

  missions(session: string): Mission[] {
    return this.host.db.all<MissionRow>('SELECT * FROM amp_mission WHERE session = ? ORDER BY priority DESC, created, identity', this.sessionId(session))
      .map(({ identity: _identity, session: _session, ...row }) => ({ ...row, session }))
  }

  putGoal(session: string, goal: Goal): GoalLifecycle {
    this.validate('goal', goal)
    return this.host.db.transaction(() => {
      const sessionId = this.sessionId(session)
      this.unique('amp_planning_goal', goal.id)
      const lifecycle = createGoalLifecycle(goal)
      const now = this.host.clock.now()
      this.host.db.insert('amp_planning_goal', { id: goal.id, session: sessionId, body: canonical(lifecycle), created: now, updated: now })
      this.store.append('goal', goal, this.at())
      this.event(session, 'goal.proposed', { goal: goal.id, state: lifecycle.state })
      return this.goal(session, goal.id)
    })
  }

  transitionGoal(session: string, id: string, state: GoalState): GoalLifecycle {
    return this.host.db.transaction(() => {
      const current = this.goal(session, id)
      if (state === 'active') {
        const mission = this.missions(session).find(item => item.goal === id)
        if (mission !== undefined && this.missions(session).some(item => item.status === 'active' && item.id !== mission.id)) {
          throw new InvalidStateError('this session already has an active mission')
        }
      }
      if (state === 'achieved') {
        const plans = this.plans(session).filter(plan => plan.goal.id === id && plan.status !== 'abandoned')
        if (plans.some(plan => plan.status !== 'done' || plan.tasks.some(task => task.status !== 'done'))) {
          throw new InvalidStateError('finish every plan and task before achieving the goal')
        }
      }
      let next: GoalLifecycle
      try { next = moveGoal(current, state, this.at()) }
      catch (error) { throw new InvalidStateError(error instanceof Error ? error.message : String(error)) }
      this.host.db.update('amp_planning_goal', { body: canonical(next), updated: this.host.clock.now() }, 'id = ?', id)
      if (state === 'abandoned') {
        for (const plan of this.plans(session).filter(plan => plan.goal.id === id && !terminalPlan(plan.status))) {
          this.savePlan(session, { ...plan, status: 'abandoned' })
        }
      }
      if (state === 'active') {
        this.host.db.update('amp_mission', { status: 'active', updated: this.host.clock.now() }, 'goal = ?', id)
      }
      if (terminalGoal(state)) {
        this.host.db.update('amp_mission', { status: state === 'achieved' ? 'done' : 'abandoned', updated: this.host.clock.now() }, 'goal = ?', id)
      }
      this.event(session, 'goal.transitioned', { goal: id, from: current.state, state })
      // The Harness owns the live lifecycle of one agent goal: push after the
      // durable AMP transition so a refused Harness call cannot roll it back.
      // A projection import is the opposite direction, so it must not echo the
      // phase it has just read back into the Harness (resume/complete churn).
      if (this.syncingFromHarness) return next
      const link = this.harness.pushGoal(session, next)
      if (link?.note !== undefined) {
        this.event(session, 'harness.goal.sync', { goal: id, synced: link.note === undefined, note: link.note })
      }
      return next
    })
  }

  putPlan(session: string, plan: Plan): Plan {
    this.validate('plan', plan)
    if (plan.status !== 'draft' || plan.tasks.some(task => task.status !== 'pending')) {
      throw new InvalidArgumentError('new plans must be draft with pending tasks')
    }
    return this.host.db.transaction(() => {
      const lifecycle = this.goal(session, plan.goal.id)
      if (terminalGoal(lifecycle.state)) throw new InvalidStateError('cannot plan for a terminal goal')
      this.unique('amp_planning_plan', plan.id)
      const now = this.host.clock.now()
      this.host.db.insert('amp_planning_plan', { id: plan.id, session: this.sessionId(session), goal: plan.goal.id, body: canonical(plan), created: now, updated: now })
      this.store.append('plan', plan, this.at())
      this.event(session, 'plan.created', { plan: plan.id, goal: plan.goal.id })
      return this.plan(session, plan.id)
    })
  }

  transitionPlan(session: string, id: string, status: Plan['status']): Plan {
    return this.host.db.transaction(() => {
      const current = this.plan(session, id)
      const edges: Record<Plan['status'], Plan['status'][]> = {
        draft: ['committed', 'abandoned'], committed: ['executing', 'abandoned'],
        executing: ['done', 'abandoned'], done: [], abandoned: [],
      }
      if (!edges[current.status].includes(status)) throw new InvalidStateError(`plan ${id}: ${current.status} -> ${status} is not an edge`)
      const goal = this.goal(session, current.goal.id)
      if (status !== 'abandoned' && terminalGoal(goal.state)) throw new InvalidStateError('goal is terminal')
      if (status === 'executing' && goal.state !== 'active') throw new InvalidStateError('activate the goal before executing its plan')
      if (status === 'done' && current.tasks.some(task => task.status !== 'done')) throw new InvalidStateError('every task must be done before the plan is done')
      return this.savePlan(session, { ...current, status })
    })
  }

  updateTask(session: string, id: string, taskId: string, status: PlanTask['status']): Plan {
    return this.host.db.transaction(() => {
      const plan = this.plan(session, id)
      if (plan.status !== 'executing') throw new InvalidStateError('tasks may change only on an executing plan')
      const task = plan.tasks.find(item => item.id === taskId)
      if (task === undefined) throw new NotFoundError('plan task', taskId)
      const edges: Record<PlanTask['status'], PlanTask['status'][]> = {
        pending: ['running', 'skipped'], running: ['done', 'failed'], failed: ['running', 'skipped'], done: [], skipped: [],
      }
      if (!edges[task.status].includes(status)) throw new InvalidStateError(`task ${taskId}: ${task.status} -> ${status} is not an edge`)
      if (status === 'running') {
        const prerequisites = plan.edges.filter(([, to]) => to === taskId).map(([from]) => from)
        if (prerequisites.some(id => plan.tasks.find(item => item.id === id)?.status !== 'done')) {
          throw new InvalidStateError('task dependencies are not done')
        }
      }
      return this.savePlan(session, { ...plan, tasks: plan.tasks.map(item => item.id === taskId ? { ...item, status } : item) })
    })
  }

  createMission(session: string, goal: Goal): Mission {
    return this.host.db.transaction(() => {
      const lifecycle = this.putGoal(session, goal)
      this.transitionGoal(session, lifecycle.goal.id, 'committed')
      const now = this.host.clock.now()
      const id = this.host.handles.next('mission')
      this.host.db.insert('amp_mission', { id, session: this.sessionId(session), goal: goal.id, priority: goal.priority, status: 'queued', created: now, updated: now })
      this.event(session, 'mission.queued', { mission: id, goal: goal.id, priority: goal.priority })
      return this.mission(session, id)
    })
  }

  activateNext(session: string): Mission | undefined {
    return this.host.db.transaction(() => {
      const sessionId = this.sessionId(session)
      if (this.missions(session).some(item => item.status === 'active')) throw new InvalidStateError('this session already has an active mission')
      const rows = this.host.db.all<MissionRow>("SELECT * FROM amp_mission WHERE session = ? AND status = 'queued' ORDER BY created, identity", sessionId)
      // Rebuild from durable runnable rows, as required by AMP's scheduler-cache contract.
      let enqueuedAt = 0
      const queue = new MissionQueue(() => enqueuedAt++)
      for (const row of rows) if (this.goal(session, row.goal).state === 'committed') queue.enqueue(row.identity, row.priority)
      const pid = queue.dequeue()
      const next = rows.find(row => row.identity === pid)
      if (next === undefined) return undefined
      this.transitionGoal(session, next.goal, 'active')
      this.host.db.update('amp_mission', { status: 'active', updated: this.host.clock.now() }, 'identity = ?', next.identity)
      this.event(session, 'mission.activated', { mission: next.id, goal: next.goal })
      return this.mission(session, next.id)
    })
  }

  settleMission(session: string, id: string, outcome: 'done' | 'abandoned'): Mission {
    return this.host.db.transaction(() => {
      const mission = this.mission(session, id)
      if (mission.status === 'done' || mission.status === 'abandoned') throw new InvalidStateError('mission is terminal')
      if (outcome === 'done' && mission.status !== 'active') throw new InvalidStateError('activate the mission before completing it')
      this.transitionGoal(session, mission.goal, outcome === 'done' ? 'achieved' : 'abandoned')
      this.event(session, 'mission.settled', { mission: id, goal: mission.goal, outcome })
      return this.mission(session, id)
    })
  }

  /** Refresh a turn projection atomically with its caller's ledger append; never infer achievement. */
  adoptProjection(session: string, goal: Goal, plan: Plan): void {
    this.validate('goal', goal)
    this.validate('plan', plan)
    if (plan.goal.id !== goal.id) throw new InvalidArgumentError('projected plan must reference the projected goal')
    if (plan.status === 'done' && plan.tasks.some(task => task.status !== 'done')) throw new InvalidStateError('every projected task must be done before the plan is done')
    this.host.db.transaction(() => {
      const sessionId = this.sessionId(session)
      const now = this.host.clock.now()
      const current = this.host.db.get<{ session: number } & BodyRow>('SELECT session, body FROM amp_planning_goal WHERE id = ?', goal.id)
      if (current !== undefined && current.session !== sessionId) throw new InvalidArgumentError('projected goal belongs to another session')
      const existing = this.host.db.get<{ session: number; goal: string } & BodyRow>('SELECT session, goal, body FROM amp_planning_plan WHERE id = ?', plan.id)
      if (existing !== undefined && existing.session !== sessionId) throw new InvalidArgumentError('projected plan belongs to another session')
      if (existing !== undefined && existing.goal !== goal.id) throw new InvalidArgumentError('projected plan cannot change its goal')
      const previous = existing === undefined ? undefined : JSON.parse(existing.body) as Plan
      if (previous !== undefined) {
        const advances: Record<Plan['status'], Plan['status'][]> = {
          draft: ['draft', 'committed', 'executing', 'done', 'abandoned'],
          committed: ['committed', 'executing', 'done', 'abandoned'],
          executing: ['executing', 'done', 'abandoned'], done: ['done'], abandoned: ['abandoned'],
        }
        if (!advances[previous.status].includes(plan.status)) throw new InvalidStateError('projected plan cannot regress or revive a terminal plan')
        if (terminalPlan(previous.status) && canonical(previous) !== canonical(plan)) throw new InvalidStateError('projected terminal plan is immutable')
      }
      let lifecycle = current === undefined ? createGoalLifecycle(goal) : JSON.parse(current.body) as GoalLifecycle
      if (terminalGoal(lifecycle.state)) {
        if (existing === undefined || !terminalPlan(plan.status) || canonical(lifecycle.goal) !== canonical(goal) || canonical(previous) !== canonical(plan)) {
          throw new InvalidStateError('cannot change a projection for a terminal goal')
        }
        return
      }
      lifecycle = { ...lifecycle, goal }
      if (current === undefined) {
        this.host.db.insert('amp_planning_goal', { id: goal.id, session: sessionId, body: canonical(lifecycle), created: now, updated: now })
      } else {
        this.host.db.update('amp_planning_goal', { body: canonical(lifecycle), updated: now }, 'id = ?', goal.id)
        this.host.db.update('amp_mission', { priority: goal.priority, updated: now }, 'goal = ?', goal.id)
      }
      // Use the public transitions so mission admission and lifecycle events stay consistent.
      if (plan.status !== 'draft' && plan.status !== 'abandoned' && lifecycle.state === 'proposed') lifecycle = this.transitionGoal(session, goal.id, 'committed')
      if ((plan.status === 'executing' || plan.status === 'done') && lifecycle.state === 'committed') this.transitionGoal(session, goal.id, 'active')
      if (existing === undefined) {
        this.host.db.insert('amp_planning_plan', { id: plan.id, session: sessionId, goal: goal.id, body: canonical(plan), created: now, updated: now })
      } else {
        this.host.db.update('amp_planning_plan', { body: canonical(plan), updated: now }, 'id = ?', plan.id)
      }
    })
  }

  private goal(session: string, id: string): GoalLifecycle {
    const row = this.host.db.get<BodyRow>('SELECT body FROM amp_planning_goal WHERE session = ? AND id = ?', this.sessionId(session), id)
    if (row === undefined) throw new NotFoundError('AMP goal', id)
    return JSON.parse(row.body) as GoalLifecycle
  }
  /** Goals as stored, without importing first (avoids recursing through `goals`). */
  private readGoals(session: string): GoalLifecycle[] {
    return this.host.db.all<BodyRow>('SELECT body FROM amp_planning_goal WHERE session = ? ORDER BY created, id', this.sessionId(session))
      .map(row => JSON.parse(row.body) as GoalLifecycle)
  }
  /** One stored goal, or `undefined` when this session has no row with that id. */
  private storedGoal(session: string, id: string): GoalLifecycle | undefined {
    const row = this.host.db.get<BodyRow>('SELECT body FROM amp_planning_goal WHERE session = ? AND id = ?', this.sessionId(session), id)
    return row === undefined ? undefined : JSON.parse(row.body) as GoalLifecycle
  }
  /** The AMP goal the projection creates for one Harness goal. */
  private importedGoal(remote: HarnessRemoteGoal, id: string): Goal {
    return {
      amp: '0.1',
      kind: 'goal',
      id,
      statement: remote.objective,
      success: [{
        id: 'host-completion',
        statement: 'the host reports this goal complete',
        check: 'coordination_goal list shows the imported goal in state achieved',
        kind: 'assert',
      }],
      value: 0.5,
      priority: 0,
    }
  }
  /** The link note for a phase AMP has no state of its own for. */
  private phaseNote(phase: HarnessGoalPhase): string | undefined {
    if (phase === 'paused') return 'the Harness reports this goal paused; the AMP state is not advanced'
    if (phase === 'blocked') return 'the Harness reports this goal blocked; the AMP state is not advanced'
    return undefined
  }
  /**
   * Upsert the projection link.
   *
   * The link is sync bookkeeping, not an AMP artifact: it never touches the
   * ledger, which is why a repeated read cannot grow the chain. A success clears
   * an earlier note, so a stale failure or paused note does not outlive the
   * condition that caused it.
   */
  private recordImport(session: string, goal: string, remote: HarnessRemoteGoal, note: string | undefined): void {
    this.host.db.run(
      `INSERT INTO harness_link (session, goal, remote_id, revision, phase, note, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session, goal) DO UPDATE SET
         remote_id = excluded.remote_id, revision = excluded.revision, phase = excluded.phase,
         note = excluded.note,
         synced = CASE WHEN excluded.note IS NULL THEN excluded.synced ELSE harness_link.synced END`,
      session,
      goal,
      remote.id,
      remote.revision,
      remote.phase,
      note ?? null,
      note === undefined ? this.host.clock.now() : null,
    )
  }
  /** Record one failed import, and never let the recording itself escape. */
  private noteImportFailure(session: string, remote: HarnessRemoteGoal | undefined, goal: string | undefined, error: unknown): void {
    if (remote === undefined) return
    try {
      this.recordImport(session, goal ?? remote.ampId, remote, `projection import failed: ${messageOf(error)}`)
    } catch {
      // A failing note write must not fail the read that triggered the sync.
    }
  }
  /**
   * Apply the Harness phase to the imported goal.
   *
   * Only the two phases that have an AMP state are applied: `active` admits the
   * goal (committed, then active) and `complete` walks it to `achieved`.
   * `paused` and `blocked` are Harness-only phases, so they never advance a
   * projection past `committed`; they are recorded on the link instead of being
   * guessed at. A terminal AMP goal is left alone: history is not rewritten.
   */
  private alignImportedGoal(session: string, goal: string, phase: HarnessGoalPhase): void {
    const current = this.storedGoal(session, goal)?.state
    if (current === undefined || terminalGoal(current)) return
    if (phase === 'paused' || phase === 'blocked') {
      if (current === 'proposed') this.importTransition(session, goal, 'committed')
      return
    }
    const target: GoalState = phase === 'complete' ? 'achieved' : 'active'
    for (const step of pathTo(current, target)) this.importTransition(session, goal, step)
  }
  /** One transition applied on behalf of the import, with the echo-back disabled. */
  private importTransition(session: string, goal: string, state: GoalState): void {
    this.syncingFromHarness = true
    try {
      this.transitionGoal(session, goal, state)
    } finally {
      this.syncingFromHarness = false
    }
  }
  private plan(session: string, id: string): Plan {
    const row = this.host.db.get<BodyRow>('SELECT body FROM amp_planning_plan WHERE session = ? AND id = ?', this.sessionId(session), id)
    if (row === undefined) throw new NotFoundError('AMP plan', id)
    return JSON.parse(row.body) as Plan
  }
  private mission(session: string, id: string): Mission {
    const mission = this.missions(session).find(item => item.id === id)
    if (mission === undefined) throw new NotFoundError('AMP mission', id)
    return mission
  }
  private savePlan(session: string, plan: Plan): Plan {
    this.host.db.update('amp_planning_plan', { body: canonical(plan), updated: this.host.clock.now() }, 'id = ?', plan.id)
    this.store.append('plan', plan, this.at())
    this.event(session, 'plan.updated', { plan: plan.id, goal: plan.goal.id, status: plan.status })
    // Plan mode is a Harness-owned boolean, so it follows "is any plan
    // executing": switching it on from `executing` and off from every other
    // status keeps the two sides describing the same fact.
    const executing = this.plans(session).some(item => item.status === 'executing')
    const outcome = this.harness.pushPlanMode(session, executing)
    if (outcome !== undefined) {
      this.event(session, 'harness.plan.sync', { plan: plan.id, active: executing, outcome })
    }
    return this.plan(session, plan.id)
  }
  private sessionId(session: string): number {
    const row = this.host.db.get<{ identity: number }>('SELECT identity FROM session WHERE handle = ?', session)
    if (row === undefined) throw new NotFoundError('session', session)
    return row.identity
  }
  private unique(table: string, id: string): void {
    if (this.host.db.get<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, id)) throw new InvalidArgumentError(`AMP id ${id} already exists`)
  }
  private at(): string { return new Date(this.host.clock.now()).toISOString() }
  private event(session: string, type: string, payload: Record<string, unknown>): void {
    const at = this.at()
    this.store.append('event', makeEvent({ id: this.host.handles.next('amp-event'), actor: { kind: 'agent', id: 'deepseek-coordination' }, type, at, payload: { ...payload, session } }), at)
  }
  private validate(kind: 'goal' | 'plan', value: Goal | Plan): void {
    let problems: string[]
    try {
      // Canonicalization refuses NaN/Infinity and other non-JSON data before persistence.
      if (canonical(value).length > 128_000) throw new Error('planning object exceeds 128000 characters')
      if (kind === 'goal') {
        const goal = value as Goal
        problems = validateGoal(goal)
        if (!Number.isSafeInteger(goal.priority) || goal.priority < 0) problems.push('priority must be a non-negative safe integer')
        if (!Number.isFinite(goal.value)) problems.push('value must be finite')
      } else {
        const plan = value as Plan
        // The adapter validator checks structure only; upstream has a wider RefKind union.
        problems = validatePlan(plan as unknown as Parameters<typeof validatePlan>[0])
        problems.push(...validatePlanInput({ tasks: plan.tasks, edges: plan.edges, abandonIf: plan.abandon_if }))
        if (plan.goal.kind !== 'goal') problems.push('goal reference must have kind goal')
        if (plan.tasks.length > 12) problems.push('at most 12 tasks are allowed')
        if (plan.commitment_window > 5) problems.push('commitment_window must be at most 5')
        const ids = new Set(plan.tasks.map(task => task.id))
        if (plan.edges.some(([from, to]) => !ids.has(from) || !ids.has(to))) problems.push('edges must reference tasks in this plan')
      }
    } catch (error) { throw new InvalidArgumentError(`invalid AMP ${kind}: ${error instanceof Error ? error.message : String(error)}`) }
    if (problems.length) throw new InvalidArgumentError(`invalid AMP ${kind}: ${problems.join('; ')}`)
  }
}
