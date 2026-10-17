/**
 * Cognitive orchestration (v23 §10.1, §10.2) plus the probe, mode-state and
 * session-history records of §11.17.
 *
 * The module owns exactly one question — *how* a pipeline stage runs for the
 * interaction and validation the user selected — and records the answer:
 *
 *  - `strategy(turn, stage)` is pure. It resolves a `CognitiveStrategy` from the
 *    turn's `interaction` and `validation` through the §10.2 table.
 *  - `stage(turn, stage)` resolves the same strategy, appends one `cognition`
 *    row that stores it as JSON, and mirrors it on `turn.cognitive` in the same
 *    transaction. The row is append-only: resolving a stage again writes a new
 *    row, so the audit trail keeps every decision instead of one mutable cell.
 *  - `probe`, `mode`, `history` and `recordHistory` persist the remaining
 *    §11.17 records; `probe` asks the deterministic clarification question that
 *    the normalised entropy implies, and `mode` upserts the mode state of the
 *    session's latest turn.
 *
 * The §10.2 table is transcribed cell by cell below (`StageMatrix`) so the code
 * can be diffed against the document. A cell that the table marks `—` resolves
 * to a *disabled* strategy (`think === false`, `heuristic === false`,
 * `order === 'parallel'`) rather than throwing: a caller may enumerate every
 * stage uniformly, and the persisted row then records that the stage was
 * deliberately not run.
 *
 * Two numbers are fixed by the document rather than by configuration:
 *
 *  - `maxIteration` is `DefaultMaxIteration` (1) for every stage except the
 *    answer stage under the heuristic or converge interaction, where the §10.2
 *    answer cell lets the answer revise — `AnswerMaxIteration` (3). This is not
 *    `config.plan.maxRebuild`: that setting counts plan rebuilds, and reusing it
 *    would tie the cognitive budget to an unrelated threshold.
 *  - `convergence` follows the validation level: `low` stops on `score`,
 *    `medium` on `entropy`, `high` on `evidence`. `entropyThreshold` carries
 *    `config.bayesian.stopEntropy` exactly when the convergence is `entropy`.
 *
 * Every generated cell value is machine readable English, not user copy: the
 * Chinese labels of the document live in `src/shared/enum.ts` only (§0).
 */
import type { ModuleHost } from './module.js'
import { clamp, round } from './module.js'
import type { Cognition, History, ModeState, Probe, Turn } from '../shared/entity.js'
import type { Interaction, Validation } from '../shared/enum.js'
import { toInteraction, toValidation } from '../shared/enum.js'
import { InvalidArgumentError, InvalidStateError } from '../shared/error.js'
import { mapTurn, number, text } from './row.js'
import type { Row } from './row.js'

/* ------------------------------------------------------------------------- *
 * Public types (v23 §10.1)
 * ------------------------------------------------------------------------- */

/** The ten cognitive stages of v23 §10.1, in document order. */
export type CognitiveStageName =
  | 'comprehension'
  | 'organization'
  | 'plan'
  | 'planscore'
  | 'planrebuild'
  | 'constraint'
  | 'predict'
  | 'reality'
  | 'answer'
  | 'orchestrate'

/**
 * The document's scalar name for a stage. `CognitiveStageName` is the same
 * union; it is the name used inside the persisted strategy so the stage can
 * never be confused with a comprehension `StageName`.
 */
export type CognitiveStage = CognitiveStageName

export const CognitiveStageValues: readonly CognitiveStageName[] = [
  'comprehension',
  'organization',
  'plan',
  'planscore',
  'planrebuild',
  'constraint',
  'predict',
  'reality',
  'answer',
  'orchestrate',
]

/** How the think and heuristic halves of a stage relate in time. */
export type CognitiveOrder = 'think-first' | 'heuristic-first' | 'parallel' | 'interleave'

export const CognitiveOrderValues: readonly CognitiveOrder[] = [
  'think-first',
  'heuristic-first',
  'parallel',
  'interleave',
]

/** The stopping rule that ends a stage's iteration. */
export type CognitiveConvergence = 'entropy' | 'infoGain' | 'score' | 'evidence' | 'timeout'

export const CognitiveConvergenceValues: readonly CognitiveConvergence[] = [
  'entropy',
  'infoGain',
  'score',
  'evidence',
  'timeout',
]

