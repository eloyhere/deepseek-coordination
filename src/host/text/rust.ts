/**
 * Rust parser: `use`/`extern crate` imports, module items, impl methods and
 * constants.
 *
 * Deliberately lexical, not a full AST. One `O(n)` token pass (`charCodeAt`,
 * no regular expressions, no dependencies, no file I/O) consumes whitespace,
 * line and nested block comments, normal/raw/byte strings, character literals
 * and lifetimes, then a single scan classifies the significant tokens:
 *
 *  - `use a::b;`, `pub use`, `use a::{b, c};`, `use a::*;` and
 *    `extern crate x;` → one `import` `FileReference` per path, and one
 *    `importation` `NodeMetadata` per reference. The specifier is the path as
 *    written (`crate::`/`self::`/`super::` are marked local; everything else
 *    goes through the shared lexical classifier);
 *  - `mod name;` and `mod name { ... }` → one `module` node (`label: 'mod'`);
 *    the body of an inline module is scanned for module-level items;
 *  - `struct`/`trait` declarations → one `class` node whose `label` is the
 *    Rust keyword; `enum` declarations → one `enumeration` node (`label:
 *    'enum'`). The declared type name is the `name`. Bodies are skipped
 *    (fields, variants and trait signatures are not projected);
 *  - `impl Type { ... }` → one `class` node with `label: 'implementation'` and
 *    `name` = the implemented type (`Type` in `impl Trait for Type`); the body
 *    is scanned for direct members only;
 *  - `fn name(` at module level → `function`; a direct member of an `impl`
 *    block → `method` (one brace-level of impl context is tracked; function
 *    bodies are skipped, so nested/local functions produce no nodes);
 *  - `const NAME` and `static NAME` (including `static mut`) → one `variable`
 *    node with `label: 'const'` or `'static'`; the initializer is skipped;
 *  - macros (`macro_rules!`, `println!`, `macro name { ... }`) produce no
 *    nodes; attributes (`#[...]`, `#![...]`) and doc comments are skipped
 *    without breaking the scan; `type` aliases are skipped.
 *
 * The taxonomy uses the precise `NodeKind` spellings (`class`, `enumeration`,
 * `module`, `function`, `method`, `variable`, `importation`). Rust nuance that
 * has no dedicated kind lives in `label`, never in a new kind. Bodies are never
 * returned: a node carries only a body-free span, fragment coordinates and
 * (when a path is known) a `NodeReference`.
 *
 * Conservative gaps, documented rather than guessed:
 *
 *  - method extraction covers direct `impl` members only; `trait` bodies,
 *    `extern` blocks and function bodies are not visited;
 *  - `const`/`static` items inside function bodies are not projected;
 *  - `union` and `type` declarations are not projected; associated types are
 *    skipped;
 *  - `impl` names are a compact lexical rendering of the type path
 *    (`Foo<T>`), never resolved or normalised;
 *  - a malformed declaration records `parse-error` diagnostics and recovers at
 *    the next token; `parse` never throws for malformed input.
 *
 * Complexity: tokenizing is `O(n)`; the item scan visits every token once
 * because every recognized body is skipped exactly once. Space is
 * `O(tokens + declarations)`, bounded by `MAX_TOKENS`/`MAX_METADATA_NODES`.
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
  isExternalSpecifier,
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

/** Symbol kinds the Rust scan can prove (precise `NodeKind` spellings). */
export type RustSymbolKind = 'class' | 'enumeration' | 'module' | 'function' | 'method' | 'variable'

/** One code symbol the Rust scan can prove. */
export interface RustSymbol extends FlatFragment {
  kind: RustSymbolKind
  name: string
  /** Rust spelling of the declaration (`struct`, `implementation`, `const`, ...). */
  label?: string
  /** Declaration span: header only for `const`/`static`, the whole block otherwise. */
  span: SourceSpan
  /** Enclosing `impl` type for a method or associated constant. */
  owner?: string
  /** Body-free locator for this symbol. */
  reference?: NodeReference
}

/** Parser-specific result with the extracted symbols in source order. */
export interface RustParseResult extends ParseResult {
  symbols: RustSymbol[]
}

/** Significant token. Comments, whitespace and literals are not re-emitted. */
interface RustToken {
  kind: 'ident' | 'number' | 'string' | 'punct'
  /** Raw token text; string text is kept only for span slicing. */
  text: string
  start: number
  end: number
  /** 1-based line of the token start. */
  line: number
  /** 1-based UTF-16 column of the token start. */
  column: number
}

/** Class-like Rust item keywords. */
type RustClassKeyword = 'struct' | 'enum' | 'trait'

/** One source-ordered declaration: an import reference or an extracted symbol. */
type RustDeclaration =
  | { kind: 'reference'; reference: FileReference; label: string }
  | { kind: 'symbol'; symbol: RustSymbol }

