/**
 * JavaScript / TypeScript / JSX parser: references, exports, symbols, comments.
 *
 * Deliberately lexical, not a full AST. It tokenizes once (`tokenizer.ts`), then
 * scans the significant-token stream for:
 *
 *  - static `import ... from 'x'`, side-effect `import 'x'`, namespace imports,
 *    default/named imports, `import type`;
 *  - `export ... from 'x'`, `export * from`, `export * as ns from`,
 *    `export type ... from`, and local `export { ... }` bindings;
 *  - dynamic `import('x')` and `require('x')` (literal arguments only);
 *  - `class X`, `function f` / `async function f` / `function* f`,
 *    `const f = (...) => ...`, method shorthand inside a class body
 *    (`m(...) {}`, `constructor`, `get`/`set`, `static`, `async`, `*gen`),
 *    `const`/`let`/`var` bindings (identifier and destructured names), and
 *    static class fields / `static {}` block bindings;
 *  - TypeScript `interface`, `type` alias, `enum` and `namespace`/`module`
 *    declarations (`declare` is a modifier only and produces no node);
 *  - comments, attached to the nearest following symbol (JSDoc/line/block).
 *
 * False-positive defences: comments and strings are token kinds, so `import` in
 * a comment or string is never a reference; regex literals are scanned as one
 * token; static import/export must start a statement, which keeps JSX text such
 * as `<p>import x from './x'</p>` from being misread as a declaration.
 *
 * Conservative gaps (reported as `unverifiable`, never guessed):
 *
 *  - non-literal specifiers (`import(name)`, `require(expr)`, template literals
 *    with substitutions) produce no reference;
 *  - imports nested inside a function body, `export =`, decorator semantics,
 *    JSX tag/attribute names are out of scope (domain model §5);
 *  - methods and static fields are extracted only from `class` declarations
 *    whose body the scanner can isolate; nested functions/classes inside
 *    method/function bodies are skipped, so only direct local declarations are
 *    reported. Instance class fields are not reported (their scope has no
 *    value in the shared vocabulary);
 *  - TypeScript `interface`/`type`/`enum`/`namespace` map onto existing
 *    `NodeKind` spellings (`class`/`definition`/`module`) because the whitelist
 *    has no TS-specific kinds;
 *  - doc metadata: `usage`/`purpose` come only from explicit `@usage`,
 *    `@purpose`, `Usage:` or `Purpose:` lines; `brief` only from the first
 *    doc-comment line. Missing annotations leave the fields empty and emit one
 *    `unverifiable` diagnostic per parse. Comment bodies are never returned:
 *    only capped summary/description/brief fields.
 *
 * Complexity: tokenize O(n); reference/symbol scan O(tokens) overall because
 * every class/function body is skipped exactly once; AST O(symbols). No
 * recursion over source nesting.
 */
import { AstTree } from '../../shared/ast.js'
import type { AstNode } from '../../shared/ast.js'
import type { SourceSpan, Token } from '../../shared/ast.js'
import {
  MAX_BRIEF_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PURPOSE_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_USAGE_LENGTH,
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
  CodeComment,
  ConceptBinding,
  ConceptScope,
  FileReference,
  FlatFragment,
  NodeMetadata,
  NodeReference,
  ParseOptions,
  ParseResult,
  Parser,
} from './parser.js'
import { tokenize } from './tokenizer.js'
import { structuralLocator } from './markup.js'
import type { StructuralConcept } from '../../shared/entity.js'
import type { ConditionForm, StructuralRelation } from '../../shared/enum.js'

/** What a symbol binds in its source context (shared metadata vocabulary). */
export type CodeBinding = ConceptBinding

/**
 * Declaration scope, only when the enclosing context can be proved locally.
 * `global` is a module-level declaration, `local` a declaration inside a
 * function/method body, `static` a class member declared with `static` (or a
 * member of a `static {}` block). Anything else leaves the field absent.
 */
export type CodeScope = ConceptScope

/** One code symbol the lexical scan can prove. */
export interface CodeSymbol extends FlatFragment {
  /**
   * Symbol kind. JS uses `class`/`function`/`method`/`variable`; TypeScript
   * declarations map onto existing `NodeKind` spellings because the whitelist
   * has no `interface`/`type`/`enum`/`namespace`:
   *  - `interface` -> `class` (a named, member-bearing type declaration);
   *  - `type` alias and `enum` -> `definition` (named type/value definitions);
   *  - `namespace`/`module` -> `module` (a declaration container).
   */
  kind: 'class' | 'function' | 'method' | 'variable' | 'definition' | 'module'
  name: string
  /** Symbol span, including the declaration keyword(s). */
  span: SourceSpan
  /** Code span = token range; same range as `span` today, kept separate on purpose. */
  codeSpan: SourceSpan
  /** Index of the first declaration token in the raw token array. */
  tokenStart: number
  /** Index of the last declaration token (body close) in the raw token array. */
  tokenEnd: number
  exported: boolean
  async: boolean
  generator: boolean
  static: boolean
  /** What this symbol binds. Always known from the symbol kind. */
  binding?: CodeBinding
  /** Provable scope; absent rather than guessed when the context is unclear. */
  scope?: CodeScope
  form?: 'method' | 'constructor' | 'getter' | 'setter'
  ownerClass?: string
  /** Body-free locator for this symbol. */
  reference?: NodeReference
  /** Explicit first doc-comment line (≤300). */
  brief?: string
  /** Explicit doc-comment first line (≤200). */
  summary?: string
  /** Behaviour from the doc comment body (≤500). */
  description?: string
  /** Explicit `@usage`/`Usage:` only (≤300). */
  usage?: string
  /** Explicit `@purpose`/`Purpose:` only (≤200). */
  purpose?: string
  commentStyle?: CodeComment['style']
  /** True when an explicit usage annotation was found. */
  hasUsage: boolean
  /** True when an explicit purpose annotation was found. */
  hasPurpose: boolean
}

/** One exported binding occurrence. */
export interface ExportBinding {
  /** Exported name (`*` for wildcard). */
  name: string
  /** Re-export source specifier, when there is one. */
  specifier?: string
  typeOnly: boolean
  wildcard: boolean
  span: SourceSpan
}

/** Parser-specific result with symbols, comments and export bindings. */
export interface JavaScriptParseResult extends ParseResult {
  symbols: CodeSymbol[]
  comments: CodeComment[]
  exports: ExportBinding[]
  /** Explicit contract-tag Condition nodes (`@requires`, `@ensures`, ...). */
  conditions: NodeMetadata[]
}

/** Maximum contract-tag Condition nodes extracted from one file. */
export const MAX_CONTRACT_CONDITIONS = 256

/**
 * Doc-comment contract tags mapped to a Condition form. Only these tags are
 * conditions; `@param`/`@returns`/`@throws` are not (`docs/domain-model-v24.md`
 * §2.3). `requires`/`pre` map to the necessary-condition relation, `ensures`/
 * `post` to a postcondition, `invariant` to an invariant.
 */
const CONTRACT_TAGS: Readonly<Record<string, { form: ConditionForm; relation?: StructuralRelation }>> = {
  requires: { form: 'precondition', relation: 'requires' },
  pre: { form: 'precondition', relation: 'requires' },
  ensures: { form: 'postcondition' },
  post: { form: 'postcondition' },
  invariant: { form: 'invariant' },
}

/** Significant token with its index in the raw token array. */
interface SigToken {
  token: Token
  index: number
}

/** Parsed doc-comment fields, already capped. */
interface DocFields {
  brief?: string
  summary?: string
  description?: string
  usage?: string
  purpose?: string
  hasUsage: boolean
  hasPurpose: boolean
}

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'readonly', 'override', 'abstract', 'declare', 'accessor',
])
const DECLARATION_KEYWORDS = new Set(['function', 'class'])
/** TypeScript declaration keywords that can follow `export`. */
const TS_DECLARATION_KEYWORDS = new Set(['interface', 'type', 'enum', 'namespace', 'module'])
const CONTINUATION = new Set(['+', '-', '*', '/', '%', '&&', '||', '??', '?', ':', '=', '=>', ',', '.', '&', '|'])

/**
 * Parse JavaScript/TypeScript/JSX source.
 *
 * Time O(n) in the source length, space O(tokens + symbols). Never throws for
 * malformed code; throws only when `options.signal` is already aborted.
 */
