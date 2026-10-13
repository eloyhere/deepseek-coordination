// takeover.test.mjs - the byte-level promises the takeover makes, proven against real files.
//
// The interception's whole justification is that it changes WHERE a value comes from without changing
// what the result means. Two of those promises are testable without a running harness, because they are
// pure functions over bytes:
//
//   1. writing through the takeover preserves the target's BOM and line-ending convention while the
//      VALUE reported to the model stays normalised text — the split that makes a diff card correct and
//      the file on disk unchanged in convention;
//   2. a read window is sliced from the verb's own structured lines rather than re-derived from its
//      truncated `text`, which is what keeps `totalLines` right for a file larger than the verb's cap.
//
// A third group pins the eligibility rule, because every one of those conditions exists to keep a call
// on the built-in path rather than answer it somewhere the model did not ask for.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let passes = 0
let failures = 0
const ok = (m) => { passes++; console.log('  PASS  ' + m) }
const bad = (m) => { failures++; console.log('  FAIL  ' + m) }

const takeover = await import(new URL('../src/plugin/takeover.js', import.meta.url).href)
const { readTargetFormat, decodeTextFile, encodeTextForTarget, writeFileAtomic, __internals } = takeover
const { eligible } = __internals

const work = mkdtempSync(join(tmpdir(), 'dsh-os-takeover-'))
const path = (name) => join(work, name)

console.log('takeover verification for ' + root)
console.log(`scratch: ${work}`)

// ---------------------------------------------------------------------------
console.log('\n== 1. target format detection ==')
{
  // The four combinations that matter, written as bytes so the test does not depend on how any editor
  // would have saved them.
  writeFileSync(path('plain-lf.txt'), Buffer.from('a\nb\n', 'utf8'))
  writeFileSync(path('bom-crlf.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n', 'utf8')]))
  writeFileSync(path('bom-lf.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nb\n', 'utf8')]))
  writeFileSync(path('crlf.txt'), Buffer.from('a\r\nb\r\n', 'utf8'))
  writeFileSync(path('empty.txt'), Buffer.alloc(0))

  const plain = readTargetFormat(path('plain-lf.txt'))
  if (plain.exists && plain.bom === false && plain.eol === 'lf') ok('plain UTF-8 + LF -> no BOM, lf')
  else bad(`plain UTF-8 + LF read as ${JSON.stringify(plain)}`)

  const bomCrlf = readTargetFormat(path('bom-crlf.txt'))
  if (bomCrlf.bom === true && bomCrlf.eol === 'crlf') ok('UTF-8 BOM + CRLF -> bom, crlf')
  else bad(`BOM+CRLF read as ${JSON.stringify(bomCrlf)}`)

  const bomLf = readTargetFormat(path('bom-lf.txt'))
  if (bomLf.bom === true && bomLf.eol === 'lf') ok('UTF-8 BOM + LF -> bom, lf')
  else bad(`BOM+LF read as ${JSON.stringify(bomLf)}`)

  // A missing target is the "new file" case, and it must resolve to the built-in defaults so a file
  // created through the takeover is byte-identical to one created without it.
  const missing = readTargetFormat(path('does-not-exist.txt'))
  if (missing.exists === false && missing.bom === false && missing.eol === 'lf') ok('a missing target resolves to the built-in defaults (no BOM, lf)')
  else bad(`missing target read as ${JSON.stringify(missing)}`)

  const empty = readTargetFormat(path('empty.txt'))
  if (empty.exists === true && empty.bom === false && empty.eol === 'lf') ok('an empty file is treated as LF, changing nothing about how it is written')
  else bad(`empty file read as ${JSON.stringify(empty)}`)
}

