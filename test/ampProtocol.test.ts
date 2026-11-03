/**
 * AMP v0.1 kernel conformance.
 *
 * These tests pin the rules the refactor depends on, each stated by the
 * reference implementation in `attention-manifest-protocol`:
 *
 *  - canonical JSON + digest (`S-1`), id grammar (`B-1`);
 *  - the frame boundary: required `why` (`A-1`), nine-slot ceiling (`F-2`),
 *    computed digest (`F-3`), no silent drops (`F-7`), budget accounting (`F-6`);
 *  - confidence derivation and tier gates (`M-1`, `W-4`, `W-5`);
 *  - envelope sealing, tamper detection, expiry, version negotiation and the
 *    receiver's FIFO/cancel rules (`P-3`…`P-10`);
 *  - ledger hashing, snapshot verification and checkpoint signing (`X-2`,
 *    `X-5`, `X-7`).
 *
 * No database and no DSH: every case is pure protocol.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BoundaryRejection,
  AppendLog,
  MemoryAppendSink,
  EnvelopeRuntime,
  RefTable,
  Ledger,
  buildAttentionRequest,
  buildInterruptRecord,
  canonical,
  canAuthorizeEffect,
  checkpointDigest,
  deriveConfidence,
  digestOf,
  effectiveOrigins,
  envelopeDigest,
  exportSnapshot,
  frameFrom,
  generateSigningKey,
  idFrom,
  interruptOutcome,
  isId,
  makeEvent,
  makeReceipt,
  negotiateVersion,
  pressureBlocked,
  reviseClaim,
  sealCheckpoint,
  sealEnvelope,
  signManifest,
  suggestTier,
  assertPlan,
  validateAttentionRequest,
  validateGoal,
  validatePlan,
  validateClaim,
  validateHypothesis,
  validateInterruptRecord,
  verifyCheckpoint,
  verifyEnvelope,
  verifyEventDigest,
  verifyFrameDigest,
  verifyManifest,
  verifySnapshot,
  type Claim,
  type Frame,
  type FrameDraft,
  type Hypothesis,
  type Receipt,
  type SealedEnvelope,
} from '../src/protocol/index.js'

const refs = (): RefTable => {
  const table = RefTable.forScope('run', 'agent-a')
  table.add('task', 'turn-1', {})
  table.add('goal', 'goal-1', {})
  table.add('concept', 'profession-execution', {})
  table.add('concept', 'policy-max-iteration', {})
  table.add('concept', 'policy-allow-bash', {})
  return table
}

const slot = (over: Record<string, unknown> = {}) => ({
  target: { kind: 'task' as const, id: 'turn-1' },
  role: 'process' as const,
  salience: 0.9,
  cost: { tokens: 0 },
  why: 'the turn is the task under attention',
  state: 'active' as const,
  ...over,
})

const draft = (over: Partial<FrameDraft> = {}): FrameDraft => ({
  id: 'frame-turn-1',
  agent: 'agent-a',
  cycle: 1,
  mode: 'exploit',
  slots: [slot()],
  budget: { allocated: { ms: 30_000 }, spent: {} },
  ...over,
})

/* ------------------------------------------------------------------------- *
 * Canonical JSON and ids
 * ------------------------------------------------------------------------- */

