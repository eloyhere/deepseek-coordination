/**
 * Bayesian inference engine (v23 §12, v22-consistent; §6.1 heuristic/converge
 * modes, §9.5 stage three/four, §11.17 entities).
 *
 * The engine is deliberately synchronous and local: it reads only the
 * coordination database, never a DSH provider, and therefore stays useful when
 * every optional `ModuleHost` port is absent (tests compose exactly that host).
 *
 * Likelihood model
 * ----------------
 * `computeLikelihood(evidence, hypothesis, weight)` turns a clamped evidence
 * weight `w` in [0, 1] into a likelihood ratio:
 *
 *   p(e|h)  = w
 *   p(e|-h) = 1 - w
 *   LR      = p(e|h) / p(e|-h) = w / (1 - w)
 *
 * `w = 0.5` is neutral (`LR = 1`); `w = 1` is decisive support and `w = 0` is
 * decisive refutation, both numerically guarded. The `likelihood` row stores
 * `p(e|h)` in `probability` and the clamped weight in `weight`; the ratio
 * itself is derived from those two numbers, never invented as a column.
 *
 * Posterior update
 * ----------------
 *   logit(post) = logit(prior) + weight * log(LR)
 *   post        = sigmoid(logit(post))
 *
 * which is exactly `sigmoid(logit(prior) + weight * logit(p(e|h)))` because
 * `logit(p(e|h)) == log(LR)` under the mapping above. The posterior is
 * clamped strictly inside (0, 1) and rounded to six decimals.
 *
 * Schema notes (columns inspected in `src/host/database.ts`)
 * ---------------------------------------------------------
 * - `posterior` stores `(turn, hypothesis, probability, created)`; v23 has no
 *   `entropy`, `weight` or `changed` column, so entropy is derived on demand
 *   and the likelihood actually used is recorded in `likelihood`.
 * - `boundary` stores `(turn, failureRoute, content, created)`; there is no
 *   probability column, so the risk/evidence text is part of `content`.
 * - `calibration` stores `(model, dimension, predicted, actual, score,
 *   created)`; there is no sample column, so a "sample count" only decides
 *   whether the honest fallback or a real Brier-like score is written.
 * - Every write runs inside one `CoordinationDatabase.transaction`, and every
 *   domain failure is a typed error from `src/shared/error.ts`.
 *
 * Validation levels (v23 §6.3 override)
 * -------------------------------------
 * All three validation levels search and perform Bayesian prior/posterior
 * updates. The level controls retrieval breadth and evidence scope, not
 * whether inference happens: see `evidencePolicy`. Consequently `low` is
 * never treated as "no Bayesian update" anywhere in this module.
 */
import type { ModuleHost } from './module.js'
import { clamp, round } from './module.js'
import type { BayesianConfig } from './config.js'
import type {
  Boundary,
  Calibration,
  FailureRoute,
  Likelihood,
  Posterior,
  Prior,
  ProgressInvariant,
  Route,
  Stopping,
} from '../shared/entity.js'
import type { Validation } from '../shared/enum.js'
import { toValidation } from '../shared/enum.js'
import { InvalidArgumentError, InvalidStateError, NotFoundError } from '../shared/error.js'
import { bool, number, text } from './row.js'
import type { Row } from './row.js'

/** Numerical guard that keeps probabilities strictly inside (0, 1). */
const ProbabilityEpsilon = 1e-6
/** Config defaults, repeated so a partially built host still behaves. */
const DefaultPrior = 0.5
const DefaultLikelihoodWeight = 0.5
const DefaultStopEntropy = 0.05
const DefaultInfoGain = 0.01
const DefaultMaxRoutes = 12

/* ------------------------------------------------------------------------- *
 * Evidence and convergence policy (v23 §6.3 override)
 * ------------------------------------------------------------------------- */

/** Where the evidence for a turn may be retrieved from. */
export type EvidenceScope = 'turn' | 'session' | 'local'

/** Which interaction modes receive the Bayesian update at this level. */
export type EvidenceInteractionScope = 'selected' | 'all'

/**
 * One validation level's retrieval and inference policy.
 *
 * The user requirement that overrides v23 §6.3: every level searches and
 * updates priors/posteriors (`bayesian` is always true). Levels differ only in
 * how broadly evidence is retrieved:
 *
 * - `queries`    independent search queries the level may issue;
 * - `maxResults` results requested per query;
 * - `scope`      `turn` = current turn only, `session` = current session
 *                history, `local` = session plus local cross-session history;
 * - `interactions` `selected` = only the chosen interaction, `all` = every
 *                interaction mode (the v23 §6.3 breadth distinction that
 *                survives the override).
 */
export interface EvidencePolicy {
  queries: number
  maxResults: number
  scope: EvidenceScope
  bayesian: true
  interactions: EvidenceInteractionScope
}

