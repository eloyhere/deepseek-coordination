/**
 * The complete public service contract (v23 §18.1).
 *
 * `CoordinationService` implements this interface on the Host; tools, the
 * Client RPC, and other plugins consume it through `ctx.coordination`. The
 * interface deliberately imports no DSH type: the Client bundle and tests can
 * type-check it without a Node-only dependency.
 */
import type {
  Action,
  Answer,
  Boundary,
  CacheStrategy,
  Calibration,
  Choice,
  Cognition,
  Command,
  CommandResult,
  Compact,
  CompactResult,
  Comprehension,
  ComprehensionStageRecord,
  CoordinationMetrics,
  Crisis,
  Directive,
  Emotion,
  ErrorRecord,
  FailureRoute,
  Fusion,
  Gate,
  Goal,
  GoalResult,
  GlobalPosterior,
  History,
  Lesson,
  Likelihood,
  MergeResult,
  MergeStrategy,
  ModeState,
  ModelCapability,
  OrchestrationResult,
  OrchestrationTrace,
  Pattern,
  PermissionResult,
  Plan,
  PlanRebuild,
  PlanResult,
  Posterior,
  Predict,
  Prior,
  Probe,
  ProfessionRecord,
  ProgressInvariant,
  Prospect,
  ProviderView,
  Question,
  Reality,
  RecoveryDecision,
  Refusal,
  RequestResult,
  Resource,
  ResourceVision,
  Result,
  Rollback,
  Route,
  Score,
  Selection,
  Session,
  Stopping,
  SubTask,
  Takeover,
  Turn,
  Version,
} from './entity.js'
import type {
  CommandType,
  Interaction,
  PlanMode,
  Profession,
  Scene,
  ScoreCategory,
  StageName,
  TakeoverType,
  Validation,
} from './enum.js'

export interface MessageLike {
  role: string
  content: unknown
  [key: string]: unknown
}

export interface GenerateOptionsLike {
  provider?: string
  model?: string
  messages: MessageLike[]
  system?: string
  reasoningEffort?: string
  maxTokens?: number
  [key: string]: unknown
}

export interface ComprehensionContext {
  session?: string
  scene?: Scene
  validation?: Validation
  history?: readonly string[]
  evidence?: readonly string[]
}

export interface EmotionStageOutput {
  label: string
  intensity: number
  empathy: string
  crisis?: string
}

export interface ThinkStageOutput {
  reasoning: string
  intent: string
  requirement: string
  constraint: string
  assumption: string
  ambiguity: string
  confidence: number
}

export interface RouteCandidate {
  name: string
  description: string
  probability: number
}

export interface HeuristicStageOutput {
  routes: RouteCandidate[]
  evidence: string[]
  best: string
  confidence: number
  entropy: number
}

export interface ConvergeStageOutput {
  failures: RouteCandidate[]
  boundary: string
  evidence: string[]
  confidence: number
  entropy: number
  stop: boolean
}

export interface LowOutput {
  turn: Turn
  interaction: Interaction
  answer?: Answer
  reason: string
}

export interface MediumOutput {
  turn: Turn
  posterior: Posterior[]
  routes: Route[]
  stopping: Stopping
}

export interface GlobalOutput {
  turn: Turn
  posteriors: GlobalPosterior[]
  fusion: Fusion[]
  stopping: Stopping
}

export interface EmpathyProfile {
  tone: string
  pace: string
  boundary: string
}

export interface ErrorRemedy {
  action: 'retry' | 'revise' | 'rollback' | 'escalate' | 'learn'
  reason: string
}

export interface CacheStats {
  totalRequests: number
  cacheHits: number
  cacheMisses: number
  hitRate: number
  estimatedSavings: number
  effortBreaks: number
}

export interface TakeoverPayload {
  title?: string
  message?: string
  fields?: readonly string[]
  current?: string
  requested?: string
  [key: string]: unknown
}

export interface TakeoverResult {
  accepted: boolean
  value?: unknown
  reason?: string
}

export interface OrchestrationTraceVerification {
  ok: boolean
  brokenAt?: number
  reason?: string
}

