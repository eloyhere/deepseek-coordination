/** AMP workspace verbs backed by the session workspace root. */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AMP_PREFIX } from '../names.js'
import type { AmpHost } from '../amp.js'
import { storageLayout } from '../storage.js'
import { hasFileOutline, markFileOutlined, markProjectOutlined, projectSnapshot, takeProjectOutline } from '../readNavigation.js'
import { failure, ok, rootOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'
import type { Workspace } from 'attention-manifest-protocol/workspace'
import type { WorkspaceFile, FileSnapshot, FileDiff, WriteTarget } from 'attention-manifest-protocol/file'

function key(module: string, verb: string): string {
  return `${AMP_PREFIX}_${module}.${verb}`
}

/** The plugin's own data directory is not part of the project tree. */
function internalDirectory(host: AmpHost): string {
  const layout = storageLayout(host.config, rootOf(host))
  return resolve(layout.directory).toLowerCase()
}

interface Resolved {
  readonly absolute: string
  readonly relative: string
}

function resolveInRoot(host: AmpHost, raw: unknown): Resolved {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('path must be a non-empty string')
  const root = resolve(rootOf(host))
  const target = resolve(root, raw)
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error('path must stay inside the workspace root')
  }
  return { absolute: target, relative: rel === '' ? '.' : rel }
}

interface AmpProtocolSurface {
  readonly workspace: { Workspace: new (options: Record<string, unknown>) => Workspace }
  readonly file: { NodeFileStorage: new (options: Record<string, unknown>) => unknown }
}

const mounts = new WeakMap<AmpHost, Map<string, Workspace>>()

/** One AMP Workspace (and its NodeFileStorage) per resolved workspace root. */
function workspaceOf(host: AmpHost): Workspace {
  const root = resolve(rootOf(host))
  let byRoot = mounts.get(host)
  if (byRoot === undefined) {
    byRoot = new Map()
    mounts.set(host, byRoot)
  }
  const existing = byRoot.get(root)
  if (existing !== undefined) return existing
  const protocol = host.protocol as unknown as AmpProtocolSurface
  const storage = new protocol.file.NodeFileStorage({
    root,
    createRoot: false,
    maxFileBytes: Math.max(host.config.maxReadChars * 4, 1_000_000),
  })
  const workspace = new protocol.workspace.Workspace({
    tenantId: host.config.tenantId,
    rootId: host.config.rootId,
    storage,
  })
  byRoot.set(root, workspace)
  return workspace
}

interface OpenFile {
  readonly file: WorkspaceFile
  readonly snapshot: FileSnapshot
}

/** Mount (and activate) one workspace-relative file through AMP. */
function openFile(host: AmpHost, path: string, writable: boolean): OpenFile {
  // AMP addresses files with POSIX separators; Windows callers pass `src\\a.ts`.
  const portable = path.split(sep).join('/')
  const file = workspaceOf(host).file(portable, { mode: writable ? 'writable' : 'read-only' })
  file.mount()
  const snapshot = file.activate()
  return { file, snapshot }
}

function nodesOf(file: WorkspaceFile): Array<{ id: string; name: string; kind: string; line: number; endLine: number }> {
  return file.outline().map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    line: entry.range.startLine + 1,
    endLine: entry.range.endLine + 1,
  }))
}

function languageOf(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'json') return 'json'
  if (extension === 'ts' || extension === 'tsx' || extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') return 'typescript'
  return extension
}

