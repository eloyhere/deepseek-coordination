/**
 * Shared invocation layer for the dsh-os entry points.
 *
 * Three consumers need to run a verb and get its envelope back:
 *   * `src/plugin/index.js`  the model-facing `dsh_os` tool;
 *   * `src/plugin/takeover.js` the `tools/execute` interception that forwards the built-in
 *     `read`/`write`/`edit`/`pwsh` calls onto dsh-os verbs;
 *   * `src/plugin/settings.js` the settings service the client panel drives, which probes
 *     `selfcheck` and reads `permission list`.
 *
 * The resolution rules below (which artefact, which executable, which argv prefix) were originally
 * inline in the tool plugin. They are extracted rather than copied because a second copy would drift:
 * the 7.6 artefact was unreachable for a while precisely because one place knew about two files and
 * another place did not.
 *
 * Nothing here writes anything. Every export is a pure read of the environment plus a spawn.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Whether a command can be started at all.
 *
 * Used only by the 'auto' edition choice, to decide between the two PowerShell artefacts. It asks the
 * command itself rather than searching PATH by hand, so a shim, an alias-resolved path and a
 * .exe-extension lookup on Windows all behave the way an actual spawn would. A failure to start is the
 * answer being sought, so any error means "not available" and never propagates.
 */
export function executableAvailable(command) {
  try {
    const probe = spawnSync(command, ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], {
      stdio: 'ignore',
      timeout: 10000,
      windowsHide: true,
    })
    return probe.error === undefined && probe.status === 0
  } catch {
    return false
  }
}

/**
 * Find a PowerShell 7 executable.
 *
 * 'pwsh' alone is not enough. Installing PowerShell 7 does NOT put it on PATH for every process, and
 * in this repository's own environment it is at the standard install location while `spawn pwsh`
 * fails with ENOENT. Requiring a PATH entry would therefore make the 7.6 artefact unreachable on a
 * machine where it is plainly installed, which is exactly the bug this selection was added to fix.
 *
 * So the search is: an explicit DSH_OS_POWERSHELL, then PATH, then the two standard install locations.
 * The first entry that starts wins, and null means 7.x is genuinely not available here.
 */
export function findPowerShell7() {
  const explicit = process.env.DSH_OS_POWERSHELL
  if (explicit) return executableAvailable(explicit) ? explicit : null

  const candidates = ['pwsh']
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)']
    const localAppData = process.env.LOCALAPPDATA
    candidates.push(join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
    if (programFilesX86) candidates.push(join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'))
    if (localAppData) candidates.push(join(localAppData, 'Microsoft', 'PowerShell', '7', 'pwsh.exe'))
  } else {
    candidates.push('/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh')
  }

  for (const candidate of candidates) {
    // A bare name is left to PATH resolution; an absolute path is checked for existence first so the
    // probe does not pay for a spawn that cannot succeed.
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (!existsSync(candidate)) continue
    }
    if (executableAvailable(candidate)) return candidate
  }
  return null
}

// src/plugin/invoke.js -> package root, which is THREE levels up from the file:
//   file          <pkg>/src/plugin/invoke.js
//   dirname       <pkg>/src/plugin
//   dirname       <pkg>/src
//   dirname       <pkg>            <- what the scripts are joined against
// Getting this off by one is invisible until runtime, where it reports "no entry point" while the
// file is present; tests/plugin.test.mjs pins it.
export const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** Where the implementation lives inside the package, unless a caller overrides it. */
export const DEFAULT_SCRIPT_DIR = 'src/host/bin'

