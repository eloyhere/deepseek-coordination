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
import { handleAmpRoute, type AmpRouteResult } from '../src/host/amp-routes.js'
import { createTestHost, testConfig } from './helpers.js'
import { verifyManifest, type Frame, type Manifest, type Receipt } from '../src/protocol/index.js'

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
    { amp: h.amp },
  )
}

const valueOf = <T>(result: AmpRouteResult | undefined): T => {
  assert.ok(result !== undefined)
  assert.equal(result.status, 200)
  const body = result.body as { ok: boolean; value: T }
  assert.equal(body.ok, true)
  return body.value
}

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
