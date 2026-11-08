/**
 * `agent/pre-step` input capture.
 *
 * DSH dispatches `agent/pre-step` as a waterfall. The listener in `index.ts`
 * calls `next()` first, then hands the final `decision.messages` batch to this
 * capture. The capture is intentionally small for P0: it extracts the current
 * user prompt, keeps a bounded summary of the batch, and exposes extractor and
 * hook extension points for the P1 channels. It never implements @file,
 * attachment, @session, steer or inject parsing itself.
 *
 * Every method is fail-open. A malformed message, a hostile getter or a broken
 * extractor is recorded in `errors`/`status()` and never thrown into the DSH
 * step. The concrete DSH batch is `UserMessage[]` (`role: 'user'`, `source`, and
 * `content: ContentBlock[]`), but this entry point deliberately takes `unknown`
 * so the narrowing itself cannot throw. This module has no runtime imports (the
 * only import is type-only), so it can be unit-tested directly with Node's
 * TypeScript type stripping.
 */
import type { WireItem } from './wire.js'

/** Maximum number of session/turn pending entries kept in memory. */
export const DEFAULT_MAX_PENDING = 64

/** Maximum prompt characters retained for one turn. */
export const MAX_PROMPT_CHARS = 4000

/** Message summaries retained per capture (the tail of the batch). */
export const MAX_MESSAGE_SUMMARIES = 24

/** The turn/step position the pre-step payload reported. */
export interface CaptureContext {
  readonly turn?: number
  readonly step?: number
}

/** A bounded, text-free summary of one message in the captured batch. */
export interface CapturedMessageSummary {
  readonly role: string
  readonly source: string
  readonly textChars: number
  readonly blocks: number
}

/**
 * The input captured for one session/turn.
 *
 * `prompt` is the latest non-empty user prompt observed for the turn. A
 * continuation step that claims no user message inherits the prompt captured
 * earlier in the same turn, so the prompt item does not disappear after step
 * one. `messages` describes only the batch claimed for this step.
 */
export interface PendingInput {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly capturedAt: string
  readonly prompt: string
  /** Bounded summary of this step's claimed batch; not the full history. */
  readonly messages: readonly CapturedMessageSummary[]
  /** Wire items produced by registered extractors; empty in P0. */
  readonly items: readonly WireItem[]
  readonly errors: readonly string[]
}

/**
 * Input for {@link WireCapture.hydrate}: a pending prompt recovered from an
 * already-open turn's log after plugin reload. No capture batch is available,
 * so `messages`, `items` and `errors` stay empty.
 */
export interface HydrateInput {
  readonly sessionId: string
  readonly turn: number
  readonly step?: number
  readonly prompt: string
  /** ISO timestamp override; defaults to the capture clock. */
  readonly at?: string
}

/** Input handed to each registered extractor. */
export interface CaptureExtractorInput {
  readonly agent: unknown
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly messages: readonly unknown[]
  readonly prompt: string
}

/**
 * Extension point for P1 channels.
 *
 * An extractor returns zero or more wire items. It must not throw for ordinary
 * malformed input; if it does, the failure is recorded and the capture
 * continues. Extractors run synchronously and must not perform I/O or await.
 */
export interface CaptureExtractor {
  readonly name: string
  extract(input: CaptureExtractorInput): readonly WireItem[] | void
}

/** Observer called after one PendingInput is built. */
export type CaptureHook = (pending: PendingInput) => void

/** Construction options; both exist mainly for deterministic tests. */
export interface WireCaptureOptions {
  /** Maximum pending session/turn entries; defaults to {@link DEFAULT_MAX_PENDING}. */
  readonly maxEntries?: number
  /** Clock override; defaults to `() => new Date()`. */
  readonly now?: () => Date
}

/** Bounded status view of the last capture. */
export interface CaptureSummary {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly capturedAt: string
  readonly promptChars: number
  readonly messages: number
  readonly items: number
  readonly errors: number
}

/** Safe, allocation-bounded status returned by {@link WireCapture.status}. */
export interface WireCaptureStatus {
  readonly pending: number
  readonly maxEntries: number
  readonly captured: number
  readonly invalidated: number
  readonly cleared: number
  readonly evicted: number
  readonly failures: number
  readonly errors: readonly string[]
  readonly lastCapture?: CaptureSummary
}

