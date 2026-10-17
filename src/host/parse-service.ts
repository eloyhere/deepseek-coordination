/**
 * Per-session/process parse service: the file layer around the pure P0 parser.
 *
 * `src/host/text/**` never touches the filesystem: `parseFileText` takes text
 * and returns spans/references/metadata. This service is the missing half — it
 * validates a workspace-relative path, reads at most 1 MiB, detects the charset,
 * calls the parser with the documented budgets, caches the *metadata-only*
 * result and returns everything an agent-facing tool needs:
 *
 *   - `NodeMetadata[]` (name/kind/summary/brief/reference/flat fields; no body),
 *   - `references` (specifier + span; no resolved bytes),
 *   - `diagnostics`, `charset`, `bomBytes`, `truncated`, `tokens`,
 *   - a bounded structural slice (`headings`/`statements`/`divs`/formula
 *     references) that `chain.ts` needs for Book/Article/heading/proof edges.
 *
 * Invariants (docs/domain-model-v24.md §2.4–§2.7, docs/file-processing-v24.md §4):
 *
 * | Budget | Value |
 * |---|---|
 * | bytes read per file | 1 MiB (prefix; `truncated`) |
 * | source text handed to a parser | 1 MiB UTF-16 code units (parser) |
 * | tokens per parse | 200,000 (parser) |
 * | node metadata per parse | 20,000 (parser) |
 * | parse wall clock | 2,000 ms (parser) |
 * | parse cache | 256 files, LRU keyed `path+mtime+size+parserId` |
 * | read cap | 256 KiB / 2,000 lines / 16,000 tokens per `coordination_read` |
 *
 * **No body storage.** The decoded source text is a local variable: it is never
 * put on `ParsedFile`, never cached and never returned. The only method that
 * returns real text is {@link ParseService.readContent}, which backs
 * `coordination_read`; it is the single authorized content path.
 *
 * Workspace root: `options.workspaceRoot ?? process.cwd()`. The tool layer
 * resolves the real root first (`resolveToolWorkspaceRoot`: explicit tool option
 * → service root → `ModuleHost` root → DSH sandbox policy) and only falls back
 * to `process.cwd()` when the host exposes none. Every path is validated
 * lexically (`normaliseWorkspacePath`), resolved under the root and re-checked
 * with `realpath` when the file exists, so traversal, absolute paths, UNC paths
 * and symlinks out of the root are rejected before any read.
 *
 * Dependencies: Node builtins (`node:fs`, `node:crypto`, `node:path`), the pure
 * text layer, the bounded `ParseCache`, `estimateTokens` for the read budget and
 * the typed errors. No new package, no DSH import.
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { InvalidArgumentError, InvalidStateError, NotFoundError } from '../shared/error.js'
import { LruList } from '../shared/lru.js'
import {
  MAX_METADATA_NODES,
  MAX_AST_DEPTH,
  MAX_PARSE_MS,
  MAX_TOKENS,
  createNodeMetadata,
  createNodeReference,
  isRangeCapableCharset,
  normaliseWorkspacePath,
  sha256Fingerprint,
  utf8ByteLength,
} from './text/parser.js'
import { defaultParserRegistry, parseFileText, parseText } from './text/index.js'
import { classifySpecifier } from './text/parser.js'
import {
  MAX_GRAPH_EDGES,
  MAX_GRAPH_VERTICES,
  createDependencyGraph,
  resolveSpecifier,
} from './text/dependency.js'
import type { DependencySource } from './text/dependency.js'
import type {
  Charset,
  Diagnostic,
  DocumentMetadata,
  FileReference,
  NodeMetadata,
  ParseOptions,
  ParseResult,
} from './text/parser.js'
import type { SourceSpan } from '../shared/ast.js'
import { estimateTokens } from './token.js'

/* ------------------------------------------------------------------------- *
 * Budgets
 * ------------------------------------------------------------------------- */

/** Bytes read from one file before parsing (1 MiB). */
export const MAX_FILE_BYTES = 1_048_576
/** Node metadata retained per parse (the parser's own cap). */
export const MAX_PARSE_NODES = MAX_METADATA_NODES
/** Token budget handed to a parser. */
export const MAX_PARSE_TOKENS = MAX_TOKENS
/** Wall-clock budget handed to a parser. */
export const MAX_PARSE_DURATION_MS = MAX_PARSE_MS
/** Default parse cache capacity (files). */
export const DEFAULT_PARSE_CACHE_CAPACITY = 256
/** One `coordination_read` may return at most 256 KiB. */
export const MAX_READ_BYTES = 262_144
/** One `coordination_read` may return at most 2,000 lines. */
export const MAX_READ_LINES = 2_000
/** One `coordination_read` may return at most 16,000 estimated tokens. */
export const MAX_READ_TOKENS = 16_000
/**
 * Line-mode reads scan the whole file to build line offsets. To keep that work
 * bounded, files above this size must be read in bytes mode (documented limit,
 * fail-closed, no silent truncation of the *line index*).
 */
export const MAX_LINE_SCAN_BYTES = 8 * 1024 * 1024
/** Structural items retained per parse (headings/statements/divs/formulas). */
export const MAX_STRUCTURE_ITEMS = 20_000
/** Formula references retained per parse. */
export const MAX_STRUCTURE_FORMULA_REFERENCES = 5_000

/* ------------------------------------------------------------------------- *
 * Result shapes (metadata only; no body)
 * ------------------------------------------------------------------------- */

/** Node lifecycle status from the domain model. */
export type NodeStatus = 'parsed' | 'partial' | 'truncated' | 'failed' | 'unverifiable'

