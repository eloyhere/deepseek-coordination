/**
 * Agent tools for the two new control surfaces.
 *
 * `coordination_control` exposes the AMP 0.5.0 scoped-control contract —
 * registry metadata and the interaction/scenario settings, across the
 * `global → workspace → session` chain, with CAS versions and `dryRun`.
 *
 * `coordination_knowledge` lets the agent declare that a file is knowledge (or
 * retitle, retag and unmark it) instead of inferring it from a path.
 *
 * `coordination_environment` is the same scoped-control store narrowed to the
 * `environments` registry, so the model can manage one environment per call
 * without hand-building a registry payload.
 *
 * All three tools call the same service methods the HTTP routes and the panel
 * call, so there is exactly one implementation of each operation. Invalid input
 * never throws: it returns `{ error: { code, message } }`, which is part of the
 * declared output schema.
 */
import type { CoordinationToolDefinition, CoordinationToolService, ToolExecution } from './tools.js'
import { createToolWorkspaceRootResolver, toolResultMaxBytes, type CoordinationToolTextBlock } from './tools.js'
import type { ControlService } from './control.js'
import type { KnowledgeService } from './knowledge.js'
import { CONTROL_REGISTRIES } from '../shared/control.js'
import type {
  ControlDomain,
  ControlRegistry,
  ControlRegistryAction,
  ControlScope,
} from '../shared/control.js'
import { ENVIRONMENT_ID, discoverEnvironment, mergeDiscovered, seedEnvironment } from './environment.js'

/** The host surface these tools need; `CoordinationService` satisfies it. */
export interface ControlToolService extends CoordinationToolService {
  readonly control: ControlService
  readonly knowledge: KnowledgeService
}

export type ControlToolName = 'coordination_control' | 'coordination_knowledge' | 'coordination_environment'

/** One typed failure, mirroring the graph tools' envelope. */
export interface ControlToolError {
  error: { code: 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'INVALID_STATE'; message: string }
}

const ERROR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: { code: { type: 'string' }, message: { type: 'string' } },
}

/** Every successful shape these tools return, closed for the model. */
const CONTROL_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    scope: { type: 'string' },
    registry: { type: 'string' },
    domain: { type: 'string' },
    id: { type: 'string' },
    key: { type: 'string' },
    version: { type: 'number' },
    effectiveVersion: { type: 'number' },
    source: { type: 'string' },
    dryRun: { type: 'boolean' },
    changed: { type: 'number' },
    created: { type: 'number' },
    updated: { type: 'number' },
    enabled: { type: 'boolean' },
    deleted: { type: 'boolean' },
    value: {},
    mix: {},
    effectiveMix: {},
    plan: { type: 'array', items: { type: 'object' } },
    records: { type: 'array', items: { type: 'object' } },
    links: { type: 'array', items: { type: 'object' } },
    error: ERROR_SCHEMA,
  },
}

const KNOWLEDGE_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    entries: { type: 'array', items: { type: 'object' } },
    entry: { type: 'object' },
    path: { type: 'string' },
    truncated: { type: 'boolean' },
    error: ERROR_SCHEMA,
  },
}

/**
 * Every successful shape `coordination_environment` returns.
 *
 * `list` wraps the effective records in one object (a bare array cannot be a
 * closed object root), while `get` returns one `ControlRecordView` and the
 * mutations return the control service's `ControlMutationResult`. The union of
 * those fields lives here; no field is required so the typed failure envelope
 * shares the same schema.
 */
const ENVIRONMENT_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    scope: { type: 'string' },
    registry: { type: 'string' },
    id: { type: 'string' },
    version: { type: 'number' },
    effectiveVersion: { type: 'number' },
    source: { type: 'string' },
    dryRun: { type: 'boolean' },
    changed: { type: 'number' },
    enabled: { type: 'boolean' },
    deleted: { type: 'boolean' },
    created: { type: 'number' },
    updated: { type: 'number' },
    value: {},
    records: { type: 'array', items: { type: 'object' } },
    error: ERROR_SCHEMA,
  },
}

/** Map one thrown domain error onto the declared failure shape. */
function failure(error: unknown): ControlToolError {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : 'control call failed'
  if (code === 'INVALID_ARGUMENT' || code === 'NOT_FOUND' || code === 'INVALID_STATE') {
    return { error: { code, message } }
  }
  return { error: { code: 'INVALID_ARGUMENT', message } }
}

function textBlocks(value: unknown, service: CoordinationToolService): CoordinationToolTextBlock[] {
  const text = JSON.stringify(value, null, 2)
  const max = toolResultMaxBytes(service)
  return [{ type: 'text', text: max > 0 && text.length > max ? text.slice(0, max) : text }]
}

