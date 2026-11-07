/**
 * The AMP host: a per-workspace SQLite protocol kernel, one agent gateway, one
 * bounded call journal, and the module catalog the harness registers tools for.
 *
 * AMP 0.7.9 is a protocol, not a server: it ships the surface (module names,
 * verbs, authority), the executable kernel, and a thin gateway. This class is
 * the host adapter that binds both to DSH identity, workspace roots and
 * lifetime.
 *
 * Persistence follows the workspace: `session.header.cwd` selects the store, so
 * a project's goals, plans, tasks, attention, receipts and evidence live in
 * `<root>/.deepseek-coordination/amp.sqlite` instead of the user's home
 * directory. `storePath` pins one shared store and `storage: 'user'` restores
 * the machine-wide layout; both keep the kernel root-independent.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  AgentBinding,
  AgentGateway,
  AgentSurface,
  GatewayCallRecord,
  GatewayHandler,
  SurfaceModule,
  ToolDescriptor,
} from 'attention-manifest-protocol/agent'
import type { Kernel } from 'attention-manifest-protocol/kernel'
import type { Config } from './config.js'
import { AMP_PREFIX } from './names.js'
import type { AmpProtocol } from './protocol.js'
import type { AmpSync } from './sync.js'
import type { HarnessBridge } from './bridge.js'
import type { AmpContextOptimizer } from './context.js'
import { AmpPreferencesStore } from './preferences.js'
import {
  AmpStateStore,
  fileBytes,
  inheritUserPreferences,
  PREFERENCES_FILE,
  STATE_FILE,
  storageLayout,
  storeDirectoryName,
  storeIdentity,
  type AmpStorageLayout,
} from './storage.js'
import { ensureStoreIgnored } from './vcsIgnore.js'
import { createHandlers } from './handlers/index.js'
import { asRecord, jsonSafe } from './json.js'
import { observeView, projectSessionLists, sessionContext, meaningful, type SessionViewContext, type ViewRow } from './sessionView.js'
import type { AmpCallResult, AmpModule } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The AMP host service: kernel, gateway, module catalog and journal. */
    amp: AmpHost
  }
}

interface CallFrame {
  readonly exec: ToolRunContext
  readonly module: string
  readonly verb: string
  /** Workspace root of the calling agent; absent when the agent has no cwd. */
  readonly root: string | undefined
}

/** A gateway call plus the session/workspace it was made for. */
type JournalRecord = GatewayCallRecord & {
  readonly sessionId?: string
  readonly root?: string
}

interface StorageFailure {
  readonly at: string
  readonly root: string | null
  readonly storePath: string
  readonly message: string
}

type IdentityLookup = { get?: (id: string) => unknown }

function cwdOf(value: unknown): string | undefined {
  const header = asRecord(asRecord(value)?.header)
  const cwd = header?.cwd
  return typeof cwd === 'string' && cwd.trim().length > 0 ? resolve(cwd) : undefined
}

function moduleRecord(source: SurfaceModule): AmpModule {
  return {
    module: source.module,
    tier: source.tier,
    summary: source.summary,
    verbs: source.exposed.map((verb) => ({
      verb: verb.verb,
      mutating: verb.mutating,
      authority: [...verb.authority],
      summary: verb.summary,
    })),
    withheld: source.withheld.map((item) => ({ verb: item.verb, reason: item.reason })),
  }
}

/** A gateway failure projected as a tool error. */
export class AmpCallError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AmpCallError'
    this.code = code
  }
}

/**
 * One storage directory: its kernel (opened lazily), takeover preferences and
 * durable host-side state. Several workspace roots can share a slot when an
 * explicit `storePath` or `storage: 'user'` pins one store.
 */
class StoreSlot {
  readonly root: string | undefined
  readonly layout: AmpStorageLayout
  readonly preferences: AmpPreferencesStore
  readonly state: AmpStateStore
  private readonly protocol: AmpProtocol
  private readonly config: Config
  private kernelInstance: Kernel | undefined

  constructor(protocol: AmpProtocol, config: Config, root: string | undefined, layout: AmpStorageLayout) {
    this.protocol = protocol
    this.config = config
    this.root = root
    this.layout = layout
    this.preferences = new AmpPreferencesStore(join(layout.directory, PREFERENCES_FILE), {
      takeoverFileRead: false,
      takeoverFileWrite: false,
      takeoverSearch: false,
      takeoverNotifications: config.notifications,
      contextOptimization: config.contextOptimization,
      autoRefresh: true,
      compactCatalog: false,
    })
    this.state = new AmpStateStore(join(layout.directory, STATE_FILE))
  }

