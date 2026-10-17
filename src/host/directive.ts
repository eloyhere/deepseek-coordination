/**
 * The Directive module (v23 §6.4).
 *
 * `/feedback 反馈` records a directive against the current turn or its plan:
 * the user's correction is stored as its own row so a later step can apply it
 * (status `applied`) or refuse it (status `rejected`). This module owns the
 * record, not the application; a fresh directive is `pending` and `finished`
 * stays empty until another step resolves it.
 */
import type { Directive, Turn } from '../shared/entity.js'
import type { ModuleHost } from './module.js'
import { mapTurn, number, text } from './row.js'
import type { Row } from './row.js'
import { InvalidArgumentError, InvalidStateError } from '../shared/error.js'

const TERMINAL_TURN = new Set(['done', 'failed', 'cancelled', 'abandoned'])

export class DirectiveModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /** Record one feedback directive of a turn. */
  execute(turn: number, content: string): Directive {
    if (typeof content !== 'string') {
      throw new InvalidArgumentError('directive content must be a string', { received: typeof content })
    }
    const body = content.trim()
    if (body.length === 0) throw new InvalidArgumentError('directive content must not be empty')
    const current = this.writableTurn(turn)
    const identity = this.host.db.insert('directive', {
      handle: this.host.handles.next('directive'),
      turn: current.identity,
      content: body,
      status: 'pending',
      created: this.host.clock.now(),
    })
    return this.get(identity)
  }

  /** One directive row by identity. */
  get(identity: number): Directive {
    return mapDirective(this.host.db.require<Row>('directive', identity, 'directive'))
  }

  /** Every directive of a session, oldest first. */
  list(sessionIdentity: number): Directive[] {
    return this.host.db
      .all<Row>(
        `SELECT d.* FROM directive d
         JOIN turn t ON t.identity = d.turn
         WHERE t.session = ? ORDER BY d.identity ASC`,
        sessionIdentity,
      )
      .map(mapDirective)
  }

  private writableTurn(turn: number): Turn {
    const current = mapTurn(this.host.db.require<Row>('turn', turn, 'turn'))
    if (TERMINAL_TURN.has(current.status)) {
      throw new InvalidStateError(`turn ${turn} is already ${current.status}`, {
        turn,
        status: current.status,
      })
    }
    return current
  }
}

/** Map one `directive` row; `row.ts` has no mapper for this entity. */
function mapDirective(row: Row): Directive {
  const status = text(row, 'status', 'pending')
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    content: text(row, 'content'),
    status: status === 'applied' || status === 'rejected' ? status : 'pending',
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}
