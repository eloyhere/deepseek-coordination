/**
 * The `/amp/*` route table.
 *
 * `handleAmpRoute` is pure: it takes the already-parsed path, method, URL and
 * session, and returns the body and status the composition root writes. These
 * tests therefore cover the protocol surface without a webserver, a Cordis
 * context or a running harness — and they pin the two failure shapes that matter:
 * a missing session is a 400 (not an empty frame), and an unknown AMP path is a
 * 404 that the caller can distinguish from a non-AMP path (`undefined`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CoordinationDatabase } from '../src/host/database.js'
import { HandleGenerator, ManualClock } from '../src/host/handle.js'
import { SceneProfiles } from '../src/shared/enum.js'
import { AmpService, COORDINATION_CAPABILITIES, type AmpTurnFacts } from '../src/host/amp.js'
import { handleAmpRoute, type AmpRouteResult } from '../src/host/ampRoutes.js'
import { AmpCollaboration } from '../src/host/ampCollaboration.js'
import { createTestHost, testConfig } from './helpers.js'
import { verifyManifest, type Frame, type Manifest, type Receipt } from '../src/protocol/index.js'
import { insertSession, insertTurn } from './helpers.js'

interface Harness {
  db: CoordinationDatabase
  amp: AmpService
  close(): void
}

function harness(): Harness {
  const host = createTestHost()
  const amp = new AmpService({
    db: host.db,
    config: testConfig(),
    handles: new HandleGenerator('test'),
    clock: new ManualClock(),
    capabilities: COORDINATION_CAPABILITIES,
  })
  return {
    db: host.db,
    amp,
    close(): void {
      host.close()
    },
  }
}

const facts = (over: Partial<AmpTurnFacts> = {}): AmpTurnFacts => ({
  session: 'session-a',
  turn: 'test-turn-1',
  ordinal: 1,
  profession: 'execution',
  interaction: 'think',
  scene: 'dialogue',
  validation: 'medium',
  sceneProfile: SceneProfiles.dialogue,
  created: 1_700_000_000_000,
  status: 'done',
  ...over,
})

async function call(
  h: Harness,
  path: string,
  method = 'GET',
  query = '',
): Promise<AmpRouteResult | undefined> {
  const url = new URL(`http://coordination.local${path}${query === '' ? '' : `?${query}`}`)
  return await handleAmpRoute(
    { path, method, url, session: (url.searchParams.get('session') ?? '').trim() },
    { amp: h.amp, db: h.db },
    {
      sessionSkillCatalog: {
        async list(request: { sessionId: string }) {
          return { skills: [{ name: `skill-${request.sessionId}`, description: 'session skill', modelInvocable: true }] }
        },
      },
    },
  )
}

const valueOf = <T>(result: AmpRouteResult | undefined): T => {
  assert.ok(result !== undefined)
  assert.equal(result.status, 200)
  const body = result.body as { ok: boolean; value: T }
  assert.equal(body.ok, true)
  return body.value
}

test('insights requires an existing session and returns scoped persisted data', async () => {
  const h = harness()
  try {
    const missing = await call(h, '/amp/insights')
    assert.equal(missing?.status, 400)

    const sessionA = insertSession(h.db, 'insight-session-a')
    const turnA = insertTurn(h.db, sessionA, { handle: 'insight-turn-a', created: 1_700_000_000_000 })
    const sessionB = insertSession(h.db, 'insight-session-b')
    const turnB = insertTurn(h.db, sessionB, { handle: 'insight-turn-b', created: 1_700_000_000_001 })
    h.db.insert('cognition', { handle: 'cog-a', turn: turnA, stage: 'plan', strategy: '{"think":true}', content: 'A cognition', created: 1_700_000_000_000 })
    h.db.insert('cognition', { handle: 'cog-b', turn: turnB, stage: 'answer', strategy: '{"think":true}', content: 'B cognition', created: 1_700_000_000_001 })
    h.amp.store.append('claim', { kind: 'claim', id: 'claim-a', statement: 'session A fact', turn: 'insight-turn-a', status: 'held', tier: 'T1' })
    h.amp.store.append('claim', { kind: 'claim', id: 'claim-b', statement: 'session B fact', turn: 'insight-turn-b', status: 'held', tier: 'T1' })
    await call(h, '/amp/manifest')

    const value = valueOf<{
      cognition: Array<{ id: string; scope: string }>
      capabilities: Array<{ scope: string }>
      skills: Array<{ id: string }>
      knowledge: Array<{ id: string }>
      sources: { capabilities: { available: boolean }; skills: { available: boolean } }
    }>(await call(h, '/amp/insights', 'GET', 'session=insight-session-a'))
    assert.deepEqual(value.cognition.map((item) => item.id), ['cog-a'])
    assert.deepEqual(value.knowledge.map((item) => item.id), ['claim-a'])
    assert.ok(value.capabilities.length > 0)
    assert.ok(value.capabilities.every((item) => item.scope === 'installation'))
    assert.deepEqual(value.skills.map((item) => item.id), ['skill-insight-session-a'])
    assert.equal(value.sources.capabilities.available, true)
    assert.equal(value.sources.skills.available, true)
  } finally {
    h.close()
  }
})

test('sessions without coordination rows return empty persisted views', async () => {
  const h = harness()
  try {
    const value = valueOf<{ cognition: unknown[]; knowledge: unknown[]; skills: Array<{ id: string }> }>(
      await call(h, '/amp/insights', 'GET', 'session=not-in-coordination-db'),
    )
    assert.deepEqual(value.cognition, [])
    assert.deepEqual(value.knowledge, [])
    // A catalog-only skill is discovery data: the Harness service exposes
    // `list` and nothing else, so the row is marked read-only here and becomes
    // writable only through this plugin's `skills` control registry override.
    assert.deepEqual(value.skills, [{
      id: 'skill-not-in-coordination-db', title: 'skill-not-in-coordination-db', summary: 'session skill',
      source: 'session skill catalog', scope: 'session', status: 'read-only',
      details: { modelInvocable: true, writable: false },
    }])
  } finally {
    h.close()
  }
})

test('collaboration route returns only selected session duties and explicit failures', async () => {
  const h = harness()
  const fixture = createTestHost()
  try {
    for (const session of ['owner', 'worker', 'stranger']) insertSession(fixture.db, session)
    const collaboration = new AmpCollaboration(fixture.host)
    const duty = collaboration.assign('owner', { id: 'route-duty', assigneeSession: 'worker', role: 'execution', responsibilities: ['Produce an artifact'], acceptance: ['Review the artifact'] })
    const request = (session: string, method = 'GET') => ({ path: '/amp/collaboration', method, url: new URL('http://coordination.local/amp/collaboration'), session })
    const service = { amp: h.amp, db: fixture.db, collaboration }
    assert.deepEqual(valueOf(await handleAmpRoute(request('owner'), service)), { duties: [duty] })
    assert.deepEqual(valueOf(await handleAmpRoute(request('worker'), service)), { duties: [duty] })
    assert.deepEqual(valueOf(await handleAmpRoute(request('stranger'), service)), { duties: [] })
    assert.equal((await handleAmpRoute(request(''), service))?.status, 400)
    assert.equal((await handleAmpRoute(request('missing'), service))?.status, 404)
    assert.equal((await handleAmpRoute(request('owner'), { amp: h.amp }))?.status, 503)
    assert.equal((await handleAmpRoute(request('owner', 'POST'), service))?.status, 404)

    // The state card is the compaction-surviving summary: durable rows in, one
    // compact object out, and `null` when the session has nothing to carry.
    const cardRequest = (session: string) => ({ path: '/amp/state-card', method: 'GET', url: new URL('http://coordination.local/amp/state-card'), session })
    assert.equal((await handleAmpRoute(cardRequest(''), service))?.status, 400)
    const card = valueOf<{ durable: boolean; duties?: { open: number }; next?: string }>(await handleAmpRoute(cardRequest('owner'), service))
    assert.equal(card?.durable, true)
    assert.equal(card?.duties?.open, 1)
    assert.match(String(card?.next), /^Advance duty route-duty/)
    assert.equal(valueOf(await handleAmpRoute(cardRequest('stranger'), service)), null)

    // `?compaction=1` pairs the live card with the pre-compaction snapshot the
    // service captured in `maybeCompact`; without a snapshot the slot is null.
    const snapshotService = { ...service, compactionCardOf: () => ({ session: 'owner', durable: true, objective: 'captured' }) }
    const both = valueOf<{ current: { durable?: boolean }; compaction: { durable?: boolean; objective?: string } | null }>(
      await handleAmpRoute({ path: '/amp/state-card', method: 'GET', url: new URL('http://coordination.local/amp/state-card?compaction=1'), session: 'owner' }, snapshotService),
    )
    assert.equal(both?.current?.durable, true)
    assert.equal(both?.compaction?.durable, true)
    assert.equal(both?.compaction?.objective, 'captured')
    const none = valueOf<{ current: unknown; compaction: unknown }>(
      await handleAmpRoute({ path: '/amp/state-card', method: 'GET', url: new URL('http://coordination.local/amp/state-card?compaction=1'), session: 'owner' }, service),
    )
    assert.equal(none?.compaction, null)
  } finally { fixture.close(); h.close() }
})

test('identity and manifest are served as protocol objects', async () => {
  const h = harness()
  try {
    const identity = valueOf<{ kid: string; alg: string; publicKey: string }>(await call(h, '/amp/identity'))
    assert.match(identity.kid, /^ed25519-[0-9a-f]{16}$/)
    assert.equal(identity.alg, 'ed25519')
    assert.equal(Object.hasOwn(identity, 'privateKey'), false)

    const manifest = valueOf<Manifest>(await call(h, '/amp/manifest'))
    assert.equal(manifest.kind, 'manifest')
    assert.equal(manifest.agent.id, 'deepseek-coordination')
    const { importPublicKey } = await import('../src/protocol/index.js')
    const verdict = await verifyManifest(manifest, await importPublicKey(identity.publicKey))
    assert.equal(verdict.ok, true, verdict.reasons.join('; '))
  } finally {
    h.close()
  }
})

test('the frame route distinguishes a missing session from a missing frame', async () => {
  const h = harness()
  try {
    const missingSession = await call(h, '/amp/frame')
    assert.ok(missingSession !== undefined)
    assert.equal(missingSession.status, 400)
    assert.equal((missingSession.body as { error: { code: string } }).error.code, 'INVALID_ARGUMENT')

    const unknownSession = await call(h, '/amp/frame', 'GET', 'session=nobody')
    assert.ok(unknownSession !== undefined)
    assert.equal(unknownSession.status, 404)
    assert.equal((unknownSession.body as { error: { code: string } }).error.code, 'NOT_FOUND')

    await h.amp.openTurn(facts())
    const frame = valueOf<Frame>(await call(h, '/amp/frame', 'GET', 'session=session-a'))
    assert.equal(frame.id, 'frame-test-turn-1')
  } finally {
    h.close()
  }
})

test('receipts and the ledger honour their limits', async () => {
  const h = harness()
  try {
    for (let index = 0; index < 4; index += 1) {
      await h.amp.recordTool({ tool: 'coordination_read', ok: true, ms: index })
    }
    const receipts = valueOf<Receipt[]>(await call(h, '/amp/receipts', 'GET', 'limit=2'))
    assert.equal(receipts.length, 2)
    // The clamp is observable: 10,000 is served as 500, never as 10,000.
    const capped = valueOf<Receipt[]>(await call(h, '/amp/receipts', 'GET', 'limit=10000'))
    assert.equal(capped.length, 4)

    const head = valueOf<{ tip: string; count: number; entries: unknown[] }>(
      await call(h, '/amp/ledger', 'GET', 'limit=2'),
    )
    // Each tool call appends a receipt *and* a tool.invoked event.
    assert.equal(head.count, 8)
    assert.equal(head.entries.length, 2)
    assert.match(head.tip, /^sha256:[0-9a-f]{64}$/)

    const all = valueOf<{ entries: unknown[] }>(await call(h, '/amp/ledger', 'GET', 'full=1'))
    assert.equal(all.entries.length, 8)
  } finally {
    h.close()
  }
})

test('verify and checkpoint round-trip through the routes', async () => {
  const h = harness()
  try {
    await h.amp.closeTurn(facts())
    const before = valueOf<{ ok: boolean; count: number }>(await call(h, '/amp/verify'))
    assert.equal(before.ok, true)
    assert.equal(before.count, 2)

    const checkpoint = valueOf<{ seq: number; count: number }>(await call(h, '/amp/checkpoint', 'POST'))
    assert.equal(checkpoint.seq, 0)
    assert.equal(checkpoint.count, before.count)

    const after = valueOf<{ ok: boolean; checkpoint?: { seq: number } }>(await call(h, '/amp/verify'))
    assert.equal(after.ok, true)
    assert.equal(after.checkpoint?.seq, 0)
  } finally {
    h.close()
  }
})

test('an unknown AMP path is a 404; a non-AMP path is not this handler\'s business', async () => {
  const h = harness()
  try {
    const unknown = await call(h, '/amp/nope')
    assert.ok(unknown !== undefined)
    assert.equal(unknown.status, 404)
    assert.match((unknown.body as { error: { message: string } }).error.message, /not an AMP route/)

    const wrongMethod = await call(h, '/amp/identity', 'POST')
    assert.ok(wrongMethod !== undefined)
    assert.equal(wrongMethod.status, 404)

    assert.equal(await call(h, '/selection'), undefined)
    assert.equal(await call(h, '/graph/tree'), undefined)
  } finally {
    h.close()
  }
})
