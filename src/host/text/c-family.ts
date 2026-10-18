/**
 * C / C++ parser: preprocessor includes, namespaces, type declarations, free
 * functions, out-of-class method definitions and file-scope variables.
 *
 * Deliberately lexical, like the JavaScript/Java/Rust parsers: one O(n) token
 * pass (`charCodeAt`, no regular expressions, no dependencies, no file I/O)
 * drops whitespace and comments, consumes preprocessor directives and keeps one
 * `include` token per `#include`. A second linear pass over the significant
 * tokens classifies declarations; every recognised body is skipped exactly
 * once, so the total work stays O(n).
 *
 * What is extracted:
 *
 *  - `#include <x>` / `#include "x"` -> one `import` `FileReference` and one
 *    `importation` `NodeMetadata` per include (specifier = header name as
 *    written, span = the name without `< >` or the quotes);
 *  - `namespace N { ... }` -> one `module` node (name = `N`, span = the
 *    namespace header); the body is scanned at namespace scope;
 *  - `class`, `struct`, `union`, `enum` and `enum class` declarations,
 *    including forward declarations -> one `class` node each, `label` = the
 *    keyword; bodies are skipped and never projected;
 *  - free functions and function prototypes (`Ret f(...)`, `auto f() -> Ret`)
 *    -> `function`; an out-of-class definition (`Ret Class::method(...)`,
 *    `Class::Class(...)`, `Class::~Class(...)`) -> `method` with `label` =
 *    `Class::method` and `name` = `method`;
 *  - file-scope variables/constants -> one `variable` node per declarator,
 *    `label: 'const'` only for an explicit `const`/`constexpr` specifier;
 *  - `template <...>` prefixes are skipped and the following declaration is
 *    still emitted; attributes (`[[...]]`, `alignas`, `__attribute__`,
 *    `__declspec`) are skipped without breaking scanning.
 *
 * Kind mapping (checked against `NodeKind` in `src/host/node-registry.ts`; no
 * kind is added there):
 *
 * | C/C++ construct                         | `NodeMetadata.kind` | `label` |
 * |-----------------------------------------|---------------------|---------|
 * | `#include`                              | `importation`       | - |
 * | `namespace N { ... }`                   | `module`            | - |
 * | `class` / `struct` / `union` / `enum`   | `class`             | keyword |
 * | free function / prototype               | `function`          | - |
 * | `Class::method` / ctor / dtor definition| `method`            | `Class::method` |
 * | file-scope variable                     | `variable`          | - |
 * | `const` / `constexpr` variable          | `variable`          | `const` |
 *
 * Deliberate limits (reported as diagnostics, never guessed):
 *
 *  - function, method, type, namespace and enum bodies are skipped, never
 *    parsed, so local variables and nested declarations inside a body produce
 *    no nodes; comments produce no nodes at all, so no comment text is ever
 *    returned;
 *  - macros (`#define`, `#if`, ...) produce no nodes; `#include MACRO` cannot
 *    be resolved lexically and is reported as `unverifiable`;
 *  - class members (fields, member functions, access labels) are not projected:
 *    only out-of-class `Class::method` definitions become `method` nodes;
 *  - `typedef`/`using` aliases, concepts and lambdas are skipped without
 *    emitting a declaration; C++20 module/import declarations are not modelled,
 *    and a declaration the scanner cannot prove is dropped rather than guessed;
 *  - `operator` overloads and K&R-style definitions are not projected; a
 *    statement that declares several function declarators (`int a(void), b(void);`)
 *    yields at most the first `function` node;
 *  - malformed input (unterminated string/char/raw string/comment, unbalanced
 *    braces or parentheses) records `parse-error`/`unverifiable` diagnostics
 *    and returns an incomplete result; `parse` never throws for malformed text.
 *
 * Complexity: tokenizing O(n); declaration scan O(tokens) because every
 * recognised body is skipped once; metadata O(nodes), capped by
 * `MAX_METADATA_NODES`. Every loop is bounded by the shared text cap, token cap
 * and parse deadline.
 */
import { AstTree } from '../../shared/ast.js'
import type { AstNode, SourceSpan } from '../../shared/ast.js'
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
  ConceptBinding,
  ConceptScope,
  FileReference,
  NodeMetadata,
  NodeReference,
  ParseOptions,
  ParseResult,
  Parser,
} from './parser.js'

/** Parser id used in results and natural locators. */
const PARSER_ID = 'c-family'
/** Extensions claimed by this parser (registration is left to the integrator). */
const C_FAMILY_EXTENSIONS: readonly string[] = ['.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.hh']

/** Parser-specific result. The shared `ParseResult` already carries `nodes`. */
export type CFamilyParseResult = ParseResult

/** Significant tokens; comments, directives and whitespace are not re-emitted. */
type CTokenKind = 'word' | 'number' | 'string' | 'char' | 'punctuation' | 'include'

interface CToken {
  kind: CTokenKind
  /** Token text. For `include` tokens this is the header name without delimiters. */
  text: string
  span: SourceSpan
  /** Angle-bracket include (`#include <vector>`); only set on `include` tokens. */
  system?: boolean
}

/** One open block that the declaration scan must pop on its closing brace. */
type CScope = 'namespace' | 'extern'

/** Mutable state shared by the declaration scan. */
interface CParseState {
  ctx: ParseContext
  tokens: readonly CToken[]
  nodes: NodeMetadata[]
  references: FileReference[]
  root: AstNode<string>
  /** One entry per open namespace/extern block, popped on the matching `}`. */
  scopes: CScope[]
}

/** Type keywords that open a type declaration (not an elaborated type use). */
type CTypeKeyword = 'class' | 'struct' | 'union' | 'enum'

/** Emit options for one metadata node. */
interface EmitNodeOptions {
  kind: 'class' | 'function' | 'method' | 'variable' | 'module' | 'importation'
  name: string
  /** C/C++ nuance: declaration keyword, `Class::method`, or `const`. */
  label?: string
  binding?: ConceptBinding
  scope?: ConceptScope
  scheme?: 'symbol' | 'module'
  target?: string
  span: SourceSpan
}

/** Result of scanning a class-like declaration header up to its body/semicolon. */
interface TypeHeaderEnd {
  bodyOpen: number
  semicolon: number
}

/**
 * Parse C/C++ source.
 *
 * Time O(n) in the source length, space O(tokens + nodes). Never throws for
 * malformed code; throws only when `options.signal` is already aborted (the
 * standard `AbortSignal` contract).
 */
