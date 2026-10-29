/**
 * Complexity-adoption regression tests (v24 audit).
 *
 * These tests exist to keep the audit's adoptions honest:
 *
 *  - behaviour equivalence for the query rewrites (turn ordinals, route
 *    ranking, blockedBy resolution) — same rows, same order, same errors;
 *  - bounded caches stay bounded, and eviction does not change a correct answer
 *    (provider catalogs re-enumerate, effort detection only forgets a session);
 *  - the SQL indexes the audit added are present on a fresh and a reopened
 *    database, and the planner actually uses them;
 *  - the client poll signature is sensitive to every field it replaced and is
 *    cheap enough for a 2 s poll (generous wall-clock guard, never a ratio).
 *
 * Timing guards are deliberately loose (seconds, not milliseconds): they catch
 * an accidental quadratic rewrite, not a slow machine. Measured before/after
 * numbers live in `docs/complexity-audit-v24.md`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CoordinationDatabase, SCHEMA_VERSION } from '../src/host/database.js'
import { BayesianModule } from '../src/host/bayesian.js'
import { OrchestrationModule } from '../src/host/orchestration.js'
import { ProfessionModule } from '../src/host/profession.js'
import { ProviderModule, ProviderCatalogCacheCapacity } from '../src/host/provider.js'
import { CacheModule, EffortCacheCapacity } from '../src/host/cache.js'
import { CompactionStateStore } from '../src/host/compaction-state.js'
import { TurnModule } from '../src/host/turn.js'
import { computePlanDimensions } from '../src/host/plan.js'
import type { PlanMeasureInput } from '../src/host/plan.js'
import {
  SelectStyleCacheCapacity,
  SelectionStateCache,
  selectStyle,
  selectionStateSignature,
} from '../src/client/selection-cache.js'
import type { ModuleHost } from '../src/host/module.js'
import type { SelectionState, SelectionStateConfig } from '../src/shared/selection.js'
import { InvalidArgumentError, InvalidStateError } from '../src/shared/error.js'
import { createTestHost, insertPlan, insertSession, insertTurn } from './helpers.js'

/* ------------------------------------------------------------------------- *
 * Small fixtures and instrumentation
 * ------------------------------------------------------------------------- */

function milliseconds(operation: () => void): number {
  const start = performance.now()
  operation()
  return performance.now() - start
}

/**
 * Count the statements that match `pattern` on `get` and `all`.
 *
 * Wrapping the two read methods is how a query-count assertion stays exact
 * without a mock driver; every module reads through this object.
 */
function countQueries(
  db: CoordinationDatabase,
  pattern: RegExp,
): { reads: () => number; restore: () => void } {
  const target = db as unknown as Record<string, unknown>
  const originalGet = db.get.bind(db)
  const originalAll = db.all.bind(db)
  const counter = { reads: 0 }
  target.get = (sql: string, ...parameters: unknown[]): unknown => {
    if (pattern.test(sql)) counter.reads += 1
    return originalGet(sql, ...parameters)
  }
  target.all = (sql: string, ...parameters: unknown[]): unknown => {
    if (pattern.test(sql)) counter.reads += 1
    return originalAll(sql, ...parameters)
  }
  return {
    reads: () => counter.reads,
    restore: () => {
      target.get = originalGet
      target.all = originalAll
    },
  }
}

function queryPlan(db: CoordinationDatabase, sql: string): string {
  return db
    .all<{ detail?: unknown }>(`EXPLAIN QUERY PLAN ${sql}`)
    .map((row) => String(row.detail ?? ''))
    .join(' | ')
}

function indexNames(db: CoordinationDatabase, table: string): string[] {
  return db
    .all<{ name?: unknown }>(`PRAGMA index_list(${table})`)
    .map((row) => String(row.name ?? ''))
}

/** A representative host config projection for the signature tests. */
function selectionConfig(): SelectionStateConfig {
  return {
    defaultProfession: 'execution',
    defaultInteraction: 'think',
    defaultScene: 'dialogue',
    defaultValidation: 'medium',
    showTooltip: true,
    takeover: false,
    workflow: true,
    locale: 'auto',
    refreshInterval: 5000,
    cacheEnabled: true,
    searchEnabled: true,
    audit: true,
    errorHint: true,
    rebuildCanReselect: true,
    abandonCanReselect: true,
    compaction: {
      auto: true,
      soft: 0.7,
      hard: 0.88,
      reserve: 2048,
      recentTurns: 6,
      cooldown: 30000,
      maxPerSession: 20,
    },
  }
}

