/**
 * Append-only governance trace.
 *
 * Each row hashes the previous row's hash plus this event's canonical content.
 * SQLite triggers reject UPDATE and DELETE, so the chain is both tamper
 * evident and tamper resistant. `verify` recomputes the chain for one turn.
 */
import { createHash } from 'node:crypto'
import type { OrchestrationTrace } from '../shared/entity.js'
import type { ModuleHost, TraceInput, TraceVerification, TraceWriter } from './module.js'

export class TraceModule implements TraceWriter {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  append(input: TraceInput): OrchestrationTrace {
    const detail = typeof input.detail === 'string' ? input.detail : JSON.stringify(input.detail)
    const created = this.host.clock.now()
    const previous = this.host.db.get<{ hash: string }>(
      'SELECT hash FROM orchestration_trace WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      input.turn,
    )
    const parentHash = previous?.hash ?? '0'
    const hash = hashTrace(parentHash, {
      turn: input.turn,
      event: input.event,
      subtask: input.subtask ?? null,
      actor: input.actor,
      profession: input.profession ?? null,
      parentEvent: input.parentEvent ?? null,
      detail,
      created,
    })

    if (input.parentEvent !== undefined) {
      const parent = this.host.db.get<{ turn: number }>(
        'SELECT turn FROM orchestration_trace WHERE identity = ?',
        input.parentEvent,
      )
      if (parent === undefined) {
        throw new Error(`trace parent event ${input.parentEvent} does not exist`)
      }
      if (parent.turn !== input.turn) {
        throw new Error(`trace parent event ${input.parentEvent} belongs to another turn`)
      }
    }

    const identity = this.host.db.insert('orchestration_trace', {
      handle: this.host.handles.next('trace'),
      turn: input.turn,
      event: input.event,
      subtask: input.subtask,
      actor: input.actor,
      profession: input.profession,
      parentEvent: input.parentEvent,
      detail,
      hash,
      created,
    })
    return this.host.db.require<OrchestrationTrace>('orchestration_trace', identity, 'orchestration trace')
  }

  list(turn: number): OrchestrationTrace[] {
    return this.host.db.all<OrchestrationTrace>(
      'SELECT * FROM orchestration_trace WHERE turn = ? ORDER BY identity ASC',
      turn,
    )
  }

  verify(turn: number): TraceVerification {
    const rows = this.list(turn)
    let previous = '0'
    for (const row of rows) {
      const expected = hashTrace(previous, {
        turn: row.turn,
        event: row.event,
        subtask: row.subtask ?? null,
        actor: row.actor,
        profession: row.profession ?? null,
        parentEvent: row.parentEvent ?? null,
        detail: row.detail,
        created: row.created,
      })
      if (expected !== row.hash) {
        return { ok: false, brokenAt: row.identity, reason: 'hash chain mismatch' }
      }
      previous = row.hash
    }
    return { ok: true }
  }
}

/** Hash one trace payload with a stable key order. */
export function hashTrace(previousHash: string, payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortKeys(payload))
  return createHash('sha256').update(previousHash).update('\n').update(canonical).digest('hex')
}

/** Recursively sort object keys so the JSON is canonical. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return result
}

/** Write a trace row through a host that may not have a TraceWriter yet. */
export function appendTrace(host: ModuleHost, input: TraceInput): OrchestrationTrace {
  return host.trace.append(input)
}
