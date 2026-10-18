/**
 * Python parser: imports, class/def declarations, module and class attributes.
 *
 * Deliberately lexical, not a full AST. A single `O(n)` scan splits the source
 * into logical lines (triple-quoted strings, comments, bracket continuation and
 * backslash continuation are consumed, never emitted) and tracks indentation.
 * A second pass over those lines classifies statements:
 *
 *  - `import a.b`, `import a.b as c`, `import a, b` and
 *    `from a.b import c, d as e` → one `import` `FileReference` per imported
 *    module (`specifier` = dotted module), plus one `importation`
 *    `NodeMetadata` per reference. The reference shape matches the JavaScript
 *    parser (`kind`/`specifier`/`external`/`span`/`names`/wildcard), so the
 *    dependency layer can consume it unchanged;
 *  - `class Name(Base):` → `class` symbol; the span is exactly the header
 *    `class ... :` (decorators and the body are excluded);
 *  - `def name(...)` at lexical module scope → `function`; directly in a class
 *    body (or in an `if`/`for` block inside it) → `method`. A def nested in a
 *    function/method body is not extracted (bounded);
 *  - module-level assignments (`NAME = ...`, `name: Type = ...`,
 *    `NAME, OTHER = ...`, `(a, b) = ...`, chained `a = b = 1`) → one `variable`
 *    symbol per target name. Assignments whose lexical scope is a class body
 *    are class attributes and are also extracted; assignments inside a
 *    function/method body are not;
 *  - decorators (`@name`, `@name(...)`) are skipped entirely: they produce no
 *    nodes and do not interrupt the declaration scan.
 *
 * Body/docstring/comment text is never projected: tokens keep no string text,
 * comments are discarded, and no `brief`/`summary`/`description` is inferred
 * from a docstring. Every node carries only a body-free `span`, fragment
 * coordinates and (when a path is known) a `NodeReference`.
 *
 * Conservative gaps (documented, never guessed):
 *
 *  - defs/classes nested inside a function or method are not emitted; their
 *    bodies keep the enclosing function scope so local assignments stay local;
 *  - assignments with attribute/subscript targets (`self.x = ...`, `a[0] = ...`)
 *    and nested destructuring (`(a, (b, c)) = ...`) are not variables;
 *  - imports are not resolved; absolute dotted modules are `external` by the
 *    shared lexical classifier, and leading-dot (relative) modules keep their
 *    dotted spelling so a Python-aware resolver can map them later;
 *  - `global`/`nonlocal` statements, `match` patterns and type aliases are not
 *    interpreted.
 *
 * Malformed input (unterminated quotes, unbalanced brackets, tabs mixed with
 * spaces in indentation) records `parse-error` diagnostics and recovers at the
 * next physical line when possible; `parse` never throws for malformed input.
 *
 * Complexity: one `O(n)` scan plus one `O(lines)` classification pass; space is
 * `O(tokens + declarations)`, both bounded by the parser budgets
 * (`MAX_TOKENS`, `MAX_METADATA_NODES`). No regular expression is used, so no
 * backtracking is possible.
 */
import { AstTree } from '../../shared/ast.js'
import type { SourceSpan } from '../../shared/ast.js'
import {
  MAX_METADATA_NODES,
  MAX_NAME_LENGTH,
  ParseContext,
  appendAstNode,
  createAstRoot,
  fragmentForSpan,
  pushNodeMetadata,
  referenceForSpan,
  sanitizeMetadataText,
} from './parser.js'
import type {
  FileReference,
  FlatFragment,
  NodeMetadata,
  NodeReference,
  ParseOptions,
  ParseResult,
  Parser,
} from './parser.js'

/** Symbol kinds the Python scan can prove. */
export type PythonSymbolKind = 'class' | 'function' | 'method' | 'variable'

/** Lexical scope of an extracted symbol; only these two scopes are emitted. */
export type PythonSymbolScope = 'module' | 'class'

/** One code symbol the lexical scan can prove. */
export interface PythonSymbol extends FlatFragment {
  kind: PythonSymbolKind
  name: string
  /** Declaration span. For class/def this is the header up to its colon. */
  span: SourceSpan
  /** Lexical scope the declaration belongs to. */
  scope: PythonSymbolScope
  /** Enclosing class name for a method or a class attribute. */
  ownerClass?: string
  /** Body-free locator for this symbol. */
  reference?: NodeReference
}

/** Parser-specific result with the extracted symbols in source order. */
export interface PythonParseResult extends ParseResult {
  symbols: PythonSymbol[]
}

/**
 * Hard keywords. Used only to reject them as assignment/target names; soft
 * keywords (`match`, `case`, `type`, `_`) stay legal identifiers.
 */