function asArguments(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new Error(`${name} must be a non-empty string`), { code: 'INVALID_ARGUMENT' })
  }
  return value.trim()
}

function optionalInteger(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw Object.assign(new Error(`${name} must be a non-negative integer`), { code: 'INVALID_ARGUMENT' })
  }
  return value
}

function scopeOf(args: Record<string, unknown>, fallback: ControlScope): ControlScope {
  const value = args.scope
  if (value === undefined || value === null) return fallback
  if (value === 'global' || value === 'workspace' || value === 'session') return value
  throw Object.assign(new Error('scope must be global, workspace or session'), { code: 'INVALID_ARGUMENT' })
}

function registryOf(value: unknown): ControlRegistry {
  if (typeof value === 'string' && (CONTROL_REGISTRIES as readonly string[]).includes(value)) {
    return value as ControlRegistry
  }
  throw Object.assign(
    new Error(`registry must be one of: ${CONTROL_REGISTRIES.join(', ')}`),
    { code: 'INVALID_ARGUMENT' },
  )
}

function actionOf(value: unknown): ControlRegistryAction {
  if (typeof value === 'string' && [
    'list', 'get', 'register', 'update', 'remove', 'enable', 'disable',
    'default_get', 'default_set', 'default_reset', 'link', 'unlink',
  ].includes(value)) return value as ControlRegistryAction
  throw Object.assign(new Error('unknown registry action'), { code: 'INVALID_ARGUMENT' })
}

function domainOf(value: unknown): ControlDomain {
  if (value === 'interaction' || value === 'scenario') return value
  throw Object.assign(new Error('domain must be interaction or scenario'), { code: 'INVALID_ARGUMENT' })
}

/** The environment tool's narrower action vocabulary. */
const ENVIRONMENT_ACTIONS = ['list', 'get', 'set', 'refresh', 'remove', 'enable', 'disable'] as const
type EnvironmentAction = (typeof ENVIRONMENT_ACTIONS)[number]

function environmentActionOf(value: unknown): EnvironmentAction {
  if (typeof value === 'string' && (ENVIRONMENT_ACTIONS as readonly string[]).includes(value)) {
    return value as EnvironmentAction
  }
  throw Object.assign(
    new Error(`action must be one of: ${ENVIRONMENT_ACTIONS.join(', ')}`),
    { code: 'INVALID_ARGUMENT' },
  )
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw Object.assign(new Error(`${name} must be a boolean`), { code: 'INVALID_ARGUMENT' })
  }
  return value
}

/**
 * Read an environment's variable map.
 *
 * A variable is a name → string pair; anything else (numbers, nested objects,
 * arrays) is refused here, before a registry row is written.
 */
function environmentVariablesOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('variables must be an object of string values'), { code: 'INVALID_ARGUMENT' })
  }
  const variables: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw Object.assign(
        new Error(`variables.${name} must be a string`),
        { code: 'INVALID_ARGUMENT' },
      )
    }
    variables[name] = entry
  }
  return variables
}

/**
 * The three tool definitions.
 *
 * The workspace root is resolved through the same request-scoped resolver the
 * graph tools use, so a control call acts on the workspace the session is
 * actually in rather than on `process.cwd()`.
 */
