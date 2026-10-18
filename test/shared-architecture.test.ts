/**
 * Architecture guard for the shared layer.
 *
 * These tests read the source text instead of importing every module: the point
 * is to pin the public export surface and the dependency direction, which a
 * behavioural test cannot see. They catch the exact regressions this refactor
 * removed: a second LRU core exported from `hash.ts`, `lru.ts` importing that
 * core, duplicate node implementations, and accidental re-exports.
 *
 * The shared import graph is built from all local `./x.js` imports, including
 * type-only imports, and reported through `t.diagnostic` so an audit can see the
 * same graph the assertion checks for cycles.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

interface ImportReference {
  /** Importing file, for example `lru.ts`. */
  readonly file: string
  /** Raw specifier, for example `./hash.js`. */
  readonly specifier: string
  /** Imported binding names (`default` and `*` included when present). */
  readonly names: string[]
  /** True for `import type` / `export type`. */
  readonly typeOnly: boolean
  /** True when the statement is `export ... from`, i.e. a re-export. */
  readonly reExport: boolean
}

interface SharedSource {
  readonly file: string
  readonly text: string
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

/** Walk up from the test bundle (`.tmp/test-build`) to the repository root. */
function findRepositoryRoot(start: string): string {
  let current = start
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'src', 'shared', 'hash.ts'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`cannot locate the repository root from ${start}`)
}

const repositoryRoot = findRepositoryRoot(moduleDirectory)
const sourceDirectory = join(repositoryRoot, 'src')
const sharedDirectory = join(sourceDirectory, 'shared')
const testDirectory = join(repositoryRoot, 'test')

const sharedSources: SharedSource[] = readdirSync(sharedDirectory)
  .filter((name) => name.endsWith('.ts'))
  .sort()
  .map((file) => ({ file, text: readFileSync(join(sharedDirectory, file), 'utf8') }))
const sourceByFile = new Map(sharedSources.map((source) => [source.file, source.text]))

/** Recursively list `.ts` files under a directory. */
function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(fullPath))
    else if (entry.name.endsWith('.ts')) files.push(fullPath)
  }
  return files.sort()
}

/** Split an import clause into binding names, dropping `as` aliases and `type`. */
function parseBindingNames(clause: string): string[] {
  const trimmed = clause.trim()
  if (trimmed === '') return []
  const names: string[] = []
  const braceStart = trimmed.indexOf('{')
  const head = braceStart >= 0 ? trimmed.slice(0, braceStart) : trimmed
  const leading = head.replace(/,\s*$/, '').trim()
  if (leading !== '') names.push(leading.split(',')[0].trim().replace(/^type\s+/, ''))
  if (braceStart >= 0) {
    const braceEnd = trimmed.lastIndexOf('}')
    const body = braceEnd > braceStart ? trimmed.slice(braceStart + 1, braceEnd) : ''
    for (const part of body.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (name !== '') names.push(name)
    }
  }
  if (trimmed.startsWith('*')) return ['*']
  return names
}

/** Parse every local import/re-export statement in one source file. */
function parseImports(file: string, text: string): ImportReference[] {
  const pattern =
    /^[ \t]*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]/gm
  const references: ImportReference[] = []
  for (const match of text.matchAll(pattern)) {
    const kind = match[1]
    const typeOnly = match[2] !== undefined
    const clause = match[3]
    const specifier = match[4]
    references.push({
      file,
      specifier,
      names: parseBindingNames(clause),
      typeOnly,
      reExport: kind === 'export',
    })
  }
  return references
}

/** Resolve a relative `./x.js` specifier to a shared `x.ts` file name. */
function resolveSharedTarget(specifier: string): string | undefined {
  const target = specifier.replace(/^\.\//, '').replace(/\.js$/, '.ts')
  return sourceByFile.has(target) ? target : undefined
}

/** Build the shared import graph (type-only edges included). */
function buildImportGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>()
  for (const source of sharedSources) {
    const targets = new Set<string>()
    for (const reference of parseImports(source.file, source.text)) {
      const target = resolveSharedTarget(reference.specifier)
      if (target !== undefined) targets.add(target)
    }
    graph.set(source.file, targets)
  }
  return graph
}

/** Report every cycle reachable in a directed graph as a closed node path. */
function findCycles(graph: Map<string, Set<string>>): string[][] {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const cycles: string[][] = []
  const visit = (node: string): void => {
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      const nextState = state.get(next)
      if (nextState === 'visiting') {
        const start = stack.indexOf(next)
        cycles.push([...stack.slice(start), next])
      } else if (nextState === undefined) {
        visit(next)
      }
    }
    stack.pop()
    state.set(node, 'done')
  }
  for (const node of [...graph.keys()].sort()) {
    if (!state.has(node)) visit(node)
  }
  return cycles
}

/** Export class names in declaration order. */
function exportedClasses(text: string): string[] {
  return [...text.matchAll(/export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)].map(
    (match) => match[1],
  )
}

/** Export function names in declaration order. */
function exportedFunctions(text: string): string[] {
  return [...text.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1])
}