export function parseCFamily(text: string, options: ParseOptions = {}): CFamilyParseResult {
  const ctx = new ParseContext(text, options)
  const tokens = tokenizeC(ctx)
  const root = createAstRoot('module', ctx.text.length)
  const state: CParseState = { ctx, tokens, nodes: [], references: [], root, scopes: [] }

  scanDeclarations(state)

  return ctx.finalize({
    parserId: PARSER_ID,
    references: state.references,
    tokens: ctx.tokens,
    ast: new AstTree(root),
    nodes: state.nodes,
  })
}

/** `Parser` implementation; registration is intentionally left to the integrator. */
export class CFamilyParser implements Parser {
  readonly id = PARSER_ID
  readonly extensions: readonly string[] = C_FAMILY_EXTENSIONS

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parseCFamily(text, options)
  }
}

/** Shared singleton for the future registry (`./index.ts`). */
export const cFamilyParser = new CFamilyParser()

/* ------------------------------------------------------------------------- *
 * Tokenizer
 * ------------------------------------------------------------------------- */

/**
 * Scan C/C++ source into a flat significant-token array.
 *
 * Comments and preprocessor directives are consumed and never stored; a
 * literal `#include` becomes one `include` token carrying the header name and
 * its inner span, so include references can be emitted in source order during
 * the declaration scan. Unterminated strings, character literals, raw strings,
 * block comments and directives are diagnosed and the scan continues, so
 * malformed input cannot throw.
 */