export function parseJavaScript(text: string, options: ParseOptions = {}): JavaScriptParseResult {
  const ctx = new ParseContext(text, options)
  const scanned = tokenize(ctx.text, { maxTokens: ctx.maxTokens, shouldStop: ctx.shouldStop })
  const tokens = scanned.tokens
  ctx.tokens = tokens.length
  if (scanned.truncated && tokens.length >= ctx.maxTokens) {
    ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
  }

  const references: FileReference[] = []
  const symbols: CodeSymbol[] = []
  const comments: CodeComment[] = []
  const exports: ExportBinding[] = []
  const commentBodies = new Map<number, string>()
  const sig = significantTokens(tokens)

  for (const token of tokens) {
    if (token.kind !== 'comment') continue
    const style = commentStyle(token.text)
    const body = commentBody(token.text, style)
    commentBodies.set(token.span.start, body)
    comments.push({
      style,
      brief: firstLine(body),
      span: token.span,
      attachment: 'orphan',
    })
  }

  if (!ctx.timedOut && sig.length > 0) {
    const newline = newlineFlags(tokens, sig)
    const braceDepth = braceDepthFlags(sig)
    const exportedDeclarations = collectExportedDeclarations(sig)
    let position = 0
    while (position < sig.length) {
      if ((position & 1_023) === 0 && !ctx.checkpoint()) break
      const value = sig[position].token.text
      // A module-level declaration is global; a declaration in a top-level
      // block is not provably global (the scope enum has no block case), so its
      // scope is omitted instead of guessed.
      const moduleScope: CodeScope | undefined = braceDepth[position] === 0 ? 'global' : undefined
      if (value === 'import') {
        handleImport(ctx, sig, position, references)
        position += 1
        continue
      }
      if (value === 'export') {
        handleExport(ctx, sig, position, references, exports)
        position += 1
        continue
      }
      if (value === 'require' && sig[position - 1]?.token.text !== '.') {
        handleRequire(ctx, sig, position, references)
        position += 1
        continue
      }
      if (value === 'class' && canDeclare(sig, position)) {
        position = handleClass(ctx, sig, position, symbols, exportedDeclarations, newline, moduleScope, references)
        continue
      }
      if (value === 'function' && canDeclare(sig, position)) {
        position = handleFunction(ctx, sig, position, symbols, exportedDeclarations, newline, moduleScope, references)
        continue
      }
      if (value === 'interface' && canDeclare(sig, position)) {
        position = handleInterface(ctx, sig, position, symbols, exportedDeclarations, moduleScope)
        continue
      }
      if (value === 'type' && canDeclare(sig, position)) {
        const next = handleTypeAlias(ctx, sig, position, symbols, exportedDeclarations, newline, moduleScope)
        position = next > position ? next : position + 1
        continue
      }
      if (value === 'enum' && (canDeclare(sig, position) || sig[position - 1]?.token.text === 'const')) {
        position = handleEnum(ctx, sig, position, symbols, exportedDeclarations, moduleScope)
        continue
      }
      if ((value === 'namespace' || value === 'module') && canDeclare(sig, position)) {
        position = handleNamespace(ctx, sig, position, symbols, exportedDeclarations, moduleScope)
        continue
      }
      if ((value === 'const' || value === 'let' || value === 'var') && canDeclare(sig, position)) {
        const next = handleDeclaration(ctx, sig, position, symbols, exportedDeclarations, newline, moduleScope, references)
        position = next > position ? next : position + 1
        continue
      }
      position += 1
    }
  }

  attachComments(ctx, symbols, comments, commentBodies, tokens)
  const conditions = buildContractConditions(ctx, comments)
  const metadata = [...buildMetadata(ctx, symbols), ...conditions, ...buildReferenceNodes(ctx, references)]

  const root = createAstRoot('module', ctx.text.length)
  for (const reference of references) {
    appendAstNode(ctx, root, reference.kind === 'export-from' ? 'export' : 'import', reference.span, reference.specifier)
  }
  for (const symbol of symbols) {
    appendAstNode(ctx, root, symbol.kind, symbol.span, symbol.name)
  }
  for (const comment of comments) {
    appendAstNode(ctx, root, 'comment', comment.span, comment.brief)
  }

  const base = ctx.finalize({
    parserId: 'javascript',
    references,
    tokens: tokens.length,
    ast: new AstTree(root),
    nodes: metadata,
  })
  return { ...base, symbols, comments, exports, conditions }
}

/** `Parser` implementation for the registry. */
export class JavaScriptParser implements Parser {
  readonly id = 'javascript'
  readonly extensions: readonly string[] = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parseJavaScript(text, options)
  }
}

/** Shared singleton; the registry in `./index.ts` registers it. */
export const javascriptParser = new JavaScriptParser()

/* ------------------------------------------------------------------------- *
 * Significant-token helpers
 * ------------------------------------------------------------------------- */

function significantTokens(tokens: readonly Token[]): SigToken[] {
  const result: SigToken[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind === 'whitespace' || token.kind === 'newline' || token.kind === 'comment' || token.kind === 'eof') {
      continue
    }
    result.push({ token, index })
  }
  return result
}

/** For each significant token, whether a newline token precedes it. O(tokens). */
function newlineFlags(tokens: readonly Token[], sig: readonly SigToken[]): boolean[] {
  const flags: boolean[] = new Array(sig.length).fill(false)
  let previousRaw = -1
  for (let position = 0; position < sig.length; position += 1) {
    const currentRaw = sig[position].index
    for (let index = previousRaw + 1; index < currentRaw; index += 1) {
      if (tokens[index].kind === 'newline') {
        flags[position] = true
        break
      }
    }
    previousRaw = currentRaw
  }
  return flags
}

/**
 * For each significant token, how many `{` are unmatched before it. Used to
 * distinguish a module-level declaration (depth 0) from one nested in a
 * top-level block; body scanning supplies its own scope explicitly.
 */
function braceDepthFlags(sig: readonly SigToken[]): number[] {
  const depths: number[] = new Array(sig.length).fill(0)
  let depth = 0
  for (let position = 0; position < sig.length; position += 1) {
    depths[position] = depth
    const value = sig[position].token.text
    if (value === '{') {
      // `declare global { ... }` declares into the global scope, so its members
      // stay module-level; every other block adds a nesting level.
      const declareGlobal = position >= 2 &&
        sig[position - 1].token.text === 'global' &&
        sig[position - 2].token.text === 'declare'
      if (!declareGlobal) depth += 1
    } else if (value === '}' && depth > 0) {
      depth -= 1
    }
  }
  return depths
}

function isStatementStart(sig: readonly SigToken[], position: number): boolean {
  if (position === 0) return true
  const previous = sig[position - 1].token
  if (previous.text === ';' || previous.text === '{' || previous.text === '}' || previous.text === ')') {
    return true
  }
  // Automatic semicolon insertion: a line break after a complete token starts a
  // new statement often enough for a lexical scanner, and this is what lets
  // semicolon-free files produce more than one import.
  return sig[position].token.span.line > previous.span.line
}

function canDeclare(sig: readonly SigToken[], position: number): boolean {
  if (position === 0) return true
  const previous = sig[position - 1].token
  if (previous.kind === 'keyword' &&
    (previous.text === 'export' || previous.text === 'default' ||
      previous.text === 'abstract' || previous.text === 'declare' || previous.text === 'async')) {
    return true
  }
  return isStatementStart(sig, position)
}

/** Declaration keywords preceded by `export` (incl. `export default/async/...`). */
function collectExportedDeclarations(sig: readonly SigToken[]): Set<number> {
  const exported = new Set<number>()
  for (let position = 0; position < sig.length; position += 1) {
    if (sig[position].token.text !== 'export') continue
    if (!isStatementStart(sig, position)) continue
    let cursor = position + 1
    if (sig[cursor]?.token.text === 'type') cursor += 1
    while (cursor < sig.length) {
      const value = sig[cursor].token.text
      if (value === 'default' || value === 'abstract' || value === 'declare' || value === 'async') {
        cursor += 1
        continue
      }
      break
    }
    const candidate = sig[cursor]?.token.text
    if (candidate !== undefined &&
      (DECLARATION_KEYWORDS.has(candidate) || TS_DECLARATION_KEYWORDS.has(candidate) ||
        candidate === 'const' || candidate === 'let' || candidate === 'var')) {
      exported.add(cursor)
    }
  }
  return exported
}

/** Raw token index of the first declaration token, walking back over modifiers. */
function declarationStartPosition(sig: readonly SigToken[], position: number): number {
  let cursor = position
  while (cursor > 0) {
    const previous = sig[cursor - 1].token
    if (previous.kind === 'keyword' &&
      (previous.text === 'export' || previous.text === 'default' || previous.text === 'abstract' ||
        previous.text === 'declare' || previous.text === 'async')) {
      cursor -= 1
      continue
    }
    break
  }
  return cursor
}

function declarationStart(sig: readonly SigToken[], position: number): number {
  return sig[declarationStartPosition(sig, position)].index
}

function spanBetween(start: Token, end: Token): SourceSpan {
  return { start: start.span.start, end: end.span.end, line: start.span.line, column: start.span.column }
}

/** Span of a string literal's contents, excluding quotes when present. */
function innerStringSpan(token: Token): SourceSpan {
  const text = token.text
  const quoted = text.length >= 2 &&
    (text[0] === "'" || text[0] === '"' || text[0] === '`') && text[text.length - 1] === text[0]
  if (!quoted) return token.span
  return {
    start: token.span.start + 1,
    end: token.span.end - 1,
    line: token.span.line,
    column: token.span.column + 1,
  }
}

/** Literal value of a string token, or undefined for a non-literal. */
function stringLiteralValue(token: Token): string | undefined {
  if (token.kind !== 'string') return undefined
  const text = token.text
  if (text.length < 2) return undefined
  const quote = text[0]
  if ((quote !== "'" && quote !== '"' && quote !== '`') || text[text.length - 1] !== quote) return undefined
  const inner = text.slice(1, -1)
  if (quote === '`' && inner.includes('${')) return undefined
  return inner
}

/** Index of the matching close for `open`, or -1. O(range). */
function findMatching(
  sig: readonly SigToken[],
  openPosition: number,
  openText: string,
  closeText: string,
  limit = sig.length,
): number {
  let depth = 0
  for (let position = openPosition; position < Math.min(limit, sig.length); position += 1) {
    const value = sig[position].token.text
    if (value === openText) depth += 1
    else if (value === closeText) {
      depth -= 1
      if (depth === 0) return position
    }
  }
  return -1
}

/**
 * Index of the `{` that opens a function body, after `paramsClose`.
 *
 * Plain JS/TS without a return type has the brace immediately after `)`. A
 * TypeScript return type (`): number {`, `): Promise<void> {`,
 * `): { ok: boolean } {`) sits in between and previously made the declaration
 * invisible to the symbol scan. The annotation is skipped lexically, with a
 * bounded window; anything ambiguous (function types, declarations without a
 * body) returns -1, so the caller keeps its fail-closed behaviour. No new
 * syntax is accepted and no type is interpreted.
 */
