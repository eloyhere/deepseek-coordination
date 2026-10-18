/**
 * PHP parser: namespaces, imports/includes, class-like declarations, methods
 * and top-level variables.
 *
 * Deliberately lexical, not a full AST. Heredoc/nowdoc bodies and inline HTML
 * after `?>` are masked to spaces in one `O(n)` pass, then one `O(n)` token
 * pass (`charCodeAt`, no regular expressions, no dependencies, no file I/O)
 * consumes whitespace, comments, quoted strings, numbers and variables. A
 * single scan classifies the significant tokens:
 *
 *  - `namespace X;` and `namespace X { ... }` → one `module` node
 *    (`label: 'namespace'`). An inline namespace body is treated as transparent
 *    for the top-level scan, so its items are module-level items;
 *  - `use A\B;`, `use A\B as C;`, `use A\{B, C};` and comma-separated
 *    `use A\B, C\D;` → one `import` `FileReference` per imported path, and one
 *    `importation` `NodeMetadata` per reference (`label: 'use'`);
 *  - `require`, `require_once`, `include` and `include_once` with a literal
 *    path (optionally parenthesized) → one `import` reference and one
 *    `importation` node whose `label` is the keyword. Non-literal include
 *    targets produce no reference and one `unverifiable` diagnostic;
 *  - `class`, `interface`, `trait` and `enum` → one node each, using the
 *    precise declaration kind (`class`, `interface` or `enumeration`) with the
 *    PHP keyword as `label`; the body is scanned for methods. Anonymous
 *    classes (`new class { ... }`) are skipped without a node;
 *  - `function name(` at top level → `function`; a direct member of a
 *    class-like body → `method`. Bodies are skipped, so closures and nested
 *    functions produce no nodes;
 *  - a top-level `$name = ...` assignment → one `variable` node whose `name`
 *    keeps the leading `$` exactly as written. Assignments inside class,
 *    function, closure and control-flow bodies are not projected.
 *
 * The taxonomy uses the precise `NodeKind` spellings (`module`, `class`,
 * `interface`, `enumeration`, `function`, `method`, `variable`,
 * `importation`). PHP nuance that has no dedicated kind lives in `label`, never
 * in a new kind. Bodies are never returned: a node carries only a body-free
 * span, fragment coordinates and (when a path is known) a `NodeReference`.
 *
 * Conservative gaps, documented rather than guessed:
 *
 *  - declaration extraction is limited to top-level statements; literal
 *    `require`/`include` paths are also recognized in file-scope control
 *    blocks, but conditional declarations and assignments inside `if`/`loop`/
 *    `match` blocks are not projected (the brace depth is tracked and
 *    non-top-level constructs are skipped);
 *  - heredoc/nowdoc strings and inline HTML are masked, never parsed;
 *  - short open tags (`<?`) are not treated as PHP openers; a file with only
 *    short tags is scanned as source text rather than masked;
 *  - `const NAME = ...` is not a `$variable` and produces no node;
 *  - a malformed declaration records `parse-error` diagnostics and recovers at
 *    the next token; `parse` never throws for malformed input.
 *
 * Complexity: masking is `O(n)`, tokenizing is `O(n)`, and the item scan visits
 * every token once because recognized bodies are skipped exactly once. Space
 * is `O(tokens + declarations)`, bounded by `MAX_TOKENS`/`MAX_METADATA_NODES`.
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

/** Symbol kinds the PHP scan can prove (precise `NodeKind` spellings). */
export type PhpSymbolKind =
  | 'class'
  | 'interface'
  | 'enumeration'
  | 'module'
  | 'function'
  | 'method'
  | 'variable'

/** One code symbol the PHP scan can prove. */
export interface PhpSymbol extends FlatFragment {
  kind: PhpSymbolKind
  /** Name as written; a variable keeps its leading `$`. */
  name: string
  /** PHP spelling of the declaration (`namespace`, `interface`, `class`, ...). */
  label?: string
  /** Declaration span: the whole block for class-like items. */
  span: SourceSpan
  /** Enclosing class-like name for a method. */
  ownerClass?: string
  /** Body-free locator for this symbol. */
  reference?: NodeReference
}

/** Parser-specific result with the extracted symbols in source order. */
export interface PhpParseResult extends ParseResult {
  symbols: PhpSymbol[]
}

/** Significant token. Comments and whitespace are not re-emitted. */
interface PhpToken {
  kind: 'ident' | 'variable' | 'number' | 'string' | 'punct'
  /** Raw token text (quoted for strings, `$`-prefixed for variables). */
  text: string
  start: number
  end: number
  /** 1-based line of the token start. */
  line: number
  /** 1-based UTF-16 column of the token start. */
  column: number
}

/** One source-ordered declaration: an import reference or an extracted symbol. */
type PhpDeclaration =
  | { kind: 'reference'; reference: FileReference; label: string }
  | { kind: 'symbol'; symbol: PhpSymbol }

/** Sink used by the scan so a metadata cap can stop it without exceptions. */
interface PhpSink {
  addReference(reference: FileReference, label: string): boolean
  addSymbol(symbol: PhpSymbol): boolean
  shouldStop(): boolean
}

/** Top-level scan state; brace depth keeps declarations out of nested blocks. */
interface PhpScanState {
  braceDepth: number
  parenDepth: number
  bracketDepth: number
  /** Inline `namespace ... {` braces, which are transparent to top level. */
  transparentBraces: number
}

/** Tokens after `class`/`interface`/`trait`/`enum` that never name a type. */
const PHP_CLASS_NON_NAMES: ReadonlySet<string> = new Set(['extends', 'implements'])

