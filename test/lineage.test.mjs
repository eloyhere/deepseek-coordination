/**
 * P3 lineage tests.
 *
 * `fork.ts`, `subagent.ts` and `lineage.ts` are TypeScript and are imported
 * directly with Node's type stripping. Their runtime imports use the
 * repository's `.js` specifier convention, so the same small synchronous
 * resolve hook as the P1/P2 tests maps a relative `.js` specifier to its `.ts`
 * sibling. The subagent tests use the real `CooperationCoordinator`; no AMP
 * behavior is mocked.
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

const { ForkTracker, MAX_FORK_RECORDS } = await import('../src/host/fork.ts')
const { SubagentTracker, EMPTY_SCOPE, MAX_SUBAGENT_RECORDS } = await import('../src/host/subagent.ts')
const { LineageSources, EmptyLineageStatus, emptyLineageStatus } = await import('../src/host/lineage.ts')
const { CooperationCoordinator } = await import('attention-manifest-protocol/cooperation')

const FIXED_AT = '2026-11-09T00:00:00.000Z'
const SESSION_WINDOW = 24 * 60 * 60 * 1000

/** A minimal agent stand-in: only `id` and `session.header` are read. */
function agentFor(id, header = {}, inheritedEventCount = 0) {
  return { id, session: { header, inheritedEventCount } }
}

/** A complete zero P2 output status for the fake base source. */
function emptyOutputStatus() {
  return {
    spill: { sessions: 0, records: 0, observed: 0, parsed: 0, duplicates: 0, evicted: 0, failures: 0 },
    retention: { records: 0, maxRecords: 0, sessions: 0, observed: 0, parsed: 0, duplicates: 0, evicted: 0, failures: 0 },
    prune: { sessions: 0, records: 0, linked: 0, pending: 0, observed: 0, pruned: 0, unlinked: 0, failures: 0 },
    compaction: { sessions: 0, records: 0, open: 0, observed: 0, starts: 0, summaries: 0, ends: 0, failures: 0 },
    failures: 0,
  }
}

/** A fake P2 source over a fixed item list. */
function baseSource(items = []) {
  return { itemsFor: () => items, status: () => emptyOutputStatus() }
}

/** Assert an expiry is inside a session-window from now. */
function assertSessionExpiry(expiresAt) {
  const left = Date.parse(expiresAt) - Date.now()
  assert.ok(left > SESSION_WINDOW - 60_000 && left <= SESSION_WINDOW, String(left))
}

test('ordinary seeded fork records source, boundary and one index item', () => {
  const fork = new ForkTracker({ now: () => FIXED_AT })
  const agent = agentFor('child-1', { isSeeded: true, parentSession: 'parent-1' }, 7)
  fork.observeAgent(agent)

  assert.deepEqual(fork.get('child-1'), {
    sessionId: 'child-1',
    sourceSessionId: 'parent-1',
    boundary: 7,
    kind: 'fork',
    at: FIXED_AT,
  })
  assert.deepEqual(fork.records(), [fork.get('child-1')])

  const [item] = fork.itemsFor(agent)
  assert.equal(item.id, 'dsh:fork:child-1:0:fork')
  assert.equal(item.channel, 'fork')
  assert.deepEqual(item.pointer, {
    kind: 'fork',
    id: 'child-1',
    version: 'inherited:7',
    uri: `dsh-session:${Buffer.from('child-1', 'utf8').toString('base64url')}`,
  })
  assert.equal(item.summary, 'fork inherited 7 events from parent-1')
  assert.deepEqual(item.scores, { relevance: 0.5, urgency: 0.2, confidence: 0.7, importance: 0.9 })
  assert.deepEqual(item.budget, { tokens: 256 })
  assert.equal(item.trust, 'host')
  assert.equal(item.scope.sessionId, 'child-1')
  assertSessionExpiry(item.expiresAt)
})