function findFunctionBodyOpen(sig: readonly SigToken[], paramsClose: number): number {
  if (sig[paramsClose + 1]?.token.text === '{') return paramsClose + 1
  if (sig[paramsClose + 1]?.token.text !== ':') return -1
  let depth = 0
  const limit = Math.min(sig.length, paramsClose + 200)
  for (let position = paramsClose + 1; position < limit; position += 1) {
    const value = sig[position].token.text
    if (value === '(' || value === '[' || value === '<') {
      depth += 1
      continue
    }
    if (value === ')' || value === ']' || value === '>') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (value === ';' || value === '=' || value === '=>' || value === '}') return -1
    if (value !== '{') continue
    if (depth > 0) {
      // A brace inside `Array<{ a: 1 }>` is part of the annotation.
      const nestedClose = findMatching(sig, position, '{', '}')
      if (nestedClose < 0) return -1
      position = nestedClose
      continue
    }
    const previous = sig[position - 1]?.token.text
    if (
      previous !== ':' && previous !== '|' && previous !== '&' &&
      previous !== ',' && previous !== '[' && previous !== '(' && previous !== '<'
    ) {
      // `: number {` / `: Result {`: the annotation ended, this brace is the body.
      return position
    }
    const close = findMatching(sig, position, '{', '}')
    if (close < 0) return -1
    const next = sig[close + 1]?.token.text
    // `{ ... } {` = an object return type followed by the body.
    if (next === '{') return close + 1
    // `{ ... } | ...` / `{ ... } & ...` = a union/intersection type literal.
    if (next === '|' || next === '&') {
      position = close
      continue
    }
    return -1
  }
  return -1
}

/* ------------------------------------------------------------------------- *
 * References
 * ------------------------------------------------------------------------- */

function pushReference(
  ctx: ParseContext,
  references: FileReference[],
  kind: FileReference['kind'],
  token: Token,
  typeOnly: boolean,
  names: readonly string[],
  wildcard = false,
): void {
  const specifier = stringLiteralValue(token)
  if (specifier === undefined) return
  const span = innerStringSpan(token)
  references.push({
    kind,
    specifier,
    external: isExternalSpecifier(specifier),
    span,
    ...(typeOnly ? { typeOnly: true } : {}),
    ...(names.length === 0 ? {} : { names }),
    ...(wildcard ? { wildcard: true } : {}),
    ...fragmentForSpan(ctx, span),
  })
}

function handleImport(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  references: FileReference[],
): void {
  const next = sig[position + 1]
  const previous = sig[position - 1]
  if (next === undefined) return
  if (next.token.text === '.' || next.token.text === '(') {
    if (next.token.text === '(' && previous?.token.text !== '.') {
      handleDynamicImport(ctx, sig, position, references)
      return
    }
    return // import.meta or a property named import
  }
  if (!isStatementStart(sig, position)) return
  if (next.token.kind === 'string') {
    pushReference(ctx, references, 'import', next.token, false, [])
    return
  }
  let cursor = position + 1
  let typeOnly = false
  if (sig[cursor]?.token.text === 'type' && sig[cursor + 1]?.token.text !== 'from') {
    typeOnly = true
    cursor += 1
  }
  const names: string[] = []
  const limit = Math.min(sig.length, cursor + 300)
  for (let index = cursor; index < limit; index += 1) {
    const token = sig[index].token
    const value = token.text
    if (value === '{') {
      const close = findMatching(sig, index, '{', '}', limit)
      const stop = close < 0 ? limit : close
      let inside = index + 1
      while (inside < stop) {
        const entry = sig[inside].token
        if (entry.text === 'type' &&
          (sig[inside + 1]?.token.kind === 'identifier' || sig[inside + 1]?.token.kind === 'keyword')) {
          inside += 1
          continue
        }
        if (entry.text === 'as') {
          // Skip the alias target; the imported name is the one before `as`.
          inside += 2
          continue
        }
        if (entry.kind === 'identifier' || entry.kind === 'keyword') names.push(entry.text)
        inside += 1
      }
      index = close < 0 ? limit : close
      continue
    }
    if (value === '*') {
      names.push('*')
      if (sig[index + 1]?.token.text === 'as' && sig[index + 2]?.token.kind === 'identifier') index += 2
      continue
    }
    if (value === 'from') {
      const literal = sig[index + 1]
      if (literal === undefined || literal.token.kind !== 'string') {
        ctx.unverifiable('import has a non-literal module specifier', literal?.token.span ?? token.span)
        return
      }
      pushReference(ctx, references, 'import', literal.token, typeOnly, names)
      return
    }
    if (value === ';') return
    if (token.kind === 'identifier') {
      names.push('default')
      continue
    }
    if (token.kind === 'keyword' && value !== 'type') return
  }
  ctx.unverifiable('import statement has no literal module specifier', sig[position].token.span)
}

function handleDynamicImport(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  references: FileReference[],
): void {
  const argument = sig[position + 2]
  if (argument === undefined) {
    ctx.unverifiable('dynamic import has no argument', sig[position].token.span)
    return
  }
  if (stringLiteralValue(argument.token) === undefined) {
    ctx.unverifiable('dynamic import specifier is not a string literal', argument.token.span)
    return
  }
  const after = sig[position + 3]?.token.text
  if (after !== ')' && after !== ',') {
    ctx.unverifiable('dynamic import specifier is part of a larger expression', argument.token.span)
    return
  }
  pushReference(ctx, references, 'dynamic-import', argument.token, false, [])
}

function handleRequire(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  references: FileReference[],
): void {
  if (sig[position + 1]?.token.text !== '(') return
  const argument = sig[position + 2]
  if (argument === undefined) return
  if (stringLiteralValue(argument.token) === undefined) {
    ctx.unverifiable('require specifier is not a string literal', argument.token.span)
    return
  }
  if (sig[position + 3]?.token.text !== ')') {
    ctx.unverifiable('require specifier is part of a larger expression', argument.token.span)
    return
  }
  pushReference(ctx, references, 'require', argument.token, false, [])
}

function handleExport(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  references: FileReference[],
  exports: ExportBinding[],
): void {
  if (!isStatementStart(sig, position)) return
  let cursor = position + 1
  let typeOnly = false
  if (sig[cursor]?.token.text === 'type' &&
    sig[cursor + 1]?.token.text !== 'from' && sig[cursor + 1]?.token.text !== ',' &&
    sig[cursor + 1]?.token.text !== '=') {
    typeOnly = true
    cursor += 1
  }
  const first = sig[cursor]
  if (first === undefined) return

  if (first.token.text === '{') {
    const close = findMatching(sig, cursor, '{', '}')
    const stop = close < 0 ? sig.length : close
    const names: string[] = []
    let index = cursor + 1
    while (index < stop) {
      const entry = sig[index].token
      if (entry.kind === 'identifier' || entry.kind === 'keyword') {
        const aliased = sig[index + 1]?.token.text === 'as' &&
          (sig[index + 2]?.token.kind === 'identifier' || sig[index + 2]?.token.kind === 'keyword')
        names.push(entry.text)
        exports.push({
          name: aliased ? sig[index + 2].token.text : entry.text,
          typeOnly,
          wildcard: false,
          span: entry.span,
        })
        if (aliased) index += 2
      }
      index += 1
    }
    const from = close < 0 ? undefined : sig[close + 1]
    if (from?.token.text === 'from' && sig[close + 2]?.token.kind === 'string') {
      pushReference(ctx, references, 'export-from', sig[close + 2].token, typeOnly, names)
    }
    return
  }

  if (first.token.text === '*') {
    let index = cursor + 1
    let exportedName = '*'
    if (sig[index]?.token.text === 'as') {
      const alias = sig[index + 1]
      if (alias !== undefined && (alias.token.kind === 'identifier' || alias.token.kind === 'keyword')) {
        exportedName = alias.token.text
      }
      index += 2
    }
    if (sig[index]?.token.text === 'from' && sig[index + 1]?.token.kind === 'string') {
      const specifier = stringLiteralValue(sig[index + 1].token)
      pushReference(ctx, references, 'export-from', sig[index + 1].token, typeOnly, ['*'], true)
      exports.push({
        name: exportedName,
        ...(specifier === undefined ? {} : { specifier }),
        typeOnly,
        wildcard: true,
        span: sig[index + 1].token.span,
      })
      return
    }
    ctx.unverifiable('export * has no literal module specifier', first.token.span)
    return
  }

  if (first.token.text === 'default') {
    exports.push({ name: 'default', typeOnly, wildcard: false, span: first.token.span })
  }
}

/* ------------------------------------------------------------------------- *
 * Symbols
 * ------------------------------------------------------------------------- */

function findClassBodyOpen(sig: readonly SigToken[], from: number): number {
  let parens = 0
  let brackets = 0
  let angles = 0
  const limit = Math.min(sig.length, from + 500)
  for (let position = from; position < limit; position += 1) {
    const value = sig[position].token.text
    if (value === '(') parens += 1
    else if (value === ')') parens = Math.max(0, parens - 1)
    else if (value === '[') brackets += 1
    else if (value === ']') brackets = Math.max(0, brackets - 1)
    else if (value === '<') angles += 1
    else if (value === '>') angles = Math.max(0, angles - 1)
    else if (value === '{' && parens === 0 && brackets === 0 && angles === 0) return position
    else if (value === ';' && parens === 0 && brackets === 0 && angles === 0) return -1
  }
  return -1
}

function newSymbol(
  kind: CodeSymbol['kind'],
  name: string,
  span: SourceSpan,
  tokenStart: number,
  tokenEnd: number,
  exported: boolean,
  flags: {
    async?: boolean
    generator?: boolean
    static?: boolean
    scope?: CodeScope
    binding?: CodeBinding
  } = {},
): CodeSymbol {
  return {
    kind,
    name,
    span,
    codeSpan: span,
    tokenStart,
    tokenEnd,
    exported,
    async: flags.async === true,
    generator: flags.generator === true,
    static: flags.static === true,
    binding: flags.binding ?? bindingForKind(kind),
    ...(flags.scope === undefined ? {} : { scope: flags.scope }),
    hasUsage: false,
    hasPurpose: false,
  }
}

/** The binding category implied by a symbol kind; type names bind identifiers. */
function bindingForKind(kind: CodeSymbol['kind']): CodeBinding {
  switch (kind) {
    case 'class':
      return 'class'
    case 'function':
      return 'function'
    case 'method':
      return 'method'
    case 'variable':
      return 'variable'
    default:
      return 'identifier'
  }
}

