/**
 * Optional AMP compaction backend wrapper.
 *
 * This module is deliberately separate from `compaction.ts`: importing it pulls
 * in `@deepseek-ai/dsh-compaction`, while the tracker and the rest of the host
 * plugin must load even in profiles that do not mount a compaction backend.
 * A composition that replaces `ctx.compaction` imports this module explicitly.
 */
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { CompactionTracker } from './compaction.js'

/**
 * Compaction backend wrapper that delegates to a real engine.
 *
 * It owns no summarization, retention policy or event writing: every abstract
 * operation forwards its exact arguments and returns the delegate's result, so
 * the ordinary `compaction/start|summary|end` events keep being appended by
 * the real backend and {@link CompactionTracker} observes them through
 * `session/event`.
 *
 * This class registers itself as `ctx.compaction` through the Cordis
 * `Service` constructor. It must therefore be used only by a composition that
 * deliberately replaces the base compaction backend, never registered
 * alongside it.
 */
export class AmpCompactionBackend extends CompactionEngine {
  private readonly delegate: CompactionEngine
  /**
   * The tracker this backend is paired with.
   *
   * The backend never feeds it directly: the real delegate appends the
   * `compaction/*` events and the composition's `session/event` listener
   * observes them, so a record reflects the durable log rather than a
   * forwarding call.
   */
  readonly tracker: CompactionTracker

  /**
   * @param ctx - Cordis context that owns the `compaction` service.
   * @param delegate - the real backend that performs compaction.
   * @param tracker - tracker fed by this composition's `session/event` listener.
   */
  constructor(ctx: Context, delegate: CompactionEngine, tracker: CompactionTracker) {
    super(ctx)
    this.delegate = delegate
    this.tracker = tracker
  }

  /** Forward automatic compaction; policy stays in the delegate. */
  compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    return this.delegate.compactIfNeeded(agent, trigger, signal)
  }

  /** Forward an explicit idle-session compaction, preserving `sourceCommandId`. */
  compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null> {
    return this.delegate.compactNow(agent, signal, sourceCommandId)
  }

  /** Forward a forced region compaction, preserving the optional cancellation signal. */
  compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult> {
    return this.delegate.compactRegion(start, end, agent, signal)
  }
}

/**
 * Build the AMP compaction wrapper without registering it.
 *
 * Constructing this instance is enough for Cordis to expose it as
 * `compaction`, so callers must first dispose or replace the base service.
 */
export function createAmpCompactionBackend(
  ctx: Context,
  delegate: CompactionEngine,
  tracker: CompactionTracker,
): AmpCompactionBackend {
  return new AmpCompactionBackend(ctx, delegate, tracker)
}
