/**
 * Settings-store audit (v24 §19 persistence).
 *
 * The page's durable edits live in one small JSON document beside the
 * coordination database. These tests cover the four behaviours the route
 * depends on: a missing document means "no overrides", a corrupt document
 * degrades instead of throwing, a write merges into what is already stored, and
 * the deployment secrets can never be persisted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOverrides, settingsPath, writeOverrides } from '../src/host/settings-store.js'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a missing document is no overrides, not an error', () => {
  withTempDir((dir) => {
    const file = join(dir, 'nested', 'config.overrides.json')
    assert.deepEqual(readOverrides(file), {})
  })
})

test('a corrupt or non-object document degrades to no overrides', () => {
  withTempDir((dir) => {
    const file = join(dir, 'config.overrides.json')
    writeFileSync(file, '{ not json', 'utf8')
    assert.deepEqual(readOverrides(file), {})
    writeFileSync(file, '["plan.threshold"]', 'utf8')
    assert.deepEqual(readOverrides(file), {})
  })
})

test('non-scalar entries and the deployment secrets are dropped on read', () => {
  withTempDir((dir) => {
    const file = join(dir, 'config.overrides.json')
    writeFileSync(file, JSON.stringify({
      'plan.threshold': 0.7,
      'ui.compact': false,
      'parser.cacheCapacity': 42,
      database: 'secret',
      databasePath: 'C:/secret.db',
      'plan.weights': { coverage: 0.5 },
      'defaults.scene': null,
    }), 'utf8')
    assert.deepEqual(readOverrides(file), {
      'plan.threshold': 0.7,
      'ui.compact': false,
      'parser.cacheCapacity': 42,
    })
  })
})

test('a write merges into the stored document and creates its directory', () => {
  withTempDir((dir) => {
    const file = join(dir, 'state', 'config.overrides.json')
    assert.equal(writeOverrides(file, { 'plan.threshold': 0.6 }), true)
    assert.equal(writeOverrides(file, { 'ui.compact': false, 'plan.threshold': 0.8 }), true)
    assert.deepEqual(readOverrides(file), { 'plan.threshold': 0.8, 'ui.compact': false })
    // The document is human-readable and stable, so a reviewer can diff it.
    const text = readFileSync(file, 'utf8')
    assert.match(text, /"plan\.threshold": 0\.8/)
    assert.ok(text.endsWith('\n'))
  })
})

test('the database location decides where the document lives', () => {
  const path = settingsPath(join('C:', 'data', 'coordination', 'coordination.db'))
  assert.equal(path, join('C:', 'data', 'coordination', 'config.overrides.json'))
})
