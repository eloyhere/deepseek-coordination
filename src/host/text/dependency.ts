/**
 * Dependency graph construction for parsed references.
 *
 * Purely lexical, no filesystem access: a relative specifier is resolved
 * against its importer's directory with `.`/`..`/separator normalisation only —
 * never by probing files and never by guessing extensions. Bare specifiers,
 * URLs, `data:` payloads and `#` fragments are external and produce no edge.
 *
 * `DirectedGraph` (shared) supplies Kahn ordering, cycle detection and levels;
 * this module only normalises, filters and bounds the input.
 *
 * Bounds (`docs/domain-model-v24.md` §7): 20,000 vertices and 100,000 edges,
 * fail-closed. On overflow the graph keeps the prefix, sets `truncated`, records
 * one `graph-limit` diagnostic and stops adding vertices/edges; no partial
 * transitive answer is implied.
 *
 * Complexity: `O(V + E)` for `createDependencyGraph` (each reference is O(1) map
 * work plus O(path length) normalisation), `O(V + E)` for ordering/levels/cycle.
 */
import { DirectedGraph } from '../../shared/graph.js'
import { InvalidArgumentError } from '../../shared/error.js'
import { isExternalSpecifier } from './parser.js'
import type { Diagnostic, FileReference, ReferenceKind } from './parser.js'

/** Hard graph vertex cap. */
export const MAX_GRAPH_VERTICES = 20_000
/** Hard graph edge cap. */
export const MAX_GRAPH_EDGES = 100_000

/** One parsed file and its references. */
export interface DependencySource {
  path: string
  references: readonly FileReference[]
}

/** One resolved edge, with the first specifier that produced it. */
export interface DependencyEdgeInfo {
  from: string
  to: string
  specifier: string
  kind: ReferenceKind
  typeOnly: boolean
}

/** One external reference (bare package, URL, data:, fragment). */
export interface ExternalDependency {
  from: string
  specifier: string
  kind: ReferenceKind
  typeOnly: boolean
}

/** One relative reference that could not be resolved to a workspace path. */
export interface UnresolvedDependency {
  from: string
  specifier: string
  kind: ReferenceKind
  reason: string
}

/** Aggregate graph counts. */
export interface DependencyCounts {
  files: number
  references: number
  edges: number
  external: number
  unresolved: number
  vertices: number
  graphEdges: number
  isolated: number
}

/** Result of `createDependencyGraph`. */
export interface DependencyGraphResult {
  graph: DirectedGraph<string>
  edges: DependencyEdgeInfo[]
  external: ExternalDependency[]
  unresolved: UnresolvedDependency[]
  counts: DependencyCounts
  diagnostics: Diagnostic[]
  truncated: boolean
}

/** Options for `createDependencyGraph`; values can only lower the hard caps. */
export interface DependencyGraphOptions {
  maxVertices?: number
  maxEdges?: number
  includeTypeOnly?: boolean
}

/** Result of `topologicalOrder`. `order` is null exactly when `cycle` is set. */
export interface TopologicalOrderResult {
  order: string[] | null
  cycle: string[] | null
}

/** Result of `dependencyLevels`. `levels` is null exactly when `cycle` is set. */
export interface DependencyLevelsResult {
  levels: Map<string, number> | null
  cycle: string[] | null
}

/**
 * Normalise a local path lexically: `\` → `/`, collapse `.`/`..`, keep an
 * absolute root or Windows drive, keep leading `..` for a relative path.
 * Returns `.` for an empty relative path.
 *
 * Time O(path length), space O(segments).
 */
export function normalizePath(path: string): string {
  if (typeof path !== 'string') {
    throw new InvalidArgumentError('path must be a string', { type: typeof path })
  }
  const value = path.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(value)
  const absolute = drive !== null || value.startsWith('/')
  const prefix = drive === null ? (absolute ? '/' : '') : `${drive[0]}/`
  const rest = drive === null ? value : value.slice(drive[0].length)
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
      else if (!absolute) segments.push('..')
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join('/')
  if (prefix === '') return joined.length === 0 ? '.' : joined
  return joined.length === 0 ? prefix : `${prefix}${joined}`
}

/** Directory part of a normalised path (`''` when there is none). */
function directoryOf(path: string): string {
  const normalised = normalizePath(path)
  const slash = normalised.lastIndexOf('/')
  return slash < 0 ? '' : normalised.slice(0, slash)
}

/**
 * Resolve a reference specifier against an importer path, lexically.
 *
 * External specifiers return `undefined` (no local edge). An absolute local
 * path is normalised as-is. A relative path joins the importer directory.
 * Without an importer, a relative path is normalised against the workspace root.
 *
 * Time O(specifier + importer length).
 */
export function resolveSpecifier(specifier: string, importerPath?: string): string | undefined {
  if (typeof specifier !== 'string' || specifier.length === 0) return undefined
  if (isExternalSpecifier(specifier)) return undefined
  const value = specifier.trim()
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return normalizePath(value)
  const base = importerPath === undefined ? '' : directoryOf(importerPath)
  const joined = base.length === 0 ? value : `${base}/${value}`
  const normalised = normalizePath(joined)
  // A relative resolution that climbs above the workspace root is unresolvable.
  if (normalised === '..' || normalised.startsWith('../')) return undefined
  return normalised
}