/** Export interface/type/const names, used to keep `lru.ts` class-only. */
function exportedNonClasses(text: string): string[] {
  const names: string[] = []
  for (const pattern of [
    /export\s+interface\s+([A-Za-z_$][\w$]*)/g,
    /export\s+type\s+([A-Za-z_$][\w$]*)/g,
    /export\s+const\s+([A-Za-z_$][\w$]*)/g,
  ]) {
    for (const match of text.matchAll(pattern)) names.push(match[1])
  }
  return names.sort()
}

/** Expected exported classes per shared file: the allowlist for the layer. */
const expectedClasses: Record<string, string[]> = {
  'hash.ts': [],
  'node.ts': ['LinearNode', 'BinaryNode', 'SkipNode'],
  'node-record.ts': [],
  'tree.ts': ['BinaryTree', 'BPlusTree'],
  'redblack.ts': ['RedBlackTree', 'RedBlackSet'],
  'heap.ts': ['BinaryHeap', 'IndexedHeap'],
  'stack.ts': ['Deque', 'Stack', 'Queue'],
  'map.ts': ['OrderedMap', 'UnorderedMap'],
  'list.ts': ['OrderedSkipList', 'UnorderedSkipList'],
  'set.ts': ['OrderedSet', 'UnorderedSet', 'OrderedSkipSet', 'UnorderedSkipSet'],
  'lru.ts': [
    'LruList',
    'WeakLruList',
    'OrderedLruSet',
    'UnorderedLruSet',
    'OrderedLruList',
    'UnorderedLruList',
  ],
  'ast.ts': ['AstNode', 'AstTree', 'TokenStream', 'AstIndex'],
  'graph.ts': ['DirectedGraph'],
  'trie.ts': ['Trie'],
  'grid.ts': ['GridRange', 'SparseGrid'],
  'error.ts': [
    'CoordinationError',
    'NotFoundError',
    'InvalidStateError',
    'InvalidArgumentError',
    'ProfessionLockedError',
    'ProfessionRequiredError',
    'OrchestrationError',
    'VerificationError',
    'TakeoverError',
    'PermissionError',
    'DatabaseError',
    'UpstreamError',
    'NotImplementedError',
  ],
  'enum.ts': [],
  'entity.ts': [],
  'i18n.ts': [],
  'selection.ts': [],
  'service.ts': [],
}

test('hash.ts exports no LRU core and no source file resurrects the old names', () => {
  const forbidden = ['HashLruList', 'HashWeakLruList']
  const hashText = sourceByFile.get('hash.ts')
  assert.ok(hashText !== undefined, 'hash.ts must exist')
  assert.deepEqual(exportedClasses(hashText), [], 'hash.ts must not export any class')
  for (const name of forbidden) {
    assert.doesNotMatch(hashText, new RegExp(`export\\s+(?:abstract\\s+)?class\\s+${name}\\b`))
    assert.doesNotMatch(hashText, new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`))
  }

  const offenders: string[] = []
  for (const path of listTypeScriptFiles(sourceDirectory)) {
    const file = relative(sourceDirectory, path).replace(/\\/g, '/')
    if (file === 'shared/hash.ts') continue
    const text = readFileSync(path, 'utf8')
    for (const name of forbidden) {
      if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${file} references ${name}`)
    }
  }

  for (const file of readdirSync(testDirectory).filter((name) => name.endsWith('.test.ts'))) {
    if (file === 'shared-architecture.test.ts') continue
    const text = readFileSync(join(testDirectory, file), 'utf8')
    for (const name of forbidden) {
      if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`test/${file} references ${name}`)
    }
  }

  assert.deepEqual(offenders, [], 'the former hash-resident LRU classes must not be referenced')
})

test('lru.ts imports only the normaliseCapacity leaf helper from hash.ts', () => {
  const lruText = sourceByFile.get('lru.ts')
  assert.ok(lruText !== undefined, 'lru.ts must exist')
  const hashImports = parseImports('lru.ts', lruText).filter(
    (reference) => reference.specifier === './hash.js',
  )
  assert.deepEqual(
    hashImports.map((reference) => ({ names: reference.names, typeOnly: reference.typeOnly })),
    [{ names: ['normaliseCapacity'], typeOnly: false }],
  )

  const allowedHashImports = new Set([
    'hashString',
    'hashNumber',
    'hashCombine',
    'stableHash',
    'normaliseCapacity',
  ])
  const unexpected: string[] = []
  for (const source of sharedSources) {
    for (const reference of parseImports(source.file, source.text)) {
      if (reference.specifier !== './hash.js') continue
      for (const name of reference.names) {
        if (!allowedHashImports.has(name)) {
          unexpected.push(`${source.file} imports ${name} from hash.ts`)
        }
      }
    }
  }
  assert.deepEqual(unexpected, [], 'only the documented hash helpers may be imported')
})

