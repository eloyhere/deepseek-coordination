/**
 * AMP → Harness lifecycle synchronization.
 *
 * The two sides own different facts: the Harness owns one live goal per agent
 * (with a CAS revision) and a boolean plan mode, while this plugin owns the AMP
 * goal/plan/mission records. These tests pin the seam:
 *
 *  - `active` creates or resumes the Harness goal, `achieved` completes it and
 *    `abandoned` clears it;
 *  - a refused Harness call is recorded as a note and never thrown, so the AMP
 *    transition that already committed stays committed;
 *  - a Harness goal changed elsewhere is reported as divergence instead of being
 *    silently overwritten;
 *  - plan mode follows "is any plan executing".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestHost } from './helpers.js'
import { HarnessPlanningSync } from '../src/host/harnessSync.js'
import type { GoalLifecycle, GoalState } from 'attention-manifest-protocol/goal'

const clock = { now: () => 1_700_000_000_000 }

interface RemoteGoal {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
}

/** A tiny stand-in for `ctx.goals`; every call is recorded for assertions. */
function fakeGoals(initial?: RemoteGoal) {
  const calls: string[] = []
  let current: RemoteGoal | undefined = initial
  let sequence = 100
  return {
    calls,
    get current() {
      return current
    },
    /** Simulate another writer replacing the live goal. */
    replace(next: RemoteGoal | undefined) {
      current = next
    },
    port: {
      get: () => {
        calls.push('get')
        return current === undefined ? undefined : { ...current }
      },
      create: (_agent: unknown, request: { objective: string }) => {
        calls.push(`create:${request.objective}`)
        sequence += 1
        current = { id: `harness-goal-${sequence}`, revision: 1, objective: request.objective, phase: 'active' }
        return { ...current }
      },
      resume: (_agent: unknown, ref: unknown) => {
        calls.push('resume')
        const { id } = ref as { id: string }
        current = { ...(current as RemoteGoal), id, revision: (current?.revision ?? 0) + 1, phase: 'active' }
        return { ...current }
      },
      complete: (_agent: unknown, ref: unknown) => {
        calls.push('complete')
        const { id, revision } = ref as { id: string; revision: number }
        current = { id, revision: revision + 1, objective: current?.objective ?? '', phase: 'complete' }
        return { ...current }
      },
      clear: () => {
        calls.push('clear')
        current = undefined
        return { id: 'cleared', revision: 1 }
      },
    },
  }
}

const agent = { id: 'session-a' }

function lifecycle(state: GoalState, statement = 'ship the thing'): GoalLifecycle {
  return {
    goal: {
      amp: '0.1',
      kind: 'goal',
      id: 'goal-1',
      statement,
      success: [{ id: 's1', statement: 'it works', check: 'manual' }],
      value: 0.6,
      priority: 1,
    },
    state,
  } as unknown as GoalLifecycle
}

function harness(seed?: RemoteGoal, planModeSet?: (active: boolean) => string) {
  const host = createTestHost()
  const goals = fakeGoals(seed)
  const sync = new HarnessPlanningSync({
    db: host.db,
    clock,
    goals: goals.port,
    agents: { get: (id: string) => (id === 'session-a' ? agent : undefined) },
    ...(planModeSet === undefined
      ? {}
      : { planMode: { get: () => ({ active: false }), set: (_a: unknown, active: boolean) => planModeSet(active) } }),
  } as never)
  return { sync, goals, close: () => host.close() }
}

test('an active AMP goal creates one Harness goal and records the link', () => {
  const h = harness()
  try {
    const link = h.sync.pushGoal('session-a', lifecycle('active'))
    assert.equal(link?.remoteId, 'harness-goal-101')
    assert.equal(link?.phase, 'active')
    assert.equal(link?.revision, 1)
    assert.deepEqual(h.goals.calls, ['get', 'create:ship the thing'])
    assert.equal(h.sync.link('session-a', 'goal-1')?.remoteId, 'harness-goal-101')
  } finally {
    h.close()
  }
})

test('re-activating the same goal resumes instead of creating a second one', () => {
  const h = harness({ id: 'harness-goal-9', revision: 3, objective: 'ship the thing', phase: 'paused' })
  try {
    const link = h.sync.pushGoal('session-a', lifecycle('active'))
    assert.equal(link?.remoteId, 'harness-goal-9')
    assert.equal(link?.phase, 'active')
    assert.ok(h.goals.calls.includes('resume'))
    assert.equal(h.goals.calls.filter((call) => call.startsWith('create')).length, 0)
  } finally {
    h.close()
  }
})