const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for',
  'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])

/** One lexical token of a logical line. Banner brackets keep their depth. */
interface PythonToken {
  kind: 'name' | 'number' | 'string' | 'operator'
  /** Raw text for names/numbers/operators; empty for strings (never emitted). */
  text: string
  span: SourceSpan
  /** Bracket depth immediately before this token; 0 is statement top level. */
  depth: number
}

/** One logical line: indentation plus significant tokens, comment excluded. */
interface LogicalLine {
  /** Indentation in display columns (tabs expand to the next multiple of 8). */
  indent: number
  tokens: PythonToken[]
}

/** Result of the source scan. */
interface ScanResult {
  lines: LogicalLine[]
  /** Number of significant tokens emitted. */
  tokens: number
}

/** Frame kinds for the indentation stack. `block` is a non-lexical block. */
type FrameKind = 'class' | 'function' | 'block'

/** One open block, indexed by the indentation of its header line. */
interface BlockFrame {
  headerIndent: number
  kind: FrameKind
  /** Class or function name, when the block has one. */
  name?: string
}

/** A block introduced by the previous logical line and its next body line. */
interface PendingBlock {
  indent: number
  kind: FrameKind
  name?: string
}

/** One source-ordered declaration: an import reference or an extracted symbol. */
type Declaration = { reference: FileReference } | { symbol: PythonSymbol }

/** One simple assignment target. */
interface TargetName {
  name: string
  span: SourceSpan
}

/** A parsed assignment target list and the index of the assigning `=`. */
interface TargetList {
  names: TargetName[]
  equals: number
}

/**
 * Parse Python source.
 *
 * Time `O(n)` in the source length; space `O(tokens + declarations)`, both
 * bounded by the parser budgets. Never throws for malformed source; throws only
 * when `options.signal` is already aborted (standard `AbortSignal` contract).
 */
export function parsePython(text: string, options: ParseOptions = {}): PythonParseResult {
  const ctx = new ParseContext(text, options)
  const scanned = scanPython(ctx)
  ctx.tokens = scanned.tokens

  const references: FileReference[] = []
  const symbols: PythonSymbol[] = []
  const declarations: Declaration[] = []
  let limitReached = false

  const addReference = (reference: FileReference): void => {
    if (declarations.length >= MAX_METADATA_NODES) {
      ctx.limit('node-limit', `node metadata limit ${MAX_METADATA_NODES} reached; later declarations were dropped`)
      limitReached = true
      return
    }
    references.push(reference)
    declarations.push({ reference })
  }
  const addSymbol = (symbol: PythonSymbol): void => {
    if (declarations.length >= MAX_METADATA_NODES) {
      ctx.limit('node-limit', `node metadata limit ${MAX_METADATA_NODES} reached; later declarations were dropped`)
      limitReached = true
      return
    }
    symbols.push(symbol)
    declarations.push({ symbol })
  }

  const frames: BlockFrame[] = []
  let pending: PendingBlock | undefined
  let lineOrdinal = 0

  for (const line of scanned.lines) {
    lineOrdinal += 1
    if ((lineOrdinal & 1_023) === 0 && !ctx.checkpoint()) break
    if (limitReached) break

    // Close every block this line dedents out of. `<=` because a sibling at a
    // header's own indentation is no longer inside that header's block.
    while (frames.length > 0 && line.indent <= frames[frames.length - 1].headerIndent) {
      frames.pop()
    }
    if (pending !== undefined) {
      if (line.indent > pending.indent) {
        frames.push({
          headerIndent: pending.indent,
          kind: pending.kind,
          ...(pending.name === undefined ? {} : { name: pending.name }),
        })
      }
      pending = undefined
    }

    const tokens = line.tokens
    if (tokens.length === 0) continue
    const first = tokens[0]
    // A decorator is not a declaration and its arguments are irrelevant. It
    // must not break scanning, so the line is simply skipped.
    if (first.text === '@') continue
    if (first.text === 'import') {
      handleImportStatement(ctx, tokens, addReference)
      continue
    }
    if (first.text === 'from') {
      handleFromImport(ctx, tokens, addReference)
      continue
    }
    const defIndex = defDeclarationIndex(tokens)
    if (defIndex >= 0) {
      pending = handleDef(ctx, line, tokens, defIndex, frames, addSymbol)
      continue
    }
    if (first.text === 'class') {
      pending = handleClass(ctx, line, tokens, frames, addSymbol)
      continue
    }
    handleAssignment(ctx, tokens, frames, addSymbol)
    pending = endsWithBlockColon(tokens) ? { indent: line.indent, kind: 'block' } : undefined
  }

  const nodes = buildNodes(ctx, declarations)
  const ast = buildAst(ctx, declarations)
  const base = ctx.finalize({
    parserId: 'python',
    references,
    tokens: scanned.tokens,
    ast,
    nodes,
  })
  return { ...base, symbols }
}