test('ordinary fork items follow the latest observed turn', () => {
  const fork = new ForkTracker({ now: () => FIXED_AT })
  const agent = agentFor('child-turn', { isSeeded: true, parentSession: 'parent-1' }, 2)
  fork.observeAgent(agent)
  assert.equal(fork.itemsFor(agent)[0].id, 'dsh:fork:child-turn:0:fork')

  fork.observeEvent('child-turn', { type: 'turn/start', data: { turn: 3 } })
  assert.equal(fork.itemsFor(agent)[0].id, 'dsh:fork:child-turn:3:fork')
  assert.equal(fork.itemsFor(agent)[0].scope.turnId, 'turn:child-turn:3')

  fork.observeEvent('child-turn', { type: 'turn/start', data: { turn: -1 } })
  assert.equal(fork.itemsFor(agent)[0].id, 'dsh:fork:child-turn:3:fork')
})

test('ordinary fork without source stays unrecorded and missing boundary is zero', () => {
  const fork = new ForkTracker({ now: () => FIXED_AT })
  const agent = agentFor('child-2', { isSeeded: true }, 3)
  fork.observeAgent(agent)
  assert.equal('sourceSessionId' in fork.get('child-2'), false)
  const [item] = fork.itemsFor(agent)
  assert.equal(item.summary, 'fork inherited 3 events from an unrecorded source')
  assert.equal(item.pointer.version, 'inherited:3')

  const bare = { id: 'child-3', session: { header: { isSeeded: true } } }
  fork.observeAgent(bare)
  assert.equal(fork.get('child-3').boundary, 0)
  assert.equal(fork.get('child-3').sourceSessionId, undefined)
})

test('non-seeded sessions and subagent children are ignored by the fork tracker', () => {
  const fork = new ForkTracker()
  fork.observeAgent(agentFor('plain', { isSeeded: false }))
  fork.observeAgent(agentFor('sub', { isSeeded: true, origin: 'subagent', parentSession: 'parent' }))
  assert.equal(fork.records().length, 0)
  assert.equal(fork.itemsFor(agentFor('plain')).length, 0)
  const status = fork.status()
  assert.equal(status.ignored, 2)
  assert.equal(status.observed, 0)
  assert.equal(status.failures, 0)
})

test('fork observation and projection never throw on malformed input', () => {
  const fork = new ForkTracker()
  assert.doesNotThrow(() => fork.observeAgent(undefined))
  assert.doesNotThrow(() => fork.observeAgent(null))
  assert.doesNotThrow(() => fork.observeAgent({ id: 'bad' }))
  assert.doesNotThrow(() => fork.observeAgent({
    id: 'bad-getter',
    session: {
      get header() {
        throw new Error('bad header')
      },
    },
  }))
  assert.deepEqual(fork.itemsFor(undefined), [])
  assert.deepEqual(fork.itemsFor({ id: 'missing' }), [])
  assert.equal(fork.get('bad-getter'), undefined)
  assert.ok(fork.status().failures >= 2)
})

test('fork records are bounded to 200', () => {
  const fork = new ForkTracker()
  const total = MAX_FORK_RECORDS + 5
  for (let index = 0; index < total; index += 1) {
    fork.observeAgent(agentFor(`fork-${index}`, { isSeeded: true }, index))
  }
  assert.equal(fork.records().length, MAX_FORK_RECORDS)
  assert.equal(fork.get('fork-0'), undefined)
  assert.equal(fork.get(`fork-${total - 1}`).boundary, total - 1)
})

