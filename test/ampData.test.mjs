import assert from 'node:assert/strict'
import test from 'node:test'

import { snapshotSignature } from '../src/client/ampData.ts'

test('snapshot signature tolerates a null kernel from an unopened store', () => {
  assert.doesNotThrow(() => snapshotSignature({ kernel: null }, [], [], null))
  assert.match(snapshotSignature({ kernel: null }, [], [], null), /"kernel":null/)
  assert.doesNotThrow(() => snapshotSignature({}, [], [], null))
  assert.doesNotThrow(() => snapshotSignature(null, [], [], null))
  assert.doesNotThrow(() => snapshotSignature({ kernel: { workflowEvents: 1, receiptCount: 2 } }, [], [], null))
})

test('snapshot signature tracks context lag and exclusions', () => {
  const pending = snapshotSignature(null, [], [], null, {
    contextDiagnostics: { lag: 1, compilerExclusions: 0, lastCompileAt: '2026-11-09T00:00:00.000Z' },
    outputs: { spill: { records: 2 } },
  })
  const ready = snapshotSignature(null, [], [], null, {
    contextDiagnostics: { lag: 0, compilerExclusions: 1, lastCompileAt: '2026-11-09T00:00:01.000Z' },
    outputs: { spill: { records: 2 } },
  })
  assert.notEqual(pending, ready)
  assert.match(pending, /"context"/)
  assert.doesNotThrow(() => snapshotSignature(null, [], [], null, null))
})