/** Sink used by the scan so a metadata cap can stop it without exceptions. */
interface RustSink {
  addReference(reference: FileReference, label: string): boolean
  addSymbol(symbol: RustSymbol): boolean
  shouldStop(): boolean
}

/**
 * Hard keywords. Used only to reject them as declaration names; raw
 * identifiers (`r#type`) stay legal because their token text keeps the `r#`.
 */
const RUST_KEYWORDS: ReadonlySet<string> = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
  'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
  'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
  'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
  'where', 'while', 'abstract', 'become', 'box', 'do', 'final', 'macro',
  'override', 'priv', 'try', 'typeof', 'unsized', 'virtual', 'yield',
])

/**
 * Parse Rust source.
 *
 * Time `O(n)` in the source length; space `O(tokens + declarations)`, both
 * bounded by the parser budgets. Never throws for malformed source; throws only
 * when `options.signal` is already aborted (standard `AbortSignal` contract).
 */
export function parseRust(text: string, options: ParseOptions = {}): RustParseResult {
  const ctx = new ParseContext(text, options)
  const tokens = tokenizeRust(ctx)
  ctx.tokens = tokens.length

  const references: FileReference[] = []
  const symbols: RustSymbol[] = []
  const declarations: RustDeclaration[] = []
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
  const addSymbol = (symbol: RustSymbol): boolean => {
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

  scanRustItems(ctx, tokens, {
    addReference,
    addSymbol,
    shouldStop: () => limitReached,
  })

  const nodes = buildRustNodes(ctx, declarations)
  const ast = buildRustAst(ctx, declarations)
  const base = ctx.finalize({
    parserId: 'rust',
    references,
    tokens: tokens.length,
    ast,
    nodes,
  })
  return { ...base, symbols }
}

/** `Parser` implementation for the registry. Registration is deferred. */
export class RustParser implements Parser {
  readonly id = 'rust'
  readonly extensions: readonly string[] = ['.rs']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parseRust(text, options)
  }
}

/** Shared singleton; the integrator registers it later. */
export const rustParser = new RustParser()

/* ------------------------------------------------------------------------- *
 * Item scan
 * ------------------------------------------------------------------------- */

/**
 * Walk the significant tokens once and collect module-level items. Every
 * recognized body is skipped exactly once, so the scan is `O(tokens)`.
 */
function scanRustItems(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  sink: RustSink,
): void {
  let position = 0
  let steps = 0
  while (position < tokens.length) {
    steps += 1
    if ((steps & 511) === 0 && !ctx.checkpoint()) return
    if (sink.shouldStop()) return

    const token = tokens[position]
    const text = token.text

    if (text === '#') {
      position = skipRustAttribute(ctx, tokens, position)
      continue
    }
    if (token.kind === 'ident') {
      // Macro invocation/definition (`println!`, `macro_rules! name { ... }`).
      if (tokens[position + 1]?.text === '!') {
        position = skipRustMacro(ctx, tokens, position)
        continue
      }
      if (text === 'use') {
        position = handleRustUse(ctx, tokens, position, sink)
        continue
      }
      if (text === 'extern') {
        position = handleRustExtern(ctx, tokens, position, sink)
        continue
      }
      if (text === 'mod') {
        position = handleRustMod(ctx, tokens, position, sink)
        continue
      }
      if (text === 'struct' || text === 'enum' || text === 'trait') {
        position = handleRustClassLike(ctx, tokens, position, sink)
        continue
      }
      if (text === 'impl') {
        position = handleRustImpl(ctx, tokens, position, sink)
        continue
      }
      if (text === 'fn') {
        position = handleRustFn(ctx, tokens, position, 'function', undefined, sink)
        continue
      }
      if (text === 'const' || text === 'static') {
        position = handleRustVariable(ctx, tokens, position, text, undefined, sink)
        continue
      }
      if (text === 'macro') {
        position = skipRustMacroDefinition(ctx, tokens, position)
        continue
      }
      // A type alias may contain `fn` pointers, so skip it as a unit.
      if (text === 'type') {
        position = skipRustStatement(tokens, position + 1)
        continue
      }
    }
    position += 1
  }
}

