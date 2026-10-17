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
  enabled: boolean
  /** Forced true by the resolver: the lock is a core safety constraint. */
  lock: boolean
  default: Profession
  rebuildCanReselect: boolean
  abandonCanReselect: boolean
  audit: boolean
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
  toolbar: boolean
  showTooltip: boolean
  takeover: boolean
  refreshInterval: number
  compact: boolean
  /** 'auto' follows the DSH locale; zh-CN/en-US force the host-side copy. */
  locale: string
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
  bayesian: BayesianConfig
  comprehension: ComprehensionConfig
  ui: UiConfig
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
  maxTurnPerSession: Schema.number().min(1).default(1000),
  defaultLease: Schema.number().min(1000).default(30000),
  clarifyTimeout: Schema.number().min(1000).default(30000),
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
    maxRebuild: Schema.number().min(0).default(3),
    weights: Schema.object({
      feasibility: Schema.number().default(0.15),
      coverage: Schema.number().default(0.15),
      clarity: Schema.number().default(0.1),
      specificity: Schema.number().default(0.1),
      alignment: Schema.number().default(0.2),
      risk: Schema.number().default(0.1),
      cost: Schema.number().default(0.1),
      efficiency: Schema.number().default(0.1),
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
      feasibility: Schema.number().default(0.5),
      coverage: Schema.number().default(0.6),
      clarity: Schema.number().default(0.5),
      specificity: Schema.number().default(0.5),
      alignment: Schema.number().default(0.7),
      risk: Schema.number().default(0.7),
      cost: Schema.number().default(0.8),
      efficiency: Schema.number().default(0.5),
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
    maxReject: Schema.number().min(0).default(2),
    maxSubTask: Schema.number().min(1).default(32),
    groundTruth: Schema.boolean().default(true),
    groundTruthTimeout: Schema.number().min(100).default(5000),
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
    ttl: Schema.number().min(0).default(60000),
    fingerprintWindow: Schema.number().min(1).default(50),
    effortWarning: Schema.boolean().default(true),
  }).default({ enabled: true, ttl: 60000, fingerprintWindow: 50, effortWarning: true }),
  bayesian: Schema.object({
    prior: Schema.number().min(0).max(1).default(0.5),
    stopEntropy: Schema.number().min(0).default(0.05),
    infoGain: Schema.number().min(0).default(0.01),
    maxRoutes: Schema.number().min(1).default(12),
    calibrationFloor: Schema.number().min(0).max(1).default(0.1),
  }).default({ prior: 0.5, stopEntropy: 0.05, infoGain: 0.01, maxRoutes: 12, calibrationFloor: 0.1 }),
  comprehension: Schema.object({
    stageTimeout: Schema.number().min(100).default(30000),
    searchEnabled: Schema.boolean().default(true),
    maxEvidence: Schema.number().min(1).default(8),
    highHistoryWindow: Schema.number().min(0).default(50),
  }).default({ stageTimeout: 30000, searchEnabled: true, maxEvidence: 8, highHistoryWindow: 50 }),
  ui: Schema.object({
    toolbar: Schema.boolean().default(true),
    showTooltip: Schema.boolean().default(true),
    takeover: Schema.boolean().default(false),
    refreshInterval: Schema.number().min(500).default(5000),
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
    maxIteration: Schema.number().min(1).default(profile.maxIteration),
    scoreThreshold: Schema.number().min(0).max(1).default(profile.scoreThreshold),
  }).default(profile) as SchemaDefinition<SceneProfile>
}

/** Materialise every nested default and force the non-negotiable lock. */
export function resolveConfig(input: Partial<CoordinationConfig> | undefined): CoordinationConfig {
  const base = (Config({}) ?? {}) as CoordinationConfig
  const merged = deepMerge(base, input ?? {}) as CoordinationConfig
  merged.profession.lock = true
  merged.profession.enabled = true
  merged.plan.weights = normaliseWeights(merged.plan.weights)
  return merged
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
