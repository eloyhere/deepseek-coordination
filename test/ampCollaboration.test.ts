import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AmpCollaboration } from '../src/host/ampCollaboration.js'
import { AmpPlanning } from '../src/host/ampPlanning.js'
import { AmpStore } from '../src/host/ampStore.js'
import { createTestHost, insertSession } from './helpers.js'

function fixture() {
  const f = createTestHost()
  for (const handle of ['owner', 'worker', 'stranger']) insertSession(f.db, handle)
  return { ...f, duties: new AmpCollaboration(f.host), planning: new AmpPlanning(f.host) }
}
const input = (id = 'duty-one') => ({ id, assigneeSession: 'worker', role: 'execution' as const,
  responsibilities: ['Prepare the reviewable artifact'], acceptance: ['Artifact reviewed against the plan'] })

test('duty handoff is durable, scoped and requires owner review', () => {
  const f = fixture()
  try {
    const assigned = f.duties.assign('owner', input())
    assert.equal(assigned.status, 'assigned')
    const reloaded = new AmpCollaboration(f.host)
    assert.deepEqual(reloaded.view('owner'), [assigned])
    assert.deepEqual(reloaded.view('worker'), [assigned])
    assert.deepEqual(reloaded.view('stranger'), [])
    assert.throws(() => reloaded.transition('stranger', assigned.id, 'accepted'), /not found/)
    assert.throws(() => reloaded.transition('owner', assigned.id, 'accepted'), /only the bound assignee/)
    reloaded.transition('worker', assigned.id, 'accepted')
    reloaded.transition('worker', assigned.id, 'working')
    assert.throws(() => reloaded.transition('worker', assigned.id, 'submitted'), /submission requires/)
    const submitted = reloaded.transition('worker', assigned.id, 'submitted', { summary: 'Artifact delivered', evidence: ['Review log 1'] })
    assert.equal(submitted.status, 'submitted')
    assert.equal(submitted.summary, 'Artifact delivered')
    assert.throws(() => reloaded.transition('worker', assigned.id, 'verified', { review: 'Looks good' }), /only the duty owner/)
    assert.throws(() => reloaded.transition('owner', assigned.id, 'verified'), /review requires/)
    assert.equal(reloaded.transition('owner', assigned.id, 'verified', { review: 'Checks passed' }).status, 'verified')
    assert.throws(() => reloaded.transition('owner', assigned.id, 'cancelled'), /is verified/)
    assert.equal(new AmpStore(f.db).verify().ok, true)
    const events = f.db.all<{ body: string }>("SELECT body FROM amp_object WHERE kind = 'event'")
    assert.deepEqual(events.map(row => JSON.parse(row.body).type), ['duty.assigned', 'duty.transitioned', 'duty.transitioned', 'duty.transitioned', 'duty.transitioned'])
  } finally { f.close() }
})

test('owner rejects submission, assignee revises, owner may cancel', () => {
  const f = fixture()
  try {
    f.duties.assign('owner', input())
    f.duties.transition('worker', 'duty-one', 'accepted')
    f.duties.transition('worker', 'duty-one', 'working')
    f.duties.transition('worker', 'duty-one', 'submitted', { summary: 'First', evidence: ['first artifact'] })
    f.duties.transition('owner', 'duty-one', 'rejected', { review: 'Needs revision' })
    assert.throws(() => f.duties.transition('worker', 'duty-one', 'submitted', { summary: 'Second', evidence: ['second artifact'] }), /not an edge/)
    f.duties.transition('worker', 'duty-one', 'working')
    const revised = f.duties.transition('worker', 'duty-one', 'submitted', { summary: 'Second', evidence: ['second artifact'] })
    assert.equal(revised.review, undefined)
    assert.deepEqual(revised.evidence, ['second artifact'])
    assert.equal(f.duties.transition('owner', 'duty-one', 'cancelled').status, 'cancelled')
  } finally { f.close() }
})

test('duty references are checked against owner planning rows', () => {
  const f = fixture()
  try {
    f.planning.putGoal('owner', { amp: '0.1', kind: 'goal', id: 'goal-one', statement: 'Ship', success: [{ id: 'criterion-one', statement: 'Ship is verified', check: 'inspect release' }], priority: 1, value: 0.5 })
    f.planning.putPlan('owner', { amp: '0.1', kind: 'plan', id: 'plan-one', goal: { kind: 'goal', id: 'goal-one' }, tasks: [{ id: 'task-one', intent: 'Write', actor: 'self', pre: [], expect: { observation: 'Draft', check: 'inspect draft' }, irreversibility: 1, status: 'pending' }], edges: [], commitment_window: 1, budget: {}, abandon_if: [{ id: 'criterion-stop', statement: 'Stop on error', check: 'inspect errors' }], status: 'draft', created: '2026-11-02T00:00:00Z' })
    assert.equal(f.duties.assign('owner', { ...input(), goal: 'goal-one', plan: 'plan-one', task: 'task-one' }).plan, 'plan-one')
    assert.throws(() => f.duties.assign('worker', { ...input('foreign'), assigneeSession: 'stranger', goal: 'goal-one' }), /not found/)
    assert.throws(() => f.duties.assign('owner', { ...input('unknown-task'), plan: 'plan-one', task: 'task-missing' }), /not found/)
    assert.throws(() => f.duties.assign('owner', { ...input('mismatch'), plan: 'plan-one', goal: 'goal-two' }), /does not match/)
    assert.equal(f.db.count('amp_duty'), 1)
    assert.equal(new AmpStore(f.db).verify().ok, true)
  } finally { f.close() }
})

test('invalid assignments and unauthorized mutations do not write events', () => {
  const f = fixture()
  try {
    const ledger = new AmpStore(f.db)
    const bad = [
      { ...input('Bad Id'), id: 'Bad Id' },
      { ...input('self'), assigneeSession: 'owner' },
      { ...input('unknown-session'), assigneeSession: 'missing' },
      { ...input('missing-acceptance'), acceptance: [] },
      { ...input('missing-responsibility'), responsibilities: [] },
      { ...input('dangling-task'), task: 'task-one' },
    ]
    for (const value of bad) assert.throws(() => f.duties.assign('owner', value))
    assert.equal(ledger.count(), 0)
    f.duties.assign('owner', input())
    const count = ledger.count()
    assert.throws(() => f.duties.assign('owner', input()), /already exists/)
    assert.throws(() => f.duties.transition('worker', 'duty-one', 'working'), /not an edge/)
    assert.throws(() => f.duties.transition('worker', 'duty-one', 'cancelled'), /only the duty owner/)
    assert.equal(ledger.count(), count)
  } finally { f.close() }
})
