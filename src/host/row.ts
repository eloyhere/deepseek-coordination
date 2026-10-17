/**
 * Row mappers.
 *
 * SQLite returns `unknown` cells; modules that read `SELECT *` use these
 * helpers instead of repeating casts. JSON columns and 0/1 booleans are
 * normalised here once, so a mapper bug is a single fix rather than a sweep.
 */
import { parseJson, yes } from './database.js'
import type {
  Command,
  Compact,
  Comprehension,
  Goal,
  OrchestrationTrace,
  Plan,
  ProfessionRecord,
  ProviderView,
  Score,
  Selection,
  SubTask,
  Takeover,
  Turn,
  ModelCapability,
  CacheStrategy,
  RecoveryPacket,
} from '../shared/entity.js'
import type {
  CommandType,
  Interaction,
  PlanMode,
  PlanStatus,
  Profession,
  ProfessionStatus,
  Scene,
  ScoreCategory,
  StageName,
  StageStatus,
  SubTaskStatus,
  TakeoverStatus,
  TakeoverType,
  TraceEvent,
  TurnStatus,
  Validation,
  Verdict,
} from '../shared/enum.js'

export type Row = Record<string, unknown>

export function text(row: Row, key: string, fallback = ''): string {
  const value = row[key]
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value)
}

export function number(row: Row, key: string, fallback = 0): number {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : value === null || value === undefined ? fallback : Number(value)
}

export function optionalNumber(row: Row, key: string): number | undefined {
  const value = row[key]
  return value === null || value === undefined ? undefined : number(row, key)
}

export function bool(row: Row, key: string): boolean {
  return yes(row[key])
}

export function json<T>(row: Row, key: string, fallback: T): T {
  return parseJson<T>(row[key], fallback)
}