test('a completed Harness goal is replaced rather than resumed', () => {
  const h = harness({ id: 'harness-goal-1', revision: 4, objective: 'old', phase: 'complete' })
  try {
    const link = h.sync.pushGoal('session-a', lifecycle('active'))
    assert.equal(link?.remoteId, 'harness-goal-101')
    assert.equal(h.goals.calls.filter((call) => call.startsWith('create')).length, 1)
    assert.equal(h.goals.calls.includes('resume'), false)
  } finally {
    h.close()
  }
})

test('achieved completes and abandoned clears the linked Harness goal', () => {
  const h = harness()
  try {
    h.sync.pushGoal('session-a', lifecycle('active'))
    const achieved = h.sync.pushGoal('session-a', lifecycle('achieved'))
    assert.equal(achieved?.phase, 'complete')
    assert.ok(h.goals.calls.includes('complete'))

    const second = harness()
    try {
      second.sync.pushGoal('session-a', lifecycle('active'))
      second.sync.pushGoal('session-a', lifecycle('abandoned'))
      assert.ok(second.goals.calls.includes('clear'))
    } finally {
      second.close()
    }
  } finally {
    h.close()
  }
})

test('a Harness refusal is recorded as a note and never thrown', () => {
  const host = createTestHost()
  try {
    const sync = new HarnessPlanningSync({
      db: host.db,
      clock,
      goals: {
        get: () => undefined,
        create: () => {
          throw new Error('goal service refused: revision conflict')
        },
      },
      agents: { get: () => agent },
    } as never)
    const link = sync.pushGoal('session-a', lifecycle('active'))
    assert.match(link?.note ?? '', /revision conflict/)
    // The AMP side already committed, so the link row exists with the note.
    assert.match(sync.link('session-a', 'goal-1')?.note ?? '', /revision conflict/)
  } finally {
    host.close()
  }
})

test('a missing goal service or agent yields a note, not an exception', () => {
  const host = createTestHost()
  try {
    const noService = new HarnessPlanningSync({ db: host.db, clock } as never)
    assert.match(noService.pushGoal('session-a', lifecycle('active'))?.note ?? '', /no Harness goal service/)
    const noAgent = new HarnessPlanningSync({
      db: host.db,
      clock,
      goals: { get: () => undefined, create: () => ({ id: 'x' }) },
      agents: { get: () => undefined },
    } as never)
    assert.match(noAgent.pushGoal('session-a', lifecycle('active'))?.note ?? '', /no live Harness agent/)
  } finally {
    host.close()
  }
})

test('pullGoal reports divergence when the Harness goal was replaced elsewhere', () => {
  const h = harness()
  try {
    const pushed = h.sync.pushGoal('session-a', lifecycle('active'))
    assert.equal(pushed?.remoteId, 'harness-goal-101')
    // Another writer clears the goal behind this module's back.
    h.goals.replace(undefined)
    const cleared = h.sync.pullGoal('session-a', 'goal-1')
    assert.equal(cleared.diverged, true)
    assert.match(cleared.note ?? '', /cleared elsewhere/)
    // A goal that is still the linked one is not divergence.
    h.goals.replace({ id: 'harness-goal-101', revision: 3, objective: 'ship the thing', phase: 'active' })
    const same = h.sync.pullGoal('session-a', 'goal-1')
    assert.equal(same.diverged, false)
    assert.equal(same.phase, 'active')
  } finally {
    h.close()
  }
})

test('plan mode follows the executing-plan flag and stays optional', () => {
  const seen: boolean[] = []
  const h = harness(undefined, (active) => {
    seen.push(active)
    return 'committed'
  })
  try {
    assert.equal(h.sync.pushPlanMode('session-a', true), 'committed')
    assert.equal(h.sync.pushPlanMode('session-a', false), 'committed')
    assert.deepEqual(seen, [true, false])
  } finally {
    h.close()
  }
  const withoutPlanMode = harness()
  try {
    assert.equal(withoutPlanMode.sync.pushPlanMode('session-a', true), undefined)
    assert.equal(withoutPlanMode.sync.status('session-a', ['goal-1']).planMode, 'unavailable')
  } finally {
    withoutPlanMode.close()
  }
})

test('sync status summarises the goal service and the plan-mode switch', () => {
  const h = harness()
  try {
    const status = h.sync.status('session-a', ['goal-1'])
    assert.equal(status.goals, 'synced')
    assert.equal(status.planMode, 'unavailable')
  } finally {
    h.close()
  }
})
