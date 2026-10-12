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

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-os'

/** The plugin is inert without the tool registry. */
export const inject = ['tools']

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Resolve the platform entry point, or null when this deployment has no script for it. */
function resolveEntry(scriptDir) {
  const dir = join(PKG_ROOT, scriptDir)
  const candidates = process.platform === 'win32'
    ? [join(dir, 'dsh-os.bat'), join(dir, 'dsh-os.ps1')]
    : [join(dir, 'dsh-os.sh')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Run the script with an argv array and capture stdout/stderr as bytes.
 *
 * Streams are read to completion rather than awaited one at a time: reading one pipe fully before the
 * other deadlocks as soon as the unread pipe fills.
 */
function runScript(entry, argv, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry, argv, {
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
  const scriptDir = config.scriptDir ?? 'src/host/bin'
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
      verb: {
        type: 'string',
        required: true,
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
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const entry = resolveEntry(scriptDir)
      if (entry === null) {
        throw new Error(
          `dsh-os has no entry point for platform "${process.platform}" under ${scriptDir}; ` +
          'the POSIX implementation may not be built yet (run tools/build.ps1)',
        )
      }

      // The verb may be given as several words; the script resolves multi-word verbs itself, so it is
      // split here rather than guessed at.
      const argv = [...String(args.verb).trim().split(/\s+/)]
      for (const value of args.arguments ?? []) argv.push(String(value))
      for (const flag of args.flags ?? []) argv.push(String(flag))
      if (args.allow === true) argv.push('--allow')

      const result = await runScript(entry, argv, timeoutMs, exec?.signal)

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
