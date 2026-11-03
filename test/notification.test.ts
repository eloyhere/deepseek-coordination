/**
 * `coordination_notification`: the notification centre and its model-facing tool.
 *
 * These tests pin the rules the host tool, the `/notify/pending` route and the
 * client host all depend on:
 *
 *  - one request normalises into a complete item (surface, severity, defaults);
 *  - delivery is at most once per item (`drain` clears the queue);
 *  - queues are per session, bounded, and expire on the injected clock;
 *  - invalid input is a typed failure, never a silently clamped message;
 *  - the tool resolves the calling session from the tool execution and reports
 *    the queue state, so the model can see what it produced.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManualClock } from '../src/host/handle.js'
import { NotificationCenter, parseNotificationRequest } from '../src/host/notify.js'
import { coordinationNotificationToolDefinition } from '../src/host/notifyTools.js'
import { NOTIFICATION_LIMITS } from '../src/shared/notification.js'

const session = 'session-a'

function center(clock?: ManualClock): NotificationCenter {
  return new NotificationCenter(clock === undefined ? {} : { clock })
}

/* ------------------------------------------------------------------------- *
 * Normalisation
 * ------------------------------------------------------------------------- */

test('a request normalises surface, severity, duration and anchor defaults', () => {
  const request = parseNotificationRequest({ surface: 'snackbar', message: '  done  ' })
  assert.deepEqual(request, {
    surface: 'snackbar',
    severity: 'info',
    message: 'done',
    duration: 6000,
    anchor: 'bottom-right',
    actions: [],
  })
})

test('a dialog waits for the user by default and keeps its title', () => {
  const request = parseNotificationRequest({ surface: 'dialog', title: 'Heads up', message: 'body' })
  assert.equal(request.duration, 0)
  assert.equal(request.anchor, 'top-center')
  assert.equal(request.title, 'Heads up')

  const forced = parseNotificationRequest({ surface: 'dialog', message: 'body', duration: 5000 })
  assert.equal(forced.duration, 0, 'a dialog ignores an explicit auto-close delay')
})

test('an explicit duration and anchor win over the defaults', () => {
  const request = parseNotificationRequest({
    surface: 'popover',
    message: 'body',
    duration: 1500,
    anchor: 'top-left',
    severity: 'warning',
  })
  assert.equal(request.duration, 1500)
  assert.equal(request.anchor, 'top-left')
  assert.equal(request.severity, 'warning')
})

test('the caller session key is ignored, not rejected', () => {
  const request = parseNotificationRequest({ surface: 'alert', message: 'body', session: 'session-b' })
  assert.equal(request.surface, 'alert')
})

test('actions are validated, deduplicated by id and capped at four', () => {
  const request = parseNotificationRequest({
    surface: 'dialog',
    message: 'body',
    actions: [{ id: 'ok', label: 'OK' }, { id: 'later', label: 'Later' }],
  })
  assert.deepEqual(request.actions, [{ id: 'ok', label: 'OK' }, { id: 'later', label: 'Later' }])

  assert.throws(
    () => parseNotificationRequest({
      surface: 'dialog',
      message: 'body',
      actions: [{ id: 'ok', label: 'OK' }, { id: 'ok', label: 'Again' }],
    }),
    /duplicated/,
  )
  assert.throws(
    () => parseNotificationRequest({
      surface: 'dialog',
      message: 'body',
      actions: Array.from({ length: NOTIFICATION_LIMITS.actions + 1 }, (_, index) => ({
        id: `a${index}`,
        label: `A${index}`,
      })),
    }),
    /at most/,
  )
})

test('invalid input is a typed failure instead of a silent clamp', () => {
  assert.throws(() => parseNotificationRequest({ message: 'body' }), /surface is required/)
  assert.throws(() => parseNotificationRequest({ surface: 'banner', message: 'body' }), /surface must be one of/)
  assert.throws(() => parseNotificationRequest({ surface: 'alert' }), /message must be a string/)
  assert.throws(() => parseNotificationRequest({ surface: 'alert', message: '   ' }), /must not be empty/)
  assert.throws(
    () => parseNotificationRequest({ surface: 'alert', message: 'x'.repeat(NOTIFICATION_LIMITS.message + 1) }),
    /at most/,
  )
  assert.throws(() => parseNotificationRequest({ surface: 'alert', message: 'body', duration: 10 }), /duration must be 0 or/)
  assert.throws(() => parseNotificationRequest({ surface: 'alert', message: 'body', duration: 1.5 }), /integer/)
  assert.throws(() => parseNotificationRequest({ surface: 'alert', message: 'body', colour: 'red' }), /unknown notification parameter/)
})

/* ------------------------------------------------------------------------- *
 * Queue
 * ------------------------------------------------------------------------- */

