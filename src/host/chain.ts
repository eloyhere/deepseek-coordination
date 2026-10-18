/**
 * Host-only Chain projection engine (v24 §3, §4, §7; "chain.ts" in
 * `docs/complexity-audit-v24.md` §9).
 *
 * A `Chain` is a **derived, read-only projection**: rooted at one public handle,
 * bounded in depth (≤ 8), link count (≤ 50) and size (~1,500 tokens), with
 * explicit `truncated` and an explicit `cycle` path when one exists. It is never
 * persisted as truth, never contains an AST, an adjacency map, a database row or
 * a file body: only `ChainLink` values with handle/relation/status/depth and,
 * when the budget allows, a compact locator (`path` + one range + fingerprint).
 *
 * # Edges this engine can build by itself (from parser metadata only)
 *
 * | Source (parser output) | Edge |
 * |---|---|
 * | file references (`import`/`require`/`export-from`/CSS/HTML/Markdown/TeX input) resolved lexically | `depends` (the projection of `imports`, §3) |
 * | heading levels (Markdown/HTML) | `contains` parent→child, `part_of` child→parent |
 * | every parsed node under its file node | `contains` file→node, `part_of` node→file |
 * | TeX `\begin{proof}` + explicit `\ref` target | `proves` |
 * | Markdown fenced div `::: require` / `::: meet` | `requires` (file→condition), `meets` (condition→file) |
 * | formula label/equation/symbol reference matching a node name/label | `references` |
 *
 * Everything else (`satisfies`, `baseline`, `prerequisite`, and host-asserted
 * `requires`/`meets`) comes from {@link ChainEngine.relate}: per the domain
 * model, only a host/verifier may write satisfaction or pin a baseline. The
 * agent may *ask* for a chain; it can never assert an edge.
 *
 * # Query surface
 *
 * `dependenciesOf` / `dependentsOf` / `satisfiesOf` / `satisfiedBy` /
 * `baselineOf` / `prerequisitesOf` / `unmet` / `path` / `cycle`. Every result is
 * a {@link ChainProjection}. `depends_on` is accepted as an alias of the
 * canonical relation name `depends` (the domain model forbids underscores).
 *
 * # Cache
 *
 * Projections are cached in a `LruList` keyed by
 * `(graphVersion, action, root, relationSet, depth, limit, target)`. The domain
 * model specifies `(root, relationSet, depth, graphVersion)`; `action`, `limit`
 * and `target` are added because they change the value (otherwise a `path`
 * answer could be served for a `dependencies` query). `graphVersion` is this
 * engine's monotonic counter, incremented on every index/relate. It is still the
 * projection-cache key rather than a database `MAX(identity)`, because a
 * rehydrated engine must not re-read the edge table on every query; the persisted
 * edge rows are read once at startup (`hydrate`) and written incrementally by the
 * optional persistence sink.
 *
 * Graphs are `DirectedGraph<string>` (shared) per relation, so cycle detection
 * and traversal use the frozen library. Complexity: `index` O(nodes + edges) for
 * one file; a query is O(V + E) bounded by depth/links/tokens; a cache hit is
 * O(1). Node and edge totals are fail-closed at 50,000/200,000 (domain §7).
 */
import { DirectedGraph } from '../shared/graph.js'
import { LruList } from '../shared/lru.js'
import { InvalidArgumentError, NotFoundError } from '../shared/error.js'
import { estimateTokens } from './token.js'
import { resolveSpecifier } from './text/dependency.js'
import { fileHandleFor, nodeHandleFor, nodeKeyOf } from './node-registry.js'
import type { ParsedFile } from './parse-service.js'

/* ------------------------------------------------------------------------- *
 * Budgets and vocabulary
 * ------------------------------------------------------------------------- */

/** Maximum traversal depth for every query. */
export const MAX_CHAIN_DEPTH = 8
/** Maximum links in one projection. */
export const MAX_CHAIN_LINKS = 50
/** Soft token budget for one projection (estimated over the links). */
export const MAX_CHAIN_TOKENS = 1_500
/** Default projection-cache capacity. */
export const DEFAULT_CHAIN_CACHE_CAPACITY = 128
/** Fail-closed vertex cap (domain model §7). */
export const MAX_CHAIN_NODES = 50_000
/** Fail-closed edge cap (domain model §7). */
export const MAX_CHAIN_EDGES = 200_000

/**
 * Extensions the chain uses to bind an extensionless import (`./b`) to a file
 * that has already been parsed (`src/b.ts`). This is not a filesystem probe and
 * not a guess: only paths the engine has actually indexed are considered, and
 * the list order is deterministic. When the file is parsed later, its incoming
 * stub edges are adopted (`adoptStubEdges`), so order does not matter.
 */
const KNOWN_FILE_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.html', '.htm', '.md', '.markdown', '.mdx', '.tex', '.ltx', '.latex',
]

/**
 * Kinds that can own a workspace file. Only these populate `knownPaths`, which
 * is what makes an extensionless import bind to an already-parsed file after a
 * rehydration as well.
 */
const FILE_NODE_KINDS: ReadonlySet<string> = new Set(['module', 'document', 'book', 'article'])

/**
 * Graph kind of a derived workspace directory node. Directories are structural
 * descriptions only: they live in the chain graph, are derived from path
 * prefixes with no filesystem access, and are never registered in
 * `knownPaths`, so an extensionless import cannot bind to one as if it were a
 * parsed file (or claim the directory exists on disk).
 */
const DIRECTORY_NODE_KIND = 'directory'

/**
 * Canonical chain relations. `depends_on` is an input alias for `depends`
 * (domain model §4: "requested `depends_on` is `depends` … no underscores").
 */
export type ChainRelation =
  | 'depends'
  | 'satisfies'
  | 'baseline'
  | 'prerequisite'
  | 'requires'
  | 'meets'
  | 'proves'
  | 'defines'
  | 'references'
  | 'contains'
  | 'part_of'

/** Per-link status. `stale` is computed from the current node version. */
export type ChainStatus = 'satisfied' | 'unmet' | 'unknown' | 'stale' | 'unverifiable'

/** Direction of the query relative to the stored edge. */
export type ChainDirection = 'forward' | 'reverse'

/** Query verbs exposed by `coordination_chain`. */
export type ChainAction =
  | 'dependencies'
  | 'dependents'
  | 'satisfies'
  | 'satisfied_by'
  | 'baseline'
  | 'prerequisites'
  | 'unmet'
  | 'path'
  | 'cycle'

/** One projected relation. No body, no AST, no adjacency. */
export interface ChainLink {
  /** Public handle of the far node (the node this link points at). */
  handle: string
  from: string
  to: string
  relation: ChainRelation
  direction: ChainDirection
  status: ChainStatus
  /** Distance from the root (1 = direct neighbour). */
  depth: number
  evidenceHandle?: string
  /** Pinned version/hash of a `baseline` link. */
  baselineVersion?: string
  kind?: string
  name?: string
  label?: string
  title?: string
  brief?: string
  path?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
  charset?: string
  created: number
  changed: number
}

/** One bounded, read-only chain projection. */
export interface ChainProjection {
  root: string
  links: ChainLink[]
  /** Deepest link depth present (0 for an empty projection). */
  depth: number
  truncated: boolean
  /** One explicit cycle path (`[a, b, c]` means `a → b → c → a`), if found. */
  cycle?: string[]
  version: string
  computedAt: number
  relation?: ChainRelation
  /** True only for the `path` action: whether a path to the target exists. */
  found?: boolean
  counts: {
    nodes: number
    links: number
    external: number
    unresolved: number
    omitted: number
  }
}

