import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AmpPlanning } from '../src/host/ampPlanning.js'
import { AmpStore } from '../src/host/ampStore.js'
import { handleAmpRoute } from '../src/host/ampRoutes.js'
import { AmpService } from '../src/host/amp.js'
import type { Goal, Plan } from 'attention-manifest-protocol/goal/plan.js'
import { createTestHost, insertSession } from './helpers.js'

const goal = (id: string, priority = 1): Goal => ({ amp: '0.1', kind: 'goal', id, statement: 'Ship the release', success: [{ id: `success-${id}`, statement: 'Release is verified', check: 'review release evidence', kind: 'assert' }], value: 0.5, priority, horizon: 'session' })
const plan = (id: string, goalId: string): Plan => ({ amp: '0.1', kind: 'plan', id, goal: { kind: 'goal', id: goalId }, tasks: ['a', 'b'].map(suffix => ({ id: `${id}-${suffix}`, intent: `step ${suffix}`, actor: 'self', pre: [], expect: { observation: 'evidence exists', check: 'review evidence' }, irreversibility: 1, status: 'pending' })), edges: [[`${id}-a`, `${id}-b`]], commitment_window: 1, budget: {}, abandon_if: [{ id: `stop-${id}`, statement: 'stop on failure', check: 'inspect failures' }], status: 'draft', created: '2026-11-02T00:00:00.000Z' })

function fixture() {
  const h = createTestHost()
  insertSession(h.db, 'one')
  insertSession(h.db, 'two')
  return { ...h, planning: new AmpPlanning(h.host) }
}

test('mission admission uses AMP priority/FIFO and survives adapter recreation', () => {
  const h = fixture()
  try {
    const low = h.planning.createMission('one', goal('low', 1))
    const first = h.planning.createMission('one', goal('first', 9))
    const second = h.planning.createMission('one', goal('second', 9))
    const restored = new AmpPlanning(h.host)
    assert.equal(restored.activateNext('one')?.id, first.id)
    assert.throws(() => restored.activateNext('one'), /already has an active/)
    restored.settleMission('one', first.id, 'done')
    assert.equal(restored.activateNext('one')?.id, second.id)
    restored.settleMission('one', second.id, 'abandoned')
    assert.equal(restored.activateNext('one')?.id, low.id)
    assert.equal(new AmpStore(h.db).verify().ok, true)
    assert.equal(restored.goals('one').find(item => item.goal.id === 'first')?.state, 'achieved')
    assert.deepEqual(restored.missions('two'), [])
    assert.throws(() => restored.settleMission('two', low.id, 'done'), /not found/)
  } finally { h.close() }
})

test('plan lifecycle enforces dependencies and terminal goals cannot be revived', () => {
  const h = fixture()
  try {
    const mission = h.planning.createMission('one', goal('release'))
    h.planning.putPlan('one', plan('release-plan', 'release'))
    h.planning.transitionPlan('one', 'release-plan', 'committed')
    assert.throws(() => h.planning.transitionPlan('one', 'release-plan', 'executing'), /activate the goal/)
    h.planning.activateNext('one')
    h.planning.transitionPlan('one', 'release-plan', 'executing')
    assert.throws(() => h.planning.updateTask('one', 'release-plan', 'release-plan-b', 'running'), /dependencies/)
    assert.throws(() => h.planning.settleMission('one', mission.id, 'done'), /finish every plan/)
    h.planning.updateTask('one', 'release-plan', 'release-plan-a', 'running')
    h.planning.updateTask('one', 'release-plan', 'release-plan-a', 'done')
    h.planning.updateTask('one', 'release-plan', 'release-plan-b', 'running')
    h.planning.updateTask('one', 'release-plan', 'release-plan-b', 'done')
    h.planning.transitionPlan('one', 'release-plan', 'done')
    assert.equal(h.planning.settleMission('one', mission.id, 'done').status, 'done')
    assert.throws(() => h.planning.transitionGoal('one', 'release', 'active'), /not an edge/)
    assert.throws(() => h.planning.putPlan('one', plan('late', 'release')), /terminal goal/)
    assert.equal(new AmpStore(h.db).verify().ok, true)
  } finally { h.close() }
})