/**
 * Parse PHP source.
 *
 * Time `O(n)` in the source length; space `O(tokens + declarations)`, both
 * bounded by the parser budgets. Never throws for malformed source; throws only
 * when `options.signal` is already aborted (standard `AbortSignal` contract).
 */
export function parsePhp(text: string, options: ParseOptions = {}): PhpParseResult {
  const ctx = new ParseContext(text, options)
  const masked = maskPhpSource(ctx, ctx.text)
  const tokens = tokenizePhp(ctx, masked)
  ctx.tokens = tokens.length

  const references: FileReference[] = []
  const symbols: PhpSymbol[] = []
  const declarations: PhpDeclaration[] = []
  let limitReached = false

  const addReference = (reference: FileReference, label: string): boolean => {
    if (declarations.length >= MAX_METADATA_NODES) {
      ctx.limit(
        'node-limit',
        `node metadata limit ${MAX_METADATA_NODES} reached; later declarations were dropped`,
      )
      limitReached = true
      return false
    }
    references.push(reference)
    declarations.push({ kind: 'reference', reference, label })
    return true
  }
  const addSymbol = (symbol: PhpSymbol): boolean => {
    if (declarations.length >= MAX_METADATA_NODES) {
      ctx.limit(
        'node-limit',
        `node metadata limit ${MAX_METADATA_NODES} reached; later declarations were dropped`,
      )
      limitReached = true
      return false
    }
    symbols.push(symbol)
    declarations.push({ kind: 'symbol', symbol })
    return true
  }

  scanPhpItems(ctx, tokens, {
    addReference,
    addSymbol,
    shouldStop: () => limitReached,
  })

  const nodes = buildPhpNodes(ctx, declarations)
  const ast = buildPhpAst(ctx, declarations)
  const base = ctx.finalize({
    parserId: 'php',
    references,
    tokens: tokens.length,
    ast,
    nodes,
  })
  return { ...base, symbols }
}

/** `Parser` implementation for the registry. Registration is deferred. */
export class PhpParser implements Parser {
  readonly id = 'php'
  readonly extensions: readonly string[] = ['.php']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parsePhp(text, options)
  }
}

/** Shared singleton; the integrator registers it later. */
export const phpParser = new PhpParser()

/* ------------------------------------------------------------------------- *
 * Item scan
 * ------------------------------------------------------------------------- */

/** Walk the significant tokens once and collect top-level declarations. */
function scanPhpItems(
  ctx: ParseContext,
  tokens: readonly PhpToken[],
  sink: PhpSink,
): void {
  const state: PhpScanState = { braceDepth: 0, parenDepth: 0, bracketDepth: 0, transparentBraces: 0 }
  let position = 0
  let steps = 0
  while (position < tokens.length) {
    steps += 1
    if ((steps & 511) === 0 && !ctx.checkpoint()) return
    if (sink.shouldStop()) return

    const token = tokens[position]
    const text = token.text
    if (text === '{') {
      state.braceDepth += 1
      position += 1
      continue
    }
    if (text === '}') {
      if (state.braceDepth > 0) state.braceDepth -= 1
      else if (state.transparentBraces > 0) state.transparentBraces -= 1
      position += 1
      continue
    }
    if (text === '(') {
      state.parenDepth += 1
      position += 1
      continue
    }
    if (text === ')') {
      if (state.parenDepth > 0) state.parenDepth -= 1
      position += 1
      continue
    }
    if (text === '[') {
      state.bracketDepth += 1
      position += 1
      continue
    }
    if (text === ']') {
      if (state.bracketDepth > 0) state.bracketDepth -= 1
      position += 1
      continue
    }
    if (state.parenDepth === 0 && state.bracketDepth === 0 && token.kind === 'ident' &&
      (text === 'require' || text === 'require_once' || text === 'include' || text === 'include_once')) {
      // Include paths are file dependencies wherever script-level code runs
      // (including `if`/`try` blocks); function and class bodies never reach
      // this point because their handlers skip them as a unit.
      position = handlePhpInclude(ctx, tokens, position, sink)
      continue
    }
    if (state.braceDepth !== 0 || state.parenDepth !== 0 || state.bracketDepth !== 0) {
      position += 1
      continue
    }

    if (text === '#' && tokens[position + 1]?.text === '[') {
      position = skipPhpAttribute(ctx, tokens, position)
      continue
    }
    if (token.kind === 'ident') {
      if (text === 'namespace') {
        position = handlePhpNamespace(ctx, tokens, position, state, sink)
        continue
      }
      if (text === 'use') {
        position = handlePhpUse(ctx, tokens, position, sink)
        continue
      }
      if (text === 'class' || text === 'interface' || text === 'trait' || text === 'enum') {
        position = handlePhpClassLike(ctx, tokens, position, sink)
        continue
      }
      if (text === 'function') {
        position = handlePhpFunction(ctx, tokens, position, 'function', undefined, sink)
        continue
      }
    }
    if (token.kind === 'variable') {
      const next = tokens[position + 1]
      const previous = tokens[position - 1]
      if (next?.text === '=' && previous?.text !== '->' && previous?.text !== '::' &&
        previous?.text !== '$') {
        if (!sink.addSymbol({
          kind: 'variable',
          name: token.text,
          span: tokenSpan(token),
        })) {
          return
        }
      }
      position += 1
      continue
    }
    position += 1
  }

  if (state.transparentBraces > 0) ctx.parseError('inline namespace body is unterminated')
  if (state.braceDepth > 0) ctx.parseError('unbalanced braces at end of file')
}

