/**
 * The Compact module (v23 §6.4, §11.6).
 *
 * `/compact 摘要` asks DSH to compact the current context and records what
 * happened so the UI and the audit trail can show the effect. The plugin never
 * fabricates a compaction: without the live DSH compaction port (and the live
 * agent it needs) the module raises NotImplementedError instead of inventing a
 * before/after pair.
 *
 * A real compaction rewrites the model-visible prefix, so the prefix cache is
 * always invalid after one: `CompactResult.cacheBroken` is true and the row
 * records the strategy, the sizes and the resulting ratio.
 */
import type { Compact, CompactResult, Turn } from '../shared/entity.js'
import type { ModuleHost } from './module.js'
import { clamp } from './module.js'
import { mapCompact, mapTurn, text } from './row.js'
import type { Row } from './row.js'
import {
  CoordinationError,
  InvalidArgumentError,
  InvalidStateError,
  NotImplementedError,
} from '../shared/error.js'

const TERMINAL_TURN = new Set(['done', 'failed', 'cancelled', 'abandoned'])

/** The three compaction strategies of v23 §11.6. */
export type CompactStrategy = 'summary' | 'prune' | 'hybrid'

/** English and Chinese strategy words accepted after the `/compact` prefix. */
const STRATEGY_WORD: Readonly<Record<string, CompactStrategy>> = {
  summary: 'summary',
  prune: 'prune',
  hybrid: 'hybrid',
  摘要: 'summary',
  裁剪: 'prune',
  混合: 'hybrid',
}

/** The strategy that is used when the command carries no recognised word. */
const DEFAULT_STRATEGY: CompactStrategy = 'hybrid'

export class CompactModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /** Run the `/compact` command: word → strategy, then a real compaction. */
  async execute(turn: number, content: string): Promise<CompactResult> {
    const strategy = strategyOf(content)
    const compact = await this.compress(turn, strategy)
    return { compact, cacheBroken: true }
  }

  /**
   * Compact the current context through DSH and record the result. Both the
   * compaction port and a live agent are required; otherwise nothing is
   * recorded and NotImplementedError is raised.
   */
  async compress(turn: number, strategy: CompactStrategy): Promise<Compact> {
    assertStrategy(strategy)
    const current = this.writableTurn(turn)
    const compaction = this.host.compaction
    const agents = this.host.agents
    if (compaction === undefined || agents === undefined) {
      throw new NotImplementedError('DSH compaction port')
    }

    const session = this.host.db.require<Row>('session', current.session, 'session')
    const handle = text(session, 'handle')
    if (handle.length === 0) {
      throw new InvalidStateError('session has no DSH handle; a live agent cannot be resolved', {
        session: current.session,
      })
    }
    const agent = agents.get(handle)
    if (agent === undefined) {
      throw new NotImplementedError('DSH compaction port')
    }

    const timeout = this.host.config.clarifyTimeout
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeout))
    let result: unknown
    try {
      result = await compaction.compactNow(agent, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new InvalidStateError(`DSH compaction timed out after ${timeout}ms`, { turn, timeout })
      }
      if (error instanceof CoordinationError) throw error
      throw new InvalidStateError(`DSH compaction failed: ${messageOf(error)}`, { turn })
    } finally {
      clearTimeout(timer)
    }

    const snapshot = readSnapshot(result)
    const beforeSize = snapshot.before.length
    const afterSize = snapshot.after.length
    if (beforeSize === 0 && afterSize === 0) {
      throw new InvalidStateError('DSH compaction returned no recordable text', { turn, strategy })
    }
    // after/before; a missing before cannot be divided by zero, so the ratio is
    // recorded as unchanged (1) and every real ratio is clamped to 0…1.
    const ratio = beforeSize === 0 ? 1 : clamp(afterSize / beforeSize, 0, 1)
    const created = this.host.clock.now()
    const identity = this.host.db.transaction(() => {
      const row = this.host.db.insert('compact', {
        handle: this.host.handles.next('compact'),
        turn: current.identity,
        session: current.session,
        beforeContent: snapshot.before,
        afterContent: snapshot.after,
        beforeSize,
        afterSize,
        ratio,
        strategy,
        reason: snapshot.reason ?? 'command',
        created,
      })
      this.host.db.update('turn', { compact: row }, 'identity = ?', current.identity)
      return row
    })
    return this.get(identity)
  }

  /** One compaction row by identity. */
  get(identity: number): Compact {
    return mapCompact(this.host.db.require<Row>('compact', identity, 'compact'))
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

interface CompactionSnapshot {
  before: string
  after: string
  reason?: string
}

/**
 * Defensively read the port's `unknown` result. A `{ before, after, reason }`
 * shape is used when present; any other value is serialised as the after text
 * (JSON for objects, String for the rest), so no DSH payload is assumed.
 */
function readSnapshot(result: unknown): CompactionSnapshot {
  const record = asRecord(result)
  if (record !== undefined) {
    const hasBefore = Object.hasOwn(record, 'before')
    const hasAfter = Object.hasOwn(record, 'after')
    if (hasBefore || hasAfter) {
      const before = hasBefore ? portText(record.before) : ''
      const after = hasAfter ? portText(record.after) : portText(result)
      const reason =
        typeof record.reason === 'string' && record.reason.length > 0 ? record.reason : undefined
      return { before, after, ...(reason === undefined ? {} : { reason }) }
    }
  }
  return { before: '', after: portText(result) }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Turn a port value into recordable text without trusting its shape. */
function portText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? String(value) : encoded
  } catch {
    return String(value)
  }
}

/** Read the strategy word that follows the prefix; anything else is hybrid. */
function strategyOf(content: unknown): CompactStrategy {
  if (typeof content !== 'string') {
    throw new InvalidArgumentError('compact content must be a string', { received: typeof content })
  }
  const token = content.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return STRATEGY_WORD[token] ?? DEFAULT_STRATEGY
}

function assertStrategy(strategy: unknown): asserts strategy is CompactStrategy {
  if (strategy !== 'summary' && strategy !== 'prune' && strategy !== 'hybrid') {
    throw new InvalidArgumentError(`unknown compact strategy: ${String(strategy)}`, {
      allowed: ['summary', 'prune', 'hybrid'],
    })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