  hasKernel(): boolean {
    return this.kernelInstance !== undefined
  }

  peekKernel(): Kernel | undefined {
    return this.kernelInstance
  }

  kernel(): Kernel {
    if (this.kernelInstance !== undefined) return this.kernelInstance
    this.kernelInstance = this.protocol.kernel.createKernel({
      tenantId: this.config.tenantId,
      rootId: this.config.rootId,
      storePath: this.layout.storePath,
      clock: () => new Date().toISOString(),
    })
    return this.kernelInstance
  }

  close(): void {
    this.state.dispose()
    this.kernelInstance?.close()
    this.kernelInstance = undefined
  }
}

export class AmpHost {
  readonly ctx: Context
  readonly config: Config
  readonly modules: readonly AmpModule[]
  readonly surface: AgentSurface
  readonly catalog: readonly ToolDescriptor[]
  readonly gateway: AgentGateway
  readonly protocol: AmpProtocol
  /** DSH→AMP projector, attached by the composition root. */
  sync?: AmpSync
  /** AMP→DSH command/tool/feedback bridge, attached by the composition root. */
  bridge?: HarnessBridge
  /** AMP attention → DSH prompt context optimizer, attached by the composition root. */
  contextOptimizer?: AmpContextOptimizer
  /** Last client render failures, exposed through the diagnostic route. */
  readonly clientErrors: Array<Record<string, unknown>> = []

  private readonly slots = new Map<string, StoreSlot>()
  private readonly failures: StorageFailure[] = []
  private fallbackSlot: StoreSlot | undefined
  /** Last workspace root seen from a tool call or session; used outside a call. */
  private primaryRoot: string | undefined
  private kernelJournal: JournalRecord[] = []
  private readonly callFrame = new AsyncLocalStorage<CallFrame>()
  private readonly observedViews = new Map<string, SessionViewContext>()
  private readonly historyViews = new Map<string, { session: unknown; seq: unknown; generation: unknown; view: SessionViewContext }>()
  private readonly turnPositions = new Map<string, { turn: number; step: number }>()

  constructor(ctx: Context, config: Config, protocol: AmpProtocol) {
    this.ctx = ctx
    this.config = config
    this.protocol = protocol
    const all = protocol.agent.SURFACE_MODULES.map(moduleRecord)
    this.modules = all
    const only = config.modules
    if (only !== undefined && only.length > 0) {
      const invalid = only.filter((name) => !all.some((item) => item.module === name && item.tier === 'agent'))
      if (invalid.length > 0) {
        throw new Error(`unknown or non-agent AMP module(s): ${invalid.join(', ')}`)
      }
    }
    this.surface = protocol.agent.createAgentSurface(only === undefined || only.length === 0 ? undefined : { only })
    this.catalog = this.surface.tools
    this.gateway = new protocol.agent.AgentGateway({
      surface: this.surface,
      handlers: createHandlers(this),
      authorize: () => true,
      onCall: (record) => {
        const frame = this.callFrame.getStore()
        const sessionId = frame?.exec.agent?.id
        this.kernelJournal.push({
          ...record,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(frame?.root === undefined ? {} : { root: frame.root }),
        })
        while (this.kernelJournal.length > this.config.maxJournal) this.kernelJournal.shift()
      },
    })
  }

  /** Agent-tier modules, in surface order. */
  get agentModules(): readonly AmpModule[] {
    return this.modules.filter((item) => item.tier === 'agent' && this.toolNames().some((name) => name.startsWith(`${AMP_PREFIX}_${item.module}.`)))
  }

  toolNames(): readonly string[] {
    return this.catalog.map((tool) => tool.name)
  }

  toolFor(module: string, verb: string): ToolDescriptor | undefined {
    return this.catalog.find((tool) => tool.module === module && tool.verb === verb)
  }

  /** The tool call currently running on this async resource, if any. */
  currentExec(): ToolRunContext | undefined {
    return this.callFrame.getStore()?.exec
  }

  currentModule(): { module: string; verb: string } | undefined {
    const frame = this.callFrame.getStore()
    return frame === undefined ? undefined : { module: frame.module, verb: frame.verb }
  }

