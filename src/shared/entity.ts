/**
 * Domain entities of the coordination database.
 *
 * The shapes mirror design document v23 §11. Identifiers are SQLite integer
 * primary keys named `identity`; public identifiers are `handle`. Timestamps
 * are Unix milliseconds. A `?` marks a column that is absent until the
 * corresponding lifecycle step commits.
 */
import type {
  CommandType,
  Interaction,
  PlanMode,
  PlanStatus,
  Profession,
  ProfessionStatus,
  RecoverySuggestion,
  ResourceKind,
  Scene,
  ScoreCategory,
  StageName,
  StageStatus,
  SubTaskStatus,
  TakeoverStatus,
  TakeoverType,
  TraceEvent,
  TurnStatus,
  Validation,
  Verdict,
} from './enum.js'

export type Identity = number
export type Handle = string
export type Timestamp = number

/** One conversation scope owned by a DSH session. */
export interface Session {
  identity: Identity
  handle: Handle
  principal: string
  sandbox: string
  interaction: Interaction
  scene: Scene
  validation: Validation
  profile: string
  generation: number
  status: 'active' | 'ended'
  created: Timestamp
  ended?: Timestamp
}

/** One user prompt as accepted into a turn. */
export interface Prompt {
  identity: Identity
  handle: Handle
  turn: Identity
  content: string
  media?: string
  created: Timestamp
}

/** One command face attached to a turn. */
export interface Command {
  identity: Identity
  handle: Handle
  turn: Identity
  type: CommandType
  content: string
  result?: string
  created: Timestamp
  finished?: Timestamp
}

/** One turn of a session. */
export interface Turn {
  identity: Identity
  handle: Handle
  session: Identity
  ordinal: number
  prompt?: Identity
  command: CommandType
  comprehension?: Identity
  organization?: Identity
  plan?: Identity
  goal?: Identity
  compact?: Identity
  interaction: Interaction
  scene: Scene
  validation: Validation

  /** The single locked profession of this task (the parent agent in orchestration). */
  profession: Profession
  locked: boolean
  lockedAt?: Timestamp

  cognitive?: string
  effort: string
  iteration: number
  rebuild: number
  status: TurnStatus
  created: Timestamp
  finished?: Timestamp
}

/** A persistent goal attached to a turn/session. */
export interface Goal {
  identity: Identity
  handle: Handle
  turn: Identity
  session: Identity
  content: string
  status: 'set' | 'updated' | 'viewed' | 'cleared'
  reason?: string
  created: Timestamp
  changed?: Timestamp
}

/** One context compaction. */
export interface Compact {
  identity: Identity
  handle: Handle
  turn: Identity
  session: Identity
  before: string
  after: string
  beforeSize: number
  afterSize: number
  ratio: number
  strategy: 'summary' | 'prune' | 'hybrid'
  reason?: string
  created: Timestamp
}

/** One goal plan produced by Organization. */
export interface Plan {
  identity: Identity
  handle: Handle
  turn: Identity
  parent?: Identity
  goal: string
  approach: string
  step: string
  constraint: string
  assumption: string
  status: PlanStatus
  rebuild: number
  mode: PlanMode
  orchestration: boolean
  created: Timestamp
  finished?: Timestamp
}

/** One plan rebuild attempt. */
export interface PlanRebuild {
  identity: Identity
  handle: Handle
  plan: Identity
  attempt: number
  reason: string
  dimension: string
  beforeScore: string
  afterScore: string
  created: Timestamp
}

/** The profession record for one task: one turn, or one subtask. */
export interface ProfessionRecord {
  identity: Identity
  handle: Handle
  turn: Identity
  subtask?: Identity
  actor: string
  profession: Profession
  locked: boolean
  lockedAt?: Timestamp
  status: ProfessionStatus
  input?: string
  output?: string
  reason?: string
  created: Timestamp
  finished?: Timestamp
}

/** The recovery packet a verifier produces after a failed verification. */
export interface RecoveryPacket {
  failedCriteria: string
  cause: string
  suggestion: RecoverySuggestion
  detail?: string
}

