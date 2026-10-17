/**
 * Comprehension module tests (v23 §6.3/§9.5 as amended, §11.9, §11.10).
 *
 * The suite runs against an in-memory coordination database and a minimal host:
 * no Cordis, no DSH, no HTTP server. Session, turn and prompt rows are inserted
 * with raw SQL and the turn/prompt ids are handed to the module, so the tests do
 * not depend on any module owned by another agent.
 *
 * Covered contract:
 *  - `comprehensionPolicy` exposes the per-level search/scope/volume/stage plan;
 *  - every level runs all four stages by default, with policy-sized search;
 *  - a policy override can disable search and the Bayesian stages, in which
 *    case ordinals 3 and 4 are written as `skipped`;
 *  - a self-harm marker produces a crisis line from the emotion stage;
 *  - route probabilities sum to 1 and `best` is the highest route;
 *  - stage rows are persisted with ordinals and can be re-run append-only;
 *  - `config.comprehension.searchEnabled` disables search for every level;
 *  - a failing or hanging search still commits the stage as `done`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CoordinationDatabase } from '../src/host/database.js'
import { createModuleHost } from '../src/host/module.js'
import type { ModuleHost, TraceWriter, WebSearchPort } from '../src/host/module.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { ComprehensionModule, comprehensionPolicy, comprehensionQueryBudget } from '../src/host/comprehension.js'
import type { ComprehendInput, ComprehensionPolicy, ComprehensionPolicyPatch } from '../src/host/comprehension.js'
import type { ComprehensionStageRecord } from '../src/shared/entity.js'
import type { Interaction, Scene, Validation } from '../src/shared/enum.js'
import { NotFoundError } from '../src/shared/error.js'
import { SceneProfiles } from '../src/shared/enum.js'

/* ------------------------------------------------------------------------- *
 * Fixture
 * ------------------------------------------------------------------------- */

interface FixtureOptions {
  validation?: Validation
  interaction?: Interaction
  scene?: Scene
  content?: string
  web?: WebSearchPort
  policies?: Partial<Record<Validation, ComprehensionPolicyPatch>>
  stageTimeout?: number
  searchEnabled?: boolean
  maxEvidence?: number
  prior?: number
  stopEntropy?: number
}

interface Fixture {
  db: CoordinationDatabase
  host: ModuleHost
  module: ComprehensionModule
  session: number
  turn: number
  promptIdentity: number
  content: string
  interaction: Interaction
  scene: Scene
  validation: Validation
  close(): void
}

/**
 * Mirror of `resolveConfig()`'s resolved shape. `config.ts` imports
 * `@deepseek-ai/schemastery` at runtime, which this unit test deliberately does
 * not need: the comprehension module only reads `comprehension` and `bayesian`.
 */