function tokenizeC(ctx: ParseContext): CToken[] {
  const text = ctx.text
  const length = text.length
  const tokens: CToken[] = []
  let index = 0
  let line = 1
  let column = 1
  let scanned = 0
  /** True when only whitespace has been seen since the last line break. */
  let lineStart = true

  const push = (
    kind: CTokenKind,
    start: number,
    startLine: number,
    startColumn: number,
  ): void => {
    tokens.push({
      kind,
      text: text.slice(start, index),
      span: { start, end: index, line: startLine, column: startColumn },
    })
  }

  /** Scan a single- or double-quoted body; `index` starts at the opening quote. */
  const scanQuoted = (quoteCode: number): void => {
    const start = index
    const startLine = line
    const startColumn = column
    index += 1
    column += 1
    let closed = false
    while (index < length) {
      const current = text.charCodeAt(index)
      if (current === 92) {
        index += 1
        column += 1
        if (index < length) {
          const escaped = text.charCodeAt(index)
          if (escaped === 10) {
            index += 1
            line += 1
            column = 1
          } else if (escaped === 13) {
            index += 1
            if (text.charCodeAt(index) === 10) index += 1
            line += 1
            column = 1
          } else {
            index += 1
            column += 1
          }
        }
        continue
      }
      if (current === quoteCode) {
        index += 1
        column += 1
        closed = true
        break
      }
      // An unescaped line break cannot appear in a C/C++ literal.
      if (current === 10 || current === 13) break
      index += 1
      column += 1
    }
    if (!closed) {
      ctx.parseError(
        quoteCode === 34 ? 'unterminated string literal' : 'unterminated character literal',
        { start, end: index, line: startLine, column: startColumn },
      )
    }
  }

  /** Scan a raw string (`R"delim(...)delim"`); `index` starts at the quote. */
  const scanRawString = (): void => {
    const start = index
    const startLine = line
    const startColumn = column
    index += 1
    column += 1
    const delimiterStart = index
    let delimiterEnd = index
    while (delimiterEnd < length && delimiterEnd - delimiterStart <= 16) {
      const current = text.charCodeAt(delimiterEnd)
      if (current === 40) break
      if (current === 10 || current === 13 || current === 34 || current === 92) break
      delimiterEnd += 1
    }
    if (text.charCodeAt(delimiterEnd) !== 40) {
      ctx.parseError('malformed raw string literal', { start, end: delimiterEnd, line: startLine, column: startColumn })
      index = delimiterEnd
      column += delimiterEnd - delimiterStart
      return
    }
    const delimiter = text.slice(delimiterStart, delimiterEnd)
    index = delimiterEnd + 1
    column += delimiterEnd - delimiterStart + 1
    const terminator = `)${delimiter}"`
    let closed = false
    while (index < length) {
      const current = text.charCodeAt(index)
      if (current === 41 && text.startsWith(terminator, index)) {
        index += terminator.length
        column += terminator.length
        closed = true
        break
      }
      if (current === 10) {
        index += 1
        line += 1
        column = 1
        continue
      }
      if (current === 13) {
        index += 1
        if (text.charCodeAt(index) === 10) index += 1
        line += 1
        column = 1
        continue
      }
      index += 1
      column += 1
    }
    if (!closed) {
      ctx.parseError('unterminated raw string literal', { start, end: length, line: startLine, column: startColumn })
    }
  }

  /**
   * Consume one preprocessor directive starting at `#`. Only `#include` emits a
   * token; macros and conditionals are dropped. Backslash-newline continuations
   * are part of the same logical line.
   */
  const scanDirective = (): void => {
    const directiveStart = index
    const directiveLine = line
    const directiveColumn = column
    index += 1
    column += 1
    while (index < length) {
      const current = text.charCodeAt(index)
      if (current === 32 || current === 9) {
        index += 1
        column += 1
        continue
      }
      break
    }
    const nameStart = index
    while (index < length && isWordPartCode(text.charCodeAt(index))) {
      index += 1
      column += 1
    }
    const directive = text.slice(nameStart, index)

    if (directive === 'include' || directive === 'include_next') {
      while (index < length) {
        const current = text.charCodeAt(index)
        if (current === 32 || current === 9) {
          index += 1
          column += 1
          continue
        }
        break
      }
      const open = text.charCodeAt(index)
      if (open === 60 || open === 34) {
        const close = open === 60 ? 62 : 34
        const contentStart = index + 1
        const contentLine = line
        const contentColumn = column + 1
        index += 1
        column += 1
        let closed = false
        while (index < length) {
          const current = text.charCodeAt(index)
          if (current === 10 || current === 13) break
          if (current === close) {
            closed = true
            break
          }
          index += 1
          column += 1
        }
        if (closed) {
          tokens.push({
            kind: 'include',
            text: text.slice(contentStart, index),
            span: { start: contentStart, end: index, line: contentLine, column: contentColumn },
            system: open === 60,
          })
          index += 1
          column += 1
        } else {
          ctx.parseError('unterminated #include header name', {
            start: contentStart,
            end: index,
            line: contentLine,
            column: contentColumn,
          })
        }
      } else if (isWordStartCode(open)) {
        ctx.unverifiable('#include uses a macro header name; no reference emitted', {
          start: index,
          end: Math.min(length, index + 32),
          line,
          column,
        })
      } else {
        ctx.parseError('#include has no header name', {
          start: directiveStart,
          end: index,
          line: directiveLine,
          column: directiveColumn,
        })
      }
    }

    // Skip the rest of the logical line, including backslash continuations.
    while (index < length) {
      const current = text.charCodeAt(index)
      if (current === 92) {
        const next = text.charCodeAt(index + 1)
        if (next === 10 || next === 13) {
          index += 1
          column += 1
          if (text.charCodeAt(index) === 13) {
            index += 1
            if (text.charCodeAt(index) === 10) index += 1
          } else {
            index += 1
          }
          line += 1
          column = 1
          continue
        }
      }
      if (current === 10 || current === 13) break
      index += 1
      column += 1
    }
  }

  while (index < length) {
    // Check the deadline/abort signal on a character stride as well as the
    // token cap, so a long comment or whitespace run cannot hide a timeout.
    if ((index & 4_095) === 0 && !ctx.checkpoint()) break
    const code = text.charCodeAt(index)

    if (code === 10) {
      index += 1
      line += 1
      column = 1
      lineStart = true
      continue
    }
    if (code === 13) {
      index += 1
      if (text.charCodeAt(index) === 10) index += 1
      line += 1
      column = 1
      lineStart = true
      continue
    }
    if (code === 32 || code === 9 || code === 12 || code === 11 || code === 0xfeff) {
      index += 1
      column += 1
      continue
    }

    // Line comment: one trivia token, no body retained.
    if (code === 47 && text.charCodeAt(index + 1) === 47) {
      index += 2
      column += 2
      while (index < length) {
        const current = text.charCodeAt(index)
        if (current === 10 || current === 13) break
        index += 1
        column += 1
      }
      scanned += 1
      continue
    }

    // Block comment; an unterminated one is a diagnostic, not a throw.
    if (code === 47 && text.charCodeAt(index + 1) === 42) {
      const start = index
      const startLine = line
      const startColumn = column
      index += 2
      column += 2
      let closed = false
      while (index < length) {
        const current = text.charCodeAt(index)
        if (current === 42 && text.charCodeAt(index + 1) === 47) {
          index += 2
          column += 2
          closed = true
          break
        }
        if (current === 10) {
          index += 1
          line += 1
          column = 1
          continue
        }
        if (current === 13) {
          index += 1
          if (text.charCodeAt(index) === 10) index += 1
          line += 1
          column = 1
          continue
        }
        index += 1
        column += 1
      }
      if (!closed) {
        ctx.parseError('unterminated block comment', {
          start,
          end: length,
          line: startLine,
          column: startColumn,
        })
      }
      scanned += 1
      continue
    }

    if (scanned >= ctx.maxTokens) {
      ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`, {
        start: index,
        end: index,
        line,
        column,
      })
      break
    }

    // A `#` that is the first non-whitespace character on its line starts a
    // preprocessor directive; a macro body may otherwise contain `#`.
    if (code === 35 && lineStart) {
      scanDirective()
      lineStart = false
      scanned += 1
      continue
    }
    lineStart = false

    const start = index
    const startLine = line
    const startColumn = column

    // String literal.
    if (code === 34) {
      scanQuoted(34)
      push('string', start, startLine, startColumn)
      scanned += 1
      continue
    }

    // Character literal.
    if (code === 39) {
      scanQuoted(39)
      push('char', start, startLine, startColumn)
      scanned += 1
      continue
    }

    // Numeric literal: deliberately permissive; only the boundary matters.
    if (isAsciiDigit(code) || (code === 46 && isAsciiDigit(text.charCodeAt(index + 1)))) {
      index += 1
      column += 1
      let previous = code
      while (index < length) {
        const current = text.charCodeAt(index)
        if (isAsciiDigit(current) || isAsciiLetter(current) || current === 95 || current === 46 || current === 39) {
          index += 1
          column += 1
          previous = current
          continue
        }
        if (
          (current === 43 || current === 45) &&
          (previous === 69 || previous === 101 || previous === 80 || previous === 112)
        ) {
          index += 1
          column += 1
          previous = current
          continue
        }
        break
      }
      push('number', start, startLine, startColumn)
      scanned += 1
      continue
    }

    // Identifier/keyword, including string/char literal prefixes (`L"x"`,
    // `u8"x"`, `R"(...)"`, `u8R"(...)"`).
    if (isWordStartCode(code)) {
      index += 1
      column += 1
      while (index < length && isWordPartCode(text.charCodeAt(index))) {
        index += 1
        column += 1
      }
      const prefix = text.slice(start, index)
      const quote = text.charCodeAt(index)
      if (quote === 34 && RAW_STRING_PREFIXES.has(prefix)) {
        scanRawString()
        push('string', start, startLine, startColumn)
        scanned += 1
        continue
      }
      if (quote === 34 && STRING_PREFIXES.has(prefix)) {
        scanQuoted(34)
        push('string', start, startLine, startColumn)
        scanned += 1
        continue
      }
      if (quote === 39 && STRING_PREFIXES.has(prefix)) {
        scanQuoted(39)
        push('char', start, startLine, startColumn)
        scanned += 1
        continue
      }
      push('word', start, startLine, startColumn)
      scanned += 1
      continue
    }

    // Punctuation/operator. `::`, `->` and `...` are merged because the
    // structural scan reads qualified names and trailing return types; every
    // other operator is split into single code units, which is enough for
    // structural matching.
    if (code === 58 && text.charCodeAt(index + 1) === 58) {
      index += 2
      column += 2
      push('punctuation', start, startLine, startColumn)
      scanned += 1
      continue
    }
    if (code === 45 && text.charCodeAt(index + 1) === 62) {
      index += 2
      column += 2
      push('punctuation', start, startLine, startColumn)
      scanned += 1
      continue
    }
    if (
      code === 46 &&
      text.charCodeAt(index + 1) === 46 &&
      text.charCodeAt(index + 2) === 46
    ) {
      index += 3
      column += 3
      push('punctuation', start, startLine, startColumn)
      scanned += 1
      continue
    }
    index += 1
    column += 1
    push('punctuation', start, startLine, startColumn)
    scanned += 1
  }

  ctx.tokens = scanned
  return tokens
}

/** String literal prefixes that may precede `"` or `'`. */
const STRING_PREFIXES: ReadonlySet<string> = new Set(['L', 'u', 'U', 'u8'])
/** Raw string literal prefixes that may precede `"`. */
const RAW_STRING_PREFIXES: ReadonlySet<string> = new Set(['R', 'LR', 'uR', 'UR', 'u8R'])

/** Keywords/type specifiers that can never be a declared name. */
const NON_NAME_WORDS: ReadonlySet<string> = new Set([
  'alignas', 'alignof', 'asm', 'auto', 'bool', 'break', 'case', 'catch', 'char',
  'char8_t', 'char16_t', 'char32_t', 'class', 'const', 'consteval', 'constexpr',
  'constinit', 'const_cast', 'continue', 'decltype', 'default', 'delete', 'do',
  'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern',
  'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long',
  'mutable', 'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'private',
  'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'return',
  'short', 'signed', 'sizeof', 'static', 'static_assert', 'static_cast',
  'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true',
  'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using',
  'virtual', 'void', 'volatile', 'wchar_t', 'while', '__asm__', '__attribute__',
  '__cdecl', '__declspec', '__attribute', '__extension__', '__inline', '__pragma',
  '__restrict', '__volatile__', '_Pragma',
])

/** Words never accepted as a function/method name by the candidate scan. */
const CALL_EXCLUSIONS: ReadonlySet<string> = new Set([
  'alignas', 'alignof', 'assert', 'catch', 'decltype', 'delete', 'do', 'else',
  'for', 'if', 'new', 'noexcept', 'operator', 'requires', 'return', 'sizeof',
  'static_assert', 'switch', 'throw', 'typeof', 'while', '__attribute__',
  '__cdecl', '__declspec', '__typeof__', 'co_await', 'co_return', 'co_yield',
])

/** Class-like declaration keywords. */
const TYPE_KEYWORDS: ReadonlySet<string> = new Set(['class', 'struct', 'union', 'enum'])

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isWordStartCode(code: number): boolean {
  // C/C++ identifiers are ASCII plus implementation-defined universal
  // characters; treating every code unit >= 128 as a word part keeps the scan
  // linear and accepts UTF-8 identifiers.
  return code === 95 || code === 36 || isAsciiLetter(code) || code >= 128
}

function isWordPartCode(code: number): boolean {
  return isWordStartCode(code) || isAsciiDigit(code)
}

function isWordToken(token: CToken | undefined): boolean {
  return token !== undefined && token.kind === 'word'
}

/* ------------------------------------------------------------------------- *
 * Declaration scan
 * ------------------------------------------------------------------------- */

/**
 * Walk the significant tokens once and emit nodes in source order.
 *
 * Every handler consumes at least one token and skips any body it recognises,
 * so no loop can stall and the total work is linear. Namespace/extern bodies
 * stay on this scan; function/type bodies are skipped because children inside
 * them are never projected.
 */
function scanDeclarations(state: CParseState): void {
  const { ctx, tokens } = state
  let position = 0
  while (position < tokens.length) {
    if ((position & 255) === 0 && !ctx.checkpoint()) break
    const token = tokens[position]

    if (token.kind === 'include') {
      emitInclude(state, token)
      position += 1
      continue
    }

    const text = token.text
    if (text === ';') {
      position += 1
      continue
    }
    if (text === '}') {
      if (state.scopes.length > 0) state.scopes.pop()
      else ctx.parseError('unbalanced closing brace', token.span)
      position += 1
      continue
    }
    if (text === 'extern' && tokens[position + 1]?.kind === 'string') {
      if (tokens[position + 2]?.text === '{') {
        state.scopes.push('extern')
        position += 3
        continue
      }
      position = advance(dispatchDeclaration(state, position, position), position)
      continue
    }
    if (text === 'template') {
      const next = skipTemplatePrefix(state, position)
      if (next < 0) {
        position = skipToSemicolon(state, position)
        continue
      }
      position = advance(dispatchDeclaration(state, next, position), position)
      continue
    }
    // Attributes may precede any declaration; they never emit a node.
    if ((text === '[' && tokens[position + 1]?.text === '[') || isAnnotationWord(text)) {
      const next = skipAnnotations(tokens, position)
      if (next > position) {
        position = advance(dispatchDeclaration(state, next, position), position)
        continue
      }
    }

    position = advance(dispatchDeclaration(state, position, position), position)
  }

  if (state.scopes.length > 0) {
    ctx.unverifiableOnce(
      'unterminated-scope',
      'namespace or extern block is not closed at end of file',
    )
  }
}

/** Ensure forward progress even if a handler ever returns its own position. */
function advance(next: number, previous: number): number {
  return next > previous ? next : previous + 1
}

/** Classify one statement at `start`, emitting the declarations it proves. */
function dispatchDeclaration(state: CParseState, start: number, spanStart: number): number {
  const { tokens } = state
  const token = tokens[start]
  if (token === undefined) return tokens.length
  const text = token.text

  if (text === 'namespace' || (text === 'inline' && tokens[start + 1]?.text === 'namespace')) {
    return handleNamespace(state, start, spanStart)
  }
  if (TYPE_KEYWORDS.has(text)) {
    return handleTypeDeclaration(state, start, spanStart)
  }
  // Statements that are not declarations and contain no node of their own.
  if (
    text === 'static_assert' ||
    text === '_Static_assert' ||
    text === 'using' ||
    text === 'export' ||
    text === 'concept' ||
    (text === 'extern' && tokens[start + 1]?.text === 'template')
  ) {
    return skipToSemicolon(state, start)
  }
  return scanDeclaration(state, start, spanStart)
}

/** Skip tokens up to and including the next top-level `;`. */
function skipToSemicolon(state: CParseState, start: number): number {
  const { tokens } = state
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let position = start; position < tokens.length; position += 1) {
    const text = tokens[position].text
    if (text === '(') parens += 1
    else if (text === ')') parens = Math.max(0, parens - 1)
    else if (text === '[') brackets += 1
    else if (text === ']') brackets = Math.max(0, brackets - 1)
    else if (text === '{') braces += 1
    else if (text === '}') {
      if (braces === 0) return position > start ? position : start + 1
      braces -= 1
    } else if (text === ';' && parens === 0 && brackets === 0 && braces === 0) {
      return position + 1
    }
  }
  return tokens.length
}

