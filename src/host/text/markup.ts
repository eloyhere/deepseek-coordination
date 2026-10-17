/**
 * Markup parsers: CSS, HTML and Markdown.
 *
 * All three are single-pass, `O(n)`, bounded by the shared `ParseContext`:
 * 1 MiB / 200k tokens / depth 256 / 2 s / 20k metadata nodes. They extract only
 * references, structure and body-free metadata — never raw content — so a later
 * layer can page the file through byte spans.
 *
 *  - CSS: `@import "x"`, `@import url(...)`, `url(...)` (excluding `data:`), and
 *    `/* … *\/` comments. CSS class selectors are **not** `Class`.
 *  - HTML: `<script src>`, `<link href>`, `<img src>` (case-insensitive tags and
 *    attributes, quoted or unquoted), headings, paragraphs, `<article>`,
 *    `<title>`/`<meta name="description">`, comments. Inline script/style bodies
 *    are skipped so their text cannot look like markup.
 *  - Markdown: inline/reference links and images, headings, paragraphs, fenced
 *    code blocks, YAML front matter (text keys only, no YAML engine), Pandoc
 *    fenced divs (`::: definition` / `require` / `meet` / `condition`), and
 *    `$...$`/`$$...$$` formulas. Fenced code, inline code and HTML comments are
 *    masked before link/formula scanning.
 *
 * Metadata rules: `name` from an explicit heading/title; `brief` only from an
 * explicit description field (front matter `description`/`abstract`, HTML
 * `meta[name=description]`); `usage`/`purpose` only from explicit front-matter
 * keys. Everything else stays empty and is reported `unverifiable`.
 */
import { AstTree } from '../../shared/ast.js'
import type { AstNode } from '../../shared/ast.js'
import type { SourceSpan } from '../../shared/ast.js'
import {
  MAX_BRIEF_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PURPOSE_LENGTH,
  MAX_USAGE_LENGTH,
  ParseContext,
  appendAstNode,
  createAstRoot,
  fragmentForSpan,
  pushNodeMetadata,
  referenceForSpan,
  sanitizeMetadataText,
} from './parser.js'
import type {
  CodeComment,
  DocumentMetadata,
  FileReference,
  FlatFragment,
  NodeMetadata,
  NodeReference,
  ParseOptions,
  ParseResult,
  Parser,
} from './parser.js'
import type {
  ConceptMetadata,
  OfficeConcept,
  StructuralConcept,
} from '../../shared/entity.js'
import type {
  CellValueType,
  ConditionForm,
  StructuralKind,
  StructuralRelation,
} from '../../shared/enum.js'
import { isStatementKind } from '../../shared/enum.js'
import { formulaMetadata, markdownCodeRanges, scanDollarFormulas } from './formula.js'
import type { Formula } from './formula.js'
import { splitTextLines, tokenize } from './tokenizer.js'
import type { TextLine } from './tokenizer.js'

/* ------------------------------------------------------------------------- *
 * Result shapes
 * ------------------------------------------------------------------------- */

/** One heading (Markdown `#`, HTML `<h1>`–`<h6>`). */
export interface HeadingInfo extends FlatFragment {
  level: number
  title: string
  span: SourceSpan
  reference?: NodeReference
}

/** One prose paragraph; `preview` is capped at 512 characters by the domain model. */
export interface ParagraphInfo extends FlatFragment {
  preview: string
  span: SourceSpan
}

/** One Pandoc fenced div, with nesting depth. */
export interface FencedDivInfo extends FlatFragment {
  name: string
  depth: number
  span: SourceSpan
  reference?: NodeReference
}

/** One front-matter key/value pair; the value remains raw text (no YAML engine). */
export interface FrontMatterEntry {
  key: string
  value: string
  span: SourceSpan
}

/** CSS result. */
export interface CssParseResult extends ParseResult {
  comments: CodeComment[]
}

/** HTML result. */
export interface HtmlParseResult extends ParseResult {
  headings: HeadingInfo[]
  paragraphs: ParagraphInfo[]
  comments: CodeComment[]
}

/** Markdown result. */
export interface MarkdownParseResult extends ParseResult {
  headings: HeadingInfo[]
  paragraphs: ParagraphInfo[]
  divs: FencedDivInfo[]
  frontMatter: FrontMatterEntry[]
  comments: CodeComment[]
  formulas: Formula[]
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

const MAX_PARAGRAPH_PREVIEW = 512

function lineSpan(line: TextLine, start: number, end: number): SourceSpan {
  return {
    start,
    end,
    line: line.number,
    column: start - line.start + 1,
  }
}

function lineCommentBrief(body: string): string {
  return sanitizeMetadataText(firstNonEmptyLine(body), MAX_BRIEF_LENGTH)
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
}

/** Replace every character in the given ranges with a space, preserving newlines. */
function maskRanges(text: string, ranges: readonly SourceSpan[]): string {
  if (ranges.length === 0) return text
  const characters = text.split('')
  for (const range of ranges) {
    for (let index = Math.max(0, range.start); index < Math.min(characters.length, range.end); index += 1) {
      const code = text.charCodeAt(index)
      if (code !== 10 && code !== 13) characters[index] = ' '
    }
  }
  return characters.join('')
}

/** HTML comment ranges (`<!-- … -->`), including the delimiters. */
function htmlCommentRanges(text: string): { ranges: SourceSpan[]; comments: CodeComment[] } {
  const ranges: SourceSpan[] = []
  const comments: CodeComment[] = []
  const lines = splitTextLines(text)
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('<!--', index)
    if (open < 0) break
    const close = text.indexOf('-->', open + 4)
    const end = close < 0 ? text.length : close + 3
    const line = lineAtOffset(lines, open)
    const span: SourceSpan = { start: open, end, line: line.number, column: open - line.start + 1 }
    ranges.push(span)
    const body = text.slice(open + 4, close < 0 ? text.length : close)
    comments.push({
      style: 'html',
      brief: lineCommentBrief(body),
      span,
      attachment: 'orphan',
    })
    index = end
  }
  return { ranges, comments }
}

