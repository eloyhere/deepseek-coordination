/**
 * Harness → AMP projection import.
 *
 * The Harness owns one live goal per agent (`ctx.goals`), and this plugin's
 * navigation used to show only goals written *through* its own tools. A goal
 * created by the Harness itself (`create_goal`, `/goal`) was therefore invisible
 * in the goals/missions/plans navigation even though the host was working toward
 * it. These tests pin the reverse direction:
 *
 *  - an `active`/`complete` Harness goal becomes a visible AMP goal carrying the
 *    host objective and a deterministic local id;
 *  - a second read is a no-op: no duplicate row, no duplicate ledger entry;
 *  - `paused`/`blocked` are recorded on the link instead of being guessed;
 *  - the import never echoes a phase back into the Harness (`create`/`resume`/
 *    `complete`/`clear`), which would churn the host's CAS lifecycle;
 *  - missing ports, a missing agent and a missing goal are silent, and a cleared
 *    Harness goal is reported as divergence rather than deleted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentPort, GoalPort } from '../src/host/module.js'
import { AmpPlanning } from '../src/host/ampPlanning.js'
import { ampIdOfRemote } from '../src/host/harnessSync.js'
import { createTestHost, insertSession } from './helpers.js'

type Phase = 'active' | 'paused' | 'blocked' | 'complete'

interface RemoteGoal {
  id: string
  revision: number
  objective: string
  phase: Phase
}

const agent = { id: 'session-a' }

/** A tiny `ctx.goals` stand-in; every call is recorded so echo-back is visible. */
function fakeGoals(initial?: RemoteGoal) {
  const calls: string[] = []
  let current: RemoteGoal | undefined = initial
  const port: GoalPort = {
    get: () => {
      calls.push('get')
      return current === undefined ? undefined : { ...current }
    },
    create: (_agent, request) => {
      calls.push(`create:${request.objective}`)
      // A reached push means the projection echoed back: fail before it writes.
      throw new Error('the projection import must not create a Harness goal')
    },
    resume: () => {
      calls.push('resume')
      throw new Error('the projection import must not resume a Harness goal')
    },
    complete: () => {
      calls.push('complete')
      throw new Error('the projection import must not complete a Harness goal')
    },
    clear: () => {
      calls.push('clear')
      throw new Error('the projection import must not clear a Harness goal')
    },
  }
  return {
    calls,
    port,
    /** Simulate another writer moving the Harness goal. */
    replace(next: RemoteGoal | undefined): void {
      current = next
    },
  }
}

const agentsOf = (): AgentPort => ({
  get: (id: string) => (id === agent.id ? agent : undefined),
  list: () => [agent],
})

/** A test host with one registered session and a live fake goal port. */
function fixture(seed?: RemoteGoal) {
  const h = createTestHost()
  insertSession(h.db, 'session-a')
  const goals = fakeGoals(seed)
  const planning = new AmpPlanning({ ...h.host, goals: goals.port, agents: agentsOf() })
  return { ...h, goals, planning }
}

const active = (patch: Partial<RemoteGoal> = {}): RemoteGoal => ({
  id: 'harness-goal-1',
  revision: 1,
  objective: 'Ship the release',
  phase: 'active',
  ...patch,
})

test('an active Harness goal becomes a visible AMP goal with the host objective', () => {
  const h = fixture(active())
  try {
    const goals = h.planning.goals('session-a')
    assert.equal(goals.length, 1)
    assert.equal(goals[0]?.state, 'active')
    assert.equal(goals[0]?.goal.statement, 'Ship the release')
    // The local id is the deterministic translation of the Harness id, so the
    // navigation and the link row cannot drift apart between reads.
    assert.equal(goals[0]?.goal.id, ampIdOfRemote('harness-goal-1'))
    assert.equal(goals[0]?.goal.value, 0.5)
    assert.equal(goals[0]?.goal.priority, 0)
    assert.deepEqual(goals[0]?.goal.success, [{
      id: 'host-completion',
      statement: 'the host reports this goal complete',
      check: 'coordination_goal list shows the imported goal in state achieved',
      kind: 'assert',
    }])

    // `view` is the payload the panel and the mission/goal/plan navigation read.
    const view = h.planning.view('session-a')
    assert.deepEqual(view.goals, goals)
    assert.deepEqual(view.missions, [])
    assert.deepEqual(view.plans, [])
  } finally {
    h.close()
  }
})