/**
 * Skip a `template <...>` prefix and return the index of the declaration that
 * follows it; `-1` when the prefix is malformed or is a bare explicit
 * instantiation (`template class Foo<int>;`), which produces no nodes.
 */
function skipTemplatePrefix(state: CParseState, position: number): number {
  const { ctx, tokens } = state
  let cursor = position + 1
  if (tokens[cursor]?.text !== '<') return -1
  const close = findMatchingAngles(tokens, cursor)
  if (close < 0) {
    ctx.parseError('template parameter list is unterminated', tokens[cursor].span)
    return -1
  }
  return close + 1
}

/* ------------------------------------------------------------------------- *
 * Namespaces
 * ------------------------------------------------------------------------- */

/** `namespace N { ... }`, `inline namespace N { ... }`, `namespace A::B { ... }`. */
function handleNamespace(state: CParseState, start: number, spanStart: number): number {
  const { ctx, tokens } = state
  let keyword = start
  if (tokens[start].text === 'inline') keyword += 1
  const keywordToken = tokens[keyword]
  if (keywordToken === undefined) return tokens.length

  let cursor = skipAnnotations(tokens, keyword + 1)
  let name = ''
  if (isWordToken(tokens[cursor])) {
    const parts: string[] = [tokens[cursor].text]
    cursor += 1
    while (tokens[cursor]?.text === '::' && isWordToken(tokens[cursor + 1])) {
      parts.push(tokens[cursor + 1].text)
      cursor += 2
    }
    name = parts.join('::')
  }
  cursor = skipAnnotations(tokens, cursor)

  let bodyOpen = -1
  let semicolon = -1
  const limit = Math.min(tokens.length, cursor + 64)
  for (let position = cursor; position < limit; position += 1) {
    const text = tokens[position].text
    if (text === '{') {
      bodyOpen = position
      break
    }
    if (text === ';') {
      semicolon = position
      break
    }
  }

  if (bodyOpen < 0 && semicolon < 0) {
    ctx.parseError('namespace header is not terminated', keywordToken.span)
    return Math.min(tokens.length, cursor + 1)
  }
  if (bodyOpen < 0 || (semicolon >= 0 && semicolon < bodyOpen)) {
    // `namespace N = A::B;` / `namespace N;`: no body, no node per taxonomy.
    return semicolon + 1
  }
  // An anonymous namespace has no name to store; its `}` is still tracked so
  // the declaration scan stays balanced.
  if (name.length > 0) {
    const span: SourceSpan = {
      start: tokens[spanStart].span.start,
      end: tokens[bodyOpen].span.start,
      line: tokens[spanStart].span.line,
      column: tokens[spanStart].span.column,
    }
    emitNode(state, {
      kind: 'module',
      name,
      binding: 'identifier',
      scope: 'global',
      scheme: 'module',
      target: name,
      span,
    })
  }
  state.scopes.push('namespace')
  return bodyOpen + 1
}

