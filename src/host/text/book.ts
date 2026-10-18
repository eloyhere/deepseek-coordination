/**
 * Book/literature ecosystem parser.
 *
 * This module is the single producer of the **book taxonomy** in the text
 * layer: `book`, `part`, `chapter` (book chapter), `article`, `person` and
 * `venue`. Markdown/HTML never emit those kinds — an HTML `<article>` element
 * or a Markdown heading is markup structure, not a publication unit — so a
 * `book`/`article` can only appear here, and only from an explicit marker.
 *
 * Two explicit, machine-readable source structures are recognised. Nothing is
 * inferred from prose:
 *
 *  1. **Table of contents** — a `SUMMARY.md` / `SUMMARY.txt`-style list of
 *     Markdown links:
 *
 *     ```md
 *     # Summary
 *     - [Part I](part-i.md)
 *       - [Chapter 1](ch1.md)
 *         - [Section 1.1](ch1.md#s11)
 *     ```
 *
 *     A depth-1 item is a `part`, depth 2 a `chapter`, depth 3+ a `section`.
 *     Depth comes from list nesting (indentation), never from prose. The link
 *     text becomes `name`; the link target becomes the node `locator`
 *     (`chapter:ch1.md`) and, when it can be expressed safely, the nested
 *     `reference` (`file` for a workspace target, `url` for http(s)).
 *  2. **Front matter** — a leading `---` fenced block of simple `key: value`
 *     lines, at most {@link MAX_FRONT_MATTER_LINES} lines, parsed without a YAML
 *     engine:
 *
 *     ```md
 *     ---
 *     type: book              → a `book` node
 *     title: The Art of X     → that node's `name`
 *     author: Ada, Alan       → one `person` node per name (`label: 'author'`)
 *     venue: Memoires         → a `venue` node
 *     ---
 *     ```
 *
 *     `type: article` produces an `article` node instead. `venue`, `journal`
 *     and `publisher` each produce one `venue` node labelled with the explicit
 *     key. A value that is absent produces no node; a value the taxonomy does
 *     not know is reported `unverifiable` rather than guessed.
 *
 * Contract:
 *
 *  - **Body-free**: nodes carry `kind`, `name`, `label`, `locator`, an optional
 *    body-free `reference` and flat file coordinates/fingerprint. No prose
 *    body, no YAML value beyond the capped front-matter map is stored.
 *  - **Deterministic and source-ordered**: the same `(path, text, options)`
 *    tuple yields the same nodes in the same order; locators are natural keys,
 *    never public handles.
 *  - **Bounded**: every loop checks the shared `ParseContext` budgets (1 MiB,
 *    200k tokens, 2 s, depth cap) and node emission goes through
 *    `pushNodeMetadata`, so the list stops at `MAX_METADATA_NODES`.
 *  - **Malformed input is reported, never thrown**: an unterminated front
 *    matter fence is an `unverifiable` diagnostic and no front-matter nodes;
 *    non-`key: value` lines inside the fence are counted and reported once.
 *  - **Linear**: one forward scan over `splitTextLines` output with periodic
 *    deadline checkpoints; every per-line decision is character scanning or a
 *    flat, delimiter-bounded regular expression, so there is no backtracking
 *    over large input.
 *
 * Node kinds emitted:
 *
 * | Source | Rule | Kind |
 * |---|---|---|
 * | TOC list item | nesting depth 1 | `part` |
 * | TOC list item | nesting depth 2 | `chapter` |
 * | TOC list item | nesting depth >= 3 | `section` |
 * | front matter | `type: book` | `book` |
 * | front matter | `type: article` | `article` |
 * | front matter | each `author` name | `person` |
 * | front matter | `venue` / `journal` / `publisher` | `venue` |
 */