function lineAtOffset(lines: readonly TextLine[], offset: number): TextLine {
  let low = 0
  let high = lines.length - 1
  let candidate = 0
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (lines[middle].start <= offset) {
      candidate = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return lines[candidate] ?? { start: 0, end: 0, text: '', number: 1 }
}

function documentMetadata(
  form: DocumentMetadata['form'],
  source: DocumentMetadata['source'],
  title: string | undefined,
  author: string | undefined,
  metadata: Record<string, string> | undefined,
): DocumentMetadata | undefined {
  const cleanTitle = title === undefined ? undefined : sanitizeMetadataText(title, MAX_NAME_LENGTH)
  const cleanAuthor = author === undefined ? undefined : sanitizeMetadataText(author, MAX_NAME_LENGTH)
  if (form === 'unknown' && cleanTitle === undefined && cleanAuthor === undefined && metadata === undefined) {
    return undefined
  }
  return {
    form,
    source,
    ...(cleanTitle === undefined || cleanTitle.length === 0 ? {} : { title: cleanTitle }),
    ...(cleanAuthor === undefined || cleanAuthor.length === 0 ? {} : { author: cleanAuthor }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

/** File-backed reference for a document node, or undefined without a path. */
function documentReference(
  ctx: ParseContext,
  target: string | undefined,
  span: SourceSpan,
  scheme: 'file' | 'symbol',
  parserId: string,
): NodeReference | undefined {
  if (ctx.path === undefined) return undefined
  try {
    return referenceForSpan(ctx, {
      scheme,
      target: target ?? `${ctx.path}#span:${span.start}`,
      span,
      parserId,
    })
  } catch {
    return undefined
  }
}

function pushDocumentMetadata(
  ctx: ParseContext,
  nodes: NodeMetadata[],
  input: Parameters<typeof pushNodeMetadata>[2],
): NodeMetadata | undefined {
  return pushNodeMetadata(ctx, nodes, input)
}

function reportMissingBrief(ctx: ParseContext, count: number, span: SourceSpan | undefined): void {
  if (count === 0) return
  ctx.unverifiable(
    `metadata brief missing on ${count} node(s); left empty (explicit description fields only)`,
    span,
  )
}

/* ------------------------------------------------------------------------- *
 * Structural concept helpers (docs/domain-extraction-v24.md)
 * ------------------------------------------------------------------------- */

/** Maximum locators kept in one concept list field (authoritative link is `partOf`). */
export const MAX_CONCEPT_LIST = 16
/** Maximum author/editor names kept on one work concept. */
export const MAX_CONCEPT_NAMES = 8
/** Maximum condition concepts extracted from one file. */
export const MAX_CONCEPT_CONDITIONS = 256
/** Maximum paragraph nodes one Markdown file may contribute (domain-model cap). */
export const MAX_MARKDOWN_PARAGRAPHS = 2_000
/** Maximum CSV/TSV cell nodes one file may contribute. */
export const MAX_CSV_CELLS = 5_000
/** Maximum CSV/TSV columns read per row. */
export const MAX_CSV_COLUMNS = 1_024
/** Maximum CSV/TSV rows inspected. */
export const MAX_CSV_ROWS = 100_000

/**
 * Build the natural locator of one concept inside a parse, e.g.
 * `document:docs/a.md/chapter:2` or `module:src/a.ts/condition:1`.
 *
 * Locators are parser-internal natural keys; `partOf`/`contains` reference
 * them. They are never public handles and never leave the host tuple
 * `(path, kind, locator)` that `node-registry.ts` hashes.
 */
export function structuralLocator(
  path: string | undefined,
  kind: string,
  key: string | number,
  scope: 'document' | 'module' = 'document',
): string {
  const normalized = path?.replace(/\\/g, '/')
  const root = normalized === undefined ? scope : `${scope}:${normalized}`
  return `${root}/${kind}:${key}`
}

/**
 * Split an explicit front-matter name list. Commas, semicolons and the English
 * conjunction `and` separate names; surrounding brackets/quotes are stripped.
 * A name is never invented: an empty list returns `[]`.
 */
export function parseExplicitNameList(value: string): string[] {
  const trimmed = value.trim().replace(/^\[/, '').replace(/\]$/, '').trim()
  if (trimmed.length === 0) return []
  return trimmed
    .split(/\s*(?:;|,|\band\b)\s*/i)
    .map((part) => part.trim().replace(/^["']|["']$/g, '').trim())
    .filter((part) => part.length > 0)
}

/** Sanitise one concept string; empty becomes undefined (never fabricated). */
function conceptText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const clean = sanitizeMetadataText(value, MAX_NAME_LENGTH)
  return clean.length === 0 ? undefined : clean
}

/** Sanitise and cap a concept string list; empty becomes undefined. */
function conceptList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  const clean: string[] = []
  for (const value of values) {
    const text = conceptText(value)
    if (text === undefined || clean.includes(text)) continue
    clean.push(text)
    if (clean.length >= MAX_CONCEPT_LIST) break
  }
  return clean.length === 0 ? undefined : clean
}

/** Attach a concept to a node; a no-op when the node was dropped by the cap. */
function setDomain(node: NodeMetadata | undefined, concept: ConceptMetadata): void {
  if (node === undefined) return
  node.domain = concept
}

/** Try to attach a concept without exceeding the metadata cap. */
function domainNode(
  ctx: ParseContext,
  nodes: NodeMetadata[],
  input: Parameters<typeof pushNodeMetadata>[2],
  concept: ConceptMetadata,
): NodeMetadata | undefined {
  const node = pushNodeMetadata(ctx, nodes, input)
  setDomain(node, concept)
  return node
}

/** Add `child` to the `contains` list of `parent` in a concept-children map. */
function addConceptChild(
  children: Map<string, string[]>,
  parent: string | undefined,
  child: string,
): void {
  if (parent === undefined) return
  const list = children.get(parent)
  if (list === undefined) {
    children.set(parent, [child])
    return
  }
  if (!list.includes(child) && list.length < MAX_CONCEPT_LIST) list.push(child)
}

/** Copy the collected child locators onto every concept that owns them. */
function finalizeConceptChildren(
  children: ReadonlyMap<string, string[]>,
  concepts: readonly StructuralConcept[],
): void {
  for (const concept of concepts) {
    if (concept.locator === undefined) continue
    const list = children.get(concept.locator)
    if (list !== undefined && list.length > 0) concept.contains = [...list]
  }
}

/** Front-matter keys that hold comma/`and`-separated name lists. */
const LIST_FRONT_MATTER_KEYS: ReadonlySet<string> = new Set([
  'author', 'authors', 'editor', 'editors', 'keyword', 'keywords',
  'requires', 'requirement', 'requirements', 'meets', 'ensure', 'ensures',
])

/** Form mapping for a Pandoc fenced-div condition name; never guesses. */
function conditionFormOf(name: string): { form: ConditionForm; relation?: StructuralRelation } | undefined {
  switch (name) {
    case 'precondition':
      return { form: 'precondition', relation: 'requires' }
    case 'postcondition':
      return { form: 'postcondition' }
    case 'invariant':
      return { form: 'invariant', relation: 'requires' }
    case 'guard':
      return { form: 'guard', relation: 'requires' }
    case 'assumption':
      return { form: 'assumption' }
    case 'hypothesis':
      return { form: 'hypothesis' }
    case 'constraint':
      return { form: 'constraint', relation: 'requires' }
    case 'goal':
      return { form: 'goal' }
    case 'pre':
      return { form: 'precondition', relation: 'requires' }
    case 'post':
      return { form: 'postcondition' }
    case 'require':
      return { form: 'unknown', relation: 'requires' }
    case 'meet':
    case 'meets':
      return { form: 'unknown', relation: 'meets' }
    case 'condition':
      return { form: 'unknown' }
    default:
      return undefined
  }
}

/** Structural kinds a Pandoc fenced div may declare explicitly. */
const DIV_STRUCTURAL_KINDS: ReadonlySet<string> = new Set([
  'book', 'part', 'chapter', 'article', 'section', 'paragraph',
])

/** Merge explicit front matter into the `DocumentMetadata.form` field. */
function documentFormOf(metadata: Record<string, string> | undefined): DocumentMetadata['form'] {
  return documentFormFromMetadata(metadata)
}

/* ------------------------------------------------------------------------- *
 * CSS
 * ------------------------------------------------------------------------- */

/**
 * Parse CSS. `O(n)` single pass; `@import` wins over `url(...)` for the same
 * construct because the `@import` branch consumes the whole statement.
 */
export function parseCss(text: string, options: ParseOptions = {}): CssParseResult {
  const ctx = new ParseContext(text, options)
  const scanned = tokenize(ctx.text, {
    maxTokens: ctx.maxTokens,
    shouldStop: ctx.shouldStop,
    lineComments: [],
    blockComments: [['/*', '*/']],
    stringDelimiters: ['"', "'"],
  })
  ctx.tokens = scanned.tokens.length
  if (scanned.truncated && scanned.tokens.length >= ctx.maxTokens) {
    ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
  }
  const references: FileReference[] = []
  const comments: CodeComment[] = []
  const source = ctx.text
  let index = 0
  let lastCheck = 0

  const add = (kind: FileReference['kind'], value: string, start: number, end: number, attributes?: Record<string, string>): void => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    if (trimmed.toLowerCase().startsWith('data:')) return // binary payload, never a file dependency
    const span = specifierSpan(source, start, end, trimmed)
    references.push({
      kind,
      specifier: trimmed,
      external: isExternal(trimmed),
      span,
      ...(attributes === undefined ? {} : { attributes }),
      ...fragmentForSpan(ctx, span),
    })
  }

  while (index < source.length) {
    if (index - lastCheck >= 2_048) {
      lastCheck = index
      if (!ctx.checkpoint()) break
    }
    const code = source.charCodeAt(index)
    if (code === 47 && source.charCodeAt(index + 1) === 42) {
      const close = source.indexOf('*/', index + 2)
      const end = close < 0 ? source.length : close + 2
      const line = lineAtOffset(splitTextLines(source), index)
      const span = lineSpan(line, index, end)
      const body = source.slice(index + 2, close < 0 ? source.length : close)
      comments.push({
        style: 'block',
        brief: lineCommentBrief(body),
        span,
        attachment: 'orphan',
      })
      index = end
      continue
    }
    if (code === 34 || code === 39) {
      index = skipQuoted(source, index)
      continue
    }
    if (code === 64 && source.slice(index, index + 7).toLowerCase() === '@import' && !isIdentCode(source.charCodeAt(index + 7))) {
      const consumed = consumeCssImport(source, index + 7)
      if (consumed !== undefined) {
        add('css-import', consumed.value, consumed.valueStart, consumed.valueEnd, consumed.attributes)
        index = consumed.end
        continue
      }
    }
    if ((code === 117 || code === 85) && source.slice(index, index + 4).toLowerCase() === 'url(' && !isIdentCode(source.charCodeAt(index - 1))) {
      const consumed = consumeUrl(source, index + 4)
      if (consumed !== undefined) {
        add('css-url', consumed.value, consumed.valueStart, consumed.valueEnd)
        index = consumed.end
        continue
      }
    }
    index += 1
  }

  ctx.tokens = scanned.tokens.length
  const root = createAstRoot('stylesheet', ctx.text.length)
  for (const reference of references) {
    appendAstNode(ctx, root, reference.kind === 'css-import' ? 'import' : 'url', reference.span, reference.specifier)
  }
  for (const comment of comments) {
    appendAstNode(ctx, root, 'comment', comment.span, comment.brief)
  }
  return { ...ctx.finalize({ parserId: 'css', references, ast: new AstTree(root), nodes: [] }), comments }
}

/* ------------------------------------------------------------------------- *
 * HTML
 * ------------------------------------------------------------------------- */

interface HtmlTag {
  name: string
  attributes: Map<string, { value: string; start: number; end: number }>
  start: number
  end: number
  closing: boolean
  selfClosing: boolean
}

/** Parse one tag starting at `<`; returns undefined when it is not a tag. */
function readHtmlTag(text: string, start: number): HtmlTag | undefined {
  if (text.charCodeAt(start) !== 60) return undefined
  let cursor = start + 1
  const closing = text[cursor] === '/'
  if (closing) cursor += 1
  const nameStart = cursor
  while (cursor < text.length && isTagNameCode(text.charCodeAt(cursor))) cursor += 1
  if (cursor === nameStart) return undefined
  const name = text.slice(nameStart, cursor).toLowerCase()
  const attributes = new Map<string, { value: string; start: number; end: number }>()
  let selfClosing = false
  while (cursor < text.length) {
    while (cursor < text.length && isWhitespaceCode(text.charCodeAt(cursor))) cursor += 1
    if (cursor >= text.length) break
    const code = text.charCodeAt(cursor)
    if (code === 62) {
      cursor += 1
      break
    }
    if (code === 47) {
      selfClosing = true
      cursor += 1
      continue
    }
    const attributeStart = cursor
    while (cursor < text.length) {
      const next = text.charCodeAt(cursor)
      if (isWhitespaceCode(next) || next === 61 || next === 62 || next === 47) break
      cursor += 1
    }
    if (cursor === attributeStart) {
      cursor += 1
      continue
    }
    const attributeName = text.slice(attributeStart, cursor).toLowerCase()
    while (cursor < text.length && isWhitespaceCode(text.charCodeAt(cursor))) cursor += 1
    if (text.charCodeAt(cursor) !== 61) {
      attributes.set(attributeName, { value: '', start: attributeStart, end: attributeStart })
      continue
    }
    cursor += 1
    while (cursor < text.length && isWhitespaceCode(text.charCodeAt(cursor))) cursor += 1
    const quote = text.charCodeAt(cursor)
    if (quote === 34 || quote === 39) {
      const valueStart = cursor + 1
      const close = text.indexOf(String.fromCharCode(quote), valueStart)
      const valueEnd = close < 0 ? text.length : close
      attributes.set(attributeName, { value: text.slice(valueStart, valueEnd), start: valueStart, end: valueEnd })
      cursor = close < 0 ? text.length : close + 1
      continue
    }
    const valueStart = cursor
    while (cursor < text.length) {
      const next = text.charCodeAt(cursor)
      if (isWhitespaceCode(next) || next === 62) break
      cursor += 1
    }
    attributes.set(attributeName, { value: text.slice(valueStart, cursor), start: valueStart, end: cursor })
  }
  return { name, attributes, start, end: cursor, closing, selfClosing }
}

/** Parse HTML: references, headings, paragraphs, title/description/article. */
export function parseHtml(text: string, options: ParseOptions = {}): HtmlParseResult {
  const ctx = new ParseContext(text, options)
  const scanned = tokenize(ctx.text, {
    maxTokens: ctx.maxTokens,
    shouldStop: ctx.shouldStop,
    lineComments: [],
    blockComments: [['<!--', '-->']],
    stringDelimiters: ['"', "'"],
  })
  ctx.tokens = scanned.tokens.length
  if (scanned.truncated && scanned.tokens.length >= ctx.maxTokens) {
    ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
  }
  const source = ctx.text
  const lines = splitTextLines(source)
  const references: FileReference[] = []
  const headings: HeadingInfo[] = []
  const paragraphs: ParagraphInfo[] = []
  const comments: CodeComment[] = []
  const nodes: NodeMetadata[] = []
  let title: string | undefined
  let titleSpan: SourceSpan | undefined
  let description: string | undefined
  let article = false
  let index = 0
  let lastCheck = 0

  /*
   * Structural containers: `<article>`/`<main>` (the Article work node) and
   * nested `<section>` elements. A heading names its enclosing section only when
   * no other content precedes it, and never invents a name.
   */
  const hasArticleElement = /<\s*article\b/i.test(source)
  const conceptOrdinals = new Map<string, number>()
  const nextConceptOrdinal = (kind: string): number => {
    const next = (conceptOrdinals.get(kind) ?? 0) + 1
    conceptOrdinals.set(kind, next)
    return next
  }
  const conceptChildren = new Map<string, string[]>()
  const concepts: StructuralConcept[] = []
  interface HtmlContainer {    name: 'article' | 'main' | 'section'
    start: number
    level: number
    locator?: string
    concept?: StructuralConcept
    title?: string
  }
  const openContainers: HtmlContainer[] = []
  let workLocator: string | undefined
  let paragraphNodeCount = 0
  let missingBrief = 0
  let firstSpan: SourceSpan | undefined
  const root = createAstRoot('document', ctx.text.length)

  const containerParent = (): string | undefined => {
    for (let cursor = openContainers.length - 1; cursor >= 0; cursor -= 1) {
      const locator = openContainers[cursor].locator
      if (locator !== undefined) return locator
    }
    return undefined
  }

  const emitContainerNode = (container: HtmlContainer, end: number): void => {
    const concept = container.concept
    if (container.locator === undefined || concept === undefined) return
    const span = lineSpan(lineAtOffset(lines, container.start), container.start, end)
    const name = container.name === 'section' ? container.title : (title ?? container.title)
    const reference = documentReference(ctx, undefined, span, 'symbol', 'html')
    const node = domainNode(ctx, nodes, {
      kind: concept.kind,
      locator: container.locator,
      ...(name === undefined ? {} : { name }),
      ...(reference === undefined ? {} : { reference }),
      ...fragmentForSpan(ctx, span),
      source: 'html',
      span,
    }, concept)
    if (node !== undefined) {
      concepts.push(concept)
      if (concept.partOf !== undefined) addConceptChild(conceptChildren, concept.partOf, container.locator)
      if (concept.kind === 'article' && workLocator === undefined) workLocator = container.locator
    }
    missingBrief += 1
    firstSpan ??= span
    appendAstNode(ctx, root, concept.kind, span, name)
  }

  while (index < source.length) {
    if (index - lastCheck >= 2_048) {
      lastCheck = index
      if (!ctx.checkpoint()) break
    }
    if (source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4)
      const end = close < 0 ? source.length : close + 3
      const span = lineSpan(lineAtOffset(lines, index), index, end)
      comments.push({
        style: 'html',
        brief: lineCommentBrief(source.slice(index + 4, close < 0 ? source.length : close)),
        span,
        attachment: 'orphan',
      })
      index = end
      continue
    }
    if (source.charCodeAt(index) !== 60) {
      index += 1
      continue
    }
    const tag = readHtmlTag(source, index)
    if (tag === undefined) {
      index += 1
      continue
    }
    if (tag.closing) {
      if (tag.name === 'article' || tag.name === 'main' || tag.name === 'section') {
        for (let cursor = openContainers.length - 1; cursor >= 0; cursor -= 1) {
          if (openContainers[cursor].name !== tag.name) continue
          const [container] = openContainers.splice(cursor, 1)
          if (container !== undefined) emitContainerNode(container, tag.end)
          break
        }
      }
      index = tag.end
      continue
    }
    if (tag.name === 'article' || tag.name === 'main' || tag.name === 'section') {
      if (tag.name !== 'section') article = true
      // A `<main>` that wraps `<article>` elements is a transparent container.
      if (tag.name === 'main' && hasArticleElement) {
        openContainers.push({ name: 'main', start: tag.start, level: 0 })
        index = tag.end
        continue
      }
      const kind: 'article' | 'section' = tag.name === 'section' ? 'section' : 'article'
      const ordinal = nextConceptOrdinal(kind)
      const locator = structuralLocator(ctx.path, kind, ordinal)
      const parent = kind === 'section' ? containerParent() : undefined
      const level = kind === 'section'
        ? openContainers.filter((entry) => entry.name === 'section').length + 1
        : 0
      const concept: StructuralConcept = {
        kind,
        locator,
        ordinal,
        explicit: true,
        ...(level > 0 ? { level } : {}),
        ...(parent === undefined ? {} : { partOf: parent }),
      }
      openContainers.push({ name: tag.name, start: tag.start, level, locator, concept })
      if (kind === 'article' && workLocator === undefined) workLocator = locator
      addConceptChild(conceptChildren, parent, locator)
      index = tag.end
      continue
    }
    if (tag.name === 'title') {
      const close = /<\/title\s*>/i.exec(source.slice(tag.end))
      const end = close === null ? source.length : tag.end + close.index
      title = stripTags(source.slice(tag.end, end)).trim()
      titleSpan = lineSpan(lineAtOffset(lines, tag.start), tag.start, close === null ? end : end + close[0].length)
      index = close === null ? source.length : end + close[0].length
      continue
    }
    if (tag.name === 'meta') {
      const name = tag.attributes.get('name')?.value.toLowerCase()
      const content = tag.attributes.get('content')
      if (name === 'description' && content !== undefined) description = content.value
      index = tag.end
      continue
    }
    const sourceAttribute = sourceSpecifier(tag, 'src')
    const hrefAttribute = sourceSpecifier(tag, 'href')
    if (tag.name === 'script') {
      if (sourceAttribute !== undefined) {
        addHtmlReference(ctx, references, 'html-script', tag, sourceAttribute, tag.attributes.get('type')?.value)
      } else {
        const close = findClosingTag(source, tag.end, 'script')
        index = close
        continue
      }
    } else if (tag.name === 'link') {
      if (hrefAttribute !== undefined) {
        addHtmlReference(ctx, references, 'html-link', tag, hrefAttribute, tag.attributes.get('rel')?.value)
      }
    } else if (tag.name === 'img') {
      if (sourceAttribute !== undefined) addHtmlReference(ctx, references, 'html-image', tag, sourceAttribute)
    } else if (/^h[1-6]$/.test(tag.name)) {
      const level = Number(tag.name.slice(1))
      const close = new RegExp(`</${tag.name}\\s*>`, 'i').exec(source.slice(tag.end))
      const contentEnd = close === null ? source.length : tag.end + close.index
      const span = lineSpan(lineAtOffset(lines, index), index, close === null ? contentEnd : contentEnd + close[0].length)
      const heading: HeadingInfo = {
        level,
        title: stripTags(source.slice(tag.end, contentEnd)).trim(),
        span,
        ...fragmentForSpan(ctx, span),
      }
      heading.reference = documentReference(ctx, undefined, span, 'symbol', 'html')
      headings.push(heading)
      const headingNode = pushDocumentMetadata(ctx, nodes, {
        kind: 'heading',
        name: heading.title,
        ...(heading.reference === undefined ? {} : { reference: heading.reference }),
        fragment: heading,
        source: 'heading',
        span,
      })
      missingBrief += 1
      firstSpan ??= span
      appendAstNode(ctx, root, 'heading', span, heading.title)
      /*
       * A heading that is the first content of `<article>`/`<section>` is that
       * container's label, not a nested second concept: reuse the container
       * concept and give the heading node its domain. Only when other content
       * precedes the heading is it a separate Section.
       */
      let naming: HtmlContainer | undefined
      for (let cursor = openContainers.length - 1; cursor >= 0; cursor -= 1) {
        const container = openContainers[cursor]
        if (container.locator === undefined || container.concept === undefined) continue
        if (container.title === undefined && onlyMarkupBetween(source, container.start, tag.start)) {
          container.title = heading.title
          naming = container
        }
        break
      }
      if (naming !== undefined && naming.concept !== undefined) {
        setDomain(headingNode, naming.concept)
      } else {
        const parent = containerParent()
        const ordinal = nextConceptOrdinal('section')
        const locator = structuralLocator(ctx.path, 'section', ordinal)
        const concept: StructuralConcept = {
          kind: 'section',
          locator,
          ordinal,
          level,
          explicit: true,
          ...(parent === undefined ? {} : { partOf: parent }),
        }
        setDomain(headingNode, concept)
        concepts.push(concept)
        addConceptChild(conceptChildren, parent, locator)
      }
      index = close === null ? contentEnd : contentEnd + close[0].length
      continue
    } else if (tag.name === 'p') {
      const close = /<\/p\s*>/i.exec(source.slice(tag.end))
      const contentEnd = close === null ? source.length : tag.end + close.index
      const span = lineSpan(lineAtOffset(lines, index), index, close === null ? contentEnd : contentEnd + close[0].length)
      const paragraph: ParagraphInfo = {
        preview: stripTags(source.slice(tag.end, contentEnd)).replace(/\s+/g, ' ').trim().slice(0, MAX_PARAGRAPH_PREVIEW),
        span,
        ...fragmentForSpan(ctx, span),
      }
      paragraphs.push(paragraph)
      if (paragraphNodeCount < MAX_MARKDOWN_PARAGRAPHS) {
        paragraphNodeCount += 1
        const parent = containerParent() ?? workLocator
        const ordinal = nextConceptOrdinal('paragraph')
        const locator = structuralLocator(ctx.path, 'paragraph', ordinal)
        const concept: StructuralConcept = {
          kind: 'paragraph',
          locator,
          ordinal,
          explicit: true,
          ...(parent === undefined ? {} : { partOf: parent }),
        }
        const reference = documentReference(
          ctx,
          `${ctx.path ?? 'text'}#paragraph:${ordinal}`,
          span,
          'symbol',
          'html',
        )
        const node = domainNode(ctx, nodes, {
          kind: 'paragraph',
          locator,
          ...(reference === undefined ? {} : { reference }),
          fragment: paragraph,
          source: 'paragraph',
          span,
        }, concept)
        if (node !== undefined) {
          concepts.push(concept)
          addConceptChild(conceptChildren, parent, locator)
        }
      }
      index = close === null ? contentEnd : contentEnd + close[0].length
      continue
    }
    if (tag.name === 'style') {
      const close = findClosingTag(source, tag.end, 'style')
      index = close
      continue
    }
    index = tag.end
  }

  // Unclosed containers still end at EOF; nesting is never guessed from text.
  while (openContainers.length > 0) {
    const container = openContainers.pop()
    if (container !== undefined) emitContainerNode(container, source.length)
  }
  finalizeConceptChildren(conceptChildren, concepts)

  const documentForm: DocumentMetadata['form'] = article ? 'article' : 'unknown'
  const metadata = documentMetadata(
    documentForm,
    title !== undefined || description !== undefined ? 'html' : 'none',
    title,
    undefined,
    undefined,
  )
  if (title !== undefined) {
    const span = titleSpan ?? { start: 0, end: 0, line: 1, column: 1 }
    const reference = documentReference(ctx, ctx.path, span, 'file', 'html')
    pushDocumentMetadata(ctx, nodes, {
      kind: 'document',
      name: title,
      brief: description,
      ...(reference === undefined ? {} : { reference }),
      ...fragmentForSpan(ctx, span),
      source: description === undefined ? 'html' : 'html',
      span,
    })
    if (description === undefined) {
      missingBrief += 1
      firstSpan ??= span
    }
    appendAstNode(ctx, root, 'document', span, title)
  }
  for (const comment of comments) appendAstNode(ctx, root, 'comment', comment.span, comment.brief)
  reportMissingBrief(ctx, missingBrief, firstSpan)
  return {
    ...ctx.finalize({
      parserId: 'html',
      references,
      ast: new AstTree(root),
      nodes,
      ...(metadata === undefined ? {} : { document: metadata }),
    }),
    headings,
    paragraphs,
    comments,
  }
}

/* ------------------------------------------------------------------------- *
 * Markdown
 * ------------------------------------------------------------------------- */

interface LinkDefinition {
  destination: string
  title?: string
  span: SourceSpan
  used: boolean
}

/** Parse Markdown into references, structure, front matter, divs and formulas. */
export function parseMarkdown(text: string, options: ParseOptions = {}): MarkdownParseResult {
  const ctx = new ParseContext(text, options)
  const scanned = tokenize(ctx.text, {
    maxTokens: ctx.maxTokens,
    shouldStop: ctx.shouldStop,
    lineComments: [],
    blockComments: [['<!--', '-->']],
    stringDelimiters: ['"', "'", '`'],
  })
  ctx.tokens = scanned.tokens.length
  if (scanned.truncated && scanned.tokens.length >= ctx.maxTokens) {
    ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
  }
  const source = ctx.text
  const lines = splitTextLines(source)
  const code = markdownCodeRanges(source)
  const html = htmlCommentRanges(source)
  const masks = [...code.fences, ...code.inline, ...html.ranges]
  const masked = maskRanges(source, masks)
  const maskedLines = splitTextLines(masked)

  const references: FileReference[] = []
  const headings: HeadingInfo[] = []
  const paragraphs: ParagraphInfo[] = []
  const divs: FencedDivInfo[] = []
  const comments: CodeComment[] = [...html.comments]
  const frontMatter: FrontMatterEntry[] = []
  const nodes: NodeMetadata[] = []

  let bodyStartLine = 0
  let frontMetadata: Record<string, string> | undefined
  let title: string | undefined

  if (maskedLines.length > 0 && maskedLines[0].text.trim() === '---') {
    const closeIndex = findFrontMatterClose(maskedLines)
    if (closeIndex < 0) {
      ctx.unverifiable('front matter has no closing delimiter; treated as body', lineSpan(lines[0], lines[0].start, lines[0].end))
    } else {
      for (let index = 1; index < closeIndex; index += 1) {
        const original = lines[index]
        if (original === undefined) continue
        const entry = parseFrontMatterEntry(original)
        if (entry === undefined) continue
        // A YAML block list (`author:` then `  - Ada`) is still explicit text:
        // collect it into the same entry value, no YAML engine involved.
        if (entry.value.length === 0 && LIST_FRONT_MATTER_KEYS.has(entry.key.toLowerCase())) {
          const collected: string[] = []
          let cursor = index + 1
          while (cursor < closeIndex) {
            const continuation = /^\s*-\s+(.*)$/.exec(lines[cursor]?.text ?? '')
            if (continuation === null) break
            const value = continuation[1].trim().replace(/^["']|["']$/g, '').trim()
            if (value.length > 0) collected.push(value)
            cursor += 1
          }
          if (collected.length > 0) {
            entry.value = collected.join('; ')
            index = cursor - 1
          }
        }
        frontMatter.push(entry)
        frontMetadata ??= {}
        frontMetadata[entry.key] = entry.value
      }
      bodyStartLine = closeIndex + 1
      title = frontMetadata?.title
    }
  }

  /*
   * Structural domain concepts (`docs/domain-extraction-v24.md` §2). A plan is
   * computed before the body scan so paragraphs can point at their enclosing
   * concept; nothing here is inferred from prose.
   */
  const isSummary = isSummaryPath(ctx.path)
  const form: DocumentMetadata['form'] = isSummary && frontMetadata?.form === undefined
    ? 'book'
    : documentFormOf(frontMetadata)
  const conceptOrdinals = new Map<string, number>()
  const nextConceptOrdinal = (kind: string): number => {
    const next = (conceptOrdinals.get(kind) ?? 0) + 1
    conceptOrdinals.set(kind, next)
    return next
  }
  const conceptChildren = new Map<string, string[]>()
  const concepts: StructuralConcept[] = []
  const outlineStack: Array<{ level: number; locator: string }> = []
  const workPlan = planMarkdownWork(
    frontMetadata,
    form,
    title,
    isSummary,
    hasMarkdownBody(maskedLines, bodyStartLine),
    ctx.path,
  )
  const workLocator = workPlan.primary?.locator
  const frontMatterSpan: SourceSpan | undefined = frontMatter.length > 0 && lines[0] !== undefined
    ? {
        start: lines[0].start,
        end: lines[Math.min(lines.length - 1, Math.max(0, bodyStartLine - 1))]?.end ?? lines[0].end,
        line: 1,
        column: 1,
      }
    : undefined
  let paragraphNodeCount = 0
  let paragraphCapReported = false
  let frontMatterConditionCount = 0

  const definitions = new Map<string, LinkDefinition>()
  for (let index = bodyStartLine; index < maskedLines.length; index += 1) {
    const line = maskedLines[index]
    const definition = parseLinkDefinition(line, source)
    if (definition === undefined) continue
    const key = normaliseLabel(definition.label)
    if (!definitions.has(key)) definitions.set(key, definition.definition)
  }

  const fenceLines = new Set<number>()
  const fenceStarts = new Map<number, { marker: string; length: number; info: string }>()
  for (const fence of code.fences) {
    const startLine = lineAtOffset(lines, fence.start).number
    const endLine = lineAtOffset(lines, Math.max(fence.start, fence.end - 1)).number
    for (let line = startLine; line <= endLine; line += 1) fenceLines.add(line)
    const startText = lines[startLine - 1]?.text.trimStart() ?? ''
    const startFence = matchFence(startText)
    if (startFence !== undefined) fenceStarts.set(startLine, startFence)
  }

  const divStack: Array<{ node?: AstNode<string>; fenceLength: number; info: FencedDivInfo }> = []
  let paragraphStart = -1
  let paragraphText: string[] = []
  let missingBrief = 0
  let firstMissingSpan: SourceSpan | undefined

  const flushParagraph = (): void => {
    if (paragraphStart < 0) return
    const first = lines[paragraphStart]
    const last = lines[Math.max(paragraphStart, (paragraphStart + paragraphText.length - 1) || paragraphStart)]
    if (first === undefined) {
      paragraphStart = -1
      paragraphText = []
      return
    }
    const span: SourceSpan = {
      start: first.start,
      end: last === undefined ? first.end : last.end,
      line: first.number,
      column: 1,
    }
    const preview = paragraphText.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PARAGRAPH_PREVIEW)
    paragraphs.push({ preview, span, ...fragmentForSpan(ctx, span) })
    if (paragraphNodeCount < MAX_MARKDOWN_PARAGRAPHS) {
      paragraphNodeCount += 1
      const ordinal = nextConceptOrdinal('paragraph')
      const locator = structuralLocator(ctx.path, 'paragraph', ordinal)
      const parent = outlineStack[outlineStack.length - 1]?.locator ?? workLocator
      const concept: StructuralConcept = {
        kind: 'paragraph',
        locator,
        ordinal,
        explicit: true,
        ...(parent === undefined ? {} : { partOf: parent }),
      }
      const reference = documentReference(
        ctx,
        `${ctx.path ?? 'text'}#paragraph:${ordinal}`,
        span,
        'symbol',
        'markdown',
      )
      const node = domainNode(ctx, nodes, {
        kind: 'paragraph',
        locator,
        ...(reference === undefined ? {} : { reference }),
        fragment: fragmentForSpan(ctx, span),
        source: 'paragraph',
        span,
      }, concept)
      if (node !== undefined) {
        concepts.push(concept)
        addConceptChild(conceptChildren, parent, locator)
      }
    } else if (!paragraphCapReported) {
      paragraphCapReported = true
      ctx.unverifiableOnce(
        'markdown-paragraph-cap',
        `paragraph concept limit ${MAX_MARKDOWN_PARAGRAPHS} reached; later paragraph nodes were dropped`,
        span,
      )
    }
    paragraphStart = -1
    paragraphText = []
  }

  const currentParent = (root: AstNode<string>): AstNode<string> => {
    const top = divStack[divStack.length - 1]
    return top?.node ?? root
  }

  const root = createAstRoot('document', ctx.text.length)

  for (let index = bodyStartLine; index < maskedLines.length; index += 1) {
    if ((index & 1_023) === 0 && !ctx.checkpoint()) break
    const maskedLine = maskedLines[index]
    const originalLine = lines[index] ?? maskedLine
    if (fenceLines.has(originalLine.number)) {
      // Fenced code: one code node on the opening line, nothing scanned inside.
      const startFence = fenceStarts.get(originalLine.number)
      if (startFence !== undefined) {
        const endLineNumber = fenceEndLine(lines, index, startFence.marker, startFence.length)
        const endLine = lines[Math.min(lines.length - 1, endLineNumber - 1)] ?? originalLine
        const span: SourceSpan = {
          start: originalLine.start,
          end: endLine.end,
          line: originalLine.number,
          column: 1,
        }
        appendAstNode(ctx, currentParent(root), 'code', span, startFence.info)
      }
      flushParagraph()
      continue
    }
    const trimmed = maskedLine.text.trim()
    if (trimmed.length === 0) {
      flushParagraph()
      continue
    }
    const div = matchDiv(originalLine.text.trimStart())
    if (div !== undefined) {
      flushParagraph()
      if (div.info.length > 0) {
        const name = div.info.replace(/^\{\.?/, '').replace(/\}$/, '').split(/[\s,]/)[0] ?? ''
        const span = lineSpan(originalLine, originalLine.start, originalLine.end)
        const info: FencedDivInfo = {
          name,
          depth: divStack.length + 1,
          span,
          ...fragmentForSpan(ctx, span),
        }
        info.reference = documentReference(ctx, undefined, span, 'symbol', 'markdown')
        const node = appendAstNode(ctx, currentParent(root), 'div', span, name)
        divs.push(info)
        divStack.push({ ...(node === undefined ? {} : { node }), fenceLength: div.length, info })
      } else {
        let popped = false
        while (divStack.length > 0) {
          const top = divStack[divStack.length - 1]
          if (div.length >= top.fenceLength) {
            const closed = divStack.pop()
            if (closed !== undefined) {
              closed.info.span = {
                start: closed.info.span.start,
                end: originalLine.end,
                line: closed.info.span.line,
                column: closed.info.span.column,
              }
              if (closed.node !== undefined) {
                closed.node.span = {
                  start: closed.node.span.start,
                  end: originalLine.end,
                  line: closed.node.span.line,
                  column: closed.node.span.column,
                }
              }
              Object.assign(closed.info, fragmentForSpan(ctx, closed.info.span))
            }
            popped = true
            break
          }
          divStack.pop()
        }
        if (!popped) continue
      }
      continue
    }
    const heading = matchHeading(maskedLine, originalLine)
    if (heading !== undefined) {
      flushParagraph()
      const span = heading.span
      const info: HeadingInfo = {
        level: heading.level,
        title: heading.title,
        span,
        ...fragmentForSpan(ctx, span),
      }
      info.reference = documentReference(ctx, undefined, span, 'symbol', 'markdown')
      headings.push(info)
      const headingNode = pushDocumentMetadata(ctx, nodes, {
        kind: 'heading',
        name: heading.title,
        ...(info.reference === undefined ? {} : { reference: info.reference }),
        fragment: info,
        source: 'heading',
        span,
      })
      missingBrief += 1
      firstMissingSpan ??= span
      appendAstNode(ctx, currentParent(root), 'heading', span, heading.title)
      if (!isSummary) {
        // Book chapter vs article/chapter section is explicit from the document
        // form plus heading level; no prose heuristic is involved.
        const kind: StructuralKind = form === 'book' && heading.level === 1 ? 'chapter' : 'section'
        const ordinal = nextConceptOrdinal(kind)
        const locator = structuralLocator(ctx.path, kind, ordinal)
        while (outlineStack.length > 0 && outlineStack[outlineStack.length - 1].level >= heading.level) {
          outlineStack.pop()
        }
        const parent = outlineStack[outlineStack.length - 1]?.locator ?? workLocator
        const concept: StructuralConcept = {
          kind,
          locator,
          ordinal,
          level: heading.level,
          explicit: true,
          ...(kind === 'chapter' ? { form: 'chapter' as const } : {}),
          ...(parent === undefined ? {} : { partOf: parent }),
        }
        setDomain(headingNode, concept)
        concepts.push(concept)
        addConceptChild(conceptChildren, parent, locator)
        outlineStack.push({ level: heading.level, locator })
      }
      continue
    }
    // Link reference definitions are targets, not prose or link usage.
    if (parseLinkDefinition(maskedLine, source) !== undefined) {
      flushParagraph()
      continue
    }
    // Links and images on this line.
    scanMarkdownLinks(ctx, maskedLine, originalLine, definitions, references)
    if (paragraphStart < 0) paragraphStart = index
    paragraphText.push(originalLine.text.trim())
  }
  flushParagraph()
  while (divStack.length > 0) divStack.pop()

  /*
   * Fenced divs are both a P0 syntax node (`kind='div'`, kept for the existing
   * chain relation code) and, when the marker names a concept, a semantic node
   * (`chapter`/`section`/`condition`/`definition`/...). Nesting is proven by
   * span containment plus the recorded fence depth.
   */
  const divStructuralParents: Array<string | undefined> = []
  for (let divIndex = 0; divIndex < divs.length; divIndex += 1) {
    const div = divs[divIndex]
    pushDocumentMetadata(ctx, nodes, {
      kind: 'div',
      ...(div.name.length === 0 ? {} : { name: div.name }),
      ...(div.reference === undefined ? {} : { reference: div.reference }),
      fragment: div,
      source: 'annotation',
      span: div.span,
    })
    missingBrief += 1
    firstMissingSpan ??= div.span

    const inheritedParent = ((): string | undefined => {
      for (let parentIndex = divIndex - 1; parentIndex >= 0; parentIndex -= 1) {
        const candidate = divs[parentIndex]
        if (candidate.span.start <= div.span.start && candidate.span.end >= div.span.end && candidate.depth < div.depth) {
          return divStructuralParents[parentIndex] ?? workLocator
        }
      }
      return workLocator
    })()
    divStructuralParents[divIndex] = inheritedParent

    const marker = div.name.toLowerCase()
    const attributes = divAttributes(source, div.span)
    let semanticKind: string | undefined
    let concept: StructuralConcept | undefined
    if (DIV_STRUCTURAL_KINDS.has(marker)) {
      semanticKind = marker
      const kind = marker as StructuralKind
      const ordinal = nextConceptOrdinal(kind)
      const locator = structuralLocator(ctx.path, kind, ordinal)
      concept = {
        kind,
        locator,
        ordinal,
        explicit: true,
        ...(kind === 'chapter' ? { form: 'chapter' as const } : {}),
        ...(inheritedParent === undefined ? {} : { partOf: inheritedParent }),
      }
      divStructuralParents[divIndex] = locator
      addConceptChild(conceptChildren, inheritedParent, locator)
    } else {
      const condition = conditionFormOf(marker)
      if (condition !== undefined) {
        semanticKind = 'condition'
        const ordinal = nextConceptOrdinal('condition')
        const locator = structuralLocator(ctx.path, 'condition', ordinal)
        concept = {
          kind: 'condition',
          locator,
          ordinal,
          form: condition.form,
          status: 'unknown',
          explicit: true,
          ...(condition.relation === undefined ? {} : { relation: condition.relation }),
          ...(inheritedParent === undefined ? {} : { partOf: inheritedParent }),
          ...(workLocator === undefined ? {} : { appliesTo: workLocator }),
        }
        addConceptChild(conceptChildren, inheritedParent, locator)
      } else if (isStatementKind(marker)) {
        semanticKind = marker
        const ordinal = nextConceptOrdinal(marker)
        const locator = structuralLocator(ctx.path, marker, ordinal)
        concept = {
          kind: marker,
          locator,
          ordinal,
          status: marker === 'axiom' ? 'axiomatic' : marker === 'proof' ? 'unverifiable' : 'stated',
          explicit: true,
          ...(marker === 'proof' ? { proofStatus: 'unverifiable' as const } : {}),
          ...(inheritedParent === undefined ? {} : { partOf: inheritedParent }),
        }
        addConceptChild(conceptChildren, inheritedParent, locator)
      }
    }
    if (semanticKind === undefined || concept === undefined) continue
    const displayName = attributes.title ?? attributes.id
    const semanticNode = domainNode(ctx, nodes, {
      kind: semanticKind,
      locator: concept.locator,
      ...(displayName === undefined ? {} : { name: displayName }),
      ...(attributes.id === undefined ? {} : { label: attributes.id }),
      ...(div.reference === undefined ? {} : { reference: div.reference }),
      fragment: div,
      source: 'annotation',
      span: div.span,
    }, concept)
    if (semanticNode !== undefined) concepts.push(concept)
  }

  // Definitions that were never used still reference a file.
  for (const definition of definitions.values()) {
    if (definition.used) continue
    references.push({
      kind: 'markdown-link',
      specifier: definition.destination,
      external: isExternal(definition.destination),
      span: definition.span,
      ...fragmentForSpan(ctx, definition.span),
    })
  }

  const excluded = [...code.fences, ...code.inline, ...html.ranges]
  const containerAt = (offset: number, delimiter: 'inline' | 'block' | 'cell' | 'environment'): 'heading' | 'paragraph' | 'block' => {
    for (const heading of headings) {
      if (offset >= heading.span.start && offset < heading.span.end) return 'heading'
    }
    return delimiter === 'inline' ? 'paragraph' : 'block'
  }
  const scan = scanDollarFormulas(source, {
    excluded,
    containerAt,
    dialect: 'markdown-math',
    shouldStop: ctx.shouldStop,
  })
  const formulas = scan.formulas
  if (scan.truncated) ctx.limit('token-limit', 'formula limit reached; later formulas were dropped')
  for (const formula of formulas) {
    if (formula.unverifiable) ctx.unverifiable(formula.reason ?? 'unverifiable formula', formula.span)
    const metadata = formulaMetadata(ctx, formula, 'markdown')
    pushDocumentMetadata(ctx, nodes, metadata)
    missingBrief += 1
    firstMissingSpan ??= formula.span
    appendAstNode(ctx, currentParent(root), 'formula', formula.span, formula.dialect)
  }

  /*
   * Front-matter condition lists (`requires:`/`meets:`). Only explicit items
   * become Condition concepts; the value text is metadata (brief), never body.
   */
  const frontEntry = (key: string): FrontMatterEntry | undefined =>
    frontMatter.find((entry) => entry.key.toLowerCase() === key)
  for (const key of ['requires', 'meets'] as const) {
    const value = frontMetadata?.[key]
    if (value === undefined) continue
    const span = frontEntry(key)?.span ?? frontMatterSpan ?? { start: 0, end: 0, line: 1, column: 1 }
    for (const item of parseExplicitNameList(value)) {
      if (frontMatterConditionCount >= MAX_CONCEPT_CONDITIONS) {
        ctx.unverifiableOnce(
          'markdown-condition-cap',
          `condition limit ${MAX_CONCEPT_CONDITIONS} reached; later conditions were dropped`,
          span,
        )
        break
      }
      frontMatterConditionCount += 1
      const ordinal = nextConceptOrdinal('condition')
      const locator = structuralLocator(ctx.path, 'condition', ordinal)
      const concept: StructuralConcept = {
        kind: 'condition',
        locator,
        ordinal,
        form: 'unknown',
        status: 'unknown',
        explicit: true,
        relation: key === 'requires' ? 'requires' : 'meets',
        ...(workLocator === undefined ? {} : { appliesTo: workLocator }),
      }
      const reference = documentReference(
        ctx,
        `${ctx.path ?? 'text'}#condition:${ordinal}`,
        span,
        'symbol',
        'markdown',
      )
      const node = domainNode(ctx, nodes, {
        kind: 'condition',
        locator,
        brief: item,
        ...(reference === undefined ? {} : { reference }),
        ...fragmentForSpan(ctx, span),
        source: 'front-matter',
        span,
      }, concept)
      if (node !== undefined) {
        concepts.push(concept)
        addConceptChild(conceptChildren, workLocator, locator)
      }
    }
  }

  /*
   * `SUMMARY.md` chapter list (documented P0 source). A heading names a Part;
   * a link list item names a Chapter at indentation 0 and a Section below it.
   * Only local (non-URL) targets are structural chapters.
   */
  if (isSummary) {
    const itemStack: Array<{ level: number; locator: string }> = []
    let currentPart: string | undefined
    for (let index = bodyStartLine; index < maskedLines.length; index += 1) {
      const original = lines[index]
      const maskedLine = maskedLines[index]
      if (original === undefined || maskedLine === undefined) continue
      if (fenceLines.has(original.number)) continue
      const headingMatch = matchHeading(maskedLine, original)
      if (headingMatch !== undefined) {
        if (headingMatch.title.toLowerCase() === 'summary') continue
        const ordinal = nextConceptOrdinal('part')
        const locator = structuralLocator(ctx.path, 'part', ordinal)
        const concept: StructuralConcept = {
          kind: 'part',
          locator,
          ordinal,
          explicit: true,
          ...(workLocator === undefined ? {} : { partOf: workLocator }),
        }
        const reference = documentReference(ctx, undefined, headingMatch.span, 'symbol', 'markdown')
        const node = domainNode(ctx, nodes, {
          kind: 'part',
          locator,
          name: headingMatch.title,
          ...(reference === undefined ? {} : { reference }),
          ...fragmentForSpan(ctx, headingMatch.span),
          source: 'summary',
          span: headingMatch.span,
        }, concept)
        if (node !== undefined) {
          concepts.push(concept)
          addConceptChild(conceptChildren, workLocator, locator)
          currentPart = locator
          itemStack.length = 0
        }
        continue
      }
      const item = /^(\s*)[-*+]\s+\[([^\]]*)\]\(([^)]+)\)/.exec(maskedLine.text)
      if (item === null) continue
      const target = item[3].trim()
      if (target.length === 0 || isExternal(target)) continue
      const indent = item[1].replace(/\t/g, '  ').length
      const level = Math.min(10, Math.floor(indent / 2) + 1)
      const kind: StructuralKind = level === 1 ? 'chapter' : 'section'
      const ordinal = nextConceptOrdinal(kind)
      const locator = structuralLocator(ctx.path, kind, ordinal)
      while (itemStack.length > 0 && itemStack[itemStack.length - 1].level >= level) itemStack.pop()
      const parent = itemStack[itemStack.length - 1]?.locator ?? currentPart ?? workLocator
      const name = item[2].trim()
      const span = lineSpan(original, original.start + indent, original.end)
      const concept: StructuralConcept = {
        kind,
        locator,
        ordinal,
        level,
        explicit: true,
        target,
        ...(parent === undefined ? {} : { partOf: parent }),
      }
      const reference = documentReference(
        ctx,
        `${ctx.path ?? 'text'}#${kind}:${ordinal}`,
        span,
        'symbol',
        'markdown',
      )
      const node = domainNode(ctx, nodes, {
        kind,
        locator,
        ...(name.length === 0 ? {} : { name }),
        ...(reference === undefined ? {} : { reference }),
        ...fragmentForSpan(ctx, span),
        source: 'summary',
        span,
      }, concept)
      if (node !== undefined) {
        concepts.push(concept)
        addConceptChild(conceptChildren, parent, locator)
        itemStack.push({ level, locator })
      }
    }
  }

  /*
   * Book/Article work node, Person authorities and Venue. Every value comes from
   * an explicit front-matter field; a missing field creates no node.
   */
  const workSpan = frontMatterSpan ?? { start: 0, end: 0, line: 1, column: 1 }
  for (const planned of workPlan.nodes) {
    const reference = documentReference(ctx, ctx.path, workSpan, 'file', 'markdown')
    const node = domainNode(ctx, nodes, {
      kind: planned.concept.kind,
      locator: planned.concept.locator,
      ...(planned.name === undefined ? {} : { name: planned.name }),
      ...(reference === undefined ? {} : { reference }),
      ...(frontMatterSpan === undefined ? {} : fragmentForSpan(ctx, frontMatterSpan)),
      source: 'front-matter',
      span: workSpan,
    }, planned.concept)
    if (node !== undefined) {
      concepts.push(planned.concept)
      if (planned.concept.partOf !== undefined && planned.concept.locator !== undefined) {
        addConceptChild(conceptChildren, planned.concept.partOf, planned.concept.locator)
      }
    }
  }
  const authoritySpan = (key: string): SourceSpan | undefined => frontEntry(key)?.span ?? frontMatterSpan
  const emitPeople = (names: readonly string[], role: 'author' | 'editor', key: string): void => {
    const span = authoritySpan(key) ?? frontMatterSpan ?? { start: 0, end: 0, line: 1, column: 1 }
    for (let index = 0; index < names.length; index += 1) {
      const ordinal = index + 1
      const locator = structuralLocator(ctx.path, 'person', `${role}:${ordinal}`)
      const concept: StructuralConcept = {
        kind: 'person',
        locator,
        ordinal,
        role,
        explicit: true,
      }
      const reference = documentReference(
        ctx,
        `${ctx.path ?? 'text'}#person:${role}:${ordinal}`,
        span,
        'symbol',
        'markdown',
      )
      const node = domainNode(ctx, nodes, {
        kind: 'person',
        locator,
        name: names[index],
        ...(reference === undefined ? {} : { reference }),
        ...fragmentForSpan(ctx, span),
        source: 'front-matter',
        span,
      }, concept)
      if (node !== undefined) concepts.push(concept)
    }
  }
  emitPeople(workPlan.authors, 'author', 'authors')
  emitPeople(workPlan.editors, 'editor', 'editors')
  if (workPlan.venue !== undefined) {
    const span = authoritySpan('venue') ?? frontMatterSpan ?? { start: 0, end: 0, line: 1, column: 1 }
    const locator = structuralLocator(ctx.path, 'venue', 1)
    const concept: StructuralConcept = {
      kind: 'venue',
      locator,
      ordinal: 1,
      form: 'unknown',
      explicit: true,
    }
    const reference = documentReference(ctx, `${ctx.path ?? 'text'}#venue:1`, span, 'symbol', 'markdown')
    const node = domainNode(ctx, nodes, {
      kind: 'venue',
      locator,
      name: workPlan.venue,
      ...(reference === undefined ? {} : { reference }),
      ...fragmentForSpan(ctx, span),
      source: 'front-matter',
      span,
    }, concept)
    if (node !== undefined) concepts.push(concept)
  }

  finalizeConceptChildren(conceptChildren, concepts)

  const document = documentMetadata(
    form,
    frontMetadata === undefined ? 'none' : 'front-matter',
    title,
    frontMetadata?.author,
    frontMetadata,
  )
  if (title !== undefined || frontMetadata !== undefined) {
    const lastFrontMatterLine = lines[Math.min(lines.length - 1, Math.max(0, bodyStartLine - 1))]
    const span: SourceSpan = frontMatter.length > 0 && lastFrontMatterLine !== undefined
      ? { start: lines[0].start, end: lastFrontMatterLine.end, line: 1, column: 1 }
      : { start: 0, end: 0, line: 1, column: 1 }
    const reference = documentReference(ctx, ctx.path, span, 'file', 'markdown')
    const brief = frontMetadata?.description ?? frontMetadata?.abstract
    pushDocumentMetadata(ctx, nodes, {
      kind: 'document',
      ...(title === undefined ? {} : { name: title }),
      ...(brief === undefined ? {} : { brief }),
      ...(frontMetadata?.usage === undefined ? {} : { usage: frontMetadata.usage }),
      ...(frontMetadata?.purpose === undefined ? {} : { purpose: frontMetadata.purpose }),
      ...(reference === undefined ? {} : { reference }),
      ...fragmentForSpan(ctx, span),
      source: frontMetadata === undefined ? 'none' : 'front-matter',
      span,
    })
    if (brief === undefined) {
      missingBrief += 1
      firstMissingSpan ??= span
    }
  }
  reportMissingBrief(ctx, missingBrief, firstMissingSpan)

  return {
    ...ctx.finalize({
      parserId: 'markdown',
      references,
      ast: new AstTree(root),
      nodes,
      ...(document === undefined ? {} : { document }),
    }),
    headings,
    paragraphs,
    divs,
    frontMatter,
    comments,
    formulas,
  }
}

/* ------------------------------------------------------------------------- *
 * Markdown internals
 * ------------------------------------------------------------------------- */

/** One planned Book/Article work node, before it is emitted. */
interface PlannedWorkNode {
  concept: StructuralConcept
  name?: string
  span: SourceSpan
}

/** Result of explicit front-matter work detection (never inferred from prose). */
interface MarkdownWorkPlan {
  nodes: PlannedWorkNode[]
  primary?: StructuralConcept
  authors: string[]
  editors: string[]
  venue?: string
  doi?: string
}

/**
 * Plan the Book/Article work node(s) from explicit front matter and the document
 * form. A plain Markdown document is the model's implicit Article only when it
 * actually has body content; a front-matter-only file still counts because its
 * title/author fields were explicitly authored.
 */
function planMarkdownWork(
  front: Record<string, string> | undefined,
  form: DocumentMetadata['form'],
  title: string | undefined,
  isSummary: boolean,
  hasBody: boolean,
  path: string | undefined,
): MarkdownWorkPlan {
  const authors = parseExplicitNameList(front?.authors ?? front?.author ?? '').slice(0, MAX_CONCEPT_NAMES)
  const editors = parseExplicitNameList(front?.editors ?? front?.editor ?? '').slice(0, MAX_CONCEPT_NAMES)
  const venue = conceptText(front?.venue)
  const doi = conceptText(front?.doi)
  const bookTitle = conceptText(front?.book)
  const articleTitle = conceptText(front?.article)
  const empty: MarkdownWorkPlan = { nodes: [], authors, editors }
  if (form === 'workbook' || form === 'deck') return empty
  const span: SourceSpan = { start: 0, end: 0, line: 1, column: 1 }
  const bookForm = form === 'book' || isSummary
  const articleForm = form === 'article' || form === 'note' || articleTitle !== undefined
  const bookContainer = bookForm || bookTitle !== undefined
  const shared = {
    ...(authors.length === 0 ? {} : { authors }),
    ...(editors.length === 0 ? {} : { editors }),
    ...(venue === undefined ? {} : { venue }),
    ...(doi === undefined ? {} : { doi }),
  }
  const nodes: PlannedWorkNode[] = []
  let book: StructuralConcept | undefined
  let article: StructuralConcept | undefined
  if (bookContainer) {
    book = {
      kind: 'book',
      locator: structuralLocator(path, 'book', 1),
      explicit: true,
      ...(bookTitle === undefined ? {} : { book: bookTitle }),
      ...shared,
    }
    // A collected article's document title is the article title, so the book
    // name must come from the explicit `book:` field, never from `title`.
    const bookName = bookForm ? (title ?? bookTitle) : bookTitle
    nodes.push({
      concept: book,
      ...(bookName === undefined ? {} : { name: bookName }),
      span,
    })
  }
  const wantArticle = bookForm
    ? articleTitle !== undefined
    : articleForm || bookTitle !== undefined || hasBody || front !== undefined
  if (wantArticle) {
    article = {
      kind: 'article',
      locator: structuralLocator(path, 'article', 1),
      explicit: articleForm,
      ...(articleTitle === undefined ? {} : { article: articleTitle }),
      ...(bookTitle === undefined ? {} : { book: bookTitle }),
      ...shared,
      ...(book?.locator === undefined ? {} : { partOf: book.locator }),
    }
    const articleName = articleTitle ?? (bookForm ? undefined : title)
    nodes.push({
      concept: article,
      ...(articleName === undefined ? {} : { name: articleName }),
      span,
    })
  }
  const primary = bookForm ? book : (article ?? book)
  return {
    nodes,
    ...(primary === undefined ? {} : { primary }),
    authors,
    editors,
    ...(venue === undefined ? {} : { venue }),
    ...(doi === undefined ? {} : { doi }),
  }
}

/** True when the body after front matter has any structural content. */
function hasMarkdownBody(lines: readonly TextLine[], start: number): boolean {
  for (let index = start; index < lines.length; index += 1) {
    const text = lines[index]?.text.trim() ?? ''
    if (text.length === 0 || text.startsWith(':::')) continue
    return true
  }
  return false
}

/** True for a GitBook/mdBook `SUMMARY.md` chapter list. */
function isSummaryPath(path: string | undefined): boolean {
  if (path === undefined) return false
  const normalised = path.replace(/\\/g, '/')
  const base = normalised.slice(normalised.lastIndexOf('/') + 1).toLowerCase()
  return base === 'summary.md' || base === 'summary.markdown' || base === 'summary.mdx'
}

/**
 * Read `title="..."` / `#id` attributes from a fenced-div opening line. Both
 * are explicit text; a line without them yields an empty object.
 */
function divAttributes(source: string, span: SourceSpan): { title?: string; id?: string } {
  const newline = source.indexOf('\n', span.start)
  const limit = Math.min(newline < 0 ? source.length : newline, span.start + 512)
  const line = source.slice(span.start, Math.max(span.start, limit))
  const titleMatch = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/i.exec(line)
  const idMatch = /(?:^|[\s{])#([A-Za-z][A-Za-z0-9_:.-]*)/.exec(line)
  const title = (titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3])?.trim()
  const id = idMatch?.[1]?.trim()
  return {
    ...(title === undefined || title.length === 0 ? {} : { title }),
    ...(id === undefined || id.length === 0 ? {} : { id }),
  }
}

function findFrontMatterClose(lines: readonly TextLine[]): number {
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].text.trim()
    if (trimmed === '---' || trimmed === '...') return index
  }
  return -1
}

