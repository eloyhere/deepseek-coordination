/**
 * Orchestration module tests.
 *
 * The fixture builds a real in-memory coordination database and composes a
 * `ModuleHost` with the real `TraceModule` and `ProfessionModule`, so the tests
 * exercise the schema, the SQLite profession triggers, the append-only trace
 * hash chain and the verify-gate rather than a mock. Session, turn and plan rows
 * are inserted with SQL/`db.insert` on purpose: this module owns subtasks, not
 * the modules that create turns or plans.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubTask } from '../src/shared/entity.js'
import { InvalidArgumentError, InvalidStateError, VerificationError } from '../src/shared/error.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { CoordinationDatabase } from '../src/host/database.js'
import { ManualClock } from '../src/host/handle.js'
import { createModuleHost } from '../src/host/module.js'
import type { ModuleHost, TraceWriter } from '../src/host/module.js'
import { OrchestrationModule } from '../src/host/orchestration.js'
import { ProfessionModule } from '../src/host/profession.js'
import { TraceModule } from '../src/host/trace.js'

interface FixtureOptions {
  effort?: string
  maxReject?: number
  maxSubTask?: number
  profile?: string
  groundTruth?: boolean
  modelRouting?: boolean
}

interface Fixture {
  db: CoordinationDatabase
  host: ModuleHost
  trace: TraceModule
  profession: ProfessionModule
  orchestration: OrchestrationModule
  clock: ManualClock
  sandbox: string
  session: number
  turn: number
  plan: number
  setStep(step: unknown): void
  setStepText(step: string): void
  close(): void
}

/**
 * The resolved config this fixture needs.
 *
 * `resolveConfig` would pull `@deepseek-ai/schemastery` at runtime; this
 * checkout ships the package without its dependency link, so the test builds
 * the same resolved shape directly. Only the orchestration block varies.
 */
function createConfig(options: FixtureOptions): CoordinationConfig {
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
      maxReject: options.maxReject ?? 2,
      maxSubTask: options.maxSubTask ?? 8,
      groundTruth: options.groundTruth ?? true,
      groundTruthTimeout: 5000,
      allowShellGroundTruth: false,
      modelRouting: options.modelRouting ?? true,
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
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const clock = new ManualClock()
  const db = new CoordinationDatabase(':memory:')
  const sandbox = mkdtempSync(join(tmpdir(), 'coordination-orchestration-'))
  const config = createConfig(options)

  // TraceModule needs a host and the host needs a TraceWriter. Build the
  // kernel first, then attach the writer to the host every module receives.
  const kernel = createModuleHost({ db, config, clock, trace: undefined as unknown as TraceWriter })
  const trace = new TraceModule(kernel)
  const host: ModuleHost = { ...kernel, trace }
  const profession = new ProfessionModule(host)
  const orchestration = new OrchestrationModule(host, profession)

  const now = clock.now()
  const session = db.insert('session', {
    handle: 'session-orchestration',
    principal: 'local',
    sandbox,
    interaction: 'orchestrate',
    scene: 'engineering',
    validation: 'high',
    profile: options.profile ?? 'deepseek-chat',
    generation: 1,
    status: 'active',
    created: now,
  })
  const turn = db.insert('turn', {
    handle: 'turn-orchestration',
    session,
    ordinal: 1,
    command: 'none',
    interaction: 'orchestrate',
    scene: 'engineering',
    validation: 'high',
    profession: 'outcome',
    locked: 1,
    lockedAt: now,
    effort: options.effort ?? 'high',
    iteration: 1,
    rebuild: 0,
    status: 'orchestrating',
    created: now,
  })
  const plan = db.insert('plan', {
    handle: 'plan-orchestration',
    turn,
    goal: 'ship the feature',
    approach: 'decompose into subtasks',
    step: '[]',
    constraint: 'none',
    assumption: 'none',
    status: 'active',
    rebuild: 0,
    mode: 'auto',
    orchestration: 1,
    created: now,
  })

  return {
    db,
    host,
    trace,
    profession,
    orchestration,
    clock,
    sandbox,
    session,
    turn,
    plan,
    setStep(step: unknown): void {
      db.update('plan', { step: JSON.stringify(step) }, 'identity = ?', plan)
    },
    setStepText(step: string): void {
      db.update('plan', { step }, 'identity = ?', plan)
    },
    close(): void {
      db.close()
      rmSync(sandbox, { recursive: true, force: true })
    },
  }
}

