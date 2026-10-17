/**
 * Supporting-module tests: generic Score (v23 §11.16), Error Learning and
 * Emotion/Companion/Crisis (§6.1 emotion mode, §6.3 validation, §9.5 stage one,
 * §11.17).
 *
 * The repository has no runtime TypeScript loader, so these tests are written
 * as TypeScript and executed through the same compile-then-run path as the
 * other host modules:
 *
 *   node node_modules/typescript/bin/tsc -p <temp build tsconfig>
 *   node --test .tmp/.../build/test/support.test.js
 *
 * Every test builds a real `:memory:` coordination database and inserts its
 * session, turn, prompt, error and score rows with explicit SQL. The supporting
 * modules are concurrent work, so no other host module is imported here: the
 * fixture is the database contract, not another module's behaviour.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CoordinationDatabase } from '../src/host/database.js'
import { createModuleHost } from '../src/host/module.js'
import type { ModuleHost, TraceWriter } from '../src/host/module.js'
import { HandleGenerator, ManualClock } from '../src/host/handle.js'
import { ScoreModule } from '../src/host/score.js'
import { LearningModule } from '../src/host/learning.js'
import { EmotionModule } from '../src/host/emotion.js'
import { resolveConfig } from '../src/host/config.js'
import type { ScoreCategory } from '../src/shared/enum.js'
import { InvalidArgumentError, NotFoundError } from '../src/shared/error.js'

/* ------------------------------------------------------------------------- *
 * Fixture
 * ------------------------------------------------------------------------- */

let handleCounter = 0

function nextHandle(kind: string): string {
  handleCounter += 1
  return `test-${kind}-${handleCounter}`
}

interface Fixture {
  db: CoordinationDatabase
  host: ModuleHost
  clock: ManualClock
  score: ScoreModule
  learning: LearningModule
  emotion: EmotionModule
  session: number
  turn: number
}

function fixture(): Fixture {
  const db = new CoordinationDatabase(':memory:')
  const clock = new ManualClock()
  const trace: TraceWriter = {
    append() {
      throw new Error('the supporting modules must not write governance trace rows')
    },
    list() {
      return []
    },
    verify() {
      return { ok: true }
    },
  }
  const host = createModuleHost({
    db,
    // None of the supporting modules reads a config value; the resolved
    // defaults only have to satisfy `ModuleHost`. Asking `resolveConfig` keeps
    // this fixture from drifting when the shared config grows a field (v24 §19
    // added `scenes` and `ui.locale` that way).
    config: resolveConfig({}),
    trace,
    clock,
    handles: new HandleGenerator('test'),
  })
  const session = insertSession(db, clock)
  const turn = insertTurn(db, clock, session, 1)
  return {
    db,
    host,
    clock,
    score: new ScoreModule(host),
    learning: new LearningModule(host),
    emotion: new EmotionModule(host),
    session,
    turn,
  }
}

function identityOf(db: CoordinationDatabase, table: string, handle: string): number {
  const row = db.get<{ identity: number }>(`SELECT identity FROM "${table}" WHERE handle = ?`, handle)
  if (row === undefined) throw new Error(`${table} row ${handle} was not inserted`)
  return row.identity
}

