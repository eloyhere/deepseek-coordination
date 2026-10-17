/**
 * Plan + Organization tests (v23 §9.2, §9.3, §9.4, §11.11-11.13; v24 writing
 * scene).
 *
 * These tests build their own fixtures with raw SQL so they do not depend on
 * the comprehension/orchestration modules: the comprehension row, its turn and
 * the turn's prompt are inserted directly, then `Organize` and `PlanModule`
 * are exercised exactly as the service will call them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CoordinationDatabase } from '../src/host/database.js'
import { CoordinationEventBus, createModuleHost } from '../src/host/module.js'
import type { ModuleHost } from '../src/host/module.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { HandleGenerator, ManualClock } from '../src/host/handle.js'
import { TraceModule } from '../src/host/trace.js'
import { OrganizationModule, WritingStageMarkers, WritingStages } from '../src/host/organization.js'
import type { PlanStepDraft, PlanSubtaskDraft } from '../src/host/organization.js'
import {
  PlanDimensionNames,
  PlanModule,
  PlanScenePolicies,
  WritingScoreThreshold,
  computePlanTotal,
  planScoreThreshold,
} from '../src/host/plan.js'
import type { PlanDimensions } from '../src/host/plan.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError } from '../src/shared/error.js'
import type { Interaction } from '../src/shared/enum.js'

/* ------------------------------------------------------------------------- *
 * Configuration
 * ------------------------------------------------------------------------- */

/**
 * The resolved configuration of v23 §9.3 and §19, written out literally.
 *
 * `config.ts` imports `@deepseek-ai/schemastery` at runtime, and this
 * checkout's top-level copy of that package cannot resolve its
 * `@deepseek-ai/cosmokit` dependency, so this test imports only the
 * configuration *type* and carries the documented defaults. They are exactly
 * the defaults `resolveConfig` materialises.
 */
const TestConfig: CoordinationConfig = {
  database: 'coordination',
  databasePath: '',
  maxTurnPerSession: 1000,
  defaultLease: 30000,
  clarifyTimeout: 30000,
  profession: {
    enabled: true,
    lock: true,
    default: 'execution',
    rebuildCanReselect: true,
    abandonCanReselect: true,
    audit: true,
    errorHint: true,
  },
  plan: {
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
  },
  orchestration: {
    maxReject: 2,
    maxSubTask: 32,
    groundTruth: true,
    groundTruthTimeout: 5000,
    allowShellGroundTruth: false,
    modelRouting: true,
  },
  cache: { enabled: true, ttl: 60000, fingerprintWindow: 50, effortWarning: true },
  bayesian: { prior: 0.5, stopEntropy: 0.05, infoGain: 0.01, maxRoutes: 12, calibrationFloor: 0.1 },
  comprehension: { stageTimeout: 30000, searchEnabled: true, maxEvidence: 8, highHistoryWindow: 50 },
  ui: { toolbar: true, showTooltip: true, takeover: false, refreshInterval: 5000, compact: true },
  defaults: {
    profession: 'execution',
    interaction: 'think',
    scene: 'dialogue',
    validation: 'medium',
    command: 'none',
  },
}

/**
 * A configuration whose (future) `config.scenes.writing` entry overrides the
 * local writing policy. The local `CoordinationConfig` type does not expose
 * `scenes` yet, so the extra field is added through an assertion exactly like
 * the module reads it.
 */
function configWithWritingThreshold(scoreThreshold: number): CoordinationConfig {
  return {
    ...TestConfig,
    scenes: { writing: { scoreThreshold } },
  } as unknown as CoordinationConfig
}

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

interface ComprehensionText {
  intent: string
  requirement: string
  constraint: string
  assumption: string
  ambiguity: string
}

/** A comprehension rich enough to produce a passing, specific plan. */
const RichComprehension: ComprehensionText = {
  intent: '修复登录接口的 token 过期错误',
  requirement: '登录失败时返回 401 并记录日志',
  constraint: '不要修改数据库 schema',
  assumption: '现有单元测试可以运行',
  ambiguity: '未说明是否兼容旧版 token',
}

/** A plan text that misses every threshold; used to force a rebuild. */
const WeakPlan = {
  goal: 'x',
  approach: '',
  step: '[]',
  constraint: '',
  assumption: '',
}

