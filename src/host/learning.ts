/**
 * Error learning (v23 §11.17: Error / Pattern / Calibration / Lesson /
 * Rollback).
 *
 * The module turns one recorded `error` row into three useful things: a stable
 * classification, a deterministic remedy, and — once it repeats — a pattern
 * with a lesson attached. Everything is synchronous and local; no optional
 * `ModuleHost` port is required.
 *
 * Classification table
 * --------------------
 * Classification is a pure function of the stored message. The first rule with
 * a hit wins; ASCII signals are matched on word boundaries, CJK signals are
 * matched literally. Root-cause rules outrank the generic `tool` bucket, so
 * "tool failed: permission denied" is a permission failure.
 *
 * | # | category     | stable signals                                                        |
 * |---|--------------|-----------------------------------------------------------------------|
 * | 1 | `permission` | permission, eacces, eperm, access denied, denied, forbidden,           |
 * |   |              | unauthorized, not allowed, sandbox, read-only, 403, 权限, 无权,        |
 * |   |              | 拒绝访问, 不允许                                                        |
 * | 2 | `timeout`    | timeout, timed out, etimedout, deadline exceeded, abort, aborted,      |
 * |   |              | time out, 超时                                                         |
 * | 3 | `schema`     | schema, schemastery, zod, validation, unexpected token, json, parse,   |
 * |   |              | invalid json, invalid input, malformed, typeerror, 类型, 校验, 格式    |
 * | 4 | `provider`   | provider, api, api key, rate limit, too many requests, overloaded,     |
 * |   |              | upstream, econnrefused, econnreset, enotfound, network, 429, 5xx,      |
 * |   |              | model, llm, completion, 连接失败, 服务不可用, 模型                     |
 * | 5 | `tool`       | tool, command failed, command not found, not recognized, exit code,    |
 * |   |              | enoent, no such file, spawn, shell, bash, npm err, build failed,       |
 * |   |              | test failed, 工具, 命令, 构建失败, 编译失败                            |
 * | 6 | `unknown`    | no rule matched                                                        |
 *
 * Resolution order for one stored row is: message keywords, then the category
 * the row already carries when it names a real failure class (a caller that
 * recorded `schema` is not downgraded), then a learned pattern whose signature
 * is contained in the message signature, finally `unknown`. Only the `category`
 * column is ever rewritten — `message`, `stack` and `created` are history and
 * stay untouched, and patterns, lessons and rollbacks are only ever appended.
 *
 * Remedy table
 * ------------
 * | category     | remedy     | why                                                    |
 * |--------------|------------|--------------------------------------------------------|
 * | `permission` | `escalate` | only a human can widen the sandbox or approval scope   |
 * | `timeout`    | `retry`    | the budget, not the work, failed                       |
 * | `schema`     | `revise`   | the data/argument contract is wrong                    |
 * | `provider`   | `retry`    | the failure is upstream and usually transient          |
 * | `tool`       | `revise`   | re-running the same malformed call repeats the failure |
 * | `unknown`    | `learn`    | no stable signature yet; record it and re-classify     |
 *
 * `rollback` is never inferred: undoing a change is a decision a caller takes
 * explicitly through `rollback(error, target)`, which persists the record.
 */
import type { ModuleHost } from './module.js'
import { BayesianModule } from './bayesian.js'
import type { Calibration, ErrorRecord, Pattern, Rollback } from '../shared/entity.js'
import type { ErrorRemedy } from '../shared/service.js'
import { InvalidArgumentError, NotFoundError } from '../shared/error.js'
import { number, text } from './row.js'
import type { Row } from './row.js'

/* ------------------------------------------------------------------------- *
 * Categories
 * ------------------------------------------------------------------------- */

export type ErrorCategory = 'tool' | 'timeout' | 'permission' | 'provider' | 'schema' | 'unknown'

export const ErrorCategoryValues: readonly ErrorCategory[] = [
  'tool',
  'timeout',
  'permission',
  'provider',
  'schema',
  'unknown',
]

interface CategoryRule {
  category: ErrorCategory
  markers: readonly string[]
}