function selectionState(): SelectionState {
  return {
    session: 'session-1',
    selection: {
      session: 'session-1',
      profession: 'execution',
      interaction: 'think',
      scene: 'dialogue',
      validation: 'medium',
      command: 'none',
      locked: false,
      changed: 1,
    },
    locked: false,
    presets: [
      { value: 'read-only', name: 'Read only', description: 'no writes', sandbox: 'read-only' },
      { value: 'workspace-write', name: 'Workspace write' },
    ],
    preset: 'read-only',
    tooltip: true,
    config: selectionConfig(),
  }
}

/** Insert one `subtask` row with every NOT NULL column filled. */
function insertSubTask(
  host: ModuleHost,
  parent: number,
  status: string,
  extra: Record<string, unknown> = {},
): number {
  return host.db.insert('subtask', {
    handle: `subtask-${parent}-${status}-${host.db.count('subtask')}`,
    parent,
    model: 'test-model',
    effort: 'medium',
    task: 'test task',
    acceptance: 'test acceptance',
    profession: 'execution',
    locked: 1,
    status,
    rejectCount: 0,
    created: host.clock.now(),
    ...extra,
  })
}

/* ------------------------------------------------------------------------- *
 * 1. Turn ordinal: MAX(ordinal) is equivalent and index-backed
 * ------------------------------------------------------------------------- */

test('turn ordinals come from the indexed MAX(ordinal), not a row count', (context) => {
  const host = createTestHost({ config: { maxTurnPerSession: 100000 } })
  context.after(() => host.close())
  const session = insertSession(host.db)
  for (let index = 0; index < 2000; index += 1) insertTurn(host.db, session)

  // Dense ordinals are an invariant (turn rows are append-only), so the two
  // sources agree for every existing database.
  const countRow = host.db.get<{ total: number }>('SELECT COUNT(*) AS total FROM turn WHERE session = ?', session)
  const maxRow = host.db.get<{ ordinal: number }>(
    'SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM turn WHERE session = ?',
    session,
  )
  assert.equal(Number(maxRow?.ordinal), Number(countRow?.total))

  const plan = queryPlan(host.db, 'SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM turn WHERE session = 1')
  assert.match(plan, /USING (COVERING )?INDEX/)
  assert.doesNotMatch(plan, /SCAN turn/)

  const turns = new TurnModule({
    config: host.host.config,
    clock: host.host.clock,
    handles: host.host.handles,
    executionStore: host.host.executionStore!,
    turnStore: host.host.turnStore!,
    trace: host.host.trace,
    profession: new ProfessionModule(host.host),
  })
  const created = turns.create(session, {
    content: 'the next prompt',
    profession: 'execution',
    interaction: 'think',
    scene: 'dialogue',
    validation: 'medium',
  })
  assert.equal(created.ordinal, 2001)
  assert.equal(host.db.count('turn', 'session = ?', session), 2001)

  // Same guard as before: the ceiling refuses the next turn with the same error.
  const capped = createTestHost({ config: { maxTurnPerSession: 2 } })
  context.after(() => capped.close())
  const cappedSession = insertSession(capped.db)
  const cappedTurns = new TurnModule({
    config: capped.host.config,
    clock: capped.host.clock,
    handles: capped.host.handles,
    executionStore: capped.host.executionStore!,
    turnStore: capped.host.turnStore!,
    trace: capped.host.trace,
    profession: new ProfessionModule(capped.host),
  })
  for (let index = 0; index < 2; index += 1) {
    cappedTurns.create(cappedSession, {
      content: `prompt ${index}`,
      profession: 'execution',
      interaction: 'think',
      scene: 'dialogue',
      validation: 'medium',
    })
  }
  assert.throws(
    () => cappedTurns.create(cappedSession, {
      content: 'one too many',
      profession: 'execution',
      interaction: 'think',
      scene: 'dialogue',
      validation: 'medium',
    }),
    (error: unknown) => error instanceof InvalidStateError && /maxTurnPerSession/.test(error.message),
  )
})

/* ------------------------------------------------------------------------- *
 * 2. Route ranking: one posterior read per pass, latest row wins
 * ------------------------------------------------------------------------- */

