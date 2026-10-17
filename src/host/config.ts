/**
 * Plugin configuration (v23 §19, v24 scene policy) and its resolved defaults.
 *
 * The schema is the only place a deployment can tune behaviour: anything two
 * deployments could reasonably disagree about is a field here, not a constant
 * in a module. `resolveConfig` materialises every nested default so the rest of
 * the service never branches on `undefined`.
 */
import Schema, { type Schema as SchemaDefinition } from '@deepseek-ai/schemastery'
import type { CommandType, Interaction, Profession, Scene, SceneProfile, Validation } from '../shared/enum.js'
import { SceneProfiles } from '../shared/enum.js'

export interface ProfessionConfig {
  /** Forced true by the resolver; kept for schema compatibility. */
  enabled: boolean
  /** Forced true by the resolver: the lock is a core safety constraint. */
  lock: boolean
  /**
   * Documented alias of `defaults.profession`. `resolveConfig()` mirrors the
   * effective default here so neither key is dead; new deployments should set
   * `defaults.profession`.
   */
  default: Profession
  /** Forced true by the resolver: a rebuild always creates a new task. */
  rebuildCanReselect: boolean
  /** Forced true by the resolver: the next task may choose a new profession. */
  abandonCanReselect: boolean
  /**
   * Reserved: the profession module always appends its lock/rebuild/abandon
   * events to `orchestration_trace`, so this flag does not gate anything yet.
   * Kept for schema compatibility until a trace-audit policy actually exists.
   */
  audit: boolean
  /** Whether lock rejections carry the rebuild/abandon escape hatch. */
  errorHint: boolean
}

export interface PlanWeights {
  feasibility: number
  coverage: number
  clarity: number
  specificity: number
  alignment: number
  risk: number
  cost: number
  efficiency: number
}

export interface PlanDimensionThreshold {
  feasibility: number
  coverage: number
  clarity: number
  specificity: number
  alignment: number
  risk: number
  cost: number
  efficiency: number
}

export interface PlanConfig {
  threshold: number
  maxRebuild: number
  weights: PlanWeights
  dimensions: PlanDimensionThreshold
}

export interface OrchestrationConfig {
  maxReject: number
  maxSubTask: number
  groundTruth: boolean
  groundTruthTimeout: number
  allowShellGroundTruth: boolean
  modelRouting: boolean
}

export interface CacheConfig {
  enabled: boolean
  ttl: number
  fingerprintWindow: number
  effortWarning: boolean
}

/**
 * Automatic token-governor policy (v24 §5/§9.3, `src/host/token.ts`).
 *
 * This group is deliberately distinct from the `compact` table and the
 * `compact` command: those record an explicit, user-requested compaction,
 * while these thresholds tune when the governor *proposes* one. `auto: false`
 * disables only the automatic proposal; an explicit compact command still
 * runs. `soft`/`hard` are utilisation ratios against the effective window
 * (`contextWindow - reserve`), `cooldown` and `maxPerSession` bound how often
 * the host adapter may act on a proposal.
 */
export interface CompactionPolicyConfig {
  auto: boolean
  soft: number
  hard: number
  reserve: number
  recentTurns: number
  cooldown: number
  maxPerSession: number
}

export interface BayesianConfig {
  prior: number
  stopEntropy: number
  infoGain: number
  maxRoutes: number
  calibrationFloor: number
}

export interface ComprehensionConfig {
  stageTimeout: number
  searchEnabled: boolean
  maxEvidence: number
  highHistoryWindow: number
}

export interface UiConfig {
  /**
   * @deprecated Legacy alias of the composer workflow flag. It is projected as
   * `SelectionStateConfig.workflow` and kept so the schema stays compatible;
   * new deployments should not build a setting around it.
   */
  toolbar: boolean
  showTooltip: boolean
  takeover: boolean
  refreshInterval: number
  compact: boolean
  /** 'auto' follows the DSH locale; zh-CN/en-US force the host-side copy. */
  locale: string
}

/**
 * File-processing policy (v24 `docs/file-processing-v24.md` §4, domain model §7).
 *
 * The values are the documented hard caps: 1 MiB of source text, 200 000
 * tokens, AST depth 256, a 2 s parse budget, a 256-entry parse cache and the
 * 20 000 / 100 000 dependency-graph bounds. They live in the schema so a
 * deployment can tighten them in one place.
 *
 * Consumers and timing (`src/host/tools.ts`): `enabled` gates the four file
 * tools at registration time and is re-checked live (a disabled parser makes the
 * registered tools fail closed); every limit is re-applied to the lazy
 * `ToolRuntime` when the config signature changes, so a `/config` patch reaches
 * the next tool call instead of waiting for a restart. `maxAstDepth` is threaded
 * into the parser's `maxDepth` and the two dependency-graph caps bound
 * `ParseService.dependencyGraph`; all three are clamped to the parser-layer hard
 * caps. The settings catalog still marks those three keys `planned`; that is a
 * catalog flag, not a missing consumer.
 */
