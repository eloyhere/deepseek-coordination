/**
 * R1 recovery tests.
 *
 * `recovery.ts` and the tracker modules are TypeScript and are imported
 * directly with Node 24 type stripping. Their runtime imports use the
 * repository's `.js` specifier convention, so the same small synchronous
 * resolve hook as the P1/P2/P3 suites maps a relative `.js` specifier to its
 * `.ts` sibling. Fake sessions implement the only log surface recovery reads:
 * `id`, `seq` (the next event seq, i.e. log length) and `eventAt(seq)`.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL !== undefined &&
      specifier.endsWith('.js') &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      const mapped = `${specifier.slice(0, -3)}.ts`
      try {
        if (existsSync(fileURLToPath(new URL(mapped, context.parentURL)))) {
          return nextResolve(mapped, context)
        }
      } catch {
        // Fall through to the original specifier.
      }
    }
    return nextResolve(specifier, context)
  },
})

const { recoverContext } = await import('../src/host/recovery.ts')
const { WireCapture } = await import('../src/host/prestep.ts')
const { ForkTracker } = await import('../src/host/fork.ts')
const { SubagentTracker } = await import('../src/host/subagent.ts')
const { SpillIndex } = await import('../src/host/spill.ts')
const { RetentionLedger } = await import('../src/host/retention.ts')
const { PruneTracker } = await import('../src/host/prune.ts')
const { CompactionTracker } = await import('../src/host/compaction.ts')
const { CooperationCoordinator } = await import('attention-manifest-protocol/cooperation')

const FIXED_AT = '2026-11-09T00:00:00.000Z'
const SPILL_TEXT = '(Omitted 42 bytes. Full formatted result stored at: C:\\tmp\\recovery.txt. Read the full result.)'

/** One session event fixture; `seq`/`time` are supplied by the fake session. */
function sessionEvent(type, data) {
  return { type, data }
}

/** One human prompt event (`user/message` data is the message itself). */
function userPrompt(text, extra = {}) {
  return sessionEvent('user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
    ...extra,
  })
}

/**
 * A fake session over a mutable event array.
 *
 * `seq` is the next event's sequence number (the log length), matching the
 * real `Session.seq` getter; `eventAt` returns the indexed event with its
 * assigned seq.
 */
function fakeSession(id, events = [], header = {}) {
  return {
    id,
    header,
    events,
    get seq() {
      return events.length
    },
    eventAt(seq) {
      const event = events[seq]
      return event === undefined ? undefined : { seq, time: FIXED_AT, ...event }
    },
  }
}

/** A live agent whose durable session is the given fake session. */
function agentFor(session) {
  return { id: session.id, session }
}

/** Fake host context exposing only the two list surfaces recovery uses. */
function fakeContext(agents = [], sessions = []) {
  return {
    agents: { list: () => agents },
    sessions: { list: () => sessions },
  }
}

/** Fresh tracker set; `coordinator` is optional for subagent delegation tests. */
function makeDeps(options = {}) {
  return {
    capture: new WireCapture({ now: () => new Date(FIXED_AT) }),
    fork: new ForkTracker({ now: () => FIXED_AT }),
    subagent: new SubagentTracker({ coordinator: options.coordinator, now: () => FIXED_AT }),
    spill: new SpillIndex(),
    retention: new RetentionLedger(),
    prune: new PruneTracker(),
    compaction: new CompactionTracker(),
  }
}

test('open turn replays prompt, spill and turn mapping from the log', () => {
  const session = fakeSession(
    'session-open',
    [
      sessionEvent('turn/start', { turn: 1 }),
      userPrompt('recover the open prompt'),
      sessionEvent('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'shell' }),
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'text', text: `preview\n${SPILL_TEXT}` }],
        },
      }),
    ],
    { isSeeded: true, parentSession: 'parent-open' },
  )
  const agent = agentFor(session)
  // The same session appears through both services; recovery must replay once.
  const ctx = fakeContext([agent], [session, session])
  const deps = makeDeps()

  const status = recoverContext(ctx, deps)

  assert.deepEqual(status, { sessions: 1, agents: 1, events: 4, hydrations: 1, failures: 0 })
  const pending = deps.capture.pendingFor('session-open', 1)
  assert.ok(pending)
  assert.equal(pending.prompt, 'recover the open prompt')
  assert.equal(pending.step, 0)
  assert.deepEqual(pending.messages, [])
  assert.deepEqual(pending.items, [])
  assert.deepEqual(pending.errors, [])

  const records = deps.spill.list('session-open')
  assert.equal(records.length, 1)
  assert.equal(records[0].locator, 'C:\\tmp\\recovery.txt')
  assert.equal(records[0].bytes, 42)
  assert.equal(records[0].tool, 'shell')
  const [spillItem] = deps.spill.itemsFor(agent)
  assert.equal(spillItem.id, 'dsh:spill:session-open:1:spill-0')
  assert.equal(spillItem.pointer.version, 'bytes:42')
  // A spill notice is not a retention omission and must not be double-counted.
  assert.deepEqual(deps.retention.list('session-open'), [])

  // Replay happens before observeAgent, but turn mapping is already known.
  assert.equal(deps.fork.get('session-open').boundary, 0)
  assert.equal(deps.fork.itemsFor(agent)[0].id, 'dsh:fork:session-open:1:fork')
})

