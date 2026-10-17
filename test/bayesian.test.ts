/**
 * Bayesian engine tests.
 *
 * The repository has no runtime TypeScript loader, so these tests are written
 * as TypeScript and executed through the same compile-then-run path used by the
 * other host modules:
 *
 *   node node_modules/typescript/bin/tsc -p <temp build tsconfig>
 *   node --test .tmp/.../build/test/bayesian.test.js
 *
 * Every test builds a real `:memory:` coordination database and inserts a
 * session, turn and evidence row with explicit SQL, exactly as the host would.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CoordinationDatabase } from '../src/host/database.js'
import { createModuleHost } from '../src/host/module.js'
import type { TraceWriter } from '../src/host/module.js'
import { ManualClock } from '../src/host/handle.js'
import {
  BayesianModule,
  binaryEntropy,
  convergencePolicy,
  evidencePolicy,
  klDivergence,
  logit,
  sigmoid,
  softmaxLogOdds,
} from '../src/host/bayesian.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError } from '../src/shared/error.js'

/* ------------------------------------------------------------------------- *
 * Fixture
 * ------------------------------------------------------------------------- */

let handleCounter = 0

function nextHandle(kind: string): string {
  handleCounter += 1
  return `test-${kind}-${handleCounter}`
}

interface FixtureOptions {
  prior?: number
  stopEntropy?: number
  infoGain?: number
  maxRoutes?: number
}

interface Fixture {
  db: CoordinationDatabase
  config: CoordinationConfig
  clock: ManualClock
  bayesian: BayesianModule
  turn: number
  evidence: number
}

/**
 * Minimal config fixture. The Bayesian engine reads only `config.bayesian`
 * (see `BayesianModule.priorProbability`), so the test does not repeat the
 * other groups' defaults. This keeps the suite independent of unrelated
 * config-schema evolution and of the runtime `@deepseek-ai/schemastery`
 * dependency, which is not linked in this workspace.
 */
function testConfig(options: FixtureOptions = {}): CoordinationConfig {
  return {
    bayesian: {
      prior: options.prior ?? 0.5,
      stopEntropy: options.stopEntropy ?? 0.05,
      infoGain: options.infoGain ?? 0.01,
      maxRoutes: options.maxRoutes ?? 12,
      calibrationFloor: 0.1,
    },
  } as unknown as CoordinationConfig
}

function fixture(options: FixtureOptions = {}): Fixture {
  const db = new CoordinationDatabase(':memory:')
  const config = testConfig(options)
  const clock = new ManualClock()
  const trace: TraceWriter = {
    append() {
      throw new Error('the Bayesian engine must not write governance trace rows')
    },
    list() {
      return []
    },
    verify() {
      return { ok: true }
    },
  }
  const host = createModuleHost({ db, config, trace, clock })
  const session = insertSession(db, clock)
  const turn = insertTurn(db, clock, session, 1)
  const evidence = insertEvidence(db, clock, turn, 0.5)
  return { db, config, clock, bayesian: new BayesianModule(host), turn, evidence }
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

function insertEvidence(db: CoordinationDatabase, clock: ManualClock, turn: number, weight: number): number {
  const handle = nextHandle('evidence')
  db.run(
    `INSERT INTO evidence (handle, turn, source, content, weight, created)
     VALUES (?, ?, ?, ?, ?, ?)`,
    handle,
    turn,
    'test',
    'hand-computed evidence',
    weight,
    clock.now(),
  )
  return identityOf(db, 'evidence', handle)
}

function insertPosterior(
  db: CoordinationDatabase,
  clock: ManualClock,
  turn: number,
  hypothesis: string,
  probability: number,
): number {
  const handle = nextHandle('posterior')
  db.run(
    `INSERT INTO posterior (handle, turn, hypothesis, probability, created)
     VALUES (?, ?, ?, ?, ?)`,
    handle,
    turn,
    hypothesis,
    probability,
    clock.now(),
  )
  return identityOf(db, 'posterior', handle)
}

function insertAnswer(db: CoordinationDatabase, clock: ManualClock, turn: number): number {
  const handle = nextHandle('answer')
  db.run(
    `INSERT INTO answer (handle, turn, content, validation, created)
     VALUES (?, ?, ?, ?, ?)`,
    handle,
    turn,
    'test answer',
    'medium',
    clock.now(),
  )
  return identityOf(db, 'answer', handle)
}

function insertScore(
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

/* ------------------------------------------------------------------------- *
 * priors and likelihoods
 * ------------------------------------------------------------------------- */

test('definePrior persists the configured prior', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const prior = f.bayesian.definePrior(f.turn, 'h1', 'test-fixture')

  assert.equal(prior.turn, f.turn)
  assert.equal(prior.hypothesis, 'h1')
  assert.equal(prior.probability, 0.5)
  assert.equal(prior.source, 'test-fixture')
  assert.ok(prior.identity > 0)
  assert.equal(f.db.count('prior'), 1)
})

test('definePrior and defineRoute read config.bayesian.prior while failure risk inverts it', (t) => {
  const f = fixture({ prior: 0.8 })
  t.after(() => f.db.close())

  const prior = f.bayesian.definePrior(f.turn, 'h1', 'config')
  assert.equal(prior.probability, 0.8)

  const route = f.bayesian.defineRoute(f.turn, 'h1', 'success route')
  assert.equal(route.probability, 0.8)
  assert.equal(route.rank, 0)

  const failure = f.bayesian.defineFailureRoute(f.turn, 'h1', 'failure route')
  assert.equal(failure.probability, 0.2)
  assert.equal(failure.rank, 0)
})

test('computeLikelihood maps weight to p(e|h), stores the weight and clamps it', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const likelihood = f.bayesian.computeLikelihood(f.evidence, 'h1', 0.5)
  assert.equal(likelihood.evidence, f.evidence)
  assert.equal(likelihood.hypothesis, 'h1')
  assert.equal(likelihood.probability, 0.5) // p(e|h) = 0.5 is the neutral ratio
  assert.equal(likelihood.weight, 0.5)

  const saturated = f.bayesian.computeLikelihood(f.evidence, 'h1', 5)
  assert.equal(saturated.weight, 1)
  assert.equal(saturated.probability, 0.999999)

  const ignored = f.bayesian.computeLikelihood(f.evidence, 'h1', -3)
  assert.equal(ignored.weight, 0)
  assert.equal(ignored.probability, 0.000001) // p(e|h) = 0 is guarded for logit
  assert.equal(f.db.count('likelihood'), 3)
})

