/**
 * Graph-view projection tests (`host/graph-view.ts`).
 *
 * The module is deliberately pure: every fixture here is a body-free snapshot
 * of the persisted v24 graph (`GraphNode[]` + `GraphEdge[]`), exactly what the
 * `/graph/*` routes hand in from `GraphStore.loadNodes()` / `loadEdges()`. No
 * database, filesystem, parser or Cordis host is involved, so these tests run
 * on plain Node.
 *
 * Covered contracts:
 *
 *  - tree projection from an indexed directory + file set, with parser child
 *    nodes ignored and the depth cap applied;
 *  - outline family detection and depth ordering for book, tex and project
 *    fixtures, with unknown kinds omitted, plus file/workspace scopes and caps;
 *  - dependency projection keeps file-level `depends` edges only (containment
 *    edges are filtered out), scopes to one file on request and computes cycles
 *    on the projected subgraph;
 *  - the cycle forms: mutual pair, three-node cycle, self-loop, acyclic graph;
 *  - import/export rows keep complete lists inside a cycle, scope to one file
 *    and respect caps;
 *  - search is case-insensitive, empty-query-safe and capped;
 *  - invalid outline paths are rejected with `INVALID_ARGUMENT`, unknown graph
 *    paths with `NOT_FOUND`;
 *  - the two-level cache: L1 within one query, L2 across queries of the same
 *    graph version, a scope component in the key, and a version bump clearing
 *    L2;
 *  - the preview extension classifier plus the in-memory payload builders:
 *    tex text/cap, docx sanitized HTML conversion, xlsx row/column caps and
 *    string-only cells, pptx title/line caps, and oversize truncation (the
 *    reads themselves belong to `index.ts`);
 *  - the workspace index report: the resolved root is always returned and a
 *    zero-file scan adds the `no-workspace-files` diagnostic;
 *  - the async, request-scoped workspace-root resolver's full precedence chain,
 *    its normalisation/validation rules and its per-request cache.
 */
import { deflateRawSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  INDEX_SKIP_DIRECTORIES,
  MAX_AGENT_MESSAGES,
  MAX_AGENT_MESSAGE_BYTES,
  MAX_AGENT_ROSTER,
  MAX_AGENT_TRANSCRIPT_BYTES,
  MAX_CYCLES,
  MAX_DOCX_DOCUMENT_BYTES,
  MAX_DOCX_HTML_BYTES,
  MAX_IMPORT_ENTRIES,
  MAX_INDEX_DEPTH,
  MAX_INDEX_FILES,
  MAX_INTRA_DEPTH,
  MAX_INTRA_EDGES,
  MAX_INTRA_NODES,
  MAX_OUTLINE_FILES,
  MAX_OUTLINE_NODES,
  MAX_PPTX_LINE_CHARS,
  MAX_PPTX_LINES,
  MAX_PREVIEW_TEXT_BYTES,
  MAX_SEARCH_LIMIT,
  MAX_XLSX_COLUMNS,
  MAX_XLSX_ROWS,
  TURN_CEILING,
  WorkspaceIndexGate,
  agentMessagesRoute,
  agentProgressOf,
  buildAgentRoster,
  buildAgentTranscript,
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
  graphCacheStats,
  indexWorkspaceFiles,
  isIndexableWorkspaceFile,
  normaliseGraphPath,
  previewKindOf,
  resetGraphCache,
  resolveAgentSessionEvents,
  sanitizePreviewHtml,
  searchGraph,
  workspaceIndexReport,
  type AgentRosterInput,
  type AgentServiceBundle,
  type AgentSessionEventLike,
  type GraphEdge,
  type GraphNode,
  type GraphQuery,
  type GraphScope,
  type WorkspaceIndexEntry,
  type WorkspaceIndexIo,
} from '../src/host/graph-view.js'
import {
  ToolWorkspaceRootResolver,
  resolveToolWorkspaceRootForRequest,
  type ToolWorkspaceRootService,
} from '../src/host/tools.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

/** One body-free node fixture. */
function node(handle: string, kind: string, path: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { handle, kind, path, ...extra }
}

/** One edge fixture. */
function edge(from: string, to: string, relation = 'depends'): GraphEdge {
  return { relation, from, to }
}

/** One scoped query fixture. */
function query(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[] = [],
  version = 'fixture',
  scope: GraphScope = 'workspace',
): GraphQuery {
  return createGraphQuery({ version, scope, nodes, edges })
}

function names(entries: ReadonlyArray<{ name: string }>): string[] {
  return entries.map((entry) => entry.name)
}

/* ------------------------------------------------------------------------- *
 * Tree
 * ------------------------------------------------------------------------- */

test('tree builds directories and files, ignores parser child nodes, sorts dirs first', () => {
  const nodes: GraphNode[] = [
    node('d-src', 'directory', 'src'),
    node('f-a', 'document', 'src/a.ts', { name: 'a.ts' }),
    node('f-b', 'module', 'src/lib/b.ts', { name: 'b.ts' }),
    node('f-book', 'book', 'docs/book.md', { name: 'book.md' }),
    // A parser child is not a file: it must never surface as a tree entry.
    node('p-heading', 'heading', 'docs/book.md', { name: 'Chapter' }),
  ]

  const tree = buildTree(nodes, '.')
  assert.equal(tree.root, '.')
  assert.deepEqual(names(tree.entries), ['docs', 'src'])
  assert.equal(tree.entries[0]?.kind, 'directory')
  assert.equal(tree.entries[1]?.kind, 'directory')

  const docs = tree.entries[0]
  assert.deepEqual(docs?.children?.map((entry) => [entry.path, entry.kind]), [['docs/book.md', 'file']])

  const src = tree.entries[1]
  assert.deepEqual(
    src?.children?.map((entry) => [entry.path, entry.kind]),
    [['src/lib', 'directory'], ['src/a.ts', 'file']],
  )
  assert.deepEqual(
    src?.children?.[0]?.children?.map((entry) => [entry.path, entry.kind]),
    [['src/lib/b.ts', 'file']],
  )
})

test('tree caps depth at 8 and returns no entries for an empty graph', () => {
  const deep = 'a/b/c/d/e/f/g/h/i/deep.ts'
  const tree = buildTree([node('deep', 'document', deep)], 'root')
  assert.equal(tree.root, 'root')
  // The file is at depth 10: neither it nor any directory past depth 8 exists.
  const flattened: string[] = []
  const stack = [...tree.entries]
  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry === undefined) break
    flattened.push(entry.path)
    if (entry.children !== undefined) stack.push(...entry.children)
  }
  assert.ok(!flattened.includes(deep))
  assert.ok(!flattened.includes('a/b/c/d/e/f/g/h/i'))
  assert.ok(flattened.includes('a/b/c/d/e/f/g/h'))

  assert.deepEqual(buildTree([], '.'), { root: '.', entries: [] })
})

/* ------------------------------------------------------------------------- *
 * Outline
 * ------------------------------------------------------------------------- */

test('outline: file scope for a book fixture omits unknown kinds', () => {
  const path = 'books/guide.book'
  const nodes: GraphNode[] = [
    node('b0', 'book', path, { name: 'Guide', line: 1 }),
    node('b1', 'chapter', path, { name: 'One', line: 4 }),
    node('b2', 'paragraph', path, { name: 'Intro', line: 5 }),
    node('b3', 'sentence', path, { name: 'First sentence.', line: 5 }),
    node('b4', 'footnote', path, { name: 'Unknown kind', line: 6 }),
  ]
  const outline = buildOutline(query(nodes), path)
  assert.equal(outline.scope, 'file')
  assert.equal(outline.path, path)
  assert.equal(outline.family, 'book')
  assert.deepEqual(
    outline.nodes.map((entry) => [entry.kind, entry.depth, entry.line]),
    [
      ['book', 0, 1],
      ['chapter', 1, 4],
      ['paragraph', 3, 5],
      ['sentence', 5, 5],
    ],
  )
})

test('outline: file scope for a tex fixture orders document..paragraph', () => {
  const path = 'paper/main.tex'
  const nodes: GraphNode[] = [
    node('t0', 'document', path, { name: 'main.tex', line: 1 }),
    node('t1', 'chapter', path, { name: 'Chapter', line: 2 }),
    node('t2', 'preface', path, { name: 'Preface', line: 3 }),
    node('t3', 'preamble', path, { name: 'Preamble', line: 4 }),
    node('t4', 'part', path, { name: 'Part', line: 5 }),
    node('t5', 'section', path, { name: 'Section', line: 6 }),
    node('t6', 'paragraph', path, { name: 'Paragraph', line: 7 }),
    node('t7', 'theorem', path, { name: 'A theorem', line: 8 }),
  ]
  const outline = buildOutline(query(nodes), path)
  assert.equal(outline.scope, 'file')
  assert.equal(outline.family, 'tex')
  assert.deepEqual(
    outline.nodes.map((entry) => [entry.kind, entry.depth]),
    [
      ['document', 0],
      ['chapter', 1],
      ['preface', 2],
      ['preamble', 3],
      ['part', 4],
      ['section', 5],
      ['paragraph', 6],
    ],
  )
})

test('outline: file scope for a project fixture orders module..exportation', () => {
  const path = 'src/app.ts'
  const nodes: GraphNode[] = [
    node('p0', 'module', path, { name: 'app', line: 1 }),
    node('p1', 'class', path, { name: 'App', line: 2 }),
    node('p2', 'method', path, { name: 'run', line: 3 }),
    node('p3', 'function', path, { name: 'boot', line: 4 }),
    node('p4', 'interface', path, { name: 'Options', line: 5 }),
    node('p5', 'type', path, { name: 'Mode', line: 6 }),
    node('p6', 'importation', path, { name: './util', line: 7 }),
    node('p7', 'enumeration', path, { name: 'State', line: 8 }),
    node('p8', 'namespace', path, { name: 'Ns', line: 9 }),
  ]
  const outline = buildOutline(query(nodes), path)
  assert.equal(outline.scope, 'file')
  assert.equal(outline.family, 'project')
  assert.deepEqual(
    outline.nodes.map((entry) => [entry.kind, entry.depth]),
    [
      ['module', 0],
      ['class', 2],
      ['method', 6],
      ['function', 7],
      ['interface', 4],
      ['type', 5],
      ['importation', 10],
    ],
  )
  // `enumeration` and `namespace` identify the family but have no depth in the
  // project order, so they are omitted rather than guessed.
  assert.ok(!outline.nodes.some((entry) => entry.kind === 'enumeration' || entry.kind === 'namespace'))
})