test('closed turns are not hydrated', () => {
  const session = fakeSession('session-closed', [
    sessionEvent('turn/start', { turn: 1 }),
    userPrompt('this turn already ended'),
    sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  const ctx = fakeContext([agentFor(session)], [session])
  const deps = makeDeps()

  const status = recoverContext(ctx, deps)

  assert.equal(status.events, 3)
  assert.equal(status.hydrations, 0)
  assert.equal(deps.capture.pendingFor('session-closed', 1), undefined)
})

test('compaction lifecycle is rebuilt without a fabricated prompt', () => {
  const session = fakeSession('session-compact', [
    sessionEvent('compaction/start', { turn: 1, compactionId: 'c-1' }),
    sessionEvent('compaction/summary', {
      turn: 1,
      compactionId: 'c-1',
      summary: [{ type: 'text', text: 'compacted summary' }],
      shadowedRange: { start: 0, end: 2 },
      shadowedSeqs: [0, 1],
      shadowedTokenCount: 9,
      provider: 'test',
      model: 'model',
    }),
    sessionEvent('compaction/end', { turn: 1, compactionId: 'c-1' }),
  ])
  const ctx = fakeContext([agentFor(session)], [session])
  const deps = makeDeps()

  const status = recoverContext(ctx, deps)

  assert.equal(status.events, 3)
  assert.equal(status.hydrations, 0)
  const records = deps.compaction.records('session-compact')
  assert.equal(records.length, 1)
  assert.equal(records[0].summary, 'compacted summary')
  assert.equal(records[0].endSeq, 2)
  assert.equal(deps.compaction.status().ends, 1)
})

test('second recovery replays only new seqs and hydrates the new open turn', () => {
  const session = fakeSession('session-again', [
    sessionEvent('turn/start', { turn: 1 }),
    userPrompt('first prompt'),
  ])
  const ctx = fakeContext([agentFor(session)], [session])
  const deps = makeDeps()

  const first = recoverContext(ctx, deps)
  assert.deepEqual(first, { sessions: 1, agents: 1, events: 2, hydrations: 1, failures: 0 })
  assert.equal(deps.capture.pendingFor('session-again', 1).prompt, 'first prompt')

  session.events.push(
    sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    sessionEvent('turn/start', { turn: 2 }),
    userPrompt('second prompt'),
  )
  const second = recoverContext(ctx, deps)
  assert.deepEqual(second, { sessions: 1, agents: 1, events: 3, hydrations: 1, failures: 0 })
  // The closed turn keeps its earlier prompt; the new turn gets the new one.
  assert.equal(deps.capture.pendingFor('session-again', 1).prompt, 'first prompt')
  assert.equal(deps.capture.pendingFor('session-again', 2).prompt, 'second prompt')

  const third = recoverContext(ctx, deps)
  assert.deepEqual(third, { sessions: 1, agents: 1, events: 0, hydrations: 0, failures: 0 })
})

test('a replaced session object is replayed from seq zero', () => {
  const original = fakeSession('session-replaced', [
    sessionEvent('turn/start', { turn: 1 }),
    userPrompt('old prompt'),
  ])
  let current = original
  const ctx = {
    agents: { list: () => [] },
    sessions: { list: () => [current] },
  }
  const deps = makeDeps()

  assert.equal(recoverContext(ctx, deps).events, 2)

  current = fakeSession('session-replaced', [
    sessionEvent('turn/start', { turn: 4 }),
    userPrompt('replacement prompt'),
  ])
  const status = recoverContext(ctx, deps)
  assert.equal(status.events, 2)
  assert.equal(status.hydrations, 1)
  assert.equal(deps.capture.pendingFor('session-replaced', 4).prompt, 'replacement prompt')
})

test('subagent history is replayed before its live delegation is created', () => {
  const child = fakeSession(
    'child-sub',
    [
      sessionEvent('turn/start', { turn: 1 }),
      userPrompt('delegated work'),
      sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ],
    { isSeeded: true, origin: 'subagent', parentSession: 'parent-1', delegationDepth: 0 },
  )
  const ctx = fakeContext([agentFor(child)], [child])
  const deps = makeDeps({ coordinator: new CooperationCoordinator() })

  const status = recoverContext(ctx, deps)

  assert.equal(status.agents, 1)
  // The historical turn/end must not settle the task created at the log head.
  const record = deps.subagent.get('child-sub')
  assert.ok(record)
  assert.equal(record.state, 'running')
  assert.equal(deps.subagent.status().delegated, 1)
  assert.equal(deps.subagent.status().settled, 0)
  // Only a future turn/end settles it.
  deps.subagent.observeEvent('child-sub', sessionEvent('turn/end', {
    turn: 2,
    reason: { kind: 'completed' },
  }))
  assert.equal(deps.subagent.get('child-sub').state, 'completed')
  assert.equal(deps.subagent.status().settled, 1)
})

test('malformed services, sessions and events never throw', () => {
  const deps = makeDeps()
  const ctx = {
    agents: {
      list: () => [
        null,
        {
          id: 'bad-agent',
          get session() {
            throw new Error('no session')
          },
        },
      ],
    },
    sessions: {
      list: () => [
        null,
        {},
        { id: 'bad-seq', seq: 'many', eventAt: () => ({}) },
        {
          id: 'bad-events',
          get seq() {
            return 3
          },
          eventAt(seq) {
            if (seq === 1) throw new Error('bad event')
            return { type: 'turn/start', data: { turn: 1 } }
          },
        },
      ],
    },
  }

  let status
  assert.doesNotThrow(() => {
    status = recoverContext(ctx, deps)
  })
  assert.ok(status.failures >= 1)

  let empty
  assert.doesNotThrow(() => {
    empty = recoverContext({}, deps)
  })
  assert.deepEqual(empty, { sessions: 0, agents: 0, events: 0, hydrations: 0, failures: 0 })

  assert.doesNotThrow(() => recoverContext({
    get agents() {
      throw new Error('broken agents service')
    },
    sessions: { list: () => [] },
  }, deps))
  assert.doesNotThrow(() => recoverContext({
    sessions: {
      list() {
        throw new Error('broken list')
      },
    },
  }, deps))
})

test('hydrate validates input, defaults step/at and never overwrites a prompt', () => {
  const capture = new WireCapture({ now: () => new Date(FIXED_AT) })

  assert.equal(capture.hydrate(null), undefined)
  assert.equal(capture.hydrate({ sessionId: '', turn: 0, prompt: 'x' }), undefined)
  assert.equal(capture.hydrate({ sessionId: 's', turn: -1, prompt: 'x' }), undefined)
  assert.equal(capture.hydrate({ sessionId: 's', turn: 1.5, prompt: 'x' }), undefined)
  assert.equal(capture.hydrate({ sessionId: 's', turn: 0, prompt: '   ' }), undefined)

  const first = capture.hydrate({ sessionId: 's', turn: 0, prompt: 'first prompt' })
  assert.ok(first)
  assert.equal(first.prompt, 'first prompt')
  assert.equal(first.step, 0)
  assert.equal(first.capturedAt, FIXED_AT)
  assert.deepEqual(first.messages, [])
  assert.deepEqual(first.items, [])
  assert.deepEqual(first.errors, [])

  const second = capture.hydrate({
    sessionId: 's',
    turn: 0,
    prompt: 'second prompt',
    step: 3,
    at: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(second.prompt, 'first prompt')
  assert.equal(second.step, 0)
  assert.equal(second.capturedAt, FIXED_AT)
})

test('historical turn/end is offered to AMP settle without creating facts', () => {
  const session = fakeSession('session-settle', [
    sessionEvent('turn/start', { turn: 1 }),
    sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    sessionEvent('turn/start', { turn: 2 }),
  ])
  const calls = []
  const deps = {
    ...makeDeps(),
    settleTurn: (sessionId, turn, reason) => calls.push([sessionId, turn, reason]),
  }
  const status = recoverContext(fakeContext([agentFor(session)], [session]), deps)
  assert.deepEqual(calls, [['session-settle', 1, { kind: 'completed' }]])
  assert.equal(status.events, 3)
  assert.equal(deps.capture.pendingFor('session-settle', 1), undefined)
  assert.equal(deps.capture.pendingFor('session-settle', 2), undefined)
})
