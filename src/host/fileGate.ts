/**
 * Host-side file-access takeover (`ui.takeoverFiles`, off by default).
 *
 * DSH dispatches every tool call through the `tools/pre-execute` waterfall:
 * a listener receives the pending `ToolExecution` (`{ name, arguments, agent,
 * signal, ... }`) plus a `next()` delegate. Calling `next()` continues the
 * waterfall (whose terminal answer is `{ kind: 'allow' }`); returning a
 * `PreToolDecision` settles it, and `{ kind: 'deny', reason }` refuses the call
 * before dispatch.
 *
 * What this gate does while the switch is on — and nothing more:
 *
 *  - `read` — never blocked. One record per call (the host appends it as an AMP
 *    event) names the tool and the path that was read.
 *  - `write` / `edit` — refused only when the target `file_path` provably
 *    resolves outside the session workspace root: an absolute path outside it,
 *    or a relative path that climbs out with `..`. Inside the workspace the
 *    call proceeds untouched, and a refusal records its reason as well.
 *  - every other tool — `next()`; the gate has no opinion.
 *
 * Fail-open is deliberate. A missing path argument, an unknown workspace root
 * (no sandbox policy, no plugin-level root), an argument shape this module does
 * not recognise, or any internal failure all let the call through: the gate
 * exists to stop a *provable* escape, not to guess. The check is lexical — no
 * filesystem access, no `realpath`, no symlink resolution — so a path whose
 * containment would need the disk is allowed, and DSH's own sandbox still
 * applies underneath. It is not a policy engine and it does not replace the
 * approval waterfall.
 *
 * `install()` registers the `tools/pre-execute` listener only while the switch
 * is on, so the shipped default adds nothing to the waterfall. `sync()`
 * re-evaluates the switch after a live config save (the settings page's
 * `POST /config` path), and the listener re-reads the flag on every call, so
 * switching the gate off stops enforcement immediately.
 */
import { posix, win32 } from 'node:path'

/** Tools whose calls are recorded but never blocked. */
export const FILE_GATE_READ_TOOLS = ['read'] as const

/** Tools whose target path must stay inside the workspace. */
export const FILE_GATE_WRITE_TOOLS = ['write', 'edit'] as const

/** Why a decision came out the way it did; stable, so logs can be grepped. */
export type FileGateCode =
  | 'read-recorded'
  | 'outside-workspace'
  | 'inside-workspace'
  | 'unknown-path'
  | 'unknown-workspace'
  | 'not-a-file-tool'

/** What the tool call does with files, as far as this gate cares. */
export type FileGateToolKind = 'read' | 'write' | 'other'

/**
 * One `tools/pre-execute` decision, as this module produces it.
 *
 * The full DSH union also carries `cancel` and `ask`; the gate never produces
 * either, and modelling only what it returns keeps the pure function testable
 * without the host runtime.
 */
export type FileGateVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }

/** One audit record: exactly what the host appends to the AMP ledger. */
export interface FileGateRecord {
  /** A read that was allowed, or a write that was refused. */
  readonly kind: 'read' | 'deny'
  readonly tool: string
  /** The path exactly as the call supplied it, when one was readable. */
  readonly path?: string
  /** Human-readable refusal, present for `deny` only. */
  readonly reason?: string
  /** DSH session id behind the call, when the event carries one. */
  readonly agent?: string
}

/** The decision `decideFileAccess` returns; pure and locale-free. */
export interface FileGateDecision {
  readonly decision: 'allow' | 'deny'
  readonly kind: FileGateToolKind
  readonly tool: string
  readonly code: FileGateCode
  /** The raw target path, when the arguments carried one. */
  readonly path?: string
  /** Readable refusal; present exactly when `decision` is `deny`. */
  readonly reason?: string
}

/** Input of the pure decision: what the tool is called with, and where the root is. */
export interface FileGateAccessInput {
  /** Tool name from the `tools/pre-execute` event (`exec.name`). */
  readonly tool: string
  /** Parsed arguments (`exec.arguments`); any JSON shape is accepted. */
  readonly args: unknown
  /** Absolute workspace root; `undefined` means "unknown" and fails open. */
  readonly workspaceRoot?: string
}

/**
 * The live switch, read from the host config.
 *
 * Structural on purpose: `CoordinationConfig` satisfies it, and a test can pass
 * `{ ui: { takeoverFiles: true } }` without building the whole config.
 */