test('outline: workspace scope groups files by path with a cap per group', () => {
  const nodes: GraphNode[] = [
    node('f-b', 'document', 'b.md', { name: 'b.md' }),
    node('h-b', 'heading', 'b.md', { name: 'B heading', line: 2 }),
    node('f-a', 'document', 'a.md', { name: 'a.md' }),
    node('h-a', 'heading', 'a.md', { name: 'A heading', line: 2 }),
    node('f-c', 'file', 'notes.unknown'),
  ]
  const outline = buildOutline(query(nodes))
  assert.equal(outline.scope, 'workspace')
  assert.deepEqual(outline.groups.map((group) => group.path), ['a.md', 'b.md', 'notes.unknown'])
  assert.deepEqual(outline.groups[0]?.nodes.map((entry) => entry.kind), ['document', 'heading'])
  assert.equal(outline.groups[2]?.family, 'unknown')
  assert.deepEqual(outline.groups[2]?.nodes, [])
})

test('outline: workspace scope caps files at 200 and nodes per group at 500', () => {
  const nodes: GraphNode[] = []
  for (let index = 0; index < MAX_OUTLINE_FILES + 5; index += 1) {
    nodes.push(node(`f${index}`, 'document', `f${index}.md`, { name: `f${index}.md` }))
  }
  for (let index = 0; index < MAX_OUTLINE_NODES + 5; index += 1) {
    nodes.push(node(`s${index}`, 'sentence', 'f0.md', { name: `s${index}`, line: index + 2 }))
  }
  const outline = buildOutline(query(nodes))
  assert.equal(outline.scope, 'workspace')
  assert.equal(outline.groups.length, MAX_OUTLINE_FILES)
  assert.equal(outline.groups[0]?.path, 'f0.md')
  assert.equal(outline.groups[0]?.nodes.length, MAX_OUTLINE_NODES)
})

test('outline rejects invalid paths and returns NOT_FOUND for unindexed files', () => {
  const nodes: GraphNode[] = [node('f', 'document', 'docs/a.md', { name: 'a.md' })]
  for (const invalid of ['', '   ', '/etc/passwd', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini', '../secret.md', 'docs/../secret.md']) {
    assert.throws(
      () => buildOutline(query(nodes), invalid),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'INVALID_ARGUMENT',
      `expected ${JSON.stringify(invalid)} to be rejected`,
    )
  }
  assert.throws(
    () => buildOutline(query(nodes), 'docs/missing.md'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'NOT_FOUND',
  )
  assert.equal(normaliseGraphPath('docs/../secret.md'), undefined)
  assert.equal(normaliseGraphPath('./docs/a.md'), 'docs/a.md')
  assert.equal(normaliseGraphPath('docs\\a.md'), 'docs/a.md')
})

/* ------------------------------------------------------------------------- *
 * Dependencies and cycles
 * ------------------------------------------------------------------------- */

test('dependencies keep file-level depends edges only and skip unresolved targets', () => {
  const nodes: GraphNode[] = [
    node('d-src', 'directory', 'src'),
    node('f-a', 'module', 'src/a.ts'),
    node('f-b', 'module', 'src/b.ts'),
  ]
  const edges: GraphEdge[] = [
    edge('f-a', 'f-b'),
    edge('d-src', 'f-a', 'contains'),
    edge('f-a', 'd-src', 'part_of'),
    // Unresolved specifier: no indexed node, so no path and no pseudo-cycle.
    edge('f-a', 'missing-handle'),
  ]
  const view = buildDependencies(query(nodes, edges))
  assert.equal(view.scope, 'workspace')
  assert.deepEqual(view.links, [
    { from: 'src/a.ts', to: 'src/b.ts', relation: 'depends', cyclic: false },
  ])
  assert.deepEqual(view.cycles, [])
})

test('dependencies: mutual A<->B is one cycle and both edges are cyclic', () => {
  resetGraphCache()
  const nodes: GraphNode[] = [
    node('f-a', 'module', 'a.ts'),
    node('f-b', 'module', 'b.ts'),
    node('i-a', 'importation', 'a.ts', { name: './b', ordinal: 1 }),
    node('i-b', 'importation', 'b.ts', { name: './a', ordinal: 1 }),
  ]
  const edges: GraphEdge[] = [edge('f-a', 'f-b'), edge('f-b', 'f-a')]
  const graph = query(nodes, edges, 'cycle-pair')
  const view = buildDependencies(graph)
  assert.equal(view.scope, 'workspace')
  assert.deepEqual(view.cycles, [['a.ts', 'b.ts', 'a.ts']])
  assert.equal(view.links.length, 2)
  assert.ok(view.links.every((link) => link.cyclic))
  assert.deepEqual(
    view.links.map((link) => [link.from, link.to]),
    [['a.ts', 'b.ts'], ['b.ts', 'a.ts']],
  )

  // A cycle never removes an import: both rows stay complete.
  const imports = buildImports(graph)
  assert.equal(imports.scope, 'workspace')
  assert.deepEqual(
    imports.rows.map((row) => [row.path, row.imported, row.exported]),
    [
      ['a.ts', ['./b'], []],
      ['b.ts', ['./a'], []],
    ],
  )
})

test('dependencies: file scope keeps incident edges only and still reports the cycle', () => {
  resetGraphCache()
  const nodes: GraphNode[] = [
    node('f-a', 'module', 'a.ts'),
    node('f-b', 'module', 'b.ts'),
    node('f-c', 'module', 'c.ts'),
    node('f-d', 'module', 'd.ts'),
  ]
  const edges: GraphEdge[] = [
    edge('f-a', 'f-b'),
    edge('f-b', 'f-a'),
    edge('f-c', 'f-d'),
  ]
  const view = buildDependencies(query(nodes, edges, 'cycle-scope'), 'a.ts')
  assert.equal(view.scope, 'file')
  assert.equal(view.path, 'a.ts')
  assert.deepEqual(
    view.links.map((link) => [link.from, link.to, link.cyclic]),
    [
      ['a.ts', 'b.ts', true],
      ['b.ts', 'a.ts', true],
    ],
  )
  assert.deepEqual(view.cycles, [['a.ts', 'b.ts', 'a.ts']])
})

test('dependencies: A->B->C->A is one three-node cycle', () => {
  resetGraphCache()
  const nodes: GraphNode[] = [
    node('f-a', 'module', 'a.ts'),
    node('f-b', 'module', 'b.ts'),
    node('f-c', 'module', 'c.ts'),
  ]
  const edges: GraphEdge[] = [edge('f-a', 'f-b'), edge('f-b', 'f-c'), edge('f-c', 'f-a')]
  const view = buildDependencies(query(nodes, edges, 'cycle-three'))
  assert.deepEqual(view.cycles, [['a.ts', 'b.ts', 'c.ts', 'a.ts']])
  assert.ok(view.links.every((link) => link.cyclic))
})

test('dependencies: a self-loop is a length-1 cycle listed separately', () => {
  resetGraphCache()
  const nodes: GraphNode[] = [node('f-a', 'module', 'a.ts')]
  const edges: GraphEdge[] = [edge('f-a', 'f-a')]
  const view = buildDependencies(query(nodes, edges, 'cycle-self'))
  assert.deepEqual(view.cycles, [['a.ts', 'a.ts']])
  assert.deepEqual(view.links, [{ from: 'a.ts', to: 'a.ts', relation: 'depends', cyclic: true }])
})

test('dependencies: an acyclic graph reports no cycles and non-cyclic edges', () => {
  resetGraphCache()
  const nodes: GraphNode[] = [
    node('f-a', 'module', 'a.ts'),
    node('f-b', 'module', 'b.ts'),
  ]
  const edges: GraphEdge[] = [edge('f-a', 'f-b')]
  const view = buildDependencies(query(nodes, edges, 'cycle-none'))
  assert.deepEqual(view.cycles, [])
  assert.deepEqual(view.links, [{ from: 'a.ts', to: 'b.ts', relation: 'depends', cyclic: false }])
  assert.ok(view.cycles.length <= MAX_CYCLES)
})

test('dependencies: a scoped query for an unindexed file is NOT_FOUND', () => {
  assert.throws(
    () => buildDependencies(query([], [], 'deps-missing'), 'missing.ts'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'NOT_FOUND',
  )
})

/* ------------------------------------------------------------------------- *
 * Imports
 * ------------------------------------------------------------------------- */

test('imports group by path, sort rows and cap the entries per row', () => {
  resetGraphCache()
  const nodes: GraphNode[] = [
    node('f-a', 'module', 'a.ts'),
    node('f-b', 'module', 'b.ts'),
    node('f-c', 'module', 'c.ts'),
    node('a-i1', 'importation', 'a.ts', { name: './b', ordinal: 1 }),
    node('a-i2', 'importation', 'a.ts', { name: './c', ordinal: 2 }),
    node('a-e1', 'exportation', 'a.ts', { name: './c', ordinal: 3 }),
    node('c-i1', 'importation', 'c.ts', { name: 'node:fs', ordinal: 1 }),
  ]
  for (let index = 0; index < 260; index += 1) {
    nodes.push(node(`b-i${index}`, 'importation', 'b.ts', { name: `pkg-${index}`, ordinal: index }))
  }
  const rows = buildImports(query(nodes, [], 'imports-caps'))
  assert.equal(rows.scope, 'workspace')
  assert.deepEqual(rows.rows.map((row) => row.path), ['a.ts', 'b.ts', 'c.ts'])
  assert.deepEqual(rows.rows[0], { path: 'a.ts', imported: ['./b', './c'], exported: ['./c'] })
  assert.equal(rows.rows[1]?.imported.length, MAX_IMPORT_ENTRIES)
  assert.equal(rows.rows[1]?.imported[0], 'pkg-0')
  assert.equal(rows.rows[1]?.imported[MAX_IMPORT_ENTRIES - 1], `pkg-${MAX_IMPORT_ENTRIES - 1}`)
  assert.deepEqual(rows.rows[2], { path: 'c.ts', imported: ['node:fs'], exported: [] })
})

test('imports: file scope returns exactly one row, including an empty one', () => {
  const nodes: GraphNode[] = [
    node('f-a', 'module', 'a.ts'),
    node('f-b', 'module', 'b.ts'),
    node('a-i1', 'importation', 'a.ts', { name: './b', ordinal: 1 }),
  ]
  const graph = query(nodes, [], 'imports-scope')
  const withImports = buildImports(graph, 'a.ts')
  assert.deepEqual(withImports, {
    scope: 'file',
    path: 'a.ts',
    rows: [{ path: 'a.ts', imported: ['./b'], exported: [] }],
  })
  const empty = buildImports(graph, 'b.ts')
  assert.deepEqual(empty, { scope: 'file', path: 'b.ts', rows: [{ path: 'b.ts', imported: [], exported: [] }] })
  assert.throws(
    () => buildImports(graph, 'missing.ts'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'NOT_FOUND',
  )
})

/* ------------------------------------------------------------------------- *
 * Search
 * ------------------------------------------------------------------------- */

test('search is case-insensitive over name/label/path and empty for a blank query', () => {
  const nodes: GraphNode[] = [
    node('n1', 'heading', 'docs/guide.md', { name: 'Alpha Section', line: 4 }),
    node('n2', 'function', 'src/app.ts', { name: 'alphaFn', line: 9 }),
    node('n3', 'class', 'src/beta.ts', { name: 'Beta', label: 'ALPHA alias', line: 2 }),
    node('n4', 'module', 'src/gamma.ts', { name: 'gamma' }),
  ]
  const hits = searchGraph(nodes, 'AlPhA')
  assert.deepEqual(hits.map((hit) => hit.handle).sort(), ['n1', 'n2', 'n3'])
  const pathHit = searchGraph(nodes, 'GAMMA')
  assert.deepEqual(pathHit.map((hit) => hit.handle), ['n4'])
  assert.deepEqual(searchGraph(nodes, ''), [])
  assert.deepEqual(searchGraph(nodes, '   '), [])
})

test('search respects the requested limit and the hard cap', () => {
  const nodes: GraphNode[] = Array.from({ length: 250 }, (_unused, index) =>
    node(`n${index}`, 'function', `src/f${index}.ts`, { name: `match-${index}`, line: index + 1 }),
  )
  assert.equal(searchGraph(nodes, 'match', 2).length, 2)
  assert.equal(searchGraph(nodes, 'match', 999).length, MAX_SEARCH_LIMIT)
  assert.equal(searchGraph(nodes, 'match').length, 50)
  assert.equal(searchGraph(nodes, 'match', -5).length, 0)
})

/* ------------------------------------------------------------------------- *
 * Two-level cache
 * ------------------------------------------------------------------------- */

const CACHE_NODES: GraphNode[] = [
  node('f-a', 'module', 'a.ts'),
  node('f-b', 'module', 'b.ts'),
  node('a-i1', 'importation', 'a.ts', { name: './b', ordinal: 1 }),
]
const CACHE_EDGES: GraphEdge[] = [edge('f-a', 'f-b')]

test('cache: L1 resolves a file once per query, L2 is reused across queries', () => {
  resetGraphCache()
  const first = createGraphQuery({ version: 'cache-1', nodes: CACHE_NODES, edges: CACHE_EDGES })
  const facts = first.factsOf('a.ts')
  const afterFirst = graphCacheStats()
  assert.equal(afterFirst.misses, 1)
  assert.equal(afterFirst.hits, 0)

  // L1: the same query answers from its request map, not from L2.
  assert.equal(first.factsOf('a.ts'), facts)
  assert.equal(graphCacheStats().misses, 1)
  assert.equal(graphCacheStats().hits, 0)

  // L2: a second query of the same version reuses both resolved files.
  const second = createGraphQuery({ version: 'cache-1', nodes: CACHE_NODES, edges: CACHE_EDGES })
  buildImports(second)
  const afterSecond = graphCacheStats()
  assert.equal(afterSecond.misses, 2)
  assert.ok(afterSecond.hits >= 1, 'the second query must hit L2')
  assert.deepEqual(second.factsOf('a.ts').imports, ['./b'])
})

test('cache: the scope is part of the key, so file and workspace views never mix', () => {
  resetGraphCache()
  const workspaceView = createGraphQuery({ version: 'cache-scope', nodes: CACHE_NODES, edges: CACHE_EDGES })
  buildImports(workspaceView)
  assert.equal(graphCacheStats().misses, 2)

  const fileView = createGraphQuery({
    version: 'cache-scope',
    scope: 'file',
    nodes: CACHE_NODES,
    edges: CACHE_EDGES,
  })
  buildImports(fileView, 'a.ts')
  const stats = graphCacheStats()
  assert.equal(stats.misses, 3, 'a different scope must not hit the workspace entries')
  assert.equal(stats.hits, 0)
  assert.equal(stats.size, 3)
})

test('cache: a version bump clears L2 and recomputes facts', () => {
  resetGraphCache()
  const first = createGraphQuery({ version: 'version-a', nodes: CACHE_NODES, edges: CACHE_EDGES })
  buildImports(first)
  assert.equal(graphCacheStats().misses, 2)
  assert.equal(graphCacheStats().size, 2)

  const changedNodes: GraphNode[] = [
    ...CACHE_NODES,
    node('a-i2', 'importation', 'a.ts', { name: './c', ordinal: 2 }),
  ]
  const second = createGraphQuery({ version: 'version-b', nodes: changedNodes, edges: CACHE_EDGES })
  const view = buildImports(second)
  const stats = graphCacheStats()
  assert.equal(stats.version, 'version-b')
  assert.equal(stats.misses, 4, 'a new version must not reuse the previous cache')
  assert.equal(stats.hits, 0)
  assert.equal(stats.size, 2, 'the stale entries were dropped')
  assert.deepEqual(view.rows[0]?.imported, ['./b', './c'])
})

/* ------------------------------------------------------------------------- *
 * Preview classifier (the bounded read itself lives in index.ts)
 * ------------------------------------------------------------------------- */

test('preview classifies markdown/html/code/text/tex/office by extension', () => {
  assert.equal(previewKindOf('docs/a.md'), 'markdown')
  assert.equal(previewKindOf('docs/a.MDX'), 'markdown')
  assert.equal(previewKindOf('docs/a.html'), 'html')
  assert.equal(previewKindOf('docs/a.HTM'), 'html')
  assert.equal(previewKindOf('src/a.ts'), 'code')
  assert.equal(previewKindOf('config/app.yaml'), 'code')
  assert.equal(previewKindOf('config/app.toml'), 'code')
  assert.equal(previewKindOf('notes.txt'), 'text')
  assert.equal(previewKindOf('LICENSE'), 'text')
  assert.equal(previewKindOf('paper/main.tex'), 'tex')
  assert.equal(previewKindOf('paper/main.LTX'), 'tex')
  assert.equal(previewKindOf('paper/main.latex'), 'tex')
  assert.equal(previewKindOf('docs/report.docx'), 'docx')
  assert.equal(previewKindOf('docs/workbook.xlsx'), 'xlsx')
  assert.equal(previewKindOf('docs/deck.pptx'), 'pptx')
})

test('tex preview keeps raw text and re-applies the 64 KiB cap', () => {
  const content = '\\section{Intro}\n$x^2$\n'
  const preview = buildTextPreview('paper/main.tex', 'tex', content, false, content.length)
  assert.equal(preview.kind, 'tex')
  assert.equal(preview.content, content)
  assert.equal(preview.truncated, false)

  const oversized = buildTextPreview(
    'paper/huge.tex',
    'tex',
    'x'.repeat(MAX_PREVIEW_TEXT_BYTES + 1),
    false,
    MAX_PREVIEW_TEXT_BYTES + 1,
  )
  assert.equal(oversized.truncated, true)
  assert.ok(Buffer.byteLength(oversized.content, 'utf8') <= MAX_PREVIEW_TEXT_BYTES)
})

/* ------------------------------------------------------------------------- *
 * Preview payload builders (tex/docx/xlsx/pptx)
 *
 * Fixtures are tiny ZIP packages built in memory, reusing the raw-DEFLATE
 * builder pattern from `test/office.test.ts`; no file or process is involved.
 * ------------------------------------------------------------------------- */

interface ZipEntryInput {
  name: string
  data: string | Uint8Array
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, name)

    offset += local.length + name.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralChunks)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localChunks, centralDirectory, end])
}

