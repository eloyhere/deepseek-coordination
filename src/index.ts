/**
 * deepseek-coordination — Host half (Cordis plugin running in the Node process)
 *
 * Composition root: one coordination database, one service, one HTTP surface,
 * one agent-turn lifecycle. The client half (src/client) reads and writes the
 * five composer dropdowns through `/deepseek-coordination/selection`.
 *
 * Contract notes:
 *  - Hard dependencies go in `inject`; apply() runs only once they are ready.
 *  - Everything registered through ctx is disposed on unload — the route
 *    disposer is returned from ctx.effect().
 *  - The route prefix is absolute with no trailing slash; kind 'prefix' matches
 *    every sub-path beneath it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, resolveConfig, type CoordinationConfig } from './host/config.js'
import { CoordinationService } from './host/coordination.js'
import { resolveDatabasePath } from './host/database.js'
import { createRuntime, installTurnLifecycle } from './host/dsh.js'
import { applyConfigPatch } from './host/selection.js'
import { withAmpReceipts } from './host/amp.js'
import { handleAmpRoute } from './host/amp-routes.js'
import { readOverrides, settingsPath, writeOverrides } from './host/settings-store.js'
import { createProxyService } from './host/proxy-service.js'
import { brandProfileOf, shouldDecorate } from './host/model-brand.js'
import type { GenerateOptionsLike } from './shared/service.js'
import {
  createToolWorkspaceRootResolver,
  registerCoordinationGraphTools,
  registerCoordinationTools,
  resolveToolWorkspaceRoot,
  toolRegistryOf,
  type ToolWorkspaceRootResolver,
} from './host/tools.js'
import { GraphStore } from './host/graph-store.js'
import { ParseService } from './host/parse-service.js'
import { ChainEngine } from './host/chain.js'
import { NodeRegistry } from './host/node-registry.js'
import {
  MAX_PREVIEW_ARCHIVE_BYTES,
  MAX_PREVIEW_TEXT_BYTES,
  WorkspaceIndexGate,
  agentMessagesRoute,
  buildAgentRoster,
  buildDependencies,
  buildDocxPreview,
  buildImports,
  buildIntra,
  buildOutline,
  buildPptxPreview,
  buildTextPreview,
  buildTree,
  buildXlsxPreview,
  collectAgentRoster,
  createGraphQuery,
  graphVersionOf,
  indexWorkspaceFiles,
  isOfficePreviewKind,
  normaliseGraphPath,
  previewKindOf,
  resetGraphCache,
  resolveAgentSessionEvents,
  searchGraph,
  workspaceIndexReport,
  type AgentServiceBundle,
  type GraphEdge,
  type GraphNode,
  type GraphQuery,
  type GraphScope,
  type PreviewValue,
  type WorkspaceIndexEntry,
  type WorkspaceIndexIo,
  type WorkspaceIndexReport,
} from './host/graph-view.js'
import type { TakeoverGateAnswer } from './host/takeover-gate.js'
import { CoordinationError, InvalidArgumentError, InvalidStateError, NotFoundError, toErrorJson } from './shared/error.js'
import { normaliseLocale, type Locale } from './shared/i18n.js'
import { ABOUT } from './shared/about.js'
import type { Profession } from './shared/enum.js'
import type { ConfigPatch, ConfigScalar } from './shared/selection.js'
import { writeConfigPath } from './shared/selection.js'

export const name = 'deepseek-coordination'

export const inject = ['webServer', 'tools']

export { Config }

/** Route prefix owned by this plugin. Mirrors src/client/bridge.ts. */
const ROUTE_PREFIX = '/deepseek-coordination'

/** Unified JSON response envelope: { ok: true, value } | { ok: false, error }. */
function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/** Shared 400 for every `/graph/*` path query with an invalid path. */
function invalidGraphPath(response: ServerResponse): void {
  json(
    response,
    {
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'path must be a workspace-relative path without ".."',
      },
    },
    400,
  )
}