function handleClass(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  symbols: CodeSymbol[],
  exported: ReadonlySet<number>,
  newline: readonly boolean[],
  scope: CodeScope | undefined,
  references: FileReference[],
): number {
  const nameToken = sig[position + 1]
  if (nameToken === undefined || nameToken.token.kind !== 'identifier') return position + 1
  const open = findClassBodyOpen(sig, position + 2)
  if (open < 0) {
    ctx.unverifiable('class declaration body could not be isolated', sig[position].token.span)
    return position + 1
  }
  const close = findMatching(sig, open, '{', '}')
  const endPosition = close < 0 ? open : close
  if (close < 0) ctx.unverifiable('unterminated class body', sig[open].token.span)
  const span = spanBetween(sig[declarationStartPosition(sig, position)].token, sig[endPosition].token)
  symbols.push(
    newSymbol(
      'class',
      nameToken.token.text,
      span,
      declarationStart(sig, position),
      sig[endPosition].index,
      exported.has(position),
      { scope },
    ),
  )
  if (close >= 0) scanMethods(ctx, sig, open, close, nameToken.token.text, symbols, newline, references)
  return endPosition + 1
}

function handleFunction(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  symbols: CodeSymbol[],
  exported: ReadonlySet<number>,
  newline: readonly boolean[],
  scope: CodeScope | undefined,
  references: FileReference[],
): number {
  let cursor = position + 1
  let generator = false
  if (sig[cursor]?.token.text === '*') {
    generator = true
    cursor += 1
  }
  const nameToken = sig[cursor]
  if (nameToken === undefined || nameToken.token.kind !== 'identifier') return position + 1
  if (sig[cursor + 1]?.token.text !== '(') return position + 1
  const paramsClose = findMatching(sig, cursor + 1, '(', ')')
  if (paramsClose < 0) {
    ctx.unverifiable('function parameter list is unterminated', sig[cursor + 1].token.span)
    return position + 1
  }
  // A TypeScript return type (`): number {`, `): Promise<void> {`) must not
  // hide the declaration: the body brace is found after the annotation.
  const bodyOpen = sig[paramsClose + 1]?.token.text === '{'
    ? paramsClose + 1
    : findFunctionBodyOpen(sig, paramsClose)
  if (bodyOpen < 0) {
    // Ambient TypeScript declaration: `declare function f(): void;` has no
    // body. The `declare` keyword produces no node of its own; the function
    // symbol is still real and stays module-level.
    if (sig[position - 1]?.token.text !== 'declare') return position + 1
    const afterParams = paramsClose + 1
    const signatureEnd = afterParams >= sig.length ||
      newline[afterParams] === true ||
      sig[afterParams]?.token.text === ';' ||
      sig[afterParams]?.token.text === '}'
      ? paramsClose
      : Math.max(paramsClose, typeAliasEnd(sig, afterParams, newline))
    const ambientSpan = spanBetween(sig[declarationStartPosition(sig, position)].token, sig[signatureEnd].token)
    symbols.push(
      newSymbol('function', nameToken.token.text, ambientSpan, declarationStart(sig, position), sig[signatureEnd].index, exported.has(position), {
        async: sig[position - 1]?.token.text === 'async',
        generator,
        scope,
      }),
    )
    return signatureEnd + 1
  }
  const bodyClose = findMatching(sig, bodyOpen, '{', '}')
  const endPosition = bodyClose < 0 ? bodyOpen : bodyClose
  if (bodyClose < 0) ctx.unverifiable('unterminated function body', sig[bodyOpen].token.span)
  const span = spanBetween(sig[declarationStartPosition(sig, position)].token, sig[endPosition].token)
  const previous = sig[position - 1]?.token.text
  symbols.push(
    newSymbol('function', nameToken.token.text, span, declarationStart(sig, position), sig[endPosition].index, exported.has(position), {
      async: previous === 'async',
      generator,
      scope,
    }),
  )
  if (bodyClose >= 0) scanBodyVariables(ctx, sig, bodyOpen, bodyClose, 'local', symbols, newline, references)
  return endPosition + 1
}

/** One name introduced by a binding pattern. */
interface BindingName {
  name: string
  span: SourceSpan
  /** Significant-token index of the binding identifier. */
  tokenIndex: number
}

/** Parsed binding pattern plus the position just after it. */
interface BindingPattern {
  names: BindingName[]
  next: number
  /** True for a single plain identifier (the only function-binding shape). */
  simple: boolean
}

/** Where a declarator's initializer starts, or where the declarator ends. */
interface DeclaratorScan {
  equals?: number
  end: number
}

/** A provable function value assigned to a binding. */
interface FunctionValue {
  end: number
  async: boolean
  generator: boolean
}

/**
 * TypeScript `interface`. `NodeKind` has no `interface` spelling, so the
 * closest existing kind (`class`, a named member-bearing type declaration) is
 * used and the binding is the type name (`identifier`).
 */
function handleInterface(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  symbols: CodeSymbol[],
  exported: ReadonlySet<number>,
  scope: CodeScope | undefined,
): number {
  const nameToken = sig[position + 1]
  if (nameToken === undefined || nameToken.token.kind !== 'identifier') return position + 1
  const open = findClassBodyOpen(sig, position + 2)
  if (open < 0) {
    ctx.unverifiable('interface body could not be isolated', sig[position].token.span)
    return position + 1
  }
  const close = findMatching(sig, open, '{', '}')
  const endPosition = close < 0 ? open : close
  if (close < 0) ctx.unverifiable('unterminated interface body', sig[open].token.span)
  const span = spanBetween(sig[declarationStartPosition(sig, position)].token, sig[endPosition].token)
  symbols.push(
    newSymbol(
      'class',
      nameToken.token.text,
      span,
      declarationStart(sig, position),
      sig[endPosition].index,
      exported.has(position),
      { scope, binding: 'identifier' },
    ),
  )
  return endPosition + 1
}

/**
 * TypeScript `type` alias. `NodeKind` has no `type` spelling; `definition` is
 * the closest existing kind for a named type/value definition.
 */
function handleTypeAlias(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  symbols: CodeSymbol[],
  exported: ReadonlySet<number>,
  newline: readonly boolean[],
  scope: CodeScope | undefined,
): number {
  const nameToken = sig[position + 1]
  if (nameToken === undefined || nameToken.token.kind !== 'identifier') return position + 1
  let cursor = position + 2
  if (sig[cursor]?.token.text === '<') {
    const typeParameters = findMatching(sig, cursor, '<', '>')
    if (typeParameters < 0) return position + 1
    cursor = typeParameters + 1
  }
  if (sig[cursor]?.token.text !== '=') return position + 1
  const endPosition = typeAliasEnd(sig, cursor + 1, newline)
  const span = spanBetween(sig[declarationStartPosition(sig, position)].token, sig[endPosition].token)
  symbols.push(
    newSymbol(
      'definition',
      nameToken.token.text,
      span,
      declarationStart(sig, position),
      sig[endPosition].index,
      exported.has(position),
      { scope, binding: 'identifier' },
    ),
  )
  return endPosition + 1
}

/**
 * TypeScript `enum` (including `const enum`). `NodeKind` has no `enum`
 * spelling; `definition` is the closest existing kind.
 */
function handleEnum(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  symbols: CodeSymbol[],
  exported: ReadonlySet<number>,
  scope: CodeScope | undefined,
): number {
  const nameToken = sig[position + 1]
  if (nameToken === undefined || nameToken.token.kind !== 'identifier') return position + 1
  if (sig[position + 2]?.token.text !== '{') return position + 1
  const open = position + 2
  const close = findMatching(sig, open, '{', '}')
  const endPosition = close < 0 ? open : close
  if (close < 0) ctx.unverifiable('unterminated enum body', sig[open].token.span)
  // `export const enum E` marks the `const` declaration as exported.
  const exportedEnum = exported.has(position) ||
    (sig[position - 1]?.token.text === 'const' && exported.has(position - 1))
  const startPosition = sig[position - 1]?.token.text === 'const'
    ? declarationStartPosition(sig, position - 1)
    : declarationStartPosition(sig, position)
  const span = spanBetween(sig[startPosition].token, sig[endPosition].token)
  symbols.push(
    newSymbol(
      'definition',
      nameToken.token.text,
      span,
      sig[startPosition].index,
      sig[endPosition].index,
      exportedEnum,
      { scope, binding: 'identifier' },
    ),
  )
  return endPosition + 1
}

/**
 * TypeScript `namespace` / `module` block. `module` is the existing `NodeKind`
 * spelling for a declaration container, so both map to it.
 */
function handleNamespace(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  symbols: CodeSymbol[],
  exported: ReadonlySet<number>,
  scope: CodeScope | undefined,
): number {
  const nameToken = sig[position + 1]
  if (nameToken === undefined) return position + 1
  let cursor = position + 2
  let name: string
  if (nameToken.token.kind === 'identifier') {
    name = nameToken.token.text
    while (sig[cursor]?.token.text === '.' && sig[cursor + 1]?.token.kind === 'identifier') {
      name = `${name}.${sig[cursor + 1].token.text}`
      cursor += 2
    }
  } else if (nameToken.token.kind === 'string') {
    name = stripQuotes(nameToken.token.text)
  } else {
    return position + 1
  }
  const open = findClassBodyOpen(sig, cursor)
  if (open < 0) {
    ctx.unverifiable('namespace body could not be isolated', sig[position].token.span)
    return position + 1
  }
  const close = findMatching(sig, open, '{', '}')
  const endPosition = close < 0 ? open : close
  if (close < 0) ctx.unverifiable('unterminated namespace body', sig[open].token.span)
  const span = spanBetween(sig[declarationStartPosition(sig, position)].token, sig[endPosition].token)
  symbols.push(
    newSymbol(
      'module',
      name,
      span,
      declarationStart(sig, position),
      sig[endPosition].index,
      exported.has(position),
      { scope, binding: 'identifier' },
    ),
  )
  return endPosition + 1
}

