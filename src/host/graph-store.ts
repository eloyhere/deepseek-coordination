/**
 * Persistent v24 node/edge/snapshot graph (domain model §2.8, schema 24).
 *
 * The parse service, the node registry and the chain engine are **derived,
 * in-memory projections**. This store is the only place that writes them to the
 * coordination database, and the only place that reads them back:
 *
 *  - `NodeRegistry` writes one `node` row per card (`saveNode`);
 *  - `ChainEngine` writes one `node` row per indexed vertex (including lexical
 *    stubs) and one `edge` row per relation (`saveNode`/`saveEdge`);
 *  - the file-tool runtime writes one `snapshot` row per parsed file
 *    (`saveSnapshot`).
 *
 * Handles stay deterministic: the `node.handle` column is the public handle
 * (`node-registry.ts`) and the `edge.handle` is a hash of
 * `(project, relation, source handle, target handle)`. A new runtime rehydrates
 * both (`loadNodes`/`loadEdges`), so `coordination_describe` and
 * `coordination_chain` answer the same handle after a restart.
 *
 * # No body, ever
 *
 * No column here holds `content`, `body`, source text, an AST or attachment
 * bytes; `reference` is the body-free JSON locator. The `snapshot` row records
 * size/mtime/parser/hash/status and counts only.
 *
 * # Bounds
 *
 * Rehydration is bounded (`DEFAULT_HYDRATE_NODES` / `DEFAULT_HYDRATE_EDGES`,
 * newest first) because a database may outlive a process by a long time. A
 * handle older than the bound is `NotFoundError` again — explicit, never a
 * wrong answer. The v24 graph itself is not pruned yet (documented gap).
 *
 * Complexity: one `node`/`edge` upsert per node/edge (O(log n) with the unique
 * indexes), one bounded read per runtime. All writes for one parse run inside
 * the caller's `transaction`.
 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { CoordinationDatabase } from './database.js'
import { parseJson } from './database.js'
import type { NodePersistenceRecord } from './node-registry.js'
import { fileHandleFor } from './node-registry.js'
import type { ChainEdgeSnapshot, ChainNodeSnapshot } from './chain.js'
import type { NodeStatus, ParsedFile } from './parse-service.js'
import type { ConceptMetadata } from '../shared/entity.js'

/** Rehydrate at most this many newest nodes (matches the registry default). */
export const DEFAULT_HYDRATE_NODES = 50_000
/** Rehydrate at most this many newest edges. */
export const DEFAULT_HYDRATE_EDGES = 50_000

/** Options for {@link GraphStore}. */
export interface GraphStoreOptions {
  workspaceRoot: string
  hydrateNodes?: number
  hydrateEdges?: number
}

interface NodeRow {
  identity: number
  handle: string
  kind: string
  locator: string
  path: string | null
  name: string | null
  label: string | null
  byteStart: number | null
  byteEnd: number | null
  lineStart: number | null
  lineEnd: number | null
  fingerprint: string | null
  charset: string | null
  status: string
  summary: string | null
  brief: string | null
  description: string | null
  usage: string | null
  purpose: string | null
  reference: string | null
  detail: string | null
  ordinal: number
  created: number
  changed: number
}

interface EdgeRow {
  relation: string
  status: string
  baselineVersion: string | null
  targetVersion: string | null
  evidenceHandle: string | null
  created: number
  changed: number | null
  sourceHandle: string
  targetHandle: string | null
}

/**
 * SQLite-backed graph store. One instance per lazily-created tool runtime; it
 * borrows the long-lived `CoordinationDatabase` and never closes it.
 */
export class GraphStore {
  readonly projectHandle: string
  private readonly db: CoordinationDatabase
  private readonly hydrateNodes: number
  private readonly hydrateEdges: number
  private readonly identities = new Map<string, number>()
  private projectIdentity: number | undefined

