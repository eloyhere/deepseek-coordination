/**
 * Generic lexical scanner for the text parser layer.
 *
 * One pass, `O(n)` time in the source length and `O(tokens)` space, with no
 * regular expressions and no backtracking: every branch advances the cursor
 * monotonically, so a pathological input cannot trigger quadratic work. The
 * scanner is language-neutral; a parser configures the comment/signature
 * vocabulary it needs:
 *
 *  - JavaScript / TypeScript: `//`, `/* … *\/`, `'`, `"`, `` ` ``, regex literals;
 *  - CSS: block comments only;
 *  - HTML: `<!-- … -->` block comments;
 *  - TeX: `%` line comments;
 *  - Markdown: no comments at the tokenizer level (HTML comments are handled by
 *    the markup parser itself).
 *
 * The emitted tokens use the shared `Token`/`TokenKind`/`SourceSpan` contract
 * from `src/shared/ast.ts`, and `tokenizeToStream` wraps a result in the shared
 * `TokenStream`, so the parser layer never re-implements either structure.
 *
 * Deliberate limits: the scanner stops at `maxTokens` (default 200,000, the
 * parser-layer hard cap) and at a caller-supplied `shouldStop` callback, which
 * is where a parser enforces its deadline and abort signal. Stopping early sets
 * `truncated`; the caller decides which diagnostic code that becomes.
 *
 * Regex literals are recognised with the usual "previous significant token can
 * start an expression" heuristic and are emitted as `string` tokens, because
 * `TokenKind` has no separate regex category. A regex is therefore never
 * mistaken for a sequence of identifiers/strings by a parser. The heuristic is
 * lexical, not grammatical: a `/` after an identifier is division, so a regex
 * literal in an expression position the heuristic does not predict is scanned
 * as operators. That is conservative for reference extraction.
 *
 * Not a parser: no trees, no symbol table, no specifier resolution.
 */
import { TokenStream } from '../../shared/ast.js'
import type { Token, TokenKind } from '../../shared/ast.js'
import { InvalidArgumentError } from '../../shared/error.js'

/**
 * Default token budget. Mirrors `MAX_TOKENS` in `./parser.ts`; duplicated here
 * so the tokenizer stays importable on its own without a cycle through the
 * parser contract module.
 */
const DEFAULT_MAX_TOKENS = 200_000

/**
 * `shouldStop` is consulted once every this many loop iterations. `Date.now`
 * and `AbortSignal.throwIfAborted` are cheap but not free; 1,024 tokens keeps
 * deadline accuracy within roughly a millisecond on a 1 MiB file.
 */
const CHECKPOINT_INTERVAL = 1_024

/** Punctuation characters emitted with `TokenKind: 'punctuation'`. */
const PUNCTUATION = new Set(['{', '}', '(', ')', '[', ']', ',', ';', '.', ':'])

/** Operator characters emitted with `TokenKind: 'operator'`. */
const OPERATORS = new Set(['=', '+', '-', '*', '/', '%', '<', '>', '!', '&', '|', '^', '~', '?', '@', '#', '\\'])

/**
 * ECMAScript + TypeScript keywords. Classification is advisory: a parser that
 * cares compares token text. `type`, `interface`, `readonly` and friends are
 * included because TS treats them as contextual keywords and a reader looking
 * at a token dump expects them labelled.
 */
const KEYWORDS: ReadonlySet<string> = new Set([
  'abstract', 'accessor', 'as', 'asserts', 'async', 'await', 'break', 'case', 'catch',
  'class', 'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function',
  'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is',
  'keyof', 'let', 'module', 'namespace', 'new', 'null', 'of', 'override', 'private',
  'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unique',
  'unknown', 'using', 'var', 'void', 'while', 'with', 'yield',
])

/** Previous-token kinds after which a `/` starts a regex literal. */
const REGEX_PREFIX_KEYWORDS: ReadonlySet<string> = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return',
  'throw', 'typeof', 'void', 'yield',
])

/** Previous-token punctuation/operator text after which a `/` starts a regex. */
const REGEX_PREFIX_SYMBOLS: ReadonlySet<string> = new Set([
  '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '/', '%',
  '<', '>', '~', '^',
])

/** One configurable comment pair; the opener and closer are literal strings. */
export type CommentPair = readonly [open: string, close: string]

