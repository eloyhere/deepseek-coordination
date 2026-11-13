/**
 * R1 host-side recovery: rebuild in-process tracker state from session logs.
 *
 * Plugin activation starts with empty trackers, but every fact those trackers
 * observe is already durable in the session logs. Recovery therefore replays
 * the logs synchronously during activation:
 *
 *  - `ForkTracker` / `SubagentTracker`: turn mapping and delegation lineage;
 *  - `SpillIndex` / `RetentionLedger` / `PruneTracker` / `CompactionTracker`:
 *    output, retention, prune and compaction records;
 *  - `WireCapture`: the last user prompt of an already-open turn, so the first
 *    assembly after a reload does not display the previous step's prompt.
 *
 * `AmpSync` is deliberately not called. AMP session/turn/goal/action facts are
 * owned by sync and are already derived from the same log; replaying them here
 * would duplicate them. Recovery never reads attachment bytes, performs no
 * network or store I/O and creates no evidence or receipt.
 *
 * Replay order is significant: all historical events are fed to the trackers
 * *before* live agents are observed. `SubagentTracker.observeAgent` creates and
 * starts a delegation task, so observing first would let an inherited
 * historical `turn/end` settle the new task immediately. With history first,
 * the observation happens at the log head and only future events settle it.
 *
 * Every path is fail-open: a malformed list, session or event is counted in
 * `RecoveryStatus.failures` and skipped, never thrown into plugin activation.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WireCapture } from './prestep.js'
import type { ForkTracker } from './fork.js'
import type { SubagentTracker } from './subagent.js'
import type { SpillIndex } from './spill.js'
import type { RetentionLedger } from './retention.js'
import type { PruneTracker } from './prune.js'
import type { CompactionTracker } from './compaction.js'

/**
 * Maximum live agents enumerated in one recovery pass. Agents beyond this cap
 * are not observed; the truncation is counted once in `failures`, never thrown.
 */
export const MAX_RECOVERY_AGENTS = 200

/**
 * Maximum sessions enumerated from either host service in one recovery pass.
 * A longer list is truncated and the truncation is counted once in `failures`.
 */
export const MAX_RECOVERY_SESSIONS = 200

/**
 * Maximum new events replayed for one session in one recovery pass. Older
 * pending events are skipped as a defensive stop and counted once; the newest
 * window is kept so an open turn's `turn/start` and prompt still replay.
 */
export const MAX_EVENTS_PER_SESSION = 50_000

/** The host-side trackers recovery rebuilds. */
export interface RecoveryDeps {
  readonly capture: WireCapture
  readonly fork: ForkTracker
  readonly subagent: SubagentTracker
  readonly spill: SpillIndex
  readonly retention: RetentionLedger
  readonly prune: PruneTracker
  readonly compaction: CompactionTracker
  /**
   * Close a durable turn in the AMP workflow after a reload.
   *
   * Recovery is otherwise forbidden from touching sync facts, but a historical
   * `turn/end` is the one fact sync cannot observe after the fact. Without this
   * callback every turn created before the reload remains `interpreting` in the
   * read-only panel forever. The callback settles only the existing turn; it
   * never creates a session, turn, action, goal or receipt.
   */
  readonly settleTurn?: (sessionId: string, turn: number, reason: unknown) => void
  /**
   * Fast activation mode: replay only the session tail that can still be open.
   *
   * A conversation open used to feed every historical event of every session
   * through the trackers just to learn one prompt. With this flag, a session
   * whose last event is `turn/end` starts at the cursor without a replay, and an
   * open session is scanned backwards only until its latest `turn/start` and
   * user message. Live events keep the trackers complete from then on.
   */
  readonly openTurnsOnly?: boolean
}

/** Bounded outcome of one `recoverContext` call. */
export interface RecoveryStatus {
  /** Sessions whose log was replayed in this call. */
  readonly sessions: number
  /** Live agents enumerated in this call. */
  readonly agents: number
  /** Events replayed in this call (only new seqs after the first call). */
  readonly events: number
  /** Open-turn prompts handed to `WireCapture.hydrate` in this call. */
  readonly hydrations: number
  /** Recoverable failures; one bad event or entry counts once. */
  readonly failures: number
}

/** Mutable counters while a recovery pass runs. */
interface RecoveryCounters {
  sessions: number
  agents: number
  events: number
  hydrations: number
  failures: number
}

