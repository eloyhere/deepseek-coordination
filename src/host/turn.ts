/**
 * Turns: one task per prompt (v23 §3.3, §9.7, §11.2, §17.1).
 *
 * `create` is the only place a task begins. It writes the prompt, the optional
 * command face and the turn row, then locks the profession: the turn row itself
 * carries `profession` NOT NULL with `locked` = 1, and the task gets exactly one
 * profession record plus one `lock` governance event (§3.3, §3.5, §3.8).
 * Everything downstream (comprehension, organization, plan, goal, compact) is
 * attached later through `attach`.
 *
 * Two ordering facts are fixed by the schema rather than by taste:
 *
 * - `prompt.turn` references `turn.identity`, so the turn row has to exist
 *   before its prompt row; the prompt identity is then written back into
 *   `turn.prompt`. Both writes and the command row share one transaction, so no
 *   reader ever observes the half state.
 * - `request.model` is accepted for symmetry with the SubTask four-tuple, but
 *   the `turn` table (v23 §17.1) has no model column. The model of the parent
 *   agent remains a DSH-side fact and is deliberately not persisted here.
 *
 * Terminal states are irreversible (§8.5): `finish` accepts one of
 * `done`/`failed`/`cancelled` and refuses a turn that already ended. The one
 * lawful way to leave a locked profession early is `markAbandoned`, which is
 * delegated to `ProfessionModule` so the lock rules live in a single module.
 */
import type { ModuleHost } from './module.js'
import type { Session, Turn } from '../shared/entity.js'
import type {
  CommandType,
  Interaction,
  Profession,
  Scene,
  TurnStatus,
  Validation,
} from '../shared/enum.js'
import {
  CommandValues,
  InteractionValues,
  SceneValues,
  TurnStatusLabel,
  ValidationValues,
  isOneOf,
} from '../shared/enum.js'
import { InvalidArgumentError, InvalidStateError } from '../shared/error.js'
import { ProfessionModule, assertProfession } from './profession.js'
import { SessionModule } from './session.js'
import { mapTurn } from './row.js'
import type { Row } from './row.js'

/** Every field one new turn needs. */
export interface TurnRequest {
  content: string
  profession: Profession
  interaction: Interaction
  scene: Scene
  validation: Validation
  command?: CommandType
  effort?: string
  /** Accepted for symmetry with SubTask; the v23 turn table has no column. */
  model?: string
}

/** The statuses that end a task; no transition out of them is lawful. */
const TERMINAL_TURN: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'abandoned'])

/** The active-turn predicate shared with `SessionModule` and `SelectionModule`. */
const ACTIVE_TURN = `status NOT IN ('done', 'failed', 'cancelled', 'abandoned')`

/**
 * A profession record has no `cancelled` status. A cancelled turn did not
 * complete its task, so `abandoned` is the closest truthful record status;
 * `failed` would claim the task failed on its own merits.
 */
const FINISH_RECORD: Readonly<Record<'done' | 'failed' | 'cancelled', string>> = {
  done: 'done',
  failed: 'failed',
  cancelled: 'abandoned',
}

/** Written into the profession record when a host restart interrupts a task. */
const INTERRUPTED_REASON = 'turn was interrupted by a host restart'

/** The columns `attach` may fill in; the order is the pipeline order (§9.7). */
const ATTACH_FIELD = ['comprehension', 'organization', 'plan', 'goal', 'compact'] as const

export class TurnModule {
  private readonly host: ModuleHost
  private sessions?: SessionModule
  private professions?: ProfessionModule

  constructor(host: ModuleHost) {
    this.host = host
  }

  /**
   * Resolve the coordination session of one DSH session id, creating it on
   * first sight. `SessionModule` owns the record, so it is reused rather than
   * re-implemented here.
   */
  ensureSession(
    sessionHandle: string,
    metadata?: { cwd?: string; profile?: string; principal?: string },
  ): Session {
    assertSessionHandle(sessionHandle)
    return this.sessionModule().ensure(sessionHandle, metadata ?? {})
  }