interface TurnInput extends Partial<ComprehensionText> {
  interaction?: Interaction
  /** v24: `writing` is accepted here before the shared `Scene` union carries it. */
  scene?: string
}

interface TurnFixture {
  identity: number
  comprehension: number
}

let fixtureSerial = 0

/** An in-memory host with a real trace writer and a manual clock. */
function createHost(config: CoordinationConfig = TestConfig): ModuleHost {
  const db = new CoordinationDatabase(':memory:')
  const clock = new ManualClock(1_700_000_000_000)
  const handles = new HandleGenerator()
  const events = new CoordinationEventBus()
  const trace = new TraceModule({ db, clock, handles } as unknown as ModuleHost)
  return createModuleHost({ db, config, clock, handles, events, trace })
}

/** Insert session, prompt, turn and comprehension rows with plain SQL. */
function seedTurn(host: ModuleHost, input: TurnInput = {}): TurnFixture {
  fixtureSerial += 1
  const serial = fixtureSerial
  const created = host.clock.now() + serial
  const interaction = input.interaction ?? 'think'
  const scene = input.scene ?? 'dialogue'
  const intent = input.intent ?? RichComprehension.intent
  const requirement = input.requirement ?? RichComprehension.requirement
  const constraint = input.constraint ?? RichComprehension.constraint
  const assumption = input.assumption ?? RichComprehension.assumption
  const ambiguity = input.ambiguity ?? RichComprehension.ambiguity

  const session = host.db.insert('session', {
    handle: `session-${serial}`,
    principal: 'tester',
    sandbox: 'R:\\tmp',
    interaction,
    scene,
    validation: 'medium',
    profile: 'default',
    generation: 1,
    status: 'active',
    created,
  })
  const turn = host.db.insert('turn', {
    handle: `turn-${serial}`,
    session,
    ordinal: 1,
    command: 'none',
    interaction,
    scene,
    validation: 'medium',
    profession: 'execution',
    locked: 1,
    lockedAt: created,
    effort: 'medium',
    iteration: 1,
    rebuild: 0,
    status: 'organizing',
    created,
  })
  const prompt = host.db.insert('prompt', {
    handle: `prompt-${serial}`,
    turn,
    content: intent,
    created,
  })
  const comprehension = host.db.insert('comprehension', {
    handle: `comprehension-${serial}`,
    turn,
    prompt,
    intent,
    requirement,
    constraint,
    assumption,
    ambiguity,
    confidence: 0.8,
    stageCount: 4,
    model: 'test-model',
    created,
    finished: created,
  })
  host.db.update('turn', { comprehension }, 'identity = ?', turn)
  return { identity: turn, comprehension }
}

/** Insert a plan row directly, bypassing Organization. */
function insertPlan(
  host: ModuleHost,
  turn: number,
  input: {
    goal?: string
    approach?: string
    step?: string
    constraint?: string
    assumption?: string
    orchestration?: boolean
    rebuild?: number
    status?: string
  } = {},
): number {
  return host.db.insert('plan', {
    handle: host.handles.next('plan'),
    turn,
    goal: input.goal ?? WeakPlan.goal,
    approach: input.approach ?? WeakPlan.approach,
    step: input.step ?? WeakPlan.step,
    constraint: input.constraint ?? WeakPlan.constraint,
    assumption: input.assumption ?? WeakPlan.assumption,
    status: input.status ?? 'draft',
    rebuild: input.rebuild ?? 0,
    mode: 'auto',
    orchestration: input.orchestration === true,
    created: host.clock.now(),
  })
}

function dimensionsOf(scores: Array<{ dimension: string; value: number }>): PlanDimensions {
  const collected: Record<string, number> = {}
  for (const score of scores) collected[score.dimension] = score.value
  return collected as unknown as PlanDimensions
}

/**
 * A plan whose weighted total sits between the base 0.5 threshold and the
 * writing 0.6 threshold. Every dimension is inside its threshold, so the same
 * text passes on a dialogue turn and fails only on `total` on a writing turn.
 *
 * The comprehension for this fixture is intent `修复登录接口` with an empty
 * requirement/constraint/assumption: goal+step cover 3 of the 5 intent terms
 * (coverage 0.6) and the plan text covers 4 (alignment 0.8). Ten accepted
 * English steps keep efficiency at 0.5 and cost at ~0.74; the destructive and
 * uncertain markers put risk at 0.5; no digits or tool/path names appear, so
 * specificity stays at 0.6.
 */
