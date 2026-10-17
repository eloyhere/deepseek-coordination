/**
 * Agent profession locking (v23 §3).
 *
 * One task has exactly one profession. The turn (or subtask) is locked at
 * creation; changing it afterwards throws, and SQLite triggers repeat the
 * refusal even if a caller bypasses this module. Rebuild creates a new task,
 * abandon closes the old one; neither mutates the original profession.
 */
import type { ModuleHost } from './module.js'
import type {
  ProfessionRecord,
  SubTask,
  Turn,
} from '../shared/entity.js'
import type { Profession, ProfessionStatus } from '../shared/enum.js'
import { ProfessionValues } from '../shared/enum.js'
import {
  InvalidArgumentError,
  InvalidStateError,
  ProfessionLockedError,
  ProfessionRequiredError,
} from '../shared/error.js'
import { mapProfessionRecord, mapSubTask, mapTurn } from './row.js'
import type { Row } from './row.js'

const TERMINAL_TURN = new Set(['done', 'failed', 'cancelled', 'abandoned'])
const TERMINAL_RECORD = new Set<ProfessionStatus>(['done', 'failed', 'abandoned'])

export interface ProfessionPatch {
  subtask?: number
  input?: string
  output?: string
  reason?: string
}

export class ProfessionModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /** Set and lock a turn's profession. A locked turn always refuses. */
  selectProfession(turn: number, profession: Profession): Turn {
    assertProfession(profession)
    const current = this.requireTurn(turn)
    if (current.locked) {
      throw new ProfessionLockedError({
        turn,
        current: current.profession,
        requested: profession,
        reason: 'profession is locked for the duration of the task',
        hint: this.hint(),
      })
    }
    if (TERMINAL_TURN.has(current.status)) {
      throw new InvalidStateError(`turn ${turn} is already ${current.status}`, { turn, status: current.status })
    }
    const lockedAt = this.host.clock.now()
    this.host.db.transaction(() => {
      this.host.db.update(
        'turn',
        { profession, locked: 1, lockedAt },
        'identity = ?',
        turn,
      )
      this.recordProfession(turn, profession, 'host', 'running')
      this.host.trace.append({
        turn,
        event: 'lock',
        actor: 'host',
        profession,
        detail: { previous: current.profession, profession },
      })
    })
    return this.requireTurn(turn)
  }

  checkProfessionLock(turn: number): boolean {
    return this.requireTurn(turn).locked
  }

  /** Fail-closed guard used before any task execution. */
  requireLockedProfession(turn: number): Profession {
    const current = this.requireTurn(turn)
    if (!current.locked || current.profession === undefined) {
      throw new ProfessionRequiredError({ turn })
    }
    if (TERMINAL_TURN.has(current.status)) {
      throw new InvalidStateError(`turn ${turn} is already ${current.status}`, { turn, status: current.status })
    }
    return current.profession
  }

  /**
   * Rebuild a turn: end the old task and create a new one. The new task may
   * select a different profession because it is a different task.
   */
  rebuildTurn(turn: number, profession: Profession): Turn {
    assertProfession(profession)
    const current = this.requireTurn(turn)
    if (TERMINAL_TURN.has(current.status)) {
      throw new InvalidStateError(`turn ${turn} is already ${current.status}`, { turn, status: current.status })
    }
    const session = this.host.db.require<Row>('session', current.session, 'session')
    const count = this.host.db.count('turn', 'session = ?', current.session)
    if (count >= this.host.config.maxTurnPerSession) {
      throw new InvalidStateError(`session ${session.handle} reached maxTurnPerSession`, {
        session: current.session,
        maxTurnPerSession: this.host.config.maxTurnPerSession,
      })
    }
    const ordinalRow = this.host.db.get<{ next: number }>(
      'SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM turn WHERE session = ?',
      current.session,
    )
    const ordinal = Number(ordinalRow?.next ?? 1)
    const now = this.host.clock.now()
    const newIdentity = this.host.db.transaction(() => {
      const identity = this.host.db.insert('turn', {
        handle: this.host.handles.next('turn'),
        session: current.session,
        ordinal,
        command: current.command,
        interaction: current.interaction,
        scene: current.scene,
        validation: current.validation,
        profession,
        locked: 1,
        lockedAt: now,
        effort: current.effort,
        iteration: current.iteration,
        rebuild: current.rebuild + 1,
        status: 'pending',
        created: now,
      })

      if (current.prompt !== undefined) {
        const prompt = this.host.db.get<Row>('SELECT * FROM prompt WHERE identity = ?', current.prompt)
        if (prompt !== undefined) {
          const promptIdentity = this.host.db.insert('prompt', {
            handle: this.host.handles.next('prompt'),
            turn: identity,
            content: prompt.content,
            media: prompt.media,
            created: now,
          })
          this.host.db.update('turn', { prompt: promptIdentity }, 'identity = ?', identity)
        }
      }

      if (current.command !== 'none') {
        const command = this.host.db.get<Row>('SELECT * FROM command WHERE turn = ? ORDER BY identity DESC LIMIT 1', turn)
        this.host.db.insert('command', {
          handle: this.host.handles.next('command'),
          turn: identity,
          type: current.command,
          content: command?.content ?? '',
          created: now,
        })
      }

      this.host.db.update('turn', { status: 'abandoned', finished: now }, 'identity = ?', turn)
      this.updateRecordStatus(turn, 'abandoned', 'rebuilt')
      this.host.trace.append({
        turn,
        event: 'rebuild',
        actor: 'host',
        profession: current.profession,
        detail: { newTurn: identity, newProfession: profession, previousProfession: current.profession },
      })
      this.host.trace.append({
        turn: identity,
        event: 'lock',
        actor: 'host',
        profession,
        detail: { previousTurn: turn, rebuilt: true },
      })
      this.recordProfession(identity, profession, 'host', 'running')
      return identity
    })
    return this.requireTurn(newIdentity)
  }

  /** Abandon a turn without creating a replacement. */
  abandonTurn(turn: number): Turn {
    const current = this.requireTurn(turn)
    if (current.status === 'abandoned') return current
    if (TERMINAL_TURN.has(current.status)) {
      throw new InvalidStateError(`turn ${turn} is already ${current.status}`, { turn, status: current.status })
    }
    const now = this.host.clock.now()
    this.host.db.transaction(() => {
      this.host.db.update('turn', { status: 'abandoned', finished: now }, 'identity = ?', turn)
      this.updateRecordStatus(turn, 'abandoned', 'abandoned')
      this.host.trace.append({
        turn,
        event: 'abandon',
        actor: 'host',
        profession: current.profession,
        detail: { reason: 'turn abandoned' },
      })
    })
    return this.requireTurn(turn)
  }

  /** Rebuild a subtask; the replacement carries `supersedes` to the old one. */
  rebuildSubTask(subtask: number, profession: Profession): SubTask {
    assertProfession(profession)
    const current = this.requireSubTask(subtask)
    if (current.status === 'verified' || current.status === 'rejected' || current.status === 'abandoned') {
      throw new InvalidStateError(`subtask ${subtask} is already ${current.status}`, {
        subtask,
        status: current.status,
      })
    }
    const now = this.host.clock.now()
    const identity = this.host.db.transaction(() => {
      const created = this.host.db.insert('subtask', {
        handle: this.host.handles.next('subtask'),
        parent: current.parent,
        model: current.model,
        effort: current.effort,
        task: current.task,
        tools: current.tools,
        context: current.context,
        acceptance: current.acceptance,
        groundTruth: current.groundTruth,
        profession,
        locked: 1,
        lockedAt: now,
        blockedBy: current.blockedBy,
        status: 'pending',
        rejectCount: 0,
        supersedes: current.identity,
        created: now,
      })
      this.host.db.update(
        'subtask',
        { status: 'rejected', reason: 'rebuilt', finished: now },
        'identity = ?',
        subtask,
      )
      this.updateSubTaskRecord(subtask, 'abandoned', 'rebuilt')
      this.host.trace.append({
        turn: current.parent,
        event: 'rebuild',
        subtask,
        actor: 'host',
        profession: current.profession,
        detail: { newSubTask: created, newProfession: profession, previousProfession: current.profession },
      })
      this.host.trace.append({
        turn: current.parent,
        event: 'lock',
        subtask: created,
        actor: 'host',
        profession,
        detail: { previousSubTask: subtask, rebuilt: true },
      })
      this.recordProfession(current.parent, profession, 'host', 'running', { subtask: created })
      return created
    })
    return this.requireSubTask(identity)
  }

  /** Abandon a subtask without creating a replacement. */
  abandonSubTask(subtask: number): SubTask {
    const current = this.requireSubTask(subtask)
    if (current.status === 'abandoned') return current
    const now = this.host.clock.now()
    this.host.db.transaction(() => {
      this.host.db.update(
        'subtask',
        { status: 'abandoned', reason: 'abandoned', finished: now },
        'identity = ?',
        subtask,
      )
      this.updateSubTaskRecord(subtask, 'abandoned', 'abandoned')
      this.host.trace.append({
        turn: current.parent,
        event: 'abandon',
        subtask,
        actor: 'host',
        profession: current.profession,
        detail: { reason: 'subtask abandoned' },
      })
    })
    return this.requireSubTask(subtask)
  }

  /**
   * Upsert the single profession record of one task. Never changes a locked
   * record's profession; status/output updates remain lawful.
   */
  recordProfession(
    turn: number,
    profession: Profession,
    actor: string,
    status: ProfessionStatus | string,
    patch: ProfessionPatch = {},
  ): ProfessionRecord {
    assertProfession(profession)
    this.requireTurn(turn)
    if (patch.subtask !== undefined) this.requireSubTask(patch.subtask)
    const existing = this.findRecord(turn, patch.subtask)
    const now = this.host.clock.now()
    const normalised = statusOf(status)
    if (existing === undefined) {
      const identity = this.host.db.insert('profession_record', {
        handle: this.host.handles.next('profession'),
        turn,
        subtask: patch.subtask,
        actor,
        profession,
        locked: 1,
        lockedAt: now,
        status: normalised,
        input: patch.input,
        output: patch.output,
        reason: patch.reason,
        created: now,
      })
      return mapProfessionRecord(this.host.db.require<Row>('profession_record', identity, 'profession record'))
    }
    if (existing.locked && existing.profession !== profession) {
      throw new ProfessionLockedError({
        turn,
        current: existing.profession,
        requested: profession,
        subtask: patch.subtask,
        hint: this.hint(),
      })
    }
    this.host.db.update(
      'profession_record',
      {
        status: normalised,
        input: patch.input,
        output: patch.output,
        reason: patch.reason,
        finished: TERMINAL_RECORD.has(normalised) ? now : null,
      },
      'identity = ?',
      existing.identity,
    )
    return this.requireRecord(existing.identity)
  }

  getProfessionRecord(turn: number): ProfessionRecord {
    const existing = this.findRecord(turn)
    if (existing !== undefined) return existing
    const current = this.requireTurn(turn)
    return this.recordProfession(turn, current.profession, 'host', 'running')
  }

  listProfessionRecord(session: number): ProfessionRecord[] {
    return this.host.db
      .all<Row>(
        `SELECT pr.* FROM profession_record pr
         JOIN turn t ON t.identity = pr.turn
         WHERE t.session = ? ORDER BY pr.identity ASC`,
        session,
      )
      .map(mapProfessionRecord)
  }

  getSubTask(subtask: number): SubTask {
    return this.requireSubTask(subtask)
  }

  requireTurn(turn: number): Turn {
    return mapTurn(this.host.db.require<Row>('turn', turn, 'turn'))
  }

  requireSubTask(subtask: number): SubTask {
    return mapSubTask(this.host.db.require<Row>('subtask', subtask, 'subtask'))
  }

  private findRecord(turn: number, subtask?: number): ProfessionRecord | undefined {
    const row =
      subtask === undefined
        ? this.host.db.get<Row>(
            'SELECT * FROM profession_record WHERE turn = ? AND subtask IS NULL ORDER BY identity DESC LIMIT 1',
            turn,
          )
        : this.host.db.get<Row>(
            'SELECT * FROM profession_record WHERE turn = ? AND subtask = ? ORDER BY identity DESC LIMIT 1',
            turn,
            subtask,
          )
    return row === undefined ? undefined : mapProfessionRecord(row)
  }

  private requireRecord(identity: number): ProfessionRecord {
    return mapProfessionRecord(this.host.db.require<Row>('profession_record', identity, 'profession record'))
  }

  private updateRecordStatus(turn: number, status: ProfessionStatus, reason: string): void {
    this.host.db.run(
      `UPDATE profession_record SET status = ?, reason = ?, finished = ?
       WHERE turn = ? AND subtask IS NULL`,
      status,
      reason,
      this.host.clock.now(),
      turn,
    )
  }

  private updateSubTaskRecord(subtask: number, status: ProfessionStatus, reason: string): void {
    this.host.db.run(
      `UPDATE profession_record SET status = ?, reason = ?, finished = ?
       WHERE subtask = ?`,
      status,
      reason,
      this.host.clock.now(),
      subtask,
    )
  }

  private hint(): string {
    return this.host.config.profession.errorHint
      ? 'use rebuildTurn/rebuildSubTask or abandonTurn/abandonSubTask to change profession'
      : ''
  }
}

export function assertProfession(value: unknown): asserts value is Profession {
  if (!ProfessionValues.includes(value as Profession)) {
    throw new InvalidArgumentError(`unknown profession: ${String(value)}`, {
      allowed: ProfessionValues,
    })
  }
}

export function statusOf(value: string): ProfessionStatus {
  if (value === 'pending' || value === 'running' || value === 'done' || value === 'failed' || value === 'abandoned') {
    return value
  }
  return 'running'
}