test('importing the same Harness goal twice keeps one row and one ledger append', () => {
  const h = fixture(active())
  try {
    const first = h.planning.syncFromHarness('session-a')
    assert.equal(first?.created, true)
    assert.equal(first?.goal, ampIdOfRemote('harness-goal-1'))
    const ledger = h.db.count('amp_object')
    const stored = h.planning.goals('session-a')

    const second = h.planning.syncFromHarness('session-a')
    assert.equal(second?.created, false)
    assert.equal(h.db.count('amp_planning_goal'), 1)
    assert.equal(h.db.count('harness_link'), 1)
    assert.equal(h.db.count('amp_object'), ledger, 'a repeated read writes no ledger entry')
    assert.deepEqual(h.planning.goals('session-a'), stored)

    // Phase changes refresh the link, never the number of goals.
    h.goals.replace(active({ revision: 2 }))
    h.planning.goals('session-a')
    assert.equal(h.db.count('amp_planning_goal'), 1)
    assert.equal(h.db.count('amp_object'), ledger)
    assert.equal(h.planning.harnessLink('session-a', first!.goal)?.revision, 2)
  } finally {
    h.close()
  }
})

test('a completed Harness goal aligns the imported goal to achieved', () => {
  const h = fixture({ id: 'harness-goal-2', revision: 7, objective: 'Land the fix', phase: 'complete' })
  try {
    const goals = h.planning.goals('session-a')
    assert.equal(goals.length, 1)
    assert.equal(goals[0]?.state, 'achieved')
    assert.ok(goals[0]?.achievedAt !== undefined)
    // The whole admission path was walked locally, with no push to the host.
    assert.deepEqual(h.goals.calls.filter(call => call !== 'get'), [])
    const link = h.planning.harnessLink('session-a', goals[0]!.goal.id)
    assert.equal(link?.phase, 'complete')
    assert.equal(link?.remoteId, 'harness-goal-2')
  } finally {
    h.close()
  }
})

test('a paused Harness goal is committed and recorded on the link, not guessed', () => {
  const h = fixture({ id: 'harness-goal-3', revision: 2, objective: 'Wait for review', phase: 'paused' })
  try {
    const goals = h.planning.goals('session-a')
    assert.equal(goals[0]?.state, 'committed', 'paused is not an AMP state and never means active')
    const link = h.planning.harnessLink('session-a', goals[0]!.goal.id)
    assert.equal(link?.phase, 'paused')
    assert.equal(link?.revision, 2)
    assert.match(link?.note ?? '', /paused/)
    // Still one goal, still committed: a repeated read changes nothing.
    assert.equal(h.planning.goals('session-a')[0]?.state, 'committed')
  } finally {
    h.close()
  }
})

test('the import never pushes a projected phase back to the Harness', () => {
  const h = fixture(active())
  try {
    h.planning.goals('session-a')
    h.planning.goals('session-a')
    h.planning.view('session-a')
    assert.equal(h.planning.syncStatus('session-a').goals, 'synced')
    // The Harness moves its own goal to complete; the import follows it.
    h.goals.replace(active({ revision: 4, phase: 'complete' }))
    assert.equal(h.planning.goals('session-a')[0]?.state, 'achieved')
    // Only reads: no create/resume/complete/clear was ever attempted.
    assert.deepEqual(h.goals.calls.filter(call => call !== 'get'), [])
  } finally {
    h.close()
  }
})

test('a missing goal, agent or goal service yields an empty list without throwing', () => {
  const noGoal = fixture()
  try {
    assert.deepEqual(noGoal.planning.goals('session-a'), [])
    assert.equal(noGoal.db.count('amp_planning_goal'), 0)
    assert.deepEqual(noGoal.goals.calls, ['get'], 'the read is attempted exactly once')
  } finally {
    noGoal.close()
  }

  // A goal port with no agent port: nothing can carry a goal, so nothing runs.
  const noAgent = createTestHost()
  insertSession(noAgent.db, 'session-a')
  try {
    const goals = fakeGoals(active())
    const planning = new AmpPlanning({ ...noAgent.host, goals: goals.port })
    assert.deepEqual(planning.goals('session-a'), [])
    assert.deepEqual(goals.calls, [])
    assert.equal(noAgent.db.count('amp_planning_goal'), 0)
  } finally {
    noAgent.close()
  }

  // No goal service at all: the historical behaviour, unchanged.
  const noPort = createTestHost()
  insertSession(noPort.db, 'session-a')
  try {
    assert.deepEqual(new AmpPlanning(noPort.host).view('session-a'), { missions: [], goals: [], plans: [] })
  } finally {
    noPort.close()
  }
})

