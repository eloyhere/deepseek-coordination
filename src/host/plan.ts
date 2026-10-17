/**
 * Plan scoring, rebuild, and lifecycle (v23 §9.3, §9.4, §13).
 *
 * Every plan is scored on the eight dimensions the design document fixes. The
 * measurement function is pure: it derives the dimension vector from the plan
 * text plus the comprehension that produced it, so `score`, `compute` and
 * `shouldRebuild` always agree, and a rebuild can compare before/after totals
 * without writing a score row (and without recursing into `score`).
 *
 * Formula summary (see `computePlanDimensions`; each result is clamped to
 * 0..1 and rounded to 4 decimals):
 *
 *   feasibility = 0.50*min(1, steps/3) + 0.20*approach present
 *               + 0.15*constraint stated + 0.15*assumption stated
 *   coverage    = |intent terms ∩ terms(goal + step)| / |intent terms|
 *                 (neutral 0.5 when the comprehension states no intent)
 *   clarity     = 0.40*sentence-length fit + 0.30*structure fit
 *               + 0.30*(1 - vague markers per sentence)
 *   specificity = 0.30*concrete-verb fit + 0.30*acceptance fit
 *               + 0.20*numeric signal + 0.20*path/tool signal
 *   alignment   = |reference terms ∩ terms(plan text)| / |reference terms|
 *                 where reference = comprehension intent + requirement +
 *                 constraint (neutral 0.5 when there is no reference)
 *   risk        = min(1, 0.18*destructive markers + 0.08*uncertain markers)
 *               - 0.15 stated constraint - 0.05 stated assumption
 *   cost        = 0.50*min(1, steps/12) + 0.50*min(1, characters/4000)
 *   efficiency  = 1 - |steps/intent terms - 1| / 2   (0 when there are no steps)
 *
 * "Terms" are ASCII words plus CJK character bigrams: the design document and
 * its prompts are Chinese, and a whitespace splitter would treat a whole clause
 * as one token. Markers are distinct literals counted once when present.
 *
 * Weighted total (§9.3): feasibility*0.15 + coverage*0.15 + clarity*0.10 +
 * specificity*0.10 + alignment*0.20 + (1-risk)*0.10 + (1-cost)*0.10 +
 * efficiency*0.10. `computePlanTotal` normalises the configured weights, so the
 * default weights reproduce the documented formula exactly; a plan whose eight
 * dimensions are all 0.5 scores exactly the default 0.5 threshold.
 *
 * Thresholds: feasibility >= 0.5, coverage >= 0.6, clarity >= 0.5,
 * specificity >= 0.5, alignment >= 0.7, risk <= 0.7, cost <= 0.8,
 * efficiency >= 0.5. A plan passes only when every dimension is inside its
 * threshold AND the weighted total reaches the scene's threshold; alignment
 * and risk are part of "every dimension", so the two extra §9.4 conditions are
 * covered without a second check.
 *
 * v24 delta: a plan whose turn scene is `writing` (between `dialogue` and
 * `office`) must reach `WritingScoreThreshold` (0.6) instead of
 * `config.plan.threshold`. The scene is read from the turn row; a deployment
 * that later exposes `config.scenes.writing.scoreThreshold` overrides the
 * local constant. The quality score recorded on the answer afterwards is the
 * service layer's job; it should reuse `PlanScenePolicies` rather than
 * hard-coding 0.6 again.
 */
import type { PlanDimensionThreshold, PlanWeights } from './config.js'
import type { ModuleHost } from './module.js'
import { clamp, round } from './module.js'
import type { PlanStepDraft, PlanSubtaskDraft, SubtaskDraftProfession } from './organization.js'
import type { Comprehension, Plan, PlanRebuild, Score } from '../shared/entity.js'
import type { PlanStatus } from '../shared/enum.js'
import { InvalidArgumentError, InvalidStateError } from '../shared/error.js'
import { mapComprehension, mapPlan, mapScore, mapTurn } from './row.js'
import type { Row } from './row.js'
import { number, text } from './row.js'

/* ------------------------------------------------------------------------- *
 * Dimension vocabulary
 * ------------------------------------------------------------------------- */

/** The eight dimensions of §9.3, in document order. */
export const PlanDimensionNames = [
  'feasibility',
  'coverage',
  'clarity',
  'specificity',
  'alignment',
  'risk',
  'cost',
  'efficiency',
] as const

export type PlanDimension = (typeof PlanDimensionNames)[number]

export type PlanDimensions = Record<PlanDimension, number>

/** Dimensions whose threshold is an upper bound ("lower is better"). */
const LowerIsBetterDimensions: ReadonlySet<PlanDimension> = new Set<PlanDimension>(['risk', 'cost'])

const TerminalPlanStatuses: ReadonlySet<PlanStatus> = new Set<PlanStatus>([
  'done',
  'failed',
  'abandoned',
  'rebuilt',
])

export const PlanStatusValues: readonly PlanStatus[] = [
  'draft',
  'scored',
  'active',
  'done',
  'failed',
  'abandoned',
  'rebuilt',
]

