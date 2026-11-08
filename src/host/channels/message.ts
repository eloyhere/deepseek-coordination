/**
 * Steer / inject input channel.
 *
 * `agent.steer()` and `agent.inject()` put user-role messages into the same
 * `agent/pre-step` batch as ordinary prompts. This extractor classifies them
 * without copying their body into the attention envelope: a steer becomes a
 * high-priority index entry, host-injected context is skipped, and any other
 * plugin-sourced message becomes a lower-trust `inject` entry.
 *
 * Heuristics (documented in the P1 report):
 *  - `source.kind === 'user'` and `step > 1` is a steer: it can only have been
 *    admitted after the turn's first step.
 *  - `source.kind === 'user'` and `step <= 1` is the ordinary prompt P0 already
 *    captures; it is skipped here.
 *  - any other source kind is plugin context. DSH's own injected sources are
 *    skipped, as are `amp:` self-injections (feedback-loop guard).
 */
import type { CaptureExtractor, CaptureExtractorInput } from '../prestep.js'
import type { WireItem } from '../wire.js'
import {
  isUserRole,
  messageIdOf,
  safeSlot,
  scoresOf,
  sourceKindOf,
  stepExpiry,
  textOfMessage,
  turnExpiry,
  wireItem,
} from './shared.js'

/** Candidate cap per class, matching the steer/inject channel budgets. */
export const MAX_MESSAGE_ITEMS = 4

/** First characters quoted in a steer summary. */
export const STEER_SUMMARY_CHARS = 200

/** First characters quoted in an inject summary. */
export const INJECT_SUMMARY_CHARS = 160

/**
 * DSH sources that inject host context rather than user/plugin intent.
 *
 * This mirrors the host-injected vocabulary P0 relies on. It is a local copy on
 * purpose: `prestep.ts` owns the capture contract and stays untouched by P1.
 * The list is a lower bound — unknown plugin kinds are still classified as
 * inject, which is the intended fail-open behavior for a new producer.
 */
export const HOST_INJECTED_SOURCES: readonly string[] = [
  'agent-instructions',
  'time-context',
  'session-reference',
  'amp',
  'runtime-context',
  'compaction',
  'reminder',
  'system',
]

/** Bound one-line summary text, without newlines inflating the envelope. */
function excerpt(text: string, limit: number): string {
  return text.slice(0, limit).replaceAll('\n', ' ').replaceAll('\r', ' ')
}

/** Whether a source kind is host-injected or an AMP self-injection. */
export function isHostInjected(kind: string): boolean {
  return HOST_INJECTED_SOURCES.includes(kind) || kind.startsWith('amp:')
}

/**
 * Extract `steer` and `inject` wire items from one pre-step batch.
 *
 * The slot uses the message's position in the batch (`steer-<index>` /
 * `inject-<index>`), which is stable for the step that admitted it. Empty
 * texts and the ordinary first-step prompt are skipped; a plugin injection
 * whose text exactly repeats `input.prompt` is skipped as a duplicate. The
 * pointer carries the DSH message id when available and never the body.
 */
export function extractMessageItems(input: CaptureExtractorInput): readonly WireItem[] {
  const items: WireItem[] = []
  try {
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return items
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    const steerExpiry = turnExpiry()
    const injectExpiry = stepExpiry()
    let steers = 0
    let injects = 0
    for (let index = 0; index < input.messages.length; index += 1) {
      if (steers >= MAX_MESSAGE_ITEMS && injects >= MAX_MESSAGE_ITEMS) break
      const message = input.messages[index]
      if (!isUserRole(message)) continue
      const text = textOfMessage(message).trim()
      if (text.length === 0) continue
      const kind = sourceKindOf(message)
      // A steer is never dropped for matching `input.prompt`: on a later step
      // P0 promotes the newly claimed message itself to the effective prompt,
      // so comparing a steer with the prompt would discard every single-steer
      // batch. The prompt-equality filter therefore applies to plugin context
      // only, where the prompt is the turn's original user text.
      if (kind === 'user') {
        if (input.step <= 1 || steers >= MAX_MESSAGE_ITEMS) continue
        const slot = safeSlot('steer', index)
        const item = wireItem(input.agent, input.sessionId, input.turn, {
          channel: 'steer',
          slot,
          pointer: {
            kind: 'message',
            id: messageIdOf(message) ?? slot,
            version: `turn:${String(input.turn)}:step:${String(input.step)}`,
          },
          summary: `steer: ${excerpt(text, STEER_SUMMARY_CHARS)}`,
          scores: scoresOf(1, 1, 1, 0.9),
          expiresAt: steerExpiry,
          reason: 'the user steered the turn before this step',
          trust: 'user',
        })
        if (item === undefined) continue
        steers += 1
        items.push(item)
        continue
      }
      if (kind.length === 0 || isHostInjected(kind) || injects >= MAX_MESSAGE_ITEMS) continue
      if (prompt.length > 0 && text === prompt) continue
      const slot = safeSlot('inject', index)
      const item = wireItem(input.agent, input.sessionId, input.turn, {
        channel: 'inject',
        slot,
        pointer: {
          kind: 'message',
          id: messageIdOf(message) ?? slot,
          version: `turn:${String(input.turn)}:step:${String(input.step)}`,
        },
        summary: `injected by ${kind}: ${excerpt(text, INJECT_SUMMARY_CHARS)}`,
        scores: scoresOf(0.7, 0.2, 0.8, 0.6),
        expiresAt: injectExpiry,
        reason: `the ${kind} plugin injected context for this step`,
        trust: 'derived',
      })
      if (item === undefined) continue
      injects += 1
      items.push(item)
    }
  } catch {
    // Fail-open: a malformed batch contributes no steer/inject items.
  }
  return items
}

/** The `message` channel extractor registered by `registerInputExtractors`. */
export const messageExtractor: CaptureExtractor = {
  name: 'message',
  extract: extractMessageItems,
}