  /** Invoke one AMP verb through the gateway with DSH-bound identity. */
  async call(module: string, verb: string, parameters: unknown, exec: ToolRunContext): Promise<AmpCallResult> {
    const descriptor = this.toolFor(module, verb)
    if (descriptor === undefined) {
      throw new AmpCallError('unknown_tool', `AMP module "${module}" has no exposed verb "${verb}"`)
    }
    const args = asRecord(parameters) ?? {}
    const binding = this.bindingFor(exec.agent)
    const idempotencyKey = descriptor.mutating ? exec.callId : undefined
    const root = this.rootOfAgent(exec.agent)
    if (root !== undefined) this.primaryRoot = root
    // Outside the call frame this is the same store `kernel()` resolves; keep
    // one root for the call so the state flush cannot drift to another store.
    const stateRoot = root ?? this.primaryRoot
    const run = (): AmpCallResult | Promise<AmpCallResult> => {
      const pending = this.gateway.call(descriptor.name, args, {
        binding,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      })
      if (pending instanceof Promise) {
        return pending.then(
          (value) => ({ module, verb, value: jsonSafe(value) }),
          (error: unknown) => {
            throw this.projectError(error)
          },
        )
      }
      return { module, verb, value: jsonSafe(pending) }
    }
    const result = this.callFrame.run({ exec, module, verb, root }, run)
    // Host-side state has no kernel aggregate, and AMP marks some of its verbs
    // read-only even though the host answers them by updating that state (for
    // example `session.report_status`). Persist after every call; the store
    // skips the write when the document did not change.
    return Promise.resolve(result).finally(() => {
      this.flushState(stateRoot)
    })
  }

  /** Model-facing binding for one agent; values are never read from arguments. */
  bindingFor(agent: Agent | undefined): AgentBinding {
    if (agent === undefined) {
      throw new AmpCallError('binding_invalid', 'AMP calls must run on behalf of an agent')
    }
    const position = this.turnPositions.get(agent.id)
    return {
      tenantId: this.config.tenantId,
      principalId: agent.id,
      sessionId: agent.id,
      ...(position === undefined ? {} : { turnId: this.turnId(agent.id, position.turn) }),
      policyVersion: 'dsh-amp-0.7.9',
      cancellationEpoch: 0,
    }
  }

  turnId(sessionId: string, turn: number): string {
    return `turn:${sessionId}:${turn}`
  }

  /** Current workspace root on the active AMP call frame. */
  rootOfCurrentCall(): string | undefined {
    return this.callFrame.getStore()?.root
  }

  /** Workspace root carried by an agent, when it declares one. */
  rootOfAgent(agent: unknown): string | undefined {
    return cwdOf(asRecord(agent)?.session)
  }

  /** Workspace root of a session, live or restored. */
  rootOfSession(sessionId: string): string | undefined {
    const self = this.ctx as unknown as { agents?: IdentityLookup; sessions?: IdentityLookup }
    try {
      const agent = self.agents?.get?.(sessionId)
      const fromAgent = cwdOf(asRecord(agent)?.session)
      if (fromAgent !== undefined) return fromAgent
    } catch {
      // A stale or non-live session id must not make /amp/status fail.
    }
    try {
      const session = self.sessions?.get?.(sessionId)
      const fromSession = cwdOf(session)
      if (fromSession !== undefined) return fromSession
    } catch {
      // Fall through to the last observed workspace root.
    }
    return this.primaryRoot
  }

  /** Track DSH turn/step positions from the durable session feed. */
  observeSessionEvent(session: { id: string }, event: { type: string; data?: unknown }): void {
    const data = asRecord(event.data)
    if (data === undefined) return
    const view = this.observedViews.get(session.id) ?? sessionContext([])
    observeView(view, event.type, data)
    this.observedViews.set(session.id, view)
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    if (turn === undefined) return
    const step = typeof data.step === 'number' ? data.step : 0
    if (event.type === 'turn/start' || event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end') {
      this.turnPositions.set(session.id, { turn, step })
    }
  }

  currentTurn(sessionId: string): number | undefined {
    return this.turnPositions.get(sessionId)?.turn
  }

  /** Create or return the AMP session row for one DSH session. */
  ensureSession(sessionId: string, root?: string): void {
    const kernel = this.kernel(root ?? this.rootOfSession(sessionId))
    const session = kernel.ports.services.session
    try {
      session.find(sessionId).get()
      return
    } catch {
      // Not created yet.
    }
    kernel.flow.startSession({ sessionId, actor: 'dsh-host' })
  }

