/**
 * The P0 parser contract: options, result shape, diagnostics, the parser
 * registry, hard resource limits and the small amount of plumbing every text
 * parser shares (bounded AST construction, spans, stop checks).
 *
 * The layer is pure: text in, result out. No `node:fs`, no network, no DSH
 * import, no model call. Reading a file is the file layer's job; the parser
 * receives the text. That keeps the parsers deterministic and lets them run in
 * a sandbox, a test and a worker process unchanged.
 *
 * Extension points kept deliberately open for the v25 domain model:
 *
 *  - `ParseResult.document` carries the document form (`article`, `book`, ...)
 *    plus title/author and the raw metadata keys from front matter or
 *    `\documentclass`, so `Book`/`Article` can be layered on without changing a
 *    parser signature;
 *  - `FileReference` carries optional occurrence metadata (`names`, `wildcard`,
 *    `attributes`) so `Importation`/`Exportation` can keep it;
 *  - `ParserRegistry` is keyed by both extension and id and never guesses.
 *
 * Hard limits (`docs/file-processing-v24.md` §4, `domain-model-v24.md` §7):
 *
 * | Budget | Value | Overflow behaviour |
 * |---|---|---|
 * | source text | 1 MiB (1,048,576 UTF-16 code units) | parse the prefix, `truncated` |
 * | tokens | 200,000 | stop at the cap, `truncated` |
 * | AST depth | 256 | stop adding nodes, `truncated` |
 * | parse time | 2,000 ms | stop, `truncated`, `timeout` diagnostic |
 * | diagnostics | 100 | drop later diagnostics, keep `truncated` |
 *
 * Dependencies: shared AST (`AstNode`/`AstTree`/`SourceSpan`), shared errors.
 */
import { AstNode } from '../../shared/ast.js'
import type { AstTree, SourceSpan } from '../../shared/ast.js'
import { InvalidArgumentError } from '../../shared/error.js'
import { createHash } from 'node:crypto'

/** Maximum source text, in UTF-16 code units (1 MiB). */
export const MAX_TEXT_LENGTH = 1_048_576
/** Maximum tokens per parse. */
export const MAX_TOKENS = 200_000
/** Maximum AST node depth (root has depth 0). */
export const MAX_AST_DEPTH = 256
/** Maximum parse wall-clock time in milliseconds. */
export const MAX_PARSE_MS = 2_000
/** Maximum diagnostics retained per result. */
export const MAX_DIAGNOSTICS = 100
/** Maximum `NodeMetadata.name` length. */
export const MAX_NAME_LENGTH = 200
/** Maximum `NodeMetadata.summary` length. */
export const MAX_SUMMARY_LENGTH = 200
/** Maximum `NodeMetadata.description` length. */
export const MAX_DESCRIPTION_LENGTH = 500
/** Maximum `NodeMetadata.usage` length (explicit annotation only). */
export const MAX_USAGE_LENGTH = 300
/** Maximum `NodeMetadata.purpose` length (explicit annotation only). */
export const MAX_PURPOSE_LENGTH = 200
/** Maximum `NodeMetadata.brief` length; explicit sources only. */
export const MAX_BRIEF_LENGTH = 300

/**
 * Closed charset union for parser output. P0 only produces byte/line ranges for
 * `utf-8`, `utf-8-bom` and `ascii`; any other value is detected/reported but not
 * transcoded (`domain-model-v24.md` §7).
 */
export type Charset =
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16le'
  | 'utf-16be'
  | 'utf-16le-bom'
  | 'utf-16be-bom'
  | 'utf-32le'
  | 'utf-32be'
  | 'utf-32le-bom'
  | 'utf-32be-bom'
  | 'ascii'
  | 'latin1'
  | 'windows-1252'
  | 'gb18030'
  | 'gbk'
  | 'big5'
  | 'shift-jis'
  | 'euc-kr'
  | 'binary'
  | 'unknown'

/** Result of charset detection. Never guesses silently: `unknown` is reported. */
export interface CharsetDetection {
  charset: Charset
  /** BOM length in bytes (0 when absent). */
  bomBytes: number
  /** True when the content cannot be treated as text. */
  binary: boolean
  /** How the answer was reached. */
  confidence: 'declared' | 'bom' | 'valid-utf8' | 'ascii' | 'heuristic' | 'unknown'
  /** Human-readable reason, for diagnostics. */
  reason?: string
}

const CHARSETS: ReadonlySet<Charset> = new Set<Charset>([
  'utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'utf-16le-bom', 'utf-16be-bom',
  'utf-32le', 'utf-32be', 'utf-32le-bom', 'utf-32be-bom', 'ascii', 'latin1',
  'windows-1252', 'gb18030', 'gbk', 'big5', 'shift-jis', 'euc-kr', 'binary', 'unknown',
])

/** True when P0 can produce byte+line ranges for this charset. */
export function isRangeCapableCharset(charset: Charset): boolean {
  return charset === 'utf-8' || charset === 'utf-8-bom' || charset === 'ascii'
}

/**
 * Detect a charset from raw bytes or already-decoded text.
 *
 * BOM order: UTF-32 first (its LE BOM starts with the UTF-16 LE BOM), then
 * UTF-16, then UTF-8. Without a BOM the bytes must be valid UTF-8 (→ `utf-8`),
 * or all ASCII (→ `ascii`). A declared charset is used only when BOM/UTF-8
 * evidence is absent; invalid bytes with no declaration are `binary` when they
 * contain a NUL byte and `unknown` otherwise — never a silent guess.
 *
 * Time O(n), space O(1).
 */
export function detectCharset(source: string | Uint8Array | ArrayBuffer, declared?: Charset): CharsetDetection {
  if (declared !== undefined && !CHARSETS.has(declared)) {
    throw new InvalidArgumentError('unknown declared charset', { charset: declared })
  }
  if (typeof source === 'string') {
    const bomBytes = source.startsWith('\uFEFF') ? 3 : 0
    if (declared === undefined) {
      const detected: Charset = bomBytes > 0
        ? 'utf-8-bom'
        : isAllAscii(source) ? 'ascii' : 'utf-8'
      return {
        charset: detected,
        bomBytes,
        binary: false,
        confidence: bomBytes > 0 ? 'bom' : detected === 'ascii' ? 'ascii' : 'valid-utf8',
      }
    }
    return {
      charset: declared,
      bomBytes: declared === 'utf-8-bom' ? Math.max(3, bomBytes) : bomBytes,
      binary: declared === 'binary',
      confidence: 'declared',
      ...(isRangeCapableCharset(declared) ? {} : { reason: 'declared non-UTF-8 charset; P0 does not transcode' }),
    }
  }
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source)
  const bom = detectBom(bytes)
  if (bom !== undefined) {
    return { charset: bom.charset, bomBytes: bom.bytes, binary: false, confidence: 'bom' }
  }
  if (declared !== undefined) {
    return {
      charset: declared,
      bomBytes: 0,
      binary: declared === 'binary',
      confidence: 'declared',
      ...(isRangeCapableCharset(declared) ? {} : { reason: 'declared non-UTF-8 charset; P0 does not transcode' }),
    }
  }
  if (isValidUtf8(bytes)) {
    const ascii = isAllAsciiBytes(bytes)
    // A NUL byte in otherwise-ASCII input is binary in practice (a text file
    // never carries it); keep the answer explicit rather than "valid UTF-8".
    if (!ascii) {
      return { charset: 'utf-8', bomBytes: 0, binary: false, confidence: 'valid-utf8' }
    }
    for (const byte of bytes) {
      if (byte === 0) {
        return {
          charset: 'binary',
          bomBytes: 0,
          binary: true,
          confidence: 'heuristic',
          reason: 'NUL byte in text input',
        }
      }
    }
    return { charset: 'ascii', bomBytes: 0, binary: false, confidence: 'ascii' }
  }
  for (const byte of bytes) {
    if (byte === 0) {
      return { charset: 'binary', bomBytes: 0, binary: true, confidence: 'heuristic', reason: 'NUL byte in non-UTF-8 input' }
    }
  }
  return { charset: 'unknown', bomBytes: 0, binary: false, confidence: 'unknown', reason: 'invalid UTF-8 without a declaration' }
}