function parseFrontMatterEntry(line: TextLine): FrontMatterEntry | undefined {
  const colon = line.text.indexOf(':')
  if (colon <= 0) return undefined
  const key = line.text.slice(0, colon).trim()
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key)) return undefined
  let value = line.text.slice(colon + 1).trim()
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) value = value.slice(1, -1)
  }
  return {
    key,
    value,
    span: { start: line.start, end: line.end, line: line.number, column: 1 },
  }
}

function documentFormFromMetadata(metadata: Record<string, string> | undefined): DocumentMetadata['form'] {
  const value = metadata?.form ?? metadata?.type ?? metadata?.document
  switch (value?.toLowerCase()) {
    case 'book':
      return 'book'
    case 'article':
      return 'article'
    case 'note':
      return 'note'
    case 'workbook':
      return 'workbook'
    case 'deck':
      return 'deck'
    default:
      return 'unknown'
  }
}

function matchFence(trimmed: string): { marker: string; length: number; info: string } | undefined {
  const marker = trimmed[0]
  if (marker !== '`' && marker !== '~') return undefined
  let length = 0
  while (length < trimmed.length && trimmed[length] === marker) length += 1
  if (length < 3) return undefined
  return { marker, length, info: trimmed.slice(length).trim() }
}

function fenceEndLine(lines: readonly TextLine[], startIndex: number, marker: string, length: number): number {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].text.trim()
    let count = 0
    while (count < trimmed.length && trimmed[count] === marker) count += 1
    if (count >= length && trimmed.slice(count).trim().length === 0) return lines[index].number
  }
  return lines.length
}

