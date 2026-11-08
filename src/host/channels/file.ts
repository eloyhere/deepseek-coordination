/**
 * `@file` input channel.
 *
 * DSH's `dsh-file-reference` only completes and inserts a path; it never reads
 * the file. This extractor mirrors that syntax on the final `agent/pre-step`
 * batch: a mention starts at the beginning of the text or after whitespace, an
 * email-local `@` is therefore ignored, and a quoted `@"path with spaces"` form
 * is accepted. Relative paths resolve against `agent.session.header.cwd`;
 * absolute paths must still land inside that root. The only I/O is one `stat`
 * per surviving mention, used for `mtimeMs`/`size`; file content is never read.
 */
import { statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import path from 'node:path'

import type { CaptureExtractor, CaptureExtractorInput } from '../prestep.js'
import type { WireItem } from '../wire.js'
import {
  cwdOf,
  isInside,
  scoresOf,
  sourceKindOf,
  textOfMessage,
  toPosix,
  turnExpiry,
  safeSlot,
  wireItem,
} from './shared.js'

/** Candidate cap for the file channel (wire.md §4.5). */
export const MAX_FILE_ITEMS = 8

/** Matches `@path` at the start of the text or after whitespace, quoted or not. */
const MENTION_PATTERN = /(^|\s)@(?:"([^"]+)"|(\S+))/g

/** Reject control characters and embedded quotes in either mention form. */
const INVALID_PATH = /[\u0000-\u001f\u007f"]/

/**
 * Parse `@path` and `@"path with spaces"` mentions from one text block.
 *
 * Only an `@` at the start of the text or directly after whitespace starts a
 * token, so `user@example.com` yields nothing. Control characters and embedded
 * quotes are rejected rather than normalized. Returns raw path strings in
 * appearance order; never throws.
 */
export function parseFileMentions(text: string): readonly string[] {
  const mentions: string[] = []
  try {
    if (typeof text !== 'string' || text.length === 0) return mentions
    MENTION_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null = MENTION_PATTERN.exec(text)
    while (match !== null) {
      const candidate = match[2] ?? match[3]
      if (candidate !== undefined && candidate.length > 0 && !INVALID_PATH.test(candidate)) {
        mentions.push(candidate)
      }
      match = MENTION_PATTERN.exec(text)
    }
  } catch {
    return mentions
  }
  return mentions
}

/**
 * Resolve one mention to a workspace-relative POSIX path.
 *
 * Returns `undefined` when the target escapes the root (including another
 * Windows volume) or resolves back to the root itself. The returned path is a
 * normalized `path.relative` value, so duplicate spellings of the same file
 * collapse to one id.
 */
export function resolveMention(root: string, mention: string): string | undefined {
  try {
    const absoluteRoot = path.resolve(root)
    const target = path.isAbsolute(mention) ? path.resolve(mention) : path.resolve(absoluteRoot, mention)
    if (!isInside(absoluteRoot, target)) return undefined
    const relative = path.relative(absoluteRoot, target)
    if (relative.length === 0) return undefined
    return toPosix(relative)
  } catch {
    return undefined
  }
}

/**
 * Extract one `file` wire item per distinct `@path` mention.
 *
 * Only `source.kind === 'user'` messages are scanned, so paths that appear in a
 * host instruction or a session-reference snapshot are never promoted to user
 * intent. A mention whose path is outside the workspace, missing, unreadable or
 * not a regular file is dropped; the item carries a stat version, not content.
 */
export function extractFileItems(input: CaptureExtractorInput): readonly WireItem[] {
  const items: WireItem[] = []
  try {
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return items
    const root = cwdOf(input.agent)
    if (root === undefined) return items
    const absoluteRoot = path.resolve(root)
    const seen = new Set<string>()
    const expiresAt = turnExpiry()
    for (const message of input.messages) {
      if (sourceKindOf(message) !== 'user') continue
      const text = textOfMessage(message)
      if (text.length === 0) continue
      for (const mention of parseFileMentions(text)) {
        if (items.length >= MAX_FILE_ITEMS) break
        const relative = resolveMention(absoluteRoot, mention)
        if (relative === undefined || seen.has(relative)) continue
        let stat: Stats
        try {
          stat = statSync(path.join(absoluteRoot, relative))
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        const item = wireItem(input.agent, input.sessionId, input.turn, {
          channel: 'file',
          slot: safeSlot('file', items.length + 1),
          pointer: {
            kind: 'file',
            id: relative,
            version: `stat:${String(stat.mtimeMs)}:${String(stat.size)}`,
            uri: `dsh-file:${relative}`,
          },
          summary: `@${relative} — path reference only; not read (${String(stat.size)} bytes)`,
          scores: scoresOf(0.9, 0.5, 0.9, 0.7),
          expiresAt,
          reason: 'the user referenced this path in the prompt',
          trust: 'user',
        })
        if (item === undefined) continue
        seen.add(relative)
        items.push(item)
      }
      if (items.length >= MAX_FILE_ITEMS) break
    }
  } catch {
    // Fail-open: a malformed batch contributes no file items.
  }
  return items
}

/** The `file` channel extractor registered by `registerInputExtractors`. */
export const fileExtractor: CaptureExtractor = {
  name: 'file',
  extract: extractFileItems,
}
