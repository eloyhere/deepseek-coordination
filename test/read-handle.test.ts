/**
 * `nodeReadDefaults` — the AMP 0.6.0 range bridge used by `coordination_read`.
 *
 * Outline ranges are half-open UTF-8 bytes and inclusive 1-based lines over the
 * raw file; `coordination_read` counts decoded text. These tests pin the
 * conversion the bridge performs, especially the BOM shift that a naive
 * `byteStart` copy would get wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InvalidArgumentError } from '../src/shared/error.js'
import { nodeReadDefaults } from '../src/host/tools.js'

test('lines address passes through as a 1-based inclusive range', () => {
  const defaults = nodeReadDefaults({ lineStart: 10, lineEnd: 12, byteStart: 100, byteEnd: 140 }, 'lines')
  assert.deepEqual(defaults, { mode: 'lines', start: 10, end: 12 })
})

test('byte address is the decoded-text offset, not the raw one', () => {
  const plain = nodeReadDefaults({ lineStart: 1, lineEnd: 1, byteStart: 100, byteEnd: 140 }, 'bytes')
  assert.deepEqual(plain, { mode: 'bytes', start: 100, end: 140 })

  // A UTF-8 BOM is stripped before decoding, so a raw offset 3 bytes into the
  // file is decoded offset 0; AMP's bridge removes the prefix for us.
  const bom = nodeReadDefaults(
    { lineStart: 1, lineEnd: 1, byteStart: 103, byteEnd: 143, charset: 'utf-8-bom' },
    'bytes',
  )
  assert.deepEqual(bom, { mode: 'bytes', start: 100, end: 140 })
})

test('a reversed or empty range fails closed instead of clamping', () => {
  assert.throws(
    () => nodeReadDefaults({ lineStart: 12, lineEnd: 10 }, 'lines'),
    (error: unknown) => error instanceof InvalidArgumentError,
  )
  assert.throws(
    () => nodeReadDefaults({ byteStart: 140, byteEnd: 100, lineStart: 1, lineEnd: 1 }, 'bytes'),
    (error: unknown) => error instanceof InvalidArgumentError,
  )
})

test('a node without a line range still addresses its first line', () => {
  const defaults = nodeReadDefaults({}, 'lines')
  assert.deepEqual(defaults, { mode: 'lines', start: 1, end: 1 })
})
