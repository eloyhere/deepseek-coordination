/** Optional model-facing AMP planning surface; no host runtime dependency. */
import type { Goal, Plan, PlanTask } from 'attention-manifest-protocol/goal/plan.js'
import type { GoalState } from 'attention-manifest-protocol/goal'
import { InvalidArgumentError } from '../shared/error.js'
import type { Locale } from '../shared/i18n.js'
import type { AmpPlanning } from './ampPlanning.js'
import type {
  CoordinationToolDefinition,
  CoordinationToolService,
  CoordinationToolTextBlock,
  ToolExecution,
} from './tools.js'

export type CoordinationPlanningToolName = 'coordination_mission' | 'coordination_goal' | 'coordination_plan'

type Schema = Record<string, unknown>
const nonempty: Schema = { type: 'string', minLength: 1, pattern: '\\S' }
const choices = (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] })
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}),
})
const text: Schema = { type: 'string' }
const id: Schema = { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,63}$' }
const timestamp: Schema = { type: 'string', format: 'date-time' }
const array = (items: Schema, minItems = 0, maxItems?: number): Schema => ({
  type: 'array', items, minItems, ...(maxItems === undefined ? {} : { maxItems }),
})
const integer = (minimum: number, maximum?: number): Schema => ({
  type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }),
})
const criterion = object({ id, statement: nonempty, check: nonempty, kind: choices(['observe', 'query', 'assert']) }, ['id', 'statement', 'check'])
/**
 * A reference without the 30-value `kind` enum.
 *
 * The enum was serialized once per reference slot (goal, process, warrant and
 * task ref), which alone cost ~1.8k characters on the plan tool. The kind is
 * still validated: AMP's own validators reject an unknown reference at
 * execution time, so the wire keeps a plain string instead of the vocabulary.
 */
const reference = object({ kind: nonempty, id, label: text }, ['kind', 'id'])
const budget = object({ tokens: integer(0), ms: integer(0), calls: integer(0), interrupts: integer(0), money: { type: 'number', minimum: 0 } })
const goalSchema = object({
  amp: { type: 'string', const: '0.1' }, kind: { type: 'string', const: 'goal' }, id,
  statement: nonempty, success: array(criterion, 1), value: { type: 'number', minimum: 0, maximum: 1 },
  priority: integer(0), deadline: timestamp, horizon: choices(['task', 'session', 'long']),
}, ['amp', 'kind', 'id', 'statement', 'success', 'value', 'priority'])
const taskStatuses: readonly PlanTask['status'][] = ['pending', 'running', 'done', 'failed', 'skipped']
const planStatuses: readonly Plan['status'][] = ['draft', 'committed', 'executing', 'done', 'abandoned']
const goalStates: readonly GoalState[] = ['proposed', 'committed', 'active', 'achieved', 'abandoned']
const taskSchema = object({
  id, intent: nonempty, actor: choices(['self', 'tool', 'other']), ref: reference, pre: array(text),
  expect: object({ observation: nonempty, check: nonempty }, ['observation', 'check']),
  irreversibility: integer(0, 3), budget, status: choices(taskStatuses),
}, ['id', 'intent', 'actor', 'pre', 'expect', 'irreversibility', 'status'])
const planSchema = object({
  amp: { type: 'string', const: '0.1' }, kind: { type: 'string', const: 'plan' }, id,
  goal: reference, process: reference, tasks: array(taskSchema, 1, 12), edges: array(array(id, 2, 2)),
  commitment_window: integer(1, 5), budget, abandon_if: array(criterion, 1),
  monitor: object({ triggers: array(object({
    when: nonempty, action: choices(['retry', 'adjust', 'recompose', 'replan', 'abandon']),
  }, ['when', 'action'])) }),
  rollback: text, warrant: reference, status: choices(planStatuses), created: timestamp,
}, ['amp', 'kind', 'id', 'goal', 'tasks', 'edges', 'commitment_window', 'budget', 'abandon_if', 'status', 'created'])

