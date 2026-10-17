/**
 * Token-governor policy tests (v24 §5 cache, §9.3 plan scoring, §12 Bayesian
 * EIG, §14 validation, §22 the settings surface).
 *
 * Pure policy: no DSH host, no HTTP, no database write. The governor only reads
 * `config.compaction`; the projection test composes the real `SelectionModule`
 * over the shared in-memory fixture so the settings wire shape is pinned too.
 *
 * The estimator is intentionally heuristic, so its examples are pinned exactly
 * rather than compared with a tokenizer: a change to a coefficient must fail
 * here and be reviewed as a policy change.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestHost, testConfig } from './helpers.js'
import { resolveConfig } from '../src/host/config.js'
import { SelectionModule } from '../src/host/selection.js'
import {
  TokenGovernor,
  TokenPolicy,
  budgetFor,
  estimateMessages,
  estimateTokens,
  normaliseCompactionPatch,
  planBudget,
  selectContext,
  shouldCompact,
  shouldRetrieve,
  tokenDiagnostics,
  valuePerToken,
} from '../src/host/token.js'
import type { ContextChunk, TokenBudget } from '../src/host/token.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { InvalidArgumentError } from '../src/shared/error.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const ManualBudget: TokenBudget = { contextWindow: 10_000, soft: 0.7, hard: 0.88, reserve: 2000, recentTurns: 6 }

function compactionConfig(patch: Partial<CoordinationConfig['compaction']> = {}): CoordinationConfig['compaction'] {
  return { ...testConfig().compaction, ...patch }
}

function chunk(patch: Partial<ContextChunk> & Pick<ContextChunk, 'id' | 'kind' | 'text' | 'tokens' | 'score'>): ContextChunk {
  return patch
}

/* ------------------------------------------------------------------------- *
 * estimateTokens
 * ------------------------------------------------------------------------- */

test('estimateTokens pins the ASCII, CJK and code examples', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('   \n\t '), 0)
  // 2 ASCII words * 1.3 = 2.6 -> 3
  assert.equal(estimateTokens('hello world'), 3)
  // 2.6 + two punctuation marks * 0.25 = 3.1 -> 3
  assert.equal(estimateTokens('Hello, world!'), 3)
  // CJK is one token per character: 4 characters.
  assert.equal(estimateTokens('你好世界'), 4)
  // 2 CJK + one ASCII word: 2 + 1.3 = 3.3 -> 3
  assert.equal(estimateTokens('你好 world'), 3)
  // 5 CJK/fullwidth characters (Chinese punctuation is fullwidth).
  assert.equal(estimateTokens('中文，标点'), 5)
  // Code: const/x/1 = 3.9, '=' and ';' = 0.5 -> 4.4 -> 4
  assert.equal(estimateTokens('const x = 1;'), 4)
  // Long identifiers get 0.1 token per character beyond five:
  // 5 words = 6.5, extras 3+6+1 = 1.0, 4 punctuation = 1.0 -> 8.5 -> 9
  assert.equal(estimateTokens('function getUserById(id) { return id }'), 9)
  // One long word: 1.3 + (100 - 5) * 0.1 = 10.8 -> 11
  assert.equal(estimateTokens('a'.repeat(100)), 11)
  // Pure punctuation: 3 * 0.25 = 0.75 -> 1
  assert.equal(estimateTokens('+++'), 1)
  // Astral emoji are not free and are not four code units either.
  assert.equal(estimateTokens('👍'), 1)
})

test('estimateTokens memoises repeated summaries and stays bounded', () => {
  tokenDiagnostics.reset()
  const summary = 'the deployment note is stable '.repeat(40) // ~1,160 chars
  const first = estimateTokens(summary)
  const missesAfterFirst = tokenDiagnostics.memoMisses
  assert.equal(estimateTokens(summary), first)
  assert.equal(tokenDiagnostics.memoMisses, missesAfterFirst)
  assert.ok(tokenDiagnostics.memoHits >= 1)

  for (let index = 0; index < 300; index += 1) {
    estimateTokens(`unique summary ${index} ` + 'z'.repeat(400))
  }
  assert.equal(tokenDiagnostics.memoEntries, TokenPolicy.estimator.memoCapacity)
  assert.ok(tokenDiagnostics.memoEntries <= 256)
})

