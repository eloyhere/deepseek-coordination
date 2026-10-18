/**
 * Read-only OOXML parser for Word (`.docx`), Excel (`.xlsx`) and PowerPoint
 * (`.pptx`) documents, plus explicit refusal of the proprietary Publisher
 * (`.pub`) and Access (`.accdb`) formats.
 *
 * The layer is **descriptive only**: it never writes a package, never converts
 * a format, never executes a macro or formula, and never starts Office or
 * LibreOffice. A formula is emitted as a text `name` only; no value is
 * evaluated and no cell is materialised. Every returned `NodeMetadata` is
 * body-free — it carries a kind, an explicit name/label, a locator and a span,
 * never paragraph text, cell values, slide text or package bytes.
 *
 * ## Evidence direction
 *
 * A node exists only because the package contains the element/attribute that
 * states it:
 *
 * | Package evidence | Node |
 * |---|---|
 * | `word/document.xml` root | `document` |
 * | `w:p` + `w:pPr/w:pStyle` = `Heading1` | `chapter` (name = heading runs) |
 * | the same with `Heading2`/`Heading3` | `section` (name = heading runs) |
 * | any other explicit `w:pStyle` | `paragraph` (no name; no body text) |
 * | `w:hyperlink` resolved through `word/_rels/document.xml.rels` | `link` (name = target) |
 * | `xl/workbook.xml` root | `workbook` |
 * | `xl/workbook.xml` `sheet` element | `sheet` (name = `name` attribute) |
 * | worksheet `dimension/@ref` | `range` (name = the explicit reference) |
 * | worksheet `<f>` with text | `formula` (name = formula text, capped at 200) |
 * | `ppt/presentation.xml` root | `document` |
 * | `p:sldId` entry resolved through `ppt/_rels/presentation.xml.rels` | `slide` |
 *
 * Nothing is inferred from prose, style names other than the explicit
 * Heading1/2/3 ids, cell values or slide/shape text. A missing relationship is
 * reported as `unverifiable`, never guessed: in particular a worksheet or slide
 * is never attached to a different sheet/slide than the relationship names, so
 * ownership cannot be wrong (containment links are simply left out).
 *
 * ## Bounds (all fail closed, all reported as diagnostics)
 *
 * | Budget | Value |
 * |---|---|
 * | ZIP entries | 2,000 |
 * | uncompressed bytes per entry | 64 MiB |
 * | uncompressed bytes across entries | 256 MiB |
 * | XML part bytes actually parsed | 16 MiB (metadata parts 2 MiB) |
 * | XML nesting | 128 tags (`fast-xml-parser` `maxNestedTags`) |
 * | wall clock | `MAX_PARSE_MS` (2,000 ms), lowered by `options.timeoutMs` |
 * | node metadata | `MAX_METADATA_NODES` (20,000) |
 * | diagnostics | `MAX_DIAGNOSTICS` (100) |
 *
 * The ZIP is read with `fflate.unzipSync`; its `filter` callback runs before
 * decompression, so an entry-count, per-entry-size or total-size violation
 * refuses the archive before a bomb can expand. XML is parsed with
 * `fast-xml-parser` (`preserveOrder`, no DTD/entity processing, explicit depth
 * cap); a malformed package returns diagnostics and never throws.
 *
 * ## Spans
 *
 * `NodeMetadata.span` is relative to the **decompressed XML part** it came from
 * (the part name is carried in `locator`, e.g.
 * `word/document.xml#chapter:1`). No `path`/byte range is fabricated: a ZIP
 * compresses the XML, so the original file byte offset of an element is not
 * recoverable from the decoded part without re-encoding it. Consumers that
 * need a file coordinate read the file through the host's authorized content
 * path instead.
 *
 * The parser is deliberately **not registered** in `text/index.ts`; a later
 * wiring change can register {@link OfficeParser} once the file layer has a
 * binary-read path that does not reject NUL bytes.
 */
import { unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import {
  MAX_DIAGNOSTICS,
  MAX_METADATA_NODES,
  MAX_NAME_LENGTH,
  MAX_PARSE_MS,
  extensionOf,
} from './parser.js'
import type {
  Diagnostic,
  DiagnosticCode,
  DocumentMetadata,
  MetadataSource,
  NodeMetadata,
  ParseOptions,
  ParseResult,
  Parser,
} from './parser.js'
import type { SourceSpan } from '../../shared/ast.js'

/* ------------------------------------------------------------------------- *
 * Public contract
 * ------------------------------------------------------------------------- */

/** Parser id used by the metadata-only result. */
export const OFFICE_PARSER_ID = 'office'

/** Supported container extensions (the parser is not registered automatically). */
export const OFFICE_EXTENSIONS: readonly string[] = ['.docx', '.xlsx', '.pptx', '.pub', '.accdb']

/** Maximum number of central-directory entries accepted from one ZIP (2,000). */
export const MAX_ZIP_ENTRIES = 2_000
/** Maximum uncompressed size of one ZIP entry (64 MiB). */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024
/** Maximum uncompressed size of all ZIP entries together (256 MiB). */
export const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024
/** Maximum compressed input bytes accepted (defensive cap; 512 MiB). */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
/** Maximum XML part size actually handed to the XML parser (16 MiB). */
export const MAX_XML_PART_BYTES = 16 * 1024 * 1024
/** Maximum size of a metadata-only part (content types, rels, core props; 2 MiB). */
export const MAX_METADATA_PART_BYTES = 2 * 1024 * 1024
/** Maximum XML nesting accepted by the parser (128 tags). */
export const MAX_XML_DEPTH = 128

/** Container format recognised by {@link parseOffice}. */
export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pub' | 'accdb' | 'unknown'

/**
 * Diagnostic code. `unsupported-format` is parser-specific: the shared
 * `DiagnosticCode` union is owned by `parser.ts`, which this module must not
 * edit, so the widened local union keeps the explicit refusal code without
 * silently degrading it to `unverifiable`.
 */
export type OfficeDiagnosticCode = DiagnosticCode | 'unsupported-format'

/** One bounded, span-free diagnostic (office nodes carry part-relative spans). */
export interface OfficeDiagnostic extends Omit<Diagnostic, 'code'> {
  code: OfficeDiagnosticCode
}

/** Parse options plus an optional explicit format hint for non-ZIP inputs. */
export interface OfficeParseOptions extends ParseOptions {
  /**
   * Explicit format. Used for `.pub`/`.accdb` refusal and as a fallback when a
   * ZIP has no recognisable OOXML part; package content still wins over a hint.
   */
  format?: OfficeFormat
}

/** The body-free result shape; `diagnostics` is widened for `unsupported-format`. */
export interface OfficeParseResult extends Omit<ParseResult, 'diagnostics'> {
  diagnostics: OfficeDiagnostic[]
  /** Detected (or explicitly requested) container format. */
  format: OfficeFormat
  /** True when the container/format was refused before any node was produced. */
  refused: boolean
}

/** Accepted input: raw bytes, an ArrayBuffer, or a byte-preserving string. */
export type OfficeInput = string | Uint8Array | ArrayBuffer

/**
 * Parse one Office package.
 *
 * Never throws for malformed, corrupt, oversized or unsupported input: those
 * become diagnostics and, where the evidence is unusable, `refused: true` with
 * no nodes. A pre-aborted `options.signal` is the only exception, matching the
 * `Parser` contract.
 */
export function parseOffice(input: OfficeInput, options: OfficeParseOptions = {}): OfficeParseResult {
  const ctx = new OfficeContext(options)
  try {
    return parseOfficeInternal(input, options, ctx)
  } catch (error) {
    if (isAbortError(error)) throw error
    ctx.parseError(`unexpected Office parser failure: ${describeError(error)}`)
    ctx.refused = true
    return buildResult(ctx, 'unknown', [])
  }
}

/** `Parser` adapter, exported but intentionally not registered. */
export class OfficeParser implements Parser {
  readonly id = OFFICE_PARSER_ID
  readonly extensions: readonly string[] = OFFICE_EXTENSIONS

  parse(text: string, options: ParseOptions = {}): ParseResult {
    // The shared Parser contract is text-in. The file layer's binary-read path
    // must hand this parser a byte-preserving (Latin-1) string until the
    // contract grows a byte input; `parseOffice` is the direct byte API.
    return parseOffice(text, options) as unknown as ParseResult
  }
}

export const officeParser = new OfficeParser()

/* ------------------------------------------------------------------------- *
 * Entry
 * ------------------------------------------------------------------------- */

function parseOfficeInternal(
  input: OfficeInput,
  options: OfficeParseOptions,
  ctx: OfficeContext,
): OfficeParseResult {
  options.signal?.throwIfAborted()
  if (!ctx.checkpoint()) return buildResult(ctx, 'unknown', [])

  const extension = options.path === undefined ? undefined : extensionOf(options.path)
  const requested = requestedFormat(options.format)
  if (options.format !== undefined && requested === undefined) {
    ctx.unverifiable(`unknown requested Office format "${String(options.format)}"; auto-detection used`)
  }

  // Proprietary formats are refused by explicit extension/hint, before any
  // content sniff: their binary layout is not a ZIP and is not approximated.
  if (requested === 'pub' || requested === 'accdb') return unsupportedFormat(ctx, requested)
  if (extension === '.pub' || extension === '.accdb') {
    return unsupportedFormat(ctx, extension === '.pub' ? 'pub' : 'accdb')
  }

  const bytes = toBytes(input)
  if (bytes === undefined || bytes.length === 0) {
    ctx.parseError('empty input; there is no ZIP container to describe')
    ctx.refused = true
    return buildResult(ctx, requested ?? extensionFormat(extension) ?? 'unknown', [])
  }
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    ctx.limit('node-limit', `input exceeds the ${MAX_ARCHIVE_BYTES}-byte archive cap; refused`)
    ctx.refused = true
    return buildResult(ctx, requested ?? extensionFormat(extension) ?? 'unknown', [])
  }
  if (isOleCompoundFile(bytes)) {
    // Legacy/encrypted Office containers (including .pub/.accdb and a
    // password-protected OOXML package) are OLE compound files, not ZIPs.
    ctx.add(
      'unsupported-format',
      'legacy/encrypted OLE compound binary is not an OOXML ZIP package; structure is unverifiable and no nodes are produced',
    )
    ctx.refused = true
    return buildResult(ctx, requested ?? extensionFormat(extension) ?? 'unknown', [])
  }

  const zip = readZipParts(bytes, ctx)
  if (zip.refused) {
    ctx.refused = true
    return buildResult(ctx, requested ?? extensionFormat(extension) ?? 'unknown', [])
  }

  const detected = detectFormat(zip.parts)
  const hinted = requested ?? extensionFormat(extension)
  const format = detected ?? hinted ?? 'unknown'
  if (detected !== undefined && requested !== undefined && requested !== detected) {
    ctx.unverifiable(
      `requested format "${requested}" does not match the package content ("${detected}"); parsed as "${detected}"`,
    )
  }
  if (detected !== undefined && requested === undefined && extension !== undefined) {
    const fromExtension = extensionFormat(extension)
    if (fromExtension !== undefined && fromExtension !== detected) {
      ctx.unverifiable(
        `path extension "${extension}" does not match the package content ("${detected}"); parsed as "${detected}"`,
      )
    }
  }
  if (format === 'unknown') {
    ctx.unverifiable(
      'ZIP container is not a recognised OOXML package (no wordprocessingml, spreadsheetml or presentationml part)',
    )
    ctx.refused = true
    return buildResult(ctx, 'unknown', [])
  }
  if (!ctx.checkpoint()) return buildResult(ctx, format, [])

  const xml = createXmlParser()
  switch (format) {
    case 'docx':
      return parseDocx(zip.parts, ctx, options, xml)
    case 'xlsx':
      return parseXlsx(zip.parts, ctx, options, xml)
    case 'pptx':
      return parsePptx(zip.parts, ctx, options, xml)
    case 'pub':
    case 'accdb':
      return unsupportedFormat(ctx, format)
  }
}

/** Explicit refusal for the proprietary binary formats; no nodes are invented. */
function unsupportedFormat(ctx: OfficeContext, format: 'pub' | 'accdb'): OfficeParseResult {
  ctx.refused = true
  ctx.add(
    'unsupported-format',
    `${format === 'pub' ? 'Publisher (.pub)' : 'Access (.accdb)'} is a proprietary binary format; ` +
      'its structure is unverifiable and no nodes are produced',
  )
  return buildResult(ctx, format, [])
}

/* ------------------------------------------------------------------------- *
 * Result and context
 * ------------------------------------------------------------------------- */

class OfficeContext {
  readonly diagnostics: OfficeDiagnostic[] = []
  truncated = false
  refused = false
  /** Explicit `docProps/core.xml` title, when present. */
  title: string | undefined
  /** Explicit `docProps/core.xml` creator, when present. */
  author: string | undefined

  private readonly deadline: number
  private readonly timeoutMs: number
  private readonly signal: AbortSignal | undefined
  private readonly seen = new Set<string>()
  private timedOut = false
  private nodeCapReported = false