/** These are deliberately local: adding planning does not change shared copy tables. */
const COPY = {
  'en-US': {
    mission: 'List, create, activate, complete or abandon session missions. Creation takes an AMP Goal object; activation selects the next queued mission. Action defaults to list.',
    goal: 'List or create AMP goal lifecycles, or transition a goal state. Creation takes an AMP Goal object. Action defaults to list.',
    plan: 'List or create AMP plans, transition a plan, or update one task status. Creation takes an AMP Plan object. Action defaults to list.',
    session: 'DSH session ID or coordination session handle; defaults to the calling session.',
    action: 'Operation to perform; defaults to list.',
    id: 'Mission, goal or plan ID for the selected operation.',
    goalArtifact: 'Complete AMP Goal object (amp 0.1, kind goal), with observable success criteria.',
    planArtifact: 'Complete AMP Plan object (amp 0.1, kind plan), with tasks, expected observations, budget and abandonment criteria.',
    state: 'Target AMP goal lifecycle state.', status: 'Target plan status (transition) or task status (task).',
    task: 'Task ID within the plan identified by id.',
  },
  'zh-CN': {
    mission: '列出、创建、激活、完成或放弃会话任务使命。创建时传入 AMP Goal 对象；激活时选择下一条排队使命。action 默认 list。',
    goal: '列出或创建 AMP 目标生命周期，或转换目标状态。创建时传入 AMP Goal 对象。action 默认 list。',
    plan: '列出或创建 AMP 计划、转换计划状态，或更新单个任务状态。创建时传入 AMP Plan 对象。action 默认 list。',
    session: 'DSH 会话 ID 或 coordination 会话 handle；省略时使用当前调用会话。',
    action: '要执行的操作；默认 list。', id: '当前操作的使命、目标或计划 ID。',
    goalArtifact: '完整的 AMP Goal 对象（amp 0.1、kind goal），包含可观察的成功标准。',
    planArtifact: '完整的 AMP Plan 对象（amp 0.1、kind plan），包含任务、预期观察、预算与放弃标准。',
    state: '目标 AMP 生命周期状态。', status: '计划目标状态（transition）或任务目标状态（task）。',
    task: '由 id 指定的计划内的任务 ID。',
  },
} as const

type Dependencies = {
  resolveSession(args: Record<string, unknown>, exec: ToolExecution | undefined): string
  render(value: unknown): CoordinationToolTextBlock[]
}

export function coordinationPlanningToolDefinitions(
  service: CoordinationToolService,
  locale: Locale,
  dependencies: Dependencies,
): CoordinationToolDefinition[] {
  const planning = service.planning
  if (planning === undefined) return []
  const copy = COPY[locale]
  const described = (schema: Schema, description: string): Schema => ({ ...schema, description })
  /**
   * Wire shape of an AMP Goal/Plan argument.
   *
   * The complete schema stays local and is what `execute` validates against;
   * the tool declaration ships this one-line object instead. The nested Plan
   * schema alone was ~5.6k characters re-sent on every request, so the catalog
   * pays for a description while the host keeps the exact same validation and
   * error messages.
   */
  const artifact = (description: string): Schema => ({ type: 'object', additionalProperties: true, description })
  const common = {
    session: described(nonempty, copy.session),
    id: described(nonempty, copy.id),
  }
  const definition = (
    name: CoordinationPlanningToolName,
    description: string,
    actions: readonly string[],
    properties: Record<string, Schema>,
    execute: (args: Record<string, unknown>, action: string, session: string, planning: AmpPlanning) => unknown,
    validationProperties: Record<string, Schema> = properties,
  ): CoordinationToolDefinition => {
    const action = described({ ...choices(actions), default: 'list' }, copy.action)
    const parameters = object({ ...common, action, ...properties })
    const validation = object({ ...common, action, ...validationProperties })
    return {
      name, description, parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => dependencies.render(value) },
      execute(rawArgs, exec) {
        validate(rawArgs, validation, 'arguments')
        const selected = (rawArgs.action ?? 'list') as string
        const session = dependencies.resolveSession(rawArgs, exec)
        return execute(rawArgs, selected, session, planning)
      },
    }
  }
  return [
    definition('coordination_mission', copy.mission, ['list', 'create', 'activate', 'complete', 'abandon'], {
      goal: artifact(copy.goalArtifact),
    }, (args, action, session, api) => {
      fields(args, action === 'create' ? ['goal'] : action === 'complete' || action === 'abandon' ? ['id'] : [])
      if (action === 'list') return { session, missions: api.missions(session) }
      if (action === 'create') return { session, mission: api.createMission(session, args.goal as unknown as Goal) }
      if (action === 'activate') return { session, mission: api.activateNext(session) ?? null }
      return { session, mission: api.settleMission(session, args.id as string, action === 'complete' ? 'done' : 'abandoned') }
    }, { goal: described(goalSchema, copy.goalArtifact) }),
    definition('coordination_goal', copy.goal, ['list', 'create', 'transition'], {
      goal: artifact(copy.goalArtifact), state: described(choices(goalStates), copy.state),
    }, (args, action, session, api) => {
      fields(args, action === 'create' ? ['goal'] : action === 'transition' ? ['id', 'state'] : [])
      if (action === 'list') return { session, goals: api.goals(session) }
      if (action === 'create') return { session, goal: api.putGoal(session, args.goal as unknown as Goal) }
      return { session, goal: api.transitionGoal(session, args.id as string, args.state as GoalState) }
    }, { goal: described(goalSchema, copy.goalArtifact), state: described(choices(goalStates), copy.state) }),
    definition('coordination_plan', copy.plan, ['list', 'create', 'transition', 'task'], {
      plan: artifact(copy.planArtifact), task: described(nonempty, copy.task),
      status: described(choices([...new Set([...planStatuses, ...taskStatuses])]), copy.status),
    }, (args, action, session, api) => {
      fields(args, action === 'create' ? ['plan'] : action === 'transition' ? ['id', 'status'] : action === 'task' ? ['id', 'task', 'status'] : [])
      if (action === 'list') return { session, plans: api.plans(session) }
      if (action === 'create') return { session, plan: api.putPlan(session, args.plan as unknown as Plan) }
      validate(args.status, choices(action === 'task' ? taskStatuses : planStatuses), 'status')
      return { session, plan: action === 'task'
        ? api.updateTask(session, args.id as string, args.task as string, args.status as PlanTask['status'])
        : api.transitionPlan(session, args.id as string, args.status as Plan['status']) }
    }, {
      plan: described(planSchema, copy.planArtifact), task: described(nonempty, copy.task),
      status: described(choices([...new Set([...planStatuses, ...taskStatuses])]), copy.status),
    }),
  ]
}