/** `use` path/groups. Emits one reference, or one per group path. */
function handleRustUse(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
  sink: RustSink,
): number {
  const keyword = tokens[position]
  const limit = Math.min(tokens.length, position + 4_000)
  let semicolon = -1
  for (let cursor = position + 1; cursor < limit; cursor += 1) {
    if (tokens[cursor].text === ';') {
      semicolon = cursor
      break
    }
  }
  if (semicolon < 0) {
    ctx.parseError('use declaration is missing its semicolon', tokenSpan(keyword))
    return limit
  }

  const pathStart = position + 1
  let pathEnd = semicolon - 1
  let groupStart = -1
  let angleDepth = 0
  for (let cursor = pathStart; cursor < semicolon; cursor += 1) {
    const text = tokens[cursor].text
    if (text === '<') {
      angleDepth += 1
      continue
    }
    if (text === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
      continue
    }
    if (text === '>>') {
      angleDepth = Math.max(0, angleDepth - 2)
      continue
    }
    if (angleDepth > 0) continue
    if (text === 'as') {
      pathEnd = cursor - 1
      break
    }
    if (text === '{') {
      groupStart = cursor
      pathEnd = cursor - 1
      break
    }
  }

  let wildcard = false
  while (pathEnd >= pathStart && tokens[pathEnd].text === '::') pathEnd -= 1
  if (groupStart < 0 && pathEnd >= pathStart && tokens[pathEnd].text === '*') {
    wildcard = true
    pathEnd -= 1
    while (pathEnd >= pathStart && tokens[pathEnd].text === '::') pathEnd -= 1
  }
  if (pathEnd < pathStart) {
    ctx.parseError('use declaration has an empty import path', tokenSpan(keyword))
    return semicolon + 1
  }

  const specifier = joinTokenText(tokens, pathStart, pathEnd)
  const names: string[] = []
  if (groupStart >= 0) {
    const close = findMatching(tokens, groupStart, '{', '}', semicolon)
    const stop = close < 0 ? semicolon : close
    for (let cursor = groupStart + 1; cursor < stop; cursor += 1) {
      const token = tokens[cursor]
      if (token.text === 'as') {
        // The alias is a local binding; the imported name is the one before it.
        cursor += 1
        continue
      }
      if (token.text === '*') {
        wildcard = true
        names.push('*')
        continue
      }
      if (token.kind === 'ident') names.push(token.text)
    }
    if (names.length === 0 && !wildcard) names.push('*')
  }

  const span = tokenRangeSpan(tokens[pathStart], tokens[pathEnd])
  const reference: FileReference = {
    kind: 'import',
    specifier,
    external: isExternalRustSpecifier(specifier),
    span,
    ...(names.length === 0 ? {} : { names }),
    ...(wildcard ? { wildcard: true } : {}),
    ...fragmentForSpan(ctx, span),
  }
  if (!sink.addReference(reference, 'use')) return tokens.length
  return semicolon + 1
}

/** `extern crate x;` (import) and `extern "C" { ... }` (skipped block). */
function handleRustExtern(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
  sink: RustSink,
): number {
  const next = tokens[position + 1]
  if (next?.text !== 'crate') {
    // `extern "C" fn` defines a normal Rust function; leave it to the `fn` case.
    if (next?.text === 'fn') return position + 1
    if (next?.kind === 'string' && tokens[position + 2]?.text === 'fn') return position + 1
    let open = -1
    const limit = Math.min(tokens.length, position + 16)
    for (let cursor = position + 1; cursor < limit; cursor += 1) {
      const text = tokens[cursor].text
      if (text === '{') {
        open = cursor
        break
      }
      if (text === ';') return cursor + 1
    }
    if (open < 0) return position + 1
    const close = findMatching(tokens, open, '{', '}')
    return close < 0 ? tokens.length : close + 1
  }

  const nameToken = tokens[position + 2]
  if (nameToken === undefined || nameToken.kind !== 'ident') {
    ctx.parseError('extern crate declaration is missing a crate name', tokenSpan(tokens[position]))
    return Math.min(tokens.length, position + 3)
  }
  let cursor = position + 3
  if (tokens[cursor]?.text === 'as') {
    if (tokens[cursor + 1]?.kind === 'ident') {
      cursor += 2
    } else {
      ctx.parseError('extern crate alias is missing a name', tokenSpan(tokens[cursor]))
      cursor += 1
    }
  }
  if (tokens[cursor]?.text !== ';') {
    ctx.parseError('extern crate declaration is missing its semicolon', tokenSpan(nameToken))
    return Math.min(tokens.length, cursor + 1)
  }

  const span = tokenRangeSpan(nameToken, nameToken)
  const reference: FileReference = {
    kind: 'import',
    specifier: nameToken.text,
    external: true,
    span,
    ...fragmentForSpan(ctx, span),
  }
  if (!sink.addReference(reference, 'extern crate')) return tokens.length
  return cursor + 1
}

/** `mod name;` and `mod name { ... }`; inline bodies stay in the linear scan. */
function handleRustMod(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
  sink: RustSink,
): number {
  const keyword = tokens[position]
  const nameToken = tokens[position + 1]
  if (nameToken === undefined || nameToken.kind !== 'ident' || RUST_KEYWORDS.has(nameToken.text)) {
    ctx.parseError('mod declaration is missing a name', tokenSpan(keyword))
    return Math.min(tokens.length, position + 2)
  }
  const next = tokens[position + 2]
  if (next?.text === ';') {
    if (!sink.addSymbol({
      kind: 'module',
      name: nameToken.text,
      label: 'mod',
      span: tokenRangeSpan(keyword, next),
    })) {
      return tokens.length
    }
    return position + 3
  }
  if (next?.text === '{') {
    const close = findMatching(tokens, position + 2, '{', '}')
    const endPosition = close < 0 ? position + 2 : close
    if (close < 0) ctx.parseError('module body is unterminated', tokenSpan(next))
    if (!sink.addSymbol({
      kind: 'module',
      name: nameToken.text,
      label: 'mod',
      span: tokenRangeSpan(keyword, tokens[endPosition]),
    })) {
      return tokens.length
    }
    // Continue inside the inline module: its items are module-level.
    return position + 3
  }
  ctx.parseError('mod declaration has neither a body nor a semicolon', tokenSpan(keyword))
  return position + 2
}