const CONTENT_TYPES_DOCX =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>'

const DOCX_STYLES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
  '</w:styles>'

const DOCX_RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
  'Target="javascript:alert(1)" TargetMode="External"/>' +
  '</Relationships>'

const DOCX_DOCUMENT =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
  '<w:r><w:t>Quarterly Review</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>Safe body</w:t></w:r>' +
  '<w:hyperlink r:id="rId1"><w:r><w:t>click</w:t></w:r></w:hyperlink></w:p>' +
  '<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>' +
  '</w:body></w:document>'

function docxEntries(documentXml = DOCX_DOCUMENT): ZipEntryInput[] {
  return [
    { name: '[Content_Types].xml', data: CONTENT_TYPES_DOCX },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: DOCX_RELS },
    { name: 'word/styles.xml', data: DOCX_STYLES },
  ]
}

test('docx preview converts to HTML and strips scripts, event handlers and javascript: URLs', async () => {
  const preview = await buildDocxPreview('docs/report.docx', buildZip(docxEntries()))
  assert.equal(preview.path, 'docs/report.docx')
  assert.equal(preview.kind, 'docx')
  assert.equal(preview.truncated, false)
  assert.ok(preview.html.includes('Quarterly Review'))
  assert.ok(preview.html.includes('Safe body'))
  assert.ok(preview.html.includes('&lt;script&gt;'), 'the script text stays inert escaped text')
  assert.ok(!preview.html.includes('<script'))
  assert.ok(!preview.html.includes('<style'))
  assert.ok(!preview.html.toLowerCase().includes('javascript:'))
  assert.ok(!preview.html.includes('onerror'))
  assert.ok(preview.bytes > 0)
})

test('docx sanitizer rebuilds only allowlisted markup and drops unsafe attributes', () => {
  const result = sanitizePreviewHtml(
    '<p onclick="steal()">ok<script>alert(1)</script><style>p{color:red}</style>' +
      '<a href="javascript:alert(1)" onmouseover="x()">link</a><br>' +
      '<img src="x" onerror="x()"></p>',
  )
  assert.equal(result.truncated, false)
  assert.equal(result.html, '<p>ok<a>link</a><br></p>')
  assert.ok(!result.html.includes('javascript:'))
  assert.ok(!result.html.includes('onclick'))
  assert.ok(!result.html.includes('onmouseover'))
  assert.ok(!result.html.includes('<script'))
  assert.ok(!result.html.includes('<style'))
  assert.ok(!result.html.includes('<img'))
})