  /**
   * Create one turn for a coordination session identity. The profession is
   * locked here, which is what makes "switch profession mid-task" impossible:
   * no later call to this module can rewrite `turn.profession` (§3.3).
   */
  create(sessionIdentity: number, request: TurnRequest): Turn {
    assertSessionIdentity(sessionIdentity)
    assertRequest(request)
    const command = request.command ?? 'none'
    assertOneOf('command', command, CommandValues)
    const session = this.host.db.require<Row>('session', sessionIdentity, 'session')
    const effort =
      typeof request.effort === 'string' && request.effort.trim().length > 0 ? request.effort : 'medium'

    const identity = this.host.db.transaction(() => {
      const existing = this.host.db.count('turn', 'session = ?', sessionIdentity)
      if (existing >= this.host.config.maxTurnPerSession) {
        throw new InvalidStateError(
          `session ${String(session.handle)} reached maxTurnPerSession`,
          { session: sessionIdentity, maxTurnPerSession: this.host.config.maxTurnPerSession },
        )
      }
      const ordinal = existing + 1
      const now = this.host.clock.now()

      const turnIdentity = this.host.db.insert('turn', {
        handle: this.host.handles.next('turn'),
        session: sessionIdentity,
        ordinal,
        command,
        interaction: request.interaction,
        scene: request.scene,
        validation: request.validation,
        profession: request.profession,
        locked: 1,
        lockedAt: now,
        effort,
        iteration: 1,
        rebuild: 0,
        status: 'pending',
        created: now,
      })

      const promptIdentity = this.host.db.insert('prompt', {
        handle: this.host.handles.next('prompt'),
        turn: turnIdentity,
        content: request.content,
        created: now,
      })
      this.host.db.update('turn', { prompt: promptIdentity }, 'identity = ?', turnIdentity)

      if (command !== 'none') {
        this.host.db.insert('command', {
          handle: this.host.handles.next('command'),
          turn: turnIdentity,
          type: command,
          content: request.content,
          created: now,
        })
      }

      /* The single profession record of this task (v23 §3.5, §11.14). */
      this.professionModule().recordProfession(turnIdentity, request.profession, 'host', 'running', {
        input: request.content,
      })

      this.host.trace.append({
        turn: turnIdentity,
        event: 'lock',
        actor: 'host',
        profession: request.profession,
        detail: { phase: 'turn-create' },
      })

      return turnIdentity
    })

    return this.requireTurn(identity)
  }

  /**
   * Create one turn for a DSH session id: ensure the coordination session, then
   * `create`. The two entry points never mix their argument kinds, so a session
   * handle can never be mistaken for a session identity.
   */
  createForHandle(sessionHandle: string, request: TurnRequest): Turn {
    const session = this.ensureSession(sessionHandle)
    return this.create(session.identity, request)
  }

  get(identity: number): Turn {
    return this.requireTurn(identity)
  }

  /** Every turn of one session, in ordinal order. */
  list(sessionIdentity: number): Turn[] {
    return this.host.db
      .all<Row>('SELECT * FROM turn WHERE session = ? ORDER BY ordinal ASC, identity ASC', sessionIdentity)
      .map(mapTurn)
  }

  /**
   * The one non-terminal turn of a session, if any. Selection uses the same
   * predicate: an active turn is what keeps the profession dropdown read-only.
   */
  active(sessionIdentity: number): Turn | undefined {
    const row = this.host.db.get<Row>(
      `SELECT * FROM turn WHERE session = ? AND ${ACTIVE_TURN} ORDER BY identity DESC LIMIT 1`,
      sessionIdentity,
    )
    return row === undefined ? undefined : mapTurn(row)
  }

