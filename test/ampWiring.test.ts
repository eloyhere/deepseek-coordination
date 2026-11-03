/**
 * AMP wiring: the plugin's state projected into protocol artifacts.
 *
 * These tests exercise `AmpService` against an in-memory coordination database
 * and no DSH process. They pin the four things a reader of the ledger depends
 * on:
 *
 *  - a manifest whose capability tier/confidence come from receipts (M-1);
 *  - a frame with explicit exclusions instead of silent omissions (`A-2`, `F-7`);
 *  - a receipt per turn and per tool call, measured rather than asserted (`R-1`);
 *  - an append-only chain whose rewrite is refused by SQLite and detected by
 *    verification (`X-1`, `X-2`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CoordinationDatabase } from '../src/host/database.js'
import { HandleGenerator, ManualClock } from '../src/host/handle.js'
import { CoordinationEventBus } from '../src/host/module.js'
import { SceneProfiles } from '../src/shared/enum.js'
import { createTestHost, testConfig } from './helpers.js'
import {
  AMP_AGENT_ID,
  AmpService,
  COORDINATION_CAPABILITIES,
  frameModeOf,
  ledgerProjection,
  outcomeOf,
  receiptIdOf,
  receiptOpOf,
  toolRefId,
  withAmpReceipts,
  type AmpTurnFacts,
} from '../src/host/amp.js'
import type { CoordinationToolDefinition, CoordinationToolRegistry } from '../src/host/tools.js'
import { canonical, isId, validateClaim, verifyManifest, verifySnapshot, type Claim } from '../src/protocol/index.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

interface Harness {
  db: CoordinationDatabase
  amp: AmpService
  clock: ManualClock
  close(): void
}

function harness(): Harness {
  const host = createTestHost()
  const clock = new ManualClock()
  const amp = new AmpService({
    db: host.db,
    config: testConfig(),
    handles: new HandleGenerator('test'),
    clock,
    capabilities: COORDINATION_CAPABILITIES,
  })
  return {
    db: host.db,
    amp,
    clock,
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

/* ------------------------------------------------------------------------- *
 * Manifest
 * ------------------------------------------------------------------------- */

test('the first manifest is signed, self-declared honestly and starts every capability at T0', async () => {
  const h = harness()
  try {
    const manifest = await h.amp.manifest()
    assert.equal(manifest.amp, '0.1')
    assert.equal(manifest.kind, 'manifest')
    assert.equal(manifest.agent.id, AMP_AGENT_ID)
    assert.equal(manifest.capabilities.length, COORDINATION_CAPABILITIES.length)
    for (const capability of manifest.capabilities) {
      assert.equal(capability.tier, 'T0', 'a capability with no receipt has earned nothing')
      assert.equal(capability.confidence, 0.5, 'Laplace prior with zero calls is 1/2')
      assert.deepEqual(capability.evidence, [])
    }
    // Nothing is measured yet, so the manifest says so instead of claiming 0 error.
    assert.equal(manifest.self.calibration.ece, 1)
    assert.ok(manifest.self.limits?.some((limit) => limit.includes('calibration is not measured')))

    const verdict = await verifyManifest(manifest, await publicKeyOf(h))
    assert.equal(verdict.ok, true, verdict.reasons.join('; '))

    const identity = await h.amp.identity()
    assert.match(identity.kid, /^ed25519-[0-9a-f]{16}$/)
    assert.match(identity.publicKey, /^[A-Za-z0-9_-]+$/)
    // The private key is not part of the public identity.
    assert.equal(Object.hasOwn(identity, 'privateKey'), false)

    const stored = h.db.count('amp_manifest')
    assert.equal(stored, 1)
    // A second call inside the TTL returns the same object instead of re-signing.
    const again = await h.amp.manifest()
    assert.equal(again.digest, manifest.digest)
    assert.equal(h.db.count('amp_manifest'), 1)
  } finally {
    h.close()
  }
})

