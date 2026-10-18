/**
 * Read-only workspace-graph and agent-record projections for the `/graph/*`
 * host routes.
 *
 * The graph projections are **pure query logic**: they never read a file, never
 * open the database, never call a parser and never write anything. The HTTP
 * layer hands them a body-free snapshot of the persisted v24 graph
 * (`node`/`edge` rows read through `GraphStore.loadNodes()` / `loadEdges()`),
 * and they project that snapshot into the six response shapes:
 *
 *   - {@link buildTree}        `{ root, entries, projects }` directory/file tree
 *                                                         plus manifest projects
 *   - {@link buildOutline}     `{ path, family, nodes }`   per-file outline
 *   - {@link buildIntra}       `{ path, family, nodes, edges, truncated }`
 *                                                         intra-file symbol graph
 *   - {@link buildDependencies}`{ links, cycles }`         `depends` edges + cycles
 *   - {@link buildImports}     `{ path, imported, exported }[]`
 *   - {@link searchGraph}      `{ handle, kind, name, path, line }[]`
 *
 * # Body-free by construction
 *
 * `GraphNode` carries exactly the metadata the persisted `node` row may expose:
 * handle, kind, name, label, path, line and ordering. There is no field for
 * content, prompt, credential or diagnostic text, so a projection cannot leak
 * one even by accident. The import/export lists hold **specifiers**, never the
 * imported module's body.
 *
 * # Agent records: read-only host projections, never invented data
 *
 * The two `/graph/agents*` routes project the host's own records to two more
 * shapes:
 *
 *   - {@link buildAgentRoster} `{ agents, progress }`       live/known agents
 *   - {@link buildAgentTranscript} `{ id, messages, truncated }`
 *                                                          bounded transcript
 *
 * {@link collectAgentRoster} and {@link resolveAgentSessionEvents} are thin
 * **read-only adapters** over the optional Cordis services `agents`, `sessions`,
 * `subagents`, `sessionQuery`, `sessionProjectionCache`, `sessionProjections`,
 * `goals` and `sessionPersistence`. They only call documented read methods and
 * never write, resume, send, cancel or create anything. A missing service is
 * capability absence: the roster is empty and an unknown transcript is
 * `NOT_FOUND`, never fabricated. Labels/objectives/statuses/timestamps come
 * from those records or are a documented structural fallback (short id,
 * first own task message); no model call is ever made to synthesize them.
 *
 * # The body-bearing routes
 *
 * > Preview is the only body-bearing **file-content** route: workspace-relative
 * > only, 64 KiB text cap, user-initiated, never cached or logged.
 * >
 * > `/graph/agents/messages` is the only body-bearing **agent-record** route:
 * > one known session id, `cache-control: no-store`, ≤200 messages, ≤8 KiB per
 * > message and ≤64 KiB total (newest kept), text blocks only. Non-text blocks
 * > (images, tool arguments) and binary-looking text are never returned, and the
 * > body is never cached or logged. Every other graph route stays body-free.
 *
 * `/graph/preview` performs its bounded read in `src/index.ts` (through
 * `ParseService.readContent` for text, and a bounded byte read through the same
 * containment checks for Office packages). This module classifies the extension
 * ({@link previewKindOf}) and builds the payload **in memory**:
 *
 *  - {@link buildTextPreview} passes through an already bounded text read;
 *  - {@link buildDocxPreview} converts a ≤64 KiB `word/document.xml` through
 *    mammoth and then reconstructs a ≤256 KiB allowlisted HTML fragment
 *    ({@link sanitizePreviewHtml});
 *  - {@link buildXlsxPreview} projects ≤20 sheets of ≤1,000 rows × 50 columns,
 *    string values only (a formula's `<f>` text is never returned);
 *  - {@link buildPptxPreview} projects ≤200 slides of ≤40 lines × 200
 *    characters.
 *
 * No Office byte is ever written to disk, no external process is started and
 * no converted body is stored or cached.
 *
 * # Bounded workspace indexing (`POST /graph/index`)
 *
 * A fresh profile has an empty graph: the file tools index only what they are
 * asked to parse. {@link indexWorkspaceFiles} is the scan half of the explicit
 * indexing entry point and is still pure orchestration — the host injects a
 * read-only {@link WorkspaceIndexIo} that binds it to `node:fs`, `ParseService`
 * and `GraphStore`/`ChainEngine`. The scan never descends into
 * `node_modules`/`.git`/`dist`/`.tmp`, never attempts a binary extension,
 * accepts the structural manifests by exact file name (the `.json`/`.xml`/
 * `.toml` extensions themselves stay off the allowlist), and is
 * capped at {@link MAX_INDEX_FILES} files / {@link INDEX_TIME_LIMIT_MS} ms and
 * reports `truncated` when a bound stopped it. {@link WorkspaceIndexGate}
 * serializes concurrent runs (the route answers 409 `BUSY`).
 * {@link workspaceIndexReport} adds the resolved root the route actually scanned
 * and, when nothing was indexed, the `no-workspace-files` diagnostic.
 *
 * # Two-level cache (dependencies / imports / intra)
 *
 * Per-file facts (`imports`, `exports`, `deps`) are resolved through:
 *
 *  - **L1 (per request)**: `createGraphQuery` allocates one `Map`; a query that
 *    visits the same file twice (dependency walk plus cycle scan) resolves it
 *    once. The map is dropped when the request ends.
 *  - **L2 (per process)**: a module-level `Map` keyed
 *    `` `${version}\u0000${scope}\u0000${path}` ``, holding only the resolved
 *    specifier/path lists. Intra-file views share the same map, version tracker
 *    and 512-entry capacity under their own
 *    `` `${version}\u0000intra\u0000${path}` `` key. FIFO eviction (Map
 *    insertion order). A different `version` clears the whole map, so a graph
 *    change can never serve stale facts. `version` is supplied by the caller and
 *    must change whenever the underlying graph changes (the routes derive it
 *    from the snapshot's row count + newest `changed` timestamp, i.e. an
 *    equivalent of the chain's `graphVersion` counter).
 *
 * Node is single-threaded, so no lock is needed; every read checks the map for
 * an actual entry instead of caching `undefined`.
 *
 * # Cycles
 *
 * A `depends` graph is allowed to be cyclic. Every traversal here is an
 * **iterative** DFS with explicit white/gray/black colouring — recursion is
 * forbidden because a deep dependency chain would overflow the stack.
 *
 * Dependency rows carry `cyclic: true` when the edge belongs to a cycle. That
 * flag is derived from the strongly connected components (iterative Kosaraju,
 * O(V + E)), so an edge deep in a cycle is marked even when the returned cycle
 * list is capped. The cycle list enumerates simple cycles up to a bounded scan
 * and reports each as a closed path (`['a', 'b', 'a']`); a self-loop is
 * `['a', 'a']`. Cycles are deduplicated by canonical rotation, sorted
 * lexicographically and capped at {@link MAX_CYCLES}. Edges are never removed
 * to break a cycle: the import/export rows stay complete.
 *
 * # Caps
 *
 * | Projection | Cap |
 * |---|---|
 * | tree depth / entries | 8 / 2,000 |
 * | intra nodes / edges | 500 / 2,000 |
 * | intra nesting depth | 20 (deeper nodes clamp to 20) |
 * | dependency links | 2,000 |
 * | cycles | 50 |
 * | import/export rows | 2,000 |
 * | import/export entries per row | 200 |
 * | search limit | 200 (default 50) |
 * | L2 cache entries | 512 |
 * | agent roster | 200 |
 * | roster label / objective | 200 / 2,000 chars |
 * | transcript messages | 200 |
 * | transcript message bytes | 8 KiB each / 64 KiB total |
 * | cold completion probes | 20 |
 *
 * Reuses `normaliseWorkspacePath` from the pure text layer: the same lexical
 * validation the file layer applies (no filesystem access, no symlink probe).
 */
import { XMLParser } from 'fast-xml-parser'
import { unzipSync, zipSync } from 'fflate'
import mammoth from 'mammoth'
import { InvalidArgumentError, InvalidStateError, NotFoundError } from '../shared/error.js'
import { normaliseWorkspacePath } from './text/parser.js'

/* ------------------------------------------------------------------------- *
 * Budgets
 * ------------------------------------------------------------------------- */

/** Maximum nesting level of a tree entry (root children are depth 1). */
export const MAX_TREE_DEPTH = 8
/** Maximum number of tree entries (directories + files). */
export const MAX_TREE_ENTRIES = 2_000
/** Maximum number of dependency links in one response. */
export const MAX_DEPENDENCY_LINKS = 2_000
/** Maximum number of cycles in one response. */
export const MAX_CYCLES = 50
/** Maximum number of import/export rows in one response. */
export const MAX_IMPORT_ROWS = 2_000
/** Maximum number of import/export specifiers per row. */
export const MAX_IMPORT_ENTRIES = 200
/** Default search result cap. */
export const DEFAULT_SEARCH_LIMIT = 50
/** Maximum search result cap. */
export const MAX_SEARCH_LIMIT = 200
/** Maximum files one workspace outline returns. */
export const MAX_OUTLINE_FILES = 200
/** Maximum nodes one workspace-outline group returns. */
export const MAX_OUTLINE_NODES = 500
/** Maximum symbol nodes one intra-file view returns. */
export const MAX_INTRA_NODES = 500
/** Maximum symbol edges one intra-file view returns. */
export const MAX_INTRA_EDGES = 2_000
/** Maximum nesting depth one intra-file view reports (deeper nodes clamp here). */
export const MAX_INTRA_DEPTH = 20
/** Process-wide L2 cache capacity. */
export const MAX_CACHE_ENTRIES = 512

/** Query scope: one file, or the whole workspace (the default). */
export type GraphScope = 'file' | 'workspace'

/** Bound on the simple-cycle search (frame steps) before the list is capped. */
const MAX_CYCLE_STEPS = 20_000
/** Bound on candidate cycles kept before sorting/capping the response. */
const MAX_CYCLE_CANDIDATES = 200

/* ------------------------------------------------------------------------- *
 * Snapshot shapes (body-free)
 * ------------------------------------------------------------------------- */

/** One persisted graph node, projected to the fields the routes may expose. */
export interface GraphNode {
  handle: string
  kind: string
  name?: string
  label?: string
  /** Workspace-relative path; absent for a path-less parse. */
  path?: string
  /** 1-based start line, when the parser recorded one. */
  line?: number
  /** Source order within one parse; keeps import/export lists deterministic. */
  ordinal?: number
  /** Persistence update stamp; only the graph version uses it. */
  changed?: number
}

/** One persisted graph edge (`relation` is the canonical chain relation). */
export interface GraphEdge {
  relation: string
  from: string
  to: string
  changed?: number
}

/** Input of {@link createGraphQuery}; `version` identifies the snapshot. */
export interface GraphQueryInput {
  /** Changes whenever the graph changes; the L2 cache key prefix. */
  version: string
  /**
   * Scope of the query. It is part of the L2 key, so a file-scoped view and a
   * workspace view of the same version never share cached entries.
   */
  scope?: GraphScope
  /**
   * Absolute workspace root the snapshot's paths are relative to. Project
   * scopes are resolved against it; the workspace fallback root is this value.
   * Defaults to `'.'` for callers that do not project workspace metadata.
   */
  workspaceRoot?: string
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
}

/** Per-file facts cached by L1/L2. Specifiers and paths only, never content. */
export interface FileFacts {
  /** `importation` specifiers, source order, deduplicated, capped. */
  imports: readonly string[]
  /** `exportation` specifiers, source order, deduplicated, capped. */
  exports: readonly string[]
  /** Direct `depends` targets, workspace-relative paths, deduplicated. */
  deps: readonly string[]
}

/** One request-scoped graph query with an L1 map over the L2 cache. */
export interface GraphQuery {
  readonly version: string
  readonly scope: GraphScope
  /** Absolute workspace root this query's paths are relative to. */
  readonly workspaceRoot: string
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  /** Sorted, unique workspace-relative paths of the indexed files. */
  readonly paths: readonly string[]
  /** Resolve (and cache) the body-free facts of one workspace-relative file. */
  factsOf(path: string): FileFacts
}

/* ------------------------------------------------------------------------- *
 * Tree projection
 * ------------------------------------------------------------------------- */

/** One directory/file entry of `/graph/tree`. */
export interface TreeNode {
  /** Workspace-relative path. */
  path: string
  /** Last path segment. */
  name: string
  kind: 'directory' | 'file'
  /** Present for directories only. */
  children?: TreeNode[]
}

/** One outermost project scope of `/graph/tree`. */
export interface TreeProject {
  /** Project ecosystem inferred from the manifest file name. */
  kind: ManifestKind
  /** Absolute directory containing the manifest (the project root). */
  root: string
  /** Manifest file name (for example `package.json`). */
  manifest: string
  /**
   * Workspace-relative paths of the manifests nested inside this project.
   *
   * They belong to the outermost project: a nested manifest never creates a
   * nested project scope.
   */
  nestedManifests: string[]
}

/** Value of `GET /graph/tree`. */
export interface GraphTree {
  /** Resolved workspace root the scan used; never a common path prefix. */
  root: string
  entries: TreeNode[]
  /** Outermost manifest projects, deduplicated by their root directory. */
  projects: TreeProject[]
}

/**
 * Project ecosystem inferred from a structural manifest file name.
 *
 * `unknown` is a custom name accepted through `manifestNames` that has no
 * built-in kind yet. Use {@link MANIFEST_ROOTS} to add a new exact file name.
 */
export type ManifestKind =
  | 'npm'
  | 'maven'
  | 'cargo'
  | 'go'
  | 'python'
  | 'gradle'
  | 'composer'
  | 'ruby'
  | 'elixir'
  | 'dune'
  | 'unknown'

/**
 * Default manifest file names accepted by the workspace scan.
 *
 * These are matched by **exact file name** (case-insensitively), not by a
 * shared extension: `.json`/`.xml`/`.toml` stay off the extension allowlist, so
 * only the structural manifests below are claimed. A caller can replace the
 * list with `manifestNames`; the ignore list still wins over this acceptance.
 */
export const DEFAULT_MANIFEST_NAMES = [
  'package.json',
  'pom.xml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'build.gradle',
  'settings.gradle',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'dune-project',
] as const

/**
 * Explicit exact-filename → project-kind table.
 *
 * This is deliberately a fixed table, not "any known build file becomes a
 * project root": only the structural manifests listed here define a project
 * scope. Extend it to add a new ecosystem; a custom `manifestNames` entry that
 * is not in this table is still indexed but has kind `unknown`.
 */
export const MANIFEST_ROOTS: Readonly<Record<string, ManifestKind>> = {
  'package.json': 'npm',
  'pom.xml': 'maven',
  'Cargo.toml': 'cargo',
  'go.mod': 'go',
  'pyproject.toml': 'python',
  'build.gradle': 'gradle',
  'settings.gradle': 'gradle',
  'composer.json': 'composer',
  'Gemfile': 'ruby',
  'mix.exs': 'elixir',
  'dune-project': 'dune',
}

/** Lower-cased lookup for the case-insensitive exact-name match. */
const MANIFEST_KIND_BY_NAME: ReadonlyMap<string, ManifestKind> = new Map(
  Object.entries(MANIFEST_ROOTS).map(([name, kind]): [string, ManifestKind] => [name.toLowerCase(), kind]),
)

/** Canonical file name per kind; the first table entry for a kind wins. */
const MANIFEST_NAME_BY_KIND: ReadonlyMap<ManifestKind, string> = (() => {
  const names = new Map<ManifestKind, string>()
  for (const [name, kind] of Object.entries(MANIFEST_ROOTS)) {
    if (!names.has(kind)) names.set(kind, name)
  }
  return names
})()

/**
 * One structural manifest in the indexed file set.
 *
 * `path` is workspace-relative (an absolute path inside the workspace root is
 * also accepted and resolved back to the relative form). `manifest` and `root`
 * are accepted as aliases for callers that already split them.
 */
export interface Manifest {
  kind: ManifestKind
  /** Workspace-relative manifest path, for example `packages/web/package.json`. */
  path?: string
  /** Alias for `path`. */
  manifest?: string
  /** Workspace-relative project directory; used when neither path alias is set. */
  root?: string
}

/** One manifest input: a structured record or its workspace-relative path. */
export type ManifestInput = Manifest | string

/**
 * One project scope resolved against a workspace root.
 *
 * `root` is always absolute: the directory that contains the manifest. The
 * workspace scope (`kind: 'workspace'`) is the fallback for a file that no
 * manifest claims; its root is the workspace root itself and it has no
 * manifest.
 */
export interface ProjectScope {
  kind: ManifestKind | 'workspace'
  /** Absolute project root (the manifest's directory, or the workspace root). */
  root: string
  /** Manifest file name (not its path); `null` for the workspace scope. */
  manifest: string | null
}

/** Project scope echoed on one workspace-outline group. */
export interface OutlineProjectScope {
  kind: ManifestKind
  /** Absolute project root. */
  root: string
}

/** One manifest resolved against a workspace root (workspace-relative paths). */
interface ManifestRecord {
  kind: ManifestKind
  /** Workspace-relative manifest path. */
  path: string
  /** Workspace-relative project directory (`''` is the workspace root). */
  root: string
}

/** Basename of a slash-normalised path. */
function basenameOf(path: string): string {
  const normalised = normaliseScopePath(path)
  const index = normalised.lastIndexOf('/')
  return index < 0 ? normalised : normalised.slice(index + 1)
}

/** Directory part of a slash-normalised path (`''` for a root-level name). */
function dirnameOf(path: string): string {
  const normalised = normaliseScopePath(path)
  const index = normalised.lastIndexOf('/')
  return index < 0 ? '' : normalised.slice(0, index)
}

/** Normalise a workspace-relative path for project-scope comparisons. */
function normaliseScopePath(path: string): string {
  let normalised = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  while (normalised.startsWith('./')) normalised = normalised.slice(2)
  normalised = normalised.replace(/\/+$/, '')
  return normalised === '.' ? '' : normalised
}

/** True for a POSIX-absolute, drive-rooted or UNC path. */
function isAbsoluteScopePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('/') || path.startsWith('//')
}

/** Join one workspace-relative path onto an absolute workspace root. */
function resolveWorkspaceChild(workspaceRoot: string, relative: string): string {
  const child = normaliseScopePath(relative)
  if (child.length === 0) return workspaceRoot
  if (isAbsoluteScopePath(child)) return child
  const base = workspaceRoot.replace(/[\\/]+$/, '')
  const windows = /^[A-Za-z]:[\\/]/.test(workspaceRoot) || workspaceRoot.includes('\\')
  const separator = windows ? '\\' : '/'
  return `${base}${separator}${child.replace(/\//g, separator)}`
}

/** Make an absolute path inside the workspace relative; other paths are unchanged. */
function toWorkspaceRelative(path: string, workspaceRoot: string): string {
  const normalised = normaliseScopePath(path)
  const root = normaliseScopePath(workspaceRoot)
  if (!isAbsoluteScopePath(normalised) || root.length === 0) return normalised
  const lowerPath = normalised.toLowerCase()
  const lowerRoot = root.toLowerCase()
  if (lowerPath === lowerRoot) return ''
  if (lowerPath.startsWith(`${lowerRoot}/`)) return normalised.slice(root.length + 1)
  return normalised
}

/** True when `path` is `root` itself or lies below it. */
function isPathWithin(root: string, path: string): boolean {
  const base = normaliseScopePath(root)
  const target = normaliseScopePath(path)
  if (base.length === 0) return true
  return target === base || target.startsWith(`${base}/`)
}

/** Lower-cased exact manifest-name set (case-insensitive match). */
function manifestNameSet(names: readonly string[] = DEFAULT_MANIFEST_NAMES): ReadonlySet<string> {
  const result = new Set<string>()
  for (const name of names) {
    const normalised = basenameOf(name)
    if (normalised.length > 0) result.add(normalised.toLowerCase())
  }
  return result
}

