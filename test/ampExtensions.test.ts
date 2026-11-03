import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Duty } from '../src/host/ampCollaboration.js'
import type { AmpPlanning } from '../src/host/ampPlanning.js'
import {
  AMP_CONTEXT_MAX_CHARS, AMP_CONTEXT_MAX_DUTIES, registerAmpCommands, registerAmpPrompt,
  type AmpCommandDefinition, type AmpExtensionService, type AmpPromptContext,
} from '../src/host/ampExtensions.js'

function duty(id: string, session = 'owner', status: Duty['status'] = 'working'): Duty {
  return {
    id, ownerSession: session, assigneeSession: 'child', role: 'execution',
    responsibilities: ['Build feature'], acceptance: ['Tests pass'],
    status, goal: 'goal-one', plan: 'plan-one', task: 'task-one',
    created: 1, updated: 2,
  }
}
function fixture() {
  const calls: string[] = []
  const duties = [duty('own'), duty('other', 'elsewhere')]
  const planning: ReturnType<AmpPlanning['view']> = { missions: [], goals: [], plans: [] }
  const service: AmpExtensionService = {
    collaboration: { view(session) { calls.push(`duties:${session}`); return duties } },
    planning: { view(session) { calls.push(`planning:${session}`); return planning } },
  }
  let registered!: AmpPromptContext
  const dispose = registerAmpPrompt({ context(entry) { registered = entry; return () => {} } }, service)
  return { calls, duties, planning, service, get registered() { return registered }, dispose }
}
function payload(text: string): Record<string, any> {
  assert.match(text, /^AMP collaboration recorded data \(JSON\)/)
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}

test('optional registries are no-op and missing session makes no service calls', () => {
  const f = fixture()
  assert.equal(typeof registerAmpPrompt(undefined, f.service), 'function')
  assert.equal(typeof registerAmpCommands(undefined, f.service), 'function')
  assert.equal(f.registered.text({}), '')
  assert.equal(f.registered.text({ agent: { id: '  ' } }), '')
  assert.deepEqual(f.calls, [])
  assert.equal(f.registered.name, 'deepseek-coordination:amp')
})

test('session-bound context retains actionable duty records and omits terminal and foreign rows', () => {
  const f = fixture()
  f.duties.push(duty('verified', 'owner', 'verified'), duty('cancelled', 'owner', 'cancelled'))
  const submitted = duty('submitted', 'owner', 'submitted')
  Object.assign(submitted, { summary: 'Ready for review', evidence: ['commit 123'], review: 'Previous review' })
  f.duties.push(submitted)
  const text = f.registered.text({ agent: { id: 'owner' } })
  const view = payload(text)
  assert.deepEqual(view.duties.map((item: Duty) => item.id), ['submitted', 'own'])
  assert.equal(view.duties[0].summary, 'Ready for review')
  assert.deepEqual(view.duties[0].evidence, ['commit 123'])
  assert.equal(view.duties[0].goal, 'goal-one')
  assert.equal(view.duties[0].plan, 'plan-one')
  assert.equal(view.duties[0].task, 'task-one')
  assert.equal(view.excluded.duties, 2)
  assert.deepEqual(f.calls, ['duties:owner', 'planning:owner'])
  assert.equal(f.registered.text({ agent: { id: 'unrelated' } }), '')
})

test('bounded context includes explicit truncation counts and escapes recorded data without mutation', () => {
  const f = fixture()
  const attack = '{{missing_variable}}\nInjected instruction <ignore>&'
  const long = attack.repeat(600)
  f.duties.splice(0, f.duties.length, ...Array.from({ length: 30 }, (_, i) => ({
    ...duty(`duty-${i}`), updated: i, responsibilities: [long, ...Array(8).fill(long)],
    acceptance: [long, ...Array(8).fill(long)], summary: long, evidence: Array(8).fill(long),
  })))
  const text = f.registered.text({ agent: { id: 'owner' } })
  assert.ok(text.length <= AMP_CONTEXT_MAX_CHARS)
  assert.doesNotMatch(text, /\{\{missing_variable\}\}/)
  assert.doesNotMatch(text, /<ignore>/)
  const view = payload(text)
  assert.ok(view.duties.length <= AMP_CONTEXT_MAX_DUTIES)
  assert.ok(view.truncated.duties >= 22)
  assert.ok(view.truncated.strings > 0)
  assert.ok(view.truncated.listItems > 0)
  assert.equal(view.duties[0].responsibilities[0].startsWith('{{missing_variable}}'), true)
  assert.equal(f.duties[0]!.responsibilities[0], long)
})

