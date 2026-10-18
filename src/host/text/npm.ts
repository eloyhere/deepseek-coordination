/**
 * npm `package.json` parser.
 *
 * Lexical and dependency-free: a bounded, non-evaluating JSON scan over the
 * (already 1 MiB-capped) `ParseContext.text`. No `JSON.parse` of unbounded
 * input, no module loader, no evaluation, no network and no filesystem access.
 *
 * descriptive only: no edit, no build, no install; a real 'project create' would be a shell command behind DSH's permission model, not a plugin tool.
 *
 * Extracted metadata is body-free:
 *
 * | kind | name | label |
 * |---|---|---|
 * | `project` | `name` | `name@version` |
 * | `dependency` | package name | the declared range |
 * | `script` | script key | — (a command body is never stored) |
 *
 * Every `dependencies` / `devDependencies` / `peerDependencies` /
 * `optionalDependencies` entry also emits a `FileReference` with
 * `attributes.relation = 'depends'`, so the dependency layer sees the package
 * as an external dependency. `scripts` values are scanned only to skip them;
 * they never reach a node, a summary or a description.
 *
 * Malformed JSON (unterminated strings/objects/arrays, bad escapes, a non-object
 * root) is reported as diagnostics, and the verified prefix is returned instead
 * of throwing. Nesting, token, time and metadata budgets come from
 * `ParseContext` (`node-limit`/`depth-limit`/`token-limit`/`timeout`).
 *
 * Complexity: one pass over the source, O(n) time and O(entries) space.
 */
import type { SourceSpan } from '../../shared/ast.js'
import {
  MAX_METADATA_NODES,
  ParseContext,
  fragmentForSpan,
  pushNodeMetadata,
  referenceForSpan,
} from './parser.js'
import type {
  FileReference,
  NodeMetadata,
  NodeReference,
  ParseOptions,
  ParseResult,
  Parser,
} from './parser.js'

/** Parser id used for references and the registry. */
const PARSER_ID = 'npm'

/** Sections whose entries are package dependencies. */
const DEPENDENCY_SECTIONS: ReadonlySet<string> = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
])

/** Sections of `package.json` this parser reads with entry capture. */
const CAPTURED_SECTIONS: ReadonlySet<string> = new Set([...DEPENDENCY_SECTIONS, 'scripts'])

/** A decoded JSON string with its content offsets (quotes excluded). */
interface JsonStringToken {
  value: string
  /** Content start (after the opening quote). */
  start: number
  /** Content end (at the closing quote). */
  end: number
  /** Offset just after the closing quote. */
  tokenEnd: number
}

interface JsonValueScan {
  kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  start: number
  end: number
  string?: JsonStringToken
}

interface JsonEntryScan {
  key: JsonStringToken
  value: JsonValueScan
  start: number
  end: number
}

interface JsonObjectScan {
  start: number
  end: number
  entries: JsonEntryScan[]
}

interface RootSection {
  name: string
  object: JsonObjectScan
}

interface RootScan {
  start: number
  end: number
  name?: JsonStringToken
  version?: JsonStringToken
  sections: RootSection[]
}

/**
 * Parse a `package.json` from text. Never throws for malformed JSON (only a
 * pre-aborted signal may throw, via `ParseContext.checkpoint`).
 *
 * Time O(n), space O(entries).
 */
