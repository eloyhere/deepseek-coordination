/**
 * Local environment discovery for `coordination_environment`.
 *
 * The registry starts empty on a fresh database, which made the tool useless:
 * the model had to rediscover git/node/npm paths by trial and error. This module
 * discovers a curated, secret-free set of paths and variables and seeds one
 * `env.local` record; the agent can then edit it through the same tool.
 *
 * Deliberate constraints:
 *
 *  - **Curated, not a dump.** Only known variable names and the toolchain list
 *    are collected. `isSensitiveName()` refuses API keys, tokens, secrets,
 *    passwords and credentials — nothing here may leak a credential into the
 *    database or the prompt.
 *  - **Bounded.** `PATH`-like values are clipped (the full value is rarely
 *    useful in context); a discovered executable is recorded only when it
 *    actually exists on disk.
 *  - **Deterministic.** Key order is fixed by the curated tables, so two runs on
 *    the same machine produce the same JSON and the prompt-cache prefix does not
 *    churn.
 *  - **Editable.** `seedEnvironment()` only writes when the registry is empty;
 *    it never overwrites an entry the user or the agent edited.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Stable id of the seeded record. */
export const ENVIRONMENT_ID = 'env.local'

/** A discovered environment record, ready to store as a registry value. */
export interface DiscoveredEnvironment {
  readonly name: string
  readonly description: string
  /** name → string values; every value is a string by contract. */
  readonly variables: Record<string, string>
  /** Snapshot of this discovery, used by `refresh` to tell edits from drift. */
  readonly discovered: Record<string, string>
  /** ISO timestamp of the discovery. */
  readonly refreshedAt: string
}

export interface DiscoveryOptions {
  /** Workspace root recorded as `project.root`; omitted when unknown. */
  readonly workspaceRoot?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  /** Test seam: returns true when the candidate is a file. */
  readonly isFile?: (path: string) => boolean
  readonly now?: () => number
}

/** Tools whose resolved executable path is worth recording. */
const TOOL_NAMES = ['git', 'node', 'npm', 'pnpm', 'python', 'python3', 'java', 'pwsh', 'powershell', 'bash', 'sh'] as const

/** Curated environment variables: registry key, source names in priority order, clip length. */
const CURATED_VARIABLES: ReadonlyArray<{ key: string; names: readonly string[]; max?: number }> = [
  { key: 'path', names: ['PATH'], max: 4_000 },
  { key: 'pathext', names: ['PATHEXT'], max: 400 },
  { key: 'psmodulepath', names: ['PSModulePath'], max: 2_000 },
  { key: 'home', names: ['HOME', 'USERPROFILE'] },
  { key: 'temp', names: ['TEMP', 'TMP'] },
  { key: 'shell', names: ['SHELL', 'ComSpec'] },
  { key: 'lang', names: ['LANG', 'LC_ALL'], max: 120 },
  { key: 'os', names: ['OS'] },
]

const CLIP_TAIL = '…'

/** True for names that look like credentials; never collected, never seeded. */
export function isSensitiveName(name: string): boolean {
  return /(?:^|[_.-])(?:api[_.-]?key|key|token|secret|password|passwd|credential|session[_.-]?id)s?(?:$|[_.-])/i.test(name)
}

