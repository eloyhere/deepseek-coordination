/**
 * DSH runtime adapters and lifecycle hooks.
 *
 * This file is the only host-side place that touches the Cordis context. Every
 * module receives the narrow structural ports declared in `module.ts`, so a
 * module test can run without DSH at all.
 *
 * Lifecycle wiring (v23 §3.3): one coordination Turn per DSH turn. `agent/pre-step`
 * opens it before the model sees the messages; `agent/turn-stopping` closes it,
 * which also unlocks the composer's profession dropdown for the next turn.
 * Every callback is failure-isolated: a bug in coordination must never break
 * the agent loop.
 */
import type {
  AgentPort,
  AgentView,
  ApprovalPort,
  CompactionPort,
  GoalPort,
  LlmConfigurableProviderInfo,
  LlmModelInfo,
  LlmProviderInfo,
  LlmReadPort,
  LlmResolvedModelInfo,
  LoggerPort,
  PermissionPresetCatalog,
  PermissionPresetOption,
  PermissionPresetPort,
  SandboxPolicyPort,
  SandboxPolicyView,
  SessionPort,
  WebSearchPort,
} from './module.js'

type UnknownRecord = Record<string, unknown>

/** The ports the host plugin builds from one Cordis context. */
export interface DshRuntime {
  llm?: LlmReadPort
  goals?: GoalPort
  compaction?: CompactionPort
  web?: WebSearchPort
  agents?: AgentPort
  sessions?: SessionPort
  approval?: ApprovalPort
  permissionPresets?: PermissionPresetPort
  sandboxPolicy?: SandboxPolicyPort
  logger?: LoggerPort
  /** The live DSH session object, for ports that take it whole. */
  rawSession(id: string): unknown
  /** The live DSH agent object, for ports that take it whole. */
  rawAgent(id: string): unknown
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined
}

