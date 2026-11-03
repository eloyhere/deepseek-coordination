/**
 * Data-structure adoption regression tests (v24 pass).
 *
 * Every adoption in this pass has one of two proofs here:
 *
 *  - an equivalence test against a local reference implementation of the
 *    previous algorithm, so the public result (selection, agreement, command
 *    grants) is unchanged; or
 *  - a cap/operation test for the bounded structure (LRU memo, sparse grid,
 *    B+ tree) that pins the bound without asserting a wall-clock ratio.
 *
 * The randomized fixtures are deterministic (an LCG, never `Math.random`), and
 * timings are loose seconds-scale guards: they catch an accidental O(n^2)
 * rewrite on a slow machine, not a performance target. Measured before/after
 * numbers live in `docs/data-structure-adoption-v24.md`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { hashString } from '../src/shared/hash.js'
import { BPlusTree } from '../src/shared/tree.js'
import { GridRange, SparseGrid } from '../src/shared/grid.js'
import { ComprehensionModule } from '../src/host/comprehension.js'
import { EmotionModule } from '../src/host/emotion.js'
import { PermissionModule } from '../src/host/permission.js'
import { compareAgreement } from '../src/host/predict.js'
import {
  TokenPolicy,
  estimateTokens,
  selectContext,
  tokenDiagnostics,
  valuePerToken,
} from '../src/host/token.js'
import type { ContextChunk, TokenBudget } from '../src/host/token.js'
import type { AgentPort, ApprovalPort } from '../src/host/module.js'
import { createTestHost, insertSession, insertTurn } from './helpers.js'

/* ------------------------------------------------------------------------- *
 * Deterministic randomized fixtures
 * ------------------------------------------------------------------------- */

/** Small LCG; deterministic across runs and platforms. */
function randomSource(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))] as T
}

const KindValues: ReadonlyArray<ContextChunk['kind']> = [
  'system',
  'user',
  'assistant',
  'tool',
  'evidence',
  'plan',
  'history',
]

/**
 * Random chunks with exact duplicates only (no near-duplicates), so a reference
 * that dedupes by raw text is equivalent to the production signature dedupe:
 * the signature collision space is 64 bits plus a length bucket, and these
 * texts share no 80% normalised prefix unless they are identical.
 */
function randomChunks(count: number, random: () => number): ContextChunk[] {
  const chunks: ContextChunk[] = []
  const texts: string[] = []
  for (let index = 0; index < count; index += 1) {
    const duplicate = index > 0 && random() < 0.08
    const text = duplicate
      ? (texts[Math.floor(random() * index)] as string)
      : `word${Math.floor(random() * 1_000_000)}-${index}-${Math.floor(random() * 1_000_000)}`
    texts.push(text)
    const chunk: ContextChunk = {
      id: `chunk-${index}`,
      kind: pick(random, KindValues),
      text,
      tokens: Math.floor(random() * 31),
      score: Math.round(random() * 1_000_000) / 1_000_000,
    }
    if (random() < 0.1) chunk.pinned = true
    if (random() < 0.8) chunk.created = Math.floor(random() * 5) * 100
    chunks.push(chunk)
  }
  return chunks
}

function randomBudget(random: () => number): TokenBudget {
  return {
    contextWindow: 300 + Math.floor(random() * 700),
    soft: 0.7,
    hard: 0.4 + random() * 0.5,
    reserve: Math.floor(random() * 80),
    recentTurns: Math.floor(random() * 4),
  }
}

/* ------------------------------------------------------------------------- *
 * Local reference implementations (the previous algorithms, verbatim logic)
 * ------------------------------------------------------------------------- */

interface ScoredReference {
  index: number
  chunk: ContextChunk
  value: number
}

function compareReference(left: ScoredReference, right: ScoredReference): number {
  if (left.value !== right.value) return right.value - left.value
  const leftCreated = left.chunk.created ?? 0
  const rightCreated = right.chunk.created ?? 0
  if (leftCreated !== rightCreated) return leftCreated - rightCreated
  if (left.chunk.id === right.chunk.id) return left.index - right.index
  return left.chunk.id < right.chunk.id ? -1 : 1
}

