import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  MAX_TEX_SYNC_BYTES,
  MAX_TEX_SYNC_GZIP_BYTES,
  MAX_TEX_SYNC_RECORDS,
  inflateTexSync,
  texSyncCandidate,
  texSyncPage,
} from '../src/host/texSync.js'

function fixture(inputs: string[], sheets: string[]): string {
  return [
    'SyncTeX Version:1', ...inputs, 'Output:pdf', 'Magnification:1000',
    'Unit:1', 'X Offset:0', 'Y Offset:0', 'Content:', ...sheets,
    'Postamble:', 'Count:5', 'Post scriptum:', '',
  ].join('\n')
}

const sync = fixture(['Input:1:./paper/main.tex', 'Input:2:./paper/other.tex'], [
  '{1', '[1,10:4736286,46220574:26673152,35887000,0',
  '(1,12:4736286,8865054:26673152,455111,0', 'h1,13:4736286,8865054:0,455111,0', ')', ']', '}1',
  '{2', '[2,20:4736286,46220574:26673152,35887000,0',
  'x1,30:4736286,8865054', '$1,31:4736286,8865054', ']', '}2',
])

test('SyncTeX derives only adjacent artifacts from workspace-relative TeX paths', () => {
  assert.equal(texSyncCandidate('paper/main.tex'), 'paper/main.synctex.gz')
  assert.equal(texSyncCandidate('./paper/main.LTX'), 'paper/main.synctex.gz')
  assert.equal(texSyncCandidate('paper\\main.latex'), 'paper/main.synctex.gz')
  for (const path of ['../main.tex', '/tmp/main.tex', 'C:\\tmp\\main.tex', '\\\\server\\main.tex', 'paper/a:main.tex', 'main.pdf', 'paper//main.tex', 'main.tex\0']) {
    assert.equal(texSyncCandidate(path), undefined, path)
  }
})

test('SyncTeX maps real sheet/source record syntax and nearest line deterministically', () => {
  assert.equal(texSyncPage(sync, 'paper/main.tex', 10), 1)
  assert.equal(texSyncPage(sync, 'paper/main.tex', 30), 2)
  assert.equal(texSyncPage(sync, 'paper/main.tex', 31), 2)
  assert.equal(texSyncPage(sync, 'paper/main.tex', 23), 2)
  assert.equal(texSyncPage(sync, 'paper/other.tex', 20), 2)
  // Nearest 13 and 30 tie at 21.5, use an explicit even-line fixture.
  const tie = fixture(['Input:1:main.tex'], ['{1', 'h1,10:0,0:0,0,0', '}1', '{2', 'h1,20:0,0:0,0,0', '}2'])
  assert.equal(texSyncPage(tie, 'main.tex', 15), 2)
  const repeated = fixture(['Input:1:main.tex'], ['{2', 'h1,10:0,0:0,0,0', '}2', '{1', 'h1,10:0,0:0,0,0', '}1'])
  assert.equal(texSyncPage(repeated, 'main.tex', 10), 1)
})

test('SyncTeX tolerates Windows absolute input metadata and optional source columns', () => {
  const absolute = fixture(['Input:7:R:\\compiler\\paper\\main.tex'], ['{4', '[7,42,3:0,0:0,0,0', '}4'])
  assert.equal(texSyncPage(absolute, 'paper/main.tex', 42), 4)
  assert.equal(texSyncPage(absolute.replace(/\n/g, '\r\n'), 'paper/main.tex', 42), 4)
})

test('SyncTeX refuses ambiguous basename tags, conflicting tags and missing mapping', () => {
  const ambiguous = fixture(['Input:1:/a/main.tex', 'Input:2:/b/main.tex'], ['{1', 'h1,10:0,0:0,0,0', '}1'])
  assert.equal(texSyncPage(ambiguous, 'paper/main.tex', 10), undefined)
  const exact = fixture(['Input:1:paper/main.tex', 'Input:2:/b/main.tex'], ['{3', 'h1,10:0,0:0,0,0', '}3'])
  assert.equal(texSyncPage(exact, 'paper/main.tex', 10), 3)
  const conflict = fixture(['Input:1:main.tex', 'Input:1:other.tex'], ['{1', 'h1,10:0,0:0,0,0', '}1'])
  assert.equal(texSyncPage(conflict, 'main.tex', 10), undefined)
  assert.equal(texSyncPage(sync, 'missing.tex', 10), undefined)
  assert.equal(texSyncPage(sync.replace('SyncTeX Version:1', 'SyncTeX Version:2'), 'paper/main.tex', 10), undefined)
  assert.equal(texSyncPage(fixture(['Input:1:main.tex'], ['h1,10:0,0:0,0,0']), 'main.tex', 10), undefined)
})

test('SyncTeX rejects invalid requested lines, pages and budget excesses', () => {
  for (const line of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(texSyncPage(sync, 'paper/main.tex', line), undefined)
  }
  for (const page of ['0', '-1', '100001', '9007199254740992']) {
    assert.equal(texSyncPage(fixture(['Input:1:main.tex'], [`{${page}`, 'h1,10:0,0:0,0,0']), 'main.tex', 10), undefined)
  }
  assert.equal(texSyncPage('x'.repeat(MAX_TEX_SYNC_BYTES + 1), 'main.tex', 10), undefined)
  assert.equal(texSyncPage(fixture(['Input:1:main.tex'], Array(MAX_TEX_SYNC_RECORDS).fill('h1,10:0,0:0,0,0')), 'main.tex', 10), undefined)
  assert.equal(texSyncPage(sync + '\0', 'paper/main.tex', 10), undefined)
})

test('SyncTeX gzip inflation is bounded and requires valid UTF-8', () => {
  assert.equal(inflateTexSync(gzipSync(sync)), sync)
  assert.equal(inflateTexSync(Buffer.from('not gzip')), undefined)
  assert.equal(inflateTexSync(gzipSync(Buffer.from([0xff, 0xfe]))), undefined)
  assert.equal(inflateTexSync(gzipSync('x\0y')), undefined)
  assert.equal(inflateTexSync(gzipSync('x'.repeat(MAX_TEX_SYNC_BYTES + 1))), undefined)
  assert.equal(inflateTexSync(new Uint8Array(MAX_TEX_SYNC_GZIP_BYTES + 1)), undefined)
})
