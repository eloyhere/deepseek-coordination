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
