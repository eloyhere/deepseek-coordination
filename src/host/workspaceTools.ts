/**
 * `coordination_workspace`: build, structure and run inside the workspace.
 *
 * Three actions, one tool:
 * - `structure` is a thin delegation to `coordination_file`, so the workspace
 *   shape the model sees here and there can never drift apart.
 * - `build` and `test` are *named* package scripts, not shell snippets: the
 *   command is derived from `package.json` (`scripts.build` / `scripts.test`)
 *   so the model cannot smuggle a different command through the action name.
 * - `run` is the escape hatch and takes an explicit `command`, but it still goes
 *   through DSH's own `ctx.shell` service, so the operator's sandbox mode, the
 *   permission surface and the process accounting all still apply. This plugin
 *   never spawns a process itself.
 *
 * Everything is bounded: the timeout is capped, output is capped by the tool's
 * result budget, and a missing shell seam is reported as `UNAVAILABLE` instead
 * of pretending the command ran.
 */
import { readFile } from 'node:fs/promises'
import { resolve as resolvePath, sep } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { coordinationGraphToolDefinitions } from './tools.js'
import type { CoordinationToolService, CoordinationToolDefinition, CoordinationToolTextBlock } from './tools.js'
import type { Locale } from '../shared/i18n.js'

/** The tool contract asks for text blocks; the value is already bounded JSON. */
function textBlocks(value: unknown): CoordinationToolTextBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}
/** One bounded command request handed to the host shell service. */
export interface WorkspaceRunRequest {
  command: string
  workdir: string
  timeoutMs: number
}

/** What one command produced, already bounded by the shell implementation. */
export interface WorkspaceRunOutcome {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  /** Sandbox mode the host reported, when it reports one. */
  sandboxMode?: string
}

/** The structural seam the host shell service exposes (see `ctx.shell`). */
export interface WorkspaceShellPort {
  resolve(request: {
    command: string
    workdir?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): unknown
  execute(spec: unknown): Promise<{
    result(): Promise<{
      exitCode: number | null
      timedOut: boolean
      aborted: boolean
      timeoutMs: number
      stdout: { text: string; truncated: boolean }
      stderr: { text: string; truncated: boolean }
      sandbox?: { mode?: string }
    }>
  }>
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_COMMAND_LENGTH = 4_000
const MAX_PACKAGE_BYTES = 256 * 1024

export type WorkspaceAction = 'structure' | 'build' | 'test' | 'run'

export interface WorkspaceToolOptions {
  /** Workspace root override (tests, profiles). */
  workspaceRoot?: string
  /** Explicit shell seam; the tool also accepts `service.host.shell`. */
  shell?: WorkspaceShellPort
  /** Injected clock, so a test can assert the duration without sleeping. */
  now?: () => number
}

interface WorkspaceArguments {
  action?: unknown
  path?: unknown
  depth?: unknown
  limit?: unknown
  command?: unknown
  timeoutMs?: unknown
  mode?: unknown
}

function asArguments(raw: unknown): WorkspaceArguments {
  return (raw !== null && typeof raw === 'object' ? raw : {}) as WorkspaceArguments
}

function boundedString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length === 0 ? fallback : trimmed.slice(0, max)
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), max)
}

/** `structure` is the file tool's own projection; nothing is re-derived here. */
function structureTool(service: CoordinationToolService, locale: Locale, options: WorkspaceToolOptions): CoordinationToolDefinition {
  const [file] = coordinationGraphToolDefinitions(service, locale, {
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
  })
  return file!
}

/**
 * The command a named action runs, derived only from the workspace's own
 * scripts. `build`/`test` never accept a caller-supplied command: that keeps
 * the action name honest and the command auditable.
 */
export function workspaceScriptCommand(
  action: 'build' | 'test',
  scripts: Record<string, string> | undefined,
  packageManager: 'npm' | 'pnpm' | 'yarn' = 'npm',
): { command: string; script: string } | { error: string } {
  const name = action
  const script = scripts?.[name]
  if (typeof script !== 'string' || script.trim().length === 0) {
    return { error: `package.json has no "${name}" script` }
  }
  if (packageManager === 'npm') return { command: `npm run ${name}`, script }
  return { command: `${packageManager} run ${name}`, script }
}

/** Keep a path inside the workspace root; `..` never escapes it. */
function containedPath(root: string, candidate: string): string {
  const absolute = resolvePath(root, candidate)
  const prefix = root.endsWith(sep) ? root : root + sep
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw Object.assign(new Error(`"${candidate}" resolves outside the workspace root`), { code: 'INVALID_ARGUMENT' })
  }
  return absolute
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    const path = containedPath(root, 'package.json')
    const raw = await readFile(path, 'utf8')
    if (raw.length > MAX_PACKAGE_BYTES) return undefined
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** `pnpm run build` is right when the lockfile says pnpm; npm is the fallback. */
function packageManagerOf(packageJson: Record<string, unknown> | undefined): 'npm' | 'pnpm' | 'yarn' {
  const declared = packageJson?.packageManager
  if (typeof declared === 'string') {
    if (declared.startsWith('pnpm@')) return 'pnpm'
    if (declared.startsWith('yarn@')) return 'yarn'
  }
  return 'npm'
}

