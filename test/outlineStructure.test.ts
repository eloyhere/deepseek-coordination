import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildOutline,
  createGraphQuery,
  MAX_INTRA_DEPTH,
  type GraphEdge,
  type GraphNode,
} from '../src/host/graphView.js'

function node(handle: string, kind: string, path: string, line: number): GraphNode {
  return { handle, kind, path, line, name: handle }
}

function edge(from: string, to: string, relation: GraphEdge['relation'] = 'contains'): GraphEdge {
  return { from, to, relation }
}

function outline(nodes: GraphNode[], edges: GraphEdge[], path: string) {
  const query = createGraphQuery({ version: `outline-${path}`, nodes, edges })
  const result = buildOutline(query, path)
  assert.equal(result.scope, 'file')
  return result.nodes
}

test('Markdown outline derives H1/H2/H3 nesting from heading parents', () => {
  const path = 'docs/guide.md'
  const nodes = [
    node('doc', 'document', path, 1),
    node('h1', 'heading', path, 2),
    node('h2', 'heading', path, 5),
    node('h3', 'heading', path, 8),
    node('h2-next', 'heading', path, 12),
  ]
  const edges = [
    edge('doc', 'h1'),
    edge('doc', 'h2'),
    edge('doc', 'h3'),
    edge('doc', 'h2-next'),
    edge('h1', 'h2'),
    edge('h2', 'h3'),
    edge('h1', 'h2-next'),
  ]
  const result = outline(nodes, edges, path)
  assert.deepEqual(result.map(({ handle, depth, line }) => [handle, depth, line]), [
    ['doc', 0, 1],
    ['h1', 1, 2],
    ['h2', 2, 5],
    ['h3', 3, 8],
    ['h2-next', 2, 12],
  ])
})

test('article outlines retain nested Markdown headings without duplicate H1 chapters', () => {
  const path = 'README.md'
  const nodes = [
    node('article', 'article', path, 1),
    { ...node('h1', 'heading', path, 1), name: 'Title' },
    { ...node('chapter', 'chapter', path, 1), name: 'Title' },
    node('h2', 'heading', path, 15),
    { ...node('h2-stale', 'heading', path, 15), name: 'h2' },
    node('h3', 'heading', path, 20),
    node('h2-next', 'heading', path, 29),
  ]
  const edges = [edge('article', 'h1'), edge('h1', 'h2'), edge('h2', 'h3'), edge('h1', 'h2-next')]
  const result = outline(nodes, edges, path)
  assert.deepEqual(result.map(({ handle, depth }) => [handle, depth]), [
    ['article', 0], ['h1', 1], ['h2', 2], ['h3', 3], ['h2-next', 2],
  ])
})

test('code outline uses module/class/method containment, not kind ordinals', () => {
  const path = 'src/app.ts'
  const nodes = [
    node('module', 'module', path, 1),
    node('class', 'class', path, 3),
    node('method', 'method', path, 6),
    node('function', 'function', path, 12),
  ]
  const edges = [
    edge('module', 'class'),
    edge('class', 'method'),
    edge('module', 'function'),
    // Reverse-form edges are normalized to the same parent-child relation.
    edge('method', 'class', 'part_of'),
  ]
  const result = outline(nodes, edges, path)
  assert.deepEqual(result.map(({ handle, depth, line }) => [handle, depth, line]), [
    ['module', 0, 1],
    ['class', 1, 3],
    ['method', 2, 6],
    ['function', 1, 12],
  ])
})

test('code outline expands interfaces and classes only where edges prove children', () => {
  const path = 'src/contracts.ts'
  const nodes = [
    node('module', 'module', path, 1),
    node('service', 'interface', path, 2),
    node('run', 'method', path, 3),
    node('title', 'property', path, 4),
    node('worker', 'class', path, 6),
    node('execute', 'method', path, 7),
    node('empty', 'interface', path, 10),
    node('free', 'function', path, 12),
  ]
  const edges = [edge('module', 'service'), edge('service', 'run'), edge('service', 'title'), edge('module', 'worker'),
    edge('worker', 'execute'), edge('module', 'empty'), edge('module', 'free')]
  assert.deepEqual(outline(nodes, edges, path).map(({ handle, parent, depth }) => [handle, parent, depth]), [
    ['module', undefined, 0], ['service', 'module', 1], ['run', 'service', 2],
    ['title', 'service', 2], ['worker', 'module', 1], ['execute', 'worker', 2],
    ['empty', 'module', 1], ['free', 'module', 1],
  ])
})