/** Optional bounds for a chain query. */
export interface ChainQueryOptions {
  depth?: number
  limit?: number
  /** Required by `path`; ignored elsewhere. */
  target?: string
  /** Narrow the traversal to one relation (aliases accepted). */
  relation?: ChainRelation | 'depends_on' | 'imports' | 'satisfiedBy'
  /**
   * Only return nodes of this graph kind (`module`, `function`, `directory`,
   * …). Case-insensitive and trimmed; an empty value means no filter. A kind
   * that matches nothing yields an empty projection, never an error.
   */
  kind?: string
}

/** Host-only edge write (`relate`); the only way to add non-parser relations. */
export interface ChainRelationInput {
  from: string
  to: string
  relation: ChainRelation | 'depends_on'
  status?: ChainStatus
  /** Pinned target version for `baseline`; defaults to the target's version. */
  baselineVersion?: string
  evidenceHandle?: string
}

/**
 * One chain node ready for the v24 `edge`/`node` tables (host-only).
 *
 * Body-free: handle/kind/name/label/brief/locator fields and a fingerprint
 * version for staleness. `origin` distinguishes a parsed node from a lexical
 * stub, so rehydration never claims a stub was parsed.
 */
export interface ChainNodeSnapshot {
  handle: string
  kind: string
  name?: string
  label?: string
  brief?: string
  path?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
  charset?: string
  /** Fingerprint (or explicit version) used for staleness comparisons. */
  version: string
  origin: 'parser' | 'host' | 'stub'
}

/** One chain edge ready for the v24 `edge` table (host-only). */
export interface ChainEdgeSnapshot {
  relation: ChainRelation
  from: string
  to: string
  status: ChainStatus
  baselineVersion?: string
  targetVersion?: string
  evidenceHandle?: string
  created: number
  changed: number
}

/** Host-only write hook; implemented by `GraphStore`, absent without a DB. */
export interface ChainPersistenceSink {
  saveNode(node: ChainNodeSnapshot): void
  saveEdge(edge: ChainEdgeSnapshot): void
  /** Remove one edge that was re-pointed/removed (stub adoption, reparse). */
  deleteEdge(edge: { relation: ChainRelation; from: string; to: string }): void
}

/** Options for {@link ChainEngine}. */
export interface ChainEngineOptions {
  cacheCapacity?: number
  /** Optional ceiling from host config; clamped to `MAX_CHAIN_DEPTH`. */
  maxDepth?: number
  /** Optional ceiling from host config; clamped to `MAX_CHAIN_LINKS`. */
  maxLinks?: number
  /** Optional token budget; clamped to `MAX_CHAIN_TOKENS`. */
  tokenBudget?: number
  /** Persist every indexed node/edge (host only; the engine never reads it). */
  persist?: ChainPersistenceSink
  now?: () => number
}

/** Live retune values; every field is explicit (already resolved by the caller). */
export interface ChainRetuneOptions {
  cacheCapacity?: number
  maxDepth: number
  maxLinks: number
  tokenBudget: number
}

interface ChainNode {
  handle: string
  kind: string
  name?: string
  label?: string
  brief?: string
  path?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
  charset?: string
  /** Fingerprint (or explicit version) used for staleness comparisons. */
  version: string
  /** Reference/stub marker; stubs are never described as parsed nodes. */
  origin: 'parser' | 'host' | 'stub'
}

interface ChainEdge {
  relation: ChainRelation
  from: string
  to: string
  status: ChainStatus
  baselineVersion?: string
  targetVersion?: string
  evidenceHandle?: string
  created: number
  changed: number
}

interface WalkResult {
  links: ChainLink[]
  depth: number
  truncated: boolean
  cycle?: string[]
  omitted: number
  found?: boolean
}

/* ------------------------------------------------------------------------- *
 * Action table
 * ------------------------------------------------------------------------- */

const ALL_RELATIONS: readonly ChainRelation[] = [
  'depends',
  'satisfies',
  'baseline',
  'prerequisite',
  'requires',
  'meets',
  'proves',
  'defines',
  'references',
  'contains',
  'part_of',
]

interface ActionSpec {
  relations: readonly ChainRelation[]
  direction: ChainDirection
  defaultDepth: number
  /** `unmet` keeps only links that fail closed. */
  statusFilter?: (status: ChainStatus) => boolean
}

const ACTION_SPECS: Readonly<Record<Exclude<ChainAction, 'path' | 'cycle'>, ActionSpec>> = {
  dependencies: { relations: ['depends'], direction: 'forward', defaultDepth: 1 },
  dependents: { relations: ['depends'], direction: 'reverse', defaultDepth: 1 },
  satisfies: { relations: ['satisfies'], direction: 'reverse', defaultDepth: 8 },
  satisfied_by: { relations: ['satisfies'], direction: 'forward', defaultDepth: 8 },
  baseline: { relations: ['baseline'], direction: 'forward', defaultDepth: 8 },
  prerequisites: { relations: ['prerequisite'], direction: 'forward', defaultDepth: 8 },
  // Unknown never auto-passes: an unmet query reports explicit `unmet` links and
  // unknown necessary inputs (requires/meets/prerequisite).
  unmet: {
    relations: ['requires', 'meets', 'prerequisite', 'depends', 'baseline'],
    direction: 'forward',
    defaultDepth: 8,
    statusFilter: (status) =>
      status === 'unmet' ||
      status === 'stale' ||
      (status === 'unknown'),
  },
}

const RELATION_ALIASES: Readonly<Record<string, ChainRelation>> = {
  depends_on: 'depends',
  depends: 'depends',
  imports: 'depends',
  import: 'depends',
  satisfies: 'satisfies',
  satisfied_by: 'satisfies',
  satisfiedBy: 'satisfies',
  baseline: 'baseline',
  prerequisite: 'prerequisite',
  requires: 'requires',
  meets: 'meets',
  proves: 'proves',
  defines: 'defines',
  references: 'references',
  contains: 'contains',
  part_of: 'part_of',
}

/* ------------------------------------------------------------------------- *
 * Engine
 * ------------------------------------------------------------------------- */

/**
 * Host-only chain projection engine. One instance per parse service/session; it
 * indexes every parse the tool layer performs and answers bounded queries.
 */
export class ChainEngine {
  private readonly graphs = new Map<ChainRelation, DirectedGraph<string>>()
  private readonly nodes = new Map<string, ChainNode>()
  private readonly edges = new Map<string, ChainEdge>()
  private readonly edgesByTarget = new Map<string, Set<string>>()
  private readonly knownPaths = new Map<string, string>()
  /**
   * Exact directory path keyed by its lower-cased spelling. A second spelling is
   * path ambiguity (a case-insensitive workspace cannot prove which one owns
   * the tree), so the directory layer refuses to emit edges rather than guess.
   */
  private readonly directorySpellings = new Map<string, string>()
  private readonly cache: LruList<string, ChainProjection>
  private readonly now: () => number
  private readonly persist: ChainPersistenceSink | undefined
  private maxDepth: number
  private maxLinks: number
  private tokenBudget: number
  private counter = 0
  private externalReferences = 0
  private unresolvedReferences = 0
  private unresolvedProofs = 0
  private capped = false

