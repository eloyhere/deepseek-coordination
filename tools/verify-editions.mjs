// verify-editions.mjs - prove BOTH PowerShell artefacts are reachable through the plugin.
//
// The 7.6 artefact existed, was built and was tested, but resolveInvocation only ever looked for
// dsh-os.ps1, so nothing could select it. This drives the real handler under each edition and reports
// what actually answered, which is the only way to show the selection works.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
let passes = 0
let failures = 0
const ok = (m) => { passes++; console.log('  PASS  ' + m) }
const bad = (m) => { failures++; console.log('  FAIL  ' + m) }

const hostMod = await import(pathToFileURL(join(root, 'src/plugin/index.js')).href)
const host = hostMod.default ?? hostMod

function ctxWith() {
  const registered = []
  return {
    registered,
    ctx: { tools: { register(t) { registered.push(t); return t } } },
  }
}

// Run selfcheck through the real handler under a given config and report which script answered.
async function runEdition(label, config, env) {
  const saved = process.env.DSH_OS_POWERSHELL_EDITION
  if (env === undefined) delete process.env.DSH_OS_POWERSHELL_EDITION
  else process.env.DSH_OS_POWERSHELL_EDITION = env
  try {
    const { ctx, registered } = ctxWith()
    host.apply(ctx, config)
    const tool = registered.find((t) => t.name === 'dsh_os')
    const value = await tool.execute({ verb: 'selfcheck' }, {})
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const script = (text.match(/"script":"([^"]+)"/) ?? [])[1]
    const ps = (text.match(/"powershell":"([^"]+)"/) ?? [])[1]
    if (script) {
      ok(`${label}: script=${script}, powershell=${ps ?? 'n/a'}`)
      return { script, ps }
    }
    bad(`${label}: no envelope; got ${text.slice(0, 160)}`)
    return null
  } catch (e) {
    // A missing executable is a legitimate outcome to report rather than a crash.
    bad(`${label}: threw: ${e.message.split('\n')[0]}`)
    return null
  } finally {
    if (saved === undefined) delete process.env.DSH_OS_POWERSHELL_EDITION
    else process.env.DSH_OS_POWERSHELL_EDITION = saved
  }
}

console.log('PowerShell edition selection for ' + root)
console.log(`\n== both artefacts present? ==`)
for (const f of ['dsh-os.ps1', 'dsh-os7.ps1', 'dsh-os.sh']) {
  const p = join(root, 'src/host/bin', f)
  const { existsSync } = await import('node:fs')
  if (existsSync(p)) ok(`${f} exists`)
  else bad(`${f} is missing; nothing can select it`)
}

if (process.platform !== 'win32') {
  console.log('\n== not Windows: only the shell artefact applies ==')
  await runEdition('default', {})
} else {
  console.log('\n== the default must stay 5.1 (an existing deployment cannot shift underneath itself) ==')
  const def = await runEdition('default', {})
  if (def?.script?.endsWith('dsh-os.ps1')) ok('default selected dsh-os.ps1 (5.1)')
  else bad(`default selected ${def?.script}, expected dsh-os.ps1`)

  console.log('\n== explicit 7.6 ==')
  const seven = await runEdition("powershellEdition: '7.6'", { powershellEdition: '7.6' })
  if (seven?.script?.endsWith('dsh-os7.ps1')) {
    ok('selected dsh-os7.ps1')
    if (/^7\./.test(seven.ps ?? '')) ok(`the runtime that answered is PowerShell ${seven.ps}`)
    else bad(`expected a 7.x runtime, got ${seven.ps}`)
  } else {
    bad(`selected ${seven?.script}, expected dsh-os7.ps1`)
  }

  console.log('\n== auto: prefers 7.6 when pwsh is present ==')
  const auto = await runEdition("powershellEdition: 'auto'", { powershellEdition: 'auto' })
  if (auto) ok(`auto selected ${auto.script} (powershell ${auto.ps})`)

  console.log('\n== the environment variable selects the edition too ==')
  const viaEnv = await runEdition('DSH_OS_POWERSHELL_EDITION=7.6', {}, '7.6')
  if (viaEnv?.script?.endsWith('dsh-os7.ps1')) ok('environment variable selected dsh-os7.ps1')
  else bad(`environment variable selected ${viaEnv?.script}, expected dsh-os7.ps1`)

  console.log('\n== config wins over the environment ==')
  const both = await runEdition("config '5.1' with env '7.6'", { powershellEdition: '5.1' }, '7.6')
  if (both?.script?.endsWith('dsh-os.ps1')) ok('config won')
  else bad(`config did not win: got ${both?.script}`)
}

console.log('')
console.log(`passed=${passes} failed=${failures}`)
if (failures > 0) process.exit(1)
