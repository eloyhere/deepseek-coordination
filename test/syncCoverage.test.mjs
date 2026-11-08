/**
 * R3: `AmpSync` observation coverage for compaction and fork/subagent lineage.
 *
 * `AmpSync` is TypeScript and is imported directly with Node 24's type
 * stripping. Its runtime import uses the repository's `.js` specifier
 * convention, so a small synchronous resolve hook maps a relative `.js`
 * specifier to its `.ts` sibling when that sibling exists (same loader as
 * `test/channelsInput.test.mjs`).
 *
 * The fake host only implements the observation seam. `kernel()` throws so a
 * passing test also proves that compaction/fork bookkeeping never writes AMP
 * workflow state, turns, goals, plans, receipts or evidence.
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

const { AmpSync } = await import('../src/host/sync.ts')

/** Fake host: records session/turn calls and fails if the kernel is consulted. */
function createHost() {
  const host = {
    sessions: [],
    turns: [],
    kernels: 0,
    ensureSession(sessionId, root) {
      host.sessions.push({ sessionId, root })
    },
    rootOfAgent() {
      return 'root'
    },
    rootOfSession() {
      return 'root'
    },
    ensureTurn(sessionId, turn, root) {
      host.turns.push({ sessionId, turn, root })
      return `turn:${sessionId}:${turn ?? 0}`
    },
    turnId(sessionId, turn) {
      return `turn:${sessionId}:${turn}`
    },
    currentTurn() {
      return 0
    },
    kernel() {
      host.kernels += 1
      throw new Error('observation-only sync must not consult the AMP kernel')
    },
  }
  return host
}

/** Minimal `apply()`-shaped fixture: only the `agent/created` channel is wired. */
function createSync() {
  const handlers = new Map()
  const ctx = {
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
  }
  const host = createHost()
  const sync = new AmpSync(ctx, host)
  sync.attach()
  const emit = (name, payload) => {
    for (const handler of handlers.get(name) ?? []) handler(payload)
  }
  return { sync, host, emit }
}

test('a seeded ordinary fork is indexed without any AMP workflow write', () => {
  const { sync, host, emit } = createSync()
  const agent = {
    id: 'fork-1',
    session: { header: { isSeeded: true, parentSession: 'parent-1' }, inheritedEventCount: 12 },
  }
  emit('agent/created', { agent })

  assert.deepEqual(host.sessions, [{ sessionId: 'fork-1', root: 'root' }])
  const status = sync.status()
  assert.equal(status.counters.session, 1)
  assert.equal(status.counters.fork, 1)
  assert.equal(status.counters.subagent, 0)
  assert.equal(status.forks.length, 1)
  const [fork] = status.forks
  assert.equal(fork.sessionId, 'fork-1')
  assert.equal(fork.sourceSessionId, 'parent-1')
  assert.equal(fork.boundary, 12)
  assert.equal(fork.kind, 'fork')
  assert.equal(typeof fork.at, 'string')
  assert.deepEqual(status.errors, [])
  assert.equal(host.turns.length, 0)
  assert.equal(host.kernels, 0)
})

test('subagent children classify by origin and non-seeded sessions stay unrecorded', () => {
  const { sync, emit } = createSync()
  emit('agent/created', {
    agent: {
      id: 'sub-1',
      session: { header: { isSeeded: true, origin: 'subagent', parentSession: 'parent-2' }, inheritedEventCount: 7 },
    },
  })
  emit('agent/created', {
    agent: {
      id: 'plain-1',
      session: { header: { isSeeded: false }, inheritedEventCount: 0 },
    },
  })

  const status = sync.status()
  assert.equal(status.counters.session, 2)
  assert.equal(status.counters.subagent, 1)
  assert.equal(status.counters.fork, 0)
  assert.equal(status.forks.length, 1)
  const [subagent] = status.forks
  assert.equal(subagent.sessionId, 'sub-1')
  assert.equal(subagent.sourceSessionId, 'parent-2')
  assert.equal(subagent.boundary, 7)
  assert.equal(subagent.kind, 'subagent')
  assert.deepEqual(status.errors, [])
})