function referenceCapacity(budget: TokenBudget): number {
  const effective = budget.contextWindow - budget.reserve
  if (!(effective > 0)) return 0
  return Math.max(0, Math.floor(effective * budget.hard * TokenPolicy.selectionFillRatio))
}

/** The pre-adoption selectContext: filter → sort → scan, dedupe by raw text. */
function referenceSelect(
  chunks: ContextChunk[],
  budget: TokenBudget,
  options: { recentTurns?: number; minScore?: number } = {},
): { selected: string[]; dropped: string[]; estimated: number } {
  const recentTurns = options.recentTurns ?? budget.recentTurns
  const minScore = options.minScore ?? 0
  const scored: ScoredReference[] = chunks.map((chunk, index) => ({
    index,
    chunk,
    value: valuePerToken(chunk),
  }))

  const mandatory = new Set<number>()
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index]?.pinned === true) mandatory.add(index)
  }
  let recentNeeded = recentTurns * 2
  for (let index = chunks.length - 1; index >= 0 && recentNeeded > 0; index -= 1) {
    const kind = chunks[index]?.kind
    if (kind !== 'user' && kind !== 'assistant') continue
    mandatory.add(index)
    recentNeeded -= 1
  }

  const signatures = new Set<string>()
  let estimated = 0
  for (const index of mandatory) {
    signatures.add(chunks[index]?.text ?? '')
    estimated += chunks[index]?.tokens ?? 0
  }

  const capacity = referenceCapacity(budget)
  const candidates = scored
    .filter((entry) => !mandatory.has(entry.index) && entry.chunk.score >= minScore)
    .sort(compareReference)

  const accepted: number[] = []
  for (const entry of candidates) {
    const signature = entry.chunk.text
    if (signatures.has(signature)) continue
    if (estimated + entry.chunk.tokens > capacity) continue
    signatures.add(signature)
    accepted.push(entry.index)
    estimated += entry.chunk.tokens
  }

  const kept = new Set<number>(mandatory)
  for (const index of accepted) kept.add(index)
  const selected: string[] = []
  const dropped: string[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] as ContextChunk
    if (kept.has(index)) selected.push(chunk.id)
    else dropped.push(chunk.id)
  }
  return { selected, dropped, estimated }
}

