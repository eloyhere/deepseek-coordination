/**
 * plugin.test.mjs - exercise the dsh-os plugin's real execute path with a stub plugin context.
 *
 * The golden suites test the scripts. This tests the layer above them: that the plugin resolves the
 * right platform entry point, builds an argv array (never a shell string), passes a path containing
 * spaces through as ONE argument, and returns the envelope verbatim.
 *
 * What this does NOT prove: that DSH's loader accepts the bundle. That needs a real profile install
 * and is not something a unit test can stand in for.
 *
 * Usage: node tests/plugin.test.mjs     (exit 0 when every case passes)
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testsDir = dirname(fileURLToPath(import.meta.url))
const rootDir = dirname(testsDir)

let pass = 0
let fail = 0
const failures = []

/** Capture the definition the plugin registers, so its execute can be driven directly. */
async function loadPlugin() {
  // A dynamic import needs a file:// URL on Windows; a bare "R:\..." path is read as a URL with
  // scheme "r:" and rejected by the ESM loader.
  const mod = await import(pathToFileURL(join(rootDir, 'src/plugin/index.js')).href)
  let registered = null
  const ctx = { tools: { register: (def) => { registered = def; return () => {} } } }
  mod.apply(ctx, {})
  assert.ok(registered !== null, 'plugin must register exactly one tool')
  return { mod, def: registered }
}

async function check(description, fn) {
  try {
    await fn()
    pass++
    console.log(`  PASS  ${description}`)
  } catch (error) {
    fail++
    failures.push(`${description}: ${error.message}`)
    console.log(`  FAIL  ${description}`)
    console.log(`        ${error.message}`)
  }
}

const { def } = await loadPlugin()

await check('registers a tool named dsh_os', () => {
  assert.equal(def.name, 'dsh_os')
  assert.equal(typeof def.execute, 'function')
  assert.ok(def.parameters.verb.required === true, 'verb is required')
})

await check('declares the output shape an agent parses', () => {
  assert.deepEqual(def.output.schema, { type: 'string' })
  const rendered = def.output.render({}, '{"ok":true}')
  assert.deepEqual(rendered, [{ type: 'text', text: '{"ok":true}' }])
})

await check('selfcheck returns one parseable envelope', async () => {
  const out = await def.execute({ verb: 'selfcheck' }, {})
  const parsed = JSON.parse(out)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.verb, 'selfcheck')
  assert.ok(parsed.result.verbCount > 0, 'verb table is reported')
})

await check('multi-word verb is split and resolved', async () => {
  const out = await def.execute({ verb: 'file charset', arguments: ['src/host/command.txt'] }, {})
  const parsed = JSON.parse(out)
  assert.equal(parsed.verb, 'file.charset')
  assert.equal(parsed.result.charset, 'utf-8')
})

await check('named arguments are passed through', async () => {
  const out = await def.execute({
    verb: 'file charset',
    arguments: ['path=src/host/command.txt'],
  }, {})
  const parsed = JSON.parse(out)
  assert.equal(parsed.result.charset, 'utf-8')
})

await check('a path containing spaces stays ONE argument', async () => {
  // This is the defect the whole surface exists to remove: through a shell string this path would be
  // split into two arguments and the call would target the wrong file.
  const out = await def.execute({
    verb: 'file charset',
    arguments: ['src/host/docs/a b placeholder.txt'],
  }, {})
  const parsed = JSON.parse(out)
  // The file does not exist, so the point is which path the script reports it could not read.
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'E_NOT_FOUND')
  assert.ok(
    parsed.error.message.includes('a b placeholder.txt'),
    `the space must survive into one path, got: ${parsed.error.message}`,
  )
})

await check('a typed failure is returned as a result, not thrown away', async () => {
  const out = await def.execute({ verb: 'file charset', arguments: ['/no/such/file'] }, {})
  const parsed = JSON.parse(out)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'E_NOT_FOUND')
  assert.equal(parsed.error.message.length > 0, true, 'error.code is authoritative but the message must survive')
})

await check('flags are forwarded verbatim', async () => {
  const out = await def.execute({
    verb: 'environment list',
    flags: ['--scope', 'process', '--filter', 'PATH*'],
  }, {})
  const parsed = JSON.parse(out)
  assert.equal(parsed.ok, true)
})

await check('allow:true reaches the script as --allow', async () => {
  const box = join(rootDir, '.temporary', 'plugin-test.txt')
  const created = await def.execute({
    verb: 'file create',
    arguments: [box, 'plugin test', 'utf-8'],
    allow: true,
  }, {})
  const parsedCreated = JSON.parse(created)
  // Either it was created, or a previous run left it behind; both prove --allow arrived.
  assert.ok(
    parsedCreated.ok === true || parsedCreated.error.code === 'E_EXISTS',
    `expected create to succeed or report E_EXISTS, got: ${created}`,
  )
})

await check('a mutating verb without allow is refused', async () => {
  const out = await def.execute({
    verb: 'file create',
    arguments: [join(rootDir, '.temporary', 'plugin-test-never.txt'), 'x', 'utf-8'],
  }, {})
  const parsed = JSON.parse(out)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'E_PERMISSION')
})

await check('the package declares the bundle the loader needs', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.main, 'src/plugin/index.js')
  // The patch must be present for the loader to read, and it must reference the package by name.
  const patch = readFileSync(join(rootDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(pkg.name), 'the patch must name the plugin package')
  assert.ok(patch.includes('insert:'), 'the patch must insert an entry')
})

console.log()
console.log(`passed=${pass} failed=${fail}`)
if (fail > 0) {
  console.log('failures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
process.exit(0)