// ---------------------------------------------------------------------------
console.log('\n== 2. decode / encode round trip ==')
{
  // Decoding normalises the way the built-in `read` does, so the model compares like with like.
  const decoded = decodeTextFile(readFileSync(path('bom-crlf.txt')))
  if (decoded === 'a\nb\n') ok('decoding strips the BOM and normalises CRLF to LF')
  else bad(`decoded ${JSON.stringify(decoded)}`)

  // Encoding re-applies the target's convention, so the bytes that reach the disk were never really
  // "changed" in convention even though the value the model saw was normalised.
  const backCrlf = encodeTextForTarget('a\nb\n', { bom: true, eol: 'crlf' })
  const expectedCrlf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n', 'utf8')])
  if (backCrlf.equals(expectedCrlf)) ok('encoding restores BOM + CRLF for a CRLF target')
  else bad(`encoded ${backCrlf.toString('hex')} instead of ${expectedCrlf.toString('hex')}`)

  const backLf = encodeTextForTarget('a\nb\n', { bom: false, eol: 'lf' })
  if (backLf.equals(Buffer.from('a\nb\n', 'utf8'))) ok('encoding leaves an LF target as LF with no BOM')
  else bad(`encoded ${backLf.toString('hex')}`)

  // A round trip through every detected format must be exact: this is the property that makes the
  // "preserve the target" policy safe to apply unconditionally.
  for (const name of ['plain-lf.txt', 'bom-crlf.txt', 'bom-lf.txt', 'crlf.txt', 'empty.txt']) {
    const file = path(name)
    const original = readFileSync(file)
    const format = readTargetFormat(file)
    const round = encodeTextForTarget(decodeTextFile(original), format)
    if (round.equals(original)) ok(`${name} round-trips byte-exactly`)
    else bad(`${name} round-trip differs: ${round.toString('hex')} vs ${original.toString('hex')}`)
  }

  // LF text handed to a CRLF target is normalised rather than doubled, which is the bug a naive
  // replace would produce.
  const alreadyCrlf = encodeTextForTarget('a\r\nb\r\n', { bom: false, eol: 'crlf' })
  if (alreadyCrlf.equals(Buffer.from('a\r\nb\r\n', 'utf8'))) ok('text that already carries CRLF is not doubled on a CRLF target')
  else bad(`doubled line endings: ${JSON.stringify(alreadyCrlf.toString('utf8'))}`)
}

// ---------------------------------------------------------------------------
console.log('\n== 3. atomic write ==')
{
  const target = path('atomic.txt')
  writeFileSync(target, 'old')
  writeFileAtomic(target, Buffer.from('new', 'utf8'))
  if (readFileSync(target, 'utf8') === 'new') ok('writeFileAtomic replaces the content')
  else bad('writeFileAtomic did not replace the content')

  // The replacement must not leave the temporary sibling behind, since the target directory is the
  // user's workspace and debris there is a visible defect.
  const { readdirSync } = await import('node:fs')
  const leftovers = readdirSync(work).filter((name) => name.includes('.dsh-os-'))
  if (leftovers.length === 0) ok('no temporary file is left behind')
  else bad(`temporary files left behind: ${leftovers.join(', ')}`)

  // A write into a directory that does not exist fails rather than silently creating one; the create
  // path is what creates parent directories, through the verb.
  let threw = false
  try { writeFileAtomic(path('no-such-dir/file.txt'), Buffer.from('x')) } catch { threw = true }
  if (threw) ok('a write into a missing directory throws instead of creating it implicitly')
  else bad('a write into a missing directory did not throw')

  const after = readdirSync(work).filter((name) => name.includes('.dsh-os-'))
  if (after.length === 0) ok('a failed write leaves no temporary file behind either')
  else bad(`failed write left: ${after.join(', ')}`)
}

