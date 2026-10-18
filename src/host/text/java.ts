/**
 * Java parser: package, imports, type declarations, methods, constructors and
 * fields.
 *
 * Deliberately lexical, like the JavaScript parser: one bounded token scan, then
 * one structural pass over the significant tokens. There is no full AST, no
 * annotation interpretation and no dependency on the filesystem or on another
 * language parser.
 *
 * What is extracted:
 *
 *  - `package com.example.app;`            -> one `module` node;
 *  - `import a.b.C;` / `import static ...` -> a `FileReference` plus one
 *    `importation` node each, so the dependency layer can build `depends`
 *    edges from the same reference shape the JavaScript parser emits;
 *  - `class`, `interface`, `enum`, `record` and `@interface` declarations
 *    (including nested types) -> one `class` node each;
 *  - methods and constructors (including abstract/interface methods and
 *    compact record constructors) -> one `method` node each, with a
 *    declaration-signature span (modifiers/annotations through the body `{` or
 *    the terminating `;`);
 *  - field/constant declarations -> one `variable` node per declarator.
 *
 * Kind mapping (checked against `NodeKind` in `src/host/node-registry.ts`):
 *
 * | Java construct                    | `NodeMetadata.kind` | note |
 * |-----------------------------------|---------------------|------|
 * | `package`                         | `module`            | existing kind |
 * | `import` / `import static`        | `importation`       | existing kind |
 * | `class`                           | `class`             | exact |
 * | `interface` / `enum` / `record`   | `class`             | no dedicated NodeKind exists; `class` is the closest declaration kind |
 * | `@interface`                      | `class`             | same mapping as `interface` |
 * | method / constructor              | `method`            | exact |
 * | field / constant                  | `variable`          | existing kind; `label: 'constant'` only for an explicit `static final` |
 *
 * Deliberate limits (reported as diagnostics, never guessed):
 *
 *  - method/constructor/initializer bodies are skipped, never parsed, so nested
 *    local classes inside a body are not reported;
 *  - enum constants are skipped without nodes (they are not fields and carry
 *    no explicit type), and a type's record components are not fields;
 *  - annotations produce no nodes; they are skipped so their arguments cannot
 *    break scanning;
 *  - comments produce no nodes at all, so no comment body can leak into the
 *    result;
 *  - malformed input yields `parse-error`/`unverifiable` diagnostics and an
 *    incomplete result; `parse` never throws for malformed text.
 *
 * Complexity: token scan O(n); structural scan O(tokens) with each type/method
 * body skipped once; metadata O(nodes). Every loop is bounded by the shared
 * token cap, text cap, type-nesting depth cap and parse deadline.
 */
import { AstTree } from '../../shared/ast.js'
import type { AstNode, SourceSpan } from '../../shared/ast.js'
import {
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
  NodeMetadata,
  NodeReference,
  ParseOptions,
  ParseResult,
  Parser,
} from './parser.js'

/** Parser id used in results and natural locators. */
const PARSER_ID = 'java'
/** Extensions claimed by this parser (not registered here: the integrator does that). */
const JAVA_EXTENSIONS: readonly string[] = ['.java']

/** Java tokens significant to this parser; whitespace and comments are dropped. */
type JavaTokenKind = 'word' | 'number' | 'string' | 'char' | 'punctuation'

interface JavaToken {
  kind: JavaTokenKind
  text: string
  span: SourceSpan
}

/** Mutable state shared by the structural scan. */
interface JavaParseState {
  ctx: ParseContext
  tokens: readonly JavaToken[]
  /** For each `{` token, the index of its matching `}` (and the reverse); -1 when unmatched. */
  braceMatches: Int32Array
  nodes: NodeMetadata[]
  references: FileReference[]
  root: AstNode<string>
  packageName?: string
}

/** Java form of a type declaration, kept only for diagnostics and mapping. */
type JavaTypeForm = 'class' | 'interface' | 'enum' | 'record' | '@interface'

interface TypeDeclaration {
  /** Token index of the type keyword (`interface` for `@interface`). */
  keyword: number
  /** Token index of the declared name. */
  name: number
  form: JavaTypeForm
}

interface MemberPrefix {
  next: number
  modifiers: ReadonlySet<string>
}

interface MethodHeader {
  nameToken: JavaToken
  /** Token index where the declaration signature ends (`{` or `;`). */
  signatureEnd: number
  bodyOpen: number
  bodyClose: number
  next: number
}

interface EmitNodeOptions {
  kind: string
  name: string
  span: SourceSpan
  /** Natural-locator namespace; defaults to `kind`. */
  locatorKind?: string
  /** Reference target; defaults to `locatorKind:name`. */
  target?: string
  /** Explicit label only (currently `constant`). */
  label?: string
  /** `module` for the package node, `symbol` for everything else. */
  scheme?: 'symbol' | 'module'
  /** Importation nodes carry no nested reference today. */
  withReference?: boolean
}

/** Result of parsing one Java source file. */
export interface JavaParseResult extends ParseResult {
  /** Explicit package name, only when the file has a `package` clause. */
  packageName?: string
}