/** End of a TypeScript type alias right-hand side (bounded, fail-closed). */
function typeAliasEnd(sig: readonly SigToken[], from: number, newline: readonly boolean[]): number {
  let depth = 0
  let angles = 0
  const limit = Math.min(sig.length, from + 500)
  let last = from
  for (let position = from; position < limit; position += 1) {
    const value = sig[position].token.text
    if (value === '(' || value === '[' || value === '{') {
      depth += 1
      last = position
      continue
    }
    if (value === ')' || value === ']' || value === '}') {
      if (depth === 0) return Math.max(from, position - 1)
      depth -= 1
      last = position
      continue
    }
    if (depth === 0) {
      if (value === ';') return Math.max(from, position - 1)
      if (value === '<' && canStartGeneric(sig, position)) {
        angles += 1
        last = position
        continue
      }
      if (value === '>' && angles > 0) {
        angles -= 1
        last = position
        continue
      }
      if (angles > 0) {
        last = position
        continue
      }
      if (position > from && newline[position] === true) {
        const previous = sig[position - 1]?.token.text
        if (!CONTINUATION.has(previous ?? '') && !CONTINUATION.has(value)) return Math.max(from, position - 1)
      }
    }
    last = position
  }
  return last
}

/**
 * `const x = 1`, `let { a, b: c } = obj`, `const [x, ...rest] = arr`, and the
 * existing `const f = (...) => ...` / `const f = function ...` function
 * bindings. One variable node is emitted per binding name; a function value on
 * a single identifier binding keeps the existing `function` symbol instead.
 */
function handleDeclaration(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  symbols: CodeSymbol[],
  exported: ReadonlySet<number> | undefined,
  newline: readonly boolean[],
  scope: CodeScope | undefined,
  references: FileReference[],
): number {
  const next = declareBindings(ctx, sig, position, symbols, exported, newline, scope)
  // The declarator scan skips its initializer so the same tokens are not
  // re-read as declarations. References living in that skipped range must still
  // be extracted (`const x = await import('./x')`, `const y = require('./y')`).
  scanSkippedReferences(ctx, sig, position + 1, next, references)
  return next
}

/** Emit the symbols of one `const`/`let`/`var` statement; returns the next position. */
function declareBindings(
  ctx: ParseContext,
  sig: readonly SigToken[],
  position: number,
  symbols: CodeSymbol[],
  exported: ReadonlySet<number> | undefined,
  newline: readonly boolean[],
  scope: CodeScope | undefined,
): number {
  // `const enum` / `declare const enum`: the enum handler owns that symbol.
  if (sig[position + 1]?.token.text === 'enum') return position + 1
  const startPosition = declarationStartPosition(sig, position)
  // Symbols record raw token indices; the span needs the sig token itself.
  const tokenStart = sig[startPosition].index
  const isExported = exported?.has(position) === true
  let cursor = position + 1
  let guard = 0
  while (cursor < sig.length && guard < 64) {
    guard += 1
    if ((guard & 31) === 0 && !ctx.checkpoint()) return cursor
    const pattern = parseBindingPattern(sig, cursor)
    if (pattern === undefined) return cursor + 1
    const scanned = scanDeclarator(sig, pattern.next, newline)
    if (scanned.equals === undefined) {
      pushVariables(sig, symbols, pattern.names, tokenStart, isExported, scope)
      cursor = scanned.end
    } else {
      const valueStart = scanned.equals + 1
      const fn = pattern.simple ? functionValueAt(sig, valueStart, newline) : undefined
      if (fn !== undefined) {
        const end = Math.max(valueStart, fn.end)
        const span = spanBetween(sig[startPosition].token, sig[end].token)
        symbols.push(
          newSymbol('function', pattern.names[0].name, span, tokenStart, sig[end].index, isExported, {
            async: fn.async,
            generator: fn.generator,
            scope,
          }),
        )
        cursor = end + 1
      } else {
        pushVariables(sig, symbols, pattern.names, tokenStart, isExported, scope)
        cursor = declaratorEnd(sig, valueStart, newline)
      }
    }
    if (sig[cursor]?.token.text === ',') {
      cursor += 1
      continue
    }
    return sig[cursor]?.token.text === ';' ? cursor + 1 : cursor
  }
  return cursor
}

function pushVariables(
  sig: readonly SigToken[],
  symbols: CodeSymbol[],
  names: readonly BindingName[],
  tokenStart: number,
  exported: boolean,
  scope: CodeScope | undefined,
): void {
  for (const binding of names) {
    symbols.push(
      newSymbol('variable', binding.name, binding.span, tokenStart, sig[binding.tokenIndex].index, exported, { scope }),
    )
  }
}

/**
 * Extract the dynamic `import()` / `require()` references in a token range that
 * a declaration handler skipped. Static `import` declarations cannot occur in a
 * declarator, so only the two call forms matter here.
 */
function scanSkippedReferences(
  ctx: ParseContext,
  sig: readonly SigToken[],
  from: number,
  to: number,
  references: FileReference[],
): void {
  const limit = Math.min(to, sig.length)
  for (let position = Math.max(0, from); position < limit; position += 1) {
    const value = sig[position].token.text
    if (value === 'import') {
      if (sig[position - 1]?.token.text !== '.') handleImport(ctx, sig, position, references)
    } else if (value === 'require' && sig[position - 1]?.token.text !== '.') {
      handleRequire(ctx, sig, position, references)
    }
  }
}

/** Parse `name`, `{ ... }` or `[ ... ]` into the bound names. */
function parseBindingPattern(sig: readonly SigToken[], start: number): BindingPattern | undefined {
  const token = sig[start]?.token
  if (token === undefined) return undefined
  if (token.kind === 'identifier') {
    return { names: [{ name: token.text, span: token.span, tokenIndex: start }], next: start + 1, simple: true }
  }
  if (token.text === '{') {
    const close = findMatching(sig, start, '{', '}')
    if (close < 0) return undefined
    const names: BindingName[] = []
    collectObjectBindings(sig, start + 1, close, names)
    return { names, next: close + 1, simple: false }
  }
  if (token.text === '[') {
    const close = findMatching(sig, start, '[', ']')
    if (close < 0) return undefined
    const names: BindingName[] = []
    collectArrayBindings(sig, start + 1, close, names)
    return { names, next: close + 1, simple: false }
  }
  return undefined
}

/** Collect `{ a, b: c, [key]: d, ...rest }` binding names. */
function collectObjectBindings(
  sig: readonly SigToken[],
  from: number,
  close: number,
  names: BindingName[],
): void {
  let position = from
  while (position < close) {
    const token = sig[position]?.token
    if (token === undefined) return
    const value = token.text
    if (value === ',') {
      position += 1
      continue
    }
    const spread = spreadPatternStart(sig, position)
    if (spread !== undefined) {
      position = collectValueBinding(sig, spread, close, names)
      continue
    }
    if (value === '[') {
      const keyClose = findMatching(sig, position, '[', ']', close)
      if (keyClose < 0) return
      position = keyClose + 1
      if (sig[position]?.token.text === ':') position = collectValueBinding(sig, position + 1, close, names)
      continue
    }
    if (token.kind === 'identifier' || token.kind === 'keyword' || token.kind === 'string' || token.kind === 'number') {
      const next = sig[position + 1]?.token.text
      if (next === ':') {
        // `key: value` — the key is not a binding, the value pattern is.
        position = collectValueBinding(sig, position + 2, close, names)
        continue
      }
      if (token.kind === 'identifier' && (next === ',' || next === '}' || next === '=')) {
        names.push({ name: token.text, span: token.span, tokenIndex: position })
        position = next === '=' ? skipToDelimiter(sig, position + 2, close) : position + 1
        continue
      }
    }
    position = skipToDelimiter(sig, position + 1, close)
  }
}

/** Collect `[a, , b = 1, ...rest]` binding names. */
function collectArrayBindings(
  sig: readonly SigToken[],
  from: number,
  close: number,
  names: BindingName[],
): void {
  let position = from
  while (position < close) {
    const token = sig[position]?.token
    if (token === undefined) return
    if (token.text === ',') {
      position += 1
      continue
    }
    const spread = spreadPatternStart(sig, position)
    if (spread !== undefined) {
      position = collectValueBinding(sig, spread, close, names)
      continue
    }
    const nested = parseBindingPattern(sig, position)
    if (nested !== undefined) {
      names.push(...nested.names)
      position = nested.next
      if (sig[position]?.token.text === '=') position = skipToDelimiter(sig, position + 1, close)
      continue
    }
    position = skipToDelimiter(sig, position + 1, close)
  }
}

/** Parse the value side of `key: value`; returns the position after it. */
function collectValueBinding(
  sig: readonly SigToken[],
  start: number,
  close: number,
  names: BindingName[],
): number {
  const nested = parseBindingPattern(sig, start)
  if (nested === undefined) return start + 1
  names.push(...nested.names)
  let position = nested.next
  if (sig[position]?.token.text === '=') position = skipToDelimiter(sig, position + 1, close)
  return position
}

/** True when `...` (three separate `.` tokens) starts at `position`. */
function spreadPatternStart(sig: readonly SigToken[], position: number): number | undefined {
  if (sig[position]?.token.text !== '.') return undefined
  if (sig[position + 1]?.token.text !== '.') return undefined
  if (sig[position + 2]?.token.text !== '.') return undefined
  return position + 3
}

/** Skip a default/expression value up to a top-level `,` or the pattern close. */
function skipToDelimiter(sig: readonly SigToken[], from: number, close: number): number {
  let depth = 0
  for (let position = from; position < close; position += 1) {
    const value = sig[position].token.text
    if (value === '(' || value === '[' || value === '{') depth += 1
    else if (value === ')' || value === ']' || value === '}') {
      if (depth === 0) return position
      depth -= 1
    } else if (depth === 0 && value === ',') return position
  }
  return close
}