export function parsePackageJson(text: string, options: ParseOptions = {}): ParseResult {
  const ctx = new ParseContext(text, options)
  const references: FileReference[] = []
  const nodes: NodeMetadata[] = []
  const root = scanRoot(ctx)
  if (root === undefined) return ctx.finalize({ parserId: PARSER_ID, references, nodes })

  const projectSpan = spanAt(ctx, root.start, root.end)
  const name = root.name?.value
  const version = root.version?.value
  const label = isPresent(name) && isPresent(version) ? `${name}@${version}` : undefined
  const projectReference = ctx.path === undefined
    ? undefined
    : referenceForSpan(ctx, { scheme: 'file', target: ctx.path, span: projectSpan, parserId: PARSER_ID })
  pushNodeMetadata(ctx, nodes, {
    kind: 'project',
    ...(isPresent(name) ? { name } : {}),
    ...(label === undefined ? {} : { label }),
    ...(projectReference === undefined ? {} : { reference: projectReference }),
    fragment: fragmentForSpan(ctx, projectSpan),
    source: 'annotation',
    span: projectSpan,
  })

  sections: for (const section of root.sections) {
    for (const entry of section.object.entries) {
      if (nodes.length >= MAX_METADATA_NODES) {
        ctx.limit(
          'node-limit',
          `node metadata limit ${MAX_METADATA_NODES} reached; later nodes were dropped`,
        )
        break sections
      }
      const packageName = entry.key.value
      if (packageName.length === 0) continue
      const span = spanAt(ctx, entry.start, entry.end)
      if (section.name === 'scripts') {
        pushNodeMetadata(ctx, nodes, {
          kind: 'script',
          name: packageName,
          fragment: fragmentForSpan(ctx, span),
          source: 'annotation',
          span,
        })
        continue
      }
      const stringValue = entry.value.kind === 'string' ? entry.value.string : undefined
      if (stringValue === undefined) {
        ctx.unverifiable(
          `dependency "${packageName}" in "${section.name}" is not a string; skipped`,
          span,
        )
        continue
      }
      const range = stringValue.value
      const reference = moduleReference(ctx, packageName, span)
      const node = pushNodeMetadata(ctx, nodes, {
        kind: 'dependency',
        name: packageName,
        ...(range.length === 0 ? {} : { label: range }),
        ...(reference === undefined ? {} : { reference }),
        fragment: fragmentForSpan(ctx, span),
        source: 'annotation',
        span,
      })
      if (node !== undefined) {
        const specifierSpan = spanAt(ctx, stringValue.start, stringValue.end)
        references.push({
          kind: 'import',
          specifier: packageName,
          external: true,
          span: specifierSpan,
          attributes: { manager: 'npm', relation: 'depends', section: section.name },
          ...fragmentForSpan(ctx, specifierSpan),
        })
      }
    }
  }

  return ctx.finalize({ parserId: PARSER_ID, references, nodes })
}

/** `Parser` implementation for the registry. Matched by exact file name only. */
export class NpmParser implements Parser {
  readonly id = PARSER_ID
  readonly extensions: readonly string[] = []
  readonly filenames: readonly string[] = ['package.json']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parsePackageJson(text, options)
  }
}

/** Shared singleton. */
export const npmParser = new NpmParser()

/* ------------------------------------------------------------------------- *
 * Root scan
 * ------------------------------------------------------------------------- */

/**
 * Scan the root object only, capturing `name`/`version` and the immediate
 * entries of `dependencies`/`devDependencies`/`peerDependencies`/
 * `optionalDependencies`/`scripts`. Every other value is validated and skipped.
 */