function borderlinePlan(): { goal: string; approach: string; step: string } {
  const filler =
    'Perform the documented action on the target and record the evidence for the reviewer, then confirm the observed result against the expected outcome and note the remaining scope, '
  const acceptance = 'the action is recorded and confirmed'
  const riskWords = 'delete maybe perhaps possibly roughly '
  const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
  const steps = ordinals.map((ordinal, index) => ({
    step: `${index === 0 ? riskWords : ''}${filler}${ordinal}`,
    acceptance,
  }))
  return { goal: '修复登录', approach: '接口 token', step: JSON.stringify(steps) }
}

/* ------------------------------------------------------------------------- *
 * computePlanTotal: the documented formula
 * ------------------------------------------------------------------------- */

test('computePlanTotal reproduces the documented weighted formula', () => {
  const weights = TestConfig.plan.weights
  const dimensions: PlanDimensions = {
    feasibility: 1,
    coverage: 0.8,
    clarity: 0.6,
    specificity: 0.7,
    alignment: 0.9,
    risk: 0.2,
    cost: 0.3,
    efficiency: 0.8,
  }
  const documented =
    1 * 0.15 +
    0.8 * 0.15 +
    0.6 * 0.1 +
    0.7 * 0.1 +
    0.9 * 0.2 +
    (1 - 0.2) * 0.1 +
    (1 - 0.3) * 0.1 +
    0.8 * 0.1
  assert.equal(computePlanTotal(dimensions, weights), 0.81)
  assert.ok(Math.abs(computePlanTotal(dimensions, weights) - documented) < 1e-9)

  // All-neutral dimensions must land exactly on the default 0.5 threshold.
  const neutral: PlanDimensions = {
    feasibility: 0.5,
    coverage: 0.5,
    clarity: 0.5,
    specificity: 0.5,
    alignment: 0.5,
    risk: 0.5,
    cost: 0.5,
    efficiency: 0.5,
  }
  assert.equal(computePlanTotal(neutral, weights), 0.5)

  // Weight normalisation: one non-zero weight isolates its dimension.
  const feasibilityOnly = {
    feasibility: 2,
    coverage: 0,
    clarity: 0,
    specificity: 0,
    alignment: 0,
    risk: 0,
    cost: 0,
    efficiency: 0,
  }
  assert.equal(computePlanTotal({ ...neutral, feasibility: 0.73 }, feasibilityOnly), 0.73)
})

/* ------------------------------------------------------------------------- *
 * Organization
 * ------------------------------------------------------------------------- */

test('organize writes one organization and one draft plan per turn', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host)
  const organization = new OrganizationModule(host)

  const plan = organization.organize(fixture.comprehension)

  assert.equal(plan.turn, fixture.identity)
  assert.equal(plan.status, 'draft')
  assert.equal(plan.rebuild, 0)
  assert.equal(plan.mode, 'auto')
  assert.equal(plan.orchestration, false)
  assert.equal(plan.parent, undefined)
  assert.ok(plan.goal.includes(RichComprehension.intent))
  assert.ok(plan.goal.includes(RichComprehension.requirement))
  assert.ok(plan.constraint.includes(RichComprehension.constraint))
  assert.ok(plan.assumption.includes(RichComprehension.assumption))
  assert.ok(plan.approach.length > 40)

  const steps = JSON.parse(plan.step) as PlanStepDraft[]
  assert.ok(Array.isArray(steps))
  assert.ok(steps.length >= 5)
  for (const step of steps) {
    assert.equal(typeof step.step, 'string')
    assert.ok(step.step.trim().length > 0)
    assert.ok((step.acceptance ?? '').trim().length > 0)
  }

  const recorded = organization.forPlan(plan.identity)
  assert.ok(recorded !== undefined)
  assert.equal(recorded.identity, organization.get(recorded.identity).identity)
  assert.equal(recorded.plan, plan.identity)
  assert.equal(recorded.turn, fixture.identity)
  assert.equal(recorded.comprehension, fixture.comprehension)
  assert.equal(recorded.step, plan.step)

  const turnRow = host.db.get<{ organization: number; plan: number }>(
    'SELECT organization, plan FROM turn WHERE identity = ?',
    fixture.identity,
  )
  assert.equal(turnRow?.plan, plan.identity)
  assert.equal(turnRow?.organization, recorded.identity)
  assert.equal(host.db.count('plan'), 1)
  assert.equal(host.db.count('organization'), 1)

  // Organization runs once per turn: a second call is a state error.
  assert.throws(() => organization.organize(fixture.comprehension), InvalidStateError)
})

