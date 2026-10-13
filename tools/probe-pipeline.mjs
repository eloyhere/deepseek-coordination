// probe-pipeline.mjs - drive the whole interception without a running harness.
//
// `tests/takeover.test.mjs` proves the pieces. This proves the WIRING: that `apply()` really subscribes
// to `tools/execute`, that the subscription honours the master switch and the per-tool switches, and
// that what the handlers return is exactly the `{ value }` envelope `normalizeDispatchResult` expects.
// That last one is the reason this file exists: a bare value would be read as `result.value === undefined`
// and fail schema validation at runtime, in the live profile, where nobody wants to find out.
//
// The verb layer is replaced by a loader stub (see `.temporary/probe/invoke-stub-loader.mjs`), so no
// process is spawned. Everything below runs the REAL takeover.js, the REAL settings service and the REAL
// schema shapes; only the envelopes coming back from the script are fake.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const takeover = await import(new URL('../src/plugin/takeover.js', import.meta.url).href)
const settingsModule = await import(new URL('../src/plugin/settings.js', import.meta.url).href)

let passes = 0
let failures = 0
const ok = (m) => { passes++; console.log('  PASS  ' + m) }
const bad = (m) => { failures++; console.log('  FAIL  ' + m) }

const work = mkdtempSync(join(tmpdir(), 'dsh-os-pipeline-'))
const settingsFile = join(work, 'settings.json')

console.log('interception pipeline probe')
console.log(`scratch: ${work}`)

// A settings service with the API takeover.js consumes, backed by a real file so persistence is real.
const service = new settingsModule.SettingsService({}, { settingsPath: settingsFile })
service.update({ enabled: true, tools: { read: true, write: true, edit: true, pwsh: true } })

// A context that records the subscription.
const listeners = new Map()
const ctx = {
  'dsh-os-settings': service,
  on(name, handler) { listeners.set(name, handler) },
  inject() {},
  provide() { return () => {} },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
}

takeover.apply(ctx, {})
const execute = listeners.get('tools/execute')
if (typeof execute === 'function') ok('apply() subscribed to tools/execute')
else bad('apply() did not subscribe to tools/execute')

/** Run one intercepted call the way the registry does, and report which path answered. */
async function call(name, args) {
  let builtin = false
  const next = () => { builtin = true; return { value: 'BUILTIN' } }
  const returned = await execute({ name, arguments: args, agent: {} }, next)
  if (returned === undefined) throw new Error('handler returned undefined; normalizeDispatchResult would reject it')
  if (!Object.hasOwn(returned, 'value')) throw new Error('handler did not return a { value } envelope')
  if (process.env.DSH_PROBE_DEBUG) {
    console.log(`    [debug] ${name} -> builtin=${builtin} value=${JSON.stringify(returned.value)}`)
  }
  return { value: returned.value, builtin }
}

// ---------------------------------------------------------------------------
console.log('\n== 1. read is answered with a value the built-in schema accepts ==')
{
  const { value, builtin } = await call('read', { file_path: 'C:\\x\\a.txt' })
  const problems = validateRead(value)
  if (problems.length === 0) ok('the intercepted value satisfies the built-in read output schema')
  else bad(`value violates the schema: ${problems.join('; ')}`)
  if (!builtin) ok('the built-in body was skipped')
  else bad('the built-in body ran despite a successful interception')
}

// ---------------------------------------------------------------------------
console.log('\n== 2. a write to a NEW path goes through the verb, not around it ==')
{
  const target = join(work, 'created.txt')
  const { value, builtin } = await call('write', { file_path: target, content: 'hello' })
  const problems = validateWrite(value, { expectBeforeNull: true })
  if (problems.length === 0) ok('a new target yields { operation: "create", before: null } per the built-in schema')
  else bad(`value violates the schema: ${problems.join('; ')}`)
  if (!builtin) ok('the built-in body was skipped')
  else bad('the built-in body ran')
  // The verb stub records nothing on disk, so the create branch must NOT have written the file itself:
  // the verb is what creates parent directories and applies the protected-path check, and a direct write
  // here would bypass both.
  let exists = true
  try { readFileSync(target) } catch { exists = false }
  if (!exists) ok('the create branch did not write the file itself — the verb owns that write')
  else bad('the create branch wrote the file directly, which would bypass the verb')
}