  constructor(options: OfficeParseOptions) {
    this.signal = options.signal
    const requestedTimeout = options.timeoutMs
    this.timeoutMs = typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout)
      ? Math.min(Math.max(0, Math.trunc(requestedTimeout)), MAX_PARSE_MS)
      : MAX_PARSE_MS
    this.deadline = Date.now() + this.timeoutMs
  }

  /** Deadline/abort gate. Throws only for an aborted signal (the Parser contract). */
  checkpoint(): boolean {
    if (this.signal !== undefined) this.signal.throwIfAborted()
    if (this.timedOut) return false
    if (Date.now() < this.deadline) return true
    this.timedOut = true
    this.truncated = true
    this.add('timeout', `Office parse exceeded its ${this.timeoutMs} ms budget; returned the parsed prefix`)
    return false
  }

  /** Add one diagnostic, deduplicated by code+message and capped. */
  add(code: OfficeDiagnosticCode, message: string): void {
    if (this.diagnostics.length >= MAX_DIAGNOSTICS) return
    const key = `${code}\u0000${message}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.diagnostics.push({ code, message: clipText(message, 300), severity: 'warning' })
  }

  /** Record an observation once per key (used for repeated missing relationships). */
  note(key: string, message: string): void {
    if (this.seen.has(`note\u0000${key}`)) return
    this.seen.add(`note\u0000${key}`)
    this.unverifiable(message)
  }

  unverifiable(message: string): void {
    this.add('unverifiable', message)
  }

  parseError(message: string): void {
    this.add('parse-error', message)
  }

  /** Record a hard limit; sets `truncated`. */
  limit(code: DiagnosticCode, message: string): void {
    this.truncated = true
    this.add(code, message)
  }

  /** Append one node under `MAX_METADATA_NODES`; returns false when the cap is hit. */
  push(nodes: NodeMetadata[], node: NodeMetadata): boolean {
    if (nodes.length >= MAX_METADATA_NODES) {
      if (!this.nodeCapReported) {
        this.nodeCapReported = true
        this.limit('node-limit', `node metadata limit ${MAX_METADATA_NODES} reached; later nodes were dropped`)
      }
      return false
    }
    nodes.push(node)
    return true
  }
}

function buildResult(ctx: OfficeContext, format: OfficeFormat, nodes: NodeMetadata[]): OfficeParseResult {
  const result: OfficeParseResult = {
    parserId: OFFICE_PARSER_ID,
    references: [],
    diagnostics: [...ctx.diagnostics],
    truncated: ctx.truncated,
    tokens: 0,
    charset: 'binary',
    bomBytes: 0,
    format,
    refused: ctx.refused,
  }
  if (nodes.length > 0) result.nodes = nodes
  const document = documentMetadata(format, ctx.title, ctx.author)
  if (document !== undefined) result.document = document
  return result
}

function documentMetadata(
  format: OfficeFormat,
  title: string | undefined,
  author: string | undefined,
): DocumentMetadata | undefined {
  const optional = {
    ...(title === undefined || title.length === 0 ? {} : { title }),
    ...(author === undefined || author.length === 0 ? {} : { author }),
  }
  switch (format) {
    case 'docx':
      // A .docx can be an article, a book or a note; the container does not
      // prove which, so the form stays explicitly unknown.
      return { form: 'unknown', source: 'extension', ...optional }
    case 'xlsx':
      return { form: 'workbook', source: 'extension', ...optional }
    case 'pptx':
      return { form: 'deck', source: 'extension', ...optional }
    default:
      return undefined
  }
}

function requestedFormat(value: OfficeFormat | undefined): OfficeFormat | undefined {
  if (value === 'docx' || value === 'xlsx' || value === 'pptx' || value === 'pub' || value === 'accdb') {
    return value
  }
  return undefined
}

function extensionFormat(extension: string | undefined): OfficeFormat | undefined {
  switch (extension) {
    case '.docx':
      return 'docx'
    case '.xlsx':
      return 'xlsx'
    case '.pptx':
      return 'pptx'
    case '.pub':
      return 'pub'
    case '.accdb':
      return 'accdb'
    default:
      return undefined
  }
}

/* ------------------------------------------------------------------------- *
 * ZIP container (fflate; bounds enforced before decompression)
 * ------------------------------------------------------------------------- */

class ZipRefusal extends Error {
  constructor(
    readonly code: DiagnosticCode,
    message: string,
    readonly truncated: boolean,
  ) {
    super(message)
    this.name = 'ZipRefusal'
  }
}

interface ZipReadResult {
  parts: Map<string, Uint8Array>
  refused: boolean
}

/**
 * Decompress only the package parts the office readers can use, after enforcing
 * all archive bounds. `fflate`'s filter runs per central-directory entry before
 * decompression, so the refusal happens before a bomb expands.
 */
function readZipParts(bytes: Uint8Array, ctx: OfficeContext): ZipReadResult {
  const parts = new Map<string, Uint8Array>()
  const state = { entries: 0, total: 0 }
  const accepted = new Set<string>()
  try {
    const files = unzipSync(bytes, {
      filter: (file) => {
        state.entries += 1
        if (state.entries > MAX_ZIP_ENTRIES) {
          throw new ZipRefusal(
            'node-limit',
            `ZIP entry limit ${MAX_ZIP_ENTRIES} exceeded; archive refused`,
            true,
          )
        }
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
          throw new ZipRefusal('parse-error', 'ZIP entry has an invalid uncompressed size; archive refused', false)
        }
        if (file.originalSize > MAX_ZIP_ENTRY_BYTES) {
          throw new ZipRefusal(
            'node-limit',
            `ZIP entry exceeds the ${MAX_ZIP_ENTRY_BYTES}-byte uncompressed cap (possible zip bomb); archive refused`,
            true,
          )
        }
        state.total += file.originalSize
        if (state.total > MAX_ZIP_TOTAL_BYTES) {
          throw new ZipRefusal(
            'node-limit',
            `ZIP uncompressed total exceeds the ${MAX_ZIP_TOTAL_BYTES}-byte cap (possible zip bomb); archive refused`,
            true,
          )
        }
        const name = canonicalPartName(file.name)
        if (name === undefined || !isOfficePart(name)) return false
        if (accepted.has(name)) {
          throw new ZipRefusal('parse-error', `duplicate ZIP entry "${name}"; archive refused`, false)
        }
        if (file.compression !== 0 && file.compression !== 8) {
          ctx.unverifiable(`part "${name}" uses unsupported ZIP compression method ${file.compression}; skipped`)
          ctx.truncated = true
          return false
        }
        const partLimit = isMetadataPart(name) ? MAX_METADATA_PART_BYTES : MAX_XML_PART_BYTES
        if (file.originalSize > partLimit) {
          ctx.unverifiable(`part "${name}" exceeds the ${partLimit}-byte XML part cap; skipped`)
          ctx.truncated = true
          return false
        }
        accepted.add(name)
        return true
      },
    })
    for (const [name, data] of Object.entries(files)) {
      if (data instanceof Uint8Array) parts.set(name, data)
    }
  } catch (error) {
    if (error instanceof ZipRefusal) {
      ctx.add(error.code, error.message)
      if (error.truncated) ctx.truncated = true
      return { parts, refused: true }
    }
    ctx.parseError(`not a readable ZIP container: ${describeError(error)}`)
    return { parts, refused: true }
  }
  if (state.entries === 0) {
    ctx.parseError('ZIP container has no central-directory entries')
    return { parts, refused: true }
  }
  return { parts, refused: false }
}

/** Canonical package part name, or undefined for directories/traversal/non-canonical names. */
function canonicalPartName(name: string): string | undefined {
  if (typeof name !== 'string' || name.length === 0 || name.length > 512) return undefined
  if (name.startsWith('/') || name.includes('\\') || name.includes('\u0000')) return undefined
  const segments = name.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return undefined
  }
  return name
}

/** Parts the readers may need. Images, media, macros and every other entry are counted, never decompressed. */
function isOfficePart(name: string): boolean {
  if (
    name === '[Content_Types].xml' ||
    name === 'docProps/core.xml' ||
    name === 'word/document.xml' ||
    name === 'word/_rels/document.xml.rels' ||
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name === 'ppt/presentation.xml' ||
    name === 'ppt/_rels/presentation.xml.rels'
  ) {
    return true
  }
  if (name.startsWith('xl/worksheets/')) return isFlatXmlPart(name.slice('xl/worksheets/'.length))
  if (name.startsWith('ppt/slides/')) return isFlatXmlPart(name.slice('ppt/slides/'.length))
  return false
}

function isFlatXmlPart(rest: string): boolean {
  return rest.length > '.xml'.length && rest.endsWith('.xml') && !rest.includes('/')
}

function isMetadataPart(name: string): boolean {
  return (
    name === '[Content_Types].xml' ||
    name === 'docProps/core.xml' ||
    name.endsWith('.rels')
  )
}

/** Detect the package family from content types plus explicit part names. */
function detectFormat(parts: Map<string, Uint8Array>): OfficeFormat | undefined {
  const contentTypes = parts.get('[Content_Types].xml')
  if (contentTypes !== undefined && contentTypes.length <= MAX_METADATA_PART_BYTES) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(contentTypes).toLowerCase()
    if (text.includes('wordprocessingml')) return 'docx'
    if (text.includes('spreadsheetml')) return 'xlsx'
    if (text.includes('presentationml')) return 'pptx'
  }
  if (parts.has('word/document.xml')) return 'docx'
  if (parts.has('xl/workbook.xml') || hasPartUnder(parts, 'xl/worksheets/')) return 'xlsx'
  if (parts.has('ppt/presentation.xml') || hasPartUnder(parts, 'ppt/slides/')) return 'pptx'
  return undefined
}

function hasPartUnder(parts: Map<string, Uint8Array>, prefix: string): boolean {
  for (const name of parts.keys()) {
    if (name.startsWith(prefix)) return true
  }
  return false
}

/* ------------------------------------------------------------------------- *
 * XML parsing (fast-xml-parser, ordered and bounded)
 * ------------------------------------------------------------------------- */

interface XmlRecord {
  [key: string]: unknown
}

interface ParsedXml {
  text: string
  nodes: XmlRecord[]
}

type XmlAttributeMap = Record<string, unknown>

/**
 * Ordered, prefixed XML parser. Prefixes are kept (`w:p`, `r:id`) so an
 * element's unprefixed `id` and its `r:id` relationship attribute cannot
 * collide; matching strips prefixes with {@link localName}.
 */
function createXmlParser(): XMLParser {
  return new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    attributesGroupName: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    // No DTD, no named-entity expansion, no external entity resolution.
    processEntities: false,
    allowBooleanAttributes: false,
    maxNestedTags: MAX_XML_DEPTH,
    ignoreDeclaration: true,
    ignorePiTags: true,
    captureMetaData: true,
  })
}

const XML_METADATA_SYMBOL: symbol | undefined = (() => {
  try {
    const reader = (XMLParser as unknown as { getMetaDataSymbol?: () => unknown }).getMetaDataSymbol
    if (typeof reader !== 'function') return undefined
    const value = reader()
    return typeof value === 'symbol' ? value : undefined
  } catch {
    return undefined
  }
})()

/** Parse one XML part, or return undefined with a diagnostic. Never throws. */
function parseXmlPart(
  ctx: OfficeContext,
  partName: string,
  bytes: Uint8Array,
  parser: XMLParser,
): ParsedXml | undefined {
  if (bytes.length === 0) {
    ctx.parseError(`part "${partName}" is empty`)
    ctx.truncated = true
    return undefined
  }
  if (bytes.length > MAX_XML_PART_BYTES) {
    ctx.unverifiable(`part "${partName}" exceeds the ${MAX_XML_PART_BYTES}-byte XML parse cap; skipped`)
    ctx.truncated = true
    return undefined
  }
  const decoded = decodeXmlBytes(bytes)
  if (decoded.text === undefined) {
    ctx.parseError(`part "${partName}": ${decoded.error}`)
    ctx.truncated = true
    return undefined
  }
  const text = decoded.text
  if (text.includes('<!DOCTYPE') || text.includes('<!ENTITY')) {
    ctx.parseError(`part "${partName}": DTD/entity declarations are not allowed in OOXML`)
    ctx.truncated = true
    return undefined
  }
  try {
    const parsed = parser.parse(text)
    if (!Array.isArray(parsed)) {
      ctx.parseError(`part "${partName}": XML parser did not return an ordered node list`)
      ctx.truncated = true
      return undefined
    }
    return { text, nodes: parsed as XmlRecord[] }
  } catch (error) {
    ctx.parseError(`part "${partName}": malformed XML (${describeError(error)})`)
    ctx.truncated = true
    return undefined
  }
}

function decodeXmlBytes(bytes: Uint8Array): { text?: string; error?: string } {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le', { fatal: true }).decode(bytes) }
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder('utf-16be', { fatal: true }).decode(bytes) }
    }
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { error: 'not valid UTF-8/UTF-16 XML' }
  }
}

/* ------------------------------------------------------------------------- *
 * Ordered XML helpers
 * ------------------------------------------------------------------------- */

function isTextNode(node: XmlRecord): boolean {
  return typeof node['#text'] === 'string'
}

/** The element key of an ordered `fast-xml-parser` node (`w:p`, `dimension`, ...). */
function tagNameOf(node: XmlRecord): string | undefined {
  for (const key of Object.keys(node)) {
    if (key !== ':@' && key !== '#text') return key
  }
  return undefined
}

function childrenOf(node: XmlRecord): XmlRecord[] {
  const tag = tagNameOf(node)
  if (tag === undefined) return []
  const value = node[tag]
  return Array.isArray(value) ? (value as XmlRecord[]) : []
}

function attributesOf(node: XmlRecord): XmlAttributeMap {
  const value = node[':@']
  return typeof value === 'object' && value !== null ? (value as XmlAttributeMap) : {}
}

/** Local part of a prefixed XML name (`w:val` → `val`, `Relationship` → `Relationship`). */
function localName(name: string): string {
  const colon = name.lastIndexOf(':')
  return colon >= 0 ? name.slice(colon + 1) : name
}

/** First attribute whose local name matches, decoded later by the caller. */
function attribute(node: XmlRecord, name: string): string | undefined {
  for (const [key, value] of Object.entries(attributesOf(node))) {
    if (typeof value !== 'string') continue
    const raw = key.startsWith('@_') ? key.slice(2) : key
    if (localName(raw) === name) return value
  }
  return undefined
}

/**
 * Relationship id (`r:id` / any prefixed `*:id`), ignoring an element's own
 * unprefixed `id`. `p:sldId` carries both `id` and `r:id`; only the latter
 * names a relationship.
 */
function relationshipId(node: XmlRecord): string | undefined {
  for (const [key, value] of Object.entries(attributesOf(node))) {
    if (typeof value !== 'string') continue
    const raw = key.startsWith('@_') ? key.slice(2) : key
    if (raw.includes(':') && localName(raw) === 'id') return value
  }
  return undefined
}

/** Concatenated direct/nested text of one element, bounded. */
function textContent(node: XmlRecord, limit = 4_096): string {
  let text = ''
  const append = (value: string): void => {
    if (text.length >= limit) return
    const room = limit - text.length
    text += value.length <= room ? value : value.slice(0, room)
  }
  const walk = (children: XmlRecord[]): void => {
    for (const child of children) {
      if (text.length >= limit) return
      if (isTextNode(child)) {
        append(child['#text'] as string)
        continue
      }
      walk(childrenOf(child))
    }
  }
  walk(childrenOf(node))
  return text
}

/** Source span of an element in its decompressed XML part. */
function spanOf(node: XmlRecord): SourceSpan {
  if (XML_METADATA_SYMBOL !== undefined) {
    const meta = (node as unknown as Record<symbol, unknown>)[XML_METADATA_SYMBOL]
    if (typeof meta === 'object' && meta !== null) {
      const start = (meta as { startIndex?: unknown }).startIndex
      const end = (meta as { endIndex?: unknown }).endIndex
      if (typeof start === 'number' && Number.isFinite(start) && start >= 0) {
        const finish = typeof end === 'number' && Number.isFinite(end) && end >= start ? end : start
        return { start, end: finish, line: 1, column: 1 }
      }
    }
  }
  return { start: 0, end: 0, line: 1, column: 1 }
}

function rootSpan(parsed: ParsedXml): SourceSpan {
  for (const node of parsed.nodes) {
    if (isTextNode(node)) continue
    return spanOf(node)
  }
  return { start: 0, end: parsed.text.length, line: 1, column: 1 }
}

function findRoot(parsed: ParsedXml): XmlRecord | undefined {
  for (const node of parsed.nodes) {
    if (!isTextNode(node)) return node
  }
  return undefined
}

function findFirstElement(nodes: XmlRecord[], wanted: string, ctx: OfficeContext): XmlRecord | undefined {
  let found: XmlRecord | undefined
  walkOrdered(nodes, ctx, (node, tag) => {
    if (found !== undefined) return false
    if (tag === wanted) {
      found = node
      return false
    }
    return undefined
  })
  return found
}

function collectElements(nodes: XmlRecord[], wanted: string, ctx: OfficeContext): XmlRecord[] {
  const found: XmlRecord[] = []
  walkOrdered(nodes, ctx, (node, tag) => {
    if (found.length >= MAX_ZIP_ENTRIES) return false
    if (tag === wanted) found.push(node)
    return undefined
  })
  return found
}

/** Depth-first ordered walk with a deadline checkpoint per element. */
function walkOrdered(
  nodes: XmlRecord[],
  ctx: OfficeContext,
  visit: (node: XmlRecord, tag: string) => boolean | void,
): void {
  let stopped = false
  const walk = (children: XmlRecord[]): void => {
    for (const node of children) {
      if (stopped) return
      if (!ctx.checkpoint()) {
        stopped = true
        return
      }
      if (isTextNode(node)) continue
      const tag = tagNameOf(node)
      if (tag === undefined) continue
      if (visit(node, localName(tag)) === false) {
        stopped = true
        return
      }
      walk(childrenOf(node))
    }
  }
  walk(nodes)
}

/* ------------------------------------------------------------------------- *
 * Relationships and part resolution
 * ------------------------------------------------------------------------- */

interface Relationship {
  target: string
  external: boolean
}

function parseRelationships(
  ctx: OfficeContext,
  partName: string,
  parts: Map<string, Uint8Array>,
  parser: XMLParser,
): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>()
  const bytes = parts.get(partName)
  if (bytes === undefined) return relationships
  const parsed = parseXmlPart(ctx, partName, bytes, parser)
  if (parsed === undefined) return relationships
  walkOrdered(parsed.nodes, ctx, (node, tag) => {
    if (tag !== 'Relationship') return undefined
    const id = attribute(node, 'Id')
    const target = attribute(node, 'Target')
    if (id === undefined || target === undefined || id.length === 0 || target.length === 0) {
      return undefined
    }
    if (relationships.has(id)) return undefined
    const mode = attribute(node, 'TargetMode')
    relationships.set(id, {
      target,
      external: mode !== undefined && mode.toLowerCase() === 'external',
    })
    return undefined
  })
  return relationships
}

/** Resolve a relationship target against a part's base directory (lexical only). */
function resolvePartTarget(baseDir: string, target: string): string | undefined {
  let raw = target.replace(/\\/g, '/').trim()
  if (raw.length === 0 || raw.includes('\u0000')) return undefined
  // An absolute URI is never a package part.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return undefined
  if (raw.startsWith('/')) raw = raw.slice(1)
  else if (baseDir.length > 0) raw = `${baseDir}/${raw}`
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : undefined
}

interface LocatedPart {
  name: string
  bytes: Uint8Array
}

/** Exact package-part lookup, with a percent-decoding fallback for URI-style targets. */
function findPart(parts: Map<string, Uint8Array>, name: string | undefined): LocatedPart | undefined {
  if (name === undefined) return undefined
  const direct = parts.get(name)
  if (direct !== undefined) return { name, bytes: direct }
  if (!name.includes('%')) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(name)
  } catch {
    return undefined
  }
  const bytes = parts.get(decoded)
  return bytes === undefined ? undefined : { name: decoded, bytes }
}

/* ------------------------------------------------------------------------- *
 * Shared metadata helpers
 * ------------------------------------------------------------------------- */

function officeNode(input: {
  kind: string
  locator: string
  source: MetadataSource
  span: SourceSpan
  name?: string
  label?: string
}): NodeMetadata {
  const node: NodeMetadata = {
    kind: input.kind,
    locator: input.locator,
    source: input.source,
    span: input.span,
  }
  const name = cleanName(input.name)
  if (name.length > 0) node.name = name
  const label = cleanName(input.label)
  if (label.length > 0) node.label = label
  return node
}

/** Decode the five XML entities and numeric references; unknown entities stay literal. */
function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g, (match, hex, decimal, named) => {
    if (named !== undefined) {
      switch (named) {
        case 'amp':
          return '&'
        case 'lt':
          return '<'
        case 'gt':
          return '>'
        case 'quot':
          return '"'
        case 'apos':
          return "'"
        default:
          return match
      }
    }
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal, 10)
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match
    if (code >= 0xd800 && code <= 0xdfff) return match
    return String.fromCodePoint(code)
  })
}

/** Collapse controls/whitespace for a single-line metadata name. */
function normalizeNameText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function clipText(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

/** Decode + normalise + cap a raw attribute/text value used as a name. */
function cleanName(value: string | undefined): string {
  if (value === undefined || value.length === 0) return ''
  return clipText(normalizeNameText(decodeXmlEntities(value)), MAX_NAME_LENGTH)
}

/** Formula text: same normalisation, but never HTML-stripped (a formula may contain `<`/`>`). */
function cleanFormulaText(value: string): string {
  if (value.length === 0) return ''
  return clipText(normalizeNameText(decodeXmlEntities(value)), MAX_NAME_LENGTH)
}

/** File-name stem used only when no explicit in-package title exists. */
function pathStem(path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0) return undefined
  const normalised = path.replace(/\\/g, '/')
  const base = normalised.slice(normalised.lastIndexOf('/') + 1)
  if (base.length === 0) return undefined
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const clean = clipText(normalizeNameText(stem), MAX_NAME_LENGTH)
  return clean.length > 0 ? clean : undefined
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return clipText(normalizeNameText(message), 240)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/* ------------------------------------------------------------------------- *
 * Core properties (docProps/core.xml) — explicit metadata only
 * ------------------------------------------------------------------------- */

function readCoreProperties(parts: Map<string, Uint8Array>, ctx: OfficeContext, parser: XMLParser): void {
  const bytes = parts.get('docProps/core.xml')
  if (bytes === undefined) return
  const parsed = parseXmlPart(ctx, 'docProps/core.xml', bytes, parser)
  if (parsed === undefined) return
  const title = firstTextOf(parsed.nodes, 'title', ctx)
  const author = firstTextOf(parsed.nodes, 'creator', ctx)
  if (title !== undefined) {
    const clean = cleanName(title)
    if (clean.length > 0) ctx.title = clean
  }
  if (author !== undefined) {
    const clean = cleanName(author)
    if (clean.length > 0) ctx.author = clean
  }
}

function firstTextOf(nodes: XmlRecord[], wanted: string, ctx: OfficeContext): string | undefined {
  const element = findFirstElement(nodes, wanted, ctx)
  return element === undefined ? undefined : textContent(element)
}

/** Document/workbook name: explicit core title, else the path stem, else absent. */
function packageName(ctx: OfficeContext, options: OfficeParseOptions): string | undefined {
  return ctx.title ?? pathStem(options.path)
}

/* ------------------------------------------------------------------------- *
 * DOCX
 * ------------------------------------------------------------------------- */

interface DocxCounters {
  chapter: number
  section: number
  paragraph: number
  link: number
}

interface ParagraphState {
  style?: string
  text: string
  span: SourceSpan
}

function parseDocx(
  parts: Map<string, Uint8Array>,
  ctx: OfficeContext,
  options: OfficeParseOptions,
  parser: XMLParser,
): OfficeParseResult {
  const nodes: NodeMetadata[] = []
  const partName = 'word/document.xml'
  const bytes = parts.get(partName)
  if (bytes === undefined) {
    ctx.parseError(`docx package is missing ${partName}; document structure is unverifiable`)
    ctx.truncated = true
    return buildResult(ctx, 'docx', nodes)
  }
  readCoreProperties(parts, ctx, parser)
  const parsed = parseXmlPart(ctx, partName, bytes, parser)
  if (parsed === undefined) return buildResult(ctx, 'docx', nodes)

  const relationships = parseRelationships(ctx, 'word/_rels/document.xml.rels', parts, parser)
  const counters: DocxCounters = { chapter: 0, section: 0, paragraph: 0, link: 0 }
  const pending: NodeMetadata[] = []
  const documentName = packageName(ctx, options)
  pending.push(officeNode({
    kind: 'document',
    locator: `${partName}#document`,
    ...(documentName === undefined ? {} : { name: documentName }),
    source: 'none',
    span: rootSpan(parsed),
  }))
  walkDocx(parsed.nodes, [], counters, relationships, pending, ctx, partName)

  // Restore true XML order (a paragraph closes after its hyperlinks, so a
  // single forward walk alone would emit the link before its paragraph).
  pending.sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end)
  for (const node of pending) {
    if (!ctx.push(nodes, node)) break
  }
  return buildResult(ctx, 'docx', nodes)
}