function referenceTokens(source: string): Set<string> {
  const tokens = new Set<string>()
  const lowered = source.toLowerCase()
  for (const match of lowered.matchAll(/[a-z0-9]+/g)) tokens.add(match[0])
  for (const match of source.matchAll(/[\u3400-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) tokens.add(run)
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

function referenceNumbers(source: string): number[] {
  const found: number[] = []
  for (const match of source.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const value = Number.parseFloat(match[0])
    if (Number.isFinite(value)) found.push(value)
  }
  return found
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function bruteNumeric(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || right.length === 0) return 1
  let total = 0
  for (const value of left) {
    let best = 0
    for (const candidate of right) {
      const scale = Math.max(Math.abs(value), Math.abs(candidate), 1)
      const similarity = clamp01(1 - Math.abs(value - candidate) / scale)
      if (similarity > best) best = similarity
    }
    total += best
  }
  return round4(total / left.length)
}

/** The pre-adoption compareAgreement, using the brute-force numeric factor. */
function referenceAgreement(left: string, right: string): number {
  const leftTokens = referenceTokens(left)
  const rightTokens = referenceTokens(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    const same = left.trim().length > 0 && left.trim() === right.trim()
    return same ? 1 : 0
  }
  let shared = 0
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1
  const union = leftTokens.size + rightTokens.size - shared
  const overlap = union === 0 ? 0 : shared / union
  return round4(clamp01(overlap * bruteNumeric(referenceNumbers(left), referenceNumbers(right))))
}

/* ------------------------------------------------------------------------- *
 * 1. Hash: the shared FNV-1a must be byte-identical to the removed helper
 * ------------------------------------------------------------------------- */

function localFnvBase36(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

test('shared hashString reproduces the removed FNV-1a memo/dedupe key bytes', () => {
  const samples = [
    '',
    'a',
    'hello world',
    '你好世界',
    '中文，标点 and words',
    '👍🏽 astral 🚀',
    'line\nwith\ttabs',
    'x'.repeat(257),
    'z'.repeat(4096),
    '0123456789abcdef'.repeat(8),
  ]
  for (const sample of samples) {
    assert.equal(hashString(sample).toString(36), localFnvBase36(sample), sample.slice(0, 24))
  }
})

/* ------------------------------------------------------------------------- *
 * 2. LRU memo: exact cap and least-recently-used eviction
 * ------------------------------------------------------------------------- */

test('estimateTokens memo is a 256-entry LRU and evicts only the oldest', () => {
  tokenDiagnostics.reset()
  const first = `first-${'y'.repeat(400)}`
  estimateTokens(first)
  assert.equal(tokenDiagnostics.memoMisses, 1)

  // 256 further unique texts (distinct lengths → distinct sample keys) evict
  // the first entry; capacity is exactly the policy cap.
  for (let index = 1; index <= 256; index += 1) {
    assert.equal(estimateTokens(`z${'z'.repeat(400 + index)}`) >= 0, true)
  }
  assert.equal(tokenDiagnostics.memoEntries, 256)
  assert.ok(tokenDiagnostics.memoEntries <= TokenPolicy.estimator.memoCapacity)

  const missesBefore = tokenDiagnostics.memoMisses
  estimateTokens(first)
  assert.equal(tokenDiagnostics.memoMisses, missesBefore + 1, 'the oldest entry was evicted')

  const newest = `z${'z'.repeat(400 + 256)}`
  const hitsBefore = tokenDiagnostics.memoHits
  estimateTokens(newest)
  assert.equal(tokenDiagnostics.memoHits, hitsBefore + 1, 'the newest entry is still cached')
  assert.equal(tokenDiagnostics.memoEntries, 256)
  tokenDiagnostics.reset()
})

/* ------------------------------------------------------------------------- *
 * 3. selectContext: heap order must equal the previous sort order
 * ------------------------------------------------------------------------- */

test('selectContext heap matches the sort reference on randomized fixtures', () => {
  const random = randomSource(0x5eed_1234)
  for (let fixture = 0; fixture < 40; fixture += 1) {
    const chunks = randomChunks(Math.floor(random() * 121), random)
    const budget = randomBudget(random)
    const options =
      random() < 0.5
        ? { recentTurns: Math.floor(random() * 4), minScore: random() < 0.3 ? 0.2 : 0 }
        : {}
    const actual = selectContext(chunks, budget, options)
    const expected = referenceSelect(chunks, budget, options)
    assert.deepEqual(actual.selected.map((chunk) => chunk.id), expected.selected, `selected fixture ${fixture}`)
    assert.deepEqual(actual.dropped.map((chunk) => chunk.id), expected.dropped, `dropped fixture ${fixture}`)
    assert.equal(actual.estimated, expected.estimated, `estimated fixture ${fixture}`)
  }
})

test('selectContext keeps pinned, recent, minScore and dedupe semantics', () => {
  const chunks: ContextChunk[] = [
    { id: 'pinned', kind: 'evidence', text: 'shared fact', tokens: 5, score: 0.1, pinned: true, created: 1 },
    { id: 'recent-user', kind: 'user', text: 'recent question', tokens: 5, score: 0.1, created: 2 },
    { id: 'recent-assistant', kind: 'assistant', text: 'recent answer', tokens: 5, score: 0.1, created: 3 },
    { id: 'below-score', kind: 'history', text: 'low value', tokens: 1, score: 0.05, created: 4 },
    { id: 'candidate', kind: 'plan', text: 'shared fact', tokens: 1, score: 0.9, created: 5 },
    { id: 'tail', kind: 'history', text: 'tail unique', tokens: 1, score: 0.8, created: 6 },
  ]
  const budget: TokenBudget = { contextWindow: 400, soft: 0.7, hard: 0.9, reserve: 200, recentTurns: 1 }
  const result = selectContext(chunks, budget, { recentTurns: 1, minScore: 0.1 })
  assert.deepEqual(result.selected.map((chunk) => chunk.id), ['pinned', 'recent-user', 'recent-assistant', 'tail'])
  assert.deepEqual(result.dropped.map((chunk) => chunk.id), ['below-score', 'candidate'])
  assert.equal(result.estimated, 16)
})

test('selectContext scores 20k chunks within the audit bound', () => {
  const random = randomSource(0x20_0000)
  const chunks: ContextChunk[] = []
  for (let index = 0; index < 20_000; index += 1) {
    chunks.push({
      id: `big-${index}`,
      kind: pick(random, KindValues),
      text: `chunk ${index} ${Math.floor(random() * 1_000_000)}`,
      tokens: 1 + Math.floor(random() * 40),
      score: random(),
      created: index,
    })
  }
  const scenarios: Array<{ name: string; budget: TokenBudget }> = [
    { name: 'wide', budget: { contextWindow: 32_000, soft: 0.7, hard: 0.85, reserve: 2_000, recentTurns: 6 } },
    { name: 'tight', budget: { contextWindow: 8_000, soft: 0.7, hard: 0.85, reserve: 2_000, recentTurns: 6 } },
  ]
  for (const scenario of scenarios) {
    const start = performance.now()
    const result = selectContext(chunks, scenario.budget)
    const elapsed = performance.now() - start
    const referenceStart = performance.now()
    const reference = referenceSelect(chunks, scenario.budget)
    const referenceElapsed = performance.now() - referenceStart
    assert.equal(result.selected.length + result.dropped.length, chunks.length)
    assert.ok(result.estimated > 0)
    assert.deepEqual(result.selected.map((chunk) => chunk.id), reference.selected)
    assert.equal(result.estimated, reference.estimated)
    assert.ok(elapsed < 5_000, `20k selectContext took ${elapsed.toFixed(1)}ms (limit 5000ms)`)
    assert.ok(referenceElapsed < 5_000, `20k sort reference took ${referenceElapsed.toFixed(1)}ms (limit 5000ms)`)
    console.log(
      `[adoption] selectContext 20k ${scenario.name}: heap ${elapsed.toFixed(1)}ms, sort reference ${referenceElapsed.toFixed(1)}ms, selected ${result.selected.length}, estimated ${result.estimated}`,
    )
  }
})

/* ------------------------------------------------------------------------- *
 * 4. OrderedSet dedupe: comprehension, emotion, permission grants
 * ------------------------------------------------------------------------- */

test('comprehension deduplicates repeated constraint clauses in first-seen order', async () => {
  const testHost = createTestHost()
  try {
    const module = new ComprehensionModule(testHost.host)
    const prompt = '请修复登录问题。必须使用 SQLite。必须使用 SQLite。不要改动 API。'
    const emotion = await module.emotion(prompt)
    const think = await module.think(prompt, emotion)
    const clauses = think.constraint.split('；')
    assert.equal(clauses.filter((clause) => clause.includes('必须使用 SQLite')).length, 1)
    assert.equal(clauses.filter((clause) => clause.includes('不要改动 API')).length, 1)
  } finally {
    testHost.close()
  }
})

test('emotion records a repeated crisis marker once in signal order', () => {
  const testHost = createTestHost()
  try {
    const session = insertSession(testHost.db)
    const turn = insertTurn(testHost.db, session)
    const prompt = '我想死，我想死，我想死。'
    const promptIdentity = testHost.db.insert('prompt', {
      handle: 'test-adoption-prompt',
      turn,
      content: prompt,
      created: Date.now(),
    })
    testHost.db.update('turn', { prompt: promptIdentity }, 'identity = ?', turn)
    const module = new EmotionModule(testHost.host)
    const crisis = module.crisis(turn)
    assert.equal(crisis?.signal, '想死')
  } finally {
    testHost.close()
  }
})

test('permission deduplicates repeated grant names in first-seen order', () => {
  const testHost = createTestHost()
  try {
    const session = insertSession(testHost.db)
    const turn = insertTurn(testHost.db, session)
    const module = new PermissionModule(testHost.host)
    const result = module.request('build', ['shell', 'shell', 'network', 'shell'], 'duplicate grants', session)
    assert.equal(result.allowed, true)
    assert.deepEqual(module.list(session), [{ subject: 'build', grant: ['shell', 'network'], status: 'granted' }])
    assert.equal(turn > 0, true)
  } finally {
    testHost.close()
  }
})

/* ------------------------------------------------------------------------- *
 * 5. Queue: permission command order, lookahead, quoted strings, 200 grants
 * ------------------------------------------------------------------------- */

test('permission command queue preserves lookahead, order and quoted tokens', () => {
  const policies: unknown[] = []
  const approval: ApprovalPort = {
    setPolicy(_agent, policy) {
      policies.push(policy)
    },
  }
  const agents: AgentPort = {
    get(id) {
      return id === 'live-session' ? { id: 'agent-1', session: 'live-session' } : undefined
    },
    list() {
      return []
    },
  }
  const testHost = createTestHost({ agents, approval })
  try {
    const session = insertSession(testHost.db, 'live-session')
    const turn = insertTurn(testHost.db, session)
    const module = new PermissionModule(testHost.host)

    const allowed = module.execute(turn, 'allow alice read --approval never write')
    assert.equal(allowed.allowed, true)
    assert.deepEqual(policies, ['never'], 'the directive value was consumed exactly once')
    assert.equal(module.check('alice', ['read', 'write']).allowed, true, 'grants after the directive survive')

    const quoted = module.execute(turn, 'allow "bob smith" "read files"')
    assert.equal(quoted.allowed, true)
    assert.equal(module.check('bob smith', ['read files']).allowed, true)
    assert.match(module.execute(turn, 'status "bob smith"').reason ?? '', /read files/)
  } finally {
    testHost.close()
  }
})

test('permission command accepts 200 grants without losing or reordering one', () => {
  const testHost = createTestHost()
  try {
    const session = insertSession(testHost.db)
    const turn = insertTurn(testHost.db, session)
    const module = new PermissionModule(testHost.host)
    const grants = Array.from({ length: 200 }, (_, index) => `grant-${index}`)
    const start = performance.now()
    const result = module.execute(turn, `allow worker ${grants.join(' ')}`)
    const elapsed = performance.now() - start
    assert.equal(result.allowed, true)
    assert.equal(module.check('worker', grants).allowed, true)
    const view = module.list(session).find((entry) => entry.subject === 'worker')
    assert.deepEqual(view?.grant, grants)
    assert.ok(elapsed < 5_000, `200-grant command took ${elapsed.toFixed(1)}ms (limit 5000ms)`)
    console.log(`[adoption] permission 200-grant command: ${elapsed.toFixed(1)}ms`)
  } finally {
    testHost.close()
  }
})

/* ------------------------------------------------------------------------- *
 * 6. Red-black nearest neighbour: brute-force equivalence + benchmark
 * ------------------------------------------------------------------------- */

test('red-black numeric agreement matches the brute-force reference', () => {
  const random = randomSource(0xc0_ffee)
  const numberText = (values: readonly number[]): string => values.join(' ')
  for (let fixture = 0; fixture < 300; fixture += 1) {
    const leftCount = Math.floor(random() * 21)
    const rightCount = Math.floor(random() * 21)
    const values = (count: number): number[] =>
      Array.from({ length: count }, () => {
        const roll = random()
        if (roll < 0.08) return 0
        const magnitude = Math.round(random() * 10_000) / 10
        return random() < 0.4 ? -magnitude : magnitude
      })
    const left = numberText(values(leftCount))
    const right = numberText(values(rightCount))
    assert.equal(compareAgreement(left, right), referenceAgreement(left, right), `fixture ${fixture}`)
  }

  // Fixed edge cases: exact, duplicate, sign, zero and no-number mixes.
  const cases: Array<[string, string]> = [
    ['0', '0'],
    ['0', '1'],
    ['-5 5', '-5 5'],
    ['-5 5', '-50 50'],
    ['0 0 0', '0'],
    ['1.5 2.5', '2.5 1.5'],
    ['100 200 300', '300 200 100'],
    ['-0.5', '0.5'],
    ['no numbers here', 'no numbers here'],
  ]
  for (const [left, right] of cases) {
    assert.equal(compareAgreement(left, right), referenceAgreement(left, right), `${left} vs ${right}`)
  }
})

test('red-black numeric agreement stays linear-ish on numeric-heavy text', () => {
  const random = randomSource(0xdead_5eed)
  const values = (count: number): number[] =>
    Array.from({ length: count }, () => Math.round((random() * 2 - 1) * 100_000) / 10)
  const leftNumbers = values(2_000)
  const rightNumbers = values(2_000)
  const left = leftNumbers.join(' ')
  const right = rightNumbers.join(' ')

  const productionStart = performance.now()
  const production = compareAgreement(left, right)
  const productionElapsed = performance.now() - productionStart

  const referenceStart = performance.now()
  const reference = referenceAgreement(left, right)
  const referenceElapsed = performance.now() - referenceStart

  assert.equal(production, reference)
  assert.ok(productionElapsed < 5_000, `tree agreement took ${productionElapsed.toFixed(1)}ms (limit 5000ms)`)
  assert.ok(referenceElapsed < 5_000, `reference agreement took ${referenceElapsed.toFixed(1)}ms (limit 5000ms)`)
  console.log(
    `[adoption] numeric agreement 2k×2k: tree ${productionElapsed.toFixed(1)}ms, brute ${referenceElapsed.toFixed(1)}ms`,
  )
})

/* ------------------------------------------------------------------------- *
 * 7. SparseGrid readiness (no host sheet consumer yet) + B+ tree benchmark
 * ------------------------------------------------------------------------- */

test('SparseGrid models a sheet range without dense allocation', () => {
  const grid = new SparseGrid<string>()
  grid.set(0, 0, 'a')
  grid.set(1, 2, 'b')
  grid.set(2, 1, 'c')
  grid.set(2, 3, 'd')
  assert.equal(grid.size, 4)
  assert.deepEqual(grid.rowAt(2).map((cell) => [cell.row, cell.column, cell.value]), [
    [2, 1, 'c'],
    [2, 3, 'd'],
  ])
  assert.deepEqual(grid.columnAt(2).map((cell) => [cell.row, cell.column, cell.value]), [[1, 2, 'b']])
  assert.deepEqual(grid.range(new GridRange(1, 1, 2, 3)).map((cell) => cell.value), ['b', 'c', 'd'])
  assert.deepEqual(grid.bounds(), new GridRange(0, 0, 2, 3))

  // Far coordinates stay sparse: no dense rows/columns are ever allocated.
  grid.set(1_000_000, 999_999, 'far')
  assert.equal(grid.get(1_000_000, 999_999), 'far')
  assert.equal(grid.size, 5)
  assert.equal(grid.rowAt(1_000_000).length, 1)
})

test('B+ tree indexes a 10k posterior-shaped range index within the bound', () => {
  const start = performance.now()
  const tree = new BPlusTree<number, number>(8)
  for (let index = 0; index < 10_000; index += 1) tree.set(index, index * 2)
  const values: number[] = []
  for (const [, value] of tree.range(2_500, 7_500)) values.push(value)
  const elapsed = performance.now() - start
  assert.equal(tree.size, 10_000)
  assert.equal(values.length, 5_001)
  assert.equal(values[0], 5_000)
  assert.equal(values[values.length - 1], 15_000)
  assert.ok(elapsed < 5_000, `10k B+ tree build+range took ${elapsed.toFixed(1)}ms (limit 5000ms)`)
  console.log(`[adoption] B+ tree 10k set + 5k range: ${elapsed.toFixed(1)}ms`)
})
