/**
 * Synchronisation between this plugin's navigation (missions / goals / plans)
 * and the Harness's own lifecycle services.
 *
 * The two sides own different things, and this module keeps that split instead
 * of duplicating either model:
 *
 *  - **Harness `ctx.goals`** owns the goal *lifecycle* of one live agent:
 *    `active | paused | blocked | complete`, with a CAS revision. It is the
 *    authority for whether the agent is actually working toward a goal.
 *  - **Harness `ctx.planMode`** owns the boolean "plan mode" state. The Harness
 *    has no plan document, so a plan's `executing` status is the only honest
 *    mapping.
 *  - **This plugin** owns the AMP artifacts: the mission queue, the AMP goal
 *    with its observable success criteria, and the plan with tasks and edges.
 *
 * Consequences that are visible in the code:
 *
 *  - A mission is *not* mirrored while queued: the Harness allows one current
 *    goal per agent, so a queued mission has nowhere to go. Activation creates
 *    (or resumes) the Harness goal, and settlement completes or clears it.
 *  - Every push is best effort: a missing service, a stale revision or a
 *    refused transition is recorded on the link row and reported as a status,
 *    never thrown into the planning transaction. AMP stays consistent even when
 *    the Harness refuses.
 *  - A pull compares the recorded link with the live Harness view. A remote
 *    change the local side has not seen is reported as `diverged` in the
 *    planning payload, so the panel can show the truth instead of guessing.
 *  - A goal the Harness created itself (`create_goal`, `/goal`) is *imported*
 *    rather than ignored: `normalisedRemoteGoalOf`/`linkOfRemote` give the
 *    planning module what it needs to project that goal into an AMP goal. The
 *    import is one-way — the Harness stays the authority for the phase, and the
 *    projection never pushes the phase it just read back.
 */
import { createHash } from 'node:crypto'
import type { GoalLifecycle, GoalState } from 'attention-manifest-protocol/goal'
import type { AgentView, ModuleHost } from './module.js'
import type { Goal } from 'attention-manifest-protocol/goal/plan.js'

/** The Harness phases this module can observe. */
export type HarnessGoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** One Harness goal exactly as `ctx.goals.get` reports it. */
export interface HarnessRemoteGoalSnapshot {
  /** Harness goal id, verbatim. */
  id: string
  /** Harness CAS revision. */
  revision: number
  /** The objective as the Harness recorded it; it may be empty. */
  objective: string
  /** Live lifecycle phase; the Harness is the authority for it. */
  phase: HarnessGoalPhase
}

/**
 * A Harness goal normalised for the projection import into AMP.
 *
 * This is still the Harness's goal, not a second fact: the AMP side only gets a
 * deterministic local id, the statement it can display, and the phase it aligns
 * against.
 */
export interface HarnessRemoteGoal extends HarnessRemoteGoalSnapshot {
  /** Deterministic AMP id derived from {@link HarnessRemoteGoalSnapshot.id}. */
  ampId: string
}

/** One recorded link between an AMP goal and a Harness goal. */
export interface HarnessGoalLink {
  /** AMP goal id. */
  goal: string
  /** Harness goal id, once one was created. */
  remoteId?: string
  /** Harness revision the local side last observed or produced. */
  revision?: number
  /** Harness phase last observed. */
  phase?: HarnessGoalPhase
  /** Last successful sync. */
  syncedAt?: number
  /** Why the last attempt failed, when it did. */
  note?: string
}

/** Sync state of one session, as the planning payload reports it. */
export interface HarnessSyncStatus {
  /** `unavailable` when the profile exposes no goal service. */
  goals: 'synced' | 'diverged' | 'unavailable'
  /** `unavailable` when the profile exposes no plan-mode service. */
  planMode: 'on' | 'off' | 'unavailable'
  /** Highest-priority explanatory note, when there is one. */
  note?: string
}