export interface ParserConfig {
  /** Master switch for the file tools; read at registration and on every call. */
  enabled: boolean
  /** Maximum source text in bytes; the parser truncates and marks `truncated`. */
  maxFileBytes: number
  /** Maximum tokens emitted by one parse. */
  maxTokens: number
  /** AST depth handed to the parser (`maxDepth`), capped to `MAX_AST_DEPTH`. */
  maxAstDepth: number
  /** Parse wall-clock budget in milliseconds. */
  timeoutMs: number
  /** Parse-result cache capacity in files. */
  cacheCapacity: number
  /** Dependency-graph vertex cap, capped to the parser layer's hard cap. */
  dependencyGraphMaxVertices: number
  /** Dependency-graph edge cap, capped to the parser layer's hard cap. */
  dependencyGraphMaxEdges: number
}

/**
 * Chain-projection budget (domain model §3, §7): depth ≤ 8, links ≤ 50,
 * ~1 500 tokens.
 *
 * `src/host/tools.ts` re-applies all three to the lazy `ToolRuntime` whenever the
 * file-layer config signature changes, so a live `/config` patch reaches the
 * next query while indexed handles stay valid (`ChainEngine.retune`).
 */
export interface ChainConfig {
  depth: number
  links: number
  tokenBudget: number
}

/**
 * Model-facing tool output budget. `0` means "no byte cap" (the historical
 * unbounded `renderJson`); a positive value makes `renderJson` emit a valid JSON
 * truncation envelope with an explicit marker and byte counts. The value is read
 * per render, not captured at registration, so a live `/config` change applies
 * to the very next tool result.
 */
export interface ToolConfig {
  maxResultBytes: number
}

export interface CoordinationConfig {
  database: string
  databasePath: string
  maxTurnPerSession: number
  defaultLease: number
  clarifyTimeout: number
  profession: ProfessionConfig
  plan: PlanConfig
  orchestration: OrchestrationConfig
  cache: CacheConfig
  /** Automatic token-governor thresholds; distinct from the `compact` tables. */
  compaction: CompactionPolicyConfig
  bayesian: BayesianConfig
  comprehension: ComprehensionConfig
  ui: UiConfig
  /** v24 file-processing policy (`docs/file-processing-v24.md` §4). */
  parser: ParserConfig
  /** Chain-projection budget (domain model §3); applied live by `ToolRuntime`. */
  chain: ChainConfig
  /** Model-facing tool output budget; `0` keeps the unbounded render. */
  tools: ToolConfig
  /** v24 §19: per-scene execution policy. */
  scenes: Record<Scene, SceneProfile>
  /** Defaults used when the composer sends no explicit selection. */
  defaults: {
    profession: Profession
    interaction: Interaction
    scene: Scene
    validation: Validation
    command: CommandType
  }
}

