import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

/** Exercise the composed plugin, including prepend ordering and its HTTP routes. */
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'amp-dialog-'))
  const roots = { a: join(directory, 'a'), b: join(directory, 'b') }
  for (const root of Object.values(roots)) mkdirSync(root)
  const agents = new Map(Object.entries(roots).map(([id, cwd]) => [id, { id, session: { header: { cwd } } }]))
  const listeners = new Map()
  const routes = new Map()
  const disposers = []
  const tools = new Map()
  const services = { webServer: { register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  } } }
  const registrations = []
  const native = { approval: 0, questions: 0 }
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) }, get: (name) => tools.get(name), definitions: () => [...tools.values()] },
    systemPrompt: { getSectionOrder: () => 0, getContextOrder: () => 0, section: () => () => {}, context: () => () => {} },
    skills: { register: () => () => {} },
    commands: { register: () => () => {} },
    agents: { get: (id) => agents.get(id) },
    sessions: { list: () => [] },
    on(name, handler, options) {
      registrations.push({ name, options })
      const entries = listeners.get(name) ?? []
      if (options?.prepend) entries.unshift(handler)
      else entries.push(handler)
      listeners.set(name, entries)
      return () => {
        const index = entries.indexOf(handler)
        if (index !== -1) entries.splice(index, 1)
      }
    },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
    get: (name) => services[name],
    provide(name, value) { services[name] = value; return () => { delete services[name] } },
    inject: (_dependencies, callback) => callback(ctx),
  }
  // Harness's own UI is already listening before the plugin mounts.
  ctx.on('approval/request', async () => { native.approval++; return 'unavailable' })
  ctx.on('user-questions/request', async () => { native.questions++; return { answers: [] } })
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const cleanup of disposers.reverse()) cleanup()
  }
  t.after(() => { dispose(); rmSync(directory, { recursive: true, force: true }) })
  await apply(ctx, {
    tenantId: 'test', rootId: 'root', storePath: join(directory, 'amp.sqlite'),
    notifications: false, prompt: false, skills: false, commands: false, routes: true,
    maxJournal: 100, maxReadChars: 100_000, maxWriteChars: 100_000,
  })
  const host = services.amp
  host.preferencesFor(roots.a).update({ takeoverNotifications: true })
  host.preferencesFor(roots.b).update({ takeoverNotifications: true })
  const dispatch = (name, request) => {
    const entries = [...(listeners.get(name) ?? [])]
    const invoke = (index) => index < entries.length
      ? entries[index](request, () => invoke(index + 1))
      : Promise.reject(new Error('no native answerer'))
    return invoke(0)
  }
  const request = async (path, { method = 'GET', body, raw } = {}) => {
    const url = `/deepseek-coordination${path}`
    const handler = routes.get(url.split('?')[0])
    assert.ok(handler, `route ${path} is registered`)
    let status
    let payload
    await handler({ method, url, async *[Symbol.asyncIterator]() {
      if (raw !== undefined) yield Buffer.from(raw)
      else if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    } }, { writeHead(code) { status = code }, end(text) { payload = JSON.parse(text) } })
    return { status, ...payload }
  }
  return {
    host, roots, native, registrations, listeners, dispose, request, services,
    approval: (session = 'a', extra = {}) => dispatch('approval/request', { agent: agents.get(session), toolName: 'workspace.write', reason: 'write a file', ...extra }),
    questions: (questions, session = 'a', extra = {}) => dispatch('user-questions/request', { agent: agents.get(session), questions, ...extra }),
    pending: async (session = 'a') => (await request(`/dialogs/pending?session=${session}`)).value.items,
    answer: (session, id, answer) => request('/dialogs/answer', { method: 'POST', body: { session, id, ...answer } }),
    cancel: (session, id) => request('/dialogs/cancel', { method: 'POST', body: { session, id } }),
  }
}

const question = { id: 'choice', question: 'Choose an option', header: 'Choice', options: [{ label: 'One', description: 'First option' }, { label: 'Two' }] }