import { AstTree } from '../../shared/ast.js'
import type { SourceSpan } from '../../shared/ast.js'
import {
  MAX_NAME_LENGTH,
  ParseContext,
  appendAstNode,
  createAstRoot,
  createNodeReference,
  fragmentForSpan,
  normaliseWorkspacePath,
  pushNodeMetadata,
  referenceForSpan,
  sanitizeMetadataText,
} from './parser.js'
import type {
  DocumentMetadata,
  FileReference,
  NodeMetadata,
  NodeReference,
  ParseOptions,
  ParseResult,
  Parser,
} from './parser.js'
import { splitTextLines } from './tokenizer.js'
import type { TextLine } from './tokenizer.js'
import type { StructuralConcept } from '../../shared/entity.js'
import type { VenueForm } from '../../shared/enum.js'

/** Stable parser id. */
export const BOOK_PARSER_ID = 'book'
/**
 * Extensions claimed by {@link BookParser}. `.md`/`.txt` stay with the Markdown
 * parser; the TOC file names are claimed exactly instead (see
 * {@link BOOK_FILENAMES}), because a `SUMMARY.md` is a book structure even
 * though its name ends in `.md`.
 */
export const BOOK_EXTENSIONS: readonly string[] = ['.book']
/** Exact file names claimed by {@link BookParser} (matched case-insensitively). */
export const BOOK_FILENAMES: readonly string[] = ['summary.md', 'summary.txt']
/**
 * Front-matter block cap, in scanned lines including the opening `---`. A block
 * whose closing fence is not found within this budget is treated as malformed.
 */
export const MAX_FRONT_MATTER_LINES = 200
/** Maximum `locator` contributution taken from one link target. */
export const MAX_BOOK_LOCATOR_LENGTH = 256
/** Maximum author names copied onto the work concept's `authors` list. */
const MAX_CONCEPT_AUTHORS = 8
/** Maximum child locators kept on one concept's `contains` list. */
const MAX_CONCEPT_CHILDREN = 16
/** Lines between two deadline/abort checkpoints. */
const CHECKPOINT_LINES = 1_024
/** Front-matter keys that name a publication venue. */
const VENUE_KEYS: ReadonlySet<string> = new Set(['venue', 'journal', 'publisher'])

/** One `key: value` line of the leading front-matter block. */
export interface BookFrontMatterEntry {
  /** Key as written (trimmed). */
  key: string
  /** Value as written (trimmed, surrounding quotes stripped); never a body. */
  value: string
  span: SourceSpan
}

/** Kinds the TOC depth mapping produces. */
export type BookSectionKind = 'part' | 'chapter' | 'section'

/** One TOC list entry, mirroring the node it produced. */
export interface BookTocEntry {
  kind: BookSectionKind
  /** 1-based nesting depth: 1 = part, 2 = chapter, 3+ = section. */
  level: number
  /** Link text, when non-empty. */
  name?: string
  /** Link target exactly as written (fragment included). */
  target: string
  /** Natural key of the node (`part:part-i.md`), unique within the parse. */
  locator: string
  /** Body-free pointer at the linked file/URL, when one could be built. */
  reference?: NodeReference
  span: SourceSpan
}

/** Result of {@link parseBook}; adds the explicit structures it found. */
export interface BookParseResult extends ParseResult {
  frontMatter: BookFrontMatterEntry[]
  toc: BookTocEntry[]
}

/* ------------------------------------------------------------------------- *
 * Parser entry points
 * ------------------------------------------------------------------------- */

/**
 * Parse one book-structure file: a `SUMMARY.md`-style table of contents and/or
 * a leading front-matter block.
 *
 * Never throws for malformed text (only a pre-aborted `options.signal` may
 * throw, per the parser contract); malformed structures become diagnostics.
 * Time O(n) in the source length, space O(nodes + lines).
 */