/**
 * Project kind of an exact manifest file name, or `undefined` when the path is
 * not a manifest. The match is case-insensitive and by exact file name only.
 */
export function manifestKindOfPath(
  path: string,
  manifestNames: readonly string[] = DEFAULT_MANIFEST_NAMES,
): ManifestKind | undefined {
  const name = basenameOf(path).toLowerCase()
  // The caller's list is authoritative: a replacement list narrows the exact
  // names the scan accepts, and only an accepted name gets a project kind.
  if (!manifestNameSet(manifestNames).has(name)) return undefined
  return MANIFEST_KIND_BY_NAME.get(name) ?? 'unknown'
}

/** True when the path is one of the accepted structural manifests. */
export function isManifestPath(
  path: string,
  manifestNames: readonly string[] = DEFAULT_MANIFEST_NAMES,
): boolean {
  return manifestKindOfPath(path, manifestNames) !== undefined
}

/** Workspace-relative manifest path of one {@link Manifest} input, if resolvable. */
function manifestPathOf(manifest: Manifest, workspaceRoot: string): string | undefined {
  if (manifest.path !== undefined) {
    const normalised = toWorkspaceRelative(manifest.path, workspaceRoot)
    return normalised.length === 0 ? undefined : normalised
  }
  if (manifest.manifest !== undefined) {
    // With a project root beside it, `manifest` is a file name; without one it
    // is the manifest path itself. A path-looking value always wins.
    const raw = manifest.root !== undefined && !manifest.manifest.includes('/') && !manifest.manifest.includes('\\')
      ? joinScopePath(manifest.root, manifest.manifest)
      : manifest.manifest
    const normalised = toWorkspaceRelative(raw, workspaceRoot)
    return normalised.length === 0 ? undefined : normalised
  }
  if (manifest.root !== undefined) {
    const name = MANIFEST_NAME_BY_KIND.get(manifest.kind)
    if (name === undefined) return undefined
    const normalised = toWorkspaceRelative(joinScopePath(manifest.root, name), workspaceRoot)
    return normalised.length === 0 ? undefined : normalised
  }
  return undefined
}

/** Join two workspace-relative path fragments. */
function joinScopePath(directory: string, name: string): string {
  const base = normaliseScopePath(directory)
  return base.length === 0 ? name : `${base}/${name}`
}

/** Normalise a structured or bare-string manifest input. */
function normaliseManifest(input: ManifestInput): Manifest | undefined {
  if (typeof input !== 'string') return input
  const path = normaliseScopePath(input)
  if (path.length === 0) return undefined
  return { kind: manifestKindOfPath(path) ?? 'unknown', path }
}

/** One manifest record from an indexed path, when the path is a manifest. */
function manifestRecordOf(
  path: string,
  workspaceRoot: string,
  manifestNames: readonly string[],
): ManifestRecord | undefined {
  const relative = toWorkspaceRelative(path, workspaceRoot)
  const kind = manifestKindOfPath(relative, manifestNames)
  if (kind === undefined) return undefined
  return { kind, path: relative, root: dirnameOf(relative) }
}

/** All distinct manifest records of an indexed path set, outermost first. */
function manifestRecordsOf(
  paths: readonly string[],
  workspaceRoot: string,
  manifestNames: readonly string[] = DEFAULT_MANIFEST_NAMES,
): ManifestRecord[] {
  const seen = new Set<string>()
  const records: ManifestRecord[] = []
  for (const path of paths) {
    const record = manifestRecordOf(path, workspaceRoot, manifestNames)
    if (record === undefined || seen.has(record.path)) continue
    seen.add(record.path)
    records.push(record)
  }
  records.sort(compareManifestRecords)
  return records
}

/** Shallowest project root first, then deterministic manifest path. */
function compareManifestRecords(left: ManifestRecord, right: ManifestRecord): number {
  return (
    scopeDepth(left.root) - scopeDepth(right.root) ||
    compareText(left.path, right.path)
  )
}

/** Number of directory segments in a workspace-relative project root. */
function scopeDepth(root: string): number {
  const normalised = normaliseScopePath(root)
  return normalised.length === 0 ? 0 : normalised.split('/').length
}

/**
 * Resolve the project scope of one file.
 *
 * The manifests are matched by their workspace-relative manifest paths. The
 * file belongs to the manifest directory **closest to the workspace root**
 * (the outermost ancestor); a nested manifest never narrows the scope. When no
 * manifest claims the file, the workspace scope is returned: its root is the
 * resolved workspace root and its manifest is `null`.
 *
 * The match is purely lexical: no file-system access and no common-prefix
 * guess. `workspaceRoot` is echoed as the fallback root, so the answer is the
 * directory the scan actually walked.
 */
export function projectScopeOf(
  path: string,
  manifests: readonly ManifestInput[],
  workspaceRoot = '.',
): ProjectScope {
  const filePath = toWorkspaceRelative(path, workspaceRoot)
  let best: { scope: ProjectScope; depth: number; order: string } | undefined
  for (const input of manifests) {
    const manifest = normaliseManifest(input)
    if (manifest === undefined) continue
    const manifestPath = manifestPathOf(manifest, workspaceRoot)
    if (manifestPath === undefined) continue
    const projectRoot = dirnameOf(manifestPath)
    if (!isPathWithin(projectRoot, filePath)) continue
    const depth = scopeDepth(projectRoot)
    const order = manifestPath
    if (best !== undefined && (depth > best.depth || (depth === best.depth && compareText(order, best.order) >= 0))) {
      continue
    }
    best = {
      scope: {
        kind: manifest.kind,
        root: resolveWorkspaceChild(workspaceRoot, projectRoot),
        manifest: basenameOf(manifestPath),
      },
      depth,
      order,
    }
  }
  return best?.scope ?? { kind: 'workspace', root: workspaceRoot, manifest: null }
}

/**
 * Global outline root: the outermost manifest project's root when one exists,
 * otherwise the resolved workspace root.
 *
 * The result is never a longest common prefix of the group paths. When several
 * unrelated projects are outermost (siblings), there is no single project
 * root, so the workspace root remains the only correct global root.
 */
export function outlineRootOf(
  workspaceRoot: string,
  projects: readonly (Pick<ProjectScope, 'kind' | 'root'> & { manifest?: string | null } | string)[],
): string {
  const roots = projects
    .map((project): { kind: ProjectScope['kind']; root: string } =>
      typeof project === 'string'
        ? { kind: 'unknown', root: project }
        : project)
    .filter((project) => project.kind !== 'workspace')
    .map((project) => {
      // Keep an already-absolute project root exactly as reported; only a
      // relative root is resolved against the workspace root. Normalising an
      // absolute root here would rewrite its separators (C:\x → C:/x).
      const absolute = isAbsoluteScopePath(normaliseScopePath(project.root))
        ? project.root
        : resolveWorkspaceChild(workspaceRoot, project.root)
      return { absolute, relative: toWorkspaceRelative(absolute, workspaceRoot) }
    })
    .filter((root) => root.absolute.length > 0)
  const unique = new Map<string, string>()
  for (const root of roots) {
    if (!unique.has(root.relative)) unique.set(root.relative, root.absolute)
  }
  if (unique.size === 0) return workspaceRoot
  let shallowest = Number.POSITIVE_INFINITY
  for (const relative of unique.keys()) shallowest = Math.min(shallowest, scopeDepth(relative))
  const outermost = [...unique.entries()]
    .filter(([relative]) => scopeDepth(relative) === shallowest)
    .map(([, absolute]) => absolute)
  return outermost.length === 1 ? (outermost[0] as string) : workspaceRoot
}

/**
 * Outermost project list of the tree: one entry per outermost manifest
 * directory. Nested manifests are recorded in `nestedManifests` and do not
 * create a nested project.
 */
function treeProjectsOf(
  records: readonly ManifestRecord[],
  workspaceRoot: string,
): TreeProject[] {
  const projects: TreeProject[] = []
  const relativeRoots: string[] = []
  for (const record of records) {
    const parent = relativeRoots.findIndex((root) => isPathWithin(root, record.root))
    if (parent >= 0) {
      const project = projects[parent] as TreeProject
      if (!project.nestedManifests.includes(record.path)) project.nestedManifests.push(record.path)
      continue
    }
    projects.push({
      kind: record.kind,
      root: resolveWorkspaceChild(workspaceRoot, record.root),
      manifest: basenameOf(record.path),
      nestedManifests: [],
    })
    relativeRoots.push(record.root)
  }
  for (const project of projects) project.nestedManifests.sort(compareText)
  projects.sort(
    (left, right) =>
      scopeDepth(toWorkspaceRelative(left.root, workspaceRoot)) -
        scopeDepth(toWorkspaceRelative(right.root, workspaceRoot)) ||
      compareText(left.root, right.root),
  )
  return projects
}

/** Outermost manifest record claiming one file, if any. */
function outermostManifestOf(
  path: string,
  records: readonly ManifestRecord[],
  workspaceRoot: string,
): ManifestRecord | undefined {
  const filePath = toWorkspaceRelative(path, workspaceRoot)
  let best: ManifestRecord | undefined
  let bestDepth = Number.POSITIVE_INFINITY
  for (const record of records) {
    if (!isPathWithin(record.root, filePath)) continue
    const depth = scopeDepth(record.root)
    if (depth < bestDepth || (depth === bestDepth && best !== undefined && compareText(record.path, best.path) < 0)) {
      best = record
      bestDepth = depth
    }
  }
  return best
}

/**
 * Build the directory/file tree from the indexed graph nodes.
 *
 * Only `directory` nodes and the parser's file-backed kinds
 * (`module`/`document`/`book`/`article`/`file`) contribute; every parser
 * child node is ignored, so the tree never claims a symbol is a file. A
 * structural manifest is always a file entry, even when its parser reports a
 * non-file kind (`project`). Ancestor directories are derived from path
 * prefixes, because the chain creates them exactly that way. Invalid or
 * path-less nodes are skipped rather than guessed.
 *
 * `root` is the resolved workspace root the scan used. It is echoed verbatim
 * and is never derived from the indexed paths: `src` is a directory under the
 * root, not the root, even when every indexed file lives below it.
 *
 * Manifest projects are computed from the indexed manifest paths. Only the
 * **outermost** manifest directory becomes a project: a nested manifest is
 * listed in `nestedManifests` and never creates a nested scope. `projects` is
 * empty when the workspace has no structural manifest.
 *
 * Depth is capped at {@link MAX_TREE_DEPTH} (root children are depth 1) and the
 * total entry count at {@link MAX_TREE_ENTRIES}; input paths are sorted first,
 * so the truncation is deterministic. Children are ordered directories first,
 * then by code-point name.
 */
