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
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  // `parameters` must be a COMPLETE JSON Schema with an object root.
  //
  // The registry's register() does NOT compile the { name: {...} } property map that the internal
  // defineTool accepts, so handing it the bare map ships a schema whose root has no `type`, and the
  // provider rejects the whole request with:
  //   Invalid schema for function 'dsh_os': schema must be a JSON Schema of 'type: "object"',
  //   got 'type: null'
  // These assertions are deliberately about the root, because that is where the defect lived.
  assert.equal(def.parameters.type, 'object', 'the parameter schema root must declare type: object')
  assert.ok(def.parameters.properties, 'the schema must carry a properties map')
  assert.ok(!def.parameters.verb, 'a bare property map is not a schema: properties must be nested')
  // Requiredness lives in the root `required` array, not a per-property `required: true` flag.
  assert.deepEqual(def.parameters.required, ['verb'], 'verb is the only required parameter')
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
  // The loader resolves the plugin by the package NAME named in the patch row, so the manifest must
  // export its entry point. Without an "exports" map, a name-based ESM resolution has nothing to
  // follow and the plugin would fail to import even though the files are all present.
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports, 'the manifest must export the plugin entry point')
  assert.equal(pkg.exports['.'], './src/plugin/index.js')
  const patch = readFileSync(join(rootDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(pkg.name), 'the patch must name the plugin package')
  assert.ok(patch.includes('insert:'), 'the patch must insert an entry')
})

await check('the patch row matches the documented bundle shape', () => {
  // Checked structurally rather than by loading a YAML parser: the project has no YAML dependency,
  // and the loader's dialect allows !!js tags that a stock parser would reject. The property that
  // matters is that each row is an `insert` list entry carrying a unique id and the package name.
  const patch = readFileSync(join(rootDir, 'cordis.patch.yml'), 'utf8')
  const lines = patch.split('\n')
  const insertIndex = lines.findIndex((l) => /^- insert:\s*$/.test(l))
  assert.ok(insertIndex >= 0, 'the first document node must be an `insert:` list')
  const rowIds = lines.filter((l) => /^\s+-\s+id:\s*\S+/.test(l))
  assert.ok(rowIds.length >= 1, 'at least one row must declare an id')
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  const names = lines.filter((l) => /^\s+name:\s*\S+/.test(l)).map((l) => l.split(':')[1].trim().replace(/^['"]|['"]$/g, ''))
  // A row name is a package SPECIFIER: the bare package name, or the package plus a subpath export.
  // Two rows naming the same specifier would import one module twice, and the second import throws
  // `tool "dsh_os" is already registered` - which aborts the whole entry. So the names must be
  // distinct, and every one must address this package.
  for (const n of names) {
    assert.ok(
      n === pkg.name || n.startsWith(pkg.name + '/'),
      `row name '${n}' must address the package '${pkg.name}', optionally through a subpath export`,
    )
  }
  assert.equal(new Set(names).size, names.length, 'row names must be distinct, or a module loads twice')
  // The subpath each row names must actually be exported, or the loader cannot import it.
  for (const n of names) {
    if (n === pkg.name) continue
    const subpath = './' + n.slice(pkg.name.length + 1)
    assert.ok(pkg.exports[subpath], `row name '${n}' needs an exports entry for '${subpath}'`)
  }
  // Ids must be unique, or a second row would silently shadow the first.
  const ids = rowIds.map((l) => l.split(':')[1].trim())
  assert.equal(new Set(ids).size, ids.length, 'row ids must be unique')
  // The delegate row must be present: it is the only component allowed to write permission.json.
  assert.ok(ids.includes('dsh-os-permission'), 'the permission consent delegate row must be installed')
  // And the manifest must export a name-based entry point for that row, or the loader cannot import it.
  assert.equal(pkg.exports['./permission'], './src/permission/index.js')
})

await check('the plugin is resolvable by its own package name', () => {
  // This is the property the loader depends on and the one an "exports"-less manifest lacks. The
  // check is done through Node's real resolver by creating a throwaway package that depends on this
  // one, so it proves name resolution rather than assuming it.
  const box = join(rootDir, '.temporary', 'name-resolution')
  const inner = join(box, 'node_modules', 'deepseek-coordination')
  rmSync(box, { recursive: true, force: true })
  mkdirSync(join(box, 'probe'), { recursive: true })
  mkdirSync(join(box, 'node_modules'), { recursive: true })
  writeFileSync(join(box, 'package.json'), JSON.stringify({ name: 'probe', type: 'module' }))
  symlinkSync(rootDir, inner, 'junction')
  writeFileSync(
    join(box, 'probe', 'entry.mjs'),
    `const m = await import('deepseek-coordination')\n` +
    `process.stdout.write(JSON.stringify({ apply: typeof m.apply, inject: m.inject, name: m.name }))\n`,
  )
  const out = execFileSync(process.execPath, [join(box, 'probe', 'entry.mjs')], { cwd: box, encoding: 'utf8' })
  const resolved = JSON.parse(out)
  assert.equal(resolved.apply, 'function', 'apply must be exported from the package root')
  assert.deepEqual(resolved.inject, ['tools'])
  assert.equal(resolved.name, 'dsh-os')
  rmSync(box, { recursive: true, force: true })
})

console.log()
console.log(`passed=${pass} failed=${fail}`)
if (fail > 0) {
  console.log('failures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
process.exit(0)