function matchDiv(trimmed: string): { length: number; info: string } | undefined {
  if (!trimmed.startsWith(':::')) return undefined
  let length = 0
  while (length < trimmed.length && trimmed[length] === ':') length += 1
  if (length < 3) return undefined
  return { length, info: trimmed.slice(length).trim() }
}

function matchHeading(
  masked: TextLine,
  original: TextLine,
): { level: number; title: string; span: SourceSpan } | undefined {
  const match = /^( {0,3})(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(masked.text)
  if (match === null) return undefined
  const title = original.text.slice(match[1].length + match[2].length).trim().replace(/[ \t]+#+$/, '').trim()
  const start = original.start + match[1].length
  return {
    level: match[2].length,
    title,
    span: lineSpan(original, start, original.end),
  }
}

function parseLinkDefinition(
  line: TextLine,
  source: string,
): { label: string; definition: LinkDefinition } | undefined {
  const match = /^ {0,3}\[([^\]]+)\]:[ \t]*(.*)$/.exec(line.text)
  if (match === null) return undefined
  const label = match[1]
  if (label.startsWith('^')) return undefined
  const rest = match[2].trim()
  const destination = parseDestination(rest, line.start + match[0].length - rest.length)
  if (destination === undefined) return undefined
  return {
    label,
    definition: {
      destination: destination.value,
      span: destination.span,
      used: false,
    },
  }
}

function parseDestination(
  rest: string,
  offset: number,
): { value: string; span: SourceSpan } | undefined {
  if (rest.length === 0) return undefined
  let start = 0
  let value: string
  if (rest[0] === '<') {
    const close = rest.indexOf('>', 1)
    if (close < 0) return undefined
    value = rest.slice(1, close)
    start = 1
  } else {
    let end = 0
    while (end < rest.length) {
      const character = rest[end]
      if (character === ' ' || character === '\t') break
      end += 1
    }
    value = rest.slice(0, end)
    if (value.length === 0) return undefined
  }
  return {
    value,
    span: { start: offset + start, end: offset + start + value.length, line: 1, column: 1 },
  }
}

/** Scan one Markdown line for inline and reference links/images. */
function scanMarkdownLinks(
  ctx: ParseContext,
  maskedLine: TextLine,
  originalLine: TextLine,
  definitions: Map<string, LinkDefinition>,
  references: FileReference[],
): void {
  void originalLine
  const text = maskedLine.text
  let index = 0
  while (index < text.length) {
    const character = text[index]
    const isImage = character === '!' && text[index + 1] === '['
    if (character !== '[' && !isImage) {
      index += 1
      continue
    }
    if (isEscapedCharacter(text, index)) {
      index += 1
      continue
    }
    const labelStart = index + (isImage ? 2 : 1)
    const labelEnd = findClosingBracket(text, labelStart)
    if (labelEnd < 0) {
      index += 1
      continue
    }
    const label = text.slice(labelStart, labelEnd)
    if (label.startsWith('^')) {
      index = labelEnd + 1
      continue
    }
    const after = text[labelEnd + 1]
    const kind: FileReference['kind'] = isImage ? 'markdown-image' : 'markdown-link'
    if (after === '(') {
      const close = findClosingParen(text, labelEnd + 2)
      if (close < 0) {
        index = labelEnd + 1
        continue
      }
      const rawDestination = text.slice(labelEnd + 2, close).trim()
      const destination = parseInlineDestination(rawDestination, maskedLine.start + labelEnd + 2)
      if (destination !== undefined) {
        const span = destination.span
        references.push({
          kind,
          specifier: destination.value,
          external: isExternal(destination.value),
          span,
          ...fragmentForSpan(ctx, span),
        })
      }
      index = close + 1
      continue
    }
    if (after === '[') {
      const close = text.indexOf(']', labelEnd + 2)
      if (close < 0) {
        index = labelEnd + 1
        continue
      }
      const referenceLabel = text.slice(labelEnd + 2, close).length === 0
        ? label
        : text.slice(labelEnd + 2, close)
      const definition = definitions.get(normaliseLabel(referenceLabel))
      if (definition !== undefined) {
        definition.used = true
        const span: SourceSpan = {
          start: maskedLine.start + index,
          end: maskedLine.start + close + 1,
          line: maskedLine.number,
          column: index + 1,
        }
        references.push({
          kind,
          specifier: definition.destination,
          external: isExternal(definition.destination),
          span,
          ...fragmentForSpan(ctx, span),
        })
      }
      index = close + 1
      continue
    }
    // Shortcut reference `[label]` when a definition exists.
    const definition = definitions.get(normaliseLabel(label))
    if (definition !== undefined) {
      definition.used = true
      const span: SourceSpan = {
        start: maskedLine.start + index,
        end: maskedLine.start + labelEnd + 1,
        line: maskedLine.number,
        column: index + 1,
      }
      references.push({
        kind,
        specifier: definition.destination,
        external: isExternal(definition.destination),
        span,
        ...fragmentForSpan(ctx, span),
      })
    }
    index = labelEnd + 1
  }
}

function parseInlineDestination(rest: string, offset: number): { value: string; span: SourceSpan } | undefined {
  if (rest.length === 0) return undefined
  let value: string
  let start = 0
  if (rest[0] === '<') {
    const close = rest.indexOf('>', 1)
    if (close < 0) return undefined
    value = rest.slice(1, close)
    start = 1
  } else {
    let end = 0
    while (end < rest.length) {
      const character = rest[end]
      if (character === ' ' || character === '\t') break
      end += 1
    }
    value = rest.slice(0, end)
  }
  if (value.length === 0) return undefined
  return {
    value,
    span: { start: offset + start, end: offset + start + value.length, line: 1, column: 1 },
  }
}

function normaliseLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

function findClosingBracket(text: string, from: number): number {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '[') depth += 1
    else if (character === ']') {
      if (depth === 0) return index
      depth -= 1
    }
  }
  return -1
}

