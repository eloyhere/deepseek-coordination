import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CHANNEL_BUDGETS,
  DEFAULT_MAX_ITEMS,
  TRUST_CLASSES,
  WIRE_CHANNELS,
  WIRE_EXCLUSION_REASONS,
  WIRE_TRUSTS,
  toCreateAttention,
  trustClass,
  wireId,
} from '../src/host/wire.ts'
import { DEFAULT_MAX_PENDING, MAX_MESSAGE_SUMMARIES, WireCapture } from '../src/host/prestep.ts'

test('wire channels, budget table and default item cap match wire.md 4.5', () => {
  assert.equal(WIRE_CHANNELS.length, 16)
  assert.deepEqual([...WIRE_CHANNELS], [
    'prompt', 'goal', 'plan', 'tool', 'workspace', 'file', 'attachment', 'session-ref',
    'steer', 'inject', 'spill', 'retention', 'prune', 'compaction', 'fork', 'subagent',
  ])
  const expected = {
    prompt: [600, 1, 'turn'],
    goal: [300, 1, 'session'],
    plan: [600, 1, 'session'],
    tool: [400, 3, 'turn'],
    workspace: [256, 1, 'session'],
    file: [256, 8, 'turn'],
    attachment: [256, 4, 'session'],
    'session-ref': [256, 3, 'turn'],
    steer: [256, 4, 'turn'],
    inject: [256, 4, 'step'],
    spill: [256, 4, 'session'],
    retention: [0, 0, 'none'],
    prune: [256, 2, 'session'],
    compaction: [400, 1, 'session'],
    fork: [256, 1, 'session'],
    subagent: [256, 8, 'session'],
  }
  assert.deepEqual(Object.keys(DEFAULT_CHANNEL_BUDGETS).sort(), Object.keys(expected).sort())
  for (const [channel, [tokens, maxItems, ttl]] of Object.entries(expected)) {
    assert.deepEqual(DEFAULT_CHANNEL_BUDGETS[channel], { tokens, maxItems, ttl }, channel)
  }
  const sum = Object.values(DEFAULT_CHANNEL_BUDGETS).reduce((total, budget) => total + budget.maxItems, 0)
  assert.equal(DEFAULT_MAX_ITEMS, sum)
  assert.equal(DEFAULT_MAX_ITEMS, 46)
})

test('wireId builds the grammar, validates the slot and truncates long ids with sha256', () => {
  assert.equal(wireId('prompt', 'session-a28d', 7, 'prompt'), 'dsh:prompt:session-a28d:7:prompt')
  assert.equal(wireId('session-ref', 'session-1', 0, 'session-2'), 'dsh:session-ref:session-1:0:session-2')

  for (const slot of ['Prompt', 'prompt 1', 'prompt.1', 'prompt/1', 'prompt:1', '', null, 1]) {
    assert.throws(() => wireId('prompt', 'session-1', 1, slot), /slot/, String(slot))
  }
  assert.throws(() => wireId('bogus', 'session-1', 1, 'prompt'), /channel/)
  assert.throws(() => wireId('prompt', '', 1, 'prompt'), /sessionId/)
  assert.throws(() => wireId('prompt', 'session-1', -1, 'prompt'), /turn/)
  assert.throws(() => wireId('prompt', 'session-1', 1.5, 'prompt'), /turn/)
  assert.throws(() => wireId('prompt', 'session-1', Number.NaN, 'prompt'), /turn/)

  const long = wireId('prompt', 'session-1', 1, 'x'.repeat(250))
  assert.equal(long.length, 200)
  assert.ok(long.startsWith('dsh:prompt:session-1:1:xxx'))
  assert.equal(long[187], '-')
  assert.match(long, /-[0-9a-f]{12}$/)
  assert.equal(wireId('prompt', 'session-1', 1, 'x'.repeat(250)), long)
  assert.notEqual(wireId('prompt', 'session-1', 1, 'x'.repeat(251)), long)
})

test('toCreateAttention maps fields losslessly and keeps trust host-side', () => {
  const item = {
    id: wireId('prompt', 'session-1', 7, 'prompt'),
    channel: 'prompt',
    scope: { tenantId: 'tenant', principalId: 'session-1', sessionId: 'session-1', turnId: 'turn:stale' },
    pointer: { kind: 'prompt', id: 'message-1', version: 'seq:3' },
    summary: 'implement P0',
    scores: { relevance: 1, urgency: 1, confidence: 1, importance: 1 },
    budget: { tokens: 600 },
    expiresAt: '2026-01-01T00:00:00.000Z',
    reason: 'the user asked for it',
    trust: 'user',
  }
  const mapped = toCreateAttention(item, 'turn:session-1:7')
  assert.deepEqual(mapped, {
    id: item.id,
    summary: 'implement P0',
    pointer: { kind: 'prompt', id: 'message-1', version: 'seq:3' },
    scope: { tenantId: 'tenant', principalId: 'session-1', sessionId: 'session-1', turnId: 'turn:session-1:7' },
    scores: { relevance: 1, urgency: 1, confidence: 1, importance: 1 },
    budget: { tokens: 600 },
    expiresAt: '2026-01-01T00:00:00.000Z',
    reason: 'the user asked for it',
  })
  assert.equal('trust' in mapped, false)
  assert.notEqual(mapped.scope, item.scope)
  assert.notEqual(mapped.pointer, item.pointer)
  assert.notEqual(mapped.scores, item.scores)
  assert.notEqual(mapped.budget, item.budget)
  assert.equal(item.scope.turnId, 'turn:stale')
})