export interface FileGateConfig {
  readonly ui?: { readonly takeoverFiles?: boolean }
}

/** The host's side of the gate: where the root comes from and where records go. */
export interface FileGateOptions {
  readonly config: FileGateConfig
  /**
   * Absolute workspace root for one call, given the event's agent id. Returning
   * `undefined` (or throwing) means "cannot determine" and lets the call pass.
   */
  readonly workspaceRootFor?: (agent: string | undefined) => string | undefined
  /** Sink for one record (AMP event, log). A throwing sink is ignored. */
  readonly record?: (record: FileGateRecord) => void
}

/**
 * Decide one tool call without touching the host: the gate's whole policy.
 *
 * See the module header for the fail-open rules; every `allow` still carries a
 * `code` so a caller can tell "inside the workspace" from "could not tell".
 */
export function decideFileAccess(input: FileGateAccessInput): FileGateDecision {
  const tool = typeof input.tool === 'string' ? input.tool.trim() : ''
  const read = (FILE_GATE_READ_TOOLS as readonly string[]).includes(tool)
  const write = (FILE_GATE_WRITE_TOOLS as readonly string[]).includes(tool)

  if (read) {
    const path = pathArgumentOf(input.args)
    return {
      decision: 'allow',
      kind: 'read',
      tool,
      code: 'read-recorded',
      ...(path === undefined ? {} : { path }),
    }
  }
  if (!write) return { decision: 'allow', kind: 'other', tool, code: 'not-a-file-tool' }

  const path = pathArgumentOf(input.args)
  if (path === undefined) return { decision: 'allow', kind: 'write', tool, code: 'unknown-path' }

  const root = typeof input.workspaceRoot === 'string' ? input.workspaceRoot.trim() : ''
  if (root.length === 0) {
    return { decision: 'allow', kind: 'write', tool, code: 'unknown-workspace', path }
  }

  if (isInsideWorkspace(root, path)) {
    return { decision: 'allow', kind: 'write', tool, code: 'inside-workspace', path }
  }
  return {
    decision: 'deny',
    kind: 'write',
    tool,
    code: 'outside-workspace',
    path,
    reason: `ui.takeoverFiles refuses ${tool}: "${path}" resolves outside the workspace root "${root}"`,
  }
}

/**
 * Refuse out-of-workspace writes, record reads, pass everything else through.
 *
 * One instance belongs to one `CoordinationService`; `install()` owns the single
 * Cordis listener and its disposer. The methods are safe to call without a
 * context (the pure decision and the handler still work), which is how the tests
 * drive them.
 */
export class FileGate {
  private readonly config: FileGateConfig
  private readonly workspaceRootFor: ((agent: string | undefined) => string | undefined) | undefined
  private readonly sink: ((record: FileGateRecord) => void) | undefined
  private context: unknown
  private dispose: (() => void) | undefined

  constructor(input: FileGateOptions) {
    this.config = input.config
    this.workspaceRootFor = input.workspaceRootFor
    this.sink = input.record
  }