/** `Parser` implementation for the registry. Registration is deferred. */
export class PythonParser implements Parser {
  readonly id = 'python'
  readonly extensions: readonly string[] = ['.py', '.pyi', '.pyw']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parsePython(text, options)
  }
}

/** Shared singleton; the integrator registers it in `./index.ts`. */
export const pythonParser = new PythonParser()

/* ------------------------------------------------------------------------- *
 * Source scan: physical lines → logical lines
 * ------------------------------------------------------------------------- */

/**
 * Split `ctx.text` into logical lines and tokenize them.
 *
 * Physical lines are joined while inside `()[]{}` or after a `\` newline.
 * Triple-quoted strings and comments are consumed so their contents can never
 * be mistaken for declarations. Unterminated strings, unbalanced brackets and
 * mixed tab/space indentation become `parse-error` diagnostics.
 *
 * Time `O(n)`, space `O(tokens)`; the token and time budgets stop the scan.
 */
function scanPython(ctx: ParseContext): ScanResult {
  const text = ctx.text
  const length = text.length
  const lines: LogicalLine[] = []
  let index = 0
  let line = 1
  let lineStart = 0
  let totalTokens = 0
  let steps = 0
  let stopped = false
  let mixedIndentReported = false
  let lineTokens: PythonToken[] = []
  let codeEnd = 0

  /** Advance the cursor, keeping the 1-based line/column state in sync. */
  const advanceTo = (to: number): void => {
    const target = Math.max(index, Math.min(to, length))
    while (index < target) {
      const code = text.charCodeAt(index)
      if (code === 10) {
        line += 1
        lineStart = index + 1
      } else if (code === 13 && text.charCodeAt(index + 1) !== 10) {
        line += 1
        lineStart = index + 1
      }
      index += 1
    }
  }

  /** Cooperative deadline/abort check, amortised over 4,096 scan steps. */
  const tick = (): boolean => {
    steps += 1
    if ((steps & 4_095) !== 0) return true
    if (ctx.checkpoint()) return true
    stopped = true
    return false
  }

  const pushToken = (
    kind: PythonToken['kind'],
    tokenText: string,
    start: number,
    end: number,
    startLine: number,
    startColumn: number,
    depth: number,
  ): boolean => {
    if (totalTokens >= ctx.maxTokens) {
      ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
      stopped = true
      return false
    }
    lineTokens.push({
      kind,
      text: tokenText,
      span: { start, end, line: startLine, column: startColumn },
      depth,
    })
    totalTokens += 1
    return true
  }

  const consumeNewline = (): void => {
    const code = text.charCodeAt(index)
    const end = code === 13 && text.charCodeAt(index + 1) === 10 ? index + 2 : index + 1
    advanceTo(end)
  }

  while (index < length && !stopped) {
    if (!ctx.checkpoint()) break

    // Indentation of the logical line. Tabs advance to the next 8-column stop;
    // a line that mixes tabs and spaces in its indentation is reported once.
    let indentColumns = 0
    let sawSpace = false
    let sawTab = false
    while (index < length) {
      if (!tick()) break
      const code = text.charCodeAt(index)
      if (code === 32) {
        indentColumns += 1
        sawSpace = true
        advanceTo(index + 1)
        continue
      }
      if (code === 9) {
        indentColumns += 8 - (indentColumns % 8)
        sawTab = true
        advanceTo(index + 1)
        continue
      }
      if (code === 12) {
        indentColumns += 1
        advanceTo(index + 1)
        continue
      }
      // A byte-order mark is file metadata, not indentation.
      if (code === 0xfeff) {
        advanceTo(index + 1)
        continue
      }
      break
    }
    if (stopped) break
    if (index >= length) break

    const firstCode = text.charCodeAt(index)
    if (firstCode === 10 || firstCode === 13) {
      consumeNewline()
      continue
    }
    // A comment-only line has no logical line and never changes block state.
    if (firstCode === 35) {
      while (index < length) {
        if (!tick()) break
        const code = text.charCodeAt(index)
        if (code === 10 || code === 13) break
        advanceTo(index + 1)
      }
      if (stopped) break
      if (index < length) consumeNewline()
      continue
    }
    if (sawSpace && sawTab && !mixedIndentReported) {
      mixedIndentReported = true
      ctx.parseError('indentation mixes tabs and spaces', {
        start: index,
        end: Math.min(index + 1, length),
        line,
        column: index - lineStart + 1,
      })
    }

    lineTokens = []
    codeEnd = index
    const stack: string[] = []

    while (index < length && !stopped) {
      if (!tick()) break
      const code = text.charCodeAt(index)

      if (code === 32 || code === 9 || code === 12 || code === 0xfeff) {
        advanceTo(index + 1)
        continue
      }

      if (code === 10 || code === 13) {
        // Inside brackets a newline is implicit continuation; otherwise it ends
        // the logical line and the outer loop measures the next indentation.
        if (stack.length === 0) break
        consumeNewline()
        continue
      }

      if (code === 92) {
        // Explicit `\` newline continuation.
        const next = text.charCodeAt(index + 1)
        if (next === 10 || (next === 13 && text.charCodeAt(index + 2) === 10)) {
          advanceTo(next === 13 ? index + 3 : index + 2)
          continue
        }
        const tokenStart = index
        const tokenLine = line
        const tokenColumn = index - lineStart + 1
        if (!pushToken('operator', '\\', tokenStart, tokenStart + 1, tokenLine, tokenColumn, stack.length)) break
        advanceTo(tokenStart + 1)
        codeEnd = tokenStart + 1
        continue
      }

      if (code === 35) {
        // Comment: discard to end of physical line. Its text never reaches a
        // token, so no comment content can be projected onto a node.
        while (index < length) {
          if (!tick()) break
          const current = text.charCodeAt(index)
          if (current === 10 || current === 13) break
          advanceTo(index + 1)
        }
        if (stopped) break
        continue
      }

      if (code === 39 || code === 34) {
        const quote = code
        const tokenStart = index
        const tokenLine = line
        const tokenColumn = index - lineStart + 1
        const triple = text.charCodeAt(index + 1) === quote && text.charCodeAt(index + 2) === quote
        let cursor = index + (triple ? 3 : 1)
        let terminated = false
        while (cursor < length) {
          if (!tick()) break
          const current = text.charCodeAt(cursor)
          if (current === 92) {
            const next = text.charCodeAt(cursor + 1)
            if (next === 10 || (next === 13 && text.charCodeAt(cursor + 2) === 10)) {
              cursor += next === 13 ? 3 : 2
              continue
            }
            cursor += 2
            continue
          }
          if (triple) {
            if (
              current === quote &&
              text.charCodeAt(cursor + 1) === quote &&
              text.charCodeAt(cursor + 2) === quote
            ) {
              cursor += 3
              terminated = true
              break
            }
            cursor += 1
            continue
          }
          if (current === quote) {
            cursor += 1
            terminated = true
            break
          }
          if (current === 10 || current === 13) break
          cursor += 1
        }
        if (stopped) break
        cursor = Math.min(cursor, length)
        if (!terminated) {
          ctx.parseError(triple ? 'unterminated triple-quoted string' : 'unterminated string literal', {
            start: tokenStart,
            end: cursor,
            line: tokenLine,
            column: tokenColumn,
          })
        }
        // String text is deliberately not retained: only its extent matters.
        if (!pushToken('string', '', tokenStart, cursor, tokenLine, tokenColumn, stack.length)) break
        advanceTo(cursor)
        codeEnd = cursor
        continue
      }

      if (isNameStart(code)) {
        const tokenStart = index
        const tokenLine = line
        const tokenColumn = index - lineStart + 1
        let end = index + 1
        while (end < length && isNamePart(text.charCodeAt(end))) end += 1
        if (!pushToken('name', text.slice(tokenStart, end), tokenStart, end, tokenLine, tokenColumn, stack.length)) break
        advanceTo(end)
        codeEnd = end
        continue
      }

      if (code >= 48 && code <= 57) {
        const tokenStart = index
        const tokenLine = line
        const tokenColumn = index - lineStart + 1
        let end = index + 1
        // Number spelling is not interpreted; consuming the run keeps digits,
        // dots, exponents and hex digits inside one token.
        while (end < length) {
          const next = text.charCodeAt(end)
          if (isNamePart(next) || next === 46) end += 1
          else break
        }
        if (!pushToken('number', text.slice(tokenStart, end), tokenStart, end, tokenLine, tokenColumn, stack.length)) break
        advanceTo(end)
        codeEnd = end
        continue
      }

      const tokenStart = index
      const tokenLine = line
      const tokenColumn = index - lineStart + 1
      const character = text[index]
      const depth = stack.length
      if (!pushToken('operator', character, tokenStart, tokenStart + 1, tokenLine, tokenColumn, depth)) break
      if (character === '(') stack.push(')')
      else if (character === '[') stack.push(']')
      else if (character === '{') stack.push('}')
      else if (character === ')' || character === ']' || character === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === character) {
          stack.pop()
        } else {
          ctx.parseError(`unmatched closing '${character}'`, {
            start: tokenStart,
            end: tokenStart + 1,
            line: tokenLine,
            column: tokenColumn,
          })
          // Recover as if it closed the innermost open bracket; otherwise one
          // stray `]` would swallow the rest of the file.
          if (stack.length > 0) stack.pop()
        }
      }
      advanceTo(tokenStart + 1)
      codeEnd = tokenStart + 1
    }

    if (stopped) break
    if (index >= length && stack.length > 0) {
      ctx.parseError('unbalanced brackets at end of file', {
        start: Math.min(codeEnd, length),
        end: Math.min(codeEnd, length),
        line,
        column: index - lineStart + 1,
      })
    }
    if (lineTokens.length > 0) {
      lines.push({ indent: indentColumns, tokens: lineTokens })
    }
  }

  return { lines, tokens: totalTokens }
}