test('estimateMessages counts text blocks and per-message overhead without JSON', () => {
  assert.equal(estimateMessages([]), 0)
  // 2.6 + 3 template tokens = 5.6 -> 6
  assert.equal(estimateMessages([{ role: 'user', content: 'hello world' }]), 6)
  assert.equal(
    estimateMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
    ]),
    6,
  )
  // Object content, text field: 1.3 + 3 = 4.3 -> 4
  assert.equal(estimateMessages([{ role: 'user', content: { text: 'hi' } }]), 4)
  // A message with no measurable text still pays the chat-template overhead.
  assert.equal(estimateMessages([{ role: 'user', content: null }]), 3)
  assert.equal(estimateMessages([{ role: 'user', content: 42 }]), 3)
})

/* ------------------------------------------------------------------------- *
 * budgetFor
 * ------------------------------------------------------------------------- */

test('budgetFor clamps the window, thresholds and reserve', () => {
  // 8k window: 8% would be 640, so the 2048 floor applies; the 25% cap wins.
  assert.deepEqual(budgetFor(8_000), {
    contextWindow: 8_000,
    soft: 0.7,
    hard: 0.88,
    reserve: 2_000,
    recentTurns: 6,
  })
  assert.equal(budgetFor(1_000).contextWindow, 8_000)
  assert.equal(budgetFor(5_000_000).contextWindow, 2_000_000)
  // 100k: max(2048, 8%) = 8000.
  assert.equal(budgetFor(100_000).reserve, 8_000)
  assert.equal(budgetFor(2_000_000).reserve, 160_000)
  // A reserve never consumes more than a quarter of the window.
  assert.equal(budgetFor(100_000, { reserve: 999_999 }).reserve, 25_000)
  // soft is clamped to [0.3, 0.9] and hard stays above it, at most 0.98.
  assert.equal(budgetFor(100_000, { soft: 0.95 }).soft, 0.9)
  assert.equal(budgetFor(100_000, { soft: 0.95 }).hard, 0.91)
  assert.equal(budgetFor(100_000, { hard: 0.5 }).hard, 0.71)
  assert.equal(budgetFor(100_000, { hard: 0.99 }).hard, 0.98)
  assert.equal(budgetFor(100_000, { soft: 0.2 }).soft, 0.3)
  assert.equal(budgetFor(100_000, { recentTurns: 1 }).recentTurns, 2)
  assert.equal(budgetFor(100_000, { recentTurns: 50 }).recentTurns, 20)
})

/* ------------------------------------------------------------------------- *
 * planBudget
 * ------------------------------------------------------------------------- */

test('planBudget switches at 0.69, 0.71 and 0.89 of the effective window', () => {
  // effective = 10,000 - 2,000 = 8,000
  const below = planBudget(5_520, ManualBudget)
  assert.equal(below.decision, 'none')
  assert.equal(below.utilization, 0.69)
  assert.match(below.reason, /below the soft threshold 0\.7/)

  const soft = planBudget(5_680, ManualBudget)
  assert.equal(soft.decision, 'soft-compact')
  assert.equal(soft.utilization, 0.71)
  assert.match(soft.reason, /soft threshold 0\.7/)

  const hard = planBudget(7_120, ManualBudget)
  assert.equal(hard.decision, 'hard-prune')
  assert.equal(hard.utilization, 0.89)
  assert.match(hard.reason, /hard threshold 0\.88/)

  // The boundary belongs to the higher severity.
  assert.equal(planBudget(5_600, ManualBudget).decision, 'soft-compact')
  assert.equal(planBudget(7_040, ManualBudget).decision, 'hard-prune')
})

test('planBudget fails safe on empty capacity and inside the reserve', () => {
  const noCapacity = planBudget(1_000, { ...ManualBudget, contextWindow: 2_000, reserve: 2_000 })
  assert.deepEqual(noCapacity, {
    decision: 'none',
    utilization: 0,
    reason: 'effective context window is 0 tokens after a 2000-token reserve; no compaction decision',
  })

  // 900 tokens fit inside a 9000-token reserve: never hard-prune.
  const insideReserve = planBudget(900, { ...ManualBudget, contextWindow: 10_000, reserve: 9_000 })
  assert.equal(insideReserve.decision, 'soft-compact')
  assert.equal(insideReserve.reason.includes('hard threshold'), false)
})