/** One orchestrated subtask. */
export interface SubTask {
  identity: Identity
  handle: Handle
  parent: Identity
  model: string
  effort: string
  task: string
  tools: string[]
  context: string
  acceptance: string
  groundTruth?: string

  profession: Profession
  locked: boolean
  lockedAt?: Timestamp

  blockedBy: number[]
  status: SubTaskStatus
  result?: string
  evidence?: string
  verdict?: Verdict
  reason?: string
  recovery?: RecoveryPacket
  rejectCount: number
  supersedes?: Identity
  created: Timestamp
  finished?: Timestamp
}

/** One append-only governance event. */
export interface OrchestrationTrace {
  identity: Identity
  handle: Handle
  turn: Identity
  event: TraceEvent
  subtask?: Identity
  actor: string
  profession?: Profession
  parentEvent?: Identity
  detail: string
  hash: string
  created: Timestamp
}

/** The four-stage comprehension result. */
export interface Comprehension {
  identity: Identity
  handle: Handle
  turn: Identity
  prompt: Identity
  intent: string
  requirement: string
  constraint: string
  assumption: string
  ambiguity: string
  confidence: number
  entropy?: number

  emotion?: number
  empathy?: string
  think?: string
  probe?: number
  evidence?: string
  constraintIds?: string
  boundary?: string
  prospect?: string
  posterior?: string
  fusion?: string
  refusal?: number
  route?: string
  failure?: string

  stageCount: number
  thinkTrace?: string
  model?: string
  created: Timestamp
  finished?: Timestamp
}

/** One comprehension stage record. */
export interface ComprehensionStageRecord {
  identity: Identity
  handle: Handle
  comprehension: Identity
  stage: StageName
  ordinal: number
  status: StageStatus
  input?: string
  output?: string
  confidence?: number
  entropyBefore?: number
  entropyAfter?: number
  created: Timestamp
  finished?: Timestamp
}

/** Organization: the bridge from comprehension to a plan. */
export interface Organization {
  identity: Identity
  handle: Handle
  turn: Identity
  comprehension: Identity
  plan: Identity
  goal: string
  approach: string
  step: string
  constraint: string
  assumption: string
  model?: string
  created: Timestamp
  finished?: Timestamp
}

/** One dimension score. */
export interface Score {
  identity: Identity
  handle: Handle
  category: ScoreCategory
  target: Identity
  dimension: string
  value: number
  reason?: string
  model?: string
  created: Timestamp
}

/* ------------------------------------------------------------------------- *
 * Model view (read-only projection of DSH ctx.llm)
 * ------------------------------------------------------------------------- */

export interface ModelCapability {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  input: string[]
  reasoningEfforts?: string[]
  compat?: Record<string, unknown>
}

export interface CacheStrategy {
  effortCacheBreak: boolean
  reasoningPreserve: boolean
  configUpdateParam?: string
}

export interface ProviderView {
  route: string
  title: string
  live: boolean
  source: 'base' | 'plugin' | 'user'
  models: ModelCapability[]
  cacheStrategy?: CacheStrategy
  notes?: string
  observed: Timestamp
}

/* ------------------------------------------------------------------------- *
 * Execution and learning entities
 * ------------------------------------------------------------------------- */

export interface Predict {
  identity: Identity
  handle: Handle
  turn: Identity
  plan: Identity
  step: string
  content: string
  created: Timestamp
}

export interface Reality {
  identity: Identity
  handle: Handle
  turn: Identity
  predict: Identity
  content: string
  created: Timestamp
}

export interface Action {
  identity: Identity
  handle: Handle
  turn: Identity
  plan: Identity
  kind: string
  content: string
  status: 'pending' | 'running' | 'done' | 'failed'
  created: Timestamp
  finished?: Timestamp
}

export interface Answer {
  identity: Identity
  handle: Handle
  turn: Identity
  content: string
  validation: Validation
  created: Timestamp
}

export interface Question {
  identity: Identity
  handle: Handle
  turn: Identity
  content: string
  answer?: string
  created: Timestamp
  finished?: Timestamp
}

