/** Model-facing planning tools against the durable AMP core and SQLite fixture. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Goal, Plan } from 'attention-manifest-protocol/goal/plan.js'
import type { GoalLifecycle } from 'attention-manifest-protocol/goal'
import { AmpPlanning, type Mission } from '../src/host/ampPlanning.js'
import {
  coordinationToolDefinitions,
  registerCoordinationTools,
  TOOL_RESULT_MARKER,
  type CoordinationAnyToolName,
  type CoordinationToolDefinition,
  type CoordinationToolService,
  type ToolExecution,
} from '../src/host/tools.js'
import { InvalidArgumentError } from '../src/shared/error.js'
import { createTestHost, insertSession } from './helpers.js'

const planningNames = ['coordination_mission', 'coordination_goal', 'coordination_plan'] as const

function fixture() {
  const f = createTestHost()
  const planning = new AmpPlanning(f.host)
  // SessionModule.ensure stores the DSH ID directly in session.handle.
  insertSession(f.db, 'dsh-planning')
  insertSession(f.db, 'coordination-session')
  const unused = (): never => { throw new Error('planning tools must not call composer methods') }
  const narrow: CoordinationToolService = {
    locale: 'en-US',
    state: unused,
    setSelection: unused,
    activeTurn: unused,
    getProfessionRecord: unused,
    turnByOrdinal: unused,
  }
  const service: CoordinationToolService = { ...narrow, planning, config: f.host.config }
  const definitions = coordinationToolDefinitions(service)
  function tool(name: typeof planningNames[number]): CoordinationToolDefinition {
    const definition = definitions.find(entry => entry.name === name)
    assert.ok(definition, `${name} is registered`)
    return definition
  }
  async function call<T>(name: typeof planningNames[number], args: Record<string, unknown> = {}, exec?: ToolExecution): Promise<T> {
    return await tool(name).execute(args, exec ?? { agent: { id: 'dsh-planning' } }) as T
  }
  return { ...f, planning, narrow, service, definitions, tool, call }
}

function goal(id = 'goal-tool'): Goal {
  return {
    amp: '0.1', kind: 'goal', id,
    statement: 'Produce the tested planning artifact',
    success: [{ id: 'criterion-success', statement: 'Artifact passes validation', check: 'inspect validation result', kind: 'observe' }],
    value: 0.8, priority: 2, horizon: 'session',
  }
}

function plan(goalId: string, id = 'plan-tool'): Plan {
  return {
    amp: '0.1', kind: 'plan', id, goal: { kind: 'goal', id: goalId },
    tasks: [{
      id: 'task-write', intent: 'Write the artifact', actor: 'self', pre: [],
      expect: { observation: 'Artifact is available', check: 'inspect artifact' },
      irreversibility: 0, status: 'pending',
    }],
    edges: [], commitment_window: 1, budget: { tokens: 500, calls: 2 },
    abandon_if: [{ id: 'criterion-abandon', statement: 'Required input is unavailable', check: 'inspect input availability' }],
    status: 'draft', created: '2026-11-02T12:00:00Z',
  }
}

test('planning registration is optional, independent of file tools, localized and disposable', t => {
  const f = fixture()
  t.after(() => f.close())
  assert.equal(coordinationToolDefinitions(f.narrow).length, 3)
  assert.equal(f.definitions.length, 6)
  assert.deepEqual(f.definitions.slice(3).map(entry => entry.name), planningNames)
  const registered: CoordinationAnyToolName[] = []
  const disposed: CoordinationAnyToolName[] = []
  const dispose = registerCoordinationTools({
    register(definition) {
      registered.push(definition.name)
      return () => { disposed.push(definition.name) }
    },
  }, f.service, 'en-US', { fileTools: false })
  assert.deepEqual(registered.slice(3), planningNames)
  dispose()
  assert.deepEqual(disposed, [...registered].reverse())
  dispose()
  assert.equal(disposed.length, registered.length, 'disposal is idempotent')

  const chinese = coordinationToolDefinitions(f.service, 'zh-CN')
  for (const name of planningNames) {
    const english = f.tool(name)
    const localized = chinese.find(entry => entry.name === name)!
    assert.notEqual(english.description, localized.description)
    const properties = english.parameters.properties as Record<string, Record<string, unknown>>
    assert.equal(properties.action?.default, 'list')
    assert.equal(english.parameters.additionalProperties, false)
    assert.match(String(properties.session?.description), /DSH session ID or coordination session handle/)
  }
})

test('mission and plan tools drive the real goal, mission and task lifecycle', async t => {
  const f = fixture()
  t.after(() => f.close())
  const created = await f.call<{ session: string; mission: Mission }>('coordination_mission', { action: 'create', goal: goal() })
  assert.equal(created.session, 'dsh-planning')
  assert.equal(created.mission.status, 'queued')
  assert.equal(f.planning.goals('dsh-planning')[0]?.state, 'committed')
  const activated = await f.call<{ mission: Mission }>('coordination_mission', { action: 'activate' })
  assert.equal(activated.mission.id, created.mission.id)
  assert.equal(activated.mission.status, 'active')
  assert.equal(f.planning.goals('dsh-planning')[0]?.state, 'active')

  const createdPlan = await f.call<{ plan: Plan }>('coordination_plan', { action: 'create', plan: plan(created.mission.goal) })
  assert.equal(createdPlan.plan.status, 'draft')
  await f.call('coordination_plan', { action: 'transition', id: createdPlan.plan.id, status: 'committed' })
  await f.call('coordination_plan', { action: 'transition', id: createdPlan.plan.id, status: 'executing' })
  const running = await f.call<{ plan: Plan }>('coordination_plan', { action: 'task', id: createdPlan.plan.id, task: 'task-write', status: 'running' })
  assert.equal(running.plan.tasks[0]?.status, 'running')
  assert.equal(f.planning.plans('dsh-planning')[0]?.tasks[0]?.status, 'running')
  await f.call('coordination_plan', { action: 'task', id: createdPlan.plan.id, task: 'task-write', status: 'done' })
  const finished = await f.call<{ plan: Plan }>('coordination_plan', { action: 'transition', id: createdPlan.plan.id, status: 'done' })
  assert.equal(finished.plan.status, 'done')
  const completed = await f.call<{ mission: Mission }>('coordination_mission', { action: 'complete', id: created.mission.id })
  assert.equal(completed.mission.status, 'done')

  const missions = await f.call<{ missions: Mission[] }>('coordination_mission')
  const goals = await f.call<{ goals: GoalLifecycle[] }>('coordination_goal')
  const plans = await f.call<{ plans: Plan[] }>('coordination_plan')
  assert.deepEqual(missions.missions, [completed.mission])
  assert.equal(goals.goals[0]?.state, 'achieved')
  assert.deepEqual(plans.plans, [finished.plan])
  assert.deepEqual(await f.call('coordination_mission', { action: 'activate' }), { session: 'dsh-planning', mission: null })
})

test('goal creation/transitions and mission abandonment dispatch to durable core state', async t => {
  const f = fixture()
  t.after(() => f.close())
  const created = await f.call<{ goal: GoalLifecycle }>('coordination_goal', { action: 'create', goal: goal('standalone-goal') })
  assert.equal(created.goal.state, 'proposed')
  await f.call('coordination_goal', { action: 'transition', id: created.goal.goal.id, state: 'committed' })
  const abandoned = await f.call<{ goal: GoalLifecycle }>('coordination_goal', { action: 'transition', id: created.goal.goal.id, state: 'abandoned' })
  assert.equal(abandoned.goal.state, 'abandoned')
  assert.equal(f.planning.goals('dsh-planning')[0]?.state, 'abandoned')
  const queued = await f.call<{ mission: Mission }>('coordination_mission', { action: 'create', goal: goal('mission-abandon') })
  const settled = await f.call<{ mission: Mission }>('coordination_mission', { action: 'abandon', id: queued.mission.id })
  assert.equal(settled.mission.status, 'abandoned')
  assert.equal(f.planning.goals('dsh-planning').find(item => item.goal.id === 'mission-abandon')?.state, 'abandoned')
})

test('planning tools infer the calling session, accept an explicit handle and keep sessions isolated', async t => {
  const f = fixture()
  t.after(() => f.close())
  const inferred = await f.call<{ session: string }>('coordination_goal', { action: 'create', goal: goal('inferred-goal') }, { agent: { id: '  dsh-planning  ' } })
  assert.equal(inferred.session, 'dsh-planning')
  const explicit = await f.call<{ session: string }>('coordination_goal', { session: '  coordination-session  ', action: 'create', goal: goal('explicit-goal') })
  assert.equal(explicit.session, 'coordination-session')
  assert.deepEqual(f.planning.goals('dsh-planning').map(item => item.goal.id), ['inferred-goal'])
  assert.deepEqual(f.planning.goals('coordination-session').map(item => item.goal.id), ['explicit-goal'])
  await assert.rejects(async () => f.tool('coordination_goal').execute({}), InvalidArgumentError)
  await assert.rejects(async () => f.tool('coordination_goal').execute({ session: '' }), InvalidArgumentError)
})

test('malformed nested artifacts and action arguments fail before planning methods run', async t => {
  const f = fixture()
  t.after(() => f.close())
  const putGoal = t.mock.method(f.planning, 'putGoal')
  const putPlan = t.mock.method(f.planning, 'putPlan')
  const updateTask = t.mock.method(f.planning, 'updateTask')
  const transitionPlan = t.mock.method(f.planning, 'transitionPlan')
  const createMission = t.mock.method(f.planning, 'createMission')
  const cases: Array<[typeof planningNames[number], Record<string, unknown>, RegExp]> = [
    ['coordination_goal', { action: 'create', goal: JSON.stringify(goal()) }, /arguments.goal must be a JSON object/],
    ['coordination_goal', { action: 'create', goal: { ...goal(), success: [] } }, /arguments.goal.success/],
    ['coordination_goal', { action: 'create', goal: { ...goal(), value: NaN } }, /arguments.goal.value/],
    ['coordination_goal', { action: 'create', goal: { ...goal(), success: [{ id: 'criterion', statement: 'Success' }] } }, /arguments.goal.success\[0\] requires check/],
    ['coordination_goal', { action: 'create', goal: { ...goal(), deadline: '2026-02-31T00:00:00Z' } }, /arguments.goal.deadline/],
    ['coordination_goal', { action: 'create', goal: { ...goal(), unknown: true } }, /unknown field unknown/],
    ['coordination_plan', { action: 'create', plan: { ...plan('goal'), tasks: [{ ...plan('goal').tasks[0], expect: { observation: 'Exists' } }] } }, /arguments.plan.tasks\[0\].expect requires check/],
    ['coordination_plan', { action: 'create', plan: { ...plan('goal'), budget: { tokens: -1 } } }, /arguments.plan.budget.tokens/],
    ['coordination_plan', { action: 'create', plan: { ...plan('goal'), edges: [['task-write']] } }, /arguments.plan.edges\[0\]/],
    ['coordination_plan', { action: 'transition', id: 'plan', status: 'running' }, /status must be one of/],
    ['coordination_plan', { action: 'task', id: 'plan', task: 'task-write', status: 'executing' }, /status must be one of/],
    ['coordination_plan', { action: 'task', id: 'plan', status: 'running' }, /task is required/],
    ['coordination_mission', { action: 'create' }, /goal is required/],
    ['coordination_mission', { action: 'activate', id: 'mission' }, /id is not accepted/],
    ['coordination_mission', { action: 'delete' }, /arguments.action/],
  ]
  for (const [name, args, expected] of cases) {
    await assert.rejects(() => f.call(name, args), error => error instanceof InvalidArgumentError && expected.test(error.message), `${name}: ${JSON.stringify(args)}`)
  }
  for (const mock of [putGoal, putPlan, updateTask, transitionPlan, createMission]) assert.equal(mock.mock.callCount(), 0)
  assert.equal(f.db.count('amp_planning_goal'), 0)
  assert.equal(f.db.count('amp_planning_plan'), 0)
  assert.equal(f.db.count('amp_mission'), 0)
})

test('planning JSON output honors the live tools.maxResultBytes budget', async t => {
  const f = fixture()
  t.after(() => f.close())
  await f.call('coordination_goal', { action: 'create', goal: { ...goal(), statement: 'Observable success '.repeat(200) } })
  const definition = f.tool('coordination_goal')
  const value = await f.call<{ goals: GoalLifecycle[] }>('coordination_goal')
  const full = definition.output.render({}, value)[0]!
  assert.equal(full.type, 'text')
  assert.deepEqual(JSON.parse(full.text), value)

  // Changing the existing service config must affect an already-created tool.
  f.host.config.tools.maxResultBytes = 300
  const capped = definition.output.render({}, value)[0]!
  const envelope = JSON.parse(capped.text) as { truncated: boolean; marker: string; originalBytes: number }
  assert.equal(envelope.truncated, true)
  assert.equal(envelope.marker, TOOL_RESULT_MARKER)
  assert.equal(envelope.originalBytes, Buffer.byteLength(full.text, 'utf8'))
  assert.ok(Buffer.byteLength(capped.text, 'utf8') <= 300)
  assert.equal(f.planning.goals('dsh-planning')[0]?.goal.statement, value.goals[0]?.goal.statement, 'render truncation leaves persisted artifacts intact')
})