/** Read a POST JSON body, with a size cap that guards against oversized payloads. */
const BODY_CAP_BYTES = 1 << 20

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const part = chunk as Buffer
    total += part.length
    if (total > BODY_CAP_BYTES) {
      request.destroy()
      return null
    }
    chunks.push(part)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function statusOf(error: unknown): number {
  if (!(error instanceof CoordinationError)) return 500
  switch (error.code) {
    case 'PROFESSION_LOCKED':
    case 'PROFESSION_REQUIRED':
      return 409
    case 'INVALID_ARGUMENT':
    case 'INVALID_STATE':
      return 400
    case 'NOT_FOUND':
      return 404
    case 'NOT_IMPLEMENTED':
      return 501
    case 'PERMISSION':
      return 403
    default:
      return 500
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function sessionOf(url: URL, body?: Record<string, unknown>): string {
  const fromQuery = url.searchParams.get('session')
  const fromBody = typeof body?.session === 'string' ? body.session : undefined
  return (fromQuery ?? fromBody ?? '').trim()
}

/* ------------------------------------------------------------------------- *
 * Read-only workspace graph (the `/graph/*` routes)
 * ------------------------------------------------------------------------- */

/** One body-free snapshot of the persisted v24 graph plus its version. */
interface GraphSnapshot {
  /** Absolute workspace root the indexed paths are relative to. */
  root: string
  /** Changes whenever the snapshot changes; keys the graph-view L2 cache. */
  version: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Read the graph the file layer has persisted, without parsing or writing.
 *
 * The chain engine itself is a private part of the file-tool runtime, so the
 * routes read its durable projection instead: `GraphStore.loadNodes()` /
 * `loadEdges()` are the store's own bounded, read-only queries (newest 10k
 * nodes / 50k edges). No parse is triggered, no snapshot is written, and an
 * empty database simply yields empty projections.
 *
 * The workspace root is supplied by the caller: the `/graph/*` routes resolve
 * it per request with the async, request-scoped resolver, so the graph these
 * projections describe is the graph of the session workspace; `version` is the
 * route-side equivalent of the chain's monotonic `graphVersion`.
 *
 * The default root keeps the file-tool resolver for internal callers that do
 * not carry a request context (rebuild, intra); the graph routes always pass
 * their resolved root explicitly.
 */
function graphSnapshotOf(service: CoordinationService, root = resolveToolWorkspaceRoot(service)): GraphSnapshot {
  const store = new GraphStore(service.db, { workspaceRoot: root })
  const nodes: GraphNode[] = store.loadNodes().map((record) => ({
    handle: record.handle,
    kind: record.kind,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.label === undefined ? {} : { label: record.label }),
    ...(record.path === undefined ? {} : { path: record.path }),
    ...(record.lineStart === undefined ? {} : { line: record.lineStart }),
    ...(record.ordinal === undefined ? {} : { ordinal: record.ordinal }),
    ...(record.changed === undefined ? {} : { changed: record.changed }),
  }))
  const edges: GraphEdge[] = store.loadEdges().map((edge) => ({
    relation: edge.relation,
    from: edge.from,
    to: edge.to,
    changed: edge.changed,
  }))
  return { root, version: graphVersionOf(nodes, edges), nodes, edges }
}

/** One scoped query over a snapshot; the scope is part of the L2 cache key. */
function graphQueryOf(snapshot: GraphSnapshot, scope: GraphScope): GraphQuery {
  return createGraphQuery({
    version: snapshot.version,
    scope,
    // Project scopes are resolved against the same root the snapshot was read
    // for: the workspace root, never a prefix inferred from the file paths.
    workspaceRoot: snapshot.root,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
  })
}

/**
 * Resolve the workspace root for one `/graph/*` request.
 *
 * The resolver is request-scoped by construction: its answer is cached on the
 * instance for the duration of this request only, so two requests (or two
 * sessions) never share a root. An invalid explicit `root` throws
 * `InvalidArgumentError`, which the route handler maps to 400.
 */
function graphRootResolver(
  service: CoordinationService,
  context: Context,
  url: URL,
): ToolWorkspaceRootResolver {
  return createToolWorkspaceRootResolver(service, {}, {
    root: url.searchParams.get('root'),
    context,
  })
}

/* ------------------------------------------------------------------------- *
 * Preview — the only body-bearing file-content route
 * ------------------------------------------------------------------------- */

/**
 * Preview is the only body-bearing file-content route: workspace-relative only,
 * 64 KiB cap, user-initiated, never cached or logged. The agent transcript
 * route is the other body-bearing route, but it reads bounded session records
 * (never file content) and is equally no-store and unlogged; every other graph
 * route stays body-free.
 */

/** Hard cap on the bytes one text preview may return. */
const PREVIEW_MAX_BYTES = MAX_PREVIEW_TEXT_BYTES

/**
 * Read one bounded, user-initiated preview of a workspace file.
 *
 * Text goes through `ParseService.readContent`, i.e. exactly the validation and
 * containment path `coordination_read` uses: workspace-relative only, realpath
 * checked against the workspace root (symlink escapes refused), UTF-8 decoded
 * with fatal validation, binary/NUL refused. Office packages are read as bytes
 * through the same containment checks and converted **in memory only** by the
 * payload builders in `host/graph-view.ts`: no temporary file, no external
 * process, no LibreOffice. Preview never parses into the graph, never caches a
 * body and never logs one; the metadata-only parse caches are untouched.
 *
 * BOM handling: byte ranges exclude a UTF-8 BOM, so `start: 0` is refused for a
 * BOM-prefixed file; retry just after it. Both attempts read at most 64 KiB.
 *
 * The workspace root is resolved per request (the same async resolver as the
 * other graph reads) so a desktop install directory can never be used as the
 * preview root; the lexical + realpath containment checks below still run
 * against that resolved root, unchanged.
 */
async function previewOf(
  path: string,
  workspaceRoot: string,
): Promise<PreviewValue> {
  const parser = new ParseService({ workspaceRoot })
  const relative = parser.relativePath(path)
  const kind = previewKindOf(relative)
  if (isOfficePreviewKind(kind)) {
    const bytes = readOfficePreviewBytes(parser, relative)
    if (kind === 'docx') return buildDocxPreview(relative, bytes)
    if (kind === 'xlsx') return buildXlsxPreview(relative, bytes)
    return buildPptxPreview(relative, bytes)
  }
  let result: ReturnType<ParseService['readContent']>
  try {
    result = parser.readContent({ path: relative, mode: 'bytes', start: 0, maxBytes: PREVIEW_MAX_BYTES })
  } catch (error) {
    if (error instanceof InvalidArgumentError && error.message.includes('BOM')) {
      result = parser.readContent({ path: relative, mode: 'bytes', start: 3, maxBytes: PREVIEW_MAX_BYTES })
    } else {
      throw error
    }
  }
  return buildTextPreview(
    relative,
    kind,
    result.content,
    result.truncated,
    result.byteRange.end - result.byteRange.start,
  )
}

/**
 * Read one Office package with the same containment guarantees as a text read.
 *
 * `ParseService.absolutePath` applies the lexical workspace-relative check;
 * `realpathSync` then refuses a symlink that resolves outside the root. The
 * file is opened once and `fstat` bounds the read, so at most
 * {@link MAX_PREVIEW_ARCHIVE_BYTES} bytes reach the in-memory converter.
 */
function readOfficePreviewBytes(parser: ParseService, relative: string): Uint8Array {
  const absolute = parser.absolutePath(relative)
  let real: string
  try {
    real = realpathSync(absolute)
  } catch {
    throw new NotFoundError('file', relative)
  }
  let root: string
  try {
    root = realpathSync(parser.workspaceRoot)
  } catch {
    throw new InvalidStateError('workspace root is not readable')
  }
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (real !== root && !real.startsWith(prefix)) {
    throw new InvalidArgumentError('path resolves outside the workspace root', { path: relative })
  }

  let fd: number
  try {
    fd = openSync(real, 'r')
  } catch {
    throw new NotFoundError('file', relative)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new InvalidArgumentError('path is not a regular file', { path: relative })
    if (stat.size > MAX_PREVIEW_ARCHIVE_BYTES) {
      throw new InvalidStateError(
        `Office preview package exceeds the ${MAX_PREVIEW_ARCHIVE_BYTES}-byte cap`,
      )
    }
    const buffer = Buffer.allocUnsafe(stat.size)
    let read = 0
    while (read < stat.size) {
      const count = readSync(fd, buffer, read, stat.size - read, read)
      if (count <= 0) break
      read += count
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, read)
  } finally {
    closeSync(fd)
  }
}

/* ------------------------------------------------------------------------- *
 * Rebuild — re-index the already-known workspace files
 * ------------------------------------------------------------------------- */

/** Maximum files one rebuild re-parses. */
const REBUILD_FILE_CAP = 2_000
/** Wall-clock budget of one rebuild; overrun reports the completed count. */
const REBUILD_TIME_LIMIT_MS = 10_000

/** True while a rebuild runs; a second concurrent request answers BUSY. */
let rebuildInFlight = false

/** Value of `POST /graph/rebuild`. */
interface RebuildValue {
  files: number
  nodes: number
  durationMs: number
  truncated: boolean
}

/**
 * Re-parse and re-index every file the graph already knows.
 *
 * This is the only graph action, and it stays within the read-only contract:
 * the file system is only read, no build/command/execution runs, and only the
 * coordination database's own graph rows are refreshed. Each file goes through
 * the normal `ParseService` budgets, then `NodeRegistry` + `ChainEngine` rebuild
 * its cards and edges in one transaction; a single unreadable or unsupported
 * file is skipped without aborting the run.
 *
 * Bounds: at most {@link REBUILD_FILE_CAP} files and
 * {@link REBUILD_TIME_LIMIT_MS} ms — overrun returns the completed counts with
 * `truncated: true`. The L2 dependency cache is cleared unconditionally at the
 * end, and the rewritten rows bump the snapshot-derived graph version, so every
 * `/graph/*` view is invalidated (L1 is request-scoped and already discarded).
 */
async function rebuildGraph(service: CoordinationService): Promise<RebuildValue> {
  const startedAt = Date.now()
  const root = resolveToolWorkspaceRoot(service)
  const known = graphQueryOf(graphSnapshotOf(service, root), 'workspace').paths
  const store = new GraphStore(service.db, { workspaceRoot: root })
  const parser = new ParseService({ workspaceRoot: root })
  const registry = new NodeRegistry({ persist: { saveNode: (record) => store.saveNode(record) } })
  const chain = new ChainEngine({
    persist: {
      saveNode: (node) => store.saveChainNode(node),
      saveEdge: (edge) => store.saveEdge(edge),
      deleteEdge: (edge) => store.deleteEdge(edge),
    },
  })

  const targets = known.slice(0, REBUILD_FILE_CAP)
  let files = 0
  let nodes = 0
  let truncated = known.length > targets.length
  for (const path of targets) {
    if (Date.now() - startedAt >= REBUILD_TIME_LIMIT_MS) {
      truncated = true
      break
    }
    // Yield once per file so a concurrent request sees the in-flight flag and
    // answers BUSY instead of waiting for the whole rebuild.
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    let parsed: ReturnType<ParseService['parse']>
    try {
      parsed = parser.parse({ path })
    } catch {
      // Unsupported extension or a file removed since indexing: keep going.
      continue
    }
    try {
      const cards = store.transaction(() => {
        store.beginParse(path)
        const registered = registry.register(parsed)
        chain.index(parsed)
        store.saveSnapshot(parsed, { nodeCount: registered.length })
        return registered.length
      })
      files += 1
      nodes += cards
    } catch {
      // One bad file must never abort the rest of the rebuild.
    }
  }
  resetGraphCache()
  return { files, nodes, durationMs: Date.now() - startedAt, truncated }
}

/* ------------------------------------------------------------------------- *
 * Index — scan the workspace and index files that are not in the graph yet
 * ------------------------------------------------------------------------- */

/**
 * Serializes `POST /graph/index`: the flag flips before the first await, so a
 * concurrent request answers 409 `BUSY` instead of queuing behind the scan.
 */
const indexGate = new WorkspaceIndexGate()

/**
 * Explicit indexing entry point for a profile whose graph is still empty.
 *
 * The file tools only index the paths they are asked to parse, so a fresh
 * workspace legitimately has no graph and the panels show their empty state.
 * This scan walks the workspace instead: the bounds (depth ≤ 8, accepted
 * extensions, skipped directories, 200 files / 10 s) live beside the pure
 * walker in `host/graph-view.ts`; this adapter only binds it to the same
 * services {@link rebuildGraph} uses.
 *
 * Read-only: directories are listed, accepted files are read through
 * `ParseService`'s budgeted read path, and only the coordination database's own
 * graph rows are rewritten. No build, command or execution runs, no workspace
 * file is written, and symlinks are not followed.
 */
async function indexWorkspace(service: CoordinationService, root: string): Promise<WorkspaceIndexReport> {
  const parser = new ParseService({ workspaceRoot: root })
  const store = new GraphStore(service.db, { workspaceRoot: root })
  const registry = new NodeRegistry({ persist: { saveNode: (record) => store.saveNode(record) } })
  const chain = new ChainEngine({
    persist: {
      saveNode: (node) => store.saveChainNode(node),
      saveEdge: (edge) => store.saveEdge(edge),
      deleteEdge: (edge) => store.deleteEdge(edge),
    },
  })

  const io: WorkspaceIndexIo = {
    async readDirectory(path: string): Promise<readonly WorkspaceIndexEntry[]> {
      const absolute = path.length === 0 ? root : join(root, path)
      const entries = await readdir(absolute, { withFileTypes: true })
      // A symlink is never followed: the scan cannot leave the workspace and
      // cannot index one file twice through an alias.
      return entries
        .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    },
    async indexFile(path: string): Promise<number> {
      const parsed = parser.parse({ path })
      return store.transaction(() => {
        store.beginParse(path)
        const registered = registry.register(parsed)
        chain.index(parsed)
        store.saveSnapshot(parsed, { nodeCount: registered.length })
        return registered.length
      })
    },
  }

  const result = await indexWorkspaceFiles(io)
  // Rewritten rows bump the snapshot-derived graph version; drop L2 explicitly.
  resetGraphCache()
  // The root is part of the answer: a wrong root is visible, not silent, and a
  // zero-file scan carries the `no-workspace-files` diagnostic.
  return workspaceIndexReport(result, root)
}

/**
 * Nest a flat dotted override map, then merge it over the deployment config.
 *
 * Stored overrides win over the profile patch: the operator changed those paths
 * from the page, which is the most recent intent. `resolveConfig` still applies
 * every invariant afterwards (forced flags, weight normalisation, clamping).
 */
function mergeOverrides(
  input: Partial<CoordinationConfig> | undefined,
  overrides: Readonly<Record<string, ConfigScalar>>,
): Partial<CoordinationConfig> {
  const document: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overrides)) writeConfigPath(document, key, value)
  return deepMergeRecords(input ?? {}, document) as Partial<CoordinationConfig>
}