// ---------------------------------------------------------------------------
console.log('\n== 3. a write to an EXISTING file preserves its BOM and CRLF ==')
{
  const target = join(work, 'existing.txt')
  writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n', 'utf8')]))
  const { value, builtin } = await call('write', { file_path: target, content: 'three\nfour' })
  const problems = validateWrite(value, { expectBeforeNull: false })
  if (problems.length === 0) ok('an existing target yields { operation: "update" } with string before/after')
  else bad(`value violates the schema: ${problems.join('; ')}`)
  if (!builtin) ok('the built-in body was skipped')

  const bytes = readFileSync(target)
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const crlf = bytes.toString('utf8').includes('\r\n')
  if (hasBom && crlf) ok('the target kept its BOM and CRLF even though the reported value is LF text')
  else bad(`convention lost: bom=${hasBom} crlf=${crlf}`)
  if (value.before === 'one\ntwo\n') ok('before is the normalised text the built-in read would have shown')
  else bad(`before was ${JSON.stringify(value.before)}`)
  if (value.after === 'three\nfour') ok('after is the text that was asked for, not the bytes on disk')
  else bad(`after was ${JSON.stringify(value.after)}`)
}

// ---------------------------------------------------------------------------
console.log('\n== 4. an edit applies the literal replacement ==')
{
  const target = join(work, 'edited.txt')
  writeFileSync(target, 'alpha beta gamma\n')
  const { value } = await call('edit', { file_path: target, old_string: 'beta', new_string: 'BETA' })
  const problems = validateEdit(value)
  if (problems.length === 0) ok('the value satisfies the built-in edit output schema')
  else bad(`value violates the schema: ${problems.join('; ')}`)
  if (readFileSync(target, 'utf8') === 'alpha BETA gamma\n') ok('the literal replacement landed on disk')
  else bad(`file is ${JSON.stringify(readFileSync(target, 'utf8'))}`)
}

// ---------------------------------------------------------------------------
console.log('\n== 5. an ambiguous edit falls back instead of guessing ==')
{
  const target = join(work, 'ambiguous.txt')
  writeFileSync(target, 'x x\n')
  const { builtin } = await call('edit', { file_path: target, old_string: 'x', new_string: 'y' })
  if (builtin) ok('two matches without replace_all calls through to the built-in implementation')
  else bad('an ambiguous edit was answered instead of falling back')
  if (readFileSync(target, 'utf8') === 'x x\n') ok('the file was left untouched by the refused edit')
  else bad('the refused edit modified the file anyway')
}

// ---------------------------------------------------------------------------
console.log('\n== 6. pwsh yields the foreground variant of the oneOf schema ==')
{
  const { value } = await call('pwsh', { command: 'Get-Date', description: 'x', workdir: 'C:\\x' })
  const problems = validatePwsh(value)
  if (problems.length === 0) ok('the value satisfies the foreground variant of the built-in oneOf schema')
  else bad(`value violates the schema: ${problems.join('; ')}`)
}

// ---------------------------------------------------------------------------
console.log('\n== 7. the switches gate the interception ==')
{
  service.update({ enabled: false })
  const off = await call('read', { file_path: 'C:\\x\\a.txt' })
  if (off.builtin) ok('master switch off -> the built-in path runs')
  else bad('master switch off still intercepted')

  service.update({ enabled: true, tools: { read: false } })
  const perTool = await call('read', { file_path: 'C:\\x\\a.txt' })
  if (perTool.builtin) ok('per-tool switch off -> that tool falls back while the master switch stays on')
  else bad('per-tool switch off still intercepted')

  const other = await call('edit', { file_path: join(work, 'edited.txt'), old_string: 'BETA', new_string: 'beta' })
  if (!other.builtin) ok('the other tools keep working while one is switched off')
  else bad('switching one tool off disabled the others')
}

// ---------------------------------------------------------------------------
console.log('\n== 8. a verb failure falls back instead of failing the call ==')
{
  service.update({ enabled: true, tools: { read: true } })
  process.env.DSH_PROBE_THROW = 'file view'
  const { builtin } = await call('read', { file_path: 'C:\\x\\a.txt' })
  process.env.DSH_PROBE_THROW = ''
  if (builtin) ok('a failing verb calls through to the built-in implementation')
  else bad('a failing verb did not fall back')

  const recorded = service.current().activity.some((entry) => entry.outcome === 'fell-back')
  if (recorded) ok('the fallback is recorded, so the panel can show why')
  else bad('the fallback was not recorded')
}

