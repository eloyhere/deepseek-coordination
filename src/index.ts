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
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, resolveConfig, type CoordinationConfig } from './host/config.js'
import { CoordinationService } from './host/coordination.js'
import { resolveDatabasePath } from './host/database.js'
import { createRuntime, installTurnLifecycle } from './host/dsh.js'
import { applyConfigPatch } from './host/selection.js'
import { withAmpReceipts } from './host/amp.js'
import { withToolTiming } from './host/toolTiming.js'
import { ToolCatalog, withToolCatalog } from './host/toolCatalog.js'
import { schemaDetailFromEnv, withLeanSchemas } from './host/leanSchemas.js'
import { profileFromEnv, withToolProfile } from './host/toolProfiles.js'
import { handleAmpRoute, type AmpInsightsHost } from './host/ampRoutes.js'
import { adaptAmpScopeHost } from './host/ampScope.js'
import { readOverrides, settingsPath, writeOverrides } from './host/settingsStore.js'
import { createProxyService } from './host/proxyService.js'
import { registerAmpPlanningSkills, type AmpDynamicSkill, type AmpSkillRegistry } from './host/ampSkills.js'
import type { NativeSubagentsPort } from './host/ampSubagents.js'
import { registerAmpPrompt, registerAmpCommands, type AmpPromptRegistry, type AmpCommandRegistry, type AmpExtensionService } from './host/ampExtensions.js'
import { brandProfileOf, shouldDecorate } from './host/modelBrand.js'
import type { GenerateOptionsLike } from './shared/service.js'
import {
  createToolWorkspaceRootResolver,
  coordinationIndexToolDefinition,
  disposeCoordinationToolRuntime,
  parseOptionsOf,
  registerCoordinationGraphTools,
  registerCoordinationTools,
  resolveToolWorkspaceRoot,
  toolRegistryOf,
  type ToolWorkspaceRootResolver,
} from './host/tools.js'
import { coordinationWorkspaceTool } from './host/workspaceTools.js'
import { GraphStore } from './host/graphStore.js'
import { coordinationControlTools, type ControlToolService } from './host/controlTools.js'
import { NotificationCenter } from './host/notify.js'
import { coordinationNotificationToolDefinition } from './host/notifyTools.js'
import { ApprovalCenter } from './host/approve.js'
import { coordinationApproveToolDefinition } from './host/approveTools.js'
import { coordinationSearchToolDefinition } from './host/searchTools.js'
import { handleControlRoute } from './host/controlRoutes.js'
import { assertGraphIndexEnabled, graphIndexOperations, graphRevision } from './host/graphIndex.js'
import { ParseService } from './host/parseService.js'
import { inflateTexSync, texSyncCandidate, texSyncPage } from './host/texSync.js'
import {
  MAX_PREVIEW_ARCHIVE_BYTES,
  MAX_PREVIEW_PDF_BYTES,
  MAX_PREVIEW_TEXT_BYTES,
  agentMessagesRoute,
  buildAgentRoster,
  buildDependencies,
  buildDocxPreview,
  buildImports,
  buildIntra,
  buildOutline,
  buildOutlineIndex,
  buildPptxPreview,
  buildTextPreview,
  buildTree,
  buildXlsxPreview,
  collectAgentRoster,
  createGraphQuery,
  graphVersionOf,
  isOfficePreviewKind,
  normaliseGraphPath,
  previewKindOf,
  previewPdfRange,
  resolveAgentSessionEvents,
  searchGraph,
  texPdfCandidate,
  type AgentServiceBundle,
  type GraphEdge,
  type GraphNode,
  type GraphQuery,
  type GraphScope,
  type PreviewValue,
} from './host/graphView.js'
import type { TakeoverGateAnswer } from './host/takeoverGate.js'
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

/**
 * Whether `coordination_search` belongs in the catalog.
 *
 * Registered only when the operator configured a backend: `COORDINATION_ES_URL`
 * (the endpoint) or `COORDINATION_ES_SEARCH=1` (explicit opt-in for the default
 * localhost endpoint). An unconditionally registered tool whose cluster is down
 * costs catalog tokens every turn and fails every call.
 */