/* ------------------------------------------------------------------------- *
 * Type declarations
 * ------------------------------------------------------------------------- */

/**
 * `class` / `struct` / `union` / `enum` declaration, its forward declaration,
 * or an elaborated type use (`struct Foo *p;`) that is handed back to the
 * declaration scan as a variable/function statement.
 */
function handleTypeDeclaration(state: CParseState, keywordIndex: number, spanStart: number): number {
  const { ctx, tokens } = state
  const keywordToken = tokens[keywordIndex]
  const keyword = keywordToken.text as CTypeKeyword
  let cursor = keywordIndex + 1
  if (keyword === 'enum' && (tokens[cursor]?.text === 'class' || tokens[cursor]?.text === 'struct')) {
    cursor += 1
  }
  cursor = skipAnnotations(tokens, cursor)

  let name = ''
  if (isWordToken(tokens[cursor]) && !NON_NAME_WORDS.has(tokens[cursor].text)) {
    name = tokens[cursor].text
    cursor += 1
    while (tokens[cursor]?.text === '::' && isWordToken(tokens[cursor + 1])) {
      name = tokens[cursor + 1].text
      cursor += 2
    }
  }
  cursor = skipAnnotations(tokens, cursor)
  // `class API Foo {...}`: a macro can sit between the keyword and the name.
  if (
    name.length > 0 &&
    isWordToken(tokens[cursor]) &&
    (tokens[cursor + 1]?.text === '{' ||
      tokens[cursor + 1]?.text === ':' ||
      tokens[cursor + 1]?.text === 'final')
  ) {
    name = tokens[cursor].text
    cursor += 1
    cursor = skipAnnotations(tokens, cursor)
  }
  if (tokens[cursor]?.text === 'final') {
    cursor += 1
    cursor = skipAnnotations(tokens, cursor)
  }
  if (tokens[cursor]?.text === '<') {
    // Explicit/partial specialisation of a class template.
    const close = findMatchingAngles(tokens, cursor)
    if (close < 0) {
      ctx.parseError('type template argument list is unterminated', tokens[cursor].span)
      return tokens.length
    }
    cursor = close + 1
    cursor = skipAnnotations(tokens, cursor)
  }

  const next = tokens[cursor]
  if (next === undefined) {
    ctx.parseError('type declaration is not terminated', keywordToken.span)
    return tokens.length
  }

  let bodyOpen = -1
  let semicolon = -1
  if (next.text === '{') {
    bodyOpen = cursor
  } else if (next.text === ';') {
    semicolon = cursor
  } else if (next.text === ':') {
    const end = findTypeHeaderEnd(tokens, cursor)
    bodyOpen = end.bodyOpen
    semicolon = end.semicolon
  } else {
    // `struct Foo x;`, `enum Color color;`: an elaborated type in a
    // variable/function declaration, not a type declaration.
    return scanDeclaration(state, spanStart, spanStart)
  }

  if (bodyOpen < 0 && semicolon < 0) {
    ctx.parseError('type declaration header is not terminated', keywordToken.span)
    return tokens.length
  }

  if (name.length > 0) {
    const span: SourceSpan = {
      start: tokens[spanStart].span.start,
      end: bodyOpen >= 0 ? tokens[bodyOpen].span.start : tokens[semicolon].span.end,
      line: tokens[spanStart].span.line,
      column: tokens[spanStart].span.column,
    }
    emitNode(state, {
      kind: 'class',
      name,
      label: keyword,
      binding: 'class',
      scope: 'global',
      target: `class:${name}`,
      span,
    })
  }

  if (bodyOpen >= 0) {
    const close = findMatching(tokens, bodyOpen, '{', '}')
    if (close < 0) {
      ctx.parseError('unterminated type declaration body', tokens[bodyOpen].span)
      return tokens.length
    }
    return close + 1
  }
  return semicolon + 1
}

/** Index of the `{` body open or `;` terminator after a type header. */
function findTypeHeaderEnd(tokens: readonly CToken[], from: number): TypeHeaderEnd {
  let parens = 0
  let brackets = 0
  let angles = 0
  for (let position = from; position < tokens.length; position += 1) {
    const text = tokens[position].text
    if (text === '(') {
      parens += 1
      continue
    }
    if (text === ')') {
      parens = Math.max(0, parens - 1)
      continue
    }
    if (text === '[') {
      brackets += 1
      continue
    }
    if (text === ']') {
      brackets = Math.max(0, brackets - 1)
      continue
    }
    if (parens > 0 || brackets > 0) continue
    if (text === '<') {
      angles += 1
      continue
    }
    if (text === '>') {
      angles = Math.max(0, angles - 1)
      continue
    }
    if (angles > 0) continue
    if (text === '{') return { bodyOpen: position, semicolon: -1 }
    if (text === ';') return { bodyOpen: -1, semicolon: position }
    if (text === '}' || text === '=') return { bodyOpen: -1, semicolon: -1 }
  }
  return { bodyOpen: -1, semicolon: -1 }
}

