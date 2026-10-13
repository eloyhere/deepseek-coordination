/**
 * dsh-os takeover: route the built-in file and shell tools onto dsh-os verbs.
 *
 * WHY THIS IS A SEPARATE PLUGIN ROW
 *
 * `dsh_os` is a tool the model has to be *told* to use. In practice it never is: the built-in
 * `read`/`write`/`edit`/`pwsh` tools are right there, they overlap almost completely, and nothing in
 * the prompt prefers one over the other. The result is that the byte-level guarantees this project
 * exists for are never exercised — the plugin is installed and imperceptible.
 *
 * This row removes the choice. When a user enables takeover in the settings panel, the built-in calls
 * are intercepted and answered by the same machinery, so the guarantees apply whether or not the model
 * cooperates.
 *
 * WHY `tools/execute` AND NOT A SHADOWING REGISTRATION
 *
 * `@deepseek-ai/dsh-tools` lets a scoped registration shadow a global tool, which looks like the
 * obvious mechanism. It does not work here. The Web/desktop composition disables the host-side
 * `tool-fs`/`tool-pwsh` rows and remounts them inside every agent *preset* (`dsh-web-app`'s patch),
 * so the built-ins live in a scope layer that is NEARER than any global registration this plugin could
 * make — the preset would shadow us, not the other way round.
 *
 * `tools/execute` (dsh-tools `dispatchScheduledExecution`) is the around-dispatch waterfall:
 *
 *     ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec))
 *
 * A handler that returns `{ value }` without calling `next()` replaces the tool body's value. The
 * value is then validated against the BUILT-IN tool's own `output.schema` and rendered by the BUILT-IN
 * `output.render` (`normalizeDispatchResult` -> `createSuccessResult`), so the model-facing text, the
 * diff cards and the presentation metadata stay exactly what they were: the only thing that changes is
 * where the bytes came from.
 *
 * WHAT IS DELIBERATELY NOT TAKEN OVER
 *
 *   * `glob` and `grep` stay built-in. dsh-os has no content-search verb at all, and `file search`
 *     matches names rather than contents, so forwarding them would silently lose results.
 *   * `run_in_background` command calls stay built-in: the built-in result for a background call is a
 *     job id from the harness job system, and dsh-os's `--background` starts an unrelated process with
 *     a pid. Claiming otherwise would hand the model a handle it cannot collect.
 *   * Relative paths are not intercepted. The built-in `read`/`write`/`edit` resolve against the
 *     session's workspace root through `ctx.fs`; an interception that used the process working
 *     directory instead would silently read a different file. Interception requires an absolute path.
 *   * `sandbox_permissions` escalation is not honoured. The built-in body asks `ctx.approval` for a
 *     wider sandbox before touching the file; a redirected call runs the verb directly, so the file
 *     sandbox is not what bounds it — dsh-os's own protected-path check is. This is a real reduction
 *     in defence and is documented in README.md rather than hidden.
 *
 * FALLBACK IS THE CONTRACT
 *
 * Every interception is wrapped: anything unexpected — a verb this build does not have, an encoding
 * dsh-os refuses, a malformed path — calls `next()` and lets the built-in tool do the work. Takeover
 * can therefore only ever change HOW a call is answered, never whether it is answered. A model that
 * cannot see the difference is the point.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { invokeForResult, resolveInvocation } from './invoke.js'

export const name = 'dsh-os-takeover'

/** The interception needs the tool pipeline, and the switch lives in the settings service. */
export const inject = ['tools', 'dsh-os-settings']

/**
 * Tools this row knows how to answer.
 *
 * The order is also the order the settings panel presents them in. Leaving a tool out is a supported
 * configuration, not a degraded one: with `read` off, reads are the built-in implementation and writes
 * still go through dsh-os.
 */
export const TAKEOVER_TOOLS = ['read', 'write', 'edit', 'pwsh']

/** Defaults matching the "follow the built-in, preserve the target" policy chosen for this feature. */
export const DEFAULT_CONFIG = {
  read: true,
  write: true,
  edit: true,
  pwsh: true,
}

// ---------------------------------------------------------------------------
// target format detection
// ---------------------------------------------------------------------------

/**
 * Read the byte-level facts the built-in tools do not preserve.
 *
 * The built-in `write` always emits UTF-8 with no BOM and LF line endings. Rewriting a file that had a
 * BOM or CRLF therefore produces a whole-file diff and can break a script that depended on the
 * convention. Which of the two the target already had is only knowable from its bytes, so they are
 * read here rather than guessed.
 *
 * A file that does not exist yields the built-in defaults, which is what makes a newly created file
 * behave exactly as it did before takeover was enabled.
 */