function insertSession(db: CoordinationDatabase, clock: ManualClock): number {
  const handle = nextHandle('session')
  db.run(
    `INSERT INTO session (handle, principal, sandbox, interaction, scene, validation, profile, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    handle,
    'test',
    'danger-full-access',
    'think',
    'dialogue',
    'medium',
    'default',
    clock.now(),
  )
  return identityOf(db, 'session', handle)
}

function insertTurn(db: CoordinationDatabase, clock: ManualClock, session: number, ordinal: number): number {
  const handle = nextHandle('turn')
  db.run(
    `INSERT INTO turn (handle, session, ordinal, interaction, scene, validation, profession, iteration, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    handle,
    session,
    ordinal,
    'think',
    'dialogue',
    'medium',
    'execution',
    1,
    clock.now(),
  )
  return identityOf(db, 'turn', handle)
}

/** Insert a prompt for a turn, optionally wiring the turn's pointer to it. */
function insertPrompt(
  db: CoordinationDatabase,
  clock: ManualClock,
  turn: number,
  content: string,
  pointer = false,
): number {
  const handle = nextHandle('prompt')
  db.run(
    `INSERT INTO prompt (handle, turn, content, created) VALUES (?, ?, ?, ?)`,
    handle,
    turn,
    content,
    clock.now(),
  )
  const identity = identityOf(db, 'prompt', handle)
  if (pointer) db.update('turn', { prompt: identity }, 'identity = ?', turn)
  return identity
}

function insertError(
  db: CoordinationDatabase,
  clock: ManualClock,
  turn: number,
  message: string,
  category = 'unknown',
  stack?: string,
): number {
  const handle = nextHandle('error')
  db.run(
    `INSERT INTO error (handle, turn, category, message, stack, created)
     VALUES (?, ?, ?, ?, ?, ?)`,
    handle,
    turn,
    category,
    message,
    stack ?? null,
    clock.now(),
  )
  return identityOf(db, 'error', handle)
}

function insertScoreRow(
  db: CoordinationDatabase,
  clock: ManualClock,
  input: { category: string; target: number; dimension: string; value: number; model?: string },
): void {
  db.run(
    `INSERT INTO score (handle, category, target, dimension, value, model, created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    nextHandle('score'),
    input.category,
    input.target,
    input.dimension,
    input.value,
    input.model ?? null,
    clock.now(),
  )
}

function isChinese(content: string): boolean {
  return /[\u4e00-\u9fa5]/.test(content)
}

/* ------------------------------------------------------------------------- *
 * Score (v23 §11.16)
 * ------------------------------------------------------------------------- */

test('score.add persists one validated row', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const score = f.score.add('plan', 7, 'clarity', 0.5, '  halfway  ', 'deepseek-chat')

  assert.ok(score.identity > 0)
  assert.match(score.handle, /^test-score-/)
  assert.equal(score.category, 'plan')
  assert.equal(score.target, 7)
  assert.equal(score.dimension, 'clarity')
  assert.equal(score.value, 0.5)
  assert.equal(score.reason, 'halfway')
  assert.equal(score.model, 'deepseek-chat')
  assert.equal(score.created, f.clock.now())
  assert.equal(f.db.count('score'), 1)

  const bare = f.score.add('turn', 7, 'alignment', 0.75)
  assert.equal(bare.reason, undefined)
  assert.equal(bare.model, undefined)
  assert.equal(f.db.count('score'), 2)
})

test('score.add normalises precision and accepts both closed endpoints', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  assert.equal(f.score.add('plan', 1, 'risk', 0.123456789).value, 0.123457)
  assert.equal(f.score.add('plan', 1, 'cost', 0).value, 0)
  assert.equal(f.score.add('plan', 1, 'efficiency', 1).value, 1)
  assert.equal(f.db.count('score'), 3)
})

test('score.add rejects values outside [0, 1] instead of clamping them', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  for (const value of [-0.01, 1.01, 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => f.score.add('plan', 1, 'clarity', value),
      (error: unknown) => error instanceof InvalidArgumentError && error.code === 'INVALID_ARGUMENT',
      `${String(value)} must be refused`,
    )
  }
  assert.equal(f.db.count('score'), 0, 'a refused value must not be stored')
})

test('score.add rejects unknown categories, identities and dimensions', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  assert.throws(() => f.score.add('failureRoute' as unknown as ScoreCategory, 1, 'clarity', 0.5), InvalidArgumentError)
  assert.throws(() => f.score.add('plan', 0, 'clarity', 0.5), InvalidArgumentError)
  assert.throws(() => f.score.add('plan', -3, 'clarity', 0.5), InvalidArgumentError)
  assert.throws(() => f.score.add('plan', 1.5, 'clarity', 0.5), InvalidArgumentError)
  assert.throws(() => f.score.add('plan', 1, '   ', 0.5), InvalidArgumentError)
  assert.throws(() => f.score.add('plan', 1, 12 as unknown as string, 0.5), InvalidArgumentError)
  assert.throws(() => f.score.add('plan', 1, 'clarity', 0.5, 4 as unknown as string), InvalidArgumentError)
  assert.throws(() => f.score.add('plan', 1, 'clarity', 0.5, undefined, 4 as unknown as string), InvalidArgumentError)
  assert.equal(f.db.count('score'), 0)
})

test('score.list filters by category and target, oldest first', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  f.score.add('plan', 7, 'clarity', 0.4)
  f.score.add('plan', 7, 'clarity', 0.6)
  f.score.add('plan', 8, 'clarity', 0.9)
  f.score.add('turn', 7, 'clarity', 0.2)

  assert.deepEqual(f.score.list('plan', 7).map(row => row.value), [0.4, 0.6])
  assert.deepEqual(f.score.list('plan', 8).map(row => row.value), [0.9])
  assert.deepEqual(f.score.list('turn', 7).map(row => row.value), [0.2])
  assert.deepEqual(f.score.list('plan', 9), [])
  assert.throws(() => f.score.list('plan', 0), InvalidArgumentError)
})

test('score.average averages samples and fails closed on an empty set', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  assert.equal(f.score.average('plan', 7), 0, 'an unmeasured target must not look like a pass')
  f.score.add('plan', 7, 'clarity', 0.2)
  f.score.add('plan', 7, 'coverage', 0.4)
  assert.equal(f.score.average('plan', 7), 0.3)

  f.score.add('plan', 7, 'risk', 0)
  f.score.add('plan', 7, 'cost', 1)
  assert.equal(f.score.average('plan', 7), 0.4)
  assert.equal(f.score.average('plan', 8), 0)
})

test('score.latest returns the newest measurement of one dimension', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  assert.equal(f.score.latest('plan', 7, 'clarity'), undefined)
  f.score.add('plan', 7, 'clarity', 0.3)
  const newest = f.score.add('plan', 7, 'clarity', 0.8)
  f.score.add('plan', 7, 'coverage', 0.1)

  const latest = f.score.latest('plan', 7, 'clarity')
  assert.equal(latest?.identity, newest.identity)
  assert.equal(latest?.value, 0.8)
  assert.equal(f.score.latest('plan', 7, 'coverage')?.value, 0.1)
  assert.equal(f.score.latest('plan', 7, 'alignment'), undefined)
  assert.throws(() => f.score.latest('plan', 7, ''), InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * Error learning (v23 §11.17)
 * ------------------------------------------------------------------------- */

test('classify maps the stable signals of the documented table', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['EACCES: permission denied, open R:\\secret.txt', 'permission'],
    ['sandbox blocked the file write', 'permission'],
    ['ETIMEDOUT after 30000ms', 'timeout'],
    ['Deadline exceeded while waiting for the provider', 'timeout'],
    ['invalid json: unexpected token < in JSON at position 3', 'schema'],
    ['Rate limit exceeded (429) from provider', 'provider'],
    ['tool exec failed: ENOENT no such file or directory', 'tool'],
    ['something strange exploded', 'unknown'],
  ]

  for (const [message, expected] of cases) {
    const identity = insertError(f.db, f.clock, f.turn, message, 'unknown', 'stack frame 1')
    const classified = f.learning.classify(identity)
    assert.equal(classified.category, expected, message)
    assert.equal(classified.message, message, 'classify must never rewrite the message')
    assert.equal(classified.stack, 'stack frame 1', 'classify must never rewrite the stack')
    assert.equal(classified.created, f.clock.now(), 'classify must never rewrite the creation time')
    const stored = f.db.get<{ category: string }>('SELECT category FROM error WHERE identity = ?', identity)
    assert.equal(stored?.category, expected)
  }
})

test('classify never downgrades a category the caller recorded', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const identity = insertError(f.db, f.clock, f.turn, 'the gizmo derailed', 'schema')
  assert.equal(f.learning.classify(identity).category, 'schema')
  assert.equal(f.learning.classify(identity).category, 'schema', 'classify is idempotent')
})

test('classify falls back to a learned pattern when no keyword matches', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  f.db.run(
    `INSERT INTO pattern (handle, kind, signature, content, weight, created)
     VALUES (?, ?, ?, ?, ?, ?)`,
    nextHandle('pattern'),
    'provider',
    'the gizmo derailed',
    'seeded by an operator',
    1,
    f.clock.now(),
  )
  const identity = insertError(f.db, f.clock, f.turn, 'The gizmo derailed during step 3')
  assert.equal(f.learning.classify(identity).category, 'provider')
})

test('decide maps each category onto the documented remedy without writing', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['EACCES: permission denied', 'escalate'],
    ['request timeout after 10s', 'retry'],
    ['invalid json payload', 'revise'],
    ['provider returned 503', 'retry'],
    ['command failed: exit code 2', 'revise'],
    ['a disturbance in the force', 'learn'],
  ]

  for (const [message, action] of cases) {
    const identity = insertError(f.db, f.clock, f.turn, message)
    const remedy = f.learning.decide(identity)
    assert.equal(remedy.action, action, message)
    assert.ok(remedy.reason.length > 0)
    const stored = f.db.get<{ category: string }>('SELECT category FROM error WHERE identity = ?', identity)
    assert.equal(stored?.category, 'unknown', 'decide is a read; classify is the writer')
  }
  assert.throws(() => f.learning.decide(9999), NotFoundError)
})

test('learn deduplicates the pattern by kind and signature and appends lessons', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const first = insertError(f.db, f.clock, f.turn, 'ETIMEDOUT after 30000ms')
  const second = insertError(f.db, f.clock, f.turn, 'ETIMEDOUT after 45000ms')

  f.learning.learn(first)
  assert.equal(f.db.count('pattern'), 1)
  assert.equal(f.db.count('lesson'), 1)
  const created = f.learning.pattern('etimedout after <n>ms')
  assert.ok(created !== undefined, 'the signature replaces numbers with a placeholder')
  assert.equal(created.kind, 'timeout')
  assert.equal(created.weight, 1, 'a stable keyword classification is fully understood')
  assert.equal(f.db.get<{ category: string }>('SELECT category FROM error WHERE identity = ?', first)?.category, 'timeout')

  f.learning.learn(second)
  assert.equal(f.db.count('pattern'), 1, 'the same signature must not create a second pattern')
  assert.equal(f.db.count('lesson'), 2, 'every observation keeps its own lesson')
  const repeated = f.learning.pattern('etimedout after <n>ms')
  assert.equal(repeated?.identity, created.identity)
  assert.equal(repeated?.weight, created.weight, 'a repeat never rewrites the pattern')
  assert.equal(repeated?.content, created.content, 'a repeat never rewrites the pattern content')
  assert.equal(repeated?.created, created.created, 'a repeat never rewrites the pattern history')

  f.learning.learn(first)
  assert.equal(f.db.count('pattern'), 1)
  assert.equal(f.db.count('lesson'), 3)

  const provisional = insertError(f.db, f.clock, f.turn, 'gribble flux anomaly')
  f.learning.learn(provisional)
  const unknown = f.learning.pattern('gribble flux anomaly')
  assert.equal(unknown?.kind, 'unknown')
  assert.equal(unknown?.weight, 0.5, 'an unclassified pattern is provisional')

  assert.equal(f.learning.pattern('no such signature'), undefined)
  assert.throws(() => f.learning.pattern('  '), InvalidArgumentError)
})

test('learn classifies first, so the pattern kind and the error category agree', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const identity = insertError(f.db, f.clock, f.turn, 'invalid json: unexpected token }')
  f.learning.learn(identity)

  assert.equal(f.db.get<{ category: string }>('SELECT category FROM error WHERE identity = ?', identity)?.category, 'schema')
  assert.equal(f.learning.pattern('invalid json: unexpected token }')?.kind, 'schema')
  assert.throws(() => f.learning.learn(9999), NotFoundError)
})

test('rollback records the decision against the error row', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const identity = insertError(f.db, f.clock, f.turn, 'tool exec failed: command not found')
  const rollback = f.learning.rollback(identity, 'turn:12')

  assert.ok(rollback.identity > 0)
  assert.match(rollback.handle, /^test-rollback-/)
  assert.equal(rollback.error, identity)
  assert.equal(rollback.target, 'turn:12')
  assert.match(rollback.reason, /tool/)
  assert.equal(rollback.created, f.clock.now())
  assert.equal(f.db.count('rollback'), 1)

  assert.throws(() => f.learning.rollback(identity, '   '), InvalidArgumentError)
  assert.throws(() => f.learning.rollback(9999, 'turn:12'), NotFoundError)
  assert.equal(f.db.count('rollback'), 1)
})

test('listError returns the errors of one session only', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const secondTurn = insertTurn(f.db, f.clock, f.session, 2)
  const otherSession = insertSession(f.db, f.clock)
  const otherTurn = insertTurn(f.db, f.clock, otherSession, 1)

  const first = insertError(f.db, f.clock, f.turn, 'first failure')
  const second = insertError(f.db, f.clock, secondTurn, 'second failure')
  insertError(f.db, f.clock, otherTurn, 'foreign failure')

  assert.deepEqual(f.learning.listError(f.session).map(row => row.identity), [first, second])
  assert.equal(f.learning.listError(otherSession).length, 1)
  assert.equal(f.learning.listError(otherSession)[0]?.message, 'foreign failure')
  assert.deepEqual(f.learning.listError(f.session).map(row => row.handle), [
    f.db.get<{ handle: string }>('SELECT handle FROM error WHERE identity = ?', first)?.handle,
    f.db.get<{ handle: string }>('SELECT handle FROM error WHERE identity = ?', second)?.handle,
  ])
  assert.throws(() => f.learning.listError(9999), NotFoundError)
  assert.throws(() => f.learning.listError(0), InvalidArgumentError)
})

test('calibration writes the neutral 0.5 fallback when no sample exists', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const calibration = f.learning.calibration('deepseek-chat', 'clarity')

  assert.equal(calibration.model, 'deepseek-chat')
  assert.equal(calibration.dimension, 'clarity')
  assert.equal(calibration.predicted, 0.5)
  assert.equal(calibration.actual, 0.5)
  assert.equal(calibration.score, 0.5, 'no sample is ever invented')
  assert.equal(calibration.created, f.clock.now())
  assert.equal(f.db.count('calibration'), 1)

  const again = f.learning.calibration('deepseek-chat', 'clarity')
  assert.equal(again.identity, calibration.identity, 'one row per model and dimension')
  assert.equal(f.db.count('calibration'), 1)
  assert.throws(() => f.learning.calibration('', 'clarity'), InvalidArgumentError)
  assert.throws(() => f.learning.calibration('deepseek-chat', '  '), InvalidArgumentError)
})

test('calibration scores real samples when the score table has them', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertScoreRow(f.db, f.clock, { category: 'plan', target: 1, dimension: 'clarity', value: 1, model: 'm' })
  insertScoreRow(f.db, f.clock, { category: 'plan', target: 1, dimension: 'clarity', value: 0.9, model: 'm' })

  const calibration = f.learning.calibration('m', 'clarity')
  assert.ok(calibration.predicted > 0.9)
  assert.equal(calibration.actual, 1)
  assert.ok(calibration.score > 0.5 && calibration.score <= 1)
  assert.equal(f.db.count('calibration'), 1)
})

/* ------------------------------------------------------------------------- *
 * Emotion, empathy, companion (v23 §6.1)
 * ------------------------------------------------------------------------- */

test('detect reads the lexicon and appends one emotion row per reading', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const positive = f.emotion.detect(f.turn, '谢谢你，我今天很开心！')
  assert.equal(positive.label, 'positive')
  assert.ok(positive.intensity > 0.12 && positive.intensity <= 1)
  assert.equal(positive.turn, f.turn)
  assert.match(positive.handle, /^test-emotion-/)
  assert.ok(isChinese(positive.empathy ?? ''), 'the empathy line is supportive Chinese copy')
  assert.equal(positive.created, f.clock.now())
  assert.equal(f.db.count('emotion'), 1)

  const worry = f.emotion.detect(f.turn, '我好焦虑，担心明天做不完')
  assert.equal(worry.label, 'worry')

  const urgency = f.emotion.detect(f.turn, 'deadline 到了，紧急，马上要交')
  assert.equal(urgency.label, 'urgency')

  const neutral = f.emotion.detect(f.turn, '')
  assert.equal(neutral.label, 'neutral')
  assert.equal(neutral.intensity, 0.12)

  assert.deepEqual(
    f.emotion.list(f.turn).map(row => row.label),
    ['positive', 'worry', 'urgency', 'neutral'],
  )
  assert.equal(f.db.count('emotion'), 4)
})

test('detect reads the turn prompt when no prompt is passed', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPrompt(f.db, f.clock, f.turn, '气死我了，真的很烦', false)
  assert.equal(f.emotion.detect(f.turn).label, 'anger', 'the latest prompt is the fallback')

  insertPrompt(f.db, f.clock, f.turn, '谢谢你，太好了', true)
  assert.equal(f.emotion.detect(f.turn).label, 'positive', 'the turn pointer wins over the latest row')

  const bare = insertTurn(f.db, f.clock, f.session, 2)
  assert.equal(f.emotion.detect(bare).label, 'neutral', 'a turn without a prompt reads as neutral')
  assert.throws(() => f.emotion.detect(f.turn, 42 as unknown as string), InvalidArgumentError)
})

test('detect never diagnoses: it labels emotional states only', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const labels = ['愤怒，气死了', '难过，想哭', '绝望，心碎', '我不舒服，很郁闷'].map(
    prompt => f.emotion.detect(f.turn, prompt).label,
  )
  assert.deepEqual(labels, ['anger', 'sadness', 'sadness', 'negative'])
  const allowed = new Set(['positive', 'negative', 'worry', 'anger', 'sadness', 'urgency', 'crisis', 'neutral'])
  for (const label of labels) assert.ok(allowed.has(label))
})

test('empathy is deterministic and tuned to the reading', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const sad = f.emotion.detect(f.turn, '我很难过，想哭')
  const first = f.emotion.empathy(sad)
  assert.deepEqual(f.emotion.empathy(sad), first, 'the profile is a pure function of the reading')
  assert.ok(first.tone.length > 0)
  assert.ok(first.pace.length > 0)
  assert.ok(isChinese(first.boundary))
  assert.match(first.boundary, /不诊断|不评判|不催促|不代替|不制造|不站队|不夸大/)

  const happy = f.emotion.detect(f.turn, '太棒了，谢谢！')
  assert.notEqual(f.emotion.empathy(happy).tone, first.tone)

  const low = f.emotion.empathy({ ...sad, intensity: 0.1 })
  const high = f.emotion.empathy({ ...sad, intensity: 0.9 })
  assert.equal(low.pace, '自然的对话节奏')
  assert.match(high.pace, /放慢/)

  const unknown = f.emotion.empathy({ ...sad, label: 'elated' })
  assert.ok(unknown.tone.length > 0, 'an unknown label falls back to the neutral profile')
  assert.throws(() => f.emotion.empathy(null as unknown as typeof sad), InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * Crisis (v23 §9.5 stage one, conservative)
 * ------------------------------------------------------------------------- */

test('crisis persists an explicit self-harm statement once', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPrompt(f.db, f.clock, f.turn, '我真的撑不住了，想死', true)

  const crisis = f.emotion.crisis(f.turn)
  assert.ok(crisis !== null)
  assert.equal(crisis.turn, f.turn)
  assert.equal(crisis.severity, 'high')
  assert.match(crisis.signal, /想死/)
  assert.ok(isChinese(crisis.action))
  assert.equal(crisis.created, f.clock.now())
  assert.equal(f.db.count('crisis'), 1)

  const again = f.emotion.crisis(f.turn)
  assert.equal(again?.identity, crisis.identity, 'a crisis row is an event: idempotent per turn')
  assert.equal(f.db.count('crisis'), 1)
})

test('crisis raises severity when the same sentence carries imminence', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPrompt(f.db, f.clock, f.turn, '我想死，今晚就结束生命', true)
  const crisis = f.emotion.crisis(f.turn)
  assert.ok(crisis !== null)
  assert.equal(crisis.severity, 'critical')
  assert.match(crisis.action, /110|120/)
})

test('crisis records explicit harm to others, with its own action', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPrompt(f.db, f.clock, f.turn, '我想杀了他', true)
  const crisis = f.emotion.crisis(f.turn)
  assert.ok(crisis !== null)
  assert.equal(crisis.severity, 'high')
  assert.match(crisis.action, /对方/)
  assert.match(crisis.action, /110|120/)
})

test('crisis returns null whenever the reading is uncertain', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const uncertain: ReadonlyArray<readonly [string, string]> = [
    ['他说“我想死”', 'quoted speech is reported, not intent'],
    ['如果朋友想死，我该怎么帮助他？', 'another person is the subject'],
    ['最近在读一篇关于自杀预防的论文', 'a topic is discussed'],
    ['我不想死，我只是很累', 'the statement is negated'],
    ['想死你了，好久不见', 'no first person reference'],
    ['自杀', 'a bare topic word is not an explicit statement'],
    ['he wants to die', 'no first person reference'],
    ['今年的自杀率又上升了', 'a measurement is not an intent'],
    ['我有点难过', 'plain sadness is not a crisis'],
    ['', 'an empty prompt is not a crisis'],
  ]

  let ordinal = 2
  for (const [prompt, because] of uncertain) {
    const turn = insertTurn(f.db, f.clock, f.session, ordinal)
    ordinal += 1
    insertPrompt(f.db, f.clock, turn, prompt, true)
    assert.equal(f.emotion.crisis(turn), null, because)
  }
  assert.equal(f.db.count('crisis'), 0)
})

/* ------------------------------------------------------------------------- *
 * Companion (sustained support)
 * ------------------------------------------------------------------------- */

test('companion appends a supportive row linked to the session and emotion', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const emotion = f.emotion.detect(f.turn, '我很难过，想哭')
  const companion = f.emotion.companion(f.turn)

  assert.ok(companion.identity > 0)
  assert.match(companion.handle, /^test-companion-/)
  assert.equal(companion.session, f.session)
  assert.equal(companion.emotion, emotion.identity)
  assert.ok(isChinese(companion.response), 'the companion copy is short supportive Chinese')
  assert.equal(companion.created, f.clock.now())
  assert.equal(f.db.count('companion'), 1)

  f.emotion.companion(f.turn)
  assert.equal(f.db.count('companion'), 2, 'each call offers one line of sustained support')
})

test('companion reads the turn first when no emotion row exists yet', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const companion = f.emotion.companion(f.turn)
  assert.equal(f.db.count('emotion'), 1, 'a companion needs a reading, so one is taken')
  assert.equal(f.db.count('companion'), 1)
  const emotion = f.db.get<{ identity: number; label: string }>('SELECT identity, label FROM emotion LIMIT 1')
  assert.equal(companion.emotion, emotion?.identity)
  assert.equal(emotion?.label, 'neutral')
})

/* ------------------------------------------------------------------------- *
 * Unknown turns
 * ------------------------------------------------------------------------- */

test('every emotion method refuses an unknown turn with a typed error', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  assert.throws(() => f.emotion.detect(9999), NotFoundError)
  assert.throws(() => f.emotion.list(9999), NotFoundError)
  assert.throws(() => f.emotion.crisis(9999), NotFoundError)
  assert.throws(() => f.emotion.companion(9999), NotFoundError)
  assert.throws(() => f.emotion.detect(0), InvalidArgumentError)

  const missing = f.db.get<{ identity: number }>('SELECT identity FROM turn WHERE identity = 9999')
  assert.equal(missing, undefined)
})