function scanRoot(ctx: ParseContext): RootScan | undefined {
  const text = ctx.text
  let cursor = skipJsonWhitespace(text, ctx.bomOffset)
  if (cursor >= text.length) {
    ctx.parseError('empty JSON document', spanAt(ctx, 0, 0))
    return undefined
  }
  if (text.charCodeAt(cursor) !== 0x7b) {
    ctx.parseError(
      'package.json root must be a JSON object',
      spanAt(ctx, cursor, Math.min(text.length, cursor + 1)),
    )
    return undefined
  }
  const start = cursor
  const sections: RootSection[] = []
  let name: JsonStringToken | undefined
  let version: JsonStringToken | undefined
  let closed = false
  cursor = skipJsonWhitespace(text, cursor + 1)
  if (text.charCodeAt(cursor) === 0x7d) {
    closed = true
    cursor += 1
  }

  while (!closed && cursor < text.length) {
    if (!ctx.checkpoint()) break
    if (ctx.tokens >= ctx.maxTokens) {
      ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
      break
    }
    if (text.charCodeAt(cursor) !== 0x22) {
      ctx.parseError('expected a JSON object key string', spanAt(ctx, cursor, cursor + 1))
      break
    }
    const key = readJsonString(ctx, text, cursor)
    if (key === undefined) break
    cursor = skipJsonWhitespace(text, key.tokenEnd)
    if (text.charCodeAt(cursor) !== 0x3a) {
      ctx.parseError('expected ":" after a JSON object key', spanAt(ctx, cursor, cursor + 1))
      break
    }
    cursor = skipJsonWhitespace(text, cursor + 1)

    let value: JsonValueScan | undefined
    if (CAPTURED_SECTIONS.has(key.value) && text.charCodeAt(cursor) === 0x7b) {
      const object = scanJsonObject(ctx, text, cursor, 1, true)
      value = { kind: 'object', start: object.start, end: object.end }
      sections.push({ name: key.value, object })
    } else {
      value = scanJsonValue(ctx, text, cursor, 1)
      if (value === undefined) break
      if (CAPTURED_SECTIONS.has(key.value)) {
        ctx.unverifiable(`"${key.value}" is not a JSON object; skipped`, spanAt(ctx, value.start, value.end))
      } else if (value.kind === 'string' && value.string !== undefined) {
        if (key.value === 'name') name = value.string
        else if (key.value === 'version') version = value.string
      }
    }

    cursor = skipJsonWhitespace(text, value.end)
    const next = text.charCodeAt(cursor)
    if (next === 0x2c) {
      cursor = skipJsonWhitespace(text, cursor + 1)
      if (text.charCodeAt(cursor) === 0x7d) {
        ctx.parseError('trailing comma in a JSON object', spanAt(ctx, cursor, cursor + 1))
        cursor += 1
        closed = true
      }
      continue
    }
    if (next === 0x7d) {
      cursor += 1
      closed = true
      break
    }
    ctx.parseError('expected "," or "}" in a JSON object', spanAt(ctx, cursor, Math.min(text.length, cursor + 1)))
    break
  }

  if (!closed) {
    if (cursor >= text.length) {
      ctx.parseError('unterminated JSON object', spanAt(ctx, start, text.length))
    }
    cursor = Math.max(cursor, start + 1)
  } else if (skipJsonWhitespace(text, cursor) < text.length) {
    ctx.parseError('trailing content after the JSON object', spanAt(ctx, cursor, text.length))
  }
  return { start, end: closed ? cursor : Math.max(cursor, text.length), name, version, sections }
}

/* ------------------------------------------------------------------------- *
 * JSON value scanning
 * ------------------------------------------------------------------------- */

function scanJsonObject(
  ctx: ParseContext,
  text: string,
  start: number,
  depth: number,
  capture: boolean,
): JsonObjectScan {
  const entries: JsonEntryScan[] = []
  let cursor = skipJsonWhitespace(text, start + 1)
  if (text.charCodeAt(cursor) === 0x7d) return { start, end: cursor + 1, entries }
  while (cursor < text.length) {
    if (!ctx.checkpoint()) return { start, end: cursor, entries }
    if (text.charCodeAt(cursor) !== 0x22) {
      ctx.parseError('expected a JSON object key string', spanAt(ctx, cursor, cursor + 1))
      return { start, end: cursor, entries }
    }
    const key = readJsonString(ctx, text, cursor)
    if (key === undefined) return { start, end: cursor, entries }
    cursor = skipJsonWhitespace(text, key.tokenEnd)
    if (text.charCodeAt(cursor) !== 0x3a) {
      ctx.parseError('expected ":" after a JSON object key', spanAt(ctx, cursor, cursor + 1))
      return { start, end: cursor, entries }
    }
    cursor = skipJsonWhitespace(text, cursor + 1)
    const value = scanJsonValue(ctx, text, cursor, depth + 1)
    if (value === undefined) return { start, end: cursor, entries }
    if (capture) entries.push({ key, value, start: key.start, end: value.end })
    cursor = skipJsonWhitespace(text, value.end)
    const next = text.charCodeAt(cursor)
    if (next === 0x2c) {
      cursor = skipJsonWhitespace(text, cursor + 1)
      if (text.charCodeAt(cursor) === 0x7d) {
        ctx.parseError('trailing comma in a JSON object', spanAt(ctx, cursor, cursor + 1))
        return { start, end: cursor + 1, entries }
      }
      continue
    }
    if (next === 0x7d) return { start, end: cursor + 1, entries }
    ctx.parseError('expected "," or "}" in a JSON object', spanAt(ctx, cursor, Math.min(text.length, cursor + 1)))
    return { start, end: cursor, entries }
  }
  ctx.parseError('unterminated JSON object', spanAt(ctx, start, text.length))
  return { start, end: text.length, entries }
}