/** Identifier start: ASCII letter, `_`, or any non-ASCII code unit. */
function isNameStart(code: number): boolean {
  if (code >= 128) return true
  if (code === 95) return true
  if (code >= 65 && code <= 90) return true
  return code >= 97 && code <= 122
}

/** Identifier continuation: start characters plus ASCII digits. */
function isNamePart(code: number): boolean {
  return isNameStart(code) || (code >= 48 && code <= 57)
}

/* ------------------------------------------------------------------------- *
 * Statement classification
 * ------------------------------------------------------------------------- */

/** Index of `def` in `[async] def ...`, or -1 when the line is not a def. */
function defDeclarationIndex(tokens: readonly PythonToken[]): number {
  if (tokens[0]?.text === 'def') return 0
  if (tokens[0]?.text === 'async' && tokens[1]?.text === 'def') return 1
  return -1
}

/** First `:` token at statement top level at or after `from`, or -1. */
function findHeaderColon(tokens: readonly PythonToken[], from: number): number {
  for (let position = from; position < tokens.length; position += 1) {
    const token = tokens[position]
    if (token.text === ':' && token.depth === 0) return position
  }
  return -1
}

/** True when the logical line ends with a top-level colon (a block header). */
function endsWithBlockColon(tokens: readonly PythonToken[]): boolean {
  const last = tokens[tokens.length - 1]
  return last !== undefined && last.text === ':' && last.depth === 0
}