interface LinkRow {
  session: string
  goal: string
  remote_id: string | null
  revision: number | null
  phase: string | null
  note: string | null
  synced: number | null
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asPhase = (value: unknown): HarnessGoalPhase | undefined =>
  value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete'
    ? value
    : undefined

/** Project one `harness_link` row without inventing absent fields. */
function linkOfRow(row: LinkRow): HarnessGoalLink {
  return {
    goal: row.goal,
    ...(row.remote_id === null ? {} : { remoteId: row.remote_id }),
    ...(row.revision === null ? {} : { revision: row.revision }),
    ...(asPhase(row.phase) === undefined ? {} : { phase: asPhase(row.phase) }),
    ...(row.synced === null ? {} : { syncedAt: row.synced }),
    ...(row.note === null ? {} : { note: row.note }),
  }
}

/** The Harness lifecycle phase an AMP goal state maps to, or `undefined`. */
function phaseForState(state: GoalState): HarnessGoalPhase | undefined {
  if (state === 'active') return 'active'
  if (state === 'achieved') return 'complete'
  return undefined
}

/** `docs/schemas/common.schema.json#/$defs/id`. */
const AmpIdPattern = /^[a-z][a-z0-9._:-]{0,63}$/

/**
 * Deterministic AMP id for one Harness goal id.
 *
 * A Harness id is not an AMP id: uppercase letters, spaces, slashes and more
 * than 64 characters are all legal there. The projection therefore needs a
 * stable translation rather than a random local id — the same remote goal must
 * always yield the same local id, because that is half of the import's
 * idempotency (the `harness_link` lookup is the other half).
 *
 * Illegal runs become `-` (after lowercasing, which keeps readable ids readable
 * instead of turning `Goal 42` into `--42`), and an id longer than 64 characters
 * is truncated and suffixed with a short digest of the original, so two long
 * ids that share a prefix cannot collapse into one local goal.
 */
export function ampIdOfRemote(remoteId: string): string {
  const body = remoteId
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._:]+|[-._:]+$/g, '')
  const head = body.length === 0 ? 'goal' : AmpIdPattern.test(body) ? body : `goal-${body}`
  if (head.length <= 64) return head
  const digest = createHash('sha256').update(remoteId, 'utf8').digest('hex').slice(0, 8)
  // 55 + '-' + 8 keeps the result exactly at the 64-character ceiling.
  return `${head.slice(0, 55)}-${digest}`
}

/**
 * Normalise one raw Harness goal for the AMP projection (pure; never writes).
 *
 * An AMP goal requires a non-empty statement, so a Harness goal with no
 * recorded objective gets the honest placeholder `host goal <remoteId>` rather
 * than a silently failing import.
 */
export function normaliseRemoteGoal(snapshot: HarnessRemoteGoalSnapshot): HarnessRemoteGoal {
  const objective = snapshot.objective.trim().length === 0 ? `host goal ${snapshot.id}` : snapshot.objective
  return { ...snapshot, objective, ampId: ampIdOfRemote(snapshot.id) }
}

/**
 * Goal/plan synchronization over the optional Harness ports.
 *
 * All methods are synchronous: the ports are synchronous, and a planning
 * transition must not become async to stay in one SQLite transaction.
 */
export class HarnessPlanningSync {
  constructor(
    private readonly host: Pick<ModuleHost, 'db' | 'clock' | 'goals' | 'planMode' | 'agents'>,
  ) {}

  /** Is a Harness goal service available in this profile? */
  get hasGoals(): boolean {
    return this.host.goals !== undefined
  }

  /** Is the Harness plan-mode switch available? */
  get hasPlanMode(): boolean {
    return this.host.planMode !== undefined
  }

  /** The recorded link of one AMP goal, if any. */
  link(session: string, goal: string): HarnessGoalLink | undefined {
    const row = this.host.db.get<LinkRow>(
      'SELECT * FROM harness_link WHERE session = ? AND goal = ?',
      session,
      goal,
    )
    return row === undefined ? undefined : linkOfRow(row)
  }

  /**
   * The link recorded for a Harness goal id, if any.
   *
   * The projection import asks this first: a row means the remote goal was
   * already adopted, so a repeated read adds neither an AMP goal nor a ledger
   * entry. `harness_link` has one row per `(session, goal)`, and a remote goal
   * owns at most one of them per session.
   */
  linkOfRemote(session: string, remoteId: string): HarnessGoalLink | undefined {
    const row = this.host.db.get<LinkRow>(
      'SELECT * FROM harness_link WHERE session = ? AND remote_id = ? ORDER BY goal LIMIT 1',
      session,
      remoteId,
    )
    return row === undefined ? undefined : linkOfRow(row)
  }