/* ------------------------------------------------------------------------- *
 * valuePerToken and selectContext
 * ------------------------------------------------------------------------- */

test('valuePerToken applies score, kind weight and token cost', () => {
  const system = chunk({ id: 'system', kind: 'system', text: 'rules', tokens: 100, score: 1 })
  const user = chunk({ id: 'user', kind: 'user', text: 'question', tokens: 100, score: 1 })
  const free = chunk({ id: 'history', kind: 'history', text: 'note', tokens: 0, score: 0.5 })
  assert.equal(valuePerToken(system), 0.03)
  assert.equal(valuePerToken(user), 0.02)
  assert.equal(valuePerToken(free), 0.8)
})

test('selectContext keeps pinned and recent chunks verbatim and drops the low-value rest', () => {
  const budget = budgetFor(10_000)
  const chunks = [
    chunk({ id: 'system', kind: 'system', text: 'system rules', tokens: 4_000, score: 1, pinned: true, created: 0 }),
    chunk({ id: 'old-user', kind: 'user', text: 'old question', tokens: 5_000, score: 0.05, created: 1 }),
    chunk({ id: 'old-answer', kind: 'assistant', text: 'old answer', tokens: 5_000, score: 0.05, created: 2 }),
    chunk({ id: 'recent-user', kind: 'user', text: 'recent question', tokens: 300, score: 0.2, created: 3 }),
    chunk({ id: 'recent-answer', kind: 'assistant', text: 'recent answer', tokens: 300, score: 0.2, created: 4 }),
    chunk({ id: 'evidence', kind: 'evidence', text: 'fresh evidence', tokens: 1_000, score: 0.9, created: 5 }),
  ]
  const result = selectContext(chunks, budget, { recentTurns: 1 })
  assert.deepEqual(
    result.selected.map((entry) => entry.id),
    ['system', 'recent-user', 'recent-answer', 'evidence'],
  )
  assert.deepEqual(
    result.dropped.map((entry) => entry.id),
    ['old-user', 'old-answer'],
  )
  assert.equal(result.estimated, 5_600)
  // The input order, not the score order, is the wire order (prefix caching).
  assert.deepEqual(
    result.selected.map((entry) => entry.id),
    chunks.filter((entry) => result.selected.includes(entry)).map((entry) => entry.id),
  )
})

test('selectContext deduplicates identical and near-identical text', () => {
  const budget = budgetFor(10_000)
  const chunks = [
    chunk({
      id: 'evidence-a',
      kind: 'evidence',
      text: 'alpha beta gamma delta epsilon zeta eta theta',
      tokens: 100,
      score: 0.9,
      created: 1,
    }),
    chunk({
      id: 'evidence-b',
      kind: 'evidence',
      text: 'alpha beta gamma delta epsilon zeta eta theta!',
      tokens: 100,
      score: 0.9,
      created: 2,
    }),
    chunk({ id: 'evidence-c', kind: 'evidence', text: 'completely different content here', tokens: 100, score: 0.9, created: 3 }),
  ]
  const result = selectContext(chunks, budget, { recentTurns: 0 })
  assert.deepEqual(
    result.selected.map((entry) => entry.id),
    ['evidence-a', 'evidence-c'],
  )
  assert.deepEqual(
    result.dropped.map((entry) => entry.id),
    ['evidence-b'],
  )
  // One Set pass, never a pairwise similarity matrix.
  assert.ok(tokenDiagnostics.lastSelect.dedupeKeys <= chunks.length)
})