test('shared import graph is acyclic even with type-only edges included', (t) => {
  const graph = buildImportGraph()
  const cycle = findCycles(graph)
  assert.deepEqual(cycle, [], `shared import graph contains a cycle: ${cycle.map((path) => path.join(' -> ')).join('; ')}`)

  const dangling: string[] = []
  for (const [file, targets] of graph) {
    for (const target of targets) {
      if (!sourceByFile.has(target)) dangling.push(`${file} -> ${target}`)
    }
  }
  assert.deepEqual(dangling, [])

  const edgeKinds = new Map<string, { value: boolean; type: boolean }>()
  for (const source of sharedSources) {
    for (const reference of parseImports(source.file, source.text)) {
      const target = resolveSharedTarget(reference.specifier)
      if (target === undefined) continue
      const key = `${source.file}->${target}`
      const kind = edgeKinds.get(key) ?? { value: false, type: false }
      if (reference.typeOnly) kind.type = true
      else kind.value = true
      edgeKinds.set(key, kind)
    }
  }
  const isTypeOnly = (from: string, to: string): boolean => {
    const kind = edgeKinds.get(`${from}->${to}`)
    return kind !== undefined && kind.type && !kind.value
  }
  const typeOnlyEdgeCount = [...edgeKinds.keys()].filter((key) => {
    const [from, to] = key.split('->')
    return isTypeOnly(from, to)
  }).length
  const lines = [...graph.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, targets]) => {
      const rendered = [...targets]
        .sort()
        .map((target) => `${target}${isTypeOnly(file, target) ? ' (type)' : ''}`)
      return `${file} -> ${rendered.length === 0 ? '(none)' : rendered.join(', ')}`
    })
  t.diagnostic(`shared import graph (${graph.size} files, ${typeOnlyEdgeCount} type-only direct edges):`)
  t.diagnostic(lines.join('\n'))
})

test('public export surface matches the class allowlist and has no duplicate core', () => {
  const exportedByFile = new Map<string, string[]>()
  for (const source of sharedSources) {
    const actual = exportedClasses(source.text)
    const expected = expectedClasses[source.file]
    assert.ok(expected !== undefined, `no expected class allowlist for ${source.file}`)
    assert.deepEqual(
      actual,
      expected,
      `${source.file} exported classes drifted: got ${actual.join(', ') || '(none)'}`,
    )
    exportedByFile.set(source.file, actual)
  }

  const owners = new Map<string, string[]>()
  for (const [file, classes] of exportedByFile) {
    for (const name of classes) {
      const files = owners.get(name) ?? []
      files.push(file)
      owners.set(name, files)
    }
  }
  const duplicates = [...owners.entries()].filter(([, files]) => files.length > 1)
  assert.deepEqual(duplicates, [], 'a class name must have exactly one owner file')

  const hashText = sourceByFile.get('hash.ts')
  assert.ok(hashText !== undefined)
  assert.deepEqual(
    exportedFunctions(hashText).sort(),
    ['hashCombine', 'hashNumber', 'hashString', 'normaliseCapacity', 'stableHash'],
    'hash.ts must expose only the documented hash functions and capacity helper',
  )

  const lruText = sourceByFile.get('lru.ts')
  assert.ok(lruText !== undefined)
  assert.deepEqual(exportedNonClasses(lruText), [], 'lru.ts must export classes only')

  for (const source of sharedSources) {
    assert.doesNotMatch(
      source.text,
      /^[ \t]*export\s+(?:\*|\{)/m,
      `${source.file} must not re-export bindings from another module`,
    )
  }
})

test('shared structures compose lower-level primitives instead of copying them', () => {
  const importsOf = (file: string): ImportReference[] => {
    const text = sourceByFile.get(file)
    assert.ok(text !== undefined, `${file} must exist`)
    return parseImports(file, text)
  }
  const assertImports = (file: string, specifier: string, name: string): void => {
    const names = importsOf(file)
      .filter((reference) => reference.specifier === specifier)
      .flatMap((reference) => reference.names)
    assert.ok(names.includes(name), `${file} must import ${name} from ${specifier}`)
  }

  assertImports('map.ts', './node.js', 'LinearNode')
  assertImports('tree.ts', './node.js', 'BinaryNode')
  assertImports('list.ts', './node.js', 'SkipNode')
  assertImports('list.ts', './tree.js', 'compareValues')
  assertImports('set.ts', './map.js', 'OrderedMap')
  assertImports('set.ts', './list.js', 'OrderedSkipList')
  assertImports('set.ts', './list.js', 'UnorderedSkipList')
  assertImports('lru.ts', './stack.js', 'Deque')
  assertImports('lru.ts', './map.js', 'OrderedMap')

  for (const source of sharedSources) {
    if (source.file !== 'node.ts') {
      assert.doesNotMatch(
        source.text,
        /\bclass\s+(?:LinearNode|BinaryNode|SkipNode)\b/,
        `${source.file} must use node.ts nodes, not a private copy`,
      )
    }
    if (source.file !== 'lru.ts') {
      assert.doesNotMatch(
        source.text,
        /\bclass\s+(?:LruList|WeakLruList)\b/,
        `${source.file} must not grow a second LRU core`,
      )
    }
  }
})