/** One heading, reduced to what a chain/outline needs. */
export interface ParsedHeading {
  level: number
  title: string
  /** UTF-16 offset of the heading start; stable for handle derivation. */
  spanStart: number
}

/** One theorem-like statement, reduced to what a chain needs. */
export interface ParsedStatement {
  kind: string
  label?: string
  /** Target of a proof, from an explicit `\ref` inside the proof environment. */
  proofTarget?: string
  spanStart: number
}

/** One Pandoc fenced div (`::: require`, `::: meet`, ...). */
export interface ParsedDiv {
  name: string
  depth: number
  spanStart: number
}

/** One explicit formula reference (label/equation/symbol), no expression text. */
export interface ParsedFormulaReference {
  kind: string
  target: string
  formulaSpanStart: number
}

/**
 * Structural slice of a parse. It is derived from parser-specific result
 * fields (headings/statements/divs/formulas) that the generic `ParseResult`
 * type does not expose; nothing here is guessed and nothing here is a body.
 */
export interface ParsedStructure {
  headings: ParsedHeading[]
  statements: ParsedStatement[]
  divs: ParsedDiv[]
  formulaReferences: ParsedFormulaReference[]
  /** Raw front-matter keys; values stay text, no YAML engine. */
  frontMatter: Record<string, string>
}

/** One reference, projected for the model (specifier only, no body). */
export interface ReferenceView {
  kind: string
  specifier: string
  external: boolean
  typeOnly: boolean
  classification: 'relative' | 'absolute' | 'external' | 'fragment'
  /** Lexical resolution against the importer, when local; never a file read. */
  resolved?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
}

/** The body-free result of parsing one file or one text. */
export interface ParsedFile {
  /** Workspace-relative path, when the input was a path. */
  path?: string
  parserId: string
  charset: Charset
  bomBytes: number
  truncated: boolean
  tokens: number
  /** Whole-file size in bytes (not the possibly truncated read). */
  size: number
  mtime?: number
  /** True when the result came from the LRU cache, not from a parse. */
  cached: boolean
  status: NodeStatus
  document?: DocumentMetadata
  /** Synthesized file-backed node (module/document/book/article); body-free. */
  file: NodeMetadata
  /** Parser nodes, bounded by `MAX_PARSE_NODES`. */
  nodes: NodeMetadata[]
  references: FileReference[]
  diagnostics: Diagnostic[]
  structure: ParsedStructure
}

/** Constructor options; every budget can only be lowered. */
export interface ParseServiceOptions {
  workspaceRoot?: string
  cacheCapacity?: number
  maxFileBytes?: number
  maxNodes?: number
  maxTokens?: number
  /** AST depth handed to the parser as `maxDepth`, capped to `MAX_AST_DEPTH`. */
  maxAstDepth?: number
  timeoutMs?: number
  /** Dependency-graph vertex cap, capped to `MAX_GRAPH_VERTICES`. */
  maxGraphVertices?: number
  /** Dependency-graph edge cap, capped to `MAX_GRAPH_EDGES`. */
  maxGraphEdges?: number
}

/**
 * Bounded summary of the workspace dependency graph the service can build from
 * the metadata of every file it has parsed.
 *
 * Counts only: no edge list, no graph object and no source text cross the
 * service boundary, which keeps the value small enough for a tool result. The
 * caps are the configured `parser.dependencyGraphMaxVertices/Edges`; overflow is
 * explicit in `truncated` plus one `graph-limit` diagnostic, exactly like the
 * pure `createDependencyGraph` layer.
 */
export interface DependencyGraphSummary {
  files: number
  references: number
  vertices: number
  edges: number
  graphEdges: number
  external: number
  unresolved: number
  isolated: number
  truncated: boolean
  diagnostics: Diagnostic[]
  limits: { maxVertices: number; maxEdges: number }
}

/** Input for {@link ParseService.parse}: exactly one of `path` or `text`. */
export interface ParseRequest {
  path?: string
  text?: string
  parserId?: string
  /** Declared charset; detection runs when absent. */
  charset?: Charset
}

/** Input for {@link ParseService.readContent} (the `coordination_read` args). */
export interface ReadRequest {
  path: string
  mode: 'bytes' | 'lines'
  /** Bytes mode: 0-based inclusive byte offset. Lines mode: 1-based line. */
  start: number
  /** Bytes mode: exclusive byte end. Lines mode: inclusive line end. */
  end?: number
  maxBytes?: number
  maxLines?: number
  /** Declared charset; a mismatch with the BOM is refused. */
  charset?: Charset
}

/** The only value in this plugin that may carry real file text. */
export interface ReadResult {
  path: string
  mode: 'bytes' | 'lines'
  requested: { start: number; end: number }
  returned: { start: number; end: number }
  content: string
  truncated: boolean
  charset: Charset
  bom: boolean
  bomBytes: number
  /** `sha256:<hex>` over the exact returned bytes (BOM excluded). */
  hash: string
  fileBytes: number
  mtime: number
  byteRange: { start: number; end: number }
  lineRange?: { start: number; end: number }
  /** Bytes-mode continuation: the exclusive byte offset of the next chunk. */
  nextStart?: number
  /** Lines-mode continuation: the next unread 1-based line. */
  nextLine?: number
}

/** Cache counters for tests and diagnostics. */
export interface ParseCacheStats {
  hits: number
  misses: number
  evictions: number
  size: number
  capacity: number
}

/* ------------------------------------------------------------------------- *
 * Service
 * ------------------------------------------------------------------------- */

/**
 * Workspace-bound parse service. One instance per session/process (the tool
 * layer shares one instance per `CoordinationService`); it is cheap to create
 * and owns only a bounded LRU cache.
 */