  /** Create or return the AMP turn row for the session's current DSH turn. */
  ensureTurn(sessionId: string, turn?: number, root?: string): string {
    const kernel = this.kernel(root ?? this.rootOfSession(sessionId))
    this.ensureSession(sessionId, root)
    const number = turn ?? this.currentTurn(sessionId) ?? 0
    const id = this.turnId(sessionId, number)
    const service = kernel.ports.services.turn
    try {
      service.find(id).get()
      return id
    } catch {
      // Not created yet.
    }
    kernel.flow.beginTurn({ turnId: id, sessionId, actor: 'dsh-host' })
    return id
  }

  /** Kernel for a workspace root; opens the store on first use. */
  kernel(root?: string): Kernel {
    const resolved = this.resolveRoot(root)
    const slot = this.slotAt(resolved)
    try {
      return slot.kernel()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failures.push({ at: new Date().toISOString(), root: resolved ?? null, storePath: slot.layout.storePath, message })
      while (this.failures.length > 10) this.failures.shift()
      // A read-only or locked workspace must not take AMP down: keep the
      // machine-wide fallback so the protocol surface stays usable.
      const fallback = this.fallbackStorage()
      return fallback.kernel()
    }
  }

  /** Takeover preferences for a workspace root (machine-wide when unknown). */
  preferencesFor(root?: string): AmpPreferencesStore {
    return this.slotAt(this.resolveRoot(root)).preferences
  }

  /** Runtime takeover switches, resolved against one live Session's workspace. */
  preferencesForSession(sessionId?: string): AmpPreferencesStore {
    if (sessionId !== undefined) {
      try {
        const agent = this.ctx.agents.get(sessionId as never)
        const cwd = agent?.session.header?.cwd
        if (typeof cwd === 'string' && cwd.length > 0) return this.preferencesFor(cwd)
      } catch {
        // Use the current/default root when the Session is no longer live.
      }
    }
    return this.preferencesFor()
  }

  notificationTakeoverEnabled(sessionId?: string): boolean {
    return this.preferencesForSession(sessionId).get().takeoverNotifications
  }

  /** Runtime takeover switches, resolved against the active workspace. */
  get preferences(): AmpPreferencesStore {
    return this.preferencesFor()
  }

  /** Durable per-session notes (turn reports, clarifications, focus requests). */
  get notes(): Map<string, unknown[]> {
    return this.slotAt(this.resolveRoot()).state.notes
  }

  /** Latest status line per session. */
  get statusLines(): Map<string, string> {
    return this.slotAt(this.resolveRoot()).state.statusLines
  }

  /** Per-session cooperation mailboxes. */
  get mailboxes(): Map<string, unknown[]> {
    return this.slotAt(this.resolveRoot()).state.mailboxes
  }

  /** Scoped result handles returned by `execution.run`. */
  get handles(): Map<string, unknown> {
    return this.slotAt(this.resolveRoot()).state.handles
  }

  /** Evidence ids cited by the current session. */
  get citations(): Set<string> {
    return this.slotAt(this.resolveRoot()).state.citations
  }

  /** Last text read per workspace path, used by `workspace.diff`. */
  get baseContents(): Map<string, string> {
    return this.slotAt(this.resolveRoot()).state.baseContents
  }

  /** Storage layout, open stores and any fallback the host had to take. */
  storage(root?: string): Record<string, unknown> {
    const primary = root === undefined ? this.primaryRoot : resolve(root)
    const planned = storageLayout(this.config, primary)
    return {
      mode: planned.mode,
      storeDirectory: storeDirectoryName(this.config),
      defaultRoot: primary ?? null,
      storePath: planned.storePath,
      directory: planned.directory,
      roots: [...this.slots.values()].map((slot) => {
        const snapshot = slot.peekKernel()?.snapshot()
        return {
          root: slot.root ?? null,
          mode: slot.layout.mode,
          storePath: slot.layout.storePath,
          directory: slot.layout.directory,
          open: slot.hasKernel(),
          exists: existsSync(slot.layout.storePath),
          bytes: fileBytes(slot.layout.storePath) ?? null,
          entities: snapshot?.store.entities ?? null,
          events: snapshot?.store.events ?? null,
        }
      }),
      fallbacks: [...this.failures],
    }
  }

  findEntity(kind: string, id: string, root?: string): Record<string, unknown> | undefined {
    const kernel = this.kernel(root)
    try {
      const rows = (kernel.store as unknown as { list(kind: string): readonly unknown[] }).list(kind)
      return rows.map(asRecord).find((row) => row !== undefined && row.id === id)
    } catch {
      return undefined
    }
  }