export function buildTree(
  nodes: readonly GraphNode[],
  root = '.',
  options: { manifestNames?: readonly string[] } | readonly string[] = {},
): GraphTree {
  const manifestNames = Array.isArray(options)
    ? (options as readonly string[])
    : (options as { manifestNames?: readonly string[] }).manifestNames ?? DEFAULT_MANIFEST_NAMES
  const files: string[] = []
  const directories: string[] = []
  const manifestPaths = new Set<string>()
  for (const node of nodes) {
    const path = node.path === undefined ? undefined : normaliseGraphPath(node.path)
    if (path === undefined) continue
    const kind = node.kind.trim().toLowerCase()
    if (kind === 'directory') {
      directories.push(path)
      continue
    }
    // A structural manifest is a file entry even when its parser reports a
    // non-file kind such as `project`. The manifest's own file node is also
    // accepted through FILE_NODE_KINDS; the Set below removes the duplicate.
    const manifest = isManifestPath(path, manifestNames)
    if (manifest || FILE_NODE_KINDS.has(kind)) {
      files.push(path)
      if (manifest) manifestPaths.add(path)
    }
  }
  // Deterministic insertion order also makes the entry cap deterministic.
  const ordered = [...new Set([...directories, ...files])].sort(compareText)

  const childrenOf = new Map<string, TreeNode[]>()
  childrenOf.set('', [])
  const nodeByPath = new Map<string, TreeNode>()
  const directorySet = new Set(directories)
  let total = 0

  /** Create every ancestor directory of `directoryPath`; false when capped. */
  const ensureDirectory = (directoryPath: string): boolean => {
    if (directoryPath.length === 0) return true
    const segments = directoryPath.split('/')
    let prefix = ''
    let parent = ''
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`
      const existing = nodeByPath.get(prefix)
      if (existing !== undefined) {
        if (existing.kind !== 'directory') return false
        parent = prefix
        continue
      }
      // A path deeper than the cap contributes its ancestors up to depth 8,
      // but never the truncated entry itself.
      if (index + 1 > MAX_TREE_DEPTH) return false
      if (total >= MAX_TREE_ENTRIES) return false
      const directory: TreeNode = { path: prefix, name: segment, kind: 'directory', children: [] }
      nodeByPath.set(prefix, directory)
      childrenOf.get(parent)?.push(directory)
      childrenOf.set(prefix, directory.children as TreeNode[])
      parent = prefix
      total += 1
    }
    return true
  }

  for (const path of ordered) {
    if (total >= MAX_TREE_ENTRIES) break
    if (directorySet.has(path)) {
      ensureDirectory(path)
      continue
    }
    const segments = path.split('/')
    const name = segments[segments.length - 1] as string
    const parentPath = segments.slice(0, -1).join('/')
    // Over-deep files still contribute the ancestors that fit under the cap,
    // so the tree shows the truncated hierarchy instead of hiding it entirely.
    const parentReady = ensureDirectory(parentPath)
    if (segments.length > MAX_TREE_DEPTH) continue
    if (!parentReady || nodeByPath.has(path) || total >= MAX_TREE_ENTRIES) continue
    const file: TreeNode = { path, name, kind: 'file' }
    nodeByPath.set(path, file)
    childrenOf.get(parentPath)?.push(file)
    total += 1
  }

  // Depth is at most 8, so an explicit stack replaces recursion here too.
  const stack: TreeNode[][] = [childrenOf.get('') as TreeNode[]]
  while (stack.length > 0) {
    const level = stack.pop() as TreeNode[]
    level.sort(compareTreeNodes)
    for (const entry of level) {
      if (entry.children !== undefined) stack.push(entry.children)
    }
  }
  return {
    root,
    entries: childrenOf.get('') as TreeNode[],
    projects: treeProjectsOf(manifestRecordsOf([...manifestPaths], root, manifestNames), root),
  }
}

function compareTreeNodes(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return compareText(left.name, right.name) || compareText(left.path, right.path)
}

/* ------------------------------------------------------------------------- *
 * Outline projection
 * ------------------------------------------------------------------------- */

/** Document family the outline uses for depth ordering. */
export type GraphFamily = 'book' | 'article' | 'tex' | 'project' | 'document' | 'unknown'

/** One node of `/graph/outline`. */
export interface OutlineNode {
  handle: string
  kind: string
  name: string
  /** Index of the kind in its family order; unknown kinds are omitted. */
  depth: number
  /** 1-based source line (0 when the parser recorded none). */
  line: number
}

/** One file group of a workspace-scoped outline. */
export interface OutlineGroup {
  path: string
  family: GraphFamily
  nodes: OutlineNode[]
  /**
   * Outermost manifest project that claims this file, when the workspace has
   * one. A file outside every project (or in a workspace with no manifest) has
   * no `project` field at all.
   */
  project?: OutlineProjectScope
}

/** Value of `GET /graph/outline?path=<file>`. */
export interface FileOutline {
  scope: 'file'
  path: string
  family: GraphFamily
  nodes: OutlineNode[]
}

/** Value of `GET /graph/outline` (no `path`). */
export interface WorkspaceOutline {
  scope: 'workspace'
  groups: OutlineGroup[]
}

export type OutlineView = FileOutline | WorkspaceOutline

/**
 * Family orders; the array index is the nesting depth (domain-model §3).
 *
 * The document family is not spelled out in the route contract beyond
 * "headings/paragraphs → document", so it reuses the markup order: the file
 * node first, then its headings and paragraphs.
 */
const FAMILY_ORDERS: Readonly<Record<Exclude<GraphFamily, 'unknown'>, readonly string[]>> = {
  book: ['book', 'chapter', 'page', 'paragraph', 'line', 'sentence'],
  article: ['article', 'chapter', 'page', 'paragraph', 'line', 'sentence'],
  tex: ['document', 'chapter', 'preface', 'preamble', 'part', 'section', 'paragraph'],
  project: [
    'module',
    'file',
    'class',
    'property',
    'interface',
    'type',
    'method',
    'function',
    'static',
    'variable',
    'importation',
    'exportation',
  ],
  document: ['document', 'heading', 'paragraph', 'line', 'sentence'],
}

/** Parser file-backed node kinds that may appear in the tree/query path set. */
const FILE_NODE_KINDS: ReadonlySet<string> = new Set(['module', 'document', 'book', 'article', 'file'])

/** Code kinds: their presence makes a file a `project` outline. */
const CODE_KINDS: ReadonlySet<string> = new Set([
  'class',
  'function',
  'method',
  'interface',
  'type',
  'enumeration',
  'namespace',
  'importation',
  'exportation',
  'module',
  'property',
  'static',
  'variable',
])

const TEX_EXTENSIONS: ReadonlySet<string> = new Set(['.tex', '.ltx', '.latex'])
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.java', '.py', '.rs', '.php', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.cs',
  '.go', '.rb', '.kt', '.swift', '.scala',
])
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdx', '.html', '.htm', '.txt'])

/**
 * Classify one parsed file into an outline family.
 *
 * Precedence is deliberate — the strongest explicit signal wins:
 * front-matter `book`/`article`, then a TeX extension or TeX-only sectioning
 * kinds, then code kinds/extension, then heading/paragraph or markup extension.
 * A file that provides none of those is `unknown` and yields no outline nodes.
 */
export function familyOf(path: string, kinds: ReadonlySet<string>): GraphFamily {
  if (kinds.has('book')) return 'book'
  if (kinds.has('article')) return 'article'
  const extension = extensionOf(path)
  if (TEX_EXTENSIONS.has(extension)) return 'tex'
  if (kinds.has('preamble') || kinds.has('preface')) return 'tex'
  if (kinds.has('document') && (kinds.has('part') || kinds.has('section'))) return 'tex'
  for (const kind of CODE_KINDS) {
    if (kinds.has(kind)) return 'project'
  }
  if (CODE_EXTENSIONS.has(extension)) return 'project'
  if (kinds.has('heading') || kinds.has('paragraph')) return 'document'
  if (extension === '.book' || isBookSummary(path)) return 'book'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  if (kinds.has('document')) return 'document'
  return 'unknown'
}

/**
 * Build the outline projection for one file or the whole workspace.
 *
 * With `requestPath` the value is `{ scope: 'file', path, family, nodes }` — it
 * never carries `groups`. The path must be valid (`InvalidArgumentError` → 400)
 * and indexed (`NotFoundError` → 404).
 * Without it the value is `{ scope: 'workspace', groups }`: one group per
 * indexed file, sorted by path, at most {@link MAX_OUTLINE_FILES} files and
 * {@link MAX_OUTLINE_NODES} nodes per group. Each group carries the outermost
 * manifest `project` that claims its file; a file no manifest claims (or every
 * file when the workspace has no manifest) has no `project` field, and the
 * global root remains the resolver's workspace root (see
 * {@link outlineRootOf}).
 *
 * Nodes are ordered by source line, then depth, then name, so a heading and its
 * first paragraph keep their natural order.
 */
export function buildOutline(query: GraphQuery): WorkspaceOutline
export function buildOutline(query: GraphQuery, requestPath: string): FileOutline
export function buildOutline(query: GraphQuery, requestPath: string | undefined): OutlineView
export function buildOutline(query: GraphQuery, requestPath?: string): OutlineView {
  if (requestPath === undefined) {
    const byPath = groupNodesByPath(query.nodes)
    const manifests = manifestRecordsOf(query.paths, query.workspaceRoot)
    const groups: OutlineGroup[] = []
    for (const path of query.paths.slice(0, MAX_OUTLINE_FILES)) {
      const outline = computeOutline(path, byPath.get(path) ?? [])
      const scope = outermostManifestOf(path, manifests, query.workspaceRoot)
      const group: OutlineGroup = {
        path,
        family: outline.family,
        nodes: outline.nodes.slice(0, MAX_OUTLINE_NODES),
      }
      if (scope !== undefined) group.project = { kind: scope.kind, root: resolveWorkspaceChild(query.workspaceRoot, scope.root) }
      groups.push(group)
    }
    return { scope: 'workspace', groups }
  }
  const path = normaliseGraphPath(requestPath)
  if (path === undefined) {
    throw new InvalidArgumentError('path must be a workspace-relative path without ".."')
  }
  if (!query.paths.includes(path)) throw new NotFoundError('file', path)
  const outline = computeOutline(path, nodesOfPath(query.nodes, path))
  return { scope: 'file', path, family: outline.family, nodes: outline.nodes }
}

/** Group every node by its normalised workspace path (workspace outline). */
function groupNodesByPath(nodes: readonly GraphNode[]): Map<string, GraphNode[]> {
  const byPath = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    if (node.path === undefined) continue
    const path = normaliseGraphPath(node.path)
    if (path === undefined) continue
    const list = byPath.get(path)
    if (list === undefined) byPath.set(path, [node])
    else list.push(node)
  }
  return byPath
}

/** All nodes that belong to one normalised workspace path. */
function nodesOfPath(nodes: readonly GraphNode[], path: string): GraphNode[] {
  return nodes.filter((node) => node.path !== undefined && normaliseGraphPath(node.path) === path)
}

/** Family + depth-ordered nodes of one already-resolved path group. */
function computeOutline(path: string, fileNodes: readonly GraphNode[]): { family: GraphFamily; nodes: OutlineNode[] } {
  const kinds = new Set(fileNodes.map((node) => node.kind.trim().toLowerCase()))
  const family = familyOf(path, kinds)
  if (family === 'unknown') return { family, nodes: [] }
  const depthOf = new Map(FAMILY_ORDERS[family].map((kind, index): [string, number] => [kind, index]))
  const outline: OutlineNode[] = []
  for (const node of fileNodes) {
    const kind = node.kind.trim().toLowerCase()
    const depth = depthOf.get(kind)
    if (depth === undefined) continue
    outline.push({
      handle: node.handle,
      kind: node.kind,
      name: node.name ?? node.label ?? '',
      depth,
      line: node.line ?? 0,
    })
  }
  outline.sort(
    (left, right) =>
      left.line - right.line ||
      left.depth - right.depth ||
      compareText(left.name, right.name) ||
      compareText(left.handle, right.handle),
  )
  return { family, nodes: outline }
}

/* ------------------------------------------------------------------------- *
 * Graph query: L1/L2 caches
 * ------------------------------------------------------------------------- */

/** L1/L2 cache counters exposed for diagnostics and tests. */
export interface CacheStats {
  hits: number
  misses: number
  evictions: number
}

/**
 * One L2 entry: the body-free per-file facts, or one intra-file projection.
 *
 * Both are pure projections of the same snapshot, so they share the version
 * tracker and the 512-entry capacity. The keys can never collide: a facts key
 * is `${version}\u0000${scope}\u0000${path}` (scope is `file`/`workspace`),
 * while an intra key is `${version}\u0000intra\u0000${path}`.
 */
type CachedGraphValue = FileFacts | IntraView

/** Process-wide L2 cache. Only body-free projections are stored. */
const l2Cache = new Map<string, CachedGraphValue>()
let l2Version = ''
let cacheStats: CacheStats = { hits: 0, misses: 0, evictions: 0 }

/** Current L2 size and counters (diagnostics/tests; no graph content). */
export function graphCacheStats(): CacheStats & { size: number; version: string } {
  return { ...cacheStats, size: l2Cache.size, version: l2Version }
}

/** Drop the process-wide L2 cache and reset its counters (tests). */
export function resetGraphCache(): void {
  l2Cache.clear()
  l2Version = ''
  cacheStats = { hits: 0, misses: 0, evictions: 0 }
}

/** Clear L2 when the snapshot version moves; a graph change never serves stale values. */
function ensureCacheVersion(version: string): void {
  if (l2Version !== version) {
    l2Cache.clear()
    l2Version = version
  }
}

/** Insert one entry, evicting the oldest (FIFO) at capacity. */
function cachePut(key: string, value: CachedGraphValue): void {
  if (l2Cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = l2Cache.keys().next().value
    if (oldest !== undefined) {
      l2Cache.delete(oldest)
      cacheStats.evictions += 1
    }
  }
  l2Cache.set(key, value)
}

/**
 * Read one file's facts through L1 (per query) and L2 (per version).
 *
 * `undefined` is never cached: the map is only written after `compute` returns,
 * so a later call cannot mistake a cached miss for a hit.
 */
function cachedFacts(version: string, scope: GraphScope, path: string, compute: () => FileFacts): FileFacts {
  ensureCacheVersion(version)
  const key = `${version}\u0000${scope}\u0000${path}`
  const hit = l2Cache.get(key)
  if (hit !== undefined) {
    cacheStats.hits += 1
    return hit as FileFacts
  }
  cacheStats.misses += 1
  const facts = compute()
  cachePut(key, facts)
  return facts
}

/**
 * Resolve one intra-file projection through L2.
 *
 * The key deliberately carries the literal `intra` segment
 * (`${version}\u0000intra\u0000${path}`), so a filesystem path can never alias a
 * facts entry. The cached value is body-free metadata only — handles, kinds,
 * names, depths and relations — never file content.
 */
function cachedIntra(version: string, path: string, compute: () => IntraView): IntraView {
  ensureCacheVersion(version)
  const key = `${version}\u0000intra\u0000${path}`
  const hit = l2Cache.get(key)
  if (hit !== undefined) {
    cacheStats.hits += 1
    return hit as IntraView
  }
  cacheStats.misses += 1
  const view = compute()
  cachePut(key, view)
  return view
}

/**
 * Create one request-scoped query.
 *
 * The caller supplies `version`, which must change whenever the graph changes;
 * the HTTP layer derives it with {@link graphVersionOf}. All indexes and the L1
 * map are local to this query, so two requests never share request state.
 */
export function createGraphQuery(input: GraphQueryInput): GraphQuery {
  const scope = input.scope ?? 'workspace'
  const pathByHandle = new Map<string, string>()
  const nodesByPath = new Map<string, GraphNode[]>()
  const fileHandles = new Set<string>()
  for (const node of input.nodes) {
    const path = node.path === undefined ? undefined : normaliseGraphPath(node.path)
    if (path === undefined) continue
    pathByHandle.set(node.handle, path)
    const list = nodesByPath.get(path)
    if (list === undefined) nodesByPath.set(path, [node])
    else list.push(node)
    if (FILE_NODE_KINDS.has(node.kind.trim().toLowerCase())) fileHandles.add(node.handle)
  }

  const paths = [...nodesByPath.keys()]
    .filter((path) => (nodesByPath.get(path) ?? []).some((node) => FILE_NODE_KINDS.has(node.kind.trim().toLowerCase())))
    .sort(compareText)

  // Direct file-level `depends` edges, resolved to workspace-relative paths.
  // External/unresolved targets have no indexed node, so they never enter the
  // graph; directory containment (`contains`/`part_of`) is filtered out here.
  const depsByPath = new Map<string, string[]>()
  for (const edge of input.edges) {
    if (edge.relation !== 'depends') continue
    if (!fileHandles.has(edge.from)) continue
    const from = pathByHandle.get(edge.from)
    const to = pathByHandle.get(edge.to)
    if (from === undefined || to === undefined) continue
    const list = depsByPath.get(from)
    if (list === undefined) depsByPath.set(from, [to])
    else if (!list.includes(to)) list.push(to)
  }

  const l1 = new Map<string, FileFacts>()
  const factsOf = (path: string): FileFacts => {
    const memo = l1.get(path)
    if (memo !== undefined) return memo
    const facts = cachedFacts(input.version, scope, path, () => ({
      imports: specifiersOf(nodesByPath.get(path) ?? [], 'importation'),
      exports: specifiersOf(nodesByPath.get(path) ?? [], 'exportation'),
      deps: [...(depsByPath.get(path) ?? [])],
    }))
    l1.set(path, facts)
    return facts
  }

  return {
    version: input.version,
    scope,
    workspaceRoot: input.workspaceRoot ?? '.',
    nodes: input.nodes,
    edges: input.edges,
    paths,
    factsOf,
  }
}

/** Body-free facts of one path group: specifier names in source order. */
function specifiersOf(nodes: readonly GraphNode[], kind: string): string[] {
  const entries: Array<{ name: string; ordinal: number }> = []
  for (const node of nodes) {
    if (node.kind.trim().toLowerCase() !== kind) continue
    const name = node.name ?? node.label ?? ''
    if (name.length === 0) continue
    entries.push({ name, ordinal: node.ordinal ?? 0 })
  }
  entries.sort((left, right) => left.ordinal - right.ordinal || compareText(left.name, right.name))
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of entries) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    result.push(entry.name)
    if (result.length >= MAX_IMPORT_ENTRIES) break
  }
  return result
}

/**
 * Version string for one snapshot: the row counts plus the newest `changed`
 * stamp. This is the route-side equivalent of the chain engine's monotonic
 * `graphVersion`; a parse writes/updates rows, so the stamp moves with it.
 */
export function graphVersionOf(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  let newest = 0
  for (const node of nodes) {
    if (node.changed !== undefined && node.changed > newest) newest = node.changed
  }
  for (const edge of edges) {
    if (edge.changed !== undefined && edge.changed > newest) newest = edge.changed
  }
  return `${nodes.length}.${edges.length}.${newest}`
}

/* ------------------------------------------------------------------------- *
 * Intra-file symbol projection
 * ------------------------------------------------------------------------- */

/**
 * Document family of `/graph/intra`.
 *
 * It is the `/graph/outline` classifier's family, minus `article`: the intra
 * contract lists five families, and an `article`-classified file keeps the
 * book-family shape, so it is reported as `book` (see {@link intraFamilyOf}).
 */
export type IntraFamily = 'project' | 'tex' | 'book' | 'document' | 'unknown'

/** One symbol node of `/graph/intra`; the file node itself is never listed. */
export interface IntraNode {
  /** Node handle. */
  id: string
  kind: string
  name: string
  /**
   * Nesting depth derived from the in-file `contains`/`part_of` chain: a direct
   * child of the file node is 0 (the file node itself is -1). Clamped to
   * {@link MAX_INTRA_DEPTH}.
   */
  depth: number
}

/** Relations an intra-file edge may carry. */
export type IntraRelation = 'contains' | 'part_of' | 'depends'

/** One edge whose two endpoints are symbol nodes of the same file. */
export interface IntraEdge {
  from: string
  to: string
  relation: IntraRelation
}

/** Value of `GET /graph/intra?path=<file>`. */
export interface IntraView {
  /** Normalised workspace-relative path. */
  path: string
  family: IntraFamily
  nodes: IntraNode[]
  edges: IntraEdge[]
  /** True when the node or edge cap cut the projection. */
  truncated: boolean
}

/** The only relations an intra-file projection keeps. */
const INTRA_RELATIONS: ReadonlySet<string> = new Set(['contains', 'part_of', 'depends'])

/**
 * Build the intra-file symbol graph of one indexed file.
 *
 * Every node whose path is the requested file is listed **except** the file
 * node itself (`module`/`document`/`book`/`article`/`file`). `id` is the node
 * handle and `name` falls back from `name` to `label` to `''`.
 *
 * Edges are restricted to `contains`, `part_of` and `depends` and are emitted
 * only when **both** endpoints are listed symbol nodes of this file. The
 * file→symbol containment edges are therefore depth scaffolding only: they
 * never cross the wire, so every edge endpoint resolves inside `nodes` and no
 * cross-file edge can leak a foreign handle. Direction follows the stored
 * relation exactly: `contains` parent→child, `part_of` child→parent, `depends`
 * as stored.
 *
 * Depth is the **longest** containment path from the file node: the file node
 * is -1, its direct children 0, a class's method 1 even when the chain also
 * contains a direct file→method edge (the most specific nesting wins). Nodes
 * with no containment path (or whose file node is absent) are top-level (0).
 * The traversal is iterative and cycle-safe; longer paths clamp at
 * {@link MAX_INTRA_DEPTH}.
 *
 * Caps: {@link MAX_INTRA_NODES} nodes and {@link MAX_INTRA_EDGES} edges;
 * `truncated` is true when either cap cut the result. The projection contains
 * no content and is cached by `version\0intra\0path`.
 *
 * The path must be valid (`InvalidArgumentError` → 400) and indexed
 * (`NotFoundError` → 404), exactly like the other file-scoped views.
 */
export function buildIntra(query: GraphQuery, requestPath: string): IntraView {
  const path = normaliseGraphPath(requestPath)
  if (path === undefined) {
    throw new InvalidArgumentError('path must be a workspace-relative path without ".."')
  }
  if (!query.paths.includes(path)) throw new NotFoundError('file', path)
  return cachedIntra(query.version, path, () => computeIntra(query, path))
}

/** Project one already-validated path group into an intra-file view. */
function computeIntra(query: GraphQuery, path: string): IntraView {
  const byHandle = new Map<string, GraphNode>()
  const symbols = new Map<string, GraphNode>()
  const fileHandles = new Set<string>()
  const kinds = new Set<string>()
  for (const node of nodesOfPath(query.nodes, path)) {
    const kind = node.kind.trim().toLowerCase()
    byHandle.set(node.handle, node)
    kinds.add(kind)
    if (FILE_NODE_KINDS.has(kind)) fileHandles.add(node.handle)
    else symbols.set(node.handle, node)
  }

  const edges: IntraEdge[] = []
  const seenEdges = new Set<string>()
  // Child → containing parents, both directions normalised to parent→child.
  const parentsOf = new Map<string, Set<string>>()
  for (const edge of query.edges) {
    const relation = edge.relation.trim().toLowerCase()
    if (!INTRA_RELATIONS.has(relation)) continue
    // Both endpoints must belong to this path: this is the only cross-file gate.
    if (!byHandle.has(edge.from) || !byHandle.has(edge.to)) continue
    if (relation !== 'depends') {
      const parent = relation === 'contains' ? edge.from : edge.to
      const child = relation === 'contains' ? edge.to : edge.from
      if (parent !== child) {
        const parents = parentsOf.get(child)
        if (parents === undefined) parentsOf.set(child, new Set([parent]))
        else parents.add(parent)
      }
    }
    // The file node is depth scaffolding, not a symbol: its edges are not emitted.
    if (!symbols.has(edge.from) || !symbols.has(edge.to)) continue
    const key = `${relation}\u0000${edge.from}\u0000${edge.to}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    edges.push({ from: edge.from, to: edge.to, relation: relation as IntraRelation })
  }

  const depthOf = containmentDepths([...symbols.keys()], fileHandles, parentsOf)
  const nodes: IntraNode[] = []
  for (const node of symbols.values()) {
    nodes.push({
      id: node.handle,
      kind: node.kind,
      name: node.name ?? node.label ?? '',
      depth: depthOf.get(node.handle) ?? 0,
    })
  }
  nodes.sort(
    (left, right) =>
      left.depth - right.depth || compareText(left.name, right.name) || compareText(left.id, right.id),
  )
  edges.sort(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.to, right.to) ||
      compareText(left.relation, right.relation),
  )
  return {
    path,
    family: intraFamilyOf(familyOf(path, kinds)),
    nodes: nodes.slice(0, MAX_INTRA_NODES),
    edges: edges.slice(0, MAX_INTRA_EDGES),
    truncated: nodes.length > MAX_INTRA_NODES || edges.length > MAX_INTRA_EDGES,
  }
}

/** Map the outline classifier onto the five documented intra families. */
function intraFamilyOf(family: GraphFamily): IntraFamily {
  // `article` and `book` share the same structural order; the intra contract
  // has no `article`, so an article file keeps the book shape.
  return family === 'article' ? 'book' : family
}

/**
 * Nesting depth of every symbol via its deepest containment path.
 *
 * `roots` are the file-node handles (depth -1) and `parentsOf` maps a child to
 * its already-normalised containing parents, so a `contains` parent→child and a
 * `part_of` child→parent both contribute the same parent edge. The iterative
 * post-order walk ignores back edges (a malformed containment cycle cannot
 * recurse forever) and clamps every answer at {@link MAX_INTRA_DEPTH}; a node
 * with no reachable parent is top-level (0).
 */
function containmentDepths(
  handles: readonly string[],
  roots: ReadonlySet<string>,
  parentsOf: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
  const depth = new Map<string, number>()
  /** 1 = on the explicit stack, 2 = fully resolved. */
  const state = new Map<string, 1 | 2>()
  const parentsFor = (handle: string): string[] => [...(parentsOf.get(handle) ?? [])].sort(compareText)
  for (const start of handles) {
    if (state.has(start)) continue
    const stack: Array<{ handle: string; index: number; parents: readonly string[] }> = [
      { handle: start, index: 0, parents: parentsFor(start) },
    ]
    state.set(start, 1)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as {
        handle: string
        index: number
        parents: readonly string[]
      }
      if (frame.index < frame.parents.length) {
        const parent = frame.parents[frame.index] as string
        frame.index += 1
        if (roots.has(parent) || state.has(parent)) continue
        state.set(parent, 1)
        stack.push({ handle: parent, index: 0, parents: parentsFor(parent) })
        continue
      }
      let best = Number.NEGATIVE_INFINITY
      for (const parent of frame.parents) {
        if (roots.has(parent)) {
          best = Math.max(best, -1)
          continue
        }
        // A parent still on the stack is a containment cycle edge: ignore it.
        if (state.get(parent) !== 2) continue
        const value = depth.get(parent)
        if (value !== undefined) best = Math.max(best, value)
      }
      depth.set(frame.handle, best === Number.NEGATIVE_INFINITY ? 0 : Math.min(best + 1, MAX_INTRA_DEPTH))
      state.set(frame.handle, 2)
      stack.pop()
    }
  }
  return depth
}

/* ------------------------------------------------------------------------- *
 * Dependency projection (with cycle support)
 * ------------------------------------------------------------------------- */

/** One direct file-level dependency edge. */
export interface DependencyLink {
  from: string
  to: string
  relation: string
  /** True when this edge lies on a directed cycle (self-loop included). */
  cyclic: boolean
}

/** Direct dependency rows: links plus the cycles they form. */
export interface DependencyLinks {
  links: DependencyLink[]
  /** Closed cycles (`['a', 'b', 'a']`); a self-loop is `['a', 'a']`. */
  cycles: string[][]
}

/** Value of `GET /graph/dependencies?path=<file>`. */
export interface FileDependencyView extends DependencyLinks {
  scope: 'file'
  path: string
}

/**
 * Value of `GET /graph/dependencies?path=<file>&level=intra`.
 *
 * `links` are the `/graph/intra` `edges` (handles, not paths) plus the `cyclic`
 * flag; `cycles` are enumerated on that same intra-file subgraph.
 */
export interface IntraDependencyView extends DependencyLinks {
  scope: 'file'
  path: string
}

/** Value of `GET /graph/dependencies` (no `path`). */
export interface WorkspaceDependencyView extends DependencyLinks {
  scope: 'workspace'
}

export type DependencyView = FileDependencyView | WorkspaceDependencyView

/** Detail level of `/graph/dependencies`: file rows (default) or in-file symbols. */
export type DependencyLevel = 'file' | 'intra'