/** Local guard: the shared helper lives in `json.ts`, which this module must
 * not import at runtime so it stays directly importable by Node tests. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unknown error'
  }
}

function integerOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

function optionalIntegerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function roleOf(message: Record<string, unknown>): string {
  if (typeof message.role === 'string') return message.role
  if (typeof message.type === 'string') return message.type
  return ''
}

function sourceKindOf(message: Record<string, unknown>): string {
  if (typeof message.source === 'string') return message.source
  const source = asRecord(message.source)
  return typeof source?.kind === 'string' ? source.kind : ''
}

function contentParts(content: unknown): { text: string; blocks: number } {
  if (typeof content === 'string') return { text: content, blocks: 1 }
  if (!Array.isArray(content)) return { text: '', blocks: 0 }
  const parts: string[] = []
  let blocks = 0
  for (const raw of content) {
    const block = asRecord(raw)
    if (block === undefined) continue
    blocks += 1
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return { text: parts.join('\n'), blocks }
}

function boundedPrompt(value: string): string {
  const text = value.trim()
  return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}…` : text
}

function keyOf(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`
}

interface BatchRead {
  /** Last user-role message explicitly sourced as `user`; authoritative. */
  readonly strong: string
  /** Last user-role message with no source metadata (fakes/older paths). */
  readonly weak: string
  readonly summaries: readonly CapturedMessageSummary[]
}

/**
 * Read the claimed batch defensively.
 *
 * Only a user-role message explicitly sourced as `user` is authoritative.
 * Host, plugin and session-reference sources are never promoted to the prompt.
 * A message with no source at all is a weak fallback used only when the turn has
 * no previously captured prompt; this keeps a later plugin notice from
 * overwriting the prompt that started the turn.
 */
function readBatch(messages: readonly unknown[], errors: string[]): BatchRead {
  const summaries: CapturedMessageSummary[] = []
  let strong = ''
  let weak = ''
  const tailStart = Math.max(0, messages.length - MAX_MESSAGE_SUMMARIES)
  for (let index = 0; index < messages.length; index += 1) {
    try {
      const message = asRecord(messages[index])
      if (message === undefined) continue
      const role = roleOf(message)
      const source = sourceKindOf(message)
      const nearTail = index >= tailStart
      let text = ''
      let blocks = 0
      if (role === 'user' || nearTail) {
        const parts = contentParts(message.content)
        text = parts.text
        blocks = parts.blocks
      } else {
        const content = message.content
        blocks = Array.isArray(content) ? content.length : typeof content === 'string' ? 1 : 0
      }
      if (nearTail) summaries.push({ role, source, textChars: text.length, blocks })
      if (role !== 'user' || text.trim().length === 0) continue
      if (source === 'user') strong = text
      else if (source === '') weak = text
    } catch (error) {
      errors.push(`message ${index}: ${messageOf(error)}`)
    }
  }
  return { strong: boundedPrompt(strong), weak: boundedPrompt(weak), summaries }
}

/**
 * Capture and retain the `agent/pre-step` input for one session/turn.
 *
 * The map is bounded to {@link DEFAULT_MAX_PENDING} session/turn entries;
 * inserting a new entry evicts the least recently captured one. `capture` is
 * synchronous, performs no I/O and never throws.
 */
export class WireCapture {
  /** P1 channel extractors; append to this array to contribute wire items. */
  readonly extractors: CaptureExtractor[] = []

  /** Optional observer, called after each successful capture attempt. */
  onCapture?: CaptureHook

  private readonly maxEntries: number
  private readonly now: () => Date
  private readonly pending = new Map<string, PendingInput>()
  private readonly failures: string[] = []
  private lastCapture: CaptureSummary | undefined
  private captured = 0
  private invalidated = 0
  private cleared = 0
  private evicted = 0

  constructor(options: WireCaptureOptions = {}) {
    this.maxEntries = integerOf(options.maxEntries, DEFAULT_MAX_PENDING) || DEFAULT_MAX_PENDING
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
  }

  /**
   * Capture the final pre-step batch.
   *
   * @param agent - the live DSH agent; only `id` is read.
   * @param messages - `decision.messages`; unknown values are narrowed.
   * @param context - the waterfall payload's turn and step.
   * @returns the retained PendingInput (also returned when it was not stored).
   */
  capture(agent: unknown, messages: unknown, context?: CaptureContext): PendingInput {
    const errors: string[] = []
    let sessionId = ''
    let turn = 0
    let step = 0

    try {
      const record = asRecord(agent)
      sessionId = typeof record?.id === 'string' ? record.id : ''
      if (sessionId.length === 0) errors.push('agent has no session id')
    } catch (error) {
      errors.push(`agent: ${messageOf(error)}`)
    }

    try {
      const position = asRecord(context)
      turn = integerOf(position?.turn, 0)
      step = integerOf(position?.step, 0)
    } catch (error) {
      errors.push(`context: ${messageOf(error)}`)
    }

    let batch: readonly unknown[] = []
    if (Array.isArray(messages)) batch = messages
    else if (messages !== undefined) errors.push('messages is not an array')

    let prompt = ''
    let weakPrompt = ''
    let summaries: readonly CapturedMessageSummary[] = []
    try {
      const read = readBatch(batch, errors)
      prompt = read.strong
      weakPrompt = read.weak
      summaries = read.summaries
    } catch (error) {
      errors.push(`batch: ${messageOf(error)}`)
    }

    const key = keyOf(sessionId, turn)
    const previous = sessionId.length === 0 ? undefined : this.pending.get(key)
    const effectivePrompt = prompt.length > 0 ? prompt : previous?.prompt ?? weakPrompt

    const items: WireItem[] = []
    for (const extractor of this.extractors) {
      try {
        const produced = extractor.extract({
          agent,
          sessionId,
          turn,
          step,
          messages: batch,
          prompt: effectivePrompt,
        })
        if (produced === undefined) continue
        if (!Array.isArray(produced)) {
          errors.push(`extractor ${extractor.name}: returned a non-array`)
          continue
        }
        for (const item of produced) items.push(item)
      } catch (error) {
        errors.push(`extractor ${extractor.name}: ${messageOf(error)}`)
      }
    }

    let capturedAt = ''
    try {
      capturedAt = this.now().toISOString()
    } catch (error) {
      errors.push(`clock: ${messageOf(error)}`)
      capturedAt = new Date(0).toISOString()
    }

    const pending: PendingInput = {
      sessionId,
      turn,
      step,
      capturedAt,
      prompt: effectivePrompt,
      messages: summaries,
      items,
      errors,
    }

    if (sessionId.length > 0) this.remember(key, pending)
    this.captured += 1
    this.lastCapture = {
      sessionId,
      turn,
      step,
      capturedAt,
      promptChars: effectivePrompt.length,
      messages: summaries.length,
      items: items.length,
      errors: errors.length,
    }

    if (this.onCapture !== undefined) {
      try {
        this.onCapture(pending)
      } catch (error) {
        this.recordFailure('onCapture', error)
      }
    }
    return pending
  }

