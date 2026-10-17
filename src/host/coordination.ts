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
import { createModuleHost, type ModuleHost } from './module.js'
import { TraceModule } from './trace.js'
import { SessionModule } from './session.js'
import { SelectionModule } from './selection.js'
import { TurnModule } from './turn.js'
import { ProfessionModule } from './profession.js'
import { CommandModule } from './command.js'
import { GoalModule } from './goal.js'
import { CompactModule } from './compact.js'
import { DirectiveModule } from './directive.js'
import { PlanModule } from './plan.js'
import { PermissionModule } from './permission.js'
import { TakeoverModule } from './takeover.js'
import { ProviderModule } from './provider.js'
import { CacheModule } from './cache.js'
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
  readonly provider: ProviderModule
  readonly cache: CacheModule

  private readonly dshTurns = new Map<string, TurnSlot>()
  private localeValue: string

  constructor(context: Context, config: CoordinationConfig, runtime: DshRuntime) {
    super(context, 'coordination')
    this.config = config
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

  dispose(): void {
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