  /**
   * Move a turn to another lifecycle status. Terminal targets are funnelled
   * through `finish` / `markAbandoned` so the profession record and the audit
   * trail can never drift from the turn row. Unknown values are refused.
   */
  setStatus(identity: number, status: TurnStatus): Turn {
    assertTurnStatus(status)
    const current = this.requireTurn(identity)
    if (current.status === status) return current
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      return this.finish(identity, status)
    }
    if (status === 'abandoned') return this.markAbandoned(identity)
    if (TERMINAL_TURN.has(current.status)) {
      throw new InvalidStateError(`turn ${identity} is already ${current.status}`, {
        turn: identity,
        status: current.status,
      })
    }
    this.host.db.update('turn', { status }, 'identity = ?', identity)
    return this.requireTurn(identity)
  }

  /**
   * Bind the artifacts produced later in the pipeline (comprehension,
   * organization, plan, goal, compact) to this turn. Absent fields keep their
   * stored value; a supplied identity must be a real positive row identity.
   */
  attach(
    identity: number,
    patch: { comprehension?: number; organization?: number; plan?: number; goal?: number; compact?: number },
  ): Turn {
    const current = this.requireTurn(identity)
    const values: Record<string, number> = {}
    for (const field of ATTACH_FIELD) {
      const value = patch[field]
      if (value === undefined) continue
      if (!Number.isInteger(value) || value <= 0) {
        throw new InvalidArgumentError(`turn.${field} must be a positive integer identity`, { field, value })
      }
      values[field] = value
    }
    if (Object.keys(values).length === 0) return current
    this.host.db.update('turn', values, 'identity = ?', identity)
    return this.requireTurn(identity)
  }

  /**
   * Close one turn and its profession record. Only a non-terminal turn may
   * finish, and no trace event is written here: the orchestration bridge owns
   * `synthesize` / `abandon` so an event is never duplicated (§3.8).
   */
  finish(identity: number, status: 'done' | 'failed' | 'cancelled'): Turn {
    const requested = status as TurnStatus
    if (requested !== 'done' && requested !== 'failed' && requested !== 'cancelled') {
      throw new InvalidArgumentError(`unknown finish status: ${String(status)}`, {
        allowed: ['done', 'failed', 'cancelled'],
      })
    }
    const current = this.requireTurn(identity)
    if (TERMINAL_TURN.has(current.status)) {
      throw new InvalidStateError(`turn ${identity} is already ${current.status}`, {
        turn: identity,
        status: current.status,
      })
    }
    const now = this.host.clock.now()
    this.host.db.transaction(() => {
      this.host.db.update('turn', { status: requested, finished: now }, 'identity = ?', identity)
      this.professionModule().recordProfession(identity, current.profession, 'host', FINISH_RECORD[requested])
    })
    return this.requireTurn(identity)
  }

  /**
   * Fail every task a previous host process left open. Called once at host
   * start; no trace event is written because a restart is not a governance
   * action of the agent. Returns the number of turns recovered.
   */
  recoverInterrupted(): number {
    const now = this.host.clock.now()
    return this.host.db.transaction(() => {
      const rows = this.host.db.all<Row>(`SELECT * FROM turn WHERE ${ACTIVE_TURN} ORDER BY identity ASC`)
      for (const row of rows) {
        const turn = mapTurn(row)
        this.host.db.update('turn', { status: 'failed', finished: now }, 'identity = ?', turn.identity)
        this.professionModule().recordProfession(turn.identity, turn.profession, 'host', 'failed', {
          reason: INTERRUPTED_REASON,
        })
      }
      return rows.length
    })
  }

  /**
   * Abandon a turn without creating a replacement. Delegated to
   * `ProfessionModule` so the "profession may only change by rebuild or
   * abandon" rule has exactly one implementation (§3.4). The profession record
   * is kept for audit.
   */
  markAbandoned(identity: number): Turn {
    return this.professionModule().abandonTurn(identity)
  }

  private requireTurn(identity: number): Turn {
    return mapTurn(this.host.db.require<Row>('turn', identity, 'turn'))
  }

  private sessionModule(): SessionModule {
    this.sessions ??= new SessionModule(this.host)
    return this.sessions
  }

  private professionModule(): ProfessionModule {
    this.professions ??= new ProfessionModule(this.host)
    return this.professions
  }
}

/** A session identity is a coordination integer, never a DSH session id. */
function assertSessionIdentity(identity: unknown): asserts identity is number {
  if (typeof identity !== 'number' || !Number.isInteger(identity) || identity <= 0) {
    throw new InvalidArgumentError(
      'session identity must be the coordination session number; use createForHandle for a DSH session id',
      { session: identity },
    )
  }
}

/** A session handle is a DSH session id string, never a coordination identity. */
function assertSessionHandle(handle: unknown): asserts handle is string {
  if (typeof handle !== 'string' || handle.trim().length === 0) {
    throw new InvalidArgumentError(
      'session handle must be the DSH session id string; use create for a coordination session number',
      { session: handle },
    )
  }
}

function assertTurnStatus(value: unknown): asserts value is TurnStatus {
  if (typeof value !== 'string' || !Object.hasOwn(TurnStatusLabel, value)) {
    throw new InvalidArgumentError(`unknown turn status: ${String(value)}`, {
      allowed: Object.keys(TurnStatusLabel),
    })
  }
}

function assertOneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): asserts value is T {
  if (!isOneOf(value, allowed)) {
    throw new InvalidArgumentError(`unknown ${field}: ${String(value)}`, { allowed })
  }
}

/** Refuse an incomplete or mistyped request before any row is written. */
function assertRequest(request: TurnRequest): void {
  if (typeof request !== 'object' || request === null) {
    throw new InvalidArgumentError('turn request must be an object')
  }
  if (typeof request.content !== 'string') {
    throw new InvalidArgumentError('turn content must be a string', { content: request.content })
  }
  assertProfession(request.profession)
  assertOneOf('interaction', request.interaction, InteractionValues)
  assertOneOf('scene', request.scene, SceneValues)
  assertOneOf('validation', request.validation, ValidationValues)
}