export function parseBook(text: string, options: ParseOptions = {}): BookParseResult {
  const ctx = new ParseContext(text, options)
  const lines = splitTextLines(ctx.text)
  const references: FileReference[] = []
  const nodes: NodeMetadata[] = []
  const frontMatter: BookFrontMatterEntry[] = []
  const toc: BookTocEntry[] = []
  const concepts: StructuralConcept[] = []
  const conceptChildren = new Map<string, string[]>()

  /*
   * The token budget is counted in physical lines: this format has no lexical
   * token stream of its own, and a line is the smallest unit the scan consumes.
   */
  let scanned = 0
  const tick = (): boolean => {
    if (ctx.isStopped) return false
    scanned += 1
    ctx.tokens = scanned
    if (scanned > ctx.maxTokens) {
      ctx.limit('token-limit', `token limit ${ctx.maxTokens} reached; parsed the prefix`)
      return false
    }
    if (scanned % CHECKPOINT_LINES === 0 && !ctx.checkpoint()) return false
    return true
  }

  ctx.checkpoint()

  /* ----------------------------------------------------------------------- *
   * 1. Leading front matter
   * ----------------------------------------------------------------------- */

  let bodyStart = 0
  let frontSpan: SourceSpan | undefined
  const first = lines[0]
  if (first !== undefined && isFrontMatterFence(first, ctx.bomOffset)) {
    let closeIndex = -1
    const scanLimit = Math.min(lines.length - 1, MAX_FRONT_MATTER_LINES)
    for (let index = 1; index <= scanLimit; index += 1) {
      if (!tick()) break
      const line = lines[index]
      if (line !== undefined && line.text.trim() === '---') {
        closeIndex = index
        break
      }
    }
    if (closeIndex >= 0) {
      bodyStart = closeIndex + 1
      const closeLine = lines[closeIndex]
      frontSpan = {
        start: first.start,
        end: closeLine === undefined ? first.end : closeLine.end,
        line: 1,
        column: 1,
      }
      let ignored = 0
      for (let index = 1; index < closeIndex; index += 1) {
        const line = lines[index]
        if (line === undefined) continue
        const entry = parseFrontMatterLine(line)
        if (entry === undefined) {
          const trimmed = line.text.trim()
          if (trimmed.length > 0 && !trimmed.startsWith('#')) ignored += 1
          continue
        }
        frontMatter.push(entry)
      }
      if (ignored > 0) {
        ctx.unverifiable(
          `front matter: ${ignored} line(s) are not simple "key: value" pairs; ignored`,
          frontSpan,
        )
      }
    } else if (!ctx.isStopped) {
      // A leading fence with no in-budget close is malformed, not a hint: no
      // front-matter value is trusted and the block is not parsed as a TOC.
      ctx.unverifiable(
        `front matter has no closing "---" delimiter within ${MAX_FRONT_MATTER_LINES} lines; front matter ignored`,
        lineSpan(first, first.start, first.end),
      )
      bodyStart = 1
    } else {
      bodyStart = lines.length
    }
  }

  /* ----------------------------------------------------------------------- *
   * 2. Front matter → work / person / venue nodes
   * ----------------------------------------------------------------------- */

  const frontByKey = new Map<string, BookFrontMatterEntry>()
  for (const entry of frontMatter) {
    const key = entry.key.toLowerCase()
    if (!frontByKey.has(key)) frontByKey.set(key, entry)
  }

  const typeEntry = frontByKey.get('type')
  const rawType = typeEntry === undefined ? '' : typeEntry.value.trim()
  const lowerType = rawType.toLowerCase()
  let workKind: 'book' | 'article' | undefined
  if (lowerType === 'book' || lowerType === 'article') {
    workKind = lowerType
  } else if (rawType.length > 0) {
    ctx.unverifiable(
      `front matter type "${sanitizeMetadataText(rawType, MAX_NAME_LENGTH)}" is not "book" or "article"; no work node emitted`,
      typeEntry === undefined ? undefined : typeEntry.span,
    )
  }

  const authorEntry = frontByKey.get('author')
  const authorNames = authorEntry === undefined ? [] : splitAuthorNames(authorEntry.value)
  const cleanedAuthors: string[] = []
  for (const rawName of authorNames) {
    const name = sanitizeMetadataText(rawName, MAX_NAME_LENGTH)
    if (name.length > 0) cleanedAuthors.push(name)
  }

  let workLocator: string | undefined
  if (workKind !== undefined) {
    workLocator = `${workKind}:1`
    const titleEntry = frontByKey.get('title')
    const title = titleEntry === undefined ? '' : sanitizeMetadataText(titleEntry.value, MAX_NAME_LENGTH)
    const span = frontSpan ?? { start: 0, end: 0, line: 1, column: 1 }
    const label = rawType.length > 0 ? sanitizeMetadataText(rawType, MAX_NAME_LENGTH) : workKind
    const concept: StructuralConcept = {
      kind: workKind,
      locator: workLocator,
      explicit: true,
      ...(cleanedAuthors.length === 0
        ? {}
        : { authors: cleanedAuthors.slice(0, MAX_CONCEPT_AUTHORS) }),
    }
    const reference = ctx.path === undefined
      ? undefined
      : referenceForSpan(ctx, {
          scheme: 'file',
          target: ctx.path,
          span,
          parserId: BOOK_PARSER_ID,
        })
    const node = pushNodeMetadata(ctx, nodes, {
      kind: workKind,
      locator: workLocator,
      ...(title.length === 0 ? {} : { name: title }),
      ...(label.length === 0 ? {} : { label }),
      ...(reference === undefined ? {} : { reference }),
      ...(frontSpan === undefined ? {} : { fragment: fragmentForSpan(ctx, frontSpan) }),
      source: 'front-matter',
      span,
    })
    if (node !== undefined) {
      node.domain = concept
      concepts.push(concept)
    }
  }

  /*
   * Authorities and venues: one node per explicit value, in source order. The
   * first occurrence of a duplicated key wins; a missing key creates no node.
   */
  let personOrdinal = 0
  let venueOrdinal = 0
  for (const entry of frontMatter) {
    const key = entry.key.toLowerCase()
    if (frontByKey.get(key) !== entry) continue
    if (key === 'author') {
      for (const rawName of authorNames) {
        personOrdinal += 1
        const locator = `person:author:${personOrdinal}`
        const name = sanitizeMetadataText(rawName, MAX_NAME_LENGTH)
        const concept: StructuralConcept = {
          kind: 'person',
          locator,
          ordinal: personOrdinal,
          role: 'author',
          explicit: true,
        }
        const reference = ctx.path === undefined
          ? undefined
          : referenceForSpan(ctx, {
              scheme: 'symbol',
              target: `${ctx.path}#person:author:${personOrdinal}`,
              span: entry.span,
              parserId: BOOK_PARSER_ID,
            })
        const node = pushNodeMetadata(ctx, nodes, {
          kind: 'person',
          locator,
          ...(name.length === 0 ? {} : { name }),
          label: 'author',
          ...(reference === undefined ? {} : { reference }),
          fragment: fragmentForSpan(ctx, entry.span),
          source: 'front-matter',
          span: entry.span,
        })
        if (node !== undefined) {
          node.domain = concept
          concepts.push(concept)
        }
        if (ctx.isStopped) break
      }
    } else if (VENUE_KEYS.has(key)) {
      venueOrdinal += 1
      const locator = `venue:${venueOrdinal}`
      const name = sanitizeMetadataText(entry.value, MAX_NAME_LENGTH)
      const form: VenueForm = key === 'journal' ? 'journal' : 'unknown'
      const concept: StructuralConcept = {
        kind: 'venue',
        locator,
        ordinal: venueOrdinal,
        form,
        explicit: true,
      }
      const reference = ctx.path === undefined
        ? undefined
        : referenceForSpan(ctx, {
            scheme: 'symbol',
            target: `${ctx.path}#venue:${venueOrdinal}`,
            span: entry.span,
            parserId: BOOK_PARSER_ID,
          })
      const node = pushNodeMetadata(ctx, nodes, {
        kind: 'venue',
        locator,
        ...(name.length === 0 ? {} : { name }),
        label: key,
        ...(reference === undefined ? {} : { reference }),
        fragment: fragmentForSpan(ctx, entry.span),
        source: 'front-matter',
        span: entry.span,
      })
      if (node !== undefined) {
        node.domain = concept
        concepts.push(concept)
      }
    }
    if (ctx.isStopped) break
  }

  /* ----------------------------------------------------------------------- *
   * 3. Table of contents → part / chapter / section nodes
   * ----------------------------------------------------------------------- */

  if (!ctx.isStopped) {
    const itemStack: Array<{ indent: number; locator: string }> = []
    const usedLocators = new Set<string>()
    const sectionOrdinals = new Map<string, number>()
    for (let index = bodyStart; index < lines.length; index += 1) {
      if (!tick()) break
      const line = lines[index]
      if (line === undefined) continue
      const item = parseTocItem(line)
      if (item === undefined) continue

      while (
        itemStack.length > 0 &&
        (itemStack[itemStack.length - 1] as { indent: number }).indent >= item.indent
      ) {
        itemStack.pop()
      }
      const level = itemStack.length + 1
      const kind: BookSectionKind = level === 1 ? 'part' : level === 2 ? 'chapter' : 'section'
      const ordinal = (sectionOrdinals.get(kind) ?? 0) + 1
      sectionOrdinals.set(kind, ordinal)
      const locator = uniqueLocator(usedLocators, `${kind}:${boundedLocatorKey(item.target)}`)
      const parent = itemStack.length === 0
        ? undefined
        : (itemStack[itemStack.length - 1] as { locator: string }).locator
      const name = item.name.trim()
      const span = lineSpan(line, item.itemStart, line.end)
      const reference = referenceForTocTarget(ctx, item.target)
      const concept: StructuralConcept = {
        kind,
        locator,
        ordinal,
        level,
        explicit: true,
        target: item.target,
        ...(parent === undefined ? {} : { partOf: parent }),
      }
      const node = pushNodeMetadata(ctx, nodes, {
        kind,
        locator,
        ...(name.length === 0 ? {} : { name }),
        ...(reference === undefined ? {} : { reference }),
        fragment: fragmentForSpan(ctx, span),
        source: 'summary',
        span,
      })
      if (node !== undefined) {
        node.domain = concept
        concepts.push(concept)
        addConceptChild(conceptChildren, parent, locator)
      }

      const targetSpan = lineSpan(line, item.targetStart, item.targetEnd)
      toc.push({
        kind,
        level,
        ...(name.length === 0 ? {} : { name }),
        target: item.target,
        locator,
        ...(reference === undefined ? {} : { reference }),
        span,
      })
      references.push({
        kind: 'markdown-link',
        specifier: item.target,
        external: isExternalTarget(item.target),
        span: targetSpan,
        ...fragmentForSpan(ctx, targetSpan),
      })

      itemStack.push({ indent: item.indent, locator })
      if (ctx.isStopped) break
    }
  }

  /* ----------------------------------------------------------------------- *
   * 4. Hierarchy, document metadata, AST and result
   * ----------------------------------------------------------------------- */

  for (const concept of concepts) {
    if (concept.locator === undefined) continue
    const children = conceptChildren.get(concept.locator)
    if (children !== undefined && children.length > 0) concept.contains = [...children]
  }

  let document: DocumentMetadata | undefined
  if (frontMatter.length > 0) {
    const titleEntry = frontByKey.get('title')
    const title = titleEntry === undefined ? '' : sanitizeMetadataText(titleEntry.value, MAX_NAME_LENGTH)
    const author = cleanedAuthors.length === 0
      ? ''
      : sanitizeMetadataText(cleanedAuthors.join(', '), MAX_NAME_LENGTH)
    const metadata: Record<string, string> = {}
    for (const entry of frontMatter) {
      const key = entry.key.toLowerCase()
      if (metadata[key] !== undefined) continue
      const value = sanitizeMetadataText(entry.value, MAX_NAME_LENGTH)
      if (value.length > 0) metadata[key] = value
    }
    document = {
      form: workKind ?? 'unknown',
      source: 'front-matter',
      ...(title.length === 0 ? {} : { title }),
      ...(author.length === 0 ? {} : { author }),
      metadata,
    }
  }

  let ast: AstTree<string> | undefined
  if (nodes.length > 0) {
    const root = createAstRoot('document', ctx.text.length)
    for (const node of nodes) {
      appendAstNode(ctx, root, node.kind, node.span, node.name)
    }
    ast = new AstTree(root)
  }

  return {
    ...ctx.finalize({
      parserId: BOOK_PARSER_ID,
      references,
      ...(ast === undefined ? {} : { ast }),
      ...(nodes.length === 0 ? {} : { nodes }),
      ...(document === undefined ? {} : { document }),
    }),
    frontMatter,
    toc,
  }
}