/** Dispatch, submit and verify one subtask in the ordinary happy path. */
function complete(fixture: Fixture, subtask: number, result: string, verifier = 'verifier-1'): SubTask {
  fixture.orchestration.dispatch(subtask)
  fixture.orchestration.submit(subtask, result, `self-check evidence for subtask ${subtask}`, 'worker-1')
  return fixture.orchestration.verify(subtask, verifier)
}

/* ------------------------------------------------------------------------- *
 * Decompose
 * ------------------------------------------------------------------------- */

test('decompose requires acceptance and inherits the parent effort', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([{ task: 'write the report' }])
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)
    assert.equal(fixture.db.count('subtask'), 0)
    assert.equal(fixture.db.count('profession_record'), 0)
    assert.equal(fixture.db.count('orchestration_trace'), 0)

    fixture.setStep([{ task: 'write the report', acceptance: '   ' }])
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)

    fixture.setStep([{ task: 'write the report', acceptance: 'the report exists', effort: 'low' }])
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)

    fixture.setStep([
      { task: 'write the report', acceptance: 'the report contains DONE' },
      {
        task: 'summarise the report',
        acceptance: 'the summary is at most one page',
        model: 'deepseek-lite',
        reason: 'summarisation is cheaper on the small model',
      },
    ])
    const subtasks = fixture.orchestration.decompose(fixture.plan)
    assert.equal(subtasks.length, 2)

    const [first, second] = subtasks
    assert.equal(first.model, 'deepseek-chat')
    assert.equal(first.effort, 'high')
    assert.equal(first.profession, 'execution')
    assert.deepEqual(first.tools, [])
    assert.equal(first.context, '')
    assert.equal(first.status, 'pending')
    assert.equal(first.rejectCount, 0)
    assert.equal(first.locked, true)
    assert.equal(typeof first.lockedAt, 'number')
    assert.equal(second.model, 'deepseek-lite')
    assert.equal(second.effort, 'high')
    assert.equal(fixture.orchestration.get(first.identity).task, 'write the report')
    assert.equal(fixture.orchestration.list(fixture.turn).length, 2)

    const records = fixture.db.all<{ actor: string; profession: string; status: string }>(
      'SELECT * FROM profession_record WHERE subtask IS NOT NULL ORDER BY identity ASC',
    )
    assert.equal(records.length, 2)
    assert.equal(records[0].actor, 'host')
    assert.equal(records[0].profession, 'execution')
    assert.equal(records[0].status, 'pending')

    const locks = fixture.orchestration.trace(fixture.turn).filter((entry) => entry.event === 'lock')
    assert.equal(locks.length, 2)
    assert.equal(locks[0].profession, 'execution')
    assert.equal(locks[0].actor, 'host')
    const detail = JSON.parse(locks[1].detail) as { reason?: string; model?: string; modelOverridden?: boolean }
    assert.equal(detail.model, 'deepseek-lite')
    assert.equal(detail.modelOverridden, true)
    assert.equal(detail.reason, 'summarisation is cheaper on the small model')

    assert.equal(fixture.trace.verify(fixture.turn).ok, true)
  } finally {
    fixture.close()
  }
})

test('decompose rejects malformed steps, unknown fields, dangling dependencies and too many subtasks', () => {
  const fixture = createFixture({ maxSubTask: 1 })
  try {
    fixture.setStep([{ task: 'a', acceptance: 'a' }, { task: 'b', acceptance: 'b' }])
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)
    assert.equal(fixture.db.count('subtask'), 0)

    fixture.setStep([{ task: 'a', acceptance: 'a', blockedBy: [999] }])
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)

    fixture.setStep([{ task: 'a', acceptance: 'a', groundtruth: 'contains:x' }])
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)

    fixture.setStepText('{ not json')
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)

    fixture.setStep({ task: 'a', acceptance: 'a' })
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)

    fixture.setStep([])
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)

    assert.equal(fixture.db.count('subtask'), 0)
  } finally {
    fixture.close()
  }
})

test('decompose refuses a model override when model routing is disabled', () => {
  const fixture = createFixture({ modelRouting: false })
  try {
    fixture.setStep([{ task: 'a', acceptance: 'a', model: 'another-model' }])
    assert.throws(() => fixture.orchestration.decompose(fixture.plan), InvalidArgumentError)
    assert.equal(fixture.db.count('subtask'), 0)

    fixture.setStep([{ task: 'a', acceptance: 'a' }])
    const subtasks = fixture.orchestration.decompose(fixture.plan)
    assert.equal(subtasks[0].model, 'deepseek-chat')
  } finally {
    fixture.close()
  }
})

