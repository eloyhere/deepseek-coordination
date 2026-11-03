import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listNativeSubagents } from '../src/host/ampSubagents.js'

test('native child roster keeps only DSH-classified children and diagnostics', async () => {
  let session = ''
  const result = await listNativeSubagents({ async listChildren(id) {
    session = id
    return [
      { kind: 'child', id: 'native-child', mode: 'continuable', activity: 'inactive', hasChildren: true, label: 'Release review' },
      { kind: 'child', id: 'one-shot', mode: 'one-shot', activity: 'running', hasChildren: false },
      { kind: 'diagnostic', id: 'damaged-child', reason: 'corrupt' },
      { kind: 'diagnostic', id: 'guess', reason: 'made-up' },
      { kind: 'child', id: '', mode: 'one-shot', activity: 'running', hasChildren: false },
      { kind: 'child', id: 'unknown', mode: 'invented', activity: 'running', hasChildren: false },
      { id: 'unclassified', mode: 'one-shot', activity: 'running', hasChildren: false },
    ]
  } }, 'parent-id')
  assert.equal(session, 'parent-id')
  assert.deepEqual(result, {
    available: true,
    agents: [
      { id: 'native-child', mode: 'continuable', activity: 'inactive', hasChildren: true, label: 'Release review' },
      { id: 'one-shot', mode: 'one-shot', activity: 'running', hasChildren: false },
    ],
    diagnostics: [{ id: 'damaged-child', reason: 'corrupt' }],
  })
})

test('descendant roster includes authoritative direct parent and depth only', async () => {
  let actor = ''
  const roster = {
    async listChildren() { throw new Error('descendant operation should be used') },
    async listDescendants(id: string) {
      actor = id
      return [
        { kind: 'child', id: 'a', mode: 'continuable', activity: 'running', hasChildren: true, parentId: id, depth: 1 },
        { kind: 'child', id: 'b', mode: 'one-shot', activity: 'inactive', hasChildren: false, parentId: 'a', depth: 2 },
        { kind: 'child', id: 'unlinked', mode: 'one-shot', activity: 'running', hasChildren: false },
        { kind: 'diagnostic', id: 'damaged', reason: 'unavailable', parentId: 'b', depth: 3 },
      ]
    },
  }
  const value = await listNativeSubagents(roster, 'root', true)
  assert.equal(actor, 'root')
  assert.deepEqual(value.agents.map(({ id, parentId, depth }) => ({ id, parentId, depth })), [
    { id: 'a', parentId: 'root', depth: 1 },
    { id: 'b', parentId: 'a', depth: 2 },
  ])
  assert.deepEqual(value.diagnostics, [{ id: 'damaged', reason: 'unavailable', parentId: 'b', depth: 3 }])
})

test('direct roster uses native descendant classification when direct catalog lacks activity', async () => {
  let directCalls = 0
  const roster = {
    async listChildren() { directCalls += 1; return [{ id: 'catalog-only', mode: 'continuable', createdAt: 123 }] },
    async listDescendants(root: string) { return [
      { kind: 'child', id: 'catalog-only', mode: 'continuable', activity: 'inactive', hasChildren: true, parentId: root, depth: 1 },
      { kind: 'child', id: 'nested', mode: 'one-shot', activity: 'running', hasChildren: false, parentId: 'catalog-only', depth: 2 },
    ] },
  }
  const value = await listNativeSubagents(roster, 'root')
  assert.equal(directCalls, 0)
  assert.deepEqual(value.agents, [{ id: 'catalog-only', mode: 'continuable', activity: 'inactive', hasChildren: true, parentId: 'root', depth: 1 }])
})

test('missing native capability returns explicit unavailable, never a fake empty roster', async () => {
  assert.deepEqual(await listNativeSubagents(undefined, 'parent'), { available: false, agents: [], diagnostics: [] })
  assert.deepEqual(await listNativeSubagents({ async listChildren() { return [] } }, 'parent', true),
    { available: false, agents: [], diagnostics: [] })
  await assert.rejects(listNativeSubagents(undefined, ''), /calling session id/)
})

test('native errors and cancellation propagate; no synthetic roster is returned', async () => {
  const controller = new AbortController()
  const failing = { async listChildren() { throw new Error('DSH persistence unavailable') } }
  await assert.rejects(listNativeSubagents(failing, 'parent'), /DSH persistence unavailable/)
  controller.abort(new Error('caller cancelled'))
  let queried = false
  await assert.rejects(listNativeSubagents({ async listChildren() { queried = true; return [] } }, 'parent', false, controller.signal), /caller cancelled/)
  assert.equal(queried, false)
  await assert.rejects(listNativeSubagents({ async listChildren() { return {} as unknown as unknown[] } }, 'parent'), /must return an array/)
})