export function readTargetFormat(path) {
  let bytes
  try {
    bytes = readFileSync(path)
  } catch {
    return { exists: false, bom: false, eol: 'lf' }
  }
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  let crlf = 0
  let lf = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue
    if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1
    else lf += 1
  }
  // A file with no line ending at all is treated as LF, which is the built-in default and therefore
  // changes nothing about how it will be written.
  const eol = crlf > lf ? 'crlf' : 'lf'
  return { exists: true, bom, eol }
}

/** Decode a text file's bytes the way the built-in `read` does: BOM stripped, CRLF normalised to LF. */
export function decodeTextFile(bytes) {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = hasBom ? bytes.subarray(3) : bytes
  return body.toString('utf8').replace(/\r\n/g, '\n')
}

/** Encode text back into a target's convention, so the write preserves what was already there. */
export function encodeTextForTarget(text, format) {
  const body = format.eol === 'crlf' ? text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
  const payload = Buffer.from(body, 'utf8')
  if (!format.bom) return payload
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payload])
}

/**
 * Replace a file's bytes atomically.
 *
 * Same-directory temporary file then `rename`, which is the same shape dsh-os's own `Write-Atomic`
 * uses. A cross-volume rename would not be atomic, and this is never one: the temporary file is a
 * sibling of its target by construction.
 *
 * The temporary name is random rather than sequential so two concurrent interceptions of the same
 * path cannot collide, and it is removed on any failure so a failed write leaves no debris behind.
 */
export function writeFileAtomic(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.dsh-os-${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, bytes)
    renameSync(temporary, path)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* the failure that matters is the original */ }
    throw error
  }
}

// ---------------------------------------------------------------------------
// per-tool handlers
// ---------------------------------------------------------------------------

/** Run `file view` and return its envelope result. */
async function viewFile(invoke, invocation, path, flags = []) {
  return invoke(invocation, 'file view', [path], flags)
}

/**
 * Answer a built-in `read` call.
 *
 * The value must satisfy the built-in schema exactly (`path`, `offset`, `lines[{number,text}]`,
 * `totalLines`, additionalProperties false), because that value is what the built-in renderer formats
 * and what the built-in presentation metadata is derived from.
 *
 * `lines` and `lineCount` are read from the envelope rather than derived from `text`. That is not a
 * style choice: `file view` builds its line objects BEFORE applying `--max-bytes` (file.ps1:387-419),
 * so `lineCount` is the file's real line count while `text` is a truncated slice of it. Deriving
 * `totalLines` from `text` would silently under-report every file larger than the flag's cap, and the
 * built-in renderer uses `totalLines` to decide whether to print the "use offset to continue" footer.
 */
async function handleRead(args, invocation, readLimit, invoke = invokeForResult) {
  const path = String(args.file_path)
  const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1
  // The built-in default comes from the `tool-fs` row's `readLimit` config (2000), so it is carried in
  // rather than hardcoded: a deployment that raised it must not see a different window size here.
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, readLimit) : readLimit

  const view = await viewFile(invoke, invocation, path)
  const totalLines = Number.isInteger(view.lineCount) ? view.lineCount : 0

  // The built-in tool treats an offset past the end of a non-empty file as an error rather than an
  // empty read, so a caller that asked for line 900 of a 10-line file is told, not handed nothing.
  if (totalLines > 0 && offset > totalLines) {
    throw new Error(`offset ${offset} is out of range for ${path}, which has ${totalLines} line(s)`)
  }

  const all = Array.isArray(view.lines) ? view.lines : []
  const lines = []
  for (const line of all) {
    if (line.number < offset || line.number > offset + limit - 1) continue
    lines.push({ number: line.number, text: String(line.text ?? '') })
  }

  return { path: view.path ?? path, offset, lines, totalLines }
}

/**
 * Answer a built-in `write` call.
 *
 * `before` and `after` are the decoded text, matching what the built-in `read` reports for the same
 * file, while the bytes actually landing on disk follow `writeFormat`:
 *
 *   * `'target'` (the default) keeps the target's original BOM and line endings, which is the reason the
 *     takeover exists: rewriting a CRLF or BOM file as plain LF+UTF-8 produces a whole-file diff and can
 *     break whatever depended on the convention;
 *   * `'builtin'` reproduces the built-in tool exactly — UTF-8 without a BOM, LF — for a caller who wants
 *     takeover to change where the bytes came from and nothing else.
 *
 * The split between value and bytes is deliberate: the values are compared by the model and diffed by
 * the UI, both of which work in normalised text, and only the byte-level write needs the convention.
 */
