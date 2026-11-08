/**
 * Subagent channel: delegation lineage and AMP cooperation settlement.
 *
 * A subagent header carries `origin: 'subagent'`, a parent session and a
 * delegation depth. The inherited transcript is H4 data and is never copied
 * here; this tracker records only the delegation relationship, creates one
 * `DelegatedTask` through `CooperationCoordinator`, starts it for the child and
 * settles it from the child's own `turn/end` event.
 *
 * `turn/end` produces a `ResultSubmission` only. No receipt, evidence or
 * session-receipt is fabricated: acceptance by AMP is the sole condition for
 * moving a record out of `running`. Every path is fail-open because AMP is a
 * side path, never the DSH critical path.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CooperationCoordinator } from 'attention-manifest-protocol/cooperation'
import type { PermissionScope } from 'attention-manifest-protocol/profession'
import { asRecord } from './json.js'
import { scopeOf, sessionExpiry } from './channels/shared.js'
import { wireId } from './wire.js'
import type { WireItem } from './wire.js'

/** Maximum subagent records retained in memory. */
export const MAX_SUBAGENT_RECORDS = 200

/** The empty permission scope used for a single DSH subagent delegation. */
export const EMPTY_SCOPE: PermissionScope = Object.freeze({
  capabilityIds: Object.freeze([]),
  operations: Object.freeze([]),
  resources: Object.freeze([]),
  allowWrite: false,
})

/** Lifecycle of one subagent as far as AMP knows it. */
export type SubagentState = 'running' | 'completed' | 'failed' | 'unknown'

/**
 * One observed subagent child.
 *
 * `parentSessionId` and `preset` stay absent when the header omits them. The
 * task fields are present only after a successful `delegate`/`start`; they are
 * the exact owner epoch and fence AMP issued, never guessed.
 */
export interface SubagentRecord {
  readonly childId: string
  readonly parentSessionId?: string
  readonly depth: number
  readonly seeded: boolean
  readonly preset?: string
  readonly taskId?: string
  readonly cooperationId?: string
  readonly ownerEpoch?: number
  readonly fence?: string
  readonly state: SubagentState
  readonly at: string
}

/** Bounded status view for diagnostics and `/amp/context`. */
export interface SubagentStatus {
  readonly records: number
  readonly parents: number
  readonly running: number
  readonly completed: number
  readonly failed: number
  readonly unknown: number
  readonly delegated: number
  readonly settled: number
  readonly observed: number
  readonly ignored: number
  readonly failures: number
}

/** Construction options; the coordinator is optional so the tracker is testable alone. */
export interface SubagentTrackerOptions {
  /** AMP cooperation kernel; when absent, records are lineage-only. */
  readonly coordinator?: CooperationCoordinator
  /** Clock override; defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string
}

/** Read a non-empty string, or `undefined`. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read a non-negative safe integer, or zero. */
function integerOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Read a non-negative safe integer, or `undefined`. */
function optionalIntegerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Track subagent children and their AMP delegation tasks.
 *
 * Observation is idempotent per child id. The map is bounded to
 * {@link MAX_SUBAGENT_RECORDS}; the oldest observation is evicted first. A
 * duplicated `agent/created` therefore cannot delegate the same task twice.
 */
export class SubagentTracker {
  private readonly coordinator?: CooperationCoordinator
  private readonly now: () => string
  private readonly recordsById = new Map<string, SubagentRecord>()
  private readonly turns = new Map<string, number>()
  private delegated = 0
  private settled = 0
  private observed = 0
  private ignored = 0
  private failures = 0

  /** @param options - optional AMP coordinator and clock override. */
  constructor(options: SubagentTrackerOptions = {}) {
    this.coordinator = options.coordinator
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  }