function scanJsonArray(
  ctx: ParseContext,
  text: string,
  start: number,
  depth: number,
): JsonValueScan | undefined {
  let cursor = skipJsonWhitespace(text, start + 1)
  if (text.charCodeAt(cursor) === 0x5d) return { kind: 'array', start, end: cursor + 1 }
  while (cursor < text.length) {
    if (!ctx.checkpoint()) return { kind: 'array', start, end: cursor }
    const value = scanJsonValue(ctx, text, cursor, depth + 1)
    if (value === undefined) return undefined
    cursor = skipJsonWhitespace(text, value.end)
    const next = text.charCodeAt(cursor)
    if (next === 0x2c) {
      cursor = skipJsonWhitespace(text, cursor + 1)
      if (text.charCodeAt(cursor) === 0x5d) {
        ctx.parseError('trailing comma in a JSON array', spanAt(ctx, cursor, cursor + 1))
        return { kind: 'array', start, end: cursor + 1 }
      }
      continue
    }
    if (next === 0x5d) return { kind: 'array', start, end: cursor + 1 }
    ctx.parseError('expected "," or "]" in a JSON array', spanAt(ctx, cursor, Math.min(text.length, cursor + 1)))
    return undefined
  }
  ctx.parseError('unterminated JSON array', spanAt(ctx, start, text.length))
  return undefined
}

function scanJsonValue(
  ctx: ParseContext,
  text: string,
  start: number,
  depth: number,
): JsonValueScan | undefined {
  if (depth > ctx.maxDepth) {
    ctx.limit('depth-limit', `JSON depth limit ${ctx.maxDepth} reached; parsed the prefix`)
    return undefined
  }
  if (!ctx.checkpoint()) return undefined
  if (ctx.tokens >= ctx.maxTokens) {
    ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
    return undefined
  }
  const cursor = skipJsonWhitespace(text, start)
  if (cursor >= text.length) {
    ctx.parseError('unexpected end of JSON input', spanAt(ctx, cursor, cursor))
    return undefined
  }
  const code = text.charCodeAt(cursor)
  if (code === 0x7b) {
    const object = scanJsonObject(ctx, text, cursor, depth, false)
    return { kind: 'object', start: cursor, end: object.end }
  }
  if (code === 0x5b) return scanJsonArray(ctx, text, cursor, depth)
  if (code === 0x22) {
    const string = readJsonString(ctx, text, cursor)
    if (string === undefined) return undefined
    return { kind: 'string', start: cursor, end: string.tokenEnd, string }
  }
  if (text.startsWith('true', cursor)) {
    ctx.tokens += 1
    return { kind: 'boolean', start: cursor, end: cursor + 4 }
  }
  if (text.startsWith('false', cursor)) {
    ctx.tokens += 1
    return { kind: 'boolean', start: cursor, end: cursor + 5 }
  }
  if (text.startsWith('null', cursor)) {
    ctx.tokens += 1
    return { kind: 'null', start: cursor, end: cursor + 4 }
  }
  if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return readJsonNumber(ctx, text, cursor)
  ctx.parseError('expected a JSON value', spanAt(ctx, cursor, Math.min(text.length, cursor + 1)))
  return undefined
}

function readJsonNumber(ctx: ParseContext, text: string, start: number): JsonValueScan | undefined {
  let cursor = start
  if (text.charCodeAt(cursor) === 0x2d) cursor += 1
  const integerStart = cursor
  while (cursor < text.length && isJsonDigit(text.charCodeAt(cursor))) cursor += 1
  if (cursor === integerStart) {
    ctx.parseError('malformed JSON number', spanAt(ctx, start, Math.min(text.length, cursor + 1)))
    return undefined
  }
  if (text.charCodeAt(cursor) === 0x2e) {
    cursor += 1
    const fractionStart = cursor
    while (cursor < text.length && isJsonDigit(text.charCodeAt(cursor))) cursor += 1
    if (cursor === fractionStart) {
      ctx.parseError('malformed JSON number', spanAt(ctx, start, Math.min(text.length, cursor + 1)))
      return undefined
    }
  }
  const exponent = text.charCodeAt(cursor)
  if (exponent === 0x65 || exponent === 0x45) {
    cursor += 1
    const sign = text.charCodeAt(cursor)
    if (sign === 0x2b || sign === 0x2d) cursor += 1
    const exponentStart = cursor
    while (cursor < text.length && isJsonDigit(text.charCodeAt(cursor))) cursor += 1
    if (cursor === exponentStart) {
      ctx.parseError('malformed JSON number', spanAt(ctx, start, Math.min(text.length, cursor + 1)))
      return undefined
    }
  }
  ctx.tokens += 1
  return { kind: 'number', start, end: cursor }
}