/** Recursive merge for plain records; arrays and scalars replace. */
function deepMergeRecords(base: unknown, patch: unknown): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    result[key] = key in result ? deepMergeRecords(result[key], value) : value
  }
  return result
}

/** Resolve a Cordis service without tripping the context proxy. */
function serviceOrUndefined(context: Context, name: string): Record<string, unknown> | undefined {
  const getter = (context as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  try {
    const value = getter.call(context, name)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Optional host services the two read-only `/graph/agents*` routes may read.
 *
 * Every entry is capability-optional: a headless or minimal profile may mount
 * none of them, in which case the roster is empty and a transcript lookup is
 * `NOT_FOUND`. Only read methods are called by `host/graph-view.ts`; this
 * bundle never grants a send/cancel/resume path.
 */
function agentServicesOf(context: Context): AgentServiceBundle {
  return {
    agents: serviceOrUndefined(context, 'agents'),
    sessions: serviceOrUndefined(context, 'sessions'),
    subagents: serviceOrUndefined(context, 'subagents'),
    sessionQuery: serviceOrUndefined(context, 'sessionQuery'),
    goals: serviceOrUndefined(context, 'goals'),
    sessionProjections: serviceOrUndefined(context, 'sessionProjections'),
    sessionProjectionCache: serviceOrUndefined(context, 'sessionProjectionCache'),
    sessionPersistence: serviceOrUndefined(context, 'sessionPersistence'),
  }
}

/** The host webserver, when the profile runs one (a headless profile does not). */
function webServerOf(context: Context): { register: (route: Record<string, unknown>) => () => void } | undefined {
  const service = serviceOrUndefined(context, 'webServer')
  return service !== undefined && typeof service.register === 'function'
    ? (service as unknown as { register: (route: Record<string, unknown>) => () => void })
    : undefined
}

export function apply(context: Context, configInput?: Partial<CoordinationConfig>): void {
  // The override document lives beside the coordination database, so the
  // database path decides where the page's durable edits go.
  const configured = resolveConfig(configInput)
  const settingsFile = settingsPath(resolveDatabasePath(configured.databasePath, configured.database))
  const stored = readOverrides(settingsFile)
  const config = Object.keys(stored).length === 0 ? configured : resolveConfig(mergeOverrides(configInput, stored))

  const runtime = createRuntime(context)
  const service = new CoordinationService(context, config, runtime)
  service.turn.recoverInterrupted()

  /*
   * Cache proxy (experiment, off by default): `proxy.enable` or
   * `DSH_COORDINATION_PROXY=1` decides whether the proxy is attached at all.
   * The installation itself lives in `host/proxy-service.ts`; rewriting is a
   * separate `proxy.mode` / `proxy.rewrite` switch and defaults to measurement.
   *
   * The decorator is brand-gated: only families with an automatic prefix cache
   * get the stable-prefix rewrite. An explicit-breakpoint family keeps its bytes
   * untouched, because markers — not text normalization — decide reuse there.
   */
  const proxyStateDir = dirname(settingsFile)
  const proxyEnabled =
    process.env.DSH_COORDINATION_PROXY === '1' || existsSync(join(proxyStateDir, 'proxy.enable'))
  const decorate = (
    request: Record<string, unknown>,
    identity: { provider: string; model: string },
  ): Record<string, unknown> => {
    const profile = brandProfileOf(identity)
    // `config` is the live object, so a settings-page toggle applies at once.
    if (!shouldDecorate(profile, config.cache.enabled)) return request
    const strategy = service.provider.cacheStrategy(identity.provider)
    const decorated = service.cache.decorate(
      request as unknown as GenerateOptionsLike,
      strategy,
    ) as unknown as Record<string, unknown>
    // `cacheWarning` is UI advice; a provider adapter must never receive it.
    const { cacheWarning: _advice, ...outgoing } = decorated
    return outgoing
  }
  const proxy = createProxyService({ context, stateDir: proxyStateDir, decorate })
  if (proxyEnabled) {
    context.effect(() => proxy.install(), `${name}: cache proxy`)
  }

  /** Re-register the tools after `POST /locale` changed the copy language. */
  let refreshTools: ((locale: Locale) => void) | undefined

  context.effect(() => () => { service.dispose() }, `${name}: database`)

  context.effect(() => {
    const timer = setInterval(() => { service.cleanupExpired() }, 60000)
    return () => { clearInterval(timer) }
  }, `${name}: cleanup`)

  context.effect(() => installTurnLifecycle(context, {
    begin: async (observation) => {
      await service.beginTurn(observation.session, observation.turn, observation.prompt ?? '')
    },
    end: async (observation) => {
      service.endTurn(observation.session, 'done')
    },
    fail: (observation) => {
      service.failTurn(observation.session)
    },
  }), `${name}: turn lifecycle`)

  /*
   * Automatic compaction: the governor estimates the step's context, and only
   * when it crosses the configured soft/hard threshold (with a cooldown and a
   * per-session cap) does it ask DSH's `compactIfNeeded`. DSH owns the safe
   * range; a null/throw/timeout is a no-op and the step always proceeds.
   */
  context.effect(() => {
    const on = (context as unknown as {
      on?: (name: string, listener: (...args: never[]) => unknown) => (() => void) | undefined
    }).on
    if (typeof on !== 'function') return () => {}
    const dispose = on.call(context, 'agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
      try {
        const record = asRecord(payload)
        const sessionId = typeof asRecord(record?.agent)?.id === 'string' ? String(asRecord(record?.agent)?.id) : ''
        const messages = Array.isArray(record?.messages)
          ? record.messages.filter((message) => asRecord(message) !== undefined)
          : []
        const signal = record?.signal as AbortSignal | undefined
        if (sessionId.length > 0 && messages.length > 0) {
          await service.maybeCompact(sessionId, messages as ReadonlyArray<{ role: string; content: unknown }>, signal)
        }
      } catch {
        // Compaction is an optimization; it never blocks the agent step.
      }
      return await next()
    })
    return () => { dispose?.() }
  }, `${name}: auto compaction`)

  /*
   * Service-level takeover (v24 §16): the gate intercepts DSH's
   * `approval/request` and `user-questions/request` waterfalls and answers only
   * from a human decision delivered through the Client routes below. Disabled
   * via `ui.takeover` it delegates immediately; unload delegates every open
   * request instead of leaving a host dialog blocked.
   */
  context.effect(() => service.takeoverGate.install(context), `${name}: takeover gate`)

  /*
   * AMP observer: a whitelist of module-bus events is mirrored into the
   * append-only ledger. Only structure is copied (ids, counts, decisions), so no
   * prompt, question or tool-output text enters the chain. The observer is an
   * effect: unloading the plugin unsubscribes every listener.
   */
  context.effect(() => service.amp.observe(service.host.events), `${name}: amp ledger`)

  /*
   * Tool descriptions are part of the model-facing prompt, so they are read at
   * registration time. A locale change therefore disposes the set and registers
   * it again; `ctx.effect` owns the final teardown, and the HTTP route owns the
   * in-place refresh.
   */
  context.effect(() => {
    let dispose: (() => void) | undefined
    const install = (locale: Locale): void => {
      dispose?.()
      const registry = toolRegistryOf(context)
      // AMP v0.1: every tool call settles as a receipt in the ledger. The
      // decorator passes the definition through unchanged, so the model sees
      // exactly the same name, description and schemas.
      const receipted = withAmpReceipts(registry, service.amp)
      // Two sets with independent lifetimes: the documented seven-tool file
      // surface and the four read-only graph tools. The graph set gets the
      // apply-time context so its per-call workspace-root resolution follows
      // the same session workspace the `/graph/*` routes use.
      const disposeFileTools = registerCoordinationTools(receipted, service, locale, { context })
      let disposeGraphTools: () => void
      try {
        disposeGraphTools = registerCoordinationGraphTools(receipted, service, locale, { context })
      } catch (error) {
        // Never leave the first set registered when the second one fails.
        disposeFileTools()
        throw error
      }
      dispose = () => {
        disposeGraphTools()
        disposeFileTools()
      }
    }
    install(normaliseLocale(service.locale))
    refreshTools = install
    return () => {
      refreshTools = undefined
      dispose?.()
      dispose = undefined
    }
  }, `${name}: tools`)

  context.effect(() => {
    // The HTTP surface is optional: a headless profile has no webserver, and the
    // coordination host still owns its database, tools and lifecycle there.
    // Reading `ctx.webServer` without `inject` would trip the Cordis proxy, so
    // the service is resolved defensively and its absence just skips the routes.
    const webServer = webServerOf(context)
    if (webServer === undefined) return () => {}
    const dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const url = new URL(request.url ?? '/', 'http://coordination.local')
        const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
        const method = request.method ?? 'GET'

        try {
          if (path === '/ping' && method === 'GET') {
            json(response, {
              ok: true,
              value: { plugin: name, version: ABOUT.version, pong: true, locale: service.locale },
            })
            return
          }

          // Read-only observability for the cache proxy. Counts, route ids,
          // token totals and prefix hashes only: this endpoint exists so the
          // host can see whether the proxy measures or normalises, and what it
          // forwarded, never what the model was told.
          if (path === '/proxy/status' && method === 'GET') {
            json(response, { ok: true, value: proxy.status() })
            return
          }

          /*
           * AMP v0.1 surface (attention-manifest-protocol 0.1).
           *
           * The route table lives in `host/amp-routes.ts` so it is testable
           * without a Cordis context or a webserver. The body is still the
           * plugin's `{ ok, value }` envelope, but `value` is the AMP object as
           * the protocol defines it — the same bytes whose canonical form is
           * signed or digested, never a reshaped copy.
           *
           *   GET  /amp/identity            -> { kid, alg, publicKey }
           *   GET  /amp/manifest            -> signed Manifest (reissued on expiry)
           *   GET  /amp/frame?session=<id>  -> latest Frame for one session
           *   GET  /amp/receipts[?limit=n]  -> newest-first Receipts
           *   GET  /amp/ledger[?limit=n][&full=1] -> chain head + entries
           *   GET  /amp/verify              -> recomputed chain verdict
           *   POST /amp/checkpoint          -> signed LedgerCheckpoint
           *
           * No response carries the private key or any content body.
           */
          const ampRoute = await handleAmpRoute(
            { path, method, url, session: sessionOf(url) },
            service,
          )
          if (ampRoute !== undefined) {
            json(response, ampRoute.body, ampRoute.status)
            return
          }

          if (path === '/echo' && method === 'POST') {
            json(response, { ok: true, value: await readJsonBody(request) })
            return
          }

          if (path === '/selection' && method === 'GET') {
            const session = sessionOf(url)
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            json(response, { ok: true, value: service.state(session) })
            return
          }

          if (path === '/selection' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            const patch = asRecord(body?.patch) ?? {}
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            json(response, { ok: true, value: service.setSelection(session, patch as never) })
            return
          }

          if (path === '/presets' && method === 'GET') {
            json(response, { ok: true, value: service.presets() })
            return
          }

          if (path === '/permission' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            const preset = typeof body?.preset === 'string' ? body.preset : ''
            if (session.length === 0 || preset.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session and preset are required' } }, 400)
              return
            }
            json(response, { ok: true, value: { preset: service.setPermission(session, preset) } })
            return
          }

          if (path === '/takeover/pending' && method === 'GET') {
            const session = sessionOf(url)
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            // The Client knows the DSH session id, so the service resolves it to
            // a coordination identity; an unknown session simply has nothing.
            json(response, { ok: true, value: service.listPendingTakeover(session) })
            return
          }

          if (path === '/takeover/answer' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const handle = typeof body?.handle === 'string' ? body.handle.trim() : ''
            const answer = asRecord(body?.answer)
            if (handle.length === 0 || answer === undefined) {
              json(
                response,
                { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'handle and answer are required' } },
                400,
              )
              return
            }
            const answered = service.answerPendingTakeover(handle, answer as TakeoverGateAnswer)
            if (!answered) {
              // The gate keeps an invalid answer's window open, while an
              // answered, cancelled or expired handle has no window left.
              const stillPending = service.takeoverGate.list().some((view) => view.handle === handle)
              if (!stillPending) {
                json(
                  response,
                  { ok: false, error: { code: 'NOT_FOUND', message: `takeover ${handle} is not pending` } },
                  404,
                )
              } else {
                json(
                  response,
                  {
                    ok: false,
                    error: { code: 'INVALID_ARGUMENT', message: 'takeover answer is invalid for the pending window' },
                  },
                  400,
                )
              }
              return
            }
            json(response, { ok: true, value: { answered: true } })
            return
          }

          if (path === '/takeover/cancel' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const handle = typeof body?.handle === 'string' ? body.handle.trim() : ''
            if (handle.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'handle is required' } }, 400)
              return
            }
            json(response, { ok: true, value: { cancelled: service.cancelPendingTakeover(handle) } })
            return
          }

          if (path === '/profession/rebuild' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            const profession = typeof body?.profession === 'string' ? body.profession : ''
            if (session.length === 0 || profession.length === 0) {
              json(
                response,
                { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session and profession are required' } },
                400,
              )
              return
            }
            // The service validates the profession and the active-turn rule;
            // a failed rebuild keeps the old task and the old selection intact.
            json(response, { ok: true, value: service.rebuildProfession(session, profession as Profession) })
            return
          }

          if (path === '/profession/abandon' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            if (session.length === 0) {
              json(
                response,
                { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } },
                400,
              )
              return
            }
            json(response, { ok: true, value: service.abandonProfession(session) })
            return
          }

          if (path === '/locale' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const locale = typeof body?.locale === 'string' ? body.locale : ''
            const current = service.setLocale(locale)
            // Tool descriptions are baked at registration time (the model-facing
            // prompt is assembled from them), so re-register with the new copy.
            refreshTools?.(normaliseLocale(current))
            json(response, { ok: true, value: { locale: current } })
            return
          }

          if (path === '/config/compaction' && method === 'POST') {
            const body = asRecord(await readJsonBody(request)) ?? {}
            json(response, { ok: true, value: service.applyCompactionPolicy(body) })
            return
          }

          /*
           * Full settings surface (v24 §19):
           *   GET  /config -> ConfigView { values, defaults }
           *   POST /config { patch: { "plan.threshold": 0.6 } }
           *        -> { applied, ignored, normalised, persisted, config }
           * The patch route validates against the config schema, applies to the
           * live service config (the session projection derives from it), then
           * attempts a DSH settings write. Unknown keys and `databasePath` are
           * refused with INVALID_ARGUMENT, never silently ignored.
           */
          if (path === '/config' && method === 'GET') {
            json(response, { ok: true, value: service.selection.configView() })
            return
          }

          if (path === '/config' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const patch = asRecord(body?.patch) ?? body ?? {}
            const outcome = applyConfigPatch(service.config, patch as ConfigPatch)
            // The token governor snapshots the compaction policy at
            // construction; re-apply the triple so a live edit reaches it.
            if (outcome.compaction !== null) service.applyCompactionPolicy(outcome.compaction)
            // Persist only what was actually written: ignored (forced /
            // read-only / planned) paths must never leak into a DSH settings
            // write, even though they were valid request keys.
            const appliedPatch: Record<string, unknown> = {}
            for (const key of outcome.applied) appliedPatch[key] = patch[key]
            // Durability is this host's own override document: DSH's settings
            // service refuses non-volatile fields and a volatile schema would
            // wrap every config value, so the page persists beside the database.
            const persisted = outcome.applied.length > 0
              ? writeOverrides(settingsFile, appliedPatch as Record<string, ConfigScalar>)
              : false
            json(response, {
              ok: true,
              value: {
                applied: outcome.applied,
                ignored: outcome.ignored,
                normalised: outcome.normalised,
                persisted,
                config: service.selection.configView(),
              },
            })
            return
          }

          /*
           * Read-only workspace graph.
           *
           * Every route is body-free and side-effect free: it reads the graph
           * the file tools already persisted and projects it through the pure
           * helpers in `host/graph-view.ts`. No parse is triggered, no file is
           * written and no prompt/credential/diagnostic text crosses the wire
           * for the workspace-graph routes.
           *
           * The two agent routes are read-only projections of the host's own
           * session records. `/graph/agents/messages` is body-bearing but
           * bounded: one known id, no-store, newest 200 messages / 64 KiB and
           * text blocks only. `/graph/agents` is JSON metadata (labels,
           * objectives, timestamps, estimated progress); both are no-store and
           * neither can send, cancel, resume or write.
           *
           * An empty graph (nothing parsed yet) or absent agent services answer
           * with empty projections, never an error; a file-scoped query for an
           * unindexed path is NOT_FOUND, as is an unknown agent id.
           *
           * Every graph read resolves its workspace root per request through
           * the async resolver: an explicit `?root=<absolute dir>` wins, then
           * the service/host declarations, the sandbox policy resolved with the
           * active session, `workingDirectory.ensure`, the session's recorded
           * `workingDirectory`, and only then `process.cwd()`. An invalid
           * explicit root is a 400. The resolved root is part of the answer
           * where a wrong root would otherwise look like an empty workspace.
           *
           *   GET /graph/tree                     -> { root, entries, projects }
           *   GET /graph/outline[?path=<rel>]     -> file | workspace outline
           *   GET /graph/intra?path=<rel>         -> in-file symbols + edges
           *   GET /graph/dependencies[?path=<rel>][&level=file|intra]
           *                                       -> file | workspace links/cycles
           *   GET /graph/imports[?path=<rel>]     -> file | workspace rows
           *   GET /graph/search?q=<text>&limit=<n> -> { hits }
           *   GET /graph/agents                   -> { agents, progress }
           *   GET /graph/agents/messages?id=<id>  -> bounded transcript
           *   GET /graph/preview?path=<rel>       -> only body-bearing file route
           *   POST /graph/rebuild                 -> re-index known paths (action)
           *   POST /graph/index                   -> scan + index a fresh workspace
           *                                          { indexed, skipped, nodes,
           *                                            durationMs, truncated, root,
           *                                            diagnostics? } (action)
           */
          if (path === '/graph/tree' && method === 'GET') {
            const root = await graphRootResolver(service, context, url).resolve()
            const snapshot = graphSnapshotOf(service, root)
            json(response, { ok: true, value: buildTree(snapshot.nodes, snapshot.root) })
            return
          }

          if (path === '/graph/outline' && method === 'GET') {
            // `path` is optional: present means one file, absent the whole
            // workspace. An explicitly empty/invalid path is a 400, never a
            // silent fallback to the workspace view.
            const hasPath = url.searchParams.has('path')
            const requested = hasPath ? normaliseGraphPath(url.searchParams.get('path')) : undefined
            if (hasPath && requested === undefined) {
              invalidGraphPath(response)
              return
            }
            const root = await graphRootResolver(service, context, url).resolve()
            const snapshot = graphSnapshotOf(service, root)
            const scope: GraphScope = requested === undefined ? 'workspace' : 'file'
            json(response, { ok: true, value: buildOutline(graphQueryOf(snapshot, scope), requested) })
            return
          }

          if (path === '/graph/intra' && method === 'GET') {
            // `path` is mandatory here: the intra route describes exactly one
            // indexed file, and its projection is body-free symbol metadata.
            const requested = normaliseGraphPath(url.searchParams.get('path'))
            if (requested === undefined) {
              invalidGraphPath(response)
              return
            }
            // Same per-request workspace root as every sibling graph read: a
            // file-scoped view must never be projected from another root.
            const root = await graphRootResolver(service, context, url).resolve()
            const snapshot = graphSnapshotOf(service, root)
            json(response, { ok: true, value: buildIntra(graphQueryOf(snapshot, 'file'), requested) })
            return
          }

          if (path === '/graph/dependencies' && method === 'GET') {
            // `level=file` (default) keeps the file-level `depends` projection;
            // `level=intra` mirrors `/graph/intra`'s symbol edges and requires
            // an explicit path. An unknown level is a 400, never a silent
            // fallback to the default.
            const level = (url.searchParams.get('level') ?? 'file').trim().toLowerCase()
            if (level !== 'file' && level !== 'intra') {
              json(
                response,
                {
                  ok: false,
                  error: { code: 'INVALID_ARGUMENT', message: 'level must be "file" or "intra"' },
                },
                400,
              )
              return
            }
            const hasPath = url.searchParams.has('path')
            if (level === 'intra' && !hasPath) {
              json(
                response,
                {
                  ok: false,
                  error: { code: 'INVALID_ARGUMENT', message: 'path is required when level=intra' },
                },
                400,
              )
              return
            }
            const requested = hasPath ? normaliseGraphPath(url.searchParams.get('path')) : undefined
            if (hasPath && requested === undefined) {
              invalidGraphPath(response)
              return
            }
            const root = await graphRootResolver(service, context, url).resolve()
            const snapshot = graphSnapshotOf(service, root)
            if (level === 'intra') {
              // The validation above guarantees a valid explicit path.
              if (requested === undefined) {
                invalidGraphPath(response)
                return
              }
              json(response, {
                ok: true,
                value: buildDependencies(graphQueryOf(snapshot, 'file'), requested, 'intra'),
              })
              return
            }
            const scope: GraphScope = requested === undefined ? 'workspace' : 'file'
            json(response, {
              ok: true,
              value: buildDependencies(graphQueryOf(snapshot, scope), requested, 'file'),
            })
            return
          }

          if (path === '/graph/imports' && method === 'GET') {
            const hasPath = url.searchParams.has('path')
            const requested = hasPath ? normaliseGraphPath(url.searchParams.get('path')) : undefined
            if (hasPath && requested === undefined) {
              invalidGraphPath(response)
              return
            }
            const root = await graphRootResolver(service, context, url).resolve()
            const snapshot = graphSnapshotOf(service, root)
            const scope: GraphScope = requested === undefined ? 'workspace' : 'file'
            json(response, {
              ok: true,
              value: buildImports(graphQueryOf(snapshot, scope), requested),
            })
            return
          }

          if (path === '/graph/search' && method === 'GET') {
            const root = await graphRootResolver(service, context, url).resolve()
            const snapshot = graphSnapshotOf(service, root)
            const hits = searchGraph(
              snapshot.nodes,
              url.searchParams.get('q') ?? '',
              url.searchParams.get('limit'),
            )
            json(response, { ok: true, value: { hits } })
            return
          }

          /*
           * Read-only agent roster. Metadata only: labels, objectives,
           * parent/creation timestamps and a deterministic *estimated* progress
           * value. `completedAt` is only set from a durable terminal turn of a
           * non-live one-shot subagent; the DSH host exposes no completion flag
           * for ordinary live sessions, so those stay `unknown` rather than
           * fabricated. Missing services produce an empty roster.
           */
          if (path === '/graph/agents' && method === 'GET') {
            response.setHeader('cache-control', 'no-store')
            const snapshot = await collectAgentRoster(agentServicesOf(context))
            json(response, {
              ok: true,
              value: buildAgentRoster(snapshot.records, snapshot.mainSessionId),
            })
            return
          }

          /*
           * The one body-bearing agent-record route. It reads exactly one known
           * session log and returns a bounded transcript (newest 200 messages /
           * 8 KiB each / 64 KiB total, text blocks only). Missing id is 400,
           * unknown id 404; every response — including errors — is no-store.
           * Nothing is logged or cached and there is no send/cancel/resume path.
           */
          if (path === '/graph/agents/messages' && method === 'GET') {
            response.setHeader('cache-control', 'no-store')
            const requested = url.searchParams.get('id')
            const id = requested === null ? undefined : requested.trim()
            const events = id === undefined || id.length === 0
              ? undefined
              : await resolveAgentSessionEvents(agentServicesOf(context), id)
            const result = agentMessagesRoute(requested, events)
            response.setHeader('cache-control', result.headers['cache-control'])
            json(response, result.body, result.status)
            return
          }

          /*
           * The only body-bearing file-content route. It is user-initiated (the
           * preview dialog), bounded and never cached or traced. Text is limited
           * to 64 KiB; docx/xlsx/pptx are converted in memory with their own
           * caps (64 KiB document part / 256 KiB HTML, 1,000×50×20 sheet
           * cells, 200×40 slides) and never written to disk. Invalid paths are
           * 400, missing files 404, binary/NUL/undecodable content 415 — never
           * a guessed rendering.
           */
          if (path === '/graph/preview' && method === 'GET') {
            const requested = normaliseGraphPath(url.searchParams.get('path'))
            if (requested === undefined) {
              invalidGraphPath(response)
              return
            }
            // Preview is explicitly not cacheable, at any layer — including
            // an error response.
            response.setHeader('cache-control', 'no-store')
            try {
              // Same per-request root as the other graph reads (no `root`
              // override: preview is workspace-relative only).
              const root = await createToolWorkspaceRootResolver(service, {}, { context }).resolve()
              const value = await previewOf(requested, root)
              json(response, { ok: true, value })
            } catch (error) {
              if (error instanceof NotFoundError) {
                json(response, { ok: false, error: { code: 'NOT_FOUND', message: error.message } }, 404)
              } else if (error instanceof InvalidStateError) {
                json(
                  response,
                  {
                    ok: false,
                    error: {
                      code: 'UNSUPPORTED_MEDIA',
                      message: 'file content is binary, not decodable text, or not a readable Office package',
                    },
                  },
                  415,
                )
              } else if (error instanceof InvalidArgumentError) {
                json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: error.message } }, 400)
              } else {
                throw error
              }
            }
            return
          }

          /*
           * The explicit indexing entry point. A fresh profile's graph is empty
           * because the file tools only index what they parse; this scan walks
           * the workspace instead. Bounded to depth 8 / 200 files / 10 s with
           * dependency, VCS and temp directories skipped and only parser-backed
           * text extensions attempted. Serialized in-process (409 BUSY). It is
           * read-only: no build, command or execution runs and no workspace file
           * is written — only the coordination database's own graph rows change.
           */
          if (path === '/graph/index' && method === 'POST') {
            const root = await graphRootResolver(service, context, url).resolve()
            const outcome = await indexGate.run(() => indexWorkspace(service, root))
            if (!outcome.ok) {
              json(
                response,
                { ok: false, error: { code: 'BUSY', message: 'a workspace index is already running' } },
                409,
              )
              return
            }
            json(response, { ok: true, value: outcome.value })
            return
          }

          /*
           * The graph rebuild action: re-parse and re-index the files already in
           * the graph. It reads files only (no build, command or execution),
           * is serialized in-process and bounded to 2000 files / 10 s. The
           * response carries counts and timing only — never file content.
           */
          if (path === '/graph/rebuild' && method === 'POST') {
            if (rebuildInFlight) {
              json(
                response,
                { ok: false, error: { code: 'BUSY', message: 'a graph rebuild is already running' } },
                409,
              )
              return
            }
            rebuildInFlight = true
            try {
              json(response, { ok: true, value: await rebuildGraph(service) })
            } finally {
              rebuildInFlight = false
            }
            return
          }

          if (path === '/state' && method === 'GET') {
            const session = sessionOf(url)
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            json(response, {
              ok: true,
              value: {
                selection: service.state(session),
                metrics: service.metrics(),
              },
            })
            return
          }

          json(response, { ok: false, error: { code: 'NOT_FOUND', message: `${method} ${path} is not a coordination route` } }, 404)
        } catch (error) {
          json(response, { ok: false, error: toErrorJson(error) }, statusOf(error))
        }
      },
    })
    return () => { dispose() }
  }, `${name}: ${ROUTE_PREFIX} routes`)
}