export const Config: SchemaDefinition<CoordinationConfig> = Schema.object({
  database: Schema.string().default('coordination'),
  databasePath: Schema.string().default(''),
  maxTurnPerSession: Schema.number().min(1).max(1_000_000).default(1000),
  defaultLease: Schema.number().min(1000).max(86_400_000).default(30000),
  clarifyTimeout: Schema.number().min(1000).max(600_000).default(30000),
  profession: Schema.object({
    enabled: Schema.boolean().default(true),
    lock: Schema.boolean().default(true),
    default: Schema.union(['decision', 'outcome', 'resource', 'personnel', 'qualification', 'execution']).default(
      'execution',
    ),
    rebuildCanReselect: Schema.boolean().default(true),
    abandonCanReselect: Schema.boolean().default(true),
    audit: Schema.boolean().default(true),
    errorHint: Schema.boolean().default(true),
  }).default({
    enabled: true,
    lock: true,
    default: 'execution',
    rebuildCanReselect: true,
    abandonCanReselect: true,
    audit: true,
    errorHint: true,
  }),
  plan: Schema.object({
    threshold: Schema.number().min(0).max(1).default(0.5),
    maxRebuild: Schema.number().min(0).max(100).default(3),
    weights: Schema.object({
      // 0..1 per weight; `resolveConfig` normalises the eight to sum 1.
      feasibility: Schema.number().min(0).max(1).step(0.01).default(0.15),
      coverage: Schema.number().min(0).max(1).step(0.01).default(0.15),
      clarity: Schema.number().min(0).max(1).step(0.01).default(0.1),
      specificity: Schema.number().min(0).max(1).step(0.01).default(0.1),
      alignment: Schema.number().min(0).max(1).step(0.01).default(0.2),
      risk: Schema.number().min(0).max(1).step(0.01).default(0.1),
      cost: Schema.number().min(0).max(1).step(0.01).default(0.1),
      efficiency: Schema.number().min(0).max(1).step(0.01).default(0.1),
    }).default({
      feasibility: 0.15,
      coverage: 0.15,
      clarity: 0.1,
      specificity: 0.1,
      alignment: 0.2,
      risk: 0.1,
      cost: 0.1,
      efficiency: 0.1,
    }),
    dimensions: Schema.object({
      feasibility: Schema.number().min(0).max(1).step(0.01).default(0.5),
      coverage: Schema.number().min(0).max(1).step(0.01).default(0.6),
      clarity: Schema.number().min(0).max(1).step(0.01).default(0.5),
      specificity: Schema.number().min(0).max(1).step(0.01).default(0.5),
      alignment: Schema.number().min(0).max(1).step(0.01).default(0.7),
      risk: Schema.number().min(0).max(1).step(0.01).default(0.7),
      cost: Schema.number().min(0).max(1).step(0.01).default(0.8),
      efficiency: Schema.number().min(0).max(1).step(0.01).default(0.5),
    }).default({
      feasibility: 0.5,
      coverage: 0.6,
      clarity: 0.5,
      specificity: 0.5,
      alignment: 0.7,
      risk: 0.7,
      cost: 0.8,
      efficiency: 0.5,
    }),
  }).default({
    threshold: 0.5,
    maxRebuild: 3,
    weights: {
      feasibility: 0.15,
      coverage: 0.15,
      clarity: 0.1,
      specificity: 0.1,
      alignment: 0.2,
      risk: 0.1,
      cost: 0.1,
      efficiency: 0.1,
    },
    dimensions: {
      feasibility: 0.5,
      coverage: 0.6,
      clarity: 0.5,
      specificity: 0.5,
      alignment: 0.7,
      risk: 0.7,
      cost: 0.8,
      efficiency: 0.5,
    },
  }),
  orchestration: Schema.object({
    maxReject: Schema.number().min(0).max(100).default(2),
    maxSubTask: Schema.number().min(1).max(1000).default(32),
    groundTruth: Schema.boolean().default(true),
    groundTruthTimeout: Schema.number().min(100).max(600_000).default(5000),
    allowShellGroundTruth: Schema.boolean().default(false),
    modelRouting: Schema.boolean().default(true),
  }).default({
    maxReject: 2,
    maxSubTask: 32,
    groundTruth: true,
    groundTruthTimeout: 5000,
    allowShellGroundTruth: false,
    modelRouting: true,
  }),
  cache: Schema.object({
    enabled: Schema.boolean().default(true),
    ttl: Schema.number().min(0).max(2_592_000_000).default(60000),
    fingerprintWindow: Schema.number().min(1).max(10_000).default(50),
    effortWarning: Schema.boolean().default(true),
  }).default({ enabled: true, ttl: 60000, fingerprintWindow: 50, effortWarning: true }),
  compaction: Schema.object({
    auto: Schema.boolean().default(true),
    soft: Schema.number().min(0.3).max(0.9).default(0.7),
    hard: Schema.number().min(0.3).max(0.98).default(0.88),
    reserve: Schema.number().min(512).max(10_000_000).default(2048),
    recentTurns: Schema.number().min(2).max(20).default(6),
    cooldown: Schema.number().min(5000).max(600000).default(30000),
    maxPerSession: Schema.number().min(1).max(10_000).default(20),
  }).default({
    auto: true,
    soft: 0.7,
    hard: 0.88,
    reserve: 2048,
    recentTurns: 6,
    cooldown: 30000,
    maxPerSession: 20,
  }),
  bayesian: Schema.object({
    prior: Schema.number().min(0).max(1).default(0.5),
    stopEntropy: Schema.number().min(0).max(10).default(0.05),
    infoGain: Schema.number().min(0).max(10).default(0.01),
    maxRoutes: Schema.number().min(1).max(1000).default(12),
    calibrationFloor: Schema.number().min(0).max(1).default(0.1),
  }).default({ prior: 0.5, stopEntropy: 0.05, infoGain: 0.01, maxRoutes: 12, calibrationFloor: 0.1 }),
  comprehension: Schema.object({
    stageTimeout: Schema.number().min(100).max(600_000).default(30000),
    searchEnabled: Schema.boolean().default(true),
    maxEvidence: Schema.number().min(1).max(1000).default(8),
    highHistoryWindow: Schema.number().min(0).max(100_000).default(50),
  }).default({ stageTimeout: 30000, searchEnabled: true, maxEvidence: 8, highHistoryWindow: 50 }),
  ui: Schema.object({
    toolbar: Schema.boolean().default(true),
    showTooltip: Schema.boolean().default(true),
    takeover: Schema.boolean().default(false),
    refreshInterval: Schema.number().min(500).max(86_400_000).default(5000),
    compact: Schema.boolean().default(true),
    locale: Schema.union(['auto', 'zh-CN', 'en-US']).default('auto'),
  }).default({
    toolbar: true,
    showTooltip: true,
    takeover: false,
    refreshInterval: 5000,
    compact: true,
    locale: 'auto',
  }),
  // File-processing caps (docs/file-processing-v24.md §4, domain-model §7).
  parser: Schema.object({
    enabled: Schema.boolean().default(true),
    maxFileBytes: Schema.number().min(1024).max(16_777_216).default(1_048_576),
    maxTokens: Schema.number().min(1).max(2_000_000).default(200_000),
    maxAstDepth: Schema.number().min(1).max(4096).default(256),
    timeoutMs: Schema.number().min(50).max(60_000).default(2000),
    cacheCapacity: Schema.number().min(1).max(100_000).default(256),
    dependencyGraphMaxVertices: Schema.number().min(1).max(1_000_000).default(20_000),
    dependencyGraphMaxEdges: Schema.number().min(1).max(5_000_000).default(100_000),
  }).default({
    enabled: true,
    maxFileBytes: 1_048_576,
    maxTokens: 200_000,
    maxAstDepth: 256,
    timeoutMs: 2000,
    cacheCapacity: 256,
    dependencyGraphMaxVertices: 20_000,
    dependencyGraphMaxEdges: 100_000,
  }),
  // Chain projection (domain-model §3, §7): depth ≤ 8, links ≤ 50, ~1 500 tokens.
  chain: Schema.object({
    depth: Schema.number().min(1).max(8).default(8),
    links: Schema.number().min(1).max(50).default(50),
    tokenBudget: Schema.number().min(100).max(100_000).default(1500),
  }).default({ depth: 8, links: 50, tokenBudget: 1500 }),
  // Model-facing tool output budget; 0 keeps today's unbounded render.
  tools: Schema.object({
    maxResultBytes: Schema.number().min(0).max(16_777_216).default(0),
  }).default({ maxResultBytes: 0 }),
  scenes: Schema.object({
    dialogue: sceneSchema(SceneProfiles.dialogue),
    writing: sceneSchema(SceneProfiles.writing),
    office: sceneSchema(SceneProfiles.office),
    research: sceneSchema(SceneProfiles.research),
    engineering: sceneSchema(SceneProfiles.engineering),
    iterate: sceneSchema(SceneProfiles.iterate),
  }).default(SceneProfiles),
  defaults: Schema.object({
    profession: Schema.union(['decision', 'outcome', 'resource', 'personnel', 'qualification', 'execution']).default(
      'execution',
    ),
    interaction: Schema.union(['emotion', 'think', 'heuristic', 'converge', 'orchestrate']).default('think'),
    scene: Schema.union(['dialogue', 'writing', 'office', 'research', 'engineering', 'iterate']).default('dialogue'),
    validation: Schema.union(['low', 'medium', 'high']).default('medium'),
    command: Schema.union(['none', 'goal', 'plan', 'feedback', 'compact', 'permission']).default('none'),
  }).default({
    profession: 'execution',
    interaction: 'think',
    scene: 'dialogue',
    validation: 'medium',
    command: 'none',
  }),
}) as SchemaDefinition<CoordinationConfig>