/** Modifiers recognised before a type or member declaration. */
const MEMBER_MODIFIERS: ReadonlySet<string> = new Set([
  'public',
  'protected',
  'private',
  'abstract',
  'static',
  'final',
  'strictfp',
  'sealed',
  'transient',
  'volatile',
  'native',
  'synchronized',
  'default',
])

/** Keywords that terminate recovery inside a package/import name. */
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  'package',
  'import',
  'class',
  'interface',
  'enum',
  'public',
  'protected',
  'private',
  'abstract',
  'static',
  'final',
  'strictfp',
  'sealed',
  'transient',
  'volatile',
  'native',
  'synchronized',
])

/**
 * Package roots that are platform libraries rather than workspace dependencies.
 * Java imports are fully-qualified names and never path-shaped, so the shared
 * `classifySpecifier` would call every import external. Marking the JDK roots
 * external keeps `java.*`/`javax.*` out of the dependency graph while leaving
 * project imports (`com.example...`) resolvable by the dependency layer.
 */
const JAVA_PLATFORM_PREFIXES: readonly string[] = [
  'java.',
  'javax.',
  'jdk.',
  'sun.',
  'com.sun.',
  'org.w3c.',
  'org.xml.',
  'org.ietf.',
  'org.omg.',
]

/**
 * Parse Java source.
 *
 * Time O(n) in the source length, space O(tokens + nodes). Malformed input never
 * throws; only an already-aborted `options.signal` propagates, per the parser
 * contract.
 */
export function parseJava(text: string, options: ParseOptions = {}): JavaParseResult {
  const ctx = new ParseContext(text, options)
  const tokens = scanJava(ctx)
  const root = createAstRoot('module', ctx.text.length)
  const state: JavaParseState = {
    ctx,
    tokens,
    // One linear pass over the token array makes every body-boundary lookup
    // O(1), so deeply nested types cannot cause repeated body scans.
    braceMatches: buildBraceMatches(tokens),
    nodes: [],
    references: [],
    root,
  }

  let position = 0
  while (position < tokens.length) {
    if ((position & 255) === 0 && !ctx.checkpoint()) break
    const token = tokens[position]
    if (token.text === ';') {
      position += 1
      continue
    }
    if (token.text === 'package') {
      position = handlePackage(state, position)
      continue
    }
    if (token.text === 'import') {
      position = handleImport(state, position)
      continue
    }
    // A declaration may start with annotations/modifiers, so read that prefix
    // first and inspect the token after it. Advancing past a consumed prefix
    // keeps pathological modifier runs linear.
    const prefix = readMemberPrefix(tokens, position, tokens.length)
    const declaration = typeDeclarationAt(tokens, prefix.next)
    if (declaration !== undefined) {
      position = scanType(state, declaration, position, 0)
      continue
    }
    position = prefix.next > position ? prefix.next : position + 1
  }

  const base = ctx.finalize({
    parserId: PARSER_ID,
    references: state.references,
    tokens: ctx.tokens,
    ast: new AstTree(state.root),
    nodes: state.nodes,
  })
  const result: JavaParseResult = { ...base }
  if (state.packageName !== undefined) result.packageName = state.packageName
  return result
}

/** `Parser` implementation; registration is intentionally left to the integrator. */
export class JavaParser implements Parser {
  readonly id = PARSER_ID
  readonly extensions: readonly string[] = JAVA_EXTENSIONS

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parseJava(text, options)
  }
}

/** Shared singleton for the future registry (`./index.ts`). */
export const javaParser = new JavaParser()

/* ------------------------------------------------------------------------- *
 * Tokenizer
 * ------------------------------------------------------------------------- */

/**
 * Scan Java source into a flat token array.
 *
 * Comments are counted as tokens for budgeting but are not stored: they can
 * never contribute a node or a body. Unterminated strings, text blocks, char
 * literals and block comments are diagnosed and the scan continues at the next
 * line/token, so malformed input cannot throw.
 */