test('subagent fork delegates and starts a real AMP task with an empty scope', () => {
  const coordinator = new CooperationCoordinator()
  const subagent = new SubagentTracker({ coordinator, now: () => FIXED_AT })
  const child = agentFor('child-sub-1', {
    isSeeded: true,
    origin: 'subagent',
    parentSession: 'parent-1',
    delegationDepth: 2,
    agentPreset: 'review',
  }, 9)
  subagent.observeAgent(child)

  const record = subagent.get('child-sub-1')
  assert.equal(record.parentSessionId, 'parent-1')
  assert.equal(record.depth, 2)
  assert.equal(record.seeded, true)
  assert.equal(record.preset, 'review')
  assert.equal(record.state, 'running')
  assert.equal(record.taskId, 'dsh:subagent:child-sub-1')
  assert.equal(record.ownerEpoch, 1)
  assert.equal(record.fence, 'dsh:subagent:child-sub-1:1')
  assert.equal(typeof record.cooperationId, 'string')
  assert.equal(record.at, FIXED_AT)

  const task = coordinator.get(record.taskId)
  assert.equal(task.state, 'running')
  assert.equal(task.delegatorAgentId, 'parent-1')
  assert.equal(task.ownerAgentId, 'child-sub-1')
  assert.deepEqual(task.effectiveScope, EMPTY_SCOPE)
  assert.deepEqual(EMPTY_SCOPE, {
    capabilityIds: [],
    operations: [],
    resources: [],
    allowWrite: false,
  })
  assert.equal(coordinator.listCooperations().length, 1)

  // A duplicate `agent/created` must not delegate the same task twice.
  subagent.observeAgent(child)
  assert.equal(coordinator.listCooperations().length, 1)
  assert.equal(subagent.status().delegated, 1)

  const [item] = subagent.itemsFor(agentFor('parent-1'))
  assert.equal(item.id, 'dsh:subagent:parent-1:0:subagent-0')
  assert.equal(item.channel, 'subagent')
  assert.deepEqual(item.pointer, { kind: 'subagent', id: 'child-sub-1', version: 'turn:1' })
  assert.equal(item.summary, 'subagent fork child-sub-1 preset=review depth=2')
  assert.deepEqual(item.scores, { relevance: 0.6, urgency: 0.3, confidence: 0.7, importance: 0.9 })
  assert.deepEqual(item.budget, { tokens: 256 })
  assert.equal(item.trust, 'host')
  assertSessionExpiry(item.expiresAt)
})

test('subagent spawn uses inherited defaults and an orphan has no task', () => {
  const coordinator = new CooperationCoordinator()
  const subagent = new SubagentTracker({ coordinator })
  subagent.observeAgent(agentFor('child-spawn', {
    origin: 'subagent',
    isSeeded: false,
    parentSession: 'parent-2',
  }))
  const [item] = subagent.itemsFor(agentFor('parent-2'))
  assert.equal(item.summary, 'subagent spawn child-spawn preset=inherited depth=0')
  assert.equal(subagent.get('child-spawn').seeded, false)
  assert.equal(subagent.get('child-spawn').depth, 0)
  assert.equal(subagent.get('child-spawn').preset, undefined)

  subagent.observeAgent(agentFor('orphan', { origin: 'subagent', isSeeded: true }))
  assert.equal(subagent.get('orphan').taskId, undefined)
  assert.equal(subagent.records().length, 2)
  assert.equal(subagent.itemsFor(agentFor('parent-2')).length, 1)
  assert.equal(coordinator.listCooperations().length, 1)
})

test('subagent items are turn-qualified by observed parent events', () => {
  const subagent = new SubagentTracker()
  subagent.observeAgent(agentFor('child-turn', {
    origin: 'subagent',
    isSeeded: true,
    parentSession: 'parent-4',
  }))
  subagent.observeEvent('parent-4', { type: 'turn/start', data: { turn: 3 } })
  const [item] = subagent.itemsFor(agentFor('parent-4'))
  assert.equal(item.id, 'dsh:subagent:parent-4:3:subagent-0')
})

