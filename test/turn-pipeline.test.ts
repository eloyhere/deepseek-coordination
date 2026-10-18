/**
 * Composed turn pipeline (v24 §19).
 *
 * The pipeline is the missing link between the library modules and the composed
 * turn lifecycle: comprehension -> organization -> plan/score, then the scene
 * policy. These tests drive `TurnPipeline` directly over the shared in-memory
 * fixture (no Cordis, no HTTP) and then one `CoordinationService` integration
 * path that proves `beginTurn` schedules the same pipeline without blocking the
 * `agent/pre-step` hook.
 *
 * Covered contract:
 *  - the validation level selects the comprehension search budget;
 *  - the turn row's interaction/scene/validation reach comprehension verbatim;
 *  - comprehension, organization, plan and eight score rows are persisted;
 *  - the scene policy is applied where a port/module exists (effort, allowWeb,
 *    requirePlan/Score/Outline/Revision, predict, citation, sandboxOnly);
 *  - an unsupported knob or a missing port degrades with a diagnostic, never a
 *    fabricated result;
 *  - a throwing stage reaches neither `next()` nor an unhandled rejection;
 *  - the DSH hook passes the payload prompt through to the turn row.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createTestHost, testConfig } from './helpers.js'
import type { TestHost } from './helpers.js'
import { ComprehensionModule } from '../src/host/comprehension.js'
import type { ComprehendInput, ComprehensionPolicyPatch } from '../src/host/comprehension.js'
import { OrganizationModule } from '../src/host/organization.js'
import { PlanModule } from '../src/host/plan.js'
import { PredictModule } from '../src/host/predict.js'
import { TurnModule } from '../src/host/turn.js'
import type { TurnRequest } from '../src/host/turn.js'
import { CoordinationService, TurnPipeline, resolveSceneProfile } from '../src/host/coordination.js'
import { installTurnLifecycle, promptTextOfMessages } from '../src/host/dsh.js'
import type { DshRuntime } from '../src/host/dsh.js'
import type { ModuleHost, SandboxPolicyPort, WebSearchPort } from '../src/host/module.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { SceneProfiles } from '../src/shared/enum.js'
import type { Validation } from '../src/shared/enum.js'
import type { Turn } from '../src/shared/entity.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

interface SearchCall {
  query: string
  maxResults?: number
}

interface SearchRecorder extends WebSearchPort {
  calls: SearchCall[]
}

/** A web port that records the budget the comprehension actually spent. */
function searchRecorder(): SearchRecorder {
  const calls: SearchCall[] = []
  return {
    calls,
    async search(request: { query: string; maxResults?: number }) {
      calls.push({ query: request.query, ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }) })
      const count = request.maxResults ?? 1
      return {
        results: Array.from({ length: count }, (_, index) => ({
          title: `result ${index + 1} for ${request.query}`,
          url: `https://example.test/${index + 1}`,
          snippet: `deterministic snippet ${index + 1}`,
        })),
      }
    },
  }
}

const NoSearchPolicy: Partial<Record<Validation, ComprehensionPolicyPatch>> = {
  low: { search: false },
  medium: { search: false },
  high: { search: false },
}

interface PipelineFixtureOptions {
  config?: Partial<CoordinationConfig>
  web?: WebSearchPort
  sandboxPolicy?: SandboxPolicyPort
  /** Observe or wrap the comprehension instance before the pipeline uses it. */
  onComprehension?(module: ComprehensionModule): void
}

interface PipelineFixture {
  host: ModuleHost
  db: TestHost['db']
  turn: TurnModule
  plan: PlanModule
  predict: PredictModule
  pipeline: TurnPipeline
  close(): void
}

function buildPipelineFixture(options: PipelineFixtureOptions = {}): PipelineFixture {
  const base = createTestHost({
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.web === undefined ? {} : { web: options.web }),
  })
  const host: ModuleHost = {
    ...base.host,
    ...(options.sandboxPolicy === undefined ? {} : { sandboxPolicy: options.sandboxPolicy }),
  }
  const comprehension = new ComprehensionModule(host)
  options.onComprehension?.(comprehension)
  const plan = new PlanModule(host)
  const predict = new PredictModule(host)
  const pipeline = new TurnPipeline({
    host,
    comprehension,
    offlineComprehension: new ComprehensionModule(host, NoSearchPolicy),
    organization: new OrganizationModule(host),
    plan,
    predict,
    rawSession: () => undefined,
  })
  return {
    host,
    db: base.db,
    turn: new TurnModule(host),
    plan,
    predict,
    pipeline,
    close: base.close,
  }
}