/**
 * Project the direct `depends` edges and the cycles they form.
 *
 * With `requestPath` only edges incident to that file are kept and the cycle
 * analysis runs on that **subgraph**, so `A → B → A` still reports a cycle when
 * `A` is the requested file. Without it the whole workspace graph is used.
 * The path must be valid (`InvalidArgumentError` → 400) and indexed
 * (`NotFoundError` → 404).
 *
 * `level: 'intra'` (requires `requestPath`, else `InvalidArgumentError` → 400)
 * switches to the `/graph/intra` symbol subgraph: `links` carry that route's
 * `edges` (handles and `contains`/`part_of`/`depends` relations) and `cycles`
 * are enumerated on the same intra-file adjacency. Because a containment pair
 * is stored as both `contains` parent→child and `part_of` child→parent, such a
 * pair is a directed two-cycle by construction.
 *
 * `links` is capped at {@link MAX_DEPENDENCY_LINKS}; `cycles` at
 * {@link MAX_CYCLES}. `cyclic` is computed from the projected edge set (SCCs),
 * not from the capped cycle list, so an edge inside a large cycle is still
 * flagged when the cycle enumeration budget runs out. No edge is ever removed.
 */
export function buildDependencies(query: GraphQuery): WorkspaceDependencyView
export function buildDependencies(query: GraphQuery, requestPath: string): FileDependencyView
export function buildDependencies(query: GraphQuery, requestPath: string | undefined): DependencyView
export function buildDependencies(query: GraphQuery, requestPath: string | undefined, level: 'file'): DependencyView
export function buildDependencies(query: GraphQuery, requestPath: string, level: 'intra'): IntraDependencyView
export function buildDependencies(
  query: GraphQuery,
  requestPath: string | undefined,
  level: 'intra',
): IntraDependencyView
export function buildDependencies(
  query: GraphQuery,
  requestPath?: string,
  level?: DependencyLevel,
): DependencyView | IntraDependencyView {
  if (level === 'intra') {
    if (requestPath === undefined) {
      throw new InvalidArgumentError('path is required when level=intra')
    }
    const view = buildIntra(query, requestPath)
    return { scope: 'file', path: view.path, ...intraDependencyProjection(view.edges) }
  }
  if (level !== undefined && level !== 'file') {
    throw new InvalidArgumentError('level must be "file" or "intra"')
  }
  const adjacency = new Map<string, string[]>()
  for (const path of query.paths) {
    const deps = [...query.factsOf(path).deps].sort(compareText)
    if (deps.length > 0) adjacency.set(path, deps)
  }

  if (requestPath === undefined) {
    return { scope: 'workspace', ...dependencyProjection(adjacency) }
  }
  const path = normaliseGraphPath(requestPath)
  if (path === undefined) {
    throw new InvalidArgumentError('path must be a workspace-relative path without ".."')
  }
  if (!query.paths.includes(path)) throw new NotFoundError('file', path)
  const subgraph = new Map<string, string[]>()
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      if (from !== path && to !== path) continue
      const list = subgraph.get(from)
      if (list === undefined) subgraph.set(from, [to])
      else list.push(to)
    }
  }
  return { scope: 'file', path, ...dependencyProjection(subgraph) }
}

/**
 * Dependency view over the intra-file symbol subgraph.
 *
 * `links` preserve the `/graph/intra` edge order and relations, adding the
 * `cyclic` flag; the adjacency for `cycles` is that same edge set, deduplicated
 * per ordered pair (two relations between the same pair remain separate links
 * but repeat no traversal step).
 */
function intraDependencyProjection(edges: readonly IntraEdge[]): DependencyLinks {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = adjacency.get(edge.from)
    if (targets === undefined) {
      adjacency.set(edge.from, [edge.to])
      continue
    }
    if (!targets.includes(edge.to)) targets.push(edge.to)
  }
  const nodes = collectNodes(adjacency)
  const cyclic = cyclicEdges(adjacency, nodes)
  const links: DependencyLink[] = edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    cyclic: cyclic.has(edgeKey(edge.from, edge.to)),
  }))
  return {
    links: links.slice(0, MAX_DEPENDENCY_LINKS),
    cycles: findCycles(adjacency, nodes),
  }
}

/** Links + cycles of one already-built dependency adjacency. */
function dependencyProjection(adjacency: ReadonlyMap<string, readonly string[]>): DependencyLinks {
  const nodes = collectNodes(adjacency)
  const cyclic = cyclicEdges(adjacency, nodes)
  const links: DependencyLink[] = []
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      links.push({ from, to, relation: 'depends', cyclic: cyclic.has(edgeKey(from, to)) })
    }
  }
  links.sort((left, right) => compareText(left.from, right.from) || compareText(left.to, right.to))
  return {
    links: links.slice(0, MAX_DEPENDENCY_LINKS),
    cycles: findCycles(adjacency, nodes),
  }
}

/** Every node mentioned by the dependency adjacency, sorted. */
function collectNodes(adjacency: ReadonlyMap<string, readonly string[]>): string[] {
  const nodes = new Set<string>()
  for (const [from, targets] of adjacency) {
    nodes.add(from)
    for (const to of targets) nodes.add(to)
  }
  return [...nodes].sort(compareText)
}

/**
 * Edges that lie on a directed cycle.
 *
 * Strongly connected components are computed with iterative Kosaraju (two
 * explicit-stack DFS passes, white/gray/black in the first). An edge is cyclic
 * when both endpoints share a component and that component has at least two
 * vertices; a self-loop is cyclic on its own.
 */
function cyclicEdges(
  adjacency: ReadonlyMap<string, readonly string[]>,
  nodes: readonly string[],
): Set<string> {
  const color = new Map<string, Color>()
  const finishOrder: string[] = []
  for (const start of nodes) {
    if ((color.get(start) ?? Color.White) !== Color.White) continue
    color.set(start, Color.Gray)
    const stack: Array<{ node: string; index: number }> = [{ node: start, index: 0 }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { node: string; index: number }
      const neighbours = adjacency.get(frame.node) ?? EMPTY_NEIGHBOURS
      if (frame.index < neighbours.length) {
        const next = neighbours[frame.index] as string
        frame.index += 1
        if ((color.get(next) ?? Color.White) === Color.White) {
          color.set(next, Color.Gray)
          stack.push({ node: next, index: 0 })
        }
        continue
      }
      color.set(frame.node, Color.Black)
      finishOrder.push(frame.node)
      stack.pop()
    }
  }

  const reverse = new Map<string, string[]>()
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      const list = reverse.get(to)
      if (list === undefined) reverse.set(to, [from])
      else list.push(from)
    }
  }

  const component = new Map<string, number>()
  const sizes: number[] = []
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const start = finishOrder[index] as string
    if (component.has(start)) continue
    const identity = sizes.length
    let size = 0
    const stack = [start]
    component.set(start, identity)
    while (stack.length > 0) {
      const node = stack.pop() as string
      size += 1
      for (const previous of reverse.get(node) ?? EMPTY_NEIGHBOURS) {
        if (component.has(previous)) continue
        component.set(previous, identity)
        stack.push(previous)
      }
    }
    sizes.push(size)
  }

  const cyclic = new Set<string>()
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      if (from === to) {
        cyclic.add(edgeKey(from, to))
        continue
      }
      const identity = component.get(from)
      if (identity === undefined || identity !== component.get(to)) continue
      if ((sizes[identity] ?? 0) > 1) cyclic.add(edgeKey(from, to))
    }
  }
  return cyclic
}

/**
 * Enumerate simple cycles, lexicographically, up to {@link MAX_CYCLES}.
 *
 * Iterative DFS from each possible minimum node (a cycle is only emitted from
 * its lexicographically smallest vertex, which removes rotations). The path is
 * held in an explicit stack; `onPath` is the gray set, so a back edge closes a
 * cycle. Both a step budget and a candidate budget keep a pathological graph
 * bounded; output is then sorted and capped.
 */
function findCycles(
  adjacency: ReadonlyMap<string, readonly string[]>,
  nodes: readonly string[],
): string[][] {
  const found = new Map<string, string[]>()
  let steps = 0
  for (const start of nodes) {
    if (steps >= MAX_CYCLE_STEPS || found.size >= MAX_CYCLE_CANDIDATES) break
    const onPath = new Set<string>([start])
    const path: string[] = [start]
    const stack: Array<{ node: string; index: number }> = [{ node: start, index: 0 }]
    while (stack.length > 0) {
      steps += 1
      if (steps >= MAX_CYCLE_STEPS) break
      const frame = stack[stack.length - 1] as { node: string; index: number }
      const neighbours = adjacency.get(frame.node) ?? EMPTY_NEIGHBOURS
      if (frame.index >= neighbours.length) {
        stack.pop()
        onPath.delete(frame.node)
        path.pop()
        continue
      }
      const next = neighbours[frame.index] as string
      frame.index += 1
      if (next === start) {
        const cycle = rotateCycle([...path, start])
        const key = cycle.join('\u0000')
        if (!found.has(key)) found.set(key, cycle)
        if (found.size >= MAX_CYCLE_CANDIDATES) break
        continue
      }
      if (next < start || onPath.has(next)) continue
      onPath.add(next)
      path.push(next)
      stack.push({ node: next, index: 0 })
    }
  }
  return [...found.values()].sort(compareCycles).slice(0, MAX_CYCLES)
}

/** Rotate a closed cycle so its smallest path comes first (rotation dedupe). */
function rotateCycle(cycle: readonly string[]): string[] {
  const body = cycle.slice(0, -1)
  if (body.length === 0) return [...cycle]
  let best = 0
  for (let index = 1; index < body.length; index += 1) {
    if ((body[index] as string) < (body[best] as string)) best = index
  }
  const rotated = [...body.slice(best), ...body.slice(0, best)]
  return [...rotated, rotated[0] as string]
}

function compareCycles(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const order = compareText(left[index] as string, right[index] as string)
    if (order !== 0) return order
  }
  return left.length - right.length
}

/* ------------------------------------------------------------------------- *
 * Import/export projection
 * ------------------------------------------------------------------------- */

/** One row of `GET /graph/imports`. */
export interface ImportRow {
  path: string
  imported: string[]
  exported: string[]
}

/** Value of `GET /graph/imports?path=<file>`. */
export interface FileImportsView {
  scope: 'file'
  path: string
  rows: ImportRow[]
}

/** Value of `GET /graph/imports` (no `path`). */
export interface WorkspaceImportsView {
  scope: 'workspace'
  rows: ImportRow[]
}

export type ImportsView = FileImportsView | WorkspaceImportsView

/**
 * Project `importation`/`exportation` nodes into per-file rows.
 *
 * With `requestPath` exactly one row is returned for that file (empty lists
 * when it has no import/export nodes); the path must be valid
 * (`InvalidArgumentError` → 400) and indexed (`NotFoundError` → 404). Without
 * it rows are sorted by path and capped at {@link MAX_IMPORT_ROWS}. Each list is
 * deduplicated, source-ordered and capped at {@link MAX_IMPORT_ENTRIES}. A file
 * inside a dependency cycle keeps its complete lists — cycles are reported by
 * `/graph/dependencies` and never repaired by deleting an import.
 */
export function buildImports(query: GraphQuery): WorkspaceImportsView
export function buildImports(query: GraphQuery, requestPath: string): FileImportsView
export function buildImports(query: GraphQuery, requestPath: string | undefined): ImportsView
export function buildImports(query: GraphQuery, requestPath?: string): ImportsView {
  if (requestPath !== undefined) {
    const path = normaliseGraphPath(requestPath)
    if (path === undefined) {
      throw new InvalidArgumentError('path must be a workspace-relative path without ".."')
    }
    if (!query.paths.includes(path)) throw new NotFoundError('file', path)
    const facts = query.factsOf(path)
    return {
      scope: 'file',
      path,
      rows: [{ path, imported: [...facts.imports], exported: [...facts.exports] }],
    }
  }
  const rows: ImportRow[] = []
  for (const path of query.paths) {
    const facts = query.factsOf(path)
    if (facts.imports.length === 0 && facts.exports.length === 0) continue
    rows.push({ path, imported: [...facts.imports], exported: [...facts.exports] })
    if (rows.length >= MAX_IMPORT_ROWS) break
  }
  return { scope: 'workspace', rows }
}

/* ------------------------------------------------------------------------- *
 * Search projection
 * ------------------------------------------------------------------------- */

/** One `GET /graph/search` hit. */
export interface SearchHit {
  handle: string
  kind: string
  name: string
  path: string
  line: number
}

/**
 * Case-insensitive substring search over node `name`, `label` and `path`.
 *
 * An empty/blank query returns no hits (never the whole graph). The cap is
 * `limit` (default {@link DEFAULT_SEARCH_LIMIT}), clamped to
 * {@link MAX_SEARCH_LIMIT}; hits are sorted by path, line, kind and handle so
 * pagination-free clients see a stable order.
 */
export function searchGraph(
  nodes: readonly GraphNode[],
  query: string,
  limit: unknown = DEFAULT_SEARCH_LIMIT,
): SearchHit[] {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle.length === 0) return []
  const cap = searchLimit(limit)
  if (cap === 0) return []
  const hits: SearchHit[] = []
  for (const node of nodes) {
    const name = node.name ?? ''
    const label = node.label ?? ''
    const path = node.path ?? ''
    if (
      !name.toLowerCase().includes(needle) &&
      !label.toLowerCase().includes(needle) &&
      !path.toLowerCase().includes(needle)
    ) {
      continue
    }
    hits.push({
      handle: node.handle,
      kind: node.kind,
      name,
      path,
      line: node.line ?? 0,
    })
  }
  hits.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      left.line - right.line ||
      compareText(left.kind, right.kind) ||
      compareText(left.handle, right.handle),
  )
  return hits.slice(0, cap)
}

/** Normalise a search limit: default 50, integer 0..200. */
function searchLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_LIMIT
  return Math.min(MAX_SEARCH_LIMIT, Math.max(0, Math.trunc(parsed)))
}

/* ------------------------------------------------------------------------- *
 * Agent roster and transcript projections (read-only host records)
 * ------------------------------------------------------------------------- */

/** Maximum agents one roster response contains. */
export const MAX_AGENT_ROSTER = 200
/** Completed-turn count at which a running agent's estimate reaches its cap. */
export const TURN_CEILING = 12
/** Maximum messages one transcript response contains. */
export const MAX_AGENT_MESSAGES = 200
/** Maximum UTF-8 bytes across all returned transcript message text (64 KiB). */
export const MAX_AGENT_TRANSCRIPT_BYTES = 64 * 1024
/** Maximum UTF-8 bytes of one transcript message text (8 KiB). */
export const MAX_AGENT_MESSAGE_BYTES = 8 * 1024
/** Maximum characters retained for one roster objective. */
export const MAX_AGENT_OBJECTIVE_CHARS = 2_000
/** Maximum characters retained for one roster label. */
export const MAX_AGENT_LABEL_CHARS = 200
/** Bound on cold one-shot completion probes per roster request. */
export const MAX_AGENT_COMPLETION_PROBES = 20

/** The only two statuses the roster contract exposes. */
export type AgentStatus = 'running' | 'inactive'

/** Why an estimated progress value has the value it has. */
export type AgentProgressBasis = 'completed' | 'turns' | 'unknown'

/**
 * One estimated progress value.
 *
 * Every value is explicitly `estimated: true`: the UI renders "estimated"
 * wording and must not treat it as a real completion percentage. The estimate
 * is deterministic and derived only from existing host records — never from a
 * model call or a wall-clock guess.
 */
export interface AgentProgress {
  value: number
  estimated: true
  basis: AgentProgressBasis
}

/** One host-record row before projection (may be partially populated). */
export interface AgentRosterInput {
  /** Session / agent id. */
  id: string
  /** Human label or title from the host; the builder falls back to a short id. */
  label?: string
  status?: AgentStatus
  /** Task/objective text from the host; the builder returns `''` when absent. */
  objective?: string
  parentId?: string
  /** ISO timestamp of the session's creation. */
  startedAt?: string
  /**
   * ISO timestamp of a definite completion. Only a durable terminal record
   * should supply this; an idle live agent is not complete.
   */
  completedAt?: string
  /** Completed turns from the host's own session record; absent when unknown. */
  turns?: number
}

/** One `/graph/agents` entry. */
export interface AgentRosterEntry {
  id: string
  label: string
  status: AgentStatus
  objective: string
  parentId?: string
  startedAt?: string
  completedAt?: string
  progress: AgentProgress
}

/** Value of `GET /graph/agents`. */
export interface AgentRosterSummary {
  agents: AgentRosterEntry[]
  progress: {
    /** Arithmetic mean of the returned agents' estimates, rounded. */
    value: number
    estimated: true
    running: number
    total: number
  }
}

/** One roster source snapshot: records plus the main-session hint. */
export interface AgentRosterSnapshot {
  /** First live top-level agent, when the agent registry is mounted. */
  mainSessionId?: string
  records: AgentRosterInput[]
}

/** Roles the transcript contract allows; `system` covers `system/message` and `developer/message`. */
export type AgentMessageRole = 'user' | 'assistant' | 'tool' | 'system'

/** One bounded transcript message. */
export interface AgentMessage {
  role: AgentMessageRole
  /** ISO event timestamp when the host recorded one. */
  at?: string
  text: string
}

/** Value of `GET /graph/agents/messages?id=<agent id>`. */
export interface AgentTranscript {
  id: string
  messages: AgentMessage[]
  /** True when a count/byte/total cap or a per-message cap cut the transcript. */
  truncated: boolean
}

/**
 * The subset of a durable session event the transcript projection reads.
 * Structural only: no DSH type is imported and unknown/malformed events are
 * ignored rather than trusted.
 */
export interface AgentSessionEventLike {
  readonly type?: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

/** Optional Cordis services the agent routes read; every one is capability-optional. */
export interface AgentServiceBundle {
  agents?: unknown
  sessions?: unknown
  subagents?: unknown
  sessionQuery?: unknown
  goals?: unknown
  sessionProjections?: unknown
  sessionProjectionCache?: unknown
  sessionPersistence?: unknown
}

/** One pure route result, including the mandatory no-store header. */
export interface AgentMessagesRouteResult {
  status: 200 | 400 | 404
  headers: { readonly 'cache-control': 'no-store' }
  body:
    | { ok: true; value: AgentTranscript }
    | { ok: false; error: { code: 'INVALID_ARGUMENT' | 'NOT_FOUND'; message: string } }
}

/**
 * Project the host's own agent/session records into the roster.
 *
 * Order is deterministic: the main session first, then its descendants in
 * pre-order (catalog order), then every remaining known record in source order;
 * duplicates and empty ids are dropped and the result is capped at
 * {@link MAX_AGENT_ROSTER}. The main session is the caller's explicit hint when
 * it names a known record, else the first record without a known parent.
 *
 * `label` falls back to a short id and `objective` to `''`; neither is
 * synthesized. Progress is computed by {@link agentProgressOf}:
 *
 *  - `completedAt` present → `100`, basis `completed`;
 *  - running with a known turn count → `min(95, 5 + 90 * turns / 12)`,
 *    basis `turns`;
 *  - otherwise → `0`, basis `unknown`.
 *
 * The summary's `value` is the rounded arithmetic mean of the returned agents'
 * values (0 for an empty roster); `running`/`total` count the returned agents.
 */
export function buildAgentRoster(
  records: readonly AgentRosterInput[],
  mainSessionId?: string,
): AgentRosterSummary {
  const byId = new Map<string, AgentRosterInput>()
  const sourceOrder: string[] = []
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const id = trimmedText(record.id)
    if (id === undefined || byId.has(id)) continue
    byId.set(id, record)
    sourceOrder.push(id)
  }