test('update applies the hand-computed log-odds formula and persists both rows', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  f.bayesian.computeLikelihood(f.evidence, 'h1', 0.8)
  const posterior = f.bayesian.update(f.turn, 'h1', f.evidence)

  // sigmoid(logit(0.5) + 0.8 * logit(0.8)) == sigmoid(0.8 * ln 4)
  const expected = Math.round(sigmoid(logit(0.5) + 0.8 * logit(0.8)) * 1e6) / 1e6
  assert.equal(posterior.probability, 0.751949)
  assert.equal(posterior.probability, expected)
  assert.equal(posterior.turn, f.turn)
  assert.equal(posterior.hypothesis, 'h1')
  assert.equal(f.db.count('posterior'), 1)
  assert.equal(f.db.count('likelihood'), 2) // one computed, one recorded by update

  const stored = f.db.get<{ probability: number }>('SELECT probability FROM posterior WHERE identity = ?', posterior.identity)
  assert.equal(stored?.probability, 0.751949)

  // Evidence below the neutral point moves the belief the other way.
  f.bayesian.computeLikelihood(f.evidence, 'h2', 0.2)
  const refuted = f.bayesian.update(f.turn, 'h2', f.evidence)
  assert.equal(refuted.probability, 0.431126)
})

test('update clamps the posterior strictly inside (0, 1)', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  f.bayesian.computeLikelihood(f.evidence, 'strong', 1)
  const strong = f.bayesian.update(f.turn, 'strong', f.evidence)
  assert.equal(strong.probability, 0.999999)
  assert.ok(strong.probability < 1)
  assert.ok(strong.probability > 0.99)

  f.bayesian.computeLikelihood(f.evidence, 'none', 0)
  const none = f.bayesian.update(f.turn, 'none', f.evidence)
  assert.equal(none.probability, 0.5)

  // A non-neutral before/after pair still lands strictly inside the interval.
  f.bayesian.computeLikelihood(f.evidence, 'edge', 0.999999)
  const edge = f.bayesian.update(f.turn, 'edge', f.evidence)
  assert.ok(edge.probability > 0 && edge.probability < 1)
})

