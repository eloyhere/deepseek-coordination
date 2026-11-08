/**
 * S2 fault-injection tests.
 *
 * These tests drive the real host-side observers with oversized, malformed,
 * duplicated and throwing inputs. They assert only the host contract: an
 * observer never throws into the DSH step, every skip is counted, and every
 * retained map/list stays bounded. TypeScript modules are imported directly
 * with Node 24 type stripping; the repository's `.js` specifier convention is
 * mapped to the `.ts` sibling by the same small resolve hook as the P1 suite.
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

const {
  MAX_EVENTS_PER_SESSION,
  MAX_RECOVERY_AGENTS,
  MAX_RECOVERY_SESSIONS,
  recoverContext,
} = await import('../src/host/recovery.ts')
const {
  MAX_PREVIOUS_ITEMS,
  MAX_TOMBSTONES,
  baseWireId,
  diffTombstones,
} = await import('../src/host/tombstones.ts')
const { WireCapture } = await import('../src/host/prestep.ts')
const { ForkTracker } = await import('../src/host/fork.ts')
const { SubagentTracker } = await import('../src/host/subagent.ts')
const { SpillIndex } = await import('../src/host/spill.ts')
const { RetentionLedger } = await import('../src/host/retention.ts')
const { PruneTracker } = await import('../src/host/prune.ts')
const { CompactionTracker } = await import('../src/host/compaction.ts')

const FIXED_AT = '2026-11-09T00:00:00.000Z'
const SPILL_TEXT = '(Omitted 42 bytes. Full formatted result stored at: C:\\tmp\\fault.txt. Read the full result.)'
const ONE_MEGABYTE = 1024 * 1024 + 1

/** One session event fixture; `seq`/`time` are supplied by the fake session. */
function sessionEvent(type, data) {
  return { type, data }
}

/** One human prompt event (`user/message` data is the message itself). */
function userPrompt(text) {
  return sessionEvent('user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

/** A fake session over a mutable event array. */
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

/** Fresh tracker set for recovery passes. */
function makeDeps() {
  return {
    capture: new WireCapture({ now: () => new Date(FIXED_AT) }),
    fork: new ForkTracker({ now: () => FIXED_AT }),
    subagent: new SubagentTracker({ now: () => FIXED_AT }),
    spill: new SpillIndex(),
    retention: new RetentionLedger(),
    prune: new PruneTracker(),
    compaction: new CompactionTracker(),
  }
}

/** One tool result message carrying `text`; the only shape observers read. */
function toolResult(text, callId = 'call-1') {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text }],
      },
    },
  }
}

test('spill tolerates >1MB and malformed results and dedupes repeats', () => {
  const spill = new SpillIndex()
  const huge = toolResult(`${'x'.repeat(ONE_MEGABYTE)}${SPILL_TEXT}`)

  assert.doesNotThrow(() => spill.observe('session-huge', huge))
  assert.equal(spill.list('session-huge').length, 1)
  const record = spill.list('session-huge')[0]
  assert.equal(record.locator, 'C:\\tmp\\fault.txt')
  assert.equal(record.bytes, 42)
  assert.equal(record.tool, 'tool')
  assert.ok(record.retrievalHint.length <= 160)
  assert.equal(spill.status().records, 1)

  // A repeated observation is ignored, not retained twice.
  assert.doesNotThrow(() => spill.observe('session-huge', huge))
  assert.equal(spill.list('session-huge').length, 1)
  assert.equal(spill.status().duplicates, 1)

  // A >1MB result without a notice is scanned and dropped.
  assert.doesNotThrow(() => spill.observe('session-huge', toolResult('z'.repeat(ONE_MEGABYTE))))
  assert.equal(spill.list('session-huge').length, 1)

  const junk = [
    undefined,
    null,
    42,
    'tool/result',
    {},
    { type: 'tool/result' },
    { type: 'tool/result', data: null },
    { type: 'tool/result', data: { message: null } },
    { type: 'tool/result', data: { message: { content: [null, 7, { type: 'text', text: 9 }] } } },
    { get type() { throw new Error('hostile type') } },
  ]
  assert.doesNotThrow(() => {
    for (const event of junk) spill.observe('session-junk', event)
    spill.observe('', huge)
    spill.observe(undefined, huge)
  })
  assert.equal(spill.list('session-junk').length, 0)
  assert.ok(spill.status().failures >= 1)
})

