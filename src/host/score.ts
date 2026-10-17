/**
 * Generic dimension scores (v23 §11.16, §9.3).
 *
 * One `score` row is one measurement of one dimension of one target. The
 * category names what the target identity addresses — `plan` targets a plan,
 * `turn` a turn, `subtask` a subtask and so on — and the `score` table
 * deliberately carries no foreign key, so the category is the only thing that
 * makes `target` meaningful. Values are normalised to [0, 1] so any consumer
 * can compare a score with a configured threshold without knowing which module
 * wrote it.
 *
 * Write discipline
 * ----------------
 * `add` is the single write path for `score`: it validates the closed category
 * domain, the target identity, the dimension name and the value, then appends
 * exactly one row. Readings never mutate history — a re-score appends a new row
 * and `latest` returns the newest one — which keeps the plan-rebuild audit of
 * §9.4 truthful instead of overwriting a previous measurement.
 *
 * A missing score is a failed reading, not a pass: `average` returns 0 when
 * nothing has been measured, because every §9.3 threshold is a lower bound and
 * an empty set must never look like a satisfied one.
 */
import type { ModuleHost } from './module.js'
import { round } from './module.js'
import { mapScore } from './row.js'
import type { Row } from './row.js'
import type { Score } from '../shared/entity.js'
import type { ScoreCategory } from '../shared/enum.js'
import { InvalidArgumentError } from '../shared/error.js'

/**
 * The closed domain of v23 §11.16. `src/shared/enum.ts` owns the TypeScript
 * union; this runtime list lives next to the only module that must reject an
 * unknown category before it reaches the database.
 */
export const ScoreCategoryValues: readonly ScoreCategory[] = [
  'prompt',
  'command',
  'goal',
  'compact',
  'comprehension',
  'organization',
  'turn',
  'plan',
  'predict',
  'reality',
  'action',
  'answer',
  'question',
  'choice',
  'error',
  'route',
  'failure',
  'subtask',
]

/** Stored precision; keeps float noise out of the audit trail. */
const ValueDecimals = 6
/** Dimensions are column-sized labels, not prose. */
const MaxDimensionLength = 120
const MaxReasonLength = 500
const MaxModelLength = 200

/* ------------------------------------------------------------------------- *
 * Guards
 * ------------------------------------------------------------------------- */

function requireCategory(value: unknown): ScoreCategory {
  if (typeof value !== 'string' || !(ScoreCategoryValues as readonly string[]).includes(value)) {
    throw new InvalidArgumentError('category must be a known ScoreCategory', { category: value, allowed: ScoreCategoryValues })
  }
  return value as ScoreCategory
}

function requireIdentity(value: unknown, kind: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${kind} must be a positive integer identity`, { [kind]: value })
  }
  return value
}

function requireDimension(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError('dimension must be a non-empty string', { dimension: value })
  }
  const dimension = value.trim()
  if (dimension.length > MaxDimensionLength) {
    throw new InvalidArgumentError(`dimension must be at most ${MaxDimensionLength} characters`, {
      dimension,
      length: dimension.length,
    })
  }
  return dimension
}

/**
 * Values are rejected, never clamped: a caller that hands over 1.5 has a bug,
 * and silently turning it into 1 would hide that bug inside a threshold check.
 */
function requireValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidArgumentError('value must be a finite number', { value })
  }
  if (value < 0 || value > 1) {
    throw new InvalidArgumentError('value must be inside [0, 1]', { value })
  }
  return round(value, ValueDecimals)
}

function optionalText(value: unknown, kind: string, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(`${kind} must be a string when present`, { [kind]: value })
  }
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length > limit) {
    throw new InvalidArgumentError(`${kind} must be at most ${limit} characters`, { [kind]: text, length: text.length })
  }
  return text
}

/* ------------------------------------------------------------------------- *
 * Module
 * ------------------------------------------------------------------------- */

export class ScoreModule {
  private readonly host: ModuleHost

  constructor(host: ModuleHost) {
    this.host = host
  }

  /**
   * Append one measurement. `reason` and `model` are trimmed and stored only
   * when non-empty, so an omitted note is NULL rather than an empty string.
   */
  add(
    category: ScoreCategory,
    target: number,
    dimension: string,
    value: number,
    reason?: string,
    model?: string,
  ): Score {
    const categoryName = requireCategory(category)
    const targetIdentity = requireIdentity(target, 'target')
    const dimensionName = requireDimension(dimension)
    const stored = requireValue(value)
    const note = optionalText(reason, 'reason', MaxReasonLength)
    const modelName = optionalText(model, 'model', MaxModelLength)
    const identity = this.host.db.insert('score', {
      handle: this.host.handles.next('score'),
      category: categoryName,
      target: targetIdentity,
      dimension: dimensionName,
      value: stored,
      reason: note,
      model: modelName,
      created: this.host.clock.now(),
    })
    return mapScore(this.host.db.require<Row>('score', identity, 'score'))
  }

  /** Every measurement of one target, oldest first (the audit order). */
  list(category: ScoreCategory, target: number): Score[] {
    const categoryName = requireCategory(category)
    const targetIdentity = requireIdentity(target, 'target')
    return this.host.db
      .all<Row>(
        'SELECT * FROM score WHERE category = ? AND target = ? ORDER BY identity ASC',
        categoryName,
        targetIdentity,
      )
      .map(mapScore)
  }

  /**
   * Mean value of one target in [0, 1], rounded to six decimals. The empty set
   * averages to 0: an unmeasured target fails every §9.3 lower bound instead of
   * passing by accident.
   */
  average(category: ScoreCategory, target: number): number {
    const rows = this.list(category, target)
    if (rows.length === 0) return 0
    const total = rows.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0)
    return round(total / rows.length, ValueDecimals)
  }

  /** The newest measurement of one dimension, or undefined when unseen. */
  latest(category: ScoreCategory, target: number, dimension: string): Score | undefined {
    const categoryName = requireCategory(category)
    const targetIdentity = requireIdentity(target, 'target')
    const dimensionName = requireDimension(dimension)
    const row = this.host.db.get<Row>(
      `SELECT * FROM score
       WHERE category = ? AND target = ? AND dimension = ?
       ORDER BY identity DESC LIMIT 1`,
      categoryName,
      targetIdentity,
      dimensionName,
    )
    return row === undefined ? undefined : mapScore(row)
  }
}
