/**
 * Public entry points for the P0 text/dependency layer.
 *
 * The layer is pure: `parseText`/`parseFileText` take text, never read a file.
 * `buildDependencyGraph` composes the two into a bounded `DirectedGraph` of
 * workspace paths. Everything is deterministic for the same
 * `(path, text, options)` tuple, so a host can re-run `refreshFileText` after an
 * edit and compare byte ranges/fingerprints instead of patching them.
 *
 * Nothing here is imported by the plugin entry point yet; the file layer and
 * the domain store will call these APIs in a later phase.
 */
import { CssParser, DelimitedParser, HtmlParser, MarkdownParser } from './markup.js'
import { JavaScriptParser } from './javascript.js'
import { LatexParser } from './tex.js'
import { PythonParser } from './python.js'
import { JavaParser } from './java.js'
import { RustParser } from './rust.js'
import { PhpParser } from './php.js'
import { CFamilyParser } from './c-family.js'
import { BookParser } from './book.js'
import { ParserRegistry, extensionOf } from './parser.js'
import type { NodeMetadata, ParseOptions, ParseResult, Parser } from './parser.js'
import { createDependencyGraph } from './dependency.js'
import type {
  DependencyCounts,
  DependencyEdgeInfo,
  DependencyGraphOptions,
  DependencyGraphResult,
  DependencySource,
  ExternalDependency,
  UnresolvedDependency,
} from './dependency.js'

/**
 * Parser instances registered by `createParserRegistry` by default.
 *
 * The list is the text-layer registration point: every extension-selected
 * language parser lives here. `BookParser` also claims the exact `SUMMARY.md` /
 * `SUMMARY.txt` file names, and the registry consults file names before
 * extensions, so a book table of contents resolves to `book` while `README.md`
 * stays Markdown.
 *
 * Binary parsers are deliberately absent: `OfficeParser` needs raw bytes and is
 * registered by the host file layer (`parse-service.ts`), which owns the bounded
 * binary read path.
 */
export const builtinParsers: readonly Parser[] = [
  new JavaScriptParser(),
  new CssParser(),
  new HtmlParser(),
  new MarkdownParser(),
  new LatexParser(),
  new DelimitedParser(),
  new PythonParser(),
  new JavaParser(),
  new RustParser(),
  new PhpParser(),
  new CFamilyParser(),
  new BookParser(),
]

/** Build a registry; pass a custom list to override the P0 set. */
export function createParserRegistry(parsers: readonly Parser[] = builtinParsers): ParserRegistry {
  const registry = new ParserRegistry()
  for (const parser of parsers) registry.register(parser)
  return registry
}

/** Process-wide registry used by `parseText`/`parseFileText`. */
export const defaultParserRegistry: ParserRegistry = createParserRegistry()

/**
 * Parse text, selecting the parser by `options.path` extension first, then by
 * `options.parserId`. Unknown extensions return `undefined` — the layer never
 * guesses a language. Time O(n) in the source length.
 */
export function parseText(text: string, options: ParseOptions = {}): ParseResult | undefined {
  const parser = defaultParserRegistry.resolve(options.path, options.parserId)
  if (parser === undefined) return undefined
  return parser.parse(text, options)
}

/**
 * Parse one file's text. This is the file-layer entry point: it takes the path
 * and already-decoded text and does not touch the filesystem. Returns
 * `undefined` for an unknown extension.
 */
export function parseFileText(path: string, text: string, options: ParseOptions = {}): ParseResult | undefined {
  const extension = extensionOf(path)
  const parser = defaultParserRegistry.resolve(path, options.parserId)
  if (parser === undefined) return undefined
  void extension
  return parser.parse(text, { ...options, path })
}

/**
 * Re-parse a whole file after an edit. Deliberately a full deterministic parse:
 * ranges and SHA-256 fingerprints are recomputed for every node instead of being
 * patched, so an edit inside/outside a fragment cannot leave stale coordinates.
 * A host compares the new metadata with the previous parse to find changed
 * fragments.
 */
export function refreshFileText(path: string, text: string, options: ParseOptions = {}): ParseResult | undefined {
  return parseFileText(path, text, options)
}

/**
 * Parser nodes that carry explicit structural/domain metadata
 * (`NodeMetadata.domain`, see `docs/domain-extraction-v24.md`).
 *
 * This is the projection seam for the file layer: `ParseService.build()` should
 * append these nodes to `ParsedFile.nodes` (they are already `NodeMetadata`, so
 * `NodeRegistry.register` and `ChainEngine.index` accept them unchanged) and
 * expose `domain.kind`/`domain.locator`/`partOf`/`contains` on the card/facts
 * types. No body text is involved.
 */
export function domainNodesOf(result: ParseResult): NodeMetadata[] {
  return (result.nodes ?? []).filter((node) => node.domain !== undefined)
}

/** One file handed to `buildDependencyGraph`. */export interface TextFile {
  path: string
  text: string
  /** File size in bytes, when the file layer knows it. */
  size?: number
  /** File mtime in milliseconds, for downstream cache invalidation. */
  mtime?: number
  /** Detected/declared charset, forwarded to the parser. */
  charset?: ParseOptions['charset']
}

/**
 * Parse every file and build the bounded dependency graph.
 *
 * Resolution is lexical (`./`, `../`, separators) and external specifiers are
 * filtered; the filesystem is never consulted. Graph overflow is fail-closed
 * (`truncated`, `graph-limit` diagnostic). Parser diagnostics are aggregated with
 * a `path: ` prefix, capped by the parser's own diagnostic budget.
 */
export function buildDependencyGraph(
  files: Iterable<TextFile>,
  options: DependencyGraphOptions = {},
): DependencyGraphResult {
  const sources: DependencySource[] = []
  const parseDiagnostics: DependencyGraphResult['diagnostics'] = []
  for (const file of files) {
    const result = parseFileText(file.path, file.text, {
      ...(file.size === undefined ? {} : { size: file.size }),
      ...(file.mtime === undefined ? {} : { mtime: file.mtime }),
      ...(file.charset === undefined ? {} : { charset: file.charset }),
    })
    sources.push({ path: file.path, references: result?.references ?? [] })
    if (result === undefined) continue
    for (const diagnostic of result.diagnostics) {
      if (parseDiagnostics.length >= 100) break
      parseDiagnostics.push({
        ...diagnostic,
        message: `${file.path}: ${diagnostic.message}`,
      })
    }
  }
  const graphResult = createDependencyGraph(sources, options)
  return {
    ...graphResult,
    diagnostics: [...parseDiagnostics.slice(0, 100), ...graphResult.diagnostics],
  }
}

export * from './parser.js'
export * from './tokenizer.js'
export * from './formula.js'
export * from './javascript.js'
export * from './markup.js'
export * from './tex.js'
export * from './dependency.js'
export * from './cache.js'

export type {
  DependencyCounts,
  DependencyEdgeInfo,
  ExternalDependency,
  UnresolvedDependency,
  DependencyGraphOptions,
  DependencySource,
}
