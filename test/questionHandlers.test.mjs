/**
 * AMP 0.14.0 question lifecycle through the plugin gateway.
 *
 * `question` is the only agent module added in 0.14.0. Its verbs used to fall
 * through to the `not_implemented` stub; these tests pin the durable lifecycle:
 * open -> asked, then get/list from the same store. The gateway wraps a handler
 * payload as `{ module, verb, value }`, so assertions unwrap one level.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

function fakeContext() {
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get(name) {
        return tools.get(name)
      },
      definitions() {
        return [...tools.values()]
      },
    },
    systemPrompt: { getSectionOrder: () => 0, getContextOrder: () => 0, section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {} },
    sessions: { list: () => [] },
    agents: { get: () => undefined },
    on: () => () => {},
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get: () => undefined,
    provide: () => () => {},
    inject: () => () => {},
  }
  return { ctx, tools, disposers }
}

function config(storePath) {
  return {
    tenantId: 'test', rootId: 'root', storePath,
    notifications: false, prompt: false, skills: false, commands: false, routes: false,
    maxJournal: 100, maxReadChars: 200_000, maxWriteChars: 1_000_000,
  }
}

function fakeExec(sessionId) {
  const agent = { id: sessionId, status: 'running', session: { header: { cwd: process.cwd() } } }
  return { callId: 'call-1', name: 'test', arguments: {}, signal: new AbortController().signal, agent, rootCallId: 'call-1' }
}

test('question open/get/list round-trips through the kernel store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-question-'))
  const { ctx, tools, disposers } = fakeContext()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    const question = tools.get('attention_manifest_protocol_question')
    assert.notEqual(question, undefined, 'the 0.14.0 question tool must be registered')
    const exec = fakeExec('session-q')

    const opened = await question.execute({
      verb: 'open',
      arguments: {
        prompt: 'Which range should be compacted?',
        kind: 'decision',
        options: [{ id: 'head', label: 'Head' }, { id: 'tail', label: 'Tail' }],
        blocking: true,
      },
    }, exec)
    assert.equal(opened.value.ok, true, JSON.stringify(opened))
    const created = opened.value.value
    assert.equal(created.state, 'asked')
    assert.equal(created.sessionId, 'session-q')
    assert.equal(created.options.length, 2)
    const id = created.id

    const got = await question.execute({ verb: 'get', arguments: { id } }, exec)
    assert.equal(got.value.ok, true)
    assert.equal(got.value.value.id, id)

    // `sessionId` is bound by the host, so the model omits it.
    const listed = await question.execute({ verb: 'list', arguments: {} }, exec)
    assert.equal(listed.value.ok, true)
    assert.equal(listed.value.value.total, 1)
    assert.equal(listed.value.value.items[0].id, id)
    assert.equal(listed.value.value.items[0].sessionId, 'session-q')

    const missing = await question.execute({ verb: 'get', arguments: { id: 'missing' } }, exec)
    assert.equal(missing.value.ok, false)
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('question open validates its prompt and kind', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-question-'))
  const { ctx, tools, disposers } = fakeContext()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    const question = tools.get('attention_manifest_protocol_question')
    const exec = fakeExec('session-q')
    const empty = await question.execute({ verb: 'open', arguments: { prompt: '   ' } }, exec)
    assert.equal(empty.value.ok, false)

    const opened = await question.execute({
      verb: 'open',
      arguments: { prompt: 'Proceed?', kind: 'not-a-kind' },
    }, exec)
    assert.equal(opened.value.ok, true)
    assert.equal(opened.value.value.kind, 'clarification', 'invalid kinds fall back to clarification')
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