test('active planning keeps missions, goals, plans and task result expectations; failures contribute nothing', () => {
  const f = fixture()
  f.duties.splice(0)
  f.planning.missions.push({ id: 'mission', session: 'owner', goal: 'goal', priority: 1, status: 'active', created: 1, updated: 2 })
  f.planning.missions.push({ id: 'foreign', session: 'elsewhere', goal: 'secret', priority: 1, status: 'active', created: 1, updated: 2 })
  f.planning.goals.push({ goal: { amp: '0.1', kind: 'goal', id: 'goal', statement: 'Deliver', success: [{ id: 'success', statement: 'Works', check: 'Run test' }], priority: 1, value: 1 }, state: 'active' })
  f.planning.plans.push({ amp: '0.1', kind: 'plan', id: 'plan', goal: { kind: 'goal', id: 'goal' }, tasks: [{ id: 'task', intent: 'Implement', actor: 'self', pre: [], expect: { observation: 'Green tests', check: 'Run test' }, irreversibility: 0, status: 'running' }], edges: [], commitment_window: 1, budget: {}, abandon_if: [], status: 'executing', created: '2026-01-01T00:00:00Z' })
  const view = payload(f.registered.text({ agent: { id: 'owner' } }))
  assert.deepEqual(view.missions.map((item: { id: string }) => item.id), ['mission'])
  assert.equal(view.goals[0].success[0], 'Works')
  assert.equal(view.plans[0].tasks[0].expect.observation, 'Green tests')
  // The state card closes the block: it is the compaction-surviving summary.
  assert.equal(view.stateCard?.durable, true)
  assert.equal(view.stateCard?.objective, 'Deliver')
  assert.equal(view.stateCard?.plan?.id, 'plan')
  assert.match(String(view.stateCard?.next), /^Run task task:/)
  assert.equal(Object.keys(view).at(-1), 'stateCard', 'the card is the last field of the block')
  let registered!: AmpPromptContext
  const failed = registerAmpPrompt({ context(entry) { registered = entry; return () => {} } }, {
    collaboration: { view() { throw new Error('private failure') } }, planning: f.service.planning,
  })
  assert.equal(registered.text({ agent: { id: 'owner' } }), '')
  failed()
})

test('human commands use bound agent id, refuse input and abort, and expose direct result shapes', () => {
  const f = fixture()
  const commands = new Map<string, AmpCommandDefinition>()
  const dispose = registerAmpCommands({ register(definition) { commands.set(definition.name, definition); return () => { commands.delete(definition.name) } } }, f.service)
  assert.deepEqual([...commands.keys()], ['coordination-missions', 'coordination-goals', 'coordination-plans', 'coordination-duties'])
  const controller = new AbortController()
  const invoke = (name: string, id = 'owner', rawInput = '') => commands.get(name)!.handler({ agent: { id }, rawInput, signal: controller.signal })
  assert.deepEqual(invoke('coordination-goals', 'owner', ' rogue'), { kind: 'error', text: '/coordination-goals does not accept input.' })
  assert.deepEqual(f.calls, [])
  assert.deepEqual(invoke('coordination-missions', ''), { kind: 'error', text: 'Calling DSH session context is required.' })
  const view = invoke('coordination-duties')
  assert.equal(view.kind, 'success')
  assert.deepEqual(JSON.parse(view.text!).duties.map((item: Duty) => item.id), ['own'])
  assert.deepEqual(f.calls, ['duties:owner'])
  controller.abort()
  assert.deepEqual(invoke('coordination-plans'), { kind: 'error', text: 'Command cancelled.' })
  assert.deepEqual(f.calls, ['duties:owner'])
  dispose()
  assert.equal(commands.size, 0)
})