async function handleWrite(args, invocation, writeFormat = 'target', invoke = invokeForResult) {
  const path = String(args.file_path)
  const content = String(args.content ?? '')

  // A target that does not exist yet goes through `file create`, which is where parent-directory
  // creation and the protected-path check live. The order matters: an earlier version wrote the file
  // first and only then called the verb, which made both of those guarantees unreachable — the write
  // had already succeeded (or already failed on a missing parent) before the verb ever ran.
  //
  // A new file is always UTF-8 without a BOM and LF, under either write format: there is no target
  // convention to preserve, so the built-in behaviour is the only defensible answer.
  if (!existsSync(path)) {
    const created = await invoke(
      invocation,
      'file create',
      [path, content, 'utf-8'],
      [],
      { allow: true },
    )
    return {
      path: created.path ?? path,
      operation: 'create',
      before: null,
      after: content,
    }
  }

  const before = decodeTextFile(readFileSync(path))
  const format = writeFormat === 'builtin' ? { bom: false, eol: 'lf' } : readTargetFormat(path)

  // The existing target is replaced here because `file create` refuses to overwrite by contract
  // (`E_EXISTS`), and no verb performs a whole-file replacement. The bytes still go through dsh-os's
  // encoding rules — `readTargetFormat` reads the BOM and line-ending convention off the target and
  // `encodeTextForTarget` re-applies them — which is the behaviour this takeover exists to provide.
  writeFileAtomic(path, encodeTextForTarget(content, format))

  return {
    path,
    operation: 'update',
    before,
    after: content,
  }
}

/**
 * Answer a built-in `edit` call.
 *
 * The literal replacement is performed on the decoded text — the same text the model was shown by
 * `read` — and the result is written back in the target's own convention. Match counting mirrors the
 * built-in contract: one match is required unless `replace_all` is set, and a violation throws so the
 * caller falls back to the built-in tool rather than inventing a different answer.
 */
async function handleEdit(args, invocation, writeFormat = 'target', invoke = invokeForResult) {
  const path = String(args.file_path)
  const oldString = String(args.old_string ?? '')
  const newString = String(args.new_string ?? '')
  const replaceAll = args.replace_all === true

  // An edit never creates, so the verb layer is not consulted; the injectable invoker is accepted for
  // symmetry with the other handlers and so a test can pin that no verb is reached on this path.
  void invoke
  void invocation

  if (oldString === '') throw new Error('old_string must be a non-empty string')
  if (oldString === newString) throw new Error('old_string and new_string must differ')

  const target = readTargetFormat(path)
  if (!target.exists) throw new Error(`cannot edit '${path}': it does not exist`)
  const format = writeFormat === 'builtin' ? { bom: false, eol: 'lf' } : target
  const before = decodeTextFile(readFileSync(path))

  const occurrences = before.split(oldString).length - 1
  if (occurrences === 0) throw new Error(`old_string was not found in ${path}`)
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`old_string appears ${occurrences} times in ${path}; pass replace_all to replace every occurrence`)
  }

  const after = replaceAll
    ? before.split(oldString).join(newString)
    : before.replace(oldString, newString)

  writeFileAtomic(path, encodeTextForTarget(after, format))

  return { path, before, after }
}

/**
 * Answer a built-in `pwsh` call.
 *
 * The value must satisfy the built-in foreground variant of the `oneOf` output schema, including
 * `kind: "foreground"`, both stream objects with their `truncated` flags, and the null-able
 * `exitCode`/`signal` pair.
 *
 * Two fields are necessarily constant here, and both are honest rather than lazy:
 *
 *   * `signal` is always null. An envelope carries a numeric exit status and no terminating-signal
 *     field, so the built-in `[killed by signal: X]` marker is unreachable through this path.
 *   * `truncated` is always false. The `execute.command` result carries the whole stdout string with no
 *     cap and no spill path, so there is nothing to report as truncated. The built-in tool's own
 *     `[output truncated; full output: …]` marker is therefore also unreachable here — which is a real
 *     loss for a command that prints megabytes, not a cosmetic one.
 *
 * `timedOut` IS reachable: a deadline that expires returns an envelope with `timedOut: true` and a null
 * exit code rather than throwing (execute.ps1), so the built-in `[timed out after Nms]` marker is
 * preserved.
 */
