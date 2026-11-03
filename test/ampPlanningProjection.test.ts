import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Goal, Plan } from 'attention-manifest-protocol/goal/plan.js'
import { AmpPlanning } from '../src/host/ampPlanning.js'
import { AmpService, type AmpPlanFacts, type AmpTurnFacts } from '../src/host/amp.js'
import { createTestHost, insertSession } from './helpers.js'
import { SceneProfiles } from '../src/shared/enum.js'

const goal = (id: string): Goal => ({ amp: '0.1', kind: 'goal', id, statement: 'Ship the release', success: [{ id: `success-${id}`, statement: 'Release is verified', check: 'review release evidence' }], value: 0.5, priority: 1 })
const plan = (id: string, goalId: string, status: Plan['status'] = 'draft'): Plan => ({
  amp: '0.1', kind: 'plan', id, goal: { kind: 'goal', id: goalId },
  tasks: [{ id: `${id}-a`, intent: 'Do work', actor: 'self', pre: [], expect: { observation: 'evidence exists', check: 'review evidence' }, irreversibility: 0, status: status === 'executing' ? 'running' : status === 'done' ? 'done' : 'pending' }],
  edges: [], commitment_window: 1, budget: {}, abandon_if: [{ id: `stop-${id}`, statement: 'stop on failure', check: 'inspect failures' }], status, created: '2026-11-02T00:00:00.000Z',
})
function fixture() {
  const h = createTestHost()
  insertSession(h.db, 'one')
  insertSession(h.db, 'two')
  const planning = new AmpPlanning(h.host)
  const amp = new AmpService({ db: h.db, config: h.host.config, handles: h.host.handles, clock: h.host.clock, onPlan: (session, g, p) => planning.adoptProjection(session, g, p) })
  return { ...h, planning, amp }
}
function facts(status: string, ordinal = 1): AmpTurnFacts {
  const planFacts: AmpPlanFacts = {
    plan: { handle: 'legacy-plan', created: 1_700_000_000_000, status, constraint: 'stop on error' },
    goal: { handle: 'legacy-goal', content: 'Finish the recorded work' },
    steps: [{ statement: 'Do the work', expect: 'Work passes inspection' }],
  }
  return { session: 'one', turn: `turn-${ordinal}`, ordinal, profession: 'execution', interaction: 'think', scene: 'dialogue', validation: 'medium', sceneProfile: SceneProfiles.dialogue, created: 1_700_000_000_000, status: 'done', planFacts }
}

test('onPlan refreshes durable snapshots across adapter recreation without claiming goal achievement', async t => {
  const h = fixture()
  t.after(() => h.close())
  await h.amp.closeTurn(facts('draft'))
  assert.equal(h.planning.goals('one')[0]?.state, 'proposed')
  await h.amp.closeTurn(facts('active', 2))
  assert.equal(h.planning.goals('one')[0]?.state, 'active')
  const startedAt = h.planning.goals('one')[0]?.startedAt
  await h.amp.closeTurn(facts('done', 3))
  const restored = new AmpPlanning(h.host)
  assert.equal(restored.plans('one')[0]?.status, 'done')
  assert.deepEqual(restored.plans('one')[0], h.amp.store.recent('plan', 1)[0])
  assert.equal(restored.goals('one')[0]?.state, 'active')
  assert.equal(restored.goals('one')[0]?.startedAt, startedAt)
  assert.equal(restored.goals('one')[0]?.achievedAt, undefined)
  assert.equal((await h.amp.verify()).ok, true)
})

