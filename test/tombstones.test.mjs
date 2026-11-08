/**
 * R2 tombstone tests.
 *
 * `tombstones.ts` is TypeScript and is imported directly with Node 24 type
 * stripping. The module has no runtime `.js` imports of its own, but the same
 * resolve hook as `channelsInput.test.mjs` is kept so importing the optimizer
 * or the wire envelope later cannot break on the repository's `.js` specifier
 * convention. The final test drives the real AMP compiler: it proves an
 * unmounted tombstone becomes a compiler `unmounted` exclusion.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL !== undefined &&
      specifier.endsWith('.js') &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      const mapped = `${specifier.slice(0, -3)}.ts`
      try {
        if (existsSync(fileURLToPath(new URL(mapped, context.parentURL)))) {
          return nextResolve(mapped, context)
        }
      } catch {
        // Fall through to the original specifier.
      }
    }
    return nextResolve(specifier, context)
  },
})

const { MAX_TOMBSTONES, baseWireId, diffTombstones } = await import('../src/host/tombstones.ts')
const { compileContext } = await import('attention-manifest-protocol/attention')

const NOW = '2026-01-01T00:00:00.000Z'
const TURN_ID = 'turn-9'
const SCOPE = {
  tenantId: 'tenant-1',
  principalId: 'session-1',
  sessionId: 'session-1',
  turnId: 'turn-2',
}

/** One complete wire item; only the tombstone fields are exercised. */
function wireItem(id, overrides = {}) {
  return {
    id,
    channel: 'tool',
    scope: { ...SCOPE },
    pointer: { kind: 'tool', id: `call-${id}`, version: 'seq:7' },
    summary: `summary for ${id}`,
    scores: { relevance: 0.8, urgency: 0.6, confidence: 0.8, importance: 0.7 },
    budget: { tokens: 256 },
    expiresAt: '2026-01-01T01:00:00.000Z',
    reason: 'test item',
    trust: 'host',
    ...overrides,
  }
}

/** Build the previous-step map exactly as the optimizer does. */
function previousMap(...items) {
  return new Map(items.map((item) => [baseWireId(item.id), item]))
}

test('baseWireId strips only a trailing numeric step suffix', () => {
  assert.equal(baseWireId('dsh:tool:session-1:2:tool-1-s3'), 'dsh:tool:session-1:2:tool-1')
  assert.equal(baseWireId('dsh:prompt:session-1:2:prompt-s10'), 'dsh:prompt:session-1:2:prompt')
  assert.equal(baseWireId('dsh:file:session-1:2:file-1-s1'), 'dsh:file:session-1:2:file-1')
  assert.equal(baseWireId('dsh:tool:session-1:2:tool-1'), 'dsh:tool:session-1:2:tool-1')
  assert.equal(baseWireId('dsh:tool:session-1:2:tool-1-sx'), 'dsh:tool:session-1:2:tool-1-sx')
  assert.equal(baseWireId('dsh:tool:session-1:2:tool-1-s'), 'dsh:tool:session-1:2:tool-1-s')
  assert.equal(baseWireId('dsh:tool:session-1:2:s3-tool-1'), 'dsh:tool:session-1:2:s3-tool-1')
  assert.equal(baseWireId(''), '')
  assert.equal(baseWireId(undefined), '')
})

test('a removed item becomes one unmounted tombstone and next holds only current items', () => {
  const a = wireItem('dsh:tool:session-1:2:tool-1', { summary: `x${'y'.repeat(1000)}` })
  const b = wireItem('dsh:tool:session-1:2:tool-2')
  const c = wireItem('dsh:tool:session-1:2:tool-3')
  const previous = previousMap(a, b)
  const { tombstones, next } = diffTombstones(previous, [b, c], SCOPE, TURN_ID, NOW)

  assert.equal(tombstones.length, 1)
  const tombstone = tombstones[0]
  assert.equal(tombstone.id, a.id)
  assert.equal(tombstone.version, 1)
  assert.equal(tombstone.mounted, false)
  assert.equal(tombstone.stale, false)
  assert.equal(tombstone.summary.length, 601)
  assert.equal(tombstone.summary.startsWith('xy'), true)
  assert.equal(tombstone.summary.endsWith('…'), true)
  assert.deepEqual(tombstone.pointer, a.pointer)
  assert.notEqual(tombstone.pointer, a.pointer)
  assert.deepEqual(tombstone.pointer, { ...a.pointer })
  assert.equal(tombstone.pointer.version, 'seq:7')
  assert.deepEqual(tombstone.sources, [])
  assert.deepEqual(tombstone.references, { evidence: [], receipts: [], capabilities: [], behaviors: [] })
  assert.equal(tombstone.scope.tenantId, SCOPE.tenantId)
  assert.equal(tombstone.scope.principalId, SCOPE.principalId)
  assert.equal(tombstone.scope.sessionId, SCOPE.sessionId)
  assert.equal(tombstone.scope.turnId, TURN_ID)
  assert.deepEqual(tombstone.scores, { relevance: 0, urgency: 0, confidence: 0, importance: 0 })
  assert.equal(tombstone.intensity, 0)
  assert.deepEqual(tombstone.budget, { tokens: 1 })
  assert.equal(tombstone.createdAt, NOW)
  assert.equal(tombstone.updatedAt, NOW)
  assert.equal(Date.parse(tombstone.expiresAt), Date.parse(NOW) + 60 * 60 * 1000)
  assert.equal(tombstone.lastReason, 'replaced or removed from the next step')

  assert.equal(next.size, 2)
  assert.equal(next.has(baseWireId(a.id)), false)
  assert.equal(next.get(baseWireId(b.id)), b)
  assert.equal(next.get(baseWireId(c.id)), c)
})