test('a misbehaving goal service cannot fail the navigation read', () => {
  const h = createTestHost()
  insertSession(h.db, 'session-a')
  try {
    const planning = new AmpPlanning({
      ...h.host,
      goals: {
        get: () => { throw new Error('goal service unavailable') },
        create: () => { throw new Error('must not create') },
      },
      agents: agentsOf(),
    })
    assert.deepEqual(planning.goals('session-a'), [])
    assert.deepEqual(planning.view('session-a'), { missions: [], goals: [], plans: [] })
    // Nothing was imported behind the failure.
    assert.equal(h.db.count('amp_planning_goal'), 0)
    assert.equal(h.db.count('amp_object'), 0)
  } finally {
    h.close()
  }
})

test('a cleared Harness goal keeps the projection and reports divergence', () => {
  const h = fixture(active())
  try {
    assert.equal(h.planning.goals('session-a').length, 1)
    h.goals.replace(undefined)
    // History is not rewritten: the imported goal is not deleted.
    assert.equal(h.planning.goals('session-a').length, 1)
    assert.equal(h.planning.syncStatus('session-a').goals, 'diverged')
  } finally {
    h.close()
  }
})

test('a Harness goal without an objective gets the host placeholder statement', () => {
  const h = fixture({ id: 'harness-goal-4', revision: 1, objective: '   ', phase: 'active' })
  try {
    const goals = h.planning.goals('session-a')
    assert.equal(goals.length, 1)
    assert.equal(goals[0]?.goal.statement, 'host goal harness-goal-4')
  } finally {
    h.close()
  }
})

test('a refused AMP write becomes one link note and the read still succeeds', () => {
  const h = fixture(active())
  try {
    // Fail the AMP goal insert itself, which is the write the import owns.
    h.db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON amp_planning_goal BEGIN SELECT RAISE(ABORT, 'import refused'); END;")
    assert.deepEqual(h.planning.goals('session-a'), [], 'the failing import does not throw')
    const link = h.planning.harnessLink('session-a', ampIdOfRemote('harness-goal-1'))
    assert.match(link?.note ?? '', /projection import failed: SQL failed: INSERT INTO "amp_planning_goal"/)
    // Fail-open means no goal and no ledger entry, not a half-written one.
    assert.equal(h.db.count('amp_planning_goal'), 0)
    assert.equal(h.db.count('amp_object'), 0)
    // The next successful read recovers and clears the note.
    h.db.exec('DROP TRIGGER reject_import')
    const goals = h.planning.goals('session-a')
    assert.equal(goals.length, 1)
    assert.equal(goals[0]?.state, 'active')
    assert.equal(h.planning.harnessLink('session-a', goals[0]!.goal.id)?.note, undefined)
  } finally {
    h.close()
  }
})

test('an authored goal holding the derived id does not block the import', () => {
  const h = createTestHost()
  insertSession(h.db, 'session-a')
  insertSession(h.db, 'session-b')
  const goals = fakeGoals(active({ id: 'shared-goal', objective: 'Projected work' }))
  const planning = new AmpPlanning({ ...h.host, goals: goals.port, agents: agentsOf() })
  try {
    // Another session's authored goal already owns the deterministic id.
    planning.putGoal('session-b', {
      amp: '0.1', kind: 'goal', id: 'shared-goal', statement: 'Authored elsewhere',
      success: [{ id: 'authored', statement: 'it checks out', check: 'inspect it' }], value: 0.6, priority: 1,
    })
    const imported = planning.goals('session-a')
    assert.equal(imported.length, 1)
    assert.equal(imported[0]?.goal.id, ampIdOfRemote('shared-goal#session-a'))
    assert.notEqual(imported[0]?.goal.id, 'shared-goal')
    // Deterministic: the disambiguated id is the same on every read.
    assert.equal(planning.goals('session-a')[0]?.goal.id, imported[0]?.goal.id)
    assert.equal(planning.goals('session-b')[0]?.goal.id, 'shared-goal')
  } finally {
    h.close()
  }
})

test('AMP ids derived from Harness ids are legal, deterministic and length-capped', () => {
  // Already legal: the id is passed through unchanged.
  assert.equal(ampIdOfRemote('harness-goal-1'), 'harness-goal-1')
  // Uppercase, spaces and slashes become lowercased `-` runs.
  assert.equal(ampIdOfRemote('Goal 42/A'), 'goal-42-a')
  // The grammar requires a leading lowercase letter.
  assert.equal(ampIdOfRemote('42'), 'goal-42')
  // Over-long ids are truncated to exactly 64 and keep a short digest so two
  // ids sharing a 55-character prefix stay distinct.
  const long = 'x'.repeat(120)
  const derived = ampIdOfRemote(long)
  assert.equal(derived.length, 64)
  assert.match(derived, /^[a-z][a-z0-9._:-]{0,63}$/)
  assert.notEqual(derived, ampIdOfRemote(`${long}y`))
  assert.equal(ampIdOfRemote(long), derived)
})