let sessionSerial = 0

/** One open turn recording the neutral effort, as the service now creates it. */
function createPipelineTurn(fixture: PipelineFixture, overrides: Partial<TurnRequest> = {}): Turn {
  sessionSerial += 1
  const session = fixture.turn.ensureSession(`dsh-pipeline-${sessionSerial}`)
  const scene = overrides.scene ?? 'dialogue'
  const request: TurnRequest = {
    content: 'write a short release note about the coordination pipeline',
    profession: 'execution',
    interaction: 'think',
    scene,
    validation: 'medium',
    // DSH owns reasoning effort; with no committed session route the row keeps
    // the neutral default instead of a scene literal.
    effort: 'medium',
    ...overrides,
  }
  return fixture.turn.create(session.identity, request)
}

const TestPrompt = 'write a short release note about the coordination pipeline'

function row<T extends Record<string, unknown>>(
  db: TestHost['db'],
  sql: string,
  ...params: unknown[]
): T {
  const value = db.get<T>(sql, ...params)
  assert.ok(value, `expected a row for: ${sql}`)
  return value
}

/* ------------------------------------------------------------------------- *
 * Comprehension input
 * ------------------------------------------------------------------------- */

test('validation level selects the comprehension search budget', async () => {
  const budgets: ReadonlyArray<readonly [Validation, number, number]> = [
    ['low', 1, 3],
    ['medium', 2, 5],
    ['high', 4, 8],
  ]
  for (const [validation, calls, results] of budgets) {
    const web = searchRecorder()
    const fixture = buildPipelineFixture({ web })
    try {
      const turn = createPipelineTurn(fixture, { validation, scene: 'dialogue' })
      const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')
      assert.equal(report.status, 'completed', `${validation} pipeline completed`)
      assert.ok(report.comprehension !== undefined, `${validation} comprehension persisted`)
      assert.equal(web.calls.length, calls, `${validation} issues ${calls} searches`)
      assert.ok(
        web.calls.every((call) => call.maxResults === results),
        `${validation} caps every query at ${results} results`,
      )
    } finally {
      fixture.close()
    }
  }
})

test('the turn row interaction, scene and validation reach comprehension verbatim', async () => {
  let captured: ComprehendInput | undefined
  const fixture = buildPipelineFixture({
    web: searchRecorder(),
    onComprehension(module) {
      const original = module.comprehend.bind(module)
      module.comprehend = async (input: ComprehendInput) => {
        captured = input
        return await original(input)
      }
    },
  })
  try {
    const turn = createPipelineTurn(fixture, {
      scene: 'writing',
      interaction: 'orchestrate',
      validation: 'low',
    })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')
    assert.equal(report.status, 'completed')
    assert.ok(captured !== undefined)
    assert.equal(captured.turn, turn.identity)
    assert.equal(captured.prompt, TestPrompt)
    assert.equal(captured.interaction, 'orchestrate')
    assert.equal(captured.scene, 'writing')
    assert.equal(captured.validation, 'low')
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Persistence
 * ------------------------------------------------------------------------- */

test('a command-face turn skips the deterministic pipeline', async () => {
  const fixture = buildPipelineFixture({ web: searchRecorder() })
  try {
    const turn = createPipelineTurn(fixture, { command: 'goal' })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')
    assert.equal(report.status, 'skipped')
    assert.equal(report.comprehension, undefined)
    assert.equal(report.plan, undefined)
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'command-face'))
    assert.equal(
      fixture.db.count('comprehension', 'turn = ?', turn.identity),
      0,
    )
  } finally {
    fixture.close()
  }
})

test('an empty prompt is skipped with a diagnostic, not an empty comprehension', async () => {
  const fixture = buildPipelineFixture({ web: searchRecorder() })
  try {
    const turn = createPipelineTurn(fixture, { content: '' })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), '', 'dsh-pipeline')
    assert.equal(report.status, 'skipped')
    assert.equal(report.comprehension, undefined)
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'prompt-empty'))
    assert.equal(fixture.db.count('comprehension', 'turn = ?', turn.identity), 0)
  } finally {
    fixture.close()
  }
})