test('retention tolerates >1MB and malformed results and dedupes repeats', () => {
  const ledger = new RetentionLedger()
  const huge = toolResult(`${'y'.repeat(ONE_MEGABYTE)}Omitted 12345 items.`)

  assert.doesNotThrow(() => ledger.observe('session-huge', huge))
  assert.equal(ledger.list('session-huge').length, 1)
  const record = ledger.list('session-huge')[0]
  assert.equal(record.tool, 'tool')
  assert.deepEqual(record.omitted, { kind: 'exact', count: 12345 })

  assert.doesNotThrow(() => ledger.observe('session-huge', huge))
  assert.equal(ledger.list('session-huge').length, 1)
  assert.equal(ledger.status().duplicates, 1)

  // A >1MB result without a notice is scanned and dropped.
  assert.doesNotThrow(() => ledger.observe('session-huge', toolResult('z'.repeat(ONE_MEGABYTE))))
  assert.equal(ledger.list('session-huge').length, 1)

  const junk = [
    undefined,
    null,
    42,
    {},
    { type: 'tool/result' },
    { type: 'tool/result', data: null },
    { type: 'tool/result', data: { message: null } },
    { type: 'tool/result', data: { message: { content: [true, { type: 'text', text: 3 }] } } },
    {
      type: 'tool/result',
      get data() {
        throw new Error('hostile data')
      },
    },
  ]
  assert.doesNotThrow(() => {
    for (const event of junk) ledger.observe('session-junk', event)
    ledger.observe('', huge)
  })
  assert.equal(ledger.list('session-junk').length, 0)
  assert.ok(ledger.status().failures >= 1)
})

test('prune records non-adjacent, missing and malformed replacements without throwing', () => {
  const prune = new PruneTracker()
  const pruneEvent = (overrides = {}) => ({
    type: 'compaction/prune',
    data: {
      turn: 1,
      shadowedRange: { start: 10, end: 12 },
      shadowedSeqs: [10, 11],
      shadowedTokenCount: 7,
      ...overrides,
    },
  })
  const replacement = (seq, sourceEventSeqs) => ({
    type: 'tool/result',
    seq,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'call-prune' },
        content: [{ type: 'text', text: 'head…tail' }],
      },
    },
  })

  // The replacement is not adjacent: the association is abandoned, not guessed.
  assert.doesNotThrow(() => {
    prune.observe('session-nonadjacent', pruneEvent())
    prune.observe('session-nonadjacent', { type: 'tool/call', data: { turn: 1, callId: 'call-1', name: 'shell' } })
    prune.observe('session-nonadjacent', replacement(21, [10]))
  })
  const nonAdjacent = prune.list('session-nonadjacent')
  assert.equal(nonAdjacent.length, 1)
  assert.equal(nonAdjacent[0].replacementSeq, undefined)
  assert.ok(prune.status().unlinked >= 1)

  // The adjacent replacement exists but does not cite the shadowed seq.
  assert.doesNotThrow(() => {
    prune.observe('session-missing', pruneEvent())
    prune.observe('session-missing', replacement(22, undefined))
  })
  const missing = prune.list('session-missing')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].replacementSeq, undefined)
  assert.equal(prune.status().unlinked, 2)

  const junk = [
    undefined,
    null,
    42,
    {},
    { type: 'compaction/prune' },
    { type: 'compaction/prune', data: null },
    { type: 'compaction/prune', data: { shadowedRange: { start: 'x', end: 2 } } },
    { type: 'compaction/prune', data: { shadowedRange: { start: 1, end: -1 } } },
    { type: 'compaction/prune', data: { shadowedRange: null } },
  ]
  assert.doesNotThrow(() => {
    for (const event of junk) prune.observe('session-junk', event)
  })
  assert.equal(prune.list('session-junk').length, 0)
  assert.equal(prune.status().records, 2)

  // The happy path still links and keeps host exclusions bounded.
  const linked = new PruneTracker()
  linked.observe('session-linked', pruneEvent())
  linked.observe('session-linked', replacement(23, [10, 11]))
  assert.equal(linked.list('session-linked')[0].replacementSeq, 23)
  assert.equal(linked.list('session-linked')[0].charsAfter, 'head…tail'.length)
  assert.ok(linked.hostExclusions().length <= 256)
})