test('prepended approval gate suppresses the native dialog and resolves a human decision', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  assert.ok(f.registrations.some((row) => row.name === 'approval/request' && row.options?.prepend === true))
  assert.ok(f.registrations.some((row) => row.name === 'user-questions/request' && row.options?.prepend === true))
  const result = f.approval('a', { displayReason: { en: 'Allow writing?', zh: '允许写入？' } })
  const [view] = await f.pending()
  assert.deepEqual(view, { id: view.id, kind: 'approval', toolName: 'workspace.write', reason: 'write a file', displayReason: { en: 'Allow writing?', zh: '允许写入？' } })
  assert.equal((await f.answer('a', view.id, { outcome: 'allowed-once' })).status, 200)
  assert.equal(await result, 'allowed-once')
  assert.equal(f.native.approval, 0)
  assert.deepEqual(await f.pending(), [])
  assert.equal((await f.answer('a', view.id, { outcome: 'allowed-once' })).status, 404)
})

test('disabled takeover delegates new requests to the native waterfall', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  f.host.preferencesFor(f.roots.a).update({ takeoverNotifications: false })
  assert.equal(await f.approval(), 'unavailable')
  assert.deepEqual(await f.questions([question]), { answers: [] })
  assert.deepEqual(f.native, { approval: 1, questions: 1 })
  assert.deepEqual(await f.pending(), [])
})

test('pending and answers are isolated by session and preserve multiple concurrent requests', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const a1 = f.approval()
  const a2 = f.approval()
  const b = f.approval('b')
  const rows = await f.pending()
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].id, rows[1].id)
  const [other] = await f.pending('b')
  assert.equal((await f.answer('b', rows[0].id, { outcome: 'allowed-once' })).status, 404)
  assert.equal((await f.cancel('b', rows[0].id)).status, 404)
  assert.equal((await f.cancel('a', rows[0].id)).status, 200)
  assert.equal((await f.answer('a', rows[1].id, { outcome: 'rejected' })).status, 200)
  await f.cancel('b', other.id)
  assert.deepEqual(await Promise.all([a1, a2, b]), ['cancelled', 'rejected', 'cancelled'])
  assert.equal(f.native.approval, 0)
})

test('invalid approval outcomes leave the dialog pending', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const result = f.approval()
  const [view] = await f.pending()
  for (const answer of [{ outcome: 'unavailable' }, { outcome: 'allowed-always' }, {}, { outcome: 'allowed-once', answers: [] }]) {
    assert.equal((await f.answer('a', view.id, answer)).status, 400)
    assert.equal((await f.pending()).length, 1)
  }
  await f.answer('a', view.id, { outcome: 'cancelled' })
  assert.equal(await result, 'cancelled')
  assert.equal(f.native.approval, 0)
})

test('question answers strictly match ids, option labels and single-select cardinality', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const result = f.questions([question])
  const [view] = await f.pending()
  assert.equal(view.kind, 'questions')
  assert.deepEqual(view.questions, [question])
  for (const answers of [
    undefined, [], [{ id: 'unknown', selected: [] }],
    [{ id: 'choice', selected: ['One', 'Two'] }],
    [{ id: 'choice', selected: ['One', 'One'] }],
    [{ id: 'choice', selected: ['1'] }],
    [{ id: 'choice', selected: 'One' }],
    [{ id: 'choice', selected: [], custom: 12 }],
    [{ id: 'choice', selected: ['One'], custom: 'Other' }],
    [{ id: 'choice', selected: [], extra: true }],
    [{ id: 'choice', selected: [] }, { id: 'choice', selected: [] }],
  ]) {
    assert.equal((await f.answer('a', view.id, { answers })).status, 400, JSON.stringify(answers))
    assert.equal((await f.pending()).length, 1)
  }
  assert.equal((await f.answer('a', view.id, { answers: [{ id: 'choice', selected: ['Two'] }] })).status, 200)
  assert.deepEqual(await result, { answers: [{ id: 'choice', selected: ['Two'] }] })
  assert.equal(f.native.questions, 0)
})

test('multi-select supports custom text and each empty selection is a valid skip', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const questions = [question, { ...question, id: 'multi', multiSelect: true }, { id: 'text', question: 'Any details?' }]
  const result = f.questions(questions)
  const [view] = await f.pending()
  const answers = [{ id: 'choice', selected: [] }, { id: 'multi', selected: ['One', 'Two'], custom: 'Also this' }, { id: 'text', selected: [], custom: 'A detail' }]
  assert.equal((await f.answer('a', view.id, { answers })).status, 200)
  assert.deepEqual(await result, { answers })
  assert.equal(f.native.questions, 0)
})

test('explicit question cancellation returns empty answers without a second native dialog', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const result = f.questions([question])
  const [view] = await f.pending()
  assert.equal((await f.cancel('a', view.id)).status, 200)
  assert.deepEqual(await result, { answers: [] })
  assert.equal((await f.cancel('a', view.id)).status, 404)
  assert.equal(f.native.questions, 0)
})