/**
 * Proposed defaults for the three validation levels. `low` is intentionally
 * narrow (one turn-scoped query) but is still a full Bayesian step; `high` is
 * the broadest retrieval (local scope, all interactions).
 */
export const EvidencePolicyDefaults: Readonly<Record<Validation, EvidencePolicy>> = Object.freeze({
  low: { queries: 1, maxResults: 3, scope: 'turn', bayesian: true, interactions: 'selected' },
  medium: { queries: 2, maxResults: 5, scope: 'session', bayesian: true, interactions: 'selected' },
  high: { queries: 4, maxResults: 8, scope: 'local', bayesian: true, interactions: 'all' },
})

/**
 * Resolve the evidence policy of a validation level. Unknown values normalise
 * to `medium` through `toValidation`, matching the rest of the shared enum
 * surface, so a stale caller never loses its Bayesian step.
 */
export function evidencePolicy(validation: Validation): EvidencePolicy {
  const level = toValidation(validation)
  return { ...EvidencePolicyDefaults[level] }
}

/**
 * Convergence ambition of one validation level.
 *
 * All levels converge, but a narrow-evidence level must not be held to the
 * same certainty as a broad one. The base `config.bayesian.stopEntropy` and
 * `config.bayesian.infoGain` are scaled per level:
 *
 * - `low`    2x threshold (stops earlier; turn-scoped evidence cannot justify
 *            the same certainty);
 * - `medium` 1x threshold;
 * - `high`   0.5x threshold (must converge tighter because evidence is broad).
 *
 * `progressTolerance` is the minimum entropy decrease that counts as progress:
 * 0 for `low`, 1e-9 bits for `medium`, 1e-6 bits for `high`.
 */
export interface ConvergencePolicy {
  validation: Validation
  stopEntropy: number
  infoGain: number
  progressTolerance: number
  evidence: EvidencePolicy
}

const StopEntropyScale: Readonly<Record<Validation, number>> = { low: 2, medium: 1, high: 0.5 }
const InfoGainScale: Readonly<Record<Validation, number>> = { low: 2, medium: 1, high: 0.5 }
const ProgressTolerance: Readonly<Record<Validation, number>> = { low: 0, medium: 1e-9, high: 1e-6 }

/** Resolve the convergence policy of a level against the configured base thresholds. */
export function convergencePolicy(
  validation: Validation,
  config: Pick<BayesianConfig, 'stopEntropy' | 'infoGain'> = {
    stopEntropy: DefaultStopEntropy,
    infoGain: DefaultInfoGain,
  },
): ConvergencePolicy {
  const level = toValidation(validation)
  const stopEntropy =
    Number.isFinite(config.stopEntropy) && config.stopEntropy >= 0 ? config.stopEntropy : DefaultStopEntropy
  const infoGain = Number.isFinite(config.infoGain) && config.infoGain >= 0 ? config.infoGain : DefaultInfoGain
  return {
    validation: level,
    stopEntropy: stopEntropy * StopEntropyScale[level],
    infoGain: infoGain * InfoGainScale[level],
    progressTolerance: ProgressTolerance[level],
    evidence: evidencePolicy(level),
  }
}

/* ------------------------------------------------------------------------- *
 * Pure numerics
 * ------------------------------------------------------------------------- */

/** Clamp a probability into the open interval used by every log ratio. */
function clampProbability(value: number): number {
  const finite = Number.isFinite(value) ? value : DefaultPrior
  return clamp(finite, ProbabilityEpsilon, 1 - ProbabilityEpsilon)
}

/** Natural-log odds of a probability, saturating at the numerical guard. */
export function logit(probability: number): number {
  const p = clampProbability(probability)
  return Math.log(p / (1 - p))
}

/** Logistic function, evaluated without overflowing `Math.exp`. */
export function sigmoid(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? 1 : 0
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const exponential = Math.exp(value)
  return exponential / (1 + exponential)
}

/**
 * Binary Shannon entropy in bits: `-p log2 p - (1 - p) log2 (1 - p)`.
 * Certainty (`p = 0` or `p = 1`) has zero entropy and never produces NaN.
 */
export function binaryEntropy(probability: number): number {
  const p = clamp(Number.isFinite(probability) ? probability : DefaultPrior, 0, 1)
  if (p <= 0 || p >= 1) return 0
  const entropy = -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p))
  return Math.max(0, entropy)
}

/**
 * KL divergence in bits between a newer and an older probability:
 * `p log2(p/q) + (1-p) log2((1-p)/(1-q))`. Identical beliefs give exactly 0;
 * boundary values are saturated at the numerical guard so the result is
 * always finite and never NaN.
 */
export function klDivergence(posterior: number, previous: number): number {
  const p = Number.isFinite(posterior) ? posterior : DefaultPrior
  const q = Number.isFinite(previous) ? previous : DefaultPrior
  if (p === q) return 0
  const safeP = clampProbability(p)
  const safeQ = clampProbability(q)
  const divergence = safeP * Math.log2(safeP / safeQ) + (1 - safeP) * Math.log2((1 - safeP) / (1 - safeQ))
  return Math.max(0, divergence)
}