function findClosingParen(text: string, from: number): number {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') {
      if (depth === 0) return index
      depth -= 1
    }
  }
  return -1
}

function isEscapedCharacter(text: string, index: number): boolean {
  let backslashes = 0
  let cursor = index - 1
  while (cursor >= 0 && text[cursor] === '\\') {
    backslashes += 1
    cursor -= 1
  }
  return backslashes % 2 === 1
}

/* ------------------------------------------------------------------------- *
 * CSS / HTML internals
 * ------------------------------------------------------------------------- */

function isExternal(specifier: string): boolean {
  const trimmed = specifier.trim()
  if (trimmed.startsWith('#')) return true
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return true
  if (trimmed.startsWith('//')) return true
  return false
}

function specifierSpan(source: string, start: number, end: number, specifier: string): SourceSpan {
  const valueStart = source.indexOf(specifier, start)
  const resolvedStart = valueStart >= 0 && valueStart < end ? valueStart : start
  const lineInfo = lineAtOffset(splitTextLines(source), resolvedStart)
  return {
    start: resolvedStart,
    end: Math.min(end, resolvedStart + specifier.length),
    line: lineInfo.number,
    column: resolvedStart - lineInfo.start + 1,
  }
}

function consumeCssImport(
  source: string,
  from: number,
): { value: string; valueStart: number; valueEnd: number; end: number; attributes?: Record<string, string> } | undefined {
  let cursor = from
  while (cursor < source.length && isWhitespaceCode(source.charCodeAt(cursor))) cursor += 1
  if (source[cursor] === '"' || source[cursor] === "'") {
    const quote = source[cursor]
    const close = source.indexOf(quote, cursor + 1)
    if (close < 0) return undefined
    const value = source.slice(cursor + 1, close)
    let end = close + 1
    const attributes: Record<string, string> = {}
    const mediaStart = end
    while (end < source.length && source[end] !== ';' && source[end] !== '}') end += 1
    const media = source.slice(mediaStart, end).trim()
    if (media.length > 0) attributes.media = media
    return { value, valueStart: cursor + 1, valueEnd: close, end: end < source.length ? end + 1 : end, ...(Object.keys(attributes).length === 0 ? {} : { attributes }) }
  }
  if (source.slice(cursor, cursor + 4).toLowerCase() === 'url(') {
    const consumed = consumeUrl(source, cursor + 4)
    if (consumed === undefined) return undefined
    let end = consumed.end
    const attributes: Record<string, string> = {}
    const mediaStart = end
    while (end < source.length && source[end] !== ';' && source[end] !== '}') end += 1
    const media = source.slice(mediaStart, end).trim()
    if (media.length > 0) attributes.media = media
    return {
      value: consumed.value,
      valueStart: consumed.valueStart,
      valueEnd: consumed.valueEnd,
      end: end < source.length ? end + 1 : end,
      ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
    }
  }
  return undefined
}