test('docx preview caps an oversized word/document.xml input and caps the HTML output', async () => {
  const oversized =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    `<w:p><w:r><w:t>${'A'.repeat(MAX_DOCX_DOCUMENT_BYTES + 1_024)}</w:t></w:r></w:p>` +
    '</w:body></w:document>'
  const inputCapped = await buildDocxPreview('docs/huge.docx', buildZip(docxEntries(oversized)))
  assert.equal(inputCapped.truncated, true)
  assert.equal(inputCapped.html, '')

  const outputCapped = sanitizePreviewHtml(`<p>${'b'.repeat(MAX_DOCX_HTML_BYTES + 4_096)}</p>`)
  assert.equal(outputCapped.truncated, true)
  assert.ok(Buffer.byteLength(outputCapped.html, 'utf8') <= MAX_DOCX_HTML_BYTES)
  assert.ok(outputCapped.html.startsWith('<p>'))
  assert.ok(outputCapped.html.endsWith('</p>'))
})

const CONTENT_TYPES_XLSX =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/xl/workbook.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '</Types>'

const XLSX_WORKBOOK =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'

const XLSX_WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
  'Target="worksheets/sheet1.xml"/></Relationships>'

const XLSX_SHARED_STRINGS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2">' +
  '<si><t>Name</t></si><si><t>Value</t></si></sst>'