/** `Parser` implementation for book structures. */
export class BookParser implements Parser {
  readonly id = BOOK_PARSER_ID
  readonly extensions: readonly string[] = BOOK_EXTENSIONS
  readonly filenames: readonly string[] = BOOK_FILENAMES

  parse(text: string, options: ParseOptions = {}): BookParseResult {
    return parseBook(text, options)
  }
}

/** Shared instance; a `ParserRegistry` may register it directly. */
export const bookParser = new BookParser()

/* ------------------------------------------------------------------------- *
 * Front matter
 * ------------------------------------------------------------------------- */

/** True for the opening `---` line, tolerating a leading UTF-8 BOM. */
function isFrontMatterFence(line: TextLine, bomOffset: number): boolean {
  if (line.number !== 1) return line.text.trim() === '---'
  const text = bomOffset > 0 && line.text.startsWith('\uFEFF') ? line.text.slice(1) : line.text
  return text.trim() === '---'
}

/**
 * Parse one simple `key: value` line. Indented/block-scalar lines, blank lines,
 * comments and lines without a valid key are rejected (no YAML engine).
 */
function parseFrontMatterLine(line: TextLine): BookFrontMatterEntry | undefined {
  const text = line.text
  if (text.length === 0) return undefined
  const firstCode = text.charCodeAt(0)
  if (firstCode === 32 || firstCode === 9) return undefined
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return undefined
  const colon = text.indexOf(':')
  if (colon <= 0) return undefined
  const key = text.slice(0, colon).trim()
  if (!isFrontMatterKey(key)) return undefined
  const value = stripSurroundingQuotes(text.slice(colon + 1).trim())
  return { key, value, span: lineSpan(line, line.start, line.end) }
}