export function coordinationControlTools(
  service: ControlToolService,
): Array<CoordinationToolDefinition<unknown>> {
  const identityOf = async (exec?: ToolExecution): Promise<{ workspace: string; session: string }> => {
    const session = exec?.agent?.id ?? ''
    // Prefer the calling session's workspace. A session the host cannot map yet
    // (a fresh child, or a test fixture) must not disable control entirely: the
    // resolver's own fallback chain then supplies the workspace root.
    try {
      const workspace = await createToolWorkspaceRootResolver(service, {}, {
        ...(session.length === 0 ? {} : { session }),
      }).resolve()
      return { workspace, session }
    } catch {
      const workspace = await createToolWorkspaceRootResolver(service, {}, {}).resolve()
      return { workspace, session }
    }
  }

  const control: CoordinationToolDefinition<unknown> = {
    name: 'coordination_control',
    description: [
      'Scoped control for registry metadata and interaction/scenario settings over global → workspace → session.',
      'Use registry + action (list/get/register/update/remove/default_*/link/unlink) or domain + action (get/set/reset); writes accept expectedVersion and dryRun.',
      'Only JSON metadata is stored.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['global', 'workspace', 'session'], description: 'Control scope; defaults to workspace.' },
        registry: { type: 'string', enum: [...CONTROL_REGISTRIES], description: 'Registry to address.' },
        action: {
          type: 'string',
          enum: ['list', 'get', 'register', 'update', 'remove', 'enable', 'disable', 'default_get', 'default_set', 'default_reset', 'link', 'unlink', 'get_setting', 'set', 'reset'],
          description: 'Registry action, or get/set/reset for a settings domain.',
        },
        id: { type: 'string', description: 'Registry entry id.' },
        key: { type: 'string', description: 'Default key.' },
        value: { description: 'Registry value (JSON object) or default value.' },
        targetId: { type: 'string', description: 'Link target id in the same registry.' },
        relation: { type: 'string', description: 'Link relation label.' },
        domain: { type: 'string', enum: ['interaction', 'scenario'], description: 'Settings domain; when set, action must be get/set/reset.' },
        selector: { type: 'string', description: 'Single mode (interaction) or scenario (scenario) selection.' },
        mix: { type: 'object', description: 'Weighted mix of the domain keys; mutually exclusive with selector.' },
        applyTo: { type: 'string', enum: ['defaults', 'existing', 'all'], description: 'Where a global/workspace settings write lands.' },
        expectedVersion: { type: 'integer', description: 'CAS version the caller last read.' },
        dryRun: { type: 'boolean', description: 'Validate without writing.' },
      },
    },
    output: {
      schema: CONTROL_TOOL_SCHEMA,
      render: (_args, value) => textBlocks(value, service),
    },
    async execute(rawArgs, exec) {
      try {
        const args = asArguments(rawArgs)
        const identity = await identityOf(exec)
        const scope = scopeOf(args, 'workspace')
        const expectedVersion = optionalInteger(args, 'expectedVersion')
        const dryRun = args.dryRun === true
        const domain = args.domain === undefined ? undefined : domainOf(args.domain)

        if (domain !== undefined) {
          const raw = args.action
          if (raw === 'set') {
            return service.control.setSetting({
              scope,
              domain,
              action: 'set',
              ...(optionalString(args, 'selector') === undefined ? {} : { selector: optionalString(args, 'selector') }),
              ...(args.mix === undefined ? {} : { mix: args.mix }),
              ...(args.applyTo === 'defaults' || args.applyTo === 'existing' || args.applyTo === 'all'
                ? { applyTo: args.applyTo }
                : {}),
              ...(expectedVersion === undefined ? {} : { expectedVersion }),
              dryRun,
            }, identity)
          }
          if (raw === 'reset') {
            return service.control.resetSetting({
              scope,
              domain,
              action: 'reset',
              ...(args.applyTo === 'defaults' || args.applyTo === 'existing' || args.applyTo === 'all'
                ? { applyTo: args.applyTo }
                : {}),
              ...(expectedVersion === undefined ? {} : { expectedVersion }),
              dryRun,
            }, identity)
          }
          if (raw === undefined || raw === 'get' || raw === 'get_setting') {
            return service.control.getSetting(domain, scope, identity)
          }
          throw Object.assign(new Error('a settings domain accepts action get, set or reset'), { code: 'INVALID_ARGUMENT' })
        }

        const registry = registryOf(args.registry ?? 'modules')
        const action = args.action === 'get_setting' ? 'get' : actionOf(args.action ?? 'list')
        const id = optionalString(args, 'id')
        const key = optionalString(args, 'key')
        const targetId = optionalString(args, 'targetId')
        const relation = optionalString(args, 'relation')
        const result = service.control.registry({
          scope,
          registry,
          action,
          ...(id === undefined ? {} : { id }),
          ...(key === undefined ? {} : { key }),
          ...(args.value === undefined ? {} : { value: args.value }),
          ...(targetId === undefined ? {} : { targetId }),
          ...(relation === undefined ? {} : { relation }),
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          dryRun,
        }, identity)
        // `list` is the one action whose service result is an array. The tool's
        // output schema is a single object (DSH validates it), so the array is
        // wrapped in the same envelope the environment tool uses; returning a
        // bare array is what produced `"value" must be an object`.
        return Array.isArray(result)
          ? { ok: true, action, scope, registry, records: result }
          : result
      } catch (error) {
        return failure(error)
      }
    },
  }

  const environment: CoordinationToolDefinition<unknown> = {
    name: 'coordination_environment',
    description: [
      'Manage the environment registry (registry "environments") over global, workspace (default) and session scopes.',
      'Actions: list/get/set/refresh/remove/enable/disable; set upserts { name, description, variables, enabled }, variables are strings only.',
      'refresh re-discovers the host toolchain (git/node/npm/pnpm/python/java/pwsh, project root, curated variables) and merges without overwriting your edits.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['global', 'workspace', 'session'], description: 'Control scope; defaults to workspace.' },
        action: {
          type: 'string',
          enum: [...ENVIRONMENT_ACTIONS],
          description: 'Environment action; defaults to list.',
        },
        id: { type: 'string', description: 'Environment id (for example env.local).' },
        name: { type: 'string', description: 'Human name of the environment.' },
        description: { type: 'string', description: 'What the environment is for.' },
        variables: {
          type: 'object',
          additionalProperties: true,
          description: 'Environment variables; every value must be a string.',
        },
        enabled: { type: 'boolean', description: 'Whether the environment is enabled; defaults to true on register.' },
        expectedVersion: { type: 'integer', description: 'CAS version the caller last read.' },
        dryRun: { type: 'boolean', description: 'Validate without writing.' },
      },
    },
    output: {
      schema: ENVIRONMENT_TOOL_SCHEMA,
      render: (_args, value) => textBlocks(value, service),
    },
    async execute(rawArgs, exec) {
      try {
        const args = asArguments(rawArgs)
        const identity = await identityOf(exec)
        const scope = scopeOf(args, 'workspace')
        const action = environmentActionOf(args.action ?? 'list')
        const expectedVersion = optionalInteger(args, 'expectedVersion')
        const dryRun = args.dryRun === true

        if (action === 'list') {
          let records = service.control.listRegistry('environments', scope, identity)
          // Seed lazily, with the caller's own workspace key: the plugin's
          // process workspace differs from a session's, so an apply-time seed
          // would create a record this list never sees. `dryRun` stays read-only.
          if (records.length === 0 && !dryRun) {
            const target = scope === 'global' ? 'global' : 'workspace'
            if (seedEnvironment(service.control, identity.workspace, {}, target)) {
              records = service.control.listRegistry('environments', scope, identity)
            }
          }
          return {
            ok: true,
            action,
            scope,
            registry: 'environments',
            records,
          }
        }

        if (action === 'refresh') {
          // Re-discover the host environment and merge it over the record. A
          // value the user changed (one that no longer equals the previous
          // discovery) is kept, so refresh never clobbers hand edits.
          const target = optionalString(args, 'id') ?? ENVIRONMENT_ID
          const existing = service.control.getRecord('environments', target, scope, identity)
          const discovery = discoverEnvironment({ workspaceRoot: identity.workspace })
          const current = (existing?.value?.variables ?? {}) as Record<string, string>
          const previous = (existing?.value?.discovered ?? {}) as Record<string, string>
          const merged = mergeDiscovered(current, previous, discovery.variables)
          const value = {
            ...(existing?.value ?? {}),
            name: existing?.value?.name ?? discovery.name,
            description: existing?.value?.description ?? discovery.description,
            enabled: existing?.value?.enabled ?? true,
            variables: merged.variables,
            discovered: discovery.discovered,
            refreshedAt: discovery.refreshedAt,
          }
          service.control.registry({
            scope,
            registry: 'environments',
            action: existing === undefined ? 'register' : 'update',
            id: target,
            value,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
            dryRun,
          }, identity)
          return {
            ok: true,
            action,
            scope,
            id: target,
            added: merged.added,
            updated: merged.updated,
            kept: merged.kept,
            refreshedAt: discovery.refreshedAt,
          }
        }

        const id = optionalString(args, 'id')
        if (id === undefined) {
          throw Object.assign(
            new Error('id is required for get, set, remove, enable and disable'),
            { code: 'INVALID_ARGUMENT' },
          )
        }

        if (action === 'get') {
          return service.control.registry({
            scope,
            registry: 'environments',
            action,
            id,
          }, identity)
        }

        if (action === 'set') {
          // `set` is an upsert: the existence check only chooses which registry
          // action writes the row. The value is merged over the effective one so
          // a partial update (say, a new description) never drops variables.
          const existing = service.control.getRecord('environments', id, scope, identity)
          const name = optionalString(args, 'name')
          const description = optionalString(args, 'description')
          const variables = environmentVariablesOf(args.variables)
          const enabled = optionalBoolean(args, 'enabled')
          const value: Record<string, unknown> = {
            ...(existing?.value ?? {}),
            ...(name === undefined ? {} : { name }),
            ...(description === undefined ? {} : { description }),
            ...(variables === undefined ? {} : { variables }),
            ...(enabled === undefined ? {} : { enabled }),
          }
          return service.control.registry({
            scope,
            registry: 'environments',
            action: existing === undefined ? 'register' : 'update',
            id,
            value,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
            dryRun,
          }, identity)
        }

        // remove / enable / disable are the control registry's own actions.
        return service.control.registry({
          scope,
          registry: 'environments',
          action,
          id,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          dryRun,
        }, identity)
      } catch (error) {
        return failure(error)
      }
    },
  }

  const knowledge: CoordinationToolDefinition<unknown> = {
    name: 'coordination_knowledge',
    description: [
      'Declare a workspace file as knowledge (spec, design note or runbook) rather than source.',
      'Actions: list/mark/update/unmark; metadata only, no file body; workspace scope (default) is shared, session is private.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'mark', 'update', 'unmark'], description: 'Knowledge action; defaults to list.' },
        path: { type: 'string', description: 'Workspace-relative file path.' },
        title: { type: 'string', description: 'Human title for the knowledge file.' },
        note: { type: 'string', description: 'Short note on why this file is knowledge.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for grouping.' },
        scope: { type: 'string', enum: ['workspace', 'session'], description: 'Mark scope; defaults to workspace.' },
      },
    },
    output: {
      schema: KNOWLEDGE_TOOL_SCHEMA,
      render: (_args, value) => textBlocks(value, service),
    },
    async execute(rawArgs, exec) {
      try {
        const args = asArguments(rawArgs)
        const identity = await identityOf(exec)
        const scope: ControlScope = args.scope === 'session' ? 'session' : 'workspace'
        const action = args.action ?? 'list'
        if (action === 'list') {
          const entries = service.knowledge.list(identity)
          return { action: 'list', entries, truncated: false }
        }
        const path = optionalString(args, 'path')
        if (path === undefined) {
          throw Object.assign(new Error('path is required for mark, update and unmark'), { code: 'INVALID_ARGUMENT' })
        }
        if (action === 'unmark') {
          const entry = service.knowledge.unmark(path, identity, scope)
          return { action: 'unmark', entry, path: entry.path }
        }
        if (action !== 'mark' && action !== 'update') {
          throw Object.assign(new Error('action must be list, mark, update or unmark'), { code: 'INVALID_ARGUMENT' })
        }
        const entry = service.knowledge.mark(path, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.note === undefined ? {} : { note: args.note }),
          ...(args.tags === undefined ? {} : { tags: args.tags }),
        }, identity, scope)
        return { action, entry, path: entry.path }
      } catch (error) {
        return failure(error)
      }
    },
  }

  /*
   * Workspace-scoped registry adjustment.
   *
   * AMP spells the workspace variant of the registry tool
   * `amp_tool_workspace_adjust`; this is the same surface under this plugin's
   * naming. It delegates to `coordination_control` with the scope pinned to
   * `workspace`, so there is exactly one implementation of every action and no
   * way for this tool to write a global or session row.
   */
  const workspaceAdjust: CoordinationToolDefinition<unknown> = {
    name: 'coordination_workspace_adjust',
    description: [
      'Adjust this workspace\'s registries: register, update, remove, enable, disable or link entries.',
      'The scope is always the current workspace, so a global or session row can never be written through this tool.',
      'Registries: modules, environments, tools, cognition, capabilities, abilities, progress, skills, knowledge, protocols, concepts.',
      'Environments are a registry like any other here: their value carries name, description, variables and an enabled flag.',
      'Writes accept expectedVersion (CAS) and dryRun; a version mismatch returns INVALID_STATE with the current version.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['registry'],
      properties: {
        registry: { type: 'string', enum: [...CONTROL_REGISTRIES], description: 'Registry to address.' },
        action: {
          type: 'string',
          enum: ['list', 'get', 'register', 'update', 'remove', 'enable', 'disable', 'default_get', 'default_set', 'default_reset', 'link', 'unlink'],
          description: 'Registry action; defaults to list.',
        },
        id: { type: 'string', description: 'Entry id.' },
        key: { type: 'string', description: 'Default key (default_get / default_set / default_reset).' },
        value: { description: 'Entry value (a JSON object) or the default value.' },
        targetId: { type: 'string', description: 'Link target id in the same registry.' },
        relation: { type: 'string', description: 'Link relation label.' },
        expectedVersion: { type: 'integer', description: 'CAS version the caller last read.' },
        dryRun: { type: 'boolean', description: 'Validate without writing.' },
      },
    },
    output: {
      schema: CONTROL_TOOL_SCHEMA,
      render: (_args, value) => textBlocks(value, service),
    },
    async execute(rawArgs, exec) {
      // Pin the scope: any `scope` a caller passes is ignored on purpose.
      return control.execute({ ...asArguments(rawArgs), scope: 'workspace' }, exec)
    },
  }

  return [control, workspaceAdjust, environment, knowledge]
}
