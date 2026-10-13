// verify-package.mjs - the published tarball must contain everything the plugin needs at runtime.
//
// This exists because src/host/bin/dsh-os7.ps1 was missing from package.json's `files` while the plugin
// resolves it by name: resolveInvocation looks for it as the 7.6 edition and falls back to the 5.1 one,
// so `powershellEdition: '7.6'` would fail for every INSTALLED user while working perfectly in this
// checkout, where the file happens to be on disk. A distribution gap of that shape is invisible to every
// other test in this repository because they all run from the repository.
//
// It packs the package for real and inspects the file list, rather than parsing `files` and trusting it:
// npm applies its own rules, and the point is what actually ships.
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
let passes = 0
let failures = 0
const ok = (m) => { passes++; console.log('  PASS  ' + m) }
const bad = (m) => { failures++; console.log('  FAIL  ' + m) }

console.log('package completeness for ' + root)

// npm pack --dry-run --json prints the manifest; it does not write a tarball.
//
// The npm CLI is run as a NODE SCRIPT rather than through a shell. `shell: true` is what the first
// version used, and Node warns about it on every run (DEP0190) because arguments are concatenated rather
// than escaped. Resolving the CLI and running it with the current interpreter avoids the shell entirely,
// which also means this works the same on Windows and POSIX.
const npmCli = (() => {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
})()

let manifest
try {
  const args = ['pack', '--dry-run', '--json']
  const out = npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npm', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  manifest = JSON.parse(out)
} catch (e) {
  bad(`npm pack --dry-run failed: ${e.message}`)
  console.log('')
  console.log(`passed=${passes} failed=${failures}`)
  process.exit(1)
}

const entry = Array.isArray(manifest) ? manifest[0] : manifest
const shipped = new Set((entry.files ?? []).map((f) => f.path.replace(/\\/g, '/')))

console.log(`  the tarball would contain ${shipped.size} file(s), ${Math.round(entry.size / 1024)} KB packed`)
console.log('')

// ---------------------------------------------------------------------------
// Everything the runtime resolves by name. Each entry says WHY it is needed, so a future removal has to
// argue with the reason rather than with a bare path.
// ---------------------------------------------------------------------------
const required = [
  ['src/plugin/index.js', 'the package entry point; the dsh_os tool lives here'],
  ['client.js', 'the dsh.client artifact; without it the settings panel never loads even though dsh.client is declared'],
  ['src/plugin/invoke.js', 'the shared invocation layer every plugin entry imports; the tool, the takeover and the settings service all spawn through it'],
  ['src/plugin/settings.js', 'the ./settings subpath export, loaded by its own patch row'],
  ['src/plugin/takeover.js', 'the ./takeover subpath export, loaded by its own patch row'],
  ['src/plugin/workflow.js', 'the ./workflow subpath export, loaded by its own patch row; without it the workflow tool and its prompt section never register'],
  ['src/permission/index.js', 'the ./permission subpath export, loaded by the second patch row'],
  ['cordis.patch.yml', 'dsh.bundle.patch; without it the loader has no patch list'],
  ['src/host/bin/dsh-os.ps1', 'the PowerShell 5.1 entry point the plugin spawns on Windows'],
  ['src/host/bin/dsh-os7.ps1', 'the PowerShell 7.6 entry point; powershellEdition 7.6/auto resolves it by this exact name'],
  ['src/host/bin/dsh-os.sh', 'the POSIX entry point the plugin spawns through /bin/bash'],
  ['src/host/bin/dsh-os.bat', 'the hand-written cmd.exe shim'],
  ['src/host/spec/verbs.tsv', 'the verb table; selfcheck and verb resolution read it from the package'],
  ['src/host/spec/charsets.tsv', 'the charset table for file charset/encode and file verify'],
  ['src/host/command.txt', 'the contract the scripts and selfcheck refer to'],
  ['tools/measure-cache.mjs', 'the prefix-cache measurement the README quotes; a shipped claim needs its tool to ship with it'],
]

for (const [path, why] of required) {
  if (shipped.has(path)) ok(`${path}`)
  else bad(`${path} is NOT in the tarball - ${why}`)
}

// ---------------------------------------------------------------------------
// The plugin must not resolve a path the tarball does not contain. Checked against the real resolution
// code rather than a copy of its logic, so the two cannot drift.
// ---------------------------------------------------------------------------
console.log('')
console.log('== the plugin resolves only paths that ship ==')
try {
  const mod = await import(new URL('../src/plugin/index.js', import.meta.url).href)
  const plugin = mod.default ?? mod
  const registered = []
  plugin.apply({ tools: { register: (t) => { registered.push(t); return t } } }, {})
  const tool = registered.find((t) => t.name === 'dsh_os')
  if (!tool) {
    bad('the plugin did not register dsh_os, so its resolution cannot be checked')
  } else {
    // Exercising the handler proves the whole chain works from the packed layout; it reads the files
    // above by the same names the loader would.
    const value = await tool.execute({ verb: 'selfcheck' }, {})
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const script = (text.match(/"script":"([^"]+)"/) ?? [])[1]
    if (script) {
      ok(`the resolved entry point runs: ${script}`)
      if (shipped.has('src/host/bin/' + script.split(/[\\/]/).pop())) {
        ok(`${script} is itself in the tarball`)
      } else {
        bad(`the resolved entry point ${script} is not in the tarball`)
      }
    } else {
      bad(`the handler returned no envelope: ${text.slice(0, 160)}`)
    }
  }
} catch (e) {
  bad(`exercising the plugin threw: ${e.message}`)
}

// ---------------------------------------------------------------------------
// files/README sanity
// ---------------------------------------------------------------------------
console.log('')
console.log('== metadata ==')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.private === true) bad('package.json has "private": true, so npm would refuse to publish')
else ok('not marked private')
if (pkg.license) ok(`license: ${pkg.license}`)
else bad('no license field')
if (pkg.repository?.url) ok('repository field present')
else bad('no repository field')
// A files entry that matches nothing is a silent mistake: npm ignores it and the path never ships.
for (const pattern of pkg.files ?? []) {
  const abs = join(root, pattern)
  if (!existsSync(abs)) {
    // A directory-only entry is allowed to be a glob; only a literal path is checked.
    if (!/[*?]/.test(pattern)) bad(`files entry matches nothing on disk: ${pattern}`)
  }
}

console.log('')
console.log(`passed=${passes} failed=${failures}`)
if (failures > 0) process.exit(1)