test('comprehension, organization, plan and the eight score rows are persisted', async () => {
  const fixture = buildPipelineFixture({ web: searchRecorder() })
  try {
    const turn = createPipelineTurn(fixture, { scene: 'writing' })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')

    assert.equal(report.status, 'completed')
    assert.ok(report.comprehension !== undefined)
    assert.ok(report.organization !== undefined)
    assert.ok(report.plan !== undefined)

    const turnRow = row<Record<string, unknown>>(
      fixture.db,
      'SELECT * FROM turn WHERE identity = ?',
      turn.identity,
    )
    assert.equal(Number(turnRow.comprehension), report.comprehension)
    assert.equal(Number(turnRow.organization), report.organization)
    assert.equal(Number(turnRow.plan), report.plan)

    const planRow = row<Record<string, unknown>>(fixture.db, 'SELECT * FROM plan WHERE identity = ?', report.plan)
    assert.equal(planRow.status, 'scored')
    assert.equal(Number(planRow.turn), turn.identity)

    const organization = row<Record<string, unknown>>(
      fixture.db,
      'SELECT * FROM organization WHERE identity = ?',
      report.organization,
    )
    assert.equal(Number(organization.comprehension), report.comprehension)
    assert.equal(Number(organization.plan), report.plan)

    const scores = fixture.db.all<Record<string, unknown>>(
      'SELECT * FROM score WHERE category = ? AND target = ?',
      'plan',
      report.plan,
    )
    assert.equal(scores.length, 8)
    assert.equal(report.score?.threshold, 0.6)
    assert.equal(report.score?.pass, report.score?.failing.length === 0)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Scene policy
 * ------------------------------------------------------------------------- */

test('writing scene policy applies plan, score, outline, revision and web', async () => {
  const fixture = buildPipelineFixture({ web: searchRecorder() })
  try {
    const turn = createPipelineTurn(fixture, { scene: 'writing' })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')

    // Reasoning is DSH-owned now: the turn keeps the neutral observed default
    // and the pipeline neither claims nor defers an effort/thinking gap.
    assert.equal(turn.effort, 'medium')
    for (const field of [
      'allowWeb',
      'requirePlan',
      'requireScore',
      'requireOutline',
      'requireRevision',
      'scoreThreshold',
    ]) {
      assert.ok(report.policy.applied.includes(field), `writing scene applies ${field}`)
    }
    assert.equal(report.policy.applied.includes('effort'), false)
    assert.equal(report.policy.deferred.some((gap) => gap.field === 'thinking'), false)
    assert.equal(report.policy.deferred.some((gap) => gap.field === 'reasoningEffort'), false)
    assert.ok(report.policy.deferred.some((gap) => gap.field === 'allowBash'))
  } finally {
    fixture.close()
  }
})

test('allowWeb=false disables comprehension search without disabling the stages', async () => {
  const web = searchRecorder()
  const config = {
    scenes: { dialogue: { ...SceneProfiles.dialogue, allowWeb: false } },
  } as unknown as Partial<CoordinationConfig>
  const fixture = buildPipelineFixture({ web, config })
  try {
    const turn = createPipelineTurn(fixture, { scene: 'dialogue' })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')
    assert.equal(report.status, 'completed')
    assert.equal(web.calls.length, 0)
    assert.ok(report.policy.applied.includes('allowWeb'))
    const comprehension = row<Record<string, unknown>>(
      fixture.db,
      'SELECT * FROM comprehension WHERE identity = ?',
      report.comprehension,
    )
    // Both Bayesian stages still run; only their search is switched off.
    assert.ok(Number(comprehension.stageCount) >= 2)
  } finally {
    fixture.close()
  }
})

test('research scene persists a prediction and accepts comprehension evidence as citation', async () => {
  const fixture = buildPipelineFixture({ web: searchRecorder() })
  try {
    const turn = createPipelineTurn(fixture, { scene: 'research', interaction: 'heuristic' })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')

    assert.ok(report.policy.applied.includes('requirePredict'))
    assert.ok(report.policy.applied.includes('requireCitation'))
    assert.ok(report.predict !== undefined)
    const prediction = row<Record<string, unknown>>(
      fixture.db,
      'SELECT * FROM predict WHERE identity = ?',
      report.predict,
    )
    assert.equal(Number(prediction.plan), report.plan)
    assert.equal(Number(prediction.turn), turn.identity)
  } finally {
    fixture.close()
  }
})

test('sandboxOnly is verified through the sandbox port when one is present', async () => {
  const sandboxPolicy: SandboxPolicyPort = {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'R:\\workspace' }),
    overrideOf: () => undefined,
  }
  const fixture = buildPipelineFixture({ web: searchRecorder(), sandboxPolicy })
  try {
    const turn = createPipelineTurn(fixture, { scene: 'engineering' })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')
    assert.ok(report.policy.applied.includes('sandboxOnly'))
    assert.ok(report.policy.deferred.some((gap) => gap.field === 'allowBash'))
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Missing ports and failures
 * ------------------------------------------------------------------------- */

test('a missing web port degrades with a diagnostic and still produces a plan', async () => {
  const fixture = buildPipelineFixture() // no web port, no sandbox port
  try {
    const turn = createPipelineTurn(fixture, { scene: 'research', validation: 'high' })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')

    assert.equal(report.status, 'completed')
    assert.ok(report.plan !== undefined)
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'web-port-missing'))
    assert.ok(report.policy.deferred.some((gap) => gap.field === 'requireCitation'))
  } finally {
    fixture.close()
  }
})

test('a missing sandbox port records sandboxOnly as deferred, not satisfied', async () => {
  const fixture = buildPipelineFixture() // no sandboxPolicy
  try {
    const turn = createPipelineTurn(fixture, { scene: 'engineering' })
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')
    assert.equal(report.status, 'completed')
    assert.ok(!report.policy.applied.includes('sandboxOnly'))
    assert.ok(report.policy.deferred.some((gap) => gap.field === 'sandboxOnly'))
  } finally {
    fixture.close()
  }
})

test('a thrown module failure becomes a failed report instead of rejecting', async () => {
  const fixture = buildPipelineFixture({ web: searchRecorder() })
  try {
    const turn = createPipelineTurn(fixture)
    fixture.plan.score = () => {
      throw new Error('score exploded')
    }
    const report = await fixture.pipeline.run(fixture.turn.get(turn.identity), TestPrompt, 'dsh-pipeline')
    assert.equal(report.status, 'failed')
    assert.ok(report.plan !== undefined)
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'plan-score-failed'))
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * DSH hook and service integration
 * ------------------------------------------------------------------------- */

interface HookHarness {
  context: unknown
  emit(name: string, payload: unknown, next: () => Promise<unknown>): Promise<unknown>
}

function hookHarness(): HookHarness {
  const listeners = new Map<string, (payload: unknown, next: () => Promise<unknown>) => unknown>()
  const context = {
    on(name: string, listener: (payload: unknown, next: () => Promise<unknown>) => unknown) {
      listeners.set(name, listener)
      return (): void => {
        listeners.delete(name)
      }
    },
    logger: { warn: (): void => {} },
  }
  return {
    context,
    async emit(name, payload, next) {
      const listener = listeners.get(name)
      assert.ok(listener, `listener ${name} is registered`)
      return await listener(payload, next)
    },
  }
}

test('promptTextOfMessages reads the last user message text blocks', () => {
  assert.equal(promptTextOfMessages(undefined), undefined)
  assert.equal(promptTextOfMessages([]), undefined)
  assert.equal(
    promptTextOfMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'text', text: 'prompt' }] },
    ]),
    'second\nprompt',
  )
})