test('selectContext ties break on created then id and keep input order', () => {
  const budget = budgetFor(10_000) // fill capacity 6,336 tokens
  const chunks = [
    chunk({ id: 'a', kind: 'evidence', text: 'alpha one', tokens: 3_000, score: 0.5, created: 200 }),
    chunk({ id: 'b', kind: 'evidence', text: 'beta two', tokens: 3_000, score: 0.5, created: 100 }),
    chunk({ id: 'c', kind: 'evidence', text: 'gamma three', tokens: 3_000, score: 0.5, created: 300 }),
  ]
  const result = selectContext(chunks, budget, { recentTurns: 0 })
  // Value is identical, so created ascending picks b then a; c does not fit.
  assert.deepEqual(
    result.selected.map((entry) => entry.id),
    ['a', 'b'],
  )
  assert.deepEqual(
    result.dropped.map((entry) => entry.id),
    ['c'],
  )
  // Same result on a re-run: deterministic for equal inputs.
  assert.deepEqual(
    selectContext(chunks, budget, { recentTurns: 0 }).selected.map((entry) => entry.id),
    ['a', 'b'],
  )
})

test('selectContext always keeps pinned chunks even when they exceed the fill budget', () => {
  const budget = budgetFor(10_000)
  const chunks = [
    chunk({ id: 'pinned', kind: 'system', text: 'never drop this fact', tokens: 10_000, score: 0, pinned: true }),
    chunk({ id: 'small', kind: 'history', text: 'extra note', tokens: 10, score: 1 }),
  ]
  const result = selectContext(chunks, budget, { recentTurns: 0 })
  assert.deepEqual(
    result.selected.map((entry) => entry.id),
    ['pinned'],
  )
  assert.equal(result.estimated, 10_000)
})

test('selectContext honours minScore for non-pinned chunks', () => {
  const budget = budgetFor(10_000)
  const chunks = [
    chunk({ id: 'pinned', kind: 'system', text: 'kept', tokens: 10, score: 0, pinned: true }),
    chunk({ id: 'weak', kind: 'evidence', text: 'weak evidence', tokens: 10, score: 0.2, created: 1 }),
    chunk({ id: 'strong', kind: 'evidence', text: 'strong evidence', tokens: 10, score: 0.8, created: 2 }),
  ]
  const result = selectContext(chunks, budget, { recentTurns: 0, minScore: 0.5 })
  assert.deepEqual(
    result.selected.map((entry) => entry.id),
    ['pinned', 'strong'],
  )
  assert.deepEqual(
    result.dropped.map((entry) => entry.id),
    ['weak'],
  )
})

test('selectContext fails closed for oversized input', () => {
  const chunks: ContextChunk[] = Array.from({ length: 20_001 }, (_unused, index) =>
    chunk({
      id: `chunk-${index}`,
      kind: 'history',
      text: `history ${index}`,
      tokens: 1,
      score: 0.1,
    }),
  )
  assert.throws(
    () => selectContext(chunks, budgetFor(10_000)),
    (error: unknown) => error instanceof InvalidArgumentError && /at most 20000 entries/.test(error.message),
  )
})

/* ------------------------------------------------------------------------- *
 * shouldRetrieve / shouldCompact
 * ------------------------------------------------------------------------- */

test('shouldRetrieve is a low-entropy / high-gain matrix', () => {
  const base = { entropy: 0.5, expectedInfoGain: 0.6, budgetTokens: 100, costPerQuery: 1000 }
  assert.equal(shouldRetrieve(base), true)
  assert.equal(shouldRetrieve({ ...base, expectedInfoGain: 0.5 }), true)
  assert.equal(shouldRetrieve({ ...base, expectedInfoGain: 0.4999 }), false)
  assert.equal(shouldRetrieve({ ...base, entropy: 0.1499 }), false)
  assert.equal(shouldRetrieve({ ...base, entropy: 0.15 }), true)
  assert.equal(shouldRetrieve({ ...base, budgetTokens: 0 }), false)
  // A cheap query lowers the required gain: 100 / 1000 * 0.5 = 0.05.
  assert.equal(shouldRetrieve({ ...base, costPerQuery: 100, expectedInfoGain: 0.05 }), true)
  assert.equal(shouldRetrieve({ ...base, costPerQuery: 100, expectedInfoGain: 0.049 }), false)
  assert.equal(shouldRetrieve({ entropy: 1, expectedInfoGain: 1, budgetTokens: 1 }), true)
})

