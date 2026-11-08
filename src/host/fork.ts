/**
 * Fork channel: ordinary session forks as host-side lineage.
 *
 * A forked child already carries its inherited prefix in its own log; copying
 * the parent's attention, evidence or receipts would double-count history and
 * promote H4 seed data into the child's context. This tracker therefore records
 * only the relationship every ordinary fork necessarily has: child session id,
 * optional source session, inherited event boundary and time. `itemsFor`
 * projects one index item for the child itself; the parent is not touched.
 *
 * Subagent children also have a `parentSession`, but that header field means
 * delegation lineage rather than historical fork origin. They belong to
 * `subagent.ts`; classification is by `origin`, never by `parentSession`.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { asRecord } from './json.js'
import { scopeOf, sessionExpiry } from './channels/shared.js'
import { wireId } from './wire.js'
import type { WireItem } from './wire.js'

/** Maximum ordinary-fork records retained in memory. */
export const MAX_FORK_RECORDS = 200

/**
 * One ordinary fork observation.
 *
 * `sourceSessionId` is present only when the durable header really carries
 * `parentSession`; an absent source is left absent rather than synthesized.
 * `boundary` is `session.inheritedEventCount` and is zero when the session
 * reports no inherited prefix.
 */
export interface ForkRecord {
  readonly sessionId: string
  readonly sourceSessionId?: string
  readonly boundary: number
  readonly kind: 'fork'
  readonly at: string
}

/** Bounded status view for diagnostics and `/amp/context`. */
export interface ForkStatus {
  readonly records: number
  readonly observed: number
  readonly ignored: number
  readonly failures: number
}

/** Construction options; `now` exists mainly for deterministic tests. */
export interface ForkTrackerOptions {
  /** Clock override; defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string
}

/** Read a non-empty string, or `undefined`. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read a non-negative safe integer, or zero. */
function boundaryOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Read a non-negative safe integer, or `undefined`. */
function optionalIntegerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Track ordinary seeded forks by their child session id.
 *
 * Observation is idempotent per child and never throws. The map is bounded to
 * {@link MAX_FORK_RECORDS}; the oldest observation is evicted first. Nothing
 * here copies attention, evidence, receipts or transcript bytes.
 */
export class ForkTracker {
  private readonly recordsById = new Map<string, ForkRecord>()
  private readonly turns = new Map<string, number>()
  private readonly now: () => string
  private observed = 0
  private ignored = 0
  private failures = 0

  /** @param options - optional clock override for tests. */
  constructor(options: ForkTrackerOptions = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  }

  /**
   * Observe one live agent's durable session header.
   *
   * Only `isSeeded === true` ordinary sessions are recorded. Non-seeded agents
   * and `origin === 'subagent'` children are ignored: their lineage is either
   * absent or owned by {@link SubagentTracker}. A missing source session is
   * never fabricated and a malformed header never escapes as an exception.
   *
   * @param agent - the live agent; only `id` and `session.header` are read.
   */
  observeAgent(agent: unknown): void {
    try {
      const record = asRecord(agent)
      const session = asRecord(record?.session)
      const header = asRecord(session?.header)
      if (header === undefined) {
        this.failures += 1
        return
      }
      if (header.isSeeded !== true) {
        this.ignored += 1
        return
      }
      if (header.origin === 'subagent') {
        this.ignored += 1
        return
      }
      const sessionId = stringOf(record?.id) ?? stringOf(header.id)
      if (sessionId === undefined) {
        this.failures += 1
        return
      }
      this.observed += 1
      if (this.recordsById.has(sessionId)) return
      const sourceSessionId = stringOf(header.parentSession)
      let at = new Date(0).toISOString()
      try {
        at = this.now()
      } catch {
        this.failures += 1
      }
      const fork: ForkRecord = {
        sessionId,
        ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
        boundary: boundaryOf(session?.inheritedEventCount),
        kind: 'fork',
        at,
      }
      this.recordsById.set(sessionId, fork)
      this.evict()
    } catch {
      this.failures += 1
    }
  }