/** Span from the start of `first` through the end of `last`. */
function tokenRangeSpan(first: PythonToken, last: PythonToken): SourceSpan {
  return {
    start: first.span.start,
    end: last.span.end,
    line: first.span.line,
    column: first.span.column,
  }
}

/** Concatenate the text of `tokens[start..end]` (inclusive). */
function joinTokenText(tokens: readonly PythonToken[], start: number, end: number): string {
  let text = ''
  for (let position = start; position <= end; position += 1) text += tokens[position].text
  return text
}

/** Nearest lexical frame, skipping non-lexical `if`/`for`/... blocks. */
function lexicalFrame(frames: readonly BlockFrame[]): BlockFrame | undefined {
  for (let position = frames.length - 1; position >= 0; position -= 1) {
    if (frames[position].kind !== 'block') return frames[position]
  }
  return undefined
}

/** Lexical scope kind of the line being classified. */
function lexicalContext(frames: readonly BlockFrame[]): 'module' | 'class' | 'function' {
  const frame = lexicalFrame(frames)
  if (frame === undefined) return 'module'
  return frame.kind === 'class' ? 'class' : 'function'
}

/** Nearest enclosing class name, or `undefined` when a function intervenes. */
function nearestClassName(frames: readonly BlockFrame[]): string | undefined {
  for (let position = frames.length - 1; position >= 0; position -= 1) {
    const frame = frames[position]
    if (frame.kind === 'class') return frame.name
    if (frame.kind === 'function') return undefined
  }
  return undefined
}

function makeSymbol(
  kind: PythonSymbolKind,
  name: string,
  span: SourceSpan,
  scope: PythonSymbolScope,
  ownerClass: string | undefined,
): PythonSymbol {
  return {
    kind,
    name,
    span,
    scope,
    ...(ownerClass === undefined ? {} : { ownerClass }),
  }
}