test('trustClass maps every wire trust level to its AMP evidence class', () => {
  assert.equal(WIRE_TRUSTS.length, 5)
  assert.equal(WIRE_EXCLUSION_REASONS.length, 6)
  assert.deepEqual(WIRE_EXCLUSION_REASONS, ['scope', 'expired', 'stale', 'unmounted', 'version', 'budget'])
  assert.deepEqual(trustClass('host'), { level: 'H1', source: 'operation_history', reliability: 0.9, origin: 'original', instruction: false })
  assert.deepEqual(trustClass('user'), { level: 'H2', source: 'user_confirmation', reliability: 1, origin: 'original', instruction: true })
  assert.deepEqual(trustClass('workspace'), { level: 'H3', source: 'system_rule', reliability: 0.8, origin: 'original', instruction: false })
  assert.deepEqual(trustClass('derived'), { level: 'H4', source: 'dialogue', reliability: 0.5, origin: 'secondary', instruction: false })
  assert.deepEqual(trustClass('external'), { level: 'H5', source: 'web_search', reliability: 0.6, origin: 'original', instruction: false })
  assert.equal(TRUST_CLASSES.derived.instruction, false)
  assert.equal(TRUST_CLASSES.host.instruction, false)
  assert.throws(() => trustClass('bogus'), /trust/)
})

test('capture extracts the current user prompt, not the host time-context', () => {
  const capture = new WireCapture({ now: () => new Date('2026-01-01T00:00:00.000Z') })
  const pending = capture.capture(
    { id: 'session-1' },
    [
      { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Current time: 2026-01-01' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '  implement P0  ' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'later' }] },
    ],
    { turn: 3, step: 1 },
  )
  assert.equal(pending.sessionId, 'session-1')
  assert.equal(pending.turn, 3)
  assert.equal(pending.step, 1)
  assert.equal(pending.capturedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(pending.prompt, 'implement P0')
  assert.equal(pending.messages.length, 4)
  assert.equal(pending.messages[1].source, 'user')
  assert.equal(pending.messages[1].role, 'user')
  assert.deepEqual(pending.errors, [])
  assert.equal(pending.items.length, 0)
  assert.equal(capture.pendingFor('session-1', 3), pending)
  assert.equal(capture.pendingFor('session-1', 4), undefined)

  const plain = capture.capture({ id: 'session-2' }, [{ role: 'user', content: 'plain string prompt' }], { turn: 1, step: 1 })
  assert.equal(plain.prompt, 'plain string prompt')

  const hostOnly = capture.capture(
    { id: 'session-3' },
    [{ role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'clock' }] }],
    { turn: 1, step: 1 },
  )
  assert.equal(hostOnly.prompt, '')
})

test('capture carries the prompt to later steps of the same turn and bounds summaries', () => {
  const capture = new WireCapture()
  capture.capture({ id: 'session-1' }, [{ role: 'user', source: { kind: 'user' }, content: 'first prompt' }], { turn: 3, step: 1 })
  const stepTwo = capture.capture({ id: 'session-1' }, [], { turn: 3, step: 2 })
  assert.equal(stepTwo.prompt, 'first prompt')
  assert.equal(stepTwo.step, 2)
  assert.equal(stepTwo.messages.length, 0)
  const nextTurn = capture.capture({ id: 'session-1' }, [], { turn: 4, step: 1 })
  assert.equal(nextTurn.prompt, '')

  const many = Array.from({ length: MAX_MESSAGE_SUMMARIES + 5 }, (_, index) => ({
    role: 'assistant',
    content: [{ type: 'text', text: `m${index}` }],
  }))
  const summary = capture.capture({ id: 'session-2' }, many, { turn: 1, step: 1 })
  assert.equal(summary.messages.length, MAX_MESSAGE_SUMMARIES)
  assert.equal(summary.messages.at(-1).textChars, 'm28'.length)
  assert.equal(summary.prompt, '')
})

test('a later plugin notice cannot overwrite the captured prompt', () => {
  const capture = new WireCapture()
  capture.capture({ id: 'session-1' }, [{ role: 'user', source: { kind: 'user' }, content: 'real prompt' }], { turn: 1, step: 1 })
  const stepTwo = capture.capture(
    { id: 'session-1' },
    [{ role: 'user', source: { kind: 'action-cards/status' }, content: 'plugin notice' }],
    { turn: 1, step: 2 },
  )
  assert.equal(stepTwo.prompt, 'real prompt')

  const pluginOnly = capture.capture(
    { id: 'session-2' },
    [{ role: 'user', source: { kind: 'plugin' }, content: 'plugin notice' }],
    { turn: 1, step: 1 },
  )
  assert.equal(pluginOnly.prompt, '')
})