  const childrenOf = new Map<string, string[]>()
  for (const id of sourceOrder) {
    const parentId = trimmedText(byId.get(id)?.parentId)
    if (parentId === undefined || parentId === id || !byId.has(parentId)) continue
    const children = childrenOf.get(parentId)
    if (children === undefined) childrenOf.set(parentId, [id])
    else children.push(id)
  }

  const main = effectiveMainId(byId, sourceOrder, mainSessionId)
  const ordered: string[] = []
  const seen = new Set<string>()
  const stack: string[] = main === undefined ? [] : [main]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
    const children = childrenOf.get(id) ?? []
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index] as string
      if (!seen.has(child)) stack.push(child)
    }
  }
  for (const id of sourceOrder) {
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }

  const agents: AgentRosterEntry[] = []
  for (const id of ordered.slice(0, MAX_AGENT_ROSTER)) {
    const record = byId.get(id) as AgentRosterInput
    agents.push(rosterEntryOf(id, record))
  }
  const running = agents.reduce((count, entry) => count + (entry.status === 'running' ? 1 : 0), 0)
  const total = agents.length
  const value = total === 0
    ? 0
    : Math.round(agents.reduce((sum, entry) => sum + entry.progress.value, 0) / total)
  return { agents, progress: { value, estimated: true, running, total } }
}

/** Project one validated roster row; optional fields are only emitted when known. */
function rosterEntryOf(id: string, record: AgentRosterInput): AgentRosterEntry {
  const status: AgentStatus = record.status === 'running' ? 'running' : 'inactive'
  const labelText = trimmedText(record.label)
  const label = labelText === undefined ? shortAgentId(id) : clipChars(labelText, MAX_AGENT_LABEL_CHARS)
  const objectiveText = trimmedText(record.objective)
  const entry: AgentRosterEntry = {
    id,
    label,
    status,
    objective: objectiveText === undefined ? '' : clipChars(objectiveText, MAX_AGENT_OBJECTIVE_CHARS),
    progress: agentProgressOf(record),
  }
  const parentId = trimmedText(record.parentId)
  if (parentId !== undefined && parentId !== id) entry.parentId = parentId
  const startedAt = isoTime(record.startedAt)
  if (startedAt !== undefined) entry.startedAt = startedAt
  const completedAt = isoTime(record.completedAt)
  if (completedAt !== undefined) entry.completedAt = completedAt
  return entry
}

/**
 * Deterministic, explainable progress estimate.
 *
 * `completedAt` is the only positive completion evidence, so it wins over a
 * running status. A running agent with a turn count grows linearly from 5 to
 * the 95 cap at {@link TURN_CEILING} completed turns; without a host turn count
 * it stays `unknown` (0). An inactive agent without a completion timestamp is
 * also `unknown` (0) — idle is not complete.
 */
export function agentProgressOf(record: AgentRosterInput): AgentProgress {
  if (isoTime(record.completedAt) !== undefined) {
    return { value: 100, estimated: true, basis: 'completed' }
  }
  if (record.status !== 'running') {
    return { value: 0, estimated: true, basis: 'unknown' }
  }
  const turns = normaliseTurns(record.turns)
  if (turns === undefined) {
    return { value: 0, estimated: true, basis: 'unknown' }
  }
  return {
    value: Math.min(95, 5 + (90 * turns) / TURN_CEILING),
    estimated: true,
    basis: 'turns',
  }
}

/** The explicit main id when known, else the first record with no known parent. */
function effectiveMainId(
  byId: ReadonlyMap<string, AgentRosterInput>,
  sourceOrder: readonly string[],
  mainSessionId: string | undefined,
): string | undefined {
  const explicit = trimmedText(mainSessionId)
  if (explicit !== undefined && byId.has(explicit)) return explicit
  for (const id of sourceOrder) {
    const parentId = trimmedText(byId.get(id)?.parentId)
    if (parentId === undefined || parentId === id || !byId.has(parentId)) return id
  }
  return undefined
}

/** Short structural id label when the host supplies no human label. */
function shortAgentId(id: string): string {
  return id.length <= 16 ? id : id.slice(0, 16)
}

/**
 * Build the bounded transcript for one known session id.
 *
 * Newest messages win: the log is walked backwards and the response keeps at
 * most {@link MAX_AGENT_MESSAGES} messages and
 * {@link MAX_AGENT_TRANSCRIPT_BYTES} UTF-8 bytes of text, with each message
 * capped at {@link MAX_AGENT_MESSAGE_BYTES}. `truncated` is true when an older
 * message or a message tail was dropped.
 *
 * Only `user/message`, `assistant/message`, `system/message`,
 * `developer/message` and `tool/result` events are read. Text blocks are
 * returned; image blocks, reasoning blocks, tool-call arguments and unknown
 * block types are never returned. A text block containing a NUL or
 * an unexpected C0 control character is treated as binary and dropped. The
 * function never throws for malformed events; it throws `NOT_FOUND` only when
 * the caller could not resolve the id (`events === undefined`).
 */
export function buildAgentTranscript(
  id: string,
  events: readonly AgentSessionEventLike[] | undefined,
): AgentTranscript {
  if (events === undefined) throw new NotFoundError('agent', id)
  const kept: AgentMessage[] = []
  let totalBytes = 0
  let truncated = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const message = messageOfEvent(events[index])
    if (message === undefined) continue
    let text = message.text
    if (utf8ByteLength(text) > MAX_AGENT_MESSAGE_BYTES) {
      text = clipPreviewUtf8Bytes(text, MAX_AGENT_MESSAGE_BYTES)
      truncated = true
    }
    const bytes = utf8ByteLength(text)
    if (kept.length >= MAX_AGENT_MESSAGES || totalBytes + bytes > MAX_AGENT_TRANSCRIPT_BYTES) {
      truncated = true
      break
    }
    kept.push(text === message.text ? message : { ...message, text })
    totalBytes += bytes
  }
  kept.reverse()
  return { id, messages: kept, truncated }
}

/** Project one event to a transcript message, or `undefined` when it has no text. */
function messageOfEvent(event: unknown): AgentMessage | undefined {
  const record = recordOf(event)
  if (record === undefined) return undefined
  const type = typeof record['type'] === 'string' ? record['type'] : ''
  let role: AgentMessageRole | undefined
  let content: unknown
  const data = recordOf(record['data'])
  if (type === 'user/message') {
    role = 'user'
    // A user/message payload IS the message (content + source).
    content = data?.['content']
  } else if (type === 'assistant/message') {
    role = 'assistant'
    content = recordOf(data?.['message'])?.['content']
  } else if (type === 'system/message' || type === 'developer/message') {
    role = 'system'
    content = recordOf(data?.['message'])?.['content']
  } else if (type === 'tool/result') {
    role = 'tool'
    content = recordOf(data?.['message'])?.['content']
  }
  if (role === undefined) return undefined
  const text = contentTextOf(content)
  if (text.trim().length === 0) return undefined
  const message: AgentMessage = { role, text }
  const at = isoTime(record['time'])
  if (at !== undefined) message.at = at
  return message
}

/** Extract visible text blocks; non-text/binary blocks are deliberately skipped. */
function contentTextOf(value: unknown, depth = 0): string {
  if (!Array.isArray(value) || depth > 4) return ''
  const texts: string[] = []
  for (const item of value) {
    const block = recordOf(item)
    if (block === undefined) continue
    const type = typeof block['type'] === 'string' ? block['type'] : ''
    if (type === 'text') {
      const text = typeof block['text'] === 'string' ? block['text'] : ''
      if (text.length > 0 && !isBinaryText(text)) texts.push(text)
      continue
    }
    // Tool results can nest their own content blocks; recurse only into those.
    if (type === 'tool-result' && Array.isArray(block['content'])) {
      const nested = contentTextOf(block['content'], depth + 1)
      if (nested.length > 0) texts.push(nested)
    }
  }
  return texts.join('\n')
}

/** NUL or an unexpected C0/DEL control character marks a binary-looking text block. */
function isBinaryText(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
}

/**
 * Pure route contract for `GET /graph/agents/messages`.
 *
 * Missing/blank `id` is 400 `INVALID_ARGUMENT`; a non-resolved id is 404
 * `NOT_FOUND`; a known id (even an empty log) is 200 with the bounded
 * transcript. Every result carries `cache-control: no-store`, including the
 * error responses; the route never caches a body.
 */
export function agentMessagesRoute(
  idValue: string | null | undefined,
  events: readonly AgentSessionEventLike[] | undefined,
): AgentMessagesRouteResult {
  const headers = { 'cache-control': 'no-store' } as const
  const id = trimmedText(idValue)
  if (id === undefined) {
    return {
      status: 400,
      headers,
      body: { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'id is required' } },
    }
  }
  if (events === undefined) {
    return {
      status: 404,
      headers,
      body: { ok: false, error: { code: 'NOT_FOUND', message: `agent ${id} was not found` } },
    }
  }
  return { status: 200, headers, body: { ok: true, value: buildAgentTranscript(id, events) } }
}

/**
 * Read-only roster collection over the optional host services.
 *
 * The main session is the first live top-level agent (`agents.roots()`), then
 * the first live agent, then the first live session. Descendants come from
 * `subagents.listDescendants(main)`; remaining live agents/sessions follow in
 * their service order. The `agents` registry is the primary capability: without
 * it the roster is empty (sessions alone cannot answer main/status), and every
 * other source is capability-optional too. A missing service or a throwing read
 * contributes nothing, so this function never throws and either absence yields
 * `{ records: [] }` rather than a fabricated roster.
 *
 * Titles and turn counts are read from the host's `title` / `sessionStats`
 * projections when the projection registry is mounted. For a cold one-shot
 * subagent, the final durable `turn/end` time is the only completion evidence
 * the host persists; at most {@link MAX_AGENT_COMPLETION_PROBES} such cold logs
 * are inspected. No write/send/resume method is ever called.
 */
export async function collectAgentRoster(services: AgentServiceBundle): Promise<AgentRosterSnapshot> {
  // The agent registry is the primary capability: without it there is no
  // authoritative live/status/main-session answer, so the contract's documented
  // capability-absence response is an empty roster (never a guessed one built
  // from sessions alone).
  if (services.agents === undefined || services.agents === null) return { records: [] }
  const agents = serviceList(services.agents, 'list')
  const roots = serviceList(services.agents, 'roots')
  const sessions = serviceList(services.sessions, 'list')
  const agentById = recordsById(agents)
  const sessionById = recordsById(sessions)
  const mainSessionId = mainSessionIdOf(roots, agentById, sessionById)

  const childById = new Map<string, Record<string, unknown>>()
  if (mainSessionId !== undefined) {
    const descendants = await serviceCallAsyncSafe(services.subagents, 'listDescendants', mainSessionId)
    for (const entry of asUnknownArray(descendants)) {
      const record = recordOf(entry)
      // Diagnostics carry no child identity; every other descendant row does.
      if (record === undefined || record['kind'] === 'diagnostic') continue
      const id = trimmedText(record['id'])
      if (id !== undefined && !childById.has(id)) childById.set(id, record)
    }
  }

  const liveIds = new Set<string>([...agentById.keys(), ...sessionById.keys()])
  const needsColdHeader = [...childById.keys()].some((id) => !liveIds.has(id))
  const headerById = new Map<string, Record<string, unknown>>()
  if (needsColdHeader) {
    const listed = await serviceCallAsyncSafe(services.sessionQuery, 'listSessions')
    for (const item of asUnknownArray(listed)) {
      const header = recordOf(recordOf(item)?.['header'])
      if (header === undefined) continue
      const id = trimmedText(header['id'])
      if (id !== undefined && !headerById.has(id)) headerById.set(id, header)
    }
  }

  const order: string[] = []
  const seen = new Set<string>()
  const add = (id: string | undefined): void => {
    if (id === undefined || seen.has(id)) return
    seen.add(id)
    order.push(id)
  }
  add(mainSessionId)
  for (const id of childById.keys()) add(id)
  for (const id of agentById.keys()) add(id)
  for (const id of sessionById.keys()) add(id)

  const records: AgentRosterInput[] = []
  let probes = 0
  for (const id of order.slice(0, MAX_AGENT_ROSTER)) {
    const agent = agentById.get(id) ?? liveAgentOf(services, id)
    const session = sessionById.get(id) ?? liveSessionOf(services, id) ?? recordOf(agent?.['session'])
    const header = sessionHeaderOf(session) ?? headerById.get(id)
    const child = childById.get(id)
    const status: AgentStatus = agent?.['status'] === 'running' ? 'running' : 'inactive'
    const startedAt = isoTime(numberOf(header?.['createdAt']) ?? numberOf(child?.['createdAt']))
    const parentId = trimmedText(child?.['parentId']) ?? trimmedText(header?.['parentSession'])
    const objective = goalObjectiveOf(services, agent) ?? objectiveFromSession(session)
    const label = trimmedText(child?.['label']) ?? titleOf(services, session, header)
    const turns = status === 'running' ? turnsOf(services, session) : undefined
    let completedAt: string | undefined
    if (status !== 'running' && child?.['mode'] === 'one-shot') {
      completedAt = finalTurnTime(sessionEventsOf(session))
      if (completedAt === undefined && session === undefined && probes < MAX_AGENT_COMPLETION_PROBES) {
        probes += 1
        completedAt = await storedCompletionTime(services, id)
      }
    }
    const record: AgentRosterInput = { id, status }
    if (label !== undefined) record.label = label
    if (objective !== undefined) record.objective = objective
    if (parentId !== undefined) record.parentId = parentId
    if (startedAt !== undefined) record.startedAt = startedAt
    if (completedAt !== undefined) record.completedAt = completedAt
    if (turns !== undefined) record.turns = turns
    records.push(record)
  }
  return mainSessionId === undefined ? { records } : { mainSessionId, records }
}

/**
 * Resolve one known agent id to its durable event log through the optional
 * host services, live-preferred. Returns `undefined` when no mounted service
 * knows the id (→ route 404); host failures other than a typed not-found are
 * rethrown (→ route 500). Never writes, resumes or activates anything.
 */
export async function resolveAgentSessionEvents(
  services: AgentServiceBundle,
  id: string,
): Promise<readonly AgentSessionEventLike[] | undefined> {
  const liveEvents = sessionEventsOf(liveSessionOf(services, id))
  if (liveEvents !== undefined) return liveEvents

  const readSession = serviceMethod(services.sessionQuery, 'readSession')
  if (readSession !== undefined) {
    try {
      const result = await readSession.call(services.sessionQuery, id)
      const events = recordOf(result)?.['events']
      if (Array.isArray(events)) return events as readonly AgentSessionEventLike[]
    } catch (error) {
      if (isNotFoundError(error)) return undefined
      throw error
    }
  }

  const observeSession = serviceMethod(services.sessionQuery, 'observeSession')
  if (observeSession !== undefined) {
    let lease: unknown
    try {
      lease = await observeSession.call(services.sessionQuery, id, { projectionMode: 'none' })
      const events = recordOf(lease)?.['events']
      if (Array.isArray(events)) return events as readonly AgentSessionEventLike[]
    } catch (error) {
      if (isNotFoundError(error)) return undefined
      throw error
    } finally {
      disposeObservation(lease)
    }
  }

  // Older persistence seams expose `inspect` (no repair/commit). `load` is
  // deliberately not used: it may durably close a torn tail, and this route is
  // read-only. The session-query path above is the normal host read path.
  const inspect = serviceMethod(services.sessionPersistence, 'inspect')
  if (inspect !== undefined) {
    try {
      const result = await inspect.call(services.sessionPersistence, id)
      const events = recordOf(result)?.['events']
      if (Array.isArray(events)) return events as readonly AgentSessionEventLike[]
    } catch (error) {
      if (isNotFoundError(error)) return undefined
      throw error
    }
  }
  return undefined
}

/* ------------------------------------------------------------------------- *
 * Agent host-adapter helpers (structural; no DSH imports)
 * ------------------------------------------------------------------------- */

type UnknownRecord = Record<string, unknown>
type ServiceCallable = (...args: unknown[]) => unknown

function recordOf(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function trimmedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normaliseTurns(value: unknown): number | undefined {
  const turns = numberOf(value)
  return turns === undefined || turns < 0 ? undefined : Math.floor(turns)
}

function asUnknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function clipChars(value: string, limit: number): string {
  if (value.length <= limit) return value
  let end = limit
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return value.slice(0, end)
}

function serviceMethod(service: unknown, name: string): ServiceCallable | undefined {
  const record = recordOf(service)
  if (record === undefined) return undefined
  const value = record[name]
  return typeof value === 'function' ? (value as ServiceCallable) : undefined
}

function serviceCallSafe(service: unknown, name: string, ...args: unknown[]): unknown {
  const method = serviceMethod(service, name)
  if (method === undefined) return undefined
  try {
    return method.apply(service, args)
  } catch {
    return undefined
  }
}

async function serviceCallAsyncSafe(
  service: unknown,
  name: string,
  ...args: unknown[]
): Promise<unknown | undefined> {
  const method = serviceMethod(service, name)
  if (method === undefined) return undefined
  try {
    return await method.apply(service, args)
  } catch {
    return undefined
  }
}

function serviceList(service: unknown, name: string): readonly unknown[] {
  return asUnknownArray(serviceCallSafe(service, name))
}

function recordsById(list: readonly unknown[]): Map<string, UnknownRecord> {
  const map = new Map<string, UnknownRecord>()
  for (const item of list) {
    const record = recordOf(item)
    const id = trimmedText(record?.['id'])
    if (id !== undefined && !map.has(id)) map.set(id, record as UnknownRecord)
  }
  return map
}

function mainSessionIdOf(
  roots: readonly unknown[],
  agentById: ReadonlyMap<string, UnknownRecord>,
  sessionById: ReadonlyMap<string, UnknownRecord>,
): string | undefined {
  for (const root of roots) {
    const id = trimmedText(recordOf(root)?.['id'])
    if (id !== undefined) return id
  }
  const firstAgent = agentById.keys().next().value
  if (firstAgent !== undefined) return firstAgent
  return sessionById.keys().next().value
}

function liveSessionOf(services: AgentServiceBundle, id: string): unknown {
  const get = serviceMethod(services.sessions, 'get')
  if (get === undefined) return undefined
  try {
    return get.call(services.sessions, id)
  } catch {
    return undefined
  }
}

function liveAgentOf(services: AgentServiceBundle, id: string): UnknownRecord | undefined {
  const get = serviceMethod(services.agents, 'get')
  if (get === undefined) return undefined
  try {
    return recordOf(get.call(services.agents, id))
  } catch {
    return undefined
  }
}

function sessionHeaderOf(session: unknown): UnknownRecord | undefined {
  return recordOf(recordOf(session)?.['header'])
}

/** DSH 0.2.x exposes `snapshotEvents()`; older surfaces exposed `events`. */
function sessionEventsOf(session: unknown): readonly AgentSessionEventLike[] | undefined {
  const record = recordOf(session)
  if (record === undefined) return undefined
  const snapshot = record['snapshotEvents']
  if (typeof snapshot === 'function') {
    try {
      const events = (snapshot as ServiceCallable).call(session)
      if (Array.isArray(events)) return events as readonly AgentSessionEventLike[]
    } catch {
      // Fall through to the structural `events` snapshot.
    }
  }
  const events = record['events']
  return Array.isArray(events) ? (events as readonly AgentSessionEventLike[]) : undefined
}

function goalObjectiveOf(
  services: AgentServiceBundle,
  agent: UnknownRecord | undefined,
): string | undefined {
  if (agent === undefined) return undefined
  return trimmedText(recordOf(serviceCallSafe(services.goals, 'get', agent))?.['objective'])
}

function objectiveFromSession(session: unknown): string | undefined {
  const events = sessionEventsOf(session)
  if (events === undefined) return undefined
  const inherited = numberOf(recordOf(session)?.['inheritedEventCount']) ?? 0
  let fallback: string | undefined
  for (const event of events) {
    const record = recordOf(event)
    if (record === undefined || record['type'] !== 'user/message') continue
    const seq = numberOf(record['seq'])
    if (seq !== undefined && seq < inherited) continue
    const data = recordOf(record['data'])
    const text = contentTextOf(data?.['content']).trim()
    if (text.length === 0) continue
    if (recordOf(data?.['source'])?.['kind'] === 'user') return text
    fallback ??= text
  }
  return fallback
}

function titleOf(
  services: AgentServiceBundle,
  session: unknown,
  header: UnknownRecord | undefined,
): string | undefined {
  if (session !== undefined) {
    const snapshot = serviceCallSafe(services.sessionProjections, 'snapshot', session)
    const title = trimmedText(recordOf(recordOf(snapshot)?.['values'])?.['title'])
    if (title !== undefined) return title
  }
  if (header !== undefined) {
    const cached = serviceCallSafe(services.sessionProjectionCache, 'cachedSnapshot', header)
    const title = trimmedText(recordOf(recordOf(cached)?.['values'])?.['title'])
    if (title !== undefined) return title
  }
  return undefined
}

/** Host `sessionStats.turns` when mounted, else count durable turn boundaries. */
function turnsOf(services: AgentServiceBundle, session: unknown): number | undefined {
  if (session === undefined) return undefined
  const snapshot = serviceCallSafe(services.sessionProjections, 'snapshot', session)
  const stats = recordOf(recordOf(recordOf(snapshot)?.['values'])?.['sessionStats'])
  const projected = normaliseTurns(stats?.['turns'])
  if (projected !== undefined) return projected
  const events = sessionEventsOf(session)
  if (events === undefined) return undefined
  let count = 0
  for (const event of events) {
    if (recordOf(event)?.['type'] === 'turn/end') count += 1
  }
  return count
}

/** The final durable `turn/end` time of a live session, if that is its last event. */
function finalTurnTime(events: readonly AgentSessionEventLike[] | undefined): string | undefined {
  if (events === undefined || events.length === 0) return undefined
  const last = recordOf(events[events.length - 1])
  if (last?.['type'] !== 'turn/end') return undefined
  return isoTime(last['time'])
}

/** Read a cold one-shot child's last event metadata; only type/time leave this helper. */
async function storedCompletionTime(
  services: AgentServiceBundle,
  id: string,
): Promise<string | undefined> {
  const records = await serviceCallAsyncSafe(services.sessionQuery, 'listEvents', id)
  const events = asUnknownArray(records)
  if (events.length === 0) return undefined
  const last = recordOf(events[events.length - 1])
  if (last?.['type'] !== 'turn/end') return undefined
  return isoTime(last['time'])
}

function isNotFoundError(error: unknown): boolean {
  const record = recordOf(error)
  const code = trimmedText(record?.['code'])
  if (code !== undefined && /NOT_FOUND/i.test(code)) return true
  if (error instanceof Error) {
    if (/not.?found/i.test(error.name)) return true
    if (/not found/i.test(error.message)) return true
  }
  return false
}

/** Release one observation lease without requiring the ES2023 `using` syntax. */
function disposeObservation(lease: unknown): void {
  if (lease === null || typeof lease !== 'object') return
  const disposeSymbol = (Symbol as unknown as { dispose?: symbol }).dispose
  if (disposeSymbol !== undefined) {
    try {
      const dispose = Reflect.get(lease as object, disposeSymbol)
      if (typeof dispose === 'function') {
        dispose.call(lease)
        return
      }
    } catch {
      // A failing lease release must never change the read result.
    }
  }
  const dispose = serviceMethod(lease, 'dispose')
  if (dispose === undefined) return
  try {
    dispose.call(lease)
  } catch {
    // A failing lease release must never change the read result.
  }
}

/** Convert a host timestamp (epoch ms or ISO string) to canonical ISO, or skip it. */
function isoTime(value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return undefined
    const parsed = Date.parse(trimmed)
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
  }
  return undefined
}

