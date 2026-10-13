/**
 * permission.test.mjs - exercise the consent delegate's rules, trust model and write path.
 *
 * The delegate is the only writer of permission.json, so its failures are the ones that matter most:
 * a wrong match grants access nobody approved, and a wrong trust decision either ignores the user's
 * real decisions or honours rules somebody else wrote.
 *
 * Everything runs against a temporary file, never the repository's permission.json.
 *
 * Usage: node tests/permission.test.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testsDir = dirname(fileURLToPath(import.meta.url))
const rootDir = dirname(testsDir)
const box = mkdtempSync(join(tmpdir(), 'dsh-perm-'))
const permPath = join(box, 'permission.json')

let pass = 0
let fail = 0
const failures = []

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

/** Load the plugin, capture its registered tools and its service, against the temp file. */
async function load() {
  const mod = await import(pathToFileURL(join(rootDir, 'src/permission/index.js')).href)
  const tools = new Map()
  let service = null
  const ctx = {
    tools: { register: (spec) => tools.set(spec.name, spec) },
    set: (_n, s) => { service = s },
    provide: (_n, s) => { service = s },
  }
  mod.apply(ctx, { permissionPath: permPath, auditLimit: 5 })
  return { mod, tools, service }
}

const { mod, tools, service } = await load()
const internals = mod.__internals

function reset() {
  if (existsSync(permPath)) rmSync(permPath)
}

await check('registers the five permission tools', () => {
  for (const n of [
    'os_permission_query',
    'os_permission_grant',
    'os_permission_revoke',
    'os_permission_list',
    'os_permission_audit',
  ]) {
    assert.ok(tools.has(n), `missing tool ${n}`)
  }
})

await check('a missing file is empty, not corrupt', () => {
  reset()
  const r = internals.readDocument(permPath)
  assert.equal(r.trusted, true)
  assert.equal(r.exists, false)
  assert.deepEqual(r.document.rules, [])
})

await check('a 0-byte file is the documented initial state and reads as empty', () => {
  reset()
  writeFileSync(permPath, '')
  const r = internals.readDocument(permPath)
  assert.equal(r.trusted, true, 'a 0-byte file must not be treated as corruption')
  assert.equal(r.exists, true)
})

await check('verb patterns match exactly, by namespace, or by wildcard', () => {
  assert.ok(internals.verbMatches('file.delete', 'file.delete'))
  assert.ok(!internals.verbMatches('file.delete', 'file.create'))
  assert.ok(internals.verbMatches('file.*', 'file.delete'))
  assert.ok(internals.verbMatches('file.*', 'file.create'))
  assert.ok(!internals.verbMatches('file.*', 'window.close'))
  assert.ok(internals.verbMatches('*', 'anything.at.all'))
})

await check('a deny rule beats an allow rule regardless of order', () => {
  // The allow is FIRST, so a "first match wins" implementation would allow. Deny must still win.
  const doc = internals.emptyDocument()
  doc.rules.push({ id: 'r-0001', verb: 'file.delete', target: { value: '*' }, decision: 'allow-always' })
  doc.rules.push({ id: 'r-0002', verb: 'file.delete', target: { value: '*' }, decision: 'deny-always' })
  const v = internals.evaluate(doc, 'file.delete', undefined)
  assert.equal(v.decision, 'deny-always')
  assert.equal(v.ruleId, 'r-0002')
})

await check('with no matching rule the answer is the defaults, not a silent allow', () => {
  const doc = internals.emptyDocument()
  const v = internals.evaluate(doc, 'file.delete', undefined)
  assert.equal(v.decision, 'ask')
  assert.equal(v.source, 'defaults')
  assert.equal(v.ruleId, null)
})

await check('grant persists a rule and an audit entry', () => {
  reset()
  const r = service.grant({ verb: 'file.delete', target: { kind: 'path', value: 'R:\\tmp\\**' }, decision: 'allow-always' })
  assert.equal(r.rule.id, 'r-0001')
  const onDisk = JSON.parse(readFileSync(permPath, 'utf8'))
  assert.equal(onDisk.updatedBy, 'consent-delegate')
  assert.equal(onDisk.rules.length, 1)
  assert.equal(onDisk.audit.length, 1)
  assert.equal(onDisk.audit[0].decision, 'allow-always')
})

await check('rule ids increment and do not collide', () => {
  service.grant({ verb: 'file.create', target: { value: 'x' }, decision: 'allow-always' })
  const listed = service.list()
  assert.deepEqual(listed.rules.map((r) => r.id), ['r-0001', 'r-0002'])
})