function searchConfigured(): boolean {
  return (process.env.COORDINATION_ES_URL ?? '').trim().length > 0
    || process.env.COORDINATION_ES_SEARCH === '1'
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
/**
 * The AMP prompt service plus a bounded workspace digest.
 *
 * The injected context answers two cheap questions the model would otherwise
 * spend tool calls on: which files are knowledge, and which interaction and
 * scenario the scope chain resolves to. Everything stays metadata: knowledge
 * contributes paths and titles, never a body. A missing sandbox policy simply
 * narrows the digest to the session scope instead of failing the prompt.
 */
function ampPromptServiceOf(service: CoordinationService): AmpExtensionService {
  return {
    collaboration: service.collaboration,
    planning: service.planning,
    contextDigest(session: string) {
      try {
        const workspace = service.host.sandboxPolicy?.resolve({ session })?.workspaceRoot ?? ''
        const identity = { ...(workspace.length === 0 ? {} : { workspace }), session }
        const scope = workspace.length === 0 ? 'session' as const : 'workspace' as const
        const interaction = service.control.getSetting('interaction', scope, identity)
        const scenario = service.control.getSetting('scenario', scope, identity)
        return {
          knowledge: service.knowledge.brief(identity, 8),
          ...(interaction.value === null ? {} : { interaction: interaction.value }),
          ...(scenario.value === null ? {} : { scenario: scenario.value }),
        }
      } catch {
        return undefined
      }
    },
  }
}

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
  const baseVersion = graphVersionOf(nodes, edges)
  const revisions = store.loadSnapshotRevisions()
  let revisionHash = 2166136261
  for (const item of revisions) {
    const text = `${item.path}\u0000${item.hash}\u0000${item.changed};`
    for (let index = 0; index < text.length; index += 1) revisionHash = Math.imul(revisionHash ^ text.charCodeAt(index), 16777619) >>> 0
  }
  return { root, version: `${baseVersion}.${revisions.length}.${revisionHash.toString(36)}`, nodes, edges }
}

/** Resolve the workspace identity the AMP insights merge needs, or `''`. */
async function ampWorkspaceOf(
  service: CoordinationService,
  context: unknown,
  url: URL,
): Promise<string> {
  try {
    return await graphRootResolver(service, context as never, url).resolve()
  } catch {
    return ''
  }
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
 * sessions) never share a root. An explicit `session` is resolved against that
 * exact Session header before any directory fallback. An invalid explicit `root` throws
 * `InvalidArgumentError`, which the route handler maps to 400.
 */