export class ParseService {
  /** Absolute workspace root every path is resolved against. */
  readonly workspaceRoot: string
  private readonly cache: LruList<string, ParsedFile>
  /** Latest parse per path, the input of {@link dependencyGraph} (bounded). */
  private readonly byPath: LruList<string, ParsedFile>
  private maxFileBytes: number
  private maxNodes: number
  private maxTokens: number
  private maxAstDepth: number
  private timeoutMs: number
  private maxGraphVertices: number
  private maxGraphEdges: number
  private realRoot: string | undefined
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(options: ParseServiceOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
    const capacity = positiveOption(options.cacheCapacity, DEFAULT_PARSE_CACHE_CAPACITY, 'cacheCapacity')
    this.cache = new LruList<string, ParsedFile>(capacity)
    this.byPath = new LruList<string, ParsedFile>(capacity)
    this.maxFileBytes = positiveOption(options.maxFileBytes, MAX_FILE_BYTES, 'maxFileBytes')
    this.maxNodes = positiveOption(options.maxNodes, MAX_PARSE_NODES, 'maxNodes')
    this.maxTokens = positiveOption(options.maxTokens, MAX_PARSE_TOKENS, 'maxTokens')
    this.maxAstDepth = positiveOption(options.maxAstDepth, MAX_AST_DEPTH, 'maxAstDepth')
    this.timeoutMs = positiveOption(options.timeoutMs, MAX_PARSE_DURATION_MS, 'timeoutMs')
    this.maxGraphVertices = positiveOption(
      options.maxGraphVertices,
      MAX_GRAPH_VERTICES,
      'maxGraphVertices',
    )
    this.maxGraphEdges = positiveOption(options.maxGraphEdges, MAX_GRAPH_EDGES, 'maxGraphEdges')
  }

  /** Effective AST depth budget (never above the parser's hard cap). */
  get astDepthLimit(): number {
    return this.maxAstDepth
  }

  /** Effective dependency-graph caps (never above the parser layer's hard caps). */
  get dependencyGraphLimits(): { maxVertices: number; maxEdges: number } {
    return { maxVertices: this.maxGraphVertices, maxEdges: this.maxGraphEdges }
  }

  /**
   * Apply a live host-config change in place.
   *
   * The workspace root is immutable (a different root means a different
   * workspace, so the tool runtime is recreated instead); every other budget is
   * updated. Cached parses whose key does not encode the budget (AST depth,
   * node cap) are dropped; the by-path index keeps its newest entries so the
   * dependency summary stays usable.
   */
  retune(options: ParseServiceOptions): void {
    this.maxFileBytes = positiveOption(options.maxFileBytes, MAX_FILE_BYTES, 'maxFileBytes')
    this.maxNodes = positiveOption(options.maxNodes, MAX_PARSE_NODES, 'maxNodes')
    this.maxTokens = positiveOption(options.maxTokens, MAX_PARSE_TOKENS, 'maxTokens')
    this.maxAstDepth = positiveOption(options.maxAstDepth, MAX_AST_DEPTH, 'maxAstDepth')
    this.timeoutMs = positiveOption(options.timeoutMs, MAX_PARSE_DURATION_MS, 'timeoutMs')
    this.maxGraphVertices = positiveOption(
      options.maxGraphVertices,
      MAX_GRAPH_VERTICES,
      'maxGraphVertices',
    )
    this.maxGraphEdges = positiveOption(options.maxGraphEdges, MAX_GRAPH_EDGES, 'maxGraphEdges')
    if (options.cacheCapacity !== undefined) {
      const capacity = positiveOption(options.cacheCapacity, DEFAULT_PARSE_CACHE_CAPACITY, 'cacheCapacity')
      this.cache.resize(capacity)
      this.byPath.resize(capacity)
    }
    // The cache key does not contain these budgets, so a cached result could
    // answer under the old cap. Dropping metadata is cheap; re-parsing is not
    // observable to a handle holder (handles and fingerprints are deterministic).
    this.cache.clear()
  }