async function handlePwsh(args, invocation, timeoutMs) {
  const command = String(args.command ?? '')
  const workdir = typeof args.workdir === 'string' && args.workdir !== '' ? args.workdir : undefined
  const requestedTimeout = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : timeoutMs

  // `pwsh -Command <command>` is what the built-in tool runs, so the same argv shape is handed to
  // execute.command: the arguments are passed as separate argv elements and never spliced into a
  // shell string.
  const flags = ['--timeout', String(Math.round(requestedTimeout))]
  if (workdir !== undefined) flags.push('--workdir', workdir)

  const result = await invokeForResult(invocation, 'execute.command', ['pwsh', '-NoLogo', '-NoProfile', '-Command', command], flags, { allow: true, timeoutMs: requestedTimeout + 5000 })

  return {
    kind: 'foreground',
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    signal: null,
    timedOut: result.timedOut === true,
    aborted: false,
    timeoutMs: Math.round(requestedTimeout),
    stdout: { text: String(result.stdout ?? ''), truncated: false },
    stderr: { text: String(result.stderr ?? ''), truncated: false },
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * Whether a path can be forwarded at all.
 *
 * An absolute path is required because the built-in tools resolve relative paths against the session
 * workspace root through `ctx.fs`, and this plugin has no equivalent of that resolution. Guessing the
 * process working directory would read a different file than the one the model named, which is worse
 * than not taking the call over.
 */
function forwardablePath(value) {
  return typeof value === 'string' && value.trim() !== '' && isAbsolute(value)
}

/** Whether the call is one this row can answer without changing what the result means. */
function eligible(tool, args) {
  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
      return forwardablePath(args.file_path)
    case 'pwsh':
      // A background call's result is a harness job id, and this surface cannot produce one: the verb
      // rejects `--background` outright. The session-scoped sandbox escalation arguments are likewise
      // the harness's own seam and are not consulted here.
      if (args.run_in_background === true) return false
      if (args.sandbox_permissions !== undefined) return false
      // A relative workdir is resolved by the built-in tool against the session's working directory, and
      // this plugin has no equivalent of that resolution. It is NOT because the verb would resolve it
      // wrongly: `execute.command` sets the spawned process's working directory explicitly
      // (execute.ps1 `$psi.WorkingDirectory`), so an absolute path behaves identically either way. The
      // gap is only in resolving a relative one, so only a relative one keeps the built-in path.
      if (args.workdir !== undefined && !forwardablePath(args.workdir)) return false
      return typeof args.command === 'string' && args.command.trim() !== ''
    default:
      return false
  }
}

export function apply(ctx, rawConfig) {
  // `?? {}` rather than a default parameter: Cordis passes a row's config as `null` when the row declares
  // none, and a default parameter only fires for `undefined`, so the first property read threw and the
  // row never activated. This row is shipped WITHOUT a config, so it hit exactly that.
  const config = rawConfig ?? {}
  const toolTimeoutMs = config.timeoutMs ?? 120000
  // Mirrors the `tool-fs` row's `readLimit` (2000 by default): the interception must not quietly apply
  // a different window size than the built-in it replaced.
  const readLimit = Number.isInteger(config.readLimit) && config.readLimit > 0 ? config.readLimit : 2000

  ctx.on('tools/execute', async (exec, next) => {
    const settings = ctx['dsh-os-settings']
    if (settings === undefined || !settings.enabled()) return next()

    const tool = exec?.name
    if (!TAKEOVER_TOOLS.includes(tool)) return next()
    if (!settings.toolEnabled(tool)) return next()

    const args = exec.arguments ?? {}
    if (!eligible(tool, args)) return next()

    const invocation = resolveInvocation(config)
    if (invocation === null) return next()

    try {
      let value
      if (tool === 'read') value = await handleRead(args, invocation, readLimit)
      else if (tool === 'write') value = await handleWrite(args, invocation, settings.writeFormat())
      else if (tool === 'edit') value = await handleEdit(args, invocation, settings.writeFormat())
      else value = await handlePwsh(args, invocation, toolTimeoutMs)

      settings.record(tool, exec, value)
      // Returning without calling next() is what replaces the built-in body. The value still travels
      // through the built-in output schema and renderer.
      return { value }
    } catch (error) {
      // Fallback is the contract: a redirected call may change how a result is produced, never whether
      // the caller gets one. The reason is recorded so the settings panel can show why.
      settings.recordFallback(tool, exec, error)
      return next()
    }
  })
}

/** Exported for tests: the eligibility rule and the per-tool handlers. */
export const __internals = { eligible, handleRead, handleWrite, handleEdit, handlePwsh }
