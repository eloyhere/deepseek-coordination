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
 *
 * v24 pipeline: a normal turn (`command = none`) now runs the deterministic
 * comprehension → organization → plan/score chain through `TurnPipeline`. The
 * pipeline is scheduled after the turn row exists and is never awaited by the
 * `agent/pre-step` hook, so a slow or failed stage cannot block the agent loop.
 * The scene policy is resolved from `config.scenes.<scene>` and applied where a
 * module or port exists; every knob that cannot be enforced is recorded in the
 * report as a deferred policy gap instead of being silently ignored.
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
import { PlanModule, decodePlanStep } from './plan.js'
import { PermissionModule } from './permission.js'
import { TakeoverModule } from './takeover.js'
import { TakeoverGate } from './takeover-gate.js'
import type { PendingTakeoverView, TakeoverGateAnswer } from './takeover-gate.js'
import { ProviderModule } from './provider.js'
import { CacheModule } from './cache.js'
import { CompactionStateStore } from './compaction-state.js'
import type { CommandHandlers } from './command.js'
import { ComprehensionModule } from './comprehension.js'
import type { ComprehensionPolicyPatch } from './comprehension.js'
import { OrganizationModule, WritingStageMarkers } from './organization.js'
import { PredictModule } from './predict.js'
import type { Comprehension, Plan, PermissionResult, Selection, Turn, CoordinationMetrics } from '../shared/entity.js'
import type { CommandType, Profession, Scene, Validation } from '../shared/enum.js'
import { SceneProfiles } from '../shared/enum.js'
import type { SceneProfile } from '../shared/enum.js'
import type { SelectionPatch, SelectionState } from '../shared/selection.js'

interface TurnSlot {
  dshTurn: number
  identity: number
}

/** How many settled pipeline reports are kept for diagnostics/tests. */
const PipelineReportCapacity = 256

/* ------------------------------------------------------------------------- *
 * Turn pipeline (v24 §19): comprehension -> organization -> plan/score
 * ------------------------------------------------------------------------- */

/** The part of the pipeline that produced a diagnostic. */
export type PipelineStage = 'pipeline' | 'comprehension' | 'organization' | 'plan' | 'predict' | 'policy'

/** One recorded degradation; a diagnostic never becomes a fabricated result. */
export interface PipelineDiagnostic {
  stage: PipelineStage
  code: string
  message: string
}

/** One scene-policy knob that the composed pipeline could not enforce. */
export interface ScenePolicyGap {
  field: keyof SceneProfile
  reason: string
}

/** How the scene policy was applied on one turn. */
export interface ScenePolicyReport {
  scene: Scene
  profile: SceneProfile
  /** The turn's persisted effort; the only DSH-adjacent execution knob we hold. */
  effort: string
  /** Policy requirements that were actually satisfied by a module or port. */
  applied: string[]
  /** Policy requirements with no consumer/port; recorded, never invented. */
  deferred: ScenePolicyGap[]
}

/** The plan measurement the pipeline persisted. */
export interface PlanPipelineScore {
  total: number
  pass: boolean
  failing: string[]
  threshold: number
}

/** The result of driving one turn through the deterministic pipeline. */
export interface TurnPipelineReport {
  turn: number
  command: CommandType
  scene: Scene
  status: 'completed' | 'skipped' | 'failed'
  comprehension?: number
  organization?: number
  plan?: number
  score?: PlanPipelineScore
  predict?: number
  policy: ScenePolicyReport
  diagnostics: PipelineDiagnostic[]
}

/**
 * A `allowWeb = false` scene still runs the deterministic four-stage
 * comprehension, but the evidence search is switched off for every validation
 * level. The override is separate from the default module so the two never
 * share mutable policy state.
 */
const NoSearchPolicy: Partial<Record<Validation, ComprehensionPolicyPatch>> = {
  low: { search: false },
  medium: { search: false },
  high: { search: false },
}

