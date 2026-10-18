/**
 * Maven POM (`pom.xml`) parser.
 *
 * Lexical and dependency-free: one forward scan over `<…>` tags with a bounded
 * element stack. No XML library, no DOM, no DTD/entity expansion beyond the five
 * predefined XML entities plus numeric character references, and no filesystem
 * access (the file layer supplies the text; `ParseContext` supplies the path).
 *
 * descriptive only: no edit, no build, no install; a real 'project create' would be a shell command behind DSH's permission model, not a plugin tool.
 *
 * It extracts body-free metadata only:
 *
 * | kind | name | label |
 * |---|---|---|
 * | `project` | `<artifactId>` | `<groupId>:<artifactId>` |
 * | `module` | the `<module>` path | — |
 * | `dependency` | `groupId:artifactId` | explicit `<version>`, or `parent` |
 *
 * Every `<dependency>` under a `<dependencies>` container (including
 * `dependencyManagement`) and the top-level `<parent>` also emits a
 * `FileReference` with `attributes.relation = 'depends'`, so the dependency
 * layer sees the coordinate as an external package dependency. A version is
 * never invented: it is copied only when the `<version>` element is explicit,
 * and the project's own `<version>` is never used as a fallback.
 *
 * Malformed XML (unterminated tags, mismatched closing tags, a missing
 * `<project>`) is reported as diagnostics; the parser returns the prefix it
 * could verify instead of throwing. Limits come from `ParseContext` (1 MiB
 * source, 200k tokens, depth 256, 2 s, 20k metadata nodes).
 *
 * Complexity: one pass over the source, O(n) time and O(declarations) space.
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
const PARSER_ID = 'maven'

/** Direct `<project>` children that name the project node. */
const PROJECT_FIELDS: ReadonlySet<string> = new Set(['groupId', 'artifactId'])

/** Direct `<parent>` children that name the parent coordinate. */
const PARENT_FIELDS: ReadonlySet<string> = new Set(['groupId', 'artifactId', 'version'])

/** Direct `<dependency>` children this parser understands (scope is kept). */
const DEPENDENCY_FIELDS: ReadonlySet<string> = new Set([
  'groupId', 'artifactId', 'version', 'scope',
])

/** One `<module>` entry inside `<modules>`. */
interface ModuleRecord {
  start: number
  end: number
  path: string
}

/** One `<parent>` or `<dependency>` element and its direct string children. */
interface CoordinateRecord {
  start: number
  end: number
  fields: Record<string, string>
}

type DependencyRecord = CoordinateRecord
type ParentRecord = CoordinateRecord

/** What a frame contributed to the parse when its element closed. */
type Capture =
  | { type: 'project' }
  | { type: 'project-field'; field: string }
  | { type: 'parent'; record: ParentRecord }
  | { type: 'parent-field'; record: ParentRecord; field: string }
  | { type: 'module' }
  | { type: 'dependency'; record: DependencyRecord }
  | { type: 'dependency-field'; record: DependencyRecord; field: string }
  | { type: 'none' }

interface ElementFrame {
  name: string
  start: number
  contentStart: number
  capture: Capture
}

interface TagToken {
  kind: 'start' | 'end' | 'other'
  name: string
  start: number
  end: number
  selfClosing: boolean
}

type Declaration =
  | { kind: 'module'; start: number; module: ModuleRecord }
  | { kind: 'parent'; start: number; parent: ParentRecord }
  | { kind: 'dependency'; start: number; dependency: DependencyRecord }

/**
 * Parse a Maven POM from text. Never throws for malformed XML (only a
 * pre-aborted signal may throw, via `ParseContext.checkpoint`).
 *
 * Time O(n), space O(declarations).
 */