test('orchestration subtask drafts each carry a non-empty acceptance', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host, { interaction: 'orchestrate' })
  const plan = new OrganizationModule(host).organize(fixture.comprehension)

  assert.equal(plan.orchestration, true)
  const drafts = JSON.parse(plan.step) as PlanSubtaskDraft[]
  assert.ok(Array.isArray(drafts))
  assert.ok(drafts.length >= 4)
  for (const draft of drafts) {
    assert.equal(typeof draft.task, 'string')
    assert.ok(draft.task.trim().length > 0)
    assert.equal(typeof draft.acceptance, 'string')
    assert.ok(draft.acceptance.trim().length > 0)
    assert.ok(['execution', 'outcome', 'decision'].includes(draft.profession))
  }
  const professions = drafts.map((draft) => draft.profession)
  assert.ok(professions.includes('execution'))
  assert.ok(professions.includes('outcome'))
  assert.ok(professions.includes('decision'))
  // config.orchestration.groundTruth defaults to true, so the verifier carries one.
  assert.ok(drafts.some((draft) => draft.groundTruth !== undefined))
})

test('writing scene composes outline, draft and revision steps in order', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host, { scene: 'writing' })
  const plan = new OrganizationModule(host).organize(fixture.comprehension)

  assert.equal(plan.orchestration, false)
  const steps = JSON.parse(plan.step) as PlanStepDraft[]
  const indices = WritingStages.map((stage) =>
    steps.findIndex((step) => step.step.startsWith(WritingStageMarkers[stage])),
  )
  assert.ok(indices.every((index) => index >= 0), `missing a writing stage: ${JSON.stringify(steps)}`)
  assert.ok(indices[0] < indices[1])
  assert.ok(indices[1] < indices[2])
  for (const step of steps) {
    assert.ok((step.acceptance ?? '').trim().length > 0)
  }
  const texts = steps.map((step) => step.step)
  assert.ok(texts.some((text) => text.includes('大纲')))
  assert.ok(texts.some((text) => text.includes('草稿')))
  assert.ok(texts.some((text) => text.includes('修订')))
})

test('writing orchestration drafts keep the outline, draft and revision sequence', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host, { scene: 'writing', interaction: 'orchestrate' })
  const plan = new OrganizationModule(host).organize(fixture.comprehension)

  assert.equal(plan.orchestration, true)
  const drafts = JSON.parse(plan.step) as PlanSubtaskDraft[]
  const indices = WritingStages.map((stage) =>
    drafts.findIndex((draft) => draft.task.startsWith(WritingStageMarkers[stage])),
  )
  assert.ok(indices.every((index) => index >= 0), `missing a writing stage: ${JSON.stringify(drafts)}`)
  assert.ok(indices[0] < indices[1])
  assert.ok(indices[1] < indices[2])
  for (const draft of drafts) {
    assert.ok(draft.acceptance.trim().length > 0)
    assert.ok(['execution', 'outcome', 'decision'].includes(draft.profession))
  }
  assert.ok(drafts.some((draft) => draft.groundTruth !== undefined))
})

/* ------------------------------------------------------------------------- *
 * Scoring
 * ------------------------------------------------------------------------- */