function scanJava(ctx: ParseContext): JavaToken[] {
  const text = ctx.text
  const length = text.length
  const tokens: JavaToken[] = []
  let index = 0
  let line = 1
  let column = 1
  let scanned = 0

  const push = (kind: JavaTokenKind, start: number, startLine: number, startColumn: number): void => {
    tokens.push({
      kind,
      text: text.slice(start, index),
      span: { start, end: index, line: startLine, column: startColumn },
    })
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
      continue
    }
    if (code === 13) {
      index += 1
      if (text.charCodeAt(index) === 10) index += 1
      line += 1
      column = 1
      continue
    }
    if (code === 32 || code === 9 || code === 12 || code === 0xfeff) {
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

    const start = index
    const startLine = line
    const startColumn = column

    // String literal or text block.
    if (code === 34) {
      index += 1
      column += 1
      if (text.charCodeAt(index) === 34 && text.charCodeAt(index + 1) === 34) {
        index += 2
        column += 2
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
          if (
            current === 34 &&
            text.charCodeAt(index + 1) === 34 &&
            text.charCodeAt(index + 2) === 34
          ) {
            index += 3
            column += 3
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
          ctx.parseError('unterminated text block', {
            start,
            end: length,
            line: startLine,
            column: startColumn,
          })
        }
        push('string', start, startLine, startColumn)
        scanned += 1
        continue
      }

      let closed = false
      while (index < length) {
        const current = text.charCodeAt(index)
        if (current === 92) {
          index += 1
          column += 1
          if (index < length) {
            const escaped = text.charCodeAt(index)
            if (escaped === 10 || escaped === 13) {
              if (escaped === 13 && text.charCodeAt(index + 1) === 10) index += 1
              index += 1
              line += 1
              column = 1
            } else {
              index += 1
              column += 1
            }
          }
          continue
        }
        if (current === 34) {
          index += 1
          column += 1
          closed = true
          break
        }
        // An unescaped line break cannot appear in a Java string literal.
        if (current === 10 || current === 13) break
        index += 1
        column += 1
      }
      if (!closed) {
        ctx.parseError('unterminated string literal', {
          start,
          end: index,
          line: startLine,
          column: startColumn,
        })
      }
      push('string', start, startLine, startColumn)
      scanned += 1
      continue
    }

    // Character literal.
    if (code === 39) {
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
            if (escaped === 10 || escaped === 13) {
              if (escaped === 13 && text.charCodeAt(index + 1) === 10) index += 1
              index += 1
              line += 1
              column = 1
            } else {
              index += 1
              column += 1
            }
          }
          continue
        }
        if (current === 39) {
          index += 1
          column += 1
          closed = true
          break
        }
        if (current === 10 || current === 13) break
        index += 1
        column += 1
      }
      if (!closed) {
        ctx.parseError('unterminated character literal', {
          start,
          end: index,
          line: startLine,
          column: startColumn,
        })
      }
      push('char', start, startLine, startColumn)
      scanned += 1
      continue
    }

    // Numeric literal: deliberately permissive; structural parsing only needs
    // the token boundary, not the value.
    if (isAsciiDigit(code) || (code === 46 && isAsciiDigit(text.charCodeAt(index + 1)))) {
      index += 1
      column += 1
      let previous = code
      while (index < length) {
        const current = text.charCodeAt(index)
        if (isAsciiDigit(current) || isAsciiLetter(current) || current === 95 || current === 46) {
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

    // Identifier or keyword. Java identifiers may contain non-ASCII letters;
    // treating every code unit >= 128 as a word part keeps the scan linear and
    // accepts Unicode identifiers without a Unicode table.
    if (isWordStartCode(code)) {
      index += 1
      column += 1
      while (index < length && isWordPartCode(text.charCodeAt(index))) {
        index += 1
        column += 1
      }
      push('word', start, startLine, startColumn)
      scanned += 1
      continue
    }

    // Punctuation/operator: one code unit. Splitting `>>`, `::`, `...` and `->`
    // is enough for structural matching; it never changes a declaration name.
    index += 1
    column += 1
    push('punctuation', start, startLine, startColumn)
    scanned += 1
  }

  ctx.tokens = scanned
  return tokens
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isWordStartCode(code: number): boolean {
  return code === 95 || code === 36 || isAsciiLetter(code) || code >= 128
}

function isWordPartCode(code: number): boolean {
  return isWordStartCode(code) || isAsciiDigit(code)
}

function isWordToken(token: JavaToken | undefined): token is JavaToken {
  return token !== undefined && token.kind === 'word'
}

/* ------------------------------------------------------------------------- *
 * Package and imports
 * ------------------------------------------------------------------------- */

function handlePackage(state: JavaParseState, position: number): number {
  const { ctx, tokens } = state
  const startToken = tokens[position]
  let cursor = position + 1
  const segments: string[] = []
  let endToken = startToken
  let terminated = false

  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token.text === ';') {
      endToken = token
      cursor += 1
      terminated = true
      break
    }
    if (token.kind === 'word') {
      // Missing `;`: recover at the next declaration keyword instead of eating
      // the rest of the file into the package name.
      if (DECLARATION_KEYWORDS.has(token.text)) break
      segments.push(token.text)
      endToken = token
      cursor += 1
      continue
    }
    if (token.text === '.') {
      cursor += 1
      continue
    }
    break
  }

  if (segments.length === 0) {
    ctx.unverifiable('package clause has no name', startToken.span)
    return cursor
  }
  if (!terminated) ctx.unverifiable('package clause is not terminated by ";"', startToken.span)

  const name = segments.join('.')
  state.packageName = name
  const span: SourceSpan = {
    start: startToken.span.start,
    end: endToken.span.end,
    line: startToken.span.line,
    column: startToken.span.column,
  }
  emitNode(state, {
    kind: 'module',
    name,
    span,
    locatorKind: 'module',
    target: name,
    scheme: 'module',
  })
  return cursor
}