function walkDocx(
  children: XmlRecord[],
  paragraphs: ParagraphState[],
  counters: DocxCounters,
  relationships: Map<string, Relationship>,
  pending: NodeMetadata[],
  ctx: OfficeContext,
  partName: string,
): void {
  for (const node of children) {
    if (!ctx.checkpoint()) return
    if (pending.length >= MAX_METADATA_NODES) return
    if (isTextNode(node)) continue
    const tag = tagNameOf(node)
    if (tag === undefined) continue
    const name = localName(tag)

    if (name === 'p') {
      const state: ParagraphState = { text: '', span: spanOf(node) }
      paragraphs.push(state)
      walkDocx(childrenOf(node), paragraphs, counters, relationships, pending, ctx, partName)
      paragraphs.pop()
      emitDocxParagraph(state, counters, pending, partName)
      continue
    }
    if (name === 'pStyle') {
      const value = attribute(node, 'val')
      const current = paragraphs[paragraphs.length - 1]
      if (value !== undefined && current !== undefined && current.style === undefined) {
        current.style = value
      }
      continue
    }
    if (name === 't') {
      const current = paragraphs[paragraphs.length - 1]
      if (current !== undefined) {
        current.text = appendLimited(current.text, decodeXmlEntities(textContent(node)))
      }
      continue
    }
    if (name === 'hyperlink') {
      emitDocxLink(node, counters, relationships, pending, ctx, partName)
      walkDocx(childrenOf(node), paragraphs, counters, relationships, pending, ctx, partName)
      continue
    }
    walkDocx(childrenOf(node), paragraphs, counters, relationships, pending, ctx, partName)
  }
}

