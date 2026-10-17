/**
 * CognitionModule and PredictModule tests (v23 §10.1, §10.2, §9.7 ⑩, §11.17).
 *
 * The repository has no runtime TypeScript loader, so the tests run through the
 * shared harness: `npm run test:build` bundles every `test/*.test.ts` with
 * tsdown and `node --test .tmp/test-build` executes the bundles on plain Node
 * 24 (`node:sqlite` is built in).
 *
 * The kernel comes from `test/helpers.ts`, which keeps the runtime
 * `@deepseek-ai/schemastery` import out of the test process; session, turn and
 * plan rows are inserted directly because creating turns and plans belongs to
 * the Turn and Plan modules, and neither module under test may depend on them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Interaction, TurnStatus, Validation } from '../src/shared/enum.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError } from '../src/shared/error.js'
import { createTestHost, insertPlan, insertSession, insertTurn } from './helpers.js'
import type { TestHost } from './helpers.js'
import { CognitionModule, CognitiveStageValues } from '../src/host/cognition.js'
import type { CognitiveStage, CognitiveStrategy } from '../src/host/cognition.js'
import { PredictModule, compareAgreement } from '../src/host/predict.js'
import type { Row } from '../src/host/row.js'

/* ------------------------------------------------------------------------- *
 * Fixture
 * ------------------------------------------------------------------------- */

interface TurnOptions {
  validation?: Validation
  status?: TurnStatus
}

interface PlanOptions {
  goal?: string
  approach?: string
  step?: string
  constraint?: string
}

interface Fixture extends TestHost {
  cognition: CognitionModule
  predict: PredictModule
  session: number
  addTurn(interaction: Interaction, options?: TurnOptions): number
  addPlan(turn: number, options?: PlanOptions): number
}

function createFixture(): Fixture {
  const testHost = createTestHost()
  const session = insertSession(testHost.db, 'session-cognition')
  return {
    ...testHost,
    cognition: new CognitionModule(testHost.host),
    predict: new PredictModule(testHost.host),
    session,
    addTurn(interaction: Interaction, options: TurnOptions = {}): number {
      return insertTurn(testHost.db, session, {
        interaction,
        scene: 'engineering',
        validation: options.validation ?? 'medium',
        status: options.status ?? 'planning',
      })
    },
    addPlan(turn: number, options: PlanOptions = {}): number {
      return insertPlan(testHost.db, turn, {
        goal: options.goal ?? 'ship the feature',
        approach: options.approach ?? 'write the code',
        constraint: options.constraint ?? 'no destructive writes',
        status: 'active',
        ...(options.step === undefined ? {} : { step: options.step }),
      })
    },
  }
}

/** `both|think|heuristic|none order maxIteration`, the part tests compare. */
function strategyLabel(strategy: CognitiveStrategy): string {
  const flags =
    strategy.think && strategy.heuristic
      ? 'both'
      : strategy.think
        ? 'think'
        : strategy.heuristic
          ? 'heuristic'
          : 'none'
  return `${flags} ${strategy.order} ${strategy.maxIteration}`
}

function turnRow(fixture: Fixture, turn: number): Row | undefined {
  return fixture.db.get<Row>('SELECT * FROM turn WHERE identity = ?', turn)
}

/* ------------------------------------------------------------------------- *
 * The §10.2 matrix
 * ------------------------------------------------------------------------- */

test('the §10.2 matrix resolves every think-interaction stage', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('think')
    const expected: Record<CognitiveStage, string> = {
      comprehension: 'both think-first 1',
      organization: 'think think-first 1',
      plan: 'think think-first 1',
      planscore: 'think think-first 1',
      planrebuild: 'think think-first 1',
      constraint: 'think think-first 1',
      predict: 'none parallel 1',
      reality: 'none parallel 1',
      answer: 'think think-first 1',
      orchestrate: 'none parallel 1',
    }
    for (const stage of CognitiveStageValues) {
      const strategy = fixture.cognition.strategy(turn, stage)
      assert.equal(strategy.stage, stage)
      assert.equal(strategyLabel(strategy), expected[stage], `stage ${stage}`)
    }
    // strategy() is pure: no cognition row, no turn mirror.
    assert.equal(fixture.db.count('cognition'), 0)
    assert.equal(turnRow(fixture, turn)?.cognitive, null)
  } finally {
    fixture.close()
  }
})