/** `type`, `title`, `author`, `venue`, ... — ASCII identifier keys only. */
function isFrontMatterKey(key: string): boolean {
  if (key.length === 0) return false
  if (!isAsciiLetter(key.charCodeAt(0))) return false
  for (let index = 1; index < key.length; index += 1) {
    const code = key.charCodeAt(index)
    if (isAsciiLetter(code) || isDigit(code) || code === 45 || code === 95) continue
    return false
  }
  return true
}

/**
 * Split an explicit author list on commas and semicolons only. The `and`
 * conjunction is deliberately *not* a separator: "Sand" is a name, and this
 * parser never guesses which token is a person.
 */
function splitAuthorNames(value: string): string[] {
  const names: string[] = []
  let start = 0
  for (let index = 0; index <= value.length; index += 1) {
    const code = index === value.length ? 59 /* ';' */ : value.charCodeAt(index)
    if (code !== 44 /* ',' */ && code !== 59) continue
    const name = stripSurroundingQuotes(value.slice(start, index).trim()).trim()
    if (name.length > 0) names.push(name)
    start = index + 1
  }
  return names
}

/** Strip one matching pair of surrounding single/double quotes. */
function stripSurroundingQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value.charCodeAt(0)
  const last = value.charCodeAt(value.length - 1)
  if ((first === 34 || first === 39) && first === last) return value.slice(1, -1).trim()
  return value
}