/** The resolved strategy of one stage for one turn (v23 §10.1). */
export interface CognitiveStrategy {
  stage: CognitiveStageName
  think: boolean
  heuristic: boolean
  order: CognitiveOrder
  maxIteration: number
  convergence: CognitiveConvergence
  entropyThreshold?: number
}

/**
 * A stage request with optional audit overrides. `stage(turn, stage)` always
 * uses the matrix; the overrides exist for a caller that has already decided to
 * skip one half of a stage (for example a replay that reuses the stored think
 * output) and still wants the decision recorded.
 */
export interface CognitiveStageInput {
  turn: number
  stage: CognitiveStage
  think?: boolean
  heuristic?: boolean
}

/* ------------------------------------------------------------------------- *
 * The §10.2 matrix
 * ------------------------------------------------------------------------- */

/**
 * One cell of the §10.2 table, named after the wording of the cell. The table
 * is the authority for `think` / `heuristic`; the names below make a wrong entry
 * visible at a glance.
 *
 *  - `four-stage`                四阶段
 *  - `four-stage-bayes`          四阶段 + 贝叶斯
 *  - `standard`                  标准
 *  - `standard-subtask`          标准 + SubTask 拆解
 *  - `required`                  必须
 *  - `on-demand`                 按需
 *  - `dispatch-verify-synthesize` 派发 → 验收 → 恢复 → 综合
 *  - `not-applicable`            —
 *  - `answer-think`              think
 *  - `answer-heuristic`          heuristic
 *  - `answer-think-bayes`        think + Bayesian
 *  - `answer-synthesis`          综合子任务产出
 */
type StageCell =
  | 'four-stage'
  | 'four-stage-bayes'
  | 'standard'
  | 'standard-subtask'
  | 'required'
  | 'on-demand'
  | 'dispatch-verify-synthesize'
  | 'not-applicable'
  | 'answer-think'
  | 'answer-heuristic'
  | 'answer-think-bayes'
  | 'answer-synthesis'

interface StageFlags {
  think: boolean
  heuristic: boolean
}

/** One cell repeated for every interaction column. */
function everyInteraction(cell: StageCell): Readonly<Record<Interaction, StageCell>> {
  return { emotion: cell, think: cell, heuristic: cell, converge: cell, orchestrate: cell }
}

/** v23 §10.2, one column per interaction, one row per stage. */
const StageMatrix: Readonly<Record<CognitiveStageName, Readonly<Record<Interaction, StageCell>>>> = {
  // 四阶段 everywhere; the Bayesian columns add 贝叶斯 on top of the chain.
  comprehension: {
    emotion: 'four-stage',
    think: 'four-stage',
    heuristic: 'four-stage-bayes',
    converge: 'four-stage-bayes',
    orchestrate: 'four-stage',
  },
  // 标准 everywhere; 统筹 adds SubTask 拆解.
  organization: {
    emotion: 'standard',
    think: 'standard',
    heuristic: 'standard',
    converge: 'standard',
    orchestrate: 'standard-subtask',
  },
  plan: everyInteraction('required'),
  planscore: everyInteraction('required'),
  planrebuild: everyInteraction('on-demand'),
  // §10.2 has no `constraint` row. The stage belongs to the constraint and
  // boundary work the Bayesian stages produce, so it follows 按需: think always,
  // the heuristic only when the interaction selects the Bayesian engine.
  constraint: everyInteraction('on-demand'),
  predict: everyInteraction('not-applicable'),
  reality: everyInteraction('not-applicable'),
  answer: {
    emotion: 'not-applicable',
    think: 'answer-think',
    heuristic: 'answer-heuristic',
    converge: 'answer-think-bayes',
    orchestrate: 'answer-synthesis',
  },
  orchestrate: {
    emotion: 'not-applicable',
    think: 'not-applicable',
    heuristic: 'not-applicable',
    converge: 'not-applicable',
    orchestrate: 'dispatch-verify-synthesize',
  },
}

/** §10.2 iterations: 1 by default, 3 for the revising answer cells. */
const DefaultMaxIteration = 1
const AnswerMaxIteration = 3

/* ------------------------------------------------------------------------- *
 * Cognition module
 * ------------------------------------------------------------------------- */