test('rankRoute reads every latest posterior in one statement', (context) => {
  const { host, close } = createTestHost()
  context.after(() => close())
  const session = insertSession(host.db)
  const turn = insertTurn(host.db, session)
  const bayesian = new BayesianModule(host)
  const routeCount = 36
  for (let index = 0; index < routeCount; index += 1) {
    host.db.insert('route', {
      handle: `route-${index}`,
      turn,
      name: `route-${index}`,
      description: `route ${index}`,
      probability: 0.5,
      rank: 0,
      created: host.clock.now(),
    })
    if (index < 4) {
      host.db.insert('failure_route', {
        handle: `failure-${index}`,
        turn,
        name: `failure-${index}`,
        description: `failure ${index}`,
        probability: 0.5,
        rank: 0,
        created: host.clock.now(),
      })
    }
  }
  // Two posteriors for route-0: only the newest may feed the ranking.
  host.db.insert('posterior', {
    handle: 'posterior-old',
    turn,
    hypothesis: 'route-0',
    probability: 0.2,
    created: host.clock.now(),
  })
  host.db.insert('posterior', {
    handle: 'posterior-new',
    turn,
    hypothesis: 'route-0',
    probability: 0.95,
    created: host.clock.now(),
  })

  const counter = countQueries(host.db, /FROM posterior/i)
  const ranked = bayesian.rankRoute(turn)
  const reads = counter.reads()
  counter.restore()

  assert.equal(reads, 1, 'one grouped posterior read per ranking pass')
  assert.equal(ranked.length, routeCount)
  assert.equal(ranked[0]?.name, 'route-0', 'the latest posterior (0.95) wins')
  assert.deepEqual(
    ranked.map((route) => route.rank),
    ranked.map((_, index) => index),
  )
  // The write-back is persisted, not just returned.
  assert.equal(host.db.get<{ rank: number }>('SELECT rank FROM route WHERE name = ?', 'route-0')?.rank, 0)

  const failureCounter = countQueries(host.db, /FROM posterior/i)
  bayesian.rankFailureRoute(turn)
  assert.equal(failureCounter.reads(), 1)
  failureCounter.restore()
})

/* ------------------------------------------------------------------------- *
 * 3. blockedBy resolution: one read per list, identical errors
 * ------------------------------------------------------------------------- */

test('dispatch resolves every blockedBy entry in one read', (context) => {
  const { host, close } = createTestHost()
  context.after(() => close())
  const session = insertSession(host.db)
  const turn = insertTurn(host.db, session)
  const orchestration = new OrchestrationModule(host, new ProfessionModule(host))
  assert.equal(host.config.orchestration.maxSubTask > 8, true)

  const dependencies: number[] = []
  for (let index = 0; index < 8; index += 1) dependencies.push(insertSubTask(host, turn, 'verified'))
  const target = insertSubTask(host, turn, 'pending', { blockedBy: dependencies })

  const counter = countQueries(host.db, /FROM subtask WHERE identity = \?/i)
  const dispatched = orchestration.dispatch(target)
  const pointReads = counter.reads()
  counter.restore()

  assert.equal(pointReads, 0, 'no query per dependency')
  assert.equal(dispatched.status, 'running')

  // The three refusal paths keep their exact wording.
  const missing = insertSubTask(host, turn, 'pending', { blockedBy: [999999] })
  const otherTurn = insertTurn(host.db, session)
  const foreign = insertSubTask(host, otherTurn, 'verified')
  const foreignTarget = insertSubTask(host, turn, 'pending', { blockedBy: [foreign] })
  const unverified = insertSubTask(host, turn, 'submitted')
  const unverifiedTarget = insertSubTask(host, turn, 'pending', { blockedBy: [unverified] })

  assert.throws(
    () => orchestration.dispatch(missing),
    (error: unknown) => error instanceof InvalidStateError && /blocked by missing subtask 999999/.test(error.message),
  )
  assert.throws(
    () => orchestration.dispatch(foreignTarget),
    (error: unknown) => error instanceof InvalidStateError && /blocked by subtask \d+ of another turn/.test(error.message),
  )
  assert.throws(
    () => orchestration.dispatch(unverifiedTarget),
    (error: unknown) => error instanceof InvalidStateError && /dependencies must be verified/.test(error.message),
  )
})