test('aborted and already-aborted requests settle fail-closed and remove pending dialogs', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  const approval = f.approval('a', { signal: controller.signal })
  const questions = f.questions([question], 'a', { signal: controller.signal })
  assert.equal((await f.pending()).length, 2)
  controller.abort()
  assert.equal(await approval, 'cancelled')
  assert.deepEqual(await questions, { answers: [] })
  assert.equal(await f.approval('a', { signal: controller.signal }), 'cancelled')
  assert.deepEqual(await f.questions([question], 'a', { signal: controller.signal }), { answers: [] })
  assert.deepEqual(await f.pending(), [])
  assert.deepEqual(f.native, { approval: 0, questions: 0 })
})

test('preference changes retire existing dialogs when polled or updated over HTTP', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const approval = f.approval()
  const questions = f.questions([question])
  f.host.preferencesFor(f.roots.a).update({ takeoverNotifications: false })
  assert.deepEqual(await f.pending(), [])
  assert.equal(await approval, 'cancelled')
  assert.deepEqual(await questions, { answers: [] })
  f.host.preferencesFor(f.roots.a).update({ takeoverNotifications: true })
  const next = f.approval()
  const reply = await f.request('/amp/preferences?session=a', { method: 'POST', body: { takeoverNotifications: false } })
  assert.equal(reply.status, 200)
  assert.equal(await next, 'cancelled')
  assert.deepEqual(f.native, { approval: 0, questions: 0 })
})

test('plugin effect disposal closes pending requests and unregisters its listeners', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const approval = f.approval()
  const questions = f.questions([question])
  f.dispose()
  assert.equal(await approval, 'cancelled')
  assert.deepEqual(await questions, { answers: [] })
  assert.deepEqual(f.native, { approval: 0, questions: 0 })
  assert.equal(f.listeners.get('approval/request').length, 1)
  assert.equal(f.listeners.get('user-questions/request').length, 1)
})

test('timed questions hold the official wait claim until answered without a local timeout', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const claims = []
  f.services.userQuestions = {
    async *attachWait(agent, callId, signal) {
      const claim = { agent, callId, signal, released: false }
      claims.push(claim)
      const closed = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      try {
        yield { remainingMs: 1 }
        await closed
      } finally { claim.released = true }
    },
  }
  const result = f.questions([question], 'a', { wait: { callId: 'timed-call', timed: true } })
  const [view] = await f.pending()
  assert.equal(claims.length, 1)
  assert.equal(claims[0].agent.id, 'a')
  assert.equal(claims[0].callId, 'timed-call')
  assert.equal(claims[0].signal.aborted, false)
  // A supplied finite remaining frame does not install a plugin countdown.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await f.pending()).length, 1)
  await f.answer('a', view.id, { answers: [{ id: 'choice', selected: ['One'] }] })
  assert.deepEqual(await result, { answers: [{ id: 'choice', selected: ['One'] }] })
  assert.equal(claims[0].signal.aborted, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(claims[0].released, true)
  assert.equal(f.native.questions, 0)
})

test('a timed wait that already expired preserves its business error instead of inventing an empty answer', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  const timeout = Object.assign(new Error('question expired'), { code: 'ASK_TIMED_OUT' })
  const result = f.questions([question], 'a', { signal: controller.signal, wait: { callId: 'expired-call', timed: true } })
  const rejected = assert.rejects(result, (error) => error === timeout)
  controller.abort(timeout)
  await rejected
  await assert.rejects(f.questions([question], 'a', { signal: controller.signal, wait: { callId: 'expired-call', timed: true } }), (error) => error === timeout)
  assert.deepEqual(await f.pending(), [])
  assert.equal(f.native.questions, 0)
})

test('dialog routes reject malformed input and wrong methods', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  for (const path of ['/dialogs/answer', '/dialogs/cancel']) {
    assert.equal((await f.request(path)).status, 405)
    for (const body of [null, [], {}, { session: 'a' }, { session: '', id: 'x' }, { session: 'a', id: 12 }]) {
      assert.equal((await f.request(path, { method: 'POST', body })).status, 400)
    }
    assert.equal((await f.request(path, { method: 'POST', raw: '{' })).status, 400)
  }
  assert.equal((await f.request('/dialogs/pending')).status, 400)
  assert.equal((await f.request('/dialogs/pending?session=a', { method: 'POST' })).status, 405)
})
