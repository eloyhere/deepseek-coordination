/**
 * Text-level sentence and line segmentation.
 *
 * This module turns prose into body-free coordinates: a sentence is reported as
 * a half-open UTF-16 offset range plus its 1-based line and column, never as a
 * copy of the text. It is pure (no file I/O, no host imports), deterministic and
 * single-pass: every scanner advances one UTF-16 code unit at a time, with no
 * regular expressions and no recursion, so no input can cause regex
 * backtracking or stack overflow.
 *
 * Segmentation rules:
 *
 *  - an ASCII `.`, `!` or `?` ends a sentence only when followed by whitespace
 *    or end of input;
 *  - CJK `。`, `！` and `？` end a sentence immediately (CJK prose does not put a
 *    space after terminal punctuation);
 *  - a `.` after a single capital letter (`A.` in `J. R. R. Tolkien`) and a `.`
 *    between digits (`3.14`) never end a sentence;
 *  - blank lines end the current sentence as a paragraph break;
 *  - terminal punctuation inside `(...)`, `[...]`, `"..."` or a fenced code
 *    block does not end a sentence;
 *  - reported ranges are trimmed; empty segments are dropped.
 *
 * Bounds: at most `MAX_SENTENCES` segments are produced and at most
 * `MAX_SENTENCE_LENGTH` UTF-16 code units are scanned. Both caps are
 * configurable; whichever is reached first stops the scan. `lineRanges` is
 * capped at `MAX_LINE_RANGES` lines. Invalid limits fall back to the defaults
 * and non-string input yields an empty result: these functions never throw.
 *
 * Complexity: O(n) time in the scanned prefix, O(output) space; the bracket
 * depth counters are O(1) even for deeply nested text.
 */
import type { SourceSpan } from '../../shared/ast.js'

/** Default maximum number of sentence segments returned. */
export const MAX_SENTENCES = 2_000
/** Default maximum number of UTF-16 code units scanned. */
export const MAX_SENTENCE_LENGTH = 200_000
/** Default maximum number of line ranges returned. */
export const MAX_LINE_RANGES = 20_000

/**
 * One sentence range: `start` inclusive, `end` exclusive (UTF-16 offsets).
 * `line` and `column` are 1-based and point at the first non-whitespace unit.
 */
export interface SentenceSegment {
  readonly start: number
  readonly end: number
  readonly line: number
  readonly column: number
}

/**
 * Split prose into sentence segments.
 *
 * The text prefix is scanned once. A segment starts at its first non-whitespace
 * character and ends after its last non-whitespace character; trailing
 * whitespace belongs to no segment. Paragraph breaks (blank lines) also close
 * the current segment. Fenced code blocks are skipped entirely.
 *
 * @param text Source text; non-string input returns `[]`.
 * @param options `maxSentences` (default 2,000) and `maxLength` (default
 *   200,000 UTF-16 code units) both cap the scan; whichever is reached first
 *   stops it. Invalid values fall back to the defaults; `0` yields `[]`.
 * @returns Segments in source order, never overlapping.
 */
export function segmentSentences(
  text: string,
  options?: { maxSentences?: number; maxLength?: number },
): SentenceSegment[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const maxSentences = normaliseLimit(options?.maxSentences, MAX_SENTENCES)
  const maxLength = normaliseLimit(options?.maxLength, MAX_SENTENCE_LENGTH)
  if (maxSentences === 0 || maxLength === 0) return []
  const scanEnd = Math.min(text.length, maxLength)
  const segments: SentenceSegment[] = []

  let index = 0
  let line = 1
  let pendingStart = -1
  let pendingEnd = -1
  let pendingLine = 1
  let pendingColumn = 1
  let parenDepth = 0
  let bracketDepth = 0
  let quoted = false
  let inFence = false
  let fenceMarker = 0
  let fenceLength = 0

  const flush = (): void => {
    if (pendingStart < 0 || pendingEnd <= pendingStart) return
    segments.push({ start: pendingStart, end: pendingEnd, line: pendingLine, column: pendingColumn })
    pendingStart = -1
    pendingEnd = -1
  }

  scan: while (index < scanEnd && segments.length < maxSentences) {
    let lineEnd = index
    while (lineEnd < scanEnd) {
      const code = text.charCodeAt(lineEnd)
      if (code === 10 || code === 13) break
      lineEnd += 1
    }

    let lineHasContent = false
    let fenceLine = false
    const fence = scanFenceLine(text, index, lineEnd)
    if (inFence) {
      fenceLine = true
      if (
        fence !== undefined &&
        fence.marker === fenceMarker &&
        fence.length >= fenceLength &&
        !fence.info
      ) {
        inFence = false
      }
    } else if (fence !== undefined) {
      fenceLine = true
      inFence = true
      fenceMarker = fence.marker
      fenceLength = fence.length
    }

    if (!fenceLine) {
      let escaped = false
      for (let cursor = index; cursor < lineEnd; cursor += 1) {
        const code = text.charCodeAt(cursor)
        const wasEscaped = escaped
        escaped = code === 92 ? !escaped : false
        if (isWhitespaceCode(code)) continue
        lineHasContent = true
        if (pendingStart < 0) {
          pendingStart = cursor
          pendingLine = line
          pendingColumn = cursor - index + 1
        }
        pendingEnd = cursor + 1
        if (!wasEscaped) {
          if (code === 34) quoted = !quoted
          else if (code === 40) parenDepth += 1
          else if (code === 41) {
            if (parenDepth > 0) parenDepth -= 1
          } else if (code === 91) bracketDepth += 1
          else if (code === 93) {
            if (bracketDepth > 0) bracketDepth -= 1
          }
        }
        if (
          parenDepth === 0 &&
          bracketDepth === 0 &&
          !quoted &&
          isSentenceEnd(text, cursor, scanEnd, code)
        ) {
          flush()
          if (segments.length >= maxSentences) break scan
        }
      }
    }

    if (lineEnd >= scanEnd) break
    const newline = text.charCodeAt(lineEnd)
    const newlineLength = newline === 13 && text.charCodeAt(lineEnd + 1) === 10 ? 2 : 1
    if (
      !lineHasContent &&
      !fenceLine &&
      !inFence &&
      pendingStart >= 0 &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      !quoted
    ) {
      flush()
      if (segments.length >= maxSentences) break
    }
    index = lineEnd + newlineLength
    line += 1
  }

  if (segments.length < maxSentences) flush()
  return segments
}

