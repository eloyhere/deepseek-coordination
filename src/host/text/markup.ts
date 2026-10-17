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
): void {
  pushNodeMetadata(ctx, nodes, input)
}

function reportMissingBrief(ctx: ParseContext, count: number, span: SourceSpan | undefined): void {
  if (count === 0) return
  ctx.unverifiable(
    `metadata brief missing on ${count} node(s); left empty (explicit description fields only)`,
    span,
  )
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
      index = tag.end
      continue
    }
    if (tag.name === 'article' || tag.name === 'main') article = true
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
      index = close === null ? contentEnd : contentEnd + close[0].length
      continue
    } else if (tag.name === 'p') {
      const close = /<\/p\s*>/i.exec(source.slice(tag.end))
      const contentEnd = close === null ? source.length : tag.end + close.index
      const span = lineSpan(lineAtOffset(lines, index), index, close === null ? contentEnd : contentEnd + close[0].length)
      paragraphs.push({
        preview: stripTags(source.slice(tag.end, contentEnd)).replace(/\s+/g, ' ').trim().slice(0, MAX_PARAGRAPH_PREVIEW),
        span,
        ...fragmentForSpan(ctx, span),
      })
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

  const documentForm: DocumentMetadata['form'] = article ? 'article' : 'unknown'
  const metadata = documentMetadata(
    documentForm,
    title !== undefined || description !== undefined ? 'html' : 'none',
    title,
    undefined,
    undefined,
  )
  const root = createAstRoot('document', ctx.text.length)
  let missingBrief = 0
  let firstSpan: SourceSpan | undefined
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
  for (const heading of headings) {
    if (ctx.path !== undefined && heading.reference === undefined) {
      heading.reference = documentReference(ctx, undefined, heading.span, 'symbol', 'html')
    }
    pushDocumentMetadata(ctx, nodes, {
      kind: 'heading',
      name: heading.title,
      ...(heading.reference === undefined ? {} : { reference: heading.reference }),
      ...(heading.path === undefined ? {} : { fragment: heading }),
      source: 'heading',
      span: heading.span,
    })
    missingBrief += 1
    firstSpan ??= heading.span
    appendAstNode(ctx, root, 'heading', heading.span, heading.title)
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
        frontMatter.push(entry)
        frontMetadata ??= {}
        frontMetadata[entry.key] = entry.value
      }
      bodyStartLine = closeIndex + 1
      title = frontMetadata?.title
    }
  }

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
      pushDocumentMetadata(ctx, nodes, {
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

  for (const div of divs) {
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

  const form = documentFormFromMetadata(frontMetadata)
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
