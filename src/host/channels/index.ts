/**
 * Registration of the P1 input channels on the P0 capture seam.
 *
 * `WireCapture.extractors` is the only integration point: each extractor maps
 * the final `agent/pre-step` batch to `WireItem[]`, and `AmpContextOptimizer`
 * merges `PendingInput.items` into the compiled attention package without
 * further wiring. Registration is idempotent per capture instance and also
 * skips a channel whose extractor name is already present, so a double module
 * instance cannot duplicate items.
 */
import type { WireCapture } from '../prestep.js'
import { attachmentExtractor } from './attachment.js'
import { fileExtractor } from './file.js'
import { messageExtractor } from './message.js'
import { sessionExtractor } from './session.js'

/**
 * The P1 extractors in registration order: file, attachment, session, message.
 *
 * Exported for tests and for P2/P3 code that needs to reason about the set
 * without re-registering it.
 */
export const INPUT_EXTRACTORS = [
  fileExtractor,
  attachmentExtractor,
  sessionExtractor,
  messageExtractor,
] as const

/** Captures that already received the extractor set. */
const registered = new WeakSet<WireCapture>()

/**
 * Append the four P1 extractors to a capture instance.
 *
 * Idempotent: calling it twice (or from a second copy of this module) does not
 * duplicate an extractor. Fail-open: a malformed capture is ignored rather than
 * breaking plugin activation.
 */
export function registerInputExtractors(capture: WireCapture): void {
  try {
    if (registered.has(capture)) return
    const present = new Set<string>(capture.extractors.map((extractor) => extractor.name))
    const pending = INPUT_EXTRACTORS.filter((extractor) => !present.has(extractor.name))
    if (pending.length > 0) capture.extractors.push(...pending)
    registered.add(capture)
  } catch {
    // The capture contract is P0's; a broken instance cannot be repaired here.
  }
}

export { attachmentExtractor, fileExtractor, messageExtractor, sessionExtractor }