test('compaction tolerates no start, duplicate summaries, error ends and huge text', () => {
  const compaction = new CompactionTracker()

  // A summary with no `seq` and no open start has no anchor: no record.
  assert.doesNotThrow(() => compaction.observe('session-no-start', {
    type: 'compaction/summary',
    data: {
      turn: 1,
      compactionId: 'no-start',
      shadowedRange: { start: 0, end: 2 },
      summary: 'orphan summary',
    },
  }))
  assert.equal(compaction.records('session-no-start').length, 0)

  // An end with no summary never creates an empty record.
  assert.doesNotThrow(() => compaction.observe('session-no-start', {
    type: 'compaction/end',
    seq: 1,
    data: { turn: 1, compactionId: 'no-start', error: 'summary failed' },
  }))
  assert.equal(compaction.records('session-no-start').length, 0)
  assert.equal(compaction.status().ends, 0)

  assert.doesNotThrow(() => {
    compaction.observe('session-compaction', {
      type: 'compaction/start',
      seq: 1,
      data: { turn: 1, compactionId: 'c-1' },
    })
    const summary = {
      type: 'compaction/summary',
      seq: 2,
      data: {
        turn: 1,
        compactionId: 'c-1',
        shadowedRange: { start: 0, end: 5 },
        shadowedSeqs: [0, 1],
        shadowedTokenCount: 10,
        summary: [{ type: 'text', text: 'first summary' }],
      },
    }
    compaction.observe('session-compaction', summary)
    // A duplicate summary is ignored: the first record wins.
    compaction.observe('session-compaction', {
      ...summary,
      seq: 3,
      data: { ...summary.data, summary: [{ type: 'text', text: 'second summary' }] },
    })
  })
  assert.equal(compaction.records('session-compaction').length, 1)
  assert.equal(compaction.records('session-compaction')[0].summary, 'first summary')
  assert.equal(compaction.status().summaries, 1)

  assert.doesNotThrow(() => compaction.observe('session-compaction', {
    type: 'compaction/end',
    seq: 4,
    data: { turn: 1, compactionId: 'c-1', error: 'provider error' },
  }))
  const failed = compaction.records('session-compaction')[0]
  assert.equal(failed.endSeq, 4)
  assert.equal(failed.error, 'provider error')

  const hugeText = 'w'.repeat(ONE_MEGABYTE)
  assert.doesNotThrow(() => {
    compaction.observe('session-compaction', {
      type: 'compaction/start',
      seq: 5,
      data: { turn: 1, compactionId: 'c-huge' },
    })
    compaction.observe('session-compaction', {
      type: 'compaction/summary',
      seq: 6,
      data: {
        turn: 1,
        compactionId: 'c-huge',
        shadowedRange: { start: 6, end: 9 },
        shadowedSeqs: [6, 7, 8],
        shadowedTokenCount: 3,
        summary: hugeText,
      },
    })
  })
  const huge = compaction.records('session-compaction').find((record) => record.compactionId === 'c-huge')
  assert.ok(huge)
  assert.ok(huge.summary.length <= 2001)
  assert.equal(huge.summary.startsWith('w'), true)
  assert.equal(huge.summary.endsWith('…'), true)
  assert.equal(huge.summaryDigest.startsWith('sha256:'), true)
  assert.equal(huge.summaryDigest.length, 71)

  // A throwing payload is counted, not propagated.
  assert.doesNotThrow(() => compaction.observe('session-hostile', {
    type: 'compaction/summary',
    seq: 7,
    data: {
      turn: 1,
      compactionId: 'hostile',
      get shadowedRange() {
        throw new Error('hostile range')
      },
    },
  }))
  assert.ok(compaction.status().failures >= 1)
})