/* ------------------------------------------------------------------------- *
 * Table of contents
 * ------------------------------------------------------------------------- */

interface TocItem {
  /** Visual indentation (a tab counts as two columns). */
  indent: number
  /** Absolute offset of the list marker. */
  itemStart: number
  /** Raw link text. */
  name: string
  /** Normalised link target (angle brackets/optional title stripped). */
  target: string
  /** Absolute target offsets, for the reference occurrence span. */
  targetStart: number
  targetEnd: number
}

/**
 * Parse `- [name](target)` at the start of a line (indentation allowed).
 *
 * Character scanning only: no regular expression and no backtracking, so a
 * pathological line costs one linear pass.
 */
function parseTocItem(line: TextLine): TocItem | undefined {
  const text = line.text
  let cursor = 0
  let indent = 0
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code === 32) {
      indent += 1
      cursor += 1
      continue
    }
    if (code === 9) {
      indent += 2
      cursor += 1
      continue
    }
    break
  }
  const marker = text.charCodeAt(cursor)
  if (marker !== 45 && marker !== 42 && marker !== 43) return undefined // - * +
  const afterMarker = text.charCodeAt(cursor + 1)
  if (afterMarker !== 32 && afterMarker !== 9) return undefined
  cursor += 1
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code !== 32 && code !== 9) break
    cursor += 1
  }
  if (text.charCodeAt(cursor) !== 91) return undefined // '['
  const itemStart = line.start + cursor
  const nameStart = cursor + 1
  const nameEnd = text.indexOf(']', nameStart)
  if (nameEnd < 0 || text.charCodeAt(nameEnd + 1) !== 40) return undefined // '('
  const targetOpen = nameEnd + 1
  const targetClose = text.indexOf(')', targetOpen + 1)
  if (targetClose < 0) return undefined
  let start = targetOpen + 1
  while (start < targetClose) {
    const code = text.charCodeAt(start)
    if (code !== 32 && code !== 9) break
    start += 1
  }
  let end = targetClose
  while (end > start) {
    const code = text.charCodeAt(end - 1)
    if (code !== 32 && code !== 9) break
    end -= 1
  }
  if (start >= end) return undefined
  let target = text.slice(start, end)
  if (target.startsWith('<')) {
    const angleClose = target.indexOf('>')
    if (angleClose < 0) return undefined
    target = target.slice(1, angleClose)
    start += 1
    end = start + target.length
  } else {
    const whitespace = firstWhitespaceIndex(target)
    if (whitespace >= 0) {
      target = target.slice(0, whitespace)
      end = start + target.length
    }
  }
  if (target.length === 0) return undefined
  return {
    indent,
    itemStart,
    name: text.slice(nameStart, nameEnd),
    target,
    targetStart: line.start + start,
    targetEnd: line.start + end,
  }
}