export function parsePom(text: string, options: ParseOptions = {}): ParseResult {
  const ctx = new ParseContext(text, options)
  const source = ctx.text
  const references: FileReference[] = []
  const nodes: NodeMetadata[] = []
  const projectFields: Record<string, string> = {}
  const modules: ModuleRecord[] = []
  const dependencies: DependencyRecord[] = []
  const stack: ElementFrame[] = []
  let parent: ParentRecord | undefined
  let projectStart = -1
  let projectSpan: SourceSpan | undefined
  let projectSeen = false
  let stopped = false

  function captureFor(tag: TagToken): Capture {
    const open = stack[stack.length - 1]
    if (tag.name === 'project' && open === undefined && projectStart < 0) {
      projectStart = tag.start
      return { type: 'project' }
    }
    if (open === undefined) return { type: 'none' }
    if (open.name === 'project') {
      if (PROJECT_FIELDS.has(tag.name)) return { type: 'project-field', field: tag.name }
      if (tag.name === 'parent') {
        const record: ParentRecord = { start: tag.start, end: tag.end, fields: {} }
        parent = record
        return { type: 'parent', record }
      }
      return { type: 'none' }
    }
    if (open.name === 'modules' && tag.name === 'module') return { type: 'module' }
    if (open.name === 'dependencies' && tag.name === 'dependency') {
      const record: DependencyRecord = { start: tag.start, end: tag.end, fields: {} }
      dependencies.push(record)
      return { type: 'dependency', record }
    }
    if (open.name === 'dependency' && open.capture.type === 'dependency') {
      if (DEPENDENCY_FIELDS.has(tag.name)) {
        return { type: 'dependency-field', record: open.capture.record, field: tag.name }
      }
      return { type: 'none' }
    }
    if (open.name === 'parent' && open.capture.type === 'parent') {
      if (PARENT_FIELDS.has(tag.name)) {
        return { type: 'parent-field', record: open.capture.record, field: tag.name }
      }
    }
    return { type: 'none' }
  }

  function finishFrame(frame: ElementFrame, contentStart: number, closeStart: number, tagEnd: number): void {
    const raw = source.slice(contentStart, closeStart)
    const capture = frame.capture
    switch (capture.type) {
      case 'project':
        projectSeen = true
        projectSpan = spanAt(ctx, frame.start, tagEnd)
        break
      case 'project-field':
        if (projectFields[capture.field] === undefined) {
          projectFields[capture.field] = xmlText(raw)
        }
        break
      case 'parent':
        capture.record.end = tagEnd
        break
      case 'parent-field':
        if (capture.record.fields[capture.field] === undefined) {
          capture.record.fields[capture.field] = xmlText(raw)
        }
        break
      case 'module': {
        const path = xmlText(raw)
        if (path.length > 0) modules.push({ start: frame.start, end: tagEnd, path })
        break
      }
      case 'dependency':
        capture.record.end = tagEnd
        break
      case 'dependency-field':
        if (capture.record.fields[capture.field] === undefined) {
          capture.record.fields[capture.field] = xmlText(raw)
        }
        break
      default:
        break
    }
  }

  function closeElement(tag: TagToken): void {
    if (stack.length === 0) {
      ctx.parseError(`closing tag </${tag.name}> has no open element`, spanAt(ctx, tag.start, tag.end))
      return
    }
    let match = -1
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
      if (stack[depth].name === tag.name) {
        match = depth
        break
      }
    }
    if (match < 0) {
      ctx.parseError(
        `closing tag </${tag.name}> does not match any open element`,
        spanAt(ctx, tag.start, tag.end),
      )
      return
    }
    if (match !== stack.length - 1) {
      ctx.parseError(
        `closing tag </${tag.name}> while <${stack[stack.length - 1].name}> is still open`,
        spanAt(ctx, tag.start, tag.end),
      )
      while (stack.length - 1 > match) {
        const frame = stack.pop()
        if (frame === undefined) break
        finishFrame(frame, frame.contentStart, tag.start, tag.start)
      }
    }
    const frame = stack.pop()
    if (frame !== undefined) finishFrame(frame, frame.contentStart, tag.start, tag.end)
  }

  let index = 0
  while (index < source.length) {
    if (!ctx.checkpoint()) {
      stopped = true
      break
    }
    if (ctx.tokens >= ctx.maxTokens) {
      ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
      stopped = true
      break
    }
    const open = source.indexOf('<', index)
    if (open < 0) break
    if (open > index && stack.length === 0 && source.slice(index, open).trim().length > 0) {
      ctx.parseError('text outside the root element', spanAt(ctx, index, open))
    }
    const tag = readTag(ctx, source, open)
    if (tag === undefined) {
      stopped = true
      break
    }
    ctx.tokens += 1
    index = tag.end
    if (tag.kind === 'other') continue
    if (tag.kind === 'start') {
      const frame: ElementFrame = {
        name: tag.name,
        start: tag.start,
        contentStart: tag.end,
        capture: captureFor(tag),
      }
      if (tag.selfClosing) finishFrame(frame, tag.end, tag.end, tag.end)
      else stack.push(frame)
      continue
    }
    closeElement(tag)
  }

  if (!stopped && stack.length > 0) {
    const openNames = stack.slice(-8).map((frame) => `<${frame.name}>`).join(', ')
    ctx.parseError(
      `unterminated element(s): ${openNames}`,
      spanAt(ctx, stack[stack.length - 1].start, source.length),
    )
    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame === undefined) break
      finishFrame(frame, frame.contentStart, source.length, source.length)
    }
  }
  if (!stopped && stack.length === 0 && index < source.length && source.slice(index).trim().length > 0) {
    ctx.parseError('text after the closing root element', spanAt(ctx, index, source.length))
  }
  if (projectSpan === undefined && projectStart >= 0) {
    projectSpan = spanAt(ctx, projectStart, source.length)
    projectSeen = true
  }
  if (!projectSeen) {
    ctx.parseError('no <project> element found', spanAt(ctx, 0, Math.min(source.length, 1)))
  }

  const projectLabel = coordinateOf(projectFields.groupId, projectFields.artifactId)
  if (projectSpan !== undefined) {
    const span = projectSpan
    pushNodeMetadata(ctx, nodes, {
      kind: 'project',
      ...(isPresent(projectFields.artifactId) ? { name: projectFields.artifactId } : {}),
      ...(projectLabel.length === 0 ? {} : { label: projectLabel }),
      ...(ctx.path === undefined
        ? {}
        : {
            reference: referenceForSpan(ctx, {
              scheme: 'file',
              target: ctx.path,
              span,
              parserId: PARSER_ID,
            }),
          }),
      fragment: fragmentForSpan(ctx, span),
      source: 'annotation',
      span,
    })
  }

  const declarations: Declaration[] = []
  for (const module of modules) declarations.push({ kind: 'module', start: module.start, module })
  if (parent !== undefined) declarations.push({ kind: 'parent', start: parent.start, parent })
  for (const dependency of dependencies) {
    declarations.push({ kind: 'dependency', start: dependency.start, dependency })
  }
  declarations.sort((left, right) => left.start - right.start)

  for (const declaration of declarations) {
    if (nodes.length >= MAX_METADATA_NODES) {
      ctx.limit(
        'node-limit',
        `node metadata limit ${MAX_METADATA_NODES} reached; later nodes were dropped`,
      )
      break
    }
    if (declaration.kind === 'module') {
      const span = spanAt(ctx, declaration.module.start, declaration.module.end)
      pushNodeMetadata(ctx, nodes, {
        kind: 'module',
        name: declaration.module.path,
        fragment: fragmentForSpan(ctx, span),
        source: 'annotation',
        span,
      })
      continue
    }
    if (declaration.kind === 'parent') {
      const record = declaration.parent
      const span = spanAt(ctx, record.start, record.end)
      const coordinate = coordinateOf(record.fields.groupId, record.fields.artifactId)
      if (coordinate.length === 0) {
        ctx.parseError('parent element without groupId/artifactId', span)
        continue
      }
      if (!isPresent(record.fields.groupId) || !isPresent(record.fields.artifactId)) {
        ctx.unverifiable('parent element is missing groupId or artifactId; kept the explicit part', span)
      }
      const reference = nodeReferenceFor(ctx, coordinate, span)
      const node = pushNodeMetadata(ctx, nodes, {
        kind: 'dependency',
        name: coordinate,
        label: 'parent',
        ...(reference === undefined ? {} : { reference }),
        fragment: fragmentForSpan(ctx, span),
        source: 'annotation',
        span,
      })
      if (node !== undefined) {
        references.push(packageReference(ctx, coordinate, span, {
          manager: 'maven',
          relation: 'depends',
          role: 'parent',
        }))
      }
      continue
    }
    const record = declaration.dependency
    const span = spanAt(ctx, record.start, record.end)
    const coordinate = coordinateOf(record.fields.groupId, record.fields.artifactId)
    if (coordinate.length === 0) {
      ctx.parseError('dependency element without groupId/artifactId', span)
      continue
    }
    if (!isPresent(record.fields.groupId) || !isPresent(record.fields.artifactId)) {
      ctx.unverifiable('dependency element is missing groupId or artifactId; kept the explicit part', span)
    }
    const version = record.fields.version?.trim()
    const scope = record.fields.scope?.trim()
    const reference = nodeReferenceFor(ctx, coordinate, span)
    const node = pushNodeMetadata(ctx, nodes, {
      kind: 'dependency',
      name: coordinate,
      ...(version === undefined || version.length === 0 ? {} : { label: version }),
      ...(reference === undefined ? {} : { reference }),
      fragment: fragmentForSpan(ctx, span),
      source: 'annotation',
      span,
    })
    if (node !== undefined) {
      references.push(packageReference(ctx, coordinate, span, {
        manager: 'maven',
        relation: 'depends',
        role: 'dependency',
        ...(scope === undefined || scope.length === 0 ? {} : { scope }),
      }))
    }
  }

  return ctx.finalize({ parserId: PARSER_ID, references, nodes })
}