test('update enforces the evidence scope of its validation level', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const siblingTurn = insertTurn(f.db, f.clock, 1, 2)
  const siblingEvidence = insertEvidence(f.db, f.clock, siblingTurn, 0.8)

  // The turn's default validation is medium (session scope), so evidence from
  // a sibling turn is admissible and moves the belief.
  const sibling = f.bayesian.update(f.turn, 'h1', siblingEvidence)
  assert.equal(sibling.probability, 0.751949)

  // low is turn-scoped and refuses the sibling evidence.
  assert.throws(() => f.bayesian.update(f.turn, 'h2', siblingEvidence, 'low'), InvalidStateError)

  // high is local-scoped and admits the sibling evidence.
  assert.ok(f.bayesian.update(f.turn, 'h3', siblingEvidence, 'high').probability > 0.5)

  // Evidence from another session is outside medium scope but inside high.
  const foreignSession = insertSession(f.db, f.clock)
  const foreignTurn = insertTurn(f.db, f.clock, foreignSession, 1)
  const foreignEvidence = insertEvidence(f.db, f.clock, foreignTurn, 0.8)
  assert.throws(() => f.bayesian.update(f.turn, 'h4', foreignEvidence, 'medium'), InvalidStateError)
  assert.ok(f.bayesian.update(f.turn, 'h5', foreignEvidence, 'high').probability > 0.5)
})

/* ------------------------------------------------------------------------- *
 * entropy and divergence
 * ------------------------------------------------------------------------- */

test('binaryEntropy, klDivergence, logit and sigmoid match hand-computed values', () => {
  assert.equal(binaryEntropy(0.5), 1)
  assert.equal(binaryEntropy(0), 0)
  assert.equal(binaryEntropy(1), 0)
  assert.ok(Math.abs(binaryEntropy(0.9) - 0.468996) < 1e-6)

  assert.equal(klDivergence(0.5, 0.5), 0)
  assert.equal(klDivergence(0, 0), 0)
  assert.equal(klDivergence(1, 1), 0)
  assert.ok(Math.abs(klDivergence(0.9, 0.5) - 0.531004) < 1e-6)
  assert.ok(Number.isFinite(klDivergence(0, 1)))

  assert.equal(logit(0.5), 0)
  assert.ok(Math.abs(sigmoid(logit(0.75)) - 0.75) < 1e-12)

  const softmax = softmaxLogOdds([0.8, 0.5, 0.2])
  assert.deepEqual(
    softmax.map(value => Math.round(value * 1e6) / 1e6),
    [0.761905, 0.190476, 0.047619],
  )
  assert.ok(Math.abs(softmax.reduce((sum, value) => sum + value, 0) - 1) < 1e-12)
  assert.deepEqual(softmaxLogOdds([]), [])
})

/* ------------------------------------------------------------------------- *
 * evidence and convergence policy
 * ------------------------------------------------------------------------- */

test('evidencePolicy keeps Bayesian inference on for every validation level', () => {
  assert.deepEqual(evidencePolicy('low'), {
    queries: 1,
    maxResults: 3,
    scope: 'turn',
    bayesian: true,
    interactions: 'selected',
    fusion: 'none',
  })
  assert.deepEqual(evidencePolicy('medium'), {
    queries: 2,
    maxResults: 5,
    scope: 'session',
    bayesian: true,
    interactions: 'selected',
    fusion: 'none',
  })
  assert.deepEqual(evidencePolicy('high'), {
    queries: 4,
    maxResults: 8,
    scope: 'local',
    bayesian: true,
    interactions: 'all',
    fusion: 'global',
  })
  for (const level of ['low', 'medium', 'high'] as const) {
    assert.equal(evidencePolicy(level).bayesian, true)
    assert.ok(evidencePolicy(level).queries > 0)
  }
})

test('convergencePolicy scales configured thresholds by validation level', () => {
  const config = testConfig()
  const low = convergencePolicy('low', config.bayesian)
  const medium = convergencePolicy('medium', config.bayesian)
  const high = convergencePolicy('high', config.bayesian)

  assert.ok(Math.abs(low.stopEntropy - 0.1) < 1e-12)
  assert.ok(Math.abs(low.infoGain - 0.02) < 1e-12)
  assert.ok(Math.abs(medium.stopEntropy - 0.05) < 1e-12)
  assert.ok(Math.abs(medium.infoGain - 0.01) < 1e-12)
  assert.ok(Math.abs(high.stopEntropy - 0.025) < 1e-12)
  assert.ok(Math.abs(high.infoGain - 0.005) < 1e-12)

  assert.equal(low.evidence.scope, 'turn')
  assert.equal(medium.evidence.scope, 'session')
  assert.equal(high.evidence.scope, 'local')
  assert.equal(low.progressTolerance, 0)
  assert.equal(high.progressTolerance, 1e-6)
})