test('invalid plans and duplicate IDs roll back projections and ledger writes', () => {
  const h = fixture()
  try {
    h.planning.putGoal('one', goal('valid'))
    const before = new AmpStore(h.db).count()
    const cyclic = plan('cyclic', 'valid')
    cyclic.edges.push(['cyclic-b', 'cyclic-a'])
    assert.throws(() => h.planning.putPlan('one', cyclic), /cycle/)
    const dangling = plan('dangling', 'valid')
    dangling.edges.push(['missing', 'dangling-a'])
    assert.throws(() => h.planning.putPlan('one', dangling), /reference tasks/)
    assert.throws(() => h.planning.createMission('one', goal('valid')), /already exists/)
    assert.throws(() => h.planning.putGoal('one', goal('nan', NaN)), /invalid AMP/)
    assert.throws(() => h.planning.putPlan('two', plan('foreign', 'valid')), /not found/)
    assert.equal(new AmpStore(h.db).count(), before)
    assert.deepEqual(h.planning.plans('one'), [])
    assert.deepEqual(h.planning.missions('one'), [])
  } finally { h.close() }
})

test('ledger append failure rolls back goal, lifecycle and mission atomically', () => {
  const h = fixture()
  try {
    h.db.exec("CREATE TRIGGER reject_planning_event BEFORE INSERT ON amp_object WHEN NEW.kind = 'event' BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END;")
    assert.throws(() => h.planning.createMission('one', goal('rollback')), /SQL failed: INSERT INTO amp_object/)
    assert.deepEqual(h.planning.view('one'), { missions: [], goals: [], plans: [] })
    assert.equal(new AmpStore(h.db).count(), 0)
  } finally { h.close() }
})

test('goal API activation remains consistent with mission admission and abandonment', () => {
  const h = fixture()
  try {
    const first = h.planning.createMission('one', goal('one-goal'))
    h.planning.createMission('one', goal('two-goal'))
    h.planning.putPlan('one', plan('work', 'one-goal'))
    h.planning.transitionGoal('one', 'one-goal', 'active')
    assert.equal(h.planning.missions('one').find(item => item.id === first.id)?.status, 'active')
    assert.throws(() => h.planning.transitionGoal('one', 'two-goal', 'active'), /already has an active/)
    h.planning.transitionGoal('one', 'one-goal', 'abandoned')
    assert.equal(h.planning.plans('one')[0].status, 'abandoned')
    assert.equal(h.planning.missions('one').find(item => item.id === first.id)?.status, 'abandoned')
  } finally { h.close() }
})

test('planning HTTP views require and isolate sessions', async () => {
  const h = fixture()
  try {
    const amp = new AmpService({ db: h.db, config: h.host.config, handles: h.host.handles, clock: h.host.clock })
    h.planning.createMission('one', goal('visible'))
    const query = (session: string, path = '/amp/planning') => handleAmpRoute({ path, method: 'GET', session, url: new URL('http://local' + path) }, { amp, planning: h.planning })
    assert.equal((await query(''))?.status, 400)
    assert.equal((await query('missing'))?.status, 404)
    // The planning payload also reports how the AMP records stand against the
    // Harness lifecycle. This fixture has no Harness ports, so both are
    // `unavailable` rather than an invented phase.
    assert.deepEqual((await query('two'))?.body, {
      ok: true,
      value: {
        missions: [], goals: [], plans: [],
        harness: { goals: 'unavailable', planMode: 'unavailable', note: 'the Harness exposes no goal service in this profile' },
      },
    })
    assert.equal((await query('one', '/amp/missions'))?.status, 200)
  } finally { h.close() }
})