/**
 * Read one JSON string. Escapes are decoded lexically (`\uXXXX` becomes the
 * corresponding UTF-16 code unit); a raw control character or an invalid escape
 * is a diagnostic and stops the scan.
 */
function readJsonString(ctx: ParseContext, text: string, start: number): JsonStringToken | undefined {
  if (text.charCodeAt(start) !== 0x22) return undefined
  const contentStart = start + 1
  let cursor = contentStart
  let chunkStart = contentStart
  let value = ''
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code === 0x22) {
      value += text.slice(chunkStart, cursor)
      ctx.tokens += 1
      return { value, start: contentStart, end: cursor, tokenEnd: cursor + 1 }
    }
    if (code === 0x5c) {
      value += text.slice(chunkStart, cursor)
      const escape = readJsonEscape(ctx, text, cursor)
      if (escape === undefined) return undefined
      value += escape.value
      cursor = escape.end
      chunkStart = cursor
      continue
    }
    if (code < 0x20) {
      ctx.parseError('unescaped control character in a JSON string', spanAt(ctx, cursor, cursor + 1))
      return undefined
    }
    cursor += 1
  }
  ctx.parseError('unterminated JSON string', spanAt(ctx, start, text.length))
  return undefined
}

function readJsonEscape(
  ctx: ParseContext,
  text: string,
  slash: number,
): { value: string; end: number } | undefined {
  const code = text.charCodeAt(slash + 1)
  switch (code) {
    case 0x22:
      return { value: '"', end: slash + 2 }
    case 0x5c:
      return { value: '\\', end: slash + 2 }
    case 0x2f:
      return { value: '/', end: slash + 2 }
    case 0x62:
      return { value: '\b', end: slash + 2 }
    case 0x66:
      return { value: '\f', end: slash + 2 }
    case 0x6e:
      return { value: '\n', end: slash + 2 }
    case 0x72:
      return { value: '\r', end: slash + 2 }
    case 0x74:
      return { value: '\t', end: slash + 2 }
    case 0x75: {
      const hex = text.slice(slash + 2, slash + 6)
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
        ctx.parseError('invalid \\u escape in a JSON string', spanAt(ctx, slash, Math.min(text.length, slash + 6)))
        return undefined
      }
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), end: slash + 6 }
    }
    default:
      ctx.parseError('invalid escape in a JSON string', spanAt(ctx, slash, Math.min(text.length, slash + 2)))
      return undefined
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

/** Module reference for an external package; omitted without a workspace path. */
function moduleReference(ctx: ParseContext, target: string, span: SourceSpan): NodeReference | undefined {
  if (ctx.path === undefined) return undefined
  return referenceForSpan(ctx, { scheme: 'module', target, span, parserId: PARSER_ID })
}

/** Span with line/column resolved from the source map. */
function spanAt(ctx: ParseContext, start: number, end: number): SourceSpan {
  const safeStart = Math.max(0, Math.min(start, ctx.text.length))
  const safeEnd = Math.max(safeStart, Math.min(end, ctx.text.length))
  const line = ctx.sourceMap.lineAt(safeStart) ?? 1
  const column = ctx.sourceMap.columnAt(safeStart) ?? 1
  return { start: safeStart, end: safeEnd, line, column }
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.length > 0
}

function skipJsonWhitespace(text: string, start: number): number {
  let cursor = start
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      cursor += 1
      continue
    }
    break
  }
  return cursor
}

function isJsonDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}