  /** Cache counters; O(1). */
  cacheStats(): ParseCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.cache.size,
      capacity: this.cache.capacity,
    }
  }

  /** Drop every cached parse (used by tests and on dispose). */
  clear(): void {
    this.cache.clear()
    this.byPath.clear()
  }

  /**
   * Bounded dependency summary over every file this service has parsed (or the
   * supplied subset). The pure `createDependencyGraph` layer enforces the
   * configured vertex/edge caps fail-closed; the result carries counts and one
   * `graph-limit` diagnostic, never the graph itself.
   */
  dependencyGraph(paths?: readonly string[]): DependencyGraphSummary {
    const sources: DependencySource[] = []
    if (paths === undefined) {
      for (const [, parsed] of this.byPath) {
        if (parsed.path !== undefined) sources.push({ path: parsed.path, references: parsed.references })
      }
    } else {
      for (const path of paths) {
        const parsed = this.byPath.peek(path)
        if (parsed !== undefined && parsed.path !== undefined) {
          sources.push({ path: parsed.path, references: parsed.references })
        }
      }
    }
    const result = createDependencyGraph(sources, {
      maxVertices: this.maxGraphVertices,
      maxEdges: this.maxGraphEdges,
    })
    return {
      ...result.counts,
      truncated: result.truncated,
      diagnostics: result.diagnostics.slice(0, 10),
      limits: this.dependencyGraphLimits,
    }
  }

  /** Cache key: `path + mtime + size + parserId` (`docs/file-processing-v24.md` §7). */
  private cacheKey(input: { path: string; mtime: number; size: number; parserId: string }): string {
    return `${input.parserId}\u0000${input.path}\u0000${input.mtime}\u0000${input.size}`
  }

  private cacheGet(input: { path: string; mtime: number; size: number; parserId: string }): ParsedFile | undefined {
    const value = this.cache.get(this.cacheKey(input))
    if (value === undefined) this.misses += 1
    else this.hits += 1
    return value
  }

  private cacheSet(input: { path: string; mtime: number; size: number; parserId: string }, value: ParsedFile): void {
    const key = this.cacheKey(input)
    if (!this.cache.has(key) && this.cache.size >= this.cache.capacity) this.evictions += 1
    this.cache.set(key, value)
  }

  /**
   * Parse exactly one of `path` or `text`.
   *
   * A path is read from disk (≤1 MiB), charset-detected and parsed; an unknown
   * extension or `parserId` is an `InvalidArgumentError` and is never guessed.
   * A text input is parsed as given (no cache, since it has no file identity).
   */
  parse(request: ParseRequest): ParsedFile {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new InvalidArgumentError('parse request must be an object')
    }
    const hasPath = request.path !== undefined
    const hasText = request.text !== undefined
    if (hasPath === hasText) {
      throw new InvalidArgumentError('parse requires exactly one of path or text')
    }
    if (hasPath) {
      if (typeof request.path !== 'string' || request.path.length === 0) {
        throw new InvalidArgumentError('parse path must be a non-empty string')
      }
      return this.parseFromPath(request.path, request)
    }
    if (typeof request.text !== 'string') {
      throw new InvalidArgumentError('parse text must be a string')
    }
    return this.parseFromText(request.text, request)
  }

  /**
   * Normalise and validate a workspace-relative path. Throws
   * `InvalidArgumentError` for absolute paths, traversal and empty input.
   */
  relativePath(path: string): string {
    if (typeof path !== 'string' || path.length === 0) {
      throw new InvalidArgumentError('path must be a non-empty string')
    }
    const normalised = normaliseWorkspacePath(path)
    if (normalised === undefined) {
      throw new InvalidArgumentError(
        'path must be workspace-relative and must not escape the workspace',
        { path },
      )
    }
    return normalised
  }

  /** Resolve a workspace-relative path under the root; rejects escapes. */
  absolutePath(relative: string): string {
    const absolute = resolve(this.workspaceRoot, relative)
    const prefix = this.workspaceRoot.endsWith(sep) ? this.workspaceRoot : `${this.workspaceRoot}${sep}`
    if (absolute !== this.workspaceRoot && !absolute.startsWith(prefix)) {
      throw new InvalidArgumentError('path escapes the workspace root', { path: relative })
    }
    return absolute
  }

  /**
   * Read a bounded fragment of a workspace file. This is the **only** content
   * path in the plugin (backing `coordination_read`).
   *
   * Bytes mode: `start` inclusive, `end` exclusive, both charset byte offsets.
   * Lines mode: `start`/`end` 1-based inclusive decoded lines. Caps: 256 KiB,
   * 2,000 lines, 16,000 estimated tokens; overflow is explicit (`truncated`)
   * plus a continuation (`nextStart`/`nextLine`). NUL bytes, `binary`/`unknown`
   * charsets and undecodable UTF-8 refuse text reading.
   */
  readContent(request: ReadRequest): ReadResult {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new InvalidArgumentError('read request must be an object')
    }
    const relative = this.relativePath(request.path)
    const absolute = this.absoluteFilePath(relative)
    const stat = statSync(absolute)
    if (!stat.isFile()) throw new InvalidArgumentError('path is not a regular file', { path: relative })
    const size = stat.size
    const mtime = Math.trunc(stat.mtimeMs)
    if (request.mode !== 'bytes' && request.mode !== 'lines') {
      throw new InvalidArgumentError('read mode must be "bytes" or "lines"', { mode: request.mode })
    }
    const maxBytes = positiveOption(request.maxBytes, MAX_READ_BYTES, 'maxBytes')
    const maxLines = positiveOption(request.maxLines, MAX_READ_LINES, 'maxLines')
    const sniff = readRange(absolute, 0, Math.min(size, 8_192))
    if (containsNul(sniff)) {
      throw new InvalidStateError('file content is binary (NUL byte); text reading is refused', {
        path: relative,
      })
    }
    const bomBytes = hasUtf8Bom(sniff) ? 3 : 0
    const charset: Charset = bomBytes > 0 ? 'utf-8-bom' : isAllAscii(sniff) ? 'ascii' : 'utf-8'
    if (request.charset !== undefined && request.charset !== charset && !(charset === 'ascii' && request.charset === 'utf-8')) {
      throw new InvalidArgumentError('declared charset contradicts the detected charset', {
        path: relative,
        declared: request.charset,
        detected: charset,
      })
    }

    if (request.mode === 'bytes') {
      return this.readBytes(relative, absolute, size, mtime, charset, bomBytes, request, maxBytes)
    }
    return this.readLines(relative, absolute, size, mtime, charset, bomBytes, request, maxBytes, maxLines)
  }

  /* --------------------------------------------------------------------- *
   * Parsing internals
   * --------------------------------------------------------------------- */

  private parseFromPath(path: string, request: ParseRequest): ParsedFile {
    const relative = this.relativePath(path)
    const parser = defaultParserRegistry.resolve(relative, request.parserId)
    if (parser === undefined) {
      throw new InvalidArgumentError(
        'no P0 parser is registered for this path; pass a supported extension or parserId',
        { path: relative, ...(request.parserId === undefined ? {} : { parserId: request.parserId }) },
      )
    }
    const absolute = this.absoluteFilePath(relative)
    const stat = statSync(absolute)
    if (!stat.isFile()) throw new InvalidArgumentError('path is not a regular file', { path: relative })
    const size = stat.size
    const mtime = Math.trunc(stat.mtimeMs)
    const cacheInput = { path: relative, mtime, size, parserId: parser.id }
    const cached = this.cacheGet(cacheInput)
    if (cached !== undefined) {
      this.byPath.set(relative, cached)
      return { ...cached, cached: true }
    }

    const truncatedByBytes = size > this.maxFileBytes
    const buffer = readRange(absolute, 0, Math.min(size, this.maxFileBytes))
    const detection = detectFromBytes(buffer, request.charset)
    if (detection.binary || !isRangeCapableCharset(detection.charset)) {
      const parsed = this.metadataOnly(relative, size, mtime, detection.charset, detection.bomBytes, {
        reason: detection.reason ?? `charset "${detection.charset}" is not decoded in P0`,
        binary: detection.binary,
      })
      this.cacheSet(cacheInput, parsed)
      this.byPath.set(relative, parsed)
      return parsed
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      const parsed = this.metadataOnly(relative, size, mtime, 'unknown', detection.bomBytes, {
        reason: 'file is not valid UTF-8; metadata only',
        binary: false,
      })
      this.cacheSet(cacheInput, parsed)
      this.byPath.set(relative, parsed)
      return parsed
    }
    const result = parseFileText(relative, text, this.parseOptions(relative, request, {
      size,
      mtime,
      charset: detection.charset,
      bomBytes: detection.bomBytes,
    }))
    if (result === undefined) {
      throw new InvalidArgumentError('no P0 parser is registered for this path', { path: relative })
    }
    const parsed = this.build(relative, text, result, {
      size,
      mtime,
      charset: detection.charset,
      bomBytes: detection.bomBytes,
      truncatedByBytes,
    })
    this.cacheSet(cacheInput, parsed)
    this.byPath.set(relative, parsed)
    return parsed
  }

  private parseFromText(text: string, request: ParseRequest): ParsedFile {
    const result = parseText(text, {
      ...(request.parserId === undefined ? {} : { parserId: request.parserId }),
      maxTokens: this.maxTokens,
      maxDepth: this.maxAstDepth,
      timeoutMs: this.timeoutMs,
    })
    if (result === undefined) {
      throw new InvalidArgumentError(
        'no P0 parser was resolved for this text; pass a parsable path or a parserId',
        { ...(request.parserId === undefined ? {} : { parserId: request.parserId }) },
      )
    }
    const detection = detectFromBytes(Buffer.from(text, 'utf8'), request.charset)
    return this.build(undefined, text, result, {
      size: utf8ByteLength(text),
      charset: detection.charset,
      bomBytes: detection.bomBytes,
      truncatedByBytes: false,
    })
  }

  private parseOptions(
    path: string,
    request: ParseRequest,
    meta: { size: number; mtime: number; charset: Charset; bomBytes: number },
  ): ParseOptions {
    return {
      path,
      ...(request.parserId === undefined ? {} : { parserId: request.parserId }),
      maxTokens: this.maxTokens,
      maxDepth: this.maxAstDepth,
      timeoutMs: this.timeoutMs,
      size: meta.size,
      mtime: meta.mtime,
      charset: meta.charset,
      bomBytes: meta.bomBytes,
    }
  }

  /** Build the body-free `ParsedFile` from a generic parser result. */
  private build(
    path: string | undefined,
    text: string,
    result: ParseResult,
    meta: {
      size: number
      mtime?: number
      charset: Charset
      bomBytes: number
      truncatedByBytes: boolean
    },
  ): ParsedFile {
    const rawNodes = result.nodes ?? []
    const overflowNodes = rawNodes.length > this.maxNodes
    const nodes = overflowNodes ? rawNodes.slice(0, this.maxNodes) : rawNodes
    const truncated = result.truncated || meta.truncatedByBytes || overflowNodes
    const diagnostics = [...result.diagnostics]
    if (meta.truncatedByBytes) {
      diagnostics.push({
        code: 'text-limit',
        message: `file exceeds the ${this.maxFileBytes}-byte read cap; parsed the prefix`,
        severity: 'warning',
      })
    }
    if (overflowNodes) {
      diagnostics.push({
        code: 'node-limit',
        message: `node metadata limit ${this.maxNodes} reached; later nodes were dropped`,
        severity: 'warning',
      })
    }
    const bomOffset = text.startsWith('\uFEFF') ? 1 : 0
    const fragmentText = text.slice(bomOffset)
    const fingerprint = sha256Fingerprint(fragmentText)
    const lineCount = countLines(fragmentText)
    const kind = fileKind(path, result.parserId, result.document)
    const byteStart = meta.bomBytes
    // `TextDecoder` strips a UTF-8 BOM, so the decoded text starts after it; the
    // byte end is therefore BOM + fragment bytes, not the fragment bytes alone.
    const byteEnd = meta.bomBytes + utf8ByteLength(fragmentText)
    const fileReference = path === undefined
      ? undefined
      : createNodeReference({
          scheme: 'file',
          path,
          target: path,
          bytes: { start: byteStart, end: byteEnd },
          lines: { start: 1, end: lineCount },
          columns: { start: 1, end: 1 },
          hash: fingerprint,
          fileBytes: meta.size,
          ...(meta.mtime === undefined ? {} : { mtime: meta.mtime }),
          mediaType: mediaTypeOf(path),
          parserId: result.parserId,
          charset: meta.charset,
        })
    const file = createNodeMetadata({
      kind,
      ...(path === undefined ? {} : { name: basename(path) }),
      ...(fileReference === undefined ? {} : { reference: fileReference }),
      fragment: {
        ...(path === undefined ? {} : { path }),
        byteStart: path === undefined ? 0 : byteStart,
        byteEnd,
        lineStart: 1,
        lineEnd: lineCount,
        fingerprint,
        charset: meta.charset,
      },
      source: 'none',
      span: { start: 0, end: text.length, line: 1, column: 1 },
    })
    const status: NodeStatus = !isRangeCapableCharset(meta.charset)
      ? 'unverifiable'
      : truncated
        ? 'truncated'
        : 'parsed'
    const parsed: ParsedFile = {
      ...(path === undefined ? {} : { path }),
      parserId: result.parserId,
      charset: meta.charset,
      bomBytes: meta.bomBytes,
      truncated,
      tokens: result.tokens,
      size: meta.size,
      cached: false,
      status,
      ...(result.document === undefined ? {} : { document: result.document }),
      file,
      nodes,
      references: result.references,
      diagnostics,
      structure: extractStructure(result),
    }
    if (meta.mtime !== undefined) parsed.mtime = meta.mtime
    return parsed
  }

  /** Metadata-only result for binary/unknown/non-UTF-8 content. */
  private metadataOnly(
    path: string,
    size: number,
    mtime: number,
    charset: Charset,
    bomBytes: number,
    detail: { reason: string; binary: boolean },
  ): ParsedFile {
    const byteEnd = Math.min(size, this.maxFileBytes)
    const buffer = readRange(this.absoluteFilePath(path), 0, byteEnd)
    const fingerprint = fingerprintBytes(buffer)
    const reference = createNodeReference({
      scheme: 'file',
      path,
      target: path,
      bytes: { start: bomBytes, end: Math.max(bomBytes, byteEnd) },
      hash: fingerprint,
      fileBytes: size,
      mtime,
      mediaType: mediaTypeOf(path),
      parserId: 'none',
      charset,
    })
    const file = createNodeMetadata({
      kind: fileKind(path, 'none', undefined),
      name: basename(path),
      reference,
      fragment: {
        path,
        byteStart: bomBytes,
        byteEnd: Math.max(bomBytes, byteEnd),
        fingerprint,
        charset,
      },
      source: 'none',
      span: { start: 0, end: 0, line: 1, column: 1 },
    })
    return {
      path,
      parserId: 'none',
      charset,
      bomBytes,
      truncated: size > this.maxFileBytes,
      tokens: 0,
      size,
      mtime,
      cached: false,
      status: 'unverifiable',
      file,
      nodes: [],
      references: [],
      diagnostics: [
        {
          code: 'unverifiable',
          message: `${detail.reason}; metadata only (no text parse)`,
          severity: 'warning',
        },
      ],
      structure: emptyStructure(),
    }
  }

  /* --------------------------------------------------------------------- *
   * Read internals
   * --------------------------------------------------------------------- */

  private readBytes(
    path: string,
    absolute: string,
    size: number,
    mtime: number,
    charset: Charset,
    bomBytes: number,
    request: ReadRequest,
    maxBytes: number,
  ): ReadResult {
    const start = integerField(request.start, 'start', 0)
    const end = request.end === undefined ? size : integerField(request.end, 'end', start)
    if (end < start) throw new InvalidArgumentError('byte end must be greater than or equal to start', { start, end })
    if (start < bomBytes) {
      throw new InvalidArgumentError('byte range must start after the BOM', { start, bomBytes })
    }
    const requestedEnd = Math.min(end, size)
    const cappedEnd = Math.min(requestedEnd, start + maxBytes)
    const buffer = readRange(absolute, start, cappedEnd - start)
    if (containsNul(buffer)) {
      throw new InvalidStateError('file content is binary (NUL byte); text reading is refused', { path })
    }
    const decoded = decodeUtf8(buffer, path)
    const tokenCapped = capToTokens(decoded, MAX_READ_TOKENS)
    const keptBytes = tokenCapped.truncated ? Buffer.byteLength(tokenCapped.content, 'utf8') : buffer.length
    const returnedEnd = start + keptBytes
    const truncated = tokenCapped.truncated || cappedEnd < requestedEnd || requestedEnd < end
    const result: ReadResult = {
      path,
      mode: 'bytes',
      requested: { start, end },
      returned: { start, end: returnedEnd },
      content: tokenCapped.content,
      truncated,
      charset,
      bom: bomBytes > 0,
      bomBytes,
      hash: sha256Bytes(buffer.subarray(0, keptBytes)),
      fileBytes: size,
      mtime,
      byteRange: { start, end: returnedEnd },
    }
    if (truncated) result.nextStart = returnedEnd
    return result
  }

  private readLines(
    path: string,
    absolute: string,
    size: number,
    mtime: number,
    charset: Charset,
    bomBytes: number,
    request: ReadRequest,
    maxBytes: number,
    maxLines: number,
  ): ReadResult {
    const start = integerField(request.start, 'start', 1)
    if (start < 1) throw new InvalidArgumentError('line start must be >= 1', { start })
    const end = request.end === undefined ? start : integerField(request.end, 'end', start)
    if (end < start) throw new InvalidArgumentError('line end must be greater than or equal to start', { start, end })
    if (size > MAX_LINE_SCAN_BYTES) {
      throw new InvalidArgumentError(
        `line mode is limited to files up to ${MAX_LINE_SCAN_BYTES} bytes; use bytes mode`,
        { path, fileBytes: size, limit: MAX_LINE_SCAN_BYTES },
      )
    }
    const buffer = readFileSync(absolute)
    if (containsNul(buffer)) {
      throw new InvalidStateError('file content is binary (NUL byte); text reading is refused', { path })
    }
    const text = decodeUtf8(buffer, path)
    const starts = lineStarts(text, end)
    if (start > starts.length) {
      throw new InvalidArgumentError('start line is beyond the end of the file', {
        path,
        start,
        lines: starts.length,
      })
    }
    // `TextDecoder` strips a UTF-8 BOM, so the decoded text/line offsets start
    // after it; the absolute byte offset adds `bomBytes` back (BOM excluded from
    // every fragment/read range, per the domain model).
    const charStart = start === 1 ? 0 : starts[start - 1]
    const lastLine = Math.min(end, starts.length, start + maxLines - 1)
    const charEnd = lastLine < starts.length ? starts[lastLine] : text.length
    let content = text.slice(charStart, charEnd)
    let truncatedByLines = lastLine < end
    let truncatedByBytes = false
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      content = clipToBytes(content, maxBytes)
      truncatedByBytes = true
    }
    const tokenCapped = capToTokens(content, MAX_READ_TOKENS)
    content = tokenCapped.content
    const keptBytes = Buffer.byteLength(content, 'utf8')
    const byteStart = bomBytes + Buffer.byteLength(text.slice(0, charStart), 'utf8')
    const byteEnd = byteStart + keptBytes
    const truncated = truncatedByLines || truncatedByBytes || tokenCapped.truncated
    const result: ReadResult = {
      path,
      mode: 'lines',
      requested: { start, end },
      returned: { start, end: lastLine },
      content,
      truncated,
      charset,
      bom: bomBytes > 0,
      bomBytes,
      hash: sha256Bytes(Buffer.from(content, 'utf8')),
      fileBytes: size,
      mtime,
      byteRange: { start: byteStart, end: byteEnd },
      lineRange: { start, end: lastLine },
    }
    if (truncatedByLines) result.nextLine = lastLine + 1
    if ((truncatedByBytes || tokenCapped.truncated) && !truncatedByLines) result.nextLine = lastLine + 1
    return result
  }

  /** Resolve a file path, rejecting symlinks that escape the workspace. */
  private absoluteFilePath(relative: string): string {
    const absolute = this.absolutePath(relative)
    let real: string
    try {
      real = realpathSync(absolute)
    } catch {
      throw new NotFoundError('file', relative)
    }
    this.realRoot ??= realpathSync(this.workspaceRoot)
    const prefix = this.realRoot.endsWith(sep) ? this.realRoot : `${this.realRoot}${sep}`
    if (real !== this.realRoot && !real.startsWith(prefix)) {
      throw new InvalidArgumentError('path resolves outside the workspace root', { path: relative })
    }
    return real
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

/**
 * Project one parser reference for the model: specifier, span and the lexical
 * resolution (no filesystem probe, no bytes). External, fragment and unresolved
 * specifiers carry no `resolved` path.
 */
export function viewReference(reference: FileReference, importerPath?: string): ReferenceView {
  const classification = classifySpecifier(reference.specifier)
  const resolved = reference.external || classification === 'fragment'
    ? undefined
    : resolveSpecifier(reference.specifier, importerPath)
  const view: ReferenceView = {
    kind: reference.kind,
    specifier: reference.specifier,
    external: reference.external,
    typeOnly: reference.typeOnly === true,
    classification,
  }
  if (resolved !== undefined) view.resolved = resolved
  if (reference.byteStart !== undefined) view.byteStart = reference.byteStart
  if (reference.byteEnd !== undefined) view.byteEnd = reference.byteEnd
  if (reference.lineStart !== undefined) view.lineStart = reference.lineStart
  if (reference.lineEnd !== undefined) view.lineEnd = reference.lineEnd
  return view
}

interface DetectionFromBytes {
  charset: Charset
  bomBytes: number
  binary: boolean
  reason?: string
}

/** BOM-first detection over raw bytes; no transcoding beyond UTF-8. */
function detectFromBytes(bytes: Uint8Array, declared: Charset | undefined): DetectionFromBytes {
  if (declared !== undefined) {
    const allowed: ReadonlySet<Charset> = new Set<Charset>([
      'utf-8', 'utf-8-bom', 'ascii', 'utf-16le', 'utf-16be', 'utf-16le-bom', 'utf-16be-bom',
      'utf-32le', 'utf-32be', 'utf-32le-bom', 'utf-32be-bom', 'latin1', 'windows-1252',
      'gb18030', 'gbk', 'big5', 'shift-jis', 'euc-kr', 'binary', 'unknown',
    ])
    if (!allowed.has(declared)) {
      throw new InvalidArgumentError('unknown declared charset', { charset: declared })
    }
  }
  const bom = detectBomBytes(bytes)
  if (bom !== undefined) {
    if (declared !== undefined && declared !== bom.charset && declared !== 'utf-8') {
      throw new InvalidArgumentError('declared charset contradicts the BOM', {
        declared,
        detected: bom.charset,
      })
    }
    return { charset: bom.charset, bomBytes: bom.bytes, binary: false }
  }
  if (declared !== undefined) {
    return {
      charset: declared,
      bomBytes: 0,
      binary: declared === 'binary',
      ...(isRangeCapableCharset(declared) ? {} : { reason: `declared charset "${declared}" is not decoded in P0` }),
    }
  }
  if (containsNul(bytes)) {
    return { charset: 'binary', bomBytes: 0, binary: true, reason: 'NUL byte in file content' }
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { charset: 'unknown', bomBytes: 0, binary: false, reason: 'file is not valid UTF-8' }
  }
  return { charset: isAllAscii(bytes) ? 'ascii' : 'utf-8', bomBytes: 0, binary: false }
}

function detectBomBytes(bytes: Uint8Array): { charset: Charset; bytes: number } | undefined {
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

/** Parser-specific result fields this layer reads; everything else is ignored. */
interface StructuredResult {
  headings?: ReadonlyArray<{ level: number; title: string; span: SourceSpan }>
  statements?: ReadonlyArray<{ kind: string; label?: string; proofTarget?: string; span: SourceSpan }>
  divs?: ReadonlyArray<{ name: string; depth: number; span: SourceSpan }>
  formulas?: ReadonlyArray<{
    span: SourceSpan
    name?: string
    references: ReadonlyArray<{ kind: string; start: string }>
  }>
  frontMatter?: ReadonlyArray<{ key: string; value: string }>
}

function extractStructure(result: ParseResult): ParsedStructure {
  const extended = result as ParseResult & StructuredResult
  const structure = emptyStructure()
  for (const heading of (extended.headings ?? []).slice(0, MAX_STRUCTURE_ITEMS)) {
    structure.headings.push({ level: heading.level, title: heading.title, spanStart: heading.span.start })
  }
  for (const statement of (extended.statements ?? []).slice(0, MAX_STRUCTURE_ITEMS)) {
    structure.statements.push({
      kind: statement.kind,
      ...(statement.label === undefined ? {} : { label: statement.label }),
      ...(statement.proofTarget === undefined ? {} : { proofTarget: statement.proofTarget }),
      spanStart: statement.span.start,
    })
  }
  for (const div of (extended.divs ?? []).slice(0, MAX_STRUCTURE_ITEMS)) {
    structure.divs.push({ name: div.name, depth: div.depth, spanStart: div.span.start })
  }
  for (const formula of extended.formulas ?? []) {
    for (const reference of formula.references) {
      if (structure.formulaReferences.length >= MAX_STRUCTURE_FORMULA_REFERENCES) break
      if (reference.kind !== 'symbol' && reference.kind !== 'label' && reference.kind !== 'equation') continue
      structure.formulaReferences.push({
        kind: reference.kind,
        target: reference.start,
        formulaSpanStart: formula.span.start,
      })
    }
  }
  for (const entry of extended.frontMatter ?? []) {
    if (Object.prototype.hasOwnProperty.call(structure.frontMatter, entry.key)) continue
    structure.frontMatter[entry.key] = entry.value
  }
  return structure
}

function emptyStructure(): ParsedStructure {
  return { headings: [], statements: [], divs: [], formulaReferences: [], frontMatter: {} }
}

function fileKind(path: string | undefined, parserId: string, document: DocumentMetadata | undefined): string {
  if (parserId === 'javascript') return 'module'
  if (document?.form === 'book') return 'book'
  if (document?.form === 'article') return 'article'
  if (path === undefined) return 'document'
  return 'document'
}

function mediaTypeOf(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  const media: Readonly<Record<string, string>> = {
    '.js': 'text/javascript',
    '.jsx': 'text/jsx',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/tsx',
    '.css': 'text/css',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.tex': 'text/x-tex',
  }
  return media[extension]
}

/** Number of decoded lines (LF/CRLF/CR each count once). */
function countLines(text: string): number {
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 13) {
      if (text.charCodeAt(index + 1) !== 10) lines += 1
    } else if (code === 10) {
      lines += 1
    }
  }
  return lines
}

