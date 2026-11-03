/** Model-facing AMP collaboration tool; session identity comes only from DSH execution context. */
import { InvalidArgumentError } from '../shared/error.js'
import type { Locale } from '../shared/i18n.js'
import type { DutyInput, DutyStatus } from './ampCollaboration.js'
import { listNativeSubagents } from './ampSubagents.js'
import type {
  CoordinationToolDefinition,
  CoordinationToolService,
  CoordinationToolTextBlock,
  ToolExecution,
} from './tools.js'

export type CoordinationCollaborationToolName = 'coordination_collaboration'

type Schema = Record<string, unknown>
const text: Schema = { type: 'string', minLength: 1, maxLength: 4096, pattern: '\\S' }
const array = (items: Schema): Schema => ({ type: 'array', items, minItems: 1, maxItems: 32 })
const id: Schema = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9._:-]{0,63}$' }
const choices = (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] })
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}),
})
const actions = ['list', 'agents', 'assign', 'accept', 'start', 'submit', 'verify', 'reject', 'cancel'] as const
const statuses: Readonly<Record<string, DutyStatus>> = {
  accept: 'accepted', start: 'working', submit: 'submitted', verify: 'verified', reject: 'rejected', cancel: 'cancelled',
}
const role = choices(['decision', 'outcome', 'resource', 'personnel', 'qualification', 'execution'])
/**
 * Duty assignment body.
 *
 * Kept strict (the tool rejects an unknown field before any service call); the
 * optional goal/plan/task links reuse the id schema, so this stays compact.
 */
const duty = object({
  id, assigneeSession: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' }, role,
  responsibilities: array(text), acceptance: array(text), goal: id, plan: id, task: id,
}, ['id', 'assigneeSession', 'role', 'responsibilities', 'acceptance'])
const COPY = {
  'en-US': {
    description: 'List duties visible to the calling session, list its current descendant agents, assign a duty, or advance its lifecycle. Actor identity is taken from DSH execution context.',
    action: 'Operation; defaults to list.', id: 'Duty AMP ID.', duty: 'Duty assignment details. The owner is the calling session.',
    summary: 'Nonempty submission summary, up to 4096 characters.', evidence: 'Evidence references or observations, 1-32 entries.', review: 'Nonempty owner review, up to 4096 characters.',
  },
  'zh-CN': {
    description: '列出当前调用会话可见的职责、列出其当前后代代理、分配职责或推进其生命周期。操作者身份仅取自 DSH 执行上下文。',
    action: '操作；默认 list。', id: '职责 AMP ID。', duty: '职责分配内容；所有者为当前调用会话。',
    summary: '非空提交摘要，最多 4096 个字符。', evidence: '证据引用或观察，1-32 项。', review: '非空所有者评审，最多 4096 个字符。',
  },
} as const

type Dependencies = { render(value: unknown): CoordinationToolTextBlock[] }