/**
 * Resolve how to invoke the implementation.
 *
 * Returns { command, prefix, script, edition } where the final argv is [...prefix, ...verbArguments].
 *
 * A .bat cannot be executed directly: cmd.exe interprets it, so spawning it with shell:false fails
 * with EINVAL on Windows. The .ps1 is therefore preferred and launched through powershell.exe, which
 * is an executable and keeps the call shell-free. The .bat shim exists for a human at a cmd prompt,
 * not for this plugin. A .sh is executed by bash for the same reason: the script need not be marked
 * executable in the checkout for the plugin to work.
 *
 * TWO PowerShell artefacts exist and BOTH are selectable:
 *
 *   bin/dsh-os.ps1   built from src/host/lib/powershell5.1, run by powershell.exe   (Windows PowerShell 5.1)
 *   bin/dsh-os7.ps1  built from src/host/lib/powershell7.6, run by pwsh             (PowerShell 7)
 *
 * The default is unchanged at 5.1 so a deployment that is already working cannot change behaviour
 * underneath itself; `powershellEdition: '7.6'` or `'auto'` selects the other one, and
 * DSH_OS_POWERSHELL still overrides the executable. `'auto'` uses 7.6 only when both the artefact and
 * a pwsh executable are present, and falls back to 5.1 otherwise.
 */
export function resolveInvocation(rawConfig) {
  // `?? {}` rather than a default parameter. Cordis passes a row's config through as `null` when the row
  // declares none, and a default parameter only fires for `undefined` — so `config.scriptPath` on that
  // null threw and the plugin row failed to activate. Every caller may pass null.
  const config = rawConfig ?? {}
  const explicit = config.scriptPath ? [config.scriptPath] : []
  const dir = config.scriptPath
    ? dirname(config.scriptPath)
    : join(PKG_ROOT, config.scriptDir ?? DEFAULT_SCRIPT_DIR)

  // The edition may come from config or the environment; config wins because it is the more specific
  // statement, and the environment is there for a deployment that cannot edit the profile.
  const edition = String(config.powershellEdition ?? process.env.DSH_OS_POWERSHELL_EDITION ?? '5.1').toLowerCase()

  const ps51 = { file: 'dsh-os.ps1', command: 'powershell.exe', edition: '5.1' }
  const ps7 = { file: 'dsh-os7.ps1', command: 'pwsh', edition: '7.6' }

  // The PowerShell 7 executable is located once, because the search probes processes and must not run
  // per candidate.
  const ps7Command = process.platform === 'win32' ? findPowerShell7() : null

  // Build the candidate list for this platform. An explicit scriptPath disables the edition choice
  // entirely: the caller has named a file, so that file is what runs.
  let powershellCandidates = []
  if (process.platform === 'win32') {
    if (edition === '7.6' || edition === '7') {
      powershellCandidates = ps7Command ? [{ ...ps7, command: ps7Command }, ps51] : [ps51]
    } else if (edition === 'auto') {
      const ps7Ready = ps7Command !== null && existsSync(join(dir, ps7.file))
      powershellCandidates = ps7Ready ? [{ ...ps7, command: ps7Command }, ps51] : [ps51, ps7]
    } else {
      powershellCandidates = [ps51, ps7]
    }
  }

  const candidates = explicit.concat(process.platform === 'win32'
    ? powershellCandidates.map((c) => join(dir, c.file))
    : [join(dir, 'dsh-os.sh')])

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (candidate.toLowerCase().endsWith('.ps1')) {
      // The edition is derived from the FILE that was found, not from the request, because the request
      // may have named the other one and a fallback happened.
      const chosen = powershellCandidates.find((c) => join(dir, c.file) === candidate)
      const isSeven = chosen ? chosen.edition === '7.6' : false
      // -ExecutionPolicy is a Windows PowerShell option. pwsh accepts it on Windows but not everywhere,
      // so it is only passed to the 5.1 executable. The resolved command is used, not the literal name,
      // because a located pwsh is an absolute path.
      const base = ['-NoLogo', '-NoProfile', '-NonInteractive']
      return {
        script: candidate,
        command: process.env.DSH_OS_POWERSHELL ?? (chosen ? chosen.command : ps51.command),
        // -File passes the script and its arguments as separate argv entries. -Command would make
        // PowerShell re-parse a single string, which is exactly the quoting layer this surface avoids.
        prefix: isSeven
          ? [...base, '-File', candidate]
          : [...base, '-ExecutionPolicy', 'Bypass', '-File', candidate],
        edition: chosen ? chosen.edition : '5.1',
      }
    }
    if (candidate.toLowerCase().endsWith('.sh')) {
      return {
        script: candidate,
        command: '/bin/bash',
        prefix: [candidate],
        edition: 'posix',
      }
    }
    if (candidate.toLowerCase().endsWith('.bat')) {
      // Only reachable when a caller explicitly configures a .bat; cmd.exe must interpret it.
      return {
        script: candidate,
        command: process.env.ComSpec ?? 'cmd.exe',
        prefix: ['/d', '/c', candidate],
        edition: 'bat',
      }
    }
  }
  return null
}

