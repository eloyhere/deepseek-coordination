/**
 * Complexity and performance guards for the token governor.
 *
 * These are contract tests, not micro-benchmarks: the bounds are generous on
 * purpose (a shared CI box can be 5x slower than a workstation) while still
 * failing outright if someone replaces the linear estimator with a regex loop,
 * adds a per-character allocation, or introduces pairwise O(n^2) similarity in
 * selection. The exact operation counts are asserted through
 * `tokenDiagnostics`, so a "faster" implementation that silently scores a
 * chunk twice still fails.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TokenPolicy,
  budgetFor,
  estimateMessages,
  estimateTokens,
  selectContext,
  tokenDiagnostics,
} from '../src/host/token.js'
import type { ContextChunk } from '../src/host/token.js'

function elapsed(action: () => void): number {
  const started = performance.now()
  action()
  return performance.now() - started
}

test('estimateTokens scans 1M characters in one linear pass', () => {
  tokenDiagnostics.reset()
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(25_000)
  assert.ok(text.length >= 1_000_000)

  let tokens = 0
  const first = elapsed(() => {
    tokens = estimateTokens(text)
  })
  assert.ok(tokens > 100_000)
  assert.ok(first < 200, `1M-character estimate took ${first.toFixed(1)}ms (limit 200ms)`)

  // The second call is an O(1) memo hit: a constant 128-character sample is
  // compared, never the million-character body.
  const hitsBefore = tokenDiagnostics.memoHits
  const missesBefore = tokenDiagnostics.memoMisses
  let repeated = 0
  const second = elapsed(() => {
    repeated = estimateTokens(text)
  })
  assert.equal(repeated, tokens)
  assert.equal(tokenDiagnostics.memoHits, hitsBefore + 1)
  assert.equal(tokenDiagnostics.memoMisses, missesBefore)
  assert.ok(second < 50, `memo hit took ${second.toFixed(1)}ms (limit 50ms)`)
})

test('estimateMessages is linear and depth-capped instead of recursive forever', () => {
  tokenDiagnostics.reset()
  const messages = Array.from({ length: 2_000 }, (_unused, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `message number ${index} with a little text` }],
  }))
  let tokens = 0
  const time = elapsed(() => {
    tokens = estimateMessages(messages)
  })
  assert.ok(tokens > 2_000 * TokenPolicy.messageOverheadTokens)
  assert.ok(time < 100, `2,000-message estimate took ${time.toFixed(1)}ms (limit 100ms)`)

  // A cyclic content object must terminate at the depth cap, not recurse.
  const cyclic: Record<string, unknown> = {}
  cyclic.content = cyclic
  assert.equal(estimateMessages([{ role: 'user', content: cyclic }]), TokenPolicy.messageOverheadTokens)
})

test('selectContext scores 20,000 chunks once and sorts within the bound', () => {
  tokenDiagnostics.reset()
  const chunks: ContextChunk[] = Array.from({ length: 20_000 }, (_unused, index) => ({
    id: `chunk-${index}`,
    kind: index % 7 === 0 ? 'evidence' : 'history',
    text: `chunk number ${index} with some representative context text`,
    tokens: 20 + (index % 5),
    score: (index % 100) / 100,
    created: index,
  }))
  const budget = budgetFor(2_000_000)

  let result: ReturnType<typeof selectContext> | undefined
  const time = elapsed(() => {
    result = selectContext(chunks, budget)
  })
  assert.ok(result !== undefined)
  assert.ok(time < 500, `20,000-chunk selection took ${time.toFixed(1)}ms (limit 500ms)`)

  // Exactly one scoring pass, one dedupe key per surviving/accepted chunk, and
  // O(n) Set memory: the signatures are never compared pairwise.
  assert.equal(tokenDiagnostics.lastSelect.chunks, 20_000)
  assert.equal(tokenDiagnostics.lastSelect.scored, 20_000)
  assert.ok(tokenDiagnostics.lastSelect.dedupeKeys <= 20_000)
  assert.equal(result.selected.length + result.dropped.length, 20_000)
  // The full budget fits every chunk, so nothing is dropped by capacity.
  assert.equal(result.dropped.length, 0)
  assert.ok(result.estimated > 0)
})

test('the estimator memo is bounded at 256 entries and returns stable values', () => {
  tokenDiagnostics.reset()
  const first = 'compaction checkpoint '.repeat(50)
  const value = estimateTokens(first)
  assert.equal(estimateTokens(first), value)

  for (let index = 0; index < 300; index += 1) {
    estimateTokens(`memo probe ${index} ` + 'q'.repeat(500))
  }
  assert.equal(tokenDiagnostics.memoEntries, TokenPolicy.estimator.memoCapacity)
  assert.ok(tokenDiagnostics.memoEntries <= 256)
  // Memory is bounded by entries, not by total characters ever estimated.
  assert.ok(tokenDiagnostics.memoHits >= 1)
})