/* ------------------------------------------------------------------------- *
 * Declarations: functions, methods and variables
 * ------------------------------------------------------------------------- */

/**
 * Classify one declaration statement: function/prototype, method definition or
 * file-scope variable declaration. Returns the next unconsumed token index.
 *
 * Detection is lexical: the first top-level identifier followed by a plausible
 * parameter list becomes the declaration name. Once a top-level `=` is seen the
 * statement is an initializer, so call parentheses inside it are never seen as
 * a parameter list.
 */
function scanDeclaration(state: CParseState, start: number, spanStart: number): number {
  const { ctx, tokens } = state
  const startToken = tokens[start]
  if (startToken === undefined) return tokens.length

  let position = start
  let parens = 0
  let brackets = 0
  let braces = 0
  let angles = 0
  let sawEquals = false
  let candidate = -1
  let paramsClose = -1
  let colonAfterParams = false
  let last = start

  while (position < tokens.length) {
    if ((position & 255) === 0 && !ctx.checkpoint()) return position
    const token = tokens[position]
    const text = token.text

    // An enclosing block ended before the declaration did: malformed statement.
    if (text === '}' && braces === 0) break

    if (text === '(') {
      if (parens === 0 && brackets === 0 && braces === 0 && angles === 0 && !sawEquals && candidate < 0) {
        const found = functionCandidate(tokens, position)
        if (found !== undefined) {
          candidate = found.name
          paramsClose = found.close
        }
      }
      parens += 1
      last = position
      position += 1
      continue
    }
    if (text === ')') {
      parens = Math.max(0, parens - 1)
      last = position
      position += 1
      continue
    }
    if (text === '[') {
      brackets += 1
      last = position
      position += 1
      continue
    }
    if (text === ']') {
      brackets = Math.max(0, brackets - 1)
      last = position
      position += 1
      continue
    }
    if (parens > 0 || brackets > 0) {
      last = position
      position += 1
      continue
    }

    if (braces > 0) {
      if (text === '{') braces += 1
      else if (text === '}') braces = Math.max(0, braces - 1)
      last = position
      position += 1
      continue
    }

    if (!sawEquals) {
      if (text === '<') {
        angles += 1
        last = position
        position += 1
        continue
      }
      if (text === '>' && angles > 0) {
        angles = Math.max(0, angles - 1)
        last = position
        position += 1
        continue
      }
    }
    if (text === '=' && angles === 0) {
      sawEquals = true
      last = position
      position += 1
      continue
    }
    if (text === ':' && candidate >= 0 && paramsClose >= 0 && !sawEquals) {
      // Start of a constructor-initializer list; braced member initializers
      // (`value_{0}`) must be skipped, not mistaken for the function body.
      colonAfterParams = true
      last = position
      position += 1
      continue
    }
    if (text === '{' && angles === 0) {
      if (colonAfterParams && startsBraceInitializer(tokens, position)) {
        const close = findMatching(tokens, position, '{', '}')
        if (close < 0) {
          ctx.parseError('unterminated brace initializer', token.span)
          return tokens.length
        }
        position = close + 1
        last = close
        continue
      }
      if (candidate >= 0 && !sawEquals && paramsClose >= 0) {
        const span: SourceSpan = {
          start: tokens[spanStart].span.start,
          end: token.span.start,
          line: tokens[spanStart].span.line,
          column: tokens[spanStart].span.column,
        }
        emitFunction(state, candidate, span)
        const close = findMatching(tokens, position, '{', '}')
        if (close < 0) {
          ctx.parseError('unterminated function body', token.span)
          return tokens.length
        }
        return skipCatchClauses(tokens, close + 1)
      }
      braces += 1
      last = position
      position += 1
      continue
    }
    if (text === ';' && angles === 0) {
      if (candidate >= 0 && paramsClose >= 0) {
        const span: SourceSpan = {
          start: tokens[spanStart].span.start,
          end: token.span.end,
          line: tokens[spanStart].span.line,
          column: tokens[spanStart].span.column,
        }
        emitFunction(state, candidate, span)
      } else {
        emitVariables(state, start, spanStart, position)
      }
      return position + 1
    }
    last = position
    position += 1
  }

  // Stopped at an enclosing `}` or at the end of input without a terminator.
  const reason = position < tokens.length
    ? 'declaration is not terminated by ";"'
    : parens > 0
      ? 'unbalanced parentheses in declaration'
      : 'declaration is not terminated by ";"'
  ctx.parseError(reason, tokens[last]?.span ?? startToken.span)
  return position < tokens.length ? position : tokens.length
}

/**
 * First top-level `name (` that can start a function/prototype declaration, or
 * `undefined`. Fail-closed on ambiguous parameter lists, so a C++ direct
 * initializer such as `Foo value(1);` stays a variable declaration.
 */
function functionCandidate(
  tokens: readonly CToken[],
  openParen: number,
): { name: number; close: number } | undefined {
  const name = openParen - 1
  const nameToken = tokens[name]
  if (nameToken === undefined || nameToken.kind !== 'word') return undefined
  if (CALL_EXCLUSIONS.has(nameToken.text) || NON_NAME_WORDS.has(nameToken.text)) return undefined
  const previous = tokens[name - 1]
  if (previous === undefined) return undefined
  const previousText = previous.text
  const validPrevious =
    previous.kind === 'word' ||
    previousText === '*' ||
    previousText === '&' ||
    previousText === '>' ||
    previousText === ')' ||
    previousText === '~' ||
    previousText === '::'
  if (!validPrevious) return undefined
  const close = findMatching(tokens, openParen, '(', ')')
  if (close < 0) return undefined
  if (!looksLikeParameterList(tokens, openParen, close)) return undefined
  return { name, close }
}

/**
 * Cheap plausibility test for a function parameter list. Conservative by
 * design: an empty list, `...` or a leading type/identifier word passes; a
 * leading literal or other punctuation is an initializer, not parameters.
 */
function looksLikeParameterList(tokens: readonly CToken[], open: number, close: number): boolean {
  if (close === open + 1) return true
  const first = tokens[open + 1]
  if (first === undefined) return false
  if (first.text === '...') return true
  return first.kind === 'word'
}

/**
 * True when a top-level `{` after a constructor's parameter list opens a
 * braced member initializer (`value_{0}`) rather than the function body. The
 * body brace follows `)`, a previous initializer's `}`, or a `try` keyword.
 */
function startsBraceInitializer(tokens: readonly CToken[], braceOpen: number): boolean {
  const previous = tokens[braceOpen - 1]
  if (previous === undefined) return false
  if (previous.text === 'try') return false
  return previous.kind === 'word' || previous.text === '>' || previous.text === ']'
}

