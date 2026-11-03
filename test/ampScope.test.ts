import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleAmpRoute } from '../src/host/ampRoutes.js'
import { createTestHost, insertSession, insertTurn, insertGoal, insertPlan, testConfig } from './helpers.js'
import { adaptAmpScopeHost, type AmpScopeHost } from '../src/host/ampScope.js'
import type { AmpScopeView } from '../src/shared/ampScope.js'
import { goalIdOf, planIdOf } from '../src/host/amp.js'
import { AmpService, COORDINATION_CAPABILITIES, type AmpTurnFacts } from '../src/host/amp.js'
import { HandleGenerator, ManualClock } from '../src/host/handle.js'
import { SceneProfiles } from '../src/shared/enum.js'

function fixture() {
  const host = createTestHost()
  const amp = new AmpService({ db: host.db, config: testConfig(), handles: new HandleGenerator('scope'), clock: new ManualClock(), capabilities: COORDINATION_CAPABILITIES })
  return { db: host.db, amp, close: host.close }
}
const facts = (session: string, turn: string, ordinal: number): AmpTurnFacts => ({ session, turn, ordinal, profession: 'execution', interaction: 'think', scene: 'dialogue', validation: 'medium', sceneProfile: SceneProfiles.dialogue, created: 1_700_000_000_000 + ordinal, status: 'done' })
async function call(h: ReturnType<typeof fixture>, query: string, overrides: AmpScopeHost = {}) {
  const url = new URL(`http://scope.local/amp/scope?${query}`)
  return await handleAmpRoute({ path: '/amp/scope', method: 'GET', url, session: (url.searchParams.get('session') ?? '').trim() }, { amp: h.amp, db: h.db }, {
    workspaceRegistry: {
      list: () => [{ id: 'w1', title: 'One', path: 'C:/one', sessionIds: ['a'] }, { id: 'w2', title: 'Two', path: 'C:/two', sessionIds: ['b'] }],
      get: (id) => id === 'w1' ? { id: 'w1', title: 'One', path: 'C:/one', sessionIds: ['a'] } : undefined,
      resolveByPath: async (path) => path === 'C:/one' ? { id: 'w1', title: 'One', path, sessionIds: ['a'] } : undefined,
    },
    storageDomain: { get: () => ({ global: { get: () => ({ defaultWorkspaceId: 'w1' }) } }) },
    sessionQuery: { listSessions: async () => [{ header: { id: 'a', cwd: 'C:/one' } }, { header: { id: 'b', cwd: 'C:/two' } }] },
    ...overrides,
  })
}
const view = (result: Awaited<ReturnType<typeof call>>): AmpScopeView => {
  assert.equal(result?.status, 200)
  return (result?.body as { value: AmpScopeView }).value
}

test('scope route resolves the durable default and inherits parent workspaces', async () => {
  const h = fixture()
  try {
    const query = { listSessions: async () => [{ header: { id: 'a', cwd: 'C:/one' } }, { header: { id: 'child', parentSession: 'a', cwd: 'C:/two' } }, { header: { id: 'fallback', cwd: 'C:/one' } }] }
    const value = view(await call(h, 'scope=default', { sessionQuery: query }))
    assert.equal(value.workspace?.id, 'w1')
    assert.deepEqual(value.sessions.map((item) => item.id).sort(), ['a', 'child', 'fallback'])
    const child = view(await call(h, 'scope=workspace&session=child', { sessionQuery: query }))
    assert.equal(child.workspace?.id, 'w1')
    const absent = view(await call(h, 'scope=default', { storageDomain: { get: () => ({ global: { get: () => ({}) } }) } }))
    assert.equal(absent.workspace, null)
    assert.equal(absent.totalSessions, 0, 'never choose first or most recent workspace as default')
  } finally { h.close() }
})