/**
 * Per-session replay cursor and open-turn state.
 *
 * `session` and `deps` are identity guards: a replaced session (same id, new
 * object) or a new tracker set (plugin reload on the same context) starts at
 * seq 0 again instead of suppressing the replay.
 */
interface SessionReplayState {
  readonly session: unknown
  readonly deps: RecoveryDeps
  lastSeq: number
  openTurn: number | undefined
  prompt: string
}

/** Lazily created per-context cursor map; the context key is weak. */
const statesByContext = new WeakMap<Context, Map<string, SessionReplayState>>()

/** A validated read-only view of one session log. */
interface SessionReader {
  readonly end: number
  readonly read: (seq: number) => unknown
}

/** Local guard shared by this module; recovery has no runtime imports. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Read a non-negative safe integer, or `undefined`. */
function optionalIntegerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Read one host service property defensively; an absent or broken service is empty. */
function readService(root: Record<string, unknown> | undefined, key: string, counters: RecoveryCounters): unknown {
  if (root === undefined) return undefined
  try {
    return root[key]
  } catch {
    counters.failures += 1
    return undefined
  }
}

/**
 * Read one service's `list()` defensively and stop at `limit`.
 *
 * A list longer than the limit is truncated to its first `limit` entries and
 * counts one failure, so enumeration is bounded but never silent.
 */
function readList(service: unknown, limit: number, counters: RecoveryCounters): readonly unknown[] {
  if (service === undefined || service === null) return []
  try {
    const record = asRecord(service)
    const list = record?.list
    if (typeof list !== 'function') return []
    const value = list.call(service)
    if (Array.isArray(value)) {
      if (value.length > limit) {
        counters.failures += 1
        return value.slice(0, limit)
      }
      return value
    }
    counters.failures += 1
  } catch {
    counters.failures += 1
  }
  return []
}

/** Add one session object under its id, keeping the first (live) candidate. */
function addSession(candidates: Map<string, unknown>, value: unknown, counters: RecoveryCounters): void {
  try {
    const record = asRecord(value)
    if (record === undefined) {
      counters.failures += 1
      return
    }
    const id = record.id
    if (typeof id !== 'string' || id.length === 0) {
      counters.failures += 1
      return
    }
    if (!candidates.has(id)) candidates.set(id, value)
  } catch {
    counters.failures += 1
  }
}

/** Validate `seq`/`eventAt` once and bind `eventAt` to its owning session. */
function readerOf(value: unknown): SessionReader | undefined {
  try {
    const record = asRecord(value)
    if (record === undefined) return undefined
    const end = optionalIntegerOf(record.seq)
    if (end === undefined) return undefined
    const eventAt = record.eventAt
    if (typeof eventAt !== 'function') return undefined
    return {
      end,
      read: (seq: number): unknown => eventAt.call(value, seq),
    }
  } catch {
    return undefined
  }
}

/** Run one tracker callback; a failure is counted, not propagated. */
function safely(run: () => void, counters: RecoveryCounters): void {
  try {
    run()
  } catch {
    counters.failures += 1
  }
}

/** Extract a human prompt from a `user/message` payload, or `undefined`. */
function userPromptOf(data: Record<string, unknown>): string | undefined {
  const source = data.source
  const kind = typeof source === 'string' ? source : asRecord(source)?.kind
  if (kind !== 'user') return undefined
  const content = data.content
  if (typeof content === 'string') return content.trim().length > 0 ? content : undefined
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (block === undefined) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const text = parts.join('\n')
  return text.trim().length > 0 ? text : undefined
}

/**
 * Feed one event to the trackers and advance the open-turn prompt state.
 *
 * @returns true when the event carried a new human prompt for the open turn.
 */
function replayEvent(
  sessionId: string,
  event: Record<string, unknown>,
  state: SessionReplayState,
  deps: RecoveryDeps,
  counters: RecoveryCounters,
): boolean {
  safely(() => deps.fork.observeEvent(sessionId, event), counters)
  safely(() => deps.subagent.observeEvent(sessionId, event), counters)
  safely(() => deps.spill.observe(sessionId, event), counters)
  safely(() => deps.retention.observe(sessionId, event), counters)
  safely(() => deps.prune.observe(sessionId, event), counters)
  safely(() => deps.compaction.observe(sessionId, event), counters)

  const type = event.type
  if (typeof type !== 'string') return false
  const data = asRecord(event.data)
  if (type === 'turn/start') {
    const turn = optionalIntegerOf(data?.turn)
    if (turn !== undefined) {
      state.openTurn = turn
      state.prompt = ''
    }
    return false
  }
  if (type === 'turn/end') {
    const turn = optionalIntegerOf(data?.turn)
    if (turn !== undefined) {
      safely(() => deps.settleTurn?.(sessionId, turn, data?.reason), counters)
    }
    state.openTurn = undefined
    state.prompt = ''
    return false
  }
  if (type !== 'user/message' || state.openTurn === undefined || data === undefined) return false
  const prompt = userPromptOf(data)
  if (prompt === undefined) return false
  state.prompt = prompt
  return true
}