test('subagent coordinator failures are counted and leave the tracker usable', () => {
  const task = { taskId: 'task-1', cooperationId: 'coop-1', ownerEpoch: 3, fence: 'fence-1' }
  const childAgent = (id) => ({
    id,
    session: { header: { origin: 'subagent', parentSession: 'parent-1', delegationDepth: 0 } },
  })

  // `delegate()` throws: the lineage record exists in `unknown`, no task id.
  const delegateBoom = new SubagentTracker({
    coordinator: {
      delegate() {
        throw new Error('delegate boom')
      },
      start() {
        throw new Error('start must not run')
      },
      submitResult() {
        throw new Error('submit must not run')
      },
    },
    now: () => FIXED_AT,
  })
  assert.doesNotThrow(() => delegateBoom.observeAgent(childAgent('child-delegate')))
  const delegated = delegateBoom.get('child-delegate')
  assert.ok(delegated)
  assert.equal(delegated.state, 'unknown')
  assert.equal(delegated.taskId, undefined)
  assert.ok(delegateBoom.status().failures >= 1)
  assert.equal(delegateBoom.status().delegated, 0)

  // `start()` throws: same bounded degradation.
  const startBoom = new SubagentTracker({
    coordinator: {
      delegate: () => ({ ...task }),
      start() {
        throw new Error('start boom')
      },
      submitResult() {
        throw new Error('submit must not run')
      },
    },
    now: () => FIXED_AT,
  })
  assert.doesNotThrow(() => startBoom.observeAgent(childAgent('child-start')))
  const started = startBoom.get('child-start')
  assert.ok(started)
  assert.equal(started.state, 'unknown')
  assert.ok(startBoom.status().failures >= 1)
  assert.equal(startBoom.status().delegated, 0)

  // `submitResult()` throws on turn/end: the task stays running and is counted.
  let submissions = 0
  const submitBoom = new SubagentTracker({
    coordinator: {
      delegate: () => ({ ...task }),
      start: () => ({ ...task }),
      submitResult() {
        submissions += 1
        throw new Error('submit boom')
      },
    },
    now: () => FIXED_AT,
  })
  assert.doesNotThrow(() => submitBoom.observeAgent(childAgent('child-submit')))
  assert.equal(submitBoom.get('child-submit').state, 'running')
  assert.equal(submitBoom.status().delegated, 1)
  assert.doesNotThrow(() => submitBoom.observeEvent('child-submit', {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  }))
  assert.equal(submissions, 1)
  assert.equal(submitBoom.get('child-submit').state, 'running')
  assert.equal(submitBoom.status().settled, 0)
  assert.ok(submitBoom.status().failures >= 1)
})

test('recovery stops at the service enumeration caps', () => {
  const sessions = Array.from({ length: MAX_RECOVERY_SESSIONS + 100 }, (_, index) => fakeSession(
    `session-cap-${index}`,
    [sessionEvent('turn/start', { turn: 1 }), userPrompt(`prompt ${index}`)],
  ))
  const ctx = fakeContext([], sessions)
  const deps = makeDeps()

  let status
  assert.doesNotThrow(() => {
    status = recoverContext(ctx, deps)
  })
  assert.equal(status.sessions, MAX_RECOVERY_SESSIONS)
  assert.equal(status.agents, 0)
  assert.equal(status.events, MAX_RECOVERY_SESSIONS * 2)
  assert.equal(status.hydrations, MAX_RECOVERY_SESSIONS)
  assert.equal(status.failures, 1)

  // The truncation is stable: the retained cursors resume at their last seq.
  const second = recoverContext(ctx, deps)
  assert.equal(second.sessions, MAX_RECOVERY_SESSIONS)
  assert.equal(second.events, 0)
  assert.equal(second.failures, 1)

  const agents = Array.from({ length: MAX_RECOVERY_AGENTS + 50 }, (_, index) => (
    agentFor(fakeSession(`agent-cap-${index}`))
  ))
  const agentStatus = recoverContext(fakeContext(agents, []), makeDeps())
  assert.equal(agentStatus.agents, MAX_RECOVERY_AGENTS)
  assert.equal(agentStatus.sessions, MAX_RECOVERY_AGENTS)
  assert.equal(agentStatus.events, 0)
  assert.equal(agentStatus.failures, 1)
})

test('recovery replays only the newest events of one oversized session', () => {
  const total = MAX_EVENTS_PER_SESSION + 10_000
  const events = new Array(total)
  for (let index = 0; index < total; index += 1) {
    if (index === total - 10) {
      events[index] = sessionEvent('turn/start', { turn: 7 })
    } else if (index === total - 1) {
      events[index] = userPrompt('tail prompt')
    } else {
      events[index] = sessionEvent('noop', { turn: 7 })
    }
  }
  const session = fakeSession('session-oversized', events)
  const deps = makeDeps()

  let status
  const started = Date.now()
  assert.doesNotThrow(() => {
    status = recoverContext(fakeContext([agentFor(session)], [session]), deps)
  })
  const elapsed = Date.now() - started

  assert.equal(status.sessions, 1)
  assert.equal(status.agents, 1)
  assert.equal(status.events, MAX_EVENTS_PER_SESSION)
  assert.equal(status.failures, 1)
  assert.equal(status.hydrations, 1)
  const pending = deps.capture.pendingFor('session-oversized', 7)
  assert.ok(pending)
  assert.equal(pending.prompt, 'tail prompt')
  assert.ok(elapsed < 10_000, `recovery took ${elapsed}ms`)
})