test('scope reads preserve artifacts and leave unassigned tool receipts global', async () => {
  const h = fixture()
  try {
    const frame = await h.amp.openTurn(facts('a', 'turn-a', 1))
    const receipt = await h.amp.closeTurn(facts('a', 'turn-a', 1))
    const unassigned = await h.amp.recordTool({ tool: 'coordination_read', ok: true, ms: 1 })
    const before = h.amp.store.entries()
    const tip = h.amp.store.tip()
    // Scope must not initialize identity, read a private key, verify, checkpoint or append.
    h.amp.store.key = () => { throw new Error('private-key read') }
    h.amp.store.append = () => { throw new Error('scope mutated chain') }
    const scoped = view(await call(h, 'scope=workspace&session=a'))
    assert.deepEqual(scoped.sessions[0]?.frame, frame)
    assert.deepEqual(scoped.receipts, [receipt])
    assert.ok(!scoped.receipts.some((item) => item.id === unassigned.id))
    assert.equal(scoped.unassignedEntries, 0)
    const global = view(await call(h, 'scope=global'))
    assert.equal(global.unassignedEntries, 2)
    assert.ok(global.receipts.some((item) => item.id === unassigned.id))
    assert.equal(global.totalEntries, before.length)
    assert.deepEqual(scoped.entries, before.filter((entry) => scoped.entries.some((item) => item.seq === entry.seq)))
    assert.equal(Object.hasOwn(scoped, 'ok'), false)
    assert.equal(Object.hasOwn(scoped, 'kind'), false)
    assert.equal(scoped.verificationScope, 'global')
    assert.equal(h.amp.store.tip(), tip)
    assert.deepEqual(h.amp.store.entries(), before)
  } finally { h.close() }
})

test('SQLite turn joins attribute goal and plan IDs without a recent event window', async () => {
  const h = fixture()
  try {
    const session = insertSession(h.db, 'a')
    const turn = insertTurn(h.db, session)
    const goal = insertGoal(h.db, session, turn, { handle: 'sql-goal' })
    const plan = insertPlan(h.db, turn, { handle: 'sql-plan' })
    h.db.run('UPDATE turn SET goal = ?, plan = ? WHERE identity = ?', goal, plan, turn)
    h.amp.store.append('goal', { kind: 'goal', id: goalIdOf('sql-goal') })
    h.amp.store.append('plan', { kind: 'plan', id: planIdOf('sql-plan') })
    const value = view(await call(h, 'scope=workspace&session=a'))
    assert.equal(value.totalEntries, 2)
    assert.equal(value.unassignedEntries, 0)
    assert.deepEqual(value.entries.map((entry) => entry.kind), ['goal', 'plan'])
  } finally { h.close() }
})

test('scope response caps session details, entries and receipts and returns counts', async () => {
  const h = fixture()
  try {
    for (let i = 0; i < 55; i++) {
      await h.amp.closeTurn(facts(`s-${i}`, `turn-${i}`, i + 1))
    }
    const value = view(await call(h, 'scope=global&sessionLimit=999&entryLimit=999&receiptLimit=999', { sessionQuery: undefined }))
    assert.equal(value.totalSessions, 57) // 55 AMP sessions and the two registry members.
    assert.equal(value.sessions.length, 50)
    assert.equal(value.entries.length, 50)
    assert.equal(value.receipts.length, 20)
    assert.equal(value.totalReceipts, 55)
    assert.deepEqual(value.truncated, { sessions: true, entries: true, receipts: true })
    assert.deepEqual(value.limits, { sessions: 50, entries: 50, receipts: 20 })
  } finally { h.close() }
})

test('default and second workspace isolate sessions, receipts and entries', async () => {
  const h = fixture()
  try {
    await h.amp.openTurn(facts('a', 'turn-a', 1))
    const firstReceipt = await h.amp.closeTurn(facts('a', 'turn-a', 1))
    await h.amp.openTurn(facts('b', 'turn-b', 2))
    const secondReceipt = await h.amp.closeTurn(facts('b', 'turn-b', 2))
    const defaultView = view(await call(h, 'scope=default'))
    const secondView = view(await call(h, 'scope=workspace&session=b'))
    assert.equal(defaultView.workspace?.id, 'w1')
    assert.equal(secondView.workspace?.id, 'w2')
    assert.deepEqual(defaultView.sessions.map((item) => item.id), ['a'])
    assert.deepEqual(secondView.sessions.map((item) => item.id), ['b'])
    assert.deepEqual(defaultView.receipts.map((receipt) => receipt.id), [firstReceipt.id])
    assert.deepEqual(secondView.receipts.map((receipt) => receipt.id), [secondReceipt.id])
    assert.ok(defaultView.entries.every((entry) => !secondView.entries.some((other) => other.seq === entry.seq)))
    assert.equal(defaultView.unassignedEntries, 0)
    assert.equal(secondView.unassignedEntries, 0)
  } finally { h.close() }
})