/** One scene's schema, generated from the shared profile so defaults cannot drift. */
function sceneSchema(profile: SceneProfile): SchemaDefinition<SceneProfile> {
  return Schema.object({
    thinking: Schema.union(['enabled', 'disabled']).default(profile.thinking),
    reasoningEffort: Schema.string().default(profile.reasoningEffort),
    requirePlan: Schema.boolean().default(profile.requirePlan),
    requireScore: Schema.boolean().default(profile.requireScore),
    requireOutline: Schema.boolean().default(profile.requireOutline),
    requireRevision: Schema.boolean().default(profile.requireRevision),
    requirePredict: Schema.boolean().default(profile.requirePredict),
    requireCitation: Schema.boolean().default(profile.requireCitation),
    allowBash: Schema.boolean().default(profile.allowBash),
    allowWeb: Schema.boolean().default(profile.allowWeb),
    sandboxOnly: Schema.boolean().default(profile.sandboxOnly),
    maxIteration: Schema.number().min(1).max(1000).default(profile.maxIteration),
    scoreThreshold: Schema.number().min(0).max(1).default(profile.scoreThreshold),
  }).default(profile) as SchemaDefinition<SceneProfile>
}

/**
 * Materialise every nested default and force the non-negotiable switches.
 *
 * v23 §15.2 marks the profession lock and both reselect flags as forced:
 * - `profession.lock` / `profession.enabled` are safety constraints;
 * - `profession.rebuildCanReselect` / `profession.abandonCanReselect` are what
 *   makes the settings page's "forced" claim true, so the resolver pins them;
 * - `profession.default` is the documented alias of `defaults.profession`; it
 *   mirrors the effective default so neither key is dead.
 */