test('shouldCompact also fires when a large prompt has a cold cache', () => {
  const budget = budgetFor(100_000) // effective 92,000; soft point 64,400
  assert.equal(shouldCompact({ inputTokens: 70_000 }, budget), true)
  assert.equal(shouldCompact({ inputTokens: 50_000 }, budget), false)
  // 62,000 is below the soft threshold (0.674) but above 60% of the window.
  assert.equal(shouldCompact({ inputTokens: 62_000, cacheReadTokens: 0 }, budget), true)
  assert.equal(shouldCompact({ inputTokens: 62_000, cacheReadTokens: 1_200 }, budget), false)
  // The cold-cache rule is strictly greater than 60% of the window.
  assert.equal(shouldCompact({ inputTokens: 60_000, cacheReadTokens: 0 }, budget), false)
})

/* ------------------------------------------------------------------------- *
 * TokenGovernor
 * ------------------------------------------------------------------------- */

test('governor derives the default budget from config and context window', () => {
  const governor = new TokenGovernor({ config: testConfig(), contextWindow: 100_000 })
  const plan = governor.plan([])
  assert.equal(plan.estimated, 0)
  assert.equal(plan.decision, 'none')
  assert.match(plan.reason, /below the soft threshold 0\.7/)
  assert.deepEqual(plan.budget, {
    contextWindow: 100_000,
    soft: 0.7,
    hard: 0.88,
    reserve: 8_000,
    recentTurns: 6,
  })
  assert.equal(plan.keepRecent, 6)
  assert.deepEqual(plan.dropCandidates, [])
  assert.deepEqual(governor.stats(), { compactions: 0, savedTokens: 0, lastUtilization: 0 })
})

test('governor plans hard pressure, names the drop candidates and accounts compaction', () => {
  const governor = new TokenGovernor({ config: testConfig(), contextWindow: 100_000 })
  const messages = Array.from({ length: 20 }, (_unused, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
  }))
  const plan = governor.plan(messages, { inputTokens: 92_000 })
  assert.equal(plan.decision, 'hard-prune')
  assert.equal(plan.utilization, 1)
  assert.match(plan.reason, /hard threshold 0\.88/)
  // 20 messages minus the 6 recent turns * 2 verbatim messages.
  assert.equal(plan.dropCandidates.length, 8)
  assert.equal(plan.dropCandidates[0], 'message:0')

  governor.recordCompaction()
  // 40% of the last estimate is the conservative saving.
  assert.deepEqual(governor.stats(), { compactions: 1, savedTokens: 36_800, lastUtilization: 1 })
})

test('governor suppresses automatic compaction for auto, cooldown and maxPerSession', () => {
  const auto = new TokenGovernor({
    config: testConfig({ compaction: compactionConfig({ auto: false }) }),
    contextWindow: 100_000,
  })
  const blocked = auto.plan([], { inputTokens: 92_000 })
  assert.equal(blocked.decision, 'none')
  assert.match(blocked.reason, /config\.compaction\.auto/)

  const cooled = new TokenGovernor({
    config: testConfig({ compaction: compactionConfig({ cooldown: 60_000 }) }),
    contextWindow: 100_000,
  })
  assert.equal(cooled.plan([], { inputTokens: 92_000 }).decision, 'hard-prune')
  cooled.recordCompaction()
  const cooling = cooled.plan([], { inputTokens: 92_000 })
  assert.equal(cooling.decision, 'none')
  assert.match(cooling.reason, /cooldown 60000ms/)

  const capped = new TokenGovernor({
    config: testConfig({ compaction: compactionConfig({ maxPerSession: 1, cooldown: 0 }) }),
    contextWindow: 100_000,
  })
  assert.equal(capped.plan([], { inputTokens: 92_000 }).decision, 'hard-prune')
  capped.recordCompaction()
  const spent = capped.plan([], { inputTokens: 92_000 })
  assert.equal(spent.decision, 'none')
  assert.match(spent.reason, /maxPerSession 1/)
})

test('governor caches the last plan by identity and shape', () => {
  const governor = new TokenGovernor({ config: testConfig(), contextWindow: 100_000 })
  const messages = [{ role: 'user', content: 'hello world' }]
  const first = governor.plan(messages)
  assert.equal(governor.plan(messages), first)
  const fresh = [{ role: 'user', content: 'hello world' }]
  assert.equal(governor.plan(fresh), first)
  assert.equal(governor.plan([{ role: 'user', content: 'different text' }]).estimated, 6)
})

