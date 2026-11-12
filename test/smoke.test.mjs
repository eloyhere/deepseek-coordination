import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

function fakeContext(overrides = {}) {
  const tools = new Map()
  const disposers = []
  const injections = []
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
      execute: overrides.execute,
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
      section: () => () => {},
      context: () => () => {},
    },
    commands: { register: () => () => {} },
    skills: { register: () => () => {} },
    sessions: { list: () => [] },
    agents: { get: () => undefined },
    on: () => () => {},
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get: (name) => overrides[name] ?? overrides.services?.[name],
    provide: () => () => {},
    inject: (_deps, callback) => {
      injections.push(callback)
      return () => {}
    },
    ...overrides,
  }
  return { ctx, tools, disposers, injections }
}

function config(storePath) {
  return {
    tenantId: 'test',
    rootId: 'root',
    storePath,
    notifications: true,
    prompt: true,
    skills: true,
    commands: true,
    routes: true,
    maxJournal: 100,
    maxReadChars: 200_000,
    maxWriteChars: 1_000_000,
  }
}

function fakeExec(agentId = 'session-1') {
  const agent = {
    id: agentId,
    status: 'running',
    session: { header: { cwd: process.cwd() } },
  }
  return {
    callId: 'call-1',
    name: 'test',
    arguments: {},
    signal: new AbortController().signal,
    agent,
    rootCallId: 'call-1',
  }
}

/** Run one test against a fresh store, closing the kernel before cleanup. */
async function withPlugin(run) {
  const directory = mkdtempSync(join(tmpdir(), 'amp-plugin-'))
  const { ctx, tools, disposers } = fakeContext()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    await run({ ctx, tools })
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
}

test('registers the 18 AMP modules, discovery and the notification tool', async () => {
  await withPlugin(async ({ tools }) => {
    const names = [...tools.keys()].sort()
    assert.equal(names.length, 23)
    assert.ok(names.includes('deepseek_coordination_intake'))
    assert.ok(names.includes('attention_manifest_protocol_discover'))
    assert.ok(names.includes('attention_manifest_protocol_replace'))
    assert.ok(names.includes('attention_manifest_protocol_workspace'))
    assert.ok(names.includes('attention_manifest_protocol_execution'))
    assert.ok(names.includes('attention_manifest_protocol_harness'))
    assert.ok(names.includes('attention_manifest_protocol_elaboration'))
    assert.ok(names.includes('attention_manifest_protocol_draft'))
    assert.ok(names.includes('coordination_notification'))
  })
})

test('discovery returns all 30 AMP modules', async () => {
  await withPlugin(async ({ tools }) => {
    const discover = tools.get('attention_manifest_protocol_discover')
    const value = await discover.execute({ action: 'catalog' }, fakeExec())
    assert.equal(value.discovered, 30)
    const agentModules = value.modules.filter((module) => module.tier === 'agent')
    assert.equal(agentModules.length, 18)
    assert.equal(agentModules.reduce((total, module) => total + module.verbs.length, 0), 64)
  })
})

test('a module tool dispatches through the gateway and creates the kernel', async () => {
  await withPlugin(async ({ tools }) => {
    const budget = tools.get('attention_manifest_protocol_budget')
    const value = await budget.execute({ verb: 'remaining' }, fakeExec())
    assert.equal(value.module, 'budget')
    assert.equal(value.verb, 'remaining')
    assert.ok(value.value !== undefined)
    const session = tools.get('attention_manifest_protocol_session')
    const list = await session.execute({ verb: 'list' }, fakeExec())
    assert.equal(list.module, 'session')
    assert.equal(list.value.ok, true)
    await assert.rejects(
      () => session.execute({ verb: 'nope' }, fakeExec()),
      /invalid arguments|unknown_tool|no exposed verb/,
    )
  })
})

test('notification tool enqueues a snackbar and a dialog', async () => {
  await withPlugin(async ({ tools }) => {
    const notification = tools.get('coordination_notification')
    const first = await notification.execute({ surface: 'snackbar', message: 'hello' }, fakeExec('session-x'))
    assert.equal(first.ok, true)
    assert.equal(first.surface, 'snackbar')
    const second = await notification.execute({ surface: 'dialog', message: 'blocked?' }, fakeExec('session-x'))
    assert.equal(second.ok, true)
  })
})



test('routes bind through ctx.inject when webServer appears after apply', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-plugin-'))
  const overrides = {}
  const { ctx, disposers, injections } = fakeContext(overrides)
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    assert.equal(injections.length, 1)
    const paths = []
    overrides.webServer = {
      register(route) {
        if (route.path === '/deepseek-coordination/amp/client-report') throw new Error('duplicate route')
        paths.push(route.path)
        return () => {}
      },
    }
    injections[0](ctx)
    assert.ok(paths.includes('/deepseek-coordination/ping'))
    assert.ok(paths.includes('/deepseek-coordination/amp/status'))
    assert.ok(paths.includes('/deepseek-coordination/notify/pending'))
    // A real webServer rejects a second registration of the same path; the
    // fake would otherwise hide a duplicate that silently drops later routes.
    assert.equal(new Set(paths).size, paths.length, `duplicate route in ${paths.join(', ')}`)
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})



test('the harness bridge writes goals, plans, todos and feedback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-plugin-'))
  const calls = []
  const services = {
    commands: {
      execute: async (_agent, line) => {
        calls.push(line)
        return { kind: 'success', text: line }
      },
    },
    sessionFeedback: {
      record: async (request) => {
        calls.push(`feedback:${request.category}:${request.text}`)
        return { recorded: true }
      },
    },
  }
  const overrides = { services }
  const { ctx, tools, disposers } = fakeContext(overrides)
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    const harness = tools.get('attention_manifest_protocol_harness')
    const exec = fakeExec('session-bridge')
    const goal = await harness.execute({ operation: 'goal', action: 'create', text: 'ship AMP' }, exec)
    assert.equal(goal.ok, true)
    assert.ok(calls.includes('/goal ship AMP'))
    await harness.execute({ operation: 'plan', action: 'enter' }, exec)
    assert.ok(calls.includes('/plan'))
    const feedback = await harness.execute({ operation: 'feedback', text: 'done', category: 'task-result' }, exec)
    assert.equal(feedback.ok, true)
    assert.ok(calls.some((line) => line.startsWith('feedback:task-result:')))
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