function handleClass(
  ctx: ParseContext,
  line: LogicalLine,
  tokens: readonly PythonToken[],
  frames: readonly BlockFrame[],
  addSymbol: (symbol: PythonSymbol) => void,
): PendingBlock | undefined {
  const nameToken = tokens[1]
  const colon = findHeaderColon(tokens, 2)
  if (nameToken === undefined || nameToken.kind !== 'name' || PYTHON_KEYWORDS.has(nameToken.text)) {
    ctx.parseError('class declaration is missing a name', tokens[0].span)
    return colon >= 0 ? { indent: line.indent, kind: 'block' } : undefined
  }
  if (colon < 0) {
    ctx.parseError('class declaration has no header colon', tokens[0].span)
    return undefined
  }
  const context = lexicalContext(frames)
  if (context === 'function') {
    // A class in a function body is not extracted, but its body must keep the
    // function scope so its assignments are not mistaken for globals.
    return { indent: line.indent, kind: 'block' }
  }
  const span = tokenRangeSpan(tokens[0], tokens[colon])
  const ownerClass = context === 'class' ? nearestClassName(frames) : undefined
  addSymbol(makeSymbol('class', nameToken.text, span, context, ownerClass))
  return { indent: line.indent, kind: 'class', name: nameToken.text }
}

function handleDef(
  ctx: ParseContext,
  line: LogicalLine,
  tokens: readonly PythonToken[],
  defIndex: number,
  frames: readonly BlockFrame[],
  addSymbol: (symbol: PythonSymbol) => void,
): PendingBlock | undefined {
  const nameToken = tokens[defIndex + 1]
  const colon = findHeaderColon(tokens, defIndex + 2)
  if (nameToken === undefined || nameToken.kind !== 'name' || PYTHON_KEYWORDS.has(nameToken.text)) {
    ctx.parseError('def declaration is missing a name', tokens[defIndex].span)
    return colon >= 0 ? { indent: line.indent, kind: 'block' } : undefined
  }
  if (colon < 0) {
    ctx.parseError('def declaration has no header colon', tokens[defIndex].span)
    return undefined
  }
  const context = lexicalContext(frames)
  if (context === 'function') {
    // Nested defs are outside the bounded extraction scope; treat the body as
    // a non-lexical block so enclosing-function detection still works.
    return { indent: line.indent, kind: 'block' }
  }
  const kind: PythonSymbolKind = context === 'class' ? 'method' : 'function'
  const span = tokenRangeSpan(tokens[0], tokens[colon])
  const ownerClass = kind === 'method' ? nearestClassName(frames) : undefined
  addSymbol(makeSymbol(kind, nameToken.text, span, context, ownerClass))
  return { indent: line.indent, kind: 'function' }
}

/** Emit module-level/class-body assignments; function-body assignments skipped. */
function handleAssignment(
  ctx: ParseContext,
  tokens: readonly PythonToken[],
  frames: readonly BlockFrame[],
  addSymbol: (symbol: PythonSymbol) => void,
): void {
  const context = lexicalContext(frames)
  if (context === 'function') return
  const targets = parseAssignmentNames(ctx.text, tokens)
  if (targets === undefined) return
  const ownerClass = context === 'class' ? nearestClassName(frames) : undefined
  for (const target of targets) {
    addSymbol(makeSymbol('variable', target.name, target.span, context, ownerClass))
  }
}

/* ------------------------------------------------------------------------- *
 * Imports
 * ------------------------------------------------------------------------- */

function createImportReference(
  ctx: ParseContext,
  specifier: string,
  span: SourceSpan,
  names: readonly string[],
  wildcard: boolean,
): FileReference {
  return {
    kind: 'import',
    specifier,
    // Python relative imports use leading dots; everything else is a bare
    // module path for the shared lexical classifier (stdlib/third-party).
    external: !specifier.startsWith('.'),
    span,
    ...(names.length === 0 ? {} : { names }),
    ...(wildcard ? { wildcard: true } : {}),
    ...fragmentForSpan(ctx, span),
  }
}

/** `import a.b`, `import a as x`, `import a, b.c as d`. */
function handleImportStatement(
  ctx: ParseContext,
  tokens: readonly PythonToken[],
  addReference: (reference: FileReference) => void,
): void {
  let position = 1
  while (position < tokens.length) {
    const token = tokens[position]
    if (token.text === ';') return
    if (token.text === ',') {
      position += 1
      continue
    }
    if (token.kind !== 'name' || PYTHON_KEYWORDS.has(token.text)) {
      ctx.parseError('malformed import statement', token.span)
      return
    }
    const start = position
    let end = position
    position += 1
    while (
      position + 1 < tokens.length &&
      tokens[position].text === '.' &&
      tokens[position + 1].kind === 'name'
    ) {
      position += 2
      end = position - 1
    }
    if (tokens[position]?.text === 'as') {
      if (tokens[position + 1]?.kind === 'name') {
        position += 2
      } else {
        ctx.parseError('import alias is missing a name', tokens[position].span)
        position += 1
      }
    }
    const specifier = joinTokenText(tokens, start, end)
    if (specifier.length === 0) {
      ctx.parseError('import statement has an empty module name', tokens[start].span)
      return
    }
    addReference(createImportReference(ctx, specifier, tokenRangeSpan(tokens[start], tokens[end]), [], false))
    const next = tokens[position]
    if (next === undefined || next.text === ';') return
    if (next.text !== ',') {
      ctx.parseError('unexpected token after imported module', next.span)
      return
    }
    position += 1
  }
}