/** Find the initializer `=` of a declarator, bounded and fail-closed. */
function scanDeclarator(
  sig: readonly SigToken[],
  from: number,
  newline: readonly boolean[],
): DeclaratorScan {
  let depth = 0
  let angles = 0
  let sawColon = false
  const limit = Math.min(sig.length, from + 500)
  for (let position = from; position < limit; position += 1) {
    const value = sig[position].token.text
    if (value === '(' || value === '[' || value === '{') {
      depth += 1
      continue
    }
    if (value === ')' || value === ']' || value === '}') {
      if (depth === 0) return { end: position }
      depth -= 1
      continue
    }
    if (depth > 0) continue
    if (value === ':') {
      sawColon = true
      continue
    }
    if (sawColon && value === '<') {
      angles += 1
      continue
    }
    if (sawColon && value === '>' && angles > 0) {
      angles -= 1
      continue
    }
    if (angles > 0) continue
    if (value === '=') {
      // `=>` inside a function type annotation is not the initializer.
      if (sig[position + 1]?.token.text === '>') {
        position += 1
        continue
      }
      return { equals: position, end: position }
    }
    if (value === ',' || value === ';' || value === 'of' || value === 'in') return { end: position }
    if (position > from && newline[position] === true) {
      const previous = sig[position - 1]?.token.text
      if (!CONTINUATION.has(previous ?? '') && !CONTINUATION.has(value)) return { end: position }
    }
  }
  return { end: Math.max(from, Math.min(sig.length - 1, limit - 1)) }
}

/** End of a declarator initializer: a top-level `,`, `;` or line break. */
function declaratorEnd(sig: readonly SigToken[], from: number, newline: readonly boolean[]): number {
  let depth = 0
  let angles = 0
  const limit = Math.min(sig.length, from + 2_000)
  let last = from
  for (let position = from; position < limit; position += 1) {
    const value = sig[position].token.text
    if (value === '(' || value === '[' || value === '{') {
      depth += 1
      last = position
      continue
    }
    if (value === ')' || value === ']' || value === '}') {
      if (depth === 0) return position
      depth -= 1
      last = position
      continue
    }
    if (depth === 0) {
      if (value === ',' || value === ';') return position
      if (value === '<' && canStartGeneric(sig, position)) {
        angles += 1
        last = position
        continue
      }
      if (value === '>' && angles > 0) {
        angles -= 1
        last = position
        continue
      }
      if (angles > 0) {
        last = position
        continue
      }
      if (position > from && newline[position] === true) {
        const previous = sig[position - 1]?.token.text
        if (!CONTINUATION.has(previous ?? '') && !CONTINUATION.has(value)) return position
      }
    }
    last = position
  }
  return last
}

/** Heuristic for `foo<A, B>()` / `Map<string, number>` generic brackets. */
function canStartGeneric(sig: readonly SigToken[], position: number): boolean {
  const previous = sig[position - 1]?.token
  const next = sig[position + 1]?.token
  if (previous === undefined || next === undefined) return false
  const previousOk = previous.kind === 'identifier' ||
    previous.text === ')' || previous.text === ']' || previous.text === '>'
  const nextOk = next.kind === 'identifier' || next.kind === 'keyword' ||
    next.text === '{' || next.text === '[' || next.text === '(' || next.text === '<'
  return previousOk && nextOk
}

/**
 * Recognise a function value (arrow or anonymous function expression) starting
 * at `start`. Named function expressions keep the old conservative behaviour:
 * they are not treated as the binding's function value.
 */
function functionValueAt(
  sig: readonly SigToken[],
  start: number,
  newline: readonly boolean[],
): FunctionValue | undefined {
  let cursor = start
  let isAsync = false
  if (sig[cursor]?.token.text === 'async') {
    const following = sig[cursor + 1]
    if (following?.token.text === 'function' || following?.token.text === '(' || following?.token.kind === 'identifier') {
      isAsync = true
      cursor += 1
    } else {
      return undefined
    }
  }
  const value = sig[cursor]
  if (value === undefined) return undefined

  if (value.token.text === 'function') {
    let nameCursor = cursor + 1
    let generator = false
    if (sig[nameCursor]?.token.text === '*') {
      generator = true
      nameCursor += 1
    }
    if (sig[nameCursor]?.token.text !== '(') return undefined
    const paramsClose = findMatching(sig, nameCursor, '(', ')')
    if (paramsClose < 0) return undefined
    const bodyOpen = findFunctionBodyOpen(sig, paramsClose)
    if (bodyOpen < 0) return undefined
    const bodyClose = findMatching(sig, bodyOpen, '{', '}')
    return { end: bodyClose < 0 ? bodyOpen : bodyClose, async: isAsync, generator }
  }

  let arrowStart = -1
  if (value.token.text === '(') {
    const close = findMatching(sig, cursor, '(', ')')
    if (close < 0) return undefined
    for (let index = close + 1; index < Math.min(sig.length, close + 40); index += 1) {
      if (sig[index].token.text === '=' && sig[index + 1]?.token.text === '>') {
        arrowStart = index
        break
      }
      if (sig[index].token.text === ';') break
    }
  } else if (value.token.kind === 'identifier' &&
    sig[cursor + 1]?.token.text === '=' && sig[cursor + 2]?.token.text === '>') {
    arrowStart = cursor + 1
  }
  if (arrowStart < 0) return undefined
  const bodyStart = arrowStart + 2
  let endPosition = bodyStart
  if (sig[bodyStart]?.token.text === '{') {
    const close = findMatching(sig, bodyStart, '{', '}')
    endPosition = close < 0 ? bodyStart : close
  } else {
    endPosition = expressionEnd(sig, bodyStart, newline)
  }
  if (endPosition < bodyStart) endPosition = bodyStart
  return { end: endPosition, async: isAsync, generator: false }
}

/** End of an expression body: a top-level `;`, `,` or line break. */
function expressionEnd(sig: readonly SigToken[], from: number, newline: readonly boolean[]): number {
  let depth = 0
  const limit = Math.min(sig.length, from + 200)
  let last = from
  for (let position = from; position < limit; position += 1) {
    const value = sig[position].token.text
    if (value === '(' || value === '[' || value === '{') depth += 1
    else if (value === ')' || value === ']' || value === '}') {
      if (depth === 0) return Math.max(from, position - 1)
      depth -= 1
    }
    if (depth === 0 && (value === ';' || value === ',')) return Math.max(from, position - 1)
    if (depth === 0 && position > from && newline[position] === true) {
      const previous = sig[position - 1]?.token.text
      if (previous !== undefined && !CONTINUATION.has(previous) && !CONTINUATION.has(value)) {
        return Math.max(from, position - 1)
      }
    }
    last = position
  }
  return last
}

/**
 * Scan a function/method/static-block body for `const`/`let`/`var`
 * declarations. Nested function and class bodies are skipped, so a declaration
 * is only emitted when its enclosing context is exactly the supplied scope.
 */
function scanBodyVariables(
  ctx: ParseContext,
  sig: readonly SigToken[],
  open: number,
  close: number,
  scope: CodeScope,
  symbols: CodeSymbol[],
  newline: readonly boolean[],
  references: FileReference[],
): void {
  let position = open + 1
  while (position < close) {
    if ((position & 1_023) === 0 && !ctx.checkpoint()) return
    const value = sig[position].token.text
    if (value === 'function') {
      const skip = skipFunctionAt(sig, position)
      if (skip >= 0) {
        position = skip + 1
        continue
      }
    }
    if (value === 'class') {
      const skip = skipClassAt(sig, position)
      if (skip >= 0) {
        position = skip + 1
        continue
      }
    }
    if ((value === 'const' || value === 'let' || value === 'var') && isBodyDeclarationStart(sig, position, open)) {
      const next = handleDeclaration(ctx, sig, position, symbols, undefined, newline, scope, references)
      position = next > position ? next : position + 1
      continue
    }
    position += 1
  }
}

/** A declaration starts a statement inside a body (fail-closed for the rest). */
function isBodyDeclarationStart(sig: readonly SigToken[], position: number, open: number): boolean {
  if (position <= open + 1) return true
  const previousToken = sig[position - 1].token
  const previous = previousToken.text
  if (previous === '{' || previous === '}' || previous === ';') return true
  if (previous === '(') {
    const before = sig[position - 2]?.token.text
    if (before === 'for' || before === 'await') return true
  }
  return sig[position].token.span.line > previousToken.span.line && !CONTINUATION.has(previous)
}

/** Index of a nested function body's `}`, or -1 when this is not one. */
function skipFunctionAt(sig: readonly SigToken[], position: number): number {
  let cursor = position + 1
  if (sig[cursor]?.token.text === '*') cursor += 1
  if (sig[cursor]?.token.kind === 'identifier') cursor += 1
  if (sig[cursor]?.token.text !== '(') return -1
  const paramsClose = findMatching(sig, cursor, '(', ')')
  if (paramsClose < 0) return -1
  const bodyOpen = findFunctionBodyOpen(sig, paramsClose)
  if (bodyOpen < 0) return -1
  const bodyClose = findMatching(sig, bodyOpen, '{', '}')
  return bodyClose < 0 ? bodyOpen : bodyClose
}

/** Index of a nested class body's `}`, or -1 when this is not a class body. */
function skipClassAt(sig: readonly SigToken[], position: number): number {
  const next = sig[position + 1]
  if (next === undefined) return -1
  const disallowed = new Set([':', '(', '=', '}', ',', ';', '.', '?', '!'])
  if (disallowed.has(next.token.text)) return -1
  let cursor = position + 1
  if (sig[cursor]?.token.kind === 'identifier') cursor += 1
  const open = sig[cursor]?.token.text === '{' ? cursor : findClassBodyOpen(sig, cursor)
  if (open < 0) return -1
  const close = findMatching(sig, open, '{', '}')
  return close < 0 ? open : close
}