function consumeUrl(
  source: string,
  from: number,
): { value: string; valueStart: number; valueEnd: number; end: number } | undefined {
  let cursor = from
  while (cursor < source.length && isWhitespaceCode(source.charCodeAt(cursor))) cursor += 1
  if (source[cursor] === '"' || source[cursor] === "'") {
    const quote = source[cursor]
    const close = source.indexOf(quote, cursor + 1)
    if (close < 0) return undefined
    const parenClose = source.indexOf(')', close + 1)
    return {
      value: source.slice(cursor + 1, close),
      valueStart: cursor + 1,
      valueEnd: close,
      end: parenClose < 0 ? source.length : parenClose + 1,
    }
  }
  const close = source.indexOf(')', cursor)
  if (close < 0) return undefined
  const raw = source.slice(cursor, close)
  const trimmed = raw.trim()
  const valueStart = cursor + (raw.length - raw.trimStart().length)
  return {
    value: trimmed,
    valueStart,
    valueEnd: valueStart + trimmed.length,
    end: close + 1,
  }
}

function skipQuoted(source: string, start: number): number {
  const quote = source.charCodeAt(start)
  let cursor = start + 1
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor)
    if (code === 92) {
      cursor += 2
      continue
    }
    if (code === quote) return cursor + 1
    if (code === 10 || code === 13) return cursor
    cursor += 1
  }
  return cursor
}