function windowOf(text: string, parameters: Params): { content: string; start: number; end: number; truncated: boolean; unit: 'line' | 'byte' | 'char' } {
  const lines = text.split(/\r?\n/)
  if (typeof parameters.startLine === 'number') {
    const startLine = Math.max(1, Math.floor(parameters.startLine))
    const maxLines = typeof parameters.maxLines === 'number' ? Math.max(1, Math.floor(parameters.maxLines)) : lines.length
    const slice = lines.slice(startLine - 1, startLine - 1 + maxLines)
    return {
      content: slice.join('\n'),
      start: startLine,
      end: Math.min(lines.length, startLine - 1 + slice.length),
      truncated: startLine - 1 + slice.length < lines.length,
      unit: 'line',
    }
  }
  if (typeof parameters.offsetBytes === 'number') {
    const bytes = Buffer.from(text, 'utf8')
    const start = Math.max(0, Math.floor(parameters.offsetBytes))
    const maxBytes = typeof parameters.maxBytes === 'number' ? Math.max(1, Math.floor(parameters.maxBytes)) : bytes.length
    const slice = bytes.subarray(start, start + maxBytes)
    return {
      content: slice.toString('utf8'),
      start,
      end: Math.min(bytes.length, start + slice.length),
      truncated: start + slice.length < bytes.length,
      unit: 'byte',
    }
  }
  const start = typeof parameters.offset === 'number' ? Math.max(0, Math.floor(parameters.offset)) : 0
  const maxChars = typeof parameters.maxChars === 'number' ? Math.max(1, Math.floor(parameters.maxChars)) : text.length
  const content = text.slice(start, start + maxChars)
  return { content, start, end: start + content.length, truncated: start + content.length < text.length, unit: 'char' }
}

/** One directory snapshot shared by `list` and the directory outline phases. */
async function collectEntries(
  host: AmpHost,
  target: Resolved,
  maxDepth: number,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const entries: Array<Record<string, unknown>> = []
  const internal = internalDirectory(host)
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (entries.length >= limit) return
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      if (entries.length >= limit) return
      if (child.name === 'node_modules' || child.name === '.git') continue
      const absolute = join(directory, child.name)
      if (child.isDirectory() && resolve(absolute).toLowerCase() === internal) continue
      const rel = relative(resolve(rootOf(host)), absolute)
      const stat = statSync(absolute)
      entries.push({ path: rel, kind: child.isDirectory() ? 'directory' : 'file', bytes: stat.size, modified: stat.mtime.toISOString() })
      if (child.isDirectory() && depth < maxDepth) await walk(absolute, depth + 1)
    }
  }
  if (existsSync(target.absolute)) {
    const stat = statSync(target.absolute)
    if (stat.isDirectory()) await walk(target.absolute, 1)
    else entries.push({ path: target.relative, kind: 'file', bytes: stat.size, modified: stat.mtime.toISOString() })
  }
  return entries
}

function editOptions(parameters: Params): { expectedBaseHash?: string; expectedBufferVersion?: number } {
  const options: { expectedBaseHash?: string; expectedBufferVersion?: number } = {}
  if (typeof parameters.expectedBaseHash === 'string') options.expectedBaseHash = parameters.expectedBaseHash
  else if (typeof parameters.expectedRevision === 'string') options.expectedBaseHash = parameters.expectedRevision
  if (typeof parameters.expectedBufferVersion === 'number') options.expectedBufferVersion = parameters.expectedBufferVersion
  return options
}

function targetOf(parameters: Params): WriteTarget | undefined {
  if (typeof parameters.target === 'object' && parameters.target !== null) return parameters.target as WriteTarget
  if (typeof parameters.outlineId === 'string') return { mode: 'outline', id: parameters.outlineId }
  if (typeof parameters.startLine === 'number') {
    const start = Math.max(0, Math.floor(parameters.startLine) - 1)
    const end = typeof parameters.endLine === 'number' ? Math.max(start + 1, Math.floor(parameters.endLine)) : start + 1
    return { mode: 'line', start, end }
  }
  if (typeof parameters.offsetBytes === 'number') {
    const start = Math.max(0, Math.floor(parameters.offsetBytes))
    const end = typeof parameters.endBytes === 'number' ? Math.floor(parameters.endBytes) : start
    return { mode: 'byte', start, end }
  }
  return undefined
}