/* ------------------------------------------------------------------------- *
 * Scene policy (v24)
 * ------------------------------------------------------------------------- */

/**
 * v24 delta: the writing scene raises the plan pass threshold to 0.6 — prose
 * must clear a higher bar than an ordinary plan. This local constant is the
 * fallback while `config.scenes` is not part of the configuration schema.
 */
export const WritingScoreThreshold = 0.6

/** One scene's plan policy; the shape `config.scenes.<scene>` may expose. */
export interface PlanScenePolicy {
  scoreThreshold: number
}

/** Scene overrides of the plan defaults, keyed by persisted scene name. */
export const PlanScenePolicies: Readonly<Record<'writing', PlanScenePolicy>> = {
  writing: { scoreThreshold: WritingScoreThreshold },
}

/**
 * The pass threshold of one scene: the configured plan threshold by default,
 * the writing policy (0.6) for the writing scene. Pure, so the service layer
 * can reuse it when it scores the answer quality later.
 */
export function planScoreThreshold(
  scene: string,
  baseThreshold: number,
  writingThreshold: number = WritingScoreThreshold,
): number {
  if (scene !== 'writing') return baseThreshold
  return Number.isFinite(writingThreshold) ? clamp(writingThreshold, 0, 1) : WritingScoreThreshold
}

/** The shape a future `config.scenes.writing` entry would carry. */
interface ScenesConfig {
  writing?: { scoreThreshold?: number }
}

/** Read the configured writing threshold when the schema exposes it. */
function configuredWritingThreshold(host: ModuleHost): number {
  const scenes = (host.config as unknown as { scenes?: ScenesConfig }).scenes
  const value = scenes?.writing?.scoreThreshold
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : WritingScoreThreshold
}

/** The result of scoring one plan. */
export interface PlanScore {
  scores: Score[]
  total: number
  pass: boolean
  failing: string[]
}

/** The plan text the measurement needs; a `Plan` satisfies it structurally. */
export interface PlanMeasureInput {
  goal: string
  approach: string
  step: string
  constraint: string
  assumption: string
}

/** The comprehension text the measurement needs. */
export interface ComprehensionMeasureInput {
  intent: string
  requirement: string
  constraint: string
  assumption: string
  ambiguity: string
}

/** A parsed `plan.step`: flat steps, subtask drafts, or neither. */
export interface ParsedPlanStep {
  steps: PlanStepDraft[]
  drafts: PlanSubtaskDraft[]
  malformed: boolean
}

interface PlanMeasurement {
  plan: Plan
  comprehension: Comprehension | undefined
  dimensions: PlanDimensions
  /** The scene's pass threshold: `config.plan.threshold` or 0.6 for writing. */
  threshold: number
}

/* ------------------------------------------------------------------------- *
 * Markers
 * ------------------------------------------------------------------------- */

/** Hedging that makes a plan read as unclear. */
const VagueMarkers: readonly string[] = [
  'maybe',
  'perhaps',
  'possibly',
  'roughly',
  'somehow',
  'something',
  'stuff',
  'etc',
  'later',
  '大概',
  '可能',
  '也许',
  '一些',
  '之类',
  '等等',
  '随便',
  '差不多',
  '不确定',
]

/** Markers whose presence raises risk unless a constraint covers them. */
const DestructiveMarkers: readonly string[] = [
  '删除',
  '清空',
  '覆盖',
  '强制',
  '重置',
  '移除',
  '销毁',
  'drop',
  'delete',
  'truncate',
  'purge',
  'wipe',
  'overwrite',
  'force',
  'reset',
  'rm -rf',
  'rmdir',
]

/** Uncertainty markers: a plan cannot promise what it has not decided. */
const UncertainMarkers: readonly string[] = [
  'maybe',
  'perhaps',
  'possibly',
  'roughly',
  'guess',
  'probably',
  'unsure',
  '不确定',
  '猜测',
  '估计',
]

/** Concrete action verbs, English and Chinese. */
const ConcreteVerbs: readonly string[] = [
  'read',
  'write',
  'edit',
  'create',
  'outline',
  'draft',
  'revise',
  'proofread',
  'build',
  'run',
  'execute',
  'test',
  'verify',
  'check',
  'confirm',
  'record',
  'inspect',
  'measure',
  'report',
  'fix',
  'add',
  'refactor',
  'deploy',
  'plan',
  'split',
  'dispatch',
  'synthesise',
  'analyse',
  'answer',
  'rank',
  'resolve',
  'restate',
  'deliver',
  'carry',
  'listen',
  'name',
  'weigh',
  'break',
  '读取',
  '写入',
  '修改',
  '创建',
  '大纲',
  '草稿',
  '修订',
  '运行',
  '执行',
  '测试',
  '验证',
  '检查',
  '确认',
  '记录',
  '分析',
  '报告',
  '修复',
  '添加',
  '重构',
  '部署',
  '拆分',
  '派发',
  '综合',
  '实现',
  '设计',
  '排查',
  '定位',
  '生成',
  '整理',
  '核对',
]

