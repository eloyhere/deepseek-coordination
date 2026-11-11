/**
 * AMP context-prune state machine.
 *
 * These tests drive AMP's real planner, approval, compaction and verification
 * functions — the point is that the plugin does not re-implement the policy.
 * The one local helper (`applyContextPrune`) exists because AMP 0.9.1 publishes
 * the `approved -> applied` edge in `CONTEXT_PRUNE_TRANSITIONS` but not the
 * function; the first test pins that mirror.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONTEXT_PRUNE_TRANSITIONS,
  approveContextPrune,
  planContextPrune,
} from 'attention-manifest-protocol/context'
import { ContextPruner, applyContextPrune, candidateOf, pruneRecordCandidate } from '../src/host/contextPrune.ts'

const NOW = '2026-01-01T00:00:00.000Z'

/** One prune candidate with a distinct recency order. */
function candidate(index, tokens = 100) {
  const minute = String(index).padStart(2, '0')
  return {
    id: `attention:entry-${index}`,
    tokens,
    score: 0.5,
    createdAt: `2026-01-01T00:${minute}:00.000Z`,
    lastAccessAt: `2026-01-01T00:${minute}:00.000Z`,
    references: [],
  }
}

test('the approved -> applied edge AMP publishes is the edge the host mirrors', () => {
  const plan = planContextPrune([candidate(1)], { keepRecent: 1 }, { now: NOW })
  assert.equal(plan.state, 'draft')
  assert.ok(CONTEXT_PRUNE_TRANSITIONS.approved.includes('applied'))

  const approved = approveContextPrune(plan)
  const applied = applyContextPrune(approved)
  assert.equal(applied.state, 'applied')
  assert.equal(applied.version, approved.version + 1)
  assert.equal(applied.digest, approved.digest, 'applying must not rewrite the decision digest')
  assert.throws(() => applyContextPrune(plan), /cannot apply/)
})

test('review plans, applies, compacts and verifies against AMP', () => {
  const pruner = new ContextPruner({ keepRecent: 1, maxEntries: 10, maxTokens: 10_000 })
  const candidates = [candidate(1), candidate(2), candidate(3), candidate(4)]

  const outcome = pruner.review(candidates, 'unit test')
  assert.notEqual(outcome, undefined)
  const value = outcome
  assert.equal(value.state, 'applied')
  assert.equal(value.verified, true)
  assert.equal(value.checkpoint.state, 'verified')
  assert.equal(value.kept, 1, 'keepRecent keeps the most recently accessed entry')
  assert.equal(value.pruned, 3)
  assert.equal(value.savedTokens, 300)
  assert.equal(value.decisionCount, 4)
  assert.equal(value.decisions.length, 4)

  const stats = pruner.stats()
  assert.equal(stats.reviews, 1)
  assert.equal(stats.applied, 1)
  assert.equal(stats.verified, 1)
  assert.equal(stats.failed, 0)
  assert.equal(stats.lastPruned, 3)
  assert.equal(stats.lastKept, 1)
  assert.equal(stats.savedTokens, 300)
})

test('nothing to decide yields no outcome and no counters', () => {
  const pruner = new ContextPruner()
  assert.equal(pruner.review([]), undefined)
  assert.equal(pruner.stats().reviews, 0)
  assert.equal(pruner.stats().failed, 0)
})

test('invalid policy bounds fall back instead of throwing', () => {
  const pruner = new ContextPruner({ keepRecent: Number.NaN, maxEntries: -3, maxTokens: Number.POSITIVE_INFINITY })
  const policy = pruner.effectivePolicy
  assert.equal(policy.keepRecent, 24)
  assert.equal(policy.maxEntries, 200)
  assert.equal(policy.maxTokens, 20_000)
})

test('candidateOf projects summary cost, priority and mount state', () => {  const object = {
    id: 'attention:one',
    summary: 'abc',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: '2026-01-01T01:00:00.000Z',
    mounted: true,
    intensity: 0.5,
    scores: { relevance: 1, urgency: 1, confidence: 1, importance: 1 },
    references: { evidence: [{ id: 'evidence:1' }], receipts: [] },
  }
  const candidate = candidateOf(object, true)
  assert.equal(candidate.id, 'attention:one')
  assert.equal(candidate.active, true)
  assert.equal(candidateOf(object).active, undefined, 'active is the caller\'s decision, not mounted')
  assert.equal(candidate.score, 4.5)
  assert.equal(candidate.tokens, Math.ceil((3 + 160) / 4))
  assert.deepEqual(candidate.references, ['evidence:1'])
})

test('a DSH prune record enters the same planner as a superseded candidate', () => {
  const record = {
    sessionId: 'session-1',
    shadowedRange: { start: 3, end: 9 },
    shadowedSeqs: [3],
    shadowedTokenCount: 400,
    replacementSeq: 11,
    at: NOW,
    callId: 'call-1',
  }
  const candidate = pruneRecordCandidate('session-1', record)
  assert.equal(candidate.id, 'dsh:prune:session-1:3')
  assert.equal(candidate.supersededBy, 'dsh:prune:session-1:11')
  assert.equal(candidate.tokens, 400)
  assert.deepEqual(candidate.references, ['dsh:tool:call-1'])

  const pruner = new ContextPruner({ keepRecent: 0 })
  const outcome = pruner.review([candidate])
  assert.equal(outcome.pruned, 1)
  assert.equal(outcome.decisions[0].reason, 'superseded')
  assert.equal(outcome.savedTokens, 400)
})