function columnName(index: number): string {
  let name = ''
  let value = index + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function xlsxSheetXml(): string {
  const rows: string[] = [
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
    '<row r="2"><c r="A2"><v>42</v></c><c r="B2"><f>SUM(A2:A2)</f><v>42</v></c></row>',
  ]
  for (let row = 3; row <= MAX_XLSX_ROWS + 5; row += 1) {
    const cells: string[] = []
    for (let column = 0; column < MAX_XLSX_COLUMNS + 5; column += 1) {
      cells.push(`<c r="${columnName(column)}${row}"><v>${row * 100 + column}</v></c>`)
    }
    rows.push(`<row r="${row}">${cells.join('')}</row>`)
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  )
}

function xlsxEntries(): ZipEntryInput[] {
  return [
    { name: '[Content_Types].xml', data: CONTENT_TYPES_XLSX },
    { name: 'xl/workbook.xml', data: XLSX_WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', data: XLSX_WORKBOOK_RELS },
    { name: 'xl/sharedStrings.xml', data: XLSX_SHARED_STRINGS },
    { name: 'xl/worksheets/sheet1.xml', data: xlsxSheetXml() },
  ]
}

test('xlsx preview caps rows/columns, keeps string values and never emits formulas', () => {
  const preview = buildXlsxPreview('docs/workbook.xlsx', buildZip(xlsxEntries()))
  assert.equal(preview.path, 'docs/workbook.xlsx')
  assert.equal(preview.kind, 'xlsx')
  assert.equal(preview.truncated, true)
  assert.equal(preview.sheets.length, 1)
  assert.equal(preview.sheets[0]?.name, 'Data')

  const rows = preview.sheets[0]?.rows ?? []
  assert.equal(rows.length, MAX_XLSX_ROWS)
  assert.ok(rows.every((row) => row.length <= MAX_XLSX_COLUMNS))
  assert.ok(rows.every((row) => row.every((cell) => typeof cell === 'string')))
  assert.deepEqual(rows[0], ['Name', 'Value'])
  // A formula's cached value is a value; its `<f>` source is never returned.
  assert.deepEqual(rows[1], ['42', '42'])
  assert.equal(rows[MAX_XLSX_ROWS - 1]?.length, MAX_XLSX_COLUMNS)
  assert.ok(!JSON.stringify(preview.sheets).includes('SUM('))
})

const CONTENT_TYPES_PPTX =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/ppt/presentation.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
  '</Types>'

const PPTX_PRESENTATION =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>' +
  '</p:presentation>'

const PPTX_PRESENTATION_RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
  'Target="slides/slide1.xml"/>' +
  '<Relationship Id="rId2" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
  'Target="slides/slide2.xml"/></Relationships>'

function pptxTitleShape(title: string): string {
  return (
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`
  )
}

function pptxBodyShape(lines: readonly string[]): string {
  const paragraphs = lines
    .map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`)
    .join('')
  return (
    '<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  )
}

function pptxSlide(name: string, title: string, lines: readonly string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    `<p:cSld name="${name}"><p:spTree>${pptxTitleShape(title)}${pptxBodyShape(lines)}` +
    '</p:spTree></p:cSld></p:sld>'
  )
}

function pptxEntries(): ZipEntryInput[] {
  const longLines = Array.from(
    { length: MAX_PPTX_LINES + 5 },
    (_unused, index) => (index === 0 ? 'x'.repeat(MAX_PPTX_LINE_CHARS + 50) : `Point ${index + 1}`),
  )
  return [
    { name: '[Content_Types].xml', data: CONTENT_TYPES_PPTX },
    { name: 'ppt/presentation.xml', data: PPTX_PRESENTATION },
    { name: 'ppt/_rels/presentation.xml.rels', data: PPTX_PRESENTATION_RELS },
    { name: 'ppt/slides/slide1.xml', data: pptxSlide('Slide One', 'Overview', ['First point', 'Second point']) },
    { name: 'ppt/slides/slide2.xml', data: pptxSlide('Slide Two', 'Details', longLines) },
  ]
}

test('pptx preview keeps slide titles/lines and caps slides and line shapes', () => {
  const preview = buildPptxPreview('docs/deck.pptx', buildZip(pptxEntries()))
  assert.equal(preview.path, 'docs/deck.pptx')
  assert.equal(preview.kind, 'pptx')
  assert.deepEqual(preview.slides.map((slide) => slide.index), [1, 2])
  assert.deepEqual(preview.slides.map((slide) => slide.title), ['Overview', 'Details'])
  assert.deepEqual(preview.slides[0]?.lines, ['First point', 'Second point'])

  const capped = preview.slides[1]?.lines ?? []
  assert.equal(capped.length, MAX_PPTX_LINES)
  assert.ok(capped.every((line) => line.length <= MAX_PPTX_LINE_CHARS))
  assert.equal(capped[0]?.length, MAX_PPTX_LINE_CHARS)
  assert.equal(preview.truncated, true)
  assert.ok(preview.bytes > 0)
})

/* ------------------------------------------------------------------------- *
 * Intra-file symbol graph
 * ------------------------------------------------------------------------- */

/** A file -> class -> method fixture: containment in both stored directions. */
function intraFixture(version: string): { path: string; graph: GraphQuery; nodes: GraphNode[] } {
  const path = 'src/app.ts'
  const nodes: GraphNode[] = [
    node('f-app', 'module', path, { name: 'app.ts' }),
    node('c-app', 'class', path, { name: 'App', line: 2 }),
    node('m-run', 'method', path, { name: 'run', line: 3 }),
  ]
  const edges: GraphEdge[] = [
    edge('f-app', 'c-app', 'contains'),
    edge('c-app', 'f-app', 'part_of'),
    edge('c-app', 'm-run', 'contains'),
    edge('m-run', 'c-app', 'part_of'),
  ]
  return { path, graph: query(nodes, edges, version), nodes }
}

test('intra: file -> class -> method yields depths 0/1 and in-file contains edges', () => {
  const { path, graph } = intraFixture('intra-basic')
  const view = buildIntra(graph, path)

  assert.equal(view.path, path)
  assert.equal(view.family, 'project')
  assert.equal(view.truncated, false)
  assert.deepEqual(
    view.nodes.map((entry) => [entry.id, entry.kind, entry.name, entry.depth]),
    [
      ['c-app', 'class', 'App', 0],
      ['m-run', 'method', 'run', 1],
    ],
  )
  // The file node is depth scaffolding only: every emitted edge has both
  // endpoints in `nodes`, and directions follow the stored relation.
  assert.deepEqual(view.edges, [
    { from: 'c-app', to: 'm-run', relation: 'contains' },
    { from: 'm-run', to: 'c-app', relation: 'part_of' },
  ])
  const ids = new Set(view.nodes.map((entry) => entry.id))
  assert.ok(view.edges.every((entry) => ids.has(entry.from) && ids.has(entry.to)))
})

test('intra: cross-file edges and non-intra relations are excluded', () => {
  const path = 'src/a.ts'
  const nodes: GraphNode[] = [
    node('f-a', 'module', path),
    node('c-a', 'class', path, { name: 'A' }),
    node('m-a', 'method', path, { name: 'first' }),
    node('m2-a', 'method', path, { name: 'second' }),
    node('f-b', 'module', 'src/b.ts'),
    node('c-b', 'class', 'src/b.ts', { name: 'B' }),
  ]
  const edges: GraphEdge[] = [
    edge('f-a', 'c-a', 'contains'),
    edge('c-a', 'f-a', 'part_of'),
    edge('c-a', 'm-a', 'contains'),
    edge('m-a', 'c-a', 'part_of'),
    // In-file dependency: kept.
    edge('m-a', 'm2-a', 'depends'),
    // Crossing the file boundary: dropped, whichever direction/relation.
    edge('c-a', 'c-b', 'depends'),
    edge('m-a', 'f-b', 'depends'),
    edge('f-b', 'c-b', 'contains'),
    // A relation outside `contains | part_of | depends`: dropped.
    edge('m-a', 'm2-a', 'proves'),
  ]
  const view = buildIntra(query(nodes, edges, 'intra-cross'), path)
  assert.deepEqual(view.edges, [
    { from: 'c-a', to: 'm-a', relation: 'contains' },
    { from: 'm-a', to: 'c-a', relation: 'part_of' },
    { from: 'm-a', to: 'm2-a', relation: 'depends' },
  ])
  assert.ok(view.edges.every((entry) => entry.from !== 'c-b' && entry.to !== 'c-b' && entry.to !== 'f-b'))
  // A symbol with no containment path is top-level rather than omitted.
  assert.equal(view.nodes.find((entry) => entry.id === 'm2-a')?.depth, 0)
})

test('intra: depth follows the deepest containment path and clamps at 20', () => {
  const path = 'src/deep.ts'
  const nodes: GraphNode[] = [node('f-deep', 'module', path)]
  const edges: GraphEdge[] = []
  let parent = 'f-deep'
  for (let index = 0; index < MAX_INTRA_DEPTH + 5; index += 1) {
    const handle = `s${index}`
    nodes.push(node(handle, 'function', path, { name: handle, line: index + 2 }))
    // `contains` alone is enough: the reverse `part_of` normalises to the same edge.
    edges.push(edge(parent, handle, 'contains'))
    parent = handle
  }
  const view = buildIntra(query(nodes, edges, 'intra-depth'), path)
  const depthOf = new Map(view.nodes.map((entry) => [entry.id, entry.depth]))
  assert.equal(depthOf.get('s0'), 0)
  assert.equal(depthOf.get(`s${MAX_INTRA_DEPTH - 1}`), MAX_INTRA_DEPTH - 1)
  assert.equal(depthOf.get(`s${MAX_INTRA_DEPTH}`), MAX_INTRA_DEPTH)
  assert.equal(depthOf.get(`s${MAX_INTRA_DEPTH + 4}`), MAX_INTRA_DEPTH)
  assert.ok((depthOf.get(`s${MAX_INTRA_DEPTH + 4}`) ?? -1) <= MAX_INTRA_DEPTH)
})

test('intra: 500-node and 2,000-edge caps set truncated and keep output deterministic', () => {
  const path = 'src/caps.ts'
  const nodes: GraphNode[] = [node('f-caps', 'module', path)]
  const edges: GraphEdge[] = []
  const total = MAX_INTRA_EDGES + 10
  for (let index = 0; index < total; index += 1) {
    const handle = `s${index}`
    nodes.push(node(handle, 'function', path, { name: `fn${index}`, line: index + 2 }))
    // File containment is depth scaffolding (never emitted), so every symbol is
    // a direct child at depth 0.
    edges.push(edge('f-caps', handle, 'contains'))
    edges.push(edge(handle, `s${(index + 1) % total}`, 'depends'))
  }
  const view = buildIntra(query(nodes, edges, 'intra-caps'), path)
  assert.equal(view.nodes.length, MAX_INTRA_NODES)
  assert.equal(view.edges.length, MAX_INTRA_EDGES)
  assert.equal(view.truncated, true)
  assert.ok(view.nodes.every((entry) => entry.depth === 0))
  assert.deepEqual(view.edges[0], { from: 's0', to: 's1', relation: 'depends' })

  // Below both caps: no truncation flag.
  const small = buildIntra(query(intraFixture('intra-small').nodes, [], 'intra-small'), 'src/app.ts')
  assert.equal(small.truncated, false)
  assert.equal(small.nodes.length, 2)
})

test('intra: family follows the outline classifier', () => {
  const documentPath = 'docs/guide.md'
  const documentNodes: GraphNode[] = [
    node('d-guide', 'document', documentPath, { name: 'guide.md' }),
    node('h-guide', 'heading', documentPath, { name: 'Intro', line: 1 }),
  ]
  const document = buildIntra(query(documentNodes, [], 'intra-family-doc'), documentPath)
  assert.equal(document.family, 'document')
  assert.deepEqual(document.nodes.map((entry) => [entry.kind, entry.depth]), [['heading', 0]])

  const unknownPath = 'notes.zzz'
  const unknownNodes: GraphNode[] = [
    node('f-notes', 'file', unknownPath),
    node('x-notes', 'custom', unknownPath, { name: 'custom' }),
  ]
  const unknown = buildIntra(query(unknownNodes, [], 'intra-family-unknown'), unknownPath)
  assert.equal(unknown.family, 'unknown')
  assert.equal(unknown.nodes.length, 1)
})

test('dependencies: level=intra mirrors the intra edges and cycles on that subgraph', () => {
  const { path, graph } = intraFixture('intra-level')
  const intra = buildIntra(graph, path)
  const dependencies = buildDependencies(graph, path, 'intra')

  assert.equal(dependencies.scope, 'file')
  assert.equal(dependencies.path, path)
  assert.deepEqual(
    dependencies.links.map((link) => ({ from: link.from, to: link.to, relation: link.relation })),
    intra.edges,
  )
  // A containment pair is stored in both directions, so it is a directed
  // two-cycle on the intra subgraph.
  assert.deepEqual(dependencies.cycles, [['c-app', 'm-run', 'c-app']])
  assert.ok(dependencies.links.every((link) => link.cyclic))

  assert.throws(
    () => buildDependencies(graph, undefined, 'intra'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => buildDependencies(graph, path, 'symbol' as unknown as 'file'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'INVALID_ARGUMENT',
  )
})

test('intra rejects invalid paths with 400 and unindexed files with 404', () => {
  const { path, graph } = intraFixture('intra-errors')
  for (const invalid of ['', '   ', '/etc/passwd', 'C:\\Windows\\win.ini', '../secret.ts', 'src/../secret.ts']) {
    assert.throws(
      () => buildIntra(graph, invalid),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'INVALID_ARGUMENT',
      `expected ${JSON.stringify(invalid)} to be rejected`,
    )
  }
  assert.throws(
    () => buildIntra(graph, 'src/missing.ts'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'NOT_FOUND',
  )
  assert.equal(buildIntra(graph, './src/app.ts').path, path)
})

test('intra views are cached per version\\0intra\\0path', () => {
  resetGraphCache()
  const { path, graph } = intraFixture('intra-cache')
  const first = buildIntra(graph, path)
  assert.equal(graphCacheStats().misses, 1)
  assert.equal(graphCacheStats().hits, 0)
  assert.equal(graphCacheStats().size, 1)

  assert.deepEqual(buildIntra(graph, path), first)
  assert.equal(graphCacheStats().misses, 1)
  assert.equal(graphCacheStats().hits, 1)

  // A new version clears the entry; the same path is recomputed.
  const { graph: nextGraph } = intraFixture('intra-cache-2')
  buildIntra(nextGraph, path)
  const stats = graphCacheStats()
  assert.equal(stats.version, 'intra-cache-2')
  assert.equal(stats.misses, 2)
  assert.equal(stats.size, 1)
})

/* ------------------------------------------------------------------------- *
 * Agent roster and transcript fixtures
 * ------------------------------------------------------------------------- */

/** One durable session event fixture (the subset the projection reads). */
function agentEvent(
  type: string,
  time: number,
  data: unknown,
  seq?: number,
): AgentSessionEventLike {
  return { type, time, data, ...(seq === undefined ? {} : { seq }) }
}

/** One human user message fixture. */
function userEvent(text: string, time: number, seq?: number): AgentSessionEventLike {
  return agentEvent(
    'user/message',
    time,
    { content: [{ type: 'text', text }], source: { kind: 'user' } },
    seq,
  )
}

/** One assistant message fixture; the durable payload nests the message. */
function assistantEvent(text: string, time: number): AgentSessionEventLike {
  return agentEvent('assistant/message', time, {
    message: { content: [{ type: 'text', text }] },
  })
}

/** One system message fixture (0.2.x `system/message` surface). */
function systemEvent(text: string, time: number): AgentSessionEventLike {
  return agentEvent('system/message', time, {
    message: { content: [{ type: 'text', text }] },
  })
}

/** One tool-result fixture with a single text block. */
function toolEvent(text: string, time: number): AgentSessionEventLike {
  return agentEvent('tool/result', time, {
    message: {
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text }] }],
    },
  })
}

/** Minimal live-session stub: header, inherited cut and the 0.2.x event snapshot. */
function sessionStub(
  id: string,
  createdAt: number,
  events: readonly AgentSessionEventLike[] = [],
  inheritedEventCount = 0,
): {
  id: string
  header: { id: string; createdAt: number }
  inheritedEventCount: number
  snapshotEvents: () => readonly AgentSessionEventLike[]
} {
  return {
    id,
    header: { id, createdAt },
    inheritedEventCount,
    snapshotEvents: () => events,
  }
}

/** Minimal live-agent stub. */
function agentStub(id: string, status: 'running' | 'idle', session: unknown): Record<string, unknown> {
  return { id, status, session }
}

/* ------------------------------------------------------------------------- *
 * Agent roster and progress
 * ------------------------------------------------------------------------- */

test('agent roster: main first, then descendants, then other sessions; progress shape', () => {
  const records: AgentRosterInput[] = [
    { id: 'other', status: 'inactive' },
    {
      id: 'child',
      status: 'inactive',
      parentId: 'main',
      label: 'Child task',
      objective: 'Do the child work',
      completedAt: '2026-01-01T00:00:01.000Z',
    },
    { id: 'grand', status: 'running', parentId: 'child', turns: TURN_CEILING },
    { id: 'main', status: 'running', label: 'Main', objective: 'Parent task', turns: 0 },
  ]
  const summary = buildAgentRoster(records, 'main')

  assert.deepEqual(summary.agents.map((entry) => entry.id), ['main', 'child', 'grand', 'other'])
  assert.deepEqual(
    summary.agents.map((entry) => entry.progress),
    [
      { value: 5, estimated: true, basis: 'turns' },
      { value: 100, estimated: true, basis: 'completed' },
      { value: 95, estimated: true, basis: 'turns' },
      { value: 0, estimated: true, basis: 'unknown' },
    ],
  )
  assert.equal(summary.agents[0]?.label, 'Main')
  assert.equal(summary.agents[0]?.objective, 'Parent task')
  assert.equal(summary.agents[1]?.label, 'Child task')
  assert.equal(summary.agents[1]?.parentId, 'main')
  assert.equal(summary.agents[1]?.completedAt, '2026-01-01T00:00:01.000Z')
  assert.equal(summary.agents[2]?.parentId, 'child')
  // No host label: the deterministic short-id fallback is used, never invented text.
  assert.equal(summary.agents[3]?.label, 'other')
  assert.equal(summary.agents[3]?.objective, '')
  assert.deepEqual(summary.progress, { value: 50, estimated: true, running: 2, total: 4 })
})

test('agent roster: running progress is monotone, capped at 95, and unknown stays 0', () => {
  const values = [0, 1, 2, 6, 11, 12, 99].map((turns) =>
    agentProgressOf({ id: `r-${turns}`, status: 'running', turns }).value,
  )
  assert.deepEqual(values, [5, 12.5, 20, 50, 87.5, 95, 95])
  assert.ok(values.every((value) => value <= 95))
  for (let index = 1; index < values.length; index += 1) {
    assert.ok((values[index] as number) >= (values[index - 1] as number))
  }

  assert.deepEqual(
    agentProgressOf({ id: 'done', status: 'inactive', completedAt: '2026-01-01T00:00:00.000Z', turns: 0 }),
    { value: 100, estimated: true, basis: 'completed' },
  )
  assert.deepEqual(
    agentProgressOf({ id: 'idle', status: 'inactive', turns: 12 }),
    { value: 0, estimated: true, basis: 'unknown' },
  )
  assert.deepEqual(
    agentProgressOf({ id: 'fresh', status: 'running' }),
    { value: 0, estimated: true, basis: 'unknown' },
  )
})

test('agent roster: cap is applied after ordering and the summary counts the cap', () => {
  const records: AgentRosterInput[] = Array.from(
    { length: MAX_AGENT_ROSTER + 50 },
    (_, index) => ({ id: `agent-${index}`, status: 'inactive' }),
  )
  const summary = buildAgentRoster(records, 'agent-0')
  assert.equal(summary.agents.length, MAX_AGENT_ROSTER)
  assert.equal(summary.agents[0]?.id, 'agent-0')
  assert.equal(summary.agents.at(-1)?.id, `agent-${MAX_AGENT_ROSTER - 1}`)
  assert.equal(summary.progress.total, MAX_AGENT_ROSTER)
  assert.equal(summary.progress.running, 0)
})

test('agent roster: absent or throwing host services yield an empty roster, never a throw', async () => {
  const empty = await collectAgentRoster({})
  assert.deepEqual(empty.records, [])
  assert.equal(empty.mainSessionId, undefined)
  assert.deepEqual(buildAgentRoster(empty.records, empty.mainSessionId), {
    agents: [],
    progress: { value: 0, estimated: true, running: 0, total: 0 },
  })
  assert.equal(await resolveAgentSessionEvents({}, 'session-missing'), undefined)

  // The agent registry is the primary capability: sessions alone cannot supply
  // an authoritative main/status answer, so the documented absence response is
  // still an empty roster.
  const sessionsOnly = await collectAgentRoster({
    sessions: { list: () => [sessionStub('session-only', 1)] },
  })
  assert.deepEqual(sessionsOnly, { records: [] })

  const throwing: AgentServiceBundle = {
    agents: {
      list: () => { throw new Error('agent service is shutting down') },
      roots: () => { throw new Error('agent service is shutting down') },
    },
    sessions: { list: () => { throw new Error('session store is unavailable') } },
    subagents: { listDescendants: async () => { throw new Error('subagent runtime is unavailable') } },
  }
  assert.deepEqual(await collectAgentRoster(throwing), { records: [] })
})

test('agent roster collection: titles, objectives, turns, cold completion and parent ids', async () => {
  const mainEvents: AgentSessionEventLike[] = [
    userEvent('Parent task from the user', 1),
    agentEvent('turn/end', 2, { turn: 0, reason: { kind: 'completed' } }),
    agentEvent('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    agentEvent('turn/end', 4, { turn: 2, reason: { kind: 'completed' } }),
  ]
  const main = sessionStub('session-main', 1_000, mainEvents)
  const other = sessionStub('session-other', 2_000, [userEvent('Other prompt', 5)])
  const mainAgent = agentStub('session-main', 'running', main)
  const childEntry = {
    kind: 'child',
    id: 'session-child',
    parentId: 'session-main',
    depth: 1,
    mode: 'one-shot',
    label: 'Child label',
    activity: 'inactive',
    hasChildren: false,
  }
  const services: AgentServiceBundle = {
    agents: {
      list: () => [mainAgent],
      roots: () => [mainAgent],
    },
    sessions: {
      list: () => [main, other],
      get: (id: string) => (id === 'session-main' ? main : id === 'session-other' ? other : undefined),
    },
    subagents: { listDescendants: async () => [childEntry] },
    sessionQuery: {
      listSessions: async () => [
        { header: { id: 'session-main', createdAt: 1_000 } },
        { header: { id: 'session-child', createdAt: 1_500 } },
        { header: { id: 'session-other', createdAt: 2_000 } },
      ],
      listEvents: async (id: string) => id === 'session-child'
        ? [{ type: 'turn/start', time: 1_600 }, { type: 'turn/end', time: 1_700 }]
        : [],
    },
    sessionProjections: {
      snapshot: (session: unknown) => ({
        values: {
          title: session === main ? 'Main title' : 'Other title',
          sessionStats: { turns: session === main ? 3 : 1 },
        },
      }),
    },
    sessionProjectionCache: {
      cachedSnapshot: (header: { id: string }) => header.id === 'session-child'
        ? { values: { title: 'Cold child title' } }
        : undefined,
    },
  }
  const snapshot = await collectAgentRoster(services)
  assert.equal(snapshot.mainSessionId, 'session-main')
  const summary = buildAgentRoster(snapshot.records, snapshot.mainSessionId)
  assert.deepEqual(
    summary.agents.map((entry) => entry.id),
    ['session-main', 'session-child', 'session-other'],
  )

  const mainEntry = summary.agents[0]
  assert.equal(mainEntry?.label, 'Main title')
  assert.equal(mainEntry?.objective, 'Parent task from the user')
  assert.equal(mainEntry?.status, 'running')
  assert.equal(mainEntry?.startedAt, new Date(1_000).toISOString())
  assert.deepEqual(mainEntry?.progress, { value: 27.5, estimated: true, basis: 'turns' })

  const child = summary.agents[1]
  assert.equal(child?.label, 'Child label')
  assert.equal(child?.status, 'inactive')
  assert.equal(child?.parentId, 'session-main')
  assert.equal(child?.startedAt, new Date(1_500).toISOString())
  assert.equal(child?.completedAt, new Date(1_700).toISOString())
  assert.deepEqual(child?.progress, { value: 100, estimated: true, basis: 'completed' })

  const otherEntry = summary.agents[2]
  assert.equal(otherEntry?.label, 'Other title')
  assert.equal(otherEntry?.objective, 'Other prompt')
  assert.equal(otherEntry?.status, 'inactive')
  assert.deepEqual(otherEntry?.progress, { value: 0, estimated: true, basis: 'unknown' })
  assert.deepEqual(summary.progress, { value: 43, estimated: true, running: 1, total: 3 })
})

test('agent roster collection: a host goal objective wins over the first task message', async () => {
  const main = sessionStub('session-main', 1_000, [userEvent('Original prompt', 1)])
  const mainAgent = agentStub('session-main', 'running', main)
  const services: AgentServiceBundle = {
    agents: { list: () => [mainAgent], roots: () => [mainAgent] },
    sessions: { list: () => [main], get: () => main },
    goals: { get: () => ({ objective: 'Durable goal objective' }) },
    sessionProjections: { snapshot: () => ({ values: { title: 'Main', sessionStats: { turns: 0 } } }) },
  }
  const snapshot = await collectAgentRoster(services)
  assert.equal(snapshot.records[0]?.objective, 'Durable goal objective')
})

/* ------------------------------------------------------------------------- *
 * Agent transcript and route contract
 * ------------------------------------------------------------------------- */

test('agent transcript: newest 200 messages are kept and the count cap sets truncated', () => {
  const events = Array.from(
    { length: MAX_AGENT_MESSAGES + 5 },
    (_, index) => userEvent(`msg-${index}`, 1_000 + index),
  )
  const transcript = buildAgentTranscript('session-x', events)
  assert.equal(transcript.messages.length, MAX_AGENT_MESSAGES)
  assert.equal(transcript.messages[0]?.text, 'msg-5')
  assert.equal(transcript.messages.at(-1)?.text, `msg-${MAX_AGENT_MESSAGES + 4}`)
  assert.equal(transcript.messages[0]?.at, new Date(1_005).toISOString())
  assert.equal(transcript.truncated, true)
})

test('agent transcript: the 64 KiB total cap keeps the newest whole messages', () => {
  const text = 'x'.repeat(4_096)
  const events = Array.from({ length: 20 }, (_, index) => assistantEvent(text, 1_000 + index))
  const transcript = buildAgentTranscript('session-big', events)
  assert.equal(transcript.messages.length, MAX_AGENT_TRANSCRIPT_BYTES / 4_096)
  assert.equal(transcript.messages[0]?.text, text)
  assert.equal(transcript.messages.at(-1)?.text, text)
  assert.equal(transcript.truncated, true)
  const bytes = transcript.messages.reduce((sum, message) => sum + Buffer.byteLength(message.text, 'utf8'), 0)
  assert.equal(bytes, MAX_AGENT_TRANSCRIPT_BYTES)
})

test('agent transcript: one message is clipped at 8 KiB and marks truncated', () => {
  const transcript = buildAgentTranscript(
    'session-one',
    [assistantEvent('y'.repeat(MAX_AGENT_MESSAGE_BYTES + 100), 1)],
  )
  assert.equal(transcript.messages.length, 1)
  assert.equal(Buffer.byteLength(transcript.messages[0]?.text ?? '', 'utf8'), MAX_AGENT_MESSAGE_BYTES)
  assert.equal(transcript.truncated, true)
})

test('agent transcript: text only — tool arguments, images and binary blocks never surface', () => {
  const events: AgentSessionEventLike[] = [
    systemEvent('system note', 0),
    userEvent('hello', 1),
    assistantEvent('answer', 2),
    toolEvent('tool output', 3),
    agentEvent('tool/result', 4, {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'call-img',
          content: [{ type: 'image', attachment: { mimeType: 'image/png' } }],
        }],
      },
    }),
    agentEvent('tool/result', 5, {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'call-bin',
          content: [{ type: 'text', text: 'binary\u0000payload' }],
        }],
      },
    }),
    agentEvent('assistant/message', 6, {
      message: {
        content: [
          { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"secret.txt"}' },
          { type: 'text', text: 'kept text' },
        ],
      },
    }),
  ]
  const transcript = buildAgentTranscript('session-safe', events)
  assert.deepEqual(
    transcript.messages.map((message) => [message.role, message.text]),
    [
      ['system', 'system note'],
      ['user', 'hello'],
      ['assistant', 'answer'],
      ['tool', 'tool output'],
      ['assistant', 'kept text'],
    ],
  )
  assert.equal(transcript.truncated, false)
})