test('compaction summary is indexed without turn or kernel work', () => {
  const { sync, host } = createSync()
  sync.onSessionEvent({ id: 's1' }, {
    type: 'compaction/start',
    seq: 40,
    data: { compactionId: 'c1', sourceCommandId: 'cmd' },
  })
  sync.onSessionEvent({ id: 's1' }, {
    type: 'compaction/summary',
    seq: 41,
    data: { compactionId: 'c1', shadowedSeqs: [1, 2, 3], shadowedTokenCount: 900 },
  })
  sync.onSessionEvent({ id: 's1' }, {
    type: 'compaction/end',
    seq: 42,
    data: { compactionId: 'c1' },
  })

  const status = sync.status()
  assert.equal(status.counters.compaction, 1)
  assert.equal(status.compactions.length, 1)
  const [compaction] = status.compactions
  assert.equal(compaction.sessionId, 's1')
  assert.equal(compaction.compactionId, 'c1')
  assert.equal(compaction.summarySeq, 41)
  assert.deepEqual(compaction.shadowedSeqs, [1, 2, 3])
  assert.equal(compaction.shadowedTokenCount, 900)
  assert.equal(typeof compaction.at, 'string')
  assert.deepEqual(status.errors, [])
  assert.equal(host.turns.length, 0)
  assert.equal(host.kernels, 0)
})

test('malformed observations stay fail-open and preserve the legacy projections', () => {
  const { sync, host, emit } = createSync()
  emit('agent/created', { agent: { id: 'bad-1', session: { header: null } } })
  sync.onSessionEvent({ id: 's1' }, { type: 'compaction/summary', data: null })
  sync.onSessionEvent({ id: 's1' }, { type: 'compaction/summary', data: 'not-a-record' })
  sync.onSessionEvent({ id: 's1' }, { type: 'compaction/summary', data: { compactionId: 42 } })
  sync.onSessionEvent({ id: 's1' }, {
    type: 'compaction/summary',
    seq: 9,
    data: { compactionId: 'c-malformed', shadowedSeqs: 'nope', shadowedTokenCount: -1 },
  })

  // The existing turn projection still runs after every malformed observation.
  sync.onSessionEvent({ id: 's1' }, { type: 'turn/start', data: { turn: 2 } })

  const status = sync.status()
  assert.deepEqual(status.errors, [])
  assert.equal(status.counters.session, 2)
  assert.equal(status.counters.turn, 1)
  assert.equal(status.counters.compaction, 1)
  assert.equal(status.counters.fork, 0)
  assert.equal(status.forks.length, 0)
  assert.equal(status.compactions.length, 1)
  assert.equal(status.compactions[0].compactionId, 'c-malformed')
  assert.equal(status.compactions[0].summarySeq, 9)
  assert.deepEqual(status.compactions[0].shadowedSeqs, [])
  assert.equal(status.compactions[0].shadowedTokenCount, undefined)
  assert.deepEqual(host.sessions, [{ sessionId: 'bad-1', root: 'root' }, { sessionId: 's1', root: 'root' }])
  assert.equal(host.turns.length, 1)
})

test('both ledgers are bounded while counters keep the totals', () => {
  const { sync, emit } = createSync()
  for (let index = 1; index <= 55; index += 1) {
    emit('agent/created', {
      agent: {
        id: `fork-${index}`,
        session: { header: { isSeeded: true, parentSession: `parent-${index}` }, inheritedEventCount: index },
      },
    })
    sync.onSessionEvent({ id: 's1' }, {
      type: 'compaction/summary',
      seq: index,
      data: { compactionId: `c${index}`, shadowedSeqs: [index], shadowedTokenCount: index },
    })
  }

  const status = sync.status()
  assert.equal(status.counters.fork, 55)
  assert.equal(status.counters.compaction, 55)
  // Public view keeps the newest 20; the in-process ledgers stop at 50.
  assert.equal(status.forks.length, 20)
  assert.equal(status.forks[0].sessionId, 'fork-36')
  assert.equal(status.forks[19].sessionId, 'fork-55')
  assert.equal(status.compactions.length, 20)
  assert.equal(status.compactions[0].compactionId, 'c36')
  assert.equal(status.compactions[19].compactionId, 'c55')
  assert.equal(sync.forks.length, 50)
  assert.equal(sync.compactions.length, 50)
  assert.deepEqual(status.errors, [])
})

test('status exposes the counters and the bounded ledger slices', () => {
  const { sync } = createSync()
  const status = sync.status()
  assert.deepEqual(Object.keys(status).sort(), [
    'actions', 'chains', 'compactions', 'counters', 'deferred', 'errors', 'forks', 'goals',
  ])
  assert.deepEqual(status.counters, {
    session: 0,
    turn: 0,
    goal: 0,
    plan: 0,
    task: 0,
    action: 0,
    result: 0,
    compaction: 0,
    fork: 0,
    subagent: 0,
  })
  assert.equal(status.goals, 0)
  assert.equal(status.chains, 0)
  assert.equal(status.actions, 0)
  assert.deepEqual(status.errors, [])
  assert.deepEqual(status.deferred, [])
  assert.deepEqual(status.compactions, [])
  assert.deepEqual(status.forks, [])
})