export class CognitionModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /**
   * Resolve the strategy of one stage and append a `cognition` row.
   *
   * The strategy is stored twice on purpose: `strategy` holds the canonical
   * `CognitiveStrategy` JSON, `content` holds the same decision as one
   * machine-readable line (`stage=… interaction=… think=…`), and
   * `turn.cognitive` mirrors the JSON so a turn reader does not need to join the
   * cognition table. All three writes commit together.
   */
  stage(turn: number, stage: CognitiveStage): Cognition
  stage(input: CognitiveStageInput): Cognition
  stage(turnOrInput: number | CognitiveStageInput, stage?: CognitiveStage): Cognition {
    const input: CognitiveStageInput =
      typeof turnOrInput === 'number'
        ? { turn: turnOrInput, stage: stage as CognitiveStage }
        : (turnOrInput as CognitiveStageInput)
    if (typeof input !== 'object' || input === null) {
      throw new InvalidArgumentError('cognition stage requires a turn identity or a CognitiveStageInput object')
    }
    const current = this.requireTurn(input.turn)
    const stageName = assertCognitiveStage(input.stage)
    const overrides: { think?: boolean; heuristic?: boolean } = {}
    if (input.think !== undefined) overrides.think = requireBoolean(input.think, 'think')
    if (input.heuristic !== undefined) overrides.heuristic = requireBoolean(input.heuristic, 'heuristic')
    const strategy = this.resolveStrategy(current, stageName, overrides)
    const stored = JSON.stringify(strategy)
    const content = strategySummary(stageName, strategy, current)
    const created = this.host.clock.now()

    const identity = this.host.db.transaction(() => {
      const inserted = this.host.db.insert('cognition', {
        handle: this.host.handles.next('cognition'),
        turn: current.identity,
        stage: stageName,
        strategy: stored,
        content,
        created,
      })
      this.host.db.update('turn', { cognitive: stored }, 'identity = ?', current.identity)
      return inserted
    })
    this.host.events.emit('cognition/stage', {
      turn: current.identity,
      stage: stageName,
      think: strategy.think,
      heuristic: strategy.heuristic,
      order: strategy.order,
      maxIteration: strategy.maxIteration,
      convergence: strategy.convergence,
    })
    return mapCognition(this.host.db.require<Row>('cognition', identity, 'cognition'))
  }

  /**
   * The strategy of one stage without writing anything. The turn supplies the
   * interaction and validation; the §10.2 table supplies think/heuristic.
   */
  strategy(turn: number, stage: CognitiveStage): CognitiveStrategy {
    return this.resolveStrategy(this.requireTurn(turn), assertCognitiveStage(stage))
  }

  /**
   * Record one probe: the normalised entropy of the current distribution and
   * the deterministic question that entropy implies.
   *
   * The entropy is the contract — it is clamped to 0..1 and rounded to four
   * decimals before the row is written, so two callers that measured the same
   * distribution persist the same number. Above `config.bayesian.stopEntropy`
   * the probe asks for the fact that would reduce the uncertainty; at or below
   * it the probe records that no follow-up is needed.
   */
  probe(turn: number, entropy: number): Probe {
    const current = this.requireTurn(turn)
    const value = normaliseEntropy(entropy)
    const threshold = this.host.config.bayesian.stopEntropy
    const question = probeQuestion(value, threshold)
    const identity = this.host.db.insert('probe', {
      handle: this.host.handles.next('probe'),
      turn: current.identity,
      entropy: value,
      question,
      created: this.host.clock.now(),
    })
    this.host.events.emit('cognition/probe', { turn: current.identity, entropy: value })
    return mapProbe(this.host.db.require<Row>('probe', identity, 'probe'))
  }

  /**
   * The mode state of a session: the latest `mode_state` row of the session's
   * latest turn, or a new row when that turn has none yet.
   *
   * The mode state is derived only from stable turn dimensions
   * (`interaction` → `mode`; scene, validation, effort and iteration go into
   * `content`), so a row never goes stale when the turn status advances. A new
   * turn therefore gets its own row on first read while the old row stays as
   * history.
   */
  mode(session: number): ModeState {
    const identity = requireIdentity(session, 'session')
    this.host.db.require<Row>('session', identity, 'session')
    const turnRow = this.host.db.get<Row>(
      'SELECT * FROM turn WHERE session = ? ORDER BY ordinal DESC, identity DESC LIMIT 1',
      identity,
    )
    if (turnRow === undefined) {
      throw new InvalidStateError(`session ${identity} has no turn to derive a mode state from`, {
        session: identity,
      })
    }
    const current = mapTurn(turnRow)
    const existing = this.host.db.get<Row>(
      'SELECT * FROM mode_state WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      current.identity,
    )
    if (existing !== undefined) return mapModeState(existing)

    const content = JSON.stringify({
      session: identity,
      turn: current.identity,
      interaction: current.interaction,
      scene: current.scene,
      validation: current.validation,
      effort: current.effort,
      iteration: current.iteration,
    })
    const created = this.host.clock.now()
    const modeIdentity = this.host.db.insert('mode_state', {
      handle: this.host.handles.next('mode'),
      turn: current.identity,
      mode: current.interaction,
      content,
      created,
    })
    this.host.events.emit('cognition/mode', {
      session: identity,
      turn: current.identity,
      mode: current.interaction,
    })
    return mapModeState(this.host.db.require<Row>('mode_state', modeIdentity, 'mode state'))
  }

  /** Every history row of one session, oldest first. */
  history(session: number): History[] {
    const identity = requireIdentity(session, 'session')
    this.host.db.require<Row>('session', identity, 'session')
    return this.host.db
      .all<Row>('SELECT * FROM history WHERE session = ? ORDER BY identity ASC', identity)
      .map(mapHistory)
  }

  /**
   * Append one session-history entry. The `event` becomes the `kind` column and
   * the `detail` the `content` column; both must be non-empty, because a history
   * entry without a name or without a detail cannot be audited.
   */
  recordHistory(session: number, event: string, detail: string): History {
    const identity = requireIdentity(session, 'session')
    this.host.db.require<Row>('session', identity, 'session')
    const kind = requireText(event, 'history event')
    const content = requireText(detail, 'history detail')
    const created = this.host.clock.now()
    const historyIdentity = this.host.db.insert('history', {
      handle: this.host.handles.next('history'),
      session: identity,
      kind,
      content,
      created,
    })
    this.host.events.emit('cognition/history', { session: identity, kind })
    return mapHistory(this.host.db.require<Row>('history', historyIdentity, 'history'))
  }

  /* ----------------------------------------------------------------------- *
   * Resolution
   * ----------------------------------------------------------------------- */

  private resolveStrategy(
    turn: Turn,
    stage: CognitiveStageName,
    overrides: { think?: boolean; heuristic?: boolean } = {},
  ): CognitiveStrategy {
    const interaction = toInteraction(turn.interaction)
    const validation = toValidation(turn.validation)
    const cell = StageMatrix[stage][interaction]
    const flags = flagsOf(cell, interaction)
    const think = overrides.think ?? flags.think
    const heuristic = overrides.heuristic ?? flags.heuristic
    const convergence = convergenceOf(validation)
    return {
      stage,
      think,
      heuristic,
      order: orderOf(cell, interaction, think, heuristic),
      maxIteration: iterationOf(cell, think, heuristic),
      convergence,
      ...(convergence === 'entropy' ? { entropyThreshold: this.host.config.bayesian.stopEntropy } : {}),
    }
  }

  private requireTurn(identity: number): Turn {
    return mapTurn(this.host.db.require<Row>('turn', requireIdentity(identity, 'turn'), 'turn'))
  }
}

