/**
 * Shared fixtures for the coordination module tests.
 *
 * Every module test builds the same kernel: an in-memory coordination database,
 * a resolved config, the append-only trace writer and the module host. Composing
 * that by hand in eight files drifts within a week, so it lives here once.
 *
 * Two deliberate constraints:
 *
 *  - no `node:test` import: this file is a fixture, not a test file, and it must
 *    stay importable from any test (and from a scratch script) unchanged;
 *  - no runtime import of `src/host/config.ts`: that module loads
 *    `@deepseek-ai/schemastery` (and transitively `@deepseek-ai/cosmokit`), which
 *    only exists inside a DSH host, so importing it here would make every test
 *    that uses a helper fail with ERR_MODULE_NOT_FOUND under plain Node. The
 *    type import below is erased at build time; `testConfig` mirrors what
 *    `resolveConfig()` would have returned instead.
 */
import type { CoordinationConfig, PlanWeights } from '../src/host/config.js'
import { CoordinationDatabase } from '../src/host/database.js'
import { HandleGenerator, SystemClock } from '../src/host/handle.js'
import { CoordinationEventBus, createModuleHost } from '../src/host/module.js'
import type {
  AgentPort,
  ApprovalPort,
  CompactionPort,
  LlmReadPort,
  ModuleHost,
  PermissionPresetPort,
  SessionPort,
  WebSearchPort,
} from '../src/host/module.js'
import { TraceModule } from '../src/host/trace.js'
import { SceneProfiles } from '../src/shared/enum.js'

/* ------------------------------------------------------------------------- *
 * Config
 * ------------------------------------------------------------------------- */

/**
 * `resolveConfig(undefined)` written out as a literal, so this file never loads
 * Schemastery. Keep it in step with `Config` in `src/host/config.ts`: it is the
 * same tree the schema materialises (defaults, not schema metadata).
 */
const DEFAULT_CONFIG: CoordinationConfig = {
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
    maxReject: 2,
    maxSubTask: 32,
    groundTruth: true,
    groundTruthTimeout: 5000,
    allowShellGroundTruth: false,
    modelRouting: true,
  },
  cache: { enabled: true, ttl: 60000, fingerprintWindow: 50, effortWarning: true },
  bayesian: { prior: 0.5, stopEntropy: 0.05, infoGain: 0.01, maxRoutes: 12, calibrationFloor: 0.1 },
  comprehension: { stageTimeout: 30000, searchEnabled: true, maxEvidence: 8, highHistoryWindow: 50 },
  ui: { toolbar: true, showTooltip: true, takeover: false, refreshInterval: 5000, compact: true, locale: 'auto' },
  // v24 §19: the shared scene table is the schema's `scenes` default; testConfig
  // clones it, so a test may tighten one scene without leaking into the next.
  scenes: SceneProfiles,
  defaults: {
    profession: 'execution',
    interaction: 'think',
    scene: 'dialogue',
    validation: 'medium',
    command: 'none',
  },
}

/**
 * Materialise the resolved config the modules receive.
 *
 * Mirrors `resolveConfig()`: `overrides` is shallow at the type level (exactly
 * like the real resolver's input) but nested objects are merged field by field,
 * the profession lock is non-negotiable, and plan weights are normalised.
 */
export function testConfig(overrides: Partial<CoordinationConfig> = {}): CoordinationConfig {
  const merged = mergeConfig(clonePlain(DEFAULT_CONFIG), overrides)
  merged.profession.lock = true
  merged.profession.enabled = true
  merged.plan.weights = normaliseWeights(merged.plan.weights)
  return merged
}

/** Same eight weights as `PlanWeights`, in the order the resolver uses. */
const FALLBACK_WEIGHTS: PlanWeights = {
  feasibility: 0.15,
  coverage: 0.15,
  clarity: 0.1,
  specificity: 0.1,
  alignment: 0.2,
  risk: 0.1,
  cost: 0.1,
  efficiency: 0.1,
}

/** Sum to one; mirrors `normaliseWeights` in `src/host/config.ts`. */
function normaliseWeights(weights: PlanWeights): PlanWeights {
  const keys = Object.keys(weights) as Array<keyof PlanWeights>
  const total = keys.reduce((sum, key) => sum + (Number.isFinite(weights[key]) ? weights[key] : 0), 0)
  if (total <= 0) return { ...FALLBACK_WEIGHTS }
  const result = {} as PlanWeights
  for (const key of keys) result[key] = (Number.isFinite(weights[key]) ? weights[key] : 0) / total
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Copy plain objects and arrays so callers can mutate the result safely. */
function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => clonePlain(entry)) as unknown as T
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) result[key] = clonePlain(entry)
  return result as T
}

/** Field-by-field merge; `undefined` never erases a default. */
function mergeConfig<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    result[key] = key in result ? mergeConfig(result[key], value) : clonePlain(value)
  }
  return result as T
}

/* ------------------------------------------------------------------------- *
 * Host
 * ------------------------------------------------------------------------- */

export interface TestHostOptions {
  llm?: LlmReadPort
  web?: WebSearchPort
  permissionPresets?: PermissionPresetPort
  sessions?: SessionPort
  compaction?: CompactionPort
  agents?: AgentPort
  approval?: ApprovalPort
  config?: Partial<CoordinationConfig>
}

export interface TestHost {
  db: CoordinationDatabase
  host: ModuleHost
  close(): void
}

/**
 * The kernel every module test needs: in-memory database + resolved config +
 * trace writer + module host. Only the optional DSH ports are opt-in; every
 * module must tolerate their absence, so tests start from their absence.
 */