/**
 * Fast activation replay: find the one open turn without feeding the whole log
 * through the trackers.
 *
 * A closed session ends in `turn/end`, so there is nothing to hydrate and the
 * cursor can advance to its end. An open session is scanned backwards until
 * the latest `turn/start`, collecting the newest user prompt on the way. This
 * turns a 50k-event replay into a bounded tail scan whose length is one turn.
 */
function replayOpenTurnOnly(
  sessionId: string,
  session: unknown,
  reader: SessionReader,
  deps: RecoveryDeps,
  states: Map<string, SessionReplayState>,
  counters: RecoveryCounters,
): void {
  const previous = states.get(sessionId)
  if (
    previous !== undefined &&
    previous.session === session &&
    previous.deps === deps &&
    previous.lastSeq === reader.end
  ) return

  const finish = (openTurn: number | undefined, prompt: string): void => {
    states.set(sessionId, { session, deps, lastSeq: reader.end, openTurn, prompt })
    if (openTurn === undefined || prompt.length === 0) return
    try {
      const pending = deps.capture.hydrate({
        sessionId,
        turn: openTurn,
        step: 0,
        prompt,
      })
      if (pending !== undefined) counters.hydrations += 1
    } catch {
      counters.failures += 1
    }
  }

  if (reader.end === 0) {
    finish(undefined, '')
    return
  }

  let last: unknown
  try {
    last = reader.read(reader.end - 1)
  } catch {
    counters.failures += 1
    return
  }
  const lastRecord = asRecord(last)
  if (lastRecord === undefined) {
    counters.failures += 1
    return
  }
  if (lastRecord.type === 'turn/end') {
    finish(undefined, '')
    return
  }

  let openTurn: number | undefined
  let prompt = ''
  for (let seq = reader.end - 1; seq >= 0; seq -= 1) {
    let event: unknown
    try {
      event = reader.read(seq)
    } catch {
      counters.failures += 1
      continue
    }
    const record = asRecord(event)
    if (record === undefined) {
      counters.failures += 1
      continue
    }
    counters.events += 1
    if (record.type === 'turn/start') {
      const data = asRecord(record.data)
      const turn = optionalIntegerOf(data?.turn)
      if (turn !== undefined) {
        openTurn = turn
        break
      }
      continue
    }
    if (record.type === 'user/message' && prompt.length === 0) {
      const data = asRecord(record.data)
      const value = data === undefined ? undefined : userPromptOf(data)
      if (value !== undefined) prompt = value
    }
  }
  finish(openTurn, prompt)
}

