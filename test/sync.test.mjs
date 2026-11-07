import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

test('DSH session, turn, goal, plan, todo and tool events project into AMP', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-sync-'))
  const handlers = new Map()
  let host
  const ctx = {
    tools: { register: () => () => {}, get: () => undefined, definitions: () => [] },
    systemPrompt: { getSectionOrder: () => 0, getContextOrder: () => 0, section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {} },
    sessions: { list: () => [] },
    agents: { get: () => undefined },
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
    effect: (factory) => {
      const dispose = factory()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    get: () => undefined,
    provide: (_name, value) => {
      host = value
      return () => {}
    },
    inject: () => () => {},
  }
  try {
    await apply(ctx, {
      tenantId: 'test', rootId: 'root', storePath: join(directory, 'amp.sqlite'),
      notifications: false, prompt: false, skills: false, commands: false, routes: false,
      maxJournal: 100, maxReadChars: 100_000, maxWriteChars: 100_000, contextOptimization: true, contextBudgetTokens: 1200,
    })
    const agent = { id: 's1', status: 'running', session: { header: { cwd: directory } } }
    const emit = (name, ...args) => {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    }
    emit('agent/created', { agent })
    emit('session/event', { id: 's1' }, { type: 'user/message', data: { content: [{ type: 'text', text: 'please optimize this turn' }] } })
    emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } })
    emit('session/event', { id: 's1' }, { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'call-1', isError: false } } })
    emit('session/event', { id: 's1' }, { type: 'todo/write', data: { turn: 1, todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'completed' }] } })
    // A later todo_write may grow an existing plan, including after an empty list.
    const expandedTodos = [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'completed' }, { content: 'c', status: 'in_progress' }]
    emit('session/event', { id: 's1' }, { type: 'todo/write', data: { turn: 1, todos: [] } })
    emit('session/event', { id: 's1' }, { type: 'todo/write', data: { turn: 1, todos: expandedTodos } })
    assert.deepEqual(host.sync.status().errors, [])
    const addedTask = host.kernel().ports.services.task.get('dsh:task:todos:s1:2')
    assert.equal(addedTask.state, 'active')
    emit('session/event', { id: 's1' }, { type: 'todo/write', data: { turn: 1, todos: expandedTodos } })
    assert.equal(host.kernel().ports.services.task.get(addedTask.id).version, addedTask.version)
    emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    emit('goal/changed', { agent, change: { goal: { id: 'g1', objective: 'ship AMP', phase: 'complete', revision: 2 } } })

    const snapshot = host.kernel().snapshot()
    assert.ok(snapshot.counts.session >= 1)
    assert.equal(snapshot.counts.turn, 1)
    assert.equal(snapshot.counts.action, 1)
    assert.ok(snapshot.counts.plan >= 2)
    assert.ok(snapshot.counts.task >= 3)
    assert.ok(snapshot.counts.goal >= 2)
    assert.equal(host.kernel().ports.services.turn.get('turn:s1:1').state, 'completed')
    assert.equal(host.kernel().ports.services.action.get('dsh:action:call-1').state, 'succeeded')
    const lists = host.sessionLists('s1', directory)
    assert.equal(lists.session[0].title, 'please optimize this turn')
    assert.equal(lists.action[0].title, '读取文件')
    assert.equal(lists.action[0].detail, undefined)
    assert.equal(lists.goal[0].title, 'ship AMP')
    assert.equal(lists.turn[0].title, '第 1 轮对话')
    const context = host.contextOptimizer.contextFor(agent)
    assert.ok(context.includes('please optimize this turn'), JSON.stringify(context))
    assert.ok(context.includes('workspace:'))
    const sync = host.sync?.status?.()
    assert.ok(sync === undefined || sync.errors.length === 0, JSON.stringify(sync))
  } finally {
    host?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})