test('agent messages route: absent id 400, unknown id 404, no-store on every result', () => {
  const missing = agentMessagesRoute(undefined, undefined)
  assert.equal(missing.status, 400)
  assert.equal(missing.headers['cache-control'], 'no-store')
  assert.deepEqual(missing.body, {
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message: 'id is required' },
  })

  const blank = agentMessagesRoute('   ', [])
  assert.equal(blank.status, 400)
  assert.equal(blank.headers['cache-control'], 'no-store')

  const unknown = agentMessagesRoute('session-missing', undefined)
  assert.equal(unknown.status, 404)
  assert.equal(unknown.headers['cache-control'], 'no-store')
  assert.deepEqual(unknown.body, {
    ok: false,
    error: { code: 'NOT_FOUND', message: 'agent session-missing was not found' },
  })

  const known = agentMessagesRoute(' session-known ', [])
  assert.equal(known.status, 200)
  assert.equal(known.headers['cache-control'], 'no-store')
  assert.deepEqual(known.body, {
    ok: true,
    value: { id: 'session-known', messages: [], truncated: false },
  })
})

test('agent events: live store, session query, not-found mapping and absent services', async () => {
  const events = [userEvent('live', 1)]
  const live = sessionStub('session-live', 1, events)
  assert.deepEqual(
    await resolveAgentSessionEvents({ sessions: { get: (id: string) => (id === 'session-live' ? live : undefined) } }, 'session-live'),
    events,
  )
  assert.equal(await resolveAgentSessionEvents({}, 'session-live'), undefined)

  const coldServices: AgentServiceBundle = {
    sessionQuery: {
      readSession: async (id: string) => {
        if (id === 'session-cold') return { events }
        const error = new Error('session "missing" not found')
        ;(error as { code?: string }).code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      },
    },
  }
  assert.deepEqual(await resolveAgentSessionEvents(coldServices, 'session-cold'), events)
  assert.equal(await resolveAgentSessionEvents(coldServices, 'missing'), undefined)
})