  /**
   * One fork item for the child agent itself, or an empty list.
   *
   * The item is turn-scoped by contract: the turn is the latest one observed
   * by {@link observeEvent}, falling back to zero before the child's first
   * event. `AmpContextOptimizer` then appends the live step suffix and replaces
   * `scope` before compilation. The pointer id is the child session id and the
   * version carries only the inherited count; the source (when unrecorded)
   * stays absent rather than being invented.
   *
   * @param agent - the agent whose session is being compiled.
   */
  itemsFor(agent: Agent): readonly WireItem[] {
    try {
      const sessionId = stringOf(asRecord(agent)?.id)
      if (sessionId === undefined) return []
      const record = this.recordsById.get(sessionId)
      if (record === undefined) return []
      const turn = this.turns.get(sessionId) ?? 0
      const item: WireItem = {
        id: wireId('fork', sessionId, turn, 'fork'),
        channel: 'fork',
        scope: scopeOf(agent, sessionId, turn),
        pointer: {
          kind: 'fork',
          id: record.sessionId,
          version: `inherited:${record.boundary}`,
          uri: `dsh-session:${Buffer.from(record.sessionId, 'utf8').toString('base64url')}`,
        },
        summary: `fork inherited ${record.boundary} events from ${record.sourceSessionId ?? 'an unrecorded source'}`,
        scores: { relevance: 0.5, urgency: 0.2, confidence: 0.7, importance: 0.9 },
        budget: { tokens: 256 },
        expiresAt: sessionExpiry(),
        reason: 'this session was forked from an earlier session',
        trust: 'host',
      }
      return [item]
    } catch {
      this.failures += 1
      return []
    }
  }

  /**
   * Observe one session event to keep the latest turn per session.
   *
   * A `turn/start` event is the common carrier, but any event whose `data.turn`
   * is a non-negative safe integer updates the session's latest turn; other
   * events are ignored. The map is bounded to {@link MAX_FORK_RECORDS}
   * sessions so a long-lived host cannot accumulate ids. Nothing here throws.
   *
   * @param sessionId - the session that emitted the event.
   * @param event - a `SessionEvent` or a plain fixture with `type`/`data`.
   */
  observeEvent(sessionId: string, event: unknown): void {
    try {
      const owner = stringOf(sessionId)
      if (owner === undefined) return
      const record = asRecord(event)
      if (record === undefined) return
      const data = asRecord(record.data)
      const turn = optionalIntegerOf(data?.turn)
      if (turn === undefined) return
      this.turns.set(owner, turn)
      this.evictTurns()
    } catch {
      this.failures += 1
    }
  }

  /** One fork record by child session id, if observed. */
  get(sessionId: string): ForkRecord | undefined {
    return this.recordsById.get(sessionId)
  }

  /** Fork records in observation order. */
  records(): readonly ForkRecord[] {
    return [...this.recordsById.values()]
  }

  /** Bounded status for diagnostics; never throws. */
  status(): ForkStatus {
    return {
      records: this.recordsById.size,
      observed: this.observed,
      ignored: this.ignored,
      failures: this.failures,
    }
  }

  /** Evict the oldest observation beyond the in-memory cap. */
  private evict(): void {
    while (this.recordsById.size > MAX_FORK_RECORDS) {
      const oldest = this.recordsById.keys().next().value
      if (typeof oldest !== 'string') break
      this.recordsById.delete(oldest)
    }
  }

  /** Evict the oldest per-session turn beyond the in-memory cap. */
  private evictTurns(): void {
    while (this.turns.size > MAX_FORK_RECORDS) {
      const oldest = this.turns.keys().next().value
      if (typeof oldest !== 'string') break
      this.turns.delete(oldest)
    }
  }
}