test('decompose resolves all draft dependencies in one read', (context) => {
  const { host, close } = createTestHost()
  context.after(() => close())
  const session = insertSession(host.db)
  const turn = insertTurn(host.db, session)
  const profession = new ProfessionModule(host)
  const orchestration = new OrchestrationModule(host, profession)
  const first = insertSubTask(host, turn, 'verified')
  const second = insertSubTask(host, turn, 'verified')
  const plan = insertPlan(host.db, turn, {
    step: JSON.stringify([
      { task: 'first draft', acceptance: 'recorded' },
      { task: 'second draft', acceptance: 'recorded', blockedBy: [first] },
      { task: 'third draft', acceptance: 'recorded', blockedBy: [first, second] },
    ]),
  })

  const counter = countQueries(host.db, /FROM subtask WHERE identity IN/i)
  const created = orchestration.decompose(plan)
  const batchReads = counter.reads()
  counter.restore()
  assert.equal(created.length, 3)
  assert.equal(batchReads, 1, 'one IN query for the whole draft list')

  const brokenPlan = insertPlan(host.db, turn, {
    step: JSON.stringify([{ task: 'fourth draft', acceptance: 'recorded', blockedBy: [999999] }]),
  })
  assert.throws(
    () => orchestration.decompose(brokenPlan),
    (error: unknown) => error instanceof InvalidArgumentError && /blockedBy 999999 does not exist/.test(error.message),
  )
})

/* ------------------------------------------------------------------------- *
 * 4. Bounded caches: caps hold and eviction stays correct
 * ------------------------------------------------------------------------- */

test('provider catalog cache is bounded and eviction only re-reads DSH', async (context) => {
  const routes = 300
  const providers = Array.from({ length: routes }, (_, index) => ({
    id: `route-${index}`,
    name: `Route ${index}`,
  }))
  const catalog = new Map(providers.map((provider) => [provider.id, [{
    id: `${provider.id}-model`,
    name: 'Model',
    inputModalities: ['text'],
  }]]))
  const listModelsCalls: string[] = []
  const llm = {
    listProviders: () => providers,
    listConfigurableProviders: () => [],
    listModels: async (route: string): Promise<unknown[]> => {
      listModelsCalls.push(route)
      return catalog.get(route) ?? []
    },
    resolveModelInfo: async (_route: string, model: string): Promise<Record<string, unknown>> => ({
      id: model,
      name: 'Model',
      context: { contextWindow: 1000 },
      defaultMaxTokens: 100,
      inputModalities: ['text'],
      reasoning: { efforts: [] },
    }),
  }
  const { host, close } = createTestHost({ llm: llm as never })
  context.after(() => close())
  const provider = new ProviderModule(host)
  const internals = provider as unknown as { cache: { size: number; capacity: number } }

  for (let index = 0; index < routes; index += 1) await provider.models(`route-${index}`)
  assert.equal(internals.cache.size, ProviderCatalogCacheCapacity)
  assert.equal(internals.cache.capacity, ProviderCatalogCacheCapacity)
  assert.equal(listModelsCalls.length, routes)

  // The newest route is still cached: warm reads do not touch DSH.
  const warm = await provider.models(`route-${routes - 1}`)
  assert.equal(listModelsCalls.length, routes)
  assert.equal(warm.length, 1)

  // The oldest route was evicted: the next read re-enumerates and is correct.
  const cold = await provider.models('route-0')
  assert.equal(listModelsCalls.length, routes + 1)
  assert.equal(cold[0]?.id, 'route-0-model')
  assert.equal(provider.invalidate('route-0'), undefined)
  await provider.models('route-0')
  assert.equal(listModelsCalls.length, routes + 2)
  provider.invalidate()
  assert.equal(internals.cache.size, 0)
})

test('effort detector is bounded and forgets only the evicted session', (context) => {
  const { host, close } = createTestHost()
  context.after(() => close())
  const cache = new CacheModule(host)
  const internals = cache as unknown as { efforts: { size: number; capacity: number } }

  for (let session = 1; session <= EffortCacheCapacity + 100; session += 1) {
    cache.checkEffortCacheBreak(session, 'medium')
  }
  assert.equal(internals.efforts.size, EffortCacheCapacity)
  assert.equal(internals.efforts.capacity, EffortCacheCapacity)

  // A recently observed session still reports a break…
  const recent = EffortCacheCapacity + 100
  cache.checkEffortCacheBreak(recent, 'medium')
  assert.equal(cache.checkEffortCacheBreak(recent, 'high'), true)
  // …while the first session's observation was evicted; that one call reports
  // "first effort", which is the documented, non-safety tradeoff.
  assert.equal(cache.checkEffortCacheBreak(1, 'high'), false)
})