/** BOM sniff, checking UTF-32 before UTF-16 before UTF-8. */
function detectBom(bytes: Uint8Array): { charset: Charset; bytes: number } | undefined {
  if (bytes.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) {
      return { charset: 'utf-32le-bom', bytes: 4 }
    }
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) {
      return { charset: 'utf-32be-bom', bytes: 4 }
    }
  }
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { charset: 'utf-16le-bom', bytes: 2 }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { charset: 'utf-16be-bom', bytes: 2 }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { charset: 'utf-8-bom', bytes: 3 }
  }
  return undefined
}

function isAllAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return false
  }
  return true
}

function isAllAsciiBytes(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte > 0x7f) return false
  }
  return true
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Kinds of syntactic file reference the P0 parsers extract.
 *
 * `tex-input`/`tex-include` extend the reference model of
 * `docs/file-processing-v24.md` §5 because the P0 scope also covers LaTeX
 * `\input`/`\include`. Cross-references (`\ref`) are not file references and
 * live in the parser-specific result instead.
 */
export type ReferenceKind =
  | 'import'
  | 'require'
  | 'dynamic-import'
  | 'export-from'
  | 'css-import'
  | 'css-url'
  | 'html-script'
  | 'html-link'
  | 'html-image'
  | 'markdown-link'
  | 'markdown-image'
  | 'tex-input'
  | 'tex-include'

/**
 * One syntactic reference occurrence.
 *
 * `span` covers the specifier text itself (the contents of the quotes, `url()`
 * or `()`), not the whole statement, so a diagnostic can point at the exact
 * token that must be fixed.
 */
export interface FileReference extends FlatFragment {
  kind: ReferenceKind
  /** Raw specifier text as written (quotes stripped). */
  specifier: string
  /**
   * Lexically resolved workspace path, left unset by parsers: resolution is a
   * dependency-layer concern (`dependency.ts`) and must not touch the file
   * system.
   */
  resolved?: string
  /** True for bare specifiers, URLs, `data:` payloads and `#` fragments. */
  external: boolean
  span: SourceSpan
  /** TypeScript `import type` / `export type` occurrence. */
  typeOnly?: boolean
  /** Imported/exported binding names, when the syntax names them. */
  names?: readonly string[]
  /** Wildcard re-export (`export * from ...`). */
  wildcard?: boolean
  /** Non-positional occurrence metadata (HTML `rel`, CSS media, MD label, ...). */
  attributes?: Readonly<Record<string, string>>
}

/** Document form, aligned with `Document.form` in the domain model. */
export type DocumentForm = 'article' | 'book' | 'note' | 'workbook' | 'deck' | 'unknown'

/**
 * Document-level metadata detected from the text. Kept on `ParseResult` so a
 * later Book/Article layer can read the form and raw front matter without
 * reparsing.
 */
export interface DocumentMetadata {
  form: DocumentForm
  title?: string
  author?: string
  /** Where `form`/`title`/`author` came from. */
  source: 'front-matter' | 'documentclass' | 'html' | 'extension' | 'none'
  /** Raw text keys from front matter or an equivalent preamble. */
  metadata?: Readonly<Record<string, string>>
}

/** Diagnostic codes. Every failure is reported, never thrown, except abort. */
export type DiagnosticCode =
  | 'text-limit'
  | 'token-limit'
  | 'depth-limit'
  | 'node-limit'
  | 'timeout'
  | 'unverifiable'
  | 'parse-error'
  | 'graph-limit'

/** One bounded, span-carrying diagnostic. */
export interface Diagnostic {
  code: DiagnosticCode
  message: string
  span?: SourceSpan
  severity: 'info' | 'warning' | 'error'
}

/** Parser selection and resource options. Every field is optional. */
export interface ParseOptions {
  /** Workspace-relative path; its extension selects the parser first. */
  path?: string
  /** Explicit parser id; used only when `path` has no known extension. */
  parserId?: string
  /** Lower token budget than `MAX_TOKENS` (clamped to the hard cap). */
  maxTokens?: number
  /** Lower AST depth than `MAX_AST_DEPTH` (clamped to the hard cap). */
  maxDepth?: number
  /** Lower timeout than `MAX_PARSE_MS`; `0` times out immediately. */
  timeoutMs?: number
  /** Abort signal; checked at every deadline checkpoint. */
  signal?: AbortSignal
  /** File size in bytes supplied by the file layer, for reference bounds. */
  size?: number
  /** File mtime in milliseconds supplied by the file layer, for invalidation. */
  mtime?: number
  /** Charset declared by the file layer; detection runs when absent. */
  charset?: Charset
  /** BOM length in bytes declared by the file layer (default: detected). */
  bomBytes?: number
}

/** The parser result. `ast` is absent only for an empty/failed parse. */
export interface ParseResult {
  parserId: string
  ast?: AstTree<string>
  references: FileReference[]
  diagnostics: Diagnostic[]
  truncated: boolean
  tokens: number
  /** Document-level metadata, when the parser can detect any. */
  document?: DocumentMetadata
  /** Detected charset for the file (flat, always present). */
  charset?: Charset
  /** BOM bytes at the start of the file; excluded from every fragment range. */
  bomBytes?: number
  /**
   * Concept metadata for the nodes this parser extracted. Optional and bounded:
   * a result never contains full bodies (see `contentRef`).
   */
  nodes?: NodeMetadata[]
}

/**
 * A pluggable text parser.
 *
 * `parse` never throws for malformed input; it reports `diagnostics` and
 * `truncated`. It may throw only for a pre-aborted `options.signal`, matching
 * `AbortSignal` conventions.
 */
export interface Parser {
  id: string
  extensions: readonly string[]
  parse(text: string, options?: ParseOptions): ParseResult
}

/** One extracted comment. Never carries the full comment body. */
export interface CodeComment {
  style: 'line' | 'block' | 'doc' | 'html'
  /** First meaningful line, sanitised and capped at `MAX_BRIEF_LENGTH`. */
  brief: string
  span: SourceSpan
  attachment: 'leading' | 'trailing' | 'inner' | 'orphan'
  /** Symbol name when `attachment` is `leading`. */
  target?: string
}

/** Where a `NodeMetadata` field came from; useful for audit and tests. */
export type MetadataSource =
  | 'comment'
  | 'front-matter'
  | 'heading'
  | 'environment'
  | 'documentclass'
  | 'html'
  | 'annotation'
  | 'none'

/** Scheme of a `NodeReference`: what kind of thing the target locates. */
export type NodeReferenceScheme = 'file' | 'symbol' | 'module' | 'formula' | 'sheet-cell' | 'url' | 'handle'

/** Byte range in UTF-8 bytes: `start` inclusive, `end` exclusive. */
export interface ByteRange {
  start: number
  end: number
}

/** Line range, 1-based and inclusive on both ends. */
export interface LineRange {
  start: number
  end: number
}

/** Column range, 1-based UTF-16 columns, `end` exclusive. */
export interface ColumnRange {
  start: number
  end: number
}

