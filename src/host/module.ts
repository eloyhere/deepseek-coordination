/**
 * The small kernel every coordination module receives.
 *
 * Modules never reach into DSH directly. The service composes a `ModuleHost`
 * once and passes it down; this keeps provider, session, goal, compaction and
 * web access behind narrow structural ports that tests can fake. In
 * particular, no module imports `@deepseek-ai/dsh-*` at runtime, so the host
 * bundle only needs Cordis and its own code.
 */
import type { CoordinationConfig } from './config.js'
import type { CoordinationDatabase } from './database.js'
import { HandleGenerator } from './handle.js'
import type { Clock } from './handle.js'
import type { OrchestrationTrace } from '../shared/entity.js'
import type { TraceEvent } from '../shared/enum.js'

/* ------------------------------------------------------------------------- *
 * Read-only DSH ports
 * ------------------------------------------------------------------------- */

export interface LlmProviderInfo {
  id: string
  name: string
}

export interface LlmConfigurableProviderInfo {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  declared?: boolean
  error?: string
}

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly string[]
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: { efforts: ReadonlyArray<{ id: string; name: string; description?: string }>; defaultEffort?: string }
  systemPromptUpdate?: string
  toolUpdate?: string
}

export interface LlmReadPort {
  listProviders(): LlmProviderInfo[]
  listConfigurableProviders(): LlmConfigurableProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

export interface AgentView {
  readonly id: string
  readonly session?: unknown
}

export interface AgentPort {
  get(id: string): AgentView | undefined
  list(): AgentView[]
}

export interface SessionPort {
  get(id: string): unknown
  list(): unknown[]
  flush?(session: unknown): Promise<unknown>
}

export interface GoalViewPort {
  id?: string
  objective?: string
  phase?: string
}

export interface GoalPort {
  get(agent: AgentView): GoalViewPort | undefined
  create(agent: AgentView, request: { objective: string; maxGoalRounds?: number }): GoalViewPort
  edit?(agent: AgentView, reference: unknown, request: unknown): GoalViewPort
  pause?(agent: AgentView, reference: unknown): GoalViewPort
  resume?(agent: AgentView, reference: unknown): GoalViewPort
  complete?(agent: AgentView, reference: unknown): GoalViewPort
  clear?(agent: AgentView, reference: unknown): unknown
}

export interface CompactionPort {
  compactNow(agent: AgentView, signal: AbortSignal): Promise<unknown>
}

export interface WebSearchPort {
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<unknown>
}

export interface ApprovalPort {
  setPolicy(agent: AgentView, policy: unknown): void
}

/** One permission preset the DSH deployment exposes (v23 §16). */
export interface PermissionPresetOption {
  value: string
  name: string
  description?: string
  sandbox?: string
  approval?: string
}

export interface PermissionPresetCatalog {
  options: PermissionPresetOption[]
  defaultPreset?: string
}

/**
 * Read/write access to DSH's own permission presets. The plugin never defines
 * a sandbox mode of its own: the dropdown offers the deployment's catalog and
 * writes the chosen preset back through this port.
 */
export interface PermissionPresetPort {
  catalog(): PermissionPresetCatalog
  current(session: unknown): string
  set(session: unknown, name: string): void
  /** Optional: the preset's effective knobs, for the dropdown tooltip. */
  resolve?(name: string): { sandbox?: string; approval?: string; name?: string; description?: string }
}

export interface SandboxPolicyView {
  mode: string
  workspaceRoot: string
}

export interface SandboxPolicyPort {
  resolve(request?: { session?: unknown; mode?: string }): SandboxPolicyView
  overrideOf(session: unknown): string | undefined
  readonly defaultMode: string
}

export interface LoggerPort {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/* ------------------------------------------------------------------------- *
 * Trace port
 * ------------------------------------------------------------------------- */

export interface TraceInput {
  turn: number
  event: TraceEvent
  actor: string
  subtask?: number
  profession?: OrchestrationTrace['profession']
  parentEvent?: number
  detail: string | Record<string, unknown>
}

export interface TraceVerification {
  ok: boolean
  brokenAt?: number
  reason?: string
}

export interface TraceWriter {
  append(input: TraceInput): OrchestrationTrace
  list(turn: number): OrchestrationTrace[]
  verify(turn: number): TraceVerification
}

/* ------------------------------------------------------------------------- *
 * Event bus
 * ------------------------------------------------------------------------- */

export type CoordinationListener = (payload: unknown) => void

export class CoordinationEventBus {
  private readonly listeners = new Map<string, Set<CoordinationListener>>()

  on(type: string, listener: CoordinationListener): () => void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  emit(type: string, payload: unknown): void {
    const set = this.listeners.get(type)
    if (set === undefined) return
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch {
        // A broken observer must not break the committing operation.
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

/* ------------------------------------------------------------------------- *
 * Module host
 * ------------------------------------------------------------------------- */

export interface ModuleHost {
  readonly db: CoordinationDatabase
  readonly config: CoordinationConfig
  readonly handles: HandleGenerator
  readonly clock: Clock
  readonly events: CoordinationEventBus
  readonly trace: TraceWriter
  readonly llm?: LlmReadPort
  readonly goals?: GoalPort
  readonly compaction?: CompactionPort
  readonly web?: WebSearchPort
  readonly agents?: AgentPort
  readonly sessions?: SessionPort
  readonly approval?: ApprovalPort
  readonly permissionPresets?: PermissionPresetPort
  readonly sandboxPolicy?: SandboxPolicyPort
  readonly logger?: LoggerPort
}

export interface ModuleHostInput {
  db: CoordinationDatabase
  config: CoordinationConfig
  trace: TraceWriter
  handles?: HandleGenerator
  clock?: Clock
  events?: CoordinationEventBus
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
}

/** Compose the common kernel; modules receive exactly this object. */
export function createModuleHost(input: ModuleHostInput): ModuleHost {
  return {
    db: input.db,
    config: input.config,
    trace: input.trace,
    handles: input.handles ?? new HandleGenerator(),
    clock: input.clock ?? { now: () => Date.now() },
    events: input.events ?? new CoordinationEventBus(),
    ...(input.llm === undefined ? {} : { llm: input.llm }),
    ...(input.goals === undefined ? {} : { goals: input.goals }),
    ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
    ...(input.web === undefined ? {} : { web: input.web }),
    ...(input.agents === undefined ? {} : { agents: input.agents }),
    ...(input.sessions === undefined ? {} : { sessions: input.sessions }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
    ...(input.permissionPresets === undefined ? {} : { permissionPresets: input.permissionPresets }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  }
}

/** Run a callback with a small, deterministic amount of jitter. */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Round to a fixed number of decimals without float noise. */
export function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
