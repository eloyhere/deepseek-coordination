/**
 * `buildStateCard`: the compact, durable summary carried as the last field of
 * the AMP block and exposed via `GET /amp/state-card`.
 *
 * The card is what survives compaction, so the tests pin the parts that matter:
 * the active goal becomes `objective`, the executing plan names its next task,
 * an open duty becomes `next` when no plan task is actionable, constraint strings
 * come from the workspace digest, and an empty session yields no card.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Duty } from '../src/host/ampCollaboration.js'
import { buildStateCard, stateCardOf, type PlanningView } from '../src/host/stateCard.js'

function duty(overrides: Partial<Duty> & { id: string }): Duty {
  return {
    ownerSession: 's1',
    assigneeSession: 's1',
    role: 'execution',
    status: 'accepted',
    responsibilities: ['Do the work'],
    acceptance: ['Tests pass'],
    created: 1,
    updated: 1,
    ...overrides,
  } as unknown as Duty
}

const runningPlan = {
  amp: '0.1',
  kind: 'plan',
  id: 'plan-1',
  goal: { kind: 'goal', id: 'goal-1' },
  tasks: [
    { id: 't1', status: 'done', intent: 'Write tests' },
    { id: 't2', status: 'running', intent: 'Implement the parser' },
    { id: 't3', status: 'pending', intent: 'Publish' },
  ],
  edges: [],
  commitment_window: 1,
  budget: {},
  abandon_if: [],
  status: 'executing',
  created: '2026-01-01T00:00:00Z',
} as unknown as PlanningView['plans'][number]

function planningOf(): PlanningView {
  return {
    missions: [{ id: 'mission-1', session: 's1', goal: 'goal-1', priority: 1, status: 'active' as const, created: 1, updated: 1 }],
    goals: [{ goal: { amp: '0.1', kind: 'goal', id: 'goal-1', statement: 'Ship the parser', success: [], value: 1, priority: 1 }, state: 'active' as const }],
    plans: [runningPlan],
  } as unknown as PlanningView
}

test('the card names the objective, the plan and its next task', () => {
  const card = buildStateCard({ session: 's1', duties: [], planning: planningOf() })
  assert.ok(card)
  assert.equal(card.durable, true)
  assert.equal(card.objective, 'Ship the parser')
  assert.equal(card.plan?.id, 'plan-1')
  assert.equal(card.plan?.done, 1)
  assert.equal(card.plan?.total, 3)
  assert.equal(card.plan?.next?.id, 't2')
  assert.match(card.next ?? '', /^Run task t2: Implement the parser/)
})

test('an actionable duty becomes next when no plan task is runnable', () => {
  const duties = [duty({ id: 'duty-1', status: 'submitted' }), duty({ id: 'duty-2', ownerSession: 'elsewhere', assigneeSession: 'elsewhere' })]
  const card = buildStateCard({ session: 's1', duties })
  assert.ok(card)
  assert.equal(card.duties?.open, 1)
  assert.equal(card.duties?.items[0]?.id, 'duty-1')
  assert.equal(card.next, 'Review duty duty-1')
  assert.equal('plan' in card, false)
})

test('constraints come from the digest and an empty session yields no card', () => {
  const card = buildStateCard({ session: 's1', duties: [], digest: { interaction: 'think', scenario: 'engineering' } })
  assert.deepEqual(card?.constraints, ['interaction=think', 'scenario=engineering'])
  assert.equal(buildStateCard({ session: 's1', duties: [] }), undefined)
  assert.equal(stateCardOf({}, '   '), undefined)
})

test('stateCardOf tolerates missing services and returns a card only when actionable', () => {
  assert.equal(stateCardOf({}, 's1'), undefined)
  const source = {
    planning: { view: () => planningOf() },
  }
  const card = stateCardOf(source, 's1')
  assert.equal(card?.objective, 'Ship the parser')
})