/**
 * Softmax over the log-odds of the supplied probabilities. A route without a
 * matching posterior is passed `0.5`, so its log odds are exactly zero and it
 * remains a neutral competitor. The result always sums to one (within float
 * precision).
 */
export function softmaxLogOdds(probabilities: readonly number[]): number[] {
  if (probabilities.length === 0) return []
  const logits = probabilities.map(value => logit(value))
  const maximum = Math.max(...logits)
  const weights = logits.map(value => Math.exp(value - maximum))
  const total = weights.reduce((sum, value) => sum + value, 0)
  if (total <= 0 || !Number.isFinite(total)) {
    return probabilities.map(() => 1 / probabilities.length)
  }
  return weights.map(value => value / total)
}

/* ------------------------------------------------------------------------- *
 * Input guards and stored-value helpers
 * ------------------------------------------------------------------------- */

function requireIdentity(value: unknown, kind: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${kind} must be a positive integer identity`, { [kind]: value })
  }
  return value
}

function requireText(value: unknown, kind: string, allowEmpty = false): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(`${kind} must be a string`, { [kind]: value })
  }
  const trimmed = value.trim()
  if (!allowEmpty && trimmed.length === 0) {
    throw new InvalidArgumentError(`${kind} must not be empty`, { [kind]: value })
  }
  return trimmed
}

function requireWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidArgumentError('evidence weight must be a finite number', { weight: value })
  }
  return clamp(value, 0, 1)
}

/** Round a probability to six decimals, still strictly inside (0, 1). */
function storedProbability(value: number): number {
  const finite = Number.isFinite(value) ? value : DefaultPrior
  const rounded = round(clamp(finite, ProbabilityEpsilon, 1 - ProbabilityEpsilon), 6)
  return clamp(rounded, ProbabilityEpsilon, 1 - ProbabilityEpsilon)
}

/** Store a weight exactly in [0, 1]; 0 and 1 are meaningful, not floors. */
function storedWeight(value: number): number {
  const finite = Number.isFinite(value) ? value : DefaultLikelihoodWeight
  return round(clamp(finite, 0, 1), 6)
}

/** `p(e|h)` for one evidence weight; `LR = p / (1 - p)`. */
function likelihoodProbability(weight: number): number {
  return clampProbability(weight)
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

/* ------------------------------------------------------------------------- *
 * Row mappers (the v23 mappers in row.ts cover the shared entities only)
 * ------------------------------------------------------------------------- */

function mapPrior(row: Row): Prior {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    hypothesis: text(row, 'hypothesis'),
    probability: number(row, 'probability'),
    source: text(row, 'source'),
    created: number(row, 'created'),
  }
}

function mapLikelihood(row: Row): Likelihood {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    evidence: number(row, 'evidence'),
    hypothesis: text(row, 'hypothesis'),
    probability: number(row, 'probability'),
    weight: number(row, 'weight'),
    created: number(row, 'created'),
  }
}

function mapPosterior(row: Row): Posterior {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    hypothesis: text(row, 'hypothesis'),
    probability: number(row, 'probability'),
    created: number(row, 'created'),
  }
}

function mapRoute(row: Row): Route {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    name: text(row, 'name'),
    description: text(row, 'description'),
    probability: number(row, 'probability'),
    rank: number(row, 'rank'),
    created: number(row, 'created'),
  }
}

function mapFailureRoute(row: Row): FailureRoute {
  return mapRoute(row)
}

function mapBoundary(row: Row): Boundary {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    failureRoute: number(row, 'failureRoute'),
    content: text(row, 'content'),
    created: number(row, 'created'),
  }
}

function mapStopping(row: Row): Stopping {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    criterion: text(row, 'criterion'),
    value: number(row, 'value'),
    reached: bool(row, 'reached'),
    created: number(row, 'created'),
  }
}

function mapCalibration(row: Row): Calibration {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    model: text(row, 'model'),
    dimension: text(row, 'dimension'),
    predicted: number(row, 'predicted'),
    actual: number(row, 'actual'),
    score: number(row, 'score'),
    created: number(row, 'created'),
  }
}

/* ------------------------------------------------------------------------- *
 * Module
 * ------------------------------------------------------------------------- */

export class BayesianModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /** Record the starting belief of one hypothesis for one turn. */
  definePrior(turn: number, hypothesis: string, source: string): Prior {
    const turnIdentity = requireIdentity(turn, 'turn')
    this.requireTurn(turnIdentity)
    const hypothesisName = requireText(hypothesis, 'hypothesis')
    const sourceName = requireText(source, 'source', true)
    return this.host.db.transaction(() => {
      const identity = this.host.db.insert('prior', {
        handle: this.host.handles.next('prior'),
        turn: turnIdentity,
        hypothesis: hypothesisName,
        probability: storedProbability(this.priorProbability()),
        source: sourceName,
        created: this.host.clock.now(),
      })
      return mapPrior(this.host.db.require<Row>('prior', identity, 'prior'))
    })
  }

  /**
   * Record `p(e|h)` and its weight for one evidence/hypothesis pair. The
   * likelihood ratio is `p(e|h) / (1 - p(e|h))`; both stored values are
   * rounded to six decimals.
   */
  computeLikelihood(evidence: number, hypothesis: string, weight: number): Likelihood {
    const evidenceIdentity = requireIdentity(evidence, 'evidence')
    this.requireEvidence(evidenceIdentity)
    const hypothesisName = requireText(hypothesis, 'hypothesis')
    const evidenceWeight = requireWeight(weight)
    return this.host.db.transaction(() =>
      this.recordLikelihood(evidenceIdentity, hypothesisName, likelihoodProbability(evidenceWeight), evidenceWeight),
    )
  }

  /**
   * Apply one Bayesian update. The latest `prior` of the hypothesis (or
   * `config.bayesian.prior`) is the starting belief; the latest likelihood of
   * the evidence/hypothesis pair is the observation (when none exists, the
   * evidence row's own weight seeds one).
   *
   * One `posterior` row is always appended, and one `likelihood` row records
   * exactly which observation was used, so the update can be reproduced from
   * the database alone.
   */
  update(turn: number, hypothesis: string, evidence: number): Posterior {
    const turnIdentity = requireIdentity(turn, 'turn')
    this.requireTurn(turnIdentity)
    const evidenceIdentity = requireIdentity(evidence, 'evidence')
    const evidenceRow = this.requireEvidence(evidenceIdentity)
    const hypothesisName = requireText(hypothesis, 'hypothesis')
    return this.host.db.transaction(() => {
      const prior = this.latestPrior(turnIdentity, hypothesisName)
      const start = prior?.probability ?? this.priorProbability()
      const existing = this.latestLikelihood(evidenceIdentity, hypothesisName)
      const weight =
        existing === undefined
          ? clamp(number(evidenceRow, 'weight', DefaultLikelihoodWeight), 0, 1)
          : clamp(existing.weight, 0, 1)
      const probability =
        existing === undefined
          ? likelihoodProbability(weight)
          : clamp(existing.probability, ProbabilityEpsilon, 1 - ProbabilityEpsilon)
      const logLikelihoodRatio = Math.log(probability / (1 - probability))
      const posteriorProbability = sigmoid(logit(start) + weight * logLikelihoodRatio)

      // The observation actually used for this step (always exactly one row).
      this.recordLikelihood(evidenceIdentity, hypothesisName, probability, weight)
      return this.recordPosterior(turnIdentity, hypothesisName, posteriorProbability)
    })
  }

  /**
   * Expected information gain proxy: the entropy of the current belief for
   * `candidate` multiplied by the candidate's latest likelihood weight. It is
   * deterministic, in [0, 1], and 0 once the belief is already certain. The
   * candidate weight defaults to 0.5 when no likelihood was recorded.
   */
  computeEIG(turn: number, candidate: string): number {
    const turnIdentity = requireIdentity(turn, 'turn')
    this.requireTurn(turnIdentity)
    const candidateName = requireText(candidate, 'candidate')
    const posterior = this.latestPosterior(turnIdentity, candidateName)
    const probability = posterior?.probability ?? this.priorProbability()
    const row = this.host.db.get<Row>(
      `SELECT l.weight AS weight, l.probability AS probability
       FROM likelihood l
       JOIN evidence e ON e.identity = l.evidence
       WHERE l.hypothesis = ? AND e.turn = ?
       ORDER BY l.identity DESC LIMIT 1`,
      candidateName,
      turnIdentity,
    )
    const weight = row === undefined ? DefaultLikelihoodWeight : clamp(number(row, 'weight', DefaultLikelihoodWeight), 0, 1)
    return round(clamp(binaryEntropy(probability) * weight, 0, 1), 6)
  }

  /** Define one success route. Its initial probability is the hypothesis prior. */
  defineRoute(turn: number, name: string, description: string): Route {
    const turnIdentity = requireIdentity(turn, 'turn')
    this.requireTurn(turnIdentity)
    const routeName = requireText(name, 'route name')
    const routeDescription = requireText(description, 'route description', true)
    return this.host.db.transaction(() => {
      this.assertNewRoute('route', turnIdentity, routeName)
      const probability = storedProbability(this.latestPrior(turnIdentity, routeName)?.probability ?? this.priorProbability())
      const identity = this.host.db.insert('route', {
        handle: this.host.handles.next('route'),
        turn: turnIdentity,
        name: routeName,
        description: routeDescription,
        probability,
        rank: 0,
        created: this.host.clock.now(),
      })
      return mapRoute(this.host.db.require<Row>('route', identity, 'route'))
    })
  }

  /**
   * Recalculate every route probability by softmaxing the log-odds of the
   * matching posterior (0.5 when a route has no posterior yet), sort
   * descending, persist the new `rank`, and return the ranked routes.
   */
  rankRoute(turn: number): Route[] {
    const turnIdentity = requireIdentity(turn, 'turn')
    this.requireTurn(turnIdentity)
    const routes = this.host.db
      .all<Row>('SELECT * FROM route WHERE turn = ? ORDER BY identity ASC', turnIdentity)
      .map(mapRoute)
    if (routes.length === 0) return []
    const posteriorProbabilities = routes.map(route => this.latestPosterior(turnIdentity, route.name)?.probability ?? DefaultPrior)
    const probabilities = softmaxLogOdds(posteriorProbabilities).map(storedProbability)
    const ranked = routes.map((route, index) => ({ route, probability: probabilities[index] ?? 0 }))
    ranked.sort((left, right) => right.probability - left.probability || left.route.identity - right.route.identity)
    return this.host.db.transaction(() => {
      const result: Route[] = []
      ranked.forEach((entry, index) => {
        this.host.db.update('route', { probability: entry.probability, rank: index }, 'identity = ?', entry.route.identity)
        result.push({ ...entry.route, probability: entry.probability, rank: index })
      })
      return result
    })
  }

  /** Rank the success routes and return the best one. */
  selectRoute(turn: number): Route {
    const ranked = this.rankRoute(turn)
    const best = ranked[0]
    if (best === undefined) throw new NotFoundError('route', turn)
    return best
  }

  /**
   * Define one failure route. Its initial probability is the inverted prior
   * risk, i.e. `1 - prior`, because a failure route carries risk rather than
   * success probability.
   */
  defineFailureRoute(turn: number, name: string, description: string): FailureRoute {
    const turnIdentity = requireIdentity(turn, 'turn')
    this.requireTurn(turnIdentity)
    const routeName = requireText(name, 'failure route name')
    const routeDescription = requireText(description, 'failure route description', true)
    return this.host.db.transaction(() => {
      this.assertNewRoute('failure_route', turnIdentity, routeName)
      const success = this.latestPrior(turnIdentity, routeName)?.probability ?? this.priorProbability()
      const risk = storedProbability(1 - clampProbability(success))
      const identity = this.host.db.insert('failure_route', {
        handle: this.host.handles.next('failureRoute'),
        turn: turnIdentity,
        name: routeName,
        description: routeDescription,
        probability: risk,
        rank: 0,
        created: this.host.clock.now(),
      })
      return mapFailureRoute(this.host.db.require<Row>('failure_route', identity, 'failure route'))
    })
  }

  /**
   * Mirror of `rankRoute` for risk: a failure route's risk is `1 - posterior`
   * of the matching hypothesis, softmaxed over log-odds, sorted descending and
   * written back as probability/rank.
   */
  rankFailureRoute(turn: number): FailureRoute[] {
    const turnIdentity = requireIdentity(turn, 'turn')
    this.requireTurn(turnIdentity)
    const routes = this.host.db
      .all<Row>('SELECT * FROM failure_route WHERE turn = ? ORDER BY identity ASC', turnIdentity)
      .map(mapFailureRoute)
    if (routes.length === 0) return []
    const risks = routes.map(route => {
      const posterior = this.latestPosterior(turnIdentity, route.name)?.probability ?? DefaultPrior
      return clampProbability(1 - clampProbability(posterior))
    })
    const probabilities = softmaxLogOdds(risks).map(storedProbability)
    const ranked = routes.map((route, index) => ({ route, probability: probabilities[index] ?? 0 }))
    ranked.sort((left, right) => right.probability - left.probability || left.route.identity - right.route.identity)
    return this.host.db.transaction(() => {
      const result: FailureRoute[] = []
      ranked.forEach((entry, index) => {
        this.host.db.update(
          'failure_route',
          { probability: entry.probability, rank: index },
          'identity = ?',
          entry.route.identity,
        )
        result.push({ ...entry.route, probability: entry.probability, rank: index })
      })
      return result
    })
  }

  /**
   * Build the boundary record of one failure route. v23's `boundary` table has
   * no probability/evidence columns, so the inverted posterior risk and the
   * source posterior are encoded in the human-readable content alongside the
   * route description.
   */
  boundary(turn: number, failureRoute: number): Boundary {
    const turnIdentity = requireIdentity(turn, 'turn')
    this.requireTurn(turnIdentity)
    const failureRouteIdentity = requireIdentity(failureRoute, 'failure route')
    return this.host.db.transaction(() => {
      const routeRow = this.host.db.get<Row>('SELECT * FROM failure_route WHERE identity = ?', failureRouteIdentity)
      if (routeRow === undefined) throw new NotFoundError('failure route', failureRouteIdentity)
      const route = mapFailureRoute(routeRow)
      if (route.turn !== turnIdentity) {
        throw new InvalidArgumentError(
          `failure route ${failureRouteIdentity} belongs to turn ${route.turn}, not turn ${turnIdentity}`,
          { turn: turnIdentity, failureRoute: failureRouteIdentity, routeTurn: route.turn },
        )
      }
      const posterior = storedProbability(this.latestPosterior(turnIdentity, route.name)?.probability ?? DefaultPrior)
      const risk = storedProbability(1 - posterior)
      const content = [
        route.description,
        `failure probability ${risk.toFixed(6)}`,
        `posterior ${posterior.toFixed(6)}`,
        `hypothesis ${route.name}`,
      ]
        .filter(part => part.length > 0)
        .join('; ')
      const identity = this.host.db.insert('boundary', {
        handle: this.host.handles.next('boundary'),
        turn: turnIdentity,
        failureRoute: failureRouteIdentity,
        content,
        created: this.host.clock.now(),
      })
      return mapBoundary(this.host.db.require<Row>('boundary', identity, 'boundary'))
    })
  }

  /**
   * Decide whether the converge loop may stop and record the decision.
   *
   * Stopping rule (v22 §12, "Convergence Must Be Designed"), tuned by the
   * turn's validation level through `convergencePolicy`:
   * - `entropy(latest posterior) < effective stopEntropy`, or
   * - `KL(latest || previous posterior) < effective infoGain`.
   *
   * Every validation level performs this Bayesian inference; `low` merely
   * stops earlier (2x thresholds) because its evidence scope is narrow, while
   * `high` demands tighter convergence (0.5x thresholds). The level is read
   * from `turn.validation` unless an explicit override is supplied.
   *
   * The KL term needs two posterior rows; with fewer than two there is no
   * stability evidence and only the entropy term can stop. Without any
   * posterior the engine fails closed (returns `false`) and records why. One
   * `stopping` row is written per call, with `criterion` naming the decisive
   * test and `value` the measured number.
   */
  shouldStop(turn: number, validation?: Validation): boolean {
    const turnIdentity = requireIdentity(turn, 'turn')
    const turnRow = this.requireTurn(turnIdentity)
    const level = validation === undefined ? toValidation(text(turnRow, 'validation', 'medium')) : toValidation(validation)
    const policy = convergencePolicy(level, this.host.config.bayesian)
    return this.host.db.transaction(() => {
      const latestRow = this.host.db.get<Row>(
        'SELECT * FROM posterior WHERE turn = ? ORDER BY identity DESC LIMIT 1',
        turnIdentity,
      )
      if (latestRow === undefined) {
        this.recordStopping(turnIdentity, 'entropy', 1, false)
        return false
      }
      const latest = mapPosterior(latestRow)
      const entropy = binaryEntropy(latest.probability)
      const previousRow = this.host.db.get<Row>(
        'SELECT * FROM posterior WHERE turn = ? AND identity < ? ORDER BY identity DESC LIMIT 1',
        turnIdentity,
        latest.identity,
      )
      const divergence =
        previousRow === undefined
          ? undefined
          : klDivergence(latest.probability, number(previousRow, 'probability', DefaultPrior))

      if (entropy < policy.stopEntropy) {
        this.recordStopping(turnIdentity, 'entropy', entropy, true)
        return true
      }
      if (divergence !== undefined && divergence < policy.infoGain) {
        this.recordStopping(turnIdentity, 'infoGain', divergence, true)
        return true
      }
      if (divergence === undefined) {
        this.recordStopping(turnIdentity, 'entropy', entropy, false)
      } else {
        this.recordStopping(turnIdentity, 'infoGain', divergence, false)
      }
      return false
    })
  }

  /**
   * Progress invariant: iteration must not run in place. The step is
   * considered progress when the latest posterior entropy decreased relative
   * to the previous posterior, or when the turn iteration advanced past its
   * first iteration (a rebuild). It fails closed when no posterior exists:
   * without a belief there is nothing to prove progress with.
   *
   * The optional `score` is read from the latest `answer` or `plan` score of
   * the turn (falling back to the newest scored row of either category when a
   * bare score cannot be tied to a turn); it is informational and
   * intentionally does not participate in `ok`, so this invariant never
   * depends on the plan module.
   *
   * Level awareness: the level is read from `turn.validation` (or the explicit
   * override) and its `progressTolerance` decides how large an entropy
   * decrease must be to count as progress. Every level still evaluates the
   * same invariant; `low` is never skipped.
   */
  progressInvariant(turn: number, validation?: Validation): ProgressInvariant {
    const turnIdentity = requireIdentity(turn, 'turn')
    const turnRow = this.requireTurn(turnIdentity)
    const level = validation === undefined ? toValidation(text(turnRow, 'validation', 'medium')) : toValidation(validation)
    const policy = convergencePolicy(level, this.host.config.bayesian)
    const iteration = number(turnRow, 'iteration', 1)
    const score = this.latestTurnScore(turnIdentity)
    const latestRow = this.host.db.get<Row>(
      'SELECT * FROM posterior WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turnIdentity,
    )
    if (latestRow === undefined) {
      return {
        ok: false,
        reason: `no posterior recorded for turn ${turnIdentity}`,
        entropy: 0,
        score,
        iteration,
      }
    }
    const latest = mapPosterior(latestRow)
    const entropy = binaryEntropy(latest.probability)
    const entropyValue = round(entropy, 6)
    const previousRow = this.host.db.get<Row>(
      'SELECT * FROM posterior WHERE turn = ? AND identity < ? ORDER BY identity DESC LIMIT 1',
      turnIdentity,
      latest.identity,
    )
    const previousEntropy =
      previousRow === undefined ? undefined : binaryEntropy(number(previousRow, 'probability', DefaultPrior))
    const decreased =
      previousEntropy !== undefined && entropy < previousEntropy - policy.progressTolerance
    const advanced = iteration > 1
    if (decreased && advanced) {
      return {
        ok: true,
        reason: `posterior entropy decreased to ${entropyValue} bits and turn iteration advanced to ${iteration} (validation ${policy.validation})`,
        entropy: entropyValue,
        score,
        iteration,
      }
    }
    if (decreased) {
      return {
        ok: true,
        reason: `posterior entropy decreased to ${entropyValue} bits (validation ${policy.validation})`,
        entropy: entropyValue,
        score,
        iteration,
      }
    }
    if (advanced) {
      return {
        ok: true,
        reason: `turn iteration advanced to ${iteration} (validation ${policy.validation})`,
        entropy: entropyValue,
        score,
        iteration,
      }
    }
    return {
      ok: false,
      reason:
        previousEntropy === undefined
          ? `only one posterior is recorded for turn ${turnIdentity}; entropy has not decreased (validation ${policy.validation})`
          : `posterior entropy did not decrease and turn iteration is still ${iteration} (validation ${policy.validation})`,
      entropy: entropyValue,
      score,
      iteration,
    }
  }

  /**
   * Calibrate one model/dimension from its `score` rows.
   *
   * Brier-like construction: each observed score is a predicted confidence in
   * [0, 1]; the realised outcome is 1 when the score clears 0.5 and 0
   * otherwise. `predicted` is the mean confidence, `actual` the observed
   * outcome rate, and `score` is `1 - mean((confidence - outcome)^2)` (higher
   * is better). With no rows the engine writes the honest neutral row
   * `(0.5, 0.5, 0.5)` and never fabricates samples; v23's calibration table
   * has no sample column, so the sample count only selects that fallback.
   *
   * `calibration` has no unique constraint, so the module performs the upsert
   * itself: one row per (model, dimension), updated in place.
   */
  calibrate(model: string, dimension: string): Calibration {
    const modelName = requireText(model, 'model')
    const dimensionName = requireText(dimension, 'dimension')
    return this.host.db.transaction(() => {
      const rows = this.host.db.all<{ value: number }>(
        'SELECT value FROM score WHERE model = ? AND dimension = ? ORDER BY identity ASC',
        modelName,
        dimensionName,
      )
      const samples = rows.map(row => clamp(Number.isFinite(row.value) ? row.value : DefaultPrior, 0, 1))
      let predicted = DefaultPrior
      let actual = DefaultPrior
      let score = DefaultPrior
      if (samples.length > 0) {
        const outcomes = samples.map(value => (value > 0.5 ? 1 : 0))
        predicted = mean(samples)
        actual = mean(outcomes)
        const brier = mean(samples.map((value, index) => (value - (outcomes[index] ?? 0)) ** 2))
        score = clamp(1 - brier, 0, 1)
      }
      const values = {
        predicted: round(predicted, 6),
        actual: round(actual, 6),
        score: round(score, 6),
      }
      const existing = this.host.db.get<{ identity: number }>(
        'SELECT identity FROM calibration WHERE model = ? AND dimension = ? ORDER BY identity DESC LIMIT 1',
        modelName,
        dimensionName,
      )
      if (existing !== undefined) {
        this.host.db.update('calibration', values, 'identity = ?', existing.identity)
        return mapCalibration(this.host.db.require<Row>('calibration', existing.identity, 'calibration'))
      }
      const identity = this.host.db.insert('calibration', {
        handle: this.host.handles.next('calibration'),
        model: modelName,
        dimension: dimensionName,
        ...values,
        created: this.host.clock.now(),
      })
      return mapCalibration(this.host.db.require<Row>('calibration', identity, 'calibration'))
    })
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  private requireTurn(turn: number): Row {
    return this.host.db.require<Row>('turn', turn, 'turn')
  }

  private requireEvidence(evidence: number): Row {
    return this.host.db.require<Row>('evidence', evidence, 'evidence')
  }

  private priorProbability(): number {
    const configured = this.host.config.bayesian.prior
    return clampProbability(Number.isFinite(configured) ? configured : DefaultPrior)
  }

  private maxRouteCount(): number {
    const configured = this.host.config.bayesian.maxRoutes
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : DefaultMaxRoutes
  }

  private latestPrior(turn: number, hypothesis: string): Prior | undefined {
    const row = this.host.db.get<Row>(
      'SELECT * FROM prior WHERE turn = ? AND hypothesis = ? ORDER BY identity DESC LIMIT 1',
      turn,
      hypothesis,
    )
    return row === undefined ? undefined : mapPrior(row)
  }

  private latestPosterior(turn: number, hypothesis: string): Posterior | undefined {
    const row = this.host.db.get<Row>(
      'SELECT * FROM posterior WHERE turn = ? AND hypothesis = ? ORDER BY identity DESC LIMIT 1',
      turn,
      hypothesis,
    )
    return row === undefined ? undefined : mapPosterior(row)
  }

  private latestLikelihood(evidence: number, hypothesis: string): Likelihood | undefined {
    const row = this.host.db.get<Row>(
      'SELECT * FROM likelihood WHERE evidence = ? AND hypothesis = ? ORDER BY identity DESC LIMIT 1',
      evidence,
      hypothesis,
    )
    return row === undefined ? undefined : mapLikelihood(row)
  }

  private recordLikelihood(evidence: number, hypothesis: string, probability: number, weight: number): Likelihood {
    const identity = this.host.db.insert('likelihood', {
      handle: this.host.handles.next('likelihood'),
      evidence,
      hypothesis,
      probability: storedProbability(probability),
      weight: storedWeight(weight),
      created: this.host.clock.now(),
    })
    return mapLikelihood(this.host.db.require<Row>('likelihood', identity, 'likelihood'))
  }

  private recordPosterior(turn: number, hypothesis: string, probability: number): Posterior {
    const identity = this.host.db.insert('posterior', {
      handle: this.host.handles.next('posterior'),
      turn,
      hypothesis,
      probability: storedProbability(probability),
      created: this.host.clock.now(),
    })
    return mapPosterior(this.host.db.require<Row>('posterior', identity, 'posterior'))
  }

  private recordStopping(turn: number, criterion: string, value: number, reached: boolean): Stopping {
    const identity = this.host.db.insert('stopping', {
      handle: this.host.handles.next('stopping'),
      turn,
      criterion,
      value: round(Number.isFinite(value) ? value : 0, 6),
      reached,
      created: this.host.clock.now(),
    })
    return mapStopping(this.host.db.require<Row>('stopping', identity, 'stopping'))
  }

  /** Reject a duplicate route name and enforce `config.bayesian.maxRoutes`. */
  private assertNewRoute(table: 'route' | 'failure_route', turn: number, name: string): void {
    const kind = table === 'route' ? 'route' : 'failure route'
    const existing =
      table === 'route'
        ? this.host.db.get<{ identity: number }>('SELECT identity FROM route WHERE turn = ? AND name = ? LIMIT 1', turn, name)
        : this.host.db.get<{ identity: number }>(
            'SELECT identity FROM failure_route WHERE turn = ? AND name = ? LIMIT 1',
            turn,
            name,
          )
    if (existing !== undefined) {
      throw new InvalidStateError(`${kind} "${name}" is already defined for turn ${turn}`, { turn, name })
    }
    const count = this.host.db.count(table, 'turn = ?', turn)
    const maximum = this.maxRouteCount()
    if (count >= maximum) {
      throw new InvalidStateError(`turn ${turn} already has ${count} ${kind} rows (maxRoutes = ${maximum})`, {
        turn,
        count,
        maxRoutes: maximum,
      })
    }
  }

  /**
   * Latest `answer` or `plan` score for the turn, or 0. The score entity is
   * polymorphic (`category` + `target`), so each category joins its own table.
   */
  private latestTurnScore(turn: number): number {
    const answer = this.host.db.get<{ identity: number; value: number }>(
      `SELECT s.identity AS identity, s.value AS value
       FROM score s JOIN answer a ON a.identity = s.target
       WHERE s.category = 'answer' AND a.turn = ?
       ORDER BY s.identity DESC LIMIT 1`,
      turn,
    )
    const plan = this.host.db.get<{ identity: number; value: number }>(
      `SELECT s.identity AS identity, s.value AS value
       FROM score s JOIN plan p ON p.identity = s.target
       WHERE s.category = 'plan' AND p.turn = ?
       ORDER BY s.identity DESC LIMIT 1`,
      turn,
    )
    let best: { identity: number; value: number } | undefined
    if (answer !== undefined && plan !== undefined) best = answer.identity >= plan.identity ? answer : plan
    else best = answer ?? plan
    if (best === undefined) return 0
    return Number.isFinite(best.value) ? round(best.value, 6) : 0
  }
}