/**
 * Skip the `catch (...)` clauses of a function-try-block. A function body that
 * is not a try-block ends at the first `}`, so this is a no-op for the common
 * case and only consumes tokens that would otherwise be misread as a new
 * declaration.
 */
function skipCatchClauses(tokens: readonly CToken[], from: number): number {
  let position = from
  while (tokens[position]?.text === 'catch') {
    let cursor = position + 1
    if (tokens[cursor]?.text === '(') {
      const close = findMatching(tokens, cursor, '(', ')')
      if (close < 0) return position
      cursor = close + 1
    }
    if (tokens[cursor]?.text === '{') {
      const close = findMatching(tokens, cursor, '{', '}')
      if (close < 0) return position
      cursor = close + 1
    } else {
      return position
    }
    position = cursor
  }
  return position
}

/** Emit a `function` or `method` node for a qualified/unqualified name. */
function emitFunction(state: CParseState, nameIndex: number, span: SourceSpan): void {
  const { tokens } = state
  const nameToken = tokens[nameIndex]
  if (nameToken === undefined) return
  const tilde = tokens[nameIndex - 1]?.text === '~'
  const simpleNameStart = tilde ? nameIndex - 1 : nameIndex
  let labelStart = simpleNameStart
  while (tokens[labelStart - 1]?.text === '::' && isWordToken(tokens[labelStart - 2])) {
    labelStart -= 2
  }
  const name = joinTokenText(tokens, simpleNameStart, nameIndex + 1)
  const label = joinTokenText(tokens, labelStart, nameIndex + 1)
  const qualified = label.includes('::')
  emitNode(state, {
    kind: qualified ? 'method' : 'function',
    name,
    ...(qualified ? { label } : {}),
    binding: qualified ? 'method' : 'function',
    scope: 'global',
    target: `${qualified ? 'method' : 'function'}:${qualified ? label : name}`,
    span,
  })
}

/** Emit one `variable` node per declarator of a file-scope declaration. */
function emitVariables(state: CParseState, start: number, spanStart: number, semicolon: number): void {
  const { tokens } = state
  const first = tokens[start]?.text
  if (first === 'typedef' || first === 'using' || first === 'friend' || first === 'template') return

  const span: SourceSpan = {
    start: tokens[spanStart].span.start,
    end: tokens[semicolon].span.end,
    line: tokens[spanStart].span.line,
    column: tokens[spanStart].span.column,
  }
  const label = hasConstSpecifier(tokens, start, semicolon) ? 'const' : undefined
  for (const segment of splitDeclarators(tokens, start, semicolon)) {
    const nameIndex = declaratorNameIndex(tokens, segment.start, segment.end)
    if (nameIndex < 0) continue
    const nameToken = tokens[nameIndex]
    if (nameToken === undefined || !isDeclarableName(nameToken.text)) continue
    emitNode(state, {
      kind: 'variable',
      name: nameToken.text,
      ...(label === undefined ? {} : { label }),
      binding: 'variable',
      scope: 'global',
      target: `variable:${nameToken.text}`,
      span,
    })
  }
}

/** True for an explicit `const`/`constexpr` specifier anywhere in the statement. */
function hasConstSpecifier(tokens: readonly CToken[], from: number, to: number): boolean {
  for (let position = from; position < to; position += 1) {
    const token = tokens[position]
    if (token.kind === 'word' && (token.text === 'const' || token.text === 'constexpr')) return true
  }
  return false
}

/**
 * Split a declaration at top-level commas. Angle tracking stops at the first
 * top-level `=`, so `int a = 1, b = 2;` splits while `std::map<int, int> m;`
 * does not.
 */
function splitDeclarators(
  tokens: readonly CToken[],
  from: number,
  semicolon: number,
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = []
  let segmentStart = from
  let parens = 0
  let brackets = 0
  let braces = 0
  let angles = 0
  let segmentEquals = false

  for (let position = from; position < semicolon; position += 1) {
    const text = tokens[position].text
    if (text === '(') {
      parens += 1
      continue
    }
    if (text === ')') {
      parens = Math.max(0, parens - 1)
      continue
    }
    if (text === '[') {
      brackets += 1
      continue
    }
    if (text === ']') {
      brackets = Math.max(0, brackets - 1)
      continue
    }
    if (text === '{') {
      braces += 1
      continue
    }
    if (text === '}') {
      braces = Math.max(0, braces - 1)
      continue
    }
    if (parens > 0 || brackets > 0 || braces > 0) continue
    if (!segmentEquals) {
      if (text === '<') {
        angles += 1
        continue
      }
      if (text === '>') {
        angles = Math.max(0, angles - 1)
        continue
      }
      if (text === '=' && angles === 0) {
        segmentEquals = true
        continue
      }
    }
    if (text === ',' && angles === 0) {
      segments.push({ start: segmentStart, end: position })
      segmentStart = position + 1
      segmentEquals = false
      angles = 0
    }
  }
  segments.push({ start: segmentStart, end: semicolon })
  return segments
}

/**
 * Index of the declared identifier inside one declarator segment, or -1.
 *
 * The last top-level word that is not a specifier/type keyword is the name;
 * a function-pointer declarator (`int (*handler)(int)`) has no top-level name,
 * so the `(*name)` pattern is the fallback.
 */
function declaratorNameIndex(tokens: readonly CToken[], from: number, to: number): number {
  let equality = to
  let parens = 0
  let brackets = 0
  let braces = 0
  let angles = 0
  for (let position = from; position < to; position += 1) {
    const text = tokens[position].text
    if (text === '(') parens += 1
    else if (text === ')') parens = Math.max(0, parens - 1)
    else if (text === '[') brackets += 1
    else if (text === ']') brackets = Math.max(0, brackets - 1)
    else if (text === '{') braces += 1
    else if (text === '}') braces = Math.max(0, braces - 1)
    else if (parens === 0 && brackets === 0 && braces === 0) {
      if (text === '<') angles += 1
      else if (text === '>') angles = Math.max(0, angles - 1)
      else if (text === '=' && angles === 0) {
        equality = position
        break
      }
    }
  }

  parens = 0
  brackets = 0
  angles = 0
  let candidate = -1
  let pointerCandidate = -1
  for (let position = from; position < equality; position += 1) {
    const token = tokens[position]
    const text = token.text
    if (text === '(') {
      if (parens === 0 && brackets === 0 && pointerCandidate < 0) {
        let cursor = position + 1
        while (
          cursor < equality &&
          (tokens[cursor].text === '*' ||
            tokens[cursor].text === '&' ||
            tokens[cursor].text === 'const' ||
            tokens[cursor].text === 'volatile')
        ) {
          cursor += 1
        }
        if (cursor > position + 1 && isWordToken(tokens[cursor])) pointerCandidate = cursor
      }
      parens += 1
      continue
    }
    if (text === ')') {
      parens = Math.max(0, parens - 1)
      continue
    }
    if (text === '[') {
      brackets += 1
      continue
    }
    if (text === ']') {
      brackets = Math.max(0, brackets - 1)
      continue
    }
    if (parens > 0 || brackets > 0) continue
    if (text === '<') {
      angles += 1
      continue
    }
    if (text === '>') {
      angles = Math.max(0, angles - 1)
      continue
    }
    if (angles > 0) continue
    if (token.kind === 'word' && !NON_NAME_WORDS.has(text)) candidate = position
  }
  return candidate >= 0 ? candidate : pointerCandidate
}