test('capture never throws on malformed agents, messages or hostile getters', () => {
  const capture = new WireCapture()
  assert.doesNotThrow(() => capture.capture(undefined, undefined))
  const missing = capture.capture(undefined, undefined)
  assert.equal(missing.sessionId, '')
  assert.ok(missing.errors.some((line) => line.includes('agent')))

  assert.doesNotThrow(() => capture.capture({}, 'not-an-array', { turn: 1, step: 1 }))
  const notArray = capture.capture({}, 'not-an-array')
  assert.ok(notArray.errors.some((line) => line.includes('messages')))

  const hostile = { get id() { throw new Error('boom') } }
  let hostileResult
  assert.doesNotThrow(() => {
    hostileResult = capture.capture(hostile, [
      { get role() { throw new Error('bad role') }, content: 'x' },
      null,
      42,
      { role: 'user', content: [{ type: 'text', text: 7 }, null] },
    ], { turn: 1, step: 1 })
  })
  assert.equal(hostileResult.sessionId, '')
  assert.ok(hostileResult.errors.some((line) => line.includes('bad role')))

  const throwingClock = new WireCapture({ now: () => { throw new Error('clock boom') } })
  assert.doesNotThrow(() => throwingClock.capture({ id: 'session-1' }, [], { turn: 1, step: 1 }))
  assert.equal(throwingClock.capture({ id: 'session-1' }, [], { turn: 1, step: 1 }).capturedAt, '1970-01-01T00:00:00.000Z')
})

test('capture keeps bounded state and exposes status counters', () => {
  assert.equal(DEFAULT_MAX_PENDING, 64)
  const bounded = new WireCapture({ maxEntries: 2 })
  for (const sessionId of ['a', 'b', 'c']) bounded.capture({ id: sessionId }, [], { turn: 0, step: 1 })
  assert.equal(bounded.status().pending, 2)
  assert.equal(bounded.status().evicted, 1)
  assert.equal(bounded.status().captured, 3)
  assert.equal(bounded.pendingFor('a', 0), undefined)
  assert.equal(bounded.pendingFor('b', 0)?.sessionId, 'b')
  assert.equal(bounded.status().lastCapture?.sessionId, 'c')

  const defaults = new WireCapture()
  for (let index = 0; index < 70; index += 1) defaults.capture({ id: `session-${index}` }, [], { turn: 0, step: 1 })
  assert.equal(defaults.status().pending, 64)
  assert.equal(defaults.status().evicted, 6)
})

test('extractors and onCapture are fail-open extension points', () => {
  const capture = new WireCapture()
  const seen = []
  capture.onCapture = (pending) => seen.push(pending)
  capture.extractors.push({
    name: 'demo',
    extract: ({ sessionId, turn, prompt }) => [{
      id: wireId('file', sessionId, turn, 'file-1'),
      channel: 'file',
      scope: { tenantId: 'tenant', principalId: sessionId, sessionId, turnId: `turn:${sessionId}:${turn}` },
      pointer: { kind: 'file', id: 'src/host/context.ts', version: 'stat:1:2' },
      summary: `path reference for ${prompt}`,
      scores: { relevance: 1, urgency: 0, confidence: 1, importance: 1 },
      budget: { tokens: 256 },
      expiresAt: '2026-01-01T00:00:00.000Z',
      reason: 'test extractor',
      trust: 'user',
    }],
  })
  const pending = capture.capture(
    { id: 'session-x' },
    [{ role: 'user', source: { kind: 'user' }, content: 'hi' }],
    { turn: 2, step: 4 },
  )
  assert.equal(pending.items.length, 1)
  assert.equal(pending.items[0].id, 'dsh:file:session-x:2:file-1')
  assert.equal(seen.length, 1)
  assert.equal(seen[0], pending)

  const broken = new WireCapture()
  broken.extractors.push({ name: 'broken', extract: () => { throw new Error('kaboom') } })
  const failed = broken.capture({ id: 'session-y' }, [], { turn: 1, step: 1 })
  assert.equal(failed.items.length, 0)
  assert.ok(failed.errors.some((line) => line.includes('extractor broken: kaboom')))

  const hook = new WireCapture()
  hook.onCapture = () => { throw new Error('hook boom') }
  assert.doesNotThrow(() => hook.capture({ id: 'session-z' }, [], { turn: 1, step: 1 }))
  assert.equal(hook.status().failures, 1)
  assert.ok(hook.status().errors[0].includes('onCapture: hook boom'))
})

test('invalidate and clearTurn drop only the requested turn', () => {
  const capture = new WireCapture()
  capture.capture({ id: 'session-1' }, [], { turn: 1, step: 1 })
  capture.capture({ id: 'session-1' }, [], { turn: 2, step: 1 })
  capture.invalidate('session-1', 1)
  assert.equal(capture.pendingFor('session-1', 1), undefined)
  assert.ok(capture.pendingFor('session-1', 2))
  assert.equal(capture.status().invalidated, 1)
  capture.clearTurn('session-1', 2)
  assert.equal(capture.pendingFor('session-1', 2), undefined)
  assert.equal(capture.status().cleared, 1)
})