test('a step suffix change replaces an item instead of tombstoning it', () => {
  const previous = previousMap(wireItem('dsh:prompt:session-1:2:prompt-s1', { channel: 'prompt' }))
  const current = [wireItem('dsh:prompt:session-1:2:prompt-s2', { channel: 'prompt' })]
  const { tombstones, next } = diffTombstones(previous, current, SCOPE, TURN_ID, NOW)

  assert.deepEqual(tombstones, [])
  assert.equal(next.size, 1)
  assert.equal(next.has('dsh:prompt:session-1:2:prompt'), true)
  assert.equal(next.get('dsh:prompt:session-1:2:prompt'), current[0])
})

test('later duplicates win and malformed inputs never throw', () => {
  const first = wireItem('dsh:tool:session-1:2:tool-1', { summary: 'first' })
  const second = wireItem('dsh:tool:session-1:2:tool-1-s3', { summary: 'second' })
  assert.deepEqual(diffTombstones(new Map(), [], SCOPE, TURN_ID, NOW), {
    tombstones: [],
    next: new Map(),
  })

  const duplicate = diffTombstones(new Map(), [first, second], SCOPE, TURN_ID, NOW)
  assert.equal(duplicate.next.size, 1)
  assert.equal(duplicate.next.get('dsh:tool:session-1:2:tool-1'), second)

  assert.doesNotThrow(() => diffTombstones(undefined, undefined, SCOPE, TURN_ID, NOW))
  const undefinedInput = diffTombstones(undefined, undefined, SCOPE, TURN_ID, NOW)
  assert.deepEqual(undefinedInput.tombstones, [])
  assert.equal(undefinedInput.next.size, 0)

  const junkInput = diffTombstones(new Map(), [null, 42, 'x', { id: 9 }, { id: '' }], SCOPE, TURN_ID, NOW)
  assert.deepEqual(junkInput.tombstones, [])
  assert.equal(junkInput.next.size, 0)

  const malformedPrevious = new Map([['dsh:tool:session-1:2:tool-1', { id: 'dsh:tool:session-1:2:tool-1', summary: '' }]])
  assert.doesNotThrow(() => diffTombstones(malformedPrevious, [], SCOPE, TURN_ID, NOW))
  assert.deepEqual(diffTombstones(malformedPrevious, [], SCOPE, TURN_ID, NOW).tombstones, [])

  assert.doesNotThrow(() => diffTombstones(new Map(), [], {}, TURN_ID, NOW))
  const invalidScope = diffTombstones(new Map(), [], {}, TURN_ID, NOW)
  assert.deepEqual(invalidScope.tombstones, [])
  assert.equal(invalidScope.next.size, 0)
})

test('MAX_TOMBSTONES keeps the most recent removed items in previous insertion order', () => {
  const removed = Array.from({ length: MAX_TOMBSTONES + 10 }, (_, index) => (
    wireItem(`dsh:tool:session-1:2:item-${String(index)}`)
  ))
  const { tombstones, next } = diffTombstones(previousMap(...removed), [], SCOPE, TURN_ID, NOW)

  assert.equal(tombstones.length, MAX_TOMBSTONES)
  assert.equal(tombstones[0].id, 'dsh:tool:session-1:2:item-10')
  assert.equal(tombstones.at(-1).id, `dsh:tool:session-1:2:item-${String(MAX_TOMBSTONES + 9)}`)
  assert.equal(next.size, 0)
})

test('the real AMP compiler records an unmounted exclusion for a tombstone', () => {
  const removed = wireItem('dsh:tool:session-1:2:tool-1')
  const { tombstones } = diffTombstones(previousMap(removed), [], SCOPE, TURN_ID, NOW)
  const compiled = compileContext(tombstones, {
    now: NOW,
    scope: { ...SCOPE, turnId: TURN_ID },
    budget: { tokens: 1000 },
    currentVersion: (pointer) => pointer.version,
  })

  assert.deepEqual(compiled.items, [])
  assert.equal(compiled.exclusions.length, 1)
  assert.equal(compiled.exclusions[0].id, removed.id)
  assert.equal(compiled.exclusions[0].reason, 'unmounted')
  assert.equal(compiled.exclusions[0].version, 1)
  assert.deepEqual(compiled.exclusions[0].pointer, removed.pointer)
})