/** `Parser` implementation for the registry. Matched by exact file name only. */
export class MavenParser implements Parser {
  readonly id = PARSER_ID
  readonly extensions: readonly string[] = []
  readonly filenames: readonly string[] = ['pom.xml']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parsePom(text, options)
  }
}

/** Shared singleton. */
export const mavenParser = new MavenParser()

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

/** Build a `groupId:artifactId` coordinate from whatever is explicit. */
function coordinateOf(groupId: string | undefined, artifactId: string | undefined): string {
  const parts: string[] = []
  if (isPresent(groupId)) parts.push(groupId)
  if (isPresent(artifactId)) parts.push(artifactId)
  return parts.join(':')
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

/** Module reference for a local coordinate; omitted without a workspace path. */
function nodeReferenceFor(ctx: ParseContext, target: string, span: SourceSpan): NodeReference | undefined {
  if (ctx.path === undefined) return undefined
  return referenceForSpan(ctx, { scheme: 'module', target, span, parserId: PARSER_ID })
}

/**
 * External package reference. `kind` stays `import` (the closed `ReferenceKind`
 * union is a file-reference taxonomy); `attributes.relation` carries the
 * package-manager meaning the dependency layer reads.
 */
function packageReference(
  ctx: ParseContext,
  specifier: string,
  span: SourceSpan,
  attributes: Readonly<Record<string, string>>,
): FileReference {
  return {
    kind: 'import',
    specifier,
    external: true,
    span,
    attributes,
    ...fragmentForSpan(ctx, span),
  }
}

/** Span with line/column resolved from the source map. */
function spanAt(ctx: ParseContext, start: number, end: number): SourceSpan {
  const safeStart = Math.max(0, Math.min(start, ctx.text.length))
  const safeEnd = Math.max(safeStart, Math.min(end, ctx.text.length))
  const line = ctx.sourceMap.lineAt(safeStart) ?? 1
  const column = ctx.sourceMap.columnAt(safeStart) ?? 1
  return { start: safeStart, end: safeEnd, line, column }
}

/** Decode one simple element's text lexically, honouring comments and CDATA. */
function xmlText(raw: string): string {
  if (raw.length === 0) return ''
  let value = ''
  let index = 0
  while (index < raw.length) {
    if (raw.startsWith('<!--', index)) {
      const close = raw.indexOf('-->', index + 4)
      index = close < 0 ? raw.length : close + 3
      continue
    }
    if (raw.startsWith('<![CDATA[', index)) {
      const close = raw.indexOf(']]>', index + 9)
      value += raw.slice(index + 9, close < 0 ? raw.length : close)
      index = close < 0 ? raw.length : close + 3
      continue
    }
    const nextComment = raw.indexOf('<!--', index)
    const nextCdata = raw.indexOf('<![CDATA[', index)
    let stop = raw.length
    if (nextComment >= 0) stop = Math.min(stop, nextComment)
    if (nextCdata >= 0) stop = Math.min(stop, nextCdata)
    value += decodeXmlEntities(raw.slice(index, stop))
    index = stop
  }
  return value.trim()
}

const XML_ENTITY = /&(#x[0-9A-Fa-f]{1,8}|#[0-9]{1,10}|amp|lt|gt|quot|apos);/g
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Decode predefined and numeric XML entities; unknown entities stay verbatim. */
function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(XML_ENTITY, (match, body: string) => {
    if (body.startsWith('#x')) {
      const code = Number.parseInt(body.slice(2), 16)
      return isXmlCodePoint(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return isXmlCodePoint(code) ? String.fromCodePoint(code) : match
    }
    return PREDEFINED_ENTITIES[body] ?? match
  })
}

function isXmlCodePoint(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff &&
    !(code >= 0xd800 && code <= 0xdfff)
}

/**
 * Read one tag starting at `<`. Returns `undefined` only when no forward
 * progress is possible (the caller stops).
 */
function readTag(ctx: ParseContext, text: string, index: number): TagToken | undefined {
  if (index < 0 || index >= text.length || text.charCodeAt(index) !== 60) return undefined
  if (text.startsWith('<!--', index)) {
    const close = text.indexOf('-->', index + 4)
    if (close < 0) {
      ctx.parseError('unterminated XML comment', spanAt(ctx, index, text.length))
      return { kind: 'other', name: '', start: index, end: text.length, selfClosing: false }
    }
    return { kind: 'other', name: '', start: index, end: close + 3, selfClosing: false }
  }
  if (text.startsWith('<![CDATA[', index)) {
    const close = text.indexOf(']]>', index + 9)
    if (close < 0) {
      ctx.parseError('unterminated CDATA section', spanAt(ctx, index, text.length))
      return { kind: 'other', name: '', start: index, end: text.length, selfClosing: false }
    }
    return { kind: 'other', name: '', start: index, end: close + 3, selfClosing: false }
  }
  if (text.startsWith('<?', index)) {
    const close = text.indexOf('?>', index + 2)
    if (close < 0) {
      ctx.parseError('unterminated XML processing instruction', spanAt(ctx, index, text.length))
      return { kind: 'other', name: '', start: index, end: text.length, selfClosing: false }
    }
    return { kind: 'other', name: '', start: index, end: close + 2, selfClosing: false }
  }
  if (text.startsWith('<!', index)) {
    const end = scanDeclaration(text, index)
    if (end >= text.length) ctx.parseError('unterminated XML declaration', spanAt(ctx, index, text.length))
    return { kind: 'other', name: '', start: index, end, selfClosing: false }
  }
  if (text.startsWith('</', index)) {
    let cursor = index + 2
    const nameStart = cursor
    while (cursor < text.length && isXmlNameChar(text.charCodeAt(cursor))) cursor += 1
    if (cursor === nameStart) {
      ctx.parseError('malformed closing tag', spanAt(ctx, index, Math.min(text.length, index + 2)))
      return { kind: 'other', name: '', start: index, end: Math.min(text.length, index + 1), selfClosing: false }
    }
    const name = text.slice(nameStart, cursor)
    const close = text.indexOf('>', cursor)
    if (close < 0) {
      ctx.parseError(`unterminated closing tag </${name}>`, spanAt(ctx, index, text.length))
      return { kind: 'end', name, start: index, end: text.length, selfClosing: false }
    }
    return { kind: 'end', name, start: index, end: close + 1, selfClosing: false }
  }

  let cursor = index + 1
  const nameStart = cursor
  while (cursor < text.length && isXmlNameChar(text.charCodeAt(cursor))) cursor += 1
  if (cursor === nameStart) {
    ctx.parseError('malformed XML tag', spanAt(ctx, index, Math.min(text.length, index + 1)))
    return { kind: 'other', name: '', start: index, end: Math.min(text.length, index + 1), selfClosing: false }
  }
  const name = text.slice(nameStart, cursor)
  let quote = ''
  while (cursor < text.length) {
    const character = text[cursor]
    if (quote.length > 0) {
      if (character === quote) quote = ''
      cursor += 1
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      cursor += 1
      continue
    }
    if (character === '>') {
      let before = cursor - 1
      while (before > index && isXmlWhitespace(text.charCodeAt(before))) before -= 1
      return {
        kind: 'start',
        name,
        start: index,
        end: cursor + 1,
        selfClosing: text[before] === '/',
      }
    }
    cursor += 1
  }
  ctx.parseError(`unterminated <${name}> tag`, spanAt(ctx, index, text.length))
  return { kind: 'start', name, start: index, end: text.length, selfClosing: false }
}

/** Skip a `<!DOCTYPE …>` style declaration, honouring `[...]` and quotes. */
function scanDeclaration(text: string, index: number): number {
  let quote = ''
  let brackets = 0
  let cursor = index + 2
  while (cursor < text.length) {
    const character = text[cursor]
    if (quote.length > 0) {
      if (character === quote) quote = ''
      cursor += 1
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      cursor += 1
      continue
    }
    if (character === '[') {
      brackets += 1
      cursor += 1
      continue
    }
    if (character === ']') {
      if (brackets > 0) brackets -= 1
      cursor += 1
      continue
    }
    if (character === '>' && brackets === 0) return cursor + 1
    cursor += 1
  }
  return text.length
}

function isXmlNameChar(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) || code === 95 || code === 58 ||
    code === 45 || code === 46 || code >= 0x80
}

function isXmlWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13
}