  /**
   * Observe one live agent's durable session header.
   *
   * Only `origin === 'subagent'` sessions are processed. When the header names
   * a parent and a coordinator is available, one AMP `DelegatedTask` is
   * delegated and started for the child; failure leaves the lineage record in
   * `unknown` and only increments the failure counter. Inherited transcript
   * content is never read.
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
      if (header.origin !== 'subagent') {
        this.ignored += 1
        return
      }
      const childId = stringOf(record?.id) ?? stringOf(header.id)
      if (childId === undefined) {
        this.failures += 1
        return
      }
      this.observed += 1
      if (this.recordsById.has(childId)) return
      const parentSessionId = stringOf(header.parentSession)
      const depth = integerOf(header.delegationDepth)
      const seeded = header.isSeeded === true
      const preset = stringOf(header.agentPreset)
      let state: SubagentState = 'running'
      let taskId: string | undefined
      let cooperationId: string | undefined
      let ownerEpoch: number | undefined
      let fence: string | undefined
      if (parentSessionId !== undefined && this.coordinator !== undefined) {
        try {
          const requested = `dsh:subagent:${childId}`
          const task = this.coordinator.delegate({
            taskId: requested,
            delegatorAgentId: parentSessionId,
            ownerAgentId: childId,
            parentScope: EMPTY_SCOPE,
            requestedScope: EMPTY_SCOPE,
          })
          const started = this.coordinator.start(task.taskId, childId, task.ownerEpoch, task.fence)
          taskId = started.taskId
          cooperationId = started.cooperationId
          ownerEpoch = started.ownerEpoch
          fence = started.fence
          this.delegated += 1
        } catch {
          this.failures += 1
          state = 'unknown'
        }
      }
      let at = new Date(0).toISOString()
      try {
        at = this.now()
      } catch {
        this.failures += 1
      }
      this.recordsById.set(childId, {
        childId,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        depth,
        seeded,
        ...(preset === undefined ? {} : { preset }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(cooperationId === undefined ? {} : { cooperationId }),
        ...(ownerEpoch === undefined ? {} : { ownerEpoch }),
        ...(fence === undefined ? {} : { fence }),
        state,
        at,
      })
      this.evict()
    } catch {
      this.failures += 1
    }
  }

  /**
   * Items for one parent agent: one index entry per observed child.
   *
   * The inherited transcript remains in the child's log; the summary says only
   * that a fork or spawn happened, with the preset and depth the header
   * recorded. The pointer id is the child id and the version is the stable
   * `turn:1` delegation version.
   *
   * @param agent - the parent whose session is being compiled.
   */
  itemsFor(agent: Agent): readonly WireItem[] {
    try {
      const sessionId = stringOf(asRecord(agent)?.id)
      if (sessionId === undefined) return []
      const turn = this.turns.get(sessionId) ?? 0
      const scope = scopeOf(agent, sessionId, turn)
      const expiresAt = sessionExpiry()
      const items: WireItem[] = []
      let index = 0
      for (const record of this.recordsById.values()) {
        if (record.parentSessionId !== sessionId) continue
        try {
          const kind = record.seeded ? 'subagent fork' : 'subagent spawn'
          items.push({
            id: wireId('subagent', sessionId, turn, `subagent-${index}`),
            channel: 'subagent',
            scope: { ...scope },
            pointer: { kind: 'subagent', id: record.childId, version: 'turn:1' },
            summary: `${kind} ${record.childId} preset=${record.preset ?? 'inherited'} depth=${record.depth}`,
            scores: { relevance: 0.6, urgency: 0.3, confidence: 0.7, importance: 0.9 },
            budget: { tokens: 256 },
            expiresAt,
            reason: 'a subagent delegation belongs to this session lineage',
            trust: 'host',
          })
        } catch {
          this.failures += 1
        }
        index += 1
      }
      return items
    } catch {
      this.failures += 1
      return []
    }
  }

  /**
   * Observe one session event.
   *
   * The latest `turn` is remembered so parent item ids stay turn-qualified.
   * A child's `turn/end` settles its delegation through the coordinator when
   * the record is still running and owns a task; `completed` maps to success
   * and every other reason kind maps to failure. Only an accepted submission
   * updates the record state. No receipt or evidence is created.
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
      if (turn !== undefined) this.turns.set(owner, turn)
      if (record.type !== 'turn/end') return
      const child = this.recordsById.get(owner)
      if (child === undefined || child.state !== 'running') return
      const reason = asRecord(data?.reason)
      const kind = stringOf(reason?.kind) ?? 'unknown'
      const outcome: 'success' | 'failure' = kind === 'completed' ? 'success' : 'failure'
      if (
        this.coordinator === undefined ||
        child.taskId === undefined ||
        child.ownerEpoch === undefined ||
        child.fence === undefined
      ) return
      const acceptance = this.coordinator.submitResult({
        taskId: child.taskId,
        ownerAgentId: child.childId,
        ownerEpoch: child.ownerEpoch,
        fence: child.fence,
        outcome,
        value: { summary: `subagent turn ended: ${kind}` },
        provenance: [],
      })
      if (!acceptance.accepted) return
      this.settled += 1
      this.recordsById.set(child.childId, {
        ...child,
        state: outcome === 'success' ? 'completed' : 'failed',
      })
    } catch {
      this.failures += 1
    }
  }

  /** One subagent record by child id, if observed. */
  get(childId: string): SubagentRecord | undefined {
    return this.recordsById.get(childId)
  }

  /**
   * Subagent records in observation order.
   *
   * @param parentSessionId - optional parent filter; omitted reads every record.
   */
  records(parentSessionId?: string): readonly SubagentRecord[] {
    const records = [...this.recordsById.values()]
    return parentSessionId === undefined
      ? records
      : records.filter((record) => record.parentSessionId === parentSessionId)
  }

  /** Bounded status for diagnostics; never throws. */
  status(): SubagentStatus {
    const counts = { running: 0, completed: 0, failed: 0, unknown: 0 }
    const parents = new Set<string>()
    for (const record of this.recordsById.values()) {
      counts[record.state] += 1
      if (record.parentSessionId !== undefined) parents.add(record.parentSessionId)
    }
    return {
      records: this.recordsById.size,
      parents: parents.size,
      running: counts.running,
      completed: counts.completed,
      failed: counts.failed,
      unknown: counts.unknown,
      delegated: this.delegated,
      settled: this.settled,
      observed: this.observed,
      ignored: this.ignored,
      failures: this.failures,
    }
  }

  /** Evict the oldest observation beyond the in-memory cap. */
  private evict(): void {
    while (this.recordsById.size > MAX_SUBAGENT_RECORDS) {
      const oldest = this.recordsById.keys().next().value
      if (typeof oldest !== 'string') break
      this.recordsById.delete(oldest)
    }
  }
}