/** Ordered by precedence; see the table in the module header. */
const ClassificationRules: readonly CategoryRule[] = [
  {
    category: 'permission',
    markers: [
      'permission',
      'permissions',
      'eacces',
      'eperm',
      'access denied',
      'denied',
      'forbidden',
      'unauthorized',
      'not authorized',
      'not allowed',
      'sandbox',
      'read-only',
      'readonly',
      '403',
      '权限',
      '无权',
      '拒绝访问',
      '不允许',
      '禁止访问',
    ],
  },
  {
    category: 'timeout',
    markers: [
      'timeout',
      'timed out',
      'etimedout',
      'deadline exceeded',
      'time out',
      'abort',
      'aborted',
      'aborterror',
      '超时',
    ],
  },
  {
    category: 'schema',
    markers: [
      'schema',
      'schemastery',
      'zod',
      'validation',
      'validation failed',
      'unexpected token',
      'json',
      'parse',
      'parse error',
      'invalid json',
      'invalid input',
      'invalid argument',
      'invalid shape',
      'malformed',
      'typeerror',
      'type error',
      '类型',
      '校验',
      '格式',
    ],
  },
  {
    category: 'provider',
    markers: [
      'provider',
      'api',
      'api key',
      'rate limit',
      'too many requests',
      'overloaded',
      'upstream',
      'econnrefused',
      'econnreset',
      'enotfound',
      'network',
      'socket',
      '429',
      '500',
      '502',
      '503',
      '504',
      'model',
      'llm',
      'completion',
      '连接失败',
      '服务不可用',
      '模型',
    ],
  },
  {
    category: 'tool',
    markers: [
      'tool',
      'tools',
      'command failed',
      'command not found',
      'not recognized',
      'exit code',
      'enoent',
      'no such file',
      'spawn',
      'shell',
      'bash',
      'npm err',
      'build failed',
      'test failed',
      '工具',
      '命令',
      '构建失败',
      '编译失败',
    ],
  },
]

/** Classification to remedy; `rollback` is decided by the caller, never here. */
const RemedyByCategory: Readonly<Record<ErrorCategory, ErrorRemedy>> = {
  tool: {
    action: 'revise',
    reason: 'the tool call itself is malformed; correct the invocation before running it again',
  },
  timeout: {
    action: 'retry',
    reason: 'the operation ran out of time; retry with a larger or staged budget',
  },
  permission: {
    action: 'escalate',
    reason: 'the sandbox or approval scope denies the action; a human grant is required',
  },
  provider: {
    action: 'retry',
    reason: 'the upstream provider or transport failed; retry after backoff',
  },
  schema: {
    action: 'revise',
    reason: 'the data or argument contract is wrong; fix the shape before retrying',
  },
  unknown: {
    action: 'learn',
    reason: 'no stable signature is known yet; record the failure and re-classify it',
  },
}

/** Pattern weight added per repeated sighting of the same signature. */
const ConfidenceKnown = 1
const ConfidenceUnknown = 0.5
const MaxSignatureLength = 160
const MaxTextLength = 200

/* ------------------------------------------------------------------------- *
 * Guards and pure helpers
 * ------------------------------------------------------------------------- */

export function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === 'string' && (ErrorCategoryValues as readonly string[]).includes(value)
}