test('agent events: a throwing non-not-found service error is propagated (route 500)', async () => {
  const services: AgentServiceBundle = {
    sessionQuery: {
      readSession: async () => { throw new Error('disk read failed') },
    },
  }
  await assert.rejects(
    () => resolveAgentSessionEvents(services, 'session-broken'),
    (error: unknown) => error instanceof Error && error.message === 'disk read failed',
  )
})

/* ------------------------------------------------------------------------- *
 * Bounded workspace indexing (the scan half of POST /graph/index)
 * ------------------------------------------------------------------------- */

interface StubWalk {
  io: WorkspaceIndexIo
  /** Directory paths the walker asked for, in visit order. */
  reads: string[]
  /** File paths the walker handed to the parser, in visit order. */
  indexed: string[]
}

/**
 * One virtual workspace for the scanner.
 *
 * `tree` maps a workspace-relative directory (`''` is the root) to its direct
 * entries; a path in `fail` makes `indexFile` throw exactly like an
 * unsupported/binary/missing file. No real file system is involved.
 */
function stubWalk(
  tree: Readonly<Record<string, readonly WorkspaceIndexEntry[]>>,
  options: { fail?: readonly string[]; nodesPerFile?: number } = {},
): StubWalk {
  const reads: string[] = []
  const indexed: string[] = []
  const io: WorkspaceIndexIo = {
    async readDirectory(path: string): Promise<readonly WorkspaceIndexEntry[]> {
      reads.push(path)
      return tree[path] ?? []
    },
    async indexFile(path: string): Promise<number> {
      if (options.fail?.includes(path) === true) throw new Error(`cannot parse ${path}`)
      indexed.push(path)
      return options.nodesPerFile ?? 2
    },
  }
  return { io, reads, indexed }
}

function walkFile(name: string): WorkspaceIndexEntry {
  return { name, directory: false }
}

function walkDirectory(name: string): WorkspaceIndexEntry {
  return { name, directory: true }
}

test('index scan: extension allowlist and skipped directories are explicit', () => {
  for (const path of [
    'src/app.ts',
    'src/app.tsx',
    'README.md',
    'SUMMARY.md',
    'paper.tex',
    'main.py',
    'lib.rs',
    'x.TS',
    'a/b/c.css',
    'book.csv',
  ]) {
    assert.equal(isIndexableWorkspaceFile(path), true, path)
  }
  for (const path of [
    'logo.png',
    'report.docx',
    'setup.exe',
    'archive.zip',
    'notes.json',
    'data.yaml',
    'page.html.bak',
    '.gitignore',
    'Makefile',
    'src/no-extension',
  ]) {
    assert.equal(isIndexableWorkspaceFile(path), false, path)
  }
  assert.deepEqual(
    [...INDEX_SKIP_DIRECTORIES].sort(),
    ['.git', '.tmp', 'dist', 'node_modules'],
  )
})

test('index scan: depth ≤ 8, breadth-first deterministic order, skipped count', async () => {
  const tree: Record<string, WorkspaceIndexEntry[]> = {
    '': [
      walkDirectory('src'),
      walkDirectory('d1'),
      walkFile('root.ts'),
      walkFile('notes.json'),
    ],
    src: [walkFile('app.tsx'), walkFile('logo.png')],
  }
  // d1 → d1/d2 → … → d1/…/d8; a file in each directory. Files at path depth 8
  // (d1/…/d7/f7.ts) are inside the bound; d1/…/d8 is never entered (its files
  // would be depth 9).
  let directoryPath = 'd1'
  for (let level = 1; level <= 8; level += 1) {
    tree[directoryPath] = level < 8
      ? [walkFile(`f${level}.ts`), walkDirectory(`d${level + 1}`)]
      : [walkFile('too-deep.ts')]
    directoryPath = level < 8 ? `${directoryPath}/d${level + 1}` : directoryPath
  }

  const { io, reads, indexed } = stubWalk(tree)
  const result = await indexWorkspaceFiles(io, { now: () => 0 })

  const expected = [
    'd1/f1.ts',
    'd1/d2/f2.ts',
    'd1/d2/d3/f3.ts',
    'd1/d2/d3/d4/f4.ts',
    'd1/d2/d3/d4/d5/f5.ts',
    'd1/d2/d3/d4/d5/d6/f6.ts',
    'd1/d2/d3/d4/d5/d6/d7/f7.ts',
    'root.ts',
    'src/app.tsx',
  ]
  assert.deepEqual([...indexed].sort(), [...expected].sort())
  assert.equal(indexed.includes('d1/d2/d3/d4/d5/d6/d7/d8/too-deep.ts'), false)
  assert.equal(reads.some((path) => path.endsWith('/d8')), false)
  assert.equal(reads.length, 9)
  // notes.json and logo.png were seen but are not parser extensions.
  assert.equal(result.indexed, 9)
  assert.equal(result.skipped, 2)
  assert.equal(result.nodes, 18)
  assert.equal(result.truncated, false)
  assert.equal(result.durationMs, 0)
})

test('index scan: dependency/VCS dirs are never entered and parse failures are skipped', async () => {
  const tree: Record<string, WorkspaceIndexEntry[]> = {
    '': [
      walkDirectory('node_modules'),
      walkDirectory('.git'),
      walkDirectory('dist'),
      walkDirectory('.tmp'),
      walkDirectory('src'),
      walkFile('binary.png'),
      walkFile('README.md'),
      walkFile('bad.ts'),
      walkFile('style.css'),
    ],
    node_modules: [walkFile('dep.ts')],
    '.git': [walkFile('config.ts')],
    dist: [walkFile('bundle.js')],
    '.tmp': [walkFile('cache.md')],
    src: [walkFile('ok.ts'), walkFile('logo.png')],
  }

  const { io, reads, indexed } = stubWalk(tree, { fail: ['bad.ts'], nodesPerFile: 3 })
  const result = await indexWorkspaceFiles(io, { now: () => 0 })

  assert.deepEqual([...reads].sort(), ['', 'src'])
  for (const skipped of ['node_modules', '.git', 'dist', '.tmp']) {
    assert.equal(reads.includes(skipped), false, skipped)
  }
  assert.deepEqual([...indexed].sort(), ['README.md', 'src/ok.ts', 'style.css'])
  // binary.png, bad.ts (parse failure) and src/logo.png are skipped files.
  assert.equal(result.indexed, 3)
  assert.equal(result.skipped, 3)
  assert.equal(result.nodes, 9)
})

test('index scan: the 200-file cap truncates, exactly 200 files does not', async () => {
  const capped = Array.from(
    { length: MAX_INDEX_FILES + 5 },
    (_unused, index) => walkFile(`f${String(index).padStart(3, '0')}.ts`),
  )
  const cappedWalk = stubWalk({ '': capped })
  const cappedResult = await indexWorkspaceFiles(cappedWalk.io, { now: () => 0 })
  assert.equal(cappedResult.indexed, MAX_INDEX_FILES)
  assert.equal(cappedResult.truncated, true)
  assert.equal(cappedWalk.indexed.length, MAX_INDEX_FILES)
  assert.equal(cappedWalk.indexed[0], 'f000.ts')
  assert.equal(cappedWalk.indexed[MAX_INDEX_FILES - 1], 'f199.ts')

  const exact = Array.from(
    { length: MAX_INDEX_FILES },
    (_unused, index) => walkFile(`f${String(index).padStart(3, '0')}.ts`),
  )
  const exactWalk = stubWalk({ '': exact })
  const exactResult = await indexWorkspaceFiles(exactWalk.io, { now: () => 0 })
  assert.equal(exactResult.indexed, MAX_INDEX_FILES)
  assert.equal(exactResult.truncated, false)
})

test('index scan: the wall-clock budget stops before the next file', async () => {
  let clock = 0
  const { io, reads, indexed } = stubWalk({ '': [walkFile('a.ts')] })
  const result = await indexWorkspaceFiles(io, {
    now: () => {
      const current = clock
      clock += 6_000
      return current
    },
  })

  // Started at 0, the loop starts at 6 s (allowed), the file check at 12 s
  // truncates before parsing.
  assert.equal(result.indexed, 0)
  assert.equal(result.truncated, true)
  assert.deepEqual(indexed, [])
  assert.deepEqual(reads, [''])
  assert.ok(result.durationMs >= 10_000)
})

test('index scan: an unreadable directory is skipped, not fatal', async () => {
  const io: WorkspaceIndexIo = {
    async readDirectory(path: string): Promise<readonly WorkspaceIndexEntry[]> {
      if (path === 'broken') throw new Error('EACCES')
      return path === '' ? [walkDirectory('broken'), walkFile('ok.ts')] : []
    },
    async indexFile(): Promise<number> {
      return 1
    },
  }
  const result = await indexWorkspaceFiles(io, { now: () => 0 })
  assert.equal(result.indexed, 1)
  assert.equal(result.skipped, 0)
  assert.equal(result.truncated, false)
})