  /**
   * Push one AMP goal transition to the Harness.
   *
   * `active` creates or resumes the Harness goal, `achieved` completes it and
   * `abandoned` clears it. Every other state is local-only, because the Harness
   * tracks one *current* goal rather than a proposed/committed queue.
   */
  pushGoal(session: string, goal: GoalLifecycle): HarnessGoalLink | undefined {
    const goals = this.host.goals
    if (goals === undefined) return this.record(session, goal.goal.id, {}, 'the profile exposes no Harness goal service')
    const agent = this.agentOf(session)
    if (agent === undefined) {
      return this.record(session, goal.goal.id, {}, 'the session has no live Harness agent to carry a goal')
    }
    const current = this.link(session, goal.goal.id)
    try {
      if (goal.state === 'active') {
        const live = this.remoteGoal(agent)
        if (live === undefined || live.phase === 'complete') {
          // No goal, or one the Harness already completed: `create` is the only
          // legal way forward, because a completed goal cannot be resumed.
          return this.record(session, goal.goal.id, this.create(agent, goal.goal.statement))
        }
        if (live.objective === goal.goal.statement) {
          // The live goal is this AMP goal: rearms it when paused or blocked, and
          // is a harmless rearm when it is already active.
          if (goals.resume !== undefined) {
            return this.record(session, goal.goal.id, this.reference(
              goals.resume(agent, { id: live.id, revision: live.revision }),
            ))
          }
          return this.record(session, goal.goal.id, { remoteId: live.id, revision: live.revision, phase: live.phase })
        }
        // A different objective currently holds the single live goal slot. A
        // replacement attempt is the honest action; when the Harness refuses, the
        // note records it and the committed AMP transition stays committed.
        return this.record(session, goal.goal.id, this.create(agent, goal.goal.statement))
      }
      if (goal.state === 'achieved') {
        if (current?.remoteId === undefined || goals.complete === undefined) {
          return this.record(session, goal.goal.id, {}, 'no Harness goal was created for this AMP goal')
        }
        return this.record(session, goal.goal.id, this.reference(
          goals.complete(agent, { id: current.remoteId, revision: current.revision ?? 0 }),
        ))
      }
      if (goal.state === 'abandoned') {
        if (current?.remoteId === undefined || goals.clear === undefined) {
          return this.record(session, goal.goal.id, {}, 'no Harness goal was created for this AMP goal')
        }
        goals.clear(agent, { id: current.remoteId, revision: current.revision ?? 0 })
        return this.record(session, goal.goal.id, { remoteId: current.remoteId, phase: 'complete' })
      }
      return this.record(session, goal.goal.id, current ?? {})
    } catch (error) {
      return this.record(session, goal.goal.id, current ?? {}, messageOf(error))
    }
  }

  /**
   * Read the Harness goal and record what it says.
   *
   * Returns `diverged` when the live phase contradicts what this module last
   * pushed: the caller reports it instead of silently rewriting AMP state.
   */
  pullGoal(session: string, goalId: string): { phase?: HarnessGoalPhase; diverged: boolean; note?: string } {
    const goals = this.host.goals
    if (goals === undefined) return { diverged: false, note: 'the profile exposes no Harness goal service' }
    const agent = this.agentOf(session)
    if (agent === undefined) return { diverged: false, note: 'the session has no live Harness agent' }
    try {
      const live = this.remoteGoal(agent)
      const link = this.link(session, goalId)
      if (live === undefined) {
        return { diverged: link?.remoteId !== undefined, ...(link?.remoteId === undefined ? {} : { note: 'the Harness goal was cleared elsewhere' }) }
      }
      this.record(session, goalId, { remoteId: live.id, revision: live.revision, phase: live.phase })
      const diverged = link?.remoteId !== undefined && link.remoteId !== live.id
      return {
        phase: live.phase,
        diverged,
        ...(diverged ? { note: 'the Harness goal was replaced elsewhere' } : {}),
      }
    } catch (error) {
      return { diverged: false, note: messageOf(error) }
    }
  }

  /** Map one AMP plan transition onto the Harness plan-mode switch. */
  pushPlanMode(session: string, active: boolean): string | undefined {
    const planMode = this.host.planMode
    if (planMode === undefined) return undefined
    const agent = this.agentOf(session)
    if (agent === undefined) return undefined
    try {
      return planMode.set(agent, active)
    } catch {
      return undefined
    }
  }

  /** The session's sync state, for the planning payload and the panel. */
  status(session: string, goalIds: readonly string[]): HarnessSyncStatus {
    if (this.host.goals === undefined) {
      return {
        goals: 'unavailable',
        planMode: this.host.planMode === undefined ? 'unavailable' : this.planModeState(session),
        note: 'the Harness exposes no goal service in this profile',
      }
    }
    let diverged = false
    let note: string | undefined
    for (const goalId of goalIds) {
      const pulled = this.pullGoal(session, goalId)
      if (pulled.diverged) diverged = true
      note ??= pulled.note
    }
    return {
      goals: diverged ? 'diverged' : 'synced',
      planMode: this.host.planMode === undefined ? 'unavailable' : this.planModeState(session),
      ...(note === undefined ? {} : { note }),
    }
  }