test('score persists the eight dimensions and matches compute', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host)
  const plan = new OrganizationModule(host).organize(fixture.comprehension)
  const plans = new PlanModule(host)

  // compute writes nothing.
  const computed = plans.compute(plan.identity)
  assert.equal(host.db.count('score'), 0)
  assert.equal(computed, computePlanTotal(plans.dimensions(plan.identity), host.config.plan.weights))

  const result = plans.score(plan.identity)
  assert.equal(result.scores.length, 8)
  assert.equal(result.pass, true)
  assert.deepEqual(result.failing, [])
  assert.deepEqual(
    result.scores.map((score) => score.dimension).sort(),
    [...PlanDimensionNames].sort(),
  )
  for (const score of result.scores) {
    assert.equal(score.category, 'plan')
    assert.equal(score.target, plan.identity)
    assert.ok(score.value >= 0 && score.value <= 1)
  }
  assert.equal(host.db.count('score', "category = 'plan' AND target = ?", plan.identity), 8)
  assert.equal(host.db.count('score'), 8)

  const dimensions = dimensionsOf(result.scores)
  assert.equal(computePlanTotal(dimensions, host.config.plan.weights), result.total)
  assert.equal(plans.compute(plan.identity), result.total)
  assert.equal(plans.get(plan.identity).status, 'scored')
  assert.equal(plans.shouldRebuild(plan.identity), false)

  // Re-scoring updates the same eight rows instead of appending history.
  const identities = result.scores.map((score) => score.identity).sort()
  const rescored = plans.score(plan.identity)
  assert.equal(host.db.count('score', "category = 'plan' AND target = ?", plan.identity), 8)
  assert.deepEqual(rescored.scores.map((score) => score.identity).sort(), identities)
  assert.deepEqual(
    rescored.scores.map((score) => score.value).sort(),
    result.scores.map((score) => score.value).sort(),
  )
})

test('a vague plan fails the threshold matrix', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host)
  const weak = insertPlan(host, fixture.identity)
  const plans = new PlanModule(host)

  const result = plans.score(weak)
  assert.equal(result.pass, false)
  assert.ok(result.total < host.config.plan.threshold)
  assert.ok(result.failing.includes('feasibility'))
  assert.ok(result.failing.includes('coverage'))
  assert.ok(result.failing.includes('clarity'))
  assert.ok(result.failing.includes('specificity'))
  assert.ok(result.failing.includes('alignment'))
  assert.ok(result.failing.includes('efficiency'))
  assert.ok(result.failing.includes('total'))
  assert.equal(plans.get(weak).status, 'scored')
  assert.equal(plans.shouldRebuild(weak), true)
})

test('risk and cost are upper-bounded dimensions', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host)
  const plans = new PlanModule(host)

  // Ten distinct destructive markers, no stated constraint to relieve them.
  const risky = insertPlan(host, fixture.identity, {
    goal: '删除 清空 覆盖 强制 旧数据',
    approach: 'Delete, truncate, purge, wipe, drop and overwrite the legacy rows until the table is empty.',
    step: '[]',
  })
  assert.equal(plans.dimensions(risky).risk, 1)
  assert.ok(plans.score(risky).failing.includes('risk'))

  // Twelve long steps: the step count and the text length push cost up.
  const longFragment =
    'perform the documented action on the target and confirm the observed result before recording the evidence for the reviewer, '
  const costlySteps = Array.from({ length: 12 }, (_, index) => ({
    step: `${longFragment.repeat(2)}${index}`,
    acceptance: 'the action is confirmed and recorded',
  }))
  const costly = insertPlan(host, fixture.identity, {
    goal: 'Carry out the documented task',
    approach: 'Carry out every step in order, verify every acceptance criterion, then report the evidence.',
    step: JSON.stringify(costlySteps),
    constraint: 'stay inside the workspace',
    assumption: 'the workspace is writable',
  })
  assert.ok(plans.dimensions(costly).cost > 0.8)
  assert.ok(plans.score(costly).failing.includes('cost'))
})

test('a plan between 0.5 and 0.6 passes for dialogue and fails for writing', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const plans = new PlanModule(host)
  const borderline = borderlinePlan()
  const borderlineComprehension = {
    intent: '修复登录接口',
    requirement: '',
    constraint: '',
    assumption: '',
    ambiguity: '',
  }
  const writingFixture = seedTurn(host, { scene: 'writing', ...borderlineComprehension })
  const dialogueFixture = seedTurn(host, { scene: 'dialogue', ...borderlineComprehension })
  const writingPlan = insertPlan(host, writingFixture.identity, borderline)
  const dialoguePlan = insertPlan(host, dialogueFixture.identity, borderline)

  assert.equal(WritingScoreThreshold, 0.6)
  assert.equal(PlanScenePolicies.writing.scoreThreshold, 0.6)
  assert.equal(planScoreThreshold('writing', 0.5), 0.6)
  assert.equal(planScoreThreshold('dialogue', 0.5), 0.5)
  assert.equal(planScoreThreshold('office', 0.5), 0.5)
  assert.equal(planScoreThreshold('writing', 0.5, 0.75), 0.75)
  assert.equal(plans.threshold(dialoguePlan), host.config.plan.threshold)
  assert.equal(plans.threshold(writingPlan), WritingScoreThreshold)

  const dialogue = plans.score(dialoguePlan)
  const writing = plans.score(writingPlan)
  assert.equal(dialogue.total, writing.total)
  assert.ok(dialogue.total >= 0.5 && dialogue.total < 0.6, `total ${dialogue.total} is outside (0.5, 0.6)`)
  assert.equal(dialogue.pass, true)
  assert.deepEqual(dialogue.failing, [])
  assert.equal(writing.pass, false)
  assert.deepEqual(writing.failing, ['total'])
})

