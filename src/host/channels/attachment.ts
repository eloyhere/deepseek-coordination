/**
 * Attachment input channel (`image` / `file` content blocks).
 *
 * The user's images and files are already admitted and persisted by DSH before
 * a message exists. This extractor reads only the durable reference metadata
 * (`attachmentId`, byte size, intrinsic dimensions, display name and the
 * optional offload flag); it never touches base64 or attachment bytes.
 *
 * One wire item describes one message's whole attachment group, not one item
 * per image, so an expensive multi-image prompt does not multiply into several
 * near-identical attention entries.
 */
import type { CaptureExtractor, CaptureExtractorInput } from '../prestep.js'
import type { WireItem } from '../wire.js'
import {
  asRecord,
  formatBytes,
  isUserRole,
  oneLine,
  safeSlot,
  scoresOf,
  sessionExpiry,
  wireItem,
} from './shared.js'

/** Candidate cap for the attachment channel: four message groups per turn. */
export const MAX_ATTACHMENT_GROUPS = 4

/** One image or file reference read from a message's content blocks. */
export interface AttachmentPart {
  readonly kind: 'image' | 'file'
  readonly id: string
  readonly name: string
  readonly bytes: number
  readonly width?: number
  readonly height?: number
  readonly offloaded: boolean
}

/** Non-negative integer from untyped input, or `undefined`. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

/** Display name from the reference, bounded to its own text. */
function nameOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? oneLine(value) : fallback
}

/**
 * Read the attachment reference of one content block.
 *
 * An `image` block yields dimensions and the offload marker; a `file` block
 * yields its display name. Blocks without a usable `attachmentId` or byte size
 * are skipped. Base64 fields are never read.
 */
function partOf(block: Record<string, unknown>): AttachmentPart | undefined {
  try {
    const reference = asRecord(block.attachment)
    if (reference === undefined) return undefined
    const id = reference.attachmentId
    if (typeof id !== 'string' || id.length === 0) return undefined
    const bytes = countOf(reference.bytes)
    if (bytes === undefined) return undefined
    if (block.type === 'image') {
      const width = countOf(reference.width)
      const height = countOf(reference.height)
      if (width === undefined || height === undefined || width === 0 || height === 0) return undefined
      const offloaded = block.offloaded === true || reference.offloaded === true
      return {
        kind: 'image',
        id,
        name: nameOf(reference.name, 'image'),
        bytes,
        width,
        height,
        offloaded,
      }
    }
    if (block.type === 'file') {
      return { kind: 'file', id, name: nameOf(reference.name, 'file'), bytes, offloaded: false }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Collect the attachment parts of one message, in block order.
 *
 * Identical attachment ids inside one message are kept once; a repeated block
 * is the same durable object, not a second attachment.
 */
export function attachmentsOf(message: unknown): readonly AttachmentPart[] {
  const parts: AttachmentPart[] = []
  try {
    if (!isUserRole(message)) return parts
    const content = asRecord(message)?.content
    if (!Array.isArray(content)) return parts
    const seen = new Set<string>()
    for (const raw of content) {
      const block = asRecord(raw)
      if (block === undefined) continue
      if (block.type !== 'image' && block.type !== 'file') continue
      const part = partOf(block)
      if (part === undefined || seen.has(part.id)) continue
      seen.add(part.id)
      parts.push(part)
    }
  } catch {
    return parts
  }
  return parts
}

/** One summary segment: `image foo.png 800x600 84 KB (offloaded)`. */
function describePart(part: AttachmentPart): string {
  if (part.kind === 'image') {
    const size = formatBytes(part.bytes)
    const offload = part.offloaded ? ' (offloaded)' : ''
    return `image ${part.name} ${String(part.width ?? 0)}x${String(part.height ?? 0)} ${size}${offload}`
  }
  return `file ${part.name} ${formatBytes(part.bytes)}`
}

/**
 * Extract one `attachment` wire item per message group.
 *
 * The pointer names the group's first attachment (the wire envelope has one
 * pointer per item) and uses `sha256:<attachmentId>` for files — DSH's file
 * attachment id is the sha256 of the stored bytes — or `bytes:<n>` for images.
 * Every attachment in the group is listed in the summary.
 */
export function extractAttachmentItems(input: CaptureExtractorInput): readonly WireItem[] {
  const items: WireItem[] = []
  try {
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return items
    const expiresAt = sessionExpiry()
    for (const message of input.messages) {
      if (items.length >= MAX_ATTACHMENT_GROUPS) break
      const parts = attachmentsOf(message)
      if (parts.length === 0) continue
      const first = parts[0]
      if (first === undefined) continue
      const item = wireItem(input.agent, input.sessionId, input.turn, {
        channel: 'attachment',
        slot: safeSlot('attachment', items.length + 1),
        pointer: {
          kind: 'attachment',
          id: first.id,
          version: first.kind === 'file' ? `sha256:${first.id}` : `bytes:${String(first.bytes)}`,
          uri: `dsh-attachment:${first.id}`,
        },
        summary: `attachments: ${parts.map(describePart).join('; ')}`,
        scores: scoresOf(0.9, 0.6, 1, 0.8),
        expiresAt,
        reason: 'the user attached images or files to the prompt',
        trust: 'user',
      })
      if (item !== undefined) items.push(item)
    }
  } catch {
    // Fail-open: a malformed batch contributes no attachment items.
  }
  return items
}

/** The `attachment` channel extractor registered by `registerInputExtractors`. */
export const attachmentExtractor: CaptureExtractor = {
  name: 'attachment',
  extract: extractAttachmentItems,
}
