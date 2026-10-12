// verify-plugin-load.mjs - load the plugins through the REAL apply() path and run a verb end to end.
//
// tools/verify-bundle.mjs proves the loader's resolution contract (manifest -> patch -> module). This
// goes one step further and proves the two things that only fail at runtime:
//
//   1. apply() registers a tool on the context, with a schema the provider would accept
//   2. the registered handler actually spawns the script and returns a real envelope
//
// Neither had ever been exercised outside a live profile. The plugins import only Node builtins, so a
// mock context is enough to run them for real; nothing here touches the live profile.
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
let passes = 0
let failures = 0
const ok = (m) => { passes++; console.log('  PASS  ' + m) }
const bad = (m) => { failures++; console.log('  FAIL  ' + m) }

// A context that records what a plugin registers. This is the seam the loader uses: a Cordis context
// exposing ctx.tools.register. Anything else the plugins need would show up as a TypeError here.
function makeCtx() {
  const registered = []
  const ctx = {
    tools: {
      register(tool) {
        if (registered.some((t) => t.name === tool.name)) {
          throw new Error(`tool "${tool.name}" is already registered`)
        }
        registered.push(tool)
        return tool
      },
    },
  }
  return { ctx, registered }
}

console.log('plugin load verification for ' + root)
// The handler resolves its entry point by PLATFORM, not by runtime, so whichever PowerShell is on PATH
// is what ran. That is recorded rather than left implicit: a green result here means "the plugin loaded
// and drove the script", and the reader needs to know which script answered.
const entryForPlatform = process.platform === 'win32' ? 'dsh-os.ps1' : 'dsh-os.sh'
console.log(`platform=${process.platform}; the handler will drive ${entryForPlatform}`)

// ---- 1. the host plugin -------------------------------------------------------------------------
console.log('\n== 1. host plugin: apply() registers dsh_os ==')
const hostMod = await import(pathToFileURL(join(root, 'src/plugin/index.js')).href)
const host = hostMod.default ?? hostMod
const a = makeCtx()

// A second registration with the same name must throw, which is the documented failure that aborts a
// whole entry when two patch rows resolve to the same module.
try {
  host.apply(a.ctx, {})
  ok(`apply() completed; registered: ${a.registered.map((t) => t.name).join(', ')}`)
} catch (e) {
  bad(`apply() threw: ${e.message}`)
}

const hostTool = a.registered.find((t) => t.name === 'dsh_os')
if (!hostTool) {
  bad('dsh_os was not registered')
} else {
  ok('tool name is dsh_os')
  // The schema must be a JSON Schema OBJECT. A bare property map is the documented mistake that makes
  // the provider reject the whole request, so the root type is asserted rather than assumed.
  if (hostTool.parameters?.type === 'object') ok('parameters is a JSON Schema with type "object"')
  else bad(`parameters.type is ${JSON.stringify(hostTool.parameters?.type)}, expected "object"`)
  if (typeof hostTool.execute === 'function') ok('execute() is a function')
  else bad('execute() is missing')
  if (hostTool.description) ok('description present')
  else bad('description missing')
}

// ---- 2. the permission plugin ------------------------------------------------------------------
console.log('\n== 2. permission plugin: apply() registers its tools ==')
const permMod = await import(pathToFileURL(join(root, 'src/permission/index.js')).href)
const perm = permMod.default ?? permMod
const b = makeCtx()
try {
  perm.apply(b.ctx, {})
  ok(`apply() completed; registered ${b.registered.length}: ${b.registered.map((t) => t.name).join(', ')}`)
} catch (e) {
  bad(`apply() threw: ${e.message}`)
}
for (const t of b.registered) {
  if (t.parameters?.type === 'object' && typeof t.execute === 'function') {
    ok(`${t.name}: schema root is an object and execute() is a function`)
  } else {
    bad(`${t.name}: schema type=${JSON.stringify(t.parameters?.type)} execute=${typeof t.execute}`)
  }
}

// ---- 3. the host handler actually runs a verb ---------------------------------------------------
console.log('\n== 3. the registered handler spawns the script and returns an envelope ==')
if (hostTool?.execute) {
  try {
    // exec is passed through to the script runner; a bare object is enough, matching how the registry
    // calls a handler.
    const value = await hostTool.execute({ verb: 'selfcheck' }, {})
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    let parsed = null
    // The handler returns the envelope verbatim, possibly as a string.
    try { parsed = JSON.parse(typeof value === 'string' ? value : JSON.stringify(value)) } catch { }
    if (!parsed && typeof value === 'object') parsed = value
    if (parsed?.ok === true && parsed?.verb === 'selfcheck') {
      ok(`selfcheck through the handler: ok=${parsed.ok}, verbCount=${parsed.result?.verbCount}, implemented=${parsed.result?.implementedCount ?? 'n/a'}`)
    } else if (typeof value === 'string' && value.trim().startsWith('{')) {
      // The envelope may be returned as raw text; a leading brace plus ok true is enough.
      if (/"ok":true/.test(value)) ok('handler returned an ok envelope as text')
      else bad(`handler returned text that is not an ok envelope: ${value.slice(0, 160)}`)
    } else {
      bad(`handler returned something unexpected: ${text.slice(0, 200)}`)
    }
  } catch (e) {
    bad(`handler threw: ${e.message}`)
  }
}

// ---- 4. a mutating verb through the handler requires allow --------------------------------------
console.log('\n== 4. a mutating verb is refused without allow ==')
if (hostTool?.execute) {
  try {
    const value = await hostTool.execute({ verb: 'environment delete DSH_DOES_NOT_EXIST', arguments: [], flags: ['--scope', 'process'] }, {})
    const s = typeof value === 'string' ? value : JSON.stringify(value)
    if (/"ok":false/.test(s) && /"code":"E_/.test(s)) {
      const code = (s.match(/"code":"([A-Z_]+)"/) ?? [])[1]
      ok(`refused with a typed code: ${code}`)
    } else {
      bad(`expected a typed refusal, got: ${s.slice(0, 200)}`)
    }
  } catch (e) {
    bad(`handler threw instead of returning an envelope: ${e.message}`)
  }
}

console.log('')
console.log(`passed=${passes} failed=${failures}`)
if (failures > 0) process.exit(1)