export interface Choice {
  identity: Identity
  handle: Handle
  turn: Identity
  question: Identity
  option: string
  selected: boolean
  created: Timestamp
}

export interface ErrorRecord {
  identity: Identity
  handle: Handle
  turn: Identity
  category: string
  message: string
  stack?: string
  created: Timestamp
}

export interface Pattern {
  identity: Identity
  handle: Handle
  kind: string
  signature: string
  content: string
  weight: number
  created: Timestamp
}

export interface Calibration {
  identity: Identity
  handle: Handle
  model: string
  dimension: string
  predicted: number
  actual: number
  score: number
  created: Timestamp
}

export interface Lesson {
  identity: Identity
  handle: Handle
  pattern: Identity
  content: string
  created: Timestamp
}

export interface Rollback {
  identity: Identity
  handle: Handle
  error: Identity
  target: string
  reason: string
  created: Timestamp
}

export interface Emotion {
  identity: Identity
  handle: Handle
  turn: Identity
  label: string
  intensity: number
  empathy?: string
  created: Timestamp
}

export interface Companion {
  identity: Identity
  handle: Handle
  session: Identity
  emotion: Identity
  response: string
  created: Timestamp
}

export interface Crisis {
  identity: Identity
  handle: Handle
  turn: Identity
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical'
  signal: string
  action: string
  created: Timestamp
}

export interface Probe {
  identity: Identity
  handle: Handle
  turn: Identity
  entropy: number
  question: string
  created: Timestamp
}

export interface Cognition {
  identity: Identity
  handle: Handle
  turn: Identity
  stage: string
  strategy: string
  content: string
  created: Timestamp
}

export interface Evidence {
  identity: Identity
  handle: Handle
  turn: Identity
  source: string
  content: string
  weight: number
  created: Timestamp
}

export interface Constraint {
  identity: Identity
  handle: Handle
  turn: Identity
  content: string
  kind: string
  created: Timestamp
}

export interface Gate {
  identity: Identity
  handle: Handle
  turn: Identity
  decision: 'allow' | 'deny' | 'ask'
  reason: string
  created: Timestamp
}

export interface Stopping {
  identity: Identity
  handle: Handle
  turn: Identity
  criterion: string
  value: number
  reached: boolean
  created: Timestamp
}

export interface Prior {
  identity: Identity
  handle: Handle
  turn: Identity
  hypothesis: string
  probability: number
  source: string
  created: Timestamp
}

export interface Boundary {
  identity: Identity
  handle: Handle
  turn: Identity
  failureRoute: Identity
  content: string
  created: Timestamp
}

export interface Prospect {
  identity: Identity
  handle: Handle
  turn: Identity
  route: Identity
  probability: number
  created: Timestamp
}

export interface Posterior {
  identity: Identity
  handle: Handle
  turn: Identity
  hypothesis: string
  probability: number
  created: Timestamp
}

export interface Likelihood {
  identity: Identity
  handle: Handle
  evidence: Identity
  hypothesis: string
  probability: number
  weight: number
  created: Timestamp
}

export interface Fusion {
  identity: Identity
  handle: Handle
  turn: Identity
  content: string
  probability: number
  created: Timestamp
}

export interface Refusal {
  identity: Identity
  handle: Handle
  turn: Identity
  reason: string
  created: Timestamp
}

export interface Directive {
  identity: Identity
  handle: Handle
  turn: Identity
  content: string
  status: 'pending' | 'applied' | 'rejected'
  created: Timestamp
  finished?: Timestamp
}

export interface Route {
  identity: Identity
  handle: Handle
  turn: Identity
  name: string
  description: string
  probability: number
  rank: number
  created: Timestamp
}

export interface FailureRoute {
  identity: Identity
  handle: Handle
  turn: Identity
  name: string
  description: string
  probability: number
  rank: number
  created: Timestamp
}

export interface ModeState {
  identity: Identity
  handle: Handle
  turn: Identity
  mode: string
  content: string
  created: Timestamp
}