test('recovery never throws on malformed services, lists or sessions', () => {
  const deps = makeDeps()
  assert.doesNotThrow(() => recoverContext({}, deps))
  assert.doesNotThrow(() => recoverContext({
    agents: { list: () => 'not-an-array' },
    sessions: { list: () => ({}) },
  }, deps))
  assert.doesNotThrow(() => recoverContext({
    get agents() {
      throw new Error('broken agents')
    },
    sessions: { list: () => [] },
  }, deps))
  assert.doesNotThrow(() => recoverContext({
    sessions: {
      list() {
        throw new Error('broken sessions')
      },
    },
  }, deps))

  let status
  assert.doesNotThrow(() => {
    status = recoverContext({
      sessions: {
        list: () => [
          null,
          {},
          { id: 'bad-seq', seq: 'many', eventAt: () => ({}) },
          {
            id: 'bad-read',
            get seq() {
              return 3
            },
            eventAt() {
              throw new Error('bad event')
            },
          },
          { id: '', seq: 1, eventAt: () => ({}) },
        ],
      },
    }, deps)
  })
  assert.ok(status.failures >= 1)
  assert.equal(status.sessions, 1)
})

test('recovery evicts oldest session cursors beyond the per-context cap', () => {
  const agentSessions = Array.from({ length: 150 }, (_, index) => fakeSession(
    `agent-${index}`,
    [sessionEvent('turn/start', { turn: 1 }), userPrompt(`prompt ${index}`)],
  ))
  const listed = Array.from({ length: 150 }, (_, index) => fakeSession(
    `listed-${index}`,
    [sessionEvent('turn/start', { turn: 1 }), userPrompt(`prompt ${index}`)],
  ))
  const ctx = fakeContext(agentSessions.map(agentFor), listed)
  const deps = makeDeps()

  const first = recoverContext(ctx, deps)
  assert.equal(first.sessions, 300)
  assert.equal(first.agents, 150)
  assert.equal(first.events, 600)
  assert.equal(first.failures, 0)

  // The first 100 cursors were evicted, so those sessions replay from seq 0.
  const second = recoverContext(ctx, deps)
  assert.equal(second.sessions, 300)
  assert.equal(second.events, 200)
  assert.equal(second.failures, 0)
})

test('tombstones bound both the previous scan and the next map', () => {
  const scope = { tenantId: 'tenant-1', principalId: 'session-1', sessionId: 'session-1' }
  const turnId = 'turn-1'
  const now = '2026-11-09T00:00:00.000Z'
  const wireItem = (id) => ({
    id,
    pointer: { kind: 'tool', id: `call-${id}`, version: 'seq:7' },
    summary: `summary for ${id}`,
  })

  const previous = new Map()
  for (let index = 0; index < MAX_PREVIOUS_ITEMS + 500; index += 1) {
    const item = wireItem(`dsh:tool:session-1:2:item-${index}`)
    previous.set(baseWireId(item.id), item)
  }
  const current = Array.from({ length: MAX_PREVIOUS_ITEMS + 200 }, (_, index) => (
    wireItem(`dsh:tool:session-1:2:current-${index}`)
  ))

  let result
  assert.doesNotThrow(() => {
    result = diffTombstones(previous, current, scope, turnId, now)
  })
  assert.equal(result.next.size, MAX_PREVIOUS_ITEMS)
  assert.equal(result.next.has('dsh:tool:session-1:2:current-0'), false)
  assert.equal(result.next.has(`dsh:tool:session-1:2:current-${MAX_PREVIOUS_ITEMS + 199}`), true)
  assert.equal(result.tombstones.length, MAX_TOMBSTONES)
  assert.equal(result.tombstones[0].id, 'dsh:tool:session-1:2:item-1450')
  assert.equal(result.tombstones.at(-1).id, 'dsh:tool:session-1:2:item-1499')

  // Oversized previous maps are scanned only from their newest window; the
  // skipped prefix is not touched at all, so throwing getters there are safe.
  const hostile = new Map()
  for (let index = 0; index < MAX_PREVIOUS_ITEMS + 500; index += 1) {
    const value = index < 500
      ? {
          get id() {
            throw new Error('hostile id')
          },
          get pointer() {
            throw new Error('hostile pointer')
          },
          get summary() {
            throw new Error('hostile summary')
          },
        }
      : wireItem(`dsh:tool:session-1:2:hostile-${index}`)
    hostile.set(`hostile-${index}`, value)
  }
  let hostileResult
  assert.doesNotThrow(() => {
    hostileResult = diffTombstones(hostile, [], scope, turnId, now)
  })
  assert.equal(hostileResult.next.size, 0)
  assert.equal(hostileResult.tombstones.length, MAX_TOMBSTONES)
})