test('the §10.2 matrix resolves every heuristic-interaction stage', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('heuristic')
    const expected: Record<CognitiveStage, string> = {
      comprehension: 'both interleave 1',
      organization: 'think think-first 1',
      plan: 'think think-first 1',
      planscore: 'think think-first 1',
      planrebuild: 'both heuristic-first 1',
      constraint: 'both heuristic-first 1',
      predict: 'none parallel 1',
      reality: 'none parallel 1',
      answer: 'heuristic heuristic-first 3',
      orchestrate: 'none parallel 1',
    }
    for (const stage of CognitiveStageValues) {
      assert.equal(strategyLabel(fixture.cognition.strategy(turn, stage)), expected[stage], `stage ${stage}`)
    }
    // The answer cell is the only stage allowed three iterations (§10.2 启发).
    assert.equal(fixture.cognition.strategy(turn, 'answer').maxIteration, 3)
  } finally {
    fixture.close()
  }
})

test('the §10.2 matrix resolves every orchestrate-interaction stage', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('orchestrate')
    const expected: Record<CognitiveStage, string> = {
      comprehension: 'both think-first 1',
      organization: 'think think-first 1',
      plan: 'think think-first 1',
      planscore: 'think think-first 1',
      planrebuild: 'think think-first 1',
      constraint: 'think think-first 1',
      predict: 'none parallel 1',
      reality: 'none parallel 1',
      answer: 'think think-first 1',
      orchestrate: 'both parallel 1',
    }
    for (const stage of CognitiveStageValues) {
      assert.equal(strategyLabel(fixture.cognition.strategy(turn, stage)), expected[stage], `stage ${stage}`)
    }
  } finally {
    fixture.close()
  }
})

test('the §10.2 matrix resolves the converge and emotion columns', () => {
  const fixture = createFixture()
  try {
    const converge = fixture.addTurn('converge')
    assert.equal(strategyLabel(fixture.cognition.strategy(converge, 'comprehension')), 'both interleave 1')
    assert.equal(strategyLabel(fixture.cognition.strategy(converge, 'planrebuild')), 'both interleave 1')
    assert.equal(strategyLabel(fixture.cognition.strategy(converge, 'answer')), 'both think-first 3')
    assert.equal(strategyLabel(fixture.cognition.strategy(converge, 'organization')), 'think think-first 1')

    const emotion = fixture.addTurn('emotion')
    assert.equal(strategyLabel(fixture.cognition.strategy(emotion, 'comprehension')), 'both think-first 1')
    assert.equal(strategyLabel(fixture.cognition.strategy(emotion, 'organization')), 'think think-first 1')
    // 感情 answers directly: §10.2 leaves the answer cell empty.
    assert.equal(strategyLabel(fixture.cognition.strategy(emotion, 'answer')), 'none parallel 1')
  } finally {
    fixture.close()
  }
})