/* ------------------------------------------------------------------------- *
 * Preview classification (the route's only body-bearing file-content surface)
 * ------------------------------------------------------------------------- */

/** Rendering class of one preview response. */
export type PreviewKind = 'markdown' | 'html' | 'code' | 'text' | 'tex' | 'docx' | 'xlsx' | 'pptx'

/** Preview kinds whose payload is built from an OOXML package. */
export type OfficePreviewKind = 'docx' | 'xlsx' | 'pptx'

/** Preview kinds whose payload is the raw (bounded) file text. */
export type PreviewTextKind = Exclude<PreviewKind, OfficePreviewKind>

/** One worksheet projection: `rows` holds string values only, never formulas. */
export interface PreviewSheet {
  name: string
  rows: string[][]
}

/** One slide projection: a title plus its body lines. */
export interface PreviewSlide {
  /** 1-based position in the presentation. */
  index: number
  title: string
  lines: string[]
}

/** Text preview value (markdown/html/code/text/tex). */
export interface TextPreview {
  path: string
  kind: PreviewTextKind
  content: string
  truncated: boolean
  bytes: number
}

/** DOCX preview value: an already-sanitized HTML fragment. */
export interface DocxPreview {
  path: string
  kind: 'docx'
  html: string
  truncated: boolean
  bytes: number
}

/** XLSX preview value: bounded, string-only sheet projections. */
export interface XlsxPreview {
  path: string
  kind: 'xlsx'
  sheets: PreviewSheet[]
  truncated: boolean
  bytes: number
}

/** PPTX preview value: bounded slide projections. */
export interface PptxPreview {
  path: string
  kind: 'pptx'
  slides: PreviewSlide[]
  truncated: boolean
  bytes: number
}

/** Value of `GET /graph/preview`. */
export type PreviewValue = TextPreview | DocxPreview | XlsxPreview | PptxPreview

/** Raw text budget of one text preview (64 KiB). */
export const MAX_PREVIEW_TEXT_BYTES = 64 * 1024
/** Maximum bytes accepted from one Office package before it is refused (64 MiB). */
export const MAX_PREVIEW_ARCHIVE_BYTES = 64 * 1024 * 1024
/** Maximum size of the `word/document.xml` part handed to mammoth (64 KiB). */
export const MAX_DOCX_DOCUMENT_BYTES = 64 * 1024
/** Maximum size of the sanitized DOCX HTML fragment (256 KiB). */
export const MAX_DOCX_HTML_BYTES = 256 * 1024
/** Maximum number of worksheets in one workbook preview. */
export const MAX_XLSX_SHEETS = 20
/** Maximum number of rows read from one worksheet. */
export const MAX_XLSX_ROWS = 1_000
/** Maximum number of columns read from one worksheet. */
export const MAX_XLSX_COLUMNS = 50
/** Maximum characters retained for one cell value. */
export const MAX_XLSX_CELL_CHARS = 1_000
/** Maximum number of shared strings indexed for a workbook. */
export const MAX_XLSX_SHARED_STRINGS = 20_000
/** Maximum number of slides in one deck preview. */
export const MAX_PPTX_SLIDES = 200
/** Maximum number of body lines retained per slide. */
export const MAX_PPTX_LINES = 40
/** Maximum characters retained for one slide line (and the title). */
export const MAX_PPTX_LINE_CHARS = 200

/** ZIP entries scanned before a preview refuses the package (2,000). */
const MAX_PREVIEW_ZIP_ENTRIES = 2_000
/** Decompressed bytes one previewed OOXML part may occupy (8 MiB). */
const MAX_PREVIEW_ZIP_PART_BYTES = 8 * 1024 * 1024
/** Decompressed bytes across every previewed OOXML part (32 MiB). */
const MAX_PREVIEW_ZIP_TOTAL_BYTES = 32 * 1024 * 1024
/** Maximum bytes of XML handed to `fast-xml-parser` (8 MiB). */
const MAX_PREVIEW_XML_BYTES = 8 * 1024 * 1024
/** Maximum raw HTML characters scanned by the DOCX sanitizer (4 MiB). */
const MAX_DOCX_HTML_SCAN_CHARS = 4 * 1024 * 1024
/** Maximum XML elements one preview traversal visits (50,000). */
const MAX_PREVIEW_XML_ELEMENTS = 50_000

const PREVIEW_MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdx'])
const PREVIEW_HTML_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm'])
const PREVIEW_TEX_EXTENSIONS: ReadonlySet<string> = new Set(['.tex', '.ltx', '.latex'])
const PREVIEW_OFFICE_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.xlsx', '.pptx'])
const PREVIEW_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.java', '.py', '.rs', '.php',
  '.c', '.h', '.cpp', '.hpp', '.go', '.json', '.yaml', '.yml', '.toml',
])

/**
 * Classify a workspace-relative path for `/graph/preview`.
 *
 * Pure extension mapping only — no read, no content, no cache: the route itself
 * applies the 64 KiB text bound through `ParseService.readContent` and its own
 * bounded byte read for the Office kinds. An unknown extension is `text`
 * because the read path has already proven the file is decodable UTF-8;
 * binary/undecodable files never reach this projection.
 */
export function previewKindOf(path: string): PreviewKind {
  const extension = extensionOf(path)
  if (PREVIEW_MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (PREVIEW_HTML_EXTENSIONS.has(extension)) return 'html'
  if (PREVIEW_TEX_EXTENSIONS.has(extension)) return 'tex'
  if (PREVIEW_OFFICE_EXTENSIONS.has(extension)) {
    return extension === '.docx' ? 'docx' : extension === '.xlsx' ? 'xlsx' : 'pptx'
  }
  if (PREVIEW_CODE_EXTENSIONS.has(extension)) return 'code'
  return 'text'
}

/** True when the preview payload is built from an OOXML package. */
export function isOfficePreviewKind(kind: PreviewKind): kind is OfficePreviewKind {
  return kind === 'docx' || kind === 'xlsx' || kind === 'pptx'
}

/**
 * Build the text-preview payload from an already bounded read.
 *
 * The route's read is already capped, but the builder re-applies the 64 KiB
 * UTF-8 bound so a direct caller (or a future read path) cannot return a larger
 * body through this shape.
 */
export function buildTextPreview(
  path: string,
  kind: PreviewTextKind,
  content: string,
  truncated: boolean,
  bytes: number,
): TextPreview {
  const overCap = utf8ByteLength(content) > MAX_PREVIEW_TEXT_BYTES
  return {
    path,
    kind,
    content: overCap ? clipPreviewUtf8Bytes(content, MAX_PREVIEW_TEXT_BYTES) : content,
    truncated: truncated || overCap,
    bytes,
  }
}

/* ------------------------------------------------------------------------- *
 * DOCX preview: mammoth conversion + sanitize-by-construction
 * ------------------------------------------------------------------------- */

/**
 * Convert one DOCX package to a sanitized HTML fragment.
 *
 * Only `word/document.xml` (and the small style/numbering/relationship parts)
 * are extracted from the ZIP; every part is bounded by
 * {@link MAX_DOCX_DOCUMENT_BYTES}. A minimal package is rebuilt **in memory**
 * and handed to mammoth, so the original archive's media/macros are never
 * decompressed and nothing is written to disk. The resulting fragment is then
 * reconstructed from an allowlist: script/style elements and their contents,
 * event attributes and unsafe (`javascript:`, `vbscript:`, `data:`) URLs are
 * dropped before the value is returned.
 */
export async function buildDocxPreview(path: string, bytes: Uint8Array): Promise<DocxPreview> {
  assertPreviewArchive(bytes)
  const zip = readPreviewZip(bytes, isDocxPreviewPart, MAX_DOCX_DOCUMENT_BYTES)
  const documentXml = zip.parts.get('word/document.xml')
  if (documentXml === undefined) {
    // Only a document part that exists but exceeded the input cap is reported
    // as a truncated conversion; a package without one is not a DOCX.
    if (zip.skipped.has('word/document.xml')) {
      return { path, kind: 'docx', html: '', truncated: true, bytes: bytes.length }
    }
    throw new InvalidStateError('docx package is missing word/document.xml')
  }
  let rawHtml: string
  try {
    const packageBytes = buildMinimalDocx(zip.parts)
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(packageBytes) })
    rawHtml = result.value
  } catch {
    throw new InvalidStateError('docx word/document.xml could not be converted')
  }
  const sanitized = sanitizePreviewHtml(rawHtml)
  return {
    path,
    kind: 'docx',
    html: sanitized.html,
    truncated: zip.truncated || sanitized.truncated,
    bytes: bytes.length,
  }
}

/** Parts the DOCX preview needs; images/media/macros are never extracted. */
function isDocxPreviewPart(name: string): boolean {
  return (
    name === 'word/document.xml' ||
    name === 'word/_rels/document.xml.rels' ||
    name === 'word/styles.xml' ||
    name === 'word/numbering.xml'
  )
}

/** Minimal OOXML package so mammoth can convert an already capped document part. */
function buildMinimalDocx(parts: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': textBytes(DOCX_CONTENT_TYPES),
  }
  for (const name of [
    'word/_rels/document.xml.rels',
    'word/styles.xml',
    'word/numbering.xml',
  ]) {
    const part = parts.get(name)
    if (part !== undefined) entries[name] = part
  }
  const documentXml = parts.get('word/document.xml')
  if (documentXml === undefined) throw new InvalidStateError('docx package is missing word/document.xml')
  entries['word/document.xml'] = documentXml
  return zipSync(entries, { level: 6 })
}

const DOCX_CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>'

/** Tags an allowlisted DOCX fragment may contain. */
const PREVIEW_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sup', 'sub',
  'blockquote', 'pre', 'code', 'br', 'hr', 'a', 'span', 'div',
])

/** Void elements that never receive a closing tag. */
const PREVIEW_VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr'])

/** Attributes each allowlisted tag may keep; everything else is dropped. */
const PREVIEW_ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href']),
  ol: new Set(['start']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
}

/**
 * Reconstruct a safe HTML fragment from an allowlist.
 *
 * This is sanitization by construction, not by blocklist: text is decoded and
 * re-escaped, only allowlisted tags/attributes are emitted, `<script>`/`<style>`
 * are skipped together with their content, `on*` attributes are never emitted
 * and `href` values are restricted to http(s)/mailto/relative targets. The
 * result is capped at {@link MAX_DOCX_HTML_BYTES}; a cut is reported through
 * `truncated`.
 */
export function sanitizePreviewHtml(html: string): { html: string; truncated: boolean } {
  const source = typeof html === 'string' ? html : ''
  const bounded = source.length > MAX_DOCX_HTML_SCAN_CHARS
    ? source.slice(0, MAX_DOCX_HTML_SCAN_CHARS)
    : source
  const chunks: string[] = []
  const open: string[] = []
  let bytes = 0
  let truncated = bounded.length < source.length

  const append = (value: string): boolean => {
    const size = utf8ByteLength(value)
    if (bytes + size > MAX_DOCX_HTML_BYTES) {
      truncated = true
      return false
    }
    chunks.push(value)
    bytes += size
    return true
  }

  // Text is clipped rather than dropped: the caller sees as much prose as fits
  // (leaving a small reserve for the closing tags). Markup tokens are never
  // split, because a half-written tag would change the fragment's meaning.
  const appendText = (value: string): boolean => {
    const reserve = 1_024
    const room = MAX_DOCX_HTML_BYTES - bytes - reserve
    if (room <= 0) {
      truncated = true
      return false
    }
    if (utf8ByteLength(value) <= room) {
      chunks.push(value)
      bytes += utf8ByteLength(value)
      return true
    }
    let kept = ''
    let used = 0
    for (const character of value) {
      const size = utf8ByteLength(character)
      if (used + size > room) break
      kept += character
      used += size
    }
    if (kept.length > 0) {
      chunks.push(kept)
      bytes += used
    }
    truncated = true
    return false
  }

  let index = 0
  scan: while (index < bounded.length) {
    const next = bounded.indexOf('<', index)
    if (next < 0) {
      appendText(escapePreviewText(decodePreviewEntities(bounded.slice(index))))
      break
    }
    if (next > index) {
      if (!appendText(escapePreviewText(decodePreviewEntities(bounded.slice(index, next))))) break
    }
    const parsed = previewTagAt(bounded, next)
    if (parsed === undefined) {
      if (!append('&lt;')) break
      index = next + 1
      continue
    }
    index = parsed.end
    if (parsed.kind !== 'tag' || parsed.tag === undefined) continue
    const tag = parsed.tag
    if (tag === 'script' || tag === 'style') {
      if (!parsed.closing && !parsed.selfClosing) index = skipPreviewElement(bounded, index, tag)
      continue
    }
    if (!PREVIEW_ALLOWED_TAGS.has(tag)) continue
    if (parsed.closing) {
      const position = open.lastIndexOf(tag)
      if (position < 0) continue
      while (open.length - 1 > position) {
        const inner = open.pop() as string
        if (!append(`</${inner}>`)) break scan
      }
      open.pop()
      append(`</${tag}>`)
      continue
    }
    let markup = `<${tag}`
    for (const attribute of parsed.attributes) {
      if (attribute.name.startsWith('on')) continue
      const allowed = PREVIEW_ALLOWED_ATTRIBUTES[tag]
      if (allowed === undefined || !allowed.has(attribute.name)) continue
      const value = previewAttributeValue(tag, attribute.name, attribute.value)
      if (value === undefined) continue
      markup += ` ${attribute.name}="${escapePreviewAttribute(value)}"`
    }
    if (PREVIEW_VOID_TAGS.has(tag)) {
      if (!append(`${markup}>`)) break
      continue
    }
    if (parsed.selfClosing) {
      if (!append(`${markup}></${tag}>`)) break
      continue
    }
    if (!append(`${markup}>`)) break
    open.push(tag)
  }

  while (open.length > 0) {
    const tag = open.pop() as string
    if (!append(`</${tag}>`)) break
  }
  return { html: chunks.join(''), truncated }
}

type PreviewTagKind = 'tag' | 'comment' | 'declaration'

interface PreviewAttribute {
  name: string
  value: string
}

interface PreviewTag {
  kind: PreviewTagKind
  tag?: string
  closing: boolean
  selfClosing: boolean
  attributes: PreviewAttribute[]
  /** Index just past the closing `>`. */
  end: number
}

/** Parse one `<...>` token, honouring quoted attributes; never throws. */
function previewTagAt(source: string, start: number): PreviewTag | undefined {
  if (source.startsWith('<!--', start)) {
    const close = source.indexOf('-->', start + 4)
    return {
      kind: 'comment',
      closing: false,
      selfClosing: false,
      attributes: [],
      end: close < 0 ? source.length : close + 3,
    }
  }
  if (source.startsWith('<!', start) || source.startsWith('<?', start)) {
    const close = source.indexOf('>', start + 2)
    return {
      kind: 'declaration',
      closing: false,
      selfClosing: false,
      attributes: [],
      end: close < 0 ? source.length : close + 1,
    }
  }
  let quote: string | undefined
  let end = -1
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] as string
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') {
      end = index
      break
    }
  }
  if (end < 0) return undefined
  const raw = source.slice(start + 1, end)
  const name = /^\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(raw)
  if (name === null) return undefined
  const tag = (name[2] as string).toLowerCase()
  const closing = name[1] === '/'
  const selfClosing = /\/\s*$/.test(raw)
  const attributes: PreviewAttribute[] = []
  if (!closing) {
    const pattern = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(raw)) !== null) {
      attributes.push({
        name: (match[1] as string).toLowerCase(),
        value: match[2] ?? match[3] ?? match[4] ?? '',
      })
    }
  }
  return { kind: 'tag', tag, closing, selfClosing, attributes, end: end + 1 }
}

/** Skip a whole `<script>`/`<style>` element, content included. */
function skipPreviewElement(source: string, start: number, tag: string): number {
  const lower = source.toLowerCase()
  let search = start
  while (search < lower.length) {
    const close = lower.indexOf(`</${tag}`, search)
    if (close < 0) return source.length
    let cursor = close + tag.length + 2
    while (cursor < source.length && /\s/.test(source[cursor] as string)) cursor += 1
    if (source[cursor] === '>') return cursor + 1
    search = close + 2
  }
  return source.length
}

