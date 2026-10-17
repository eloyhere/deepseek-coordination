/**
 * Prediction and execution records (v23 §9.7 ⑩, §11.17).
 *
 * A non-orchestration turn runs `Predict → Action → Reality → Answer`. This
 * module owns those four records plus the `question` / `choice` pair that a
 * clarification ballot is made of:
 *
 *  - `predict` appends one predicted outcome for one plan step. The turn comes
 *    from the plan row, so a prediction can never point at a turn the plan does
 *    not belong to.
 *  - `compare` is a pure read: a deterministic 0..1 agreement between one
 *    prediction and one reality row. Nothing is written.
 *  - `action` records one executed action: the turn's plan, the action name as
 *    `kind`, and the input/output pair as JSON `content`. The output is part of
 *    the signature, so the row is stored as `done`.
 *  - `reality` attaches an observation to the turn's most recent prediction
 *    (Predict → Action → Reality is the order of §9.7 ⑩, so a reality row
 *    without a prediction is refused).
 *  - `answer` appends the answer row and, when given, one `evidence` row for
 *    the evidence the answer rests on.
 *  - `question` / `choice` record a clarification ballot; the answer to the
 *    question is the *first* selected choice, never a later overwrite.
 *
 * Lifecycle: the DSH bridge owns the turn lifecycle. `answer` only advances an
 * `acting` turn to `answering`; it never writes `finished` and never marks a
 * turn `done`. Every other method leaves the turn row alone.
 *
 * Content shapes (all deterministic, so two identical inputs persist identical
 * rows):
 *
 *  - `predict.content`: one English sentence restating the step expectation.
 *  - `reality.content`: JSON `{"expected":"…","observed":"…"}`. `compare` reads
 *    both halves; a hand-written non-JSON row is compared as one observation.
 *  - `action.content`: JSON `{"input":"…","output":"…"}`. A newline inside an
 *    input would make a text format ambiguous, so the pair is stored as JSON.
 *  - `answer.validation`: the turn's validation level, the same value
 *    `orchestration.synthesize` records. The v23 answer table has no evidence
 *    column, so `answer.evidence` becomes one `evidence` row (`source`
 *    `answer`, `weight` 1) in the same transaction instead of being dropped.
 */
import type { ModuleHost } from './module.js'
import { clamp, round } from './module.js'
import type { Action, Answer, Choice, Plan, Predict, Question, Reality, Turn } from '../shared/entity.js'
import type { Validation } from '../shared/enum.js'
import { InvalidArgumentError, InvalidStateError } from '../shared/error.js'
import { mapPlan, mapTurn, bool, number, text } from './row.js'
import type { Row } from './row.js'

/* ------------------------------------------------------------------------- *
 * Deterministic text comparison
 * ------------------------------------------------------------------------- */

/** ASCII words and numbers; the unit of the text overlap. */
const AsciiTokenPattern = /[a-z0-9]+/g

/** CJK runs are hashed as overlapping bigrams, so no dictionary is needed. */
const CjkRunPattern = /[\u3400-\u9fff]+/g

const NumberPattern = /-?\d+(?:\.\d+)?/g

/**
 * Agreement in 0..1 between a forecast and an observation.
 *
 * Text overlap is the Jaccard index of the token sets (ASCII words plus CJK
 * bigrams), so identical text is exactly 1 and text with no shared token is
 * exactly 0. When both sides carry numbers, a numeric agreement factor scales
 * the result: every left number is matched to its closest right number, the
 * relative delta becomes a 0..1 similarity, and the mean similarity multiplies
 * the overlap. A text-only pair is therefore unaffected, while a pair that
 * names different numbers cannot score 1.
 */
export function compareAgreement(left: string, right: string): number {
  const leftTokens = tokensOf(left)
  const rightTokens = tokensOf(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    const same = left.trim().length > 0 && left.trim() === right.trim()
    return same ? 1 : 0
  }
  let shared = 0
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1
  const union = leftTokens.size + rightTokens.size - shared
  const overlap = union === 0 ? 0 : shared / union
  return round(clamp(overlap * numericAgreement(numbersOf(left), numbersOf(right)), 0, 1), 4)
}