/** The directory an invocation would search, for error messages that name a real path. */
export function searchedDirectory(rawConfig) {
  const config = rawConfig ?? {}
  return config.scriptPath ?? join(PKG_ROOT, config.scriptDir ?? DEFAULT_SCRIPT_DIR)
}

/**
 * Run the script with an argv array and capture stdout/stderr as bytes.
 *
 * Streams are read to completion rather than awaited one at a time: reading one pipe fully before the
 * other deadlocks as soon as the unread pipe fills.
 */
export function runScript(invocation, verbArgs, timeoutMs = 120000, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefix, ...verbArgs], {
      windowsHide: true,
      // No shell. The argv array is passed through as-is.
      shell: false,
    })
    const out = []
    const err = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* already gone */ }
    }, timeoutMs)
    const onAbort = () => { try { child.kill() } catch { /* already gone */ } }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', (e) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({
        code,
        timedOut,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
  })
}

/**
 * Run one verb and return its parsed envelope.
 *
 * The envelope is the contract, so it is parsed here once: `ok` decides the branch and `error.code`
 * is authoritative, never `error.message`. A caller that needs the raw text uses `runVerb` instead.
 *
 * `options.allow` appends `--allow`, which is what every mutating verb requires. It is only ever set
 * by a caller that has already resolved authorization: this function does not decide anything.
 */
export async function invokeVerb(invocation, verb, args = [], flags = [], options = {}) {
  const verbArgs = [...String(verb).trim().split(/\s+/)]
  for (const value of args) verbArgs.push(String(value))
  for (const flag of flags) verbArgs.push(String(flag))
  if (options.allow === true) verbArgs.push('--allow')

  const result = await runScript(invocation, verbArgs, options.timeoutMs ?? 120000, options.signal)

  if (result.timedOut) {
    const error = new Error(`dsh-os verb "${verb}" timed out after ${options.timeoutMs ?? 120000}ms`)
    error.code = 'E_TIMEOUT'
    throw error
  }
  const text = result.stdout.trim()
  if (text === '') {
    const error = new Error(
      `dsh-os verb "${verb}" produced no envelope (exit ${result.code})` +
      (result.stderr.trim() ? `: ${result.stderr.trim()}` : ''),
    )
    error.code = 'E_NO_ENVELOPE'
    error.stderr = result.stderr
    throw error
  }
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch (cause) {
    const error = new Error(`dsh-os verb "${verb}" emitted a non-JSON envelope: ${text.slice(0, 200)}`)
    error.code = 'E_ENVELOPE_MALFORMED'
    error.cause = cause
    throw error
  }
  return { envelope, exitCode: result.code, stderr: result.stderr }
}

/**
 * Run one verb and return only `result`, throwing a typed error for a failed envelope.
 *
 * The thrown error carries `code` from the envelope, so a caller branches on the same vocabulary it
 * would have branched on in a shell, while the message stays human-readable for the tool result.
 */
export async function invokeForResult(invocation, verb, args = [], flags = [], options = {}) {
  const { envelope, stderr } = await invokeVerb(invocation, verb, args, flags, options)
  if (envelope.ok === true) return envelope.result
  const code = envelope.error?.code ?? 'E_INTERNAL'
  const error = new Error(envelope.error?.message ?? `dsh-os verb "${verb}" failed`)
  error.code = code
  error.hint = envelope.error?.hint
  error.verb = envelope.verb ?? verb
  error.stderr = stderr
  throw error
}