/** `namespace X;` / `namespace X { ... }`; body braces stay transparent. */
function handlePhpNamespace(
  ctx: ParseContext,
  tokens: readonly PhpToken[],
  position: number,
  state: PhpScanState,
  sink: PhpSink,
): number {
  const keyword = tokens[position]
  let cursor = position + 1
  const next = tokens[cursor]
  if (next === undefined) {
    ctx.parseError('namespace declaration is unterminated', tokenSpan(keyword))
    return tokens.length
  }
  // `namespace\Foo()` is a relative-name expression, not a declaration.
  if (next.text === '\\') return position + 1

  const parts: string[] = []
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token.text === ';' || token.text === '{') break
    if (token.kind === 'ident' || token.text === '\\') {
      parts.push(token.text)
      cursor += 1
      continue
    }
    break
  }
  if (cursor >= tokens.length) {
    ctx.parseError('namespace declaration is unterminated', tokenSpan(keyword))
    return tokens.length
  }
  const terminator = tokens[cursor]
  const name = parts.join('')
  if (terminator.text === ';') {
    if (name.length === 0) {
      ctx.parseError('namespace declaration is missing a name', tokenSpan(keyword))
      return cursor + 1
    }
    if (!sink.addSymbol({
      kind: 'module',
      name,
      label: 'namespace',
      span: tokenRangeSpan(keyword, terminator),
    })) {
      return tokens.length
    }
    return cursor + 1
  }

  if (terminator.text !== '{') {
    ctx.parseError('namespace declaration has an unexpected token', tokenSpan(terminator))
    return cursor
  }

  // Inline namespace block. A global `namespace { ... }` has no name; it is
  // still one module node, so its contents keep a module scope.
  if (!sink.addSymbol({
    kind: 'module',
    name,
    label: 'namespace',
    span: tokenRangeSpan(keyword, terminator),
  })) {
    return tokens.length
  }
  state.transparentBraces += 1
  return cursor + 1
}

/** `use` imports, including aliases, grouped paths and comma-separated lists. */
function handlePhpUse(
  ctx: ParseContext,
  tokens: readonly PhpToken[],
  position: number,
  sink: PhpSink,
): number {
  const keyword = tokens[position]
  const limit = Math.min(tokens.length, position + 2_000)
  let cursor = position + 1
  if (tokens[cursor]?.text === 'function' || tokens[cursor]?.text === 'const') cursor += 1
  let emitted = false

  while (cursor < tokens.length && cursor < limit) {
    if (tokens[cursor].text === ';') {
      cursor += 1
      break
    }
    const pathStart = cursor
    let pathEnd = -1
    let expectIdent = true
    while (cursor < tokens.length && cursor < limit) {
      const token = tokens[cursor]
      if (expectIdent) {
        if (token.kind === 'ident') {
          pathEnd = cursor
          cursor += 1
          expectIdent = false
          continue
        }
        if (token.text === '\\') {
          cursor += 1
          continue
        }
        break
      }
      if (token.text === '\\') {
        cursor += 1
        expectIdent = true
        continue
      }
      break
    }
    if (pathEnd < pathStart) {
      if (tokens[cursor]?.text === ';') {
        cursor += 1
        break
      }
      ctx.parseError('use declaration has an empty import path', tokenSpan(keyword))
      return skipPhpToSemicolon(tokens, cursor)
    }

    const specifier = joinPhpTokens(tokens, pathStart, pathEnd)
    const span = tokenRangeSpan(tokens[pathStart], tokens[pathEnd])
    const names: string[] = []
    let wildcard = false
    if (tokens[cursor]?.text === '{') {
      const close = findMatching(tokens, cursor, '{', '}', limit)
      const stop = close < 0 ? limit : close
      for (let index = cursor + 1; index < stop; index += 1) {
        const token = tokens[index]
        if (token.text === 'as') {
          index += 1
          continue
        }
        if (token.text === 'function' || token.text === 'const') continue
        if (token.text === '*') {
          wildcard = true
          names.push('*')
          continue
        }
        if (token.kind === 'ident') names.push(token.text)
      }
      cursor = close < 0 ? limit : close + 1
    }
    if (tokens[cursor]?.text === 'as') {
      if (tokens[cursor + 1]?.kind === 'ident') {
        cursor += 2
      } else {
        ctx.parseError('use alias is missing a name', tokenSpan(tokens[cursor]))
        cursor += 1
      }
    }

    const reference: FileReference = {
      kind: 'import',
      specifier,
      // A `use` imports a symbol, not a workspace file; resolution belongs to
      // a later PHP-aware layer, so the shared classifier never sees it.
      external: true,
      span,
      ...(names.length === 0 ? {} : { names }),
      ...(wildcard ? { wildcard: true } : {}),
      ...fragmentForSpan(ctx, span),
    }
    if (!sink.addReference(reference, 'use')) return tokens.length
    emitted = true

    if (tokens[cursor]?.text === ',') {
      cursor += 1
      continue
    }
    if (tokens[cursor]?.text === ';') {
      cursor += 1
      break
    }
    if (cursor >= limit) {
      ctx.parseError('use declaration is unterminated', tokenSpan(keyword))
      return limit
    }
    ctx.parseError('unexpected token in use declaration', tokenSpan(tokens[cursor]))
    return skipPhpToSemicolon(tokens, cursor)
  }
  if (!emitted && cursor >= tokens.length) {
    ctx.parseError('use declaration is unterminated', tokenSpan(keyword))
  }
  return cursor
}