export function workspaceHandlers(host: AmpHost): HandlerMap {
  return {
    [key('workspace', 'list')]: async (parameters: Params) => {
      try {
        const target = resolveInRoot(host, parameters.path ?? '.')
        const maxDepth = typeof parameters.depth === 'number' ? Math.min(Math.max(1, parameters.depth), 4) : 2
        const limit = typeof parameters.limit === 'number' ? Math.min(Math.max(1, parameters.limit), 1000) : 300
        const entries = await collectEntries(host, target, maxDepth, limit)
        if (existsSync(target.absolute) && statSync(target.absolute).isDirectory() && target.absolute === resolve(rootOf(host))) {
          markProjectOutlined(host, rootOf(host))
        }
        return ok({ root: rootOf(host), entries, truncated: entries.length >= limit })
      } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },

    [key('workspace', 'read')]: async (parameters: Params) => {
      try {
        const target = resolveInRoot(host, parameters.path)
        if (!existsSync(target.absolute)) return failure('not_found', `workspace path ${target.relative} was not found`)
        if (statSync(target.absolute).isDirectory()) {
          const root = rootOf(host)
          const atRoot = resolve(target.absolute) === resolve(root)
          const entries = await collectEntries(host, target, 2, 300)
          if (atRoot) markProjectOutlined(host, root)
          return ok({
            path: target.relative,
            phase: 'project_outline',
            entries,
            truncated: entries.length >= 300,
            ...(atRoot ? { project: projectSnapshot(host, root) } : {}),
            note: 'Project outline delivered. Pick a file and call workspace.outline on it before reading its content.',
          })
        }
        const opened = openFile(host, target.relative, false)
        const text = opened.file.read()
        const revision = opened.snapshot.baseHash
        const root = rootOf(host)
        const project = takeProjectOutline(host, root)
        if (!hasFileOutline(host, root, target.absolute, revision)) {
          const language = languageOf(target.relative)
          const nodes = nodesOf(opened.file)
          markFileOutlined(host, root, target.absolute, revision)
          return ok({
            path: target.relative, revision, phase: 'outline', language, nodes,
            baseHash: opened.snapshot.baseHash, bufferVersion: opened.snapshot.bufferVersion,
            bytes: Buffer.byteLength(text, 'utf8'), lines: text.split(/\r?\n/).length,
            ...(project === undefined ? {} : { project }),
            next: { verb: 'read', arguments: parameters },
            note: 'Outline delivered. Repeat read with the desired range to retrieve content.',
          })
        }
        if (project !== undefined) {
          return ok({
            path: target.relative, revision, phase: 'project_outline', project,
            baseHash: opened.snapshot.baseHash, bufferVersion: opened.snapshot.bufferVersion,
            next: { verb: 'read', arguments: parameters },
            note: 'Project structure changed. Repeat read to retrieve content.',
          })
        }
        const window = windowOf(text, parameters)
        return ok({
          path: target.relative,
          content: window.content,
          revision,
          baseHash: opened.snapshot.baseHash,
          bufferVersion: opened.snapshot.bufferVersion,
          version: opened.snapshot.version,
          eol: opened.snapshot.eol,
          encoding: opened.snapshot.encoding,
          bytes: Buffer.byteLength(text, 'utf8'),
          lines: text.split(/\r?\n/).length,
          range: { start: window.start, end: window.end, unit: window.unit },
          truncated: window.truncated,
        })
      } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },

    [key('workspace', 'outline')]: async (parameters: Params) => {
      try {
        const target = resolveInRoot(host, parameters.path)
        if (!existsSync(target.absolute)) return failure('not_found', `workspace path ${target.relative} was not found`)
        if (statSync(target.absolute).isDirectory()) {
          const root = rootOf(host)
          const atRoot = resolve(target.absolute) === resolve(root)
          const entries = await collectEntries(host, target, 2, 300)
          if (atRoot) markProjectOutlined(host, root)
          return ok({
            path: target.relative,
            phase: 'project_outline',
            entries,
            truncated: entries.length >= 300,
            ...(atRoot ? { project: projectSnapshot(host, root) } : {}),
            note: 'Project outline delivered. Call workspace.outline on a file before reading its content.',
          })
        }
        const opened = openFile(host, target.relative, false)
        const revision = opened.snapshot.baseHash
        const language = languageOf(target.relative)
        const nodes = nodesOf(opened.file)
        const project = takeProjectOutline(host, rootOf(host))
        markFileOutlined(host, rootOf(host), target.absolute, revision)
        return ok({
          path: target.relative, revision, language, nodes,
          baseHash: opened.snapshot.baseHash, bufferVersion: opened.snapshot.bufferVersion,
          ...(project === undefined ? {} : { project }),
        })
      } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },

    [key('workspace', 'document_outline')]: (parameters: Params) => {
      try {
        const target = resolveInRoot(host, parameters.path)
        if (!existsSync(target.absolute)) return failure('not_found', `workspace path ${target.relative} was not found`)
        const opened = openFile(host, target.relative, false)
        try {
          const outline = opened.file.documentOutline(
            typeof parameters.language === 'string' ? { language: parameters.language } : {},
          )
          return ok({ path: target.relative, kind: languageOf(target.relative), supported: true, ...(outline as object) })
        } catch (error) {
          const code = (error as { code?: string }).code
          if (code === 'unsupported_format' || code === 'binary_file') {
            return ok({
              path: target.relative,
              kind: languageOf(target.relative),
              supported: false,
              nodes: [],
              note: 'AMP reports no document outline for this format; use the DSH office tools to inspect the file',
            })
          }
          throw error
        }
      } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },

    [key('workspace', 'diff')]: (parameters: Params) => {
      try {
        const target = resolveInRoot(host, parameters.path)
        if (!existsSync(target.absolute)) return failure('not_found', `workspace path ${target.relative} was not found`)
        const opened = openFile(host, target.relative, false)
        const base = typeof parameters.base === 'string' ? { hash: parameters.base } : 'disk'
        const diff: FileDiff = opened.file.diffStructured(base)
        return ok({ path: target.relative, revision: opened.snapshot.baseHash, ...diff })
      } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },

    [key('workspace', 'write')]: (parameters: Params) => {
      try {
        const target = resolveInRoot(host, parameters.path)
        const dryRun = parameters.dryRun === true
        if (typeof parameters.content !== 'string') {
          return failure('invalid_arguments', 'content is required; use attention_manifest_protocol_replace for targeted edits')
        }
        if (parameters.content.length > host.config.maxWriteChars) {
          return failure('capacity_exceeded', `write exceeds the ${host.config.maxWriteChars} character ceiling`)
        }
        const exists = existsSync(target.absolute)
        if (!exists) {
          if (dryRun) return ok({ path: target.relative, dryRun, created: true, hunks: [], summary: { added: 0, removed: 0, changed: 0 }, truncated: false })
          mkdirSync(dirname(target.absolute), { recursive: true })
          writeFileSync(target.absolute, parameters.content, 'utf8')
          const opened = openFile(host, target.relative, false)
          host.baseContents.set(target.absolute, parameters.content)
          return ok({
            path: target.relative, dryRun: false, created: true,
            revision: opened.snapshot.baseHash, baseHash: opened.snapshot.baseHash,
            bufferVersion: opened.snapshot.bufferVersion, version: opened.snapshot.version,
            bytes: Buffer.byteLength(parameters.content, 'utf8'),
          })
        }
        const opened = openFile(host, target.relative, true)
        try {
          const options = editOptions(parameters)
          const changeTarget = targetOf(parameters)
          const plan = opened.file.planWrite(parameters.content, changeTarget, options)
          if (dryRun) {
            return ok({ path: target.relative, dryRun: true, mode: plan.mode, text: plan.text })
          }
          opened.file.write(parameters.content, changeTarget, options)
          const snapshot = opened.file.flush()
          host.baseContents.set(target.absolute, opened.file.read())
          return ok({
            path: target.relative, dryRun: false,
            revision: snapshot.baseHash, baseHash: snapshot.baseHash, hash: snapshot.hash,
            bufferVersion: snapshot.bufferVersion, version: snapshot.version,
            dirty: snapshot.dirty, encoding: snapshot.encoding, eol: snapshot.eol,
            bytes: Buffer.byteLength(opened.file.read(), 'utf8'),
          })
        } finally {
          try {
            opened.file.unmount({ discardDirty: true })
          } catch {
            // Releasing the lease is best effort; a mounted write already failed.
          }
        }
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'version_conflict' || code === 'buffer_conflict' || code === 'stale') {
          return failure(code, error instanceof Error ? error.message : String(error))
        }
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },
  }
}