function clipValue(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - CLIP_TAIL.length))}${CLIP_TAIL}`
}

function defaultIsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve one executable on `PATH`.
 *
 * Windows appends each `PATHEXT` entry (and the bare name); POSIX uses the bare
 * name. The first existing file wins, in `PATH` order, so the recorded path is
 * the one a shell would run.
 */
export function findOnPath(
  command: string,
  options: DiscoveryOptions = {},
): string | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isFile = options.isFile ?? defaultIsFile
  const rawPath = env.PATH ?? env.Path ?? env.path
  if (rawPath === undefined || rawPath.length === 0) return undefined
  const separator = platform === 'win32' ? ';' : ':'
  const extensions = platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(entry => entry.length > 0)]
    : ['']
  for (const directory of rawPath.split(separator)) {
    const base = directory.trim()
    if (base.length === 0) continue
    for (const extension of extensions) {
      // Build with the target platform's separator, not the host's: discovery is
      // unit-tested for both platforms from one machine.
      const candidate = platform === 'win32'
        ? `${base.replace(/[\\/]+$/, '')}\\${command}${extension}`
        : `${base.replace(/[\\/]+$/, '')}/${command}${extension}`
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

/** Read `name` from a package.json; any parse failure is simply "unknown". */
function packageNameOf(workspaceRoot: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof manifest.name === 'string' && manifest.name.trim().length > 0 ? manifest.name.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Discover the curated environment. Deterministic key order:
 * project → tools → variables → system facts.
 */
export function discoverEnvironment(options: DiscoveryOptions = {}): DiscoveredEnvironment {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const now = options.now ?? Date.now
  const variables: Record<string, string> = {}

  if (options.workspaceRoot !== undefined && options.workspaceRoot.length > 0) {
    variables['project.root'] = options.workspaceRoot
    const name = packageNameOf(options.workspaceRoot)
    if (name !== undefined) variables['project.name'] = name
  }
  for (const tool of TOOL_NAMES) {
    const found = findOnPath(tool, options)
    if (found !== undefined && !isSensitiveName(tool)) variables[`tool.${tool}`] = found
  }
  for (const { key, names, max } of CURATED_VARIABLES) {
    if (isSensitiveName(key)) continue
    const source = names.map(name => env[name]).find(value => typeof value === 'string' && value.length > 0)
    if (source === undefined) continue
    variables[key] = max === undefined ? source : clipValue(source, max)
  }
  variables.platform = platform
  variables.arch = arch

  return {
    name: 'Local environment',
    description: 'Discovered once on first use: project root, toolchain executable paths and curated host variables. Edit variables freely; refresh re-discovers without overwriting your edits.',
    variables,
    discovered: { ...variables },
    refreshedAt: new Date(now()).toISOString(),
  }
}

/** Merge a fresh discovery over the current record. */
export interface EnvironmentMergeResult {
  readonly variables: Record<string, string>
  readonly added: number
  readonly updated: number
  /** Keys the user changed; refresh leaves them untouched. */
  readonly kept: number
}

/**
 * Merge rule: a key is "drift" only while its current value still equals the
 * previous discovery. Once the value diverges, the user edited it and refresh
 * keeps that value. Keys absent from the new discovery are never removed.
 */
export function mergeDiscovered(
  current: Readonly<Record<string, string>>,
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): EnvironmentMergeResult {
  const variables: Record<string, string> = { ...current }
  let added = 0
  let updated = 0
  let kept = 0
  for (const [key, value] of Object.entries(next)) {
    if (isSensitiveName(key)) continue
    const existing = current[key]
    if (existing === undefined) {
      variables[key] = value
      added += 1
      continue
    }
    if (existing === value) continue
    if (existing === previous[key]) {
      variables[key] = value
      updated += 1
      continue
    }
    kept += 1
  }
  return { variables, added, updated, kept }
}

/** Minimal port the seed needs; `ControlService` satisfies it structurally. */
export interface EnvironmentControlPort {
  listRegistry(registry: 'environments', scope: 'workspace' | 'global', identity: { workspace: string; session: string }): readonly unknown[]
  registry(request: unknown, identity: unknown): unknown
}

/**
 * Seed `env.local` into a scope when that scope is empty.
 *
 * The workspace key must be the one the callers see: the plugin seeds lazily on
 * the first `coordination_environment list`, so it uses the session's workspace
 * rather than the host process directory (which would create a record nobody
 * lists). Returns true when a record was written; never overwrites, so a
 * deleted or edited environment stays that way.
 */
export function seedEnvironment(
  control: EnvironmentControlPort,
  workspaceRoot: string,
  options: DiscoveryOptions = {},
  scope: 'workspace' | 'global' = 'workspace',
): boolean {
  const identity = { workspace: workspaceRoot, session: '' }
  const existing = control.listRegistry('environments', scope, identity)
  if (existing.length > 0) return false
  const discovery = discoverEnvironment({ ...options, workspaceRoot })
  control.registry({
    scope,
    registry: 'environments',
    action: 'register',
    id: ENVIRONMENT_ID,
    value: {
      name: discovery.name,
      description: discovery.description,
      enabled: true,
      variables: discovery.variables,
      discovered: discovery.discovered,
      refreshedAt: discovery.refreshedAt,
    },
  }, identity)
  return true
}