function handleImport(state: JavaParseState, position: number): number {
  const { ctx, tokens } = state
  const importToken = tokens[position]
  let cursor = position + 1
  let isStatic = false
  if (tokens[cursor]?.text === 'static') {
    isStatic = true
    cursor += 1
  }

  const nameTokens: JavaToken[] = []
  let terminated = false
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token.text === ';') {
      cursor += 1
      terminated = true
      break
    }
    if (token.kind === 'word' || token.text === '.' || token.text === '*') {
      if (nameTokens.length > 0 && DECLARATION_KEYWORDS.has(token.text)) break
      nameTokens.push(token)
      cursor += 1
      continue
    }
    break
  }

  if (nameTokens.length === 0) {
    ctx.unverifiable('import declaration has no name', importToken.span)
    return cursor
  }
  if (!terminated) ctx.unverifiable('import declaration is not terminated by ";"', importToken.span)

  const specifier = nameTokens.map((token) => token.text).join('')
  const first = nameTokens[0]
  const last = nameTokens[nameTokens.length - 1]
  const span: SourceSpan = {
    start: first.span.start,
    end: last.span.end,
    line: first.span.line,
    column: first.span.column,
  }
  const fragment = fragmentForSpan(ctx, span)
  const segments = specifier.split('.')
  const importedName = segments[segments.length - 1] ?? specifier
  const names: readonly string[] = [importedName.length === 0 ? '*' : importedName]
  const reference: FileReference = {
    kind: 'import',
    specifier,
    external: isExternalJavaImport(specifier),
    span,
    names,
    ...(isStatic ? { attributes: { static: 'true' } } : {}),
    ...fragment,
  }
  state.references.push(reference)

  const name = sanitizeMetadataText(specifier, MAX_NAME_LENGTH)
  if (name.length > 0) {
    const metadata = pushNodeMetadata(ctx, state.nodes, {
      kind: 'importation',
      name,
      label: names.join(', '),
      fragment,
      source: 'none',
      span,
    })
    if (metadata !== undefined) appendAstNode(ctx, state.root, 'importation', span, name)
  }
  return cursor
}

/** True when a fully-qualified import belongs to a JDK/platform namespace. */
function isExternalJavaImport(specifier: string): boolean {
  const value = specifier.toLowerCase()
  return JAVA_PLATFORM_PREFIXES.some(
    (prefix) => value === prefix.slice(0, -1) || value.startsWith(prefix),
  )
}

/* ------------------------------------------------------------------------- *
 * Type declarations
 * ------------------------------------------------------------------------- */

/**
 * Identify a type declaration at `position`.
 *
 * `record` is a contextual identifier (it can be a field/method name), so it is
 * accepted only when the following token proves a record header. `@interface`
 * is reported at the `@` token; the plain `interface` branch deliberately does
 * not re-recognise it.
 */
function typeDeclarationAt(
  tokens: readonly JavaToken[],
  position: number,
): TypeDeclaration | undefined {
  const token = tokens[position]
  if (token === undefined) return undefined

  if (token.text === '@' && tokens[position + 1]?.text === 'interface') {
    if (!isWordToken(tokens[position + 2])) return undefined
    return { keyword: position + 1, name: position + 2, form: '@interface' }
  }
  if (token.kind !== 'word') return undefined

  if (token.text === 'class' || token.text === 'interface' || token.text === 'enum') {
    const previous = tokens[position - 1]?.text
    if (previous === '.' || previous === '::' || previous === '@') return undefined
    if (!isWordToken(tokens[position + 1])) return undefined
    return {
      keyword: position,
      name: position + 1,
      form: token.text as JavaTypeForm,
    }
  }

  if (token.text === 'record') {
    const previous = tokens[position - 1]?.text
    if (previous === '.' || previous === '::') return undefined
    if (!isWordToken(tokens[position + 1])) return undefined
    const after = tokens[position + 2]?.text
    if (after !== '(' && after !== '{' && after !== '<' && after !== 'implements' && after !== 'permits') {
      return undefined
    }
    return { keyword: position, name: position + 1, form: 'record' }
  }

  return undefined
}