/** A configured scene profile, repaired to the documented bounds. */
export function resolveSceneProfile(config: CoordinationConfig, scene: Scene): SceneProfile {
  const base = SceneProfiles[scene] ?? SceneProfiles.dialogue
  const configured = config.scenes?.[scene]
  const merged: SceneProfile = configured === undefined ? base : { ...base, ...configured }
  return {
    ...merged,
    thinking:
      merged.thinking === 'enabled' || merged.thinking === 'disabled' ? merged.thinking : base.thinking,
    reasoningEffort: textOr(merged.reasoningEffort, base.reasoningEffort),
    requirePlan: booleanOr(merged.requirePlan, base.requirePlan),
    requireScore: booleanOr(merged.requireScore, base.requireScore),
    requireOutline: booleanOr(merged.requireOutline, base.requireOutline),
    requireRevision: booleanOr(merged.requireRevision, base.requireRevision),
    requirePredict: booleanOr(merged.requirePredict, base.requirePredict),
    requireCitation: booleanOr(merged.requireCitation, base.requireCitation),
    allowBash: booleanOr(merged.allowBash, base.allowBash),
    allowWeb: booleanOr(merged.allowWeb, base.allowWeb),
    sandboxOnly: booleanOr(merged.sandboxOnly, base.sandboxOnly),
    maxIteration: boundedInteger(merged.maxIteration, base.maxIteration, 1, 1000),
    scoreThreshold: boundedNumber(merged.scoreThreshold, base.scoreThreshold, 0, 1),
  }
}

/** The modules and ports the pipeline needs; the service supplies them once. */
export interface TurnPipelineDependencies {
  host: ModuleHost
  comprehension: ComprehensionModule
  offlineComprehension: ComprehensionModule
  organization: OrganizationModule
  plan: PlanModule
  predict: PredictModule
  /** The live DSH session, for ports that take the session object whole. */
  rawSession?(sessionId: string): unknown
}

/**
 * Drive one already-created turn through comprehension, organization and plan
 * scoring, then apply the scene policy.
 *
 * The class is deliberately total: every stage is isolated, so a thrown module
 * or a missing port returns a report with a diagnostic instead of rejecting.
 * That is what lets the turn lifecycle schedule it without guarding `next()`.
 */
export class TurnPipeline {
  private readonly deps: TurnPipelineDependencies

  constructor(deps: TurnPipelineDependencies) {
    this.deps = deps
  }