  /** Harness plan-mode state for one session (`off` when unreadable). */
  planModeState(session: string): 'on' | 'off' | 'unavailable' {
    const planMode = this.host.planMode
    if (planMode === undefined) return 'unavailable'
    const agent = this.agentOf(session)
    if (agent === undefined) return 'unavailable'
    try {
      return planMode.get(agent).active ? 'on' : 'off'
    } catch {
      return 'unavailable'
    }
  }

  /** The live Harness goal of one session, read verbatim. */
  remoteGoalOf(session: string): HarnessRemoteGoalSnapshot | undefined {
    const agent = this.agentOf(session)
    if (agent === undefined) return undefined
    return this.remoteGoal(agent)
  }

  /**
   * Read and normalise the live Harness goal, ready for the AMP projection.
   *
   * Read-only and fail-open: it creates nothing, records nothing, and a goal
   * port that is missing or throwing degrades to `undefined`, so a navigation
   * read cannot be broken by it. It writes no database row — the import belongs
   * to the planning module, which owns the AMP artifacts and the link row.
   */
  normalisedRemoteGoalOf(session: string): HarnessRemoteGoal | undefined {
    let snapshot: HarnessRemoteGoalSnapshot | undefined
    try {
      snapshot = this.remoteGoalOf(session)
    } catch {
      return undefined
    }
    return snapshot === undefined ? undefined : normaliseRemoteGoal(snapshot)
  }

  private remoteGoal(agent: AgentView): HarnessRemoteGoalSnapshot | undefined {
    const goals = this.host.goals
    if (goals === undefined) return undefined
    const value = asRecord(goals.get(agent))
    const id = asText(value?.id)
    const phase = asPhase(value?.phase)
    if (value === undefined || id === undefined || phase === undefined) return undefined
    return {
      id,
      revision: typeof value.revision === 'number' ? value.revision : 0,
      objective: asText(value.objective) ?? '',
      phase,
    }
  }

  private create(agent: AgentView, objective: string): Partial<HarnessGoalLink> {
    const goals = this.host.goals
    if (goals === undefined) return {}
    return this.reference(goals.create(agent, { objective }))
  }

  private reference(value: unknown): Partial<HarnessGoalLink> {
    const record = asRecord(value)
    const id = asText(record?.id)
    const phase = asPhase(record?.phase)
    return {
      ...(id === undefined ? {} : { remoteId: id }),
      ...(typeof record?.revision === 'number' ? { revision: record.revision } : {}),
      ...(phase === undefined ? {} : { phase }),
    }
  }

  /** Upsert the link row; the sync itself is best effort and never throws. */
  private record(
    session: string,
    goal: string,
    next: Partial<HarnessGoalLink>,
    note?: string,
  ): HarnessGoalLink {
    const previous = this.link(session, goal)
    const merged: HarnessGoalLink = {
      goal,
      ...previous,
      ...next,
      ...(note === undefined ? {} : { note }),
      syncedAt: note === undefined ? this.host.clock.now() : previous?.syncedAt,
    }
    if (note !== undefined && merged.note === undefined) merged.note = note
    const values = {
      session,
      goal,
      remote_id: merged.remoteId ?? null,
      revision: merged.revision ?? null,
      phase: merged.phase ?? null,
      note: merged.note ?? null,
      synced: merged.syncedAt ?? null,
    }
    this.host.db.run(
      `INSERT INTO harness_link (session, goal, remote_id, revision, phase, note, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session, goal) DO UPDATE SET
         remote_id = excluded.remote_id, revision = excluded.revision,
         phase = excluded.phase, note = excluded.note, synced = excluded.synced`,
      values.session,
      values.goal,
      values.remote_id,
      values.revision,
      values.phase,
      values.note,
      values.synced,
    )
    return merged
  }

  /** The live Harness agent of one session, when the profile exposes agents. */
  private agentOf(session: string): AgentView | undefined {
    return this.host.agents?.get(session)
  }
}

/** Normalise a thrown value into one bounded note. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 240)
}

/** The AMP goal a link row belongs to, for callers that only have the row. */
export type HarnessLinkedGoal = Pick<Goal, 'id'>
