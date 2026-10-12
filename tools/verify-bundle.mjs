// verify-bundle.mjs - verify the loader contract for this package WITHOUT touching the live profile.
//
// A bundle is an npm package whose manifest declares `dsh.bundle.patch`; the loader applies each row of
// that patch over the profile's entry list, resolving each row's `name` as a PACKAGE SPECIFIER and then
// importing it. So the four things that can make this package fail to load are:
//
//   1. the manifest does not declare dsh.bundle.patch, or the file is missing/unparseable
//   2. a row's `name` does not resolve from the profile's node_modules
//   3. the resolved module does not export the Cordis plugin shape the loader calls (apply/inject/name)
//   4. two rows resolve to the SAME module, which registers the same tool twice and aborts the entry
//
// Each is checked here. The live profile is never written to.
import { readFileSync, existsSync, mkdirSync, symlinkSync, rmSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const pkgPath = join(root, 'package.json')
let failures = 0
let passes = 0
const ok = (m) => { passes++; console.log('  PASS  ' + m) }
const bad = (m) => { failures++; console.log('  FAIL  ' + m) }

console.log('bundle load verification for ' + root)

// ---- 1. the manifest declares a bundle patch, and the file parses -------------------------------
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
console.log('\n== 1. manifest -> patch file ==')
const patchRel = pkg?.dsh?.bundle?.patch
if (!patchRel) {
  bad('package.json does not declare dsh.bundle.patch, so no loader would treat this as a bundle')
} else {
  ok(`dsh.bundle.patch = ${patchRel}`)
}
const patchPath = patchRel ? join(root, patchRel) : null
if (!patchPath || !existsSync(patchPath)) {
  bad(`patch file missing: ${patchRel}`)
} else {
  ok('patch file exists')
}

// The loader parses YAML. It is parsed here with a minimal reader so this check has no dependency the
// project does not already have; the shapes it needs are a top-level array of `- insert:` rows.
const patchText = patchPath && existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
const rowNames = [...patchText.matchAll(/^\s*name:\s*["']?([^"'\s#]+)["']?/gm)].map((m) => m[1])
if (rowNames.length === 0) {
  bad('no `name:` entries found in the patch file')
} else {
  ok(`patch declares ${rowNames.length} row name(s): ${rowNames.join(', ')}`)
}

// ---- 2. each row name resolves as a package specifier from a profile-like node_modules -----------
console.log('\n== 2. each row resolves as a package specifier ==')
// A throwaway npm-style root, so resolution happens exactly as it would in a profile: the loader
// resolves from the profile directory, where node_modules holds the installed package.
const sandbox = join(root, '.temporary', 'profile-sandbox')
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(join(sandbox, 'node_modules'), { recursive: true })

// Install the package under the name it declares, by junction. A junction is used rather than a copy so
// this verifies the real directory, and on Windows a directory symlink needs elevation while a junction
// does not.
const installAs = pkg.name
const linkPath = join(sandbox, 'node_modules', installAs)
try {
  symlinkSync(root, linkPath, 'junction')
  ok(`linked ${installAs} -> ${root}`)
} catch (e) {
  bad(`could not link the package into the sandbox: ${e.message}`)
}

// The scope directory for the subpath export, e.g. deepseek-coordination/permission needs no scope
// because it is not scoped itself; nothing extra to do here.
const requireFromSandbox = createRequire(join(sandbox, 'noop.js'))
const resolved = new Map()
for (const name of rowNames) {
  try {
    const p = requireFromSandbox.resolve(name)
    resolved.set(name, p)
    ok(`resolved ${name} -> ${p.slice(root.length + 1) || p}`)
  } catch (e) {
    bad(`could NOT resolve '${name}' from a profile node_modules: ${e.message}`)
  }
}

// ---- 3. the resolved modules export the plugin shape the loader calls ---------------------------
console.log('\n== 3. each resolved module exports the Cordis plugin shape ==')
for (const [name, file] of resolved) {
  try {
    const mod = await import(pathToFileURL(file).href)
    const plugin = mod.default ?? mod
    const hasApply = typeof plugin?.apply === 'function'
    const hasName = typeof plugin?.name === 'string'
    if (hasApply && hasName) {
      // inject may legitimately be absent, so it is reported rather than required.
      const inj = plugin.inject === undefined ? 'no inject' : `inject=[${[].concat(plugin.inject).join(',')}]`
      ok(`${name}: apply() present, name='${plugin.name}', ${inj}`)
    } else {
      bad(`${name}: apply=${typeof plugin?.apply}, name=${typeof plugin?.name} - the loader calls apply()`)
    }
  } catch (e) {
    bad(`${name}: import threw: ${e.message}`)
  }
}

// ---- 4. distinct rows must resolve to DISTINCT modules ------------------------------------------
console.log('\n== 4. rows resolve to distinct modules ==')
const files = [...resolved.values()]
const unique = new Set(files)
if (files.length === 0) {
  bad('nothing resolved, so distinctness cannot be established')
} else if (unique.size !== files.length) {
  bad(`two rows resolve to the same module; the second load would register the same tool twice: ${files.join(', ')}`)
} else {
  ok(`${files.length} row(s) resolve to ${unique.size} distinct module(s)`)
}

// ---- the version gate --------------------------------------------------------------------------
console.log('\n== 5. version gate ==')
const peers = { ...(pkg.peerDependencies ?? {}) }
const dshPeers = Object.keys(peers).filter((k) => k.startsWith('@deepseek-ai/dsh'))
if (dshPeers.length === 0) {
  ok('no @deepseek-ai/dsh peerDependency is declared, so the loader\'s version gate has nothing to compare and admits the bundle')
} else {
  ok(`declares dsh peerDependencies: ${dshPeers.join(', ')}`)
}

rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(`passed=${passes} failed=${failures}`)
if (failures > 0) process.exit(1)
