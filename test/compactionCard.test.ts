/**
 * Compaction-time state-card snapshot.
 *
 * The plugin owns the automatic compaction proposal (`agent/pre-step` →
 * `maybeCompact`), so it can capture the durable card immediately before DSH
 * rewrites the history. This test drives the real `CoordinationService` with a
 * fake `CompactionPort`, creates an active goal (so the card has an objective)
 * and a governor-tripping message list, then asserts the capture.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CoordinationService } from '../src/host/coordination.js'
import type { CompactionPort, DshRuntime } from '../src/host/dsh.js'
import { testConfig, insertSession } from './helpers.js'

test('maybeCompact captures the state card before the history is rewritten', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coordination-compaction-card-'))
  const calls: string[] = []
  const compaction: CompactionPort = {
    async compactNow() {
      calls.push('compactNow')
      return null
    },
    async compactIfNeeded(_agent, trigger) {
      calls.push(trigger)
      return { compacted: true }
    },
  }
  const config = testConfig({
    databasePath: join(directory, 'coordination.db'),
    compaction: { auto: true, soft: 0.5, hard: 0.8, reserve: 0, recentTurns: 1, cooldown: 0, maxPerSession: 5 },
  })
  const runtime: DshRuntime = {
    rawSession: () => undefined,
    rawAgent: () => undefined,
    compaction,
  }
  const context = { reflect: { provide: (): void => {} } } as unknown as Context
  const service = new CoordinationService(context, config, runtime)
  try {
    insertSession(service.db, 's-compact')
    const putGoal = service.planning.putGoal.bind(service.planning)
    putGoal('s-compact', {
      amp: '0.1', kind: 'goal', id: 'goal-compact', statement: 'Ship the compaction card',
      success: [{ id: 'criterion', statement: 'The card is captured', check: 'assert card defined' }],
      value: 1, priority: 1,
    } as Parameters<typeof putGoal>[1])
    service.planning.transitionGoal('s-compact', 'goal-compact', 'committed')
    service.planning.transitionGoal('s-compact', 'goal-compact', 'active')

    const messages = [{ role: 'user', content: 'x'.repeat(2_000_000) }]
    const result = await service.maybeCompact('s-compact', messages)
    assert.equal(result.action, 'compacted')
    assert.deepEqual(calls, ['context-overflow'], 'an over-window step asks for overflow compaction')

    const card = service.compactionCardOf('s-compact')
    assert.ok(card, 'the pre-compaction card was captured')
    assert.equal(card.durable, true)
    assert.equal(card.objective, 'Ship the compaction card')
    assert.match(String(card.next), /^Advance goal goal-compact/)
  } finally {
    service.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a refused compaction keeps no snapshot and a later session sees none', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coordination-compaction-skip-'))
  const compaction: CompactionPort = {
    async compactNow() {
      return null
    },
    async compactIfNeeded() {
      return null
    },
  }
  const config = testConfig({
    databasePath: join(directory, 'coordination.db'),
    compaction: { auto: true, soft: 0.5, hard: 0.8, reserve: 0, recentTurns: 1, cooldown: 0, maxPerSession: 5 },
  })
  const service = new CoordinationService(
    { reflect: { provide: (): void => {} } } as unknown as Context,
    config,
    { rawSession: () => undefined, rawAgent: () => undefined, compaction },
  )
  try {
    const result = await service.maybeCompact('s-skip', [{ role: 'user', content: 'x'.repeat(2_000_000) }])
    assert.equal(result.action, 'none')
    assert.equal(service.compactionCardOf('s-skip'), undefined)
  } finally {
    service.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
