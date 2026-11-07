/** AMP workspace verbs backed by the session workspace root. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AMP_PREFIX } from '../names.js'
import type { AmpHost } from '../amp.js'
import { storageLayout } from '../storage.js'
import { hasFileOutline, markFileOutlined, markProjectOutlined, projectSnapshot, takeProjectOutline } from '../readNavigation.js'
import { failure, ok, rootOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'

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

function revisionOf(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

function textOf(host: AmpHost, file: string): string {
  const buffer = readFileSync(file)
  if (buffer.includes(0)) throw new Error('binary files cannot be read as text')
  const text = buffer.toString('utf8')
  if (text.length > host.config.maxReadChars) {
    throw new Error(`file exceeds the ${host.config.maxReadChars} character read ceiling`)
  }
  return text
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

function outlineOf(text: string, language: string): Array<{ name: string; kind: string; line: number }> {
  const result: Array<{ name: string; kind: string; line: number }> = []
  const lines = text.split(/\r?\n/)
  const markdown = language === 'markdown' || language === 'md'
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (markdown) {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line)
      if (heading !== null) result.push({ name: heading[2]!.trim(), kind: `h${heading[1]!.length}`, line: index + 1 })
      continue
    }
    const symbol = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (symbol !== null) {
      const kind = /class/.test(line) ? 'class' : /interface/.test(line) ? 'interface' : /type\s/.test(line) ? 'type' : /function/.test(line) ? 'function' : 'variable'
      result.push({ name: symbol[1]!, kind, line: index + 1 })
    }
  }
  return result.slice(0, 500)
}

function languageOf(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'json') return 'json'
  if (extension === 'ts' || extension === 'tsx' || extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') return 'typescript'
  return extension
}

function diffHunks(base: string, next: string): Array<Record<string, unknown>> {
  if (base === next) return []
  const a = base.split(/\r?\n/)
  const b = next.split(/\r?\n/)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  return [{
    oldStart: prefix + 1,
    oldLines: a.length - prefix - suffix,
    newStart: prefix + 1,
    newLines: b.length - prefix - suffix,
    removed: a.slice(prefix, a.length - suffix),
    added: b.slice(prefix, b.length - suffix),
  }]
}

function ensureParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
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
        const text = textOf(host, target.absolute)
        const revision = revisionOf(text)
        const root = rootOf(host)
        const project = takeProjectOutline(host, root)
        if (!hasFileOutline(host, root, target.absolute, revision)) {
          const language = languageOf(target.relative)
          const nodes = outlineOf(text, language)
          markFileOutlined(host, root, target.absolute, revision)
          return ok({
            path: target.relative, revision, phase: 'outline', language, nodes,
            bytes: Buffer.byteLength(text, 'utf8'), lines: text.split(/\r?\n/).length,
            ...(project === undefined ? {} : { project }),
            next: { verb: 'read', arguments: parameters },
            note: 'Outline delivered. Repeat read with the desired range to retrieve content.',
          })
        }
        if (project !== undefined) {
          return ok({
            path: target.relative, revision, phase: 'project_outline', project,
            next: { verb: 'read', arguments: parameters },
            note: 'Project structure changed. Repeat read to retrieve content.',
          })
        }
        host.baseContents.set(target.absolute, text)
        const window = windowOf(text, parameters)
        return ok({
          path: target.relative,
          content: window.content,
          revision,
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
        const text = textOf(host, target.absolute)
        const revision = revisionOf(text)
        const language = languageOf(target.relative)
        const nodes = outlineOf(text, language)
        const project = takeProjectOutline(host, rootOf(host))
        markFileOutlined(host, rootOf(host), target.absolute, revision)
        return ok({
          path: target.relative, revision, language, nodes,
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
        return ok({
          path: target.relative,
          kind: languageOf(target.relative),
          supported: false,
          nodes: [],
          note: 'binary document outlines are not implemented by this host; use the DSH office tools to inspect the file',
        })
      } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },

    [key('workspace', 'diff')]: (parameters: Params) => {
      try {
        const target = resolveInRoot(host, parameters.path)
        if (!existsSync(target.absolute)) return failure('not_found', `workspace path ${target.relative} was not found`)
        const current = textOf(host, target.absolute)
        const base = typeof parameters.base === 'string'
          ? parameters.base
          : host.baseContents.get(target.absolute) ?? ''
        return ok({
          path: target.relative,
          revision: revisionOf(current),
          baseRevision: revisionOf(base),
          hunks: diffHunks(base, current),
        })
      } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },

    [key('workspace', 'write')]: (parameters: Params) => {
      try {
        const target = resolveInRoot(host, parameters.path)
        const dryRun = parameters.dryRun === true
        const exists = existsSync(target.absolute)
        const existing = exists ? textOf(host, target.absolute) : ''
        const expected = typeof parameters.expectedRevision === 'string' ? parameters.expectedRevision : undefined
        if (exists && expected === undefined) {
          return failure('invalid_arguments', 'expectedRevision is required when overwriting an existing file')
        }
        if (expected !== undefined && expected !== revisionOf(existing)) {
          return failure('version_conflict', 'expectedRevision does not match the current file revision')
        }
        let next: string
        if (typeof parameters.content === 'string') {
          next = parameters.content
        } else if (typeof parameters.startLine === 'number') {
          const lines = existing.split(/\r?\n/)
          const start = Math.max(1, Math.floor(parameters.startLine))
          const end = typeof parameters.endLine === 'number' ? Math.floor(parameters.endLine) : start
          if (end < start || start > lines.length + 1 || end > lines.length) {
            return failure('invalid_arguments', 'line range is outside the file')
          }
          const replacement = typeof parameters.replacement === 'string' ? parameters.replacement.split(/\r?\n/) : []
          lines.splice(start - 1, end - start + 1, ...replacement)
          next = lines.join('\n')
        } else if (typeof parameters.offsetBytes === 'number') {
          const bytes = Buffer.from(existing, 'utf8')
          const start = Math.max(0, Math.floor(parameters.offsetBytes))
          const end = typeof parameters.endBytes === 'number' ? Math.floor(parameters.endBytes) : start
          if (end < start || start > bytes.length || end > bytes.length) {
            return failure('invalid_arguments', 'byte range is outside the file')
          }
          const replacement = Buffer.from(typeof parameters.replacement === 'string' ? parameters.replacement : '', 'utf8')
          next = Buffer.concat([bytes.subarray(0, start), replacement, bytes.subarray(end)]).toString('utf8')
        } else {
          return failure('invalid_arguments', 'content, startLine or offsetBytes is required')
        }
        if (next.length > host.config.maxWriteChars) {
          return failure('capacity_exceeded', `write exceeds the ${host.config.maxWriteChars} character ceiling`)
        }
        const hunks = diffHunks(existing, next)
        if (!dryRun) {
          ensureParent(target.absolute)
          const temporary = `${target.absolute}.amp-${process.pid}.tmp`
          writeFileSync(temporary, next, 'utf8')
          renameSync(temporary, target.absolute)
          host.baseContents.set(target.absolute, next)
        }
        return ok({
          path: target.relative,
          revision: revisionOf(next),
          bytes: Buffer.byteLength(next, 'utf8'),
          dryRun,
          hunks,
        })
      } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },
  }
}