test('convergence follows the validation level', () => {
  const fixture = createFixture()
  try {
    const low = fixture.cognition.strategy(fixture.addTurn('think', { validation: 'low' }), 'answer')
    assert.equal(low.convergence, 'score')
    assert.equal(Object.hasOwn(low, 'entropyThreshold'), false)

    const medium = fixture.cognition.strategy(fixture.addTurn('think', { validation: 'medium' }), 'comprehension')
    assert.equal(medium.convergence, 'entropy')
    assert.equal(medium.entropyThreshold, 0.05)

    const high = fixture.cognition.strategy(fixture.addTurn('think', { validation: 'high' }), 'comprehension')
    assert.equal(high.convergence, 'evidence')
    assert.equal(Object.hasOwn(high, 'entropyThreshold'), false)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Cognition rows
 * ------------------------------------------------------------------------- */

test('stage persists the strategy JSON, the summary line and the turn mirror', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('think')
    const record = fixture.cognition.stage(turn, 'answer')

    assert.equal(record.turn, turn)
    assert.equal(record.stage, 'answer')
    assert.ok(record.handle.startsWith('test-cognition-'))
    assert.deepEqual(JSON.parse(record.strategy) as CognitiveStrategy, fixture.cognition.strategy(turn, 'answer'))
    assert.match(record.content, /^stage=answer interaction=think validation=medium /)
    assert.match(record.content, /think=true/)
    assert.match(record.content, /heuristic=false/)
    assert.match(record.content, /order=think-first/)
    assert.match(record.content, /maxIteration=1/)
    assert.match(record.content, /convergence=entropy/)
    assert.match(record.content, /entropyThreshold=0\.05$/)

    assert.equal(fixture.db.count('cognition'), 1)
    const mirrored = turnRow(fixture, turn)
    assert.equal(mirrored?.cognitive, record.strategy)
    // stage() must not move the turn lifecycle and must not write a trace event.
    assert.equal(mirrored?.status, 'planning')
    assert.equal(mirrored?.finished, null)
    assert.deepEqual(fixture.host.trace.list(turn), [])

    // Append-only: resolving again writes a new row with a new handle.
    const again = fixture.cognition.stage(turn, 'answer')
    assert.notEqual(again.identity, record.identity)
    assert.notEqual(again.handle, record.handle)
    assert.equal(fixture.db.count('cognition'), 2)
  } finally {
    fixture.close()
  }
})

test('stage overrides are validated and audited in the strategy', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('think')

    const heuristicOnly = fixture.cognition.stage({ turn, stage: 'comprehension', think: false })
    const strategy = JSON.parse(heuristicOnly.strategy) as CognitiveStrategy
    assert.equal(strategy.think, false)
    assert.equal(strategy.heuristic, true)
    assert.equal(strategy.order, 'heuristic-first')
    assert.equal(strategy.maxIteration, 1)

    const skipped = fixture.cognition.stage({ turn, stage: 'answer', think: false, heuristic: false })
    const skippedStrategy = JSON.parse(skipped.strategy) as CognitiveStrategy
    assert.equal(skippedStrategy.think, false)
    assert.equal(skippedStrategy.heuristic, false)
    assert.equal(skippedStrategy.order, 'parallel')
    assert.equal(skippedStrategy.maxIteration, 1)

    assert.throws(
      () => fixture.cognition.stage({ turn, stage: 'plan', think: 'yes' as unknown as boolean }),
      InvalidArgumentError,
    )
    assert.throws(
      () => fixture.cognition.stage({ turn, stage: 'plan', heuristic: 1 as unknown as boolean }),
      InvalidArgumentError,
    )
    assert.throws(() => fixture.cognition.stage(turn, 'nonsense' as CognitiveStage), InvalidArgumentError)
    assert.throws(() => fixture.cognition.strategy(turn, undefined as unknown as CognitiveStage), InvalidArgumentError)
    assert.throws(() => fixture.cognition.strategy(999, 'plan'), NotFoundError)
    assert.throws(() => fixture.cognition.stage(undefined as unknown as number, 'plan'), InvalidArgumentError)
  } finally {
    fixture.close()
  }
})

