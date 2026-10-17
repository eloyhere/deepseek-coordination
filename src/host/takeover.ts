/**
 * Takeover windows (v23 §16, §17.1 `takeover` table).
 *
 * A takeover is the plugin's own form replacing a DSH default dialog: an
 * approval, a permission question, an approval-policy change, a plan review, a
 * question, or an error escalation. The row is the durable handle the Client
 * resolves; the in-memory UI state is never authoritative.
 *
 * Lifecycle:
 *
 * ```text
 * request ──► pending ──► resolved   (result stored, finished stamped)
 *                │
 *                └─────► cancelled   (no result)
 * ```
 *
 * `resolved` and `cancelled` are terminal and irreversible: resolving a
 * cancelled window throws `InvalidStateError`, cancelling a resolved one throws
 * too, and a second `resolve` is refused rather than overwriting the audited
 * result. A second `cancel` is the one deliberate exception — cancelling an
 * already cancelled window is idempotent and returns the current row, so a UI
 * double-click cannot fail.
 *
 * `should` answers whether the deployment enabled interception at all
 * (`config.ui.takeover`). When it is off, `request` rejects with
 * `{ accepted: false, reason: 'takeover disabled' }` instead of creating a row
 * no surface would ever render.
 *
 * §16 also adds the profession-lock escalation: `escalateProfessionConflict`
 * records an `errorescalation` window whose payload carries the current and
 * requested profession, the turn, and the rebuild/abandon options.
 *
 * Events on `host.events`:
 *
 * - `takeover/requested` with the created `Takeover`
 * - `takeover/resolved` with the terminal `Takeover` (resolved *or* cancelled)
 */
import type { ModuleHost } from './module.js'
import type { Takeover } from '../shared/entity.js'
import type { Profession, TakeoverType } from '../shared/enum.js'
import type { TakeoverPayload, TakeoverResult } from '../shared/service.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError, TakeoverError } from '../shared/error.js'
import { mapTakeover } from './row.js'
import type { Row } from './row.js'
import { number, text } from './row.js'
import { assertProfession } from './profession.js'

/** Request shape accepted by the module; `session` is the coordination identity. */
export interface TakeoverRequest {
  type: TakeoverType
  payload: TakeoverPayload
  session?: number
}

/** The profession-lock conflict §16 turns into an `errorescalation` window. */
export interface ProfessionConflictInput {
  turn: number
  session: number
  current: Profession
  requested: Profession
}

const TakeoverTypeRegistry: Readonly<Record<TakeoverType, true>> = {
  approval: true,
  permission: true,
  errorescalation: true,
  profession: true,
  planreview: true,
  question: true,
}

/** True for one of the six takeover types declared by `shared/enum.ts`. */
export function isTakeoverType(value: unknown): value is TakeoverType {
  return typeof value === 'string' && Object.hasOwn(TakeoverTypeRegistry, value)
}