test('canonical JSON sorts keys, keeps array order and maps undefined to null', () => {
  assert.equal(canonical({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}')
  assert.equal(canonical({ a: undefined }), '{"a":null}')
  assert.equal(canonical([1, { z: true, a: false }]), '[1,{"a":false,"z":true}]')
  assert.equal(canonical(undefined), 'null')
  // Two object literals with different insertion order must digest identically.
  assert.equal(digestOf({ x: 1, y: 2 }), digestOf({ y: 2, x: 1 }))
  assert.match(digestOf({ x: 1 }), /^sha256:[0-9a-f]{64}$/)
})

test('the id grammar accepts underscore but rejects uppercase, empty and over-long ids', () => {
  assert.equal(isId('profession-execution'), true)
  // Underscores ARE legal in AMP ids, so a model-facing tool name is a usable id.
  assert.equal(isId('coordination_read'), true)
  assert.equal(isId('Coordination'), false)
  assert.equal(isId(''), false)
  assert.equal(isId(`a${'b'.repeat(64)}`), false)
  assert.equal(isId(`a${'b'.repeat(63)}`), true)
  // idFrom repairs anything the grammar would reject.
  const repaired = idFrom('Coordination Read!', 'tool')
  assert.equal(repaired, 'tool-coordination-read')
  assert.equal(isId(repaired), true)
  assert.equal(isId(idFrom('')), true)
})

/* ------------------------------------------------------------------------- *
 * Frame boundary
 * ------------------------------------------------------------------------- */

test('frameFrom computes the digest and settles a valid draft', () => {
  const { frame, deferred } = frameFrom(draft(), refs(), { now: () => '2026-01-01T00:00:00.000Z' })
  assert.equal(frame.amp, '0.1')
  assert.equal(frame.kind, 'frame')
  assert.equal(frame.ts, '2026-01-01T00:00:00.000Z')
  assert.equal(deferred.length, 0)
  assert.match(frame.digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(verifyFrameDigest(frame), true)
  // A supplied digest must not survive: frameFrom recomputes it.
  const { frame: recomputed } = frameFrom(draft(), refs())
  assert.equal(recomputed.kind, 'frame')
})

test('frameFrom accumulates every problem and throws one BoundaryRejection', () => {
  const bad: FrameDraft = draft({
    cycle: -1,
    slots: [
      slot({ why: '   ' }),
      slot({ salience: 2 }),
      slot({ role: 'nonsense' as never }),
    ],
  })
  try {
    frameFrom(bad, refs())
    assert.fail('frameFrom should have thrown')
  } catch (error) {
    assert.ok(error instanceof BoundaryRejection)
    assert.equal(error.code, 'invalid_frame')
    assert.ok(error.problems.length >= 3, `expected several problems, got ${error.problems.join(' | ')}`)
    assert.ok(error.problems.some((problem) => problem.includes('why is empty')))
    assert.ok(error.problems.some((problem) => problem.includes('salience must be in')))
  }
})

test('frameFrom refuses more than nine slots and cannot be told to allow more', () => {
  const ten = Array.from({ length: 10 }, () => slot())
  assert.throws(() => frameFrom(draft({ slots: ten }), refs()), /slots has 10 entries, max is 9/)
  assert.throws(() => frameFrom(draft({ slots: ten }), refs(), { maxSlots: 12 }), /maxSlots must be an integer in \[0,9\]/)
  // Lowering the ceiling is allowed.
  assert.throws(() => frameFrom(draft({ slots: ten.slice(0, 3) }), refs(), { maxSlots: 2 }), /max is 2/)
})

test('frameFrom rejects an unresolvable ref and returns overflow exclusions as deferred', () => {
  const unknownTarget = draft({
    slots: [slot({ target: { kind: 'claim', id: 'claim-missing' } })],
  })
  assert.throws(() => frameFrom(unknownTarget, refs()), (error: unknown) => {
    assert.ok(error instanceof BoundaryRejection)
    assert.ok(error.problems.some((problem) => problem.includes('claim:claim-missing')))
    return true
  })

  const ignored = Array.from({ length: 3 }, (_unused, index) => ({
    target: { kind: 'concept' as const, id: 'policy-max-iteration' },
    reason: 'blocked' as const,
    revisit_if: `trigger ${index}`,
  }))
  const { frame, deferred } = frameFrom(draft({ ignored }), refs(), { maxIgnored: 1 })
  assert.equal(frame.ignored?.length, 1)
  assert.equal(deferred.length, 2)
  assert.deepEqual(deferred.map((item) => item.revisit_if), ['trigger 1', 'trigger 2'])
})

test('frameFrom rejects an over-spent budget per dimension', () => {
  assert.throws(
    () => frameFrom(draft({ budget: { allocated: { ms: 10 }, spent: { ms: 11 } } }), refs()),
    /budget\.spent\.ms exceeds budget\.allocated\.ms/,
  )
  assert.throws(() => frameFrom(draft({ budget: { allocated: {}, spent: {} } }), refs()), /at least one dimension/)
})

test('verifyFrameDigest notices a rewritten field', () => {
  const { frame } = frameFrom(draft(), refs())
  const tampered: Frame = { ...frame, note: 'rewritten' }
  assert.equal(verifyFrameDigest(tampered), false)
})

/* ------------------------------------------------------------------------- *
 * Warrant
 * ------------------------------------------------------------------------- */

const claimOf = (over: Partial<Claim> = {}): Claim => ({
  amp: '0.1',
  kind: 'claim',
  id: 'claim-1',
  statement: 'the parser is deterministic',
  tier: 'T2',
  status: 'held',
  warrant: {
    evidence: [
      {
        id: 'evidence-1',
        kind: 'observation',
        trust: 'self',
        independence: 0.5,
        relation: 'supports',
        at: '2026-01-01T00:00:00.000Z',
      },
    ],
    inference: 'observation',
    strength: 0.5,
  },
  provenance: { source: 'test', kind: 'observation', trust: 'self' },
  created: '2026-01-01T00:00:00.000Z',
  ...over,
})

test('confidence is derived from tier and evidence, never authored', () => {
  // T2 base 0.72 + 0.1*0.5 independence + 0.08*0.5 support = 0.81
  assert.equal(deriveConfidence(claimOf()), 0.81)
  // No evidence caps at 0.6 even for T3.
  assert.equal(
    deriveConfidence({ tier: 'T3', warrant: { evidence: [], inference: 'observation', strength: 0 } }),
    0.6,
  )
  // Trust caps the result: an external source cannot support a T4 claim.
  const external = claimOf({
    tier: 'T4',
    warrant: {
      evidence: [
        { id: 'e1', kind: 'document', trust: 'external', independence: 1, origin: 'a', at: '2026-01-01T00:00:00.000Z' },
        { id: 'e2', kind: 'document', trust: 'external', independence: 1, origin: 'b', at: '2026-01-01T00:00:00.000Z' },
      ],
      inference: 'observation',
      strength: 1,
    },
  })
  assert.ok(deriveConfidence(external) <= 0.5)
  assert.equal(effectiveOrigins(external.warrant.evidence), 2)
  // Ten retellings of one origin are one origin.
  const retold = external.warrant.evidence.map((item) => ({ ...item, origin: 'a' }))
  assert.equal(effectiveOrigins(retold), 1)
})

test('validateClaim enforces the tier gates', () => {
  assert.deepEqual(validateClaim(claimOf()), [])
  const noEvidence = claimOf({
    tier: 'T1',
    warrant: { evidence: [], inference: 'testimony', strength: 0 },
  })
  assert.ok(validateClaim(noEvidence).some((problem) => problem.includes('at least one evidence item')))

  const t1Mention = claimOf({
    tier: 'T1',
    warrant: {
      evidence: [{ id: 'e', kind: 'document', trust: 'trusted', independence: 0.5, at: '2026-01-01T00:00:00.000Z' }],
      inference: 'testimony',
      strength: 0.5,
    },
  })
  assert.ok(validateClaim(t1Mention).some((problem) => problem.includes('entails')))

  const t2External = claimOf({
    warrant: {
      evidence: [{ id: 'e', kind: 'document', trust: 'external', independence: 1, at: '2026-01-01T00:00:00.000Z' }],
      inference: 'testimony',
      strength: 1,
    },
  })
  assert.ok(validateClaim(t2External).some((problem) => problem.includes('observation recorded by this agent')))

  const t3Observed = claimOf({ tier: 'T3', causal: { assignment_mechanism: 'observed' } })
  assert.ok(validateClaim(t3Observed).some((problem) => problem.includes('intervention')))

  const t4OneOrigin = claimOf({ tier: 'T4' })
  assert.ok(validateClaim(t4OneOrigin).some((problem) => problem.includes('independent replication')))
})

test('a hypothesis without a falsifier is rejected and preregistration decides its class', () => {
  const hypothesis: Hypothesis = {
    amp: '0.1',
    kind: 'hypothesis',
    id: 'hypothesis-1',
    question: { kind: 'question', id: 'question-1' },
    statement: 'the cache is bounded',
    prediction: 'memory stays flat',
    refutes_if: '',
    status: 'proposed',
    created: '2026-01-01T00:00:00.000Z',
  }
  assert.ok(validateHypothesis(hypothesis).some((problem) => problem.includes('refutes_if')))
  assert.deepEqual(validateHypothesis({ ...hypothesis, refutes_if: 'memory grows without bound' }), [])
  assert.equal(pressureBlocked(claimOf(), [], true), true)
  assert.equal(pressureBlocked(claimOf(), claimOf().warrant.evidence, true), false)
})

test('canAuthorizeEffect requires held status, the tier floor and 0.6 confidence', () => {
  assert.equal(canAuthorizeEffect(claimOf(), 'T2'), true)
  assert.equal(canAuthorizeEffect(claimOf({ status: 'doubted' }), 'T2'), false)
  assert.equal(canAuthorizeEffect(claimOf(), 'T3'), false)
  assert.equal(
    canAuthorizeEffect(
      claimOf({
        warrant: { evidence: [], inference: 'assumption' as never, strength: 0 },
      }),
      'T0',
    ),
    true,
  )
})

test('reviseClaim keeps history instead of overwriting it', () => {
  const previous = claimOf()
  const revised = reviseClaim(previous, { tier: 'T3' }, 'new intervention', '2026-02-01T00:00:00.000Z')
  assert.equal(revised.id, 'claim-1.r1')
  assert.equal(revised.supersedes?.id, 'claim-1')
  assert.equal(revised.created, previous.created)
  assert.equal(revised.revision?.reason, 'new intervention')
  assert.equal(suggestTier([]), 'T0')
  assert.equal(suggestTier(claimOf().warrant.evidence), 'T2')
})

/* ------------------------------------------------------------------------- *
 * Envelope
 * ------------------------------------------------------------------------- */

test('a sealed envelope verifies, and any tampering breaks the signature', async () => {
  const key = await generateSigningKey('key-1')
  const sealed = await sealEnvelope(
    {
      from: { kind: 'agent', id: 'agent-a' },
      to: { kind: 'agent', id: 'agent-b' },
      thread: 'thread-1',
      type: 'inform',
      payload: { note: 'hello' },
    },
    key,
  )
  assert.equal(sealed.amp, '0.1')
  assert.equal(sealed.kind, 'envelope')
  assert.equal(sealed.seq, 0)
  assert.equal(sealed.version.min, '0.1')
  assert.match(sealed.sig, /^[A-Za-z0-9_-]+$/)

  const good = await verifyEnvelope(sealed, key.publicKey, { now: sealed.sent })
  assert.deepEqual(good, { ok: true, reasons: [] })

  const tampered: SealedEnvelope = { ...sealed, payload: { note: 'goodbye' } }
  const bad = await verifyEnvelope(tampered, key.publicKey, { now: sealed.sent })
  assert.equal(bad.ok, false)
  assert.ok(bad.reasons.includes('signature does not verify'))
  assert.notEqual(envelopeDigest(sealed), envelopeDigest(tampered))
})

test('expiry, version intersection and TTL validation follow the reference', async () => {
  const key = await generateSigningKey('key-1')
  const base = {
    from: { kind: 'agent' as const, id: 'agent-a' },
    to: { kind: 'agent' as const, id: 'agent-b' },
    thread: 'thread-1',
    type: 'inform' as const,
    payload: {},
  }
  const sealed = await sealEnvelope(
    { ...base, sent: '2026-01-01T00:00:00.000Z', ttlMs: 1000 },
    key,
  )
  assert.equal(sealed.expires, '2026-01-01T00:00:01.000Z')
  assert.equal((await verifyEnvelope(sealed, key.publicKey, { now: '2026-01-01T00:00:02.000Z' })).ok, false)
  assert.equal(
    (await verifyEnvelope(sealed, key.publicKey, { now: '2026-01-01T00:00:02.000Z', clockSkewMs: 1000 })).ok,
    true,
  )
  assert.equal(
    (await verifyEnvelope(sealed, key.publicKey, {
      now: '2026-01-01T00:00:00.000Z',
      expectedVersion: { min: '0.2', max: '0.3' },
    })).reasons.includes('version ranges do not intersect'),
    true,
  )
  await assert.rejects(sealEnvelope({ ...base, ttlMs: -1 }, key), /ttlMs/)
  assert.equal(negotiateVersion({ min: '0.1', max: '0.4' }, { min: '0.2', max: '0.9' })?.min, '0.2')
  assert.equal(negotiateVersion({ min: '0.1', max: '0.1' }, { min: '0.2', max: '0.2' }), null)
})

test('the envelope runtime enforces FIFO, reports gaps and applies cancel tombstones', async () => {
  const key = await generateSigningKey('key-1')
  const runtime = new EnvelopeRuntime({
    now: () => '2026-01-01T00:00:00.000Z',
    version: { min: '0.1', max: '0.1' },
  })
  const base = {
    from: { kind: 'agent' as const, id: 'agent-a' },
    to: { kind: 'agent' as const, id: 'agent-b' },
    thread: 'thread-1',
  }
  const at = (seq: number, type: 'inform' | 'commit' | 'cancel', payload: unknown, id?: string) =>
    sealEnvelope({ ...base, type, seq, payload, sent: '2026-01-01T00:00:00.000Z', ...(id === undefined ? {} : { id }) }, key)

  const second = await at(2, 'inform', { n: 2 })
  const gap = await runtime.receive(second, key.publicKey)
  assert.equal(gap.status, 'out_of_order')
  assert.equal(runtime.pending.length, 1)

  const first = await at(0, 'inform', { n: 0 })
  assert.equal((await runtime.receive(first, key.publicKey)).status, 'accepted')
  // seq 1 is still missing, so 2 stays queued.
  assert.equal(runtime.delivered.length, 1)
  assert.equal((await runtime.receive(await at(1, 'inform', { n: 1 }), key.publicKey)).status, 'accepted')
  assert.equal(runtime.delivered.length, 3)
  assert.equal(runtime.pending.length, 0)

  const cancel = await at(3, 'cancel', { targetId: 'target-1' }, 'cancel-1')
  assert.equal((await runtime.receive(cancel, key.publicKey)).status, 'accepted')
  const suppressed = await at(4, 'commit', { ok: true }, 'target-1')
  assert.equal((await runtime.receive(suppressed, key.publicKey)).status, 'cancelled')
  assert.equal(runtime.cancelled.length, 1)

  // Replaying the exact envelope is a duplicate, not a second delivery.
  assert.equal((await runtime.receive(first, key.publicKey)).status, 'duplicate')
})

/* ------------------------------------------------------------------------- *
 * Ledger
 * ------------------------------------------------------------------------- */

const receiptOf = (id: string, at: string): Receipt =>
  makeReceipt({ id, op: 'read', outcome: 'success', at, usage: { calls: 1 } })

test('receipts and events are validated at construction', () => {
  const receipt = receiptOf('receipt-1', '2026-01-01T00:00:00.000Z')
  assert.equal(receipt.amp, '0.1')
  assert.throws(() => makeReceipt({ id: 'receipt-1', op: 'read', outcome: 'success', ms: -1 }), /ms/)
  assert.throws(
    () => makeReceipt({ id: 'receipt-1', op: 'read', outcome: 'success', predicted_voi: 2 }),
    /predicted_voi/,
  )
  assert.throws(() => makeReceipt({ id: 'Receipt-1', op: 'read', outcome: 'success' }), /id/)

  const event = makeEvent({
    id: 'event-1',
    actor: { kind: 'agent', id: 'agent-a' },
    type: 'turn.opened',
    at: '2026-01-01T00:00:00.000Z',
    payload: { session: 'session-1' },
  })
  assert.equal(verifyEventDigest(event), true)
  assert.equal(verifyEventDigest({ ...event, type: 'turn.closed' }), false)
})

test('a snapshot is a single verifiable chain and a tampered entry fails', () => {
  const ledger = new Ledger()
  ledger.appendReceipt(receiptOf('receipt-1', '2026-01-01T00:00:02.000Z'))
  ledger.appendEvent(
    makeEvent({
      id: 'event-1',
      actor: { kind: 'agent', id: 'agent-a' },
      type: 'turn.opened',
      at: '2026-01-01T00:00:01.000Z',
    }),
  )
  const snapshot = exportSnapshot(ledger.contents(), 'agent-a')
  assert.equal(snapshot.kind, 'ledger-snapshot')
  assert.equal(snapshot.count, 2)
  // Chronological order: the event at :01 sorts before the receipt at :02.
  assert.equal(snapshot.entries[0].kind, 'event')
  assert.deepEqual(verifySnapshot(snapshot), { ok: true, reasons: [] })

  const tampered = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot
  const payload = tampered.entries[1].payload as Record<string, unknown>
  payload.outcome = 'failure'
  const verdict = verifySnapshot(tampered)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reasons.some((reason) => reason.includes('hash does not cover its payload')))

  const truncated = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot
  truncated.entries.pop()
  assert.equal(verifySnapshot(truncated).ok, false)
})

test('the append log reopens from its sink only when the chain verifies', async () => {
  const sink = new MemoryAppendSink()
  const log = await AppendLog.open(sink, 'agent-a')
  await log.append('event', { n: 1 })
  await log.append('receipt', { n: 2 })
  assert.equal(log.count, 2)
  assert.equal(sink.lines.length, 2)
  assert.deepEqual(log.verify(), { ok: true, reasons: [] })

  const reopened = await AppendLog.open(sink, 'agent-a')
  assert.equal(reopened.count, 2)
  assert.equal(reopened.tip, log.tip)

  const corrupt = new MemoryAppendSink([...sink.lines.slice(0, 1), '{"not":"an entry"}'])
  await assert.rejects(AppendLog.open(corrupt, 'agent-a'), /failed verification/)
})

test('checkpoints sign a domain-separated body and chain their own sequence', async () => {
  const key = await generateSigningKey('key-1')
  const ledger = new Ledger()
  ledger.appendReceipt(receiptOf('receipt-1', '2026-01-01T00:00:00.000Z'))
  const snapshot = exportSnapshot(ledger.contents(), 'agent-a')

  const first = await sealCheckpoint(snapshot, key, { tenant: 'tenant-a', issued: '2026-01-01T01:00:00.000Z' })
  assert.equal(first.seq, 0)
  assert.equal(first.prev, undefined)
  assert.equal((await verifyCheckpoint(first, key.publicKey)).ok, true)

  const second = await sealCheckpoint(snapshot, key, { tenant: 'tenant-a', previous: first })
  assert.equal(second.seq, 1)
  assert.equal(second.prev, checkpointDigest(first))
  assert.equal((await verifyCheckpoint(second, key.publicKey, first)).ok, true)
  // A different predecessor must be refused.
  const forgedPrevious = { ...first, seq: 5 }
  assert.equal((await verifyCheckpoint(second, key.publicKey, forgedPrevious)).ok, false)

  const moved = { ...first, tenant: 'tenant-b' }
  assert.equal((await verifyCheckpoint(moved, key.publicKey)).ok, false)
})

/* ------------------------------------------------------------------------- *
 * Manifest
 * ------------------------------------------------------------------------- */

test('a signed manifest covers its digest and refuses a tampered body', async () => {
  const key = await generateSigningKey('key-1')
  const manifest = await signManifest(
    {
      amp: '0.1',
      kind: 'manifest',
      agent: { id: 'agent-a', name: 'test' },
      issued: '2026-01-01T00:00:00.000Z',
      expires: '2026-01-02T00:00:00.000Z',
      capabilities: [],
      attention: { policy_digest: digestOf({ policy: 1 }), budget: { ms: 1000 } },
      self: { calibration: { ece: 1 } },
    },
    key,
  )
  assert.match(manifest.digest, /^sha256:/)
  assert.equal(manifest.signatures.length, 1)
  assert.equal(manifest.signatures[0].role, 'self')
  assert.deepEqual(await verifyManifest(manifest, key.publicKey), { ok: true, reasons: [] })

  const tampered = { ...manifest, self: { calibration: { ece: 0 } } }
  const verdict = await verifyManifest(tampered, key.publicKey)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reasons.includes('digest does not cover the manifest content'))

  const unsigned = { ...manifest, signatures: [] }
  assert.deepEqual((await verifyManifest(unsigned, key.publicKey)).reasons, ['missing self signature'])
})

/* ------------------------------------------------------------------------- *
 * Attention requests and interrupts
 * ------------------------------------------------------------------------- */

test('an attention request and its interrupt record validate as objects', () => {
  const request = buildAttentionRequest({
    id: 'attention-window-1',
    from: { kind: 'agent', id: 'deepseek-coordination' },
    to: { kind: 'human', id: 'local-user' },
    target: { kind: 'tool', id: 'bash' },
    class: 'commitment',
    urgency: 4,
    why_now: 'the call is blocked',
    if_ignored: 'it delegates to the host default',
  })
  assert.equal(request.kind, 'attention-request')
  assert.deepEqual(request.cost, { interrupts: 1 })
  assert.equal(request.fallback, 'escalate')
  assert.deepEqual(validateAttentionRequest(request), [])

  assert.throws(
    () => buildAttentionRequest({ ...request, urgency: 0 as never }),
    /urgency must be an integer in \[1,5\]/,
  )
  assert.throws(
    () => buildAttentionRequest({ ...request, fallback: 'later' as never }),
    /fallback is not queue\|drop\|escalate/,
  )

  const record = buildInterruptRecord({
    id: 'interrupt-window-1',
    request: request.id,
    class: request.class,
    target: request.target,
    urgency: 4,
    status: 'granted',
    at: '2026-01-01T00:00:00.000Z',
    reason: 'human granted the call once',
    receipt: 'ask-receipt-window-1',
  })
  assert.equal(record.granted, true)
  assert.equal(record.debt_weight, 4)
  assert.deepEqual(validateInterruptRecord(record), [])

  // `granted` is derived from `status`, so a contradictory pair can never exist.
  const contradictory = { ...record, status: 'denied' as const }
  assert.ok(validateInterruptRecord(contradictory).some((problem) => problem.includes('granted disagrees')))

  assert.equal(interruptOutcome('granted'), 'success')
  assert.equal(interruptOutcome('answered'), 'success')
  assert.equal(interruptOutcome('denied'), 'blocked')
  assert.equal(interruptOutcome('expired'), 'partial')
  assert.equal(interruptOutcome('withdrawn'), 'partial')
  assert.equal(interruptOutcome('deferred'), 'partial')
})

/* ------------------------------------------------------------------------- *
 * Plan and goal
 * ------------------------------------------------------------------------- */

test('a goal without an observable success criterion is rejected', () => {
  const base = {
    amp: '0.1' as const,
    kind: 'goal' as const,
    id: 'goal-1',
    statement: 'ship the protocol layer',
    value: 0.5,
    priority: 1,
  }
  assert.ok(validateGoal({ ...base, success: [] }).some((problem) => problem.includes('at least one observable')))
  assert.deepEqual(
    validateGoal({
      ...base,
      success: [{ id: 'criterion-1', statement: 'tests pass', check: 'npm test', kind: 'assert' }],
    }),
    [],
  )
  assert.ok(
    validateGoal({
      ...base,
      success: [{ id: 'criterion-1', statement: 'tests pass', check: '', kind: 'assert' }],
    }).some((problem) => problem.includes('check is empty')),
  )
})

test('a plan task without an expectation makes the plan unmonitorable', () => {
  const task = {
    id: 'plan-task-1',
    intent: 'write the file',
    actor: 'self' as const,
    pre: [],
    expect: { observation: 'the file exists', check: 'stat the path' },
    irreversibility: 1 as const,
    status: 'pending' as const,
  }
  const plan = {
    amp: '0.1' as const,
    kind: 'plan' as const,
    id: 'plan-1',
    goal: { kind: 'goal' as const, id: 'goal-1' },
    tasks: [task],
    edges: [],
    commitment_window: 1,
    budget: { ms: 1000 },
    abandon_if: [{ id: 'criterion-abandon', statement: 'the task is blocked', check: 'the lock is held', kind: 'assert' as const }],
    status: 'draft' as const,
    created: '2026-01-01T00:00:00.000Z',
  }
  assert.deepEqual(validatePlan(plan), [])
  assert.ok(
    validatePlan({ ...plan, tasks: [{ ...task, expect: { observation: '', check: 'stat' } }] }).some((problem) =>
      problem.includes('expected observation'),
    ),
  )
  assert.ok(
    validatePlan({ ...plan, tasks: [{ ...task, expect: { observation: 'exists', check: '' } }] }).some((problem) =>
      problem.includes('expect.check is empty'),
    ),
  )
  assert.ok(validatePlan({ ...plan, abandon_if: [] }).some((problem) => problem.includes('abandon_if')))
  assert.ok(
    validatePlan({ ...plan, tasks: [task, { ...task }] }).some((problem) => problem.includes('duplicated')),
  )
  assert.ok(
    validatePlan({ ...plan, tasks: [{ ...task, irreversibility: 4 as never }] }).some((problem) =>
      problem.includes('irreversibility'),
    ),
  )
  assert.throws(
    () => assertPlan({ ...plan, tasks: [] }),
    /at least one task/,
  )
})