/** Scan one type declaration and its members; returns the position after it. */
function scanType(
  state: JavaParseState,
  declaration: TypeDeclaration,
  startPosition: number,
  depth: number,
): number {
  const { ctx, tokens } = state
  if (!ctx.checkpoint()) return tokens.length

  if (depth > ctx.maxDepth) {
    ctx.limit(
      'depth-limit',
      `type nesting depth limit ${ctx.maxDepth} reached; inner type bodies were skipped`,
      tokens[startPosition]?.span,
    )
    const open = findTypeBodyOpen(tokens, declaration.name + 1, tokens.length)
    if (open < 0) return tokens.length
    const close = braceClose(state, open)
    return close < 0 ? tokens.length : close + 1
  }

  const nameToken = tokens[declaration.name]
  if (nameToken === undefined) return tokens.length
  const name = nameToken.text

  const open = findTypeBodyOpen(tokens, declaration.name + 1, tokens.length)
  const close = open < 0 ? -1 : braceClose(state, open)
  const startToken = tokens[startPosition] ?? nameToken
  const span: SourceSpan = {
    start: startToken.span.start,
    // A type declaration's signature ends where the body begins. The body is
    // never part of the emitted span or metadata.
    end: open >= 0 ? tokens[open].span.start : nameToken.span.end,
    line: startToken.span.line,
    column: startToken.span.column,
  }

  emitNode(state, {
    kind: 'class',
    name,
    span,
    locatorKind: 'class',
    target: `${PARSER_ID}:class:${name}`,
  })

  if (open < 0) {
    ctx.unverifiable(`type declaration "${name}" has no body`, startToken.span)
    return declaration.name + 1
  }
  if (close < 0) {
    ctx.unverifiable(`unterminated ${declaration.form} body for "${name}"`, tokens[open].span)
  }

  const bodyEnd = close < 0 ? tokens.length : close
  scanMembers(state, open, bodyEnd, name, depth + 1, declaration.form === 'enum')
  return close < 0 ? tokens.length : close + 1
}

/** Skip an annotation starting at `@`, including its parenthesised arguments. */
function skipAnnotation(
  tokens: readonly JavaToken[],
  position: number,
  limit: number,
): number {
  if (tokens[position]?.text !== '@') return position
  let cursor = position + 1
  if (!isWordToken(tokens[cursor])) return position + 1
  cursor += 1
  while (cursor + 1 < limit && tokens[cursor].text === '.' && isWordToken(tokens[cursor + 1])) {
    cursor += 2
  }
  if (cursor < limit && tokens[cursor].text === '(') {
    const close = findMatching(tokens, cursor, '(', ')', limit)
    cursor = close < 0 ? limit : close + 1
  }
  return cursor
}

/** Read annotations/modifiers at the start of a type or member declaration. */
function readMemberPrefix(
  tokens: readonly JavaToken[],
  from: number,
  limit: number,
): MemberPrefix {
  const modifiers = new Set<string>()
  let cursor = from
  let steps = 0
  while (cursor < limit && steps < 256) {
    steps += 1
    const token = tokens[cursor]
    if (token === undefined) break
    if (token.text === '@') {
      // `@interface` is a type declaration, not an annotation on the next one.
      if (tokens[cursor + 1]?.text === 'interface') break
      const next = skipAnnotation(tokens, cursor, limit)
      if (next <= cursor) break
      cursor = next
      continue
    }
    if (
      token.text === 'non' &&
      tokens[cursor + 1]?.text === '-' &&
      tokens[cursor + 2]?.text === 'sealed'
    ) {
      modifiers.add('non-sealed')
      cursor += 3
      continue
    }
    if (MEMBER_MODIFIERS.has(token.text)) {
      modifiers.add(token.text)
      cursor += 1
      continue
    }
    break
  }
  return { next: cursor, modifiers }
}

/** Find the `{` opening a type body, skipping generics, parameters and arrays. */
function findTypeBodyOpen(
  tokens: readonly JavaToken[],
  from: number,
  limit: number,
): number {
  let parens = 0
  let brackets = 0
  let angles = 0
  const stop = Math.min(limit, tokens.length)
  for (let position = from; position < stop; position += 1) {
    const value = tokens[position].text
    if (value === '(') parens += 1
    else if (value === ')') parens = Math.max(0, parens - 1)
    else if (value === '[') brackets += 1
    else if (value === ']') brackets = Math.max(0, brackets - 1)
    else if (value === '<') angles += 1
    else if (value === '>') angles = Math.max(0, angles - 1)
    else if (value === '{' && parens === 0 && brackets === 0 && angles === 0) return position
    else if ((value === ';' || value === '}') && parens === 0 && brackets === 0 && angles === 0) {
      return -1
    }
  }
  return -1
}

/**
 * Build the brace-match table in one pass: each `{` maps to its matching `}`
 * (and vice versa); unmatched braces stay -1. Time/space O(tokens).
 */
function buildBraceMatches(tokens: readonly JavaToken[]): Int32Array {
  const matches = new Int32Array(tokens.length)
  matches.fill(-1)
  const stack: number[] = []
  for (let position = 0; position < tokens.length; position += 1) {
    const value = tokens[position].text
    if (value === '{') {
      stack.push(position)
    } else if (value === '}') {
      const open = stack.pop()
      if (open !== undefined) {
        matches[open] = position
        matches[position] = open
      }
    }
  }
  return matches
}

/** Matching `}` for an open `{`, or -1. O(1). */
function braceClose(state: JavaParseState, open: number): number {
  if (open < 0 || open >= state.braceMatches.length) return -1
  return state.braceMatches[open]
}

/**
 * Index of the matching close token, or -1. Only one brace kind is tracked per
 * call; callers pass the pair they need. Time O(distance). Braces use the
 * precomputed `braceMatches` table instead.
 */