/** Precise node kind and label for one class-like Rust item keyword. */
interface RustClassLikeNode {
  kind: RustSymbolKind
  label: string
}

/**
 * Map a class-like Rust item keyword onto its precise node kind.
 *
 * `struct` and `trait` stay `class` with the keyword as label; `enum` has a
 * dedicated `enumeration` kind and keeps `label: 'enum'`.
 */
function rustClassLikeNode(keyword: RustClassKeyword): RustClassLikeNode {
  return keyword === 'enum'
    ? { kind: 'enumeration', label: 'enum' }
    : { kind: 'class', label: keyword }
}

/** `struct`/`trait` (a `class`) and `enum` (an `enumeration`); bodies are skipped. */
function handleRustClassLike(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
  sink: RustSink,
): number {
  const keyword = tokens[position]
  const kind = keyword.text as RustClassKeyword
  const nameToken = tokens[position + 1]
  if (nameToken === undefined || nameToken.kind !== 'ident' || RUST_KEYWORDS.has(nameToken.text)) {
    ctx.parseError(`${kind} declaration is missing a name`, tokenSpan(keyword))
    return Math.min(tokens.length, position + 2)
  }

  let open = -1
  let terminator = -1
  const limit = Math.min(tokens.length, position + 4_000)
  for (let cursor = position + 2; cursor < limit; cursor += 1) {
    const text = tokens[cursor].text
    if (text === '{') {
      open = cursor
      break
    }
    if (text === ';') {
      terminator = cursor
      break
    }
  }

  let endPosition: number
  let next: number
  if (open >= 0) {
    const close = findMatching(tokens, open, '{', '}')
    if (close < 0) {
      ctx.parseError(`${kind} body is unterminated`, tokenSpan(tokens[open]))
      endPosition = open
      next = tokens.length
    } else {
      endPosition = close
      next = close + 1
    }
  } else if (terminator >= 0) {
    endPosition = terminator
    next = terminator + 1
  } else {
    ctx.parseError(`${kind} declaration has no body`, tokenSpan(keyword))
    endPosition = Math.min(tokens.length - 1, position + 1)
    next = Math.min(tokens.length, position + 2)
  }

  const node = rustClassLikeNode(kind)
  if (!sink.addSymbol({
    kind: node.kind,
    name: nameToken.text,
    label: node.label,
    span: tokenRangeSpan(keyword, tokens[endPosition]),
  })) {
    return tokens.length
  }
  return next
}

/**
 * `impl` block. Emits a `class` node with `label: 'implementation'` and the
 * implemented type as `name`, then scans direct members for methods and
 * associated constants.
 */
function handleRustImpl(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
  sink: RustSink,
): number {
  const keyword = tokens[position]
  let cursor = position + 1
  if (tokens[cursor]?.text === '<') {
    const after = skipRustAngleGroup(tokens, cursor)
    if (after < 0) {
      ctx.parseError('impl generic parameters are unterminated', tokenSpan(keyword))
      return position + 1
    }
    cursor = after
  }

  let bodyOpen = -1
  const limit = Math.min(tokens.length, position + 6_000)
  for (let index = cursor; index < limit; index += 1) {
    const text = tokens[index].text
    if (text === '{') {
      bodyOpen = index
      break
    }
    if (text === ';') break
  }
  if (bodyOpen < 0) {
    ctx.parseError('impl declaration has no body', tokenSpan(keyword))
    return position + 1
  }
  const close = findMatching(tokens, bodyOpen, '{', '}')
  if (close < 0) {
    ctx.parseError('impl body is unterminated', tokenSpan(tokens[bodyOpen]))
    return tokens.length
  }

  // The displayed name is the implemented type: after `for` when present,
  // otherwise the whole type path (generic arguments included).
  let whereIndex = -1
  let forIndex = -1
  let angleDepth = 0
  for (let index = cursor; index < bodyOpen; index += 1) {
    const text = tokens[index].text
    if (text === '<') {
      angleDepth += 1
      continue
    }
    if (text === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
      continue
    }
    if (text === '>>') {
      angleDepth = Math.max(0, angleDepth - 2)
      continue
    }
    if (angleDepth > 0) continue
    if (text === 'where') {
      whereIndex = index
      continue
    }
    if (text === 'for' && whereIndex < 0) forIndex = index
  }
  const typeStart = forIndex >= 0 ? forIndex + 1 : cursor
  const typeEnd = (whereIndex >= 0 ? whereIndex : bodyOpen) - 1
  const name = typeStart <= typeEnd ? joinTokenText(tokens, typeStart, typeEnd) : ''

  if (!sink.addSymbol({
    kind: 'class',
    name,
    label: 'implementation',
    span: tokenRangeSpan(keyword, tokens[close]),
  })) {
    return tokens.length
  }

  scanRustImplBody(ctx, tokens, bodyOpen, close, name, sink)
  return close + 1
}