test('probe persists the normalised entropy and its deterministic question', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('think')
    const above = fixture.cognition.probe(turn, 0.42)
    assert.equal(above.turn, turn)
    assert.equal(above.entropy, 0.42)
    assert.ok(above.handle.startsWith('test-probe-'))
    assert.match(above.question, /entropy 0\.42 is above the stop threshold 0\.05/)
    assert.match(above.question, /name the single fact/)

    const below = fixture.cognition.probe(turn, 0.01)
    assert.equal(below.entropy, 0.01)
    assert.match(below.question, /no further probe is required/)

    assert.equal(fixture.cognition.probe(turn, 1.5).entropy, 1)
    assert.equal(fixture.cognition.probe(turn, -0.2).entropy, 0)
    assert.equal(fixture.db.count('probe'), 4)

    assert.throws(() => fixture.cognition.probe(turn, Number.NaN), InvalidArgumentError)
    assert.throws(() => fixture.cognition.probe(turn, 'high' as unknown as number), InvalidArgumentError)
    assert.throws(() => fixture.cognition.probe(999, 0.1), NotFoundError)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Predict → Action → Reality → Answer
 * ------------------------------------------------------------------------- */

test('predict persists against the plan turn and compare scores agreement', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('think')
    const plan = fixture.addPlan(turn)

    const prediction = fixture.predict.predict(plan, 'write the regression test')
    assert.equal(prediction.plan, plan)
    assert.equal(prediction.turn, turn)
    assert.equal(prediction.step, 'write the regression test')
    assert.ok(prediction.content.includes('write the regression test'))
    assert.equal(fixture.db.count('predict'), 1)

    // Identical forecast and observation: exactly 1.
    const identical = fixture.predict.reality(turn, prediction.content, prediction.content)
    assert.equal(identical.predict, prediction.identity)
    assert.equal(fixture.predict.compare(prediction.identity, identical.identity), 1)

    // No shared token: exactly 0.
    const disjoint = fixture.predict.reality(turn, 'zzz', 'qqq')
    assert.equal(fixture.predict.compare(prediction.identity, disjoint.identity), 0)

    // The observation matches, the restated expectation does not: 0.5.
    const mixed = fixture.predict.reality(turn, 'zzz', prediction.content)
    assert.equal(fixture.predict.compare(prediction.identity, mixed.identity), 0.5)

    // compare() is a pure read: no rows, no score rows.
    assert.equal(fixture.db.count('predict'), 1)
    assert.equal(fixture.db.count('reality'), 3)
    assert.equal(fixture.db.count('score'), 0)

    // A hand-written text-only reality row is compared as one observation.
    const textOnly = fixture.db.insert('reality', {
      handle: 'reality-text-only',
      turn,
      predict: prediction.identity,
      content: 'zzz',
      created: Date.now(),
    })
    assert.equal(fixture.predict.compare(prediction.identity, textOnly), 0)

    // A reality that observes another prediction is an argument error.
    const other = fixture.predict.predict(plan, 'delete the fixture')
    assert.throws(() => fixture.predict.compare(other.identity, mixed.identity), InvalidArgumentError)

    assert.throws(() => fixture.predict.predict(plan, '   '), InvalidArgumentError)
    assert.throws(() => fixture.predict.predict(999, 'step'), NotFoundError)
    assert.throws(() => fixture.predict.compare(999, mixed.identity), NotFoundError)
    assert.throws(() => fixture.predict.compare(prediction.identity, 999), NotFoundError)
  } finally {
    fixture.close()
  }
})

test('compareAgreement mixes text overlap with the numeric delta', () => {
  assert.equal(compareAgreement('apple banana', 'apple banana'), 1)
  assert.equal(compareAgreement('zzz', 'qqq'), 0)
  assert.equal(compareAgreement('latency 200 ms', 'latency 200 ms'), 1)
  // {latency, ms} of four tokens = 0.5 overlap, then the numeric delta
  // 1 - 700/900 = 0.2222 scales it to 0.1111.
  assert.equal(compareAgreement('latency 200 ms', 'latency 900 ms'), 0.1111)
  // CJK text is compared as bigrams, so identical Chinese still scores 1.
  assert.equal(compareAgreement('部署完成', '部署完成'), 1)
  assert.equal(compareAgreement('部署完成', '测试通过'), 0)
})

test('reality requires a prediction and non-empty expectations', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('think')
    assert.throws(() => fixture.predict.reality(turn, 'a thing', 'another thing'), InvalidStateError)

    const plan = fixture.addPlan(turn)
    fixture.predict.predict(plan, 'run the suite')
    assert.throws(() => fixture.predict.reality(turn, '   ', 'observed'), InvalidArgumentError)
    assert.throws(() => fixture.predict.reality(turn, 'expected', '   '), InvalidArgumentError)
    assert.equal(fixture.predict.reality(turn, 'expected', 'observed').turn, turn)
  } finally {
    fixture.close()
  }
})