/**
 * A precise, body-free pointer to one file-backed node.
 *
 * Every file-backed node carries the workspace-relative `path`, the UTF-8
 * `bytes` range, the 1-based inclusive `lines` range, the column range and the
 * encoding, all computed from the same source text by `SourceMap`. The node
 * never carries content: a consumer that is authorized to read the file resolves
 * `bytes` later. `hash` is an FNV-1a hash over the UTF-16 code units of the
 * referenced range (documented whole-range hash; stable across processes),
 * `fileBytes` bounds the file and `mtime` supports invalidation when the file
 * layer supplies it.
 *
 * For `symbol`, `module` and `formula` schemes `path` is the owning file and
 * `target` is the scheme-specific locator (`function:foo`, `src/a.ts`, ...).
 * For `url` the target is an external URL and `external` is true. For `handle`
 * the target is an opaque public handle.
 */
export interface NodeReference {
  scheme: NodeReferenceScheme
  /** Workspace-relative file path for file-backed schemes. */
  path?: string
  /** Scheme-specific locator (file path for `file`, symbol locator, URL, ...). */
  target: string
  /** UTF-8 byte range; present when the node has a file span. */
  bytes?: ByteRange
  /** 1-based inclusive line range; omitted when line mapping is unavailable. */
  lines?: LineRange
  /** 1-based UTF-16 column range; end exclusive. */
  columns?: ColumnRange
  /** Detected charset; byte/line ranges are only produced for UTF-8/ASCII. */
  charset: Charset
  /** Decoded text encoding when it is UTF-8; absent for untranscoded charsets. */
  encoding?: 'utf-8'
  /** FNV-1a over the range's UTF-16 code units. */
  hash?: string
  /** Whole-file UTF-8 byte size, for bounds and invalidation. */
  fileBytes?: number
  /** File mtime in milliseconds, when the file layer supplied it. */
  mtime?: number
  mediaType?: string
  parserId?: string
  /** True for URLs (never resolved as workspace files). */
  external?: boolean
  /** Internal UTF-16 source span; not body content. */
  span?: SourceSpan
}

/** Input for `createNodeReference`; paths and URLs are validated. */
export interface NodeReferenceInput {
  scheme: NodeReferenceScheme
  path?: string
  target: string
  bytes?: ByteRange
  lines?: LineRange
  columns?: ColumnRange
  hash?: string
  fileBytes?: number
  mtime?: number
  mediaType?: string
  parserId?: string
  external?: boolean
  span?: SourceSpan
  charset?: Charset
}

/**
 * Flat, body-free file fragment coordinates. Every file-backed node/fragment
 * carries these next to its nested `reference` so a consumer that does not want
 * to walk a union can read six scalars:
 *
 *  - `byteStart` inclusive, `byteEnd` exclusive, UTF-8 bytes (CRLF = 2 bytes,
 *    BOM counts);
 *  - `lineStart`/`lineEnd` 1-based, both inclusive (CRLF/LF/CR = one break; a
 *    final line without a newline counts);
 *  - `fingerprint` = `sha256:<hex>` of the exact fragment bytes, computed by the
 *    host from the text; it is never accepted from an agent.
 */
export interface FlatFragment {
  /** Workspace-relative path of the file that contains the fragment. */
  path?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  /** `sha256:<hex>` over the original raw fragment bytes (BOM excluded). */
  fingerprint?: string
  /** Detected file charset; P0 line ranges only for UTF-8/ASCII. */
  charset?: Charset
}

/**
 * The common concept metadata every parsed node can carry, aligned with the
 * v25 domain model (identity/name/kind/summary/description/usage/purpose/brief
 * and a body-free reference).
 *
 * Rules enforced by `createNodeMetadata`:
 *  - `identity` is a public handle assigned by a later layer; a parser never
 *    fabricates one. `locator` is the natural key a later layer may use.
 *  - `name` is optional but never empty when present.
 *  - `summary` (≤200), `description` (≤500), `usage` (≤300), `purpose` (≤200)
 *    and `brief` (≤300) are capped, HTML-stripped and secret-redacted.
 *  - `usage`/`purpose` come only from explicit annotations
 *    (`@usage`/`@purpose`/`Usage:`/`Purpose:`), never inference.
 *  - `brief` comes only from an explicit source (doc-comment first line,
 *    front-matter description/abstract, explicit formula meaning); absent
 *    otherwise and reported as `unverifiable` by the parser.
 *  - `reference` locates the node by path + byte/line range; no body text is
 *    ever stored on the node.
 */
export interface NodeMetadata extends FlatFragment {
  /** Public handle, assigned by the domain layer; never set by a parser. */
  identity?: string
  /** Natural key, e.g. `module:src/a.ts/function:f`; not a public handle. */
  locator?: string
  /** Parser-level kind (`class`, `function`, `heading`, `theorem`, `formula`, ...). */
  kind: string
  /** Explicit name/title/label; absent rather than guessed. */
  name?: string
  /** Explicit statement label (`\label{...}`), when separate from the name. */
  label?: string
  summary?: string
  description?: string
  usage?: string
  purpose?: string
  /** Explicit one-line synopsis; the only prose field on the wire. */
  brief?: string
  /** Body-free locator for this node. */
  reference?: NodeReference
  source?: MetadataSource
  span: SourceSpan
}

/** Input accepted by `createNodeMetadata`; raw values are sanitised and capped. */
export interface NodeMetadataInput {
  identity?: string
  locator?: string
  kind: string
  name?: string
  label?: string
  summary?: string
  description?: string
  usage?: string
  purpose?: string
  brief?: string
  reference?: NodeReferenceInput
  source?: MetadataSource
  span: SourceSpan
  /** Precomputed fragment coordinates; usually derived from `reference`. */
  fragment?: FlatFragment
}

/** Specifier classification shared by parsers and the dependency layer. */
export type SpecifierKind = 'relative' | 'absolute' | 'external' | 'fragment'

/** Maximum concept metadata nodes retained per parse (domain model nodes/file cap). */
export const MAX_METADATA_NODES = 20_000

/*
 * Secret scrubbing for metadata that ends up on the agent wire.
 *
 * These expressions are deliberately flat (one class per run, no nested
 * quantifiers), so matching stays linear; they are defence in depth, not a
 * guarantee that every credential format is recognised.
 */
const SECRET_ASSIGNMENT =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi
const SECRET_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g
const HTML_TAG = /<[^>]*>/g
const WHITESPACE_RUN = /\s+/g

/**
 * Normalise a metadata string: strip HTML tags, redact credential-shaped
 * substrings, collapse whitespace and clip to `maxLength` (adding `…` when
 * clipped). Non-strings and empty results become `''`, so callers can omit the
 * field rather than persist blank metadata.
 *
 * Time O(length) in the input, space O(result).
 */
export function sanitizeMetadataText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new InvalidArgumentError('metadata cap must be a positive integer', { maxLength })
  }
  let text = value.replace(HTML_TAG, ' ').replace(SECRET_ASSIGNMENT, '[redacted]')
  text = text.replace(SECRET_TOKEN, '[redacted]').replace(WHITESPACE_RUN, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}

/**
 * Normalise a workspace-relative path, or `undefined` when it is absolute,
 * drive-rooted, UNC or traversal that escapes the workspace.
 *
 * `./src/a.ts` → `src/a.ts`; `a/../b` → `b`; `../a` → `undefined`. Purely
 * lexical: no filesystem access, no symlink assumptions.
 *
 * Time O(path length), space O(segments).
 */
export function normaliseWorkspacePath(path: string): string | undefined {
  if (typeof path !== 'string' || path.length === 0) return undefined
  const value = path.replace(/\\/g, '/')
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('//')) return undefined
  const segments = value.split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (resolved.length === 0) return undefined
      resolved.pop()
      continue
    }
    if (segment.includes('\u0000')) return undefined
    resolved.push(segment)
  }
  return resolved.length === 0 ? undefined : resolved.join('/')
}