/** Direct members of an `impl` body: `fn` (method), `const`/`static`. */
function scanRustImplBody(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  open: number,
  close: number,
  owner: string,
  sink: RustSink,
): void {
  let position = open + 1
  let depth = 1
  let steps = 0
  while (position < close) {
    steps += 1
    if ((steps & 511) === 0 && !ctx.checkpoint()) return
    if (sink.shouldStop()) return

    const token = tokens[position]
    const text = token.text
    if (text === '{') {
      depth += 1
      position += 1
      continue
    }
    if (text === '}') {
      depth -= 1
      position += 1
      continue
    }
    if (depth !== 1) {
      position += 1
      continue
    }
    if (text === '#') {
      position = skipRustAttribute(ctx, tokens, position, close)
      continue
    }
    if (token.kind === 'ident' && tokens[position + 1]?.text === '!') {
      position = skipRustMacro(ctx, tokens, position, close)
      continue
    }
    if (text === 'fn') {
      position = handleRustFn(ctx, tokens, position, 'method', owner, sink)
      continue
    }
    if (text === 'const' || text === 'static') {
      position = handleRustVariable(ctx, tokens, position, text, owner, sink)
      continue
    }
    if (text === 'type') {
      position = Math.min(close, skipRustStatement(tokens, position + 1))
      continue
    }
    position += 1
  }
}

/** `fn name(...)`; a body is skipped, a trailing `;` keeps the declaration. */
function handleRustFn(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
  kind: 'function' | 'method',
  owner: string | undefined,
  sink: RustSink,
): number {
  const keyword = tokens[position]
  let cursor = position + 1
  const nameToken = tokens[cursor]
  if (nameToken === undefined || nameToken.kind !== 'ident' || RUST_KEYWORDS.has(nameToken.text)) {
    ctx.parseError('function declaration is missing a name', tokenSpan(keyword))
    return Math.min(tokens.length, position + 2)
  }
  cursor += 1
  if (tokens[cursor]?.text === '<') {
    const after = skipRustAngleGroup(tokens, cursor)
    if (after < 0) {
      ctx.parseError('function generic parameters are unterminated', tokenSpan(tokens[cursor]))
      const span = tokenRangeSpan(keyword, nameToken)
      if (!sink.addSymbol({
        kind,
        name: nameToken.text,
        span,
        ...(owner === undefined ? {} : { owner }),
      })) {
        return tokens.length
      }
      return tokens.length
    }
    cursor = after
  }
  if (tokens[cursor]?.text !== '(') {
    ctx.parseError('function declaration is missing its parameter list', tokenSpan(nameToken))
    if (!sink.addSymbol({
      kind,
      name: nameToken.text,
      span: tokenRangeSpan(keyword, nameToken),
      ...(owner === undefined ? {} : { owner }),
    })) {
      return tokens.length
    }
    return cursor
  }
  const paramsClose = findMatching(tokens, cursor, '(', ')')
  if (paramsClose < 0) {
    ctx.parseError('function parameter list is unterminated', tokenSpan(tokens[cursor]))
    if (!sink.addSymbol({
      kind,
      name: nameToken.text,
      span: tokenRangeSpan(keyword, nameToken),
      ...(owner === undefined ? {} : { owner }),
    })) {
      return tokens.length
    }
    return tokens.length
  }

  let bodyOpen = -1
  let terminator = -1
  const limit = Math.min(tokens.length, paramsClose + 500)
  for (let index = paramsClose + 1; index < limit; index += 1) {
    const text = tokens[index].text
    if (text === '{') {
      bodyOpen = index
      break
    }
    if (text === ';') {
      terminator = index
      break
    }
    if (text === '}') break
  }

  let endPosition: number
  let next: number
  if (bodyOpen >= 0) {
    const close = findMatching(tokens, bodyOpen, '{', '}')
    if (close < 0) {
      ctx.parseError('function body is unterminated', tokenSpan(tokens[bodyOpen]))
      endPosition = bodyOpen
      next = tokens.length
    } else {
      endPosition = close
      next = close + 1
    }
  } else if (terminator >= 0) {
    endPosition = terminator
    next = terminator + 1
  } else {
    ctx.parseError('function body could not be isolated', tokenSpan(nameToken))
    endPosition = paramsClose
    next = paramsClose + 1
  }

  if (!sink.addSymbol({
    kind,
    name: nameToken.text,
    span: tokenRangeSpan(keyword, tokens[endPosition]),
    ...(owner === undefined ? {} : { owner }),
  })) {
    return tokens.length
  }
  return next
}

