/**
 * CoordinationService — the host composition (v23 §2.3, §18.1).
 *
 * The service owns the kernel (database, config, handles, clock, trace) and one
 * instance of each module. The HTTP routes and the agent lifecycle call this
 * class; modules never know about Cordis or HTTP.
 *
 * This milestone wires the composer selection, the profession lock and the turn
 * lifecycle end-to-end. The wider v22 surface (Bayesian fusion, resources,
 * takeover windows) is exposed by its modules and can be added here without
 * changing the contract; methods that are not composed yet are intentionally
 * absent rather than returning fabricated data.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { CoordinationConfig } from './config.js'
import type { DshRuntime } from './dsh.js'
import { CoordinationDatabase, resolveDatabasePath } from './database.js'
import { HandleGenerator, SystemClock } from './handle.js'
import { createModuleHost, type AgentView, type ModuleHost } from './module.js'
import { TokenGovernor, normaliseCompactionPatch } from './token.js'
import type { TokenPlan } from './token.js'
import type { CompactionPolicyConfig } from './config.js'
import { TraceModule } from './trace.js'
import { SessionModule } from './session.js'
import {
  SelectionModule,
  abandonProfession as abandonProfessionTurn,
  rebuildProfession as rebuildProfessionTurn,
} from './selection.js'
import { TurnModule } from './turn.js'
import { ProfessionModule } from './profession.js'
import { CommandModule } from './command.js'
import { GoalModule } from './goal.js'
import { CompactModule } from './compact.js'
import { DirectiveModule } from './directive.js'
import { PlanModule } from './plan.js'
import { PermissionModule } from './permission.js'
import { TakeoverModule } from './takeover.js'
import { TakeoverGate } from './takeover-gate.js'
import type { PendingTakeoverView, TakeoverGateAnswer } from './takeover-gate.js'
import { ProviderModule } from './provider.js'
import { CacheModule } from './cache.js'
import { CompactionStateStore } from './compaction-state.js'
import type { CommandHandlers } from './command.js'
import type { PermissionResult, Selection, Turn, CoordinationMetrics } from '../shared/entity.js'
import type { Profession } from '../shared/enum.js'
import type { SelectionPatch, SelectionState } from '../shared/selection.js'

interface TurnSlot {
  dshTurn: number
  identity: number
}

export class CoordinationService extends Service {
  readonly db: CoordinationDatabase
  readonly config: CoordinationConfig
  readonly host: ModuleHost
  readonly session: SessionModule
  readonly selection: SelectionModule
  readonly turn: TurnModule
  readonly profession: ProfessionModule
  readonly plan: PlanModule
  readonly goal: GoalModule
  readonly compact: CompactModule
  readonly directive: DirectiveModule
  readonly command: CommandModule
  readonly permission: PermissionModule
  readonly takeover: TakeoverModule
  /** Intercepts DSH approval/question waterfalls while `ui.takeover` is on. */
  readonly takeoverGate: TakeoverGate
  readonly provider: ProviderModule
  readonly cache: CacheModule

  private readonly dshTurns = new Map<string, TurnSlot>()
  private readonly runtime: DshRuntime
  private governor: TokenGovernor
  private readonly compactionState = new CompactionStateStore()
  private compactionPolicy: CompactionPolicyConfig
  private localeValue: string

  constructor(context: Context, config: CoordinationConfig, runtime: DshRuntime) {
    super(context, 'coordination')
    this.config = config
    this.runtime = runtime
    this.compactionPolicy = { ...config.compaction }
    this.governor = new TokenGovernor({ config, contextWindow: 128_000 })
    this.localeValue = config.ui.locale === 'auto' ? 'zh-CN' : config.ui.locale
    this.db = new CoordinationDatabase(resolveDatabasePath(config.databasePath, config.database))
    const handles = new HandleGenerator()
    const clock = SystemClock
    const trace = new TraceModule(bootHost(this.db, config, handles, clock))
    this.host = createModuleHost({
      db: this.db,
      config,
      trace,
      handles,
      clock,
      ...(runtime.llm === undefined ? {} : { llm: runtime.llm }),
      ...(runtime.goals === undefined ? {} : { goals: runtime.goals }),
      ...(runtime.compaction === undefined ? {} : { compaction: runtime.compaction }),
      ...(runtime.web === undefined ? {} : { web: runtime.web }),
      ...(runtime.agents === undefined ? {} : { agents: runtime.agents }),
      ...(runtime.sessions === undefined ? {} : { sessions: runtime.sessions }),
      ...(runtime.approval === undefined ? {} : { approval: runtime.approval }),
      ...(runtime.permissionPresets === undefined ? {} : { permissionPresets: runtime.permissionPresets }),
      ...(runtime.sandboxPolicy === undefined ? {} : { sandboxPolicy: runtime.sandboxPolicy }),
      ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
    })
    this.session = new SessionModule(this.host)
    this.selection = new SelectionModule(this.host)
    this.turn = new TurnModule(this.host)
    this.profession = new ProfessionModule(this.host)
    this.plan = new PlanModule(this.host)
    this.goal = new GoalModule(this.host)
    this.compact = new CompactModule(this.host)
    this.directive = new DirectiveModule(this.host)
    this.permission = new PermissionModule(this.host)
    this.takeover = new TakeoverModule(this.host)
    this.takeoverGate = new TakeoverGate({
      takeover: this.takeover,
      sessions: this.session,
      config: this.config,
      events: this.host.events,
      clock: this.host.clock,
    })
    this.provider = new ProviderModule(this.host)
    this.cache = new CacheModule(this.host)
    this.command = new CommandModule(this.host, this.handlers())
  }

  /* --------------------------------------------------------------------- *
   * Composer selection (the five dropdowns)
   * --------------------------------------------------------------------- */

  state(session: string): SelectionState {
    return this.selection.state(session)
  }

  setSelection(session: string, patch: SelectionPatch): SelectionState {
    return this.selection.set(session, patch)
  }

  presets(): ReturnType<SelectionModule['listPreset']> {
    return this.selection.listPreset()
  }

  setPermission(session: string, preset: string): string {
    return this.selection.applyPermission(session, preset)
  }

  /* --------------------------------------------------------------------- *
   * Turns and the profession lock
   * --------------------------------------------------------------------- */

  activeTurn(session: string): ReturnType<SelectionModule['activeTurn']> {
    return this.selection.activeTurn(session)
  }

  /** The turn with this ordinal in the session, when it exists (lock tool). */
  turnByOrdinal(session: string, ordinal: number): Turn | undefined {
    return this.selection.turnByOrdinal(session, ordinal)
  }

  /**
   * `POST /profession/rebuild`: end the active task and create its replacement
   * with a new profession. Exposed here so the HTTP layer and the tools share
   * one implementation of the lock rules.
   */
  rebuildProfession(session: string, profession: Profession): SelectionState {
    return rebuildProfessionTurn(
      { selection: this.selection, profession: this.profession },
      session,
      profession,
    )
  }

  /** `POST /profession/abandon`: close the active task without a replacement. */
  abandonProfession(session: string): SelectionState {
    return abandonProfessionTurn({ selection: this.selection, profession: this.profession }, session)
  }

  getTurn(identity: number): Turn {
    return this.turn.get(identity)
  }

  selectProfession(turn: number, profession: Profession): Turn {
    return this.profession.selectProfession(turn, profession)
  }

  checkProfessionLock(turn: number): boolean {
    return this.profession.checkProfessionLock(turn)
  }

  getProfessionRecord(turn: number): ReturnType<ProfessionModule['getProfessionRecord']> {
    return this.profession.getProfessionRecord(turn)
  }

  listProfessionRecord(session: number): ReturnType<ProfessionModule['listProfessionRecord']> {
    return this.profession.listProfessionRecord(session)
  }

  /** Open (or reuse) the coordination turn for one DSH turn. */
  async beginTurn(sessionId: string, dshTurn: number, promptText = ''): Promise<Turn> {
    const session = this.session.ensure(sessionId)
    const existing = this.dshTurns.get(sessionId)
    if (existing !== undefined && existing.dshTurn === dshTurn) {
      return this.turn.get(existing.identity)
    }
    if (existing !== undefined) {
      this.finishQuietly(existing.identity, 'done')
    }
    const selection = this.selection.get(sessionId)
    const turn = this.turn.create(session.identity, {
      content: promptText,
      profession: selection.profession,
      interaction: selection.interaction,
      scene: selection.scene,
      validation: selection.validation,
      command: 'none',
    })
    this.dshTurns.set(sessionId, { dshTurn, identity: turn.identity })
    if (promptText.trim().length > 0) {
      try {
        await this.command.execute(turn.identity, promptText)
      } catch {
        // A command face never breaks the agent turn; the command row records the refusal.
      }
    }
    return turn
  }

  /** Close the coordination turn of one DSH turn; the profession unlocks. */
  endTurn(sessionId: string, outcome: 'done' | 'failed' | 'cancelled' = 'done'): void {
    const slot = this.dshTurns.get(sessionId)
    if (slot === undefined) return
    this.dshTurns.delete(sessionId)
    this.finishQuietly(slot.identity, outcome)
  }

  /** Fail the current coordination turn (an agent step/turn errored). */
  failTurn(sessionId: string): void {
    const slot = this.dshTurns.get(sessionId)
    if (slot === undefined) return
    this.dshTurns.delete(sessionId)
    this.finishQuietly(slot.identity, 'failed')
  }

  /* --------------------------------------------------------------------- *
   * Commands, permission and lifecycle
   * --------------------------------------------------------------------- */

  executeCommand(turn: number, content: string): ReturnType<CommandModule['execute']> {
    return this.command.execute(turn, content)
  }

  executePermission(turn: number, content: string): PermissionResult {
    return this.permission.execute(turn, content)
  }

  /* --------------------------------------------------------------------- *
   * Takeover gate (DSH approval / question waterfalls)
   * --------------------------------------------------------------------- */

  /**
   * Pending takeover windows for one DSH session id. The Client knows the DSH
   * id, not the coordination identity, so the lookup happens here; a session
   * that coordination has never seen has nothing pending.
   */
  listPendingTakeover(sessionId: string): PendingTakeoverView[] {
    const record = this.session.byHandle(sessionId)
    return record === undefined ? [] : this.takeoverGate.list(record.identity)
  }

  /** Deliver a human answer to a pending window; `false` leaves it open. */
  answerPendingTakeover(handle: string, answer: TakeoverGateAnswer): boolean {
    return this.takeoverGate.answer(handle, answer)
  }

  /** Cancel a pending window and delegate to the host default. */
  cancelPendingTakeover(handle: string): boolean {
    return this.takeoverGate.cancel(handle)
  }

  get locale(): string {
    return this.localeValue
  }

  setLocale(locale: string): string {
    if (locale === 'en-US' || locale === 'zh-CN') this.localeValue = locale
    return this.localeValue
  }

  metrics(): CoordinationMetrics {
    return {
      session: this.db.count('session'),
      turn: this.db.count('turn'),
      plan: this.db.count('plan'),
      subtask: this.db.count('subtask'),
      trace: this.db.count('orchestration_trace'),
      takeover: this.db.count('takeover'),
      database: this.db.path,
      schema: 23,
    }
  }

  cleanupExpired(): void {
    try {
      this.db.run('DELETE FROM lock WHERE ended IS NOT NULL AND ended < ?', Date.now() - this.config.defaultLease)
    } catch {
      // Cleanup is best-effort; a locked database is retried on the next tick.
    }
  }

  /* --------------------------------------------------------------------- *
   * Automatic compaction (token governor)
   * --------------------------------------------------------------------- */

  compaction(): CompactionPolicyConfig {
    return { ...this.compactionPolicy }
  }

  /** Settings-page patch: live policy, validated and re-applied to the governor. */
  applyCompactionPolicy(patch: unknown): { auto: boolean; soft: number; hard: number } {
    const next = normaliseCompactionPatch(patch, this.compactionPolicy)
    this.compactionPolicy = { ...this.compactionPolicy, ...next }
    this.config.compaction = this.compactionPolicy
    this.governor = new TokenGovernor({ config: this.config, contextWindow: 128_000 })
    this.compactionState.clear()
    return next
  }

  /**
   * Ask DSH to compact when the governor crosses a threshold. Safe by design:
   * O(1) early exits, a cooldown and a per-session cap, a timeout, and a
   * no-op when DSH exposes no pressure policy. Never blocks the agent step on
   * failure; the caller always proceeds to `next()`.
   */
  async maybeCompact(
    sessionId: string,
    messages: ReadonlyArray<{ role: string; content: unknown }>,
    signal?: AbortSignal,
  ): Promise<{ action: 'none' | 'compacted' | 'skipped'; plan?: TokenPlan }> {
    if (!this.compactionPolicy.auto) return { action: 'none' }
    if (signal?.aborted === true) return { action: 'none' }
    if (!Array.isArray(messages) || messages.length === 0) return { action: 'none' }
    const port = this.host.compaction
    if (port?.compactIfNeeded === undefined) return { action: 'none' }

    const now = Date.now()
    const state = this.compactionState.get(sessionId)
    if (state !== undefined) {
      if (state.count >= this.compactionPolicy.maxPerSession) return { action: 'none' }
      if (now - state.lastAt < this.compactionPolicy.cooldown) return { action: 'none' }
    }

    let plan: TokenPlan
    try {
      plan = this.governor.plan(messages)
    } catch {
      return { action: 'none' }
    }
    if (plan.decision === 'none') return { action: 'none', plan }

    const controller = new AbortController()
    const timeout = Math.min(this.config.clarifyTimeout, 30000)
    const timer = setTimeout(() => controller.abort(), timeout)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await port.compactIfNeeded(
        { id: sessionId } satisfies AgentView,
        plan.decision === 'hard-prune' ? 'context-overflow' : 'pressure',
        controller.signal,
      )
      if (result === null || result === undefined) return { action: 'none', plan }
      this.governor.recordCompaction()
      this.compactionState.set(sessionId, { lastAt: now, count: (state?.count ?? 0) + 1 })
      this.host.events.emit('compaction/auto', { session: sessionId, plan })
      return { action: 'compacted', plan }
    } catch {
      return { action: 'skipped', plan }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  dispose(): void {
    this.compactionState.clear()
    this.dshTurns.clear()
    try {
      this.db.close()
    } catch {
      // Closing twice is harmless.
    }
  }

  private finishQuietly(identity: number, outcome: 'done' | 'failed' | 'cancelled'): void {
    try {
      const current = this.turn.get(identity)
      if (current.status === 'done' || current.status === 'failed' || current.status === 'cancelled' || current.status === 'abandoned') return
      this.turn.finish(identity, outcome)
    } catch {
      // A turn closed by another path is already terminal.
    }
  }

  /** One handler per command face (v23 §6.4). */
  private handlers(): CommandHandlers {
    return {
      goal: (turn, content) => {
        const result = this.goal.execute(turn, content)
        return JSON.stringify({ goal: result.goal, rescored: result.rescored })
      },
      plan: (turn) => {
        const plan = this.plan.forTurn(turn)
        return plan === undefined ? 'no plan for this turn yet' : JSON.stringify(plan)
      },
      feedback: (turn, content) => JSON.stringify(this.directive.execute(turn, content)),
      compact: async (turn, content) => {
        const result = await this.compact.execute(turn, content)
        return JSON.stringify(result.compact)
      },
      permission: (turn, content) => {
        const result = this.permission.execute(turn, content)
        return result.reason ?? (result.allowed ? 'allowed' : 'denied')
      },
    }
  }
}

function resolvePath(config: CoordinationConfig): string {
  return resolveDatabasePath(config.databasePath, config.database)
}

/** TraceModule only reads db/handles/clock; bootstrap it before the full host exists. */
function bootHost(
  db: CoordinationDatabase,
  config: CoordinationConfig,
  handles: HandleGenerator,
  clock: typeof SystemClock,
): ModuleHost {
  return { db, config, handles, clock, trace: undefined as never, events: undefined as never }
}