test('governor recordUsage refreshes the last utilisation and saving base', () => {
  const governor = new TokenGovernor({ config: testConfig(), contextWindow: 100_000 })
  governor.recordUsage({ inputTokens: 46_000 })
  assert.deepEqual(governor.stats(), { compactions: 0, savedTokens: 0, lastUtilization: 0.5 })
  // Measured usage, not a stale plan, is the base of the 40% saving estimate.
  governor.recordCompaction()
  assert.equal(governor.stats().savedTokens, 18_400)
})

test('governor select and shouldRetrieve delegate to the pure policy', () => {
  const governor = new TokenGovernor({ config: testConfig(), contextWindow: 100_000 })
  const chunks = [
    chunk({ id: 'pinned', kind: 'system', text: 'rules', tokens: 100, score: 1, pinned: true }),
    chunk({ id: 'evidence', kind: 'evidence', text: 'fact', tokens: 100, score: 0.9 }),
  ]
  assert.deepEqual(
    governor.select(chunks).selected.map((entry) => entry.id),
    ['pinned', 'evidence'],
  )
  assert.equal(
    governor.shouldRetrieve({ entropy: 0.5, expectedInfoGain: 0.6, budgetTokens: 10, costPerQuery: 1000 }),
    true,
  )
})

/* ------------------------------------------------------------------------- *
 * Compaction patch normalisation
 * ------------------------------------------------------------------------- */

test('normaliseCompactionPatch merges and clamps the writable fields', () => {
  const current = testConfig().compaction
  assert.deepEqual(normaliseCompactionPatch({}, current), { auto: true, soft: 0.7, hard: 0.88 })
  assert.deepEqual(normaliseCompactionPatch({ auto: false, soft: 0.8 }, current), {
    auto: false,
    soft: 0.8,
    hard: 0.88,
  })
  // Raising soft pushes hard above it.
  assert.deepEqual(normaliseCompactionPatch({ soft: 0.9 }, current), { auto: true, soft: 0.9, hard: 0.91 })
  // hard below soft is clamped to soft + 0.01.
  assert.deepEqual(normaliseCompactionPatch({ hard: 0.5 }, current), { auto: true, soft: 0.7, hard: 0.71 })
  // hard above 0.98 and soft below 0.3 are clamped.
  assert.deepEqual(normaliseCompactionPatch({ hard: 1.5 }, current), { auto: true, soft: 0.7, hard: 0.98 })
  assert.deepEqual(normaliseCompactionPatch({ soft: 0.2 }, current), { auto: true, soft: 0.3, hard: 0.88 })
  // Unknown keys are ignored, never persisted.
  assert.deepEqual(normaliseCompactionPatch({ reserve: 9_999 }, current), { auto: true, soft: 0.7, hard: 0.88 })
})

test('normaliseCompactionPatch rejects wrong types and non-finite numbers', () => {
  const current = testConfig().compaction
  assert.throws(() => normaliseCompactionPatch(null, current), InvalidArgumentError)
  assert.throws(() => normaliseCompactionPatch('auto=false', current), InvalidArgumentError)
  assert.throws(() => normaliseCompactionPatch([], current), InvalidArgumentError)
  assert.throws(() => normaliseCompactionPatch({ auto: 'yes' }, current), InvalidArgumentError)
  assert.throws(() => normaliseCompactionPatch({ soft: '0.5' }, current), InvalidArgumentError)
  assert.throws(() => normaliseCompactionPatch({ soft: Number.NaN }, current), InvalidArgumentError)
  assert.throws(() => normaliseCompactionPatch({ hard: Number.POSITIVE_INFINITY }, current), InvalidArgumentError)
  assert.throws(() => normaliseCompactionPatch({}, { auto: true } as never), InvalidArgumentError)
})

/* ------------------------------------------------------------------------- *
 * Settings projection
 * ------------------------------------------------------------------------- */