  /**
   * Seed the pending input for one already-open turn from a session log.
   *
   * Recovery uses this after plugin reload: the log carries the user prompt but
   * no pre-step batch. The entry is stored in the same bounded map `capture`
   * uses, so the next assembly reads it and the next real capture inherits the
   * prompt. An existing entry with a prompt is never replaced (the first
   * capture, or an earlier recovery, is authoritative); a prompt-less entry is.
   *
   * @param input - session/turn identity plus the recovered prompt.
   * @returns the retained pending input, or `undefined` when the input is
   *   invalid; never throws.
   */
  hydrate(input: HydrateInput): PendingInput | undefined {
    try {
      const record = asRecord(input)
      if (record === undefined) return undefined
      const sessionId = record.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const turn = optionalIntegerOf(record.turn)
      if (turn === undefined) return undefined
      const prompt = boundedPrompt(typeof record.prompt === 'string' ? record.prompt : '')
      if (prompt.length === 0) return undefined
      const step = integerOf(record.step, 0)

      const key = keyOf(sessionId, turn)
      const previous = this.pending.get(key)
      if (previous !== undefined && previous.prompt.length > 0) return previous

      let capturedAt = ''
      const at = record.at
      if (typeof at === 'string' && at.length > 0) {
        capturedAt = at
      } else {
        try {
          capturedAt = this.now().toISOString()
        } catch (error) {
          this.recordFailure('hydrate', error)
          capturedAt = new Date(0).toISOString()
        }
      }

      const pending: PendingInput = {
        sessionId,
        turn,
        step,
        capturedAt,
        prompt,
        messages: [],
        items: [],
        errors: [],
      }
      this.remember(key, pending)
      return pending
    } catch (error) {
      this.recordFailure('hydrate', error)
      return undefined
    }
  }

  /** The pending input captured for one session/turn, if any. */
  pendingFor(sessionId: string, turn: number): PendingInput | undefined {
    return this.pending.get(keyOf(sessionId, turn))
  }

  /** Drop one turn's pending input; used when a capture is known to be stale. */
  invalidate(sessionId: string, turn: number): void {
    if (this.pending.delete(keyOf(sessionId, turn))) this.invalidated += 1
  }

  /** Turn-end cleanup: drop the pending input retained for that turn. */
  clearTurn(sessionId: string, turn: number): void {
    if (this.pending.delete(keyOf(sessionId, turn))) this.cleared += 1
  }

  /** Record a failure that happened outside `capture` (for example wiring). */
  recordFailure(label: string, error: unknown): void {
    this.failures.push(`${label}: ${messageOf(error)}`)
    while (this.failures.length > 20) this.failures.shift()
  }

  /** Safe status for `/amp/context` and diagnostics; never throws. */
  status(): WireCaptureStatus {
    return {
      pending: this.pending.size,
      maxEntries: this.maxEntries,
      captured: this.captured,
      invalidated: this.invalidated,
      cleared: this.cleared,
      evicted: this.evicted,
      failures: this.failures.length,
      errors: this.failures.slice(),
      ...(this.lastCapture === undefined ? {} : { lastCapture: this.lastCapture }),
    }
  }

  /** Insert and evict the oldest entry; re-insertion refreshes recency. */
  private remember(key: string, pending: PendingInput): void {
    this.pending.delete(key)
    this.pending.set(key, pending)
    while (this.pending.size > this.maxEntries) {
      const oldest = this.pending.keys().next().value
      if (typeof oldest !== 'string') break
      this.pending.delete(oldest)
      this.evicted += 1
    }
  }
}