/** `require`/`include` with a literal path; non-literal targets are reported. */
function handlePhpInclude(
  ctx: ParseContext,
  tokens: readonly PhpToken[],
  position: number,
  sink: PhpSink,
): number {
  const keyword = tokens[position]
  let cursor = position + 1
  if (tokens[cursor]?.text === '(') cursor += 1
  const literal = tokens[cursor]
  if (literal === undefined || literal.kind !== 'string') {
    ctx.unverifiable(
      `${keyword.text} target is not a literal path`,
      literal === undefined ? tokenSpan(keyword) : tokenSpan(literal),
    )
    return skipPhpToSemicolon(tokens, cursor)
  }
  const value = phpStringLiteral(literal.text)
  if (value === undefined) {
    ctx.unverifiable(`${keyword.text} target is not a literal path`, tokenSpan(literal))
    return skipPhpToSemicolon(tokens, cursor + 1)
  }

  const span: SourceSpan = {
    start: literal.start + 1,
    end: Math.max(literal.start + 1, literal.end - 1),
    line: literal.line,
    column: literal.column + 1,
  }
  const reference: FileReference = {
    kind: 'import',
    specifier: value,
    external: isPhpExternalPath(value),
    span,
    ...fragmentForSpan(ctx, span),
  }
  if (!sink.addReference(reference, keyword.text)) return tokens.length
  return skipPhpToSemicolon(tokens, cursor + 1)
}

/** Precise node kind and label for one class-like PHP keyword. */
interface PhpClassLikeNode {
  kind: PhpSymbolKind
  label: string
}

/**
 * Map a PHP class-like keyword onto its precise node kind.
 *
 * `class` and `trait` stay `class` with the keyword as label; `interface` and
 * `enum` use their dedicated kinds.
 */
function phpClassLikeNode(keyword: string): PhpClassLikeNode {
  if (keyword === 'interface') return { kind: 'interface', label: keyword }
  if (keyword === 'enum') return { kind: 'enumeration', label: keyword }
  return { kind: 'class', label: keyword }
}

/** `class`/`trait` (`class`), `interface`, `enum`; the body is scanned for methods. */
function handlePhpClassLike(
  ctx: ParseContext,
  tokens: readonly PhpToken[],
  position: number,
  sink: PhpSink,
): number {
  const keyword = tokens[position]
  const kind = keyword.text
  const next = tokens[position + 1]
  if (next === undefined || next.kind !== 'ident' || PHP_CLASS_NON_NAMES.has(next.text)) {
    // Anonymous class (`new class { ... }`) or a malformed header: skip a body
    // when one can be isolated so its method bodies never leak into the scan.
    let open = -1
    const limit = Math.min(tokens.length, position + 40)
    for (let cursor = position + 1; cursor < limit; cursor += 1) {
      const text = tokens[cursor].text
      if (text === '{') {
        open = cursor
        break
      }
      if (text === ';' || text === '}') break
    }
    if (open < 0) return position + 1
    const close = findMatching(tokens, open, '{', '}')
    return close < 0 ? tokens.length : close + 1
  }

  let open = -1
  const limit = Math.min(tokens.length, position + 1_000)
  for (let cursor = position + 2; cursor < limit; cursor += 1) {
    const text = tokens[cursor].text
    if (text === '{') {
      open = cursor
      break
    }
    if (text === ';' || text === '}') break
  }
  if (open < 0) {
    ctx.parseError(`${kind} declaration has no body`, tokenSpan(keyword))
    return Math.min(tokens.length, position + 2)
  }
  const close = findMatching(tokens, open, '{', '}')
  const node = phpClassLikeNode(kind)
  if (close < 0) {
    ctx.parseError(`${kind} body is unterminated`, tokenSpan(tokens[open]))
    if (!sink.addSymbol({
      kind: node.kind,
      name: next.text,
      label: node.label,
      span: tokenRangeSpan(keyword, tokens[open]),
    })) {
      return tokens.length
    }
    return tokens.length
  }

  if (!sink.addSymbol({
    kind: node.kind,
    name: next.text,
    label: node.label,
    span: tokenRangeSpan(keyword, tokens[close]),
  })) {
    return tokens.length
  }
  scanPhpClassBody(ctx, tokens, open, close, next.text, sink)
  return close + 1
}

/** Direct class-like members: `function` declarations become methods. */
function scanPhpClassBody(
  ctx: ParseContext,
  tokens: readonly PhpToken[],
  open: number,
  close: number,
  ownerClass: string,
  sink: PhpSink,
): void {
  let cursor = open + 1
  let depth = 1
  let steps = 0
  while (cursor < close) {
    steps += 1
    if ((steps & 511) === 0 && !ctx.checkpoint()) return
    if (sink.shouldStop()) return

    const token = tokens[cursor]
    const text = token.text
    if (text === '{') {
      depth += 1
      cursor += 1
      continue
    }
    if (text === '}') {
      depth -= 1
      cursor += 1
      continue
    }
    if (depth !== 1) {
      cursor += 1
      continue
    }
    if (text === '#' && tokens[cursor + 1]?.text === '[') {
      cursor = skipPhpAttribute(ctx, tokens, cursor, close)
      continue
    }
    if (token.kind === 'ident' && text === 'function') {
      cursor = handlePhpFunction(ctx, tokens, cursor, 'method', ownerClass, sink)
      continue
    }
    cursor += 1
  }
}