/** The contract every consumer sees. */
export interface CoordinationService {
  // Profession lock
  selectProfession(turn: number, profession: Profession): Promise<Turn>
  checkProfessionLock(turn: number): Promise<boolean>
  rebuildTurn(turn: number, profession: Profession): Promise<Turn>
  abandonTurn(turn: number): Promise<Turn>
  rebuildSubTask(subtask: number, profession: Profession): Promise<SubTask>
  abandonSubTask(subtask: number): Promise<SubTask>
  getProfessionRecord(turn: number): Promise<ProfessionRecord>
  listProfessionRecord(session: number): Promise<ProfessionRecord[]>

  // Provider view (read-only projection of ctx.llm)
  listProviderView(): Promise<ProviderView[]>
  resolveProviderView(route: string): Promise<ProviderView>
  listModelCapability(route: string): Promise<ModelCapability[]>
  getCacheStrategy(route: string): Promise<CacheStrategy | undefined>

  // Orchestration
  orchestrate(turn: number): Promise<OrchestrationResult>
  decompose(plan: number): Promise<SubTask[]>
  dispatch(subtask: number): Promise<SubTask>
  submit(subtask: number, result: string, evidence: string): Promise<SubTask>
  verify(subtask: number, verifier: string): Promise<SubTask>
  recover(subtask: number, decision: RecoveryDecision): Promise<SubTask>
  synthesize(turn: number): Promise<Answer>
  trace(turn: number): Promise<OrchestrationTrace[]>
  verifyTrace(turn: number): Promise<OrchestrationTraceVerification>

  // Commands and modules
  executeCommand(command: Command): Promise<CommandResult>
  resolveCommand(turn: number): Promise<Command>
  executeGoal(goal: Goal): Promise<GoalResult>
  getGoal(turn: number): Promise<Goal>
  setGoal(turn: number, content: string): Promise<Goal>
  updateGoal(turn: number, content: string): Promise<Goal>
  clearGoal(turn: number): Promise<Goal>
  executePlan(plan: Plan, mode: PlanMode): Promise<PlanResult>
  getPlan(turn: number): Promise<Plan>
  updatePlan(turn: number, patch: Partial<Plan>): Promise<Plan>
  rescorePlan(turn: number): Promise<Score[]>
  executeCompact(compact: Compact): Promise<CompactResult>
  compress(session: number, strategy: 'summary' | 'prune' | 'hybrid'): Promise<Compact>
  executeFeedback(turn: number, content: string): Promise<Directive>
  executePermission(turn: number, content: string): Promise<PermissionResult>

  // Comprehension
  comprehend(prompt: string, context?: ComprehensionContext): Promise<Comprehension>
  runComprehensionStage(comprehension: number, stage: StageName): Promise<ComprehensionStageRecord>
  emotionStage(prompt: string, context?: ComprehensionContext): Promise<EmotionStageOutput>
  thinkStage(prompt: string, emotion: EmotionStageOutput): Promise<ThinkStageOutput>
  heuristicStage(prompt: string, think: ThinkStageOutput): Promise<HeuristicStageOutput>
  convergeStage(prompt: string, heuristic: HeuristicStageOutput): Promise<ConvergeStageOutput>

  // Organization and plan
  organize(comprehension: number): Promise<Plan>
  createPlan(turn: number, comprehension: number): Promise<Plan>
  scorePlan(plan: number): Promise<Score[]>
  computePlanScore(plan: number): Promise<number>
  shouldRebuild(plan: number): Promise<boolean>
  rebuildPlan(plan: number): Promise<Plan>
  recordRebuild(
    plan: number,
    attempt: number,
    reason: string,
    dimension: string,
    before: string,
    after: string,
  ): Promise<PlanRebuild>

  // Profession matrix
  recordProfession(
    turn: number,
    profession: Profession,
    actor: string,
    status: string,
  ): Promise<ProfessionRecord>
  checkQualification(turn: number, route: string): Promise<boolean>
  checkDecision(turn: number): Promise<boolean>
  checkPersonnel(turn: number): Promise<boolean>

  // Validation levels
  executeLow(turn: number): Promise<LowOutput>
  executeMedium(turn: number): Promise<MediumOutput>
  executeHigh(turn: number): Promise<GlobalOutput>