function findMatching(
  tokens: readonly JavaToken[],
  open: number,
  openText: string,
  closeText: string,
  limit = tokens.length,
): number {
  let depth = 0
  const stop = Math.min(limit, tokens.length)
  for (let position = open; position < stop; position += 1) {
    const value = tokens[position].text
    if (value === openText) depth += 1
    else if (value === closeText) {
      depth -= 1
      if (depth === 0) return position
    }
  }
  return -1
}

/* ------------------------------------------------------------------------- *
 * Members: methods, constructors, fields, nested types
 * ------------------------------------------------------------------------- */

function scanMembers(
  state: JavaParseState,
  open: number,
  close: number,
  ownerName: string,
  depth: number,
  isEnum: boolean,
): void {
  const { ctx, tokens } = state
  let position = open + 1

  // Enum constants are not fields and may contain constructor arguments and
  // class bodies. Skip the whole constant list up to the first top-level `;`.
  if (isEnum) {
    const semicolon = findEnumConstantsEnd(tokens, position, close)
    if (semicolon < 0) return
    position = semicolon + 1
  }

  while (position < close) {
    if ((position & 255) === 0 && !ctx.checkpoint()) return
    const token = tokens[position]
    if (token === undefined) return
    if (token.text === ';' || token.text === ',') {
      position += 1
      continue
    }
    if (token.text === '}') {
      position += 1
      continue
    }

    const memberStart = position
    const prefix = readMemberPrefix(tokens, position, close)
    if (prefix.next >= close) return
    const first = tokens[prefix.next]
    if (first === undefined) return

    // Initializer block: `{ ... }` or, with the `static` modifier already read,
    // `static { ... }`. Its body is skipped, never scanned for members.
    if (first.text === '{') {
      const end = braceClose(state, prefix.next)
      position = end >= 0 && end < close ? end + 1 : close
      continue
    }

    // Nested type declaration.
    const declaration = typeDeclarationAt(tokens, prefix.next)
    if (declaration !== undefined) {
      const next = scanType(state, declaration, memberStart, depth)
      position = next > memberStart ? next : memberStart + 1
      continue
    }

    // Compact record constructor: `public Point { ... }` has no parameter list.
    if (isWordToken(first) && tokens[prefix.next + 1]?.text === '{') {
      const bodyOpen = prefix.next + 1
      const bodyClose = braceClose(state, bodyOpen)
      if (bodyClose < 0 || bodyClose >= close) {
        ctx.unverifiable('unterminated compact constructor body', tokens[bodyOpen].span)
      }
      emitNode(state, {
        kind: 'method',
        name: first.text,
        span: signatureSpan(tokens, memberStart, bodyOpen),
        locatorKind: 'method',
        target: `${PARSER_ID}:method:${ownerName}.${first.text}`,
      })
      position = bodyClose >= 0 && bodyClose < close ? bodyClose + 1 : close
      continue
    }

    const method = parseMethodHeader(state, prefix.next, close)
    if (method !== undefined) {
      emitNode(state, {
        kind: 'method',
        name: method.nameToken.text,
        span: signatureSpan(tokens, memberStart, method.signatureEnd),
        locatorKind: 'method',
        target: `${PARSER_ID}:method:${ownerName}.${method.nameToken.text}`,
      })
      position = method.next > memberStart ? method.next : memberStart + 1
      continue
    }

    // Field / constant declaration.
    const semicolon = findMemberEnd(tokens, prefix.next, close)
    if (semicolon < 0) {
      ctx.unverifiable('class member could not be parsed', tokens[memberStart].span)
      position = close > memberStart ? close : memberStart + 1
      continue
    }
    emitFields(state, memberStart, prefix.next, semicolon, prefix.modifiers, ownerName)
    position = semicolon + 1
  }
}