/* ------------------------------------------------------------------------- *
 * routes
 * ------------------------------------------------------------------------- */

test('rankRoute softmaxes posterior log-odds, sorts and persists rank', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'alpha', 0.8)
  insertPosterior(f.db, f.clock, f.turn, 'beta', 0.5)
  insertPosterior(f.db, f.clock, f.turn, 'gamma', 0.2)
  f.bayesian.defineRoute(f.turn, 'alpha', 'best route')
  f.bayesian.defineRoute(f.turn, 'beta', 'middle route')
  f.bayesian.defineRoute(f.turn, 'gamma', 'worst route')

  const ranked = f.bayesian.rankRoute(f.turn)

  assert.deepEqual(
    ranked.map(route => route.name),
    ['alpha', 'beta', 'gamma'],
  )
  assert.deepEqual(
    ranked.map(route => route.probability),
    [0.761905, 0.190476, 0.047619],
  )
  assert.deepEqual(
    ranked.map(route => route.rank),
    [0, 1, 2],
  )
  const sum = ranked.reduce((total, route) => total + route.probability, 0)
  assert.ok(Math.abs(sum - 1) < 1e-6)

  const selected = f.bayesian.selectRoute(f.turn)
  assert.equal(selected.name, 'alpha')
  assert.equal(selected.probability, 0.761905)

  const stored = f.db.get<{ rank: number; probability: number }>(
    'SELECT rank, probability FROM route WHERE name = ?',
    'gamma',
  )
  assert.equal(stored?.rank, 2)
  assert.equal(stored?.probability, 0.047619)
})

test('rankRoute defensively treats a missing posterior as 0.5', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'alpha', 0.8)
  f.bayesian.defineRoute(f.turn, 'alpha', 'observed route')
  f.bayesian.defineRoute(f.turn, 'beta', 'unobserved route')

  const ranked = f.bayesian.rankRoute(f.turn)
  assert.deepEqual(
    ranked.map(route => route.name),
    ['alpha', 'beta'],
  )
  assert.equal(ranked[0]?.probability, 0.8)
  assert.equal(ranked[1]?.probability, 0.2)
})

test('selectRoute fails closed when no route exists and duplicate names are refused', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  assert.deepEqual(f.bayesian.rankRoute(f.turn), [])
  assert.throws(() => f.bayesian.selectRoute(f.turn), NotFoundError)

  f.bayesian.defineRoute(f.turn, 'alpha', 'route')
  assert.throws(() => f.bayesian.defineRoute(f.turn, 'alpha', 'duplicate'), InvalidStateError)
})

test('maxRoutes from config caps route definitions', (t) => {
  const f = fixture({ maxRoutes: 2 })
  t.after(() => f.db.close())

  f.bayesian.defineRoute(f.turn, 'one', 'route one')
  f.bayesian.defineRoute(f.turn, 'two', 'route two')
  assert.throws(() => f.bayesian.defineRoute(f.turn, 'three', 'route three'), InvalidStateError)
})

/* ------------------------------------------------------------------------- *
 * failure routes and boundaries
 * ------------------------------------------------------------------------- */

test('rankFailureRoute inverts risk and sums to one', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'safe', 0.9)
  insertPosterior(f.db, f.clock, f.turn, 'risky', 0.3)
  const safe = f.bayesian.defineFailureRoute(f.turn, 'safe', 'safe failure mode')
  const risky = f.bayesian.defineFailureRoute(f.turn, 'risky', 'risky failure mode')
  assert.equal(safe.probability, 0.5)
  assert.equal(risky.probability, 0.5)

  const ranked = f.bayesian.rankFailureRoute(f.turn)
  assert.deepEqual(
    ranked.map(route => route.name),
    ['risky', 'safe'],
  )
  assert.equal(ranked[0]?.probability, 0.954545)
  assert.equal(ranked[1]?.probability, 0.045455)
  assert.deepEqual(
    ranked.map(route => route.rank),
    [0, 1],
  )
  const sum = ranked.reduce((total, route) => total + route.probability, 0)
  assert.ok(Math.abs(sum - 1) < 1e-6)
})