test('action records the plan, the kind and the JSON input/output pair', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('think')
    // action.plan is NOT NULL, so a turn without a plan cannot act.
    assert.throws(() => fixture.predict.action(turn, 'run tests', 'pnpm test', 'exit 0'), InvalidStateError)

    const plan = fixture.addPlan(turn)
    const action = fixture.predict.action(turn, 'run tests', 'pnpm test', 'exit 0')
    assert.equal(action.turn, turn)
    assert.equal(action.plan, plan)
    assert.equal(action.kind, 'run tests')
    assert.equal(action.status, 'done')
    assert.equal(typeof action.finished, 'number')
    assert.ok(action.handle.startsWith('test-action-'))
    assert.deepEqual(JSON.parse(action.content), { input: 'pnpm test', output: 'exit 0' })

    // The latest plan is used until the turn pins one; then turn.plan wins.
    const latest = fixture.addPlan(turn, { goal: 'a second plan' })
    assert.equal(fixture.predict.action(turn, 'latest', '', 'ok').plan, latest)
    fixture.db.update('turn', { plan }, 'identity = ?', turn)
    assert.equal(fixture.predict.action(turn, 'pinned', '', 'ok').plan, plan)

    assert.deepEqual(
      fixture.predict.listAction(turn).map((item) => item.kind),
      ['run tests', 'latest', 'pinned'],
    )
    assert.equal(turnRow(fixture, turn)?.status, 'planning')
    assert.throws(() => fixture.predict.action(turn, '   ', 'in', 'out'), InvalidArgumentError)
    assert.throws(() => fixture.predict.action(turn, 'name', 1 as unknown as string, 'out'), InvalidArgumentError)
    assert.throws(() => fixture.predict.action(turn, 'name', 'in', 2 as unknown as string), InvalidArgumentError)
    assert.throws(() => fixture.predict.listAction(999), NotFoundError)
  } finally {
    fixture.close()
  }
})

test('answer persists content, validation and evidence without finishing the turn', () => {
  const fixture = createFixture()
  try {
    const acting = fixture.addTurn('think', { status: 'acting', validation: 'high' })
    const answer = fixture.predict.answer(acting, 'the feature is complete', 'pnpm test passed')
    assert.equal(answer.turn, acting)
    assert.equal(answer.content, 'the feature is complete')
    assert.equal(answer.validation, 'high')
    assert.ok(answer.handle.startsWith('test-answer-'))

    const advanced = turnRow(fixture, acting)
    assert.equal(advanced?.status, 'answering')
    // The bridge finishes the turn; answer never touches `finished`.
    assert.equal(advanced?.finished, null)

    const evidence = fixture.db.get<Row>('SELECT * FROM evidence WHERE turn = ?', acting)
    assert.equal(evidence?.source, 'answer')
    assert.equal(evidence?.content, 'pnpm test passed')
    assert.equal(evidence?.weight, 1)

    // A turn that is not acting keeps its status untouched.
    const planning = fixture.addTurn('think', { status: 'planning' })
    fixture.predict.answer(planning, 'draft answer')
    assert.equal(turnRow(fixture, planning)?.status, 'planning')

    // Answering again neither rewrites a status nor duplicates evidence.
    fixture.predict.answer(acting, 'second answer')
    assert.equal(turnRow(fixture, acting)?.status, 'answering')
    assert.equal(fixture.db.count('evidence', 'turn = ?', acting), 1)
    assert.deepEqual(
      fixture.predict.listAnswer(acting).map((item) => item.content),
      ['the feature is complete', 'second answer'],
    )

    assert.throws(() => fixture.predict.answer(acting, '   '), InvalidArgumentError)
    assert.throws(() => fixture.predict.answer(acting, 'ok', '   '), InvalidArgumentError)
    assert.throws(() => fixture.predict.listAnswer(999), NotFoundError)
  } finally {
    fixture.close()
  }
})

