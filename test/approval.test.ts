/**
 * `coordination_approve`: the approval centre and its model-facing tool.
 *
 * These tests pin the rules the tool, the `/approve/*` routes and the client
 * dialog all depend on:
 *
 *  - only an explicit answer settles a window (`approved` / `rejected`);
 *  - cancel, abort, timeout and unload settle as non-approval, never as consent;
 *  - a window is bound to the session that opened it;
 *  - the per-session waiting bound is enforced, and invalid input is a typed
 *    failure rather than a silent clamp;
 *  - the tool awaits the human answer and reports the real outcome.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalCenter, parseApprovalRequest } from '../src/host/approve.js'
import { coordinationApproveToolDefinition } from '../src/host/approveTools.js'
import { APPROVAL_LIMITS } from '../src/shared/approve.js'

const session = 'session-a'

/* ------------------------------------------------------------------------- *
 * Normalisation
 * ------------------------------------------------------------------------- */

test('a request normalises to defaults and optional text', () => {
  const request = parseApprovalRequest({ message: '  Deploy to production?  ' })
  assert.deepEqual(request, {
    message: 'Deploy to production?',
    timeout: APPROVAL_LIMITS.defaultTimeout,
  })

  const full = parseApprovalRequest({
    message: 'Delete the branch?',
    title: 'Destructive',
    detail: 'The branch is merged already.',
    approveLabel: 'Delete',
    rejectLabel: 'Keep',
    timeout: 30_000,
  })
  assert.equal(full.title, 'Destructive')
  assert.equal(full.detail, 'The branch is merged already.')
  assert.equal(full.approveLabel, 'Delete')
  assert.equal(full.rejectLabel, 'Keep')
  assert.equal(full.timeout, 30_000)
})

test('invalid input is a typed failure instead of a clamp', () => {
  assert.throws(() => parseApprovalRequest({}), /message must be a string/)
  assert.throws(() => parseApprovalRequest({ message: '   ' }), /must not be empty/)
  assert.throws(
    () => parseApprovalRequest({ message: 'x'.repeat(APPROVAL_LIMITS.message + 1) }),
    /at most/,
  )
  assert.throws(() => parseApprovalRequest({ message: 'ok', timeout: 100 }), /timeout must be between/)
  assert.throws(() => parseApprovalRequest({ message: 'ok', timeout: 1.5 }), /integer/)
  assert.throws(() => parseApprovalRequest({ message: 'ok', approve: true }), /unknown approval parameter/)
  assert.throws(
    () => parseApprovalRequest({ message: 'ok', approveLabel: 'x'.repeat(APPROVAL_LIMITS.label + 1) }),
    /at most/,
  )
})

/* ------------------------------------------------------------------------- *
 * Centre
 * ------------------------------------------------------------------------- */

test('an explicit approval settles the waiting promise and clears the list', async () => {
  const approvals = new ApprovalCenter()
  const opened = approvals.open(session, { message: 'Proceed?' })
  assert.equal(approvals.size(session), 1)
  assert.equal(approvals.list(session)[0]?.id, opened.id)

  assert.equal(approvals.answer(session, opened.id, true), true)
  assert.equal(await opened.promise, 'approved')
  assert.equal(approvals.size(session), 0)
  assert.deepEqual(approvals.list(session), [])
})

test('a rejection is a rejection, not a missing answer', async () => {
  const approvals = new ApprovalCenter()
  const opened = approvals.open(session, { message: 'Proceed?' })
  approvals.answer(session, opened.id, false)
  assert.equal(await opened.promise, 'rejected')
})

test('cancel and unload settle as cancelled', async () => {
  const approvals = new ApprovalCenter()
  const first = approvals.open(session, { message: 'First?' })
  assert.equal(approvals.cancel(session, first.id), true)
  assert.equal(await first.promise, 'cancelled')

  const second = approvals.open(session, { message: 'Second?' })
  approvals.cancelAll()
  assert.equal(await second.promise, 'cancelled')
  assert.equal(approvals.size(session), 0)
})

test('a window settles exactly once', async () => {
  const approvals = new ApprovalCenter()
  const opened = approvals.open(session, { message: 'Proceed?' })
  assert.equal(approvals.answer(session, opened.id, true), true)
  assert.equal(approvals.answer(session, opened.id, false), false)
  assert.equal(approvals.cancel(session, opened.id), false)
  assert.equal(await opened.promise, 'approved')
})