  async run(turn: Turn, prompt: string, sessionId: string): Promise<TurnPipelineReport> {
    const profile = resolveSceneProfile(this.deps.host.config, turn.scene)
    const policy: ScenePolicyReport = {
      scene: turn.scene,
      profile,
      effort: turn.effort,
      applied: [],
      deferred: [],
    }
    const report: TurnPipelineReport = {
      turn: turn.identity,
      command: turn.command,
      scene: turn.scene,
      status: 'completed',
      policy,
      diagnostics: [],
    }

    /* ---- Command face and prompt guard --------------------------------- */
    if (turn.command !== 'none') {
      report.status = 'skipped'
      report.diagnostics.push({
        stage: 'pipeline',
        code: 'command-face',
        message: `turn ${turn.identity} carries the "${turn.command}" command face; the full pipeline is skipped`,
      })
      return report
    }
    if (turn.prompt === undefined) {
      report.status = 'skipped'
      report.diagnostics.push({
        stage: 'pipeline',
        code: 'prompt-missing',
        message: `turn ${turn.identity} has no prompt row; comprehension cannot run`,
      })
      return report
    }

    // The persisted prompt wins: the turn row is the audit record, while the
    // caller's argument is only a fallback for a turn created outside `create`.
    const storedPrompt = this.promptContent(turn.prompt)
    const promptText = storedPrompt.trim().length > 0 ? storedPrompt : prompt
    if (promptText.trim().length === 0) {
      report.status = 'skipped'
      report.diagnostics.push({
        stage: 'pipeline',
        code: 'prompt-empty',
        message: 'the turn prompt is empty; comprehension would have no input',
      })
      return report
    }

    /* ---- Scene policy knobs with no execution port --------------------- */
    if (turn.effort === profile.reasoningEffort) policy.applied.push('effort')
    else {
      this.defer(policy, report, 'reasoningEffort', `turn effort "${turn.effort}" differs from the scene effort "${profile.reasoningEffort}"`)
    }
    // `thinking` is rendered into the provider request by DSH; the host has no
    // model-config write port, so changing the turn row cannot toggle it.
    this.defer(policy, report, 'thinking', 'no DSH model-config port: the pipeline records the scene but cannot toggle reasoning')
    // Bash permission is a DSH permission-preset decision; this pipeline must
    // not silently rewrite the human's preset.
    this.defer(policy, report, 'allowBash', 'no execution-policy port: bash permission is left to the DSH permission preset')
    // No composed loop consumes the scene iteration budget yet.
    this.defer(policy, report, 'maxIteration', 'no iterative driver consumes scene.maxIteration yet')

    /* ---- allowWeb: the one policy knob that changes a module call ------ */
    policy.applied.push('allowWeb')
    const searchEnabled = this.deps.host.config.comprehension.searchEnabled
    if (profile.allowWeb && searchEnabled && this.deps.host.web === undefined) {
      report.diagnostics.push({
        stage: 'comprehension',
        code: 'web-port-missing',
        message: 'web search is allowed but no web port is present; comprehension runs without search evidence',
      })
    }
    const comprehensionModule = profile.allowWeb ? this.deps.comprehension : this.deps.offlineComprehension

    /* ---- Comprehension ------------------------------------------------ */
    let comprehension: Comprehension
    try {
      comprehension = await comprehensionModule.comprehend({
        turn: turn.identity,
        promptIdentity: turn.prompt,
        prompt: promptText,
        interaction: turn.interaction,
        scene: turn.scene,
        validation: turn.validation,
      })
      report.comprehension = comprehension.identity
    } catch (error) {
      report.status = 'failed'
      report.diagnostics.push({
        stage: 'comprehension',
        code: 'comprehension-failed',
        message: describeError(error),
      })
      return report
    }

    /* ---- Organization ------------------------------------------------- */
    let plan: Plan
    try {
      plan = this.deps.organization.organize(comprehension.identity)
      report.plan = plan.identity
      report.organization = this.deps.organization.forPlan(plan.identity)?.identity
      if (profile.requirePlan) policy.applied.push('requirePlan')
    } catch (error) {
      report.status = 'failed'
      report.diagnostics.push({
        stage: 'organization',
        code: 'organization-failed',
        message: describeError(error),
      })
      return report
    }

    /* ---- Plan score --------------------------------------------------- */
    try {
      const score = this.deps.plan.score(plan.identity)
      const threshold = this.deps.plan.threshold(plan.identity)
      report.score = { total: score.total, pass: score.pass, failing: score.failing, threshold }
      if (profile.requireScore) policy.applied.push('requireScore')
      if (!score.pass) {
        report.diagnostics.push({
          stage: 'plan',
          code: 'plan-below-threshold',
          message: `plan ${plan.identity} scored ${score.total} below the ${threshold} threshold (${score.failing.join(', ') || 'no failing dimension listed'})`,
        })
      }
      // `plan.ts` already applies the writing threshold; a scene-only threshold
      // has no reader yet and is reported, not silently claimed.
      if (Math.abs(profile.scoreThreshold - threshold) < 1e-9) policy.applied.push('scoreThreshold')
      else {
        this.defer(
          policy,
          report,
          'scoreThreshold',
          `plan.ts applies ${threshold} for this scene; config.scenes.${turn.scene}.scoreThreshold is ${profile.scoreThreshold} (only writing is wired)`,
        )
      }
    } catch (error) {
      report.status = 'failed'
      report.diagnostics.push({ stage: 'plan', code: 'plan-score-failed', message: describeError(error) })
      return report
    }

    /* ---- Content requirements: outline, revision ---------------------- */
    const parsed = decodePlanStep(plan.step)
    const stepTexts = [
      ...parsed.steps.map((step) => step.step),
      ...parsed.drafts.map((draft) => draft.task),
    ]
    if (profile.requireOutline) {
      if (stepTexts.some((text) => text.includes(WritingStageMarkers.outline))) policy.applied.push('requireOutline')
      else this.defer(policy, report, 'requireOutline', 'the composed plan has no outline (大纲) step')
    }
    if (profile.requireRevision) {
      if (stepTexts.some((text) => text.includes(WritingStageMarkers.revision))) policy.applied.push('requireRevision')
      else this.defer(policy, report, 'requireRevision', 'the composed plan has no revision (修订) step')
    }

    /* ---- requirePredict: persist one prediction row ------------------- */
    if (profile.requirePredict) {
      const stepLabel = parsed.steps[0]?.step ?? parsed.drafts[0]?.task
      if (stepLabel === undefined) {
        this.defer(policy, report, 'requirePredict', 'the composed plan has no step to predict')
      } else {
        try {
          const prediction = this.deps.predict.predict(plan.identity, stepLabel)
          report.predict = prediction.identity
          policy.applied.push('requirePredict')
        } catch (error) {
          report.diagnostics.push({
            stage: 'predict',
            code: 'predict-failed',
            message: describeError(error),
          })
          this.defer(policy, report, 'requirePredict', 'the prediction row could not be written')
        }
      }
    }

    /* ---- requireCitation: evidence is a comprehension fact ------------ */
    if (profile.requireCitation) {
      if (evidenceCount(comprehension.evidence) > 0) policy.applied.push('requireCitation')
      else {
        this.defer(
          policy,
          report,
          'requireCitation',
          'the comprehension produced no evidence; no citation can be attached without a result to cite',
        )
      }
    }

    /* ---- sandboxOnly: verify through the read-only sandbox port ------- */
    if (profile.sandboxOnly) {
      const port = this.deps.host.sandboxPolicy
      if (port === undefined) {
        this.defer(policy, report, 'sandboxOnly', 'no sandbox policy port is present; the current mode cannot be verified')
      } else {
        try {
          const session = this.deps.rawSession?.(sessionId)
          const view = port.resolve(session === undefined ? undefined : { session })
          if (view.mode === 'danger-full-access') {
            this.defer(policy, report, 'sandboxOnly', `the current sandbox mode is "${view.mode}"`)
          } else {
            policy.applied.push('sandboxOnly')
          }
        } catch (error) {
          this.defer(policy, report, 'sandboxOnly', describeError(error))
        }
      }
    }

    return report
  }