export interface History {
  identity: Identity
  handle: Handle
  session: Identity
  kind: string
  content: string
  created: Timestamp
}

export interface GlobalPosterior {
  identity: Identity
  handle: Handle
  hypothesis: string
  probability: number
  scope: string
  created: Timestamp
}

/* ------------------------------------------------------------------------- *
 * Resource, permission, takeover
 * ------------------------------------------------------------------------- */

export interface Resource {
  identity: Identity
  handle: Handle
  session: Identity
  kind: ResourceKind
  path: string
  media?: string
  bytes: number
  created: Timestamp
  changed: Timestamp
}

export interface Version {
  identity: Identity
  handle: Handle
  resource: Identity
  version: number
  content: string
  author: string
  created: Timestamp
}

export interface ResourceVision {
  identity: Identity
  handle: Handle
  session: Identity
  resource: Identity
  version: Identity
  created: Timestamp
}

export interface Lock {
  identity: Identity
  handle: Handle
  session: Identity
  subject: string
  mode: 'exclusive' | 'shared'
  lease: number
  heartbeat: Timestamp
  created: Timestamp
  ended?: Timestamp
}

export interface Request {
  identity: Identity
  handle: Handle
  session: Identity
  thread?: Identity
  method: string
  payload: string
  status: 'pending' | 'done' | 'failed'
  created: Timestamp
  finished?: Timestamp
}

export interface Thread {
  identity: Identity
  handle: Handle
  session: Identity
  name: string
  status: 'active' | 'ended'
  created: Timestamp
  ended?: Timestamp
}

export interface Result {
  identity: Identity
  handle: Handle
  request: Identity
  status: 'ok' | 'error'
  content: string
  created: Timestamp
}

export interface Takeover {
  identity: Identity
  handle: Handle
  session?: Identity
  type: TakeoverType
  payload: string
  status: TakeoverStatus
  result?: string
  created: Timestamp
  finished?: Timestamp
}

export interface PermissionRule {
  identity: Identity
  handle: Handle
  session: Identity
  subject: string
  grant: string
  reason?: string
  status: 'granted' | 'revoked'
  created: Timestamp
  finished?: Timestamp
}

/* ------------------------------------------------------------------------- *
 * Command / result value shapes
 * ------------------------------------------------------------------------- */

export interface CommandResult {
  command: Command
  action: 'accepted' | 'rejected' | 'pending'
  message?: string
}

export interface GoalResult {
  goal: Goal
  plan?: Plan
  rescored: boolean
}

export interface CompactResult {
  compact: Compact
  cacheBroken: boolean
}

export interface PlanResult {
  plan: Plan
  score?: number
  scores: Score[]
  rebuilt: boolean
}

export interface OrchestrationResult {
  turn: Turn
  subtasks: SubTask[]
  answer?: Answer
  trace: OrchestrationTrace[]
}

export interface CheckResult {
  allowed: boolean
  reason?: string
}

export interface RequestResult {
  allowed: boolean
  takeover?: Takeover
  reason?: string
}

export interface PermissionResult {
  allowed: boolean
  reason?: string
  takeover?: Takeover
}

export interface MergeResult {
  version: Version
  conflicts: string[]
}

export type MergeStrategy = 'ours' | 'theirs' | 'manual'

export interface ProgressInvariant {
  ok: boolean
  reason: string
  entropy: number
  score: number
  iteration: number
}

export interface RecoveryDecision {
  suggestion: RecoverySuggestion
  detail?: string
  criteria?: string
}

export interface CoordinationMetrics {
  session: number
  turn: number
  plan: number
  subtask: number
  trace: number
  takeover: number
  database: string
  schema: number
}

/** The UI's pending choice for the next prompt of one session. */
export interface Selection {
  session: string
  profession: Profession
  interaction: Interaction
  scene: Scene
  validation: Validation
  command: CommandType
  locked: boolean
  changed: Timestamp
}

/** Alias used where a DSH `Session` type would otherwise collide. */
export type CoordinationSession = Session