/**
 * One body-free `sentence` node per segment.
 *
 * Only `kind` and `span` are present: no sentence text, name or brief is copied,
 * so the node is safe to put on the wire. The node count is capped by the same
 * `maxSentences` limit as `segmentSentences`.
 *
 * @param text Source text; non-string input returns `[]`.
 * @param options Same caps as `segmentSentences`.
 */
export function sentenceNodes(
  text: string,
  options?: { maxSentences?: number; maxLength?: number },
): Array<{ kind: 'sentence'; span: SourceSpan }> {
  const nodes: Array<{ kind: 'sentence'; span: SourceSpan }> = []
  for (const segment of segmentSentences(text, options)) {
    nodes.push({
      kind: 'sentence',
      span: {
        start: segment.start,
        end: segment.end,
        line: segment.line,
        column: segment.column,
      },
    })
  }
  return nodes
}

/**
 * Physical line ranges: `start` inclusive, `end` exclusive, newline excluded.
 *
 * CRLF is one break, lone LF and lone CR are one break each, and a final line
 * without a newline is included. A trailing newline therefore yields a final
 * empty range (`start === end`), matching the host `SourceMap` line numbering;
 * empty input yields `[]`. `line` is 1-based.
 *
 * @param text Source text; non-string input returns `[]`.
 * @param maxLines Maximum ranges returned (default 20,000); `0` yields `[]`.
 *   Scanning stops as soon as the cap is reached.
 */
export function lineRanges(
  text: string,
  maxLines?: number,
): Array<{ start: number; end: number; line: number }> {
  if (typeof text !== 'string' || text.length === 0) return []
  const cap = normaliseLimit(maxLines, MAX_LINE_RANGES)
  if (cap === 0) return []
  const ranges: Array<{ start: number; end: number; line: number }> = []
  let start = 0
  let line = 1
  let index = 0
  while (index < text.length && ranges.length < cap) {
    const code = text.charCodeAt(index)
    if (code === 10 || code === 13) {
      ranges.push({ start, end: index, line })
      if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1
      index += 1
      start = index
      line += 1
      continue
    }
    index += 1
  }
  if (ranges.length < cap && start <= text.length) {
    ranges.push({ start, end: text.length, line })
  }
  return ranges
}

/** A fence delimiter line: marker code (` or ~), run length and info suffix. */
interface FenceLine {
  marker: number
  length: number
  info: boolean
}

/**
 * Classify a line as a fenced-code delimiter, if it is one. Only leading spaces
 * and tabs are allowed before the marker; a run of at least three backticks or
 * tildes opens (or closes, when the run is long enough and the rest is blank) a
 * fence.
 */
function scanFenceLine(text: string, start: number, end: number): FenceLine | undefined {
  let cursor = start
  while (cursor < end) {
    const code = text.charCodeAt(cursor)
    if (code !== 32 && code !== 9) break
    cursor += 1
  }
  const marker = text.charCodeAt(cursor)
  if (marker !== 96 && marker !== 126) return undefined
  let runEnd = cursor
  while (runEnd < end && text.charCodeAt(runEnd) === marker) runEnd += 1
  const length = runEnd - cursor
  if (length < 3) return undefined
  let info = false
  for (let index = runEnd; index < end; index += 1) {
    if (!isWhitespaceCode(text.charCodeAt(index))) {
      info = true
      break
    }
  }
  return { marker, length, info }
}

/**
 * True when the character at `index` ends a sentence. ASCII punctuation needs a
 * following whitespace/EOL (or the scan cap); CJK punctuation ends a sentence
 * immediately. A `.` between digits and a `.` after a single capital letter
 * (initials such as `A.`) are not sentence ends.
 */
function isSentenceEnd(text: string, index: number, scanEnd: number, code: number): boolean {
  if (code === 0x3002 || code === 0xff01 || code === 0xff1f) return true
  if (code !== 46 && code !== 33 && code !== 63) return false
  const next = index + 1
  if (next < scanEnd && !isWhitespaceCode(text.charCodeAt(next))) return false
  if (code === 46) {
    const previous = index > 0 ? text.charCodeAt(index - 1) : -1
    const after = next < text.length ? text.charCodeAt(next) : -1
    if (isDigitCode(previous) && isDigitCode(after)) return false
    if (
      isUppercaseCode(previous) &&
      (index < 2 || isWhitespaceCode(text.charCodeAt(index - 2)))
    ) {
      return false
    }
  }
  return true
}

/** Resolve a caller limit without throwing: invalid values use the default. */
function normaliseLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return fallback
  return value
}

/** True for Unicode whitespace relevant to prose; used for trimming and EOL. */
function isWhitespaceCode(code: number): boolean {
  return (
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57
}

function isUppercaseCode(code: number): boolean {
  return code >= 65 && code <= 90
}