// ---------------------------------------------------------------------------
console.log('\n== 9. activity records what was taken over ==')
{
  service.update({ enabled: true, tools: { read: true, write: true, edit: true, pwsh: true } })
  await call('read', { file_path: 'C:\\x\\a.txt' })
  const activity = service.current().activity
  const taken = activity.filter((entry) => entry.outcome === 'taken-over')
  if (taken.length > 0) ok(`the feed records ${taken.length} taken-over call(s)`)
  else bad('no taken-over call was recorded')
  if (taken.every((entry) => typeof entry.subject === 'string' && typeof entry.at === 'string')) ok('every entry carries a subject and a timestamp')
  else bad('an entry is missing its subject or timestamp')
}

function validateRead(value) {
  const problems = []
  if (typeof value.path !== 'string') problems.push('path is not a string')
  if (!Number.isInteger(value.offset)) problems.push('offset is not an integer')
  if (!Array.isArray(value.lines)) problems.push('lines is not an array')
  else for (const line of value.lines) {
    if (!Number.isInteger(line.number)) problems.push('a line number is not an integer')
    if (typeof line.text !== 'string') problems.push('a line text is not a string')
    if (Object.keys(line).length !== 2) problems.push(`a line has extra keys: ${Object.keys(line).join(',')}`)
  }
  if (!Number.isInteger(value.totalLines)) problems.push('totalLines is not an integer')
  if (Object.keys(value).length !== 4) problems.push(`extra top-level keys: ${Object.keys(value).join(',')}`)
  return problems
}

function validateWrite(value, { expectBeforeNull }) {
  const problems = []
  if (typeof value.path !== 'string') problems.push('path is not a string')
  if (value.operation !== 'create' && value.operation !== 'update') problems.push(`operation is ${value.operation}`)
  if (expectBeforeNull && value.before !== null) problems.push('before should be null for a create')
  if (!expectBeforeNull && typeof value.before !== 'string') problems.push('before should be a string for an update')
  if (typeof value.after !== 'string') problems.push('after is not a string')
  if (Object.keys(value).length !== 4) problems.push(`extra top-level keys: ${Object.keys(value).join(',')}`)
  return problems
}

function validateEdit(value) {
  const problems = []
  if (typeof value.path !== 'string') problems.push('path is not a string')
  if (typeof value.before !== 'string') problems.push('before is not a string')
  if (typeof value.after !== 'string') problems.push('after is not a string')
  if (Object.keys(value).length !== 3) problems.push(`extra top-level keys: ${Object.keys(value).join(',')}`)
  return problems
}

function validatePwsh(value) {
  const problems = []
  if (value.kind !== 'foreground') problems.push(`kind is ${value.kind}`)
  if (!(Number.isInteger(value.exitCode) || value.exitCode === null)) problems.push('exitCode is neither an integer nor null')
  if (!(typeof value.signal === 'string' || value.signal === null)) problems.push('signal is neither a string nor null')
  for (const key of ['timedOut', 'aborted']) if (typeof value[key] !== 'boolean') problems.push(`${key} is not a boolean`)
  if (typeof value.timeoutMs !== 'number') problems.push('timeoutMs is not a number')
  for (const stream of ['stdout', 'stderr']) {
    const s = value[stream]
    if (s === null || typeof s !== 'object') { problems.push(`${stream} is not an object`); continue }
    if (typeof s.text !== 'string') problems.push(`${stream}.text is not a string`)
    if (typeof s.truncated !== 'boolean') problems.push(`${stream}.truncated is not a boolean`)
  }
  const allowed = ['kind', 'exitCode', 'signal', 'timedOut', 'aborted', 'stopped', 'timeoutMs', 'stdout', 'stderr', 'sandbox']
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`extra key ${key}`)
  return problems
}

rmSync(work, { recursive: true, force: true })
console.log('')
console.log(`passed=${passes} failed=${failures}`)
if (failures > 0) process.exit(1)