/** Keep only a safe attribute value; `on*`/style/url attributes never pass. */
function previewAttributeValue(tag: string, name: string, raw: string): string | undefined {
  if (tag === 'a' && name === 'href') return safePreviewHref(raw)
  if (name === 'colspan' || name === 'rowspan' || name === 'start') {
    const value = decodePreviewEntities(raw).trim()
    return /^\d{1,4}$/.test(value) ? value : undefined
  }
  return undefined
}

/** Restrict links to http(s), mailto and same-document/relative targets. */
function safePreviewHref(raw: string): string | undefined {
  const value = decodePreviewEntities(raw)
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
  if (value.length === 0 || value.length > 2_048) return undefined
  const lower = value.toLowerCase()
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:')) {
    return undefined
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(lower)
  if (scheme !== null) {
    const name = scheme[1] as string
    return name === 'http' || name === 'https' || name === 'mailto' ? value : undefined
  }
  return value
}

function escapePreviewText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapePreviewAttribute(value: string): string {
  return escapePreviewText(value).replace(/'/g, '&#39;')
}

/** Decode the five XML entities and numeric references; unknown entities stay literal. */
function decodePreviewEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos|nbsp));/g,
    (match, hex, decimal, named) => {
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
          case 'nbsp':
            return '\u00a0'
          default:
            return match
        }
      }
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal, 10)
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match
      if (code >= 0xd800 && code <= 0xdfff) return match
      return String.fromCodePoint(code)
    },
  )
}

/* ------------------------------------------------------------------------- *
 * XLSX preview: bounded, string-only sheet values
 * ------------------------------------------------------------------------- */

/**
 * Project one XLSX package into bounded sheets.
 *
 * At most {@link MAX_XLSX_SHEETS} sheets, {@link MAX_XLSX_ROWS} rows and
 * {@link MAX_XLSX_COLUMNS} columns per sheet are read. Only cell values are
 * returned: a formula (`<f>`) is never emitted, while its cached `<v>` value is
 * still allowed. Every value is a string and is capped at
 * {@link MAX_XLSX_CELL_CHARS}; any cap hit sets `truncated`.
 */
export function buildXlsxPreview(path: string, bytes: Uint8Array): XlsxPreview {
  assertPreviewArchive(bytes)
  const zip = readPreviewZip(bytes, isXlsxPreviewPart, MAX_PREVIEW_ZIP_PART_BYTES)
  let truncated = zip.truncated

  const shared = parseXlsxSharedStrings(zip.parts.get('xl/sharedStrings.xml'))
  truncated = truncated || shared.truncated
  const worksheetParts = [...zip.parts.keys()]
    .filter((name) => name.startsWith('xl/worksheets/') && isFlatXmlPart(name.slice('xl/worksheets/'.length)))
    .sort(comparePartNames)

  const entries: Array<{ name: string; part: string | undefined }> = []
  const workbookBytes = zip.parts.get('xl/workbook.xml')
  if (workbookBytes !== undefined) {
    const workbook = parsePreviewXml('xl/workbook.xml', workbookBytes)
    if (workbook === undefined) {
      truncated = true
    } else {
      const relationships = parsePreviewRelationships(
        zip.parts.get('xl/_rels/workbook.xml.rels'),
      )
      let fallback = 0
      for (const [index, sheet] of collectElements(workbook, 'sheet').entries()) {
        const name = cleanPreviewName(attributeOf(sheet, 'name'), `Sheet ${index + 1}`, 200)
        const relationship = relationshipIdOf(sheet)
        const target = relationship === undefined ? undefined : relationships.get(relationship)
        let part = target === undefined
          ? undefined
          : resolvePartTarget('xl', decodePreviewEntities(target))
        if (part !== undefined && !zip.parts.has(part)) part = undefined
        if (part === undefined && relationships.size === 0) {
          part = worksheetParts[fallback]
          fallback += 1
        }
        entries.push({ name, part })
      }
    }
  }
  if (entries.length === 0) {
    for (const [index, part] of worksheetParts.entries()) {
      entries.push({ name: `Sheet ${index + 1}`, part })
    }
  }

  const used = new Set<string>()
  const sheets: PreviewSheet[] = []
  for (const entry of entries) {
    if (sheets.length >= MAX_XLSX_SHEETS) {
      truncated = true
      break
    }
    let part = entry.part
    if (part !== undefined && used.has(part)) part = undefined
    if (part === undefined) {
      // A sheet whose worksheet part is absent (chartsheet, or a part skipped
      // by the size cap) keeps its name and empty rows. It is never paired
      // positionally with a different sheet's part.
      sheets.push({ name: entry.name, rows: [] })
      continue
    }
    const worksheetBytes = zip.parts.get(part)
    if (worksheetBytes === undefined) {
      truncated = true
      sheets.push({ name: entry.name, rows: [] })
      continue
    }
    used.add(part)
    const worksheet = parseXlsxWorksheet(worksheetBytes, shared.strings)
    truncated = truncated || worksheet.truncated
    sheets.push({ name: entry.name, rows: worksheet.rows })
  }

  return { path, kind: 'xlsx', sheets, truncated, bytes: bytes.length }
}

/** Parts the XLSX preview needs; the rest of the package is never decompressed. */
function isXlsxPreviewPart(name: string): boolean {
  if (
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name === 'xl/sharedStrings.xml'
  ) {
    return true
  }
  return name.startsWith('xl/worksheets/') && isFlatXmlPart(name.slice('xl/worksheets/'.length))
}

interface XlsxSharedStrings {
  strings: string[]
  truncated: boolean
}

function parseXlsxSharedStrings(bytes: Uint8Array | undefined): XlsxSharedStrings {
  if (bytes === undefined) return { strings: [], truncated: false }
  const parsed = parsePreviewXml('xl/sharedStrings.xml', bytes)
  if (parsed === undefined) return { strings: [], truncated: true }
  const strings: string[] = []
  let truncated = false
  for (const item of collectElements(parsed, 'si')) {
    if (strings.length >= MAX_XLSX_SHARED_STRINGS) {
      truncated = true
      break
    }
    const raw = collectElementText(item, 't')
    const clipped = clipPreviewText(raw, MAX_XLSX_CELL_CHARS)
    if (clipped.truncated) truncated = true
    strings.push(clipped.text)
  }
  return { strings, truncated }
}

function parseXlsxWorksheet(
  bytes: Uint8Array,
  sharedStrings: readonly string[],
): { rows: string[][]; truncated: boolean } {
  const parsed = parsePreviewXml('xl/worksheets', bytes)
  if (parsed === undefined) return { rows: [], truncated: true }
  const rows: string[][] = []
  let truncated = false
  let scanned = 0
  for (const rowElement of collectElements(parsed, 'row')) {
    if (scanned >= MAX_XLSX_ROWS) {
      truncated = true
      break
    }
    scanned += 1
    const row: string[] = []
    let fallbackColumn = 0
    let hasValue = false
    for (const cell of childrenOf(rowElement)) {
      if (localName(tagNameOf(cell) ?? '') !== 'c') continue
      const reference = attributeOf(cell, 'r')
      const column = reference === undefined ? fallbackColumn : columnIndexOf(reference)
      if (column < 0) continue
      fallbackColumn = column + 1
      if (column >= MAX_XLSX_COLUMNS) {
        truncated = true
        continue
      }
      const value = xlsxCellValue(cell, sharedStrings)
      if (value.truncated) truncated = true
      if (value.text.length === 0) continue
      while (row.length < column) row.push('')
      row[column] = value.text
      hasValue = true
    }
    if (hasValue) rows.push(row)
  }
  return { rows, truncated }
}

function xlsxCellValue(
  cell: XmlRecord,
  sharedStrings: readonly string[],
): { text: string; truncated: boolean } {
  const type = (attributeOf(cell, 't') ?? '').toLowerCase()
  if (type === 's') {
    const raw = directChildText(cell, 'v')
    const index = Number.parseInt(raw, 10)
    const value = Number.isInteger(index) && index >= 0 ? sharedStrings[index] ?? '' : ''
    return clipPreviewText(value, MAX_XLSX_CELL_CHARS)
  }
  if (type === 'inlinestr') {
    const inline = findDirectChild(cell, 'is')
    const value = inline === undefined ? '' : collectElementText(inline, 't')
    return clipPreviewText(value, MAX_XLSX_CELL_CHARS)
  }
  // A formula's `<f>` text is never read. Its cached `<v>` value (if any) is a
  // cell value and is returned as a plain string.
  const value = directChildText(cell, 'v')
  return clipPreviewText(value, MAX_XLSX_CELL_CHARS)
}

/** Zero-based column index of an A1-style reference; -1 when unparseable. */
function columnIndexOf(reference: string): number {
  const match = /^([A-Za-z]{1,4})\d+$/.exec(reference.trim())
  if (match === null) return -1
  const letters = (match[1] as string).toUpperCase()
  let column = 0
  for (const letter of letters) {
    column = column * 26 + (letter.charCodeAt(0) - 64)
  }
  return column - 1
}

/* ------------------------------------------------------------------------- *
 * PPTX preview: bounded slide titles and lines
 * ------------------------------------------------------------------------- */

/**
 * Project one PPTX package into bounded slides.
 *
 * At most {@link MAX_PPTX_SLIDES} slides are read, each with a title, at most
 * {@link MAX_PPTX_LINES} body lines and at most {@link MAX_PPTX_LINE_CHARS}
 * characters per line. The title comes from an explicit title/ctrTitle
 * placeholder, then the slide's `cSld` name, then `Slide N`; body lines are the
 * remaining text paragraphs in document order. Any cap hit sets `truncated`.
 */
export function buildPptxPreview(path: string, bytes: Uint8Array): PptxPreview {
  assertPreviewArchive(bytes)
  const zip = readPreviewZip(bytes, isPptxPreviewPart, MAX_PREVIEW_ZIP_PART_BYTES)
  let truncated = zip.truncated

  const slideParts = [...zip.parts.keys()]
    .filter((name) => name.startsWith('ppt/slides/') && isFlatXmlPart(name.slice('ppt/slides/'.length)))
    .sort(comparePartNames)

  interface SlideEntry {
    part: string | undefined
    /** True when the presentation gave no resolvable relationship for this id. */
    fallback: boolean
  }
  const ordered: SlideEntry[] = []
  const presentationBytes = zip.parts.get('ppt/presentation.xml')
  if (presentationBytes !== undefined) {
    const presentation = parsePreviewXml('ppt/presentation.xml', presentationBytes)
    if (presentation === undefined) {
      truncated = true
    } else {
      const relationships = parsePreviewRelationships(
        zip.parts.get('ppt/_rels/presentation.xml.rels'),
      )
      // Positional pairing is a last resort used only when the package names
      // no relationships at all; a partially resolved deck keeps the missing
      // slide empty instead of borrowing a different slide's part.
      const canFallback = relationships.size === 0
      for (const slideId of collectElements(presentation, 'sldId')) {
        const relationship = relationshipIdOf(slideId)
        const target = relationship === undefined ? undefined : relationships.get(relationship)
        if (target === undefined) {
          ordered.push({ part: undefined, fallback: canFallback })
          continue
        }
        const part = resolvePartTarget('ppt', decodePreviewEntities(target))
        ordered.push({
          part: part !== undefined && zip.parts.has(part) ? part : undefined,
          fallback: false,
        })
      }
    }
  }
  if (ordered.length === 0) {
    for (const part of slideParts) ordered.push({ part, fallback: false })
  }

  const used = new Set<string>()
  const slides: PreviewSlide[] = []
  for (const entry of ordered) {
    if (slides.length >= MAX_PPTX_SLIDES) {
      truncated = true
      break
    }
    let part = entry.part
    if (part !== undefined && used.has(part)) part = undefined
    if (part === undefined && entry.fallback) {
      part = slideParts.find((name) => !used.has(name))
    }
    if (part === undefined) {
      // A slide part that is absent (or was skipped by a cap) is reported as
      // an empty slide; it is never filled with a different slide's text.
      truncated = true
      slides.push({ index: slides.length + 1, title: `Slide ${slides.length + 1}`, lines: [] })
      continue
    }
    used.add(part)
    const slideBytes = zip.parts.get(part)
    if (slideBytes === undefined) {
      truncated = true
      slides.push({ index: slides.length + 1, title: `Slide ${slides.length + 1}`, lines: [] })
      continue
    }
    const slide = parsePptxSlide(slideBytes, slides.length + 1)
    truncated = truncated || slide.truncated
    slides.push(slide.value)
  }

  return { path, kind: 'pptx', slides, truncated, bytes: bytes.length }
}

/** Parts the PPTX preview needs; media/macros are never decompressed. */
function isPptxPreviewPart(name: string): boolean {
  if (name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels') return true
  return name.startsWith('ppt/slides/') && isFlatXmlPart(name.slice('ppt/slides/'.length))
}

function parsePptxSlide(
  bytes: Uint8Array,
  index: number,
): { value: PreviewSlide; truncated: boolean } {
  const parsed = parsePreviewXml('ppt/slides', bytes)
  if (parsed === undefined) {
    return { value: { index, title: `Slide ${index}`, lines: [] }, truncated: true }
  }
  const content = findFirstElement(parsed, 'cSld')
  if (content === undefined) {
    return { value: { index, title: `Slide ${index}`, lines: [] }, truncated: false }
  }
  const slideName = cleanPreviewName(attributeOf(content, 'name'), '', 200)
  const titleShape = findFirstElement(childrenOf(content), 'sp', (shape) => shapeIsTitleShape(shape))
  let title = ''
  let truncated = false
  if (titleShape !== undefined) {
    for (const paragraph of collectElements([titleShape], 'p')) {
      const text = previewParagraphText(paragraph)
      if (text.length > 0) {
        title = text
        break
      }
    }
  }
  if (title.length === 0) title = slideName.length > 0 ? slideName : `Slide ${index}`
  const clippedTitle = clipPreviewText(title, MAX_PPTX_LINE_CHARS)
  if (clippedTitle.truncated) truncated = true

  const lines: string[] = []
  const stopped = { value: false }
  const walk = (nodes: XmlRecord[]): void => {
    for (const node of nodes) {
      if (stopped.value) return
      if (isTextNode(node)) continue
      if (node === titleShape) continue
      const tag = tagNameOf(node)
      if (tag === undefined) continue
      if (localName(tag) === 'p') {
        const text = previewParagraphText(node)
        if (text.length > 0) {
          if (lines.length >= MAX_PPTX_LINES) {
            // A further non-empty paragraph exists beyond the cap.
            truncated = true
            stopped.value = true
            return
          }
          const clipped = clipPreviewText(text, MAX_PPTX_LINE_CHARS)
          if (clipped.truncated) truncated = true
          lines.push(clipped.text)
        }
        continue
      }
      walk(childrenOf(node))
    }
  }
  walk(childrenOf(content))
  return {
    value: { index, title: clippedTitle.text, lines },
    truncated,
  }
}

/** True when a `p:sp` carries a title/ctrTitle placeholder. */
function shapeIsTitleShape(shape: XmlRecord): boolean {
  const placeholder = findFirstElement(childrenOf(shape), 'ph')
  if (placeholder === undefined) return false
  const type = (attributeOf(placeholder, 'type') ?? '').toLowerCase()
  return type === 'title' || type === 'ctrtitle'
}

/** Normalised text of one `a:p`, joining its runs in document order. */
function previewParagraphText(paragraph: XmlRecord): string {
  let text = ''
  const walk = (nodes: XmlRecord[]): void => {
    for (const node of nodes) {
      if (isTextNode(node)) {
        text += decodePreviewEntities(node['#text'] as string)
        continue
      }
      const tag = tagNameOf(node)
      if (tag === undefined) continue
      const name = localName(tag)
      if (name === 't') {
        text += collectElementText(node, 't')
        continue
      }
      if (name === 'br') {
        text += ' '
        continue
      }
      walk(childrenOf(node))
    }
  }
  walk(childrenOf(paragraph))
  return normalizePreviewText(text)
}

/* ------------------------------------------------------------------------- *
 * OOXML package/XML helpers shared by the office preview builders
 * ------------------------------------------------------------------------- */

interface XmlRecord {
  [key: string]: unknown
}

const PREVIEW_XML_PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  attributesGroupName: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  allowBooleanAttributes: false,
  maxNestedTags: 128,
  ignoreDeclaration: true,
  ignorePiTags: true,
})

interface PreviewZip {
  parts: Map<string, Uint8Array>
  truncated: boolean
  /** Wanted entries that were present but skipped because of a size cap. */
  skipped: Set<string>
}

class PreviewZipLimitError extends Error {
  readonly previewZipLimit = true

  constructor() {
    super('preview ZIP entry limit reached')
    this.name = 'PreviewZipLimitError'
  }
}

/**
 * Extract only the OOXML parts a preview needs, enforcing the entry/size
 * bounds in `fflate`'s filter (before decompression). Nothing is written.
 */
function readPreviewZip(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
  perEntryLimit: number,
): PreviewZip {
  const parts = new Map<string, Uint8Array>()
  const skipped = new Set<string>()
  let truncated = false
  let entries = 0
  let total = 0
  try {
    const files = unzipSync(bytes, {
      filter: (file) => {
        entries += 1
        if (entries > MAX_PREVIEW_ZIP_ENTRIES) throw new PreviewZipLimitError()
        const name = canonicalPartName(file.name)
        if (name === undefined || !wanted(name)) return false
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
          skipped.add(name)
          truncated = true
          return false
        }
        if (file.originalSize > perEntryLimit) {
          skipped.add(name)
          truncated = true
          return false
        }
        if (total + file.originalSize > MAX_PREVIEW_ZIP_TOTAL_BYTES) {
          skipped.add(name)
          truncated = true
          return false
        }
        total += file.originalSize
        return true
      },
    })
    for (const [name, data] of Object.entries(files)) {
      if (data instanceof Uint8Array) parts.set(name, data)
    }
  } catch (error) {
    if (isPreviewZipLimitError(error)) return { parts, truncated: true, skipped }
    throw new InvalidStateError('Office preview package is not a readable ZIP container')
  }
  return { parts, truncated, skipped }
}

function isPreviewZipLimitError(error: unknown): error is PreviewZipLimitError {
  return error instanceof PreviewZipLimitError
}

/** Reject empty/oversized archives before any ZIP work starts. */
function assertPreviewArchive(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new InvalidStateError('Office preview package is empty')
  }
  if (bytes.length > MAX_PREVIEW_ARCHIVE_BYTES) {
    throw new InvalidStateError(
      `Office preview package exceeds the ${MAX_PREVIEW_ARCHIVE_BYTES}-byte cap`,
    )
  }
}

function parsePreviewXml(partName: string, bytes: Uint8Array): XmlRecord[] | undefined {
  if (bytes.length === 0 || bytes.length > MAX_PREVIEW_XML_BYTES) return undefined
  let text: string
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }
  } catch {
    return undefined
  }
  if (text.includes('<!DOCTYPE') || text.includes('<!ENTITY')) return undefined
  try {
    const parsed = PREVIEW_XML_PARSER.parse(text)
    return Array.isArray(parsed) ? (parsed as XmlRecord[]) : undefined
  } catch {
    return undefined
  }
}

function parsePreviewRelationships(bytes: Uint8Array | undefined): Map<string, string> {
  const relationships = new Map<string, string>()
  if (bytes === undefined) return relationships
  const parsed = parsePreviewXml('relationships', bytes)
  if (parsed === undefined) return relationships
  for (const node of collectElements(parsed, 'Relationship')) {
    const id = attributeOf(node, 'Id')
    const target = attributeOf(node, 'Target')
    if (id === undefined || target === undefined || id.length === 0 || target.length === 0) continue
    if (!relationships.has(id)) relationships.set(id, target)
  }
  return relationships
}

