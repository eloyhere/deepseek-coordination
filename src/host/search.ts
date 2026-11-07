/** Project-file snapshot adapter for AMP's built-in discovery providers. */
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  compileDiscoveryPatterns,
  normalizeDiscoveryQuery,
  type AgentBinding,
  type DiscoveryOptions,
  type DiscoveryProvider,
  type DiscoveryQuery,
} from 'attention-manifest-protocol/agent'
import type { AmpHost } from './amp.js'

export type ProjectSearchScope = 'files' | 'content' | 'both'

export interface ProjectSearchRequest {
  readonly scope: ProjectSearchScope
  readonly path: string
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly options: DiscoveryOptions
}

interface ProjectSearchArguments {
  query: DiscoveryQuery
  regex?: boolean
  scope?: ProjectSearchScope
  path?: string
  include?: string | string[]
  exclude?: string | string[]
  maxFiles?: number
  maxFileBytes?: number
  limit?: number
  minimumScore?: number
  maxPerModule?: number
}

const DEFAULT_MAX_FILES = 500
const MAX_FILES = 5000
const DEFAULT_MAX_FILE_BYTES = 256_000
const MAX_FILE_BYTES = 1_000_000
const MAX_TOTAL_CONTENT_BYTES = 8_000_000
const MAX_TOTAL_CONTENT_LINES = 50_000
const SKIP_DIRS = new Set(['.git', 'node_modules', '.deepseek-coordination', '.dsh', 'dist', 'build', 'coverage'])
const BINARY_EXTENSIONS = new Set(['.7z', '.a', '.apk', '.bin', '.db', '.dll', '.exe', '.gif', '.ico', '.jpeg', '.jpg', '.lockb', '.mp3', '.mp4', '.pdf', '.png', '.sqlite', '.ttf', '.woff', '.woff2', '.zip'])

function boundedInteger(value: unknown, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return Math.min(value, maximum)
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || !values.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new TypeError(`${name} must be a non-empty string or an array of non-empty strings`)
  }
  return values as string[]
}

