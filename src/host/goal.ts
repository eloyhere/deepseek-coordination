/**
 * The Goal module (v23 §6.4, §11.5).
 *
 * `/goal 目标` sets, shows, updates or clears the goal of the current turn,
 * skipping Comprehension and Organization. Goal rows are an append-only
 * history inside one turn: every state change appends a row and `turn.goal`
 * points at the newest one, so an audit can replay how the goal evolved.
 *
 * `cleared` is a tombstone: it is the newest row but there is no current goal
 * afterwards, so `current`/`get` report "no goal" until the next `set`.
 */
import type { Goal, GoalResult, Turn } from '../shared/entity.js'
import type { ModuleHost } from './module.js'
import { mapGoal, mapTurn } from './row.js'
import type { Row } from './row.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError } from '../shared/error.js'

const TERMINAL_TURN = new Set(['done', 'failed', 'cancelled', 'abandoned'])

/** The content words that mean "show the current goal". */
const VIEW_WORD: ReadonlySet<string> = new Set(['', '查看', 'view'])

/** The content words that mean "clear the current goal". */
const CLEAR_WORD: ReadonlySet<string> = new Set(['清除', 'clear'])

export class GoalModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /** The newest goal of a turn that is still in force, or `undefined`. */
  current(turn: number): Goal | undefined {
    const row = this.host.db.get<Row>(
      'SELECT * FROM goal WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turn,
    )
    if (row === undefined) return undefined
    const goal = mapGoal(row)
    return goal.status === 'cleared' ? undefined : goal
  }

  /** The current goal of a turn; a cleared or absent goal is a NotFoundError. */
  get(turn: number): Goal {
    const current = this.current(turn)
    if (current === undefined) throw new NotFoundError('goal', turn)
    return current
  }

  /**
   * Set the goal. The first goal of a turn is `set`; replacing a different goal
   * is `updated`. Re-sending the same content is a no-op that only re-links the
   * turn pointer.
   */
  set(turn: number, content: string): Goal {
    const text = goalContent(content)
    const currentTurn = this.writableTurn(turn)
    const current = this.current(turn)
    if (current !== undefined && current.content === text) {
      this.link(currentTurn, current.identity)
      return current
    }
    return this.write(currentTurn, text, current === undefined ? 'set' : 'updated')
  }

  /** Replace the goal of a turn; a turn without a goal is a NotFoundError. */
  update(turn: number, content: string): Goal {
    const text = goalContent(content)
    const currentTurn = this.writableTurn(turn)
    const current = this.current(turn)
    if (current === undefined) throw new NotFoundError('goal', turn)
    if (current.content === text) return current
    return this.write(currentTurn, text, 'updated')
  }

  /** Clear the goal with a `cleared` tombstone row. */
  clear(turn: number): Goal {
    const currentTurn = this.writableTurn(turn)
    const current = this.current(turn)
    if (current === undefined) throw new NotFoundError('goal', turn)
    return this.write(currentTurn, current.content, 'cleared', 'cleared')
  }

  /**
   * The `/goal` command: empty or `查看`/`view` shows the current goal as a
   * `viewed` row; `清除`/`clear` clears it; anything else sets or updates it.
   * Scoring is never part of a goal command.
   */
  execute(turn: number, content: string): GoalResult {
    if (typeof content !== 'string') {
      throw new InvalidArgumentError('goal content must be a string', { received: typeof content })
    }
    const text = content.trim()
    const keyword = text.toLowerCase()
    if (VIEW_WORD.has(text) || VIEW_WORD.has(keyword)) {
      return { goal: this.view(turn), rescored: false }
    }
    if (CLEAR_WORD.has(text) || CLEAR_WORD.has(keyword)) {
      return { goal: this.clear(turn), rescored: false }
    }
    return { goal: this.set(turn, text), rescored: false }
  }

  /** Every goal row of a session, oldest first, including cleared ones. */
  list(sessionIdentity: number): Goal[] {
    return this.host.db
      .all<Row>('SELECT * FROM goal WHERE session = ? ORDER BY identity ASC', sessionIdentity)
      .map(mapGoal)
  }

  /** Record that the current goal was shown to the user. */
  private view(turn: number): Goal {
    const currentTurn = this.writableTurn(turn)
    const current = this.current(turn)
    if (current === undefined) throw new NotFoundError('goal', turn)
    return this.write(currentTurn, current.content, 'viewed')
  }

  /** Append one goal row and point the turn at it, atomically. */
  private write(currentTurn: Turn, content: string, status: Goal['status'], reason?: string): Goal {
    const now = this.host.clock.now()
    const identity = this.host.db.transaction(() => {
      const row = this.host.db.insert('goal', {
        handle: this.host.handles.next('goal'),
        turn: currentTurn.identity,
        session: currentTurn.session,
        content,
        status,
        reason,
        created: now,
        changed: status === 'set' ? undefined : now,
      })
      this.host.db.update('turn', { goal: row }, 'identity = ?', currentTurn.identity)
      return row
    })
    return this.byId(identity)
  }

  private link(currentTurn: Turn, goal: number): void {
    this.host.db.update('turn', { goal }, 'identity = ?', currentTurn.identity)
  }

  private byId(identity: number): Goal {
    return mapGoal(this.host.db.require<Row>('goal', identity, 'goal'))
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

/** Validate and normalise a goal body. */
function goalContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new InvalidArgumentError('goal content must be a string', { received: typeof content })
  }
  const text = content.trim()
  if (text.length === 0) throw new InvalidArgumentError('goal content must not be empty')
  return text
}