function fixtureConfig(options: FixtureOptions): CoordinationConfig {
  return {
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
    bayesian: {
      prior: options.prior ?? 0.5,
      stopEntropy: options.stopEntropy ?? 0.05,
      infoGain: 0.01,
      maxRoutes: 12,
      calibrationFloor: 0.1,
    },
    comprehension: {
      stageTimeout: options.stageTimeout ?? 30000,
      searchEnabled: options.searchEnabled ?? true,
      maxEvidence: options.maxEvidence ?? 8,
      highHistoryWindow: 20,
    },
    compaction: {
      auto: true,
      soft: 0.7,
      hard: 0.88,
      reserve: 2048,
      recentTurns: 6,
      cooldown: 30000,
      maxPerSession: 20,
    },
    parser: {
      enabled: true,
      maxFileBytes: 1_048_576,
      maxTokens: 200_000,
      maxAstDepth: 256,
      timeoutMs: 2000,
      cacheCapacity: 256,
      dependencyGraphMaxVertices: 20_000,
      dependencyGraphMaxEdges: 100_000,
    },
    chain: { depth: 8, links: 50, tokenBudget: 1500 },
    tools: { maxResultBytes: 0 },
    ui: { toolbar: true, showTooltip: true, takeover: false, refreshInterval: 5000, compact: true, locale: 'auto' },
    scenes: { ...SceneProfiles },
    defaults: {
      profession: 'execution',
      interaction: 'think',
      scene: 'dialogue',
      validation: 'medium',
      command: 'none',
    },
  }
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const interaction = options.interaction ?? 'think'
  const scene = options.scene ?? 'engineering'
  const validation = options.validation ?? 'medium'
  const content = options.content ?? '请帮我实现一个导出 CSV 的函数，必须兼容现有接口。'
  const db = new CoordinationDatabase(':memory:')
  const created = Date.now()

  // The comprehension module never appends an orchestration trace: the trace
  // event vocabulary is lock/rebuild/abandon/dispatch/submit/verify/recover/
  // synthesize, none of which a comprehension stage is.
  const trace: TraceWriter = {
    append: () => {
      throw new Error('comprehension must not append an orchestration trace')
    },
    list: () => [],
    verify: () => ({ ok: true }),
  }
  const host = createModuleHost({
    db,
    config: fixtureConfig(options),
    trace,
    ...(options.web === undefined ? {} : { web: options.web }),
  })
  const module = new ComprehensionModule(host, options.policies ?? {})

  const session = db.run(
    `INSERT INTO session (handle, principal, sandbox, interaction, scene, validation, profile, generation, status, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'session-comprehension-test',
    'local',
    'R:\\project',
    interaction,
    scene,
    validation,
    'test',
    1,
    'active',
    created,
  ).lastInsertRowid

  const turn = db.run(
    `INSERT INTO turn (handle, session, ordinal, command, interaction, scene, validation, profession, locked, effort, iteration, rebuild, status, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'turn-comprehension-test',
    session,
    1,
    'none',
    interaction,
    scene,
    validation,
    'execution',
    0,
    'medium',
    1,
    0,
    'comprehending',
    created,
  ).lastInsertRowid

  const promptIdentity = db.run(
    'INSERT INTO prompt (handle, turn, content, created) VALUES (?, ?, ?, ?)',
    'prompt-comprehension-test',
    turn,
    content,
    created,
  ).lastInsertRowid

  return {
    db,
    host,
    module,
    session,
    turn,
    promptIdentity,
    content,
    interaction,
    scene,
    validation,
    close: () => db.close(),
  }
}

function inputFor(fixture: Fixture, overrides: Partial<ComprehendInput> = {}): ComprehendInput {
  return {
    turn: fixture.turn,
    promptIdentity: fixture.promptIdentity,
    prompt: fixture.content,
    interaction: fixture.interaction,
    scene: fixture.scene,
    validation: fixture.validation,
    ...overrides,
  }
}

interface StageRow {
  identity: number
  handle: string
  comprehension: number
  stage: string
  ordinal: number
  status: string
  input: string | null
  output: string | null
  confidence: number | null
  entropyBefore: number | null
  entropyAfter: number | null
}

function stageRows(fixture: Fixture, comprehension: number): StageRow[] {
  return fixture.db.all<StageRow>(
    'SELECT * FROM comprehension_stage WHERE comprehension = ? ORDER BY ordinal ASC, identity ASC',
    comprehension,
  )
}

/* ------------------------------------------------------------------------- *
 * Validation policy
 * ------------------------------------------------------------------------- */

test('comprehensionPolicy documents search scope and volume for every level', () => {
  const low = comprehensionPolicy('low')
  assert.equal(low.validation, 'low')
  assert.equal(low.search, true)
  assert.equal(low.scope, 'turn')
  assert.equal(low.maxQueries, 1)
  assert.equal(low.maxResults, 3)
  assert.equal(low.historyLimit, 0)
  assert.deepEqual(low.stages, { heuristic: true, converge: true })
  assert.equal(low.globalFusion, false)

  const medium = comprehensionPolicy('medium')
  assert.equal(medium.search, true)
  assert.equal(medium.scope, 'session')
  assert.equal(medium.maxQueries, 2)
  assert.equal(medium.maxResults, 5)
  assert.deepEqual(medium.stages, { heuristic: true, converge: true })

  const high = comprehensionPolicy('high')
  assert.equal(high.search, true)
  assert.equal(high.scope, 'local')
  assert.equal(high.maxQueries, 4)
  assert.equal(high.maxResults, 8)
  assert.equal(high.globalFusion, true)
  assert.deepEqual(high.stages, { heuristic: true, converge: true })

  // Deployment caps and the master search switch are applied on top.
  assert.equal(comprehensionPolicy('high', { searchEnabled: false }).search, false)
  assert.equal(comprehensionPolicy('high', { maxEvidence: 2 }).maxResults, 2)
  assert.equal(comprehensionPolicy('high', { highHistoryWindow: 3 }).historyLimit, 3)

  // Query budget split: heuristic first, converge second.
  assert.deepEqual(comprehensionQueryBudget(0), { heuristic: 0, converge: 0 })
  assert.deepEqual(comprehensionQueryBudget(1), { heuristic: 1, converge: 0 })
  assert.deepEqual(comprehensionQueryBudget(2), { heuristic: 1, converge: 1 })
  assert.deepEqual(comprehensionQueryBudget(3), { heuristic: 2, converge: 1 })
  assert.deepEqual(comprehensionQueryBudget(4), { heuristic: 2, converge: 2 })
})

test('low validation runs all four stages with the narrow one-query budget', async () => {
  const requests: Array<{ maxResults?: number }> = []
  const web: WebSearchPort = {
    search: async (request) => {
      requests.push({ maxResults: request.maxResults })
      return ['first result', 'second result', 'third result', 'fourth result', 'fifth result']
    },
  }
  const fixture = createFixture({
    validation: 'low',
    content: '请解释这个函数返回值的含义，必须给出一个例子。',
    web,
  })
  try {
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    const stages = fixture.module.stages(comprehension.identity)

    assert.deepEqual(stages.map((stage) => stage.ordinal), [1, 2, 3, 4])
    assert.deepEqual(stages.map((stage) => stage.status), ['done', 'done', 'done', 'done'])
    assert.equal(comprehension.stageCount, 4)
    assert.equal(typeof comprehension.entropy, 'number')
    assert.ok((comprehension.route ?? '').startsWith('['))
    assert.ok((comprehension.failure ?? '').startsWith('['))

    // low = 1 query x 3 results, current-turn scope: the single query is spent
    // by the heuristic stage, so converge runs its Bayesian update without one.
    assert.equal(requests.length, 1)
    assert.equal(requests[0].maxResults, 3)
    const heuristicOutput = JSON.parse(stages[2].output ?? '{}') as { evidence?: string[] }
    assert.ok(Array.isArray(heuristicOutput.evidence))
    assert.ok((heuristicOutput.evidence ?? []).length <= 3)

    // The resolved policy is stored with the stage input for audit.
    const heuristicInput = JSON.parse(stages[2].input ?? '{}') as { policy?: ComprehensionPolicy }
    assert.equal(heuristicInput.policy?.scope, 'turn')
    assert.equal(heuristicInput.policy?.maxQueries, 1)
    assert.equal(heuristicInput.policy?.maxResults, 3)
  } finally {
    fixture.close()
  }
})

test('high validation spends four queries with the widest result cap', async () => {
  const requests: Array<{ maxResults?: number }> = []
  const web: WebSearchPort = {
    search: async (request) => {
      requests.push({ maxResults: request.maxResults })
      return ['a result', 'b result']
    },
  }
  const fixture = createFixture({
    validation: 'high',
    content: '请调研所有会话与工程文件，给出这次迁移的方案。',
    web,
  })
  try {
    await fixture.module.comprehend(inputFor(fixture))
    // high = 4 queries (2 heuristic + 2 converge), each allowing 8 results.
    assert.equal(requests.length, 4)
    for (const request of requests) assert.equal(request.maxResults, 8)
  } finally {
    fixture.close()
  }
})

test('a policy override can skip the bayesian stages while keeping ordinals 3 and 4', async () => {
  const fixture = createFixture({
    validation: 'low',
    content: '帮我把这个项目的构建时间降下来，必须在本周内完成。',
    policies: { low: { search: false, stages: { heuristic: false, converge: false } } },
  })
  try {
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    const stages = fixture.module.stages(comprehension.identity)

    assert.deepEqual(stages.map((stage) => stage.ordinal), [1, 2, 3, 4])
    assert.deepEqual(stages.map((stage) => stage.stage), ['emotion', 'think', 'heuristic', 'converge'])
    assert.deepEqual(stages.map((stage) => stage.status), ['done', 'done', 'skipped', 'skipped'])

    // A skipped stage produces no route, entropy, boundary or evidence.
    assert.equal(comprehension.entropy, undefined)
    assert.equal(comprehension.route, undefined)
    assert.equal(comprehension.failure, undefined)
    assert.equal(comprehension.boundary, undefined)
    assert.equal(comprehension.evidence, undefined)

    // Emotion and think are still stored, and confidence falls back to think.
    assert.ok((comprehension.empathy ?? '').length > 0)
    assert.ok((comprehension.think ?? '').length > 0)
    assert.ok((comprehension.intent ?? '').length > 0)
    assert.ok((comprehension.constraint ?? '').includes('必须'))
    assert.ok(comprehension.confidence > 0 && comprehension.confidence <= 1)
    assert.equal(comprehension.stageCount, 2)
    assert.ok(comprehension.finished !== undefined)

    const thinkRow = stages[1]
    assert.ok(thinkRow.confidence !== null)
    assert.equal(comprehension.confidence, thinkRow.confidence)

    const skippedInput = JSON.parse(stages[2].input ?? '{}') as { policy?: { search?: boolean } }
    assert.equal(skippedInput.policy?.search, false)
  } finally {
    fixture.close()
  }
})

test('medium validation runs all four stages and records evidence', async () => {
  const fixture = createFixture({
    validation: 'medium',
    content: '请实现一个导出 CSV 的函数，必须保持现有接口不变，不要新增依赖。',
  })
  try {
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    const stages = fixture.module.stages(comprehension.identity)

    assert.deepEqual(stages.map((stage) => stage.status), ['done', 'done', 'done', 'done'])
    assert.equal(comprehension.stageCount, 4)
    assert.equal(typeof comprehension.entropy, 'number')
    assert.ok((comprehension.boundary ?? '').includes('边界'))
    assert.ok((comprehension.route ?? '').startsWith('['))
    assert.ok((comprehension.failure ?? '').startsWith('['))
    assert.ok((comprehension.evidence ?? '').startsWith('['))

    const routes = JSON.parse(comprehension.route ?? '[]') as Array<{ name: string; probability: number }>
    const failures = JSON.parse(comprehension.failure ?? '[]') as Array<{ name: string; probability: number }>
    assert.ok(routes.length >= 2)
    assert.ok(failures.length >= 2)

    // Bayesian stages record both ends of their entropy update.
    assert.ok(stages[2].entropyBefore !== null)
    assert.ok(stages[2].entropyAfter !== null)
    assert.ok(stages[3].entropyBefore !== null)
    assert.ok(stages[3].entropyAfter !== null)

    const emotionOutput = JSON.parse(stages[0].output ?? '{}') as { label?: string; empathy?: string }
    const thinkOutput = JSON.parse(stages[1].output ?? '{}') as { reasoning?: string; intent?: string }
    const heuristicOutput = JSON.parse(stages[2].output ?? '{}') as { routes?: unknown[]; best?: string }
    const convergeOutput = JSON.parse(stages[3].output ?? '{}') as { failures?: unknown[]; stop?: boolean }
    assert.ok((emotionOutput.label ?? '').length > 0)
    assert.ok((emotionOutput.empathy ?? '').length > 0)
    assert.ok((thinkOutput.reasoning ?? '').length > 0)
    assert.ok((thinkOutput.intent ?? '').length > 0)
    assert.ok(Array.isArray(heuristicOutput.routes) && heuristicOutput.routes.length >= 2)
    assert.ok(Array.isArray(convergeOutput.failures) && convergeOutput.failures.length >= 2)
    assert.equal(typeof convergeOutput.stop, 'boolean')
  } finally {
    fixture.close()
  }
})

test('runStage keeps a policy-disabled bayesian stage skipped', async () => {
  const fixture = createFixture({
    validation: 'low',
    content: '请解释这个报错是什么意思。',
    policies: { low: { search: false, stages: { heuristic: false, converge: false } } },
  })
  try {
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    const rerun = await fixture.module.runStage(comprehension.identity, 'heuristic')
    assert.equal(rerun.stage, 'heuristic')
    assert.equal(rerun.ordinal, 3)
    assert.equal(rerun.status, 'skipped')
    assert.equal(stageRows(fixture, comprehension.identity).filter((row) => row.stage === 'heuristic').length, 2)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Emotion and think stages
 * ------------------------------------------------------------------------- */

test('emotion stage returns a crisis line for self-harm markers and none otherwise', async () => {
  const fixture = createFixture()
  try {
    const crisis = await fixture.module.emotion('我真的不想活了，想结束生命，感觉走到尽头了。')
    assert.equal(crisis.label, 'crisis')
    assert.ok(crisis.crisis !== undefined && crisis.crisis.length > 0)
    assert.ok(crisis.intensity >= 0.6 && crisis.intensity <= 1)
    assert.match(crisis.empathy, /[\u4e00-\u9fff]/)

    const worried = await fixture.module.emotion('我有点担心这个方案的风险，怎么办？')
    assert.equal(worried.label, 'worry')
    assert.equal(worried.crisis, undefined)
    assert.ok(worried.intensity > 0 && worried.intensity < crisis.intensity)

    const neutral = await fixture.module.emotion('帮我看一下这个配置文件。')
    assert.equal(neutral.label, 'neutral')
    assert.equal(neutral.crisis, undefined)
    assert.match(neutral.empathy, /[\u4e00-\u9fff]/)
  } finally {
    fixture.close()
  }
})

test('think stage extracts intent, requirement, constraint, assumption and ambiguity', async () => {
  const fixture = createFixture()
  try {
    const prompt = '请重构 ModuleLoader。必须保持公开接口不变，不要新增依赖。'
    const emotion = await fixture.module.emotion(prompt)
    const think = await fixture.module.think(prompt, emotion)

    assert.equal(think.intent, '请重构 ModuleLoader')
    assert.ok(think.requirement.startsWith('请重构 ModuleLoader'))
    assert.ok(think.constraint.includes('必须'))
    assert.ok(think.constraint.includes('不要'))
    assert.ok(think.assumption.length > 0)
    assert.equal(think.ambiguity, '无明显歧义')
    assert.ok(think.confidence > 0.5 && think.confidence <= 1)
    assert.ok(think.reasoning.includes('意图'))
    assert.ok(think.reasoning.includes('约束'))

    const vague = await fixture.module.think('改一下', emotion)
    assert.notEqual(vague.ambiguity, '无明显歧义')
    assert.ok(vague.confidence < think.confidence)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Heuristic and converge stages
 * ------------------------------------------------------------------------- */

test('heuristic probabilities sum to one and best is the highest route', async () => {
  const fixture = createFixture()
  try {
    const prompt = '请实现一个登录接口，必须兼容现有代码，同时补充测试。'
    const emotion = await fixture.module.emotion(prompt)
    const think = await fixture.module.think(prompt, emotion)
    const heuristic = await fixture.module.heuristic(prompt, think, { validation: 'medium', scene: 'engineering' })

    assert.ok(heuristic.routes.length >= 2)
    const total = heuristic.routes.reduce((sum, route) => sum + route.probability, 0)
    assert.ok(Math.abs(total - 1) < 0.002, `probabilities must sum to approximately 1, got ${total}`)

    for (let index = 1; index < heuristic.routes.length; index += 1) {
      assert.ok(heuristic.routes[index - 1].probability >= heuristic.routes[index].probability)
    }
    const top = heuristic.routes.reduce((best, route) => (route.probability > best.probability ? route : best))
    assert.equal(heuristic.best, top.name)
    assert.ok(heuristic.entropy >= 0 && heuristic.entropy <= 1)
    assert.ok(Math.abs(heuristic.confidence - (1 - heuristic.entropy)) < 1e-3)
    // Every route carries a full English word name and a description.
    for (const route of heuristic.routes) {
      assert.match(route.name, /^[a-z-]+$/)
      assert.ok(route.description.length > 0)
    }
    // No web port was injected: no fabricated citation may appear.
    assert.deepEqual(heuristic.evidence, [])

    // Caller-supplied session evidence is labelled as session evidence.
    const withContext = await fixture.module.heuristic(prompt, think, {
      validation: 'low',
      evidence: ['当前会话：遗留接口不可改'],
    })
    assert.ok(withContext.evidence.includes('session: 当前会话：遗留接口不可改'))
  } finally {
    fixture.close()
  }
})

test('converge ranks failure routes and stops when no route dominates', async () => {
  const fixture = createFixture()
  try {
    const prompt = '请把这批配置迁移到新环境，顺便清理旧数据。'
    const emotion = await fixture.module.emotion(prompt)
    const think = await fixture.module.think(prompt, emotion)
    const heuristic = await fixture.module.heuristic(prompt, think, { validation: 'low', scene: 'office' })
    const converge = await fixture.module.converge(prompt, heuristic)

    assert.ok(converge.failures.length >= 2)
    const total = converge.failures.reduce((sum, failure) => sum + failure.probability, 0)
    assert.ok(Math.abs(total - 1) < 0.002, `failure probabilities must sum to 1, got ${total}`)
    assert.ok(converge.boundary.includes('边界'))
    assert.ok(converge.failures.some((failure) => failure.name === 'unsafe-action'))
    // A single dominant route (> 0.5) keeps the loop open; otherwise it stops.
    const dominant = converge.failures.some((failure) => failure.probability > 0.5)
    assert.equal(converge.stop, !dominant)
    assert.ok(converge.evidence.some((entry) => entry.startsWith('session: ')))
  } finally {
    fixture.close()
  }
})

test('the configured bayesian prior sharpens or flattens the route distribution', async () => {
  const prompt = '请实现一个登录接口，必须兼容现有代码。'
  const sharp = createFixture({ prior: 0.1 })
  const flat = createFixture({ prior: 0.9 })
  try {
    const sharpEmotion = await sharp.module.emotion(prompt)
    const sharpThink = await sharp.module.think(prompt, sharpEmotion)
    const sharpHeuristic = await sharp.module.heuristic(prompt, sharpThink, { validation: 'low', scene: 'engineering' })

    const flatEmotion = await flat.module.emotion(prompt)
    const flatThink = await flat.module.think(prompt, flatEmotion)
    const flatHeuristic = await flat.module.heuristic(prompt, flatThink, { validation: 'low', scene: 'engineering' })

    const sharpTop = Math.max(...sharpHeuristic.routes.map((route) => route.probability))
    const flatTop = Math.max(...flatHeuristic.routes.map((route) => route.probability))
    assert.ok(sharpTop > flatTop, `a lower prior must sharpen the ranking (${sharpTop} vs ${flatTop})`)
    assert.ok(sharpHeuristic.entropy < flatHeuristic.entropy)
  } finally {
    sharp.close()
    flat.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Search port
 * ------------------------------------------------------------------------- */

test('a policy override that disables search issues no search call', async () => {
  let calls = 0
  const web: WebSearchPort = {
    search: async () => {
      calls += 1
      throw new Error('search should be disabled by the policy override')
    },
  }
  const fixture = createFixture({
    validation: 'low',
    content: '我最近很焦虑，不知道怎么办。',
    web,
    policies: { low: { search: false } },
  })
  try {
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    assert.equal(calls, 0)
    // Only evidence search is off; the four stages still run.
    assert.deepEqual(
      fixture.module.stages(comprehension.identity).map((stage) => stage.status),
      ['done', 'done', 'done', 'done'],
    )
  } finally {
    fixture.close()
  }
})

test('config.comprehension.searchEnabled false disables search for every level', async () => {
  let calls = 0
  const web: WebSearchPort = {
    search: async () => {
      calls += 1
      throw new Error('search must be disabled by config')
    },
  }
  const fixture = createFixture({
    validation: 'high',
    content: '请调研这次迁移的失败案例。',
    web,
    searchEnabled: false,
  })
  try {
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    assert.equal(calls, 0)
    assert.deepEqual(
      fixture.module.stages(comprehension.identity).map((stage) => stage.status),
      ['done', 'done', 'done', 'done'],
    )
  } finally {
    fixture.close()
  }
})

test('a failing search still commits every stage as done', async () => {
  const web: WebSearchPort = {
    search: async () => {
      throw new Error('network down')
    },
  }
  const fixture = createFixture({
    validation: 'medium',
    content: '请设计上线回滚方案，必须在发布前完成验证。',
    web,
  })
  try {
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    const stages = fixture.module.stages(comprehension.identity)
    assert.deepEqual(stages.map((stage) => stage.status), ['done', 'done', 'done', 'done'])
    const evidence = JSON.parse(comprehension.evidence ?? '[]') as string[]
    assert.ok(!evidence.some((entry) => entry.startsWith('http')))
    assert.ok(!evidence.some((entry) => entry.includes('network down')))
  } finally {
    fixture.close()
  }
})

test('unknown search result shapes are parsed defensively into evidence strings', async () => {
  const web: WebSearchPort = {
    search: async () => ({
      results: [
        { title: 'Checklist for safe deploys', url: 'https://example.test/deploy' },
        { name: 'Rollback strategy', link: 'https://example.test/rollback' },
      ],
      meta: { language: 'en' },
    }),
  }
  const fixture = createFixture({ web })
  try {
    const prompt = '请设计部署回滚方案。'
    const emotion = await fixture.module.emotion(prompt)
    const think = await fixture.module.think(prompt, emotion)
    const heuristic = await fixture.module.heuristic(prompt, think, { validation: 'medium', scene: 'engineering' })
    assert.ok(heuristic.evidence.some((entry) => entry.includes('https://example.test/deploy')))
    assert.ok(heuristic.evidence.some((entry) => entry.includes('Rollback strategy')))
    assert.ok(heuristic.evidence.some((entry) => entry.includes('https://example.test/rollback')))
    // Metadata keys are never promoted to evidence titles.
    assert.ok(!heuristic.evidence.includes('en'))
  } finally {
    fixture.close()
  }
})

test('a hanging search times out and the stage still completes', async () => {
  const web: WebSearchPort = { search: () => new Promise<never>(() => undefined) }
  const fixture = createFixture({
    validation: 'medium',
    content: '请评估这次迁移的风险。',
    stageTimeout: 100,
    web,
  })
  try {
    const started = Date.now()
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5000, `comprehension must not wait for a hanging search, took ${elapsed}ms`)
    assert.deepEqual(
      fixture.module.stages(comprehension.identity).map((stage) => stage.status),
      ['done', 'done', 'done', 'done'],
    )
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Persistence
 * ------------------------------------------------------------------------- */

test('stage rows are persisted with ordinals, handles and links', async () => {
  const fixture = createFixture({
    validation: 'medium',
    content: '请调研三个竞品并对比它们的定价，最后给出建议。',
  })
  try {
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    const rows = stageRows(fixture, comprehension.identity)

    assert.equal(rows.length, 4)
    assert.deepEqual(rows.map((row) => row.ordinal), [1, 2, 3, 4])
    assert.deepEqual(rows.map((row) => row.stage), ['emotion', 'think', 'heuristic', 'converge'])
    assert.equal(new Set(rows.map((row) => row.handle)).size, 4)
    for (const row of rows) assert.equal(row.comprehension, comprehension.identity)
    for (const row of rows) assert.match(row.handle, /^coordination-stage-/)

    // The comprehension row links back to the turn and prompt it was built for.
    const linked = fixture.db.require<{ comprehension: number | null }>('turn', fixture.turn)
    assert.equal(linked.comprehension, comprehension.identity)
    const record = fixture.module.get(comprehension.identity)
    assert.equal(record.turn, fixture.turn)
    assert.equal(record.prompt, fixture.promptIdentity)
  } finally {
    fixture.close()
  }
})

test('re-running a stage inserts a row with the same ordinal and keeps the old one', async () => {
  const fixture = createFixture({
    validation: 'medium',
    content: '请检查这个改动的风险点，并给出必须修改的清单。',
  })
  try {
    const comprehension = await fixture.module.comprehend(inputFor(fixture))
    const before = stageRows(fixture, comprehension.identity)
    const previous = before.find((row) => row.ordinal === 3)
    assert.ok(previous !== undefined)

    const rerun: ComprehensionStageRecord = await fixture.module.runStage(comprehension.identity, 'heuristic')
    assert.equal(rerun.stage, 'heuristic')
    assert.equal(rerun.ordinal, 3)
    assert.notEqual(rerun.identity, previous.identity)
    assert.equal(rerun.status, 'done')

    const after = stageRows(fixture, comprehension.identity)
    assert.equal(after.length, before.length + 1)
    const heuristicRows = after.filter((row) => row.stage === 'heuristic')
    assert.deepEqual(heuristicRows.map((row) => row.ordinal), [3, 3])
    assert.deepEqual(heuristicRows.map((row) => row.identity), [previous.identity, rerun.identity])

    // Append-only: the previous row is still byte-for-byte the row it was.
    const original = fixture.db.require<StageRow>('comprehension_stage', previous.identity)
    assert.equal(original.handle, previous.handle)
    assert.equal(original.status, 'done')
    assert.equal(original.output, previous.output)

    // The four-stage reader takes the latest row per ordinal.
    const latest = fixture.module.stages(comprehension.identity)
    assert.equal(latest.length, 4)
    assert.deepEqual(latest.map((stage) => stage.ordinal), [1, 2, 3, 4])
    assert.equal(latest[2].identity, rerun.identity)
    assert.equal(latest[1].identity, before[1].identity)

    // Re-running a bayesian stage keeps the comprehension aggregate coherent.
    const record = fixture.module.get(comprehension.identity)
    assert.ok((record.route ?? '').startsWith('['))
    assert.ok((record.confidence ?? 0) > 0)
  } finally {
    fixture.close()
  }
})

test('an unknown comprehension identity raises NotFoundError', () => {
  const fixture = createFixture()
  try {
    assert.throws(() => fixture.module.get(9999), NotFoundError)
    assert.throws(() => fixture.module.stages(9999), NotFoundError)
  } finally {
    fixture.close()
  }
})