  constructor(options: ChainEngineOptions = {}) {
    const capacity = options.cacheCapacity ?? DEFAULT_CHAIN_CACHE_CAPACITY
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new InvalidArgumentError('chain cache capacity must be a positive integer', { capacity })
    }
    this.cache = new LruList<string, ChainProjection>(capacity)
    this.now = options.now ?? Date.now
    this.maxDepth = boundedOption(options.maxDepth, MAX_CHAIN_DEPTH, 1, 'maxDepth')
    this.maxLinks = boundedOption(options.maxLinks, MAX_CHAIN_LINKS, 1, 'maxLinks')
    this.tokenBudget = boundedOption(options.tokenBudget, MAX_CHAIN_TOKENS, 1, 'tokenBudget')
    this.persist = options.persist
  }

  /**
   * Apply a live host-config change without discarding the indexed graph.
   *
   * Handles stay valid: only the budgets (depth/link/token) and the projection
   * cache capacity change. The projection cache is cleared because keys do not
   * encode the token budget and a cached answer computed under the old ceiling
   * would be stale; nodes and edges are untouched.
   */
  retune(options: ChainRetuneOptions): void {
    this.maxDepth = boundedOption(options.maxDepth, MAX_CHAIN_DEPTH, 1, 'maxDepth')
    this.maxLinks = boundedOption(options.maxLinks, MAX_CHAIN_LINKS, 1, 'maxLinks')
    this.tokenBudget = boundedOption(options.tokenBudget, MAX_CHAIN_TOKENS, 1, 'tokenBudget')
    if (options.cacheCapacity !== undefined) {
      if (!Number.isInteger(options.cacheCapacity) || options.cacheCapacity < 1) {
        throw new InvalidArgumentError('chain cache capacity must be a positive integer', {
          capacity: options.cacheCapacity,
        })
      }
      this.cache.resize(options.cacheCapacity)
    }
    this.cache.clear()
  }

  /**
   * Rehydrate persisted nodes and edges without a parse (host only).
   *
   * Snapshot handles are the deterministic public handles, so a handle returned
   * before a restart resolves again. The method never calls the persistence
   * sink (a rehydrated engine must not rewrite what it read), and both arrays
   * are bounded by the caller (see `GraphStore.load*`): the engine still applies
   * its own `MAX_CHAIN_NODES` / `MAX_CHAIN_EDGES` fail-closed ceilings.
   */
  hydrate(nodes: readonly ChainNodeSnapshot[], edges: readonly ChainEdgeSnapshot[]): void {
    if (nodes.length === 0 && edges.length === 0) return
    this.counter += 1
    for (const snapshot of nodes) {
      if (this.nodes.size >= MAX_CHAIN_NODES) {
        this.capped = true
        break
      }
      this.nodes.set(snapshot.handle, {
        handle: snapshot.handle,
        kind: snapshot.kind,
        ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
        ...(snapshot.label === undefined ? {} : { label: snapshot.label }),
        ...(snapshot.brief === undefined ? {} : { brief: snapshot.brief }),
        ...(snapshot.path === undefined ? {} : { path: snapshot.path }),
        ...(snapshot.byteStart === undefined ? {} : { byteStart: snapshot.byteStart }),
        ...(snapshot.byteEnd === undefined ? {} : { byteEnd: snapshot.byteEnd }),
        ...(snapshot.lineStart === undefined ? {} : { lineStart: snapshot.lineStart }),
        ...(snapshot.lineEnd === undefined ? {} : { lineEnd: snapshot.lineEnd }),
        ...(snapshot.fingerprint === undefined ? {} : { fingerprint: snapshot.fingerprint }),
        ...(snapshot.charset === undefined ? {} : { charset: snapshot.charset }),
        version: snapshot.version,
        origin: snapshot.origin,
      })
      if (
        snapshot.path !== undefined &&
        snapshot.origin === 'parser' &&
        FILE_NODE_KINDS.has(snapshot.kind)
      ) {
        this.knownPaths.set(snapshot.path, snapshot.handle)
      }
      if (snapshot.kind === DIRECTORY_NODE_KIND && snapshot.path !== undefined) {
        this.directorySpellings.set(snapshot.path.toLowerCase(), snapshot.path)
      }
    }
    for (const snapshot of edges) {
      if (this.edges.size >= MAX_CHAIN_EDGES) {
        this.capped = true
        break
      }
      const key = this.edgeKey(snapshot.relation, snapshot.from, snapshot.to)
      if (this.edges.has(key)) continue
      this.ensureSnapshotNode(snapshot.from)
      this.ensureSnapshotNode(snapshot.to)
      const edge: ChainEdge = {
        relation: snapshot.relation,
        from: snapshot.from,
        to: snapshot.to,
        status: snapshot.status,
        created: snapshot.created,
        changed: snapshot.changed,
        ...(snapshot.baselineVersion === undefined ? {} : { baselineVersion: snapshot.baselineVersion }),
        ...(snapshot.targetVersion === undefined ? {} : { targetVersion: snapshot.targetVersion }),
        ...(snapshot.evidenceHandle === undefined ? {} : { evidenceHandle: snapshot.evidenceHandle }),
      }
      this.edges.set(key, edge)
      this.graph(snapshot.relation).addEdge(snapshot.from, snapshot.to)
      let incoming = this.edgesByTarget.get(snapshot.to)
      if (incoming === undefined) {
        incoming = new Set<string>()
        this.edgesByTarget.set(snapshot.to, incoming)
      }
      incoming.add(key)
    }
  }

  /** Configured depth ceiling (host config can only lower `MAX_CHAIN_DEPTH`). */
  get depthLimit(): number {
    return this.maxDepth
  }

  /** Configured link ceiling (host config can only lower `MAX_CHAIN_LINKS`). */
  get linkLimit(): number {
    return this.maxLinks
  }

  /** Configured token budget (host config can only lower `MAX_CHAIN_TOKENS`). */
  get tokenLimit(): number {
    return this.tokenBudget
  }

  /** Monotonic graph version; the projection-cache invalidation key. */
  get graphVersion(): string {
    return `v${this.counter}`
  }

  /** Registered vertices (parser nodes + file nodes + stubs). */
  get size(): number {
    return this.nodes.size
  }

  /** Stored edges across every relation. */
  get edgeCount(): number {
    return this.edges.size
  }

  /** True when a vertex/edge cap was hit; later answers are explicitly truncated. */
  get truncated(): boolean {
    return this.capped
  }

  /** Projection-cache size (for the bounded-cache test). */
  get cacheSize(): number {
    return this.cache.size
  }

  /** Projection-cache capacity. */
  get cacheCapacity(): number {
    return this.cache.capacity
  }

  /** Whether a handle is known to this engine. */
  hasNode(handle: string): boolean {
    return this.nodes.has(handle)
  }

  /**
   * Index one body-free parse: register its nodes, derive ancestor directory
   * vertices, add `contains`/`part_of`, heading hierarchy, proof and condition
   * edges, then resolve its file references into `depends` edges. Bumps
   * `graphVersion`, so every cached projection is invalidated.
   *
   * Direction invariant: *`part_of` is exact; `contains` is best-effort.* A
   * `part_of` edge is written only from parser evidence (or an exact path
   * prefix for the directory layer); `contains` may be absent or partial and
   * is never invented to make the pair look symmetric. A reverse query
   * direction (`dependentsOf`, `satisfiesOf`, …) is computed from the stored
   * forward edge and never persists a new edge.
   */
  index(parsed: ParsedFile): void {
    if (parsed.path === undefined) {
      throw new InvalidArgumentError('chain indexing requires a file-backed parse (path), not a text-only parse')
    }
    const path = parsed.path
    this.counter += 1
    const fileHandle = fileHandleFor(path)
    this.upsertNode({
      handle: fileHandle,
      kind: parsed.file.kind,
      ...(parsed.file.name === undefined ? {} : { name: parsed.file.name }),
      path,
      ...flatNodeFields(parsed.file),
      version: parsed.file.fingerprint ?? `status:${parsed.status}`,
      origin: 'parser',
    })
    this.knownPaths.set(path, fileHandle)
    // Ancestor directories (`a/b/c.ts` → `a`, `a/b`) are structural vertices;
    // they are created once and never enter `knownPaths`.
    this.indexDirectories(path, fileHandle)
    // A file parsed after its importers adopts their extensionless stub edges.
    this.adoptStubEdges(path, fileHandle)

    // Locator → handle, for relations the parser states by natural key
    // (TeX `domain.appliesTo`) instead of by name/label.
    const locatorHandles = new Map<string, string>()
    for (const metadata of parsed.nodes) {
      const key = nodeKeyOf(metadata)
      const handle = nodeHandleFor(path, metadata.kind, key)
      if (metadata.locator !== undefined) locatorHandles.set(metadata.locator, handle)
      this.upsertNode({
        handle,
        kind: metadata.kind,
        ...(metadata.name === undefined ? {} : { name: metadata.name }),
        ...(metadata.label === undefined ? {} : { label: metadata.label }),
        ...(metadata.brief === undefined ? {} : { brief: metadata.brief }),
        path,
        ...flatNodeFields(metadata),
        version: metadata.fingerprint ?? `status:${parsed.status}`,
        origin: 'parser',
      })
      this.linkContainment(fileHandle, handle)
    }

    // Heading hierarchy from explicit levels (Markdown `#`, HTML `<h1>`–`<h6>`).
    const headings = [...parsed.structure.headings].sort((left, right) => left.spanStart - right.spanStart)
    const stack: Array<{ level: number; handle: string }> = []
    for (const heading of headings) {
      const handle = nodeHandleFor(path, 'heading', `heading:${heading.spanStart}`)
      if (!this.nodes.has(handle)) continue
      while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop()
      const parent = stack.length === 0 ? fileHandle : stack[stack.length - 1].handle
      if (parent !== handle) {
        this.linkContainment(parent, handle)
      }
      stack.push({ level: heading.level, handle })
    }

    // Labels → handles, for explicit proof targets and formula references.
    const labels = new Map<string, string>()
    for (const metadata of parsed.nodes) {
      if (metadata.label !== undefined && metadata.label.length > 0) {
        if (!labels.has(metadata.label)) labels.set(metadata.label, nodeHandleFor(path, metadata.kind, nodeKeyOf(metadata)))
      }
      if (metadata.name !== undefined && metadata.name.length > 0) {
        if (!labels.has(metadata.name)) labels.set(metadata.name, nodeHandleFor(path, metadata.kind, nodeKeyOf(metadata)))
      }
    }

    // Explicit proof → target (`\begin{proof} … \ref{label}`).
    for (const statement of parsed.structure.statements) {
      if (statement.proofTarget === undefined) continue
      const proofHandle = nodeHandleFor(path, statement.kind, `${statement.kind}:${statement.spanStart}`)
      const targetHandle = labels.get(statement.proofTarget)
      if (targetHandle === undefined || targetHandle === proofHandle) {
        this.unresolvedProofs += 1
        continue
      }
      if (!this.nodes.has(proofHandle)) this.unresolvedProofs += 1
      else this.addEdge(proofHandle, targetHandle, 'proves', 'satisfied', { evidenceHandle: proofHandle })
    }

    // Explicit Pandoc contract divs: `::: require` is a necessary condition of
    // the document; `::: meet` is a sufficient condition for it.
    for (const div of parsed.structure.divs) {
      const name = div.name.toLowerCase()
      if (name !== 'require' && name !== 'meet' && name !== 'condition') continue
      const divHandle = nodeHandleFor(path, 'div', `div:${div.spanStart}`)
      if (!this.nodes.has(divHandle)) continue
      if (name === 'meet') this.addEdge(divHandle, fileHandle, 'meets', 'unknown')
      else this.addEdge(fileHandle, divHandle, 'requires', 'unknown')
    }

    // Formula label/equation/symbol references that name a node in this file.
    for (const reference of parsed.structure.formulaReferences) {
      const formulaHandle = nodeHandleFor(path, 'formula', `formula:${reference.formulaSpanStart}`)
      if (!this.nodes.has(formulaHandle)) continue
      const targetHandle = labels.get(reference.target)
      if (targetHandle === undefined || targetHandle === formulaHandle) continue
      this.addEdge(formulaHandle, targetHandle, 'references', 'satisfied')
    }

    // Explicit TeX condition relations (`\requires` / `\meets`). The parser
    // sets `domain.relation` only for those two markers, so a form-only marker
    // (`\necessary`, `\sufficient`, …) never creates an edge. `appliesTo` is a
    // natural locator, not a handle: an unattached condition or one whose
    // target node was dropped yields no edge at all rather than a guessed one.
    // Directions match the markup contract: `requires` = target → condition,
    // `meets` = condition → target. `source` keeps this limited to TeX markers;
    // Markdown/front-matter conditions already have their own div/front-matter
    // wiring above and must not gain a second semantic edge.
    for (const metadata of parsed.nodes) {
      if (metadata.source !== 'command' && metadata.source !== 'environment') continue
      const concept = metadata.domain
      if (concept === undefined || concept.kind !== 'condition') continue
      const relation = concept.relation
      if (relation !== 'requires' && relation !== 'meets') continue
      const conditionHandle = nodeHandleFor(path, metadata.kind, nodeKeyOf(metadata))
      if (!this.nodes.has(conditionHandle)) continue
      const appliesTo = concept.appliesTo
      if (appliesTo === undefined) continue
      const targetHandle = locatorHandles.get(appliesTo)
      if (targetHandle === undefined || targetHandle === conditionHandle) continue
      if (relation === 'requires') this.addEdge(targetHandle, conditionHandle, 'requires', 'unknown')
      else this.addEdge(conditionHandle, targetHandle, 'meets', 'unknown')
    }

    // File references: lexical resolution only, external/unresolved never edges.
    for (const reference of parsed.references) {
      const resolved = resolveSpecifier(reference.specifier, path)
      if (resolved === undefined) {
        if (reference.external) this.externalReferences += 1
        else this.unresolvedReferences += 1
        continue
      }
      // Bind to a file this engine has already indexed (no filesystem probe);
      // otherwise keep a stub keyed by the lexical path so a later parse can
      // adopt it.
      const targetPath = this.resolveKnownPath(resolved) ?? resolved
      const targetHandle = fileHandleFor(targetPath)
      const known = this.nodes.get(targetHandle)
      const status: ChainStatus = known === undefined || known.version === 'unknown' ? 'unknown' : 'satisfied'
      this.upsertNode({
        handle: targetHandle,
        kind: known?.kind ?? 'unknown',
        path: targetPath,
        version: known?.version ?? 'unknown',
        origin: known === undefined ? 'stub' : known.origin,
      })
      this.addEdge(fileHandle, targetHandle, 'depends', status, {
        ...(known === undefined || known.version === 'unknown' ? {} : { targetVersion: known.version }),
      })
      this.refreshDependentsOf(targetHandle)
    }
  }

  /**
   * Derive the workspace-relative ancestor directories of one indexed file
   * (`a/b/c.ts` → `a`, `a/b`) once each.
   *
   * Direction invariant: *`part_of` is exact; `contains` is best-effort.* The
   * child → parent (`part_of`) edge is the fact the path prefix proves and must
   * never be wrong; the parent → child (`contains`) edge is derived from the
   * same fact but may be absent (budget/truncation). It is never invented just
   * to make the pair symmetric.
   *
   * A path that cannot name an unambiguous lexical hierarchy (absolute, UNC,
   * drive letter, `.`/`..` segment, empty segment, or a second case spelling of
   * an already-known directory) contributes no directory hierarchy at all: the
   * chain has no filesystem probe, so it refuses to guess `part_of`.
   *
   * Directories are structural descriptions only: they are derived from the
   * workspace-relative path prefix, never created on disk, never stat'ed, and
   * their presence says nothing about the project being initialized.
   *
   * Idempotent by handle: re-indexing a sibling only re-upserts the shared
   * directories and their existing edges. Creation is bounded by the same
   * `MAX_CHAIN_NODES` vertex cap as every other node; when the cap is hit no
   * edge is added for the missing vertex, and the engine stays explicitly
   * truncated.
   */
  private indexDirectories(path: string, fileHandle: string): void {
    const segments = workspaceSegments(path)
    if (segments === undefined || segments.length < 2) return
    const directories: Array<{ path: string; name: string }> = []
    for (let index = 0; index < segments.length - 1; index += 1) {
      directories.push({
        path: segments.slice(0, index + 1).join('/'),
        name: segments[index],
      })
    }
    // On a case-insensitive workspace `Pkg` and `pkg` may be the same
    // directory; two spellings cannot prove one exact parent, so emit nothing.
    for (const directory of directories) {
      const known = this.directorySpellings.get(directory.path.toLowerCase())
      if (known !== undefined && known !== directory.path) return
    }
    for (const directory of directories) {
      this.directorySpellings.set(directory.path.toLowerCase(), directory.path)
    }
    let parent: string | undefined
    for (const directory of directories) {
      const handle = nodeHandleFor(directory.path, DIRECTORY_NODE_KIND, directory.path)
      this.upsertNode({
        handle,
        kind: DIRECTORY_NODE_KIND,
        name: directory.name,
        path: directory.path,
        // Directories have no content fingerprint; an explicit stable version
        // keeps re-indexing from looking like a stale baseline.
        version: 'host:directory',
        origin: 'host',
      })
      if (!this.nodes.has(handle)) {
        // Vertex cap reached: no exact child → parent edge is possible.
        parent = undefined
        continue
      }
      if (parent !== undefined) this.linkContainment(parent, handle)
      parent = handle
    }
    if (parent !== undefined && this.nodes.has(fileHandle)) {
      this.linkContainment(parent, fileHandle)
    }
  }

  /**
   * Host-only relation write. Only the host/verifier may call this (satisfaction,
   * baselines, prerequisites, host-asserted conditions); the agent can ask for a
   * chain but never assert an edge. Re-relating the same pair updates the status.
   */
  relate(input: ChainRelationInput): ChainLink {
    if (input === null || typeof input !== 'object') {
      throw new InvalidArgumentError('relate input must be an object')
    }
    const relation = normaliseRelation(input.relation)
    if (relation === undefined) {
      throw new InvalidArgumentError('unknown chain relation', { relation: input.relation })
    }
    if (!this.nodes.has(input.from)) throw new NotFoundError('node', input.from)
    if (!this.nodes.has(input.to)) throw new NotFoundError('node', input.to)
    if (input.from === input.to) {
      throw new InvalidArgumentError('a host relation cannot point a node at itself', { handle: input.from })
    }
    this.counter += 1
    const target = this.nodes.get(input.to)
    const baselineVersion = input.baselineVersion ?? (relation === 'baseline' ? target?.version : undefined)
    const status = input.status ?? defaultStatus(relation, input.evidenceHandle !== undefined)
    const edge = this.addEdge(input.from, input.to, relation, status, {
      ...(baselineVersion === undefined || baselineVersion === 'unknown' ? {} : { baselineVersion }),
      ...(input.evidenceHandle === undefined ? {} : { evidenceHandle: input.evidenceHandle }),
      ...(relation === 'baseline' && target !== undefined && target.version !== 'unknown'
        ? { targetVersion: target.version }
        : {}),
    })
    return this.linkOf(edge, 'forward', 1, input.to)
  }

  /** Direct dependencies (outgoing `depends` edges, default depth 1). */
  dependenciesOf(handle: string, options: ChainQueryOptions = {}): ChainProjection {
    return this.query(handle, 'dependencies', options)
  }

  /** Direct dependents (incoming `depends` edges, default depth 1). */
  dependentsOf(handle: string, options: ChainQueryOptions = {}): ChainProjection {
    return this.query(handle, 'dependents', options)
  }

  /** Evidence that satisfies the target (incoming `satisfies` edges). */
  satisfiesOf(handle: string, options: ChainQueryOptions = {}): ChainProjection {
    return this.query(handle, 'satisfies', options)
  }

  /** What an evidence/condition satisfies (outgoing `satisfies` edges). */
  satisfiedBy(handle: string, options: ChainQueryOptions = {}): ChainProjection {
    return this.query(handle, 'satisfied_by', options)
  }

  /** Pinned baselines used by the root; a changed target makes the link `stale`. */
  baselineOf(handle: string, options: ChainQueryOptions = {}): ChainProjection {
    return this.query(handle, 'baseline', options)
  }

  /** Necessary task/step inputs. */
  prerequisitesOf(handle: string, options: ChainQueryOptions = {}): ChainProjection {
    return this.query(handle, 'prerequisites', options)
  }

  /** Every necessary input reachable from the root that fails closed. */
  unmet(handle: string, options: ChainQueryOptions = {}): ChainProjection {
    return this.query(handle, 'unmet', options)
  }

  /** Shortest path from `handle` to `options.target` across every relation. */
  path(handle: string, target: string, options: ChainQueryOptions = {}): ChainProjection {
    return this.query(handle, 'path', { ...options, target })
  }

  /** One explicit cycle reachable from the root, or an empty projection. */
  cycleAt(handle: string, options: ChainQueryOptions = {}): ChainProjection {
    return this.query(handle, 'cycle', options)
  }

  /** Drop cached projections (index/relate already invalidate by version). */
  clearCache(): void {
    this.cache.clear()
  }

  /** Drop every node, edge and cached projection. */
  clear(): void {
    this.nodes.clear()
    this.edges.clear()
    this.edgesByTarget.clear()
    this.knownPaths.clear()
    this.directorySpellings.clear()
    this.graphs.clear()
    this.cache.clear()
    this.counter += 1
    this.externalReferences = 0
    this.unresolvedReferences = 0
    this.unresolvedProofs = 0
    this.capped = false
  }

  /** Dispose alias. */
  dispose(): void {
    this.clear()
  }

  /* --------------------------------------------------------------------- *
   * Query internals
   * --------------------------------------------------------------------- */

  private query(handle: string, action: ChainAction, options: ChainQueryOptions): ChainProjection {
    if (typeof handle !== 'string' || handle.length === 0) {
      throw new InvalidArgumentError('chain root handle must be a non-empty public handle')
    }
    if (!this.nodes.has(handle)) throw new NotFoundError('node', handle)
    const requestedDepth = resolveDepth(options.depth, action)
    const requestedLimit = resolveLimit(options.limit)
    const depth = Math.min(requestedDepth, this.maxDepth)
    const limit = Math.min(requestedLimit, this.maxLinks)
    // A host-config ceiling below the request is explicit truncation, never a
    // silent short answer.
    const cappedByConfig = depth < requestedDepth || limit < requestedLimit
    const relation = normaliseRelation(options.relation)
    if (options.relation !== undefined && relation === undefined) {
      throw new InvalidArgumentError('unknown chain relation', { relation: options.relation })
    }
    const spec = action === 'path' || action === 'cycle' ? undefined : ACTION_SPECS[action]
    const relations = relation === undefined
      ? (spec?.relations ?? ALL_RELATIONS)
      : [relation]
    // Trimmed, case-insensitive node-kind filter; blank means "no filter".
    const kind = normaliseKind(options.kind)
    if (action === 'path') {
      if (typeof options.target !== 'string' || options.target.length === 0) {
        throw new InvalidArgumentError('path requires a target handle')
      }
      if (!this.nodes.has(options.target)) throw new NotFoundError('node', options.target)
    }
    const key = [
      this.graphVersion,
      action,
      handle,
      relations.join('+'),
      depth,
      limit,
      options.target ?? '',
      kind ?? '',
    ].join('\u0000')
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      return cappedByConfig && !cached.truncated ? { ...cached, truncated: true } : cached
    }

    const projection = action === 'cycle'
      ? this.projectCycle(handle, relations, kind, relation !== undefined)
      : action === 'path'
        ? this.projectPath(handle, options.target as string, relations, depth, limit, kind, relation !== undefined)
        : this.projectWalk(handle, action, spec as ActionSpec, relations, depth, limit, kind)
    if (cappedByConfig) projection.truncated = true
    this.cache.set(key, projection)
    return projection
  }

  private projectWalk(
    root: string,
    action: ChainAction,
    spec: ActionSpec,
    relations: readonly ChainRelation[],
    depth: number,
    limit: number,
    kind: string | undefined,
  ): ChainProjection {
    const walk = this.walk(root, relations, spec.direction, depth, limit, spec.statusFilter, kind)
    void action
    return this.projectionOf(root, relations.length === 1 ? relations[0] : undefined, walk)
  }

  private projectPath(
    root: string,
    target: string,
    relations: readonly ChainRelation[],
    depth: number,
    limit: number,
    kind: string | undefined,
    relationExplicit: boolean,
  ): ChainProjection {
    const parents = new Map<string, { from: string; relation: ChainRelation }>()
    const visited = new Set<string>([root])
    const queue: Array<{ handle: string; depth: number }> = [{ handle: root, depth: 0 }]
    let found = false
    while (queue.length > 0 && !found) {
      const current = queue.shift() as { handle: string; depth: number }
      if (current.depth >= depth) continue
      for (const relation of relations) {
        const graph = this.graphs.get(relation)
        if (graph === undefined) continue
        for (const far of graph.neighbors(current.handle)) {
          // Directory membership is not a semantic path: a shared directory
          // would make every sibling file reachable from every other one. The
          // generic `path` skips directory endpoints unless the caller names
          // the relation explicitly (`{ relation: 'contains' | 'part_of' }`).
          if (!relationExplicit && (this.isDirectory(current.handle) || this.isDirectory(far))) continue
          // A kind-filtered path may only travel through matching nodes, so
          // every returned link is of the requested kind.
          if (!this.matchesKind(far, kind)) continue
          if (visited.has(far)) continue
          visited.add(far)
          parents.set(far, { from: current.handle, relation })
          if (far === target) {
            found = true
            break
          }
          queue.push({ handle: far, depth: current.depth + 1 })
        }
        if (found) break
      }
    }
    const links: ChainLink[] = []
    let truncated = false
    if (found) {
      const chain: string[] = [target]
      let cursor = target
      while (cursor !== root) {
        const parent = parents.get(cursor)
        if (parent === undefined) break
        chain.push(parent.from)
        cursor = parent.from
      }
      chain.reverse()
      let usedTokens = 0
      for (let index = 1; index < chain.length; index += 1) {
        const parent = parents.get(chain[index])
        if (parent === undefined) break
        const edge = this.edgeOf(parent.relation, chain[index - 1], chain[index])
        if (edge === undefined) continue
        const link = this.linkOf(edge, 'forward', index, chain[index])
        const tokens = estimateTokens(JSON.stringify(link))
        if (links.length >= limit || usedTokens + tokens > this.tokenBudget) {
          truncated = true
          break
        }
        usedTokens += tokens
        links.push(link)
      }
    }
    return this.projectionOf(root, relations.length === 1 ? relations[0] : undefined, {
      links,
      depth: links.length,
      truncated,
      omitted: 0,
      found,
    })
  }

  private projectCycle(
    root: string,
    relations: readonly ChainRelation[],
    kind: string | undefined,
    relationExplicit: boolean,
  ): ChainProjection {
    // Build the root-reachable subgraph, then let the frozen primitive find the
    // cycle; a cycle is a legal result and is reported, never thrown. A kind
    // filter gates which vertices may be traversed, and a found cycle that
    // still contains an unmatched vertex (the root) is not returned.
    const sub = new DirectedGraph<string>()
    const visited = new Set<string>([root])
    const queue: string[] = [root]
    let truncated = false
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const relation of relations) {
        const graph = this.graphs.get(relation)
        if (graph === undefined) continue
        for (const far of graph.neighbors(current)) {
          // Directory membership is structural, not a cycle: `root → dir →
          // sibling → …` would report every directory tree as a cycle. The
          // generic `cycle` skips directory endpoints unless the caller names
          // the relation explicitly.
          if (!relationExplicit && (this.isDirectory(current) || this.isDirectory(far))) continue
          if (!this.matchesKind(far, kind)) continue
          sub.addEdge(current, far)
          if (visited.has(far)) continue
          if (visited.size >= MAX_CHAIN_NODES) {
            truncated = true
            continue
          }
          visited.add(far)
          queue.push(far)
        }
      }
    }
    const found = sub.findCycle()
    const cycle = found !== null && found.every((handle) => this.matchesKind(handle, kind)) ? found : null
    return this.projectionOf(root, relations.length === 1 ? relations[0] : undefined, {
      links: [],
      depth: 0,
      truncated,
      ...(cycle === null ? {} : { cycle }),
      omitted: 0,
    })
  }

  private walk(
    root: string,
    relations: readonly ChainRelation[],
    direction: ChainDirection,
    depth: number,
    limit: number,
    filter: ((status: ChainStatus) => boolean) | undefined,
    kind: string | undefined,
  ): WalkResult {
    const links: ChainLink[] = []
    const visited = new Set<string>([root])
    const parents = new Map<string, { from: string; relation: ChainRelation }>()
    const queue: Array<{ handle: string; depth: number }> = [{ handle: root, depth: 0 }]
    let truncated = false
    let cycle: string[] | undefined
    let omitted = 0
    let usedTokens = 0
    let deepest = 0
    while (queue.length > 0) {
      const current = queue.shift() as { handle: string; depth: number }
      if (current.depth >= depth) continue
      for (const relation of relations) {
        const graph = this.graphs.get(relation)
        if (graph === undefined) continue
        const neighbours = direction === 'forward'
          ? [...graph.neighbors(current.handle)]
          : [...graph.predecessors(current.handle)]
        for (const far of neighbours) {
          const edge = direction === 'forward'
            ? this.edgeOf(relation, current.handle, far)
            : this.edgeOf(relation, far, current.handle)
          if (edge === undefined) continue
          const status = this.statusOf(edge)
          if (filter !== undefined && !filter(status)) continue
          // Filtering gates the traversal as well as the result: a node of
          // another kind is neither returned nor used as a bridge.
          if (!this.matchesKind(far, kind)) continue
          if (links.length >= limit) {
            truncated = true
            omitted += 1
            continue
          }
          const link = this.linkOf(edge, direction, current.depth + 1, far)
          const tokens = estimateTokens(JSON.stringify(link))
          if (usedTokens + tokens > this.tokenBudget) {
            truncated = true
            omitted += 1
            continue
          }
          usedTokens += tokens
          links.push(link)
          if (link.depth > deepest) deepest = link.depth
          if (visited.has(far)) {
            if (cycle === undefined) cycle = this.cycleThrough(far, current.handle, parents, root)
            continue
          }
          visited.add(far)
          parents.set(far, { from: current.handle, relation })
          queue.push({ handle: far, depth: current.depth + 1 })
        }
      }
    }
    return {
      links,
      depth: deepest,
      truncated,
      omitted,
      ...(cycle === undefined ? {} : { cycle }),
    }
  }

  private projectionOf(
    root: string,
    relation: ChainRelation | undefined,
    walk: WalkResult,
  ): ChainProjection {
    const projection: ChainProjection = {
      root,
      links: walk.links,
      depth: walk.depth,
      truncated: walk.truncated || this.capped,
      version: this.graphVersion,
      computedAt: this.now(),
      counts: {
        nodes: this.nodes.size,
        links: walk.links.length,
        external: this.externalReferences,
        unresolved: this.unresolvedReferences + this.unresolvedProofs,
        omitted: walk.omitted,
      },
    }
    if (walk.cycle !== undefined) projection.cycle = walk.cycle
    if (relation !== undefined) projection.relation = relation
    if (walk.found !== undefined) projection.found = walk.found
    return projection
  }

  /** Root → `handle` path followed by `far`, i.e. one explicit cycle. */
  private cycleThrough(far: string, handle: string, parents: Map<string, { from: string; relation: ChainRelation }>, root: string): string[] {
    const path: string[] = []
    let cursor: string | undefined = handle
    let guard = 0
    while (cursor !== undefined && guard < MAX_CHAIN_NODES) {
      guard += 1
      path.push(cursor)
      if (cursor === root) break
      cursor = parents.get(cursor)?.from
    }
    path.reverse()
    path.push(far)
    return path
  }

  /* --------------------------------------------------------------------- *
   * Graph primitives
   * --------------------------------------------------------------------- */

  private graph(relation: ChainRelation): DirectedGraph<string> {
    let graph = this.graphs.get(relation)
    if (graph === undefined) {
      graph = new DirectedGraph<string>()
      this.graphs.set(relation, graph)
    }
    return graph
  }

  private edgeKey(relation: ChainRelation, from: string, to: string): string {
    return `${relation}\u0000${from}\u0000${to}`
  }

  private edgeOf(relation: ChainRelation, from: string, to: string): ChainEdge | undefined {
    return this.edges.get(this.edgeKey(relation, from, to))
  }

  private upsertNode(node: ChainNode): void {
    const existing = this.nodes.get(node.handle)
    if (existing !== undefined) {
      existing.kind = node.kind
      if (node.name !== undefined) existing.name = node.name
      if (node.label !== undefined) existing.label = node.label
      if (node.brief !== undefined) existing.brief = node.brief
      if (node.path !== undefined) existing.path = node.path
      if (node.byteStart !== undefined) existing.byteStart = node.byteStart
      if (node.byteEnd !== undefined) existing.byteEnd = node.byteEnd
      if (node.lineStart !== undefined) existing.lineStart = node.lineStart
      if (node.lineEnd !== undefined) existing.lineEnd = node.lineEnd
      if (node.fingerprint !== undefined) existing.fingerprint = node.fingerprint
      if (node.charset !== undefined) existing.charset = node.charset
      if (node.version !== 'unknown') existing.version = node.version
      if (node.origin === 'parser' || existing.origin === 'stub') existing.origin = node.origin
      this.persist?.saveNode(existing)
      return
    }
    if (this.nodes.size >= MAX_CHAIN_NODES) {
      this.capped = true
      return
    }
    const stored: ChainNode = { ...node }
    this.nodes.set(node.handle, stored)
    this.persist?.saveNode(stored)
  }

  /**
   * Ensure a hydrated edge endpoint exists. An edge whose node row was outside
   * the bounded node read still resolves as an explicit stub, never as a parsed
   * node: `version: 'unknown'` and `origin: 'stub'` keep status truthful.
   */
  private ensureSnapshotNode(handle: string): void {
    if (this.nodes.has(handle)) return
    if (this.nodes.size >= MAX_CHAIN_NODES) {
      this.capped = true
      return
    }
    this.nodes.set(handle, {
      handle,
      kind: 'unknown',
      version: 'unknown',
      origin: 'stub',
    })
  }

  /**
   * Record one containment fact with the mandated direction semantics:
   * *`part_of` is exact; `contains` is best-effort.* The caller only reaches
   * this method with an evidence-backed parent/child pair, so `part_of`
   * (child → parent) is written first and is never inferred from `contains`.
   * The derived `contains` (parent → child) is added only when that exact
   * `part_of` edge was stored; an edge-budget drop therefore leaves the exact
   * direction intact instead of fabricating a one-sided reverse.
   */
  private linkContainment(parent: string, child: string): void {
    this.addEdge(child, parent, 'part_of', 'satisfied')
    if (!this.edges.has(this.edgeKey('part_of', child, parent))) return
    this.addEdge(parent, child, 'contains', 'satisfied')
  }

  private addEdge(
    from: string,
    to: string,
    relation: ChainRelation,
    status: ChainStatus,
    extra: { baselineVersion?: string; targetVersion?: string; evidenceHandle?: string } = {},
  ): ChainEdge {
    const now = this.now()
    const key = this.edgeKey(relation, from, to)
    const existing = this.edges.get(key)
    if (existing !== undefined) {
      existing.status = status
      existing.changed = now
      if (extra.baselineVersion !== undefined) existing.baselineVersion = extra.baselineVersion
      if (extra.targetVersion !== undefined) existing.targetVersion = extra.targetVersion
      if (extra.evidenceHandle !== undefined) existing.evidenceHandle = extra.evidenceHandle
      this.persist?.saveEdge(existing)
      return existing
    }
    if (this.edges.size >= MAX_CHAIN_EDGES) {
      this.capped = true
      return { relation, from, to, status: 'unverifiable', created: now, changed: now }
    }
    const edge: ChainEdge = { relation, from, to, status, created: now, changed: now }
    if (extra.baselineVersion !== undefined) edge.baselineVersion = extra.baselineVersion
    if (extra.targetVersion !== undefined) edge.targetVersion = extra.targetVersion
    if (extra.evidenceHandle !== undefined) edge.evidenceHandle = extra.evidenceHandle
    this.edges.set(key, edge)
    this.graph(relation).addEdge(from, to)
    let incoming = this.edgesByTarget.get(to)
    if (incoming === undefined) {
      incoming = new Set<string>()
      this.edgesByTarget.set(to, incoming)
    }
    incoming.add(key)
    this.persist?.saveEdge(edge)
    return edge
  }

  /**
   * When a file is indexed after its importers, upgrade their `depends` link
   * from `unknown` to `satisfied` and pin the target version. Edges already
   * `stale` are left stale: a changed fingerprint is the point.
   */
  private refreshDependentsOf(target: string): void {
    const targetNode = this.nodes.get(target)
    if (targetNode === undefined || targetNode.version === 'unknown') return
    const incoming = this.edgesByTarget.get(target)
    if (incoming === undefined) return
    for (const key of incoming) {
      const edge = this.edges.get(key)
      if (edge === undefined) continue
      if (edge.relation !== 'depends') continue
      if (edge.status === 'stale') continue
      edge.status = 'satisfied'
      edge.targetVersion = targetNode.version
      edge.changed = this.now()
      this.persist?.saveEdge(edge)
    }
  }

  /**
   * Bind an extensionless import to a file this engine has already parsed:
   * `src/b` → `src/b.ts`, `src` → `src/index.ts`. Only known (parsed) paths are
   * considered; the filesystem is never probed. Deterministic extension order.
   */
  private resolveKnownPath(resolved: string): string | undefined {
    if (this.knownPaths.has(resolved)) return resolved
    for (const extension of KNOWN_FILE_EXTENSIONS) {
      const candidate = `${resolved}${extension}`
      if (this.knownPaths.has(candidate)) return candidate
    }
    for (const extension of KNOWN_FILE_EXTENSIONS) {
      const candidate = `${resolved}/index${extension}`
      if (this.knownPaths.has(candidate)) return candidate
    }
    return undefined
  }

  /**
   * A file parsed *after* its importers adopts the stub edges that a lexically
   * resolved specifier created (`./b` → stub `src/b`, later `src/b.ts`): each
   * incoming `depends` edge is re-pointed at the real file and pinned to its
   * version, so parse order never changes the answer.
   */
  private adoptStubEdges(path: string, realHandle: string): void {
    const version = this.nodes.get(realHandle)?.version
    if (version === undefined || version === 'unknown') return
    for (const alias of stubAliases(path)) {
      const stubHandle = fileHandleFor(alias)
      const stub = this.nodes.get(stubHandle)
      if (stub === undefined || stub.origin !== 'stub') continue
      const incoming = this.edgesByTarget.get(stubHandle)
      if (incoming === undefined) continue
      for (const key of [...incoming]) {
        const edge = this.edges.get(key)
        if (edge === undefined || edge.relation !== 'depends') continue
        this.removeEdge(key)
        this.addEdge(edge.from, realHandle, 'depends', 'satisfied', {
          targetVersion: version,
          ...(edge.evidenceHandle === undefined ? {} : { evidenceHandle: edge.evidenceHandle }),
        })
      }
      if ((this.edgesByTarget.get(stubHandle)?.size ?? 0) === 0 && this.nodes.get(stubHandle)?.origin === 'stub') {
        this.edgesByTarget.delete(stubHandle)
        this.nodes.delete(stubHandle)
      }
    }
  }

  private removeEdge(key: string): void {
    const edge = this.edges.get(key)
    if (edge === undefined) return
    this.edges.delete(key)
    this.graphs.get(edge.relation)?.removeEdge(edge.from, edge.to)
    const incoming = this.edgesByTarget.get(edge.to)
    if (incoming !== undefined) {
      incoming.delete(key)
      if (incoming.size === 0) this.edgesByTarget.delete(edge.to)
    }
    this.persist?.deleteEdge({ relation: edge.relation, from: edge.from, to: edge.to })
  }

  /** True when `handle` is a derived workspace directory vertex. */
  private isDirectory(handle: string): boolean {
    return this.nodes.get(handle)?.kind === DIRECTORY_NODE_KIND
  }

  /** True when `handle` has the normalised kind, or when no filter is active. */
  private matchesKind(handle: string, kind: string | undefined): boolean {
    if (kind === undefined) return true
    const node = this.nodes.get(handle)
    return node !== undefined && node.kind.trim().toLowerCase() === kind
  }

  /** Current status: `stale` when a pinned/target version no longer matches. */
  private statusOf(edge: ChainEdge): ChainStatus {
    if (edge.relation === 'baseline' && edge.baselineVersion !== undefined) {
      const target = this.nodes.get(edge.to)
      if (target !== undefined && target.version !== 'unknown' && target.version !== edge.baselineVersion) {
        return 'stale'
      }
    }
    if (edge.relation === 'depends' && edge.targetVersion !== undefined) {
      const target = this.nodes.get(edge.to)
      if (target !== undefined && target.version !== 'unknown' && target.version !== edge.targetVersion) {
        return 'stale'
      }
    }
    return edge.status
  }

  private linkOf(edge: ChainEdge, direction: ChainDirection, depth: number, far: string): ChainLink {
    const node = this.nodes.get(far)
    const link: ChainLink = {
      handle: far,
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      direction,
      status: this.statusOf(edge),
      depth,
      created: edge.created,
      changed: edge.changed,
    }
    if (edge.evidenceHandle !== undefined) link.evidenceHandle = edge.evidenceHandle
    if (edge.baselineVersion !== undefined) link.baselineVersion = edge.baselineVersion
    if (node !== undefined) {
      if (node.kind.length > 0) link.kind = node.kind
      if (node.name !== undefined) link.name = node.name
      if (node.label !== undefined) link.label = node.label
      if (node.brief !== undefined) link.brief = node.brief.slice(0, 120)
      if (node.path !== undefined) link.path = node.path
      if (node.lineStart !== undefined && node.lineEnd !== undefined) {
        link.lineStart = node.lineStart
        link.lineEnd = node.lineEnd
      } else if (node.byteStart !== undefined && node.byteEnd !== undefined) {
        link.byteStart = node.byteStart
        link.byteEnd = node.byteEnd
      }
      if (node.fingerprint !== undefined) link.fingerprint = node.fingerprint
      if (node.charset !== undefined) link.charset = node.charset
    }
    return link
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

/**
 * Split a workspace-relative path into hierarchy segments, or `undefined` when
 * the path cannot prove an exact hierarchy: absolute/UNC/drive paths, empty
 * segments (including a trailing slash), and in-tree `.`/`..` segments. One
 * leading `./` is tolerated because it never changes the target. Case is
 * preserved; the directory layer refuses conflicting spellings itself.
 */
function workspaceSegments(path: string): string[] | undefined {
  let value = path.replace(/\\/g, '/')
  if (value.length === 0 || value.startsWith('/')) return undefined
  if (/^[A-Za-z]:/.test(value)) return undefined
  while (value.startsWith('./')) value = value.slice(2)
  if (value.length === 0) return undefined
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return undefined
  }
  return segments
}

