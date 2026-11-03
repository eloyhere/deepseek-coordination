import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { canonical, digestOf } from 'attention-manifest-protocol/semantic/canonical.js'
import { deriveConfidence, validateClaim } from 'attention-manifest-protocol/warrant/warrant.js'

const require = createRequire(import.meta.url)

interface AmpPackageManifest {
  version: string
  engines?: { node?: string }
}

test('AMP production helpers resolve from the npm package', () => {
  const manifest = require('attention-manifest-protocol/package.json') as AmpPackageManifest
  // 0.6.0 is the latest published AMP release; the wire tag stays `0.1`.
  assert.equal(manifest.version, '0.6.0')
  assert.equal(manifest.engines?.node, '>=24')
  assert.equal(canonical({ z: 1, a: 2 }), '{"a":2,"z":1}')
  assert.match(digestOf({ amp: '0.1' }), /^sha256:[0-9a-f]{64}$/)
  assert.equal(typeof deriveConfidence, 'function')
  assert.equal(typeof validateClaim, 'function')
})