test('decompose defaults the model from the recorded parent model or the inherit sentinel', () => {
  const fixture = createFixture({ profile: '' })
  try {
    const now = fixture.clock.now()
    const prompt = fixture.db.insert('prompt', {
      handle: 'prompt-orchestration',
      turn: fixture.turn,
      content: 'ship the feature',
      created: now,
    })
    const comprehension = fixture.db.insert('comprehension', {
      handle: 'comprehension-orchestration',
      turn: fixture.turn,
      prompt,
      intent: 'ship the feature',
      requirement: 'a working feature',
      constraint: 'none',
      assumption: 'none',
      ambiguity: 'none',
      confidence: 0.9,
      stageCount: 0,
      created: now,
    })
    fixture.db.insert('organization', {
      handle: 'organization-orchestration',
      turn: fixture.turn,
      comprehension,
      plan: fixture.plan,
      goal: 'ship the feature',
      approach: 'decompose into subtasks',
      step: '[]',
      constraint: 'none',
      assumption: 'none',
      model: 'parent-model',
      created: now,
    })

    fixture.setStep([{ task: 'a', acceptance: 'a' }])
    assert.equal(fixture.orchestration.decompose(fixture.plan)[0].model, 'parent-model')
  } finally {
    fixture.close()
  }

  const bare = createFixture({ profile: '' })
  try {
    bare.setStep([{ task: 'a', acceptance: 'a' }])
    assert.equal(bare.orchestration.decompose(bare.plan)[0].model, 'inherit')
  } finally {
    bare.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Dispatch
 * ------------------------------------------------------------------------- */

test('dispatch refuses an unverified dependency and unlocks only after verification', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([
      { task: 'produce the artifact', acceptance: 'artifact.txt exists', groundTruth: 'exists:artifact.txt' },
    ])
    const [artifact] = fixture.orchestration.decompose(fixture.plan)
    fixture.setStep([{ task: 'consume the artifact', acceptance: 'consumer ran', blockedBy: [artifact.identity] }])
    const [consumer] = fixture.orchestration.decompose(fixture.plan)

    assert.throws(() => fixture.orchestration.dispatch(consumer.identity), InvalidStateError)

    assert.equal(fixture.orchestration.dispatch(artifact.identity).status, 'running')
    assert.throws(
      () => fixture.orchestration.submit(artifact.identity, 'artifact written', '   ', 'worker-artifact'),
      InvalidArgumentError,
    )
    assert.throws(
      () => fixture.orchestration.submit(artifact.identity, '   ', 'worker evidence', 'worker-artifact'),
      InvalidArgumentError,
    )
    writeFileSync(join(fixture.sandbox, 'artifact.txt'), 'ok')
    fixture.orchestration.submit(artifact.identity, 'artifact written', 'file exists at artifact.txt', 'worker-artifact')
    assert.equal(fixture.orchestration.verify(artifact.identity, 'verifier-artifact').status, 'verified')

    assert.equal(fixture.orchestration.dispatch(consumer.identity).status, 'running')
    assert.throws(() => fixture.orchestration.dispatch(artifact.identity), InvalidStateError)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Verify: independence and deterministic ground truth
 * ------------------------------------------------------------------------- */

test('the worker cannot verify its own submission', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([
      { task: 'first claim', acceptance: 'result contains DONE', groundTruth: 'contains:DONE' },
      { task: 'second claim', acceptance: 'result contains DONE', groundTruth: 'contains:DONE' },
    ])
    const [first, second] = fixture.orchestration.decompose(fixture.plan)

    fixture.orchestration.dispatch(first.identity)
    fixture.orchestration.submit(first.identity, 'DONE', 'evidence from the worker', 'worker-1')
    assert.throws(() => fixture.orchestration.verify(first.identity, 'worker-1'), VerificationError)
    assert.equal(fixture.orchestration.verify(first.identity, 'verifier-1').status, 'verified')

    // The default executor handle is `worker`.
    fixture.orchestration.dispatch(second.identity)
    fixture.orchestration.submit(second.identity, 'DONE', 'evidence from the default worker')
    assert.throws(() => fixture.orchestration.verify(second.identity, 'worker'), VerificationError)
    assert.equal(fixture.orchestration.verify(second.identity, 'verifier-2').status, 'verified')
  } finally {
    fixture.close()
  }
})

test('deterministic ground truth verifies every supported check', () => {
  const fixture = createFixture()
  try {
    const cases = [
      { task: 'exists case', groundTruth: 'exists:artifact.txt', result: 'artifact is here' },
      { task: 'contains case', groundTruth: 'contains:42', result: 'the answer is 42' },
      { task: 'not contains case', groundTruth: 'not-contains:ERROR', result: 'clean output' },
      { task: 'regex case', groundTruth: 'regex:^\\d+$', result: '12345' },
      { task: 'equals case', groundTruth: 'equals:exact text', result: 'exact text' },
    ]
    writeFileSync(join(fixture.sandbox, 'artifact.txt'), 'ok')
    fixture.setStep(
      cases.map((entry) => ({
        task: entry.task,
        acceptance: `${entry.task} acceptance`,
        groundTruth: entry.groundTruth,
      })),
    )
    const subtasks = fixture.orchestration.decompose(fixture.plan)
    assert.equal(subtasks.length, cases.length)

    subtasks.forEach((subtask, index) => {
      const entry = cases[index]
      fixture.orchestration.dispatch(subtask.identity)
      fixture.orchestration.submit(subtask.identity, entry.result, `evidence for ${entry.task}`)
      const verified = fixture.orchestration.verify(subtask.identity, 'verifier-1')
      assert.equal(verified.status, 'verified')
      assert.equal(verified.verdict, 'pass')
      assert.equal(typeof verified.finished, 'number')
    })

    const verifyTraces = fixture.orchestration.trace(fixture.turn).filter((entry) => entry.event === 'verify')
    assert.equal(verifyTraces.length, cases.length)
    const detail = JSON.parse(verifyTraces[1].detail) as { verdict: string; groundTruth: string; status: string }
    assert.equal(detail.verdict, 'pass')
    assert.equal(detail.groundTruth, 'contains:42')
    assert.equal(detail.status, 'verified')
    assert.equal(typeof verifyTraces[1].parentEvent, 'number')
    assert.equal(fixture.trace.verify(fixture.turn).ok, true)
  } finally {
    fixture.close()
  }
})

test('unknown or missing ground truth is unverifiable and rejected, never a pass', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([
      { task: 'unknown syntax', acceptance: 'the result is provably correct', groundTruth: 'sha256:deadbeef' },
      { task: 'shell exit', acceptance: 'the command succeeds', groundTruth: 'exit:0' },
      { task: 'no ground truth', acceptance: 'the result looks right' },
    ])
    const subtasks = fixture.orchestration.decompose(fixture.plan)

    subtasks.forEach((subtask, index) => {
      fixture.orchestration.dispatch(subtask.identity)
      fixture.orchestration.submit(subtask.identity, 'whatever the worker says', 'evidence', 'worker-1')
      const rejected = fixture.orchestration.verify(subtask.identity, `verifier-${index + 1}`)
      assert.equal(rejected.status, 'rejected')
      assert.equal(rejected.verdict, 'unverifiable')
      assert.equal(typeof rejected.reason, 'string')
      assert.equal(rejected.recovery?.suggestion, 'revise_criteria')
      assert.equal(rejected.recovery?.failedCriteria, subtask.acceptance)
    })

    const reasons = fixture.orchestration.list(fixture.turn).map((entry) => entry.reason ?? '')
    assert.match(reasons[0], /unknown ground truth syntax/)
    assert.match(reasons[1], /not executed/)
    assert.match(reasons[2], /no deterministic ground truth/)

    const verifyTraces = fixture.orchestration.trace(fixture.turn).filter((entry) => entry.event === 'verify')
    assert.equal(verifyTraces.length, 3)
    assert.equal(fixture.trace.verify(fixture.turn).ok, true)
  } finally {
    fixture.close()
  }
})