async function runCommand(
  shell: WorkspaceShellPort,
  request: WorkspaceRunRequest,
  now: () => number,
): Promise<WorkspaceRunOutcome> {
  const started = now()
  const spec = shell.resolve({
    command: request.command,
    workdir: request.workdir,
    timeoutMs: request.timeoutMs,
  })
  const execution = await shell.execute(spec)
  const result = await execution.result()
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    durationMs: Math.max(0, now() - started),
    stdout: result.stdout.text,
    stderr: result.stderr.text,
    stdoutTruncated: result.stdout.truncated,
    stderrTruncated: result.stderr.truncated,
    ...(result.sandbox?.mode === undefined ? {} : { sandboxMode: result.sandbox.mode }),
  }
}

/** Output schema: one closed object, every action shares it. */
const WORKSPACE_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    root: { type: 'string' },
    entries: { type: 'array', items: { type: 'object' } },
    paths: { type: 'array', items: { type: 'string' } },
    mode: { type: 'string' },
    truncated: { type: 'boolean' },
    script: { type: 'string' },
    command: { type: 'string' },
    cwd: { type: 'string' },
    exitCode: { type: 'number' },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean' },
    durationMs: { type: 'number' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    sandboxMode: { type: 'string' },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
}

/**
 * `coordination_workspace` — one tool for the three things a coding agent does
 * to a workspace: look at it, build it, run something in it.
 */
export function coordinationWorkspaceTool(
  service: CoordinationToolService,
  locale: Locale = 'en-US',
  options: WorkspaceToolOptions = {},
): CoordinationToolDefinition {
  const now = options.now ?? (() => Date.now())

  return {
    name: 'coordination_workspace',
    description: [
      'Operate the current workspace: structure, build, test or run a command.',
      'structure projects the workspace tree (or flat paths with mode="paths") and is the same projection as coordination_file.',
      'build and test run the package.json script of that name through the host shell; the command cannot be overridden by the caller.',
      'run executes an explicit command in the workspace root through the host shell, under the operator\'s sandbox and permission rules.',
      'Output is bounded: stdout/stderr are capped, the timeout is capped at 10 minutes, and a missing shell reports UNAVAILABLE rather than a fake success.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['structure', 'build', 'test', 'run'],
          description: 'Workspace action; defaults to structure.',
        },
        path: { type: 'string', description: 'structure: workspace-relative start path; defaults to the root.' },
        depth: { type: 'integer', description: 'structure: directory depth, 1-8.' },
        limit: { type: 'integer', description: 'structure: maximum entries, 1-1000.' },
        mode: { type: 'string', enum: ['tree', 'paths'], description: 'structure: nested tree (default) or flat paths.' },
        command: { type: 'string', description: 'run: the command line to execute in the workspace root.' },
        timeoutMs: { type: 'integer', description: 'build/test/run: timeout in milliseconds, capped at 600000.' },
      },
      required: ['action'],
    },
    output: {
      schema: WORKSPACE_TOOL_SCHEMA,
      render: (_args, value) => textBlocks(value),
    },
    async execute(rawArgs: unknown, exec?: ToolExecution) {
      const args = asArguments(rawArgs)
      const action = boundedString(args.action, 'structure', 16) as WorkspaceAction
      if (!['structure', 'build', 'test', 'run'].includes(action)) {
        return { ok: false, action, error: { code: 'INVALID_ARGUMENT', message: 'action must be structure, build, test or run' } }
      }

      // Structure needs no shell and no sandbox: it is a bounded read.
      if (action === 'structure') {
        const delegate = structureTool(service, locale, options)
        return delegate.execute({
          ...(args.path === undefined ? {} : { path: args.path }),
          ...(args.depth === undefined ? {} : { depth: args.depth }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.mode === undefined ? {} : { mode: args.mode }),
        }, exec)
      }

      const shell = options.shell ?? service.host?.shell
      if (shell === undefined) {
        return { ok: false, action, error: { code: 'UNAVAILABLE', message: 'the host exposes no shell service, so commands cannot run' } }
      }

      const root = options.workspaceRoot ?? service.workspaceRoot
      if (typeof root !== 'string' || root.length === 0) {
        return { ok: false, action, error: { code: 'UNAVAILABLE', message: 'the workspace root is unknown for this session' } }
      }
      const timeoutMs = positiveInteger(args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

      try {
        let command: string
        let script: string | undefined
        if (action === 'run') {
          command = boundedString(args.command, '', MAX_COMMAND_LENGTH)
          if (command.length === 0) {
            return { ok: false, action, error: { code: 'INVALID_ARGUMENT', message: 'run requires a non-empty command' } }
          }
          return { ok: true, action, cwd: root, command, ...(await runCommand(shell, { command, workdir: root, timeoutMs }, now)) }
        }

        const packageJson = await readPackageJson(root)
        const scripts = packageJson?.scripts as Record<string, string> | undefined
        const derived = workspaceScriptCommand(action, scripts, packageManagerOf(packageJson))
        if ('error' in derived) {
          return { ok: false, action, error: { code: 'NOT_FOUND', message: derived.error } }
        }
        command = derived.command
        script = derived.script
        return {
          ok: true, action, cwd: root, command, script,
          ...(await runCommand(shell, { command, workdir: root, timeoutMs }, now)),
        }
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        return {
          ok: false,
          action,
          error: {
            code: typeof code === 'string' ? code : 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    },
  }
}