/** Options for `tokenize`. All have defaults tuned for JavaScript. */
export interface TokenizerOptions {
  /** Hard token budget; the scanner stops once it is reached. Default 200,000. */
  maxTokens?: number
  /** Line-comment openers. Default `['//']`; pass `[]` to disable. */
  lineComments?: readonly string[]
  /** Block-comment pairs, for example `['/*', '*'+'/']`; pass `[]` to disable. */
  blockComments?: readonly CommentPair[]
  /** String delimiters. Default `['"', "'", '`']`. */
  stringDelimiters?: readonly string[]
  /** Keywords to label as `keyword`; defaults to the JS/TS set. */
  keywords?: ReadonlySet<string>
  /**
   * Consulted every `CHECKPOINT_INTERVAL` loop iterations. Returning true stops
   * the scan and marks the result truncated. A parser passes `() => !ctx.checkpoint()`.
   */
  shouldStop?: () => boolean
}

/** Result of one scan. `tokens` always contains a final `eof` token unless truncated. */
export interface TokenizeResult {
  tokens: Token[]
  /** True when `maxTokens` or `shouldStop` ended the scan early. */
  truncated: boolean
  /** Offset at which scanning stopped (the source length for a complete scan). */
  stoppedAt: number
}

/**
 * Scan `text` into tokens.
 *
 * Time `O(n)` in UTF-16 code units, space `O(tokens)`. The scanner never
 * backtracks: each branch either consumes one token or one character. Throws
 * `InvalidArgumentError` for a non-string source, a non-positive/non-integer
 * `maxTokens`, or an empty comment/string delimiter.
 */