/** True when `path` is safe to store as a workspace-relative reference path. */
export function isWorkspaceRelativePath(path: string): boolean {
  return normaliseWorkspacePath(path) !== undefined
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript',
  '.jsx': 'text/jsx',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.tex': 'text/x-tex',
  '.ltx': 'text/x-tex',
  '.latex': 'text/x-tex',
}

/** Best-effort media type from a path extension; undefined when unknown. */
export function mediaTypeForPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const extension = extensionOf(path)
  return extension === undefined ? undefined : MEDIA_TYPES[extension]
}

/**
 * UTF-8 byte length of a string, matching a conforming encoder: ASCII 1 byte,
 * U+0080–U+07FF 2 bytes, everything else 3 bytes, a surrogate pair 4 bytes, a
 * lone surrogate 3 bytes (the replacement character a UTF-8 encoder emits).
 *
 * Time O(n), space O(1).
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 3
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** Line-index cap; beyond this, line mapping is reported unavailable. */
export const MAX_LINE_INDEX_LINES = 200_000
/** UTF-16 distance between byte checkpoints (bounded index, no per-char array). */
const BYTE_CHECKPOINT_STRIDE = 256

/** A file-backed range triple computed from one source text. */
export interface SourceRange {
  bytes: ByteRange
  lines?: LineRange
  columns?: ColumnRange
}

/**
 * One-pass UTF-16 ↔ UTF-8 ↔ line mapper for a parsed file.
 *
 * Built once per parse, never stored on a node (it is O(source) memory: a
 * bounded byte checkpoint array plus a line-start array capped at
 * `MAX_LINE_INDEX_LINES`). `byteAt` is O(stride) after a binary search;
 * `lineAt`/`columnAt` are O(log lines). All ranges for one reference come from
 * the same map, so bytes and lines cannot disagree.
 *
 * BOM: U+FEFF is 3 UTF-8 bytes and column 1 (parsers skip it as whitespace).
 * CRLF counts as 2 bytes and one line break; a lone CR counts as one break; a
 * final line without a terminator is still a line.
 *
 * Unrepresentable input (lone surrogate) sets `representable = false`; callers
 * emit bytes only and an `unverifiable` diagnostic, never guessed lines.
 */
export class SourceMap {
  readonly text: string
  /** Total UTF-8 bytes of `text`. */
  readonly byteLength: number
  /** False when `text` contains a lone surrogate and cannot round-trip UTF-8. */
  readonly representable: boolean
  /** True when the line-start index was capped. */
  readonly lineIndexTruncated: boolean

  private readonly checkpointOffsets: number[] = [0]
  private readonly checkpointBytes: number[] = [0]
  private readonly lineStarts: number[] = [0]
  private lineIndexFull = true

  constructor(text: string) {
    this.text = text
    let bytes = 0
    let representable = true
    let index = 0
    while (index < text.length) {
      const code = text.charCodeAt(index)
      let width = 1
      let units = 1
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          width = 4
          units = 2
        } else {
          width = 3
          representable = false
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        width = 3
        representable = false
      } else if (code < 0x80) {
        width = 1
      } else if (code < 0x800) {
        width = 2
      } else {
        width = 3
      }
      bytes += width
      const nextIndex = index + units
      if (nextIndex % BYTE_CHECKPOINT_STRIDE === 0) {
        this.checkpointOffsets.push(nextIndex)
        this.checkpointBytes.push(bytes)
      }
      if (code === 13) {
        if (text.charCodeAt(index + 1) !== 10) this.pushLineStart(nextIndex)
      } else if (code === 10) {
        this.pushLineStart(nextIndex)
      }
      index = nextIndex
    }
    this.byteLength = bytes
    this.representable = representable
    this.lineIndexTruncated = !this.lineIndexFull
  }

  /** UTF-8 byte offset of a UTF-16 offset (rounded up inside a surrogate pair). O(stride + log n). */
  byteAt(offset: number): number {
    const target = clampOffset(offset, this.text.length)
    if (target === 0) return 0
    if (target >= this.text.length) return this.byteLength
    let low = 0
    let high = this.checkpointOffsets.length - 1
    let candidate = 0
    while (low <= high) {
      const middle = (low + high) >>> 1
      if (this.checkpointOffsets[middle] <= target) {
        candidate = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    let index = this.checkpointOffsets[candidate]
    let bytes = this.checkpointBytes[candidate]
    while (index < target) {
      const code = this.text.charCodeAt(index)
      let width = 1
      let units = 1
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = this.text.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          width = 4
          units = 2
        } else {
          width = 3
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        width = 3
      } else if (code < 0x80) {
        width = 1
      } else if (code < 0x800) {
        width = 2
      } else {
        width = 3
      }
      if (index + units > target) return bytes + width
      bytes += width
      index += units
    }
    return bytes
  }

  /** 1-based line at a UTF-16 offset, or undefined when the line index was capped. */
  lineAt(offset: number): number | undefined {
    if (!this.lineIndexFull) return undefined
    const target = clampOffset(offset, this.text.length)
    let low = 0
    let high = this.lineStarts.length - 1
    let candidate = 0
    while (low <= high) {
      const middle = (low + high) >>> 1
      if (this.lineStarts[middle] <= target) {
        candidate = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return candidate + 1
  }

  /** 1-based UTF-16 column at an offset, or undefined without a line index. */
  columnAt(offset: number): number | undefined {
    const line = this.lineAt(offset)
    if (line === undefined) return undefined
    return clampOffset(offset, this.text.length) - this.lineStarts[line - 1] + 1
  }

  /**
   * Compute byte and line/column ranges for one span. Bytes are always present;
   * lines/columns are omitted when the line index is unavailable or the text is
   * not UTF-8 representable. Lines are inclusive, columns end-exclusive.
   */
  rangeFor(span: SourceSpan): SourceRange {
    const start = clampOffset(span.start, this.text.length)
    const end = clampOffset(Math.max(span.start, span.end), this.text.length)
    const bytes = { start: this.byteAt(start), end: this.byteAt(end) }
    if (!this.representable || !this.lineIndexFull) return { bytes }
    const startLine = this.lineAt(start)
    const endLine = this.lineAt(end > start ? end - 1 : start)
    const startColumn = this.columnAt(start)
    const endColumn = this.columnAt(end)
    if (startLine === undefined || endLine === undefined || startColumn === undefined || endColumn === undefined) {
      return { bytes }
    }
    return {
      bytes,
      lines: { start: startLine, end: endLine },
      columns: { start: startColumn, end: endColumn },
    }
  }

  private pushLineStart(offset: number): void {
    if (!this.lineIndexFull) return
    if (this.lineStarts.length >= MAX_LINE_INDEX_LINES) {
      this.lineIndexFull = false
      return
    }
    this.lineStarts.push(offset)
  }
}

function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return 0
  if (offset <= 0) return 0
  if (offset >= length) return length
  return Math.trunc(offset)
}

/**
 * Validate and build a `NodeReference`.
 *
 * Throws `InvalidArgumentError` for an unknown scheme, an empty target, a
 * non-workspace-relative or traversal path, a non-http(s) URL, or malformed
 * ranges. Path validation is lexical; no file is touched.
 */
export function createNodeReference(input: NodeReferenceInput): NodeReference {
  if (!REFERENCE_SCHEMES.has(input.scheme)) {
    throw new InvalidArgumentError('unknown reference scheme', { scheme: input.scheme })
  }
  if (typeof input.target !== 'string' || input.target.length === 0) {
    throw new InvalidArgumentError('reference target must be a non-empty string')
  }
  let path: string | undefined
  if (input.path !== undefined) {
    path = normaliseWorkspacePath(input.path)
    if (path === undefined) {
      throw new InvalidArgumentError(
        'reference path must be workspace-relative and must not escape the workspace',
        { path: input.path },
      )
    }
  }
  if ((input.scheme === 'file' || input.scheme === 'module') && path === undefined) {
    throw new InvalidArgumentError('file-backed reference requires a workspace path', { scheme: input.scheme })
  }
  if (input.scheme === 'url') {
    if (!/^https?:\/\//i.test(input.target)) {
      throw new InvalidArgumentError('url reference target must be an http(s) URL', { target: input.target })
    }
  }
  if ((input.scheme === 'symbol' || input.scheme === 'formula') && path === undefined) {
    const hashIndex = input.target.indexOf('#')
    const filePart = hashIndex >= 0 ? input.target.slice(0, hashIndex) : input.target
    if (filePart.length > 0 && /[\\/]/.test(filePart) && normaliseWorkspacePath(filePart) === undefined) {
      throw new InvalidArgumentError('reference target path escapes the workspace', { target: input.target })
    }
  }
  if (input.bytes !== undefined) assertRange(input.bytes, 'bytes', 0)
  if (input.lines !== undefined) assertRange(input.lines, 'lines', 1)
  if (input.columns !== undefined) assertRange(input.columns, 'columns', 1)
  const charset = input.charset ?? 'utf-8'
  if (!CHARSETS.has(charset)) {
    throw new InvalidArgumentError('unknown reference charset', { charset })
  }

  const reference: NodeReference = { scheme: input.scheme, target: input.target, charset }
  if (isRangeCapableCharset(charset)) reference.encoding = 'utf-8'
  if (path !== undefined) reference.path = path
  if (input.bytes !== undefined) reference.bytes = { ...input.bytes }
  if (input.lines !== undefined) reference.lines = { ...input.lines }
  if (input.columns !== undefined) reference.columns = { ...input.columns }
  if (input.hash !== undefined) reference.hash = input.hash
  if (input.fileBytes !== undefined) reference.fileBytes = input.fileBytes
  if (input.mtime !== undefined) reference.mtime = input.mtime
  if (input.mediaType !== undefined) reference.mediaType = input.mediaType
  if (input.parserId !== undefined) reference.parserId = input.parserId
  if (input.external !== undefined) reference.external = input.external
  if (input.span !== undefined) reference.span = { ...input.span }
  return reference
}

const REFERENCE_SCHEMES: ReadonlySet<NodeReferenceScheme> = new Set([
  'file',
  'symbol',
  'module',
  'formula',
  'sheet-cell',
  'url',
  'handle',
])

function assertRange(range: { start: number; end: number }, name: string, minimum: number): void {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
    throw new InvalidArgumentError(`${name} range must contain integers`, { range })
  }
  if (range.start < minimum || range.end < range.start) {
    throw new InvalidArgumentError(`${name} range must satisfy ${minimum} <= start <= end`, { range })
  }
}