function emitDocxParagraph(
  state: ParagraphState,
  counters: DocxCounters,
  pending: NodeMetadata[],
  partName: string,
): void {
  if (state.style === undefined) return
  const style = cleanName(state.style)
  if (style.length === 0) return

  const heading = /^heading[ _-]?([1-9])$/i.exec(style)
  const level = heading === null ? undefined : Number.parseInt(heading[1], 10)
  const text = normalizeNameText(state.text)
  if (level === 1) {
    counters.chapter += 1
    pending.push(officeNode({
      kind: 'chapter',
      locator: `${partName}#chapter:${counters.chapter}`,
      ...(text.length === 0 ? {} : { name: clipText(text, MAX_NAME_LENGTH) }),
      source: 'heading',
      span: state.span,
    }))
    return
  }
  if (level === 2 || level === 3) {
    counters.section += 1
    pending.push(officeNode({
      kind: 'section',
      locator: `${partName}#section:${counters.section}`,
      ...(text.length === 0 ? {} : { name: clipText(text, MAX_NAME_LENGTH) }),
      source: 'heading',
      span: state.span,
    }))
    return
  }
  // Any other explicit paragraph style is a paragraph node; its text is never
  // stored, only its existence and span.
  counters.paragraph += 1
  pending.push(officeNode({
    kind: 'paragraph',
    locator: `${partName}#paragraph:${counters.paragraph}`,
    source: 'paragraph',
    span: state.span,
  }))
}

