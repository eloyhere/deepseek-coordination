# Persistence v24 — durable node/edge/snapshot graph

Status: implemented for the file-tool layer. This note is the evidence record for
README limitation 1 ("No persistent node/edge graph") and the persistence half of
limitation 6 (live config retune). It documents the exact schema, migration and
rehydration behaviour; it is not a new design.

## 1. Schema (version 24)

`src/host/database.ts` bumps `SCHEMA_VERSION` to **24** and appends three tables
from `docs/domain-model-v24.md` §2.8:

| Table | Purpose |
|---|---|
| `node` | One body-free row per parsed card / chain vertex: public `handle`, `kind`, natural `locator`, project/owner links, six flat fields, fingerprint, charset, status, summary/brief/description/usage/purpose, `reference` JSON, optional `detail` JSON (domain concept). |
| `edge` | One row per relation: deterministic `handle`, `kind`, source/target identities, project, `baselineVersion`, ordinal, timestamps. |
| `snapshot` | One row per parsed file: node identity, path, size, mtime, parser id, file hash, status, node/edge counts. |

Indexes and foreign keys follow §2.8 (`idx_node_*`, `idx_edge_*`,
`idx_snapshot_path`).

**One deliberate extension.** The documented `edge` table has no status column,
but the chain projection's truth includes the per-edge status and the pinned
target version. `edge` therefore adds `status TEXT NOT NULL DEFAULT 'unknown'`,
`changed INTEGER`, `targetVersion TEXT` and `evidenceHandle TEXT`; all have
defaults, so an older/foreign writer that omits them still works. Everything else
matches the document.

No column stores a file body, source text, attachment bytes, AST or formula AST.
`node.reference` is the body-free JSON locator and `node.detail` currently holds
only `{ domain }` (the explicit structural concept added by the domain-extraction
workstream).

## 2. Migration

The new statements are `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
EXISTS`; there is no `ALTER`, `DROP` or rewrite of an existing table. Opening a
schema-23 database:

1. leaves every existing row untouched;
2. creates `node`/`edge`/`snapshot` and their indexes;
3. sets `PRAGMA user_version = 24`.

`test/persistence.test.ts` proves this against a hand-built schema-23 file (one
`session` row survives, the three tables/indexes appear, `user_version` becomes
24). If schema setup fails, the constructor closes the freshly opened handle
before throwing, so the file and its temp directory are not left locked.

## 3. Write path

`GraphStore` (`src/host/graph-store.ts`) is the only writer:

- `NodeRegistry` gets a `persist` sink and writes one `node` row per card
  (`NodePersistenceRecord`, including `description`, `domain` and the owning file
  handle);
- `ChainEngine` gets a `persist` sink and writes one `node` row per indexed
  vertex (including lexical stubs, status `unverifiable`) and one `edge` row per
  relation, including status/version/evidence updates and stub re-pointing;
- the file-tool runtime writes the `snapshot` row after a parse and wraps the
  whole `parse -> register -> index -> snapshot` sequence in one
  `BEGIN IMMEDIATE` transaction.

Handles are deterministic and are the database keys:

- node handle = `node-registry.ts` public handle (`sha256(path + kind + key)`);
- edge handle = `sha256(project + relation + source handle + target handle)`;
- project handle = `sha256(absolute workspace root)`.

`beginParse(path)` removes that file's previous outgoing edges (and inbound
`part_of` edges) before the fresh parse re-adds them, so a reparse updates instead
of duplicating; incoming `depends` edges from other files are preserved and their
target version is refreshed. `renderJson` values are unchanged: the graph never
appears in a tool value.

## 4. Rehydration

`ToolRuntime` creates a `GraphStore` only when the service exposes a real
`CoordinationDatabase` (a structural check; test fakes stay in-memory). The first
file-tool call reads:

| Read | Bound |
|---|---|
| `loadNodes()` / `loadChainNodes()` | newest **10,000** nodes (`DEFAULT_HYDRATE_NODES`), project/stub rows excluded from the card registry |
| `loadEdges()` | newest **50,000** edges (`DEFAULT_HYDRATE_EDGES`), endpoints joined by handle |

The registry restores cards and the chain engine restores vertices/edges without
calling the write sink. A handle older than the bound is `NOT_FOUND` again
(explicit; never a wrong answer). `test/persistence.test.ts` parses two files,
closes the database, opens a **new** database object + service + tool runtime, and
then `coordination_describe` and `coordination_chain` by the pre-restart handles;
the dependency edge (target version/status included) resolves as `satisfied`.

## 5. Bounds and gaps

- Rehydration is bounded; the database itself is not pruned yet, and a symbol
  removed from a file leaves its old `node` row behind (edges are cleaned for the
  file's outgoing relations). This is a storage-growth issue, not a wrong-handle
  issue: a reparse updates the surviving handles' ranges/fingerprints.
- `CoordinationService.metrics()` still reports `schema: 23`; it is a constant in
  `src/host/coordination.ts`, which this workstream does not own.
- The settings catalog (`src/shared/selection.ts`) still marks
  `parser.maxAstDepth`, both `parser.dependencyGraphMax*` keys and
  `tools.maxResultBytes` as `planned`/non-writable, while the runtime now consumes
  all four. Changing those rows (chip `host`, `wired: true`) is owned by the
  settings-catalog workstream; until then `/config` reports them in `ignored` and
  the new caps can only be set by deployment config.
- `parser.enabled=false` after registration makes the file tools fail closed
  (`INVALID_STATE`) but does not unregister them; re-registration (locale change
  or restart) is still required to remove the tool set. Turning it back on when
  the tools were registered while disabled needs the same re-registration.