/** `from a.b import c`, `from . import x`, `from a import (b, c as d)`, `... import *`. */
function handleFromImport(
  ctx: ParseContext,
  tokens: readonly PythonToken[],
  addReference: (reference: FileReference) => void,
): void {
  let position = 1
  let start = -1
  let end = -1
  while (position < tokens.length) {
    const token = tokens[position]
    if (token.text === 'import') break
    if (token.text !== '.' && token.kind !== 'name') break
    if (start < 0) start = position
    end = position
    position += 1
  }
  if (start < 0 || end < 0) {
    ctx.parseError('from-import is missing a module', tokens[0].span)
    return
  }
  if (tokens[position]?.text !== 'import') {
    ctx.parseError('from-import is missing the import keyword', tokens[start].span)
    return
  }
  position += 1
  const names: string[] = []
  let wildcard = false
  while (position < tokens.length) {
    const token = tokens[position]
    if (token.text === ';') break
    if (token.text === '*') {
      names.push('*')
      wildcard = true
      position += 1
      continue
    }
    if (token.text === 'as') {
      // The alias is a local binding; imported names are the ones before `as`.
      position += 2
      continue
    }
    if (token.text === ',') {
      position += 1
      continue
    }
    if (token.text === '(' || token.text === ')') {
      position += 1
      continue
    }
    if (token.kind === 'name') {
      names.push(token.text)
      position += 1
      continue
    }
    break
  }
  const specifier = joinTokenText(tokens, start, end)
  addReference(
    createImportReference(
      ctx,
      specifier,
      tokenRangeSpan(tokens[start], tokens[end]),
      names,
      wildcard,
    ),
  )
}

/* ------------------------------------------------------------------------- *
 * Assignments
 * ------------------------------------------------------------------------- */

/**
 * Names bound by a module/class assignment statement, or `undefined` when the
 * line is not a simple assignment. Chained assignments are followed while the
 * token after `=` starts another simple target list (`a = b = 1` → `a`, `b`).
 */
function parseAssignmentNames(
  text: string,
  tokens: readonly PythonToken[],
): TargetName[] | undefined {
  const names: TargetName[] = []
  let start = 0
  while (start < tokens.length) {
    const parsed = parseTargetList(text, tokens, start)
    if (parsed === undefined) break
    names.push(...parsed.names)
    const possibleTarget = tokens[parsed.equals + 1]
    if (possibleTarget === undefined || possibleTarget.kind !== 'name' || PYTHON_KEYWORDS.has(possibleTarget.text)) {
      break
    }
    if (!isAssignmentEquals(text, tokens[parsed.equals + 2])) break
    start = parsed.equals + 1
  }
  return names.length === 0 ? undefined : names
}

/**
 * Parse `NAME`, `a, b`, `(a, b)`, `[a, b]`, annotated and starred simple target
 * lists followed by `=`. Rejects attribute/subscript/nested-destructuring
 * targets instead of guessing partial names.
 */