test('compaction state store evicts least-recently-used sessions and clears', () => {
  const store = new CompactionStateStore(3)
  assert.equal(store.capacity, 3)
  store.set('a', { lastAt: 1, count: 1 })
  store.set('b', { lastAt: 2, count: 1 })
  store.set('c', { lastAt: 3, count: 1 })
  // Reading `a` makes it the most recently used entry.
  assert.deepEqual(store.get('a'), { lastAt: 1, count: 1 })
  store.set('d', { lastAt: 4, count: 1 })
  assert.equal(store.size, 3)
  assert.equal(store.get('b'), undefined, 'the least recently used session was evicted')
  assert.notEqual(store.get('a'), undefined)
  assert.notEqual(store.get('c'), undefined)
  assert.notEqual(store.get('d'), undefined)
  store.clear()
  assert.equal(store.size, 0)
})

test('client selection cache is bounded and promotes the active session', () => {
  const cache = new SelectionStateCache(3)
  assert.equal(cache.capacity, 3)
  const state = (session: string): SelectionState => ({ ...selectionState(), session })
  cache.set('a', state('a'))
  cache.set('b', state('b'))
  cache.set('c', state('c'))
  assert.equal(cache.get('a')?.session, 'a')
  cache.set('d', state('d'))
  assert.equal(cache.size, 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a')?.session, 'a')
  cache.clear()
  assert.equal(cache.size, 0)
})

test('select style cache is bounded and identity-stable for a repeated width', () => {
  const first = selectStyle(140, true)
  const second = selectStyle(140, true)
  assert.equal(first, second, 'the same width reuses the same style object')
  for (let width = 0; width < SelectStyleCacheCapacity + 8; width += 1) selectStyle(width, false)
  const recreated = selectStyle(140, true)
  assert.notEqual(recreated, first, 'an evicted style is rebuilt')
  assert.deepEqual(recreated, first, 'and rebuilt identically')
})

/* ------------------------------------------------------------------------- *
 * 5. Client poll signature: sensitive to every field, cheap
 * ------------------------------------------------------------------------- */

test('selection signature changes for every field the composer renders', () => {
  const base = selectionState()
  const baseSignature = selectionStateSignature(base)
  assert.equal(selectionStateSignature(structuredClone(base)), baseSignature)

  const variants: Array<(state: SelectionState) => void> = [
    (state) => { state.locked = true },
    (state) => { state.preset = 'workspace-write' },
    (state) => { state.selection.profession = 'outcome' },
    (state) => { state.selection.interaction = 'orchestrate' },
    (state) => { state.selection.scene = 'engineering' },
    (state) => { state.selection.validation = 'high' },
    (state) => { state.selection.command = 'plan' },
    (state) => { state.turn = {
      identity: 1,
      handle: 'turn-1',
      ordinal: 1,
      status: 'pending',
      profession: 'execution',
      locked: true,
    } },
    (state) => { state.turn = {
      identity: 1,
      handle: 'turn-1',
      ordinal: 1,
      status: 'pending',
      profession: 'resource',
      locked: true,
    } },
    (state) => { state.presets[0]!.value = 'changed' },
    (state) => { state.presets[0]!.name = 'Changed' },
    (state) => { state.presets[0]!.description = 'changed' },
    (state) => { state.presets[0]!.sandbox = 'danger-full-access' },
    (state) => { state.tooltip = false },
    (state) => { state.config!.takeover = true },
    (state) => { state.config!.compaction.soft = 0.8 },
  ]
  let previous = baseSignature
  for (const mutate of variants) {
    const next = structuredClone(base)
    mutate(next)
    const signature = selectionStateSignature(next)
    assert.notEqual(signature, previous)
    previous = signature
  }

  // The memo must not change the encoding: the signature is exactly the JSON
  // array the composer compared before the audit.
  const legacy = (state: SelectionState): string => JSON.stringify([
    state.locked,
    state.preset ?? '',
    state.selection.profession,
    state.selection.interaction,
    state.selection.scene,
    state.selection.validation,
    state.selection.command,
    state.turn?.identity ?? 0,
    state.turn?.profession ?? '',
    state.presets.map((preset) => [preset.value, preset.name, preset.description ?? '', preset.sandbox ?? '']),
    state.tooltip,
    state.config ?? {},
  ])
  for (const state of [base, ...variants.map((mutate) => {
    const next = structuredClone(base)
    mutate(next)
    return next
  })]) {
    assert.equal(selectionStateSignature(state), legacy(state))
  }
})

test('selection signature is cheap enough for a two-second poll', () => {
  const state = selectionState()
  // The previous state is re-signed on every poll; identity memoisation is what
  // keeps that at one serialisation per poll instead of three or four.
  assert.equal(selectionStateSignature(state), selectionStateSignature(state))
  const warm = milliseconds(() => {
    for (let index = 0; index < 20000; index += 1) selectionStateSignature(state)
  })
  const cold = milliseconds(() => {
    for (let index = 0; index < 2000; index += 1) selectionStateSignature(structuredClone(state))
  })
  assert.ok(warm < 5000, `20000 memoised signatures took ${warm.toFixed(1)} ms`)
  assert.ok(cold < 5000, `2000 fresh signatures took ${cold.toFixed(1)} ms`)
})

/* ------------------------------------------------------------------------- *
 * 6. Plan measurement: the per-call token memo is deterministic
 * ------------------------------------------------------------------------- */

test('plan dimensions stay deterministic after the per-call token memo', () => {
  const plan: PlanMeasureInput = {
    goal: '把季度报告里的关键指标整理成一份可核对的中文摘要',
    approach: '先列出数据来源，再按指标逐项核对，最后生成摘要并做一次反向验证，确保每个数字都能追溯到原始文件。',
    step: JSON.stringify([
      { step: 'collect the quarterly metrics from the workspace reports', acceptance: 'every metric has a source path' },
      { step: '核对 每个指标 的 数值 与 单位', acceptance: 'no unit mismatch remains' },
      { step: 'generate the summary', acceptance: 'the summary cites each source' },
    ]),
    constraint: '不得修改原始报告，也不得联网',
    assumption: '报告文件已经下载到工作区',
  }
  const comprehension = {
    intent: '整理季度报告的关键指标并生成可核对的摘要',
    requirement: '摘要中的每个数字都能追溯到原始文件',
    constraint: '不修改原文件',
    assumption: '报告已下载到工作区',
    ambiguity: '指标范围未明说',
  }
  const first = computePlanDimensions(plan, comprehension)
  const second = computePlanDimensions({ ...plan }, { ...comprehension })
  assert.deepEqual(second, first)
  for (const [dimension, value] of Object.entries(first)) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${dimension} stays in [0, 1]`)
  }
  const elapsed = milliseconds(() => {
    for (let index = 0; index < 2000; index += 1) computePlanDimensions(plan, comprehension)
  })
  assert.ok(elapsed < 5000, `2000 dimension passes took ${elapsed.toFixed(1)} ms`)
})

/* ------------------------------------------------------------------------- *
 * 7. SQL: additive indexes exist and the planner uses them
 * ------------------------------------------------------------------------- */

test('audit indexes exist on a fresh database and are used by the planner', (context) => {
  const db = new CoordinationDatabase(':memory:')
  context.after(() => db.close())

  assert.ok(indexNames(db, 'evidence').includes('idx_evidence_turn'))
  assert.ok(indexNames(db, 'likelihood').includes('idx_likelihood_evidence'))
  assert.ok(indexNames(db, 'takeover').includes('idx_takeover_session'))

  assert.match(queryPlan(db, 'SELECT * FROM evidence WHERE turn = 1'), /idx_evidence_turn/)
  assert.match(
    queryPlan(db, "SELECT * FROM likelihood WHERE evidence = 1 AND hypothesis = 'h'"),
    /idx_likelihood_evidence/,
  )
  assert.match(queryPlan(db, 'SELECT * FROM takeover WHERE session = 1'), /idx_takeover_session/)
  // The grouped ranking query keeps its posterior index.
  assert.match(
    queryPlan(db, 'SELECT hypothesis, probability, MAX(identity) FROM posterior WHERE turn = 1 GROUP BY hypothesis'),
    /idx_posterior_turn/,
  )
})

test('audit indexes are added to an existing database without a migration', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'coordination-audit-'))
  const path = join(directory, 'coordination.db')

  const first = new CoordinationDatabase(path)
  assert.equal(first.get<{ user_version: number }>('PRAGMA user_version')?.user_version, SCHEMA_VERSION)
  // Simulate a database created before the audit: dropping an index is a
  // schema change SQLite allows on a live file, unlike editing the SQL text.
  first.exec('DROP INDEX idx_evidence_turn;')
  first.close()

  const reopened = new CoordinationDatabase(path)
  assert.ok(indexNames(reopened, 'evidence').includes('idx_evidence_turn'))
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, SCHEMA_VERSION)

  // Close before deleting: Windows refuses to unlink an open database file.
  context.after(() => {
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  })
})
