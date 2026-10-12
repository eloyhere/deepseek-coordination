/**
 * dsh-os host plugin.
 *
 * Registers one model-facing tool, `dsh_os`, that runs a verb of the atomic OS-interaction surface
 * and returns its JSON envelope verbatim.
 *
 * One tool rather than one tool per verb, deliberately:
 *   * the verb table is the contract and it lives in spec/verbs.tsv, so the tool schema does not have
 *     to be regenerated every time a verb is added or renamed (the `environment attribute` rename cost
 *     four edits once already);
 *   * an agent discovers the surface in a single call (`verb: "selfcheck"`) instead of from a
 *     several-hundred-line tool list;
 *   * the envelope is already the stable, parseable result shape, so the tool adds no second
 *     contract that could drift from the script's.
 *
 * The implementation is spawned by absolute path with an argv array. It is never invoked through a
 * shell string: that is what makes a path containing spaces stay a single argument, and it is the
 * core reason this surface exists.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-os'

/** The plugin is inert without the tool registry. */
export const inject = ['tools']

/**
 * Whether a command can be started at all.
 *
 * Used only by the 'auto' edition choice, to decide between the two PowerShell artefacts. It asks the
 * command itself rather than searching PATH by hand, so a shim, an alias-resolved path and a
 * .exe-extension lookup on Windows all behave the way an actual spawn would. A failure to start is the
 * answer being sought, so any error means "not available" and never propagates.
 */
function executableAvailable(command) {
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
 * in this very repository's own environment it is at the standard install location while `spawn pwsh`
 * fails with ENOENT. Requiring a PATH entry would therefore make the 7.6 artefact unreachable on a
 * machine where it is plainly installed, which is exactly the bug this selection was added to fix.
 *
 * So the search is: an explicit DSH_OS_POWERSHELL, then PATH, then the two standard install locations.
 * The first entry that starts wins, and null means 7.x is genuinely not available here.
 */
function findPowerShell7() {
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

// src/plugin/index.js -> package root, which is THREE levels up from the file:
//   file          <pkg>/src/plugin/index.js
//   dirname       <pkg>/src/plugin
//   dirname       <pkg>/src
//   dirname       <pkg>            <- what the scripts are joined against
// Getting this off by one is invisible until runtime, where it reports "no entry point" while the
// file is present; tests/plugin.test.mjs pins it.
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/**
 * Resolve how to invoke the implementation.
 *
 * Returns { command, prefix } where the final argv is [...prefix, ...verbArguments].
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
 * The 7.6 artefact was unreachable from here for a while: it existed, was built and was tested, but this
 * function only ever looked for dsh-os.ps1. The default is unchanged at 5.1 so a deployment that is
 * already working cannot change behaviour underneath itself; `powershellEdition: '7.6'` or `'auto'`
 * selects the other one, and DSH_OS_POWERSHELL still overrides the executable. `'auto'` uses 7.6 only
 * when both the artefact and a pwsh executable are present, and falls back to 5.1 otherwise.
 */
function resolveInvocation(config) {
  const explicit = config.scriptPath ? [config.scriptPath] : []
  const dir = config.scriptPath
    ? dirname(config.scriptPath)
    : join(PKG_ROOT, config.scriptDir ?? 'src/host/bin')

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
      }
    }
    if (candidate.toLowerCase().endsWith('.bat')) {
      // Only reachable when a caller explicitly configures a .bat; cmd.exe must interpret it.
      return {
        script: candidate,
        command: process.env.ComSpec ?? 'cmd.exe',
        prefix: ['/d', '/c', candidate],
      }
    }
  }
  return null
}

/**
 * Run the script with an argv array and capture stdout/stderr as bytes.
 *
 * Streams are read to completion rather than awaited one at a time: reading one pipe fully before the
 * other deadlocks as soon as the unread pipe fills.
 */
function runScript(invocation, verbArgs, timeoutMs, signal) {
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

export function apply(ctx, config = {}) {
  const timeoutMs = config.timeoutMs ?? 120000

  ctx.tools.register({
    name: 'dsh_os',
    description: [
      'Run one verb of the dsh-os atomic OS-interaction surface and return its JSON envelope.',
      'Use verb "selfcheck" first to list every verb with its arguments, flags and platform support.',
      'Arguments are passed as separate argv elements, so a value containing spaces stays one value;',
      'both the positional form (file create "./a.txt" "123" "utf-8-bom") and the named form',
      '(file create path="./a.txt" content="123") are accepted.',
      'Read-only verbs need no authorization; mutating verbs require allow: true.',
    ].join(' '),
    parameters: {
      // A COMPLETE JSON Schema, not the property map that `defineTool` accepts.
      //
      // The registry's `register()` takes a finished schema and does not compile one for you: only the
      // internal `defineTool` runs `parameterSchemaSpecToJsonSchema` over a { name: {...} } map. Passing
      // the bare map here ships a schema whose root has no `type`, and the provider rejects the whole
      // request with `schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
      type: 'object',
      properties: {
        verb: {
          type: 'string',
          description: 'Verb to run, e.g. "selfcheck", "file charset", "environment attribute get".',
        },
        arguments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Positional arguments and named arguments (name="value") in any order.',
        },
        flags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Flags, e.g. "--scope", "user", "--recursive". Prefix with -- exactly as documented.',
        },
        allow: {
          type: 'boolean',
          description: 'Authorization for a mutating verb. Required by create, delete, edit, execute, window, keyboard, clipboard, text, structure.',
        },
      },
      required: ['verb'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const invocation = resolveInvocation(config)
      if (invocation === null) {
        // The message names the directory that was actually searched, because the first version of
        // this code reported a plausible-looking path that was one level off and cost a debugging
        // round to find.
        const searched = config.scriptPath ?? join(PKG_ROOT, config.scriptDir ?? 'src/host/bin')
        throw new Error(
          `dsh-os has no entry point for platform "${process.platform}"; searched ${searched}` +
          ' (run tools/build.ps1 to generate it, or set the scriptPath config)',
        )
      }

      // The verb may be given as several words; the script resolves multi-word verbs itself, so it is
      // split here rather than guessed at.
      const verbArgs = [...String(args.verb).trim().split(/\s+/)]
      for (const value of args.arguments ?? []) verbArgs.push(String(value))
      for (const flag of args.flags ?? []) verbArgs.push(String(flag))
      if (args.allow === true) verbArgs.push('--allow')

      const result = await runScript(invocation, verbArgs, timeoutMs, exec?.signal)

      if (result.timedOut) {
        throw new Error(`dsh-os verb "${args.verb}" timed out after ${timeoutMs}ms`)
      }

      const text = result.stdout.trim()
      if (text === '') {
        // An empty stdout would leave the caller with nothing to parse, so the exit code and the
        // captured diagnostics are reported instead of an empty success.
        throw new Error(
          `dsh-os verb "${args.verb}" produced no envelope (exit ${result.code})` +
          (result.stderr.trim() ? `: ${result.stderr.trim()}` : ''),
        )
      }

      // The envelope is returned verbatim, including when ok is false: a typed failure is a result the
      // caller must be able to read (error.code is authoritative), not an exception that loses it.
      return text
    },
  })
}