/** Lexical stub paths a newly parsed file can adopt (`src/b.ts` → `src/b`). */
function stubAliases(path: string): string[] {
  const slash = path.lastIndexOf('/')
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const aliases: string[] = []
  if (dot > 0) aliases.push(path.slice(0, path.length - (base.length - dot)))
  const extensionless = dot > 0 ? base.slice(0, dot) : base
  if (extensionless === 'index') {
    const directory = slash < 0 ? '' : path.slice(0, slash)
    if (directory.length > 0) aliases.push(directory)
  }
  return aliases.filter((alias) => alias.length > 0 && alias !== '.')
}

function flatNodeFields(metadata: {
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
  charset?: string
}): Pick<ChainNode, 'byteStart' | 'byteEnd' | 'lineStart' | 'lineEnd' | 'fingerprint' | 'charset'> {
  const fields: Pick<ChainNode, 'byteStart' | 'byteEnd' | 'lineStart' | 'lineEnd' | 'fingerprint' | 'charset'> = {}
  if (metadata.byteStart !== undefined) fields.byteStart = metadata.byteStart
  if (metadata.byteEnd !== undefined) fields.byteEnd = metadata.byteEnd
  if (metadata.lineStart !== undefined) fields.lineStart = metadata.lineStart
  if (metadata.lineEnd !== undefined) fields.lineEnd = metadata.lineEnd
  if (metadata.fingerprint !== undefined) fields.fingerprint = metadata.fingerprint
  if (metadata.charset !== undefined) fields.charset = metadata.charset
  return fields
}