function parseTargetList(
  text: string,
  tokens: readonly PythonToken[],
  start: number,
): TargetList | undefined {
  let position = start
  let closer: string | undefined
  const opening = tokens[position]
  if (opening === undefined) return undefined
  if (opening.text === '(') {
    closer = ')'
    position += 1
  } else if (opening.text === '[') {
    closer = ']'
    position += 1
  }
  const names: TargetName[] = []
  let expectingName = true
  while (position < tokens.length) {
    const token = tokens[position]
    if (token.text === ',') {
      if (expectingName) return undefined
      position += 1
      expectingName = true
      if (closer !== undefined && tokens[position]?.text === closer) {
        position += 1
        break
      }
      continue
    }
    if (closer !== undefined && token.text === closer) {
      if (names.length === 0 || expectingName) return undefined
      position += 1
      break
    }
    if (token.text === '*') {
      if (!expectingName) return undefined
      position += 1
      if (tokens[position]?.kind !== 'name') return undefined
      continue
    }
    if (token.kind !== 'name' || PYTHON_KEYWORDS.has(token.text)) return undefined
    if (token.depth !== (closer === undefined ? 0 : 1)) return undefined
    names.push({ name: token.text, span: token.span })
    position += 1
    expectingName = false
    const separator = tokens[position]
    if (separator === undefined) return undefined
    if (separator.text === ',') {
      position += 1
      expectingName = true
      if (closer !== undefined && tokens[position]?.text === closer) {
        position += 1
        break
      }
      continue
    }
    if (closer !== undefined && separator.text === closer) {
      position += 1
      break
    }
    if (closer === undefined && (separator.text === ':' || isAssignmentEquals(text, separator))) break
    return undefined
  }

  const separator = tokens[position]
  if (separator === undefined) return undefined
  if (separator.text === ':') {
    const annotationStart = position + 1
    let cursor = annotationStart
    while (cursor < tokens.length) {
      if (tokens[cursor].depth === 0 && isAssignmentEquals(text, tokens[cursor])) break
      cursor += 1
    }
    if (cursor >= tokens.length || cursor === annotationStart) return undefined
    position = cursor
  }
  if (!isAssignmentEquals(text, tokens[position])) return undefined
  if (tokens[position + 1] === undefined) return undefined
  return { names, equals: position }
}

/** True for a single assignment `=` (not `==`, `!=`, `<=`, `>=`, `:=`), depth 0. */
function isAssignmentEquals(text: string, token: PythonToken | undefined): boolean {
  if (token === undefined || token.text !== '=' || token.depth !== 0) return false
  const previous = token.span.start > 0 ? text.charCodeAt(token.span.start - 1) : -1
  const next = token.span.end < text.length ? text.charCodeAt(token.span.end) : -1
  if (next === 0x3d) return false
  return previous !== 0x3d && previous !== 0x21 && previous !== 0x3c && previous !== 0x3e && previous !== 0x3a
}

/* ------------------------------------------------------------------------- *
 * Metadata and AST projection
 * ------------------------------------------------------------------------- */

/**
 * Build source-ordered graph nodes: one `importation` node per import reference
 * and one node per extracted symbol. Docstring/comment text is never copied;
 * symbols carry only kind, name, locator, fragment and a body-free reference.
 */
function buildNodes(ctx: ParseContext, declarations: readonly Declaration[]): NodeMetadata[] {
  const nodes: NodeMetadata[] = []
  for (let index = 0; index < declarations.length; index += 1) {
    if ((index & 255) === 0 && !ctx.checkpoint()) break
    const declaration = declarations[index]
    if ('reference' in declaration) {
      const reference = declaration.reference
      try {
        pushNodeMetadata(ctx, nodes, {
          kind: 'importation',
          name: sanitizeMetadataText(reference.specifier, MAX_NAME_LENGTH),
          ...(reference.names === undefined || reference.names.length === 0
            ? {}
            : { label: sanitizeMetadataText(reference.names.join(', '), MAX_NAME_LENGTH) }),
          span: reference.span,
          fragment: fragmentForSpan(ctx, reference.span),
        })
      } catch {
        // A fragment outside the parsed text keeps its reference/AST node but
        // produces no graph node.
      }
      continue
    }
    const symbol = declaration.symbol
    const fragment = fragmentForSpan(ctx, symbol.span)
    Object.assign(symbol, fragment)
    let reference: NodeReference | undefined
    try {
      reference = referenceForSpan(ctx, {
        scheme: 'symbol',
        target: `${symbol.kind}:${symbol.name}`,
        span: symbol.span,
        parserId: 'python',
      })
      symbol.reference = reference
    } catch {
      reference = undefined
    }
    const name = sanitizeMetadataText(symbol.name, MAX_NAME_LENGTH)
    pushNodeMetadata(ctx, nodes, {
      kind: symbol.kind,
      ...(name.length === 0 ? {} : { name }),
      locator: `python:${symbol.kind}:${name}#${symbol.span.start}`,
      ...(reference === undefined ? {} : { reference }),
      fragment,
      source: 'none',
      span: symbol.span,
    })
  }
  return nodes
}

/** One root `module` node with a child per declaration, in source order. */
function buildAst(ctx: ParseContext, declarations: readonly Declaration[]): AstTree<string> {
  const root = createAstRoot('module', ctx.text.length)
  for (const declaration of declarations) {
    if ('reference' in declaration) {
      appendAstNode(ctx, root, 'import', declaration.reference.span, declaration.reference.specifier)
    } else {
      appendAstNode(ctx, root, declaration.symbol.kind, declaration.symbol.span, declaration.symbol.name)
    }
  }
  return new AstTree(root)
}