function emitDocxLink(
  node: XmlRecord,
  counters: DocxCounters,
  relationships: Map<string, Relationship>,
  pending: NodeMetadata[],
  ctx: OfficeContext,
  partName: string,
): void {
  const id = relationshipId(node)
  const anchor = attribute(node, 'anchor')
  const relationship = id === undefined ? undefined : relationships.get(id)
  let target = relationship?.target
  if (target === undefined && id !== undefined) {
    ctx.note(
      `docx-link:${id}:${spanOf(node).start}`,
      `hyperlink relationship "${id}" is not present in word/_rels/document.xml.rels; link node not created`,
    )
  }
  if (target === undefined && anchor !== undefined && anchor.length > 0) {
    target = `#${decodeXmlEntities(anchor)}`
  }
  if (target === undefined) {
    if (id === undefined && (anchor === undefined || anchor.length === 0)) {
      ctx.note(
        `docx-link-missing:${spanOf(node).start}`,
        'hyperlink has neither a relationship id nor an anchor; link node not created',
      )
    }
    return
  }
  const name = cleanName(target)
  if (name.length === 0) return
  counters.link += 1
  pending.push(officeNode({
    kind: 'link',
    locator: `${partName}#link:${counters.link}`,
    name,
    source: 'html',
    span: spanOf(node),
  }))
}

