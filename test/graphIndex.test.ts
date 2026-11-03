import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CoordinationDatabase } from '../src/host/database.js'
import { GraphStore } from '../src/host/graphStore.js'
import { graphIndexOperations, graphRevision, validateIndexPaths } from '../src/host/graphIndex.js'
import { coordinationIndexToolDefinition, coordinationGraphToolDefinitions, type CoordinationToolService } from '../src/host/tools.js'
import { testConfig } from './helpers.js'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'coordination-index-'))
  const db = new CoordinationDatabase(':memory:')
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
  const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
  return { root, db, write }
}

function service(db: CoordinationDatabase, workspaceRoot: string): CoordinationToolService {
  return { db, workspaceRoot, locale: 'en-US', config: testConfig(), state: () => { throw Error('unused') },
    setSelection: () => { throw Error('unused') }, activeTurn: () => undefined,
    getProfessionRecord: () => { throw Error('unused') }, turnByOrdinal: () => undefined }
}

test('shared index persists identical monorepo paths independently in two workspace roots', async t => {
  const { root, db, write } = fixture(t)
  const a = join(root, 'a')
  const b = join(root, 'b')
  for (const [directory, name] of [[a, 'first'], [b, 'second']] as const) {
    write(join(directory, 'package.json'), JSON.stringify({ name, workspaces: ['packages/*'] }))
    write(join(directory, 'src/index.ts'), `export function ${name}() { return 1 }`)
    write(join(directory, 'packages/core/package.json'), JSON.stringify({ name: `${name}-core` }))
    write(join(directory, 'packages/core/src/index.ts'), `export class ${name}Core {}`)
    for (const skipped of ['node_modules', '.tmp', 'dist', '.git']) write(join(directory, skipped, 'ignored.ts'), 'export const ignored = 1')
  }
  const operations = graphIndexOperations(db)
  for (const directory of [a, b]) {
    const result = await operations.update(directory)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.indexed, 4)
    assert.equal(result.value.truncated, false)
    const records = new GraphStore(db, { workspaceRoot: directory }).loadNodes()
    const indexedPaths = [...new Set(records.map(record => record.path))]
    for (const expected of ['package.json', 'packages/core/package.json', 'packages/core/src/index.ts', 'src/index.ts']) assert.ok(indexedPaths.includes(expected))
    assert.ok(indexedPaths.every(path => !path || !/(^|\/)(node_modules|\.tmp|dist|\.git)\//.test(path)))
    assert.ok(records.some(record => record.name === (directory === a ? 'first' : 'second')))
  }
  assert.equal(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM snapshot')?.count, 8)
  assert.ok(new GraphStore(db, { workspaceRoot: a }).loadNodes().some(record => record.name === 'first'))
})

test('model changed-path update uses strict caller session and shares Host operation data/version', async t => {
  const { root, db, write } = fixture(t)
  const selected = join(root, 'selected')
  const fallback = join(root, 'fallback')
  write(join(selected, 'src/index.ts'), 'export function selectedVersion() { return 1 }')
  write(join(fallback, 'src/index.ts'), 'export function wrongWorkspace() {}')
  const host = service(db, fallback)
  const context = { get(name: string) {
    if (name === 'sessionQuery') return { observeSession(id: string) {
      return { header: { id, cwd: id === 'selected' ? selected : undefined } }
    } }
    return undefined
  } }
  const tool = coordinationIndexToolDefinition(host, 'en-US', { context })
  const first = await tool.execute({ paths: ['src/index.ts'] }, { agent: { id: 'selected' } }) as Record<string, unknown>
  assert.equal(first.root, selected)
  assert.equal(first.indexed, 1)
  assert.deepEqual(graphRevision(db, selected), { root: selected, version: first.version })
  assert.equal(new GraphStore(db, { workspaceRoot: fallback }).loadNodes().length, 0)
  await new Promise(resolve => setTimeout(resolve, 5))
  write(join(selected, 'src/index.ts'), 'export function changedVersionWithNewName() { return 12345 }')
  const second = await tool.execute({ paths: ['src/index.ts'] }, { agent: { id: 'selected' } }) as Record<string, unknown>
  assert.notEqual(second.version, first.version)
  assert.ok(new GraphStore(db, { workspaceRoot: selected }).loadNodes().some(record => record.name === 'changedVersionWithNewName'))
  await assert.rejects(Promise.resolve().then(() => tool.execute({}, { agent: { id: 'missing' } })), /no resolvable workspace/)
  const rebuilt = await graphIndexOperations(db).update(selected, { action: 'rebuild' })
  assert.ok(rebuilt.ok)
  if (rebuilt.ok) assert.equal(rebuilt.value.indexed, 1)
})

test('graph updates reject escaping batches before mutation and share BUSY across callers', async t => {
  const { root, db, write } = fixture(t)
  write(join(root, 'a.ts'), 'export const a = 1')
  const operations = graphIndexOperations(db)
  const running = operations.update(root, { paths: ['a.ts'] })
  const busy = await operations.update(root, { action: 'rebuild' })
  assert.deepEqual(busy, { ok: false, error: { code: 'BUSY', message: 'a graph update is already running' } })
  assert.equal((await running).ok, true)
  const before = graphRevision(db, root)
  await assert.rejects(operations.update(root, { paths: ['a.ts', '../escape.ts'] }), /workspace-relative/)
  assert.deepEqual(graphRevision(db, root), before)
  for (const paths of [[], Array(201).fill('a.ts'), ['C:\\outside.ts'], ['\\\\host\\share\\a.ts']]) assert.throws(() => validateIndexPaths(paths))
  await assert.rejects(operations.update(root, { action: 'rebuild', paths: ['a.ts'] }), /cannot be combined/)
  const disabled = service(db, root)
  ;(disabled.config as { parser: { enabled: boolean } }).parser.enabled = false
  await assert.rejects(Promise.resolve().then(() => coordinationIndexToolDefinition(disabled).execute({})), /disabled/)
})

test('index tool adds a bounded first-turn definition prompt proxy', t => {
  const { root, db } = fixture(t)
  const host = service(db, root)
  const schemas = coordinationGraphToolDefinitions(host).map(({ name, description, parameters }) => ({ name, description, parameters }))
  const { name, description, parameters } = coordinationIndexToolDefinition(host)
  const before = JSON.stringify(schemas)
  const after = JSON.stringify([...schemas, { name, description, parameters }])
  const proxy = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
  assert.ok(proxy(after) - proxy(before) < 210)
  t.diagnostic(`definition prompt UTF-8/4 proxy: ${proxy(before)} -> ${proxy(after)} (+${proxy(after) - proxy(before)})`)
})
