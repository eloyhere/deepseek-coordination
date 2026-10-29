/**
 * v24 persistence tests (limitations 1 and 6 of the 0.10.0 README).
 *
 * They prove the durable half of the file layer end to end:
 *
 *  - schema 24 adds `node`/`edge`/`snapshot` to an existing schema-23 database
 *    without touching a row (`CREATE ... IF NOT EXISTS`, no destructive ALTER);
 *  - a parse writes body-free nodes/edges and a snapshot;
 *  - closing the database and building a **new** service + tool runtime
 *    rehydrates the same deterministic handles, so `coordination_describe` and
 *    `coordination_chain` answer by the old handle;
 *  - the explicit domain concept (`NodeMetadata.domain`) is projected onto the
 *    card and persisted through `node.detail`, never duplicated as a node.
 *
 * Every test runs on plain Node; no Cordis/DSH host is involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CoordinationDatabase, SCHEMA_VERSION } from '../src/host/database.js'
import { fileHandleFor, NodeRegistry } from '../src/host/node-registry.js'
import type { DescribeResult, NodeCard } from '../src/host/node-registry.js'
import { GraphStore, projectHandleFor } from '../src/host/graph-store.js'
import type { ChainProjection } from '../src/host/chain.js'
import { registerCoordinationTools } from '../src/host/tools.js'
import type {
  CoordinationToolDefinition,
  CoordinationToolRegistry,
  CoordinationToolService,
  ParseToolValue,
} from '../src/host/tools.js'
import type { ParsedFile } from '../src/host/parse-service.js'
import type { NodeMetadata } from '../src/host/text/parser.js'
import { testConfig } from './helpers.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

class TempWorkspace {
  readonly root: string

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'coordination-persistence-'))
  }

  write(relative: string, content: string): void {
    const absolute = join(this.root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }

  close(): void {
    rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

class MemoryRegistry implements CoordinationToolRegistry {
  readonly definitions = new Map<string, CoordinationToolDefinition>()

  register(definition: CoordinationToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => {
      if (this.definitions.get(definition.name) === definition) this.definitions.delete(definition.name)
    }
  }

  get(name: string): CoordinationToolDefinition {
    const definition = this.definitions.get(name)
    if (definition === undefined) throw new Error(`tool ${name} was not registered`)
    return definition
  }
}

/** A composed-host-shaped service over a real coordination database. */
function persistentService(
  db: CoordinationDatabase,
  workspaceRoot: string,
): CoordinationToolService {
  return {
    locale: 'en-US',
    db,
    config: testConfig(),
    workspaceRoot,
    state: () => {
      throw new Error('selection tools are not used by the persistence tests')
    },
    setSelection: () => {
      throw new Error('selection tools are not used by the persistence tests')
    },
    activeTurn: () => undefined,
    getProfessionRecord: () => {
      throw new Error('profession tools are not used by the persistence tests')
    },
    turnByOrdinal: () => undefined,
  }
}

/** A synthetic, body-free parse used for the domain-projection test. */
function syntheticParse(domain: NodeMetadata['domain'], path = 'docs/spec.md'): ParsedFile {
  const file: NodeMetadata = {
    kind: 'document',
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 5,
    fingerprint: 'sha256:file',
    charset: 'utf-8',
    span: { start: 0, end: 100, line: 1, column: 1 },
  }
  const chapter: NodeMetadata = {
    kind: 'heading',
    name: 'Chapter One',
    path,
    byteStart: 10,
    byteEnd: 30,
    lineStart: 2,
    lineEnd: 2,
    fingerprint: 'sha256:chapter',
    charset: 'utf-8',
    ...(domain === undefined ? {} : { domain }),
    span: { start: 10, end: 30, line: 2, column: 1 },
  }
  return {
    path,
    parserId: 'markdown',
    charset: 'utf-8',
    bomBytes: 0,
    truncated: false,
    tokens: 10,
    size: 100,
    cached: false,
    status: 'parsed',
    file,
    nodes: [chapter],
    references: [],
    diagnostics: [],
    structure: { headings: [], statements: [], divs: [], formulaReferences: [], frontMatter: {} },
  }
}

/* ------------------------------------------------------------------------- *
 * Schema migration
 * ------------------------------------------------------------------------- */