test('current file membership excludes historical code nodes without collapsing same-named declarations', () => {
  const path = 'src/versions.ts'
  const nodes = [
    node('module', 'module', path, 1),
    { ...node('old', 'class', path, 3), name: 'Worker' },
    { ...node('first', 'class', path, 5), name: 'Worker' },
    node('run', 'method', path, 6),
    { ...node('second', 'class', path, 10), name: 'Worker' },
  ]
  const edges = [edge('module', 'first'), edge('first', 'run'), edge('module', 'second')]
  assert.deepEqual(outline(nodes, edges, path).map(node => node.handle), ['module', 'first', 'run', 'second'])
})

test('code declarations without parent evidence stay siblings despite kind order', () => {
  const path = 'src/unlinked.ts'
  assert.deepEqual(outline([
    node('module', 'module', path, 1),
    node('class', 'class', path, 2),
    node('interface', 'interface', path, 3),
    node('method', 'method', path, 4),
  ], [], path).map(({ handle, parent, depth }) => [handle, parent, depth]), [
    ['module', undefined, 0], ['class', undefined, 1],
    ['interface', undefined, 1], ['method', undefined, 1],
  ])
})

test('TeX outline gives repeated section kinds their explicit structural levels', () => {
  const path = 'paper/main.tex'
  const nodes = [
    node('document', 'document', path, 1),
    node('part', 'part', path, 2),
    node('chapter', 'chapter', path, 4),
    node('section', 'section', path, 7),
    node('subsection', 'section', path, 9),
    node('subsubsection', 'section', path, 11),
  ]
  const edges = [
    edge('document', 'part'),
    edge('part', 'chapter'),
    edge('chapter', 'section'),
    edge('section', 'subsection'),
    edge('subsection', 'subsubsection'),
  ]
  const result = outline(nodes, edges, path)
  assert.deepEqual(result.map(({ handle, depth, line }) => [handle, depth, line]), [
    ['document', 0, 1],
    ['part', 1, 2],
    ['chapter', 2, 4],
    ['section', 3, 7],
    ['subsection', 4, 9],
    ['subsubsection', 5, 11],
  ])
})

test('outline uses kind-order fallback without parent edges and bounds cyclic depths', () => {
  const fallbackPath = 'docs/legacy.md'
  const fallback = outline([
    node('doc', 'document', fallbackPath, 1),
    node('heading', 'heading', fallbackPath, 2),
  ], [], fallbackPath)
  assert.deepEqual(fallback.map(({ depth }) => depth), [0, 1])

  const cyclePath = 'src/cycle.ts'
  const cycleNodes = [node('module', 'module', cyclePath, 1)]
  for (let index = 0; index < MAX_INTRA_DEPTH + 6; index += 1) {
    cycleNodes.push(node(`method-${index}`, 'method', cyclePath, index + 2))
  }
  const cycleEdges: GraphEdge[] = []
  for (let index = 0; index < MAX_INTRA_DEPTH + 6; index += 1) {
    cycleEdges.push(edge(index === 0 ? 'module' : `method-${index - 1}`, `method-${index}`))
  }
  // A malformed back edge must not create unbounded recursion/depth.
  cycleEdges.push(edge(`method-${MAX_INTRA_DEPTH + 5}`, 'method-0'))
  const cyclic = outline(cycleNodes, cycleEdges, cyclePath)
  assert.equal(cyclic.length, cycleNodes.length)
  assert.ok(cyclic.every(({ depth }) => Number.isInteger(depth) && depth >= 0 && depth <= MAX_INTRA_DEPTH))
})