test('a throwing begin hook still calls next()', async () => {
  const harness = hookHarness()
  installTurnLifecycle(harness.context, {
    begin: async () => {
      throw new Error('begin exploded')
    },
    end: async () => {},
  })
  let nextCalled = false
  await harness.emit(
    'agent/pre-step',
    { agent: { id: 'dsh-hook' }, turn: 1, messages: [{ role: 'user', content: 'hello' }] },
    async () => {
      nextCalled = true
    },
  )
  assert.equal(nextCalled, true)
})

interface ServiceFixture {
  service: CoordinationService
  close(): void
}

function createServiceFixture(options: { web?: WebSearchPort } = {}): ServiceFixture {
  const directory = mkdtempSync(join(tmpdir(), 'coordination-pipeline-'))
  const config = testConfig({ databasePath: join(directory, 'coordination.db') })
  const runtime: DshRuntime = {
    rawSession: () => undefined,
    rawAgent: () => undefined,
    ...(options.web === undefined ? {} : { web: options.web }),
  }
  const context = { reflect: { provide: (): void => {} } } as unknown as Context
  const service = new CoordinationService(context, config, runtime)
  return {
    service,
    close(): void {
      try {
        service.dispose()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}

test('beginTurn carries the composer selection into the pipeline and endTurn closes the turn', async () => {
  const web = searchRecorder()
  const fixture = createServiceFixture({ web })
  try {
    // The composer persists its choice before the turn starts; the service must
    // copy it onto the turn row and the pipeline must read it from there.
    fixture.service.setSelection('dsh-service-ok', {
      scene: 'writing',
      interaction: 'orchestrate',
      validation: 'low',
    })
    const turn = await fixture.service.beginTurn('dsh-service-ok', 1, TestPrompt)
    assert.equal(turn.scene, 'writing')
    assert.equal(turn.interaction, 'orchestrate')
    assert.equal(turn.validation, 'low')
    // DSH owns the effort: with no committed session route the row records the
    // neutral default instead of the scene's configured level.
    assert.equal(turn.effort, 'medium')

    const report = await fixture.service.awaitPipeline('dsh-service-ok')
    assert.equal(report?.status, 'completed')
    assert.ok(report?.comprehension !== undefined)
    assert.ok(report?.plan !== undefined)
    assert.ok(report?.policy.applied.includes('requireOutline'))
    assert.ok(report?.policy.applied.includes('requireRevision'))
    // low = 1 query x 3 results, and the writing scene allows web.
    assert.equal(web.calls.length, 1)
    assert.equal(web.calls[0]?.maxResults, 3)

    fixture.service.endTurn('dsh-service-ok', 'done')
    assert.equal(fixture.service.turn.get(turn.identity).status, 'done')
  } finally {
    fixture.close()
  }
})

test('a failing pipeline does not block the pre-step hook and is recorded', async () => {
  const fixture = createServiceFixture({ web: searchRecorder() })
  try {
    // Force the first stage to throw; the service must still return the hook.
    fixture.service.comprehension.comprehend = async () => {
      throw new Error('comprehension exploded')
    }
    const harness = hookHarness()
    const dispose = installTurnLifecycle(harness.context, {
      begin: async (observation) => {
        await fixture.service.beginTurn(observation.session, observation.turn, observation.prompt ?? '')
      },
      end: async (observation) => {
        fixture.service.endTurn(observation.session)
      },
    })

    let nextCalled = false
    await harness.emit(
      'agent/pre-step',
      { agent: { id: 'dsh-service-fail' }, turn: 1, messages: [{ role: 'user', content: TestPrompt }] },
      async () => {
        nextCalled = true
      },
    )
    assert.equal(nextCalled, true)

    const report = await fixture.service.awaitPipeline('dsh-service-fail')
    assert.equal(report?.status, 'failed')
    assert.ok(report?.diagnostics.some((diagnostic) => diagnostic.code === 'comprehension-failed'))

    // The prompt really came from the hook payload, not from a fabricated row.
    const session = row<Record<string, unknown>>(
      fixture.service.db,
      'SELECT * FROM session WHERE handle = ?',
      'dsh-service-fail',
    )
    const turnRow = row<Record<string, unknown>>(
      fixture.service.db,
      'SELECT * FROM turn WHERE session = ?',
      session.identity,
    )
    const prompt = row<Record<string, unknown>>(
      fixture.service.db,
      'SELECT * FROM prompt WHERE identity = ?',
      turnRow.prompt,
    )
    assert.equal(prompt.content, TestPrompt)

    dispose()
  } finally {
    fixture.close()
  }
})

test('resolveSceneProfile repairs configured bounds without inventing values', () => {
  const config = testConfig({
    scenes: {
      ...SceneProfiles,
      iterate: {
        ...SceneProfiles.iterate,
        maxIteration: 0,
        scoreThreshold: 4,
        reasoningEffort: '  ',
      },
    },
  })
  const profile = resolveSceneProfile(config, 'iterate')
  assert.equal(profile.maxIteration, 1)
  assert.equal(profile.scoreThreshold, 1)
  assert.equal(profile.reasoningEffort, SceneProfiles.iterate.reasoningEffort)
})