export class TakeoverModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /** Whether interception is enabled for this kind of window (v23 §16). */
  should(type: TakeoverType): boolean {
    if (!isTakeoverType(type)) return false
    return this.host.config.ui?.takeover === true
  }

  /**
   * Record one pending window. Returns `{ accepted: true, value: { handle,
   * status: 'pending' } }`; when interception is disabled nothing is written
   * and the rejection names the reason.
   */
  request(input: TakeoverRequest): TakeoverResult {
    const type = input.type
    if (!isTakeoverType(type)) {
      throw new InvalidArgumentError(`unknown takeover type: ${String(type)}`, {
        allowed: Object.keys(TakeoverTypeRegistry),
      })
    }
    if (!this.should(type)) return { accepted: false, reason: 'takeover disabled' }
    if (!isRecord(input.payload)) {
      throw new InvalidArgumentError('takeover payload must be a JSON object')
    }
    const payload = encodeJson(input.payload, 'takeover payload')
    const session = input.session
    if (session !== undefined) {
      assertIdentity('session', session)
      this.requireSession(session)
    }

    const created = this.host.clock.now()
    const handle = this.host.handles.next('takeover')
    const identity = this.host.db.insert('takeover', {
      handle,
      session,
      type,
      payload,
      status: 'pending',
      created,
    })
    const takeover = this.require(identity)
    this.host.events.emit('takeover/requested', takeover)
    return { accepted: true, value: { handle: takeover.handle, status: 'pending' } }
  }

  /**
   * Store the operator's (or agent's) decision and close the window. Only a
   * pending window resolves; the result is kept as JSON for the audit trail.
   */
  resolve(handle: string, result: TakeoverResult): Takeover {
    const row = this.requireRow(handle)
    const status = text(row, 'status')
    if (status === 'cancelled') {
      throw new InvalidStateError(`takeover ${handle} was cancelled and cannot be resolved`, {
        handle,
        status,
      })
    }
    if (status === 'resolved') {
      throw new InvalidStateError(`takeover ${handle} is already resolved`, { handle, status })
    }
    if (status !== 'pending') {
      throw new TakeoverError(`takeover ${handle} has an unknown status`, { handle, status })
    }
    assertResult(result)
    const encoded = encodeJson(result, 'takeover result')
    const now = this.host.clock.now()
    this.host.db.transaction(() => {
      const changed = this.host.db.update(
        'takeover',
        { status: 'resolved', result: encoded, finished: now },
        'handle = ? AND status = ?',
        handle,
        'pending',
      )
      if (changed === 0) {
        throw new InvalidStateError(`takeover ${handle} is no longer pending`, { handle })
      }
    })
    const resolved = this.require(number(row, 'identity'))
    this.host.events.emit('takeover/resolved', resolved)
    return resolved
  }

  /**
   * Close a pending window without a result. Cancelling twice is idempotent and
   * returns the current row; a resolved window cannot be cancelled.
   */
  cancel(handle: string): Takeover {
    const row = this.requireRow(handle)
    const status = text(row, 'status')
    if (status === 'cancelled') return mapTakeover(row)
    if (status === 'resolved') {
      throw new InvalidStateError(`takeover ${handle} is resolved and cannot be cancelled`, {
        handle,
        status,
      })
    }
    if (status !== 'pending') {
      throw new TakeoverError(`takeover ${handle} has an unknown status`, { handle, status })
    }
    const now = this.host.clock.now()
    this.host.db.transaction(() => {
      const changed = this.host.db.update(
        'takeover',
        { status: 'cancelled', finished: now },
        'handle = ? AND status = ?',
        handle,
        'pending',
      )
      if (changed === 0) {
        throw new InvalidStateError(`takeover ${handle} is no longer pending`, { handle })
      }
    })
    const cancelled = this.require(number(row, 'identity'))
    this.host.events.emit('takeover/resolved', cancelled)
    return cancelled
  }

  /** Read one window by handle; an unknown handle is a domain not-found. */
  get(handle: string): Takeover {
    return mapTakeover(this.requireRow(handle))
  }

  /** Every window requested for one coordination session, oldest first. */
  list(session: number): Takeover[] {
    assertIdentity('session', session)
    return this.host.db
      .all<Row>('SELECT * FROM takeover WHERE session = ? ORDER BY identity ASC', session)
      .map(mapTakeover)
  }

  /**
   * §16 profession-lock conflict form: carries the locked/current profession,
   * the requested one, the turn, and the rebuild/abandon options the operator
   * may choose from.
   */
  escalateProfessionConflict(input: ProfessionConflictInput): TakeoverResult {
    assertProfession(input.current)
    assertProfession(input.requested)
    assertIdentity('turn', input.turn)
    assertIdentity('session', input.session)
    const turn = this.host.db.get<Row>('SELECT session FROM turn WHERE identity = ?', input.turn)
    if (turn === undefined) throw new NotFoundError('turn', input.turn)
    if (number(turn, 'session') !== input.session) {
      throw new InvalidArgumentError(`turn ${input.turn} does not belong to session ${input.session}`, {
        turn: input.turn,
        session: input.session,
      })
    }
    const payload: TakeoverPayload = {
      title: 'profession lock conflict',
      message: `profession "${input.current}" is locked for task ${input.turn}; requested "${input.requested}"`,
      fields: ['current', 'requested', 'action'],
      current: input.current,
      requested: input.requested,
      turn: input.turn,
      options: ['rebuild', 'abandon'],
      hint: 'rebuild the task with a new profession, or abandon it; a locked profession cannot change inside one task',
    }
    return this.request({ type: 'errorescalation', payload, session: input.session })
  }

  /* ----------------------------------------------------------------------- *
   * Row helpers
   * ----------------------------------------------------------------------- */

  private requireSession(session: number): void {
    const row = this.host.db.get<Row>('SELECT identity FROM session WHERE identity = ?', session)
    if (row === undefined) throw new NotFoundError('session', session)
  }

  private require(identity: number): Takeover {
    return mapTakeover(this.host.db.require<Row>('takeover', identity, 'takeover'))
  }

  private requireRow(handle: string): Row {
    assertHandle(handle)
    const row = this.host.db.get<Row>('SELECT * FROM takeover WHERE handle = ?', handle)
    if (row === undefined) throw new NotFoundError('takeover', handle)
    return row
  }
}

/* ------------------------------------------------------------------------- *
 * Local helpers
 * ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A takeover payload/result must survive the JSON column round-trip. */
function encodeJson(value: unknown, label: string): string {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    throw new TakeoverError(`${label} is not JSON-serialisable`, {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (encoded === undefined) throw new TakeoverError(`${label} is not JSON-serialisable`)
  return encoded
}

function assertResult(value: unknown): asserts value is TakeoverResult {
  if (!isRecord(value)) throw new InvalidArgumentError('takeover result must be an object')
  if (typeof value.accepted !== 'boolean') {
    throw new InvalidArgumentError('takeover result must carry "accepted" as a boolean')
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    throw new InvalidArgumentError('takeover result "reason" must be a string')
  }
}

function assertHandle(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError('takeover handle must be a non-empty string')
  }
}

function assertIdentity(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive integer identity`)
  }
}