function appendLimited(current: string, addition: string, limit = 4_096): string {
  if (current.length >= limit) return current
  const room = limit - current.length
  return current + (addition.length <= room ? addition : addition.slice(0, room))
}

/* ------------------------------------------------------------------------- *
 * XLSX
 * ------------------------------------------------------------------------- */

function parseXlsx(
  parts: Map<string, Uint8Array>,
  ctx: OfficeContext,
  options: OfficeParseOptions,
  parser: XMLParser,
): OfficeParseResult {
  const nodes: NodeMetadata[] = []
  const workbookPart = 'xl/workbook.xml'
  const bytes = parts.get(workbookPart)
  if (bytes === undefined) {
    ctx.parseError(`xlsx package is missing ${workbookPart}; workbook/sheet structure is unverifiable`)
    ctx.truncated = true
    return buildResult(ctx, 'xlsx', nodes)
  }
  readCoreProperties(parts, ctx, parser)
  const parsed = parseXmlPart(ctx, workbookPart, bytes, parser)
  if (parsed === undefined) return buildResult(ctx, 'xlsx', nodes)

  const root = findRoot(parsed)
  const workbookName = packageName(ctx, options)
  ctx.push(nodes, officeNode({
    kind: 'workbook',
    locator: `${workbookPart}#workbook`,
    ...(workbookName === undefined ? {} : { name: workbookName }),
    source: 'sheet',
    span: root === undefined ? rootSpan(parsed) : spanOf(root),
  }))
  const relationships = parseRelationships(ctx, 'xl/_rels/workbook.xml.rels', parts, parser)
  const sheets = collectElements(parsed.nodes, 'sheet', ctx)
  const usedParts = new Set<string>()
  let ordinal = 0
  for (const sheet of sheets) {
    if (!ctx.checkpoint()) break
    if (nodes.length >= MAX_METADATA_NODES) break
    ordinal += 1
    const sheetName = cleanName(attribute(sheet, 'name'))
    ctx.push(nodes, officeNode({
      kind: 'sheet',
      locator: `${workbookPart}#sheet:${ordinal}`,
      ...(sheetName.length === 0 ? {} : { name: sheetName }),
      source: 'sheet',
      span: spanOf(sheet),
    }))

    // A worksheet part is attached to a sheet only when the relationship names
    // it. Without that evidence the sheet node stands alone; no positional
    // guess pairs a sheet with a sheetN.xml part.
    const relId = relationshipId(sheet)
    const relationship = relId === undefined ? undefined : relationships.get(relId)
    if (relationship === undefined || relationship.external) {
      ctx.note(
        `xlsx-sheet-rel:${ordinal}`,
        `sheet ${sheetName.length === 0 ? ordinal : `"${sheetName}"`} has no resolvable worksheet relationship; ` +
          'its worksheet part was not identified',
      )
      continue
    }
    const located = findPart(parts, resolvePartTarget('xl', decodeXmlEntities(relationship.target)))
    if (located === undefined) {
      ctx.note(
        `xlsx-sheet-part:${ordinal}`,
        `worksheet part for sheet ${sheetName.length === 0 ? ordinal : `"${sheetName}"`} is missing or ` +
          'exceeded the part cap; its range/formulas were not read',
      )
      continue
    }
    if (usedParts.has(located.name)) continue
    usedParts.add(located.name)
    parseWorksheet(located.name, located.bytes, ctx, nodes, parser)
  }

  /*
   * Worksheet parts not named by a workbook relationship are still explicit
   * package evidence: describe their dimension and formulas under their own
   * part locator, without claiming a sheet owner (the direction invariant).
   * This also keeps a minimal `.xlsx` fixture without rels usable.
   */
  const remaining = worksheetPartNames(parts).filter((name) => !usedParts.has(name))
  if (remaining.length > 0) {
    ctx.note(
      'xlsx-parts-without-rel',
      `${remaining.length} worksheet part(s) were not named by a workbook relationship; ` +
        'their ranges/formulas are described without sheet ownership',
    )
    for (const partName of remaining) {
      if (nodes.length >= MAX_METADATA_NODES) break
      const data = parts.get(partName)
      if (data === undefined) continue
      parseWorksheet(partName, data, ctx, nodes, parser)
    }
  }
  return buildResult(ctx, 'xlsx', nodes)
}

/** Worksheet parts in numeric part-name order (`sheet2.xml` before `sheet10.xml`). */
function worksheetPartNames(parts: Map<string, Uint8Array>): string[] {
  return [...parts.keys()]
    .filter((name) => name.startsWith('xl/worksheets/') && isFlatXmlPart(name.slice('xl/worksheets/'.length)))
    .sort(comparePartNames)
}

function parseWorksheet(
  partName: string,
  bytes: Uint8Array,
  ctx: OfficeContext,
  nodes: NodeMetadata[],
  parser: XMLParser,
): void {
  const parsed = parseXmlPart(ctx, partName, bytes, parser)
  if (parsed === undefined) return

  let dimension: XmlRecord | undefined
  const formulaElements: XmlRecord[] = []
  const walk = (children: XmlRecord[], insideCell: boolean): void => {
    for (const node of children) {
      if (!ctx.checkpoint()) return
      if (isTextNode(node)) continue
      const tag = tagNameOf(node)
      if (tag === undefined) continue
      const name = localName(tag)
      if (name === 'dimension' && !insideCell && dimension === undefined) dimension = node
      if (name === 'f' && formulaElements.length < MAX_METADATA_NODES) formulaElements.push(node)
      // Every `<f>` in a worksheet part is explicit formula evidence. Cell
      // values (`<v>`, `<is>`, shared strings) are visited but never stored.
      walk(childrenOf(node), insideCell || name === 'c')
    }
  }
  walk(parsed.nodes, false)

  if (dimension !== undefined) {
    const ref = cleanName(attribute(dimension, 'ref'))
    if (ref.length > 0) {
      ctx.push(nodes, officeNode({
        kind: 'range',
        locator: `${partName}#range:1`,
        name: ref,
        source: 'sheet',
        span: spanOf(dimension),
      }))
    }
  }

  let ordinal = 0
  for (const element of formulaElements) {
    if (nodes.length >= MAX_METADATA_NODES) break
    const formula = cleanFormulaText(textContent(element))
    if (formula.length === 0) continue
    ordinal += 1
    // The formula is a text name only: no evaluation, no cached value, no cell.
    ctx.push(nodes, officeNode({
      kind: 'formula',
      locator: `${partName}#formula:${ordinal}`,
      name: formula,
      label: 'calculation',
      source: 'sheet',
      span: spanOf(element),
    }))
  }
}