/** `function name(...)`; a body is skipped, an abstract `;` keeps the method. */
function handlePhpFunction(
  ctx: ParseContext,
  tokens: readonly PhpToken[],
  position: number,
  kind: 'function' | 'method',
  ownerClass: string | undefined,
  sink: PhpSink,
): number {
  const keyword = tokens[position]
  let cursor = position + 1
  if (tokens[cursor]?.text === '&') cursor += 1
  const nameToken = tokens[cursor]

  if (nameToken === undefined || nameToken.kind !== 'ident') {
    // Anonymous function/closure: parameters and body are skipped, no node.
    let paramsOpen = -1
    const limit = Math.min(tokens.length, position + 40)
    for (let index = cursor; index < limit; index += 1) {
      const text = tokens[index].text
      if (text === '(') {
        paramsOpen = index
        break
      }
      if (text === '{' || text === ';') break
    }
    if (paramsOpen < 0) return Math.min(tokens.length, cursor + 1)
    const paramsClose = findMatching(tokens, paramsOpen, '(', ')')
    if (paramsClose < 0) {
      ctx.parseError('closure parameter list is unterminated', tokenSpan(tokens[paramsOpen]))
      return tokens.length
    }
    const bodyOpen = findPhpFunctionBody(tokens, paramsClose + 1)
    if (bodyOpen < 0 || tokens[bodyOpen].text === ';') {
      return bodyOpen < 0 ? paramsClose + 1 : bodyOpen + 1
    }
    const bodyClose = findMatching(tokens, bodyOpen, '{', '}')
    if (bodyClose < 0) {
      ctx.parseError('closure body is unterminated', tokenSpan(tokens[bodyOpen]))
      return tokens.length
    }
    return bodyClose + 1
  }

  if (tokens[cursor + 1]?.text !== '(') {
    ctx.parseError('function declaration is missing its parameter list', tokenSpan(nameToken))
    if (!sink.addSymbol({
      kind,
      name: nameToken.text,
      span: tokenRangeSpan(keyword, nameToken),
      ...(ownerClass === undefined ? {} : { ownerClass }),
    })) {
      return tokens.length
    }
    return cursor + 1
  }
  const paramsOpen = cursor + 1
  const paramsClose = findMatching(tokens, paramsOpen, '(', ')')
  if (paramsClose < 0) {
    ctx.parseError('function parameter list is unterminated', tokenSpan(tokens[paramsOpen]))
    if (!sink.addSymbol({
      kind,
      name: nameToken.text,
      span: tokenRangeSpan(keyword, nameToken),
      ...(ownerClass === undefined ? {} : { ownerClass }),
    })) {
      return tokens.length
    }
    return tokens.length
  }

  const bodyOpen = findPhpFunctionBody(tokens, paramsClose + 1)
  let endPosition: number
  let next: number
  if (bodyOpen >= 0 && tokens[bodyOpen].text === '{') {
    const bodyClose = findMatching(tokens, bodyOpen, '{', '}')
    if (bodyClose < 0) {
      ctx.parseError('function body is unterminated', tokenSpan(tokens[bodyOpen]))
      endPosition = bodyOpen
      next = tokens.length
    } else {
      endPosition = bodyClose
      next = bodyClose + 1
    }
  } else if (bodyOpen >= 0) {
    endPosition = bodyOpen
    next = bodyOpen + 1
  } else {
    ctx.parseError('function body could not be isolated', tokenSpan(nameToken))
    endPosition = paramsClose
    next = paramsClose + 1
  }

  if (!sink.addSymbol({
    kind,
    name: nameToken.text,
    span: tokenRangeSpan(keyword, tokens[endPosition]),
    ...(ownerClass === undefined ? {} : { ownerClass }),
  })) {
    return tokens.length
  }
  return next
}

/* ------------------------------------------------------------------------- *
 * Scan helpers
 * ------------------------------------------------------------------------- */

/** Skip a PHP 8 attribute group (`#[...]`). */
function skipPhpAttribute(
  ctx: ParseContext,
  tokens: readonly PhpToken[],
  position: number,
  limit = tokens.length,
): number {
  if (tokens[position + 1]?.text !== '[') return position + 1
  const close = findMatching(tokens, position + 1, '[', ']', limit)
  if (close < 0) {
    ctx.parseError('attribute is unterminated', tokenSpan(tokens[position]))
    return limit
  }
  return close + 1
}

/** First `{` or `;` after a parameter list (function body or declaration end). */
function findPhpFunctionBody(tokens: readonly PhpToken[], from: number): number {
  const limit = Math.min(tokens.length, from + 500)
  for (let cursor = from; cursor < limit; cursor += 1) {
    const text = tokens[cursor].text
    if (text === '{' || text === ';') return cursor
    if (text === '}') return -1
  }
  return -1
}

/** Skip to the next top-level `;`, consuming balanced groups on the way. */
function skipPhpToSemicolon(tokens: readonly PhpToken[], from: number): number {
  let depth = 0
  for (let cursor = from; cursor < tokens.length; cursor += 1) {
    const text = tokens[cursor].text
    if (text === '(' || text === '[' || text === '{') {
      depth += 1
      continue
    }
    if (text === ')' || text === ']' || text === '}') {
      if (depth > 0) depth -= 1
      continue
    }
    if (text === ';' && depth === 0) return cursor + 1
  }
  return tokens.length
}

/** Index of the matching close token, or -1. `limit` is exclusive. */
function findMatching(
  tokens: readonly PhpToken[],
  openPosition: number,
  openText: string,
  closeText: string,
  limit = tokens.length,
): number {
  let depth = 0
  for (let position = openPosition; position < Math.min(limit, tokens.length); position += 1) {
    const text = tokens[position].text
    if (text === openText) depth += 1
    else if (text === closeText) {
      depth -= 1
      if (depth === 0) return position
    }
  }
  return -1
}

/** PhpToken span (line/column already 1-based). */
function tokenSpan(token: PhpToken): SourceSpan {
  return { start: token.start, end: token.end, line: token.line, column: token.column }
}

function tokenRangeSpan(first: PhpToken, last: PhpToken): SourceSpan {
  return {
    start: first.start,
    end: last.end,
    line: first.line,
    column: first.column,
  }
}

function joinPhpTokens(tokens: readonly PhpToken[], from: number, to: number): string {
  let value = ''
  for (let position = from; position <= to; position += 1) {
    const token = tokens[position]
    if (token !== undefined) value += token.text
  }
  return value
}