/* ------------------------------------------------------------------------- *
 * §10.2 cell interpretation
 * ------------------------------------------------------------------------- */

/** `think` / `heuristic` for one cell. `on-demand` also needs the interaction. */
function flagsOf(cell: StageCell, interaction: Interaction): StageFlags {
  switch (cell) {
    case 'on-demand':
      return { think: true, heuristic: interaction === 'heuristic' || interaction === 'converge' }
    case 'four-stage':
    case 'four-stage-bayes':
    case 'dispatch-verify-synthesize':
    case 'answer-think-bayes':
      return { think: true, heuristic: true }
    case 'not-applicable':
      return { think: false, heuristic: false }
    case 'answer-heuristic':
      return { think: false, heuristic: true }
    case 'standard':
    case 'standard-subtask':
    case 'required':
    case 'answer-think':
    case 'answer-synthesis':
      return { think: true, heuristic: false }
  }
}

/**
 * The relationship between the two halves. A single enabled half fixes its own
 * order; when both run, the cell decides — the fixed four-stage chain runs think
 * first, the Bayesian columns interleave, a dispatched orchestration stage runs
 * its subtasks in parallel and a heuristic-first stage ranks routes first.
 */
function orderOf(
  cell: StageCell,
  interaction: Interaction,
  think: boolean,
  heuristic: boolean,
): CognitiveOrder {
  if (!think && !heuristic) return 'parallel'
  if (think && !heuristic) return 'think-first'
  if (!think && heuristic) return 'heuristic-first'
  switch (cell) {
    case 'four-stage-bayes':
      return 'interleave'
    case 'dispatch-verify-synthesize':
      return 'parallel'
    case 'on-demand':
      return interaction === 'heuristic' ? 'heuristic-first' : 'interleave'
    default:
      return 'think-first'
  }
}

