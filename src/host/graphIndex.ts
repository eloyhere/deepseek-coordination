/** Shared, bounded graph updates for UI routes and model calls. Workspace files are only read. */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoordinationDatabase } from './database.js'
import { GraphStore } from './graphStore.js'
import { ParseService, type ParseServiceOptions } from './parseService.js'
import { NodeRegistry } from './nodeRegistry.js'
import { ChainEngine } from './chain.js'
import { InvalidArgumentError, InvalidStateError } from '../shared/error.js'
import {
  WorkspaceIndexGate, graphVersionOf, indexWorkspaceFiles, normaliseGraphPath,
  resetGraphCache, workspaceIndexReport,
  type WorkspaceIndexReport, type GraphNode, type GraphEdge,
} from './graphView.js'

export interface GraphIndexRequest {
  action?: 'index' | 'rebuild'
  paths?: readonly string[]
}
export interface GraphIndexValue extends WorkspaceIndexReport {
  action: 'index' | 'rebuild'
  version: string
}
export type GraphIndexOutcome =
  | { ok: true; value: GraphIndexValue }
  | { ok: false; error: { code: 'BUSY'; message: string } }

/** Persisted projection version: covers tool parses as well as explicit updates. */
export function graphRevision(db: CoordinationDatabase, root: string): { root: string; version: string } {
  const store = new GraphStore(db, { workspaceRoot: root })
  const nodes: GraphNode[] = store.loadNodes().map(record => ({
    handle: record.handle, kind: record.kind,
    ...(record.path === undefined ? {} : { path: record.path }),
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.label === undefined ? {} : { label: record.label }),
    ...(record.lineStart === undefined ? {} : { line: record.lineStart }),
    ...(record.ordinal === undefined ? {} : { ordinal: record.ordinal }),
    ...(record.changed === undefined ? {} : { changed: record.changed }),
  }))
  const edges: GraphEdge[] = store.loadEdges().map(edge => ({
    relation: edge.relation, from: edge.from, to: edge.to, changed: edge.changed,
  }))
  const base = graphVersionOf(nodes, edges)
  const revisions = store.loadSnapshotRevisions()
  let hash = 2166136261
  for (const item of revisions) {
    const text = `${item.path}\u0000${item.hash}\u0000${item.changed};`
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0
  }
  return { root, version: `${base}.${revisions.length}.${hash.toString(36)}` }
}

/** One owner per Host service; every caller shares its gate and persistence path. */
export class GraphIndexOperations {
  private readonly gate = new WorkspaceIndexGate()
  constructor(private readonly db: CoordinationDatabase) {}

  async update(root: string, request: GraphIndexRequest = {}, parseOptions: ParseServiceOptions = {}): Promise<GraphIndexOutcome> {
    const action = request.action ?? 'index'
    if (action !== 'index' && action !== 'rebuild') throw new InvalidArgumentError('action must be index or rebuild')
    if (action === 'rebuild' && request.paths !== undefined) throw new InvalidArgumentError('paths cannot be combined with rebuild')
    const paths = request.paths === undefined ? undefined : validateIndexPaths(request.paths)
    const outcome = await this.gate.run(async (): Promise<GraphIndexValue> => {
      const startedAt = Date.now()
      const parser = new ParseService({ ...parseOptions, workspaceRoot: root })
      const store = new GraphStore(this.db, { workspaceRoot: root })
      const registry = new NodeRegistry({ persist: { saveNode: record => store.saveNode(record) } })
      const chain = new ChainEngine({ persist: {
        saveNode: node => store.saveChainNode(node), saveEdge: edge => store.saveEdge(edge),
        deleteEdge: edge => store.deleteEdge(edge),
      } })
      const indexFile = async (path: string): Promise<number> => {
        await new Promise<void>(resolve => { setImmediate(resolve) })
        const parsed = parser.parse({ path })
        return store.transaction(() => {
          store.beginParse(path)
          const cards = registry.register(parsed)
          chain.index(parsed)
          store.saveSnapshot(parsed, { nodeCount: cards.length })
          return cards.length
        })
      }
      try {
        let result
        if (action === 'index' && paths === undefined) {
          result = await indexWorkspaceFiles({
            async readDirectory(path) {
              const entries = await readdir(path.length === 0 ? root : join(root, path), { withFileTypes: true })
              return entries.filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
                .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
            },
            indexFile,
          })
        } else {
          const known = paths ?? store.loadSnapshotRevisions().map(snapshot => snapshot.path)
          const targets = [...new Set(known)].sort()
          const cap = action === 'rebuild' ? 2_000 : 200
          let indexed = 0
          let skipped = 0
          let nodes = 0
          let attempted = 0
          for (const path of targets.slice(0, cap)) {
            if (Date.now() - startedAt >= 10_000) break
            attempted += 1
            try { nodes += await indexFile(path); indexed += 1 } catch { skipped += 1 }
          }
          result = { indexed, skipped, nodes, durationMs: Date.now() - startedAt, truncated: attempted < targets.length }
        }
        return { ...workspaceIndexReport(result, root), action, version: graphRevision(this.db, root).version }
      } finally {
        resetGraphCache()
        parser.clear()
        registry.clear()
        chain.clear()
      }
    })
    return outcome.ok ? outcome : { ok: false, error: { code: 'BUSY', message: 'a graph update is already running' } }
  }
}

/** Validate the entire batch before reading or persisting any member. */
export function validateIndexPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200) {
    throw new InvalidArgumentError('paths must contain 1-200 workspace-relative files')
  }
  return [...new Set(paths.map(path => {
    if (typeof path !== 'string' || path.length > 4096) throw new InvalidArgumentError('paths must contain workspace-relative files')
    const value = normaliseGraphPath(path)
    if (value === undefined) throw new InvalidArgumentError('paths must be workspace-relative files without ".."')
    return value
  }))]
}

const operations = new WeakMap<CoordinationDatabase, GraphIndexOperations>()
export function graphIndexOperations(db: CoordinationDatabase): GraphIndexOperations {
  let value = operations.get(db)
  if (value === undefined) { value = new GraphIndexOperations(db); operations.set(db, value) }
  return value
}

export function assertGraphIndexEnabled(config: unknown): void {
  if ((config as { parser?: { enabled?: boolean } } | undefined)?.parser?.enabled === false) {
    throw new InvalidStateError('workspace indexing is disabled by parser.enabled')
  }
}