function tokensOf(source: string): Set<string> {
  const tokens = new Set<string>()
  const lowered = source.toLowerCase()
  for (const token of lowered.match(AsciiTokenPattern) ?? []) tokens.add(token)
  for (const run of lowered.match(CjkRunPattern) ?? []) {
    if (run.length === 1) tokens.add(run)
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

function numbersOf(source: string): number[] {
  const found: number[] = []
  for (const match of source.match(NumberPattern) ?? []) {
    const value = Number.parseFloat(match)
    if (Number.isFinite(value)) found.push(value)
  }
  return found
}

function numericAgreement(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || right.length === 0) return 1
  let total = 0
  for (const value of left) {
    let best = 0
    for (const candidate of right) {
      const scale = Math.max(Math.abs(value), Math.abs(candidate), 1)
      const similarity = clamp(1 - Math.abs(value - candidate) / scale, 0, 1)
      if (similarity > best) best = similarity
    }
    total += best
  }
  return round(total / left.length, 4)
}

/** Read the `{ expected, observed }` pair a `reality` row stores. */
function readObservation(content: string): { expected: string; observed: string } | undefined {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const expected = record.expected
    const observed = record.observed
    if (typeof expected !== 'string' || typeof observed !== 'string') return undefined
    return { expected, observed }
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------------- *
 * Predict module
 * ------------------------------------------------------------------------- */

export class PredictModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /**
   * Append one predicted outcome for one plan step.
   *
   * The prediction is a deterministic restatement of the plan row and the step
   * label: same plan, same step, same text. `step` must be non-empty, because a
   * prediction without a step cannot be compared with a reality later.
   */
  predict(plan: number, step: string): Predict {
    const record = this.requirePlan(plan)
    const stepLabel = requireText(step, 'predict step').trim()
    const content = predictionText(record, stepLabel)
    const identity = this.host.db.insert('predict', {
      handle: this.host.handles.next('predict'),
      turn: record.turn,
      plan: record.identity,
      step: stepLabel,
      content,
      created: this.host.clock.now(),
    })
    this.host.events.emit('predict/created', {
      predict: identity,
      turn: record.turn,
      plan: record.identity,
      step: stepLabel,
    })
    return mapPredict(this.host.db.require<Row>('predict', identity, 'predict'))
  }

  /**
   * Agreement in 0..1 between one prediction and one reality row. Pure: no row
   * is written and no score is persisted.
   *
   * The reality row must observe exactly this prediction; mixing two rows up is
   * an argument error, not a low score. When the row carries the
   * `{ expected, observed }` pair, the score is
   * `0.5 * agreement(prediction, observed) + 0.5 * agreement(expected, observed)`:
   * both the stored forecast and the restated expectation are measured against
   * what actually happened, and a caller that restates the prediction exactly
   * gets the plain prediction/observation agreement.
   */
  compare(predict: number, reality: number): number {
    const prediction = this.requirePredict(predict)
    const observation = this.requireReality(reality)
    if (observation.predict !== prediction.identity) {
      throw new InvalidArgumentError(
        `reality ${observation.identity} observes predict ${observation.predict}, not predict ${prediction.identity}`,
        {
          predict: prediction.identity,
          reality: observation.identity,
          observes: observation.predict,
        },
      )
    }
    const pair = readObservation(observation.content)
    if (pair === undefined) {
      return round(clamp(compareAgreement(prediction.content, observation.content), 0, 1), 4)
    }
    const direct = compareAgreement(prediction.content, pair.observed)
    const restated = compareAgreement(pair.expected, pair.observed)
    return round(clamp((direct + restated) / 2, 0, 1), 4)
  }

  /**
   * Record one executed action against the turn's plan.
   *
   * The plan is `turn.plan` when the turn already points at one, otherwise the
   * turn's latest plan; a turn without a plan cannot act (`action.plan` is NOT
   * NULL). `kind` is the action name, `content` the JSON input/output pair, and
   * the row commits as `done` because the output is already known.
   */
  action(turn: number, name: string, input: string, output: string): Action {
    const current = this.requireTurn(turn)
    const kind = requireText(name, 'action name').trim()
    const inputText = requireString(input, 'action input')
    const outputText = requireString(output, 'action output')
    const plan = this.planOf(current)
    const created = this.host.clock.now()
    const identity = this.host.db.insert('action', {
      handle: this.host.handles.next('action'),
      turn: current.identity,
      plan,
      kind,
      content: jsonText({ input: inputText, output: outputText }),
      status: 'done',
      created,
      finished: created,
    })
    this.host.events.emit('predict/action', {
      action: identity,
      turn: current.identity,
      plan,
      kind,
      status: 'done',
    })
    return mapAction(this.host.db.require<Row>('action', identity, 'action'))
  }

  /**
   * Attach one observation to the turn's most recent prediction.
   *
   * The `reality` table requires a prediction, and §9.7 ⑩ observes only after a
   * prediction exists, so a turn without a prediction is refused instead of
   * writing an unpairable row. `expected` and `observed` are stored together as
   * JSON so `compare` can weigh both against the observation.
   */
  reality(turn: number, expected: string, observed: string): Reality {
    const current = this.requireTurn(turn)
    const expectedText = requireText(expected, 'reality expected')
    const observedText = requireText(observed, 'reality observed')
    const prediction = this.latestPrediction(current)
    const identity = this.host.db.insert('reality', {
      handle: this.host.handles.next('reality'),
      turn: current.identity,
      predict: prediction.identity,
      content: jsonText({ expected: expectedText, observed: observedText }),
      created: this.host.clock.now(),
    })
    this.host.events.emit('predict/reality', {
      reality: identity,
      turn: current.identity,
      predict: prediction.identity,
    })
    return mapReality(this.host.db.require<Row>('reality', identity, 'reality'))
  }

  /**
   * Append the answer of a turn.
   *
   * The answer inherits the turn's validation level. The optional evidence is
   * written as one `evidence` row (`source` `answer`, `weight` 1) in the same
   * transaction: the v23 answer table has no evidence column, and dropping the
   * evidence would lose the only record of what the answer rests on.
   *
   * An `acting` turn moves to `answering` because the answer is now being
   * written; every other status is left untouched (`answering` is already
   * right, and a `pending` / `planning` / terminal turn belongs to the bridge).
   * `finished` is never set here and the turn is never marked `done`.
   */
  answer(turn: number, content: string, evidence?: string): Answer {
    const current = this.requireTurn(turn)
    const answerContent = requireText(content, 'answer content')
    const evidenceContent =
      evidence === undefined ? undefined : requireText(evidence, 'answer evidence')
    const created = this.host.clock.now()
    const advancing = current.status === 'acting'

    const identity = this.host.db.transaction(() => {
      const inserted = this.host.db.insert('answer', {
        handle: this.host.handles.next('answer'),
        turn: current.identity,
        content: answerContent,
        validation: current.validation,
        created,
      })
      if (evidenceContent !== undefined) {
        this.host.db.insert('evidence', {
          handle: this.host.handles.next('evidence'),
          turn: current.identity,
          source: 'answer',
          content: evidenceContent,
          weight: 1,
          created,
        })
      }
      if (advancing) {
        this.host.db.update('turn', { status: 'answering' }, 'identity = ?', current.identity)
      }
      return inserted
    })
    this.host.events.emit('predict/answer', {
      answer: identity,
      turn: current.identity,
      evidence: evidenceContent !== undefined,
      status: advancing ? 'answering' : current.status,
    })
    return mapAnswer(this.host.db.require<Row>('answer', identity, 'answer'))
  }

  /**
   * Record one clarification question. The question starts unanswered; the
   * `answer` / `finished` columns are filled by the first selected choice.
   */
  question(turn: number, content: string): Question {
    const current = this.requireTurn(turn)
    const questionContent = requireText(content, 'question content')
    const identity = this.host.db.insert('question', {
      handle: this.host.handles.next('question'),
      turn: current.identity,
      content: questionContent,
      created: this.host.clock.now(),
    })
    this.host.events.emit('predict/question', { question: identity, turn: current.identity })
    return mapQuestion(this.host.db.require<Row>('question', identity, 'question'))
  }

  /**
   * Record one choice of a question.
   *
   * The ballot is append-only: every option keeps its own row with its
   * `selected` flag, and `question.answer` / `question.finished` are filled only
   * by the first selected choice, so a later selected option cannot rewrite the
   * answer the user already gave. Both rows commit together.
   */
  choice(question: number, label: string, selected: boolean): Choice {
    const record = this.requireQuestion(question)
    const option = requireText(label, 'choice label').trim()
    if (typeof selected !== 'boolean') {
      throw new InvalidArgumentError('choice selected must be a boolean', { selected })
    }
    const created = this.host.clock.now()
    const identity = this.host.db.transaction(() => {
      const inserted = this.host.db.insert('choice', {
        handle: this.host.handles.next('choice'),
        turn: record.turn,
        question: record.identity,
        option,
        selected,
        created,
      })
      if (selected && record.answer === undefined) {
        this.host.db.update(
          'question',
          { answer: option, finished: created },
          'identity = ?',
          record.identity,
        )
      }
      return inserted
    })
    this.host.events.emit('predict/choice', {
      choice: identity,
      question: record.identity,
      turn: record.turn,
      option,
      selected,
    })
    return mapChoice(this.host.db.require<Row>('choice', identity, 'choice'))
  }

  /** Every answer of one turn, oldest first. */
  listAnswer(turn: number): Answer[] {
    const current = this.requireTurn(turn)
    return this.host.db
      .all<Row>('SELECT * FROM answer WHERE turn = ? ORDER BY identity ASC', current.identity)
      .map(mapAnswer)
  }

  /** Every action of one turn, oldest first. */
  listAction(turn: number): Action[] {
    const current = this.requireTurn(turn)
    return this.host.db
      .all<Row>('SELECT * FROM action WHERE turn = ? ORDER BY identity ASC', current.identity)
      .map(mapAction)
  }

  /* ----------------------------------------------------------------------- *
   * Readers used by the transactional methods
   * ----------------------------------------------------------------------- */

  private requireTurn(identity: number): Turn {
    return mapTurn(this.host.db.require<Row>('turn', requireIdentity(identity, 'turn'), 'turn'))
  }

  private requirePlan(identity: number): Plan {
    return mapPlan(this.host.db.require<Row>('plan', requireIdentity(identity, 'plan'), 'plan'))
  }

  private requirePredict(identity: number): Predict {
    return mapPredict(
      this.host.db.require<Row>('predict', requireIdentity(identity, 'predict'), 'predict'),
    )
  }

  private requireReality(identity: number): Reality {
    return mapReality(
      this.host.db.require<Row>('reality', requireIdentity(identity, 'reality'), 'reality'),
    )
  }

  private requireQuestion(identity: number): Question {
    return mapQuestion(
      this.host.db.require<Row>('question', requireIdentity(identity, 'question'), 'question'),
    )
  }

  /** `turn.plan` first, otherwise the turn's latest plan row. */
  private planOf(turn: Turn): number {
    if (turn.plan !== undefined) {
      this.host.db.require<Row>('plan', turn.plan, 'plan')
      return turn.plan
    }
    const row = this.host.db.get<Row>(
      'SELECT * FROM plan WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turn.identity,
    )
    if (row === undefined) {
      throw new InvalidStateError(`turn ${turn.identity} has no plan; a plan is required before an action`, {
        turn: turn.identity,
      })
    }
    return number(row, 'identity')
  }

  private latestPrediction(turn: Turn): Predict {
    const row = this.host.db.get<Row>(
      'SELECT * FROM predict WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turn.identity,
    )
    if (row === undefined) {
      throw new InvalidStateError(
        `turn ${turn.identity} has no prediction to observe; predict must run before reality`,
        { turn: turn.identity },
      )
    }
    return mapPredict(row)
  }
}

/* ------------------------------------------------------------------------- *
 * Pure helpers
 * ------------------------------------------------------------------------- */

function requireIdentity(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${field} must be a positive integer identity`, { field, value })
  }
  return value
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(`${field} must be a non-empty string`, { field })
  }
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(`${field} must be a string`, { field })
  }
  return value
}

function collapse(content: string, limit = 160): string {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (compact.length <= limit) return compact
  return `${compact.slice(0, Math.max(1, limit - 1))}…`
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** One deterministic sentence: the plan row plus the step label. */
function predictionText(plan: Plan, step: string): string {
  const goal = collapse(plan.goal)
  const approach = collapse(plan.approach)
  const constraint = collapse(plan.constraint)
  return `expect step "${collapse(step)}" of plan "${goal}" to complete via ${approach}, within constraint "${constraint}", producing the step's expected deliverable`
}

/* ------------------------------------------------------------------------- *
 * Row mappers (§17.1 has no shared mapper for these six tables)
 * ------------------------------------------------------------------------- */

function mapPredict(row: Row): Predict {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    plan: number(row, 'plan'),
    step: text(row, 'step'),
    content: text(row, 'content'),
    created: number(row, 'created'),
  }
}

function mapReality(row: Row): Reality {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    predict: number(row, 'predict'),
    content: text(row, 'content'),
    created: number(row, 'created'),
  }
}

function mapAction(row: Row): Action {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    plan: number(row, 'plan'),
    kind: text(row, 'kind'),
    content: text(row, 'content'),
    status: text(row, 'status', 'pending') as Action['status'],
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

function mapAnswer(row: Row): Answer {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    content: text(row, 'content'),
    validation: text(row, 'validation', 'medium') as Validation,
    created: number(row, 'created'),
  }
}

function mapQuestion(row: Row): Question {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    content: text(row, 'content'),
    ...(row.answer === null || row.answer === undefined ? {} : { answer: text(row, 'answer') }),
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

function mapChoice(row: Row): Choice {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    question: number(row, 'question'),
    option: text(row, 'option'),
    selected: bool(row, 'selected'),
    created: number(row, 'created'),
  }
}