test('ambiguous cross-session references remain global-only', async () => {
  const h = fixture()
  try {
    const first = await h.amp.openTurn(facts('a', 'turn-a', 1))
    const second = await h.amp.openTurn(facts('b', 'turn-b', 2))
    const ambiguous = await h.amp.event('cross-session', { refs: [
      { kind: 'frame', id: first.id }, { kind: 'frame', id: second.id },
    ] })
    const globalView = view(await call(h, 'scope=global'))
    const firstView = view(await call(h, 'scope=default'))
    const secondView = view(await call(h, 'scope=workspace&session=b'))
    const includes = (scope: AmpScopeView) => scope.entries.some((entry) => (entry.payload as { id?: string }).id === ambiguous.id)
    assert.equal(includes(globalView), true)
    assert.equal(includes(firstView), false)
    assert.equal(includes(secondView), false)
    assert.equal(globalView.unassignedEntries, 1)
    assert.equal(firstView.unassignedEntries, 0)
    assert.equal(secondView.unassignedEntries, 0)
  } finally { h.close() }
})

test('optional Host service adapter validates methods and projected data', async () => {
  const h = fixture()
  try {
    const absent = adaptAmpScopeHost({ workspaceRegistry: { list: 7 }, sessionQuery: { listSessions: null }, storageDomain: {} })
    assert.deepEqual(absent, {})
    const registry = {
      list: () => [{ id: 'w1', title: 'One', path: 'C:/one', sessionIds: ['a'] }, { id: 0, path: 'C:/bad' }],
      get: (id: string) => id === 'w1' ? { id: 'w1', title: 'One', path: 'C:/one', sessionIds: ['a'] } : undefined,
      resolveByPath: async () => undefined,
    }
    const host = adaptAmpScopeHost({ workspaceRegistry: registry, storageDomain: {
      get: () => ({ global: { get: () => ({ defaultWorkspaceId: 'w1' }) } }),
    }, sessionQuery: { listSessions: async () => [{ header: { id: 'a' } }, { header: { id: 9 } }] } })
    assert.deepEqual(host.workspaceRegistry?.list().map((item) => item.id), ['w1'])
    assert.deepEqual((await host.sessionQuery?.listSessions())?.map((item) => item.header.id), ['a'])
    const url = new URL('http://scope.local/amp/scope?scope=default')
    const result = await handleAmpRoute({ path: '/amp/scope', method: 'GET', url, session: '' }, { amp: h.amp, db: h.db }, host)
    assert.equal((result?.body as { value: AmpScopeView }).value.workspace?.id, 'w1')
  } finally { h.close() }
})

test('scope route validates scope and workspace session', async () => {
  const h = fixture()
  try {
    const invalid = await call(h, 'scope=bad')
    assert.equal(invalid?.status, 400)
    const missing = await call(h, 'scope=workspace')
    assert.equal(missing?.status, 400)
  } finally { h.close() }
})
test('scope route filters a view and reports bounded global totals', async () => {
  const h = fixture()
  try {
    await h.amp.openTurn(facts('a', 'turn-a', 1))
    await h.amp.closeTurn(facts('a', 'turn-a', 1))
    await h.amp.openTurn(facts('b', 'turn-b', 2))
    await h.amp.closeTurn(facts('b', 'turn-b', 2))
    const result = await call(h, 'scope=workspace&session=a&entryLimit=1&receiptLimit=0')
    assert.equal(result?.status, 200)
    const value = (result?.body as { value: { sessions: Array<{ id: string }>; entries: unknown[]; receipts: unknown[]; totalEntries: number; totalSessions: number; verificationScope: string; truncated: { entries: boolean } } }).value
    assert.deepEqual(value.sessions.map((item) => item.id), ['a'])
    assert.equal(value.entries.length, 1)
    assert.equal(value.receipts.length, 0)
    assert.equal(value.totalSessions, 1)
    assert.ok(value.totalEntries > 1)
    assert.equal(value.truncated.entries, true)
    assert.equal(value.verificationScope, 'global')
    const global = await call(h, 'scope=global')
    const globalValue = (global?.body as { value: { totalEntries: number } }).value
    assert.ok(globalValue.totalEntries > value.totalEntries)
  } finally { h.close() }
})