test('config.scenes.writing.scoreThreshold overrides the local writing policy', (context) => {
  const host = createHost(configWithWritingThreshold(0.99))
  context.after(() => host.db.close())
  const plans = new PlanModule(host)

  const writing = seedTurn(host, { scene: 'writing' })
  const writingPlan = new OrganizationModule(host).organize(writing.comprehension)
  assert.equal(plans.threshold(writingPlan.identity), 0.99)
  const writingScore = plans.score(writingPlan.identity)
  assert.equal(writingScore.pass, false)
  assert.deepEqual(writingScore.failing, ['total'])
  assert.ok(writingScore.total < 0.99)

  const dialogue = seedTurn(host, { scene: 'dialogue' })
  const dialoguePlan = new OrganizationModule(host).organize(dialogue.comprehension)
  assert.equal(plans.threshold(dialoguePlan.identity), host.config.plan.threshold)
  assert.equal(plans.score(dialoguePlan.identity).pass, true)
})

/* ------------------------------------------------------------------------- *
 * Rebuild
 * ------------------------------------------------------------------------- */

test('a low plan rebuilds deterministically with a rebuild record', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host)
  const weak = insertPlan(host, fixture.identity)
  const plans = new PlanModule(host)

  assert.equal(plans.shouldRebuild(weak), true)
  const rebuilt = plans.rebuild(weak)

  assert.equal(rebuilt.parent, weak)
  assert.equal(rebuilt.rebuild, 1)
  assert.equal(rebuilt.status, 'draft')
  assert.equal(rebuilt.turn, fixture.identity)
  assert.equal(rebuilt.orchestration, false)
  assert.equal(rebuilt.mode, 'auto')
  assert.ok(rebuilt.goal.includes(RichComprehension.intent))
  assert.ok(rebuilt.constraint.includes(RichComprehension.constraint))
  assert.ok(rebuilt.assumption.includes(RichComprehension.assumption))

  const steps = JSON.parse(rebuilt.step) as PlanStepDraft[]
  assert.equal(steps.length, 4) // two seeded steps plus one verification each
  for (const step of steps) assert.ok((step.acceptance ?? '').trim().length > 0)
  assert.equal(steps.filter((step) => step.step.startsWith('Verify: ')).length, 2)

  const previous = plans.get(weak)
  assert.equal(previous.status, 'rebuilt')
  assert.ok(previous.finished !== undefined)
  assert.equal(plans.forTurn(fixture.identity)?.identity, rebuilt.identity)

  const records = host.db.all<Record<string, unknown>>(
    'SELECT * FROM plan_rebuild WHERE plan = ?',
    rebuilt.identity,
  )
  assert.equal(records.length, 1)
  const record = records[0] as Record<string, unknown>
  assert.equal(record.plan, rebuilt.identity)
  assert.equal(record.attempt, 1)
  assert.equal(record.reason, 'score below threshold')
  assert.ok(String(record.dimension).includes('coverage'))
  const before = JSON.parse(String(record.beforeScore)) as { total: number }
  const after = JSON.parse(String(record.afterScore)) as { total: number }
  assert.equal(before.total, plans.compute(weak))
  assert.equal(after.total, plans.compute(rebuilt.identity))
  assert.ok(before.total < after.total)

  // The rebuild is audited through the trace bus.
  assert.ok(host.trace.list(fixture.identity).some((event) => event.event === 'rebuild'))

  // A rebuilt plan is terminal and cannot be rebuilt again.
  assert.throws(() => plans.rebuild(weak), InvalidStateError)
})