  constructor(db: CoordinationDatabase, options: GraphStoreOptions) {
    this.db = db
    this.projectHandle = projectHandleFor(resolve(options.workspaceRoot))
    this.hydrateNodes = positiveLimit(options.hydrateNodes, DEFAULT_HYDRATE_NODES)
    this.hydrateEdges = positiveLimit(options.hydrateEdges, DEFAULT_HYDRATE_EDGES)
  }

  /** Run a group of graph writes in one transaction (nested calls are flat). */
  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)
  }

  /**
   * Remove the edges a previous parse of this file produced, before the fresh
   * parse re-adds its current edges. Incoming `depends` edges from *other*
   * files are preserved: their target version, not their existence, is the
   * thing a reparse changes.
   */
  beginParse(path: string): void {
    const identity = this.identityOf(fileHandleFor(path))
    if (identity === undefined) return
    this.db.run("DELETE FROM edge WHERE source = ? OR (kind = 'part_of' AND target = ?)", identity, identity)
  }

  /** Upsert one registry card node. */
  saveNode(record: NodePersistenceRecord): void {
    const project = this.ensureProject()
    const now = Date.now()
    const owner = record.ownerHandle === undefined
      ? project
      : this.identityOf(record.ownerHandle) ?? project
    const values: Record<string, unknown> = {
      handle: this.storedHandle(record.handle),
      kind: record.kind,
      locator: record.locator ?? `node:${record.handle}`,
      project,
      owner,
      path: record.path,
      name: record.name,
      label: record.label,
      ordinal: record.ordinal ?? 0,
      byteStart: record.byteStart,
      byteEnd: record.byteEnd,
      lineStart: record.lineStart,
      lineEnd: record.lineEnd,
      fingerprint: record.fingerprint,
      charset: record.charset,
      status: record.status,
      summary: record.summary,
      brief: record.brief,
      description: record.description,
      usage: record.usage,
      purpose: record.purpose,
      reference: record.reference === undefined ? undefined : JSON.stringify(record.reference),
      detail: record.domain === undefined ? undefined : JSON.stringify({ domain: record.domain }),
      version: record.fingerprint ?? `status:${record.status}`,
      created: record.created ?? now,
      changed: record.changed ?? now,
    }
    const identity = this.identityOf(record.handle)
    if (identity !== undefined) {
      this.db.update('node', values, 'identity = ?', identity)
      return
    }
    const inserted = this.db.insert('node', values)
    this.identities.set(record.handle, inserted)
  }

  /** Upsert one chain vertex (parser node, host node or lexical stub). */
  saveChainNode(node: ChainNodeSnapshot): void {
    const project = this.ensureProject()
    const now = Date.now()
    const values: Record<string, unknown> = {
      handle: this.storedHandle(node.handle),
      kind: node.kind,
      locator: `node:${node.handle}`,
      project,
      owner: project,
      path: node.path,
      name: node.name,
      label: node.label,
      byteStart: node.byteStart,
      byteEnd: node.byteEnd,
      lineStart: node.lineStart,
      lineEnd: node.lineEnd,
      fingerprint: node.fingerprint,
      charset: node.charset,
      status: node.origin === 'stub' ? 'unverifiable' : 'parsed',
      brief: node.brief,
      version: node.version,
      created: now,
      changed: now,
    }
    const identity = this.identityOf(node.handle)
    if (identity !== undefined) {
      // Never downgrade a card node to the coarse chain row: only fill the
      // columns a card may not carry (locator stays as persisted).
      this.db.update(
        'node',
        {
          ...(node.path === undefined ? {} : { path: node.path }),
          ...(node.name === undefined ? {} : { name: node.name }),
          ...(node.label === undefined ? {} : { label: node.label }),
          ...(node.brief === undefined ? {} : { brief: node.brief }),
          version: node.version,
          changed: now,
        },
        'identity = ?',
        identity,
      )
      return
    }
    const inserted = this.db.insert('node', values)
    this.identities.set(node.handle, inserted)
  }

  /** Upsert one chain edge, creating any missing endpoint as an explicit stub. */
  saveEdge(edge: ChainEdgeSnapshot): void {
    const project = this.ensureProject()
    const source = this.requireEndpoint(edge.from)
    const target = this.requireEndpoint(edge.to)
    const handle = edgeHandleFor(this.projectHandle, edge)
    const values: Record<string, unknown> = {
      handle,
      kind: edge.relation,
      source,
      target,
      project,
      label: '',
      status: edge.status,
      baselineVersion: edge.baselineVersion,
      targetVersion: edge.targetVersion,
      evidenceHandle: edge.evidenceHandle,
      created: edge.created,
      changed: edge.changed,
    }
    const existing = this.db.get<{ identity: number }>('SELECT identity FROM edge WHERE handle = ?', handle)
    if (existing !== undefined) {
      this.db.update('edge', values, 'identity = ?', existing.identity)
      return
    }
    this.db.insert('edge', values)
  }

  /** Remove one persisted edge (a re-pointed stub edge or a reparse). */
  deleteEdge(edge: { relation: string; from: string; to: string }): void {
    this.db.run('DELETE FROM edge WHERE handle = ?', edgeHandleFor(this.projectHandle, edge))
  }

  /**
   * Upsert the per-file snapshot row. `edgeCount` is computed from the edge
   * table after the parse has indexed, so it describes the persisted graph, not
   * a projection counter.
   */
  saveSnapshot(parsed: ParsedFile, counts: { nodeCount: number; edgeCount?: number }): void {
    if (parsed.path === undefined) return
    const fileHandle = fileHandleFor(parsed.path)
    const node = this.identityOf(fileHandle)
    if (node === undefined) return
    const now = Date.now()
    const handle = `snapshot:${fileHandle}`
    const values: Record<string, unknown> = {
      handle,
      node,
      path: parsed.path,
      size: parsed.size,
      modified: parsed.mtime ?? 0,
      parser: parsed.parserId,
      hash: parsed.file.fingerprint ?? '',
      status: parsed.status,
      nodeCount: counts.nodeCount,
      edgeCount: counts.edgeCount ?? this.edgeCountFor(fileHandle),
      created: now,
      changed: now,
    }
    const existing = this.db.get<{ identity: number }>('SELECT identity FROM snapshot WHERE node = ?', node)
    if (existing !== undefined) {
      this.db.update('snapshot', values, 'identity = ?', existing.identity)
      return
    }
    this.db.insert('snapshot', values)
  }

  /**
   * The project row this store reads for, when it exists.
   *
   * Every node/edge row carries `project`; without this filter a store rooted at
   * workspace A would return workspace B's nodes (the whole database mixes
   * projects). A store whose project was never indexed returns nothing rather
   * than another workspace's graph.
   */
  private projectForRead(): number | undefined {
    if (this.projectIdentity !== undefined) return this.projectIdentity
    const row = this.db.get<{ identity: number }>(
      'SELECT identity FROM node WHERE handle = ?',
      this.projectHandle,
    )
    if (row === undefined) return undefined
    this.projectIdentity = row.identity
    return row.identity
  }

  /** Newest-first persisted nodes, bounded; the rehydration input. */
  loadNodes(): NodePersistenceRecord[] {
    const project = this.projectForRead()
    if (project === undefined) return []
    const rows = this.db.all<NodeRow>(
      `SELECT identity, handle, kind, locator, path, name, label, byteStart, byteEnd,
              lineStart, lineEnd, fingerprint, charset, status, summary, brief,
              description, usage, purpose, reference, detail, ordinal, created, changed
         FROM node
        WHERE project = ? AND kind <> 'project' AND kind <> 'unknown'
        ORDER BY changed DESC, identity DESC
        LIMIT ?`,
      project,
      this.hydrateNodes,
    )
    return rows.map((row) => ({
      handle: this.domainHandle(row.handle),
      kind: row.kind,
      locator: row.locator,
      ...(row.path === null ? {} : { path: row.path }),
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.label === null ? {} : { label: row.label }),
      ...(row.byteStart === null ? {} : { byteStart: row.byteStart }),
      ...(row.byteEnd === null ? {} : { byteEnd: row.byteEnd }),
      ...(row.lineStart === null ? {} : { lineStart: row.lineStart }),
      ...(row.lineEnd === null ? {} : { lineEnd: row.lineEnd }),
      ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
      ...(row.charset === null ? {} : { charset: row.charset }),
      status: nodeStatus(row.status),
      ...(row.summary === null ? {} : { summary: row.summary }),
      ...(row.brief === null ? {} : { brief: row.brief }),
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.usage === null ? {} : { usage: row.usage }),
      ...(row.purpose === null ? {} : { purpose: row.purpose }),
      ...(row.reference === null ? {} : { reference: parseJson(row.reference, undefined) }),
      ...(row.detail === null ? {} : detailOf(row.detail)),
      ordinal: row.ordinal,
      created: row.created,
      changed: row.changed,
    }))
  }

  /** Newest-first persisted nodes as chain snapshots (same rows, fewer fields). */
  loadChainNodes(): ChainNodeSnapshot[] {
    return this.loadNodes().map((record) => ({
      handle: record.handle,
      kind: record.kind,
      ...(record.name === undefined ? {} : { name: record.name }),
      ...(record.label === undefined ? {} : { label: record.label }),
      ...(record.brief === undefined ? {} : { brief: record.brief }),
      ...(record.path === undefined ? {} : { path: record.path }),
      ...(record.byteStart === undefined ? {} : { byteStart: record.byteStart }),
      ...(record.byteEnd === undefined ? {} : { byteEnd: record.byteEnd }),
      ...(record.lineStart === undefined ? {} : { lineStart: record.lineStart }),
      ...(record.lineEnd === undefined ? {} : { lineEnd: record.lineEnd }),
      ...(record.fingerprint === undefined ? {} : { fingerprint: record.fingerprint }),
      ...(record.charset === undefined ? {} : { charset: record.charset }),
      version: record.fingerprint ?? `status:${record.status}`,
      origin: record.kind === 'unknown' ? 'stub' : 'parser',
    }))
  }

  /** Newest-first persisted edges, bounded; endpoints are joined by handle. */
  loadEdges(): ChainEdgeSnapshot[] {
    const project = this.projectForRead()
    if (project === undefined) return []
    const rows = this.db.all<EdgeRow>(
      `SELECT e.kind AS relation, e.status, e.baselineVersion, e.targetVersion,
              e.evidenceHandle, e.created, e.changed,
              s.handle AS sourceHandle, t.handle AS targetHandle
         FROM edge e
         JOIN node s ON s.identity = e.source AND s.project = ?
         LEFT JOIN node t ON t.identity = e.target
        ORDER BY e.identity DESC
        LIMIT ?`,
      project,
      this.hydrateEdges,
    )
    const edges: ChainEdgeSnapshot[] = []
    for (const row of rows) {
      if (row.targetHandle === null) continue
      edges.push({
        relation: row.relation as ChainEdgeSnapshot['relation'],
        from: this.domainHandle(row.sourceHandle),
        to: this.domainHandle(row.targetHandle),
        status: chainStatus(row.status),
        ...(row.baselineVersion === null ? {} : { baselineVersion: row.baselineVersion }),
        ...(row.targetVersion === null ? {} : { targetVersion: row.targetVersion }),
        ...(row.evidenceHandle === null ? {} : { evidenceHandle: row.evidenceHandle }),
        created: row.created,
        changed: row.changed ?? row.created,
      })
    }
    return edges
  }

  /** Edge rows touched by one file node (snapshot count). */
  edgeCountFor(fileHandle: string): number {
    const identity = this.identityOf(fileHandle)
    if (identity === undefined) return 0
    const row = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM edge WHERE source = ? OR target = ?',
      identity,
      identity,
    )
    return Number(row?.total ?? 0)
  }

  /* --------------------------------------------------------------------- *
   * Internals
   * --------------------------------------------------------------------- */

  private ensureProject(): number {
    if (this.projectIdentity !== undefined) return this.projectIdentity
    const existing = this.db.get<{ identity: number }>(
      'SELECT identity FROM node WHERE handle = ?',
      this.projectHandle,
    )
    if (existing !== undefined) {
      this.projectIdentity = existing.identity
      return existing.identity
    }
    const now = Date.now()
    const identity = this.db.insert('node', {
      handle: this.projectHandle,
      kind: 'project',
      locator: `project:${this.projectHandle}`,
      status: 'parsed',
      ordinal: 0,
      created: now,
      changed: now,
    })
    // A project row may exist before its own identity is known (the CHECK only
    // permits a NULL project for the project kind, and the FK then needs the
    // row itself).
    this.db.run('UPDATE node SET project = ? WHERE identity = ?', identity, identity)
    this.identities.set(this.projectHandle, identity)
    this.projectIdentity = identity
    return identity
  }

  private requireEndpoint(handle: string): number {
    const existing = this.identityOf(handle)
    if (existing !== undefined) return existing
    const project = this.ensureProject()
    const now = Date.now()
    const identity = this.db.insert('node', {
      handle: this.storedHandle(handle),
      kind: 'unknown',
      locator: `node:${handle}`,
      project,
      owner: project,
      status: 'unverifiable',
      version: 'unknown',
      created: now,
      changed: now,
    })
    this.identities.set(handle, identity)
    return identity
  }

  private identityOf(handle: string): number | undefined {
    const cached = this.identities.get(handle)
    if (cached !== undefined) return cached
    const row = this.db.get<{ identity: number }>(
      'SELECT identity FROM node WHERE handle = ?',
      this.storedHandle(handle),
    )
    if (row === undefined) return undefined
    this.identities.set(handle, row.identity)
    return row.identity
  }

  /**
   * The stored node handle is scoped to this store's project.
   *
   * `node.handle` is UNIQUE and `node.project` is a column, so two workspaces
   * containing the same relative path produced the same handle; the second
   * workspace's write then updated the first workspace's row (moving it to the
   * new project). Prefixing the stored handle keeps the domain handle stable in
   * the API while making the row unique per workspace.
   */
  private storedHandle(handle: string): string {
    return `${this.projectHandle}\u0000${handle}`
  }

  /** Reverse of {@link storedHandle}: the handle callers and the chain see. */
  private domainHandle(stored: string): string {
    const prefix = `${this.projectHandle}\u0000`
    return stored.startsWith(prefix) ? stored.slice(prefix.length) : stored
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

/** Deterministic project handle per absolute workspace root. */
export function projectHandleFor(workspaceRoot: string): string {
  return `p${hash(`${resolve(workspaceRoot)}`)}`
}

/** Deterministic edge handle per (project, relation, source, target). */
export function edgeHandleFor(projectHandle: string, edge: { relation: string; from: string; to: string }): string {
  return `e${hash(`${projectHandle}\u0000${edge.relation}\u0000${edge.from}\u0000${edge.to}`)}`
}

function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 24)
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) return fallback
  return Math.min(value, fallback)
}

/** Body-free `detail` columns this store writes: only the domain concept. */
function detailOf(value: string): { domain?: ConceptMetadata } {
  const parsed = parseJson<Record<string, unknown>>(value, {})
  const domain = parsed.domain
  return domain !== undefined && domain !== null && typeof domain === 'object'
    ? { domain: domain as ConceptMetadata }
    : {}
}

function nodeStatus(value: string): NodeStatus {
  return value === 'parsed' ||
    value === 'partial' ||
    value === 'truncated' ||
    value === 'failed' ||
    value === 'unverifiable'
    ? value
    : 'partial'
}

function chainStatus(value: string): ChainEdgeSnapshot['status'] {
  return value === 'satisfied' ||
    value === 'unmet' ||
    value === 'unknown' ||
    value === 'stale' ||
    value === 'unverifiable'
    ? value
    : 'unknown'
}