test('projection rejects terminal goal work, terminal plan revival and goal rebinding atomically', t => {
  const h = fixture()
  t.after(() => h.close())
  const g = goal('terminal')
  h.planning.putGoal('one', g)
  h.planning.transitionGoal('one', g.id, 'abandoned')
  assert.throws(() => h.planning.adoptProjection('one', g, plan('new-work', g.id, 'executing')), /terminal goal/)
  assert.deepEqual(h.planning.plans('one'), [])
  const live = goal('live')
  h.planning.adoptProjection('one', live, plan('done-work', live.id, 'done'))
  assert.throws(() => h.planning.adoptProjection('one', live, plan('done-work', live.id, 'executing')), /regress or revive/)
  assert.throws(() => h.planning.adoptProjection('one', goal('different-goal'), plan('done-work', 'different-goal', 'done')), /change its goal/)
  assert.equal(h.planning.goals('one').some(item => item.goal.id === 'different-goal'), false)
  assert.throws(() => h.planning.adoptProjection('two', live, plan('foreign-work', live.id)), /another session/)
  assert.deepEqual(h.planning.view('two'), { goals: [], plans: [], missions: [] })
  h.planning.transitionGoal('one', live.id, 'achieved')
  assert.doesNotThrow(() => h.planning.adoptProjection('one', live, plan('done-work', live.id, 'done')), 'identical terminal snapshots may be replayed')
  assert.equal(h.planning.goals('one').find(item => item.goal.id === live.id)?.state, 'achieved')
})

test('projection updates goal content and uses mission admission guards for activation', t => {
  const h = fixture()
  t.after(() => h.close())
  h.planning.createMission('one', goal('first'))
  h.planning.createMission('one', goal('second'))
  h.planning.activateNext('one')
  const changed = { ...goal('second'), statement: 'Updated recorded objective', priority: 5 }
  assert.throws(() => h.planning.adoptProjection('one', changed, plan('second-plan', changed.id, 'executing')), /already has an active/)
  assert.equal(h.planning.goals('one').find(item => item.goal.id === changed.id)?.goal.statement, 'Ship the release', 'failed projection rolls back the goal update')
  assert.deepEqual(h.planning.plans('one'), [])
  h.planning.transitionGoal('one', 'first', 'abandoned')
  h.planning.adoptProjection('one', changed, plan('second-plan', changed.id, 'executing'))
  assert.equal(h.planning.goals('one').find(item => item.goal.id === changed.id)?.goal.statement, changed.statement)
  const mission = h.planning.missions('one').find(item => item.goal === changed.id)
  assert.equal(mission?.status, 'active')
  assert.equal(mission?.priority, 5)
})

test('abandoned plans do not prevent completing a successful replacement plan', t => {
  const h = fixture()
  t.after(() => h.close())
  const mission = h.planning.createMission('one', goal('replace'))
  h.planning.activateNext('one')
  h.planning.putPlan('one', plan('old-plan', mission.goal))
  h.planning.transitionPlan('one', 'old-plan', 'abandoned')
  h.planning.putPlan('one', plan('replacement', mission.goal))
  h.planning.transitionPlan('one', 'replacement', 'committed')
  h.planning.transitionPlan('one', 'replacement', 'executing')
  h.planning.updateTask('one', 'replacement', 'replacement-a', 'running')
  h.planning.updateTask('one', 'replacement', 'replacement-a', 'done')
  h.planning.transitionPlan('one', 'replacement', 'done')
  assert.equal(h.planning.settleMission('one', mission.id, 'done').status, 'done')
  assert.equal(h.planning.goals('one')[0]?.state, 'achieved')
  assert.equal(h.planning.plans('one').find(item => item.id === 'old-plan')?.status, 'abandoned')
})

test('onPlan and ledger pair roll back together when a ledger append fails', async t => {
  const h = fixture()
  t.after(() => h.close())
  await h.amp.closeTurn(facts('draft'))
  const before = h.planning.view('one')
  const planCount = h.amp.store.entries({ kind: 'plan' }).length
  h.db.exec("CREATE TRIGGER reject_review_plan BEFORE INSERT ON amp_object WHEN NEW.kind = 'plan' BEGIN SELECT RAISE(ABORT, 'projection ledger failure'); END;")
  await assert.rejects(() => h.amp.closeTurn(facts('active', 2)), /SQL failed: INSERT INTO amp_object/)
  assert.deepEqual(new AmpPlanning(h.host).view('one'), before)
  assert.equal(h.amp.store.entries({ kind: 'plan' }).length, planCount)
  assert.equal(h.amp.store.entries({ kind: 'goal' }).length, 1)
})