/** Enforce action-specific required and allowed fields before any service call. */
function fields(args: Record<string, unknown>, required: string[]): void {
  for (const field of required) {
    if (!Object.hasOwn(args, field)) throw new InvalidArgumentError(`${field} is required for this action`)
  }
  for (const field of Object.keys(args)) {
    if (field !== 'action' && field !== 'session' && !required.includes(field)) {
      throw new InvalidArgumentError(`${field} is not accepted for this action`)
    }
  }
}

/** Validate the closed, self-contained JSON schema subset authored above. */
function validate(value: unknown, schema: Schema, path: string): void {
  const fail = (reason: string): never => { throw new InvalidArgumentError(`${path} ${reason}`) }
  if ('const' in schema && value !== schema.const) fail(`must equal ${String(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`)
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('must be a JSON object')
      const record = value as Record<string, unknown>
      const properties = (schema.properties ?? {}) as Record<string, Schema>
      for (const key of (schema.required ?? []) as string[]) {
        if (!Object.hasOwn(record, key)) fail(`requires ${key}`)
      }
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) {
          // A permissive artifact (AMP Goal/Plan) is validated by AMP itself, so
          // its nested fields are not described or rejected here.
          if (schema.additionalProperties !== true) fail(`contains unknown field ${key}`)
          continue
        }
        validate(record[key], properties[key]!, `${path}.${key}`)
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) fail('must be an array')
      const values = value as unknown[]
      if (typeof schema.minItems === 'number' && values.length < schema.minItems) fail(`must have at least ${schema.minItems} items`)
      if (typeof schema.maxItems === 'number' && values.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`)
      for (let index = 0; index < values.length; index += 1) validate(values[index], schema.items as Schema, `${path}[${index}]`)
      break
    }
    case 'string': {
      if (typeof value !== 'string') fail('must be a string')
      const string = value as string
      if (typeof schema.minLength === 'number' && string.length < schema.minLength) fail('must not be empty')
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(string)) fail('has an invalid format')
      if (schema.format === 'date-time') {
        const parsed = Date.parse(string)
        if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(string) || !Number.isFinite(parsed)) {
          fail('must be an RFC 3339 timestamp with a timezone')
        }
        // Date.parse normalizes dates such as February 31; reject those too.
        const day = string.slice(0, 10)
        if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fail('must name a valid calendar date')
      }
      break
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('must be a finite number')
      const number = value as number
      if (schema.type === 'integer' && !Number.isSafeInteger(number)) fail('must be a safe integer')
      if (typeof schema.minimum === 'number' && number < schema.minimum) fail(`must be at least ${schema.minimum}`)
      if (typeof schema.maximum === 'number' && number > schema.maximum) fail(`must be at most ${schema.maximum}`)
      break
    }
  }
}