test('workspace index gate: a concurrent run answers BUSY and always releases', async () => {
  const gate = new WorkspaceIndexGate()
  let release = (): void => {}
  const blocker = new Promise<void>((resolve) => {
    release = resolve
  })

  const first = gate.run(async () => {
    await blocker
    return 'first'
  })
  assert.equal(gate.isBusy(), true)
  assert.deepEqual(await gate.run(async () => 'second'), { ok: false, busy: true })

  release()
  assert.deepEqual(await first, { ok: true, value: 'first' })
  assert.equal(gate.isBusy(), false)

  assert.deepEqual(await gate.run(async () => 'third'), { ok: true, value: 'third' })
  await assert.rejects(
    () => gate.run(async () => { throw new Error('index failed') }),
    /index failed/,
  )
  assert.equal(gate.isBusy(), false)
})

test('index scan default budget constants match the documented bounds', () => {
  assert.equal(MAX_INDEX_DEPTH, 8)
  assert.equal(MAX_INDEX_FILES, 200)
})

/* ------------------------------------------------------------------------- *
 * Request-scoped workspace root (the async `/graph/*` resolver)
 *
 * The resolver is host-side (`src/host/tools.ts`) but pure enough for plain
 * Node: every source is a stub, the filesystem is a temporary directory, and
 * the `workingDirectory`/`agents`/`sessionQuery` surfaces are read
 * structurally, exactly as the real Cordis context exposes them.
 * ------------------------------------------------------------------------- */

/** One temporary directory removed when its test finishes. */
function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'coordination-root-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  return directory
}

/** One temporary regular file (a stat-able non-directory candidate). */
function temporaryFile(t: TestContext): string {
  const file = join(temporaryDirectory(t), 'candidate.txt')
  writeFileSync(file, 'not a directory\n')
  return file
}

/** A Cordis-context stub: `ctx.get(name)` returns the injected record. */
function contextStub(services: Readonly<Record<string, unknown>>): unknown {
  return { get: (name: string): unknown => services[name] }
}

test('workspace root resolver: the explicit root wins and must be an absolute directory', async (t) => {
  const explicit = temporaryDirectory(t)
  const serviceRoot = temporaryDirectory(t)
  const service: ToolWorkspaceRootService = { workspaceRoot: serviceRoot }

  // Explicit is trimmed to an absolute, normalised path and wins over every
  // other source.
  assert.equal(
    await resolveToolWorkspaceRootForRequest(service, {}, { root: ` ${explicit} ` }),
    resolve(explicit),
  )
  // A lexical dot segment is normalised away before the directory check.
  assert.equal(
    await resolveToolWorkspaceRootForRequest(service, {}, { root: `${explicit}${sep}.` }),
    resolve(explicit),
  )

  await assert.rejects(
    () => resolveToolWorkspaceRootForRequest(service, {}, { root: 'relative/path' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
  )
  await assert.rejects(
    () => resolveToolWorkspaceRootForRequest(service, {}, { root: temporaryFile(t) }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
  )
  // An absent parameter is not an invalid parameter.
  assert.equal(await resolveToolWorkspaceRootForRequest(service), resolve(serviceRoot))
})

test('workspace root resolver: service > host > sandboxPolicy > ensure > observation > cwd', async (t) => {
  const serviceRoot = temporaryDirectory(t)
  const hostRoot = temporaryDirectory(t)
  const policyRoot = temporaryDirectory(t)
  const ensuredRoot = temporaryDirectory(t)
  const observedRoot = temporaryDirectory(t)
  const session = { header: { cwd: policyRoot } }
  const agent = { id: 'root-session', session }

  // 1. service.workspaceRoot beats host.workspaceRoot.
  assert.equal(
    await resolveToolWorkspaceRootForRequest({
      workspaceRoot: serviceRoot,
      host: { workspaceRoot: hostRoot },
    }),
    resolve(serviceRoot),
  )

  // 2. host.workspaceRoot beats the sandbox policy.
  assert.equal(
    await resolveToolWorkspaceRootForRequest({
      host: {
        workspaceRoot: hostRoot,
        sandboxPolicy: { resolve: () => ({ workspaceRoot: policyRoot }) },
      },
    }),
    resolve(hostRoot),
  )

  // 3. The sandbox policy receives the active session and beats ensure.
  let seenSession: unknown
  const policyService: ToolWorkspaceRootService = {
    host: {
      sandboxPolicy: {
        resolve: (request?: { session?: unknown }) => {
          seenSession = request?.session
          return { workspaceRoot: policyRoot }
        },
      },
    },
  }
  const fullContext = contextStub({
    agents: { roots: () => [agent] },
    workingDirectory: { ensure: async () => ensuredRoot },
  })
  assert.equal(
    await resolveToolWorkspaceRootForRequest(policyService, {}, { context: fullContext }),
    resolve(policyRoot),
  )
  assert.equal(seenSession, session)

  // 4. A throwing/failed policy falls through to workingDirectory.ensure.
  const failingPolicy: ToolWorkspaceRootService = {
    host: { sandboxPolicy: { resolve: () => { throw new Error('policy not ready') } } },
  }
  assert.equal(
    await resolveToolWorkspaceRootForRequest(failingPolicy, {}, { context: fullContext }),
    resolve(ensuredRoot),
  )

  // 5. ensure wins over the recorded session observation.
  assert.equal(
    await resolveToolWorkspaceRootForRequest({}, {}, {
      context: contextStub({
        agents: { roots: () => [{ id: 'root-session', session: { ...session, workingDirectory: observedRoot } }] },
        workingDirectory: { ensure: async () => ensuredRoot },
      }),
    }),
    resolve(ensuredRoot),
  )

  // 6. A failing/missing ensure falls back to the recorded observation.
  assert.equal(
    await resolveToolWorkspaceRootForRequest({}, {}, {
      context: contextStub({
        agents: { roots: () => [{ id: 'root-session', session: { workingDirectory: observedRoot } }] },
        workingDirectory: { ensure: async () => { throw new Error('directory disappeared') } },
      }),
    }),
    resolve(observedRoot),
  )

  // 7. A `null` observation is not a root: the final fallback is process.cwd().
  assert.equal(
    await resolveToolWorkspaceRootForRequest({}, {}, {
      context: contextStub({
        agents: { roots: () => [{ id: 'root-session', session: { workingDirectory: null } }] },
      }),
    }),
    resolve(process.cwd()),
  )
})

test('workspace root resolver: a non-directory candidate is skipped', async (t) => {
  const file = temporaryFile(t)
  const good = temporaryDirectory(t)

  // A declared-but-invalid service root does not shadow a valid host root.
  assert.equal(
    await resolveToolWorkspaceRootForRequest({ workspaceRoot: file, host: { workspaceRoot: good } }),
    resolve(good),
  )

  // A file returned by workingDirectory.ensure is skipped for the observation.
  assert.equal(
    await resolveToolWorkspaceRootForRequest({}, {}, {
      context: contextStub({
        agents: { roots: () => [{ id: 'root-session', session: { workingDirectory: good } }] },
        workingDirectory: { ensure: async () => file },
      }),
    }),
    resolve(good),
  )
})

test('workspace root resolver: reads the session observation structurally', async (t) => {
  const observedRoot = temporaryDirectory(t)
  let disposed = false
  let observedId = ''
  const lease = {
    projections: { values: { workingDirectory: observedRoot } },
    dispose: () => { disposed = true },
  }
  const context = contextStub({
    agents: { roots: () => [{ id: 'session-1', session: {} }] },
    sessionQuery: {
      observeSession: async (id: string) => {
        observedId = id
        return lease
      },
    },
    workingDirectory: { ensure: async () => { throw new Error('cold session') } },
  })

  assert.equal(await resolveToolWorkspaceRootForRequest({}, {}, { context }), resolve(observedRoot))
  assert.equal(observedId, 'session-1')
  assert.equal(disposed, true)
})

test('workspace root resolver: caches per request and awaits the async ensure path', async (t) => {
  const root = temporaryDirectory(t)
  let calls = 0
  const context = contextStub({
    agents: { roots: () => [{ id: 'root-session', session: {} }] },
    workingDirectory: {
      ensure: async () => {
        calls += 1
        return root
      },
    },
  })

  const resolver = new ToolWorkspaceRootResolver({}, {}, { context })
  const first = resolver.resolve()
  assert.ok(first instanceof Promise)
  assert.equal(await first, resolve(root))
  // The second call shares the request-scoped answer: no second filesystem or
  // service read.
  assert.equal(await resolver.resolve(), resolve(root))
  assert.equal(calls, 1)
})

test('index report: carries the resolved root and flags a zero-file scan', async () => {
  const empty = await indexWorkspaceFiles(stubWalk({}).io, { now: () => 0 })
  const emptyReport = workspaceIndexReport(empty, 'C:\\workspace')
  assert.equal(emptyReport.root, 'C:\\workspace')
  assert.equal(emptyReport.indexed, 0)
  assert.equal(emptyReport.diagnostics?.length, 1)
  assert.equal(emptyReport.diagnostics?.[0]?.code, 'no-workspace-files')
  assert.equal(emptyReport.diagnostics?.[0]?.root, 'C:\\workspace')
  assert.equal(typeof emptyReport.diagnostics?.[0]?.message, 'string')

  // The desktop symptom: a wrong root that sees files but indexes none still
  // carries the diagnostic (the skipped count is not a successful scan).
  const skippedOnly = await indexWorkspaceFiles(
    stubWalk({ '': [walkFile('logo.png'), walkFile('notes.json')] }).io,
    { now: () => 0 },
  )
  const skippedReport = workspaceIndexReport(skippedOnly, 'C:\\wrong-root')
  assert.equal(skippedReport.indexed, 0)
  assert.equal(skippedReport.skipped, 2)
  assert.equal(skippedReport.diagnostics?.[0]?.code, 'no-workspace-files')

  // A productive scan reports the root but no diagnostic.
  const productive = await indexWorkspaceFiles(
    stubWalk({ '': [walkFile('src/app.ts'), walkFile('logo.png')] }).io,
    { now: () => 0 },
  )
  const productiveReport = workspaceIndexReport(productive, 'C:\\workspace')
  assert.equal(productiveReport.indexed, 1)
  assert.equal(productiveReport.root, 'C:\\workspace')
  assert.equal(productiveReport.diagnostics, undefined)
})