export function coordinationCollaborationToolDefinitions(
  service: CoordinationToolService,
  locale: Locale,
  dependencies: Dependencies,
): CoordinationToolDefinition[] {
  const collaboration = service.collaboration
  if (collaboration === undefined) return []
  const copy = COPY[locale]
  const described = (schema: Schema, description: string): Schema => ({ ...schema, description })
  const action: Schema = described({ ...choices(actions), default: 'list' }, copy.action)
  /**
   * Wire shape of the duty body. The strict `duty` schema below is what
   * `execute` validates against; the declaration ships a one-line description
   * so the catalog does not re-send the nested Duty JSON every request.
   */
  const dutyWire: Schema = { type: 'object', additionalProperties: true, description: copy.duty }
  const parameters = object({
    action,
    id: described(id, copy.id),
    duty: described(duty, copy.duty),
    summary: described(text, copy.summary), evidence: described(array(text), copy.evidence),
    review: described(text, copy.review),
  })
  const wireParameters = object({
    action,
    id: described(id, copy.id),
    duty: dutyWire,
    summary: described(text, copy.summary), evidence: described(array(text), copy.evidence),
    review: described(text, copy.review),
  })
  return [{
    name: 'coordination_collaboration',
    description: copy.description,
    parameters: wireParameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => dependencies.render(value) },
    async execute(rawArgs, exec) {
      validate(rawArgs, parameters, 'arguments')
      const action = (rawArgs.action ?? 'list') as string
      const actor = actorSession(exec)
      const allowed: Record<string, string[]> = {
        list: [], agents: [], assign: ['duty'], accept: ['id'], start: ['id'], submit: ['id', 'summary', 'evidence'],
        verify: ['id', 'review'], reject: ['id', 'review'], cancel: ['id'],
      }
      fields(rawArgs, allowed[action]!)
      if (action === 'list') return { duties: collaboration.view(actor) }
      if (action === 'agents') return listNativeSubagents(service.nativeSubagents, actor, true, exec?.signal)
      if (action === 'assign') {
        const input = rawArgs.duty as unknown as DutyInput
        if (input.task !== undefined && input.plan === undefined) throw new InvalidArgumentError('task reference requires its plan')
        const roster = await listNativeSubagents(service.nativeSubagents, actor, true, exec?.signal)
        if (!roster.available) throw new InvalidArgumentError('native subagent roster is required to bind a duty to a verified child session')
        if (!roster.agents.some(agent => agent.id === input.assigneeSession)) {
          throw new InvalidArgumentError('assigneeSession must identify a child in this caller session native subagent tree')
        }
        service.session?.ensure(input.assigneeSession)
        return { duty: collaboration.assign(actor, input) }
      }
      const status = statuses[action]!
      const transitionInput = action === 'submit'
        ? { summary: rawArgs.summary as string, evidence: rawArgs.evidence as string[] }
        : action === 'verify' || action === 'reject' ? { review: rawArgs.review as string } : {}
      return { duty: collaboration.transition(actor, rawArgs.id as string, status, transitionInput) }
    },
  }]
}

function actorSession(exec: ToolExecution | undefined): string {
  const actor = exec?.agent?.id
  if (typeof actor !== 'string' || actor.trim().length === 0) throw new InvalidArgumentError('calling DSH session context is required')
  return actor
}

function fields(args: Record<string, unknown>, required: string[]): void {
  for (const field of required) if (!Object.hasOwn(args, field)) throw new InvalidArgumentError(`${field} is required for this action`)
  for (const field of Object.keys(args)) {
    if (field !== 'action' && !required.includes(field)) throw new InvalidArgumentError(`${field} is not accepted for this action`)
  }
}

function validate(value: unknown, schema: Schema, path: string): void {
  const fail = (reason: string): never => { throw new InvalidArgumentError(`${path} ${reason}`) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('must be a JSON object')
  const record = value as Record<string, unknown>
  const properties = (schema.properties ?? {}) as Record<string, Schema>
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(properties, key)) {
      // A permissive duty body is validated by `collaboration.assign()`.
      if (schema.additionalProperties !== true) fail(`contains unknown field ${key}`)
      continue
    }
    validateValue(record[key], properties[key]!, `${path}.${key}`)
  }
  for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(record, key)) fail(`requires ${key}`)
  if (record.action !== undefined && !(actions as readonly unknown[]).includes(record.action)) fail('action must be one of the supported operations')
}

function validateValue(value: unknown, schema: Schema, path: string): void {
  const fail = (reason: string): never => { throw new InvalidArgumentError(`${path} ${reason}`) }
  if (schema.type === 'object') {
    validate(value, schema, path)
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('must be an array')
    const values = value as unknown[]
    if (values.length < (schema.minItems as number) || values.length > (schema.maxItems as number)) fail('has an invalid number of items')
    for (let index = 0; index < values.length; index += 1) validateValue(values[index], schema.items as Schema, `${path}[${index}]`)
    return
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < ((schema.minLength as number | undefined) ?? 0) || value.length > ((schema.maxLength as number | undefined) ?? Infinity) || (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))) fail('must be a valid bounded string')
    if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) fail(`must be one of ${(schema.enum as unknown[]).join(', ')}`)
  }
}