/** True when `text` may be stored as a variable name. */
function isDeclarableName(text: string): boolean {
  return text.length > 0 && !NON_NAME_WORDS.has(text)
}

/* ------------------------------------------------------------------------- *
 * Includes and attributes
 * ------------------------------------------------------------------------- */

/** Emit one `import` reference and one `importation` node for a header include. */
function emitInclude(state: CParseState, token: CToken): void {
  const { ctx } = state
  const specifier = token.text
  if (specifier.length === 0) return

  const fragment = fragmentForSpan(ctx, token.span)
  const reference: FileReference = {
    kind: 'import',
    specifier,
    // Angle-bracket headers come from the system include path; quoted headers
    // name a file relative to the including file.
    external: token.system === true,
    span: token.span,
    attributes: { form: token.system === true ? 'angle' : 'quoted' },
    ...fragment,
  }
  state.references.push(reference)

  if (state.nodes.length >= MAX_METADATA_NODES) {
    ctx.limit('node-limit', `node metadata limit ${MAX_METADATA_NODES} reached; later nodes were dropped`)
    return
  }
  const name = sanitizeMetadataText(specifier, MAX_NAME_LENGTH)
  if (name.length === 0) return
  const metadata = pushNodeMetadata(ctx, state.nodes, {
    kind: 'importation',
    name,
    fragment,
    source: 'none',
    span: token.span,
  })
  if (metadata !== undefined) {
    appendAstNode(ctx, state.root, 'importation', token.span, name)
  }
}

/** Skip `[[...]]`, `alignas(...)`, `__attribute__((...))`, `__declspec(...)`. */
function skipAnnotations(tokens: readonly CToken[], start: number): number {
  let cursor = start
  for (;;) {
    const token = tokens[cursor]
    if (token === undefined) return cursor
    if (token.text === '[' && tokens[cursor + 1]?.text === '[') {
      const close = findMatching(tokens, cursor, '[', ']')
      if (close < 0) return cursor
      cursor = close + 1
      continue
    }
    if (isAnnotationWord(token.text) && tokens[cursor + 1]?.text === '(') {
      const close = findMatching(tokens, cursor + 1, '(', ')')
      if (close < 0) return cursor
      cursor = close + 1
      continue
    }
    return cursor
  }
}

/** Words that introduce a parenthesised annotation group. */
function isAnnotationWord(text: string): boolean {
  return (
    text === 'alignas' ||
    text === '__attribute__' ||
    text === '__attribute' ||
    text === '__declspec' ||
    text === 'declspec'
  )
}

/* ------------------------------------------------------------------------- *
 * Metadata emission
 * ------------------------------------------------------------------------- */

/** Emit one capped, sanitised node plus its body-free reference and AST entry. */
function emitNode(state: CParseState, options: EmitNodeOptions): NodeMetadata | undefined {
  const { ctx } = state
  const name = sanitizeMetadataText(options.name, MAX_NAME_LENGTH)
  if (name.length === 0) return undefined
  if (state.nodes.length >= MAX_METADATA_NODES) {
    ctx.limit('node-limit', `node metadata limit ${MAX_METADATA_NODES} reached; later nodes were dropped`)
    return undefined
  }

  const fragment = fragmentForSpan(ctx, options.span)
  let reference: NodeReference | undefined
  try {
    reference = referenceForSpan(ctx, {
      scheme: options.scheme ?? 'symbol',
      target: options.target ?? `${options.kind}:${name}`,
      span: options.span,
      parserId: PARSER_ID,
    })
  } catch {
    // A reference is optional (for example a path-less text parse); the node
    // and its flat fragment remain valid.
    reference = undefined
  }

  const locatorKey = options.kind === 'method' && options.label !== undefined ? options.label : name
  const metadata = pushNodeMetadata(ctx, state.nodes, {
    kind: options.kind,
    name,
    locator: `${PARSER_ID}:${options.kind}:${locatorKey}#${options.span.start}`,
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.binding === undefined ? {} : { binding: options.binding }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(reference === undefined ? {} : { reference }),
    fragment,
    source: 'none',
    span: options.span,
  })
  if (metadata !== undefined) {
    appendAstNode(ctx, state.root, options.kind, options.span, name)
  }
  return metadata
}

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

/** Index of the matching close token for `open`, or -1. O(range). */
function findMatching(
  tokens: readonly CToken[],
  open: number,
  openText: string,
  closeText: string,
): number {
  let depth = 0
  for (let position = open; position < tokens.length; position += 1) {
    const text = tokens[position].text
    if (text === openText) {
      depth += 1
      continue
    }
    if (text === closeText) {
      depth -= 1
      if (depth === 0) return position
    }
  }
  return -1
}

/**
 * Index of the matching `>` for a template-argument `<`, or -1.
 *
 * Nested `<...>` pairs count, while parenthesised defaults
 * (`template <int N = (1 > 0)>`) are skipped so a comparison operator cannot
 * close the parameter list early. Returns -1 at `;`/`}`/end of input.
 */
function findMatchingAngles(tokens: readonly CToken[], open: number): number {
  let depth = 0
  for (let position = open; position < tokens.length; position += 1) {
    const text = tokens[position].text
    if (text === '(') {
      const close = findMatching(tokens, position, '(', ')')
      if (close < 0) return -1
      position = close
      continue
    }
    if (text === '[') {
      const close = findMatching(tokens, position, '[', ']')
      if (close < 0) return -1
      position = close
      continue
    }
    if (text === '{') {
      const close = findMatching(tokens, position, '{', '}')
      if (close < 0) return -1
      position = close
      continue
    }
    if (text === '<') {
      depth += 1
      continue
    }
    if (text === '>') {
      depth -= 1
      if (depth === 0) return position
      continue
    }
    if (text === ';' || text === '}') return -1
  }
  return -1
}

/** Concatenate token text in `[from, to)`; used for qualified names. */
function joinTokenText(tokens: readonly CToken[], from: number, to: number): string {
  let text = ''
  for (let position = from; position < to && position < tokens.length; position += 1) {
    text += tokens[position].text
  }
  return text
}