/** Scan method shorthand members inside a class body. */
function scanMethods(
  ctx: ParseContext,
  sig: readonly SigToken[],
  openBrace: number,
  closeBrace: number,
  ownerClass: string,
  symbols: CodeSymbol[],
  newline: readonly boolean[],
  references: FileReference[],
): void {
  let position = openBrace + 1
  let guard = 0
  while (position < closeBrace && guard < sig.length) {
    guard += 1
    if ((guard & 255) === 0 && !ctx.checkpoint()) return
    const member = parseMember(ctx, sig, position, closeBrace, newline)
    if (member === undefined) {
      position += 1
      continue
    }
    if (member.field !== undefined && member.isStatic) {
      const variable = newSymbol(
        'variable',
        member.field.name,
        member.field.span,
        sig[position].index,
        sig[member.field.tokenIndex].index,
        false,
        { static: true, scope: 'static' },
      )
      variable.ownerClass = ownerClass
      symbols.push(variable)
    }
    if (member.symbol !== undefined) {
      const symbol = member.symbol
      symbol.kind = 'method'
      symbol.binding = 'method'
      symbol.ownerClass = ownerClass
      symbol.exported = false
      symbol.static = member.isStatic
      symbol.async = member.isAsync
      symbol.generator = member.isGenerator
      // Instance members have no scope value in the shared vocabulary; omit
      // rather than mislabel them `local`.
      if (member.isStatic) symbol.scope = 'static'
      symbols.push(symbol)
      if (member.body !== undefined && member.body.close > member.body.open) {
        scanBodyVariables(ctx, sig, member.body.open, member.body.close, 'local', symbols, newline, references)
      }
    }
    if (member.block !== undefined && member.block.close > member.block.open) {
      scanBodyVariables(ctx, sig, member.block.open, member.block.close, 'static', symbols, newline, references)
    }
    position = member.end > position ? member.end : position + 1
  }
}

interface MemberField {
  name: string
  /** Binding span of the field name (no modifiers or initializer). */
  span: SourceSpan
  /** Significant-token index of the name. */
  tokenIndex: number
}

interface MemberParse {
  end: number
  isStatic: boolean
  isAsync: boolean
  isGenerator: boolean
  symbol?: CodeSymbol
  /** Method body range, when the member is a method with a body. */
  body?: { open: number; close: number }
  /** `static {}` block range. */
  block?: { open: number; close: number }
  /** Static field binding, when the member is a static field. */
  field?: MemberField
}

/**
 * Parse one class-body member. Returns the position after it, a method symbol
 * for shorthand methods, a binding for a static field, and the body range of a
 * method or `static {}` block so local/static variables can be scanned.
 * Non-static fields and arrow-function fields are not reported.
 */
function parseMember(
  ctx: ParseContext,
  sig: readonly SigToken[],
  from: number,
  limit: number,
  newline: readonly boolean[],
): MemberParse | undefined {
  let cursor = from
  let isStatic = false
  let isAsync = false
  let isGenerator = false
  let accessor: 'getter' | 'setter' | undefined

  if (sig[cursor]?.token.text === 'static' && sig[cursor + 1]?.token.text === '{') {
    const blockOpen = cursor + 1
    const close = findMatching(sig, blockOpen, '{', '}', limit)
    return {
      end: close < 0 ? limit : close + 1,
      isStatic: true,
      isAsync,
      isGenerator,
      block: { open: blockOpen, close: close < 0 ? limit : close },
    }
  }
  if (sig[cursor]?.token.text === '{') {
    const close = findMatching(sig, cursor, '{', '}', limit)
    return { end: close < 0 ? limit : close + 1, isStatic, isAsync, isGenerator }
  }
  if (sig[cursor]?.token.text === ';') {
    return { end: cursor + 1, isStatic, isAsync, isGenerator }
  }

  while (cursor < limit) {
    const value = sig[cursor].token.text
    const next = sig[cursor + 1]?.token.text
    if (MODIFIERS.has(value)) {
      cursor += 1
      continue
    }
    if (value === 'static' && next !== '(' && next !== '=' && next !== ';' && next !== ':' && next !== '?' && next !== '!') {
      isStatic = true
      cursor += 1
      continue
    }
    if (value === 'async' && next !== '(') {
      isAsync = true
      cursor += 1
      continue
    }
    if ((value === 'get' || value === 'set') && next !== '(') {
      accessor = value === 'get' ? 'getter' : 'setter'
      cursor += 1
      continue
    }
    break
  }
  if (cursor >= limit) return { end: limit, isStatic, isAsync, isGenerator }
  const start = from
  if (sig[cursor].token.text === '*') {
    isGenerator = true
    cursor += 1
  }
  const nameToken = sig[cursor]
  if (nameToken === undefined) return { end: limit, isStatic, isAsync, isGenerator }
  if (nameToken.token.text === '[') {
    return { end: skipMember(sig, from, limit, newline), isStatic, isAsync, isGenerator }
  }
  const nameStart = cursor
  let name: string
  let nameEnd = cursor + 1
  if (nameToken.token.text === '#') {
    const privateName = sig[cursor + 1]
    if (privateName === undefined || privateName.token.kind !== 'identifier') {
      return { end: skipMember(sig, from, limit, newline), isStatic, isAsync, isGenerator }
    }
    name = `#${privateName.token.text}`
    nameEnd = cursor + 2
  } else if (nameToken.token.kind === 'identifier' || nameToken.token.kind === 'keyword' ||
    nameToken.token.kind === 'string' || nameToken.token.kind === 'number') {
    name = nameToken.token.kind === 'string' ? stripQuotes(nameToken.token.text) : nameToken.token.text
  } else {
    return { end: skipMember(sig, from, limit, newline), isStatic, isAsync, isGenerator }
  }

  let afterName = nameEnd
  if (sig[afterName]?.token.text === '<') {
    const typeParameters = findMatching(sig, afterName, '<', '>', limit)
    if (typeParameters < 0) return { end: skipMember(sig, from, limit, newline), isStatic, isAsync, isGenerator }
    afterName = typeParameters + 1
  }
  if (sig[afterName]?.token.text === '?' || sig[afterName]?.token.text === '!') afterName += 1
  if (sig[afterName]?.token.text !== '(') {
    const end = skipMember(sig, from, limit, newline)
    if (isStatic) {
      return {
        end,
        isStatic,
        isAsync,
        isGenerator,
        field: {
          name,
          span: spanBetween(sig[nameStart].token, sig[nameEnd - 1].token),
          tokenIndex: nameStart,
        },
      }
    }
    return { end, isStatic, isAsync, isGenerator }
  }
  const paramsClose = findMatching(sig, afterName, '(', ')', limit)
  if (paramsClose < 0) {
    ctx.unverifiable('method parameter list is unterminated', nameToken.token.span)
    return { end: skipMember(sig, from, limit, newline), isStatic, isAsync, isGenerator }
  }
  let bodyOpen = -1
  let terminatedAt = -1
  const annotationLimit = Math.min(limit, paramsClose + 80)
  for (let index = paramsClose + 1; index < annotationLimit; index += 1) {
    const value = sig[index].token.text
    if (value === '{') {
      bodyOpen = index
      break
    }
    if (value === ';') {
      terminatedAt = index
      break
    }
    if (value === '=' || value === '}') break
  }
  if (bodyOpen < 0 && terminatedAt < 0) {
    return { end: skipMember(sig, from, limit, newline), isStatic, isAsync, isGenerator }
  }
  let endPosition = terminatedAt
  if (bodyOpen >= 0) {
    const close = findMatching(sig, bodyOpen, '{', '}', limit)
    if (close < 0) ctx.unverifiable('unterminated method body', sig[bodyOpen].token.span)
    endPosition = close < 0 ? bodyOpen : close
  }
  const span = spanBetween(sig[start].token, sig[endPosition].token)
  const symbol: CodeSymbol = newSymbol(
    'method',
    name,
    span,
    sig[start].index,
    sig[endPosition].index,
    false,
    { static: isStatic, async: isAsync, generator: isGenerator },
  )
  symbol.form = name === 'constructor' ? 'constructor' : accessor ?? 'method'
  return {
    end: endPosition + 1,
    isStatic,
    isAsync,
    isGenerator,
    symbol,
    ...(bodyOpen >= 0 ? { body: { open: bodyOpen, close: endPosition } } : {}),
  }
}

/** Skip a non-method member, stopping at `;` or the next line's member. */
function skipMember(
  sig: readonly SigToken[],
  from: number,
  limit: number,
  newline: readonly boolean[],
): number {
  let depth = 0
  for (let position = from; position < limit; position += 1) {
    const value = sig[position].token.text
    if (value === '(' || value === '[' || value === '{') depth += 1
    else if (value === ')' || value === ']' || value === '}') {
      if (depth === 0) return position
      depth -= 1
    }
    if (depth === 0) {
      if (value === ';') return position + 1
      if (position > from && newline[position] === true) return position
    }
  }
  return limit
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) return value.slice(1, -1)
  }
  return value
}

/* ------------------------------------------------------------------------- *
 * Comments, attachment, metadata
 * ------------------------------------------------------------------------- */

function commentStyle(text: string): CodeComment['style'] {
  if (text.startsWith('//')) return 'line'
  if (text.startsWith('/**') && !text.startsWith('/**/')) return 'doc'
  return 'block'
}

/** Strip comment delimiters and per-line `*` prefixes. Local only. */
function commentBody(text: string, style: CodeComment['style']): string {
  if (style === 'line') {
    const body = text.slice(2)
    return body.startsWith(' ') ? body.slice(1) : body
  }
  const inner = text.startsWith('/*') ? text.slice(2, text.endsWith('*/') ? -2 : undefined) : text
  return inner
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimStart()
      if (!trimmed.startsWith('*')) return line
      const rest = trimmed.slice(1)
      return rest.startsWith(' ') ? rest.slice(1) : rest
    })
    .join('\n')
    .trim()
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? ''
  return sanitizeMetadataText(line, MAX_BRIEF_LENGTH)
}

/**
 * Attach each comment to the nearest following symbol when nothing but
 * whitespace separates them; everything else stays `orphan`. The comment body is
 * parsed here into capped fields and then dropped.
 */