export function resolveConfig(input: Partial<CoordinationConfig> | undefined): CoordinationConfig {
  const base = (Config({}) ?? {}) as CoordinationConfig
  const merged = deepMerge(base, input ?? {}) as CoordinationConfig
  merged.profession.lock = true
  merged.profession.enabled = true
  merged.profession.rebuildCanReselect = true
  merged.profession.abandonCanReselect = true
  merged.profession.default = merged.defaults.profession
  merged.plan.weights = normaliseWeights(merged.plan.weights)
  merged.compaction = resolveCompaction(merged.compaction)
  return merged
}

/**
 * Clamp the automatic compaction policy (v24 §5, token-governor contract).
 *
 * The governor trusts the resolver, so every invariant is enforced here:
 * `soft` stays in [0.3, 0.9], `hard` stays strictly above `soft` and at most
 * 0.98, `reserve` is at least 512 tokens (the governor additionally caps it at
 * 25% of the model window, which the resolver cannot know), `recentTurns` in
 * [2, 20], `cooldown` in [5 s, 10 min] and `maxPerSession` at least 1. An
 * absent or non-finite value falls back to the schema default; `auto` is on
 * unless it is explicitly `false`.
 */
export function resolveCompaction(input: CompactionPolicyConfig | undefined): CompactionPolicyConfig {
  const source: Partial<CompactionPolicyConfig> = isRecord(input) ? input : {}
  const soft = clampNumber(source.soft, 0.3, 0.9, 0.7)
  return {
    auto: source.auto !== false,
    soft,
    hard: clampNumber(source.hard, soft + 0.01, 0.98, 0.88),
    reserve: Math.round(clampNumber(source.reserve, 512, Number.MAX_SAFE_INTEGER, 2048)),
    recentTurns: Math.round(clampNumber(source.recentTurns, 2, 20, 6)),
    cooldown: Math.round(clampNumber(source.cooldown, 5000, 600000, 30000)),
    maxPerSession: Math.floor(clampNumber(source.maxPerSession, 1, Number.MAX_SAFE_INTEGER, 20)),
  }
}

/** Clamp a numeric option, falling back to `fallback` for absent/non-finite input. */
function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(maximum, Math.max(minimum, numeric))
}

/** Normalise the eight weights so their sum is exactly one. */
export function normaliseWeights(weights: PlanWeights): PlanWeights {
  const keys = Object.keys(weights) as Array<keyof PlanWeights>
  const sum = keys.reduce((total, key) => total + (Number.isFinite(weights[key]) ? weights[key] : 0), 0)
  if (sum <= 0) {
    return {
      feasibility: 0.15,
      coverage: 0.15,
      clarity: 0.1,
      specificity: 0.1,
      alignment: 0.2,
      risk: 0.1,
      cost: 0.1,
      efficiency: 0.1,
    }
  }
  const result = {} as PlanWeights
  for (const key of keys) result[key] = (Number.isFinite(weights[key]) ? weights[key] : 0) / sum
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    result[key] = key in result ? deepMerge(result[key], value) : value
  }
  return result as T
}