function asFunction(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : undefined
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Resolve one Cordis service without throwing when it is absent. */
function serviceOf(context: unknown, name: string): UnknownRecord | undefined {
  const holder = asRecord(context)
  if (holder === undefined) return undefined
  const get = asFunction(holder.get)
  if (get !== undefined) {
    try {
      const value = get.call(context, name)
      if (isRecord(value) || typeof value === 'function') return isRecord(value) ? value : { call: value }
    } catch {
      // `ctx.get` on an absent service throws in some Cordis versions.
    }
  }
  try {
    return asRecord(holder[name])
  } catch {
    // Cordis proxies throw on any service the plugin did not declare in
    // `inject` ("cannot get property ... without inject"). The ports this
    // helper resolves are optional — a DSH build that keeps the service in an
    // agent-preset context instead of the profile root simply has no value
    // here, and absence must not abort apply().
    return undefined
  }
}

function makeLogger(context: unknown): LoggerPort | undefined {
  const logger = asRecord(context)?.['logger']
  if (!isRecord(logger)) return undefined
  const record = (level: string): ((message: string, ...args: unknown[]) => void) => {
    const fn = asFunction(logger[level])
    if (fn === undefined) return () => {}
    return (message: string, ...args: unknown[]) => {
      try {
        fn.call(logger, message, ...args)
      } catch {
        // Logging must never throw into the agent loop.
      }
    }
  }
  return { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }
}

function adaptProvider(value: unknown): LlmProviderInfo {
  const record = asRecord(value) ?? {}
  const id = asString(record.id) || asString(record.provider) || asString(record.name)
  return { id, name: asString(record.name) || id }
}

function adaptConfigurableProvider(value: unknown): LlmConfigurableProviderInfo {
  const record = asRecord(value) ?? {}
  const provider = asString(record.provider) || asString(record.id)
  const settingsPath = Array.isArray(record.settingsPath)
    ? record.settingsPath.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    provider,
    displayName: asString(record.displayName) || provider,
    settingsNs: asString(record.settingsNs),
    settingsPath,
    ...(typeof record.declared === 'boolean' ? { declared: record.declared } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

function adaptModel(provider: string, value: unknown): LlmModelInfo {
  const record = asRecord(value) ?? {}
  const id = asString(record.id) || asString(record.model)
  return {
    provider: asString(record.provider) || provider,
    id,
    name: asString(record.name) || id,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(Array.isArray(record.inputModalities)
      ? { inputModalities: record.inputModalities.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  }
}

function adaptResolvedModel(provider: string, model: string, value: unknown): LlmResolvedModelInfo {
  const base = adaptModel(provider, value)
  const record = asRecord(value) ?? {}
  const context = asRecord(record.context)
  const reasoning = asRecord(record.reasoning)
  const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
  return {
    ...base,
    id: base.id || model,
    ...(context !== undefined && typeof context.contextWindow === 'number'
      ? { context: { contextWindow: context.contextWindow } }
      : {}),
    ...(typeof record.defaultMaxTokens === 'number' ? { defaultMaxTokens: record.defaultMaxTokens } : {}),
    ...(reasoning === undefined
      ? {}
      : {
          reasoning: {
            efforts: efforts
              .map((entry) => asRecord(entry))
              .filter((entry): entry is UnknownRecord => entry !== undefined)
              .map((entry) => ({
                id: asString(entry.id),
                name: asString(entry.name) || asString(entry.id),
                ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
              })),
            ...(typeof reasoning.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {}),
          },
        }),
  }
}

/** Build the read-only LLM port from `ctx.llm`. */
function makeLlmPort(context: unknown): LlmReadPort | undefined {
  const llm = serviceOf(context, 'llm')
  if (llm === undefined) return undefined
  const listProviders = asFunction(llm.listProviders)
  if (listProviders === undefined) return undefined
  return {
    listProviders: () => {
      const value = listProviders.call(llm)
      return Array.isArray(value) ? value.map(adaptProvider) : []
    },
    listConfigurableProviders: () => {
      const fn = asFunction(llm.listConfigurableProviders)
      if (fn === undefined) return []
      const value = fn.call(llm)
      return Array.isArray(value) ? value.map(adaptConfigurableProvider) : []
    },
    listModels: async (provider: string) => {
      const fn = asFunction(llm.listModels)
      if (fn === undefined) return []
      const value = await fn.call(llm, provider)
      return Array.isArray(value) ? value.map((entry) => adaptModel(provider, entry)) : []
    },
    resolveModelInfo: async (provider: string, model: string, signal?: AbortSignal) => {
      const fn = asFunction(llm.resolveModelInfo)
      if (fn === undefined) throw new Error('ctx.llm.resolveModelInfo is not available')
      const value = await fn.call(llm, provider, model, signal)
      return adaptResolvedModel(provider, model, value)
    },
  }
}

function makeAgentPort(context: unknown): { port: AgentPort; raw(id: string): unknown } | undefined {
  const agents = serviceOf(context, 'agents')
  if (agents === undefined) return undefined
  const get = asFunction(agents.get)
  const list = asFunction(agents.list)
  if (get === undefined && list === undefined) return undefined
  const toView = (value: unknown): AgentView | undefined => {
    const record = asRecord(value)
    if (record === undefined) return undefined
    const id = asString(record.id)
    return id.length === 0 ? undefined : { id, session: record.session }
  }
  return {
    port: {
      get: (id: string) => {
        if (get === undefined) return undefined
        try {
          return toView(get.call(agents, id))
        } catch {
          return undefined
        }
      },
      list: () => {
        if (list === undefined) return []
        const value = list.call(agents)
        return Array.isArray(value)
          ? value.map(toView).filter((entry): entry is AgentView => entry !== undefined)
          : []
      },
    },
    raw: (id: string) => {
      if (get === undefined) return undefined
      try {
        return get.call(agents, id)
      } catch {
        return undefined
      }
    },
  }
}

function makeSessionPort(context: unknown): { port: SessionPort; raw(id: string): unknown } | undefined {
  const sessions = serviceOf(context, 'sessions')
  if (sessions === undefined) return undefined
  const get = asFunction(sessions.get)
  const list = asFunction(sessions.list)
  if (get === undefined && list === undefined) return undefined
  return {
    port: {
      get: (id: string) => {
        if (get === undefined) return undefined
        try {
          return get.call(sessions, id)
        } catch {
          return undefined
        }
      },
      list: () => {
        if (list === undefined) return []
        const value = list.call(sessions)
        return Array.isArray(value) ? value : []
      },
      flush: async (session: unknown) => {
        const fn = asFunction(sessions.flush)
        if (fn === undefined) return undefined
        return await fn.call(sessions, session)
      },
    },
    raw: (id: string) => {
      if (get === undefined) return undefined
      try {
        return get.call(sessions, id)
      } catch {
        return undefined
      }
    },
  }
}

function makeGoalPort(context: unknown, rawAgent: (id: string) => unknown): GoalPort | undefined {
  const goals = serviceOf(context, 'goals')
  if (goals === undefined) return undefined
  const get = asFunction(goals.get)
  const create = asFunction(goals.create)
  if (get === undefined || create === undefined) return undefined
  const call = (name: string, view: AgentView, ...args: unknown[]): unknown => {
    const fn = asFunction(goals[name])
    if (fn === undefined) throw new Error(`ctx.goals.${name} is not available`)
    const agent = rawAgent(view.id) ?? view
    return fn.call(goals, agent, ...args)
  }
  return {
    get: (view: AgentView) => {
      try {
        const value = call('get', view)
        return isRecord(value) ? (value as GoalPort extends undefined ? never : never) : undefined
      } catch {
        return undefined
      }
    },
    create: (view: AgentView, request: { objective: string; maxGoalRounds?: number }) =>
      call('create', view, request) as { id?: string; objective?: string; phase?: string },
    edit: (view: AgentView, reference: unknown, request: unknown) =>
      call('edit', view, reference, request) as { id?: string; objective?: string; phase?: string },
    pause: (view: AgentView, reference: unknown) =>
      call('pause', view, reference) as { id?: string; objective?: string; phase?: string },
    resume: (view: AgentView, reference: unknown) =>
      call('resume', view, reference) as { id?: string; objective?: string; phase?: string },
    complete: (view: AgentView, reference: unknown) =>
      call('complete', view, reference) as { id?: string; objective?: string; phase?: string },
    clear: (view: AgentView, reference: unknown) => call('clear', view, reference),
  }
}

function makeCompactionPort(context: unknown, rawAgent: (id: string) => unknown): CompactionPort | undefined {
  const compaction = serviceOf(context, 'compaction')
  if (compaction === undefined) return undefined
  const compactNow = asFunction(compaction.compactNow)
  const compactIfNeeded = asFunction(compaction.compactIfNeeded)
  if (compactNow === undefined) return undefined
  return {
    compactNow: async (agent: AgentView, signal: AbortSignal) => {
      const live = rawAgent(agent.id) ?? agent
      return await compactNow.call(compaction, live, signal)
    },
    ...(compactIfNeeded === undefined
      ? {}
      : {
          compactIfNeeded: async (
            agent: AgentView,
            trigger: 'pressure' | 'context-overflow',
            signal: AbortSignal,
          ) => {
            const live = asRecord(rawAgent(agent.id)) ?? {}
            // DSH owns the safe range; we only hand it the session and routing
            // options. A missing session means "not compactable here" and the
            // governor treats the null/throw as a no-op.
            const session = live.session
            if (session === undefined) return null
            const options = isRecord(live.options) ? live.options : {}
            return await compactIfNeeded.call(compaction, { session, options }, trigger, signal)
          },
        }),
  }
}

function makeWebPort(context: unknown): WebSearchPort | undefined {
  const web = serviceOf(context, 'web')
  if (web === undefined) return undefined
  const search = asFunction(web.search)
  if (search === undefined) return undefined
  return {
    search: async (request: { query: string; maxResults?: number }, signal?: AbortSignal) =>
      await search.call(web, request, signal),
  }
}

function makeApprovalPort(context: unknown, rawAgent: (id: string) => unknown): ApprovalPort | undefined {
  const approval = serviceOf(context, 'approval')
  if (approval === undefined) return undefined
  const setPolicy = asFunction(approval.setPolicy)
  if (setPolicy === undefined) return undefined
  return {
    setPolicy: (agent: AgentView, policy: unknown) => {
      const live = rawAgent(agent.id) ?? agent
      setPolicy.call(approval, live, policy)
    },
  }
}

function makePermissionPresetPort(context: unknown): PermissionPresetPort | undefined {
  const presets = serviceOf(context, 'permissionPresets')
  if (presets === undefined) return undefined
  const catalog = asFunction(presets.catalog)
  const current = asFunction(presets.current)
  const set = asFunction(presets.set)
  if (catalog === undefined || current === undefined || set === undefined) return undefined
  const resolve = asFunction(presets.resolve)
  return {
    catalog: (): PermissionPresetCatalog => {
      const value = asRecord(catalog.call(presets)) ?? {}
      const options = Array.isArray(value.options) ? value.options : []
      const mapped: PermissionPresetOption[] = options
        .map((entry) => asRecord(entry))
        .filter((entry): entry is UnknownRecord => entry !== undefined)
        .map((entry) => ({
          value: asString(entry.value),
          name: asString(entry.name) || asString(entry.value),
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        }))
        .filter((entry) => entry.value.length > 0)
      return {
        options: mapped,
        ...(typeof value.defaultPreset === 'string' ? { defaultPreset: value.defaultPreset } : {}),
      }
    },
    current: (session: unknown) => asString(current.call(presets, session)),
    set: (session: unknown, name: string) => { set.call(presets, session, name) },
    ...(resolve === undefined
      ? {}
      : {
          resolve: (name: string) => {
            const value = asRecord(resolve.call(presets, name)) ?? {}
            return {
              ...(typeof value.sandbox === 'string' ? { sandbox: value.sandbox } : {}),
              ...(typeof value.approval === 'string' ? { approval: value.approval } : {}),
              ...(typeof value.name === 'string' ? { name: value.name } : {}),
              ...(typeof value.description === 'string' ? { description: value.description } : {}),
            }
          },
        }),
  }
}

function makeSandboxPolicyPort(context: unknown): SandboxPolicyPort | undefined {
  const policy = serviceOf(context, 'sandboxPolicy')
  if (policy === undefined) return undefined
  const resolve = asFunction(policy.resolve)
  const overrideOf = asFunction(policy.overrideOf)
  const defaultMode = asString(policy.defaultMode, 'workspace-write')
  if (resolve === undefined) return undefined
  return {
    defaultMode,
    resolve: (request?: { session?: unknown; mode?: string }): SandboxPolicyView => {
      const value = asRecord(resolve.call(policy, request ?? {})) ?? {}
      return {
        mode: asString(value.mode, defaultMode),
        workspaceRoot: asString(value.workspaceRoot),
      }
    },
    overrideOf: (session: unknown) => {
      if (overrideOf === undefined) return undefined
      const value = overrideOf.call(policy, session)
      return typeof value === 'string' ? value : undefined
    },
  }
}

/** Build every port from one Cordis context; absent services stay absent. */
export function createRuntime(context: unknown): DshRuntime {
  const agentRuntime = makeAgentPort(context)
  const sessionRuntime = makeSessionPort(context)
  const rawAgent = (id: string): unknown => agentRuntime?.raw(id)
  return {
    ...(makeLlmPort(context) === undefined ? {} : { llm: makeLlmPort(context) }),
    ...(makeGoalPort(context, rawAgent) === undefined ? {} : { goals: makeGoalPort(context, rawAgent) }),
    ...(makeCompactionPort(context, rawAgent) === undefined
      ? {}
      : { compaction: makeCompactionPort(context, rawAgent) }),
    ...(makeWebPort(context) === undefined ? {} : { web: makeWebPort(context) }),
    ...(agentRuntime === undefined ? {} : { agents: agentRuntime.port }),
    ...(sessionRuntime === undefined ? {} : { sessions: sessionRuntime.port }),
    ...(makeApprovalPort(context, rawAgent) === undefined
      ? {}
      : { approval: makeApprovalPort(context, rawAgent) }),
    ...(makePermissionPresetPort(context) === undefined
      ? {}
      : { permissionPresets: makePermissionPresetPort(context) }),
    ...(makeSandboxPolicyPort(context) === undefined
      ? {}
      : { sandboxPolicy: makeSandboxPolicyPort(context) }),
    ...(makeLogger(context) === undefined ? {} : { logger: makeLogger(context) }),
    rawSession: (id: string) => sessionRuntime?.raw(id),
    rawAgent,
  }
}

/* ------------------------------------------------------------------------- *
 * Lifecycle hooks
 * ------------------------------------------------------------------------- */

export interface TurnObservation {
  /** DSH session id. */
  session: string
  /** DSH turn ordinal inside that session. */
  turn: number
  step?: number
  /**
   * The user prompt carried by the pre-step payload. Absent when DSH does not
   * expose the messages; the pipeline then records an empty-prompt diagnostic
   * instead of inventing one.
   */
  prompt?: string
}

export interface TurnLifecycle {
  /** Open (or reuse) the coordination Turn for this DSH turn. */
  begin(observation: TurnObservation): void | Promise<void>
  /** Close the coordination Turn; the profession dropdown unlocks. */
  end(observation: TurnObservation): void | Promise<void>
  /** A step or turn errored; close the coordination Turn as failed. */
  fail?(observation: TurnObservation & { error: unknown }): void | Promise<void>
}

function warn(context: unknown, message: string, error: unknown): void {
  const logger = asRecord(asRecord(context)?.['logger'])
  const fn = asFunction(logger?.warn)
  if (fn !== undefined) {
    try {
      fn.call(logger, `deepseek-coordination: ${message}: ${error instanceof Error ? error.message : String(error)}`)
      return
    } catch {
      // fall through
    }
  }
}

/** Join the text blocks of one message content value, ignoring non-text parts. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      parts.push(entry)
      continue
    }
    const text = asString(asRecord(entry)?.text)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n')
}

/**
 * The last user prompt carried by a pre-step payload, when DSH includes the
 * conversation. This is the only host-side source of the turn text: the
 * coordination database deliberately does not mirror the DSH conversation.
 */
export function promptTextOfMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index])
    if (message?.role !== 'user') continue
    const text = contentText(message.content).trim()
    if (text.length > 0) return text
  }
  return undefined
}

/** Upper bound for opening the coordination turn inside `agent/pre-step`. */
const TurnHookBudgetMs = 5000

/**
 * Register the turn lifecycle listeners. Returns a disposer; the plugin entry
 * usually yields this from `ctx.effect` so unload removes every listener.
 *
 * The pre-step listener is intentionally bounded: opening the coordination turn
 * must never park the agent loop behind a slow database or command handler. The
 * deterministic pipeline itself is scheduled by the service and is not awaited
 * here at all.
 */
export function installTurnLifecycle(context: unknown, lifecycle: TurnLifecycle): () => void {
  const holder = asRecord(context)
  const on = asFunction(holder?.on)
  if (on === undefined) return () => {}
  const disposers: Array<() => void> = []

  const preStep = on.call(context, 'agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
    const record = asRecord(payload)
    const agentId = asString(asRecord(record?.agent)?.id)
    if (agentId.length > 0 && typeof record?.turn === 'number') {
      const prompt = promptTextOfMessages(record?.messages)
      const observation: TurnObservation = {
        session: agentId,
        turn: record.turn,
        step: typeof record.step === 'number' ? record.step : 0,
        ...(prompt === undefined ? {} : { prompt }),
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const begun = Promise.resolve()
        .then(() => lifecycle.begin(observation))
        .then(() => 'done' as const)
        .catch((error: unknown) => {
          warn(context, 'pre-step turn hook failed', error)
          return 'failed' as const
        })
      const expiry = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), TurnHookBudgetMs)
      })
      try {
        if ((await Promise.race([begun, expiry])) === 'timeout') {
          warn(context, `pre-step turn hook exceeded ${TurnHookBudgetMs}ms; continuing`, new Error('timeout'))
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    return await next()
  })
  if (typeof preStep === 'function') disposers.push(preStep as () => void)

  const stopping = on.call(context, 'agent/turn-stopping', async (payload: unknown) => {
    const record = asRecord(payload)
    const agentId = asString(asRecord(record?.agent)?.id)
    try {
      if (agentId.length > 0 && typeof record?.turn === 'number') {
        await lifecycle.end({ session: agentId, turn: record.turn })
      }
    } catch (error) {
      warn(context, 'turn-stopping hook failed', error)
    }
  })
  if (typeof stopping === 'function') disposers.push(stopping as () => void)

  if (lifecycle.fail !== undefined) {
    const failed = on.call(context, 'agent/error', (payload: unknown) => {
      const record = asRecord(payload)
      const agentId = asString(asRecord(record?.agent)?.id)
      if (agentId.length === 0 || typeof record?.turn !== 'number') return
      const turn = record.turn
      const failure = record.error
      void Promise.resolve()
        .then(() => lifecycle.fail?.({ session: agentId, turn, error: failure }))
        .catch((error: unknown) => { warn(context, 'agent/error hook failed', error) })
    })
    if (typeof failed === 'function') disposers.push(failed as () => void)
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A second disposal is harmless during plugin unload.
      }
    }
  }
}