export function createTestHost(options: TestHostOptions = {}): TestHost {
  const db = new CoordinationDatabase(':memory:')
  const config = testConfig(options.config)
  const handles = new HandleGenerator('test')
  const clock = SystemClock

  /*
   * Bootstrapping, in the only order that works: `TraceModule`'s constructor
   * demands a `ModuleHost`, but the host needs a `TraceWriter` before it can be
   * composed. `TraceModule` only ever reads `db`, `handles` and `clock` (see
   * `src/host/trace.ts`), so a four-field bootstrap object is enough. The
   * assertion is structural — `ModuleHost` is an interface, nothing is coerced
   * at runtime — and it is confined to this line: no module ever sees the
   * bootstrap object. The finished host below is a different, complete object.
   */
  const bootstrap = { db, config, handles, clock } as ModuleHost
  const trace = new TraceModule(bootstrap)

  const events = new CoordinationEventBus()
  const host = createModuleHost({
    db,
    config,
    trace,
    handles,
    clock,
    events,
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    ...(options.web === undefined ? {} : { web: options.web }),
    ...(options.permissionPresets === undefined ? {} : { permissionPresets: options.permissionPresets }),
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.approval === undefined ? {} : { approval: options.approval }),
  })

  return {
    db,
    host,
    close(): void {
      events.clear()
      db.close()
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Row fixtures
 *
 * Rows are inserted directly instead of through a module: a test about the plan
 * scorer should not have to drive comprehension first. Each helper fills every
 * NOT NULL column with a sensible value and lets `patch` override any column
 * (including `handle`), which keeps fixtures short and greppable.
 * ------------------------------------------------------------------------- */

let sessionSerial = 0
let turnSerial = 0
let promptSerial = 0
let comprehensionSerial = 0
let planSerial = 0

function now(): number {
  return Date.now()
}

/** Drop `undefined` entries so a patch cannot blank out a NOT NULL default. */
function clean(patch: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (patch !== undefined) {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) result[key] = value
    }
  }
  return result
}

/** Insert a `session` row and return its integer identity. */
export function insertSession(db: CoordinationDatabase, handle?: string): number {
  sessionSerial += 1
  return db.insert('session', {
    handle: handle ?? `test-session-${sessionSerial}`,
    principal: 'test',
    sandbox: 'danger-full-access',
    interaction: 'think',
    scene: 'dialogue',
    validation: 'medium',
    profile: 'default',
    generation: 1,
    status: 'active',
    created: now(),
  })
}

/**
 * Insert a `turn` row for `session` and return its integer identity. The ordinal
 * defaults to the next free one for that session, so repeated calls build a
 * valid turn history without the caller tracking it.
 */
export function insertTurn(db: CoordinationDatabase, session: number, patch?: Record<string, unknown>): number {
  turnSerial += 1
  const next = db.get<{ ordinal: number }>(
    'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM turn WHERE session = ?',
    session,
  )
  return db.insert('turn', {
    handle: `test-turn-${turnSerial}`,
    session,
    ordinal: next?.ordinal ?? 1,
    interaction: 'think',
    scene: 'dialogue',
    validation: 'medium',
    profession: 'execution',
    locked: 1,
    effort: 'medium',
    status: 'pending',
    created: now(),
    ...clean(patch),
  })
}

/**
 * Insert a `comprehension` row for `turn` and return its integer identity.
 * `prompt` is NOT NULL with a foreign key, so a prompt row is created (or the
 * turn's existing prompt reused) unless the patch supplies its own.
 */
export function insertComprehension(db: CoordinationDatabase, turn: number, patch?: Record<string, unknown>): number {
  comprehensionSerial += 1
  const supplied = patch?.prompt
  const prompt = typeof supplied === 'number' ? supplied : resolvePrompt(db, turn)
  return db.insert('comprehension', {
    handle: `test-comprehension-${comprehensionSerial}`,
    turn,
    prompt,
    intent: 'understand the request',
    requirement: 'answer the request',
    constraint: 'none',
    assumption: 'none',
    ambiguity: 'none',
    confidence: 0.8,
    stageCount: 0,
    created: now(),
    ...clean(patch),
  })
}

/** Insert a `plan` row for `turn` and return its integer identity. */
export function insertPlan(db: CoordinationDatabase, turn: number, patch?: Record<string, unknown>): number {
  planSerial += 1
  return db.insert('plan', {
    handle: `test-plan-${planSerial}`,
    turn,
    goal: 'ship the change',
    approach: 'take the shortest safe path',
    step: 'one step at a time',
    constraint: 'none',
    assumption: 'none',
    status: 'draft',
    rebuild: 0,
    mode: 'auto',
    orchestration: 0,
    created: now(),
    ...clean(patch),
  })
}

/** One prompt row per turn, as the schema's foreign key requires. */
function resolvePrompt(db: CoordinationDatabase, turn: number): number {
  const existing = db.get<{ identity: number }>(
    'SELECT identity FROM prompt WHERE turn = ? ORDER BY identity ASC LIMIT 1',
    turn,
  )
  if (existing !== undefined) return existing.identity
  promptSerial += 1
  return db.insert('prompt', {
    handle: `test-prompt-${promptSerial}`,
    turn,
    content: 'test prompt',
    created: now(),
  })
}

/** Row count for any table; the table name is quoted by the database wrapper. */
export function countRows(db: CoordinationDatabase, table: string): number {
  return db.count(table)
}