test('terminal subtask states are irreversible', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([
      { task: 'will verify', acceptance: 'result contains DONE', groundTruth: 'contains:DONE' },
      { task: 'will reject', acceptance: 'unknown criteria', groundTruth: 'verdict:maybe' },
    ])
    const [verified, rejected] = fixture.orchestration.decompose(fixture.plan)
    assert.equal(complete(fixture, verified.identity, 'DONE').status, 'verified')
    assert.equal(complete(fixture, rejected.identity, 'whatever').status, 'rejected')

    for (const terminal of [verified.identity, rejected.identity]) {
      assert.throws(() => fixture.orchestration.verify(terminal, 'verifier-9'), InvalidStateError)
      assert.throws(() => fixture.orchestration.dispatch(terminal), InvalidStateError)
      assert.throws(
        () => fixture.orchestration.submit(terminal, 'again', 'again', 'worker-9'),
        InvalidStateError,
      )
    }
    assert.throws(
      () => fixture.orchestration.recover(verified.identity, { suggestion: 'retry' }),
      InvalidStateError,
    )

    fixture.setStep([{ task: 'never submitted', acceptance: 'acceptance' }])
    const [pending] = fixture.orchestration.decompose(fixture.plan)
    assert.throws(() => fixture.orchestration.verify(pending.identity, 'verifier-9'), InvalidStateError)
    assert.throws(
      () => fixture.orchestration.recover(pending.identity, { suggestion: 'retry' }),
      InvalidStateError,
    )
  } finally {
    fixture.close()
  }
})