  listEntities(kind: string, sessionId?: string, root?: string): readonly Record<string, unknown>[] {
    const kernel = this.kernel(root)
    try {
      const rows = (kernel.store as unknown as { list(kind: string): readonly unknown[] }).list(kind)
      return rows
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => row !== undefined)
        .filter((row) => {
          if (sessionId === undefined) return true
          if (row.sessionId === sessionId || row.id === sessionId || asRecord(row.scope)?.sessionId === sessionId) return true
          if (kind === 'attention') return asRecord(row.scope)?.sessionId === sessionId
          return false
        })
    } catch {
      return []
    }
  }

  private currentSessionContext(sessionId: string): SessionViewContext {
    let agent: unknown
    let session: ViewRow | undefined
    try { agent = (this.ctx as unknown as { agents?: IdentityLookup }).agents?.get?.(sessionId) } catch { /* Not live. */ }
    session = asRecord(asRecord(agent)?.session)
    if (!session) {
      try { session = asRecord((this.ctx as unknown as { sessions?: IdentityLookup }).sessions?.get?.(sessionId)) } catch { /* Not restored. */ }
    }
    let view = sessionContext([])
    if (session && typeof session.deriveMessages === 'function') {
      const generation = asRecord(session.surface)?.contentGeneration
      const cached = this.historyViews.get(sessionId)
      if (cached?.session === session && cached.seq === session.seq && cached.generation === generation) {
        view = cached.view
      } else {
        try {
          const messages = (session.deriveMessages as () => readonly unknown[]).call(session)
          view = sessionContext(messages)
          this.historyViews.set(sessionId, { session, seq: session.seq, generation, view })
        } catch { /* Keep event-observed labels when history is unavailable. */ }
      }
    }
    const observed = this.observedViews.get(sessionId)
    const combined: SessionViewContext = {
      request: view.request ?? observed?.request,
      latestRequest: observed?.latestRequest ?? view.latestRequest,
      calls: new Map([...view.calls, ...(observed?.calls ?? [])]),
      todos: observed?.todos.length ? observed.todos : view.todos,
      turnRequests: observed?.turnRequests ?? new Map(),
    }
    try {
      const goals = this.ctx.get('goals') as { get?: (agent: unknown) => unknown } | undefined
      combined.goal = meaningful(asRecord(goals?.get?.(agent))?.objective)
    } catch { /* Goal service is optional. */ }
    return combined
  }

  /** Project one session's actual workflow state and persisted attention. */
  sessionLists(sessionId: string, root?: string): Record<string, readonly Record<string, unknown>[]> {
    const rootForSession = root ?? this.rootOfSession(sessionId)
    const kernel = this.kernel(rootForSession)
    const workflow = kernel.ports.workflow.snapshot()
    const entities = Array.isArray(workflow.entities) ? workflow.entities : []
    const attempts = Array.isArray(workflow.attempts) ? workflow.attempts : []
    const workflowKinds = ['session', 'turn', 'intent', 'mission', 'goal', 'plan', 'task', 'action']
    const groups: Record<string, readonly ViewRow[]> = {}
    for (const kind of workflowKinds) {
      groups[kind] = entities.filter((row) => row.kind === kind && row.sessionId === sessionId) as unknown as ViewRow[]
    }
    groups.action_attempt = attempts.filter((row) => row.sessionId === sessionId) as unknown as ViewRow[]
    for (const kind of ['attention', 'evidence']) groups[kind] = this.listEntities(kind, sessionId, rootForSession)
    // AMP 0.7.9 declares profession policies but this host has no session-bound
    // profession provider. Never query an unsupported entity kind or invent one.
    groups.profession = []
    const detached = jsonSafe(groups) as unknown as Record<string, ViewRow[]>
    let context: SessionViewContext
    try {
      context = this.currentSessionContext(sessionId)
    } catch {
      context = sessionContext([])
    }
    return projectSessionLists(detached, context) as unknown as Record<string, readonly Record<string, unknown>[]>
  }

  /** Status snapshot: catalog, storage layout, the active kernel and journal. */
  snapshot(root?: string, sessionId?: string, withLists = false): Record<string, unknown> {
    const requested = root === undefined
      ? sessionId === undefined ? this.primaryRoot : this.rootOfSession(sessionId)
      : resolve(root)
    const resolved = requested === undefined ? undefined : resolve(requested)
    const slot = resolved === undefined
      ? undefined
      : this.slots.get(storeIdentity(storageLayout(this.config, resolved).storePath))
    let kernel: unknown = null
    try {
      const snapshot = slot?.peekKernel()?.snapshot()
      if (snapshot !== undefined) {
        const entities = sessionId === undefined
          ? snapshot.entities
          : snapshot.entities.filter((entity) => entity.sessionId === sessionId)
        const counts = sessionId === undefined
          ? snapshot.counts
          : entities.reduce<Record<string, number>>((next, entity) => {
            next[entity.kind] = (next[entity.kind] ?? 0) + 1
            return next
          }, {})
        // `/amp/status` is a dashboard snapshot, not the full store dump; the
        // `/amp/kernel` route remains the place to inspect every entity. This
        // keeps a polling client from re-parsing the whole workflow each tick.
        kernel = jsonSafe({
          ...snapshot,
          entities: undefined,
          counts,
          store: sessionId === undefined ? snapshot.store : { ...snapshot.store, entities: entities.length },
        })
      }
    } catch {
      kernel = null
    }
    let lists: Record<string, readonly Record<string, unknown>[]> | undefined
    let listsError: string | undefined
    if (withLists && sessionId !== undefined) {
      try {
        lists = this.sessionLists(sessionId, resolved)
      } catch (error) {
        // A projection bug must not make the whole session status unreadable;
        // the panel keeps its counts and can show a targeted diagnostic.
        listsError = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
        lists = {}
      }
    }
    return {
      tenantId: this.config.tenantId,
      rootId: this.config.rootId,
      ...(resolved === undefined ? {} : { root: resolved }),
      ...(sessionId === undefined ? {} : { sessionId }),
      modules: this.modules.length,
      agentModules: this.agentModules.length,
      exposedTools: this.catalog.length,
      storage: this.storage(resolved),
      kernel,
      journal: this.journalEntries(sessionId).slice(-50),
      ...(lists === undefined ? {} : { lists }),
      ...(listsError === undefined ? {} : { listsError }),
    }
  }

  journalEntries(sessionId?: string, root?: string): readonly GatewayCallRecord[] {
    const resolved = root === undefined ? undefined : resolve(root)
    return this.kernelJournal.filter((entry) => (
      (sessionId === undefined || entry.sessionId === sessionId)
      && (resolved === undefined || entry.root === undefined || entry.root === resolved)
    ))
  }

  close(): void {
    for (const slot of this.slots.values()) {
      try {
        slot.close()
      } catch {
        // A store that cannot close must not block the remaining stores.
      }
    }
    this.slots.clear()
    this.historyViews.clear()
    this.observedViews.clear()
    this.fallbackSlot = undefined
  }

  private resolveRoot(explicit?: string): string | undefined {
    if (explicit !== undefined && explicit.trim().length > 0) return resolve(explicit)
    const frame = this.callFrame.getStore()
    if (frame?.root !== undefined) return frame.root
    return this.primaryRoot
  }

  private slotAt(root: string | undefined): StoreSlot {
    const layout = storageLayout(this.config, root)
    const key = storeIdentity(layout.storePath)
    const existing = this.slots.get(key)
    if (existing !== undefined) return existing
    if (layout.mode === 'workspace') {
      inheritUserPreferences(layout.directory)
      if (root !== undefined) ensureStoreIgnored(root, layout.directory)
    }
    const slot = new StoreSlot(this.protocol, this.config, root, layout)
    this.slots.set(key, slot)
    return slot
  }

  private fallbackStorage(): StoreSlot {
    if (this.fallbackSlot !== undefined) return this.fallbackSlot
    const layout = storageLayout({ ...this.config, storePath: undefined, storage: 'user' }, undefined)
    const slot = new StoreSlot(this.protocol, this.config, undefined, layout)
    this.fallbackSlot = slot
    this.slots.set(storeIdentity(layout.storePath), slot)
    return slot
  }

  private flushState(root: string | undefined): void {
    try {
      this.slotAt(root).state.flush()
    } catch {
      // Best effort.
    }
    try {
      this.fallbackSlot?.state.flush()
    } catch {
      // Best effort.
    }
  }

  private projectError(error: unknown): AmpCallError {
    if (error instanceof AmpCallError) return error
    const record = asRecord(error)
    const code = typeof record?.code === 'string' ? record.code : 'handler_failed'
    const message = error instanceof Error ? error.message : String(error)
    return new AmpCallError(code, message)
  }
}