/** First space/tab inside a link destination, or `-1`. */
function firstWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 32 || code === 9) return index
  }
  return -1
}

/** Cap the link-target part of a locator so locators stay bounded. */
function boundedLocatorKey(target: string): string {
  if (target.length <= MAX_BOOK_LOCATOR_LENGTH) return target
  return `${target.slice(0, MAX_BOOK_LOCATOR_LENGTH - 1)}…`
}

/** Make a locator unique within one parse without losing source order. */
function uniqueLocator(used: Set<string>, base: string): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let ordinal = 2
  let candidate = `${base}~${ordinal}`
  while (used.has(candidate)) {
    ordinal += 1
    candidate = `${base}~${ordinal}`
  }
  used.add(candidate)
  return candidate
}

/** Add a child locator to a concept's `contains` list (bounded, deduplicated). */
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
  if (!list.includes(child) && list.length < MAX_CONCEPT_CHILDREN) list.push(child)
}

/* ------------------------------------------------------------------------- *
 * Link targets
 * ------------------------------------------------------------------------- */

/**
 * Body-free reference at a TOC link target: `file` for a workspace-relative
 * target (resolved lexically against the TOC file, when its path is known),
 * `url` for http(s). No bytes/lines are attached, because the coordinates would
 * belong to a different file; the node's own flat fragment covers the listing
 * line. Anything else (anchors, other schemes, an unknown base path, escaping
 * paths) yields `undefined` — the target is still kept on `locator`, so nothing
 * is guessed.
 */