/** Re-import the stored public key without exposing it through the service. */
async function publicKeyOf(h: Harness): Promise<CryptoKey> {
  const identity = await h.amp.identity()
  const { importPublicKey } = await import('../src/protocol/index.js')
  return await importPublicKey(identity.publicKey)
}

test('a capability becomes T2 once a successful receipt exists, and confidence follows the ledger', async () => {
  const h = harness()
  try {
    await h.amp.recordTool({ tool: 'coordination_read', ok: true, ms: 4 })
    await h.amp.recordTool({ tool: 'coordination_read', ok: true, ms: 6 })
    await h.amp.recordTool({ tool: 'coordination_read', ok: false, ms: 2 })
    await h.amp.flush()

    // A fresh service has no manifest cache, so it rebuilds from the records.
    const fresh = new AmpService({
      db: h.db,
      config: testConfig(),
      handles: new HandleGenerator('test'),
      clock: h.clock,
      capabilities: COORDINATION_CAPABILITIES,
    })
    const manifest = await fresh.manifest()
    const read = manifest.capabilities.find((capability) => capability.id === 'coordination_read')
    assert.ok(read !== undefined)
    assert.equal(read.tier, 'T2', 'two successes are observations recorded by this agent')
    // Laplace: (2 successes + 1) / (3 calls + 2) = 0.6
    assert.equal(read.confidence, 0.6)
    assert.ok((read.evidence?.length ?? 0) > 0)
    assert.equal(read.limits?.[0], 'read-only')
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Frames
 * ------------------------------------------------------------------------- */

test('a frame cites resolvable refs, says why, and records its exclusions', async () => {
  const h = harness()
  try {
    const frame = await h.amp.openTurn(facts())
    assert.equal(frame.id, 'frame-test-turn-1')
    assert.equal(frame.agent, AMP_AGENT_ID)
    assert.equal(frame.cycle, 1)
    assert.equal(frame.mode, 'explore')
    assert.equal(frame.ts, new Date(1_700_000_000_000).toISOString())
    assert.ok(frame.slots.length <= 9)
    for (const slot of frame.slots) {
      assert.ok(slot.why.trim().length > 0, 'A-1: every slot says why it is attended to')
      assert.equal(slot.state, 'active')
    }
    // Deliberate exclusions, each with the trigger that would bring it back.
    const knobs = (frame.ignored ?? []).map((item) => item.target.id)
    assert.deepEqual(knobs.sort(), ['policy-allow-bash', 'policy-max-iteration'])
    for (const item of frame.ignored ?? []) {
      assert.ok(item.revisit_if.trim().length > 0, 'an exclusion without a revisit trigger is a silent drop')
    }
    assert.equal(frame.budget.allocated.ms, 30_000)
    assert.deepEqual(frame.budget.spent, {})

    // The bus event is what makes "latest frame for a session" answerable.
    const latest = await h.amp.latestFrameFor('session-a')
    assert.equal(latest?.id, frame.id)
    assert.equal(await h.amp.latestFrameFor('session-b'), undefined)
  } finally {
    h.close()
  }
})

test('an excluded web search appears only when the scene disallows it', async () => {
  const h = harness()
  try {
    const offline = await h.amp.openTurn(
      facts({ turn: 'test-turn-2', sceneProfile: { ...SceneProfiles.dialogue, allowWeb: false } }),
    )
    assert.ok((offline.ignored ?? []).some((item) => item.target.id === 'policy-allow-web'))
    const online = await h.amp.openTurn(facts({ turn: 'test-turn-3' }))
    assert.equal((online.ignored ?? []).some((item) => item.target.id === 'policy-allow-web'), false)
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Settlement
 * ------------------------------------------------------------------------- */

test('a turn closes with one measured reflect receipt targeting its frame', async () => {
  const h = harness()
  try {
    await h.amp.openTurn(facts())
    const receipt = await h.amp.closeTurn(facts({ finished: 1_700_000_002_500 }))
    assert.equal(receipt.id, receiptIdOf('test-turn-1'))
    assert.equal(receipt.op, 'reflect')
    assert.equal(receipt.outcome, 'success')
    assert.equal(receipt.ms, 2500)
    assert.deepEqual(receipt.usage, { ms: 2500 })
    assert.deepEqual(receipt.target, { kind: 'frame', id: 'frame-test-turn-1' })

    const verify = await h.amp.verify()
    assert.equal(verify.ok, true, verify.reasons.join('; '))
    assert.equal(verify.count, 4, 'frame + turn.opened + receipt + turn.closed')

    // The stored body is canonical JSON, so a reader can re-derive the digest.
    const row = h.db.get<{ body: string }>('SELECT body FROM amp_object WHERE kind = ? ORDER BY seq DESC', 'receipt')
    assert.ok(row !== undefined)
    assert.equal(row.body, canonical(JSON.parse(row.body)))
  } finally {
    h.close()
  }
})

test('a failed turn settles as failure and a cancelled turn as blocked', async () => {
  const h = harness()
  try {
    const failed = await h.amp.closeTurn(facts({ turn: 'test-turn-f', status: 'failed' }))
    const cancelled = await h.amp.closeTurn(facts({ turn: 'test-turn-c', status: 'cancelled' }))
    const abandoned = await h.amp.closeTurn(facts({ turn: 'test-turn-a', status: 'abandoned' }))
    assert.equal(failed.outcome, 'failure')
    assert.equal(cancelled.outcome, 'blocked')
    assert.equal(abandoned.outcome, 'partial')
    // No `finished` timestamp means no duration: usage stays empty rather than 0.
    assert.deepEqual(failed.usage, {})
  } finally {
    h.close()
  }
})

test('a tool call settles as a receipt whose verb and target name the tool', async () => {
  const h = harness()
  try {
    const receipt = await h.amp.recordTool({ tool: 'coordination_selection', ok: true, ms: 7 })
    assert.equal(receipt.op, 'attend')
    assert.equal(receipt.outcome, 'success')
    assert.deepEqual(receipt.target, { kind: 'tool', id: 'coordination_selection' })
    assert.deepEqual(receipt.usage, { calls: 1, ms: 7 })
    assert.equal(toolRefId('coordination_read'), 'coordination_read')
    assert.equal(receiptOpOf('coordination_read'), 'read')
    assert.equal(receiptOpOf('coordination_parse'), 'read')
    assert.equal(receiptOpOf('unknown_tool'), 'act')
    assert.equal(frameModeOf('emotion'), 'reflect')
    assert.equal(frameModeOf('orchestrate'), 'triage')
    assert.equal(outcomeOf('cancelled'), 'blocked')
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Immutability and verification
 * ------------------------------------------------------------------------- */

test('SQLite refuses to update or delete a ledger row', async () => {
  const h = harness()
  try {
    await h.amp.closeTurn(facts())
    // The wrapper reports the statement; the trigger's own message is the cause.
    const rejected = (statement: string): string => {
      try {
        h.db.run(statement)
      } catch (error) {
        const details = (error as { details?: { cause?: string } }).details
        return details?.cause ?? ''
      }
      return ''
    }
    assert.match(rejected('UPDATE amp_object SET body = ? WHERE seq = 0'), /append-only/)
    assert.match(rejected('DELETE FROM amp_object WHERE seq = 0'), /append-only/)
  } finally {
    h.close()
  }
})

test('verification detects a rewritten body once the trigger is gone', async () => {
  const h = harness()
  try {
    await h.amp.openTurn(facts())
    await h.amp.closeTurn(facts())
    assert.equal((await h.amp.verify()).ok, true)

    // A hostile writer with schema rights can drop the trigger; the hash chain
    // still catches the edit.
    h.db.exec('DROP TRIGGER trg_amp_object_immutable_update')
    const row = h.db.get<{ body: string }>('SELECT body FROM amp_object WHERE kind = ? ORDER BY seq ASC LIMIT 1', 'frame')
    assert.ok(row !== undefined)
    const body = JSON.parse(row.body) as Record<string, unknown>
    body.mode = 'rest'
    h.db.run('UPDATE amp_object SET body = ? WHERE kind = ? AND seq = 0', JSON.stringify(body), 'frame')

    const verify = await h.amp.verify()
    assert.equal(verify.ok, false)
    assert.ok(verify.reasons.some((reason) => reason.includes('hash does not cover its payload')))
  } finally {
    h.close()
  }
})

test('a checkpoint signs the current tip and links to its predecessor', async () => {
  const h = harness()
  try {
    await h.amp.closeTurn(facts())
    const first = await h.amp.checkpoint()
    assert.equal(first.seq, 0)
    assert.equal(first.tenant, 'local')
    assert.equal(first.agent, AMP_AGENT_ID)
    assert.equal(first.prev, undefined)

    await h.amp.closeTurn(facts({ turn: 'test-turn-2', session: 'session-b' }))
    const second = await h.amp.checkpoint()
    assert.equal(second.seq, 1)
    assert.ok(second.prev !== undefined)

    const verify = await h.amp.verify()
    assert.equal(verify.ok, true, verify.reasons.join('; '))

    // Every stored checkpoint body is canonical JSON too.
    const rows = h.db.all<{ body: string }>('SELECT body FROM amp_checkpoint ORDER BY seq ASC')
    assert.equal(rows.length, 2)
    for (const row of rows) assert.equal(row.body, canonical(JSON.parse(row.body)))
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Tool decorator and observers
 * ------------------------------------------------------------------------- */

test('withAmpReceipts passes the definition through and settles each call', async () => {
  const h = harness()
  try {
    const registered: CoordinationToolDefinition[] = []
    const inner: CoordinationToolRegistry = {
      register: (definition) => {
        registered.push(definition)
        return () => undefined
      },
    }
    const receipted = withAmpReceipts(inner, h.amp)
    const definition: CoordinationToolDefinition = {
      name: 'coordination_read',
      description: 'read one bounded range',
      parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: () => ({ ok: true }),
    }
    receipted.register(definition)
    assert.equal(registered.length, 1)
    // The model-facing definition is unchanged.
    assert.equal(registered[0].name, definition.name)
    assert.equal(registered[0].description, definition.description)
    assert.equal(registered[0].parameters, definition.parameters)

    assert.deepEqual(await registered[0].execute({}, undefined), { ok: true })
    await h.amp.flush()
    const receipts = h.amp.receipts(10)
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].op, 'read')
    assert.equal(receipts[0].outcome, 'success')

    const failing: CoordinationToolDefinition = {
      ...definition,
      execute: () => {
        throw new Error('boom')
      },
    }
    receipted.register(failing)
    await assert.rejects(async () => await registered[1].execute({}, undefined), /boom/)
    await h.amp.flush()
    assert.equal(h.amp.receipts(10)[0].outcome, 'failure')
  } finally {
    h.close()
  }
})

test('the observer mirrors ids and numbers, never prose', async () => {
  const h = harness()
  try {
    const bus = new CoordinationEventBus()
    const dispose = h.amp.observe(bus)
    bus.emit('takeover/pending', {
      session: 'session-a',
      type: 'question',
      payload: { questions: [{ id: 'q1', text: 'what is the secret passphrase?' }] },
    })
    await h.amp.flush()
    dispose()

    const events = h.db.all<{ body: string }>('SELECT body FROM amp_object WHERE kind = ? ORDER BY seq ASC', 'event')
    assert.equal(events.length, 1)
    const event = JSON.parse(events[0].body) as { type: string; payload: Record<string, unknown> }
    assert.equal(event.type, 'takeover.pending')
    // The mirrored shape keeps the bus object's own keys; only prose is elided.
    assert.equal(event.payload.session, 'session-a')
    const inner = event.payload.payload as { questions: { id: string; text: string }[] }
    assert.equal(inner.questions[0].id, 'q1')
    assert.equal(inner.questions[0].text, '[text omitted]')

    // A projection never keeps prose or a deep object; id-shaped tokens survive,
    // because the ledger is a store of pointers and that is what a pointer is.
    assert.equal(ledgerProjection('a sentence with spaces'), '[text omitted]')
    assert.equal(ledgerProjection('session-a'), 'session-a')
    assert.deepEqual(ledgerProjection({ n: 1, ok: true, nested: { deep: 'some prose here' } }), {
      n: 1,
      ok: true,
      nested: { deep: '[text omitted]' },
    })
    assert.equal((ledgerProjection({ token: 'public-token-name' }) as { token: string }).token, 'public-token-name')
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Snapshot stability
 * ------------------------------------------------------------------------- */

test('a checkpoint witnesses a prefix: later appends are legal, a shorter chain is not', async () => {
  const h = harness()
  try {
    await h.amp.closeTurn(facts({ turn: 'test-turn-1', session: 'session-a' }))
    const checkpoint = await h.amp.checkpoint()
    const sealedCount = checkpoint.count

    // Appending after sealing must not invalidate the checkpoint.
    await h.amp.closeTurn(facts({ turn: 'test-turn-2', session: 'session-b' }))
    const afterAppend = await h.amp.verify()
    assert.equal(afterAppend.ok, true, afterAppend.reasons.join('; '))
    assert.equal(afterAppend.checkpoint?.count, sealedCount)
    assert.ok(afterAppend.count > sealedCount)

    // Deleting an entry the checkpoint witnessed is detected: the chain is now
    // shorter than the commitment. (Deleting only the *unwitnessed* tail stays
    // undetectable by design — "a clean deletion of the tail produces a
    // shorter, internally valid prefix"; only the next checkpoint closes it.)
    h.db.exec('DROP TRIGGER trg_amp_object_immutable_delete')
    h.db.run('DELETE FROM amp_object WHERE seq = ?', sealedCount - 1)
    const truncated = await h.amp.verify()
    assert.equal(truncated.ok, false)
    // The break surfaces either as a torn chain or as a tip that no longer
    // matches the checkpoint; both name the checkpoint comparison.
    assert.ok(
      truncated.reasons.some((reason) => reason.includes('checkpoint')) ||
        truncated.reasons.some((reason) => reason.includes('out of order')),
      truncated.reasons.join('; '),
    )
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Cognition: comprehension → claims and unknowns
 * ------------------------------------------------------------------------- */

test('a verbatim statement earns T1; a paraphrase stays T0 with no evidence', async () => {
  const h = harness()
  try {
    await h.amp.closeTurn(
      facts({
        cognition: {
          id: 'comprehension-1',
          prompt: 'Refactor the parser and keep the public API stable.',
          intent: 'Refactor the parser',
          requirement: 'keep the public API stable',
          constraint: 'no downtime',
          assumption: 'none',
          ambiguity: 'Which parser module is meant?',
          confidence: 0.8,
          created: 1_700_000_000_000,
        },
      }),
    )
    await h.amp.flush()

    const claims = h.db
      .all<{ body: string }>('SELECT body FROM amp_object WHERE kind = ? ORDER BY seq ASC', 'claim')
      .map((row) => JSON.parse(row.body) as Record<string, unknown>)
    assert.equal(claims.length, 3, 'the "none" placeholder must not become a claim')

    const intent = claims.find((claim) => String(claim.id).endsWith('-intent'))
    assert.ok(intent !== undefined)
    assert.equal(intent.tier, 'T1')
    assert.equal(intent.status, 'held')
    assert.equal(intent.confidence, 0.7)
    const warrant = intent.warrant as { evidence: Record<string, unknown>[]; inference: string }
    assert.equal(warrant.inference, 'deduction')
    assert.equal(warrant.evidence.length, 1)
    assert.equal(warrant.evidence[0].trust, 'asserted')
    assert.equal(warrant.evidence[0].entails, true)
    assert.equal(warrant.evidence[0].excerpt, 'Refactor the parser')
    assert.match(String(warrant.evidence[0].digest), /^sha256:[0-9a-f]{64}$/)

    // Case/whitespace differences still count as verbatim.
    const requirement = claims.find((claim) => String(claim.id).endsWith('-requirement'))
    assert.ok(requirement !== undefined)
    assert.equal(requirement.tier, 'T1')

    // A statement the prompt does not contain is assumed, never sourced.
    const constraint = claims.find((claim) => String(claim.id).endsWith('-constraint'))
    assert.ok(constraint !== undefined)
    assert.equal(constraint.tier, 'T0')
    assert.equal(constraint.status, 'conjecture')
    assert.equal(constraint.confidence, 0.35)
    assert.deepEqual((constraint.warrant as { evidence: unknown[] }).evidence, [])

    const unknowns = h.db
      .all<{ body: string }>('SELECT body FROM amp_object WHERE kind = ? ORDER BY seq ASC', 'unknown')
      .map((row) => JSON.parse(row.body) as Record<string, unknown>)
    assert.equal(unknowns.length, 1)
    assert.equal(unknowns[0].importance, 0.2)
    assert.equal(unknowns[0].blocking, false)
    assert.equal(unknowns[0].status, 'open')

    // The summary event names both the claims and the unknown.
    const summary = h.amp.store
      .entries({ kind: 'event' })
      .map((entry) => entry.payload as { type?: string; payload?: Record<string, unknown> })
      .find((event) => event.type === 'cognition.recorded')
    assert.ok(summary !== undefined)
    assert.equal((summary.payload?.claims as string[]).length, 3)
    assert.ok(typeof summary.payload?.unknown === 'string')

    assert.equal((await h.amp.verify()).ok, true)
  } finally {
    h.close()
  }
})

test('every stored claim passes the warrant validator and ids stay legal', async () => {
  const h = harness()
  try {
    await h.amp.closeTurn(
      facts({
        cognition: {
          id: 'comprehension-2',
          prompt: 'Please summarise this file in one paragraph and cite the source.',
          intent: 'summarise this file in one paragraph',
          requirement: 'cite the source',
          constraint: 'none',
          assumption: 'the file is readable',
          ambiguity: 'none',
          confidence: 0.4,
          created: 1_700_000_000_000,
        },
      }),
    )
    await h.amp.flush()
    const claims = h.db
      .all<{ body: string }>('SELECT body FROM amp_object WHERE kind = ? ORDER BY seq ASC', 'claim')
      .map((row) => JSON.parse(row.body) as Claim)
    assert.ok(claims.length >= 2)
    for (const claim of claims) {
      assert.equal(isId(claim.id), true, `${claim.id} is not a legal AMP id`)
      assert.deepEqual(validateClaim(claim), [])
      assert.ok((claim.confidence ?? 0) > 0)
    }
    // "none" ambiguity and "none" constraint produce neither an unknown nor a claim.
    assert.equal(
      h.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM amp_object WHERE kind = ?', 'unknown')?.count,
      0,
    )
  } finally {
    h.close()
  }
})

test('the chain survives a reopen with the same tip and a clean verdict', async () => {
  const workspace = harness()
  try {
    await workspace.amp.openTurn(facts())
    await workspace.amp.closeTurn(facts({ finished: 1_700_000_001_000 }))
    const before = workspace.amp.store.snapshot(AMP_AGENT_ID)
    const verdict = verifySnapshot(before)
    assert.equal(verdict.ok, true, verdict.reasons.join('; '))

    // Rebuilding the service over the same database re-reads the same chain.
    const reopened = new AmpService({
      db: workspace.db,
      config: testConfig(),
      handles: new HandleGenerator('test'),
      clock: workspace.clock,
      capabilities: COORDINATION_CAPABILITIES,
    })
    const after = reopened.store.snapshot(AMP_AGENT_ID)
    assert.equal(after.tip, before.tip)
    assert.equal(after.count, before.count)
    assert.equal((await reopened.verify()).ok, true)
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Attention requests and interrupts
 * ------------------------------------------------------------------------- */

test('a window becomes an attention request, an interrupt record and an ask receipt', async () => {
  const h = harness()
  try {
    const request = await h.amp.requestAttention({
      handle: 'coordination-takeover-1',
      type: 'approval',
      tool: 'bash',
      requestedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_030_000,
    })
    assert.equal(request.class, 'commitment')
    assert.equal(request.urgency, 4)
    assert.deepEqual(request.to, { kind: 'human', id: 'local-user' })
    assert.deepEqual(request.target, { kind: 'tool', id: 'bash' })
    assert.equal(request.expires, '2023-11-14T22:13:50.000Z')
    assert.deepEqual(request.cost, { interrupts: 1 })

    const record = await h.amp.recordInterrupt({
      handle: 'coordination-takeover-1',
      type: 'approval',
      tool: 'bash',
      requestedAt: 1_700_000_000_000,
      settledAt: 1_700_000_005_000,
      outcome: 'granted',
    })
    assert.equal(record.status, 'granted')
    assert.equal(record.granted, true)
    assert.equal(record.debt_weight, 4)
    assert.deepEqual(record.cost, { interrupts: 1 })
    assert.equal(record.reason, 'human granted the call once')

    const ask = h.amp.receipts(5).find((receipt) => receipt.op === 'ask')
    assert.ok(ask !== undefined)
    assert.equal(ask.id, record.receipt)
    assert.equal(ask.outcome, 'success')
    assert.equal(ask.ms, 5000)
    assert.deepEqual(ask.usage, { interrupts: 1, ms: 5000 })
    assert.deepEqual(ask.target, { kind: 'tool', id: 'bash' })

    // A question is curiosity, and an expired window costs no interrupt.
    const question = await h.amp.requestAttention({
      handle: 'coordination-takeover-2',
      type: 'question',
      requestedAt: 1_700_000_000_000,
    })
    assert.equal(question.class, 'curiosity')
    assert.equal(question.urgency, 3)
    assert.equal(question.target.kind, 'question')

    const expired = await h.amp.recordInterrupt({
      handle: 'coordination-takeover-2',
      type: 'question',
      requestedAt: 1_700_000_000_000,
      settledAt: 1_700_000_030_000,
      outcome: 'expired',
    })
    assert.equal(expired.granted, false)
    assert.deepEqual(expired.cost, { interrupts: 0 })
    const expiredReceipt = h.amp.receipts(5).find((receipt) => receipt.id === expired.receipt)
    assert.ok(expiredReceipt !== undefined)
    assert.equal(expiredReceipt.outcome, 'partial')
    assert.deepEqual(expiredReceipt.usage, { interrupts: 0, ms: 30000 })

    const events = h.amp.store
      .entries({ kind: 'event' })
      .map((entry) => entry.payload as { type?: string })
    assert.deepEqual(events.map((event) => event.type), [
      'attention.requested',
      'interrupt.settled',
      'attention.requested',
      'interrupt.settled',
    ])
    assert.equal((await h.amp.verify()).ok, true)
  } finally {
    h.close()
  }
})


/* ------------------------------------------------------------------------- *
 * Plan artifacts
 * ------------------------------------------------------------------------- */

const planFacts = (over: Partial<import('../src/host/amp.js').AmpPlanFacts> = {}) => ({
  plan: { handle: 'test-plan-1', created: 1_700_000_000_000, status: 'active', constraint: 'stop if the build breaks' },
  goal: { handle: 'test-goal-1', content: 'ship the release notes' },
  steps: [
    { statement: 'draft the notes', expect: 'a draft exists in the notes file' },
    { statement: 'review the draft', expect: 'the review checklist is complete' },
  ],
  ...over,
})

test('a plan with recorded acceptance becomes a goal and a plan on the chain', async () => {
  const h = harness()
  try {
    await h.amp.closeTurn(facts({ turn: 'test-turn-plan', planFacts: planFacts() }))
    await h.amp.flush()

    const goals = h.db
      .all<{ body: string }>('SELECT body FROM amp_object WHERE kind = ? ORDER BY seq ASC', 'goal')
      .map((row) => JSON.parse(row.body) as Record<string, unknown>)
    const plans = h.db
      .all<{ body: string }>('SELECT body FROM amp_object WHERE kind = ? ORDER BY seq ASC', 'plan')
      .map((row) => JSON.parse(row.body) as Record<string, unknown>)
    assert.equal(goals.length, 1)
    assert.equal(plans.length, 1)

    const goal = goals[0] as { id: string; success: { statement: string; check: string }[]; value: number }
    assert.equal(goal.id, 'goal-test-goal-1')
    assert.equal(goal.success.length, 2)
    assert.equal(goal.success[0].statement, 'a draft exists in the notes file')
    assert.equal(goal.value, 0.5)

    const plan = plans[0] as {
      id: string
      goal: { id: string }
      tasks: { id: string; expect: { observation: string; check: string } }[]
      edges: string[][]
      abandon_if: { statement: string }[]
      status: string
    }
    assert.equal(plan.id, 'plan-test-plan-1')
    assert.deepEqual(plan.goal, { kind: 'goal', id: 'goal-test-goal-1' })
    assert.equal(plan.tasks.length, 2)
    assert.equal(plan.tasks[0].expect.observation, 'a draft exists in the notes file')
    assert.equal(plan.tasks[0].expect.check, 'a draft exists in the notes file')
    assert.equal(plan.edges.length, 1)
    assert.equal(plan.abandon_if[0].statement, 'stop if the build breaks')
    assert.equal(plan.status, 'executing')

    const recorded = h.amp.store
      .entries({ kind: 'event' })
      .map((entry) => entry.payload as { type?: string; payload?: Record<string, unknown> })
      .find((event) => event.type === 'plan.recorded')
    assert.ok(recorded !== undefined)
    assert.equal(recorded.payload?.tasks, 2)
    assert.equal((await h.amp.verify()).ok, true)
  } finally {
    h.close()
  }
})

test('a plan without per-step acceptance is deferred, never invented', async () => {
  const h = harness()
  try {
    await h.amp.closeTurn(
      facts({
        turn: 'test-turn-plan-2',
        planFacts: planFacts({
          steps: [
            { statement: 'draft the notes', expect: 'a draft exists' },
            { statement: 'review the draft', expect: '' },
          ],
        }),
      }),
    )
    await h.amp.flush()

    assert.equal(h.db.count('amp_object') >= 0, true)
    const kinds = h.amp.store.entries().filter((entry) => entry.kind === 'goal' || entry.kind === 'plan')
    assert.equal(kinds.length, 0, 'a plan missing an expectation must not be stored')

    const deferred = h.amp.store
      .entries({ kind: 'event' })
      .map((entry) => entry.payload as { type?: string; payload?: Record<string, unknown> })
      .find((event) => event.type === 'plan.deferred')
    assert.ok(deferred !== undefined)
    assert.equal(deferred.payload?.reason, 'missing-expect')
  } finally {
    h.close()
  }
})

test('a plan without a goal or a constraint is deferred with the recorded reason', async () => {
  const h = harness()
  try {
    await h.amp.closeTurn(facts({ turn: 'test-turn-plan-3', planFacts: planFacts({ goal: undefined }) }))
    await h.amp.closeTurn(
      facts({
        turn: 'test-turn-plan-4',
        planFacts: planFacts({ plan: { ...planFacts().plan, handle: 'test-plan-2', constraint: '  ' } }),
      }),
    )
    await h.amp.flush()
    const reasons = h.amp.store
      .entries({ kind: 'event' })
      .map((entry) => entry.payload as { type?: string; payload?: Record<string, unknown> })
      .filter((event) => event.type === 'plan.deferred')
      .map((event) => event.payload?.reason)
    assert.deepEqual(reasons, ['missing-goal', 'missing-abandon-if'])
    assert.equal(h.amp.store.entries().filter((entry) => entry.kind === 'plan').length, 0)
  } finally {
    h.close()
  }
})