/** `const NAME` / `static NAME` (including `static mut`); initializer skipped. */
function handleRustVariable(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
  keyword: 'const' | 'static',
  owner: string | undefined,
  sink: RustSink,
): number {
  const keywordToken = tokens[position]
  let cursor = position + 1
  if (tokens[cursor]?.text === 'mut') cursor += 1
  const nameToken = tokens[cursor]
  if (nameToken === undefined || nameToken.kind !== 'ident' || RUST_KEYWORDS.has(nameToken.text)) {
    // `const fn` / `const unsafe fn` are functions, not constants.
    if (tokens[position + 1]?.text === 'fn' ||
      (tokens[position + 1]?.text === 'unsafe' && tokens[position + 2]?.text === 'fn')) {
      return position + 1
    }
    ctx.parseError(`${keyword} declaration is missing a name`, tokenSpan(keywordToken))
    return Math.min(tokens.length, position + 2)
  }
  if (!sink.addSymbol({
    kind: 'variable',
    name: nameToken.text,
    label: keyword,
    span: tokenRangeSpan(keywordToken, nameToken),
    ...(owner === undefined ? {} : { owner }),
  })) {
    return tokens.length
  }
  return skipRustStatement(tokens, cursor + 1)
}

/* ------------------------------------------------------------------------- *
 * Scan helpers
 * ------------------------------------------------------------------------- */

/** Skip an attribute (`#[...]`, `#![...]`); malformed input is reported. */
function skipRustAttribute(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
  limit = tokens.length,
): number {
  let cursor = position + 1
  if (tokens[cursor]?.text === '!') cursor += 1
  if (tokens[cursor]?.text !== '[') return position + 1
  const close = findMatching(tokens, cursor, '[', ']', limit)
  if (close < 0) {
    ctx.parseError('attribute is unterminated', tokenSpan(tokens[position]))
    return limit
  }
  return close + 1
}

/** Skip a macro invocation/definition group starting at `name!`. */
function skipRustMacro(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
  limit = tokens.length,
): number {
  let opener = -1
  const scanLimit = Math.min(limit, position + 8)
  for (let cursor = position + 2; cursor < scanLimit; cursor += 1) {
    const text = tokens[cursor].text
    if (text === '(' || text === '[' || text === '{') {
      opener = cursor
      break
    }
    if (text === ';') break
  }
  if (opener < 0) return Math.min(limit, position + 2)
  const openText = tokens[opener].text
  const closeText = openText === '(' ? ')' : openText === '[' ? ']' : '}'
  const close = findMatching(tokens, opener, openText, closeText, limit)
  if (close < 0) {
    ctx.parseError('macro invocation is unterminated', tokenSpan(tokens[opener]))
    return limit
  }
  return close + 1
}

/** Skip a `macro name { ... }` definition (declarative macros 2.0). */
function skipRustMacroDefinition(
  ctx: ParseContext,
  tokens: readonly RustToken[],
  position: number,
): number {
  let opener = -1
  const limit = Math.min(tokens.length, position + 8)
  for (let cursor = position + 1; cursor < limit; cursor += 1) {
    const text = tokens[cursor].text
    if (text === '(' || text === '[' || text === '{') {
      opener = cursor
      break
    }
    if (text === ';') return cursor + 1
  }
  if (opener < 0) return position + 2
  const openText = tokens[opener].text
  const closeText = openText === '(' ? ')' : openText === '[' ? ']' : '}'
  const close = findMatching(tokens, opener, openText, closeText)
  if (close < 0) {
    ctx.parseError('macro definition is unterminated', tokenSpan(tokens[opener]))
    return tokens.length
  }
  return close + 1
}

/**
 * Skip an item statement up to and including a top-level `;`. Braces, brackets
 * and parentheses nest, so a block initializer is consumed as a unit.
 */
function skipRustStatement(tokens: readonly RustToken[], from: number): number {
  let depth = 0
  for (let cursor = from; cursor < tokens.length; cursor += 1) {
    const text = tokens[cursor].text
    if (text === '{' || text === '(' || text === '[') {
      depth += 1
      continue
    }
    if (text === '}' || text === ')' || text === ']') {
      if (depth > 0) {
        depth -= 1
        continue
      }
      if (text === '}') return cursor
      continue
    }
    if (text === ';' && depth === 0) return cursor + 1
  }
  return tokens.length
}

/** Index just past a `<...>` generic group, or -1 when unterminated. */
function skipRustAngleGroup(tokens: readonly RustToken[], open: number): number {
  let depth = 0
  for (let cursor = open; cursor < tokens.length; cursor += 1) {
    const text = tokens[cursor].text
    if (text === '<') depth += 1
    else if (text === '>') depth -= 1
    else if (text === '>>') depth -= 2
    if (depth <= 0) return cursor + 1
  }
  return -1
}

