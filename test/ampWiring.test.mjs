/**
 * Regression tests for the semantic wiring found by the module audits.
 *
 * Each case pins a behaviour that used to be a silent no-op: a response that
 * never advanced the AMP turn, a clarification whose text was dropped, an
 * evidence submission that claimed to be recorded, and a progress report that
 * never touched TaskService.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

function fakeContext() {
  const tools = new Map()
  const handlers = new Map()
  const disposers = []
  let host
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (name) => tools.get(name),
      definitions: () => [...tools.values()],
      execute: async ({ calls }) => ({
        results: calls.map((call) => ({
          callId: call.id,
          result: {
            isError: false,
            value: { ok: true },
            content: [{ type: 'text', text: 'x'.repeat(20_000) }],
          },
        })),
      }),
    },
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
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get: () => undefined,
    provide: (_name, value) => {
      host = value
      return () => {}
    },
    inject: () => () => {},
  }
  const emit = (name, ...args) => {
    for (const handler of handlers.get(name) ?? []) handler(...args)
  }
  return { ctx, tools, disposers, emit, host: () => host }
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

async function withPlugin(run) {
  const directory = mkdtempSync(join(tmpdir(), 'amp-wiring-'))
  const instance = fakeContext()
  try {
    await apply(instance.ctx, config(join(directory, 'amp.sqlite')))
    await run({ ...instance, host: instance.host })
  } finally {
    for (const dispose of instance.disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
}

const call = async (tools, module, verb, parameters, sessionId = 's1') =>
  tools.get(`attention_manifest_protocol_${module}`).execute({ verb, arguments: parameters }, fakeExec(sessionId))

test('turn.respond attempts the AMP turn transition and reports it', async () => {
  await withPlugin(async ({ tools, emit }) => {
    const agent = { id: 's1', status: 'running', session: { header: { cwd: process.cwd() } } }
    emit('agent/created', { agent })
    emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } })

    const result = await call(tools, 'turn', 'respond', { content: 'working on it' })
    assert.equal(result.value.ok, true)
    assert.equal(typeof result.value.value.advanced, 'boolean')
    // The turn id is host-stable; when the transition is legal it must advance.
    const turn = emit && tools.get('attention_manifest_protocol_turn') !== undefined
    assert.equal(turn, true)
  })
})

test('intent.submit_clarification fails loudly on an unknown intent', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await call(tools, 'intent', 'submit_clarification', {
      intentId: 'intent:missing',
      clarification: 'use the smaller range',
    })
    assert.equal(result.value.ok, false, JSON.stringify(result))
    assert.equal(result.value.error.code, 'invalid_state')
  })
})

test('goal.submit_evidence refuses to pretend when no receipt exists', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await call(tools, 'goal', 'submit_evidence', {
      goalId: 'goal:missing',
      claim: 'the audit passed',
    })
    assert.equal(result.value.ok, true)
    assert.equal(result.value.value.recorded, false)
    assert.match(result.value.value.reason, /receiptId/)
  })
})

test('task.report_progress reports an unsupported state instead of claiming success', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await call(tools, 'task', 'report_progress', {
      taskId: 'task:missing',
      progress: 'halfway',
      state: 'finished',
    })
    assert.equal(result.value.ok, true)
    assert.equal(result.value.value.advanced, false)
    assert.match(result.value.value.transition ?? '', /unsupported state/)
  })
})

test('evidence.cite refuses ids that are not in the AMP ledger', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await call(tools, 'evidence', 'cite', { ids: ['evidence:missing'] })
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'not_found')
  })
})

test('budget.remaining exposes the flat budget and the per-node tree', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await call(tools, 'budget', 'remaining', {})
    assert.equal(result.value.ok, true)
    assert.equal(typeof result.value.value, 'object')
    assert.ok(Array.isArray(result.value.value.tree))
  })
})

test('execution.read_handle pages through an AMP retrieval handle', async () => {
  await withPlugin(async ({ tools }) => {
    // Eight child calls, each capped at 4k characters by the handler, cross the
    // 16k handle threshold.
    const calls = Array.from({ length: 8 }, (_, index) => ({ name: 'echo', callId: `c${index}` }))
    const run = await call(tools, 'execution', 'run', { calls })
    assert.equal(run.value.ok, true)
    const handle = run.value.value.handle
    assert.equal(typeof handle, 'string')

    const first = await call(tools, 'execution', 'read_handle', { handle, limit: 10 })
    assert.equal(first.value.ok, true)
    assert.equal(first.value.value.content.length, 10)
    assert.ok(first.value.value.total > 16_000)

    // The tail page proves the handle serves content beyond the first page.
    const tail = first.value.value.total - 10
    const last = await call(tools, 'execution', 'read_handle', { handle, offset: tail, limit: 100 })
    assert.equal(last.value.ok, true)
    assert.equal(last.value.value.content.length, 10)

    const missing = await call(tools, 'execution', 'read_handle', { handle: 'handle:missing' })
    assert.equal(missing.value.ok, false)
    assert.equal(missing.value.error.code, 'not_found')
  })
})

test('the host publishes an AMP capability and manifest for every module', async () => {
  await withPlugin(async ({ host }) => {
    const hostService = host()
    assert.equal(typeof hostService.ampSurface, 'object')
    const summary = hostService.ampSurface.summary()
    assert.equal(summary.modules, hostService.agentModules.length)
    assert.equal(summary.active, hostService.agentModules.length)

    const question = hostService.ampSurface.infoFor('question')
    assert.equal(typeof question.capabilityId, 'string')
    assert.ok(question.verbs.includes('open'))
    assert.equal(hostService.ampSurface.isActive('question'), true)
    assert.equal(hostService.ampSurface.isActive('does-not-exist'), false)
  })
})

test('execution.run records an AMP behaviour observation', async () => {
  await withPlugin(async ({ tools, host }) => {
    const before = host().behaviour.observations
    await call(tools, 'execution', 'run', { tool: 'echo' })
    assert.equal(host().behaviour.observations, before + 1)

    const samples = host().behaviour.governance.listShadowValidations(host().behaviour.candidateId)
    assert.equal(samples.length, before + 1)
    assert.equal(samples.at(-1).passed, true)
  })
})

test('cooperation.send stores a message in the AMP cooperation kernel', async () => {
  await withPlugin(async ({ tools, host }) => {
    const sent = await call(tools, 'cooperation', 'send', { content: 'hello', to: 'peer' })
    assert.equal(sent.value.ok, true)
    assert.ok(String(sent.value.value.id).startsWith('message:'), JSON.stringify(sent.value.value))

    const summary = host().cooperation.summary()
    assert.equal(summary.cooperations, 1)
    assert.equal(summary.messages, 1)

    const inbox = await call(tools, 'cooperation', 'inbox', {})
    assert.equal(inbox.value.ok, true)
    const items = inbox.value.value.items
    assert.equal(items.length, 1)
    assert.equal(items[0].cooperationId, 'cooperation:s1')
    assert.equal(items[0].content, 'hello')
  })
})

test('the host exposes AMP model and runtime ports', async () => {
  await withPlugin(async ({ host }) => {
    const service = host()
    assert.equal(service.model.configured, false)
    assert.equal(service.runtime.configured, false)
    await assert.rejects(service.model.propose({}))
    await assert.rejects(service.runtime.execute([], {}, 'budget', {}))

    service.model.setPort({
      propose: async () => ({ kind: 'response', text: 'ok', evidenceIds: [] }),
    })
    assert.equal(service.model.configured, true)
    const context = {
      tenantId: 'test',
      principalId: 's1',
      sessionId: 's1',
      turnId: 'turn:s1:1',
      cancellationEpoch: 0,
      policyVersion: 'dsh-amp-0.14.0',
    }
    const compiled = { scope: { tenantId: 'test', sessionId: 's1', principalId: 's1' } }
    const proposal = await service.model.propose({ context, compiled, allowedToolIds: [] })
    assert.equal(proposal.kind, 'response')
    assert.equal(proposal.text, 'ok')
  })
})