/* ------------------------------------------------------------------------- *
 * Pure measurement helpers
 * ------------------------------------------------------------------------- */

const AsciiTokenPattern = /[a-z0-9]+/g
const CjkRunPattern = /[\u3400-\u9fff]+/g
const SentenceBoundaryPattern = /[.!?;。！？；\n]+/
const NumberPattern = /\d/
const PathOrToolPattern =
  /(?:[a-z]:\\|[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|js|mjs|cjs|json|md|py|sql|yml|yaml|toml|db)\b|\b(?:node|npm|pnpm|tsc|git|curl|grep|sqlite|bash|powershell|eslint|vitest|jest)\b)/i

/** ASCII words plus CJK character bigrams: one deterministic term list. */
export function planTokens(source: string): string[] {
  const tokens: string[] = []
  for (const match of source.toLowerCase().matchAll(AsciiTokenPattern)) tokens.push(match[0])
  for (const match of source.matchAll(CjkRunPattern)) {
    const run = match[0]
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/** Split prose into non-empty sentences. */
function splitSentences(source: string): string[] {
  return source
    .split(SentenceBoundaryPattern)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * Per-call memo for the repeated scans of one measurement.
 *
 * `computePlanDimensions` reads the same plan text through several lenses: the
 * term set of the whole text, the term set of goal+step, the marker count of
 * clarity text, of the whole text (vague, verb, destructive, uncertain markers).
 * Each lens used to lower-case and tokenise the source again, so one scoring
 * pass tokenised the five-field text twice and scanned it for markers four
 * times. The memo belongs to one call only: it is not shared between plans, so
 * it cannot grow across turns and cannot return a stale value.
 */
class PlanTextScanner {
  private readonly termsBySource = new Map<string, string[]>()
  private readonly markerScanBySource = new Map<string, { lower: string; words: Set<string> }>()

  /** `planTokens(source)`, tokenised at most once per call. */
  terms(source: string): string[] {
    const cached = this.termsBySource.get(source)
    if (cached !== undefined) return cached
    const terms = planTokens(source)
    this.termsBySource.set(source, terms)
    return terms
  }

  /** How many distinct markers occur in `source`, scanned at most once per call. */
  markerHits(source: string, markers: readonly string[]): number {
    let scan = this.markerScanBySource.get(source)
    if (scan === undefined) {
      const lower = source.toLowerCase()
      scan = { lower, words: new Set(lower.match(/[a-z0-9]+/g) ?? []) }
      this.markerScanBySource.set(source, scan)
    }
    let hits = 0
    for (const marker of markers) {
      const present = /^[a-z0-9]+$/.test(marker) ? scan.words.has(marker) : scan.lower.includes(marker)
      if (present) hits += 1
    }
    return hits
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSubtaskProfession(value: unknown): value is SubtaskDraftProfession {
  return value === 'execution' || value === 'outcome' || value === 'decision'
}

function readJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown
  } catch {
    return undefined
  }
}

function subtaskDraftOf(entry: Record<string, unknown>, task: string): PlanSubtaskDraft {
  const acceptance = typeof entry.acceptance === 'string' ? entry.acceptance.trim() : ''
  return {
    task,
    acceptance,
    profession: isSubtaskProfession(entry.profession) ? entry.profession : 'execution',
    ...(typeof entry.groundTruth === 'string' && entry.groundTruth.trim() !== ''
      ? { groundTruth: entry.groundTruth }
      : {}),
    ...(typeof entry.model === 'string' && entry.model.trim() !== '' ? { model: entry.model } : {}),
    ...(Array.isArray(entry.tools)
      ? { tools: entry.tools.filter((tool): tool is string => typeof tool === 'string') }
      : {}),
    ...(typeof entry.context === 'string' && entry.context.trim() !== ''
      ? { context: entry.context }
      : {}),
    ...(Array.isArray(entry.blockedBy)
      ? { blockedBy: entry.blockedBy.filter((item): item is number => typeof item === 'number') }
      : {}),
  }
}

/**
 * Decode `plan.step` into steps, subtask drafts, or neither. A plain-text step
 * that is not JSON is treated as one acceptance-less step and marked
 * `malformed`, so scoring stays total instead of throwing on legacy text.
 */
export function decodePlanStep(step: string): ParsedPlanStep {
  const raw = step.trim()
  if (raw === '') return { steps: [], drafts: [], malformed: false }
  const value = readJson(raw)
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.steps)
      ? value.steps
      : undefined
  if (list === undefined) return { steps: [{ step: raw }], drafts: [], malformed: true }

  const steps: PlanStepDraft[] = []
  const drafts: PlanSubtaskDraft[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const task = typeof entry.task === 'string' ? entry.task.trim() : ''
    if (task !== '') {
      drafts.push(subtaskDraftOf(entry, task))
      continue
    }
    const stepText = typeof entry.step === 'string' ? entry.step.trim() : ''
    if (stepText === '') continue
    const acceptance = typeof entry.acceptance === 'string' ? entry.acceptance.trim() : ''
    steps.push(acceptance === '' ? { step: stepText } : { step: stepText, acceptance })
  }
  return { steps, drafts, malformed: false }
}

/**
 * Derive the eight dimensions from the plan text and its comprehension.
 * Pure: used by `score` (with writes), by `compute`/`shouldRebuild` (without
 * writes) and by `rebuild` for both the before and the after total.
 */
export function computePlanDimensions(
  plan: PlanMeasureInput,
  comprehension: ComprehensionMeasureInput | undefined,
): PlanDimensions {
  const scanner = new PlanTextScanner()
  const parsed = decodePlanStep(plan.step)
  const goal = plan.goal.trim()
  const approach = plan.approach.trim()
  const constraint = plan.constraint.trim()
  const assumption = plan.assumption.trim()
  const text = [plan.goal, plan.approach, plan.step, plan.constraint, plan.assumption].join(' ')
  const stepCount = parsed.steps.length + parsed.drafts.length
  const acceptanceCount =
    parsed.steps.filter((step) => (step.acceptance ?? '').trim() !== '').length +
    parsed.drafts.filter((draft) => draft.acceptance.trim() !== '').length

  const feasibility =
    0.5 * clamp(stepCount / 3, 0, 1) +
    0.2 * (scanner.terms(approach).length >= 3 ? 1 : 0) +
    0.15 * (constraint === '' ? 0 : 1) +
    0.15 * (assumption === '' ? 0 : 1)

  const intentTerms = new Set(scanner.terms(comprehension?.intent ?? ''))
  const coveredTerms = new Set(scanner.terms(`${goal} ${plan.step}`))
  let coverage = 0.5
  if (intentTerms.size > 0) {
    let covered = 0
    for (const term of intentTerms) if (coveredTerms.has(term)) covered += 1
    coverage = covered / intentTerms.size
  }

  const clarityText = `${goal} ${approach}`.trim()
  const sentences = splitSentences(clarityText)
  const averageSentenceLength = sentences.length === 0 ? 0 : clarityText.length / sentences.length
  const lengthFit =
    averageSentenceLength === 0
      ? 0
      : averageSentenceLength < 24
        ? averageSentenceLength / 24
        : averageSentenceLength > 120
          ? clamp(120 / averageSentenceLength, 0, 1)
          : 1
  const structureFit = sentences.length >= 2 ? 1 : sentences.length === 1 ? 0.6 : 0
  const vagueFit = clamp(1 - scanner.markerHits(clarityText, VagueMarkers) / Math.max(1, sentences.length), 0, 1)
  const clarity = 0.4 * lengthFit + 0.3 * structureFit + 0.3 * vagueFit

  const verbFit = clamp(scanner.markerHits(text, ConcreteVerbs) / 2, 0, 1)
  const acceptanceFit = clamp(acceptanceCount / 3, 0, 1)
  const numberFit = NumberPattern.test(text) ? 1 : 0
  const pathOrToolFit = PathOrToolPattern.test(text) ? 1 : 0
  const specificity = 0.3 * verbFit + 0.3 * acceptanceFit + 0.2 * numberFit + 0.2 * pathOrToolFit

  const referenceTerms = new Set(
    scanner.terms(
      `${comprehension?.intent ?? ''} ${comprehension?.requirement ?? ''} ${comprehension?.constraint ?? ''}`,
    ),
  )
  let alignment = 0.5
  if (referenceTerms.size > 0) {
    const planTerms = new Set(scanner.terms(text))
    let overlap = 0
    for (const term of referenceTerms) if (planTerms.has(term)) overlap += 1
    alignment = overlap / referenceTerms.size
  }

  const hazard = clamp(
    scanner.markerHits(text, DestructiveMarkers) * 0.18 + scanner.markerHits(text, UncertainMarkers) * 0.08,
    0,
    1,
  )
  const relief = (constraint === '' ? 0 : 0.15) + (assumption === '' ? 0 : 0.05)
  const risk = clamp(hazard - relief, 0, 1)

  const cost = clamp(0.5 * clamp(stepCount / 12, 0, 1) + 0.5 * clamp(text.length / 4000, 0, 1), 0, 1)

  let efficiency = 0
  if (stepCount > 0) {
    efficiency =
      intentTerms.size === 0
        ? 0.5
        : clamp(1 - Math.abs(stepCount / intentTerms.size - 1) / 2, 0, 1)
  }

  return {
    feasibility: round(clamp(feasibility, 0, 1), 4),
    coverage: round(clamp(coverage, 0, 1), 4),
    clarity: round(clamp(clarity, 0, 1), 4),
    specificity: round(clamp(specificity, 0, 1), 4),
    alignment: round(clamp(alignment, 0, 1), 4),
    risk: round(clamp(risk, 0, 1), 4),
    cost: round(clamp(cost, 0, 1), 4),
    efficiency: round(clamp(efficiency, 0, 1), 4),
  }
}

/**
 * The §9.3 weighted total. Weights are normalised by their sum, so configured
 * weights need not add up to exactly one and a single non-zero weight isolates
 * its dimension (which is what the unit test relies on).
 */
export function computePlanTotal(dimensions: PlanDimensions, weights: PlanWeights): number {
  const terms: Array<{ key: keyof PlanWeights; value: number }> = [
    { key: 'feasibility', value: dimensions.feasibility },
    { key: 'coverage', value: dimensions.coverage },
    { key: 'clarity', value: dimensions.clarity },
    { key: 'specificity', value: dimensions.specificity },
    { key: 'alignment', value: dimensions.alignment },
    { key: 'risk', value: 1 - dimensions.risk },
    { key: 'cost', value: 1 - dimensions.cost },
    { key: 'efficiency', value: dimensions.efficiency },
  ]
  let weightSum = 0
  let weighted = 0
  for (const term of terms) {
    const weight = Number.isFinite(weights[term.key]) ? Math.max(0, weights[term.key]) : 0
    weightSum += weight
    weighted += clamp(term.value, 0, 1) * weight
  }
  if (weightSum <= 0) return 0
  return round(weighted / weightSum, 4)
}

/**
 * Names of the dimensions outside their threshold, plus `total` when the
 * weighted score misses `config.plan.threshold`. `risk` and `cost` are upper
 * bounds; every other dimension is a lower bound.
 */
export function failingPlanDimensions(
  dimensions: PlanDimensions,
  thresholds: PlanDimensionThreshold,
  total: number,
  threshold: number,
): string[] {
  const failing: string[] = []
  for (const dimension of PlanDimensionNames) {
    const value = dimensions[dimension]
    const limit = thresholds[dimension]
    const inside = LowerIsBetterDimensions.has(dimension) ? value <= limit : value >= limit
    if (!inside) failing.push(dimension)
  }
  if (total < threshold) failing.push('total')
  return failing
}

/* ------------------------------------------------------------------------- *
 * Rebuild helpers
 * ------------------------------------------------------------------------- */

/** Append the comprehension goal text when the current goal does not carry it. */
function ensureGoal(goal: string, comprehension: Comprehension | undefined): string {
  const current = goal.trim()
  const intent = (comprehension?.intent ?? '').trim()
  const requirement = (comprehension?.requirement ?? '').trim()
  const statements: string[] = current === '' ? [] : [current]
  if (intent !== '' && !statements.some((statement) => statement.includes(intent))) statements.push(intent)
  if (requirement !== '' && !statements.some((statement) => statement.includes(requirement))) {
    statements.push(requirement)
  }
  if (statements.length === 0) return 'Complete the request.'
  return statements.join('. ')
}

/** Give an empty or very short approach a concrete, verification-shaped frame. */
function ensureApproach(approach: string): string {
  const current = approach.trim()
  if (current === '') {
    return 'Break the goal into ordered steps, carry each step out inside the stated constraints, verify every acceptance criterion, then report the evidence.'
  }
  if (current.length < 40) {
    return `${current} Verify every acceptance criterion, then report the evidence.`
  }
  return current
}

/** Append a comprehension statement when it is not already present. */
function mergeStatement(current: string, addition: string | undefined): string {
  const base = current.trim()
  const extra = (addition ?? '').trim()
  if (extra === '') return base
  if (base === '') return extra
  if (base.includes(extra)) return base
  return `${base} ${extra}`
}

function seedSteps(goal: string): PlanStepDraft[] {
  const target = goal.trim() === '' ? 'the request' : goal.trim()
  return [
    {
      step: `Restate the goal and the acceptance basis: ${target}`,
      acceptance: 'the restatement matches the stated goal',
    },
    {
      step: `Carry out the work for: ${target}`,
      acceptance: 'the work satisfies the stated requirement',
    },
  ]
}

/**
 * Expand a step array: one entry per existing step plus one explicit
 * verification entry per non-verification step. Existing verification entries
 * are kept as-is, so repeated rebuilds grow the array linearly instead of
 * doubling it every attempt.
 */
function expandSteps(parsed: ParsedPlanStep, goal: string): PlanStepDraft[] {
  const originals =
    parsed.steps.length > 0
      ? parsed.steps
      : parsed.drafts.map((draft) => ({
          step: draft.task,
          ...(draft.acceptance === '' ? {} : { acceptance: draft.acceptance }),
        }))
  const seeded = originals.length > 0 ? originals : seedSteps(goal)
  const expanded: PlanStepDraft[] = []
  for (const original of seeded) {
    const stepText = original.step.trim() === '' ? 'complete the step' : original.step.trim()
    const stated = (original.acceptance ?? '').trim()
    const acceptance = stated === '' ? `"${stepText}" is completed and confirmed` : stated
    expanded.push({ step: stepText, acceptance })
    if (!stepText.startsWith('Verify: ')) {
      expanded.push({ step: `Verify: ${stepText}`, acceptance: `verification of "${stepText}" passes` })
    }
  }
  return expanded
}

function seedSubtaskDrafts(goal: string): PlanSubtaskDraft[] {
  const target = goal.trim() === '' ? 'the request' : goal.trim()
  return [
    {
      task: `Restate the goal and the acceptance basis: ${target}`,
      acceptance: 'the restatement matches the stated goal',
      profession: 'decision',
    },
    {
      task: `Produce the outcome for: ${target}`,
      acceptance: 'the outcome satisfies the stated requirement',
      profession: 'outcome',
    },
  ]
}

/**
 * Expand a draft array: every draft keeps its fields and gains a non-empty
 * acceptance, then one independent verification draft is appended per
 * non-verification draft. The verification drafts come last so array order
 * stays the dispatch order.
 */
function expandSubtaskDrafts(parsed: ParsedPlanStep, goal: string): PlanSubtaskDraft[] {
  const originals =
    parsed.drafts.length > 0
      ? parsed.drafts
      : parsed.steps.map((step) => ({
          task: step.step,
          acceptance: step.acceptance ?? '',
          profession: 'execution' as const,
        }))
  const seeded = originals.length > 0 ? originals : seedSubtaskDrafts(goal)
  const expanded: PlanSubtaskDraft[] = []
  for (const original of seeded) {
    const task = original.task.trim() === '' ? 'complete the subtask' : original.task.trim()
    const stated = original.acceptance.trim()
    const acceptance = stated === '' ? `"${task}" is completed and confirmed` : stated
    expanded.push({ ...original, task, acceptance })
  }
  for (const original of seeded) {
    const task = original.task.trim() === '' ? 'complete the subtask' : original.task.trim()
    if (task.startsWith('Verify: ')) continue
    expanded.push({
      task: `Verify: ${task}`,
      acceptance: `verification of "${task}" passes`,
      profession: 'decision',
    })
  }
  return expanded
}

/* ------------------------------------------------------------------------- *
 * Row mapper for the rebuild record
 * ------------------------------------------------------------------------- */

function mapPlanRebuild(row: Row): PlanRebuild {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    plan: number(row, 'plan'),
    attempt: number(row, 'attempt'),
    reason: text(row, 'reason'),
    dimension: text(row, 'dimension'),
    beforeScore: text(row, 'beforeScore'),
    afterScore: text(row, 'afterScore'),
    created: number(row, 'created'),
  }
}

/* ------------------------------------------------------------------------- *
 * The module
 * ------------------------------------------------------------------------- */

/**
 * Scoring, rebuild and lifecycle of plans.
 *
 * `score` persists the eight score rows and moves a fresh plan to `scored`.
 * `shouldRebuild` never writes score rows; when the rebuild budget is spent it
 * marks the plan `failed` and returns false, leaving escalation to the caller
 * (v23 §9.4: the service escalates the turn to human review). `rebuild` writes
 * the replacement plan, the rebuild record and the turn pointer in one
 * transaction, then returns the new plan; the old plan becomes `rebuilt`.
 */
export class PlanModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  get(plan: number): Plan {
    return mapPlan(this.host.db.require<Row>('plan', plan, 'plan'))
  }

  /** The plan currently attached to a turn; rebuilds chain, latest wins. */
  forTurn(turn: number): Plan | undefined {
    const row = this.host.db.get<Row>(
      'SELECT * FROM plan WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turn,
    )
    return row === undefined ? undefined : mapPlan(row)
  }

  /** The measured dimensions of one plan, without writing anything. */
  dimensions(plan: number): PlanDimensions {
    return this.measure(plan).dimensions
  }

  /** The weighted total of one plan, without writing anything. */
  compute(plan: number): number {
    const measurement = this.measure(plan)
    return computePlanTotal(measurement.dimensions, this.host.config.plan.weights)
  }

  /** The scene's pass threshold for this plan; 0.6 for a writing scene. */
  threshold(plan: number): number {
    return this.measure(plan).threshold
  }

  /**
   * Measure the plan, upsert its eight score rows (`category = 'plan'`,
   * `target = plan identity`, the eight dimension names) and move a
   * non-terminal plan to `scored`. Terminal plans keep their status: their
   * score history is refreshed for audit, but a closed plan is not revived.
   */
  score(plan: number): PlanScore {
    const measurement = this.measure(plan)
    const total = computePlanTotal(measurement.dimensions, this.host.config.plan.weights)
    const failing = failingPlanDimensions(
      measurement.dimensions,
      this.host.config.plan.dimensions,
      total,
      measurement.threshold,
    )
    const now = this.host.clock.now()
    const scores = this.host.db.transaction(() => {
      const written: Score[] = []
      for (const dimension of PlanDimensionNames) {
        const value = measurement.dimensions[dimension]
        const reason = failing.includes(dimension)
          ? `${dimension} is outside its threshold`
          : `${dimension} is inside its threshold`
        written.push(this.upsertScore(plan, dimension, value, reason, now))
      }
      if (!TerminalPlanStatuses.has(measurement.plan.status)) {
        this.host.db.update('plan', { status: 'scored' }, 'identity = ?', plan)
      }
      return written
    })
    return { scores, total, pass: failing.length === 0, failing }
  }

  /**
   * Whether §9.4 asks for another rebuild. Returns false for a terminal plan,
   * for a plan that passes, and when the rebuild budget is exhausted; in the
   * last case the plan is marked `failed` so the caller can escalate instead
   * of looping (no throw: escalation is the service's decision).
   */
  shouldRebuild(plan: number): boolean {
    const measurement = this.measure(plan)
    if (TerminalPlanStatuses.has(measurement.plan.status)) return false
    const total = computePlanTotal(measurement.dimensions, this.host.config.plan.weights)
    const failing = failingPlanDimensions(
      measurement.dimensions,
      this.host.config.plan.dimensions,
      total,
      measurement.threshold,
    )
    if (failing.length === 0) return false
    if (measurement.plan.rebuild >= this.host.config.plan.maxRebuild) {
      this.markFailed(plan)
      return false
    }
    return true
  }

  /**
   * Deterministically reconstruct a failing plan.
   *
   * The replacement carries the comprehension constraint and assumption that
   * the old plan omitted, a goal that states the comprehension intent, and one
   * explicit verification entry per subtask / step. Orchestration is preserved
   * and the step array keeps its documented JSON shape. Totals are computed by
   * the pure measurement, never by recursing into `score`, and the old plan,
   * the rebuild record, the new plan and the turn pointer are written in one
   * transaction.
   *
   * The `plan_rebuild` row belongs to the *replacement* plan: `attempt` equals
   * its `rebuild` counter, `dimension` is the comma-joined list of the replaced
   * plan's failing dimensions, and `beforeScore` / `afterScore` are
   * `JSON.stringify({ total })` for the old and the new weighted total.
   */
  rebuild(plan: number): Plan {
    const measurement = this.measure(plan)
    const current = measurement.plan
    if (TerminalPlanStatuses.has(current.status)) {
      throw new InvalidStateError(
        `plan ${plan} is already ${current.status}; a terminal plan cannot be rebuilt`,
        { plan, status: current.status },
      )
    }
    const attempt = current.rebuild + 1
    if (attempt > this.host.config.plan.maxRebuild) {
      throw new InvalidStateError(
        `plan ${plan} reached maxRebuild (${this.host.config.plan.maxRebuild})`,
        { plan, attempt, maxRebuild: this.host.config.plan.maxRebuild },
      )
    }

    const beforeTotal = computePlanTotal(measurement.dimensions, this.host.config.plan.weights)
    const failing = failingPlanDimensions(
      measurement.dimensions,
      this.host.config.plan.dimensions,
      beforeTotal,
      measurement.threshold,
    )
    const improved = this.improve(current, measurement.comprehension)
    const afterTotal = computePlanTotal(
      computePlanDimensions(improved, measurement.comprehension),
      this.host.config.plan.weights,
    )
    const now = this.host.clock.now()

    const rebuiltPlan = this.host.db.transaction(() => {
      const identity = this.host.db.insert('plan', {
        handle: this.host.handles.next('plan'),
        turn: current.turn,
        parent: current.identity,
        goal: improved.goal,
        approach: improved.approach,
        step: improved.step,
        constraint: improved.constraint,
        assumption: improved.assumption,
        status: 'draft',
        rebuild: attempt,
        mode: current.mode,
        orchestration: current.orchestration,
        created: now,
      })
      this.host.db.update('plan', { status: 'rebuilt', finished: now }, 'identity = ?', plan)
      this.insertRebuildRow(
        identity,
        attempt,
        'score below threshold',
        // §9.4 records which dimensions forced the rebuild; a manually
        // requested rebuild of a passing plan simply has no failing dimension.
        failing.length > 0 ? failing.join(',') : 'none',
        JSON.stringify({ total: beforeTotal }),
        JSON.stringify({ total: afterTotal }),
        now,
      )
      this.host.db.update('turn', { plan: identity }, 'identity = ?', current.turn)
      this.host.trace.append({
        turn: current.turn,
        event: 'rebuild',
        actor: 'host',
        detail: {
          plan: identity,
          parent: current.identity,
          attempt,
          failing,
          beforeScore: beforeTotal,
          afterScore: afterTotal,
        },
      })
      return identity
    })

    return this.get(rebuiltPlan)
  }

  /** Append one rebuild record; exposed for callers that rebuild manually. */
  recordRebuild(
    plan: number,
    attempt: number,
    reason: string,
    dimension: string,
    before: string,
    after: string,
  ): PlanRebuild {
    this.get(plan)
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new InvalidArgumentError(`attempt must be a positive integer, received ${String(attempt)}`, {
        plan,
        attempt,
      })
    }
    const identity = this.insertRebuildRow(
      plan,
      attempt,
      reason,
      dimension,
      before,
      after,
      this.host.clock.now(),
    )
    return mapPlanRebuild(this.host.db.require<Row>('plan_rebuild', identity, 'plan rebuild'))
  }

  /**
   * Loose lifecycle transition. Any non-terminal status may move to any other
   * status; a terminal plan (`done`, `failed`, `abandoned`, `rebuilt`) is
   * irreversible, so reviving one throws instead of silently rewriting history.
   */
  setStatus(plan: number, status: PlanStatus): Plan {
    assertPlanStatus(status)
    const current = this.get(plan)
    if (current.status === status) return current
    if (TerminalPlanStatuses.has(current.status)) {
      throw new InvalidStateError(
        `plan ${plan} is already ${current.status}; a terminal plan cannot be revived`,
        { plan, status: current.status, requested: status },
      )
    }
    const now = this.host.clock.now()
    this.host.db.update(
      'plan',
      TerminalPlanStatuses.has(status) ? { status, finished: now } : { status },
      'identity = ?',
      plan,
    )
    return this.get(plan)
  }

  activate(plan: number): Plan {
    return this.setStatus(plan, 'active')
  }

  complete(plan: number): Plan {
    return this.setStatus(plan, 'done')
  }

  /* --------------------------------------------------------------------- */

  private measure(plan: number): PlanMeasurement {
    const current = this.get(plan)
    const comprehension = this.comprehensionOf(current.turn)
    return {
      plan: current,
      comprehension,
      dimensions: computePlanDimensions(current, comprehension),
      threshold: planScoreThreshold(
        this.sceneOf(current.turn),
        this.host.config.plan.threshold,
        configuredWritingThreshold(this.host),
      ),
    }
  }

  /**
   * The persisted scene of a plan's turn. Read as a raw string because the v24
   * `writing` value may run ahead of the shared `Scene` union.
   */
  private sceneOf(turn: number): string {
    const row = this.host.db.get<Row>('SELECT scene FROM turn WHERE identity = ?', turn)
    return row === undefined ? 'dialogue' : text(row, 'scene', 'dialogue')
  }

  /**
   * The comprehension behind a plan: the turn's pointer first, then the latest
   * comprehension of the turn (a fixture or a command-mode plan may not have
   * wired the pointer).
   */
  private comprehensionOf(turn: number): Comprehension | undefined {
    const turnRow = this.host.db.get<Row>('SELECT * FROM turn WHERE identity = ?', turn)
    if (turnRow === undefined) return undefined
    const current = mapTurn(turnRow)
    if (current.comprehension !== undefined) {
      const row = this.host.db.get<Row>(
        'SELECT * FROM comprehension WHERE identity = ?',
        current.comprehension,
      )
      if (row !== undefined) return mapComprehension(row)
    }
    const latest = this.host.db.get<Row>(
      'SELECT * FROM comprehension WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turn,
    )
    return latest === undefined ? undefined : mapComprehension(latest)
  }

  /** Upsert one dimension row: update the latest row or insert a fresh one. */
  private upsertScore(
    plan: number,
    dimension: PlanDimension,
    value: number,
    reason: string,
    now: number,
  ): Score {
    const existing = this.host.db.get<Row>(
      `SELECT identity FROM score
       WHERE category = 'plan' AND target = ? AND dimension = ?
       ORDER BY identity DESC LIMIT 1`,
      plan,
      dimension,
    )
    if (existing !== undefined) {
      const identity = number(existing, 'identity')
      this.host.db.update('score', { value, reason, created: now }, 'identity = ?', identity)
      return mapScore(this.host.db.require<Row>('score', identity, 'score'))
    }
    const identity = this.host.db.insert('score', {
      handle: this.host.handles.next('score'),
      category: 'plan',
      target: plan,
      dimension,
      value,
      reason,
      created: now,
    })
    return mapScore(this.host.db.require<Row>('score', identity, 'score'))
  }

  /** Exhausted rebuild budget: mark the plan failed and close it. */
  private markFailed(plan: number): void {
    this.host.db.update(
      'plan',
      { status: 'failed', finished: this.host.clock.now() },
      'identity = ?',
      plan,
    )
  }

  private insertRebuildRow(
    plan: number,
    attempt: number,
    reason: string,
    dimension: string,
    before: string,
    after: string,
    now: number,
  ): number {
    return this.host.db.insert('plan_rebuild', {
      handle: this.host.handles.next('planrebuild'),
      plan,
      attempt,
      reason,
      dimension,
      beforeScore: before,
      afterScore: after,
      created: now,
    })
  }

  /** The improved text a rebuild writes; deterministic and pure. */
  private improve(plan: Plan, comprehension: Comprehension | undefined): PlanMeasureInput {
    const parsed = decodePlanStep(plan.step)
    const goal = ensureGoal(plan.goal, comprehension)
    return {
      goal,
      approach: ensureApproach(plan.approach),
      step: plan.orchestration
        ? JSON.stringify(expandSubtaskDrafts(parsed, goal))
        : JSON.stringify(expandSteps(parsed, goal)),
      constraint: mergeStatement(plan.constraint, comprehension?.constraint),
      assumption: mergeStatement(plan.assumption, comprehension?.assumption),
    }
  }
}

/** Validate a persisted status before it reaches a column. */
export function assertPlanStatus(value: unknown): asserts value is PlanStatus {
  if (!PlanStatusValues.includes(value as PlanStatus)) {
    throw new InvalidArgumentError(`unknown plan status: ${String(value)}`, {
      allowed: PlanStatusValues,
    })
  }
}