export function parseProjectSearchArguments(raw: Readonly<Record<string, unknown>>): ProjectSearchRequest {
  const allowed = new Set(['query', 'regex', 'scope', 'path', 'include', 'exclude', 'maxFiles', 'maxFileBytes', 'limit', 'minimumScore', 'maxPerModule'])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new TypeError(`unknown project search parameter: ${key}`)
  }
  const query = raw.query
  if (typeof query !== 'string' && !(Array.isArray(query) && query.every((entry) => typeof entry === 'string'))) {
    throw new TypeError('query must be a string or an array of strings')
  }
  // AMP owns the exact cardinality/length/regex rules; call it early so the
  // error names the offending pattern instead of surfacing inside a provider.
  if (raw.regex !== undefined && typeof raw.regex !== 'boolean') throw new TypeError('regex must be a boolean')
  try {
    normalizeDiscoveryQuery(query)
    if (raw.regex === true) compileDiscoveryPatterns(query)
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : String(error))
  }
  const scope = raw.scope ?? 'both'
  if (scope !== 'files' && scope !== 'content' && scope !== 'both') {
    throw new TypeError('scope must be files, content or both')
  }
  const path = raw.path ?? '.'
  if (typeof path !== 'string' || path.trim().length === 0) throw new TypeError('path must be a non-empty workspace-relative path')
  if (isAbsolute(path)) throw new TypeError('path must be relative to the workspace root')
  const include = stringList(raw.include, 'include')
  const exclude = stringList(raw.exclude, 'exclude')
  const options: DiscoveryOptions = {
    query,
    ...(raw.regex === true ? { regex: true } : {}),
    sources: ['session_files'],
    limit: boundedInteger(raw.limit, 10, 50, 'limit'),
    maxPerModule: boundedInteger(raw.maxPerModule, 10, 50, 'maxPerModule'),
    ...(raw.minimumScore === undefined ? {} : { minimumScore: raw.minimumScore as number }),
  }
  if (typeof options.minimumScore === 'number' && (!Number.isFinite(options.minimumScore) || options.minimumScore < 0 || options.minimumScore > 1)) {
    throw new TypeError('minimumScore must be between 0 and 1')
  }
  return {
    scope,
    path: path.trim(),
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
    maxFiles: boundedInteger(raw.maxFiles, DEFAULT_MAX_FILES, MAX_FILES, 'maxFiles'),
    maxFileBytes: boundedInteger(raw.maxFileBytes, DEFAULT_MAX_FILE_BYTES, MAX_FILE_BYTES, 'maxFileBytes'),
    options,
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  const comparable = process.platform === 'win32' ? rel.toLowerCase() : rel
  return comparable === '' || (comparable !== '..' && !comparable.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Find comma-separated brace alternatives without expanding their combinations. */
function braceAlternatives(pattern: string, start: number): { end: number; alternatives: string[] } | undefined {
  let depth = 0
  let partStart = start + 1
  const alternatives: string[] = []
  for (let index = start; index < pattern.length; index += 1) {
    if (pattern[index] === '{') depth += 1
    else if (pattern[index] === '}') {
      depth -= 1
      if (depth === 0) {
        if (alternatives.length === 0) return undefined
        alternatives.push(pattern.slice(partStart, index))
        return { end: index, alternatives }
      }
    } else if (pattern[index] === ',' && depth === 1) {
      alternatives.push(pattern.slice(partStart, index))
      partStart = index + 1
    }
  }
  return undefined
}

function globSource(pattern: string): string {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (character === '?') {
      source += '[^/]'
    } else if (character === '{') {
      const group = braceAlternatives(pattern, index)
      if (group === undefined) source += '\\{'
      else {
        source += `(?:${group.alternatives.map(globSource).join('|')})`
        index = group.end
      }
    } else if ('\\^$+?.()|{}[]'.includes(character)) {
      source += `\\${character}`
    } else {
      source += character
    }
  }
  return source
}

function globRegex(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern)}$`, 'i')
}

function matches(path: string, includes: readonly RegExp[], excludes: readonly RegExp[]): boolean {
  if (excludes.some((pattern) => pattern.test(path))) return false
  return includes.length === 0 || includes.some((pattern) => pattern.test(path))
}

/** Create session_files provider snapshots confined to the calling project. */
export function createProjectFileProvider(
  host: AmpHost,
  request: ProjectSearchRequest,
  workspaceRoot?: string,
): DiscoveryProvider {
  if (workspaceRoot !== undefined) {
    // Fail before the provider starts: discovery providers contain their own
    // failures, so an escaping path would otherwise look like an empty result.
    const root = resolve(workspaceRoot)
    if (!inside(root, resolve(root, request.path))) throw new Error('path must stay inside the workspace root')
  }
  const includePatterns = (request.include ?? []).map(globRegex)
  const excludePatterns = (request.exclude ?? []).map(globRegex)
  const scope = request.scope
  const resolvedRoot = resolve(workspaceRoot ?? host.rootOfCurrentCall() ?? process.cwd())
  const resolvedStart = resolve(resolvedRoot, request.path)
  if (!inside(resolvedRoot, resolvedStart)) throw new Error('path must stay inside the workspace root')
  const reader = host.protocol.agent.createSessionFileDiscoveryProvider(async (binding: AgentBinding) => {
    const root = resolve(workspaceRoot ?? host.rootOfSession(binding.sessionId) ?? host.rootOfCurrentCall() ?? process.cwd())
    const start = resolve(root, request.path)
    if (!inside(root, start)) throw new Error('path must stay inside the workspace root')
    const entries: Array<{ path: string; absolute: string }> = []
    const requestedEntries: Array<{ path: string; absolute: string }> = []
    const walk = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true })
      for (const child of children) {
        if (requestedEntries.length >= request.maxFiles) break
        if (child.isSymbolicLink()) continue
        const absolute = resolve(directory, child.name)
        const actual = await realpath(absolute).catch(() => undefined)
        if (actual === undefined || !inside(realRoot, actual)) continue
        const path = relative(realRoot, actual).split(sep).join('/')
        if (child.isDirectory()) {
          if (!SKIP_DIRS.has(child.name) && !excludePatterns.some((pattern) => pattern.test(path))) await walk(actual)
        } else if (child.isFile() && matches(path, includePatterns, excludePatterns)) {
          requestedEntries.push({ path, absolute: actual })
        }
      }
    }
    const info = await import('node:fs/promises')
    let realRoot: string
    let realStart: string
    try {
      realRoot = await realpath(root)
      realStart = await realpath(start)
      if (!inside(realRoot, realStart)) throw new Error('path must stay inside the workspace root')
    } catch (error) {
      if (error instanceof Error && error.message === 'path must stay inside the workspace root') throw error
      throw new Error(`search path was not found: ${request.path}`)
    }
    try {
      if ((await info.stat(realStart)).isDirectory()) await walk(realStart)
      else if (inside(realRoot, realStart)) {
        const path = relative(realRoot, realStart).split(sep).join('/')
        if (matches(path, includePatterns, excludePatterns)) requestedEntries.push({ path, absolute: realStart })
      }
    } catch {
      throw new Error(`search path was not found: ${request.path}`)
    }
    for (const entry of requestedEntries) {
      const stat = await info.stat(entry.absolute).catch(() => undefined)
      if (stat?.isFile()) entries.push(entry)
    }

    const result: Array<{ scope: { tenantId: string; principalId: string; sessionId: string }; id: string; path: string; version: string; summary?: string; content?: string }> = []
    let totalBytes = 0
    let totalLines = 0
    for (const entry of entries) {
      const extension = entry.path.slice(entry.path.lastIndexOf('.')).toLowerCase()
      let content: string | undefined
      let version = 'name-only'
      if (scope !== 'files' && !BINARY_EXTENSIONS.has(extension)) {
        try {
          const buffer = await readFile(entry.absolute)
          if (!buffer.includes(0) && buffer.length <= request.maxFileBytes && totalBytes + buffer.length <= MAX_TOTAL_CONTENT_BYTES) {
            const candidateContent = buffer.toString('utf8')
            const lineCount = candidateContent.split(/\r\n|\n|\r/).length
            if (totalLines + lineCount <= MAX_TOTAL_CONTENT_LINES) {
              content = candidateContent
              totalBytes += buffer.length
              totalLines += lineCount
              version = createHash('sha256').update(buffer).digest('hex')
            }
          }
        } catch {
          // Files may disappear during a search snapshot; skip their content.
        }
      } else if (scope !== 'files' && content === undefined) {
        version = `${version}:content-skipped`
      }
      const stat = await info.stat(entry.absolute).catch(() => undefined)
      const id = createHash('sha256').update(entry.path).digest('hex')
      result.push({
        scope: { tenantId: binding.tenantId, principalId: binding.principalId, sessionId: binding.sessionId },
        id,
        path: entry.path,
        version: stat === undefined ? version : `${stat.size}:${stat.mtimeMs}:${version}`,
        summary: entry.path,
        ...(content === undefined ? {} : { content }),
      })
    }
    return result
  })
  return {
    source: reader.source,
    async search(query, binding) {
      const candidates = await reader.search(query, binding)
      return candidates
    },
  }
}