export function mapTurn(row: Row): Turn {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    session: number(row, 'session'),
    ordinal: number(row, 'ordinal'),
    ...(row.prompt === null || row.prompt === undefined ? {} : { prompt: number(row, 'prompt') }),
    command: text(row, 'command', 'none') as CommandType,
    ...(row.comprehension === null || row.comprehension === undefined
      ? {}
      : { comprehension: number(row, 'comprehension') }),
    ...(row.organization === null || row.organization === undefined
      ? {}
      : { organization: number(row, 'organization') }),
    ...(row.plan === null || row.plan === undefined ? {} : { plan: number(row, 'plan') }),
    ...(row.goal === null || row.goal === undefined ? {} : { goal: number(row, 'goal') }),
    ...(row.compact === null || row.compact === undefined ? {} : { compact: number(row, 'compact') }),
    interaction: text(row, 'interaction', 'think') as Interaction,
    scene: text(row, 'scene', 'dialogue') as Scene,
    validation: text(row, 'validation', 'medium') as Validation,
    profession: text(row, 'profession', 'execution') as Profession,
    locked: bool(row, 'locked'),
    ...(row.lockedAt === null || row.lockedAt === undefined ? {} : { lockedAt: number(row, 'lockedAt') }),
    ...(row.cognitive === null || row.cognitive === undefined ? {} : { cognitive: text(row, 'cognitive') }),
    effort: text(row, 'effort', 'medium'),
    iteration: number(row, 'iteration', 1),
    rebuild: number(row, 'rebuild'),
    status: text(row, 'status', 'pending') as TurnStatus,
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

export function mapSubTask(row: Row): SubTask {
  const recovery = json<RecoveryPacket | null>(row, 'recovery', null)
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    parent: number(row, 'parent'),
    model: text(row, 'model'),
    effort: text(row, 'effort'),
    task: text(row, 'task'),
    tools: json<string[]>(row, 'tools', []),
    context: text(row, 'context'),
    acceptance: text(row, 'acceptance'),
    ...(row.groundTruth === null || row.groundTruth === undefined
      ? {}
      : { groundTruth: text(row, 'groundTruth') }),
    profession: text(row, 'profession', 'execution') as Profession,
    locked: bool(row, 'locked'),
    ...(row.lockedAt === null || row.lockedAt === undefined ? {} : { lockedAt: number(row, 'lockedAt') }),
    blockedBy: json<number[]>(row, 'blockedBy', []),
    status: text(row, 'status', 'pending') as SubTaskStatus,
    ...(row.result === null || row.result === undefined ? {} : { result: text(row, 'result') }),
    ...(row.evidence === null || row.evidence === undefined ? {} : { evidence: text(row, 'evidence') }),
    ...(row.verdict === null || row.verdict === undefined ? {} : { verdict: text(row, 'verdict') as Verdict }),
    ...(row.reason === null || row.reason === undefined ? {} : { reason: text(row, 'reason') }),
    ...(recovery === null ? {} : { recovery }),
    rejectCount: number(row, 'rejectCount'),
    ...(row.supersedes === null || row.supersedes === undefined
      ? {}
      : { supersedes: number(row, 'supersedes') }),
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

export function mapPlan(row: Row): Plan {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    ...(row.parent === null || row.parent === undefined ? {} : { parent: number(row, 'parent') }),
    goal: text(row, 'goal'),
    approach: text(row, 'approach'),
    step: text(row, 'step'),
    constraint: text(row, 'constraint'),
    assumption: text(row, 'assumption'),
    status: text(row, 'status', 'draft') as PlanStatus,
    rebuild: number(row, 'rebuild'),
    mode: text(row, 'mode', 'auto') as PlanMode,
    orchestration: bool(row, 'orchestration'),
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

export function mapProfessionRecord(row: Row): ProfessionRecord {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    ...(row.subtask === null || row.subtask === undefined ? {} : { subtask: number(row, 'subtask') }),
    actor: text(row, 'actor'),
    profession: text(row, 'profession', 'execution') as Profession,
    locked: bool(row, 'locked'),
    ...(row.lockedAt === null || row.lockedAt === undefined ? {} : { lockedAt: number(row, 'lockedAt') }),
    status: text(row, 'status', 'pending') as ProfessionStatus,
    ...(row.input === null || row.input === undefined ? {} : { input: text(row, 'input') }),
    ...(row.output === null || row.output === undefined ? {} : { output: text(row, 'output') }),
    ...(row.reason === null || row.reason === undefined ? {} : { reason: text(row, 'reason') }),
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

export function mapComprehension(row: Row): Comprehension {
  const optional = (key: string): string | undefined =>
    row[key] === null || row[key] === undefined ? undefined : text(row, key)
  const optionalNumeric = (key: string): number | undefined =>
    row[key] === null || row[key] === undefined ? undefined : number(row, key)
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    prompt: number(row, 'prompt'),
    intent: text(row, 'intent'),
    requirement: text(row, 'requirement'),
    constraint: text(row, 'constraint'),
    assumption: text(row, 'assumption'),
    ambiguity: text(row, 'ambiguity'),
    confidence: number(row, 'confidence'),
    ...(optionalNumeric('entropy') === undefined ? {} : { entropy: optionalNumeric('entropy') }),
    ...(optionalNumeric('emotion') === undefined ? {} : { emotion: optionalNumeric('emotion') }),
    ...(optional('empathy') === undefined ? {} : { empathy: optional('empathy') }),
    ...(optional('think') === undefined ? {} : { think: optional('think') }),
    ...(optionalNumeric('probe') === undefined ? {} : { probe: optionalNumeric('probe') }),
    ...(optional('evidence') === undefined ? {} : { evidence: optional('evidence') }),
    ...(optional('constraintIds') === undefined ? {} : { constraintIds: optional('constraintIds') }),
    ...(optional('boundary') === undefined ? {} : { boundary: optional('boundary') }),
    ...(optional('prospect') === undefined ? {} : { prospect: optional('prospect') }),
    ...(optional('posterior') === undefined ? {} : { posterior: optional('posterior') }),
    ...(optional('fusion') === undefined ? {} : { fusion: optional('fusion') }),
    ...(optionalNumeric('refusal') === undefined ? {} : { refusal: optionalNumeric('refusal') }),
    ...(optional('route') === undefined ? {} : { route: optional('route') }),
    ...(optional('failure') === undefined ? {} : { failure: optional('failure') }),
    stageCount: number(row, 'stageCount'),
    ...(optional('thinkTrace') === undefined ? {} : { thinkTrace: optional('thinkTrace') }),
    ...(optional('model') === undefined ? {} : { model: optional('model') }),
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

export function mapProviderView(row: Row): ProviderView {
  return {
    route: text(row, 'route'),
    title: text(row, 'title'),
    live: bool(row, 'live'),
    source: text(row, 'source', 'plugin') as ProviderView['source'],
    models: json<ModelCapability[]>(row, 'models', []),
    ...(row.cacheStrategy === null || row.cacheStrategy === undefined
      ? {}
      : { cacheStrategy: json<CacheStrategy>(row, 'cacheStrategy', { effortCacheBreak: false, reasoningPreserve: false }) }),
    ...(row.notes === null || row.notes === undefined ? {} : { notes: text(row, 'notes') }),
    observed: number(row, 'observed'),
  }
}

export function mapGoal(row: Row): Goal {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    session: number(row, 'session'),
    content: text(row, 'content'),
    status: text(row, 'status', 'set') as Goal['status'],
    ...(row.reason === null || row.reason === undefined ? {} : { reason: text(row, 'reason') }),
    created: number(row, 'created'),
    ...(row.changed === null || row.changed === undefined ? {} : { changed: number(row, 'changed') }),
  }
}

export function mapCompact(row: Row): Compact {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    session: number(row, 'session'),
    before: text(row, 'beforeContent'),
    after: text(row, 'afterContent'),
    beforeSize: number(row, 'beforeSize'),
    afterSize: number(row, 'afterSize'),
    ratio: number(row, 'ratio'),
    strategy: text(row, 'strategy', 'summary') as Compact['strategy'],
    ...(row.reason === null || row.reason === undefined ? {} : { reason: text(row, 'reason') }),
    created: number(row, 'created'),
  }
}

export function mapCommand(row: Row): Command {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    type: text(row, 'type', 'none') as CommandType,
    content: text(row, 'content'),
    ...(row.result === null || row.result === undefined ? {} : { result: text(row, 'result') }),
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

export function mapScore(row: Row): Score {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    category: text(row, 'category') as ScoreCategory,
    target: number(row, 'target'),
    dimension: text(row, 'dimension'),
    value: number(row, 'value'),
    ...(row.reason === null || row.reason === undefined ? {} : { reason: text(row, 'reason') }),
    ...(row.model === null || row.model === undefined ? {} : { model: text(row, 'model') }),
    created: number(row, 'created'),
  }
}

export function mapTrace(row: Row): OrchestrationTrace {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    turn: number(row, 'turn'),
    event: text(row, 'event') as TraceEvent,
    ...(row.subtask === null || row.subtask === undefined ? {} : { subtask: number(row, 'subtask') }),
    actor: text(row, 'actor'),
    ...(row.profession === null || row.profession === undefined
      ? {}
      : { profession: text(row, 'profession') as Profession }),
    ...(row.parentEvent === null || row.parentEvent === undefined
      ? {}
      : { parentEvent: number(row, 'parentEvent') }),
    detail: text(row, 'detail'),
    hash: text(row, 'hash'),
    created: number(row, 'created'),
  }
}

export function mapTakeover(row: Row): Takeover {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    ...(row.session === null || row.session === undefined ? {} : { session: number(row, 'session') }),
    type: text(row, 'type') as TakeoverType,
    payload: text(row, 'payload'),
    status: text(row, 'status') as TakeoverStatus,
    ...(row.result === null || row.result === undefined ? {} : { result: text(row, 'result') }),
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}

export function mapSelection(row: Row): Selection {
  return {
    session: text(row, 'session'),
    profession: text(row, 'profession', 'execution') as Profession,
    interaction: text(row, 'interaction', 'think') as Interaction,
    scene: text(row, 'scene', 'dialogue') as Scene,
    validation: text(row, 'validation', 'medium') as Validation,
    command: text(row, 'command', 'none') as CommandType,
    locked: false,
    changed: number(row, 'changed'),
  }
}

export function mapStage(row: Row): {
  identity: number
  handle: string
  comprehension: number
  stage: StageName
  ordinal: number
  status: StageStatus
  input?: string
  output?: string
  confidence?: number
  entropyBefore?: number
  entropyAfter?: number
  created: number
  finished?: number
} {
  return {
    identity: number(row, 'identity'),
    handle: text(row, 'handle'),
    comprehension: number(row, 'comprehension'),
    stage: text(row, 'stage') as StageName,
    ordinal: number(row, 'ordinal'),
    status: text(row, 'status') as StageStatus,
    ...(row.input === null || row.input === undefined ? {} : { input: text(row, 'input') }),
    ...(row.output === null || row.output === undefined ? {} : { output: text(row, 'output') }),
    ...(row.confidence === null || row.confidence === undefined
      ? {}
      : { confidence: number(row, 'confidence') }),
    ...(row.entropyBefore === null || row.entropyBefore === undefined
      ? {}
      : { entropyBefore: number(row, 'entropyBefore') }),
    ...(row.entropyAfter === null || row.entropyAfter === undefined
      ? {}
      : { entropyAfter: number(row, 'entropyAfter') }),
    created: number(row, 'created'),
    ...(row.finished === null || row.finished === undefined ? {} : { finished: number(row, 'finished') }),
  }
}