  /**
   * Attach the gate to one Cordis context.
   *
   * With the switch off nothing is registered at all — the shipped default
   * leaves `tools/pre-execute` untouched. The returned disposer removes the
   * listener and forgets the context; a second call is harmless.
   */
  install(context: unknown): () => void {
    this.context = context
    if (this.enabled()) this.attach()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.context = undefined
      this.detach()
    }
  }

  /**
   * Re-evaluate the switch against the live config.
   *
   * The settings page writes through `applyConfigPatch`, which mutates the live
   * config object; calling this after a save installs the listener the moment
   * the switch turns on and removes it the moment it turns off. A gate that was
   * never installed is a no-op.
   */
  sync(): void {
    if (this.context === undefined) return
    if (this.enabled()) this.attach()
    else this.detach()
  }

  /** True while the live config has `ui.takeoverFiles` on. */
  enabled(): boolean {
    return this.config.ui?.takeoverFiles === true
  }

  /**
   * `tools/pre-execute` listener body.
   *
   * Never throws: a decision it cannot make is `next()`. The registry rechecks
   * cancellation after a listener settles; this body resolves synchronously, so
   * it never races `exec.signal`.
   */
  async handle(exec: unknown, next: () => Promise<unknown>): Promise<unknown> {
    const verdict = this.verdictOf(exec)
    if (verdict !== undefined) return verdict
    return await next()
  }

  /** The denial for this call, or `undefined` when the call should proceed. */
  private verdictOf(exec: unknown): FileGateVerdict | undefined {
    try {
      if (!this.enabled()) return undefined
      const call = asRecord(exec)
      if (call === undefined) return undefined
      const tool = typeof call.name === 'string' ? call.name : ''
      const agent = agentIdOf(call.agent)
      const workspaceRoot = this.workspaceRootOf(agent)
      const decision = decideFileAccess({
        tool,
        args: call.arguments,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      })
      if (decision.decision === 'deny') {
        this.report({
          kind: 'deny',
          tool: decision.tool,
          ...(decision.path === undefined ? {} : { path: decision.path }),
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          ...(agent === undefined ? {} : { agent }),
        })
        return { kind: 'deny', reason: decision.reason ?? `ui.takeoverFiles refuses ${tool}` }
      }
      if (decision.kind === 'read') {
        this.report({
          kind: 'read',
          tool: decision.tool,
          ...(decision.path === undefined ? {} : { path: decision.path }),
          ...(agent === undefined ? {} : { agent }),
        })
      }
      return undefined
    } catch {
      // Fail open: the gate never blocks a call it could not evaluate.
      return undefined
    }
  }

  /** Ask the host for the workspace root; an absent or broken port is "unknown". */
  private workspaceRootOf(agent: string | undefined): string | undefined {
    if (this.workspaceRootFor === undefined) return undefined
    try {
      const root = this.workspaceRootFor(agent)
      return typeof root === 'string' && root.trim().length > 0 ? root.trim() : undefined
    } catch {
      return undefined
    }
  }

  /** Forward one record; the sink is write-behind and never blocks a call. */
  private report(record: FileGateRecord): void {
    if (this.sink === undefined) return
    try {
      this.sink(record)
    } catch {
      // An audit sink must not turn an allowed call into a failed one.
    }
  }

  /** Register the one listener; idempotent while it is attached. */
  private attach(): void {
    if (this.dispose !== undefined) return
    const register = asFunction(asRecord(this.context)?.on)
    if (register === undefined) return
    try {
      // `prepend` matters: the waterfall stops at the first listener that
      // answers without `next()`, so a gate registered last could be skipped.
      const dispose = register.call(
        this.context,
        'tools/pre-execute',
        (exec: unknown, next: () => Promise<unknown>) => this.handle(exec, next),
        { prepend: true },
      )
      this.dispose = typeof dispose === 'function' ? (dispose as () => void) : () => {}
    } catch {
      // A context without a working event bus simply gets no gate.
      this.dispose = undefined
    }
  }

  /** Remove the listener; a second removal is harmless. */
  private detach(): void {
    const dispose = this.dispose
    this.dispose = undefined
    if (dispose === undefined) return
    try {
      dispose()
    } catch {
      // A failing disposer during plugin unload is not worth a second throw.
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Argument and path helpers
 * ------------------------------------------------------------------------- */

/** The file-path argument of `read` / `write` / `edit`; `file_path` is canonical. */
function pathArgumentOf(args: unknown): string | undefined {
  const record = asRecord(args)
  if (record === undefined) return undefined
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** Just enough of `node:path` to compare a root with one target path. */
interface PathFlavour {
  resolve(...paths: string[]): string
  relative(from: string, to: string): string
  readonly sep: string
}

/** Windows roots are drives and UNC shares; everything else compares as POSIX. */
function flavourOf(root: string): PathFlavour {
  return /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\') ? win32 : posix
}

/**
 * Lexical containment: resolve the target against the root, then ask whether the
 * relative path climbs out. No filesystem access, so a symlink escape is not
 * seen — that is DSH's sandbox's job, not this gate's.
 */
function isInsideWorkspace(root: string, target: string): boolean {
  const flavour = flavourOf(root)
  const resolvedRoot = flavour.resolve(root)
  const resolvedTarget = flavour.resolve(resolvedRoot, target)
  const relative = flavour.relative(resolvedRoot, resolvedTarget)
  if (relative === '') return true
  return relative !== '..' && !relative.startsWith(`..${flavour.sep}`)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asFunction(value: unknown): ((...parameters: unknown[]) => unknown) | undefined {
  return typeof value === 'function' ? (value as (...parameters: unknown[]) => unknown) : undefined
}

/** DSH keeps `agent.id === session.id`; a foreign id shape is simply absent. */
function agentIdOf(value: unknown): string | undefined {
  const agent = asRecord(value)
  return typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : undefined
}