/** Shared encoder; TextEncoder emits UTF-8 and is available in Node and browsers. */
const TEXT_ENCODER = new TextEncoder()

/**
 * Host-computed SHA-256 fingerprint of a fragment's exact raw UTF-8 bytes, as
 * `sha256:<hex>`. The bytes are hashed and discarded; no content is stored.
 *
 * For UTF-8/ASCII input the UTF-8 encoding of the decoded fragment is exactly
 * the original raw fragment bytes (BOM excluded before this call). P0 does not
 * transcode other charsets; callers omit line ranges and report that.
 */
export function sha256Fingerprint(text: string): string {
  const bytes = TEXT_ENCODER.encode(text)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Compute the six flat file-fragment coordinates for a span: path, UTF-8 byte
 * range, inclusive line range and the SHA-256 fingerprint of the exact fragment
 * text. Bytes and lines come from the same `SourceMap` pass, so they agree.
 *
 * Lines are omitted (and one `unverifiable` diagnostic recorded) when the text
 * is not UTF-8 representable or the line index was capped; bytes and the
 * fingerprint remain.
 *
 * Time O(span bytes) for the fingerprint plus O(stride + log lines); space
 * O(1).
 */
export function fragmentForSpan(
  ctx: ParseContext,
  span: SourceSpan,
  pathOverride?: string,
): FlatFragment {
  const path = pathOverride ?? ctx.path
  const effective = effectiveSpan(ctx, span)
  const range = ctx.sourceMap.rangeFor(effective)
  const linesAvailable = ctx.rangeCapable && range.lines !== undefined
  if (!linesAvailable) {
    ctx.unverifiableOnce(
      `fragment-lines:${ctx.charset}`,
      'reference line/column range unavailable (non-UTF-8 charset, unrepresentable text or capped line index); byte range only',
      effective,
    )
  }
  const fragment: FlatFragment = {
    byteStart: range.bytes.start,
    byteEnd: range.bytes.end,
    fingerprint: sha256Fingerprint(ctx.text.slice(effective.start, effective.end)),
    charset: ctx.charset,
  }
  if (path !== undefined) fragment.path = path
  if (linesAvailable && range.lines !== undefined) {
    fragment.lineStart = range.lines.start
    fragment.lineEnd = range.lines.end
  }
  return fragment
}

/**
 * Build a body-free reference for a node span, using the parse context's
 * `SourceMap`, path, file size and mtime.
 *
 * Bytes are always present. Lines/columns are omitted (and one `unverifiable`
 * diagnostic is recorded) when the source is not UTF-8 representable or the
 * line index was capped; lines are never guessed. `hash` is the same
 * `sha256:<hex>` fingerprint as the flat `fingerprint`, so the nested and flat
 * views cannot drift.
 */
export function referenceForSpan(
  ctx: ParseContext,
  input: {
    scheme: NodeReferenceScheme
    target: string
    path?: string
    span: SourceSpan
    mediaType?: string
    parserId?: string
  },
): NodeReference {
  const path = input.path ?? ctx.path
  const effective = effectiveSpan(ctx, input.span)
  const range = ctx.sourceMap.rangeFor(effective)
  const linesAvailable = ctx.rangeCapable && range.lines !== undefined
  if (!linesAvailable) {
    ctx.unverifiableOnce(
      `reference-lines:${ctx.charset}`,
      'reference line/column range unavailable (non-UTF-8 charset, unrepresentable text or capped line index); byte range only',
      effective,
    )
  }
  const fingerprint = sha256Fingerprint(ctx.text.slice(effective.start, effective.end))
  return createNodeReference({
    scheme: input.scheme,
    target: input.target,
    ...(path === undefined ? {} : { path }),
    bytes: range.bytes,
    ...(linesAvailable && range.lines !== undefined ? { lines: range.lines } : {}),
    ...(linesAvailable && range.columns !== undefined ? { columns: range.columns } : {}),
    hash: fingerprint,
    fileBytes: ctx.fileBytes,
    ...(ctx.mtime === undefined ? {} : { mtime: ctx.mtime }),
    ...(input.mediaType === undefined
      ? mediaTypeForPath(path) === undefined
        ? {}
        : { mediaType: mediaTypeForPath(path) as string }
      : { mediaType: input.mediaType }),
    ...(input.parserId === undefined ? {} : { parserId: input.parserId }),
    span: effective,
    charset: ctx.charset,
  })
}

/** Span with BOM bytes excluded from the start. */
function effectiveSpan(ctx: ParseContext, span: SourceSpan): SourceSpan {
  const start = Math.max(clampOffset(span.start, ctx.text.length), ctx.bomOffset)
  const end = Math.max(start, clampOffset(span.end, ctx.text.length))
  return { start, end, line: span.line, column: span.column }
}

/**
 * Build a capped, sanitised `NodeMetadata`. Empty optional fields are omitted
 * instead of stored as `''`; a name that sanitises to empty is dropped, never
 * replaced by a guess. `kind` must be a non-empty string. A supplied reference
 * is validated (workspace-relative path, URL only for the `url` scheme).
 *
 * Time O(total field length), space O(total field length).
 */
export function createNodeMetadata(input: NodeMetadataInput): NodeMetadata {
  if (typeof input.kind !== 'string' || input.kind.length === 0) {
    throw new InvalidArgumentError('node metadata requires a non-empty kind')
  }
  const metadata: NodeMetadata = { kind: input.kind, span: input.span }
  if (input.identity !== undefined && input.identity.length > 0) metadata.identity = input.identity
  if (input.locator !== undefined && input.locator.length > 0) metadata.locator = input.locator
  const name = sanitizeMetadataText(input.name, MAX_NAME_LENGTH)
  if (name.length > 0) metadata.name = name
  const label = sanitizeMetadataText(input.label, MAX_NAME_LENGTH)
  if (label.length > 0) metadata.label = label
  const summary = sanitizeMetadataText(input.summary, MAX_SUMMARY_LENGTH)
  if (summary.length > 0) metadata.summary = summary
  const description = sanitizeMetadataText(input.description, MAX_DESCRIPTION_LENGTH)
  if (description.length > 0) metadata.description = description
  const usage = sanitizeMetadataText(input.usage, MAX_USAGE_LENGTH)
  if (usage.length > 0) metadata.usage = usage
  const purpose = sanitizeMetadataText(input.purpose, MAX_PURPOSE_LENGTH)
  if (purpose.length > 0) metadata.purpose = purpose
  const brief = sanitizeMetadataText(input.brief, MAX_BRIEF_LENGTH)
  if (brief.length > 0) metadata.brief = brief
  if (input.reference !== undefined) {
    const reference = createNodeReference(input.reference)
    metadata.reference = reference
    if (reference.path !== undefined) metadata.path = reference.path
    if (reference.bytes !== undefined) {
      metadata.byteStart = reference.bytes.start
      metadata.byteEnd = reference.bytes.end
    }
    if (reference.lines !== undefined) {
      metadata.lineStart = reference.lines.start
      metadata.lineEnd = reference.lines.end
    }
    metadata.charset = reference.charset
    if (reference.hash !== undefined) metadata.fingerprint = reference.hash
  }
  if (input.fragment !== undefined) {
    if (input.fragment.path !== undefined) metadata.path = input.fragment.path
    if (input.fragment.byteStart !== undefined) metadata.byteStart = input.fragment.byteStart
    if (input.fragment.byteEnd !== undefined) metadata.byteEnd = input.fragment.byteEnd
    if (input.fragment.lineStart !== undefined) metadata.lineStart = input.fragment.lineStart
    if (input.fragment.lineEnd !== undefined) metadata.lineEnd = input.fragment.lineEnd
    if (input.fragment.fingerprint !== undefined) metadata.fingerprint = input.fragment.fingerprint
    if (input.fragment.charset !== undefined) metadata.charset = input.fragment.charset
  }
  if (input.source !== undefined) metadata.source = input.source
  return metadata
}

/**
 * Append metadata to a result list under the per-file node cap. Overflow is a
 * truncation, not an exception: the list stops growing and one diagnostic is
 * recorded by the caller's context.
 *
 * Time O(field lengths), space O(1) plus the created object.
 */
export function pushNodeMetadata(
  ctx: ParseContext,
  target: NodeMetadata[],
  input: NodeMetadataInput,
): NodeMetadata | undefined {
  if (target.length >= MAX_METADATA_NODES) {
    ctx.limit('node-limit', `node metadata limit ${MAX_METADATA_NODES} reached; later nodes were dropped`)
    return undefined
  }
  const metadata = createNodeMetadata(input)
  target.push(metadata)
  return metadata
}

/**
 * Classify a raw specifier lexically.
 *
 * Rules: `#...` is a fragment, any URL scheme (`http:`, `data:`, `node:`, ...) is
 * external, `C:\`/`C:/` is a Windows drive path (absolute), `./`/`../` are
 * relative, `/`-rooted or backslash-rooted is absolute, and everything else is a
 * bare module specifier (external). No filesystem access, no extension guesses.
 */
export function classifySpecifier(specifier: string): SpecifierKind {
  if (typeof specifier !== 'string') {
    throw new InvalidArgumentError('specifier must be a string', { type: typeof specifier })
  }
  const value = specifier.trim()
  if (value.length === 0) return 'external'
  if (value.startsWith('#')) return 'fragment'
  if (/^[A-Za-z]:[\\/]/.test(value)) return 'absolute'
  if (value.startsWith('./') || value.startsWith('../') || value === '.' || value === '..') {
    return 'relative'
  }
  if (value.startsWith('//') || value.startsWith('\\\\')) {
    // Protocol-relative URL (`//host/x`) or UNC path (`\\host\share`). Neither is
    // a workspace file, so both are external for the dependency graph.
    return 'external'
  }
  if (value.startsWith('/') || value.startsWith('\\')) return 'absolute'
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return 'external'
  return 'external'
}

/** True when a specifier must not become a local dependency-graph edge. */
export function isExternalSpecifier(specifier: string): boolean {
  const kind = classifySpecifier(specifier)
  return kind === 'external' || kind === 'fragment'
}

/**
 * Per-parse mutable state: bounded source, deadline, abort signal, diagnostics
 * and truncation flags. Parsers call `checkpoint` every N tokens/characters, so
 * the timeout is checked periodically without measuring time per character.
 *
 * Time of `checkpoint` is O(1); `finalize` copies the diagnostic list, O(d).
 */
export class ParseContext {
  /** Possibly truncated source text. */
  readonly text: string
  /** Length of the text handed to the constructor. */
  readonly originalLength: number
  /** Effective token budget, never above `MAX_TOKENS`. */
  readonly maxTokens: number
  /** Effective AST depth budget, never above `MAX_AST_DEPTH`. */
  readonly maxDepth: number
  /** Effective wall-clock budget in milliseconds. */
  readonly timeoutMs: number
  /** Abort signal, if any. */
  readonly signal: AbortSignal | undefined
  /** Whole-file UTF-8 byte size, from `options.size` or computed from the text. */
  readonly fileBytes: number
  /** File mtime in milliseconds, when the file layer supplied it. */
  readonly mtime: number | undefined
  /** Detected charset; P0 only line-maps UTF-8/ASCII. */
  readonly charset: Charset
  /** BOM bytes at the start of the file; no fragment range includes them. */
  readonly bomBytes: number
  /** BOM length in UTF-16 code units (1 for a leading U+FEFF, else 0). */
  readonly bomOffset: number
  /** True when byte+line ranges can be computed (UTF-8/ASCII only). */
  readonly rangeCapable: boolean
  /** Diagnostics collected so far (bounded by `MAX_DIAGNOSTICS`). */
  readonly diagnostics: Diagnostic[] = []
  /** True when any limit or timeout ended work early. */
  truncated = false
  /** Lexical token count reported by the parser. */
  tokens = 0

  private readonly deadline: number
  private readonly seenCodes = new Set<DiagnosticCode>()
  private readonly seenNotes = new Set<string>()
  private readonly optionsPath: string | undefined
  private readonly optionsParserId: string | undefined
  private sourceMapCache: SourceMap | undefined
  private stopped = false
  private didTimeOut = false

  /**
   * @param text Source text. Values longer than `MAX_TEXT_LENGTH` are cut.
   * @param options Parse options; invalid budgets throw `InvalidArgumentError`.
   * Time O(n) for the length check/slice, space O(n) worst case for the slice.
   */
  constructor(text: string, options: ParseOptions = {}) {
    if (typeof text !== 'string') {
      throw new InvalidArgumentError('parser input must be a string', { type: typeof text })
    }
    this.originalLength = text.length
    this.maxTokens = positiveLimit(options.maxTokens, MAX_TOKENS, 'maxTokens')
    this.maxDepth = positiveLimit(options.maxDepth, MAX_AST_DEPTH, 'maxDepth')
    this.timeoutMs = timeoutLimit(options.timeoutMs)
    this.signal = options.signal
    if (this.signal !== undefined && typeof this.signal.throwIfAborted !== 'function') {
      throw new InvalidArgumentError('signal must be an AbortSignal')
    }
    if (options.path !== undefined && typeof options.path !== 'string') {
      throw new InvalidArgumentError('parse path must be a string', { path: typeof options.path })
    }
    if (options.parserId !== undefined && typeof options.parserId !== 'string') {
      throw new InvalidArgumentError('parserId must be a string', { parserId: typeof options.parserId })
    }
    this.optionsParserId = options.parserId
    if (options.path === undefined) {
      this.optionsPath = undefined
    } else {
      const normalised = normaliseWorkspacePath(options.path)
      if (normalised === undefined) {
        this.optionsPath = undefined
        this.push({
          code: 'parse-error',
          message: 'parse path is not workspace-relative and was ignored for references',
          severity: 'warning',
        })
      } else {
        this.optionsPath = normalised
      }
    }
    if (options.size !== undefined) {
      if (!Number.isInteger(options.size) || options.size < 0) {
        throw new InvalidArgumentError('size must be a non-negative integer', { size: options.size })
      }
      this.fileBytes = options.size
    } else {
      this.fileBytes = utf8ByteLength(text)
    }
    if (options.mtime !== undefined) {
      if (!Number.isInteger(options.mtime) || options.mtime < 0) {
        throw new InvalidArgumentError('mtime must be a non-negative integer', { mtime: options.mtime })
      }
      this.mtime = options.mtime
    } else {
      this.mtime = undefined
    }

    if (options.bomBytes !== undefined && (!Number.isInteger(options.bomBytes) || options.bomBytes < 0)) {
      throw new InvalidArgumentError('bomBytes must be a non-negative integer', { bomBytes: options.bomBytes })
    }
    const detection = detectCharset(text, options.charset)
    this.charset = detection.charset
    this.rangeCapable = isRangeCapableCharset(detection.charset)
    const leadingBomUnits = text.startsWith('\uFEFF') ? 1 : 0
    this.bomBytes = Math.max(options.bomBytes ?? detection.bomBytes, leadingBomUnits > 0 ? 3 : 0)
    this.bomOffset = leadingBomUnits
    if (!this.rangeCapable) {
      this.unverifiable(
        `charset "${detection.charset}" is not transcoded in P0; byte ranges and fingerprint only, no line ranges`,
      )
    }

    if (text.length > MAX_TEXT_LENGTH) {
      this.text = text.slice(0, MAX_TEXT_LENGTH)
      this.truncated = true
      this.push({
        code: 'text-limit',
        message: `source exceeds ${MAX_TEXT_LENGTH} UTF-16 code units; parsed the prefix`,
        span: { start: MAX_TEXT_LENGTH, end: text.length, line: 1, column: 1 },
        severity: 'warning',
      })
    } else {
      this.text = text
    }

    this.deadline = Date.now() + this.timeoutMs
  }

  /**
   * Lazily-built byte/line mapper for the (possibly truncated) source.
   * Time O(n) on first access, O(1) afterwards.
   */
  get sourceMap(): SourceMap {
    this.sourceMapCache ??= new SourceMap(this.text)
    return this.sourceMapCache
  }

  /** Workspace path from the options, if supplied. O(1). */
  get path(): string | undefined {
    return this.optionsPath
  }

  /** Parser id from the options, if supplied. O(1). */
  get parserId(): string | undefined {
    return this.optionsParserId
  }

  /** True once the deadline has been recorded as exceeded. O(1). */
  get timedOut(): boolean {
    return this.didTimeOut
  }

  /** True once any stop condition (limit, timeout, abort) has fired. O(1). */
  get isStopped(): boolean {
    return this.stopped
  }

  /**
   * Deadline/abort gate. Returns false when the parser must stop. A caller that
   * passed an aborted signal gets `signal.throwIfAborted()` — an exception is
   * the standard contract, and the parser never hides cancellation.
   *
   * Time O(1), space O(1).
   */
  checkpoint(): boolean {
    if (this.signal !== undefined) this.signal.throwIfAborted()
    if (this.didTimeOut) return false
    if (Date.now() >= this.deadline) {
      this.didTimeOut = true
      this.stopped = true
      this.truncated = true
      this.push({
        code: 'timeout',
        message: `parse exceeded its ${this.timeoutMs} ms budget; returned the parsed prefix`,
        severity: 'warning',
      })
      return false
    }
    return true
  }

  /**
   * Stop hook for the tokenizer: true means "stop scanning".
   * Time O(1); may throw on an aborted signal.
   */
  readonly shouldStop = (): boolean => this.checkpoint() === false

  /**
   * Record a limit. `truncated` is set even when the diagnostic is deduplicated.
   * Time O(1), space O(1).
   */
  limit(code: DiagnosticCode, message: string, span?: SourceSpan): void {
    this.stopped = true
    this.truncated = true
    this.push({ code, message, ...(span === undefined ? {} : { span }), severity: 'warning' })
  }

  /** Record an `unverifiable` observation (no truncation implied). */
  unverifiable(message: string, span?: SourceSpan): void {
    this.push({
      code: 'unverifiable',
      message,
      ...(span === undefined ? {} : { span }),
      severity: 'warning',
    })
  }

  /** Record a malformed-input observation (no truncation implied). */
  parseError(message: string, span?: SourceSpan): void {
    this.push({
      code: 'parse-error',
      message,
      ...(span === undefined ? {} : { span }),
      severity: 'warning',
    })
  }

  /**
   * Record an `unverifiable` observation at most once per key. Used for
   * per-fragment facts (no line ranges, capped index) that would otherwise
   * repeat for every node in the file.
   */
  unverifiableOnce(key: string, message: string, span?: SourceSpan): void {
    if (this.seenNotes.has(key)) return
    this.seenNotes.add(key)
    this.unverifiable(message, span)
  }

  /** Push a diagnostic if its code is new (limits/timeouts) or budget remains. */
  private push(diagnostic: Diagnostic): void {
    if (diagnostic.code !== 'unverifiable' && diagnostic.code !== 'parse-error') {
      if (this.seenCodes.has(diagnostic.code)) return
      this.seenCodes.add(diagnostic.code)
    }
    if (this.diagnostics.length >= MAX_DIAGNOSTICS) return
    this.diagnostics.push(diagnostic)
  }

  /**
   * Project the context into the public result. The parser supplies its id,
   * references, token count and optionally an AST; truncation and diagnostics
   * come from the context.
   *
   * Time O(d) for the diagnostic copy.
   */
  finalize(input: {
    parserId: string
    references: FileReference[]
    tokens?: number
    ast?: AstTree<string>
    document?: DocumentMetadata
    nodes?: NodeMetadata[]
  }): ParseResult {
    const result: ParseResult = {
      parserId: input.parserId,
      references: input.references,
      diagnostics: [...this.diagnostics],
      truncated: this.truncated,
      tokens: input.tokens ?? this.tokens,
      charset: this.charset,
      bomBytes: this.bomBytes,
    }
    if (input.ast !== undefined) result.ast = input.ast
    if (input.document !== undefined) result.document = input.document
    if (input.nodes !== undefined && input.nodes.length > 0) result.nodes = input.nodes
    return result
  }
}

/**
 * Build the root AST node for a file. Kind is parser-specific (`document`,
 * `module`, `stylesheet`, ...); the span is the whole (possibly truncated) text.
 *
 * Time O(1), space O(1).
 */
export function createAstRoot(kind: string, textLength: number): AstNode<string> {
  return new AstNode<string>(kind, { start: 0, end: Math.max(0, textLength), line: 1, column: 1 })
}

/**
 * Attach a child when the depth/span limits allow it.
 *
 * Returns `undefined` after recording `depth-limit` when the parent is already
 * at `ctx.maxDepth`. This is the only place parser ASTs grow, so no parser needs
 * its own recursion/depth accounting.
 *
 * Time O(parent.depth) for the depth read (the AST is shallow except nested
 * Markdown divs), space O(1).
 */
export function appendAstNode(
  ctx: ParseContext,
  parent: AstNode<string>,
  kind: string,
  span: SourceSpan,
  value?: string,
): AstNode<string> | undefined {
  const depth = parent.depth + 1
  if (depth > ctx.maxDepth) {
    ctx.limit('depth-limit', `AST depth limit ${ctx.maxDepth} reached; deeper nodes were dropped`, span)
    return undefined
  }
  const node = new AstNode<string>(kind, span, value)
  parent.addChild(node)
  return node
}

/**
 * Monotonic offset → `SourceSpan` locator.
 *
 * A parser calls it with increasing offsets during its single forward scan, so
 * the locator advances one pass over the text, O(n) total. Calling it with a
 * smaller offset than the previous call is a programming error and throws; if a
 * parser needs a second scan, it creates a second locator.
 *
 * Time O(distance), space O(1).
 */
export function createSpanLocator(text: string): (start: number, end: number) => SourceSpan {
  let offset = 0
  let line = 1
  let lineStart = 0
  const advanceTo = (to: number): void => {
    if (to < offset) {
      throw new InvalidArgumentError('span locator offsets must be monotonically non-decreasing', {
        requested: to,
        previous: offset,
      })
    }
    for (let cursor = offset; cursor < to; cursor += 1) {
      const code = text.charCodeAt(cursor)
      if (code === 10) {
        line += 1
        lineStart = cursor + 1
      } else if (code === 13 && text.charCodeAt(cursor + 1) !== 10) {
        line += 1
        lineStart = cursor + 1
      }
    }
    offset = to
  }
  return (start: number, end: number): SourceSpan => {
    advanceTo(start)
    const spanLine = line
    const spanColumn = start - lineStart + 1
    advanceTo(end)
    return { start, end, line: spanLine, column: spanColumn }
  }
}

/**
 * Registry of parsers keyed by extension and id.
 *
 * `resolve` implements the documented order: an explicit path extension wins,
 * the caller's `parserId` is the fallback, and nothing is guessed. Unknown
 * extensions return `undefined` rather than a default parser.
 *
 * All operations are O(1) average map lookups; `parsers`/`ids`/`extensions`
 * are O(n) snapshots.
 */
export class ParserRegistry {
  private readonly byIdStore = new Map<string, Parser>()
  private readonly byExtensionStore = new Map<string, Parser>()

  /**
   * Register a parser. Throws `InvalidArgumentError` for an invalid id, an
   * empty extension list, a malformed extension or a duplicate id/extension:
   * two parsers claiming one extension is a configuration bug, not a choice.
   */
  register(parser: Parser): this {
    if (parser === null || typeof parser !== 'object') {
      throw new InvalidArgumentError('parser must be an object')
    }
    if (typeof parser.id !== 'string' || parser.id.length === 0) {
      throw new InvalidArgumentError('parser id must be a non-empty string', { id: parser.id })
    }
    if (!Array.isArray(parser.extensions) || parser.extensions.length === 0) {
      throw new InvalidArgumentError('parser must declare at least one extension', { id: parser.id })
    }
    if (typeof parser.parse !== 'function') {
      throw new InvalidArgumentError('parser must implement parse()', { id: parser.id })
    }
    if (this.byIdStore.has(parser.id)) {
      throw new InvalidArgumentError('parser id is already registered', { id: parser.id })
    }
    const extensions: string[] = []
    for (const raw of parser.extensions) {
      if (typeof raw !== 'string' || !raw.startsWith('.') || raw.length < 2) {
        throw new InvalidArgumentError('parser extensions must start with a dot', {
          id: parser.id,
          extension: raw,
        })
      }
      const extension = raw.toLowerCase()
      const existing = this.byExtensionStore.get(extension)
      if (existing !== undefined) {
        throw new InvalidArgumentError('extension is already claimed by another parser', {
          extension,
          id: parser.id,
          owner: existing.id,
        })
      }
      extensions.push(extension)
    }
    this.byIdStore.set(parser.id, parser)
    for (const extension of extensions) this.byExtensionStore.set(extension, parser)
    return this
  }

  /** Parser by id, or `undefined`. Time O(1). */
  get(id: string): Parser | undefined {
    return this.byIdStore.get(id)
  }

  /** Parser by extension (with or without the leading dot), or `undefined`. */
  forExtension(extension: string): Parser | undefined {
    if (typeof extension !== 'string' || extension.length === 0) return undefined
    const normalised = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
    return this.byExtensionStore.get(normalised)
  }

  /**
   * Resolve a parser from `path` then `parserId`; never guesses.
   * Time O(1) average.
   */
  resolve(path?: string, parserId?: string): Parser | undefined {
    if (path !== undefined) {
      const extension = extensionOf(path)
      if (extension !== undefined) {
        const parser = this.byExtensionStore.get(extension)
        if (parser !== undefined) return parser
      }
    }
    if (parserId !== undefined) return this.byIdStore.get(parserId)
    return undefined
  }

  /** Registered ids in registration order. Time O(n). */
  ids(): string[] {
    return [...this.byIdStore.keys()]
  }

  /** Registered extensions in registration order. Time O(n). */
  extensions(): string[] {
    return [...this.byExtensionStore.keys()]
  }

  /** Registered parsers in registration order. Time O(n). */
  parsers(): Parser[] {
    return [...this.byIdStore.values()]
  }

  /** Number of registered parsers. Time O(1). */
  get size(): number {
    return this.byIdStore.size
  }
}

/**
 * Lowercased extension of a path, including the dot, or `undefined`.
 *
 * Dotfiles (`.gitignore`) and trailing dots have no extension. `path` is a
 * workspace path, not a URL; no query/fragment handling is attempted.
 * Time O(length of the last segment).
 */
export function extensionOf(path: string): string | undefined {
  if (typeof path !== 'string' || path.length === 0) return undefined
  let baseStart = 0
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const character = path[index]
    if (character === '/' || character === '\\') {
      baseStart = index + 1
      break
    }
  }
  const base = path.slice(baseStart)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return undefined
  return base.slice(dot).toLowerCase()
}

/** Validate a positive integer budget and clamp it to `maximum`. */
function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidArgumentError(`${name} must be a positive integer`, { [name]: value })
  }
  return Math.min(value, fallback)
}

/** Validate a millisecond budget; `0` means "time out immediately". */
function timeoutLimit(value: number | undefined): number {
  if (value === undefined) return MAX_PARSE_MS
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentError('timeoutMs must be a non-negative integer', { timeoutMs: value })
  }
  return Math.min(value, MAX_PARSE_MS)
}