function escapeRegExp(content: string): string {
  return content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** ASCII markers use word boundaries; CJK markers are literal. */
function markerRegex(marker: string): RegExp {
  const escaped = escapeRegExp(marker)
  const ascii = /^[\x20-\x7e]+$/.test(marker)
  return ascii ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i') : new RegExp(escaped, 'i')
}

function hasMarker(content: string, markers: readonly string[]): boolean {
  return markers.some(marker => marker.length > 0 && markerRegex(marker).test(content))
}

/** Collapse whitespace and cap a string, without ever returning an empty one. */
function truncate(content: string, limit: number): string {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (compact.length <= limit) return compact
  return `${compact.slice(0, Math.max(1, limit - 1))}…`
}

/**
 * Classify a raw message with the table above, without touching the database.
 * A message that matches no rule is `unknown`; the classifier never guesses
 * from prose, stack traces or numbers alone.
 */
export function classifyMessage(message: string): ErrorCategory {
  if (typeof message !== 'string') {
    throw new InvalidArgumentError('message must be a string', { message })
  }
  const content = message.toLowerCase()
  if (content.trim().length === 0) return 'unknown'
  for (const rule of ClassificationRules) {
    if (hasMarker(content, rule.markers)) return rule.category
  }
  return 'unknown'
}

/**
 * Stable signature of one failure message: lower case, paths and identifiers
 * replaced by placeholders, whitespace collapsed and capped. Two occurrences of
 * the same failure share a signature even when their ids or timings differ,
 * which is what makes `pattern` deduplication meaningful.
 */
export function errorSignature(message: string): string {
  if (typeof message !== 'string') {
    throw new InvalidArgumentError('message must be a string', { message })
  }
  const normalized = message
    .toLowerCase()
    .replace(/[a-z]:\\[^\s"'<>|]+/g, '<path>')
    .replace(/(?:\/[\w.@-]+){2,}/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\b0x[0-9a-f]+\b/g, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<id>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?，。；：！？]+$/, '')
  return normalized.length <= MaxSignatureLength
    ? normalized
    : `${normalized.slice(0, MaxSignatureLength - 3)}...`
}

function requireIdentity(value: unknown, kind: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${kind} must be a positive integer identity`, { [kind]: value })
  }
  return value
}

function requireText(value: unknown, kind: string, limit = MaxTextLength): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(`${kind} must be a string`, { [kind]: value })
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new InvalidArgumentError(`${kind} must not be empty`, { [kind]: value })
  }
  if (trimmed.length > limit) {
    throw new InvalidArgumentError(`${kind} must be at most ${limit} characters`, {
      [kind]: trimmed,
      length: trimmed.length,
    })
  }
  return trimmed
}

/* ------------------------------------------------------------------------- *
 * Row mappers (row.ts covers the v23 shared entities only)
 * ------------------------------------------------------------------------- */

function mapError(row: Row): ErrorRecord {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    category: text(row, 'category', 'unknown'),
    message: text(row, 'message'),
    ...(row.stack === null || row.stack === undefined ? {} : { stack: text(row, 'stack') }),
    created: number(row, 'created'),
  }
}

function mapPattern(row: Row): Pattern {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    kind: text(row, 'kind'),
    signature: text(row, 'signature'),
    content: text(row, 'content'),
    weight: number(row, 'weight'),
    created: number(row, 'created'),
  }
}

function mapRollback(row: Row): Rollback {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    error: number(row, 'error'),
    target: text(row, 'target'),
    reason: text(row, 'reason'),
    created: number(row, 'created'),
  }
}

/* ------------------------------------------------------------------------- *
 * Module
 * ------------------------------------------------------------------------- */

export class LearningModule {
  private readonly host: ModuleHost
  /** Calibration owns no second upsert path: `BayesianModule` writes the row. */
  private readonly bayesian: BayesianModule

  constructor(host: ModuleHost) {
    this.host = host
    this.bayesian = new BayesianModule(host)
  }

  /**
   * Resolve the category of one stored error and persist it when it changed.
   * The update touches the `category` column only; message, stack and creation
   * time are history and are never rewritten.
   */
  classify(error: number): ErrorRecord {
    const record = this.error(error)
    const category = this.resolvedCategory(record)
    if (category !== record.category) {
      this.host.db.update('error', { category }, 'identity = ?', record.identity)
    }
    return this.error(record.identity)
  }

  /**
   * The remedy for one stored error. Classification is recomputed on the fly
   * and is deliberately not persisted: a decision is a read, `classify` is the
   * only writer of the category column.
   */
  decide(error: number): ErrorRemedy {
    const record = this.error(error)
    return { ...RemedyByCategory[this.resolvedCategory(record)] }
  }

  /**
   * Learn from one stored error: classify it, then ensure exactly one pattern
   * per (kind, signature) and append one lesson for this occurrence.
   *
   * Nothing historical is rewritten. A repeat sighting of the same signature
   * reuses the pattern and only appends another lesson, so the lesson count is
   * the observation count and every pattern/lesson row stays immutable.
   * `pattern.weight` records how well the signature was understood when it was
   * learned — 1 for a stable keyword classification, 0.5 for a provisional
   * `unknown` — and is written once, at insert.
   */
  learn(error: number): void {
    const classified = this.classify(error)
    const category = isErrorCategory(classified.category) ? classified.category : 'unknown'
    const signature = errorSignature(classified.message)
    const remedy = RemedyByCategory[category]
    const now = this.host.clock.now()
    this.host.db.transaction(() => {
      const existing = this.host.db.get<Row>(
        'SELECT * FROM pattern WHERE kind = ? AND signature = ? ORDER BY identity DESC LIMIT 1',
        category,
        signature,
      )
      const patternIdentity =
        existing === undefined
          ? this.host.db.insert('pattern', {
              handle: this.host.handles.next('pattern'),
              kind: category,
              signature,
              content: `${category} failure: ${truncate(classified.message, MaxTextLength)}`,
              weight: category === 'unknown' ? ConfidenceUnknown : ConfidenceKnown,
              created: now,
            })
          : number(existing, 'identity')
      this.host.db.insert('lesson', {
        handle: this.host.handles.next('lesson'),
        pattern: patternIdentity,
        content: `${category}: ${remedy.action}; ${remedy.reason}`,
        created: now,
      })
    })
  }

  /** The newest learned pattern with this exact signature. */
  pattern(signature: string): Pattern | undefined {
    const key = requireText(signature, 'signature', MaxSignatureLength)
    const row = this.host.db.get<Row>(
      'SELECT * FROM pattern WHERE signature = ? ORDER BY identity DESC LIMIT 1',
      key,
    )
    return row === undefined ? undefined : mapPattern(row)
  }

  /**
   * Calibrate one (model, dimension) pair from its `score` rows.
   *
   * Delegated to `BayesianModule.calibrate` so the `calibration` table has a
   * single upsert path: with no samples the honest neutral row `(0.5, 0.5, 0.5)`
   * is written and no sample is ever invented.
   */
  calibration(model: string, dimension: string): Calibration {
    return this.bayesian.calibrate(model, dimension)
  }

  /**
   * Persist the decision to undo the change that led to `error`. The remedy is
   * not consulted here: a caller rolls back because it decided to, and the row
   * records only which error and which target the rollback belongs to.
   */
  rollback(error: number, target: string): Rollback {
    const record = this.error(error)
    const targetName = requireText(target, 'target')
    const category = this.resolvedCategory(record)
    const reason = `rollback after ${category} failure: ${truncate(record.message, MaxTextLength)}`
    const identity = this.host.db.insert('rollback', {
      handle: this.host.handles.next('rollback'),
      error: record.identity,
      target: targetName,
      reason,
      created: this.host.clock.now(),
    })
    return mapRollback(this.host.db.require<Row>('rollback', identity, 'rollback'))
  }

  /** Every error recorded for one coordination session, oldest first. */
  listError(session: number): ErrorRecord[] {
    const sessionIdentity = requireIdentity(session, 'session')
    if (this.host.db.get<Row>('SELECT identity FROM session WHERE identity = ?', sessionIdentity) === undefined) {
      throw new NotFoundError('session', sessionIdentity)
    }
    return this.host.db
      .all<Row>(
        `SELECT e.* FROM error e
         JOIN turn t ON t.identity = e.turn
         WHERE t.session = ?
         ORDER BY e.identity ASC`,
        sessionIdentity,
      )
      .map(mapError)
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  private error(identity: number): ErrorRecord {
    const errorIdentity = requireIdentity(identity, 'error')
    return mapError(this.host.db.require<Row>('error', errorIdentity, 'error'))
  }

  /** Message keywords, then the stored category, then a learned pattern. */
  private resolvedCategory(record: ErrorRecord): ErrorCategory {
    const byMessage = classifyMessage(record.message)
    if (byMessage !== 'unknown') return byMessage
    // `unknown` carries no information, so a learned pattern may still settle it.
    if (isErrorCategory(record.category) && record.category !== 'unknown') return record.category
    return this.learnedCategory(errorSignature(record.message)) ?? 'unknown'
  }

  /**
   * The category of the longest learned pattern whose signature is contained in
   * the candidate signature. Patterns are few, and containment lets a learned
   * signature cover variants that differ only in their tail.
   */
  private learnedCategory(signature: string): ErrorCategory | undefined {
    if (signature.length === 0) return undefined
    const rows = this.host.db.all<Row>('SELECT * FROM pattern ORDER BY identity ASC')
    let best: { signature: string; kind: string } | undefined
    for (const row of rows) {
      const stored = text(row, 'signature')
      if (stored.length === 0 || !signature.includes(stored)) continue
      if (best === undefined || stored.length >= best.signature.length) {
        best = { signature: stored, kind: text(row, 'kind') }
      }
    }
    if (best === undefined) return undefined
    return isErrorCategory(best.kind) ? best.kind : undefined
  }
}