function sourceSpecifier(tag: HtmlTag, name: string): { value: string; start: number; end: number } | undefined {
  const attribute = tag.attributes.get(name)
  if (attribute === undefined) return undefined
  return attribute.value.length === 0 ? undefined : attribute
}

function addHtmlReference(
  ctx: ParseContext,
  references: FileReference[],
  kind: FileReference['kind'],
  tag: HtmlTag,
  attribute: { value: string; start: number; end: number },
  extra?: string,
): void {
  const span: SourceSpan = {
    start: attribute.start,
    end: attribute.end,
    line: 1,
    column: 1,
  }
  // Recompute line/column from the source map from the UTF-16 offset.
  const mapped = ctx.sourceMap.lineAt(span.start)
  if (mapped !== undefined) {
    span.line = mapped
    const column = ctx.sourceMap.columnAt(span.start)
    if (column !== undefined) span.column = column
  }
  const attributes: Record<string, string> = {}
  if (extra !== undefined && extra.length > 0) attributes.type = extra
  references.push({
    kind,
    specifier: attribute.value,
    external: isExternal(attribute.value),
    span,
    ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
    ...fragmentForSpan(ctx, span),
  })
  void tag
}

function stripTags(text: string): string {
  let result = ''
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('<', index)
    if (open < 0) {
      result += text.slice(index)
      break
    }
    result += text.slice(index, open)
    const close = text.indexOf('>', open)
    if (close < 0) break
    index = close + 1
  }
  return result
}

/**
 * True when the only text between two offsets is markup/whitespace, so a heading
 * there is the first content of its container and may name it explicitly.
 */
function onlyMarkupBetween(source: string, start: number, end: number): boolean {
  let index = Math.max(0, start)
  const limit = Math.min(source.length, end)
  while (index < limit) {
    const open = source.indexOf('<', index)
    if (open < 0 || open >= limit) return source.slice(index, limit).trim().length === 0
    if (source.slice(index, open).trim().length > 0) return false
    const close = source.indexOf('>', open)
    if (close < 0 || close >= limit) return false
    index = close + 1
  }
  return true
}

function findClosingTag(source: string, from: number, name: string): number {
  const lower = source.toLowerCase()
  const close = lower.indexOf(`</${name}`, from)
  if (close < 0) return source.length
  const end = source.indexOf('>', close)
  return end < 0 ? source.length : end + 1
}

function isIdentCode(code: number): boolean {
  if (Number.isNaN(code)) return false
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || code === 95 || code === 45 || code >= 128
}

function isTagNameCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || code === 58 || code === 45
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12
}

/* ------------------------------------------------------------------------- *
 * CSV / TSV (bounded office surface)
 * ------------------------------------------------------------------------- */

/** Result of a bounded CSV/TSV parse. Values are structure counts, never cells. */
export interface DelimitedParseResult extends ParseResult {
  /** Sheet name derived from the file name, or `Sheet1`. */
  sheet: string
  rowCount: number
  columnCount: number
  /** Non-empty cells extracted as `cell` nodes. */
  cellCount: number
}

interface DelimitedCell {
  rowIndex: number
  columnIndex: number
  /** UTF-16 offsets in the source, quote characters included. */
  start: number
  end: number
  /** Raw cell text; used for type/injection detection and never stored. */
  text: string
  quoted: boolean
}

/** Delimiter from an explicit extension/id, else a first-line sniff. */
function delimitedDelimiter(path: string | undefined, parserId: string | undefined, source: string): ',' | '\t' {
  const lower = path?.toLowerCase() ?? ''
  if (lower.endsWith('.tsv')) return '\t'
  if (lower.endsWith('.csv')) return ','
  if (parserId === 'tsv') return '\t'
  const firstLine = source.slice(0, Math.min(source.length, 4_096))
  let tabs = 0
  let commas = 0
  for (const character of firstLine) {
    if (character === '\t') tabs += 1
    else if (character === ',') commas += 1
  }
  return tabs > commas ? '\t' : ','
}

/** Sheet name from the file name; never a guessed header value. */
function sheetNameOf(path: string | undefined): string {
  if (path === undefined) return 'Sheet1'
  const normalised = path.replace(/\\/g, '/')
  const base = normalised.slice(normalised.lastIndexOf('/') + 1)
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
  const clean = sanitizeMetadataText(stem, MAX_NAME_LENGTH)
  return clean.length === 0 ? 'Sheet1' : clean
}