/* ------------------------------------------------------------------------- *
 * PPTX
 * ------------------------------------------------------------------------- */

function parsePptx(
  parts: Map<string, Uint8Array>,
  ctx: OfficeContext,
  options: OfficeParseOptions,
  parser: XMLParser,
): OfficeParseResult {
  const nodes: NodeMetadata[] = []
  const presentationPart = 'ppt/presentation.xml'
  readCoreProperties(parts, ctx, parser)
  const bytes = parts.get(presentationPart)
  let presentation: ParsedXml | undefined
  if (bytes !== undefined) {
    presentation = parseXmlPart(ctx, presentationPart, bytes, parser)
  } else {
    ctx.parseError(`pptx package is missing ${presentationPart}; presentation structure is unverifiable`)
    ctx.truncated = true
  }

  const usedParts = new Set<string>()
  const unresolved: XmlRecord[] = []
  let ordinal = 0
  if (presentation !== undefined) {
    const root = findRoot(presentation)
    const presentationName = packageName(ctx, options)
    ctx.push(nodes, officeNode({
      kind: 'document',
      locator: `${presentationPart}#document`,
      ...(presentationName === undefined ? {} : { name: presentationName }),
      source: 'none',
      span: root === undefined ? rootSpan(presentation) : spanOf(root),
    }))
    const relationships = parseRelationships(ctx, 'ppt/_rels/presentation.xml.rels', parts, parser)
    const slideIds = collectElements(presentation.nodes, 'sldId', ctx)
    for (const slideId of slideIds) {
      if (!ctx.checkpoint()) break
      if (nodes.length >= MAX_METADATA_NODES) break
      const relId = relationshipId(slideId)
      const relationship = relId === undefined ? undefined : relationships.get(relId)
      const located = relationship === undefined || relationship.external
        ? undefined
        : findPart(parts, resolvePartTarget('ppt', decodeXmlEntities(relationship.target)))
      if (located === undefined) {
        unresolved.push(slideId)
        continue
      }
      ordinal += 1
      usedParts.add(located.name)
      emitSlide(ordinal, slideId, located, nodes, ctx, parser)
    }
  }

  /*
   * Enumerate slide parts the presentation relationship did not place. The
   * parts themselves are explicit package evidence, so each becomes one slide;
   * the order is only part-name order, which is stated in a diagnostic. No
   * part is ever paired with a `sldId` by position, so ownership cannot be
   * guessed (the domain-model direction invariant).
   */
  const remaining = slidePartNames(parts).filter((name) => !usedParts.has(name))
  if (remaining.length > 0) {
    ctx.note(
      'pptx-parts-without-rel',
      `${remaining.length} slide part(s) were not named by a resolved presentation relationship; ` +
        'slide nodes for them were listed in part-name order',
    )
    for (const partName of remaining) {
      if (nodes.length >= MAX_METADATA_NODES) break
      const data = parts.get(partName)
      if (data === undefined) continue
      ordinal += 1
      emitSlide(ordinal, undefined, { name: partName, bytes: data }, nodes, ctx, parser)
    }
  }

  if (unresolved.length > 0) {
    ctx.note(
      'pptx-unresolved-sldid',
      `${unresolved.length} sldId entr${unresolved.length === 1 ? 'y' : 'ies'} had no resolvable slide part; ` +
        'no slide ownership was guessed',
    )
    if (remaining.length === 0) {
      // A package that declares slides but carries no unclaimed slide parts
      // still has explicit slide entries; describe them without inventing a
      // part or text. When slide parts exist they are the stronger evidence.
      for (const slideId of unresolved) {
        if (nodes.length >= MAX_METADATA_NODES) break
        ordinal += 1
        emitSlide(ordinal, slideId, undefined, nodes, ctx, parser)
      }
    }
  }
  return buildResult(ctx, 'pptx', nodes)
}

/** Slide parts in numeric part-name order (`slide2.xml` before `slide10.xml`). */
function slidePartNames(parts: Map<string, Uint8Array>): string[] {
  return [...parts.keys()]
    .filter((name) => name.startsWith('ppt/slides/') && isFlatXmlPart(name.slice('ppt/slides/'.length)))
    .sort(comparePartNames)
}

function emitSlide(
  ordinal: number,
  slideId: XmlRecord | undefined,
  located: LocatedPart | undefined,
  nodes: NodeMetadata[],
  ctx: OfficeContext,
  parser: XMLParser,
): void {
  let name: string | undefined
  let span = slideId === undefined ? { start: 0, end: 0, line: 1, column: 1 } : spanOf(slideId)
  let locator = `ppt/presentation.xml#slide:${ordinal}`

  if (located !== undefined) {
    locator = `${located.name}#slide:${ordinal}`
    const parsed = parseXmlPart(ctx, located.name, located.bytes, parser)
    if (parsed !== undefined) {
      const content = findFirstElement(parsed.nodes, 'cSld', ctx)
      if (content !== undefined) {
        span = spanOf(content)
        const explicitName = cleanName(attribute(content, 'name'))
        if (explicitName.length > 0) name = explicitName
      }
    }
  } else {
    ctx.note(
      `pptx-slide-part:${ordinal}`,
      `slide ${ordinal} has no resolvable slide part; only its presentation entry is described`,
    )
  }

  // A positional label from the explicit slide/part order, used only when the
  // slide itself states no name. It is never derived from slide text.
  if (name === undefined) name = `Slide ${ordinal}`
  ctx.push(nodes, officeNode({
    kind: 'slide',
    locator,
    name,
    source: 'none',
    span,
  }))
}

/** Numeric part-name order (`slide2.xml` before `slide10.xml`), lexical otherwise. */
function comparePartNames(left: string, right: string): number {
  const leftMatch = /(\d+)(?!.*\d)/.exec(left)
  const rightMatch = /(\d+)(?!.*\d)/.exec(right)
  if (leftMatch !== null && rightMatch !== null) {
    const difference = Number(leftMatch[1]) - Number(rightMatch[1])
    if (difference !== 0) return difference
  }
  return left.localeCompare(right)
}

/* ------------------------------------------------------------------------- *
 * Input conversion
 * ------------------------------------------------------------------------- */

/**
 * Convert accepted input to bytes. A string is treated as a byte-preserving
 * (Latin-1) view of the package, which is how a host that only has the text
 * `Parser` contract can forward a binary file.
 */
function toBytes(input: OfficeInput): Uint8Array | undefined {
  if (typeof input === 'string') {
    if (input.length === 0) return undefined
    const bytes = new Uint8Array(input.length)
    for (let index = 0; index < input.length; index += 1) {
      bytes[index] = input.charCodeAt(index) & 0xff
    }
    return bytes
  }
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  return undefined
}

/** OLE2/CFB signature (legacy `.doc`/`.xls`, `.pub`, `.accdb`, encrypted OOXML). */
function isOleCompoundFile(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  return (
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  )
}