  /** Record one policy gap in both the report's policy view and diagnostics. */
  private defer(
    policy: ScenePolicyReport,
    report: TurnPipelineReport,
    field: keyof SceneProfile,
    reason: string,
  ): void {
    policy.deferred.push({ field, reason })
    report.diagnostics.push({ stage: 'policy', code: `scene-policy.deferred.${field}`, message: reason })
  }

  /** The persisted prompt text; the turn row is authoritative over the caller. */
  private promptContent(identity: number): string {
    const row = this.deps.host.db.get<{ content?: unknown }>(
      'SELECT content FROM prompt WHERE identity = ?',
      identity,
    )
    return typeof row?.content === 'string' ? row.content : ''
  }
}

/** A report for a pipeline that threw outside the per-stage guards. */
function failedPipelineReport(turn: Turn, config: CoordinationConfig, error: unknown): TurnPipelineReport {
  const profile = resolveSceneProfile(config, turn.scene)
  return {
    turn: turn.identity,
    command: turn.command,
    scene: turn.scene,
    status: 'failed',
    policy: { scene: turn.scene, profile, effort: turn.effort, applied: [], deferred: [] },
    diagnostics: [{ stage: 'pipeline', code: 'pipeline-failed', message: describeError(error) }],
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  return String(error)
}

function evidenceCount(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed.filter((entry) => typeof entry === 'string' && entry.trim() !== '').length
    }
    return typeof parsed === 'string' && parsed.trim() !== '' ? 1 : 0
  } catch {
    return 1
  }
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback
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
  readonly comprehension: ComprehensionModule
  readonly organization: OrganizationModule
  readonly predict: PredictModule
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
  /** In-flight deterministic pipelines, one per DSH session. */
  private readonly pipelines = new Map<string, { dshTurn: number; promise: Promise<TurnPipelineReport> }>()
  /** The latest settled report, kept for diagnostics and tests. */
  private readonly pipelineReports = new Map<string, { dshTurn: number; report: TurnPipelineReport }>()
  private readonly offlineComprehension: ComprehensionModule
  private readonly turnPipeline: TurnPipeline
  private readonly runtime: DshRuntime
  private disposed = false
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
    this.comprehension = new ComprehensionModule(this.host)
    this.offlineComprehension = new ComprehensionModule(this.host, NoSearchPolicy)
    this.organization = new OrganizationModule(this.host)
    this.predict = new PredictModule(this.host)
    this.turnPipeline = new TurnPipeline({
      host: this.host,
      comprehension: this.comprehension,
      offlineComprehension: this.offlineComprehension,
      organization: this.organization,
      plan: this.plan,
      predict: this.predict,
      rawSession: (sessionId: string) => this.runtime.rawSession(sessionId),
    })
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
    const scene = resolveSceneProfile(this.config, selection.scene)
    const turn = this.turn.create(session.identity, {
      content: promptText,
      profession: selection.profession,
      interaction: selection.interaction,
      scene: selection.scene,
      validation: selection.validation,
      command: 'none',
      // The scene's reasoning effort is seeded on the turn here; it is the only
      // execution-shaped scene knob the host can persist (see `TurnPipeline`).
      effort: scene.reasoningEffort,
    })
    this.dshTurns.set(sessionId, { dshTurn, identity: turn.identity })
    if (promptText.trim().length > 0) {
      try {
        await this.command.execute(turn.identity, promptText)
      } catch {
        // A command face never breaks the agent turn; the command row records the refusal.
      }
    }
    const current = this.turn.get(turn.identity)
    this.schedulePipeline(sessionId, dshTurn, current)
    return current
  }

  /**
   * Schedule the deterministic pipeline for one turn.
   *
   * Never awaited by `beginTurn`: the agent step proceeds immediately and a
   * slow comprehension search or a failed stage only lands in the report. The
   * map keeps at most one in-flight run per DSH session, so repeated steps do
   * not accumulate tasks.
   */
  private schedulePipeline(sessionId: string, dshTurn: number, turn: Turn): void {
    if (this.disposed) return
    const prompt = this.promptContent(turn.prompt)
    const promise = this.turnPipeline
      .run(turn, prompt, sessionId)
      .catch((error: unknown) => failedPipelineReport(turn, this.config, error))
    this.pipelines.set(sessionId, { dshTurn, promise })
    void promise
      .then((report) => {
        if (this.disposed) return
        // Keep only in-flight runs in `pipelines`; the settled copy lives in
        // the bounded report map below.
        if (this.pipelines.get(sessionId)?.promise === promise) this.pipelines.delete(sessionId)
        this.rememberPipelineReport(sessionId, { dshTurn, report })
        this.recordPipelineDiagnostics(report)
      })
      .catch(() => {
        // `run` is total; this guard only protects the observer.
      })
  }

  /** Store the latest report per session, evicting the oldest settlement. */
  private rememberPipelineReport(
    sessionId: string,
    entry: { dshTurn: number; report: TurnPipelineReport },
  ): void {
    // Re-insert so an active session moves to the newest position.
    this.pipelineReports.delete(sessionId)
    this.pipelineReports.set(sessionId, entry)
    while (this.pipelineReports.size > PipelineReportCapacity) {
      const oldest = this.pipelineReports.keys().next().value
      if (oldest === undefined) break
      this.pipelineReports.delete(oldest)
    }
  }

  /**
   * Log the pipeline outcomes that a human may need to act on.
   *
   * There is no pipeline/diagnostic table in schema 23, so the durable record is
   * the log line plus the `pipeline/report` event; the report itself is kept in
   * the bounded in-memory map for the service lifetime.
   */
  private recordPipelineDiagnostics(report: TurnPipelineReport): void {
    const logger = this.host.logger
    for (const diagnostic of report.diagnostics) {
      const message = `deepseek-coordination pipeline: ${diagnostic.code}: ${diagnostic.message}`
      if (report.status === 'failed' || diagnostic.code.endsWith('missing')) logger?.warn(message)
      else logger?.debug(message)
    }
    this.host.events.emit('pipeline/report', report)
  }

  /** Await the in-flight pipeline of one DSH turn (tests/diagnostics only). */
  async awaitPipeline(sessionId: string, dshTurn?: number): Promise<TurnPipelineReport | undefined> {
    const pending = this.pipelines.get(sessionId)
    if (pending !== undefined && (dshTurn === undefined || pending.dshTurn === dshTurn)) {
      return await pending.promise
    }
    const settled = this.pipelineReports.get(sessionId)
    if (settled !== undefined && (dshTurn === undefined || settled.dshTurn === dshTurn)) return settled.report
    return undefined
  }

  /** The latest settled pipeline report of one session, if any. */
  lastPipeline(sessionId: string, dshTurn?: number): TurnPipelineReport | undefined {
    const settled = this.pipelineReports.get(sessionId)
    if (settled === undefined) return undefined
    return dshTurn === undefined || settled.dshTurn === dshTurn ? settled.report : undefined
  }

  /** The persisted prompt text of a turn; `''` when the row is absent. */
  private promptContent(identity: number | undefined): string {
    if (identity === undefined) return ''
    const row = this.db.get<{ content?: unknown }>('SELECT content FROM prompt WHERE identity = ?', identity)
    return typeof row?.content === 'string' ? row.content : ''
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
    this.disposed = true
    this.compactionState.clear()
    this.dshTurns.clear()
    this.pipelines.clear()
    this.pipelineReports.clear()
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