/** The iteration budget of one cell; disabled stages never iterate. */
function iterationOf(cell: StageCell, think: boolean, heuristic: boolean): number {
  if (!think && !heuristic) return DefaultMaxIteration
  return cell === 'answer-heuristic' || cell === 'answer-think-bayes'
    ? AnswerMaxIteration
    : DefaultMaxIteration
}

/** `convergence` follows the validation level (v23 §6.3, §14). */
function convergenceOf(validation: Validation): CognitiveConvergence {
  if (validation === 'low') return 'score'
  if (validation === 'high') return 'evidence'
  return 'entropy'
}

/* ------------------------------------------------------------------------- *
 * Pure helpers
 * ------------------------------------------------------------------------- */

/** Validate a stage name, refusing anything outside the §10.1 union. */
export function assertCognitiveStage(value: unknown): CognitiveStageName {
  if (typeof value !== 'string' || !(CognitiveStageValues as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`unknown cognitive stage: ${String(value)}`, {
      allowed: CognitiveStageValues,
    })
  }
  return value as CognitiveStageName
}

export function isCognitiveStage(value: unknown): value is CognitiveStageName {
  return typeof value === 'string' && (CognitiveStageValues as readonly string[]).includes(value)
}

function requireIdentity(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${field} must be a positive integer identity`, { field, value })
  }
  return value
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new InvalidArgumentError(`cognitive stage ${field} override must be a boolean`, { field, value })
  }
  return value
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(`${field} must be a non-empty string`, { field })
  }
  return value
}

function normaliseEntropy(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidArgumentError('probe entropy must be a finite number', { entropy: value })
  }
  return round(clamp(value, 0, 1), 4)
}

/**
 * The probe question is a deterministic function of the entropy and the stop
 * threshold: same numbers, same row. It names the one fact that would move the
 * distribution instead of asking a vague "please clarify".
 */
function probeQuestion(entropy: number, threshold: number): string {
  const measured = String(entropy)
  const limit = String(threshold)
  return entropy > threshold
    ? `entropy ${measured} is above the stop threshold ${limit}: name the single fact that would most reduce the uncertainty of this turn`
    : `entropy ${measured} is within the stop threshold ${limit}: no further probe is required; continue on the highest-probability route`
}

/** One machine-readable line describing the resolved strategy. */
function strategySummary(stage: CognitiveStageName, strategy: CognitiveStrategy, turn: Turn): string {
  const parts = [
    `stage=${stage}`,
    `interaction=${turn.interaction}`,
    `validation=${turn.validation}`,
    `think=${strategy.think}`,
    `heuristic=${strategy.heuristic}`,
    `order=${strategy.order}`,
    `maxIteration=${strategy.maxIteration}`,
    `convergence=${strategy.convergence}`,
  ]
  if (strategy.entropyThreshold !== undefined) parts.push(`entropyThreshold=${strategy.entropyThreshold}`)
  return parts.join(' ')
}

/* ------------------------------------------------------------------------- *
 * Row mappers (§17.1 has no shared mapper for these three tables)
 * ------------------------------------------------------------------------- */

function mapCognition(row: Row): Cognition {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    stage: text(row, 'stage'),
    strategy: text(row, 'strategy'),
    content: text(row, 'content'),
    created: number(row, 'created'),
  }
}

function mapProbe(row: Row): Probe {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    entropy: number(row, 'entropy'),
    question: text(row, 'question'),
    created: number(row, 'created'),
  }
}

function mapModeState(row: Row): ModeState {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    mode: text(row, 'mode'),
    content: text(row, 'content'),
    created: number(row, 'created'),
  }
}

function mapHistory(row: Row): History {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    session: number(row, 'session'),
    kind: text(row, 'kind'),
    content: text(row, 'content'),
    created: number(row, 'created'),
  }
}
