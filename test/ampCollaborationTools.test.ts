/** Model-facing collaboration tool dispatch and boundary validation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coordinationCollaborationToolDefinitions } from '../src/host/ampCollaborationTools.js'
import type { AmpCollaboration, Duty, DutyInput, DutyStatus, DutyTransitionInput } from '../src/host/ampCollaboration.js'
import type { CoordinationToolDefinition, CoordinationToolService, ToolExecution } from '../src/host/tools.js'
import { InvalidArgumentError } from '../src/shared/error.js'

function fixture(locale: 'en-US' | 'zh-CN' = 'en-US') {
  const calls: unknown[][] = []
  const collaboration = {
    view(actor: string) { calls.push(['view', actor]); return [] as Duty[] },
    assign(actor: string, duty: DutyInput) { calls.push(['assign', actor, duty]); return { ownerSession: actor, ...duty, status: 'assigned' } as Duty },
    transition(actor: string, id: string, status: DutyStatus, input: DutyTransitionInput) {
      calls.push(['transition', actor, id, status, input]); return { id, ownerSession: actor, status } as Duty
    },
  } as unknown as AmpCollaboration
  const rosterCalls: unknown[][] = []
  const service = {
    collaboration,
    nativeSubagents: {
      async listChildren(parent: string, signal?: AbortSignal) { rosterCalls.push(['children', parent, signal]); return [] },
      async listDescendants(root: string, signal?: AbortSignal) { rosterCalls.push(['descendants', root, signal]); return [{ id: 'child', kind: 'child', mode: 'continuable', activity: 'running', hasChildren: false, parentId: root, depth: 1 }, { id: 'agent-child', kind: 'child', mode: 'continuable', activity: 'inactive', hasChildren: false, parentId: root, depth: 1 }] },
    },
  } as unknown as CoordinationToolService
  const definitions = coordinationCollaborationToolDefinitions(service, locale, { render: value => [{ type: 'text', text: JSON.stringify(value) }] })
  const tool = definitions[0] as CoordinationToolDefinition
  const call = async (args: Record<string, unknown> = {}, exec?: ToolExecution) => tool.execute(args, exec)
  return { calls, rosterCalls, tool, call }
}

const duty: DutyInput = {
  id: 'duty-write', assigneeSession: 'agent-child', role: 'execution',
  responsibilities: ['Implement the change'], acceptance: ['Tests pass'], goal: 'goal-one',
}

test('collaboration tool is optional and parameters use closed localized schemas', () => {
  assert.deepEqual(coordinationCollaborationToolDefinitions({} as CoordinationToolService, 'en-US', { render: () => [] }), [])
  const en = fixture('en-US').tool
  const zh = fixture('zh-CN').tool
  assert.equal(en.name, 'coordination_collaboration')
  assert.equal(en.parameters.additionalProperties, false)
  assert.notEqual(en.description, zh.description)
  const properties = en.parameters.properties as Record<string, Record<string, unknown>>
  assert.equal(properties.action?.default, 'list')
  assert.ok((properties.action?.enum as string[]).includes('agents'))
  // The wire schema ships a one-line description; `execute` validates the body
  // against the strict Duty schema, so the catalog does not re-send it.
  assert.equal(properties.duty?.additionalProperties, true)
  assert.match(String(properties.duty?.description), /calling session/)
})

test('actor identity always comes from DSH execution context', async () => {
  const f = fixture()
  assert.deepEqual(await f.call({}, { agent: { id: 'actual-session' } }), { duties: [] })
  assert.deepEqual(f.calls[0], ['view', 'actual-session'])
  await assert.rejects(() => f.call({ session: 'spoofed' }, { agent: { id: 'actual-session' } }), InvalidArgumentError)
  await assert.rejects(() => f.call({}), /calling DSH session context is required/)
  await assert.rejects(() => f.call({}, { agent: { id: '  ' } }), /calling DSH session context is required/)
  assert.equal(f.calls.length, 1)
})

test('agents action exposes native descendants with caller identity and abort signal', async () => {
  const f = fixture()
  const controller = new AbortController()
  const result = await f.call({ action: 'agents' }, { agent: { id: 'root-session' }, signal: controller.signal })
  assert.deepEqual(result, {
    available: true,
    agents: [{ id: 'child', mode: 'continuable', activity: 'running', hasChildren: false, parentId: 'root-session', depth: 1 }, { id: 'agent-child', mode: 'continuable', activity: 'inactive', hasChildren: false, parentId: 'root-session', depth: 1 }],
    diagnostics: [],
  })
  assert.deepEqual(f.rosterCalls, [['descendants', 'root-session', controller.signal]])
  await assert.rejects(() => f.call({ action: 'agents', id: 'ignored' }, { agent: { id: 'root-session' } }), /id is not accepted/)
  assert.equal(f.rosterCalls.length, 1)
})

test('assign and lifecycle actions dispatch exact core operations', async () => {
  const f = fixture()
  const exec = { agent: { id: 'owner-session' } }
  await f.call({ action: 'assign', duty: { ...duty, assigneeSession: 'agent-child' } }, exec)
  assert.deepEqual(f.calls[0], ['assign', 'owner-session', duty])
  await f.call({ action: 'accept', id: 'duty-write' }, exec)
  await f.call({ action: 'start', id: 'duty-write' }, exec)
  await f.call({ action: 'submit', id: 'duty-write', summary: 'Done', evidence: ['commit abc'] }, exec)
  await f.call({ action: 'verify', id: 'duty-write', review: 'Accepted' }, exec)
  await f.call({ action: 'reject', id: 'duty-write', review: 'Needs work' }, exec)
  await f.call({ action: 'cancel', id: 'duty-write' }, exec)
  assert.deepEqual(f.calls.slice(1), [
    ['transition', 'owner-session', 'duty-write', 'accepted', {}],
    ['transition', 'owner-session', 'duty-write', 'working', {}],
    ['transition', 'owner-session', 'duty-write', 'submitted', { summary: 'Done', evidence: ['commit abc'] }],
    ['transition', 'owner-session', 'duty-write', 'verified', { review: 'Accepted' }],
    ['transition', 'owner-session', 'duty-write', 'rejected', { review: 'Needs work' }],
    ['transition', 'owner-session', 'duty-write', 'cancelled', {}],
  ])
})

test('assignment requires a verified native descendant and materializes its session', async () => {
  const f = fixture()
  await assert.rejects(() => f.call({ action: 'assign', duty: { ...duty, assigneeSession: 'unrelated-session' } }, { agent: { id: 'owner' } }), /must identify a child/)
  assert.deepEqual(f.calls, [])
  const unavailable = coordinationCollaborationToolDefinitions({ collaboration: {
    assign() { throw new Error('must not be called') },
  } } as unknown as CoordinationToolService, 'en-US', { render: () => [] })[0]!
  await assert.rejects(async () => unavailable.execute({ action: 'assign', duty }, { agent: { id: 'owner' } }), /native subagent roster is required/)
  let materialized = ''
  const withSession = coordinationCollaborationToolDefinitions({
    collaboration: { assign(owner: string, input: DutyInput) { return { ...input, ownerSession: owner, status: 'assigned' } as Duty } },
    nativeSubagents: { async listChildren() { return [] }, async listDescendants(parent: string) { return [{ kind: 'child', id: 'agent-child', parentId: parent, depth: 1, activity: 'inactive', mode: 'continuable', hasChildren: false }] } },
    session: { ensure(id: string) { materialized = id } },
  } as unknown as CoordinationToolService, 'en-US', { render: () => [] })[0]!
  await withSession.execute({ action: 'assign', duty }, { agent: { id: 'owner' } })
  assert.equal(materialized, 'agent-child')
})

test('unknown, unneeded and malformed action fields fail before calling core', async () => {
  const f = fixture()
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: 'unknown' }, /action must be one of/],
    [{ action: 'list', id: 'duty' }, /id is not accepted/],
    [{ action: 'accept' }, /id is required/],
    [{ action: 'assign', duty: { ...duty, unexpected: true } }, /unknown field unexpected/],
    [{ action: 'assign', duty: { ...duty, id: 'BAD' } }, /valid bounded string/],
    [{ action: 'assign', duty: { ...duty, responsibilities: [] } }, /invalid number of items/],
    [{ action: 'assign', duty: { ...duty, acceptance: Array(33).fill('proof') } }, /invalid number of items/],
    [{ action: 'assign', duty: { ...duty, assigneeSession: 'a'.repeat(257) } }, /valid bounded string/],
    [{ action: 'assign', duty: { ...duty, ownerSession: 'forged-owner' } }, /unknown field ownerSession/],
    [{ action: 'submit', id: 'duty', summary: 'x'.repeat(4097), evidence: ['proof'] }, /valid bounded string/],
    [{ action: 'submit', id: 'duty', summary: 'Done', evidence: [NaN] }, /valid bounded string/],
    [{ action: 'submit', id: 'duty', summary: 'Done', evidence: [] }, /invalid number of items/],
    [{ action: 'assign', duty: { ...duty, role: 'unknown-role' } }, /must be one of/],
    [{ action: 'assign', duty: { id: 'duty' } }, /requires assigneeSession/],
    [{ action: 'assign', duty: { ...duty, task: 'task-1' } }, /task reference requires its plan/],
    [{ action: 'submit', id: 'duty', summary: 'Done' }, /evidence is required/],
    [{ action: 'submit', id: 'duty', summary: ' ', evidence: ['proof'] }, /valid bounded string/],
    [{ action: 'verify', id: 'duty', review: 'ok', evidence: ['proof'] }, /evidence is not accepted/],
    [{ action: 'cancel', id: 'duty', review: 'No' }, /review is not accepted/],
    [{ nonsense: true }, /unknown field nonsense/],
  ]
  for (const [args, expected] of cases) await assert.rejects(() => f.call(args, { agent: { id: 'owner' } }), expected)
  assert.deepEqual(f.calls, [])
})