  // Bayesian engine
  definePrior(turn: number, hypothesis: string, source: string): Promise<Prior>
  computeLikelihood(evidence: number, hypothesis: string, weight: number): Promise<Likelihood>
  updatePosterior(turn: number, hypothesis: string, evidence: number): Promise<Posterior>
  computeEIG(turn: number, candidate: string): Promise<number>
  defineRoute(turn: number, name: string, description: string): Promise<Route>
  rankRoute(turn: number): Promise<Route[]>
  selectRoute(turn: number): Promise<Route>
  defineFailureRoute(turn: number, name: string, description: string): Promise<FailureRoute>
  rankFailureRoute(turn: number): Promise<FailureRoute[]>
  computeBoundary(turn: number, failureRoute: number): Promise<Boundary>
  shouldStop(turn: number): Promise<boolean>
  checkProgressInvariant(turn: number): Promise<ProgressInvariant>
  calibrate(model: string, dimension: string): Promise<Calibration>

  // Takeover
  shouldTakeover(type: TakeoverType): Promise<boolean>
  requestTakeover(type: TakeoverType, payload: TakeoverPayload): Promise<TakeoverResult>
  resolveTakeover(handle: string, result: TakeoverResult): Promise<void>
  cancelTakeover(handle: string): Promise<void>
  getTakeover(handle: string): Promise<Takeover>
  listTakeover(session: number): Promise<Takeover[]>

  // Cognitive orchestration
  orchestrateStage(turn: number, stage: string): Promise<Cognition>
  probe(turn: number, entropy: number): Promise<Probe>

  // Cache optimisation
  decorateRequest(options: GenerateOptionsLike, strategy: CacheStrategy): Promise<GenerateOptionsLike>
  reorderMessages(messages: MessageLike[], strategy: CacheStrategy): MessageLike[]
  stripDynamicContent(text: string): string
  fingerprint(messages: MessageLike[]): string
  checkEffortCacheBreak(session: number, newEffort: string): boolean
  getCacheStats(session: number): CacheStats

  // Prediction and execution
  predict(plan: number, step: string): Promise<Predict>
  compare(predict: number, reality: number): Promise<number>

  // Emotion
  detectEmotion(turn: number): Promise<Emotion>
  calibrateEmpathy(emotion: Emotion): Promise<EmpathyProfile>
  detectCrisis(turn: number): Promise<Crisis | null>

  // Learning
  classify(error: number): Promise<ErrorRecord>
  decideRemedy(error: number): Promise<ErrorRemedy>
  learn(error: number): Promise<void>

  // Scoring
  score(category: ScoreCategory, target: number, dimension: string): Promise<Score>
  scoreAll(category: ScoreCategory, target: number): Promise<Score[]>

  // Resources
  resolve(handle: string): Promise<Resource>
  getVision(session: number, resource: number): Promise<ResourceVision>
  write(session: number, resource: number, content: Buffer): Promise<Version>
  merge(session: number, resource: number, strategy: MergeStrategy): Promise<MergeResult>

  // Permission
  check(subject: string, grant: string[]): Promise<RequestResult>
  request(subject: string, grant: string[], reason: string): Promise<RequestResult>
  revoke(subject: string, grant?: string[]): Promise<void>

  // Sessions, turns, selection
  ensureSession(sessionId: string, metadata?: Record<string, unknown>): Promise<Session>
  createTurn(session: number, input: CreateTurnInput): Promise<Turn>
  getTurn(turn: number): Promise<Turn>
  listTurn(session: number): Promise<Turn[]>
  getSelection(session: string): Promise<Selection>
  setSelection(session: string, patch: Partial<Selection>): Promise<Selection>

  // Lifecycle
  cleanupExpired(): Promise<void>
  metrics(): CoordinationMetrics
}

export interface CreateTurnInput {
  content: string
  profession: Profession
  interaction: Interaction
  scene: Scene
  validation: Validation
  command: CommandType
  effort?: string
  model?: string
  sessionHandle?: string
}

/* Re-export entity types for convenience at call sites that only import the
 * service contract. */
export type {
  Action,
  Answer,
  Boundary,
  Choice,
  Cognition,
  Command,
  Compact,
  Comprehension,
  Crisis,
  Directive,
  Emotion,
  FailureRoute,
  Fusion,
  Gate,
  Goal,
  GlobalPosterior,
  History,
  Lesson,
  Likelihood,
  ModeState,
  OrchestrationTrace,
  Pattern,
  Plan,
  Posterior,
  Predict,
  Prior,
  Probe,
  ProfessionRecord,
  Prospect,
  ProviderView,
  Question,
  Reality,
  Refusal,
  Resource,
  ResourceVision,
  Result,
  Rollback,
  Route,
  Score,
  Selection,
  Session,
  Stopping,
  SubTask,
  Takeover,
  Turn,
  Version,
}