/** True when the method header's parameter list ends before any `=`, `;`, `{`. */
function parseMethodHeader(
  state: JavaParseState,
  from: number,
  close: number,
): MethodHeader | undefined {
  const { ctx, tokens } = state
  let paramsOpen = -1
  let angles = 0
  let brackets = 0

  for (let position = from; position < close; position += 1) {
    const value = tokens[position].text
    if (value === '@') {
      const next = skipAnnotation(tokens, position, close)
      if (next > position) {
        position = next - 1
        continue
      }
    }
    if (value === '<') angles += 1
    else if (value === '>') angles = Math.max(0, angles - 1)
    else if (value === '[') brackets += 1
    else if (value === ']') brackets = Math.max(0, brackets - 1)
    else if (angles === 0 && brackets === 0) {
      if (value === '(') {
        paramsOpen = position
        break
      }
      if (value === '=' || value === ';' || value === '{' || value === '}') return undefined
    }
  }
  if (paramsOpen < 0 || paramsOpen <= from) return undefined

  const nameToken = tokens[paramsOpen - 1]
  if (!isWordToken(nameToken)) return undefined
  if (nameToken.text === 'new' || nameToken.text === 'this' || nameToken.text === 'super') {
    return undefined
  }

  const paramsClose = findMatching(tokens, paramsOpen, '(', ')', close)
  if (paramsClose < 0) {
    ctx.unverifiable('method parameter list is unterminated', nameToken.span)
    return {
      nameToken,
      signatureEnd: paramsOpen,
      bodyOpen: -1,
      bodyClose: -1,
      next: close,
    }
  }

  let bodyOpen = -1
  let terminator = -1
  let parens = 0
  let bracketsAfter = 0
  let braces = 0
  let anglesAfter = 0
  let defaultValue = false

  for (let position = paramsClose + 1; position < close; position += 1) {
    const value = tokens[position].text
    if (value === '@') {
      const next = skipAnnotation(tokens, position, close)
      if (next > position) {
        position = next - 1
        continue
      }
    }
    if (value === '(') parens += 1
    else if (value === ')') parens = Math.max(0, parens - 1)
    else if (value === '[') bracketsAfter += 1
    else if (value === ']') bracketsAfter = Math.max(0, bracketsAfter - 1)
    else if (value === '<') anglesAfter += 1
    else if (value === '>') anglesAfter = Math.max(0, anglesAfter - 1)
    else if (value === '{') {
      if (!defaultValue && parens === 0 && bracketsAfter === 0 && braces === 0 && anglesAfter === 0) {
        bodyOpen = position
        break
      }
      braces += 1
    } else if (value === '}') {
      if (braces > 0) braces -= 1
      else {
        terminator = position
        break
      }
    } else if (value === ';' && parens === 0 && bracketsAfter === 0 && braces === 0 && anglesAfter === 0) {
      terminator = position
      break
    } else if (
      value === 'default' &&
      parens === 0 &&
      bracketsAfter === 0 &&
      braces === 0 &&
      anglesAfter === 0
    ) {
      // Annotation type element default value: braces belong to the value.
      defaultValue = true
    }
  }

  const signatureEnd =
    bodyOpen >= 0 ? bodyOpen : terminator >= 0 ? terminator : close
  let bodyClose = -1
  let next = close
  if (bodyOpen >= 0) {
    bodyClose = braceClose(state, bodyOpen)
    if (bodyClose < 0 || bodyClose >= close) {
      ctx.unverifiable('unterminated method body', tokens[bodyOpen].span)
      next = close
    } else {
      next = bodyClose + 1
    }
  } else if (terminator >= 0) {
    next = terminator + 1
  }

  return { nameToken, signatureEnd, bodyOpen, bodyClose, next }
}

/** Emit one `variable` node per declarator of a field declaration. */
function emitFields(
  state: JavaParseState,
  memberStart: number,
  from: number,
  semicolon: number,
  modifiers: ReadonlySet<string>,
  ownerName: string,
): void {
  const { tokens } = state
  const startToken = tokens[memberStart]
  const semicolonToken = tokens[semicolon]
  if (startToken === undefined || semicolonToken === undefined) return
  const span: SourceSpan = {
    start: startToken.span.start,
    end: semicolonToken.span.end,
    line: startToken.span.line,
    column: startToken.span.column,
  }
  const isConstant = modifiers.has('static') && modifiers.has('final')
  const segments = fieldSegments(tokens, from, semicolon)
  let first = true
  for (const segment of segments) {
    const nameToken = fieldNameToken(tokens, segment.start, segment.end, first)
    first = false
    if (nameToken === undefined) continue
    emitNode(state, {
      kind: 'variable',
      name: nameToken.text,
      span,
      locatorKind: 'variable',
      target: `${PARSER_ID}:variable:${ownerName}.${nameToken.text}`,
      ...(isConstant ? { label: 'constant' } : {}),
    })
  }
}

/** Split a field declaration into declarator ranges at top-level commas. */
function fieldSegments(
  tokens: readonly JavaToken[],
  from: number,
  semicolon: number,
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = []
  let segmentStart = from
  let parens = 0
  let brackets = 0
  let braces = 0
  let angles = 0

  for (let position = from; position < semicolon; position += 1) {
    const value = tokens[position].text
    if (value === '(') parens += 1
    else if (value === ')') parens = Math.max(0, parens - 1)
    else if (value === '[') brackets += 1
    else if (value === ']') brackets = Math.max(0, brackets - 1)
    else if (value === '{') braces += 1
    else if (value === '}') braces = Math.max(0, braces - 1)
    // Angles are tracked after `=` too: a generic constructor/method reference
    // in an initializer (`new HashMap<String, Integer>()`, `Foo::<A, B>m`) has
    // top-level commas that must not split the declarator.
    else if (value === '<') angles += 1
    else if (value === '>') angles = Math.max(0, angles - 1)
    if (value === ',' && parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      segments.push({ start: segmentStart, end: position })
      segmentStart = position + 1
      angles = 0
    }
  }
  segments.push({ start: segmentStart, end: semicolon })
  return segments
}

/**
 * Last identifier before the initializer/end of one declarator: walks back over
 * `[]` so `int a[]` and `int[] a` both name `a`. For the first declarator a type
 * must precede the name; later declarators are name-only by construction.
 */
