/**
 * S3 release-contract tests.
 *
 * These are static checks over checked-in files: the npm manifest, the build and
 * pack configuration, and `wire.md`. Nothing here builds, starts an HTTP
 * server, touches the network or imports `lib/`, so the test also runs on a
 * clean checkout before `npm run build`.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/** Repository root, derived from this file instead of the process cwd. */
const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/** Runtime artifacts the published package must contain. */
const REQUIRED_FILES = [
  'wire.md',
  'lib/index.mjs',
  'lib/index.d.mts',
  'lib/compaction-backend.mjs',
  'lib/compaction-backend.d.mts',
]

/** Export subpath -> runtime target (without npm's leading `./`). */
const REQUIRED_EXPORTS = new Map([
  ['.', 'lib/index.mjs'],
  ['./compaction-backend', 'lib/compaction-backend.mjs'],
  ['./client', 'lib/client.js'],
])

/** Read one UTF-8 repository file. */
function readText(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/** Parse the checked-in manifest; a malformed manifest fails the calling test. */
function readManifest() {
  const manifest = JSON.parse(readText('package.json'))
  assert.equal(typeof manifest, 'object')
  assert.notEqual(manifest, null)
  return manifest
}

/** Strip the leading `./` npm writes so targets compare with `files` paths. */
function withoutDotSlash(value) {
  return value.startsWith('./') ? value.slice(2) : value
}

/** Resolve one `exports` entry to its normalized default/import/require target. */
function targetOf(value) {
  if (typeof value === 'string') return withoutDotSlash(value)
  if (typeof value !== 'object' || value === null) return undefined
  return targetOf(value.default ?? value.import ?? value.require)
}

test('scripts.test registers every test/*.test.mjs file', () => {
  const manifest = readManifest()
  const scripts = manifest.scripts
  assert.equal(typeof scripts, 'object')
  assert.notEqual(scripts, null)
  assert.equal(typeof scripts.test, 'string')
  const registered = scripts.test.split(/\s+/)
  const names = readdirSync(join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
  assert.ok(names.length > 0, 'test/ must contain at least one *.test.mjs file')
  for (const name of names) {
    assert.ok(registered.includes(`test/${name}`), `scripts.test is missing test/${name}`)
  }
})

test('manifest publishes the attention runtime and compaction backend', () => {
  const manifest = readManifest()
  assert.ok(Array.isArray(manifest.files), 'files must be an array')
  for (const path of REQUIRED_FILES) {
    assert.ok(manifest.files.includes(path), `files is missing ${path}`)
  }
  for (const [subpath, expected] of REQUIRED_EXPORTS) {
    const target = targetOf(manifest.exports?.[subpath])
    assert.equal(typeof target, 'string', `exports[${subpath}] has no string target`)
    assert.equal(target, expected, `exports[${subpath}] points at ${String(target)}`)
  }
})

test('build and pack checks cover the compaction-backend subpath', () => {
  for (const path of ['tsdown.config.ts', 'scripts/checkPack.mjs']) {
    assert.ok(readText(path).includes('compaction-backend'), `${path} must mention compaction-backend`)
  }
})

test('wire.md documents the S1/S2 observability names', () => {
  const wire = readText('wire.md')
  for (const keyword of ['contextDiagnostics', 'lastCapture', 'faultInjection']) {
    assert.ok(wire.includes(keyword), `wire.md must mention ${keyword}`)
  }
})