/**
 * Literal value of a PHP single/double-quoted string, or undefined when it is
 * not a plain literal (interpolation, unterminated). Backtick strings are not
 * paths.
 */
function phpStringLiteral(raw: string): string | undefined {
  if (raw.length < 2) return undefined
  const quote = raw[0]
  if ((quote !== "'" && quote !== '"') || raw[raw.length - 1] !== quote) return undefined
  const inner = raw.slice(1, -1)
  if (quote === '"') {
    for (let index = 0; index < inner.length; index += 1) {
      const code = inner.charCodeAt(index)
      if (code === 92) {
        index += 1
        continue
      }
      if (code === 36) return undefined
    }
  }
  let value = ''
  for (let index = 0; index < inner.length; index += 1) {
    const code = inner.charCodeAt(index)
    if (code === 92 && index + 1 < inner.length) {
      const next = inner[index + 1]
      if (next === quote || next === '\\') {
        value += next
        index += 1
        continue
      }
    }
    value += inner[index]
  }
  return value
}

/** True for URL/absolute include targets; bare and relative paths stay local. */
function isPhpExternalPath(value: string): boolean {
  if (value.length === 0) return false
  const first = value.charCodeAt(0)
  if (first === 47 || first === 92) return true
  if (isPhpAsciiLetter(first) && value.charCodeAt(1) === 58) return true
  if (!isPhpAsciiLetter(first)) return false
  let index = 1
  while (index < value.length) {
    const code = value.charCodeAt(index)
    if (isPhpAsciiLetter(code) || isPhpDigit(code) || code === 43 || code === 45 || code === 46) {
      index += 1
      continue
    }
    break
  }
  return value.charCodeAt(index) === 58
}

/* ------------------------------------------------------------------------- *
 * Masking: heredoc/nowdoc and inline HTML
 * ------------------------------------------------------------------------- */

/**
 * Mask heredoc/nowdoc bodies and inline HTML with spaces, keeping newlines and
 * the exact text length so every span stays aligned with the original source.
 * PHP open/close tags are left in place for the tokenizer (they are ignored).
 */
function maskPhpSource(ctx: ParseContext, text: string): string {
  const length = text.length
  const chunks: string[] = []
  let copied = 0
  let index = 0
  let line = 1
  let lineStart = 0

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
  const pushMask = (start: number, end: number): void => {
    const from = Math.max(start, copied)
    if (from >= end) return
    if (from > copied) chunks.push(text.slice(copied, from))
    chunks.push(blankRegion(text, from, end))
    copied = end
  }

  const firstOpen = findPhpOpen(text, 0)
  if (firstOpen > 0) pushMask(0, firstOpen)
  if (firstOpen > 0) advanceTo(firstOpen)

  let state: 'code' | 'single' | 'double' | 'backtick' | 'line' | 'block' = 'code'
  let steps = 0
  while (index < length) {
    steps += 1
    if ((steps & 4_095) === 0 && !ctx.checkpoint()) break
    const code = text.charCodeAt(index)
    const next = text.charCodeAt(index + 1)

    if (state === 'code') {
      if (code === 60 && next === 63) {
        // Open tag (`<?php`, `<?=`, short `<?`): keep it for tokenization.
        advanceTo(index + 2)
        continue
      }
      if (code === 63 && next === 62) {
        // Inline HTML after `?>`; masked up to the next PHP open tag.
        const open = findPhpOpen(text, index + 2)
        const end = open < 0 ? length : open
        pushMask(index + 2, end)
        advanceTo(end)
        continue
      }
      if (code === 60 && next === 60 && text.charCodeAt(index + 2) === 60) {
        const heredoc = scanPhpHeredoc(text, index)
        if (heredoc !== undefined) {
          if (!heredoc.terminated) {
            ctx.parseError('heredoc/nowdoc string is unterminated', {
              start: index,
              end: Math.min(index + 3, length),
              line,
              column: index - lineStart + 1,
            })
          }
          pushMask(index, heredoc.end)
          advanceTo(heredoc.end)
          continue
        }
      }
      if (code === 39) {
        state = 'single'
        advanceTo(index + 1)
        continue
      }
      if (code === 34) {
        state = 'double'
        advanceTo(index + 1)
        continue
      }
      if (code === 96) {
        state = 'backtick'
        advanceTo(index + 1)
        continue
      }
      if (code === 47 && next === 47) {
        state = 'line'
        advanceTo(index + 2)
        continue
      }
      if (code === 35 && next !== 91) {
        state = 'line'
        advanceTo(index + 1)
        continue
      }
      if (code === 47 && next === 42) {
        state = 'block'
        advanceTo(index + 2)
        continue
      }
      advanceTo(index + 1)
      continue
    }

    if (state === 'line') {
      if (isPhpLineBreak(code)) state = 'code'
      advanceTo(index + 1)
      continue
    }
    if (state === 'block') {
      if (code === 42 && next === 47) {
        state = 'code'
        advanceTo(index + 2)
        continue
      }
      advanceTo(index + 1)
      continue
    }
    // Quoted string state.
    if (code === 92) {
      advanceTo(index + 2)
      continue
    }
    if ((state === 'single' && code === 39) || (state === 'double' && code === 34) ||
      (state === 'backtick' && code === 96)) {
      state = 'code'
    }
    advanceTo(index + 1)
  }

  if (copied < length) chunks.push(text.slice(copied))
  return chunks.join('')
}

/** Spaces in place of a region, preserving `\r`/`\n` (no backtracking regex). */
function blankRegion(text: string, start: number, end: number): string {
  let result = ''
  let run = start
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 10 || code === 13) {
      if (index > run) result += ' '.repeat(index - run)
      result += text[index]
      run = index + 1
    }
  }
  if (end > run) result += ' '.repeat(end - run)
  return result
}

