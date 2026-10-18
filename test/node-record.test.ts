/**
 * Node record contract.
 *
 * The record is the only shape that crosses the wire, so these tests pin the
 * three properties that would otherwise drift silently: every field is always
 * present, coordinates are `number` (JSON-safe), and the inline tree obeys the
 * caller's depth limit without cycles.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachChildren,
  countRecords,
  createNodeRecord,
  fromWire,
  limitDepth,
  recordFromFlat,
  toWire,
} from '../src/shared/node-record.js'

test('an empty input still produces every field with its empty value', () => {
  const record = createNodeRecord()
  assert.deepEqual(Object.keys(record).sort(), [
    'brief', 'byte', 'charset', 'children', 'description', 'dirty',
    'fingerprint', 'line', 'path', 'purpose', 'reference', 'summary',
  ])
  assert.equal(record.path, '')
  assert.equal(record.charset, '')
  assert.deepEqual(record.byte, { start: 0, end: 0 })
  assert.deepEqual(record.line, { start: 0, end: 0 })
  assert.equal(record.dirty, false)
  assert.deepEqual(record.children, [])
})

test('flat parser fields map onto nested numeric coordinates', () => {
  const record = recordFromFlat(
    {
      path: 'src/a.ts',
      byteStart: 10,
      byteEnd: 42,
      lineStart: 2,
      lineEnd: 4,
      fingerprint: 'sha256:ab',
      reference: { target: 'symbol:function:f' },
      brief: 'f',
    },
    'utf-8',
  )
  assert.deepEqual(record.byte, { start: 10, end: 42 })
  assert.deepEqual(record.line, { start: 2, end: 4 })
  assert.equal(record.charset, 'utf-8')
  assert.equal(record.reference, 'symbol:function:f')
  assert.equal(record.brief, 'f')
  // Numbers, never bigint: the wire serializer must not throw.
  assert.equal(typeof record.byte.start, 'number')
  assert.doesNotThrow(() => JSON.stringify(toWire(record)))
})

test('a record is JSON-safe and round-trips through the wire', () => {
  const record = createNodeRecord({ path: 'a.md', charset: 'utf-8', byteStart: 1, byteEnd: 2 })
  const wire = JSON.parse(JSON.stringify(toWire(record)))
  assert.deepEqual(fromWire(wire), record)
  // An untrusted/garbage value normalises instead of throwing.
  assert.deepEqual(fromWire(null), createNodeRecord())
})

test('attaching the same record twice is refused, keeping the tree acyclic', () => {
  const child = createNodeRecord({ path: 'child' })
  const parent = attachChildren(createNodeRecord({ path: 'parent' }), [child, child])
  assert.equal(parent.children.length, 1)
  assert.equal(parent.children[0]?.path, 'child')
})

test('the inline depth limit comes from the caller, not a literal', () => {
  const leaf = createNodeRecord({ path: 'leaf' })
  const middle = attachChildren(createNodeRecord({ path: 'middle' }), [leaf])
  const root = attachChildren(createNodeRecord({ path: 'root' }), [middle])

  assert.deepEqual(limitDepth(root, 0).children, [])
  assert.equal(limitDepth(root, 1).children[0]?.path, 'middle')
  assert.equal(limitDepth(root, 1).children[0]?.children.length, 0)
  assert.equal(limitDepth(root, 2).children[0]?.children[0]?.path, 'leaf')
  // The limit never mutates the source tree.
  assert.equal(root.children[0]?.children[0]?.path, 'leaf')
})

test('countRecords counts the whole inline tree', () => {
  const leaf = createNodeRecord({ path: 'leaf' })
  const middle = attachChildren(createNodeRecord({ path: 'middle' }), [leaf])
  const root = attachChildren(createNodeRecord({ path: 'root' }), [middle, createNodeRecord()])
  assert.equal(countRecords(root), 4)
})