test('a window belongs to the session that opened it', async () => {
  const approvals = new ApprovalCenter()
  const opened = approvals.open(session, { message: 'Proceed?' })
  assert.equal(approvals.answer('session-b', opened.id, true), false)
  assert.equal(approvals.cancel('session-b', opened.id), false)
  assert.equal(approvals.size(session), 1, 'a foreign answer must not settle the window')

  assert.equal(approvals.answer(session, opened.id, true), true)
  assert.equal(await opened.promise, 'approved')
})

test('the per-session waiting bound is enforced', () => {
  const approvals = new ApprovalCenter({ pendingPerSession: 2 })
  approvals.open(session, { message: 'One?' })
  approvals.open(session, { message: 'Two?' })
  assert.throws(() => approvals.open(session, { message: 'Three?' }), /already waiting/)
  // Another session still has capacity.
  assert.doesNotThrow(() => approvals.open('session-b', { message: 'Other?' }))
})

test('a window expires on its own timer and never becomes consent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const approvals = new ApprovalCenter()
  const opened = approvals.open(session, { message: 'Proceed?', timeout: APPROVAL_LIMITS.minTimeout })
  assert.equal(approvals.size(session), 1)

  t.mock.timers.tick(APPROVAL_LIMITS.minTimeout)
  assert.equal(await opened.promise, 'expired')
  assert.equal(approvals.size(session), 0)
  assert.equal(approvals.answer(session, opened.id, true), false, 'an expired window cannot be approved later')
})

test('the pending list is oldest first and per session', () => {
  const approvals = new ApprovalCenter({ clock: { now: () => 1_700_000_000_000 } })
  const first = approvals.open(session, { message: 'First?' })
  const second = approvals.open(session, { message: 'Second?' })
  approvals.open('session-b', { message: 'Other?' })
  assert.deepEqual(approvals.list(session).map((item) => item.id), [first.id, second.id])
  assert.deepEqual(approvals.list('session-b').map((item) => item.message), ['Other?'])
})

/* ------------------------------------------------------------------------- *
 * Tool
 * ------------------------------------------------------------------------- */

test('the tool awaits the human answer and reports the real outcome', async () => {
  const approvals = new ApprovalCenter()
  const definition = coordinationApproveToolDefinition(approvals, 'en-US')
  assert.equal(definition.name, 'coordination_approve')

  const pending = definition.execute({ message: 'Deploy?' }, { agent: { id: session } })
  const item = approvals.list(session)[0]
  assert.ok(item !== undefined)
  approvals.answer(session, item.id, true)
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'approved')
  assert.equal(result.session, session)
  assert.equal(result.timedOut, false)
})

test('an aborted turn withdraws the window instead of leaving it open', async () => {
  const approvals = new ApprovalCenter()
  const definition = coordinationApproveToolDefinition(approvals, 'zh-CN')
  const controller = new AbortController()
  const pending = definition.execute(
    { message: '继续吗？' },
    { agent: { id: session }, signal: controller.signal },
  )
  assert.equal(approvals.size(session), 1)
  controller.abort()
  const result = await pending
  assert.equal(result.outcome, 'cancelled')
  assert.equal(approvals.size(session), 0)
})

test('the tool reports invalid input and a missing session as typed failures', async () => {
  const definition = coordinationApproveToolDefinition(new ApprovalCenter(), 'en-US')
  const missingSession = await definition.execute({ message: 'ok' }, undefined)
  assert.equal(missingSession.ok, false)
  assert.equal(missingSession.error?.code, 'INVALID_ARGUMENT')
  assert.match(missingSession.error?.message ?? '', /session is required/)

  const badTimeout = await definition.execute(
    { message: 'ok', timeout: 10 },
    { agent: { id: session } },
  )
  assert.equal(badTimeout.ok, false)
  assert.equal(badTimeout.error?.code, 'INVALID_ARGUMENT')
})

test('an explicit timeout is reported as expired, not approved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const definition = coordinationApproveToolDefinition(new ApprovalCenter(), 'en-US')
  const pending = definition.execute(
    { message: 'Proceed?', timeout: APPROVAL_LIMITS.minTimeout },
    { agent: { id: session } },
  )
  t.mock.timers.tick(APPROVAL_LIMITS.minTimeout)
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'expired')
  assert.equal(result.timedOut, true)
})