test('boundary records the failure route description plus posterior risk evidence', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'risky', 0.3)
  const risky = f.bayesian.defineFailureRoute(f.turn, 'risky', 'risky failure mode')
  f.bayesian.rankFailureRoute(f.turn)

  const boundary = f.bayesian.boundary(f.turn, risky.identity)
  assert.equal(boundary.turn, f.turn)
  assert.equal(boundary.failureRoute, risky.identity)
  assert.ok(boundary.content.includes('risky failure mode'))
  assert.ok(boundary.content.includes('failure probability 0.700000'))
  assert.ok(boundary.content.includes('posterior 0.300000'))
  assert.ok(boundary.content.includes('hypothesis risky'))
  assert.equal(f.db.count('boundary'), 1)

  assert.throws(() => f.bayesian.boundary(f.turn, 999), NotFoundError)

  const otherTurn = insertTurn(f.db, f.clock, 1, 2)
  const foreign = f.bayesian.defineFailureRoute(otherTurn, 'foreign', 'other turn')
  assert.throws(() => f.bayesian.boundary(f.turn, foreign.identity), InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * stopping
 * ------------------------------------------------------------------------- */

test('shouldStop stops at low posterior entropy and records the decision', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.999)
  assert.equal(f.bayesian.shouldStop(f.turn), true)

  const stopping = f.db.get<{ criterion: string; value: number; reached: number }>(
    'SELECT criterion, value, reached FROM stopping ORDER BY identity DESC LIMIT 1',
  )
  assert.equal(stopping?.criterion, 'entropy')
  assert.equal(stopping?.reached, 1)
  assert.ok(Math.abs((stopping?.value ?? 0) - 0.011408) < 1e-6)
  assert.equal(f.db.count('stopping'), 1)
})

test('shouldStop keeps iterating while entropy is high and KL exceeds infoGain', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.2)
  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.8)
  assert.equal(f.bayesian.shouldStop(f.turn), false)

  const stopping = f.db.get<{ criterion: string; value: number; reached: number }>(
    'SELECT criterion, value, reached FROM stopping ORDER BY identity DESC LIMIT 1',
  )
  assert.equal(stopping?.criterion, 'infoGain')
  assert.equal(stopping?.reached, 0)
  assert.ok(Math.abs((stopping?.value ?? 0) - 1.2) < 1e-6)
})

test('shouldStop fails closed without any posterior', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  assert.equal(f.bayesian.shouldStop(f.turn), false)

  const stopping = f.db.get<{ criterion: string; value: number; reached: number }>(
    'SELECT criterion, value, reached FROM stopping ORDER BY identity DESC LIMIT 1',
  )
  assert.equal(stopping?.criterion, 'entropy')
  assert.equal(stopping?.value, 1)
  assert.equal(stopping?.reached, 0)
})

test('shouldStop is level-aware: low stops earlier than medium and high', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.99) // entropy ~0.080793 bits
  assert.equal(f.bayesian.shouldStop(f.turn, 'low'), true) // low threshold 0.1
  assert.equal(f.bayesian.shouldStop(f.turn, 'medium'), false) // medium threshold 0.05
  assert.equal(f.bayesian.shouldStop(f.turn, 'high'), false) // high threshold 0.025
  assert.equal(f.bayesian.shouldStop(f.turn), false) // turn.validation defaults to medium
})

/* ------------------------------------------------------------------------- *
 * progress invariant
 * ------------------------------------------------------------------------- */

test('progressInvariant fails closed without posteriors', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const invariant = f.bayesian.progressInvariant(f.turn)
  assert.equal(invariant.ok, false)
  assert.equal(invariant.entropy, 0)
  assert.equal(invariant.score, 0)
  assert.equal(invariant.iteration, 1)
  assert.ok(invariant.reason.includes('no posterior'))
})

test('progressInvariant passes when posterior entropy decreased', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.5)
  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.9)

  const invariant = f.bayesian.progressInvariant(f.turn)
  assert.equal(invariant.ok, true)
  assert.ok(Math.abs(invariant.entropy - 0.468996) < 1e-6)
  assert.equal(invariant.iteration, 1)
  assert.ok(invariant.reason.includes('entropy decreased'))
})

test('progressInvariant passes when the turn iteration advanced', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  f.db.run('UPDATE turn SET iteration = 2 WHERE identity = ?', f.turn)
  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.5)

  const invariant = f.bayesian.progressInvariant(f.turn)
  assert.equal(invariant.ok, true)
  assert.equal(invariant.iteration, 2)
  assert.ok(invariant.reason.includes('iteration advanced'))
})