test('push returns one item and drain delivers it exactly once', () => {
  const notifications = center()
  const outcome = notifications.push(session, { surface: 'snackbar', message: 'saved' })
  assert.equal(outcome.queued, 1)
  assert.equal(outcome.dropped, 0)
  assert.equal(outcome.item.sequence, 1)
  assert.equal(outcome.item.session, session)
  assert.equal(outcome.item.severity, 'info')

  const delivered = notifications.drain(session)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.id, outcome.item.id)
  assert.deepEqual(notifications.drain(session), [])
  assert.equal(notifications.size(session), 0)
})

test('queues are isolated per session and ordered by sequence', () => {
  const notifications = center()
  notifications.push('session-a', { surface: 'alert', message: 'a1' })
  notifications.push('session-b', { surface: 'alert', message: 'b1' })
  notifications.push('session-a', { surface: 'alert', message: 'a2' })

  const a = notifications.drain('session-a')
  assert.deepEqual(a.map((item) => item.message), ['a1', 'a2'])
  assert.deepEqual(a.map((item) => item.sequence), [1, 3])
  const b = notifications.drain('session-b')
  assert.deepEqual(b.map((item) => item.message), ['b1'])
})

test('the per-session queue keeps its newest items and counts the drops', () => {
  const notifications = new NotificationCenter({ queueLimit: 2 })
  notifications.push(session, { surface: 'alert', message: 'one' })
  notifications.push(session, { surface: 'alert', message: 'two' })
  const outcome = notifications.push(session, { surface: 'alert', message: 'three' })
  assert.equal(outcome.queued, 2)
  assert.equal(outcome.dropped, 1)
  assert.deepEqual(notifications.drain(session).map((item) => item.message), ['two', 'three'])
})

test('undelivered transient items expire on the clock', () => {
  const clock = new ManualClock(1_700_000_000_000)
  const notifications = new NotificationCenter({ clock })
  notifications.push(session, { surface: 'alert', message: 'stale' })

  clock.advance(NOTIFICATION_LIMITS.ttl)
  assert.equal(notifications.size(session), 1, 'an item lives through the full TTL')
  clock.advance(1)
  assert.equal(notifications.size(session), 0)
  assert.deepEqual(notifications.drain(session), [])
})

test('an undelivered dialog never expires', () => {
  const clock = new ManualClock(1_700_000_000_000)
  const notifications = new NotificationCenter({ clock })
  notifications.push(session, { surface: 'dialog', message: 'answer me' })

  clock.advance(NOTIFICATION_LIMITS.ttl * 10)
  assert.equal(notifications.size(session), 1, 'a dialog waits for the operator')
  assert.deepEqual(notifications.drain(session).map((item) => item.surface), ['dialog'])
})

test('only the expired items leave a mixed queue', () => {
  const clock = new ManualClock(1_700_000_000_000)
  const notifications = new NotificationCenter({ clock })
  notifications.push(session, { surface: 'alert', message: 'old' })
  notifications.push(session, { surface: 'dialog', message: 'sticky' })
  clock.advance(60_000)
  notifications.push(session, { surface: 'alert', message: 'new' })

  clock.advance(NOTIFICATION_LIMITS.ttl - 60_000 + 1)
  assert.deepEqual(notifications.drain(session).map((item) => item.message), ['sticky', 'new'])
})

test('an empty session id can never be addressed', () => {
  const notifications = center()
  assert.throws(() => notifications.push('  ', { surface: 'alert', message: 'body' }), /session must be/)
  assert.throws(() => notifications.drain(''), /session must be/)
})

/* ------------------------------------------------------------------------- *
 * Tool
 * ------------------------------------------------------------------------- */

test('the tool enqueues for the calling session and reports the queue state', async () => {
  const notifications = center()
  const definition = coordinationNotificationToolDefinition(notifications, 'en-US')
  assert.equal(definition.name, 'coordination_notification')

  const first = await definition.execute(
    { surface: 'snackbar', message: 'indexed 12 files', severity: 'success' },
    { agent: { id: 'session-tool' } },
  )
  assert.equal(first.ok, true)
  assert.equal(first.session, 'session-tool')
  assert.equal(first.surface, 'snackbar')
  assert.equal(first.severity, 'success')
  assert.equal(first.queued, 1)

  const second = await definition.execute(
    { surface: 'dialog', message: 'body', session: 'session-explicit' },
    { agent: { id: 'session-tool' } },
  )
  assert.equal(second.session, 'session-explicit')
  assert.equal(notifications.size('session-tool'), 1)
  assert.equal(notifications.size('session-explicit'), 1)
})

test('the tool reports invalid input instead of throwing into the registry', async () => {
  const definition = coordinationNotificationToolDefinition(center(), 'zh-CN')
  const missingSession = await definition.execute({ surface: 'alert', message: 'body' }, undefined)
  assert.equal(missingSession.ok, false)
  assert.equal(missingSession.error?.code, 'INVALID_ARGUMENT')
  assert.match(missingSession.error?.message ?? '', /session is required/)

  const badSurface = await definition.execute(
    { surface: 'banner', message: 'body' },
    { agent: { id: 'session-a' } },
  )
  assert.equal(badSurface.ok, false)
  assert.equal(badSurface.error?.code, 'INVALID_ARGUMENT')
})