export function tokenize(text: string, options: TokenizerOptions = {}): TokenizeResult {
  if (typeof text !== 'string') {
    throw new InvalidArgumentError('tokenize requires a string source', { type: typeof text })
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new InvalidArgumentError('tokenize maxTokens must be a positive integer', { maxTokens })
  }
  const lineComments = options.lineComments ?? ['//']
  const blockComments = options.blockComments ?? [['/*', '*/']]
  const stringDelimiters = options.stringDelimiters ?? ['"', "'", '`']
  const keywords = options.keywords ?? KEYWORDS
  for (const opener of lineComments) {
    if (opener.length === 0) throw new InvalidArgumentError('line-comment opener must not be empty')
  }
  for (const [open, close] of blockComments) {
    if (open.length === 0 || close.length === 0) {
      throw new InvalidArgumentError('block-comment delimiters must not be empty', { open, close })
    }
  }
  for (const delimiter of stringDelimiters) {
    if (delimiter.length !== 1) {
      throw new InvalidArgumentError('string delimiters must be single characters', { delimiter })
    }
  }
  const stringDelimiterCodes = new Set(stringDelimiters.map((delimiter) => delimiter.charCodeAt(0)))

  const tokens: Token[] = []
  const length = text.length
  let index = 0
  let line = 1
  let lineStart = 0
  let iterations = 0
  let truncated = false
  let lastSignificant: Token | undefined

  // A parser with a zero/expired deadline must not do any work at all, so the
  // stop hook is consulted before the first token as well as periodically.
  if (options.shouldStop?.() === true) {
    return { tokens, truncated: true, stoppedAt: 0 }
  }

  /** Advance the cursor to `to`, counting newlines on the way. O(distance). */
  const advanceTo = (to: number): void => {
    for (let cursor = index; cursor < to; cursor += 1) {
      const code = text.charCodeAt(cursor)
      if (code === 10) {
        line += 1
        lineStart = cursor + 1
      } else if (code === 13 && text.charCodeAt(cursor + 1) !== 10) {
        line += 1
        lineStart = cursor + 1
      }
    }
    index = to
  }

  /**
   * Emit one token; `startLine`/`startColumn` were captured at the token start.
   * Updates `lastSignificant` for the regex heuristic.
   */
  const emit = (kind: TokenKind, start: number, end: number, startLine: number, startColumn: number): void => {
    if (tokens.length >= maxTokens) {
      truncated = true
      return
    }
    const token: Token = {
      kind,
      text: text.slice(start, end),
      span: { start, end, line: startLine, column: startColumn },
    }
    tokens.push(token)
    if (kind !== 'whitespace' && kind !== 'newline' && kind !== 'comment') lastSignificant = token
  }

  while (index < length) {
    if (tokens.length >= maxTokens) {
      truncated = true
      break
    }
    iterations += 1
    if (iterations % CHECKPOINT_INTERVAL === 0 && options.shouldStop?.() === true) {
      truncated = true
      break
    }

    const start = index
    const startLine = line
    const startColumn = index - lineStart + 1
    const code = text.charCodeAt(index)

    // A byte-order mark is file metadata, not code or prose. It is emitted as
    // whitespace so every parser ignores it; `SourceMap` still counts its bytes
    // and no fragment range starts before it.
    if (code === 0xfeff) {
      advanceTo(index + 1)
      emit('whitespace', start, start + 1, startLine, startColumn)
      continue
    }

    // Newline: `\n`, `\r\n` or a lone `\r`. Kept as its own token because several
    // grammars (JS ASI, Markdown headings, TeX paragraph breaks) care.
    if (code === 10 || code === 13) {
      const end = code === 13 && text.charCodeAt(index + 1) === 10 ? index + 2 : index + 1
      advanceTo(end)
      emit('newline', start, end, startLine, startColumn)
      continue
    }

    // Horizontal whitespace only; newlines were handled above so a parser can
    // rely on `newline` tokens for line structure.
    if (code === 32 || code === 9 || code === 11 || code === 12) {
      let end = index + 1
      while (end < length) {
        const next = text.charCodeAt(end)
        if (next === 32 || next === 9 || next === 11 || next === 12) end += 1
        else break
      }
      advanceTo(end)
      emit('whitespace', start, end, startLine, startColumn)
      continue
    }

    // Block comments first: `/*` must win over `//`, and `<!--` over any
    // line-comment opener. `indexOf` is linear in the remainder but every
    // consumed character is inside this comment, so the scan stays O(n).
    let blockMatched = false
    for (const [open, close] of blockComments) {
      if (!text.startsWith(open, index)) continue
      const closeIndex = text.indexOf(close, index + open.length)
      const end = closeIndex < 0 ? length : closeIndex + close.length
      advanceTo(end)
      emit('comment', start, end, startLine, startColumn)
      blockMatched = true
      break
    }
    if (blockMatched) continue

    let lineMatched = false
    for (const opener of lineComments) {
      if (!text.startsWith(opener, index)) continue
      let end = index + opener.length
      while (end < length) {
        const next = text.charCodeAt(end)
        if (next === 10 || next === 13) break
        end += 1
      }
      advanceTo(end)
      emit('comment', start, end, startLine, startColumn)
      lineMatched = true
      break
    }
    if (lineMatched) continue

    // String or template literal. A backtick may span lines; a quote ends at an
    // unescaped newline (a malformed single-line string), which keeps the scan
    // linear and lets the parser recover on the next line.
    if (stringDelimiterCodes.has(code)) {
      let cursor = index + 1
      let closed = false
      while (cursor < length) {
        const next = text.charCodeAt(cursor)
        if (next === 92) {
          cursor += 2
          continue
        }
        if (next === code) {
          cursor += 1
          closed = true
          break
        }
        if ((next === 10 || next === 13) && code !== 96) break
        cursor += 1
      }
      if (cursor > length) cursor = length
      advanceTo(cursor)
      emit('string', start, cursor, startLine, startColumn)
      void closed
      continue
    }

    // Number literal: decimal (with fraction/exponent/separators), hex, binary
    // and octal, plus the BigInt `n` suffix.
    if (isDigit(code) || (code === 46 && isDigit(text.charCodeAt(index + 1)))) {
      let cursor = index
      if (code === 48) {
        const marker = text.charCodeAt(index + 1) | 0x20
        if (marker === 120 || marker === 98 || marker === 111) {
          cursor = index + 2
          while (cursor < length && isRadixDigit(text.charCodeAt(cursor))) cursor += 1
          if (text.charCodeAt(cursor) === 110) cursor += 1
          advanceTo(cursor)
          emit('number', start, cursor, startLine, startColumn)
          continue
        }
      }
      cursor = index
      while (cursor < length) {
        const next = text.charCodeAt(cursor)
        if (isDigit(next) || next === 46 || next === 95) {
          cursor += 1
          continue
        }
        if (next === 101 || next === 69) {
          cursor += 1
          const sign = text.charCodeAt(cursor)
          if (sign === 43 || sign === 45) cursor += 1
          continue
        }
        break
      }
      if (text.charCodeAt(cursor) === 110) cursor += 1
      advanceTo(cursor)
      emit('number', start, cursor, startLine, startColumn)
      continue
    }

    // Identifier or keyword. Non-ASCII code units are folded into identifier
    // runs so CJK prose is not emitted one `unknown` token per character.
    if (isIdentifierStart(code)) {
      let cursor = index + 1
      while (cursor < length && isIdentifierPart(text.charCodeAt(cursor))) cursor += 1
      advanceTo(cursor)
      const value = text.slice(start, cursor)
      emit(keywords.has(value) ? 'keyword' : 'identifier', start, cursor, startLine, startColumn)
      continue
    }

    // Regex literal, only where an expression can start. Emitted as `string`.
    if (code === 47 && canStartRegex(lastSignificant)) {
      let cursor = index + 1
      let inClass = false
      let closed = false
      while (cursor < length) {
        const next = text.charCodeAt(cursor)
        if (next === 92) {
          cursor += 2
          continue
        }
        if (next === 10 || next === 13) break
        if (next === 91) {
          inClass = true
        } else if (next === 93) {
          inClass = false
        } else if (next === 47 && !inClass) {
          cursor += 1
          closed = true
          break
        }
        cursor += 1
      }
      if (closed) {
        while (cursor < length && isAsciiLetter(text.charCodeAt(cursor))) cursor += 1
        if (cursor > length) cursor = length
        advanceTo(cursor)
        emit('string', start, cursor, startLine, startColumn)
        continue
      }
      // Unterminated: fall through and let `/` be an operator.
    }

    if (PUNCTUATION.has(text[index])) {
      advanceTo(index + 1)
      emit('punctuation', start, start + 1, startLine, startColumn)
      continue
    }
    if (OPERATORS.has(text[index])) {
      advanceTo(index + 1)
      emit('operator', start, start + 1, startLine, startColumn)
      continue
    }

    // Anything else: one `unknown` code unit. Control characters and stray
    // punctuation land here; the parser can diagnose them if it cares.
    advanceTo(index + 1)
    emit('unknown', start, start + 1, startLine, startColumn)
  }

  if (!truncated) {
    const endLine = line
    const endColumn = index - lineStart + 1
    tokens.push({
      kind: 'eof',
      text: '',
      span: { start: length, end: length, line: endLine, column: endColumn },
    })
  }

  return { tokens, truncated, stoppedAt: index }
}