test('deterministic checks can fail, and malformed patterns are unverifiable', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([
      { task: 'missing artifact', acceptance: 'missing.txt exists', groundTruth: 'exists:missing.txt' },
      { task: 'bad pattern', acceptance: 'the pattern matches', groundTruth: 'regex:[' },
    ])
    const [missing, malformed] = fixture.orchestration.decompose(fixture.plan)

    fixture.orchestration.dispatch(missing.identity)
    fixture.orchestration.submit(missing.identity, 'the file is somewhere', 'evidence', 'worker-1')
    const failed = fixture.orchestration.verify(missing.identity, 'verifier-1')
    assert.equal(failed.status, 'rejected')
    assert.equal(failed.verdict, 'fail')
    assert.equal(failed.recovery?.suggestion, 'retry')

    fixture.orchestration.dispatch(malformed.identity)
    fixture.orchestration.submit(malformed.identity, 'anything', 'evidence', 'worker-1')
    const unverifiable = fixture.orchestration.verify(malformed.identity, 'verifier-2')
    assert.equal(unverifiable.status, 'rejected')
    assert.equal(unverifiable.verdict, 'unverifiable')
    assert.match(unverifiable.reason ?? '', /not a valid regular expression/)
    assert.equal(unverifiable.recovery?.suggestion, 'revise_criteria')
  } finally {
    fixture.close()
  }
})

test('disabling ground truth leaves a declared check unverifiable', () => {
  const fixture = createFixture({ groundTruth: false })
  try {
    fixture.setStep([{ task: 'declared check', acceptance: 'contains DONE', groundTruth: 'contains:DONE' }])
    const [subtask] = fixture.orchestration.decompose(fixture.plan)
    assert.equal(complete(fixture, subtask.identity, 'DONE').status, 'rejected')
    const rejected = fixture.orchestration.get(subtask.identity)
    assert.equal(rejected.verdict, 'unverifiable')
    assert.match(rejected.reason ?? '', /disabled by config\.orchestration\.groundTruth/)
  } finally {
    fixture.close()
  }
})