test('resolveConfig materialises and clamps the compaction group', () => {
  // The defaults are the documented schema defaults; pinning them here makes a
  // silent threshold change a failing test rather than a config surprise.
  assert.deepEqual(resolveConfig(undefined).compaction, {
    auto: true,
    soft: 0.7,
    hard: 0.88,
    reserve: 2048,
    recentTurns: 6,
    cooldown: 30000,
    maxPerSession: 20,
  })
  const resolved = resolveConfig({
    compaction: {
      auto: false,
      soft: 0.95,
      hard: 0.5,
      reserve: 100,
      recentTurns: 1,
      cooldown: 1,
      maxPerSession: 0,
    },
  })
  assert.deepEqual(resolved.compaction, {
    auto: false,
    soft: 0.9,
    hard: 0.91,
    reserve: 512,
    recentTurns: 2,
    cooldown: 5000,
    maxPerSession: 1,
  })
})

test('selection state projects the compaction policy and nothing else', () => {  const compaction = {
    auto: false,
    soft: 0.55,
    hard: 0.75,
    reserve: 4_096,
    recentTurns: 4,
    cooldown: 60_000,
    maxPerSession: 5,
  }
  const fixture = createTestHost({ config: { compaction } })
  try {
    const state = new SelectionModule(fixture.host).state('projection-session')
    assert.deepEqual(state.config?.compaction, compaction)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Invalid input
 * ------------------------------------------------------------------------- */

test('invalid input raises InvalidArgumentError', () => {
  const budget = budgetFor(10_000)
  assert.throws(() => estimateTokens(undefined as never), InvalidArgumentError)
  assert.throws(() => estimateMessages('messages' as never), InvalidArgumentError)
  assert.throws(() => estimateMessages([{ role: '', content: '' }]), InvalidArgumentError)
  assert.throws(() => estimateMessages([{ role: 'user', content: '' } as never, null as never]), InvalidArgumentError)

  assert.throws(() => budgetFor(Number.NaN), InvalidArgumentError)
  assert.throws(() => budgetFor(-1), InvalidArgumentError)
  assert.throws(() => budgetFor(Number.POSITIVE_INFINITY), InvalidArgumentError)
  assert.throws(() => budgetFor(10_000, { soft: Number.NaN }), InvalidArgumentError)
  assert.throws(() => budgetFor(10_000, { reserve: -1 }), InvalidArgumentError)
  assert.throws(() => budgetFor(10_000, null as never), InvalidArgumentError)

  assert.throws(() => planBudget(Number.NaN, budget), InvalidArgumentError)
  assert.throws(() => planBudget(-1, budget), InvalidArgumentError)
  assert.throws(() => planBudget(1, { contextWindow: 10 } as never), InvalidArgumentError)

  assert.throws(() => valuePerToken(chunk({ id: 'x', kind: 'history', text: 'x', tokens: -1, score: 1 })), InvalidArgumentError)
  assert.throws(() => valuePerToken(chunk({ id: 'x', kind: 'history', text: 'x', tokens: 1, score: Number.NaN })), InvalidArgumentError)
  assert.throws(() => selectContext('chunks' as never, budget), InvalidArgumentError)
  assert.throws(() => selectContext([], { ...budget, hard: Number.NaN }), InvalidArgumentError)
  assert.throws(() => selectContext([], budget, { recentTurns: -1 }), InvalidArgumentError)
  assert.throws(() => selectContext([], budget, { minScore: Number.NaN }), InvalidArgumentError)

  assert.throws(
    () => shouldRetrieve({ entropy: Number.NaN, expectedInfoGain: 1, budgetTokens: 1 }),
    InvalidArgumentError,
  )
  assert.throws(
    () => shouldRetrieve({ entropy: 1, expectedInfoGain: -1, budgetTokens: 1 }),
    InvalidArgumentError,
  )
  assert.throws(() => shouldCompact({ inputTokens: Number.NaN }, budget), InvalidArgumentError)
  assert.throws(() => shouldCompact({ inputTokens: -1 }, budget), InvalidArgumentError)

  assert.throws(() => new TokenGovernor({} as never), InvalidArgumentError)
  assert.throws(() => new TokenGovernor({ config: testConfig(), contextWindow: Number.NaN }), InvalidArgumentError)
  assert.throws(() => new TokenGovernor({ config: testConfig(), contextWindow: -1 }), InvalidArgumentError)
})