/** Index of the matching close token, or -1. `limit` is exclusive. */
function findMatching(
  tokens: readonly RustToken[],
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

function isExternalRustSpecifier(specifier: string): boolean {
  if (specifier === 'crate' || specifier.startsWith('crate::')) return false
  if (specifier === 'self' || specifier.startsWith('self::')) return false
  if (specifier === 'super' || specifier.startsWith('super::')) return false
  if (specifier.startsWith('::crate::') || specifier.startsWith('::self::') ||
    specifier.startsWith('::super::')) {
    return false
  }
  return isExternalSpecifier(specifier)
}

function joinTokenText(tokens: readonly RustToken[], from: number, to: number): string {
  let value = ''
  for (let position = from; position <= to; position += 1) {
    const token = tokens[position]
    if (token !== undefined) value += token.text
  }
  return value
}

function tokenSpan(token: RustToken): SourceSpan {
  return { start: token.start, end: token.end, line: token.line, column: token.column }
}

function tokenRangeSpan(first: RustToken, last: RustToken): SourceSpan {
  return {
    start: first.start,
    end: last.end,
    line: first.line,
    column: first.column,
  }
}

/* ------------------------------------------------------------------------- *
 * Tokenizer
 * ------------------------------------------------------------------------- */

/**
 * One `O(n)` token pass. Comments, whitespace, strings and character literals
 * are consumed as units; only significant tokens are returned.
 */
function tokenizeRust(ctx: ParseContext): RustToken[] {
  const text = ctx.text
  const length = text.length
  const tokens: RustToken[] = []
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
    kind: RustToken['kind'],
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

    if (isRustWhitespace(code)) {
      advanceTo(index + 1)
      continue
    }
    if (code === 47 && text.charCodeAt(index + 1) === 47) {
      let cursor = index + 2
      while (cursor < length && !isRustLineBreak(text.charCodeAt(cursor))) cursor += 1
      advanceTo(cursor)
      continue
    }
    if (code === 47 && text.charCodeAt(index + 1) === 42) {
      advanceTo(skipRustBlockComment(ctx, text, index))
      continue
    }

    const start = index
    const tokenLine = line
    const tokenColumn = index - lineStart + 1

    if (code === 34) {
      advanceTo(rustStringEnd(ctx, text, index, '"'))
      if (!push('string', start, index, tokenLine, tokenColumn)) break
      continue
    }
    if (code === 114 || code === 98) {
      const rawEnd = rustRawStringEnd(ctx, text, index)
      if (rawEnd > index) {
        advanceTo(rawEnd)
        if (!push('string', start, index, tokenLine, tokenColumn)) break
        continue
      }
    }
    if (code === 39) {
      const charEnd = rustCharLiteralEnd(text, index)
      if (charEnd > index) {
        advanceTo(charEnd)
        if (!push('string', start, index, tokenLine, tokenColumn)) break
        continue
      }
      // A lifetime (`'a`) is punctuation plus an identifier, and is never a
      // declaration name; emitting only the apostrophe keeps the scan simple.
      advanceTo(index + 1)
      if (!push('punct', start, index, tokenLine, tokenColumn)) break
      continue
    }
    if (code === 114 && text.charCodeAt(index + 1) === 35 && isRustIdentStart(text.charCodeAt(index + 2))) {
      let cursor = index + 3
      while (cursor < length && isRustIdentContinue(text.charCodeAt(cursor))) cursor += 1
      advanceTo(cursor)
      if (!push('ident', start, index, tokenLine, tokenColumn)) break
      continue
    }
    if (isRustIdentStart(code)) {
      let cursor = index + 1
      while (cursor < length && isRustIdentContinue(text.charCodeAt(cursor))) cursor += 1
      advanceTo(cursor)
      if (!push('ident', start, index, tokenLine, tokenColumn)) break
      continue
    }
    if (isRustDigit(code)) {
      let cursor = index + 1
      while (cursor < length) {
        const next = text.charCodeAt(cursor)
        if (isRustDigit(next) || isRustAsciiLetter(next) || next === 95) {
          cursor += 1
          continue
        }
        if (next === 46 && isRustDigit(text.charCodeAt(cursor + 1))) {
          cursor += 1
          continue
        }
        break
      }
      advanceTo(cursor)
      if (!push('number', start, index, tokenLine, tokenColumn)) break
      continue
    }

    const width = rustOperatorWidth(text, index)
    advanceTo(index + width)
    if (!push('punct', start, index, tokenLine, tokenColumn)) break
  }
  return tokens
}