test('a parent may accept an unverifiable subtask as partial', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([{ task: 'judgement call', acceptance: 'the prose reads well' }])
    const [subtask] = fixture.orchestration.decompose(fixture.plan)
    assert.equal(complete(fixture, subtask.identity, 'a draft in prose').status, 'rejected')
    assert.equal(fixture.orchestration.get(subtask.identity).verdict, 'unverifiable')

    const partial = fixture.orchestration.recover(subtask.identity, {
      suggestion: 'accept_partial',
      detail: 'human review will finish the prose',
    })
    assert.equal(partial.status, 'partial')
    assert.equal(partial.verdict, 'partial')

    const answer = fixture.orchestration.synthesize(fixture.turn)
    assert.match(answer.content, /Status: partial/)
    assert.match(answer.content, /a draft in prose/)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Recover loop
 * ------------------------------------------------------------------------- */

test('recover closes the retry loop after maxReject and accepts a partial result', () => {
  const fixture = createFixture({ maxReject: 2 })
  try {
    fixture.setStep([
      { task: 'fix the regression', acceptance: 'result contains FIXED', groundTruth: 'contains:FIXED' },
    ])
    const [subtask] = fixture.orchestration.decompose(fixture.plan)

    const attempt = (result: string, verifier: string): SubTask => {
      fixture.orchestration.dispatch(subtask.identity)
      fixture.orchestration.submit(subtask.identity, result, 'worker self-check attached', 'worker-1')
      return fixture.orchestration.verify(subtask.identity, verifier)
    }

    assert.equal(attempt('not yet', 'verifier-1').status, 'rejected')
    assert.throws(
      () => fixture.orchestration.recover(subtask.identity, { suggestion: 'revise_criteria' }),
      InvalidArgumentError,
    )

    const firstRetry = fixture.orchestration.recover(subtask.identity, { suggestion: 'retry' })
    assert.equal(firstRetry.status, 'pending')
    assert.equal(firstRetry.rejectCount, 1)
    assert.equal(firstRetry.verdict, undefined)
    assert.equal(firstRetry.reason, undefined)
    assert.equal(firstRetry.recovery, undefined)

    assert.equal(attempt('still not', 'verifier-2').status, 'rejected')
    assert.equal(fixture.orchestration.recover(subtask.identity, { suggestion: 'retry' }).rejectCount, 2)

    assert.equal(attempt('still broken', 'verifier-3').status, 'rejected')
    assert.throws(
      () => fixture.orchestration.recover(subtask.identity, { suggestion: 'retry' }),
      InvalidStateError,
    )
    assert.throws(
      () =>
        fixture.orchestration.recover(subtask.identity, {
          suggestion: 'revise_criteria',
          criteria: 'a different definition of done',
        }),
      InvalidStateError,
    )

    const partial = fixture.orchestration.recover(subtask.identity, {
      suggestion: 'accept_partial',
      detail: 'shipping the partial fix',
    })
    assert.equal(partial.status, 'partial')
    assert.equal(partial.verdict, 'partial')
    assert.equal(partial.reason, 'shipping the partial fix')
    assert.equal(typeof partial.finished, 'number')

    assert.throws(() => fixture.orchestration.recover(subtask.identity, { suggestion: 'retry' }), InvalidStateError)

    const answer = fixture.orchestration.synthesize(fixture.turn)
    assert.match(answer.content, /## 1\. fix the regression/)
    assert.match(answer.content, /Status: partial/)
    assert.match(answer.content, /still broken/)
    assert.equal(
      fixture.orchestration.trace(fixture.turn).some((entry) => entry.event === 'synthesize'),
      true,
    )
    assert.equal(fixture.trace.verify(fixture.turn).ok, true)
  } finally {
    fixture.close()
  }
})

test('revise_criteria replaces the acceptance and reopens the subtask', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([
      { task: 'write the release note', acceptance: 'result contains NEW', groundTruth: 'contains:NEW' },
    ])
    const [subtask] = fixture.orchestration.decompose(fixture.plan)
    assert.equal(complete(fixture, subtask.identity, 'OLD').status, 'rejected')

    const revised = fixture.orchestration.recover(subtask.identity, {
      suggestion: 'revise_criteria',
      criteria: 'result mentions the NEW wording',
      detail: 'the original criterion was too vague',
    })
    assert.equal(revised.status, 'pending')
    assert.equal(revised.acceptance, 'result mentions the NEW wording')
    assert.equal(revised.rejectCount, 1)
    assert.equal(revised.verdict, undefined)
    assert.equal(revised.recovery, undefined)

    fixture.orchestration.dispatch(subtask.identity)
    fixture.orchestration.submit(subtask.identity, 'NEW wording', 'evidence', 'worker-1')
    assert.equal(fixture.orchestration.verify(subtask.identity, 'verifier-1').status, 'verified')

    const recoverTrace = fixture.orchestration
      .trace(fixture.turn)
      .filter((entry) => entry.event === 'recover')
      .pop()
    assert.equal(recoverTrace?.actor, 'parent')
    const detail = JSON.parse(recoverTrace?.detail ?? '{}') as { suggestion?: string; criteria?: string }
    assert.equal(detail.suggestion, 'revise_criteria')
    assert.equal(detail.criteria, 'result mentions the NEW wording')
  } finally {
    fixture.close()
  }
})