function attachComments(
  ctx: ParseContext,
  symbols: CodeSymbol[],
  comments: CodeComment[],
  bodies: ReadonlyMap<number, string>,
  tokens: readonly Token[],
): void {
  const byStart = new Map<number, CodeComment>()
  for (const comment of comments) byStart.set(comment.span.start, comment)
  for (const symbol of symbols) {
    let cursor = symbol.tokenStart - 1
    let attached: CodeComment | undefined
    while (cursor >= 0) {
      const token = tokens[cursor]
      if (token.kind === 'whitespace' || token.kind === 'newline') {
        cursor -= 1
        continue
      }
      if (token.kind !== 'comment') break
      attached = byStart.get(token.span.start)
      break
    }
    if (attached === undefined || attached.attachment !== 'orphan') continue
    const body = bodies.get(attached.span.start)
    const fields = parseDocFields(body)
    attached.attachment = 'leading'
    attached.target = symbol.name
    symbol.commentStyle = attached.style
    symbol.brief = fields.brief
    symbol.summary = fields.summary
    symbol.description = fields.description
    symbol.usage = fields.usage
    symbol.purpose = fields.purpose
    symbol.hasUsage = fields.hasUsage
    symbol.hasPurpose = fields.hasPurpose
    void ctx
  }
}

/** Parse explicit doc-comment metadata into capped fields; never infers. */
function parseDocFields(content: string | undefined): DocFields {
  if (content === undefined || content.length === 0) {
    return { hasUsage: false, hasPurpose: false }
  }
  const bodyLines: string[] = []
  let usage: string | undefined
  let purpose: string | undefined
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) {
      bodyLines.push('')
      continue
    }
    const atTag = /^@([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/.exec(line)
    if (atTag !== null && (atTag[1].toLowerCase() === 'usage' || atTag[1].toLowerCase() === 'purpose')) {
      const value = atTag[2].trim()
      if (atTag[1].toLowerCase() === 'usage' && usage === undefined && value.length > 0) usage = value
      if (atTag[1].toLowerCase() === 'purpose' && purpose === undefined && value.length > 0) purpose = value
      continue
    }
    const colonTag = /^(usage|purpose)\s*[:=]\s*(.*)$/i.exec(line)
    if (colonTag !== null) {
      const value = colonTag[2].trim()
      if (colonTag[1].toLowerCase() === 'usage' && usage === undefined && value.length > 0) usage = value
      if (colonTag[1].toLowerCase() === 'purpose' && purpose === undefined && value.length > 0) purpose = value
      continue
    }
    bodyLines.push(line)
  }
  const body = bodyLines.join('\n').replace(/\n{2,}/g, '\n').trim()
  const first = body.split('\n').find((line) => line.length > 0) ?? ''
  return {
    ...(first.length === 0 ? {} : { brief: sanitizeMetadataText(first, MAX_BRIEF_LENGTH) }),
    ...(first.length === 0 ? {} : { summary: sanitizeMetadataText(first, MAX_SUMMARY_LENGTH) }),
    ...(body.length === 0 ? {} : { description: sanitizeMetadataText(body, MAX_DESCRIPTION_LENGTH) }),
    ...(usage === undefined ? {} : { usage: sanitizeMetadataText(usage, MAX_USAGE_LENGTH) }),
    ...(purpose === undefined ? {} : { purpose: sanitizeMetadataText(purpose, MAX_PURPOSE_LENGTH) }),
    hasUsage: usage !== undefined,
    hasPurpose: purpose !== undefined,
  }
}

/**
 * Extract explicit contract-tag Condition nodes from doc/line comments.
 *
 * Each `@requires`/`@ensures`/`@pre`/`@post`/`@invariant` occurrence becomes one
 * `condition` node with a form and `status='unknown'`; the tag text (if any)
 * is only the capped `brief`, never the condition expression body. A comment
 * attached to a symbol records that symbol name in `domain.appliesTo`.
 */
function buildContractConditions(ctx: ParseContext, comments: readonly CodeComment[]): NodeMetadata[] {
  const nodes: NodeMetadata[] = []
  let count = 0
  for (const comment of comments) {
    if (count >= MAX_CONTRACT_CONDITIONS) break
    const raw = ctx.text.slice(comment.span.start, comment.span.end)
    let cursor = 0
    while (cursor <= raw.length) {
      if (count >= MAX_CONTRACT_CONDITIONS) break
      const newline = raw.indexOf('\n', cursor)
      const lineEnd = newline < 0 ? raw.length : newline
      const line = raw.slice(cursor, lineEnd).replace(/\r$/, '')
      const lineStart = comment.span.start + cursor
      const match = /@(requires|ensures|pre|post|invariant)\b[ \t]*(.*)$/i.exec(line)
      if (match !== null) {
        const tag = match[1].toLowerCase()
        const mapping = CONTRACT_TAGS[tag]
        if (mapping !== undefined) {
          count += 1
          const atIndex = line.indexOf(`@${match[1]}`)
          const start = lineStart + (atIndex < 0 ? 0 : atIndex)
          const span: SourceSpan = {
            start,
            end: lineStart + line.length,
            line: 1,
            column: 1,
          }
          const mappedLine = ctx.sourceMap.lineAt(start)
          if (mappedLine !== undefined) {
            span.line = mappedLine
            const column = ctx.sourceMap.columnAt(start)
            if (column !== undefined) span.column = column
          }
          const ordinal = count
          const locator = structuralLocator(ctx.path, 'condition', ordinal, 'module')
          const value = match[2].replace(/\*\/\s*$/, '').trim()
          const concept: StructuralConcept = {
            kind: 'condition',
            locator,
            ordinal,
            form: mapping.form,
            status: 'unknown',
            explicit: true,
            ...(mapping.relation === undefined ? {} : { relation: mapping.relation }),
            ...(comment.target === undefined ? {} : { appliesTo: comment.target }),
          }
          let reference: NodeReference | undefined
          try {
            reference = referenceForSpan(ctx, {
              scheme: 'symbol',
              target: `${ctx.path ?? 'text'}#condition:${ordinal}`,
              span,
              parserId: 'javascript',
            })
          } catch {
            reference = undefined
          }
          const node = pushNodeMetadata(ctx, nodes, {
            kind: 'condition',
            locator,
            ...(value.length === 0 ? {} : { brief: value }),
            ...(reference === undefined ? {} : { reference }),
            fragment: fragmentForSpan(ctx, span),
            source: 'comment',
            span,
          })
          if (node !== undefined) node.domain = concept
        }
      }
      if (newline < 0) break
      cursor = lineEnd + 1
    }
  }
  if (count >= MAX_CONTRACT_CONDITIONS) {
    ctx.unverifiableOnce(
      'contract-condition-cap',
      `contract-tag condition limit ${MAX_CONTRACT_CONDITIONS} reached; later tags were dropped`,
    )
  }
  return nodes
}

/** Build one metadata record per symbol, plus aggregate `unverifiable` notes. */
/**
 * Project static import/export references as first-class domain nodes.
 *
 * The `depends` edge already exists from the same references; the node is what
 * makes "which module does this file import" answerable from the graph without
 * reading the AST. `require()` and dynamic `import()` count as importations too
 * (their specifiers are literal, otherwise no reference exists).
 */
function buildReferenceNodes(ctx: ParseContext, references: readonly FileReference[]): NodeMetadata[] {
  const nodes: NodeMetadata[] = []
  for (const reference of references) {
    const kind = reference.kind === 'export-from' ? 'exportation' : 'importation'
    try {
      const fragment = fragmentForSpan(ctx, reference.span)
      nodes.push({
        kind,
        name: sanitizeMetadataText(reference.specifier, MAX_NAME_LENGTH),
        span: reference.span,
        ...fragment,
        ...(reference.names === undefined || reference.names.length === 0
          ? {}
          : { label: sanitizeMetadataText(reference.names.join(', '), MAX_NAME_LENGTH) }),
      })
    } catch {
      // A specifier outside the parsed fragments keeps its AST node and its
      // dependency edge; it simply has no graph node.
    }
  }
  return nodes
}

function buildMetadata(ctx: ParseContext, symbols: CodeSymbol[]): NodeMetadata[] {
  const metadata: NodeMetadata[] = []
  let missingBrief = 0
  let missingUsage = 0
  let firstSpan: SourceSpan | undefined
  for (const symbol of symbols) {
    const fragment = fragmentForSpan(ctx, symbol.span)
    Object.assign(symbol, fragment)
    const target = `${symbol.kind}:${symbol.name}`
    let reference: NodeReference | undefined
    try {
      reference = referenceForSpan(ctx, {
        scheme: 'symbol',
        target,
        span: symbol.span,
        parserId: 'javascript',
      })
      symbol.reference = reference
    } catch {
      // A reference is optional when no workspace path exists; parsing continues.
    }
    const name = sanitizeMetadataText(symbol.name, MAX_NAME_LENGTH)
    if (symbol.brief === undefined) {
      missingBrief += 1
      firstSpan ??= symbol.span
    }
    if (symbol.usage === undefined || symbol.purpose === undefined) {
      missingUsage += 1
      firstSpan ??= symbol.span
    }
    pushNodeMetadata(ctx, metadata, {
      kind: symbol.kind,
      ...(name.length === 0 ? {} : { name }),
      summary: symbol.summary,
      description: symbol.description,
      usage: symbol.usage,
      purpose: symbol.purpose,
      brief: symbol.brief,
      ...(symbol.binding === undefined ? {} : { binding: symbol.binding }),
      ...(symbol.scope === undefined ? {} : { scope: symbol.scope }),
      locator: `javascript:${symbol.kind}:${symbol.name}#${symbol.span.start}`,
      ...(reference === undefined ? {} : { reference }),
      fragment,
      source: symbol.brief === undefined ? 'none' : 'comment',
      span: symbol.span,
    })
  }
  if (missingBrief > 0) {
    ctx.unverifiable(
      `metadata brief missing on ${missingBrief} symbol(s); left empty (explicit doc-comment line only)`,
      firstSpan,
    )
  }
  if (missingUsage > 0) {
    ctx.unverifiable(
      `metadata usage/purpose missing on ${missingUsage} symbol(s); left empty (explicit annotations only)`,
      firstSpan,
    )
  }
  return metadata
}