function referenceForTocTarget(ctx: ParseContext, target: string): NodeReference | undefined {
  try {
    if (isExternalTarget(target)) {
      if (!isHttpUrl(target)) return undefined
      return createNodeReference({
        scheme: 'url',
        target,
        charset: ctx.charset,
        parserId: BOOK_PARSER_ID,
        external: true,
      })
    }
    // Without the TOC file's workspace path there is no explicit base for a
    // relative target, so the link is not turned into a file reference.
    if (ctx.path === undefined) return undefined
    const resolved = resolveWorkspaceTarget(ctx.path, target)
    if (resolved === undefined) return undefined
    return createNodeReference({
      scheme: 'file',
      path: resolved,
      target: resolved,
      charset: ctx.charset,
      parserId: BOOK_PARSER_ID,
    })
  } catch {
    return undefined
  }
}

/** Resolve a link target to a workspace path, purely lexically. */
function resolveWorkspaceTarget(basePath: string | undefined, target: string): string | undefined {
  const hash = target.indexOf('#')
  const filePart = (hash >= 0 ? target.slice(0, hash) : target).trim()
  if (filePart.length === 0) return undefined
  const normalised = filePart.replace(/\\/g, '/')
  if (normalised.startsWith('/')) return undefined
  if (
    normalised.length >= 2 &&
    isAsciiLetter(normalised.charCodeAt(0)) &&
    normalised.charCodeAt(1) === 58 /* ':' */
  ) {
    return undefined
  }
  let prefix = ''
  if (basePath !== undefined) {
    const base = basePath.replace(/\\/g, '/')
    const slash = base.lastIndexOf('/')
    if (slash >= 0) prefix = base.slice(0, slash + 1)
  }
  return normaliseWorkspacePath(`${prefix}${normalised}`)
}

/** True for `#fragment`, `//host`, and any `scheme:` target (case-aware). */
function isExternalTarget(value: string): boolean {
  const target = value.trim()
  if (target.startsWith('#')) return true
  if (target.startsWith('//')) return true
  return hasUrlScheme(target)
}

/** `http://`/`https://` only, case-insensitively. */
function isHttpUrl(value: string): boolean {
  const head = value.slice(0, 8).toLowerCase()
  return head.startsWith('http://') || head.startsWith('https://')
}

/** Lexical URL-scheme probe: an ASCII letter followed by RFC 3986 scheme chars then `:`. */
function hasUrlScheme(value: string): boolean {
  if (value.length < 2 || !isAsciiLetter(value.charCodeAt(0))) return false
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 58 /* ':' */) return true
    if (isAsciiLetter(code) || isDigit(code) || code === 43 || code === 45 || code === 46) continue
    return false
  }
  return false
}

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

/** One line-backed span (1-based line, 1-based column). */
function lineSpan(line: TextLine, start: number, end: number): SourceSpan {
  return { start, end, line: line.number, column: start - line.start + 1 }
}

/** True for ASCII `A`–`Z` / `a`–`z`. */
function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/** True for `0`–`9`. */
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}