await check('a wildcard target needs explicit acknowledgement', () => {
  assert.throws(
    () => service.grant({ verb: 'file.delete', target: { value: '*' }, decision: 'allow-always' }),
    /acknowledgeBroad/,
    'consent to everything must be a separate, explicit decision',
  )
  // And with the acknowledgement it is recorded as broad.
  const r = service.grant({
    verb: 'file.delete',
    target: { value: '*' },
    decision: 'allow-always',
    acknowledgeBroad: true,
  })
  assert.equal(r.rule.broad, true)
})

await check('an invalid decision or scope is refused', () => {
  assert.throws(() => service.grant({ verb: 'x', target: { value: 'a' }, decision: 'allow-once' }), /allow-always or deny-always/)
  assert.throws(
    () => service.grant({ verb: 'x', target: { value: 'a' }, decision: 'allow-always', scope: 'galaxy' }),
    /scope must be one of/,
  )
})

await check('the audit is bounded and drops the OLDEST entries', () => {
  reset()
  for (let i = 0; i < 8; i++) {
    service.grant({ verb: `file.v${i}`, target: { value: 'x' }, decision: 'allow-always' })
  }
  const a = service.audit({ limit: 100 })
  assert.equal(a.total, 5, 'auditLimit of 5 must be enforced')
  // The surviving entries must be the most recent ones.
  assert.equal(a.entries[a.entries.length - 1].verb, 'file.v7')
  assert.equal(a.entries[0].verb, 'file.v3')
})

await check('a file written by somebody else is untrusted and falls back to defaults', () => {
  reset()
  writeFileSync(
    permPath,
    JSON.stringify({
      version: 1,
      updatedBy: 'somebody-else',
      defaults: { readOnly: 'allow', mutating: 'allow' },
      rules: [{ id: 'r-0001', verb: 'file.delete', target: { value: '*' }, decision: 'allow-always' }],
      audit: [],
    }),
  )
  const r = internals.readDocument(permPath)
  assert.equal(r.trusted, false)
  assert.match(r.untrustedReason, /somebody-else/)
  // The hostile rule must not be honoured: the document is replaced by defaults.
  const v = internals.evaluate(r.document, 'file.delete', undefined)
  assert.equal(v.decision, 'ask', 'an untrusted file must not grant anything')
})

await check('malformed JSON is untrusted rather than fatal', () => {
  reset()
  writeFileSync(permPath, '{ this is not json')
  const r = internals.readDocument(permPath)
  assert.equal(r.trusted, false)
  assert.match(r.untrustedReason, /not valid JSON/)
})

await check('revoke removes the rule and audits the removal', () => {
  reset()
  const g = service.grant({ verb: 'file.delete', target: { value: 'y' }, decision: 'allow-always' })
  const r = service.revoke({ ruleId: g.rule.id })
  assert.equal(r.removed.id, g.rule.id)
  assert.equal(service.list().count, 0)
  const entries = service.audit({ limit: 10 }).entries
  assert.equal(entries[entries.length - 1].decision, 'revoked')
})

await check('revoking an unknown id is refused', () => {
  assert.throws(() => service.revoke({ ruleId: 'r-9999' }), /no rule with id/)
})

await check('query reports the matching rule id and its source', () => {
  reset()
  const g = service.grant({ verb: 'file.delete', target: { value: 'z' }, decision: 'deny-always' })
  const q = service.query({ verb: 'file.delete', target: { value: 'z' } })
  assert.equal(q.decision, 'deny-always')
  assert.equal(q.ruleId, g.rule.id)
  assert.equal(q.source, 'rule')
  const miss = service.query({ verb: 'file.create', target: { value: 'z' } })
  assert.equal(miss.source, 'defaults')
})

await check('the write is atomic: no temporary file is left behind', () => {
  reset()
  service.grant({ verb: 'file.delete', target: { value: 'w' }, decision: 'allow-always' })
  const leftovers = readdirSync(box).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [], 'a crash-prone temp file must not survive a successful write')
})