test('question and choice persist a ballot and the first selected option answers', () => {
  const fixture = createFixture()
  try {
    const turn = fixture.addTurn('think')
    const question = fixture.predict.question(turn, 'which database should the plugin use?')
    assert.equal(question.turn, turn)
    assert.equal(question.content, 'which database should the plugin use?')
    assert.equal(question.answer, undefined)
    assert.equal(question.finished, undefined)
    assert.ok(question.handle.startsWith('test-question-'))

    const first = fixture.predict.choice(question.identity, 'sqlite', true)
    assert.equal(first.question, question.identity)
    assert.equal(first.turn, turn)
    assert.equal(first.option, 'sqlite')
    assert.equal(first.selected, true)

    const rejected = fixture.predict.choice(question.identity, 'postgres', false)
    assert.equal(rejected.selected, false)

    const later = fixture.predict.choice(question.identity, 'duckdb', true)
    assert.equal(later.selected, true)

    const answered = fixture.db.get<Row>('SELECT * FROM question WHERE identity = ?', question.identity)
    // The first selected option is the answer; a later selected option cannot
    // rewrite the answer the user already gave.
    assert.equal(answered?.answer, 'sqlite')
    assert.equal(typeof answered?.finished, 'number')
    assert.equal(fixture.db.count('choice', 'question = ?', question.identity), 3)
    assert.equal(turnRow(fixture, turn)?.status, 'planning')

    assert.throws(() => fixture.predict.question(turn, ''), InvalidArgumentError)
    assert.throws(() => fixture.predict.choice(question.identity, '   ', true), InvalidArgumentError)
    assert.throws(
      () => fixture.predict.choice(question.identity, 'mysql', 'yes' as unknown as boolean),
      InvalidArgumentError,
    )
    assert.throws(() => fixture.predict.choice(999, 'mysql', true), NotFoundError)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Mode state and history
 * ------------------------------------------------------------------------- */

test('mode upserts the latest-turn mode state and history records session events', () => {
  const fixture = createFixture()
  try {
    // A session without a turn has no mode to derive.
    assert.throws(() => fixture.cognition.mode(fixture.session), InvalidStateError)

    const first = fixture.addTurn('think', { validation: 'high' })
    const mode = fixture.cognition.mode(fixture.session)
    assert.equal(mode.turn, first)
    assert.equal(mode.mode, 'think')
    assert.ok(mode.handle.startsWith('test-mode-'))
    assert.deepEqual(JSON.parse(mode.content), {
      session: fixture.session,
      turn: first,
      interaction: 'think',
      scene: 'engineering',
      validation: 'high',
      effort: 'medium',
      iteration: 1,
    })
    // Latest/upsert: the same row comes back, no second row is written.
    assert.equal(fixture.cognition.mode(fixture.session).identity, mode.identity)
    assert.equal(fixture.db.count('mode_state'), 1)

    const second = fixture.addTurn('converge')
    const next = fixture.cognition.mode(fixture.session)
    assert.equal(next.turn, second)
    assert.equal(next.mode, 'converge')
    assert.equal(fixture.db.count('mode_state'), 2)

    assert.deepEqual(fixture.cognition.history(fixture.session), [])
    const recorded = fixture.cognition.recordHistory(fixture.session, 'selection', 'interaction=think')
    assert.equal(recorded.session, fixture.session)
    assert.equal(recorded.kind, 'selection')
    assert.equal(recorded.content, 'interaction=think')
    assert.ok(recorded.handle.startsWith('test-history-'))
    fixture.cognition.recordHistory(fixture.session, 'answer', 'answer=1')
    assert.deepEqual(
      fixture.cognition.history(fixture.session).map((item) => item.kind),
      ['selection', 'answer'],
    )

    assert.throws(() => fixture.cognition.recordHistory(fixture.session, '', 'detail'), InvalidArgumentError)
    assert.throws(() => fixture.cognition.recordHistory(fixture.session, 'kind', '   '), InvalidArgumentError)
    assert.throws(() => fixture.cognition.recordHistory(999, 'kind', 'detail'), NotFoundError)
    assert.throws(() => fixture.cognition.mode(999), NotFoundError)
    assert.throws(() => fixture.cognition.history(999), NotFoundError)
  } finally {
    fixture.close()
  }
})