function graphRootResolver(
  service: CoordinationService,
  context: Context,
  url: URL,
  includeSelectedSession = true,
): ToolWorkspaceRootResolver {
  return createToolWorkspaceRootResolver(service, {}, {
    root: url.searchParams.get('root'),
    session: includeSelectedSession ? sessionOf(url) || undefined : undefined,
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
 * payload builders in `host/graphView.ts`: no temporary file, no external
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
  session = '',
  sourceLine?: number,
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
  const result = previewTextContent(parser, relative)
  if (kind === 'tex') {
    const candidate = texPdfCandidate(relative)
    const metadata = candidate === undefined ? undefined : pdfPreviewMetadata(parser, candidate)
    if (metadata !== undefined) {
      return {
        path: relative,
        kind: 'pdf',
        url: `${ROUTE_PREFIX}/graph/preview/pdf?path=${encodeURIComponent(relative)}${session.length === 0 ? '' : `&session=${encodeURIComponent(session)}`}`,
        page: sourceLine === undefined ? 1 : texPreviewPage(parser, relative, sourceLine) ?? 1,
        truncated: false,
        bytes: metadata.bytes,
      }
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

/** Read the source with the existing text, UTF-8 and BOM checks. */
function previewTextContent(parser: ParseService, relative: string): ReturnType<ParseService['readContent']> {
  try {
    return parser.readContent({ path: relative, mode: 'bytes', start: 0, maxBytes: PREVIEW_MAX_BYTES })
  } catch (error) {
    if (error instanceof InvalidArgumentError && error.message.includes('BOM')) {
      return parser.readContent({ path: relative, mode: 'bytes', start: 3, maxBytes: PREVIEW_MAX_BYTES })
    }
    throw error
  }
}

/** Existing SyncTeX is optional; malformed/missing mappings leave the PDF at page 1. */
function texPreviewPage(parser: ParseService, source: string, line: number): number | undefined {
  const candidate = texSyncCandidate(source)
  if (candidate === undefined) return undefined
  let fd: number | undefined
  try {
    const real = realpathSync(parser.absolutePath(candidate))
    const root = realpathSync(parser.workspaceRoot)
    if (!real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return undefined
    fd = openSync(real, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return undefined
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) return undefined
      offset += count
    }
    const text = inflateTexSync(bytes)
    return text === undefined ? undefined : texSyncPage(text, source, line)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Inspect only an adjacent compiled PDF, under the same realpath containment as a text read. */
function pdfPreviewMetadata(parser: ParseService, relative: string): { bytes: number; real: string; dev: number; ino: number } | undefined {
  const absolute = parser.absolutePath(relative)
  if (!existsSync(absolute)) return undefined
  let real: string
  let root: string
  try {
    real = realpathSync(absolute)
    root = realpathSync(parser.workspaceRoot)
  } catch {
    return undefined
  }
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (real !== root && !real.startsWith(prefix)) return undefined
  let fd: number
  try {
    fd = openSync(real, 'r')
  } catch {
    return undefined
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 8 || stat.size > MAX_PREVIEW_PDF_BYTES) return undefined
    const header = Buffer.alloc(8)
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return undefined
    if (!header.toString('ascii').startsWith('%PDF-')) return undefined
    return { bytes: stat.size, real, dev: stat.dev, ino: stat.ino }
  } finally {
    closeSync(fd)
  }
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
 * `NOT_FOUND`. Only read methods are called by `host/graphView.ts`; this
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

/**
 * Enabled control-registry skills projected for DSH's runtime provider.
 *
 * The write path is `POST /control/registry` with registry `skills`: a record
 * carrying `content` becomes a real provider candidate, so DSH's
 * `sessionSkillCatalog` and the model-facing `skill` tool discover it. Session,
 * current-workspace and global scopes are projected in that precedence order;
 * a session-scoped row therefore wins when DSH passes the live agent.
 */
function controlRegistrySkills(
  control: CoordinationService['control'],
  cwd: string | undefined,
  sessionId: string | undefined,
): AmpDynamicSkill[] {
  const records: ReturnType<CoordinationService['control']['listRegistry']> = []
  // Session overrides workspace, which overrides global, matching the control
  // registry's `global → workspace → session` inheritance.
  if (sessionId !== undefined && sessionId.length > 0) {
    try {
      records.push(...control.localRegistry('skills', 'session', { session: sessionId }))
    } catch { /* this lookup has no usable session identity */ }
  }
  if (cwd !== undefined && cwd.length > 0) {
    try {
      records.push(...control.localRegistry('skills', 'workspace', { workspace: cwd }))
    } catch { /* this lookup has no usable workspace identity */ }
  }
  try {
    records.push(...control.listRegistry('skills', 'global', {}))
  } catch { /* a profile without a global identity has no global skills */ }
  const skills: AmpDynamicSkill[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id)) continue
    // Mark the id before the enabled/content checks so a disabled or
    // content-less override still hides the inherited row.
    seen.add(record.id)
    if (!record.enabled || record.deleted === true) continue
    const value = record.value
    const content = typeof value.content === 'string' ? value.content : ''
    if (content.length === 0) continue
    const description = typeof value.description === 'string' && value.description.length > 0
      ? value.description
      : typeof value.summary === 'string' && value.summary.length > 0
        ? value.summary
        : record.id
    skills.push({
      name: record.id,
      description,
      content,
      ...(typeof value.whenToUse === 'string' ? { whenToUse: value.whenToUse } : {}),
      ...(typeof value.path === 'string' ? { path: value.path } : {}),
      ...(typeof value.modelInvocable === 'boolean' ? { modelInvocable: value.modelInvocable } : {}),
      ...(typeof value.userInvocable === 'boolean' ? { userInvocable: value.userInvocable } : {}),
    })
  }
  return skills
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
  /*
   * Model-facing notifications: one bounded, in-memory queue per session. The
   * tool only enqueues; the client half polls `/notify/pending`, so showing a
   * surface can never block the agent loop and nothing is persisted.
   */
  const notifications = new NotificationCenter()
  /*
   * Model-facing approvals: one bounded, in-memory consent window per waiting
   * call. Unlike a notification this one blocks the tool call, and only a real
   * answer resolves it — expiry, cancellation and unload all resolve as
   * non-approval. `cancelAll` on unload keeps no dialog alive for a dead tool.
   */
  const approvals = new ApprovalCenter()
  const nativeSubagents = serviceOrUndefined(context, 'subagents')
  if (typeof nativeSubagents?.listChildren === 'function') {
    service.nativeSubagents = nativeSubagents as unknown as NativeSubagentsPort
  }
  service.turn.recoverInterrupted()

  /*
   * Cache proxy (experiment, off by default): `proxy.enable` or
   * `DSH_COORDINATION_PROXY=1` decides whether the proxy is attached at all.
   * The installation itself lives in `host/proxyService.ts`; rewriting is a
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
  /** Re-register the four human commands after `POST /locale` changed the copy language. */
  let refreshCommands: ((locale: Locale) => void) | undefined
  /** Live catalog behind `GET /context/metrics`; replaced on every (re)install. */
  let liveToolCatalog: ToolCatalog | undefined

  context.effect(() => () => { service.dispose() }, `${name}: database`)

  // No consent dialog outlives the plugin: unloading settles every waiting
  // window as `cancelled`, so a blocked tool call returns instead of hanging.
  context.effect(() => () => { approvals.cancelAll() }, `${name}: approvals`)

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
   * Host-side file-access takeover (`ui.takeoverFiles`): the `tools/pre-execute`
   * gate that records reads and refuses writes outside the workspace. With the
   * switch off nothing is registered at all; a live `/config` save re-installs
   * it through `sync()`, so the settings-page toggle applies without a restart.
   */
  context.effect(() => service.fileGate.install(context), `${name}: file gate`)

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
      // exactly the same name, description and schemas. Timing is applied once,
      // outermost, so every result carries `tookMs` without per-tool code, and
      // the catalog records the exact definitions for `/context/metrics`.
      const catalog = new ToolCatalog()
      liveToolCatalog = catalog
      // Order matters: lean runs first so the catalog records the declarations
      // the model actually receives, not the documented ones; the profile then
      // drops administration tools when `core` is selected.
      const receipted = withToolProfile(
        withLeanSchemas(
          withToolCatalog(withToolTiming(withAmpReceipts(registry, service.amp)), catalog),
          schemaDetailFromEnv(),
        ),
        profileFromEnv(),
      )
      // Two sets with independent lifetimes: the documented seven-tool file
      // surface and the four read-only graph tools. The graph set gets the
      // apply-time context so its per-call workspace-root resolution follows
      // the same session workspace the `/graph/*` routes use.
      const disposeFileTools = registerCoordinationTools(receipted, service, locale, { context })
      let disposeGraphTools: (() => void) | undefined
let disposeWorkspaceTool: (() => void) | undefined
      let disposeIndexTool: (() => void) | undefined
      let disposeControlTools: (() => void) | undefined
      let disposeNotificationTool: (() => void) | undefined
      let disposeApprovalTool: (() => void) | undefined
      let disposeSearchTool: (() => void) | undefined
      try {
        disposeGraphTools = registerCoordinationGraphTools(receipted, service, locale, { context })
        disposeIndexTool = receipted.register(coordinationIndexToolDefinition(service, locale, { context }))
        disposeWorkspaceTool = receipted.register(coordinationWorkspaceTool(service, locale))
        // AMP 0.5.0 scoped control + explicit knowledge marks: one tool each, on
        // the same registry so a tool call settles as a receipt too.
        const controlDisposers = coordinationControlTools(service as unknown as ControlToolService)
          .map((definition) => receipted.register(definition))
        disposeControlTools = () => {
          for (const disposeTool of controlDisposers.reverse()) disposeTool()
        }
        // Model-facing notifications: one extra tool on the same registry, so a
        // notification call settles as an AMP receipt like every other call.
        disposeNotificationTool = receipted.register(
          coordinationNotificationToolDefinition(notifications, locale),
        )
        // Consent dialog: the blocking counterpart of the notification tool.
        disposeApprovalTool = receipted.register(
          coordinationApproveToolDefinition(approvals, locale),
        )
        // Internal Elasticsearch: endpoint and index come from the environment,
        // the model only chooses the query. Register only when the operator
        // configured a backend: an always-registered tool whose cluster is down
        // is a slot the model pays for every turn and a guaranteed failed call.
        if (searchConfigured()) {
          disposeSearchTool = receipted.register(
            coordinationSearchToolDefinition(locale),
          )
        }
      } catch (error) {
        // Never leave the first set registered when a later one fails.
        disposeGraphTools?.()
        disposeFileTools()
        throw error
      }
      dispose = () => {
        disposeSearchTool?.()
        disposeWorkspaceTool?.()
        disposeApprovalTool?.()
        disposeNotificationTool?.()
        disposeControlTools?.()
        disposeIndexTool?.()
        disposeGraphTools?.()
        disposeFileTools()
      }
    }
    install(normaliseLocale(service.locale))
    refreshTools = install
    return () => {
      refreshTools = undefined
      liveToolCatalog = undefined
      dispose?.()
      dispose = undefined
    }
  }, `${name}: tools`)

  /*
   * AMP planning skills are an optional DSH capability. `inject` keeps this
   * fiber dormant until the skill registry is mounted and reruns it if the
   * host replaces that service; the exact registry disposers follow the
   * plugin fiber lifetime. The markdown lives beside the packaged host bundle.
   *
   * The provider also projects enabled control-registry `skills` records that
   * carry `content`, which is what makes that registry a true write-through
   * surface for DSH's session skill catalog. A control write invalidates the
   * provider so the next catalog lookup sees it.
   */
  let invalidateSkills: (() => void) | undefined
  context.inject(['skills'], (skillContext) => {
    const registry = serviceOrUndefined(skillContext, 'skills') as AmpSkillRegistry | undefined
    const skillRoot = fileURLToPath(new URL('../skills/', import.meta.url))
    return skillContext.effect(
      () => {
        const dispose = registerAmpPlanningSkills(
          registry,
          skillRoot,
          (options) => {
            const scope = options.scope
            const sessionId = typeof scope === 'object' && scope !== null && !Array.isArray(scope)
              && typeof scope.id === 'string'
              ? scope.id
              : undefined
            return controlRegistrySkills(service.control, options.cwd, sessionId)
          },
          (control) => { invalidateSkills = control.invalidate },
          // Read per lookup: a host language change only needs an invalidate to
          // publish the other descriptions, not a provider re-registration.
          () => normaliseLocale(service.locale),
        )
        return () => {
          invalidateSkills = undefined
          dispose()
        }
      },
      `${name}: AMP planning skills`,
    )
  })

  context.inject(['subagents'], (subagentContext) => {
    const roster = serviceOrUndefined(subagentContext, 'subagents')
    const port = roster !== undefined && typeof roster.listChildren === 'function'
      ? roster as unknown as NativeSubagentsPort
      : undefined
    service.nativeSubagents = port
    let disposeContinuable: (() => void) | undefined
    if (roster !== undefined && typeof roster.registerContinuableSetup === 'function') {
      disposeContinuable = (roster.registerContinuableSetup as (setup: (childContext: Context) => () => void) => () => void)
        .call(roster, (childContext) => {
          const promptRegistry = serviceOrUndefined(childContext, 'systemPrompt') as AmpPromptRegistry | undefined
          // Optional support for runtimes with continuable child setup. The global
          // context already resolves the child agent.id on installed runtimes.
          return registerAmpPrompt(promptRegistry, ampPromptServiceOf(service))
        })
    }
    return () => {
      disposeContinuable?.()
      if (service.nativeSubagents === port) service.nativeSubagents = undefined
    }
  })

  context.inject(['systemPrompt'], (promptContext) => {
    const registry = serviceOrUndefined(promptContext, 'systemPrompt') as AmpPromptRegistry | undefined
    return promptContext.effect(
      () => registerAmpPrompt(registry, ampPromptServiceOf(service)),
      `${name}: AMP context`,
    )
  })

  context.inject(['commands'], (commandContext) => {
    const registry = serviceOrUndefined(commandContext, 'commands') as AmpCommandRegistry | undefined
    return commandContext.effect(() => {
      let disposeCommands: (() => void) | undefined
      // Command descriptions and refusal text are baked at registration time, so
      // a language change re-registers the four read-only commands.
      const install = (locale: Locale): void => {
        disposeCommands?.()
        disposeCommands = registerAmpCommands(registry, service, locale)
      }
      refreshCommands = install
      install(normaliseLocale(service.locale))
      return () => {
        refreshCommands = undefined
        disposeCommands?.()
        disposeCommands = undefined
      }
    }, `${name}: AMP commands`)
  })

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
           * The route table lives in `host/ampRoutes.ts` so it is testable
           * without a Cordis context or a webserver. The body is still the
           * plugin's `{ ok, value }` envelope, but `value` is the AMP object as
           * the protocol defines it — the same bytes whose canonical form is
           * signed or digested, never a reshaped copy.
           *
           *   GET  /amp/identity            -> { kid, alg, publicKey }
           *   GET  /amp/manifest            -> signed Manifest (reissued on expiry)
           *   GET  /amp/frame?session=<id>  -> latest Frame for one session
           *   GET  /amp/planning?session=<id> -> missions, goal lifecycles and plans
           *   GET  /amp/missions|goals|plans?session=<id> -> individual planning views
           *   GET  /amp/receipts[?limit=n]  -> newest-first Receipts
           *   GET  /amp/ledger[?limit=n][&full=1] -> chain head + entries
           *   GET  /amp/verify              -> recomputed chain verdict
           *   POST /amp/checkpoint          -> signed LedgerCheckpoint
           *
           * No response carries the private key or any content body.
           */
          const ampRoute = await handleAmpRoute(
            {
              path, method, url, session: sessionOf(url),
              // Only the insights route merges the agent-managed modules, and
              // those are scoped, so it alone needs the resolved workspace.
              ...(path === '/amp/insights'
                ? { workspace: await ampWorkspaceOf(service, context, url) }
                : {}),
            },
            service,
            path === '/amp/scope' || path === '/amp/insights' ? {
              ...adaptAmpScopeHost({
                workspaceRegistry: serviceOrUndefined(context, 'workspaceRegistry'),
                storageDomain: serviceOrUndefined(context, 'storageDomain'),
                sessionQuery: serviceOrUndefined(context, 'sessionQuery'),
              }),
              sessionSkillCatalog: serviceOrUndefined(context, 'sessionSkillCatalog'),
              control: service.control,
            } as AmpInsightsHost : undefined,
          )
          if (ampRoute !== undefined) {
            json(response, ampRoute.body, ampRoute.status)
            return
          }

          /*
           * AMP 0.5.0 scoped control + explicit knowledge marks.
           *
           * The route table lives in `host/controlRoutes.ts`, for the same
           * reason as the AMP table: it is testable without a Cordis context or
           * a webserver. The caller resolves the workspace root and the session
           * once per request and never guesses either.
           *
           *   GET  /control/registry?scope=&registry=   effective registry view
           *   POST /control/registry                    one registry action
           *   GET  /control/settings?scope=&domain=     effective setting
           *   POST /control/settings                    get/set/reset a setting
           *   GET  /graph/knowledge                     knowledge files
           *   POST /graph/knowledge                     mark/update/unmark a file
           */
          if (path === '/control/registry' || path === '/control/settings'
            || path === '/graph/knowledge') {
            const session = sessionOf(url)
            let workspace = ''
            try {
              // Same per-request resolver as `/graph/*`: an explicit `?root=`
              // wins, then the session's sandbox/working directory.
              workspace = await graphRootResolver(service, context, url).resolve()
            } catch {
              // A missing workspace identity leaves global scope usable and
              // makes a workspace/session call report its own typed error.
              workspace = ''
            }
            const body = method === 'POST' ? await readJsonBody(request) : undefined
            let knownPaths: ReadonlySet<string> | undefined
            const controlRoute = handleControlRoute(
              {
                path,
                method,
                url,
                session,
                workspace,
                ...(body === null || body === undefined ? {} : { body }),
                isIndexed: (candidate: string): boolean => {
                  if (knownPaths === undefined) {
                    try {
                      const snapshot = graphSnapshotOf(service, workspace)
                      knownPaths = new Set(snapshot.nodes.flatMap((node) =>
                        node.path === undefined ? [] : [normaliseGraphPath(node.path) ?? node.path]))
                    } catch {
                      knownPaths = new Set<string>()
                    }
                  }
                  return knownPaths.has(candidate)
                },
              },
              service,
            )
            if (controlRoute !== undefined) {
              // A registry write can add, retitle, disable or remove a
              // `skills` record; refresh the runtime provider's catalog view.
              if (method === 'POST' && path === '/control/registry' && controlRoute.status === 200) {
                invalidateSkills?.()
              }
              json(response, controlRoute.body, controlRoute.status)
              return
            }
          }

          /*
           * Model-facing notifications (the `coordination_notification` tool).
           *
           *   GET  /notify/pending?session=<id>  -> { items: NotificationItem[] }
           *   POST /notify { session, surface, message, ... } -> NotificationItem
           *
           * Both are session-addressed and in-memory. GET drains: exactly one
           * polling client receives an item, and a later poll sees only newer
           * ones. POST exists so an external caller (curl, a test, another
           * local process) can pop a notification without the tool registry.
           */
          if (path === '/notify/pending' && method === 'GET') {
            const session = sessionOf(url)
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            json(response, { ok: true, value: { items: notifications.drain(session) } })
            return
          }

          if (path === '/notify' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            if (body === undefined) {
              json(
                response,
                { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'body must be a JSON object' } },
                400,
              )
              return
            }
            const session = sessionOf(url, body)
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            const outcome = notifications.push(session, body)
            json(response, { ok: true, value: outcome.item })
            return
          }

          /*
           * Model-facing approvals (the `coordination_approve` tool).
           *
           *   GET  /approve/pending?session=<id>             -> { items: ApprovalView[] }
           *   POST /approve/answer { session, id, approved } -> { answered: true }
           *   POST /approve/cancel { session, id }           -> { cancelled: true }
           *
           * Unlike `/notify/pending`, the list does NOT drain: the modal keeps
           * showing the same request until the human answers it or it expires.
           * Only `approved: true` produces an approval; the session on the
           * answer must be the session that opened the window.
           */
          if (path === '/approve/pending' && method === 'GET') {
            const session = sessionOf(url)
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            json(response, { ok: true, value: { items: approvals.list(session) } })
            return
          }

          if (path === '/approve/answer' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            const id = typeof body?.id === 'string' ? body.id.trim() : ''
            const approved = body?.approved
            if (session.length === 0 || id.length === 0 || typeof approved !== 'boolean') {
              json(
                response,
                {
                  ok: false,
                  error: { code: 'INVALID_ARGUMENT', message: 'session, id and a boolean approved are required' },
                },
                400,
              )
              return
            }
            if (!approvals.answer(session, id, approved)) {
              json(
                response,
                { ok: false, error: { code: 'NOT_FOUND', message: `approval ${id} is not pending` } },
                404,
              )
              return
            }
            json(response, { ok: true, value: { answered: true } })
            return
          }

          if (path === '/approve/cancel' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            const id = typeof body?.id === 'string' ? body.id.trim() : ''
            if (session.length === 0 || id.length === 0) {
              json(
                response,
                { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session and id are required' } },
                400,
              )
              return
            }
            if (!approvals.cancel(session, id)) {
              json(
                response,
                { ok: false, error: { code: 'NOT_FOUND', message: `approval ${id} is not pending` } },
                404,
              )
              return
            }
            json(response, { ok: true, value: { cancelled: true } })
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
            // The four read-only commands carry their own copy as well.
            refreshCommands?.(normaliseLocale(current))
            // Skill descriptions are read per lookup; drop the cached catalog so
            // DSH lists the other language instead of the one it cached.
            invalidateSkills?.()
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
            // The file gate is registered only while its switch is on: follow the
            // live value so turning `ui.takeoverFiles` on or off applies at once.
            service.fileGate.sync()
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
           * helpers in `host/graphView.ts`. No parse is triggered, no file is
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
           *   GET /graph/preview?path=<rel>       -> bounded text or PDF descriptor
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
            //
            // `paths=1` returns the lazy index instead: one row per file with
            // its family and node count, but no nodes. The panel renders file
            // rows from that payload and loads one file's nodes only when the
            // row is expanded, so a 200-file workspace no longer transfers up to
            // 100,000 nodes on first paint.
            const hasPath = url.searchParams.has('path')
            const requested = hasPath ? normaliseGraphPath(url.searchParams.get('path')) : undefined
            if (hasPath && requested === undefined) {
              invalidGraphPath(response)
              return
            }
            const root = await graphRootResolver(service, context, url).resolve()
            const snapshot = graphSnapshotOf(service, root)
            const scope: GraphScope = requested === undefined ? 'workspace' : 'file'
            const query = graphQueryOf(snapshot, scope)
            const pathsOnly = requested === undefined && url.searchParams.get('paths') === '1'
            json(response, {
              ok: true,
              value: pathsOnly ? buildOutlineIndex(query) : buildOutline(query, requested),
            })
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
          if (path === '/graph/preview/pdf' && method === 'GET') {
            response.setHeader('cache-control', 'no-store')
            const source = normaliseGraphPath(url.searchParams.get('path'))
            const candidate = source === undefined ? undefined : texPdfCandidate(source)
            if (candidate === undefined) {
              invalidGraphPath(response)
              return
            }
            const root = await createToolWorkspaceRootResolver(service, {}, { context, session: sessionOf(url) || undefined }).resolve()
            const parser = new ParseService({ workspaceRoot: root })
            // A PDF alone must not make a missing/escaped source previewable.
            previewTextContent(parser, source as string)
            const metadata = pdfPreviewMetadata(parser, candidate)
            if (metadata === undefined) {
              json(response, { ok: false, error: { code: 'NOT_FOUND', message: 'compiled PDF artifact not found' } }, 404)
              return
            }
            const fd = openSync(metadata.real, 'r')
            try {
              const stat = fstatSync(fd)
              if (!stat.isFile() || stat.size !== metadata.bytes || stat.size > MAX_PREVIEW_PDF_BYTES || stat.dev !== metadata.dev || stat.ino !== metadata.ino) {
                json(response, { ok: false, error: { code: 'UNSUPPORTED_MEDIA', message: 'compiled PDF changed or exceeds the preview limit' } }, 415)
                return
              }
              const signature = Buffer.alloc(8)
              if (readSync(fd, signature, 0, signature.length, 0) !== signature.length || !signature.toString('ascii').startsWith('%PDF-')) {
                json(response, { ok: false, error: { code: 'UNSUPPORTED_MEDIA', message: 'compiled artifact is not a PDF' } }, 415)
                return
              }
              const range = previewPdfRange(request.headers.range, stat.size)
              if (range === null) {
                response.writeHead(416, {
                  'cache-control': 'no-store',
                  'content-type': 'application/json; charset=utf-8',
                  'content-range': `bytes */${stat.size}`,
                })
                response.end()
                return
              }
              const length = range.end - range.start + 1
              const bytes = Buffer.allocUnsafe(length)
              let read = 0
              while (read < length) {
                const count = readSync(fd, bytes, read, length - read, range.start + read)
                if (count <= 0) break
                read += count
              }
              if (read !== length) {
                json(response, { ok: false, error: { code: 'UNSUPPORTED_MEDIA', message: 'compiled PDF changed during preview' } }, 415)
                return
              }
              response.setHeader('content-type', 'application/pdf')
              response.setHeader('content-disposition', 'inline')
              response.setHeader('x-content-type-options', 'nosniff')
              response.setHeader('content-security-policy', 'sandbox')
              response.setHeader('accept-ranges', 'bytes')
              response.setHeader('content-length', String(length))
              if (request.headers.range !== undefined) {
                response.writeHead(206, { 'content-range': `bytes ${range.start}-${range.end}/${stat.size}` })
              } else {
                response.writeHead(200)
              }
              response.end(bytes)
            } finally {
              closeSync(fd)
            }
            return
          }

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
              const root = await createToolWorkspaceRootResolver(service, {}, { context, session: sessionOf(url) || undefined }).resolve()
              const rawLine = url.searchParams.get('line')
              if (rawLine !== null && !/^[1-9]\d{0,6}$/.test(rawLine)) throw new InvalidArgumentError('line must be a positive source line')
              const value = await previewOf(requested, root, sessionOf(url), rawLine === null ? undefined : Number(rawLine))
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

          if (path === '/graph/revision' && method === 'GET') {
            response.setHeader('cache-control', 'no-store')
            const root = await graphRootResolver(service, context, url).resolve()
            json(response, { ok: true, value: graphRevision(service.db, root) })
            return
          }

          if ((path === '/graph/index' || path === '/graph/rebuild') && method === 'POST') {
            assertGraphIndexEnabled(service.config)
            const root = await graphRootResolver(service, context, url).resolve()
            const action = path === '/graph/rebuild' ? 'rebuild' : 'index'
            const outcome = await graphIndexOperations(service.db).update(root, { action }, parseOptionsOf(service))
            if (!outcome.ok) {
              json(response, outcome, 409)
              return
            }
            disposeCoordinationToolRuntime(service)
            const value = outcome.value
            // Preserve the rebuild route's original count field for existing clients.
            json(response, { ok: true, value: action === 'rebuild' ? { ...value, files: value.indexed } : value })
            return
          }

          if (path === '/context/metrics' && method === 'GET') {
            const cache = proxy.status()
            json(response, {
              ok: true,
              value: {
                profile: profileFromEnv(),
                catalog: liveToolCatalog?.metrics(normaliseLocale(service.locale)) ?? null,
                cache: {
                  hitRate: cache.metrics.hitRate,
                  inputTokens: cache.metrics.inputTokens,
                  cachedInputTokens: cache.metrics.cachedInputTokens,
                  samples: cache.metrics.samples,
                  requests: cache.metrics.requests,
                  window: cache.metrics.window,
                  prefix: cache.prefix,
                },
                note: 'Measures this plugin\'s tool catalog, skill catalog, AMP context cap and proxy cache-hit ratio; the DSH host prompt and its own tool block are outside this plugin and are not measured.',
              },
            })
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