await check('a STRING target persists as a scoped rule instead of being read as the wildcard', async () => {
  // The model-facing tool declares `target` as a string and hands it straight through, while `grant` reads
  // `target.value`. Reading `.value` off a string yields undefined, so the value became '*' and the
  // broad-target guard refused EVERY grant: a rule for one path could not be created at all, through the
  // only writer that exists. This case pins both halves of the fix.
  reset()
  const tools2 = new Map()
  const ctx2 = {
    tools: { register: (spec) => tools2.set(spec.name, spec) },
    provide: () => () => {},
    inject: () => {},
    effect: (f) => { const d = f(); return () => { if (typeof d === 'function') d() } },
    on: () => () => {},
    get: () => undefined,
  }
  mod.apply(ctx2, { permissionPath: permPath, requireApproval: false, auditLimit: 5 })
  const tool = tools2.get('os_permission_grant')
  assert.ok(tool, 'os_permission_grant was not registered')
  // The declared type is a string, which is exactly what makes the string shape the one that must work.
  assert.equal(tool.parameters.properties.target.type, 'string')

  const out = JSON.parse(await tool.execute(
    { verb: 'file.delete', target: 'C:\\exactly\\one.txt', decision: 'deny-always' },
    { agent: { id: 'A' }, callId: 'c1' },
  ))
  assert.ok(out.rule, `a string target was refused: ${JSON.stringify(out).slice(0, 160)}`)
  assert.equal(out.rule.target.value, 'C:\\exactly\\one.txt', 'the target value was not preserved')
  assert.equal(out.rule.target.kind, 'path', 'a string target must be stored as a path-scoped rule')
  assert.equal(out.rule.broad, false, 'a concrete target must not be recorded as broad')

  // The stored rule must be the one the evaluator then matches.
  const verdict = internals.evaluate(internals.readDocument(permPath).document, 'file.delete', 'C:\\exactly\\one.txt')
  assert.equal(verdict.decision, 'deny-always', 'the stored rule does not match its own target')
})

await check('the wildcard target still demands acknowledgeBroad', async () => {
  reset()
  const tools2 = new Map()
  const ctx2 = {
    tools: { register: (spec) => tools2.set(spec.name, spec) },
    provide: () => () => {},
    inject: () => {},
    effect: (f) => { const d = f(); return () => { if (typeof d === 'function') d() } },
    on: () => () => {},
    get: () => undefined,
  }
  mod.apply(ctx2, { permissionPath: permPath, requireApproval: false, auditLimit: 5 })
  const tool = tools2.get('os_permission_grant')
  await assert.rejects(
    () => tool.execute({ verb: 'file.delete', target: '*', decision: 'deny-always' }, { agent: { id: 'A' }, callId: 'c1' }),
    /acknowledgeBroad/,
    'permanent consent to everything must stay an explicit, separate decision',
  )
})

await check('a durable write with no approval service reports it and writes nothing', async () => {
  // The delegate's whole reason for existing is that the scripts cannot reach the approval UI, so the gate
  // has to fail CLOSED. A silent write would be worse than a refusal, and an exception would lose the
  // reason. `requireApproval` is left at its default (true) and no `approval` service is provided.
  reset()
  const tools2 = new Map()
  const ctx2 = {
    tools: { register: (spec) => tools2.set(spec.name, spec) },
    provide: () => () => {},
    inject: () => {},
    effect: (f) => { const d = f(); return () => { if (typeof d === 'function') d() } },
    on: () => () => {},
    get: () => undefined,
  }
  mod.apply(ctx2, { permissionPath: permPath, auditLimit: 5 })
  const out = JSON.parse(await tools2.get('os_permission_grant').execute(
    { verb: 'file.delete', target: 'C:\\x.txt', decision: 'deny-always' },
    { agent: { id: 'A' }, callId: 'c1' },
  ))
  assert.equal(out.ok, false, 'a durable write must not succeed without an approval')
  assert.equal(out.written, false)
  assert.equal(out.authorization, 'unavailable')
  assert.match(String(out.reason), /approval service/, 'the reason must name what was missing')
  assert.equal(existsSync(permPath), false, 'permission.json must not be created by a refused grant')
})

await check('requireApproval: false is the documented way to grant unattended', async () => {
  reset()
  const tools2 = new Map()
  const ctx2 = {
    tools: { register: (spec) => tools2.set(spec.name, spec) },
    provide: () => () => {},
    inject: () => {},
    effect: (f) => { const d = f(); return () => { if (typeof d === 'function') d() } },
    on: () => () => {},
    get: () => undefined,
  }
  mod.apply(ctx2, { permissionPath: permPath, requireApproval: false, auditLimit: 5 })
  const out = JSON.parse(await tools2.get('os_permission_grant').execute(
    { verb: 'file.delete', target: 'C:\\y.txt', decision: 'deny-always' },
    { agent: { id: 'A' }, callId: 'c1' },
  ))
  assert.ok(out.rule, `an explicit opt-out did not grant: ${JSON.stringify(out).slice(0, 160)}`)
  assert.equal(out.authorizedBy, 'not-required', 'the audit must record why no approval was asked for')
})

await check('the package still declares one bundle patch', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

rmSync(box, { recursive: true, force: true })

console.log()
console.log(`passed=${pass} failed=${fail}`)
if (fail > 0) {
  console.log('failures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
process.exit(0)