test('progressInvariant is level-aware through its progress tolerance', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.5)
  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.5005) // entropy drop ~7.2e-7 bits

  const medium = f.bayesian.progressInvariant(f.turn, 'medium')
  assert.equal(medium.ok, true) // tolerance 1e-9
  assert.ok(medium.reason.includes('validation medium'))

  const high = f.bayesian.progressInvariant(f.turn, 'high')
  assert.equal(high.ok, false) // tolerance 1e-6 is larger than the drop

  f.db.run(`UPDATE turn SET validation = 'high' WHERE identity = ?`, f.turn)
  assert.equal(f.bayesian.progressInvariant(f.turn).ok, false) // reads turn.validation
})

test('progressInvariant reports the latest answer score without depending on the plan module', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const answer = insertAnswer(f.db, f.clock, f.turn)
  insertScore(f.db, f.clock, { category: 'answer', target: answer, dimension: 'clarity', value: 0.75 })
  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.5)
  insertPosterior(f.db, f.clock, f.turn, 'h1', 0.9)

  const invariant = f.bayesian.progressInvariant(f.turn)
  assert.equal(invariant.ok, true)
  assert.equal(invariant.score, 0.75)
})

/* ------------------------------------------------------------------------- *
 * calibration
 * ------------------------------------------------------------------------- */

test('calibrate writes the neutral fallback and upserts one row when no samples exist', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  const first = f.bayesian.calibrate('model-a', 'clarity')
  assert.equal(first.model, 'model-a')
  assert.equal(first.dimension, 'clarity')
  assert.equal(first.predicted, 0.5)
  assert.equal(first.actual, 0.5)
  assert.equal(first.score, 0.5)
  assert.equal(f.db.count('calibration'), 1)

  const second = f.bayesian.calibrate('model-a', 'clarity')
  assert.equal(second.identity, first.identity)
  assert.equal(f.db.count('calibration'), 1)
})

test('calibrate computes a Brier-like skill from score rows', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertScore(f.db, f.clock, { category: 'plan', target: 42, dimension: 'quality', value: 0.8, model: 'model-a' })
  insertScore(f.db, f.clock, { category: 'plan', target: 42, dimension: 'quality', value: 0.6, model: 'model-a' })

  const first = f.bayesian.calibrate('model-a', 'quality')
  assert.equal(first.predicted, 0.7)
  assert.equal(first.actual, 1)
  assert.equal(first.score, 0.9)

  insertScore(f.db, f.clock, { category: 'plan', target: 42, dimension: 'quality', value: 0.2, model: 'model-a' })
  const second = f.bayesian.calibrate('model-a', 'quality')
  assert.equal(second.identity, first.identity)
  assert.equal(second.predicted, 0.533333)
  assert.equal(second.actual, 0.666667)
  assert.equal(second.score, 0.92)
  assert.equal(f.db.count('calibration'), 1)
})

/* ------------------------------------------------------------------------- *
 * expected information gain
 * ------------------------------------------------------------------------- */

test('computeEIG is a deterministic, clamped entropy proxy', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  insertPosterior(f.db, f.clock, f.turn, 'candidate', 0.8)
  f.bayesian.computeLikelihood(f.evidence, 'candidate', 0.8)

  const eig = f.bayesian.computeEIG(f.turn, 'candidate')
  assert.equal(eig, 0.577542) // binaryEntropy(0.8) * 0.8
  assert.ok(eig >= 0 && eig <= 1)
  assert.equal(f.bayesian.computeEIG(f.turn, 'candidate'), eig)

  const unknown = f.bayesian.computeEIG(f.turn, 'unknown-candidate')
  assert.equal(unknown, 0.5) // entropy(0.5) * default weight(0.5)
  assert.ok(unknown >= 0 && unknown <= 1)
})

/* ------------------------------------------------------------------------- *
 * typed errors
 * ------------------------------------------------------------------------- */

test('missing turns, evidence and invalid arguments raise typed errors', (t) => {
  const f = fixture()
  t.after(() => f.db.close())

  assert.throws(() => f.bayesian.computeLikelihood(999, 'h1', 0.5), NotFoundError)
  assert.throws(() => f.bayesian.update(999, 'h1', f.evidence), NotFoundError)
  assert.throws(() => f.bayesian.update(f.turn, 'h1', 999), NotFoundError)
  assert.throws(() => f.bayesian.definePrior(f.turn, '   ', 'test'), InvalidArgumentError)
  assert.throws(() => f.bayesian.computeLikelihood(f.evidence, 'h1', Number.NaN), InvalidArgumentError)
  assert.throws(() => f.bayesian.defineRoute(f.turn, '', 'description'), InvalidArgumentError)
  assert.throws(() => f.bayesian.calibrate('', 'dimension'), InvalidArgumentError)
})