// ---------------------------------------------------------------------------
console.log('\n== 4. the read window is sliced from structured lines ==')
{
  // A fake verb result modelled on the real envelope: `lines` covers the WHOLE file while `text` is a
  // truncated slice of it. That shape is the reason a window must be sliced from `lines` — deriving it
  // from `text` would report an empty read past the cap and under-count `totalLines` for every file
  // larger than the verb's `--max-bytes`.
  const fakeView = {
    path: 'C:\\x\\big.txt',
    lineCount: 500,
    lines: Array.from({ length: 500 }, (_, index) => ({ number: index + 1, text: `line ${index + 1}` })),
    text: 'line 1\nline 2',
    truncated: true,
  }
  const invocation = { command: 'never-spawned', prefix: [] }
  const fakeInvoke = async () => fakeView
  const { handleRead } = __internals

  const window1 = await handleRead({ file_path: 'C:\\x\\big.txt', offset: 3, limit: 2 }, invocation, 2000, fakeInvoke)
  if (window1.offset === 3 && window1.totalLines === 500 && window1.lines.length === 2
    && window1.lines[0].number === 3 && window1.lines[1].text === 'line 4') {
    ok('a window past the truncated text still resolves from structured lines, and totalLines is the file\'s own count')
  } else {
    bad(`window was ${JSON.stringify(window1)}`)
  }

  const window2 = await handleRead({ file_path: 'C:\\x\\big.txt', offset: 499, limit: 2000 }, invocation, 2000, fakeInvoke)
  if (window2.lines.length === 2 && window2.lines[1].number === 500) ok('a window near the end returns only the remaining lines')
  else bad(`end window was ${JSON.stringify(window2)}`)

  // The built-in tool reports an offset past the end of a non-empty file as an error rather than an
  // empty read, so a caller that asked for line 900 of a 10-line file is told, not handed nothing.
  let threw = false
  try { await handleRead({ file_path: 'C:\\x\\big.txt', offset: 900 }, invocation, 2000, fakeInvoke) } catch { threw = true }
  if (threw) ok('an offset past the end of a non-empty file throws instead of returning an empty read')
  else bad('an out-of-range offset was answered with an empty window')

  // A file with nothing in it has no lines; the window must be empty rather than one phantom line.
  const emptyView = { path: 'C:\\x\\empty.txt', lineCount: 0, lines: [], text: '' }
  const emptyWindow = await handleRead({ file_path: 'C:\\x\\empty.txt' }, invocation, 2000, async () => emptyView)
  if (emptyWindow.lines.length === 0 && emptyWindow.totalLines === 0) ok('an empty file yields an empty window, not one phantom line')
  else bad(`empty window was ${JSON.stringify(emptyWindow)}`)

  // The `limit` default and ceiling both come from the row's `readLimit`, so a deployment that raised it
  // does not silently get a 2000-line window through the interception.
  const capped = await handleRead({ file_path: 'C:\\x\\big.txt', limit: 99999 }, invocation, 10, fakeInvoke)
  if (capped.lines.length === 10) ok('the window is capped by the configured readLimit, not by the request')
  else bad(`cap produced ${capped.lines.length} lines`)
}