/**
 * 1-based char offsets of line starts, up to and including `limit` lines; the
 * returned array also holds the start of the line after the last one found, so
 * `starts[line - 1]` is a line start and `starts[line]` is its end.
 */
function lineStarts(text: string, limit: number): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1
      starts.push(index + 1)
    } else if (code === 10) {
      starts.push(index + 1)
    }
    if (starts.length > limit + 1) break
  }
  return starts
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

function containsNul(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte === 0) return true
  return false
}

function isAllAscii(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte > 0x7f) return false
  return true
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new InvalidStateError('file content is not valid UTF-8; text reading is refused', { path })
  }
}

/** Clip decoded text to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function clipToBytes(text: string, maxBytes: number): string {
  let bytes = 0
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    let width = 1
    let units = 1
    if (code < 0x80) width = 1
    else if (code < 0x800) width = 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        width = 4
        units = 2
      } else {
        width = 3
      }
    } else width = 3
    if (bytes + width > maxBytes) break
    bytes += width
    index += units
  }
  return text.slice(0, index)
}

/** Clip decoded text to a token budget (~16k tokens) without splitting a surrogate pair. */
function capToTokens(content: string, maxTokens: number): { content: string; truncated: boolean } {
  if (content.length === 0) return { content, truncated: false }
  const estimated = estimateTokens(content)
  if (estimated <= maxTokens) return { content, truncated: false }
  let cut = Math.max(0, Math.floor((content.length * maxTokens) / estimated))
  cut = Math.floor(cut * 0.95)
  while (cut > 0 && estimateTokens(content.slice(0, cut)) > maxTokens) {
    cut = Math.floor(cut * 0.9)
  }
  if (cut > 0 && cut < content.length && isHighSurrogate(content.charCodeAt(cut - 1))) cut -= 1
  return { content: content.slice(0, cut), truncated: true }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function integerField(value: unknown, name: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new InvalidArgumentError(`${name} must be an integer >= ${minimum}`, { [name]: value })
  }
  return value
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidArgumentError(`${name} must be a positive integer`, { [name]: value })
  }
  return Math.min(value, fallback)
}

/** Read exactly `length` bytes at `offset`; never reads past EOF. */
function readRange(absolute: string, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0)
  const fd = openSync(absolute, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, offset + read)
      if (count <= 0) break
      read += count
    }
    return read === length ? buffer : buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function fingerprintBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function sha256Bytes(bytes: Uint8Array): string {
  return fingerprintBytes(bytes)
}