/** Consume a `"..."` or `'...'` literal, reporting an unterminated one. */
function rustStringEnd(ctx: ParseContext, text: string, index: number, quote: string): number {
  const quoteCode = quote.charCodeAt(0)
  let cursor = index + 1
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code === 92) {
      cursor += 2
      continue
    }
    if (code === quoteCode) return cursor + 1
    cursor += 1
  }
  ctx.parseError('string literal is unterminated')
  return text.length
}

/** Raw (`r"..."`, `r#"..."#`) and byte-raw (`br#"..."#`) string end, or -1. */
function rustRawStringEnd(ctx: ParseContext, text: string, index: number): number {
  const length = text.length
  let cursor = index
  if (text.charCodeAt(cursor) === 98) {
    if (text.charCodeAt(cursor + 1) !== 114) return -1
    cursor += 2
  } else if (text.charCodeAt(cursor) === 114) {
    cursor += 1
  } else {
    return -1
  }
  let hashes = 0
  while (text.charCodeAt(cursor) === 35) {
    hashes += 1
    cursor += 1
  }
  if (text.charCodeAt(cursor) !== 34) return -1
  cursor += 1
  while (cursor < length) {
    if (text.charCodeAt(cursor) === 34) {
      let matched = 0
      while (matched < hashes && text.charCodeAt(cursor + 1 + matched) === 35) matched += 1
      if (matched === hashes) return cursor + 1 + hashes
    }
    cursor += 1
  }
  ctx.parseError('raw string literal is unterminated')
  return length
}

/** End of a character literal, or -1 when the apostrophe starts a lifetime. */
function rustCharLiteralEnd(text: string, index: number): number {
  const length = text.length
  const next = text.charCodeAt(index + 1)
  if (Number.isNaN(next)) return -1
  if (isRustIdentStart(next)) {
    let probe = index + 2
    while (probe < length && isRustIdentContinue(text.charCodeAt(probe))) probe += 1
    // `'a'` is a character, `'a` (no closing quote) is a lifetime.
    if (text.charCodeAt(probe) !== 39) return -1
    return probe + 1
  }
  let cursor = index + 1
  const limit = Math.min(length, index + 12)
  while (cursor < limit) {
    const code = text.charCodeAt(cursor)
    if (code === 92) {
      cursor += 2
      continue
    }
    if (code === 39) return cursor + 1
    if (isRustLineBreak(code)) return -1
    cursor += 1
  }
  return -1
}

/** Consume a (possibly nested) block comment; returns the offset after it. */
function skipRustBlockComment(ctx: ParseContext, text: string, index: number): number {
  const length = text.length
  let depth = 1
  let cursor = index + 2
  let steps = 0
  while (cursor < length && depth > 0) {
    steps += 1
    if ((steps & 4_095) === 0 && !ctx.checkpoint()) return length
    const code = text.charCodeAt(cursor)
    if (code === 47 && text.charCodeAt(cursor + 1) === 42) {
      depth += 1
      cursor += 2
      continue
    }
    if (code === 42 && text.charCodeAt(cursor + 1) === 47) {
      depth -= 1
      cursor += 2
      continue
    }
    cursor += 1
  }
  if (depth > 0) ctx.parseError('block comment is unterminated')
  return cursor
}

const RUST_OPERATORS_3: readonly string[] = ['..=', '<<=', '>>=']
const RUST_OPERATORS_2: readonly string[] = [
  '::', '->', '=>', '..', '==', '!=', '<=', '>=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=', '<<', '>>',
]

/** Maximal-munch length of the Rust operator at `index` (at least 1). */
function rustOperatorWidth(text: string, index: number): number {
  for (const operator of RUST_OPERATORS_3) {
    if (matchesAt(text, index, operator)) return 3
  }
  for (const operator of RUST_OPERATORS_2) {
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

function isRustWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 0xfeff
}

function isRustLineBreak(code: number): boolean {
  return code === 10 || code === 13
}

function isRustDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isRustAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isRustIdentStart(code: number): boolean {
  return isRustAsciiLetter(code) || code === 95 || code >= 0x80
}

function isRustIdentContinue(code: number): boolean {
  return isRustIdentStart(code) || isRustDigit(code)
}

/* ------------------------------------------------------------------------- *
 * Metadata and AST projection
 * ------------------------------------------------------------------------- */

/**
 * Build source-ordered graph nodes: one `importation` node per `use`/`extern
 * crate` reference and one node per extracted symbol. No body text is copied.
 */
function buildRustNodes(ctx: ParseContext, declarations: readonly RustDeclaration[]): NodeMetadata[] {
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
        parserId: 'rust',
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
      locator: `rust:${symbol.kind}:${name}#${symbol.span.start}`,
      ...(reference === undefined ? {} : { reference }),
      fragment,
      source: 'none',
      span: symbol.span,
    })
  }
  return nodes
}

/** One root `module` node with a child per declaration, in source order. */
function buildRustAst(ctx: ParseContext, declarations: readonly RustDeclaration[]): AstTree<string> {
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