test('rebuild preserves orchestration and adds one verification draft per subtask', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host, { interaction: 'orchestrate' })
  const weak = insertPlan(host, fixture.identity, { orchestration: true })
  const plans = new PlanModule(host)

  const rebuilt = plans.rebuild(weak)
  assert.equal(rebuilt.orchestration, true)
  const drafts = JSON.parse(rebuilt.step) as PlanSubtaskDraft[]
  assert.equal(drafts.length, 4) // two seeded drafts plus one verification each
  for (const draft of drafts) {
    assert.ok(draft.task.trim().length > 0)
    assert.ok(draft.acceptance.trim().length > 0)
    assert.ok(['execution', 'outcome', 'decision'].includes(draft.profession))
  }
  assert.equal(drafts.filter((draft) => draft.task.startsWith('Verify: ')).length, 2)
})

test('the rebuild limit marks the plan failed instead of throwing', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host)
  const plans = new PlanModule(host)

  assert.equal(host.config.plan.maxRebuild, 3)
  const exhausted = insertPlan(host, fixture.identity, { rebuild: 3 })
  assert.equal(plans.shouldRebuild(exhausted), false)
  assert.equal(plans.get(exhausted).status, 'failed')
  assert.ok(plans.get(exhausted).finished !== undefined)
  assert.throws(() => plans.rebuild(exhausted), InvalidStateError)
})

test('a third rebuild that still fails ends the plan as failed', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host)
  const plans = new PlanModule(host)

  const weak = insertPlan(host, fixture.identity, { rebuild: 2 })
  assert.equal(plans.shouldRebuild(weak), true)
  const third = plans.rebuild(weak)
  assert.equal(third.rebuild, 3)
  assert.equal(plans.shouldRebuild(third.identity), false)

  // Force the third attempt to stay low so the budget is genuinely spent.
  host.db.update(
    'plan',
    { goal: WeakPlan.goal, approach: WeakPlan.approach, step: WeakPlan.step, constraint: WeakPlan.constraint, assumption: WeakPlan.assumption },
    'identity = ?',
    third.identity,
  )
  assert.equal(plans.shouldRebuild(third.identity), false)
  assert.equal(plans.get(third.identity).status, 'failed')
})

/* ------------------------------------------------------------------------- *
 * Rebuild record and lifecycle
 * ------------------------------------------------------------------------- */

test('recordRebuild appends an audit row and validates its input', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host)
  const plan = new OrganizationModule(host).organize(fixture.comprehension)
  const plans = new PlanModule(host)

  const record = plans.recordRebuild(
    plan.identity,
    1,
    'manual rebuild',
    'alignment,risk',
    '{"total":0.4}',
    '{"total":0.8}',
  )
  assert.equal(record.plan, plan.identity)
  assert.equal(record.attempt, 1)
  assert.equal(record.reason, 'manual rebuild')
  assert.equal(record.dimension, 'alignment,risk')
  assert.equal(record.beforeScore, '{"total":0.4}')
  assert.equal(record.afterScore, '{"total":0.8}')
  assert.ok(record.handle.length > 0)

  assert.throws(
    () => plans.recordRebuild(plan.identity, 0, 'bad attempt', 'none', '{}', '{}'),
    InvalidArgumentError,
  )
  assert.throws(
    () => plans.recordRebuild(9_999, 1, 'missing plan', 'none', '{}', '{}'),
    NotFoundError,
  )
})

test('a terminal plan cannot be revived', (context) => {
  const host = createHost()
  context.after(() => host.db.close())
  const fixture = seedTurn(host)
  const plan = new OrganizationModule(host).organize(fixture.comprehension)
  const plans = new PlanModule(host)

  assert.equal(plans.activate(plan.identity).status, 'active')
  const done = plans.complete(plan.identity)
  assert.equal(done.status, 'done')
  assert.ok(done.finished !== undefined)
  // Same-status calls are idempotent; any real transition is a revive.
  assert.equal(plans.complete(plan.identity).status, 'done')
  assert.throws(() => plans.activate(plan.identity), InvalidStateError)
  assert.throws(() => plans.setStatus(plan.identity, 'draft'), InvalidStateError)
  assert.equal(plans.get(plan.identity).status, 'done')
})