/** Offset of the next `<?php` / `<?=` open tag, or -1. */
function findPhpOpen(text: string, from: number): number {
  const length = text.length
  for (let index = from; index + 2 < length; index += 1) {
    if (text.charCodeAt(index) !== 60 || text.charCodeAt(index + 1) !== 63) continue
    const third = text.charCodeAt(index + 2)
    if (third === 61) return index // <?=
    const fourth = text.charCodeAt(index + 3)
    const fifth = text.charCodeAt(index + 4)
    if ((third === 112 || third === 80) &&
      (fourth === 104 || fourth === 72) &&
      (fifth === 112 || fifth === 80)) {
      const after = text.charCodeAt(index + 5)
      // `<?phpfoo` is a short tag followed by an identifier, not `<?php`.
      if (Number.isNaN(after) || !isPhpIdentContinue(after)) return index
    }
  }
  return -1
}

/**
 * Scan a heredoc/nowdoc opener at `index`. Returns the offset after the closing
 * label (the trailing `;` is left in place) and whether it was terminated.
 */
function scanPhpHeredoc(
  text: string,
  index: number,
): { end: number; terminated: boolean } | undefined {
  const length = text.length
  let cursor = index + 3
  while (text.charCodeAt(cursor) === 32 || text.charCodeAt(cursor) === 9) cursor += 1
  let quote = -1
  const quoteCode = text.charCodeAt(cursor)
  if (quoteCode === 39 || quoteCode === 34) {
    quote = quoteCode
    cursor += 1
  }
  const labelStart = cursor
  if (!isPhpIdentStart(text.charCodeAt(cursor))) return undefined
  cursor += 1
  while (cursor < length && isPhpIdentContinue(text.charCodeAt(cursor))) cursor += 1
  const label = text.slice(labelStart, cursor)
  if (quote >= 0) {
    if (text.charCodeAt(cursor) !== quote) return undefined
    cursor += 1
  }
  while (text.charCodeAt(cursor) === 32 || text.charCodeAt(cursor) === 9) cursor += 1
  const newline = text.charCodeAt(cursor)
  if (newline !== 10 && newline !== 13) return undefined
  if (newline === 13 && text.charCodeAt(cursor + 1) === 10) cursor += 2
  else cursor += 1

  while (cursor <= length) {
    let probe = cursor
    while (text.charCodeAt(probe) === 32 || text.charCodeAt(probe) === 9) probe += 1
    if (text.startsWith(label, probe)) {
      const after = text.charCodeAt(probe + label.length)
      if (Number.isNaN(after) || after === 59 || after === 44 || after === 41 || after === 93 ||
        after === 10 || after === 13) {
        return { end: probe + label.length, terminated: true }
      }
    }
    let lineEnd = cursor
    while (lineEnd < length) {
      const code = text.charCodeAt(lineEnd)
      if (code === 10 || code === 13) break
      lineEnd += 1
    }
    if (lineEnd >= length) break
    if (text.charCodeAt(lineEnd) === 13 && text.charCodeAt(lineEnd + 1) === 10) cursor = lineEnd + 2
    else cursor = lineEnd + 1
  }
  return { end: length, terminated: false }
}

/* ------------------------------------------------------------------------- *
 * Tokenizer
 * ------------------------------------------------------------------------- */

/** One `O(n)` token pass over the masked source. */
function tokenizePhp(ctx: ParseContext, text: string): PhpToken[] {
  const length = text.length
  const tokens: PhpToken[] = []
  let index = 0
  let line = 1
  let lineStart = 0
  let steps = 0

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

  const push = (
    kind: PhpToken['kind'],
    start: number,
    end: number,
    tokenLine: number,
    tokenColumn: number,
  ): boolean => {
    if (tokens.length >= ctx.maxTokens) {
      ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
      return false
    }
    tokens.push({ kind, text: text.slice(start, end), start, end, line: tokenLine, column: tokenColumn })
    return true
  }

  const tick = (): boolean => {
    steps += 1
    if ((steps & 4_095) !== 0) return true
    return ctx.checkpoint()
  }

  while (index < length) {
    if (!tick()) break
    const code = text.charCodeAt(index)

    if (isPhpWhitespace(code)) {
      advanceTo(index + 1)
      continue
    }
    if (code === 47 && text.charCodeAt(index + 1) === 47) {
      let cursor = index + 2
      while (cursor < length && !isPhpLineBreak(text.charCodeAt(cursor))) cursor += 1
      advanceTo(cursor)
      continue
    }
    if (code === 35 && text.charCodeAt(index + 1) !== 91) {
      let cursor = index + 1
      while (cursor < length && !isPhpLineBreak(text.charCodeAt(cursor))) cursor += 1
      advanceTo(cursor)
      continue
    }
    if (code === 47 && text.charCodeAt(index + 1) === 42) {
      advanceTo(skipPhpBlockComment(ctx, text, index))
      continue
    }

    const start = index
    const tokenLine = line
    const tokenColumn = index - lineStart + 1

    if (code === 39 || code === 34 || code === 96) {
      advanceTo(phpStringEnd(ctx, text, index, code))
      if (!push('string', start, index, tokenLine, tokenColumn)) break
      continue
    }
    if (code === 36 && isPhpIdentStart(text.charCodeAt(index + 1))) {
      let cursor = index + 2
      while (cursor < length && isPhpIdentContinue(text.charCodeAt(cursor))) cursor += 1
      advanceTo(cursor)
      if (!push('variable', start, index, tokenLine, tokenColumn)) break
      continue
    }
    if (isPhpIdentStart(code)) {
      let cursor = index + 1
      while (cursor < length && isPhpIdentContinue(text.charCodeAt(cursor))) cursor += 1
      advanceTo(cursor)
      if (!push('ident', start, index, tokenLine, tokenColumn)) break
      continue
    }
    if (isPhpDigit(code)) {
      let cursor = index + 1
      while (cursor < length) {
        const next = text.charCodeAt(cursor)
        if (isPhpDigit(next) || isPhpIdentContinue(next) || next === 95) {
          cursor += 1
          continue
        }
        if (next === 46 && isPhpDigit(text.charCodeAt(cursor + 1))) {
          cursor += 1
          continue
        }
        break
      }
      advanceTo(cursor)
      if (!push('number', start, index, tokenLine, tokenColumn)) break
      continue
    }

    const width = phpOperatorWidth(text, index)
    advanceTo(index + width)
    if (!push('punct', start, index, tokenLine, tokenColumn)) break
  }
  return tokens
}