function resolvePartTarget(baseDir: string, target: string): string | undefined {
  let raw = target.replace(/\\/g, '/').trim()
  if (raw.length === 0 || raw.includes('\u0000')) return undefined
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

/** Canonical package part name, or undefined for directories/traversal names. */
function canonicalPartName(name: string): string | undefined {
  if (typeof name !== 'string' || name.length === 0 || name.length > 512) return undefined
  if (name.startsWith('/') || name.includes('\\') || name.includes('\u0000')) return undefined
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return undefined
  }
  return name
}

function isFlatXmlPart(rest: string): boolean {
  return rest.length > '.xml'.length && rest.endsWith('.xml') && !rest.includes('/')
}

function isTextNode(node: XmlRecord): boolean {
  return typeof node['#text'] === 'string'
}

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

function localName(name: string): string {
  const colon = name.lastIndexOf(':')
  return colon >= 0 ? name.slice(colon + 1) : name
}

function attributeOf(node: XmlRecord, name: string): string | undefined {
  const attributes = node[':@']
  if (typeof attributes !== 'object' || attributes === null) return undefined
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string') continue
    const raw = key.startsWith('@_') ? key.slice(2) : key
    if (localName(raw) === name) return value
  }
  return undefined
}

/** Prefixed relationship id (`r:id`), ignoring an element's own `id`. */
function relationshipIdOf(node: XmlRecord): string | undefined {
  const attributes = node[':@']
  if (typeof attributes !== 'object' || attributes === null) return undefined
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string') continue
    const raw = key.startsWith('@_') ? key.slice(2) : key
    if (raw.includes(':') && localName(raw) === 'id') return value
  }
  return undefined
}

function collectElements(
  nodes: readonly XmlRecord[],
  wanted: string,
  accept?: (node: XmlRecord) => boolean,
): XmlRecord[] {
  const found: XmlRecord[] = []
  const walk = (children: readonly XmlRecord[]): void => {
    for (const node of children) {
      if (found.length >= MAX_PREVIEW_XML_ELEMENTS) return
      if (isTextNode(node)) continue
      const tag = tagNameOf(node)
      if (tag === undefined) continue
      if (localName(tag) === wanted && (accept === undefined || accept(node))) found.push(node)
      walk(childrenOf(node))
    }
  }
  walk(nodes)
  return found
}

function findFirstElement(
  nodes: readonly XmlRecord[],
  wanted: string,
  accept?: (node: XmlRecord) => boolean,
): XmlRecord | undefined {
  let found: XmlRecord | undefined
  const walk = (children: readonly XmlRecord[]): void => {
    for (const node of children) {
      if (found !== undefined) return
      if (isTextNode(node)) continue
      const tag = tagNameOf(node)
      if (tag === undefined) continue
      if (localName(tag) === wanted && (accept === undefined || accept(node))) {
        found = node
        return
      }
      walk(childrenOf(node))
    }
  }
  walk(nodes)
  return found
}

function findDirectChild(node: XmlRecord, wanted: string): XmlRecord | undefined {
  for (const child of childrenOf(node)) {
    const tag = tagNameOf(child)
    if (tag !== undefined && localName(tag) === wanted) return child
  }
  return undefined
}

function directChildText(node: XmlRecord, wanted: string): string {
  const child = findDirectChild(node, wanted)
  if (child === undefined) return ''
  return collectElementText(child, 't')
}

/** Concatenated text of every `t` element below `node`, in document order. */
function collectElementText(node: XmlRecord, wanted: string): string {
  let text = ''
  const walk = (children: readonly XmlRecord[]): void => {
    for (const child of children) {
      if (isTextNode(child)) {
        text += decodePreviewEntities(child['#text'] as string)
        continue
      }
      const tag = tagNameOf(child)
      if (tag === undefined) continue
      if (localName(tag) === wanted) {
        text += decodePreviewEntities(rawTextContent(child))
        continue
      }
      walk(childrenOf(child))
    }
  }
  walk(childrenOf(node))
  return text
}

function rawTextContent(node: XmlRecord): string {
  let text = ''
  const walk = (children: readonly XmlRecord[]): void => {
    for (const child of children) {
      if (isTextNode(child)) text += child['#text'] as string
      else walk(childrenOf(child))
    }
  }
  walk(childrenOf(node))
  return text
}

function clipPreviewText(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, limit), truncated: true }
}

/** Normalise metadata-like text: controls to spaces, collapse, trim. */
function normalizePreviewText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function cleanPreviewName(
  value: string | undefined,
  fallback: string,
  limit: number,
): string {
  const clean = normalizePreviewText(value === undefined ? '' : decodePreviewEntities(value))
  if (clean.length === 0) return fallback
  return clipPreviewText(clean, limit).text
}

function comparePartNames(left: string, right: string): number {
  const leftMatch = /(\d+)(?!.*\d)/.exec(left)
  const rightMatch = /(\d+)(?!.*\d)/.exec(right)
  if (leftMatch !== null && rightMatch !== null) {
    const difference = Number(leftMatch[1]) - Number(rightMatch[1])
    if (difference !== 0) return difference
  }
  return left.localeCompare(right)
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Clip a string to at most `limit` UTF-8 bytes without splitting a code point. */
function clipPreviewUtf8Bytes(value: string, limit: number): string {
  let kept = ''
  let used = 0
  for (const character of value) {
    const size = utf8ByteLength(character)
    if (used + size > limit) break
    kept += character
    used += size
  }
  return kept
}



/* ------------------------------------------------------------------------- *
 * Path validation and ordering helpers
 * ------------------------------------------------------------------------- */

/**
 * Validate a workspace-relative query path.
 *
 * Absolute paths, drive-rooted/UNC paths, empty input and **any** `..` segment
 * are rejected (even one that would stay inside the workspace), so a caller
 * cannot use the outline route to probe the host filesystem. Reuses the text
 * layer's purely lexical normaliser: no filesystem access, no symlink probe.
 */
export function normaliseGraphPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim().replace(/\\/g, '/')
  if (raw.length === 0) return undefined
  if (raw.split('/').includes('..')) return undefined
  return normaliseWorkspacePath(raw)
}

/** File extension of a workspace-relative path, lower-cased (`.tex`). */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

function isBookSummary(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return name === 'summary.md' || name === 'summary.txt'
}

/** Code-point ordering; locale-independent, so output is stable everywhere. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Canonical edge key inside one query. */
function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`
}

const EMPTY_NEIGHBOURS: readonly string[] = []

const Color = {
  White: 0,
  Gray: 1,
  Black: 2,
} as const

type Color = (typeof Color)[keyof typeof Color]

/* ------------------------------------------------------------------------- *
 * Bounded workspace indexing (the scan half of POST /graph/index)
 *
 * This is the only part of the module that asks the host to do work: a fresh
 * profile has an empty graph, so the panel cannot show anything until someone
 * scans the workspace. The scan itself stays out of this module: the caller
 * injects a read-only `WorkspaceIndexIo`, which the host route binds to
 * `node:fs` + `ParseService` + `GraphStore`/`ChainEngine`. Tests bind it to a
 * stub tree.
 *
 * Bounds (all enforced here, not by the adapters):
 *  - workspace-relative path depth ≤ {@link MAX_INDEX_DEPTH} (root file = 1);
 *  - at most {@link MAX_INDEX_FILES} files are handed to the parser;
 *  - at most {@link INDEX_TIME_LIMIT_MS} ms of wall-clock time;
 *  - dependency/build output and VCS directories are never descended into;
 *  - only extensions the text layer has a parser for are attempted, so a
 *    binary can never reach the parser by extension;
 *  - structural manifests ({@link DEFAULT_MANIFEST_NAMES}, or a caller's
 *    `manifestNames`) are accepted by exact file name even though their
 *    `.json`/`.xml`/`.toml` extensions are not on the allowlist;
 *  - the caller's ignore list is checked **before** every acceptance rule, so
 *    ignoring `package.json` really skips it.
 * Overrunning any bound reports `truncated: true` with the completed counts;
 * a file that fails to parse is counted as `skipped` and never aborts the run.
 * ------------------------------------------------------------------------- */

/** Maximum files one workspace index hands to the parser. */
export const MAX_INDEX_FILES = 200
/** Wall-clock budget of one workspace index. */
export const INDEX_TIME_LIMIT_MS = 10_000
/** Maximum workspace-relative path depth (a root-level file is depth 1). */
export const MAX_INDEX_DEPTH = 8

/** Directories the scan never descends into (matched case-insensitively). */
export const INDEX_SKIP_DIRECTORIES: readonly string[] = ['node_modules', '.git', 'dist', '.tmp']

/**
 * Default ignore list of the scan.
 *
 * Deliberately empty: the structural manifests are indexed by default. A
 * caller's `ignore` list still wins over manifest acceptance.
 */
export const INDEX_DEFAULT_IGNORE: readonly string[] = []

/**
 * Extensions the scan accepts, mirroring the registered text parsers.
 *
 * Deliberately an allowlist: shared `.json`/`.yaml`/`.xml` extensions have no
 * registered parser (the text layer refuses to guess), and binary documents
 * (`.docx`, `.pdf`, images, archives) stay out by construction. Structural
 * manifests are the one exact-filename exception and are handled by
 * {@link isIndexableWorkspaceFile} / {@link DEFAULT_MANIFEST_NAMES}.
 */
export const INDEX_FILE_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.java', '.py', '.pyi', '.pyw', '.rs', '.php',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.hh',
  '.md', '.markdown', '.mdx', '.tex', '.ltx', '.latex', '.book',
  '.css', '.html', '.htm', '.csv', '.tsv',
]

/** One directory entry returned by {@link WorkspaceIndexIo.readDirectory}. */
export interface WorkspaceIndexEntry {
  /** Last path segment (file or directory name). */
  name: string
  /** True for a directory; symbolic links are filtered out by the adapter. */
  directory: boolean
}

/** Read-only adapter the host binds to the file system / parser / graph store. */
export interface WorkspaceIndexIo {
  /** List one workspace-relative directory (`''` is the workspace root). */
  readDirectory(path: string): Promise<readonly WorkspaceIndexEntry[]>
  /** Parse and persist one workspace-relative file; returns its node count. */
  indexFile(path: string): Promise<number>
}

/** Overrides for the scan budgets; the host route uses the defaults. */
export interface WorkspaceIndexOptions {
  maxFiles?: number
  timeLimitMs?: number
  maxDepth?: number
  /**
   * Exact manifest file names accepted even without an allowlisted extension.
   * Case-insensitive; defaults to {@link DEFAULT_MANIFEST_NAMES}.
   */
  manifestNames?: readonly string[]
  /**
   * User ignore list. Matched before every acceptance rule, so an ignored
   * manifest is skipped like any other file. Entries are workspace-relative
   * paths, bare file/directory names, or simple `*`/`?`/`**` globs.
   */
  ignore?: readonly string[]
  /** Clock injection for deterministic tests; defaults to `Date.now`. */
  now?: () => number
}

/** Acceptance policy for {@link isIndexableWorkspaceFile}. */
export interface WorkspaceFilePolicy {
  /** Exact manifest file names accepted by name (defaults to the preset list). */
  manifestNames?: readonly string[]
  /** User ignore list, matched first. */
  ignore?: readonly string[]
}

/** Value of `POST /graph/index`. */
export interface WorkspaceIndexResult {
  /** Files parsed and persisted. */
  indexed: number
  /** Files seen but not indexed (unsupported extension or parse failure). */
  skipped: number
  /** Graph nodes registered by the indexed files. */
  nodes: number
  durationMs: number
  /** True when a file/time bound stopped the scan before it finished. */
  truncated: boolean
}

/**
 * Why a workspace index answered with nothing useful.
 *
 * `no-workspace-files` means the scan indexed **zero** files under the root it
 * was actually given. That is the visible symptom of a root resolved to the
 * wrong directory (for example a desktop install directory instead of the
 * session workspace), so the response carries the root beside the diagnostic.
 */
export interface WorkspaceIndexDiagnostic {
  code: 'no-workspace-files'
  message: string
  /** Absolute workspace root the scan walked. */
  root: string
}

/** Value of `POST /graph/index`: the scan counts plus the resolved root. */
export interface WorkspaceIndexReport extends WorkspaceIndexResult {
  /** Absolute workspace root the scan went on to read. */
  root: string
  /** Present when the scan indexed no files (`indexed === 0`). */
  diagnostics?: WorkspaceIndexDiagnostic[]
}

/**
 * Attach the resolved workspace root to one scan result and, at zero indexed
 * files, the `no-workspace-files` diagnostic.
 *
 * Pure: the route supplies the root it actually scanned, so the response makes
 * a wrong root visible instead of looking like an ordinary empty workspace.
 */
export function workspaceIndexReport(
  result: WorkspaceIndexResult,
  root: string,
): WorkspaceIndexReport {
  const diagnostics: WorkspaceIndexDiagnostic[] = result.indexed === 0
    ? [{
        code: 'no-workspace-files',
        message: `no workspace files were indexed under ${root} (${result.skipped} skipped)`,
        root,
      }]
    : []
  return {
    ...result,
    root,
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  }
}

/** Escape one literal glob character for a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
}

/** Compile a case-insensitive glob (`*`, `**`, `?`) over slash paths. */
function globRegExp(pattern: string): RegExp {
  const source = normaliseScopePath(pattern).toLowerCase()
  let expression = '^'
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string
    if (character === '*') {
      if (source[index + 1] === '*') {
        expression += '.*'
        index += 1
      } else {
        expression += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      expression += '[^/]'
      continue
    }
    expression += escapeRegExp(character)
  }
  return new RegExp(`${expression}$`, 'i')
}

/**
 * True when the user ignore list matches a workspace-relative path.
 *
 * Matching is case-insensitive and checked before every acceptance rule. A
 * bare entry (`package.json`, `node_modules`) matches that name at any depth; a
 * path entry (`packages/web`) matches that directory and everything below it;
 * `*`, `?` and `**` are simple glob wildcards.
 */
export function isIgnoredWorkspacePath(path: string, ignore: readonly string[] | undefined): boolean {
  if (ignore === undefined || ignore.length === 0) return false
  const target = normaliseScopePath(path).toLowerCase()
  const segments = target.split('/').filter((segment) => segment.length > 0)
  for (const raw of ignore) {
    const entry = normaliseScopePath(raw).toLowerCase()
    if (entry.length === 0) continue
    if (entry.includes('*') || entry.includes('?')) {
      const matcher = globRegExp(entry)
      if (matcher.test(target)) return true
      if (!entry.includes('/') && segments.some((segment) => matcher.test(segment))) return true
      continue
    }
    if (entry.includes('/')) {
      if (target === entry || target.startsWith(`${entry}/`)) return true
      continue
    }
    if (target === entry || segments.includes(entry)) return true
  }
  return false
}

/**
 * True when a workspace-relative path is accepted by the workspace scan.
 *
 * The exact file names of the structural manifests are accepted first (the
 * default preset, or `policy.manifestNames`), then the extension allowlist.
 * The user ignore list is checked first, so it always wins: ignoring
 * `package.json` makes this function return `false` for it.
 */
export function isIndexableWorkspaceFile(
  path: string,
  policy: WorkspaceFilePolicy | readonly string[] = {},
): boolean {
  const settings: WorkspaceFilePolicy = Array.isArray(policy)
    ? { manifestNames: policy as readonly string[] }
    : (policy as WorkspaceFilePolicy)
  if (isIgnoredWorkspacePath(path, settings.ignore)) return false
  const manifestNames = settings.manifestNames ?? DEFAULT_MANIFEST_NAMES
  if (isManifestPath(path, manifestNames)) return true
  const extension = extensionOf(path)
  return extension.length > 0 && INDEX_FILE_EXTENSIONS.includes(extension)
}

function isSkippedWorkspaceDirectory(name: string): boolean {
  return INDEX_SKIP_DIRECTORIES.includes(name.toLowerCase())
}

function joinWorkspacePath(directory: string, name: string): string {
  return directory.length === 0 ? name : `${directory}/${name}`
}

/**
 * Scan the workspace and index every accepted text file.
 *
 * Breadth-first and deterministic: each directory's entries are sorted by
 * code-point name before they are visited, so a capped run always indexes the
 * same prefix of the workspace. `indexed` counts successful parses, `skipped`
 * counts files that were seen but not indexed (extension or parse failure);
 * directories are never counted. A directory that cannot be listed is skipped
 * without aborting the scan.
 */
export async function indexWorkspaceFiles(
  io: WorkspaceIndexIo,
  options: WorkspaceIndexOptions = {},
): Promise<WorkspaceIndexResult> {
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? MAX_INDEX_FILES))
  const timeLimitMs = Math.max(0, Math.floor(options.timeLimitMs ?? INDEX_TIME_LIMIT_MS))
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? MAX_INDEX_DEPTH))
  const manifestNames = options.manifestNames ?? DEFAULT_MANIFEST_NAMES
  const ignore = options.ignore ?? INDEX_DEFAULT_IGNORE
  const now = options.now ?? Date.now
  const startedAt = now()

  let indexed = 0
  let skipped = 0
  let nodes = 0
  let attempted = 0
  let truncated = false

  const pending: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }]

  scan: while (pending.length > 0) {
    if (now() - startedAt >= timeLimitMs) {
      truncated = true
      break
    }
    const directory = pending.shift() as { path: string; depth: number }
    let entries: readonly WorkspaceIndexEntry[]
    try {
      entries = await io.readDirectory(directory.path)
    } catch {
      // An unreadable directory contributes nothing; it must not abort the run.
      continue
    }
    const ordered = [...entries].sort((left, right) => compareText(left.name, right.name))
    for (const entry of ordered) {
      if (now() - startedAt >= timeLimitMs) {
        truncated = true
        break scan
      }
      if (entry.directory) {
        const childPath = joinWorkspacePath(directory.path, entry.name)
        // The user ignore list wins over every structural rule, including a
        // directory that merely happens to be named like a known build dir.
        if (isIgnoredWorkspacePath(childPath, ignore)) continue
        // A child directory is only descended into when its files can still be
        // within the depth bound (the child's entries are one level deeper).
        if (directory.depth + 1 >= maxDepth) continue
        if (isSkippedWorkspaceDirectory(entry.name)) continue
        pending.push({
          path: childPath,
          depth: directory.depth + 1,
        })
        continue
      }
      const path = joinWorkspacePath(directory.path, entry.name)
      if (!isIndexableWorkspaceFile(path, { manifestNames, ignore })) {
        skipped += 1
        continue
      }
      if (attempted >= maxFiles) {
        truncated = true
        break scan
      }
      attempted += 1
      try {
        const count = await io.indexFile(path)
        indexed += 1
        nodes += Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
      } catch {
        // Unsupported/binary/missing content: one skipped file, scan continues.
        skipped += 1
      }
    }
  }

  return {
    indexed,
    skipped,
    nodes,
    durationMs: Math.max(0, now() - startedAt),
    truncated,
  }
}

/** Outcome of one gated workspace index run. */
export type WorkspaceIndexGateOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; busy: true }

/**
 * Serialize workspace indexes in one host process.
 *
 * The flag flips synchronously before the task's first `await`, so a second
 * request in the same tick answers BUSY instead of queuing behind the scan.
 * The `finally` reset means a thrown task never leaves the gate stuck.
 */
export class WorkspaceIndexGate {
  private active = false

  isBusy(): boolean {
    return this.active
  }

  async run<T>(task: () => Promise<T>): Promise<WorkspaceIndexGateOutcome<T>> {
    if (this.active) return { ok: false, busy: true }
    this.active = true
    try {
      return { ok: true, value: await task() }
    } finally {
      this.active = false
    }
  }
}