// ---------------------------------------------------------------------------
console.log('\n== 5. the write format switch is real, not just persisted ==')
{
  const { handleWrite, handleEdit } = __internals
  const invocation = { command: 'never-spawned', prefix: [] }
  // A create would reach the verb layer; the invoker is stubbed so this suite never spawns a process.
  const neverInvoke = async () => { throw new Error('the verb layer must not be reached for an existing target') }

  // 'target' (the default) preserves what the file already had...
  const keep = join(work, 'format-target.txt')
  writeFileSync(keep, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n', 'utf8')]))
  await handleWrite({ file_path: keep, content: 'c\nd' }, invocation, 'target', neverInvoke)
  const kept = readFileSync(keep)
  if (kept[0] === 0xef && kept.toString('utf8').includes('\r\n')) ok("writeFormat 'target' keeps the BOM and CRLF")
  else bad(`'target' produced ${JSON.stringify(kept.toString('utf8'))}`)

  // ...and 'builtin' reproduces the built-in tool byte for byte, which is the whole point of offering it.
  const flatten = join(work, 'format-builtin.txt')
  writeFileSync(flatten, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n', 'utf8')]))
  await handleWrite({ file_path: flatten, content: 'c\nd' }, invocation, 'builtin', neverInvoke)
  const flattened = readFileSync(flatten)
  if (flattened.equals(Buffer.from('c\nd', 'utf8'))) ok("writeFormat 'builtin' writes UTF-8 without a BOM and with LF")
  else bad(`'builtin' produced ${flattened.toString('hex')}`)

  // A NEW file is the built-in convention under either setting: there is no target convention to keep,
  // and the write itself belongs to the verb (which is what creates parents and checks protected paths).
  const freshKeep = join(work, 'format-new-target.txt')
  let sawVerb = false
  await handleWrite({ file_path: freshKeep, content: 'x\ny' }, invocation, 'target', async () => {
    sawVerb = true
    writeFileSync(freshKeep, Buffer.from('x\ny', 'utf8'))
    return { path: freshKeep, operation: 'create' }
  })
  if (sawVerb) ok('a new target is created through the verb layer, not written directly')
  else bad('a new target bypassed the verb layer')
  if (readFileSync(freshKeep).equals(Buffer.from('x\ny', 'utf8'))) ok('a new file is UTF-8 without a BOM and LF even under the target format')
  else bad('a new file did not follow the built-in convention')

  // The same switch governs edit, and it must not change the edit's own semantics.
  const editTarget = join(work, 'format-edit.txt')
  writeFileSync(editTarget, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n', 'utf8')]))
  const edited = await handleEdit({ file_path: editTarget, old_string: 'two', new_string: 'TWO' }, invocation, 'builtin')
  if (readFileSync(editTarget).equals(Buffer.from('one\nTWO\n', 'utf8'))) ok("edit honours writeFormat 'builtin' by writing the flattened bytes")
  else bad(`edit under 'builtin' produced ${readFileSync(editTarget).toString('hex')}`)
  if (edited.before === 'one\ntwo\n') ok('the reported before/after stay normalised text under either format')
  else bad(`edit reported before=${JSON.stringify(edited.before)}`)
}

// ---------------------------------------------------------------------------
console.log('\n== 6. eligibility keeps calls on the built-in path ==')
{
  const cases = [
    ['read', { file_path: 'C:\\abs\\a.txt' }, true, 'an absolute read is intercepted'],
    ['read', { file_path: 'relative/a.txt' }, false, 'a relative read keeps the session-workspace resolution of the built-in tool'],
    ['read', { file_path: '   ' }, false, 'a blank path is refused'],
    ['write', { file_path: 'C:\\abs\\a.txt', content: '' }, true, 'an empty content is a legal write'],
    ['edit', { file_path: 'C:\\abs\\a.txt', old_string: 'a', new_string: 'b' }, true, 'an absolute edit is intercepted'],
    ['pwsh', { command: 'Get-Date', description: 'x' }, true, 'a foreground command is intercepted'],
    ['pwsh', { command: 'Get-Date', run_in_background: true }, false, 'a background command keeps the harness job system'],
    ['pwsh', { command: 'Get-Date', sandbox_permissions: 'danger-full-access' }, false, 'a sandbox escalation keeps the harness approval seam'],
    ['pwsh', { command: 'Get-Date', workdir: 'relative' }, false, 'a relative workdir keeps the session-cwd resolution'],
    ['pwsh', { command: 'Get-Date', workdir: 'C:\\abs' }, true, 'an absolute workdir is forwarded'],
    ['glob', { pattern: '**/*.ts' }, false, 'glob is never intercepted: this surface has no content-search verb'],
    ['grep', { pattern: 'x' }, false, 'grep is never intercepted for the same reason'],
  ]
  for (const [tool, args, expected, why] of cases) {
    const actual = eligible(tool, args)
    if (actual === expected) ok(why)
    else bad(`${why} — expected ${expected}, got ${actual}`)
  }
}

rmSync(work, { recursive: true, force: true })
console.log('')
console.log(`passed=${passes} failed=${failures}`)
if (failures > 0) process.exit(1)