/** A1 column name for a 0-based column index (`0` → `A`). */
function columnName(columnIndex: number): string {
  let value = columnIndex + 1
  let name = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

/** A1 address for 0-based row/column indices. */
function cellAddress(rowIndex: number, columnIndex: number): string {
  return `${columnName(columnIndex)}${rowIndex + 1}`
}

/** Value type from the raw text only; no evaluation and no formula parse. */
function cellValueType(text: string): CellValueType {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 'empty'
  if (/^#(?:DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!)$/.test(trimmed)) return 'error'
  if (/^(?:true|false)$/i.test(trimmed)) return 'boolean'
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return 'number'
  return 'text'
}

/** RFC 4180 + OWASP metacharacter check; `=` is text, never a formula. */
function hasInjectionRisk(text: string): boolean {
  if (text.length === 0) return false
  const first = text.charCodeAt(0)
  return first === 61 || first === 43 || first === 45 || first === 64 || first === 9 || first === 13
}

/** Span helper for a byte-verified source offset pair. */
function offsetSpan(ctx: ParseContext, start: number, end: number): SourceSpan {
  const line = ctx.sourceMap.lineAt(start) ?? 1
  const column = ctx.sourceMap.columnAt(start) ?? 1
  return { start, end, line, column }
}

/**
 * Scan RFC 4180 rows with a bounded single pass. Yields cell text only for the
 * duration of the loop; the caller never stores it.
 */
function* scanDelimitedRows(
  source: string,
  delimiter: ',' | '\t',
  shouldStop: () => boolean,
): Generator<DelimitedCell[]> {
  let index = source.startsWith('\uFEFF') ? 1 : 0
  let rowIndex = 0
  while (index < source.length) {
    const cells: DelimitedCell[] = []
    let columnIndex = 0
    let rowDone = false
    while (!rowDone) {
      if (shouldStop()) return
      const start = index
      let text = ''
      let quoted = false
      if (source[index] === '"') {
        quoted = true
        index += 1
        let buffer = ''
        while (index < source.length) {
          const character = source[index]
          if (character === '"') {
            if (source[index + 1] === '"') {
              buffer += '"'
              index += 2
              continue
            }
            index += 1
            break
          }
          buffer += character
          index += 1
        }
        // Malformed input recovery: any trailing text before the delimiter is
        // kept as part of the same cell rather than inventing a new one.
        while (index < source.length && source[index] !== delimiter && source[index] !== '\n' && source[index] !== '\r') {
          buffer += source[index]
          index += 1
        }
        text = buffer
      } else {
        while (index < source.length && source[index] !== delimiter && source[index] !== '\n' && source[index] !== '\r') {
          text += source[index]
          index += 1
        }
      }
      const end = index
      cells.push({ rowIndex, columnIndex, start, end, text, quoted })
      columnIndex += 1
      if (index >= source.length) {
        rowDone = true
        break
      }
      const character = source[index]
      if (character === delimiter) {
        index += 1
        continue
      }
      if (character === '\r') {
        index += source[index + 1] === '\n' ? 2 : 1
        rowDone = true
        break
      }
      if (character === '\n') {
        index += 1
        rowDone = true
        break
      }
      index += 1
      rowDone = true
    }
    if (cells.length > 0) yield cells
    rowIndex += 1
  }
}

/**
 * Parse CSV/TSV into a `sheet` node, non-empty `cell` nodes (A1 address only)
 * and one used-range node. No formula is evaluated, no cell text is stored and
 * a leading `=`/`+`/`-`/`@` is text with `injectionRisk` (domain model §5).
 */
export function parseDelimited(text: string, options: ParseOptions = {}): DelimitedParseResult {
  const ctx = new ParseContext(text, options)
  const scanned = tokenize(ctx.text, {
    maxTokens: ctx.maxTokens,
    shouldStop: ctx.shouldStop,
    lineComments: [],
    blockComments: [],
    stringDelimiters: ['"'],
  })
  ctx.tokens = scanned.tokens.length
  if (scanned.truncated && scanned.tokens.length >= ctx.maxTokens) {
    ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
  }
  const source = ctx.text
  const delimiter = delimitedDelimiter(ctx.path, options.parserId, source)
  const sheetName = sheetNameOf(ctx.path)
  const sheetLocator = structuralLocator(ctx.path, 'sheet', 1)
  const nodes: NodeMetadata[] = []
  const root = createAstRoot('workbook', ctx.text.length)
  let rowCount = 0
  let columnCount = 0
  let cellCount = 0
  let maxContentRow = -1
  let maxContentColumn = -1
  let firstContentStart: number | undefined
  let lastContentEnd: number | undefined
  let rowCapHit = false
  let cellCapHit = false
  if (source.trim().length > 0) {
    for (const row of scanDelimitedRows(source, delimiter, ctx.shouldStop)) {
      if (rowCount >= MAX_CSV_ROWS) {
        rowCapHit = true
        break
      }
      rowCount += 1
      if (row.length > columnCount) columnCount = Math.min(row.length, MAX_CSV_COLUMNS)
      for (const cell of row) {
        if (cell.columnIndex >= MAX_CSV_COLUMNS) {
          cellCapHit = true
          break
        }
        const valueType = cellValueType(cell.text)
        if (valueType === 'empty') continue
        if (cellCount >= MAX_CSV_CELLS) {
          cellCapHit = true
          break
        }
        cellCount += 1
        maxContentRow = Math.max(maxContentRow, cell.rowIndex)
        maxContentColumn = Math.max(maxContentColumn, cell.columnIndex)
        firstContentStart = firstContentStart === undefined ? cell.start : Math.min(firstContentStart, cell.start)
        lastContentEnd = lastContentEnd === undefined ? cell.end : Math.max(lastContentEnd, cell.end)
        const address = cellAddress(cell.rowIndex, cell.columnIndex)
        const locator = `${sheetLocator}/cell:${address}`
        const span = offsetSpan(ctx, cell.start, cell.end)
        const concept: OfficeConcept = {
          kind: 'cell',
          locator,
          ordinal: cellCount,
          sheet: sheetName,
          address,
          rowIndex: cell.rowIndex,
          columnIndex: cell.columnIndex,
          valueType,
          injectionRisk: hasInjectionRisk(cell.text),
          partOf: sheetLocator,
        }
        let reference: NodeReference | undefined
        try {
          reference = referenceForSpan(ctx, {
            scheme: 'sheet-cell',
            target: `${ctx.path ?? 'text'}#${sheetName}:${address}`,
            span,
            parserId: 'delimited',
          })
        } catch {
          reference = undefined
        }
        const node = domainNode(ctx, nodes, {
          kind: 'cell',
          locator,
          name: address,
          label: address,
          ...(reference === undefined ? {} : { reference }),
          ...fragmentForSpan(ctx, span),
          source: 'sheet',
          span,
        }, concept)
        if (node !== undefined) appendAstNode(ctx, root, 'cell', span, address)
      }
      if (cellCapHit) break
    }
  }
  if (rowCapHit) {
    ctx.limit('node-limit', `sheet row limit ${MAX_CSV_ROWS} reached; later rows were dropped`)
  }
  if (cellCapHit) {
    ctx.limit('node-limit', `sheet cell/column cap (${MAX_CSV_CELLS} cells, ${MAX_CSV_COLUMNS} columns) reached; later cells were dropped`)
  }
  const wholeSpan: SourceSpan = { start: ctx.bomOffset, end: source.length, line: 1, column: 1 }
  const sheetConcept: OfficeConcept = {
    kind: 'sheet',
    locator: sheetLocator,
    ordinal: 1,
    sheet: sheetName,
    rowCount,
    columnCount,
    cellCount,
    truncated: rowCapHit || cellCapHit,
  }
  let sheetReference: NodeReference | undefined
  if (ctx.path !== undefined) {
    try {
      sheetReference = referenceForSpan(ctx, {
        scheme: 'file',
        target: ctx.path,
        span: wholeSpan,
        parserId: 'delimited',
      })
    } catch {
      sheetReference = undefined
    }
  }
  const sheetNode = domainNode(ctx, nodes, {
    kind: 'sheet',
    locator: sheetLocator,
    name: sheetName,
    ...(sheetReference === undefined ? {} : { reference: sheetReference }),
    ...fragmentForSpan(ctx, wholeSpan),
    source: 'sheet',
    span: wholeSpan,
  }, sheetConcept)
  if (sheetNode !== undefined) appendAstNode(ctx, root, 'sheet', wholeSpan, sheetName)
  if (cellCount > 0 && maxContentRow >= 0 && maxContentColumn >= 0) {
    const startAddress = cellAddress(0, 0)
    const endAddress = cellAddress(maxContentRow, maxContentColumn)
    const rangeName = startAddress === endAddress ? startAddress : `${startAddress}:${endAddress}`
    const rangeLocator = `${sheetLocator}/range:used`
    const rangeStart = firstContentStart ?? wholeSpan.start
    const rangeEnd = lastContentEnd ?? wholeSpan.end
    const rangeSpan = offsetSpan(ctx, rangeStart, rangeEnd)
    const rangeConcept: OfficeConcept = {
      kind: 'range',
      locator: rangeLocator,
      ordinal: 1,
      sheet: sheetName,
      rangeForm: 'cell',
      start: startAddress,
      end: endAddress,
      cellCount,
      partOf: sheetLocator,
    }
    let rangeReference: NodeReference | undefined
    try {
      rangeReference = referenceForSpan(ctx, {
        scheme: 'sheet-cell',
        target: `${ctx.path ?? 'text'}#${sheetName}:${rangeName}`,
        span: rangeSpan,
        parserId: 'delimited',
      })
    } catch {
      rangeReference = undefined
    }
    const rangeNode = domainNode(ctx, nodes, {
      kind: 'range',
      locator: rangeLocator,
      name: rangeName,
      label: rangeName,
      ...(rangeReference === undefined ? {} : { reference: rangeReference }),
      ...fragmentForSpan(ctx, rangeSpan),
      source: 'sheet',
      span: rangeSpan,
    }, rangeConcept)
    if (rangeNode !== undefined) appendAstNode(ctx, root, 'range', rangeSpan, rangeName)
  }
  const document = documentMetadata(
    'workbook',
    'extension',
    sheetName,
    undefined,
    { delimiter: delimiter === '\t' ? 'tsv' : 'csv' },
  )
  return {
    ...ctx.finalize({
      parserId: 'delimited',
      references: [],
      ast: new AstTree(root),
      nodes,
      ...(document === undefined ? {} : { document }),
    }),
    sheet: sheetName,
    rowCount,
    columnCount,
    cellCount,
  }
}

/* ------------------------------------------------------------------------- *
 * Parser classes
 * ------------------------------------------------------------------------- */

/** CSS parser for the registry. */
export class CssParser implements Parser {
  readonly id = 'css'
  readonly extensions: readonly string[] = ['.css']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parseCss(text, options)
  }
}

/** HTML parser for the registry. */
export class HtmlParser implements Parser {
  readonly id = 'html'
  readonly extensions: readonly string[] = ['.html', '.htm']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parseHtml(text, options)
  }
}

/** Markdown parser for the registry. */
export class MarkdownParser implements Parser {
  readonly id = 'markdown'
  readonly extensions: readonly string[] = ['.md', '.markdown', '.mdx']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parseMarkdown(text, options)
  }
}

export const cssParser = new CssParser()
export const htmlParser = new HtmlParser()
export const markdownParser = new MarkdownParser()

/** Bounded CSV/TSV parser for the registry. */
export class DelimitedParser implements Parser {
  readonly id = 'delimited'
  readonly extensions: readonly string[] = ['.csv', '.tsv']

  parse(text: string, options: ParseOptions = {}): ParseResult {
    return parseDelimited(text, options)
  }
}

export const delimitedParser = new DelimitedParser()