function fieldNameToken(
  tokens: readonly JavaToken[],
  start: number,
  end: number,
  firstSegment: boolean,
): JavaToken | undefined {
  let equals = -1
  let parens = 0
  let brackets = 0
  let braces = 0
  let angles = 0
  for (let position = start; position < end; position += 1) {
    const value = tokens[position].text
    if (value === '(') parens += 1
    else if (value === ')') parens = Math.max(0, parens - 1)
    else if (value === '[') brackets += 1
    else if (value === ']') brackets = Math.max(0, brackets - 1)
    else if (value === '{') braces += 1
    else if (value === '}') braces = Math.max(0, braces - 1)
    else if (value === '<') angles += 1
    else if (value === '>') angles = Math.max(0, angles - 1)
    else if (value === '=' && parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      equals = position
      break
    }
  }

  let cursor = (equals >= 0 ? equals : end) - 1
  while (cursor >= start && tokens[cursor].text === ']') {
    let depth = 0
    let scan = cursor
    for (; scan >= start; scan -= 1) {
      const value = tokens[scan].text
      if (value === ']') depth += 1
      else if (value === '[') {
        depth -= 1
        if (depth === 0) break
      }
    }
    cursor = scan - 1
  }
  if (cursor < start) return undefined
  const token = tokens[cursor]
  if (!isWordToken(token)) return undefined
  if (firstSegment && cursor === start) return undefined
  return token
}

/** Index of the field-declaration `;`, or -1 at a body boundary. */
function findMemberEnd(
  tokens: readonly JavaToken[],
  from: number,
  close: number,
): number {
  let parens = 0
  let brackets = 0
  let braces = 0
  let angles = 0
  let seenEquals = false
  for (let position = from; position < close; position += 1) {
    const value = tokens[position].text
    if (value === '(') parens += 1
    else if (value === ')') parens = Math.max(0, parens - 1)
    else if (value === '[') brackets += 1
    else if (value === ']') brackets = Math.max(0, brackets - 1)
    else if (value === '{') braces += 1
    else if (value === '}') {
      if (braces === 0 && parens === 0 && brackets === 0) return -1
      braces = Math.max(0, braces - 1)
    } else if (!seenEquals) {
      if (value === '<') angles += 1
      else if (value === '>') angles = Math.max(0, angles - 1)
      else if (value === '=') seenEquals = true
    }
    if (value === ';' && parens === 0 && brackets === 0 && braces === 0) {
      return position
    }
  }
  return -1
}

/** Index of the `;` ending an enum constant list, or -1 when there is none. */
function findEnumConstantsEnd(
  tokens: readonly JavaToken[],
  from: number,
  close: number,
): number {
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let position = from; position < close; position += 1) {
    const value = tokens[position].text
    if (value === '(') parens += 1
    else if (value === ')') parens = Math.max(0, parens - 1)
    else if (value === '[') brackets += 1
    else if (value === ']') brackets = Math.max(0, brackets - 1)
    else if (value === '{') braces += 1
    else if (value === '}') {
      if (braces === 0 && parens === 0 && brackets === 0) return -1
      braces = Math.max(0, braces - 1)
    } else if (value === ';' && parens === 0 && brackets === 0 && braces === 0) {
      return position
    }
  }
  return -1
}

/* ------------------------------------------------------------------------- *
 * Metadata emission
 * ------------------------------------------------------------------------- */

function emitNode(state: JavaParseState, options: EmitNodeOptions): NodeMetadata | undefined {
  const { ctx } = state
  const name = sanitizeMetadataText(options.name, MAX_NAME_LENGTH)
  if (name.length === 0) return undefined

  const fragment = fragmentForSpan(ctx, options.span)
  let reference: NodeReference | undefined
  if (options.withReference !== false) {
    try {
      reference = referenceForSpan(ctx, {
        scheme: options.scheme ?? 'symbol',
        target: options.target ?? `${options.locatorKind ?? options.kind}:${name}`,
        span: options.span,
        parserId: PARSER_ID,
      })
    } catch {
      // A reference is optional (for example a path-less text parse of a
      // `module` node); the node and its flat fragment remain valid.
      reference = undefined
    }
  }

  const metadata = pushNodeMetadata(ctx, state.nodes, {
    kind: options.kind,
    name,
    locator: `${PARSER_ID}:${options.locatorKind ?? options.kind}:${name}#${options.span.start}`,
    ...(options.label === undefined ? {} : { label: options.label }),
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

/** Declaration-signature span: from the member start up to, not including, `{` or `;`. */
function signatureSpan(
  tokens: readonly JavaToken[],
  startPosition: number,
  endPosition: number,
): SourceSpan {
  const startToken = tokens[startPosition]
  const endToken = tokens[endPosition]
  if (startToken === undefined) {
    const empty = { start: 0, end: 0, line: 1, column: 1 }
    return empty
  }
  const fallbackEnd = tokens[tokens.length - 1]?.span.end ?? startToken.span.end
  return {
    start: startToken.span.start,
    end: endToken === undefined ? fallbackEnd : endToken.span.start,
    line: startToken.span.line,
    column: startToken.span.column,
  }
}