/**
 * Wrap a `tokenize` result in the shared `TokenStream` cursor.
 *
 * O(tokens) because `TokenStream` copies the array; space O(tokens).
 */
export function toTokenStream(result: TokenizeResult): TokenStream {
  return new TokenStream(result.tokens)
}

/**
 * Convenience: scan and wrap in one call.
 *
 * Time O(n), space O(tokens).
 */
export function tokenizeToStream(
  text: string,
  options: TokenizerOptions = {},
): { stream: TokenStream; result: TokenizeResult } {
  const result = tokenize(text, options)
  return { stream: toTokenStream(result), result }
}

/** Default JS/TS keyword set, exported for parsers that want to extend it. */
export const DEFAULT_KEYWORDS: ReadonlySet<string> = KEYWORDS

/** One physical line: `text` excludes the line terminator. */
export interface TextLine {
  /** Offset of the first character. */
  start: number
  /** Offset just past the last content character (before the terminator). */
  end: number
  /** Line content without `\r`/`\n`. */
  text: string
  /** 1-based line number. */
  number: number
}

/**
 * Split source text into physical lines without copying the whole source.
 *
 * Time O(n) in UTF-16 code units, space O(lines). `\n`, `\r\n` and a lone `\r`
 * all terminate a line. A trailing terminator does not produce a final empty
 * line, matching how an editor shows `a\n` as one line.
 */
export function splitTextLines(text: string): TextLine[] {
  if (typeof text !== 'string') {
    throw new InvalidArgumentError('splitTextLines requires a string source', { type: typeof text })
  }
  const lines: TextLine[] = []
  const length = text.length
  let start = 0
  let number = 1
  while (start < length) {
    let end = start
    while (end < length) {
      const code = text.charCodeAt(end)
      if (code === 10 || code === 13) break
      end += 1
    }
    lines.push({ start, end, text: text.slice(start, end), number })
    if (end >= length) break
    if (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10) end += 1
    start = end + 1
    number += 1
  }
  return lines
}

/** True for `0`–`9`. */
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/** True for a digit in any radix prefix (hex letters included). */
function isRadixDigit(code: number): boolean {
  return isDigit(code) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70) || code === 95
}

/** Identifier start: ASCII letters, `_`, `$`, or any non-ASCII code unit. */
function isIdentifierStart(code: number): boolean {
  if (code >= 128) return true
  if (code === 95 || code === 36) return true
  if (code >= 65 && code <= 90) return true
  return code >= 97 && code <= 122
}

/** Identifier continuation: start characters plus digits. */
function isIdentifierPart(code: number): boolean {
  if (isIdentifierStart(code)) return true
  return isDigit(code)
}

/** True for ASCII `A`–`Z` / `a`–`z`; used for regex flags without a regex. */
function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/**
 * Regex heuristic: a `/` starts a literal when nothing precedes it, or when the
 * previous significant token can end an operator/keyword but cannot end an
 * expression.
 */
function canStartRegex(previous: Token | undefined): boolean {
  if (previous === undefined) return true
  if (previous.kind === 'keyword') return REGEX_PREFIX_KEYWORDS.has(previous.text)
  if (previous.kind === 'punctuation' || previous.kind === 'operator') {
    return REGEX_PREFIX_SYMBOLS.has(previous.text)
  }
  return false
}