test('turn/end completed submits success and settles the AMP task', () => {
  const coordinator = new CooperationCoordinator()
  const subagent = new SubagentTracker({ coordinator })
  subagent.observeAgent(agentFor('child-ok', {
    origin: 'subagent',
    isSeeded: true,
    parentSession: 'parent-3',
  }))
  const taskId = subagent.get('child-ok').taskId
  assert.equal(coordinator.get(taskId).state, 'running')

  subagent.observeEvent('child-ok', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(subagent.get('child-ok').state, 'completed')
  assert.equal(coordinator.get(taskId).state, 'completed')
  assert.equal(subagent.status().settled, 1)

  // A repeated end sees a terminal record and does not submit twice.
  subagent.observeEvent('child-ok', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(subagent.status().settled, 1)
})

test('turn/end failure submits failure and settles the AMP task', () => {
  const coordinator = new CooperationCoordinator()
  const subagent = new SubagentTracker({ coordinator })
  subagent.observeAgent(agentFor('child-fail', {
    origin: 'subagent',
    isSeeded: true,
    parentSession: 'parent-5',
  }))
  const taskId = subagent.get('child-fail').taskId
  subagent.observeEvent('child-fail', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  assert.equal(subagent.get('child-fail').state, 'failed')
  assert.equal(coordinator.get(taskId).state, 'failed')
  assert.equal(subagent.status().settled, 1)
})

test('a child without a task stays running after turn/end', () => {
  const subagent = new SubagentTracker({ coordinator: new CooperationCoordinator() })
  subagent.observeAgent(agentFor('orphan-end', { origin: 'subagent', isSeeded: true }))
  subagent.observeEvent('orphan-end', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(subagent.get('orphan-end').state, 'running')
  assert.equal(subagent.status().settled, 0)
})

test('subagent observation and settlement never throw on malformed input', () => {
  const subagent = new SubagentTracker()
  assert.doesNotThrow(() => subagent.observeAgent(undefined))
  assert.doesNotThrow(() => subagent.observeAgent({ id: 'bad', session: {} }))
  assert.doesNotThrow(() => subagent.observeEvent(undefined, { type: 'turn/end' }))
  assert.doesNotThrow(() => subagent.observeEvent('x', undefined))
  assert.doesNotThrow(() => subagent.observeEvent('x', { type: 'turn/end', data: { reason: null } }))
  assert.equal(subagent.records().length, 0)
  assert.ok(subagent.status().failures >= 2)
})

test('subagent records are bounded to 200', () => {
  const subagent = new SubagentTracker()
  const total = MAX_SUBAGENT_RECORDS + 5
  for (let index = 0; index < total; index += 1) {
    subagent.observeAgent(agentFor(`sub-${index}`, { origin: 'subagent', isSeeded: false }))
  }
  assert.equal(subagent.records().length, MAX_SUBAGENT_RECORDS)
  assert.equal(subagent.get('sub-0'), undefined)
  assert.equal(subagent.get(`sub-${total - 1}`).childId, `sub-${total - 1}`)
})

test('lineage merges base, fork and subagent sources and dedupes by id', () => {
  const fork = new ForkTracker()
  const child = agentFor('child-line', { isSeeded: true, parentSession: 'parent-line' }, 4)
  fork.observeAgent(child)
  const [forkItem] = fork.itemsFor(child)

  const subagent = new SubagentTracker()
  subagent.observeAgent(agentFor('child-sub-line', {
    origin: 'subagent',
    isSeeded: true,
    parentSession: 'parent-line',
  }))

  const parent = agentFor('parent-line')
  const other = { ...forkItem, id: 'dsh:workspace:parent-line:0:workspace', channel: 'workspace' }
  const lineage = new LineageSources(baseSource([forkItem, other]), fork, subagent)
  const items = lineage.itemsFor(parent)

  assert.equal(items.length, 3)
  assert.equal(items.filter((item) => item.id === forkItem.id).length, 1)
  assert.ok(items.some((item) => item.id === other.id))
  assert.ok(items.some((item) => item.channel === 'subagent' && item.pointer.id === 'child-sub-line'))

  const status = lineage.status()
  assert.equal(status.lineage.fork.records, 1)
  assert.equal(status.lineage.subagent.records, 1)
  assert.equal(status.lineage.failures, 0)
  assert.equal(status.spill.records, 0)
  assert.deepEqual(EmptyLineageStatus, emptyLineageStatus())
})

test('lineage contains broken sources and falls back to zero status', () => {
  const brokenBase = {
    itemsFor() {
      throw new Error('items')
    },
    status() {
      throw new Error('status')
    },
  }
  const lineage = new LineageSources(brokenBase, new ForkTracker(), new SubagentTracker())
  assert.deepEqual(lineage.itemsFor(agentFor('parent')), [])
  const status = lineage.status()
  assert.equal(status.lineage.failures, 2)
  assert.equal(status.spill.records, 0)
  assert.equal(status.compaction.failures, 0)

  const nonArray = { itemsFor: () => undefined, status: () => emptyOutputStatus() }
  assert.deepEqual(new LineageSources(nonArray, new ForkTracker(), new SubagentTracker()).itemsFor(agentFor('p')), [])
})