test('schema 26 adds the graph and AMP tables to a schema-23 database without losing rows', () => {
  const workspace = new TempWorkspace()
  const path = join(workspace.root, 'legacy.db')
  try {
    // Simulate a database created by 0.9.x: one old table plus a row and the
    // old user_version. `CoordinationDatabase` must create the v25 tables and
    // bump the version without touching this row.
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE session (
        identity INTEGER PRIMARY KEY AUTOINCREMENT,
        handle TEXT UNIQUE NOT NULL,
        principal TEXT NOT NULL,
        sandbox TEXT NOT NULL,
        interaction TEXT NOT NULL,
        scene TEXT NOT NULL,
        validation TEXT NOT NULL,
        profile TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created INTEGER NOT NULL
      );
      INSERT INTO session (handle, principal, sandbox, interaction, scene, validation, profile, created)
      VALUES ('legacy-session', 'test', 'workspace-write', 'think', 'dialogue', 'medium', 'default', 1);
      PRAGMA user_version = 23;
    `)
    legacy.close()

    const db = new CoordinationDatabase(path)
    try {
      assert.equal(SCHEMA_VERSION, 26)
      assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 26)
      assert.equal(db.count('session'), 1)
      assert.equal(
        db.get<{ principal: string }>("SELECT principal FROM session WHERE handle = 'legacy-session'")?.principal,
        'test',
      )
      const tables = new Set(
        db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name),
      )
      for (const table of ['node', 'edge', 'snapshot', 'amp_object', 'amp_key', 'amp_manifest', 'amp_checkpoint']) {
        assert.ok(tables.has(table), `${table} table is missing`)
      }
      const indexes = new Set(
        db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name),
      )
      for (const index of ['idx_node_locator', 'idx_edge_key', 'idx_snapshot_path']) {
        assert.ok(indexes.has(index), `${index} index is missing`)
      }
    } finally {
      db.close()
    }
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Restart rehydration
 * ------------------------------------------------------------------------- */

test('handles and chain edges survive closing the database and building a new runtime', async () => {
  const workspace = new TempWorkspace()
  const marker = 'PERSISTED_BODY_MARKER_4c7a'
  const dbPath = join(workspace.root, 'coordination.db')
  try {
    workspace.write(
      'src/a.ts',
      `import './b'\n/** Alpha. */\nexport function alpha(): string { return '${marker}' }\n`,
    )
    workspace.write('src/b.ts', '/** Beta. */\nexport function beta(): number { return 2 }\n')

    const db = new CoordinationDatabase(dbPath)
    const service = persistentService(db, workspace.root)
    const first = new MemoryRegistry()
    const dispose = registerCoordinationTools(first, service, 'en-US')
    let aHandle = ''
    let bHandle = ''
    let aFingerprint = ''
    try {
      const parsedA = (await first.get('coordination_parse').execute({ path: 'src/a.ts' })) as ParseToolValue
      const parsedB = (await first.get('coordination_parse').execute({ path: 'src/b.ts' })) as ParseToolValue
      aHandle = parsedA.cards[0]?.identity as string
      bHandle = parsedB.cards[0]?.identity as string
      aFingerprint = parsedA.cards[0]?.fingerprint as string
      assert.equal(aHandle, fileHandleFor('src/a.ts'))
      assert.equal(bHandle, fileHandleFor('src/b.ts'))
      assert.equal(parsedA.dependencies.files, 1)
      assert.equal(parsedB.dependencies.files, 2)

      const before = (await first.get('coordination_chain').execute({
        handle: aHandle,
        action: 'dependencies',
      })) as ChainProjection
      assert.equal(before.links.length, 1)
      assert.equal(before.links[0]?.handle, bHandle)

      // The database has body-free nodes, edges with their status and two
      // snapshots.
      assert.ok(db.count('node') >= 4)
      assert.ok(db.count('edge') >= 2)
      assert.ok(db.count('edge', "kind = 'depends'") >= 1)
      assert.ok(db.count('edge', "kind = 'contains'") >= 1)
      assert.equal(db.count('snapshot'), 2)
      const depends = db.all<{ status: string }>("SELECT status FROM edge WHERE kind = 'depends'")
      assert.deepEqual(depends.map((row) => row.status), ['satisfied'])
      const snapshot = db.get<{ parser: string; nodeCount: number; hash: string }>(
        "SELECT parser, nodeCount, hash FROM snapshot WHERE path = 'src/a.ts'",
      )
      assert.equal(snapshot?.parser, 'javascript')
      assert.ok((snapshot?.nodeCount ?? 0) >= 2)
      assert.equal(snapshot?.hash, aFingerprint)
      // No body/secret ever reaches a node/edge/snapshot row.
      for (const table of ['node', 'edge', 'snapshot']) {
        assert.ok(!JSON.stringify(db.all(`SELECT * FROM ${table}`)).includes(marker), `${table} leaked a body`)
      }
    } finally {
      dispose()
      db.close()
    }

    // A *new* database object, a *new* service and a *new* tool runtime: the
    // only shared state is the file on disk.
    const reopened = new CoordinationDatabase(dbPath)
    const second = new MemoryRegistry()
    const disposeSecond = registerCoordinationTools(second, persistentService(reopened, workspace.root), 'en-US')
    try {
      const described = (await second.get('coordination_describe').execute({
        handle: aHandle,
        fields: ['summary', 'description', 'usage', 'purpose'],
      })) as DescribeResult
      assert.equal(described.card.identity, aHandle)
      assert.equal(described.card.kind, 'module')
      assert.equal(described.fields.path, 'src/a.ts')
      assert.equal(described.fields.fingerprint, aFingerprint)
      assert.equal(described.status, 'parsed')
      assert.ok(Array.isArray(described.unverifiable))
      assert.ok(!('content' in described))

      const after = (await second.get('coordination_chain').execute({
        handle: aHandle,
        action: 'dependencies',
        depth: 2,
      })) as ChainProjection
      assert.equal(after.root, aHandle)
      assert.equal(after.links.length, 1)
      assert.equal(after.links[0]?.handle, bHandle)
      assert.equal(after.links[0]?.relation, 'depends')
      assert.equal(after.links[0]?.status, 'satisfied')
      assert.equal(after.links[0]?.path, 'src/b.ts')

      // An unknown handle is still an explicit NOT_FOUND, not a fabricated one.
      await assert.rejects(
        Promise.resolve(second.get('coordination_describe').execute({ handle: 'nmissing' })),
        /was not found/,
      )
    } finally {
      disposeSecond()
      reopened.close()
    }
  } finally {
    workspace.close()
  }
})

test('re-parsing refreshes the persisted card instead of duplicating the handle', async () => {
  const workspace = new TempWorkspace()
  const dbPath = join(workspace.root, 'coordination.db')
  try {
    workspace.write('src/retune.ts', 'export const one = 1\n')
    const db = new CoordinationDatabase(dbPath)
    const service = persistentService(db, workspace.root)
    const registry = new MemoryRegistry()
    const dispose = registerCoordinationTools(registry, service, 'en-US')
    try {
      const first = (await registry.get('coordination_parse').execute({ path: 'src/retune.ts' })) as ParseToolValue
      const handle = first.cards[0]?.identity as string
      const nodes = db.count('node')
      const edges = db.count('edge')
      const snapshots = db.count('snapshot')

      // Grow the file: the same deterministic handle must be updated in place.
      workspace.write('src/retune.ts', 'export const one = 1\nexport const two = 2\n')
      const second = (await registry.get('coordination_parse').execute({ path: 'src/retune.ts' })) as ParseToolValue
      assert.equal(second.cards[0]?.identity, handle)
      assert.notEqual(second.cards[0]?.fingerprint, first.cards[0]?.fingerprint)
      assert.equal(db.count('snapshot'), snapshots)
      assert.ok(db.count('node') >= nodes)
      assert.ok(db.count('edge') >= edges)
      // Node rows are keyed by a project-scoped handle; the API handle stays stable.
      const storedHandle = `${projectHandleFor(workspace.root)}\u0000${handle}`
      const row = db.get<{ fingerprint: string }>('SELECT fingerprint FROM node WHERE handle = ?', storedHandle)
      assert.equal(row?.fingerprint, second.cards[0]?.fingerprint)
    } finally {
      dispose()
      db.close()
    }
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Domain projection
 * ------------------------------------------------------------------------- */

test('an explicit domain concept is projected onto the card and persisted without a second node', () => {
  const db = new CoordinationDatabase(':memory:')
  try {
    const store = new GraphStore(db, { workspaceRoot: '/workspace/spec' })
    const parsed = syntheticParse({
      kind: 'chapter',
      locator: 'document:docs/spec.md/chapter:1',
      partOf: 'document:docs/spec.md',
    })
    const registry = new NodeRegistry({ persist: store })
    const cards = registry.register(parsed)
    assert.equal(cards.length, 2)
    const chapter = cards[1] as NodeCard
    assert.equal(chapter.kind, 'heading')
    assert.equal(chapter.domain?.kind, 'chapter')
    assert.equal(chapter.domain?.locator, 'document:docs/spec.md/chapter:1')

    // One node row per card (plus the project row); the domain concept did not
    // create an extra node.
    assert.equal(db.count('node'), 3)
    assert.equal(db.count('node', "kind = 'chapter'"), 0)

    const restored = new NodeRegistry()
    restored.restore(store.loadNodes())
    const described = restored.describe(chapter.identity)
    assert.deepEqual(described.card.domain, {
      kind: 'chapter',
      locator: 'document:docs/spec.md/chapter:1',
      partOf: 'document:docs/spec.md',
    })
  } finally {
    db.close()
  }
})

test('a graph store reads only its own workspace project', () => {
  const db = new CoordinationDatabase(':memory:')
  try {
    const alpha = new GraphStore(db, { workspaceRoot: 'R:/workspace/alpha' })
    const beta = new GraphStore(db, { workspaceRoot: 'R:/workspace/beta' })

    // Before either workspace is indexed, neither store may borrow the other's rows.
    assert.deepEqual(beta.loadNodes(), [])
    assert.deepEqual(beta.loadEdges(), [])

    new NodeRegistry({ persist: alpha }).register(syntheticParse({
      kind: 'chapter',
      locator: 'document:alpha.md/chapter:1',
      partOf: 'document:alpha.md',
    }))
    assert.ok(alpha.loadNodes().length > 0)
    assert.deepEqual(beta.loadNodes(), [], 'beta must not see alpha nodes')
    assert.deepEqual(beta.loadEdges(), [], 'beta must not see alpha edges')

    const alphaCount = alpha.loadNodes().length
    new NodeRegistry({ persist: beta }).register(syntheticParse({
      kind: 'chapter',
      locator: 'document:beta.md/chapter:1',
      partOf: 'document:beta.md',
    }))
    // Domain handles are per workspace path, so they may legitimately repeat
    // across workspaces; isolation is proven by the row count, not by the name.
    assert.equal(alpha.loadNodes().length, alphaCount, 'alpha must not grow when beta indexes')
    assert.ok(beta.loadNodes().length > 0)
  } finally {
    db.close()
  }
})




test('a scoped node load pushes the path prefix into SQL', () => {
  const db = new CoordinationDatabase(':memory:')
  try {
    // Two rows per file; a global window of 2 would keep only one path.
    const store = new GraphStore(db, { workspaceRoot: 'R:/workspace/scoped', hydrateNodes: 2 })
    const registry = new NodeRegistry({ persist: store })
    registry.register(syntheticParse({
      kind: 'chapter',
      locator: 'document:src/big.ts/chapter:1',
      partOf: 'document:src/big.ts',
    }, 'src/big.ts'))
    registry.register(syntheticParse({
      kind: 'chapter',
      locator: 'document:docs/spec.md/chapter:1',
      partOf: 'document:docs/spec.md',
    }, 'docs/spec.md'))

    const docs = store.loadNodes('docs')
    assert.ok(docs.length > 0, 'the docs subtree must be hydrated even past the global window')
    assert.ok(docs.every((node) => node.path === undefined || node.path.startsWith('docs/')))

    const src = store.loadNodes('src')
    assert.ok(src.length > 0)
    assert.ok(src.every((node) => node.path === undefined || node.path.startsWith('src/')))

    assert.ok(store.loadNodes().length > 0, 'the unscoped read keeps working')
    assert.deepEqual(store.loadNodes('missing'), [])
  } finally {
    db.close()
  }
})