test('escalate marks the subtask rejected for a human and refuses further recovery', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([{ task: 'impossible task', acceptance: 'never true', groundTruth: 'contains:never' }])
    const [subtask] = fixture.orchestration.decompose(fixture.plan)
    assert.equal(complete(fixture, subtask.identity, 'nope').status, 'rejected')

    const escalated = fixture.orchestration.recover(subtask.identity, {
      suggestion: 'escalate',
      detail: 'needs a human decision',
    })
    assert.equal(escalated.status, 'rejected')
    assert.equal(escalated.reason, 'escalated to human')
    assert.equal(typeof escalated.finished, 'number')

    assert.throws(
      () => fixture.orchestration.recover(subtask.identity, { suggestion: 'retry' }),
      InvalidStateError,
    )
    assert.throws(() => fixture.orchestration.synthesize(fixture.turn), InvalidStateError)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Synthesize
 * ------------------------------------------------------------------------- */

test('synthesize refuses unverified subtasks and aggregates the accepted ones', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([
      { task: 'first deliverable', acceptance: 'result contains ONE', groundTruth: 'contains:ONE' },
      { task: 'second deliverable', acceptance: 'result contains TWO', groundTruth: 'contains:TWO' },
    ])
    const [first, second] = fixture.orchestration.decompose(fixture.plan)

    assert.throws(() => fixture.orchestration.synthesize(fixture.turn), InvalidStateError)
    assert.equal(fixture.db.count('answer'), 0)

    assert.equal(complete(fixture, first.identity, 'ONE result').status, 'verified')
    assert.throws(() => fixture.orchestration.synthesize(fixture.turn), InvalidStateError)
    assert.equal(fixture.db.count('answer'), 0)

    assert.equal(complete(fixture, second.identity, 'TWO result').status, 'verified')
    const answer = fixture.orchestration.synthesize(fixture.turn)
    assert.equal(answer.turn, fixture.turn)
    assert.equal(answer.validation, 'high')
    assert.match(answer.content, /## 1\. first deliverable/)
    assert.match(answer.content, /ONE result/)
    assert.match(answer.content, /## 2\. second deliverable/)
    assert.match(answer.content, /TWO result/)
    assert.equal(fixture.db.count('answer'), 1)

    // The bridge owns finishing the turn; synthesize must leave it open.
    const turnRow = fixture.db.get<{ status: string }>('SELECT status FROM turn WHERE identity = ?', fixture.turn)
    assert.equal(turnRow?.status, 'orchestrating')

    const synthesizeTrace = fixture.orchestration
      .trace(fixture.turn)
      .filter((entry) => entry.event === 'synthesize')
      .pop()
    assert.equal(synthesizeTrace?.actor, 'parent')
    const detail = JSON.parse(synthesizeTrace?.detail ?? '{}') as {
      evidence?: Array<{ subtask: number; status: string }>
      contentLength?: number
    }
    assert.equal(detail.evidence?.length, 2)
    assert.equal(detail.evidence?.[0].status, 'verified')
    assert.ok((detail.contentLength ?? 0) > 0)
    assert.equal(fixture.trace.verify(fixture.turn).ok, true)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Profession records on rebuild
 * ------------------------------------------------------------------------- */

test('rebuilding a subtask writes exactly one profession record for the replacement', () => {
  const fixture = createFixture()
  try {
    fixture.setStep([{ task: 'rebuildable work', acceptance: 'the work is done' }])
    const [original] = fixture.orchestration.decompose(fixture.plan)
    assert.equal(fixture.db.count('profession_record', 'subtask = ?', original.identity), 1)

    const rebuilt = fixture.profession.rebuildSubTask(original.identity, 'outcome')
    assert.notEqual(rebuilt.identity, original.identity)
    assert.equal(rebuilt.supersedes, original.identity)
    assert.equal(rebuilt.profession, 'outcome')
    assert.equal(rebuilt.locked, true)
    assert.equal(fixture.db.count('profession_record', 'subtask = ?', rebuilt.identity), 1)
    assert.equal(fixture.db.count('profession_record', 'subtask = ?', original.identity), 1)
    assert.equal(fixture.db.count('profession_record'), 2)

    const locks = fixture.orchestration.trace(fixture.turn).filter((entry) => entry.event === 'lock')
    assert.equal(locks.length, 2)
    assert.equal(locks[1].subtask, rebuilt.identity)
    assert.equal(locks[1].profession, 'outcome')
    assert.equal(fixture.trace.verify(fixture.turn).ok, true)
  } finally {
    fixture.close()
  }
})