/** Replay one session's new seqs, then hydrate its open-turn prompt if changed. */
function replaySession(
  sessionId: string,
  session: unknown,
  deps: RecoveryDeps,
  states: Map<string, SessionReplayState>,
  counters: RecoveryCounters,
): void {
  const reader = readerOf(session)
  if (reader === undefined) {
    counters.failures += 1
    return
  }
  counters.sessions += 1

  if (deps.openTurnsOnly === true) {
    replayOpenTurnOnly(sessionId, session, reader, deps, states, counters)
    return
  }

  const previous = states.get(sessionId)
  const continuing =
    previous !== undefined &&
    previous.session === session &&
    previous.deps === deps &&
    previous.lastSeq <= reader.end
  const state: SessionReplayState = continuing
    ? previous
    : { session, deps, lastSeq: 0, openTurn: undefined, prompt: '' }
  if (!continuing) states.set(sessionId, state)

  // Defensive stop: never replay more than MAX_EVENTS_PER_SESSION new events
  // for one session in one pass. The newest window is kept so the open turn's
  // recent `turn/start` and prompt still replay; the skip is counted once.
  const firstSeq = Math.max(state.lastSeq, reader.end - MAX_EVENTS_PER_SESSION)
  if (reader.end - state.lastSeq > MAX_EVENTS_PER_SESSION) counters.failures += 1
  let touched = false
  for (let seq = firstSeq; seq < reader.end; seq += 1) {
    let event: unknown
    try {
      event = reader.read(seq)
    } catch {
      counters.failures += 1
      continue
    }
    const record = asRecord(event)
    if (record === undefined) {
      counters.failures += 1
      continue
    }
    counters.events += 1
    try {
      if (replayEvent(sessionId, record, state, deps, counters)) touched = true
    } catch {
      counters.failures += 1
    }
  }
  state.lastSeq = reader.end

  // Only a prompt seen for the still-open turn is hydrated. A closed turn is
  // deliberately left to the next `agent/pre-step`, so assembly does not show
  // the previous turn's prompt. When no new prompt arrived, the pending entry
  // from the previous pass is already authoritative.
  if (!touched || state.openTurn === undefined || state.prompt.length === 0) return
  try {
    const pending = deps.capture.hydrate({
      sessionId,
      turn: state.openTurn,
      step: 0,
      prompt: state.prompt,
    })
    if (pending !== undefined) counters.hydrations += 1
  } catch {
    counters.failures += 1
  }
}

/**
 * Keep one context's session cursor map bounded, evicting oldest insertions.
 *
 * The map is keyed weakly by context but lives across recovery passes; without
 * this cap a host that keeps exposing new session ids would grow it without
 * bound. An evicted session is simply replayed from seq 0 on a later pass.
 */
function trimStates(states: Map<string, SessionReplayState>): void {
  while (states.size > MAX_RECOVERY_SESSIONS) {
    const oldest = states.keys().next().value
    if (typeof oldest !== 'string') return
    states.delete(oldest)
  }
}

/**
 * Rebuild host-side state from live agents and the session logs.
 *
 * Sessions are deduplicated by id (a live agent's session is normally also in
 * `ctx.sessions.list()`), and a session already replayed in this context is
 * resumed from its last seq. The first call after activation replays the whole
 * log; later calls replay only new events. Enumeration and per-session replay
 * are hard-capped (see {@link MAX_RECOVERY_AGENTS}, {@link MAX_RECOVERY_SESSIONS}
 * and {@link MAX_EVENTS_PER_SESSION}); hitting a cap increments `failures` and
 * degrades the pass instead of throwing. Trackers are observed only after
 * history replay, and every failure is counted without interrupting the pass.
 *
 * @param ctx - the host context; missing `agents`/`sessions` degrade to empty.
 * @param deps - the tracker instances to rebuild.
 * @returns bounded counters for this pass; never throws.
 */
export function recoverContext(ctx: Context, deps: RecoveryDeps): RecoveryStatus {
  const counters: RecoveryCounters = { sessions: 0, agents: 0, events: 0, hydrations: 0, failures: 0 }
  try {
    const root = asRecord(ctx)
    const liveAgents = readList(readService(root, 'agents', counters), MAX_RECOVERY_AGENTS, counters)
    const listedSessions = readList(readService(root, 'sessions', counters), MAX_RECOVERY_SESSIONS, counters)

    const candidates = new Map<string, unknown>()
    for (const agent of liveAgents) {
      counters.agents += 1
      try {
        const session = asRecord(agent)?.session
        if (session !== undefined) addSession(candidates, session, counters)
      } catch {
        counters.failures += 1
      }
    }
    for (const session of listedSessions) addSession(candidates, session, counters)

    let states = statesByContext.get(ctx)
    if (states === undefined) {
      states = new Map<string, SessionReplayState>()
      statesByContext.set(ctx, states)
    }
    for (const [sessionId, session] of candidates) {
      replaySession(sessionId, session, deps, states, counters)
    }
    // Bounded across calls even when agents and sessions together expose more
    // unique ids than one service enumeration cap allows.
    trimStates(states)

    // History first: a delegation task created now must not be settled by the
    // inherited `turn/end` events that were just replayed.
    for (const agent of liveAgents) {
      safely(() => deps.fork.observeAgent(agent), counters)
      safely(() => deps.subagent.observeAgent(agent), counters)
    }
  } catch {
    counters.failures += 1
  }
  return {
    sessions: counters.sessions,
    agents: counters.agents,
    events: counters.events,
    hydrations: counters.hydrations,
    failures: counters.failures,
  }
}