function defaultStatus(relation: ChainRelation, hasEvidence: boolean): ChainStatus {
  switch (relation) {
    case 'satisfies':
      return hasEvidence ? 'satisfied' : 'unknown'
    case 'baseline':
    case 'proves':
    case 'defines':
    case 'references':
      return 'satisfied'
    case 'contains':
    case 'part_of':
      return 'satisfied'
    default:
      return 'unknown'
  }
}

/** Map every accepted relation spelling to the canonical one. */
export function normaliseRelation(value: unknown): ChainRelation | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return RELATION_ALIASES[value]
}

/** Normalise a node-kind filter: trimmed and lower-cased; blank means none. */
function normaliseKind(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const kind = value.trim().toLowerCase()
  return kind.length === 0 ? undefined : kind
}

/** Validate a depth argument: integer 1..8; `undefined` uses the action default. */
export function resolveDepth(value: unknown, action: ChainAction): number {
  if (value === undefined) {
    if (action === 'path' || action === 'cycle') return MAX_CHAIN_DEPTH
    return ACTION_SPECS[action as Exclude<ChainAction, 'path' | 'cycle'>]?.defaultDepth ?? 1
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CHAIN_DEPTH) {
    throw new InvalidArgumentError(`depth must be an integer between 1 and ${MAX_CHAIN_DEPTH}`, {
      depth: value,
    })
  }
  return value
}

/** Validate a link-limit argument: integer 1..50; default 50. */
export function resolveLimit(value: unknown): number {
  if (value === undefined) return MAX_CHAIN_LINKS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CHAIN_LINKS) {
    throw new InvalidArgumentError(`limit must be an integer between 1 and ${MAX_CHAIN_LINKS}`, {
      limit: value,
    })
  }
  return value
}

/** Host-config ceiling: a positive integer clamped to `hardCap`, else the cap. */
function boundedOption(value: number | undefined, hardCap: number, minimum: number, name: string): number {
  if (value === undefined) return hardCap
  if (!Number.isInteger(value) || value < minimum) {
    throw new InvalidArgumentError(`${name} must be an integer >= ${minimum}`, { [name]: value })
  }
  return Math.min(value, hardCap)
}