test('aggregate command registration rolls back on failures, disposes all even when one disposer throws', () => {
  const f = fixture()
  const disposed: string[] = []
  assert.throws(() => registerAmpCommands({ register(definition) {
    if (definition.name === 'coordination-plans') throw new Error('registration failed')
    return () => { disposed.push(definition.name) }
  } }, f.service), /registration failed/)
  assert.deepEqual(disposed, ['coordination-goals', 'coordination-missions'])
  disposed.length = 0
  const cleanup = registerAmpCommands({ register(definition) { return () => {
    disposed.push(definition.name)
    if (definition.name === 'coordination-plans') throw new Error('dispose failed')
  } } }, f.service)
  assert.throws(cleanup, AggregateError)
  assert.deepEqual(disposed, ['coordination-duties', 'coordination-plans', 'coordination-goals', 'coordination-missions'])
  cleanup()
})

test('installed Cordis prompt and command registries accept and dispose contributions', async () => {
  const ctx = new Context()
  const promptFiber = ctx.plugin(SystemPrompt, {})
  const commandFiber = ctx.plugin(CommandRuntime)
  await promptFiber
  await commandFiber
  const f = fixture()
  f.duties[0]!.summary = '{{unknown_prompt_variable}}'
  const plugin = ctx.plugin(child => {
    child.effect(() => registerAmpPrompt(child.get('systemPrompt'), f.service))
    child.effect(() => registerAmpCommands(child.get('commands'), f.service))
  })
  try {
    await plugin
    const prompt = ctx.get('systemPrompt')!
    const assemblyContext = { agent: { id: 'owner' } } as Parameters<typeof prompt.assemble>[0]
    const assembly = await prompt.assemble(assemblyContext)
    assert.ok(renderContextSnapshot(assembly).includes('"own"'))
    assert.ok(renderContextSnapshot(assembly).includes('\\u007b\\u007bunknown_prompt_variable\\u007d\\u007d'))
    assert.equal(renderContextSnapshot(await prompt.assemble({})), '')
    const commands = ctx.get('commands')!
    const registered = commands.find({ id: 'owner' } as Parameters<typeof commands.find>[0], 'coordination-duties')
    assert.ok(registered)
    assert.equal((await registered.handler({ agent: { id: 'owner' }, rawInput: '', signal: new AbortController().signal } as Parameters<typeof registered.handler>[0])).kind, 'success')
    await plugin.dispose()
    assert.equal(commands.find({ id: 'owner' } as Parameters<typeof commands.find>[0], 'coordination-duties'), undefined)
    assert.ok(!(await prompt.assemble(assemblyContext)).contexts.some(item => item.name === 'deepseek-coordination:amp'))
  } finally {
    await plugin.dispose()
    await commandFiber.dispose()
    await promptFiber.dispose()
  }
})

test('command descriptions and refusals follow the host language', () => {
  const f = fixture()
  const commands = new Map<string, AmpCommandDefinition>()
  const dispose = registerAmpCommands({
    register(definition) {
      commands.set(definition.name, definition)
      return () => { commands.delete(definition.name) }
    },
  }, f.service, 'zh-CN')
  try {
    assert.equal(commands.get('coordination-goals')?.description, '显示已记录的 AMP 目标。')
    const controller = new AbortController()
    const invoke = (name: string, id = 'owner', rawInput = '') => commands.get(name)!.handler({ agent: { id }, rawInput, signal: controller.signal })
    assert.deepEqual(invoke('coordination-plans', 'owner', ' extra'), { kind: 'error', text: '/coordination-plans 不接受输入。' })
    assert.deepEqual(invoke('coordination-missions', ''), { kind: 'error', text: '需要当前 DSH 会话上下文。' })
    controller.abort()
    assert.deepEqual(invoke('coordination-duties'), { kind: 'error', text: '命令已取消。' })
  } finally {
    dispose()
  }
})