/** Consume a quoted string; PHP strings may span lines. */
function phpStringEnd(ctx: ParseContext, text: string, index: number, quote: number): number {
  let cursor = index + 1
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code === 92) {
      cursor += 2
      continue
    }
    if (code === quote) return cursor + 1
    cursor += 1
  }
  ctx.parseError('string literal is unterminated')
  return text.length
}

/** Consume a block comment; returns the offset after it. */
function skipPhpBlockComment(ctx: ParseContext, text: string, index: number): number {
  const length = text.length
  let cursor = index + 2
  let steps = 0
  while (cursor < length) {
    steps += 1
    if ((steps & 4_095) === 0 && !ctx.checkpoint()) return length
    const code = text.charCodeAt(cursor)
    if (code === 42 && text.charCodeAt(cursor + 1) === 47) return cursor + 2
    cursor += 1
  }
  ctx.parseError('block comment is unterminated')
  return cursor
}

const PHP_OPERATORS_3: readonly string[] = ['===', '!==', '<=>', '**=', '...', '<<=', '>>=', '??=', '?->']
const PHP_OPERATORS_2: readonly string[] = [
  '==', '!=', '<>', '<=', '>=', '&&', '||', '??', '->', '=>', '::', '++', '--',
  '+=', '-=', '*=', '/=', '.=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
]

/** Maximal-munch length of the PHP operator at `index` (at least 1). */
function phpOperatorWidth(text: string, index: number): number {
  for (const operator of PHP_OPERATORS_3) {
    if (matchesAt(text, index, operator)) return 3
  }
  for (const operator of PHP_OPERATORS_2) {
    if (matchesAt(text, index, operator)) return 2
  }
  return 1
}

function matchesAt(text: string, index: number, candidate: string): boolean {
  for (let offset = 0; offset < candidate.length; offset += 1) {
    if (text.charCodeAt(index + offset) !== candidate.charCodeAt(offset)) return false
  }
  return true
}

function isPhpWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 0xfeff
}

function isPhpLineBreak(code: number): boolean {
  return code === 10 || code === 13
}

function isPhpDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isPhpAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isPhpIdentStart(code: number): boolean {
  return isPhpAsciiLetter(code) || code === 95 || code >= 0x80
}

function isPhpIdentContinue(code: number): boolean {
  return isPhpIdentStart(code) || isPhpDigit(code)
}

/* ------------------------------------------------------------------------- *
 * Metadata and AST projection
 * ------------------------------------------------------------------------- */

/**
 * Build source-ordered graph nodes: one `importation` node per reference and
 * one node per extracted symbol. No body text is copied.
 */
function buildPhpNodes(ctx: ParseContext, declarations: readonly PhpDeclaration[]): NodeMetadata[] {
  const nodes: NodeMetadata[] = []
  for (let index = 0; index < declarations.length; index += 1) {
    if ((index & 255) === 0 && !ctx.checkpoint()) break
    const declaration = declarations[index]
    if (declaration.kind === 'reference') {
      const reference = declaration.reference
      try {
        pushNodeMetadata(ctx, nodes, {
          kind: 'importation',
          name: sanitizeMetadataText(reference.specifier, MAX_NAME_LENGTH),
          label: sanitizeMetadataText(declaration.label, MAX_NAME_LENGTH),
          span: reference.span,
          fragment: fragmentForSpan(ctx, reference.span),
          source: 'none',
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
        parserId: 'php',
      })
      symbol.reference = reference
    } catch {
      reference = undefined
    }
    const name = sanitizeMetadataText(symbol.name, MAX_NAME_LENGTH)
    const label = symbol.label === undefined
      ? ''
      : sanitizeMetadataText(symbol.label, MAX_NAME_LENGTH)
    pushNodeMetadata(ctx, nodes, {
      kind: symbol.kind,
      ...(name.length === 0 ? {} : { name }),
      ...(label.length === 0 ? {} : { label }),
      locator: `php:${symbol.kind}:${name}#${symbol.span.start}`,
      ...(reference === undefined ? {} : { reference }),
      fragment,
      source: 'none',
      span: symbol.span,
    })
  }
  return nodes
}

/** One root `module` node with a child per declaration, in source order. */
function buildPhpAst(ctx: ParseContext, declarations: readonly PhpDeclaration[]): AstTree<string> {
  const root = createAstRoot('module', ctx.text.length)
  for (const declaration of declarations) {
    if (declaration.kind === 'reference') {
      appendAstNode(ctx, root, 'import', declaration.reference.span, declaration.reference.specifier)
    } else {
      appendAstNode(ctx, root, declaration.symbol.kind, declaration.symbol.span, declaration.symbol.name)
    }
  }
  return new AstTree(root)
}