/**
 * Build a bounded dependency graph from parsed references.
 *
 * Time O(V + E + total path length), space O(V + E). Fail-closed at the vertex
 * and edge caps; never touches the filesystem.
 */
export function createDependencyGraph(
  sources: Iterable<DependencySource>,
  options: DependencyGraphOptions = {},
): DependencyGraphResult {
  const maxVertices = capOption(options.maxVertices, MAX_GRAPH_VERTICES, 'maxVertices')
  const maxEdges = capOption(options.maxEdges, MAX_GRAPH_EDGES, 'maxEdges')
  const includeTypeOnly = options.includeTypeOnly !== false
  const graph = new DirectedGraph<string>()
  const edges: DependencyEdgeInfo[] = []
  const external: ExternalDependency[] = []
  const unresolved: UnresolvedDependency[] = []
  const diagnostics: Diagnostic[] = []
  let truncated = false
  let files = 0
  let referenceCount = 0
  let limitReported = false

  const failLimit = (message: string): void => {
    truncated = true
    if (limitReported) return
    limitReported = true
    diagnostics.push({ code: 'graph-limit', message, severity: 'warning' })
  }

  for (const source of sources) {
    const from = normalizePath(source.path)
    files += 1
    if (!graph.hasVertex(from)) {
      if (graph.vertexCount >= maxVertices) {
        failLimit(`dependency graph vertex limit ${maxVertices} reached; later files were dropped`)
        break
      }
      graph.addVertex(from)
    }
    for (const reference of source.references) {
      referenceCount += 1
      if (!includeTypeOnly && reference.typeOnly === true) continue
      if (reference.external) {
        external.push({
          from,
          specifier: reference.specifier,
          kind: reference.kind,
          typeOnly: reference.typeOnly === true,
        })
        continue
      }
      const target = resolveSpecifier(reference.specifier, from)
      if (target === undefined) {
        unresolved.push({
          from,
          specifier: reference.specifier,
          kind: reference.kind,
          reason: 'relative specifier escapes the workspace or is empty',
        })
        continue
      }
      if (!graph.hasVertex(target) && graph.vertexCount >= maxVertices) {
        failLimit(`dependency graph vertex limit ${maxVertices} reached; later targets were dropped`)
        break
      }
      if (graph.edgeCount >= maxEdges) {
        failLimit(`dependency graph edge limit ${maxEdges} reached; later edges were dropped`)
        break
      }
      const added = graph.addEdge(from, target)
      if (added) {
        edges.push({
          from,
          to: target,
          specifier: reference.specifier,
          kind: reference.kind,
          typeOnly: reference.typeOnly === true,
        })
      }
    }
    if (truncated) break
  }

  const counts: DependencyCounts = {
    files,
    references: referenceCount,
    edges: edges.length,
    external: external.length,
    unresolved: unresolved.length,
    vertices: graph.vertexCount,
    graphEdges: graph.edgeCount,
    isolated: isolatedVertices(graph).length,
  }
  return { graph, edges, external, unresolved, counts, diagnostics, truncated }
}

/**
 * Kahn topological order. Returns `{order:null, cycle:[...]}` on a cycle; a
 * cycle is a legal result, never an exception and never retried.
 *
 * Time O(V + E), space O(V).
 */
export function topologicalOrder(graph: DirectedGraph<string>): TopologicalOrderResult {
  const order = graph.topologicalSort()
  if (order !== null) return { order, cycle: null }
  return { order: null, cycle: graph.findCycle() ?? [] }
}

/**
 * Longest-path dependency levels (sources are level 0). Returns null levels plus
 * the cycle path when the graph has a cycle.
 *
 * Time O(V + E), space O(V).
 */
export function dependencyLevels(graph: DirectedGraph<string>): DependencyLevelsResult {
  const levels = graph.dependencyLevels()
  if (levels !== null) return { levels, cycle: null }
  return { levels: null, cycle: graph.findCycle() ?? [] }
}

/**
 * Vertices with no incoming and no outgoing edges. Time O(V + E).
 */
export function isolatedVertices(graph: DirectedGraph<string>): string[] {
  const isolated: string[] = []
  for (const vertex of graph.vertices()) {
    if (graph.inDegree(vertex) === 0 && graph.outDegree(vertex) === 0) isolated.push(vertex)
  }
  return isolated
}

/**
 * Graph counts for digests: vertices, edges, sources, sinks, isolated.
 * Time O(V + E).
 */
export function graphCounts(graph: DirectedGraph<string>): {
  vertices: number
  edges: number
  sources: number
  sinks: number
  isolated: number
} {
  let sources = 0
  let sinks = 0
  let isolated = 0
  for (const vertex of graph.vertices()) {
    const incoming = graph.inDegree(vertex)
    const outgoing = graph.outDegree(vertex)
    if (incoming === 0) sources += 1
    if (outgoing === 0) sinks += 1
    if (incoming === 0 && outgoing === 0) isolated += 1
  }
  return { vertices: graph.vertexCount, edges: graph.edgeCount, sources, sinks, isolated }
}

function capOption(value: number | undefined, hardCap: number, name: string): number {
  if (value === undefined) return hardCap
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidArgumentError(`${name} must be a positive integer`, { [name]: value })
  }
  return Math.min(value, hardCap)
}
