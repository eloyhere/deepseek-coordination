/** AMP `project.outline`: a ProjectOutline tree populated from real file outlines. */
import { readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { AMP_PREFIX } from './names.js'
import type { AmpHost } from './amp.js'
import { markProjectOutlined } from './readNavigation.js'
import { workspaceOf } from './handlers/workspace.js'
import { failure, ok, rootOf } from './handlers/shared.js'
import type { HandlerMap, Params } from './handlers/shared.js'
import type { OutlineNodeInput, ProjectOutline } from 'attention-manifest-protocol/project'

function key(module: string, verb: string): string {
  return `${AMP_PREFIX}_${module}.${verb}`
}

function walkFiles(root: string, limit = 200): string[] {
  const files: string[] = []
  const walk = (directory: string, depth: number): void => {
    if (files.length >= limit) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= limit) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.amp')) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth < 2) walk(absolute, depth + 1)
      } else if (entry.isFile()) {
        files.push(join(directory, entry.name).slice(resolve(root).length + 1).split(sep).join('/'))
      }
    }
  }
  walk(root, 0)
  return files
}

interface CachedOutline {
  readonly token: string
  readonly outline: ProjectOutline
}

const outlines = new WeakMap<AmpHost, Map<string, CachedOutline>>()

/** Build (or reuse) one AMP ProjectOutline for this workspace root. */
function outlineOf(host: AmpHost): ProjectOutline {
  const root = resolve(rootOf(host))
  const files = walkFiles(root)
  const token = files.join('\u0000')
  let byRoot = outlines.get(host)
  if (byRoot === undefined) {
    byRoot = new Map()
    outlines.set(host, byRoot)
  }
  const cached = byRoot.get(root)
  if (cached !== undefined && cached.token === token) return cached.outline

  const protocol = host.protocol
  const outline = new protocol.project.ProjectOutline({
    tenantId: host.config.tenantId,
    rootId: host.config.rootId,
    projectVersion: 1,
  })
  const nodes: OutlineNodeInput[] = [{
    tenantId: host.config.tenantId,
    rootId: host.config.rootId,
    path: '.',
    type: 'directory',
    name: root.slice(root.lastIndexOf('\\') + 1) || root,
    summary: root,
    hash: 'sha256:0',
  }]
  const directories = new Set<string>()
  for (const file of files) {
    const parts = file.split('/')
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'))
  }
  for (const directory of directories) {
    const parent = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : undefined
    nodes.push({
      tenantId: host.config.tenantId,
      rootId: host.config.rootId,
      path: directory,
      type: 'directory',
      name: directory.slice(directory.lastIndexOf('/') + 1),
      summary: directory,
      hash: 'sha256:0',
      parentPath: parent ?? '.',
    })
  }
  const workspace = workspaceOf(host)
  for (const file of files) {
    let summary = ''
    let hash = ''
    let version = 0
    try {
      const handle = workspace.file(file, { mode: 'read-only' })
      handle.mount()
      const snapshot = handle.activate()
      hash = snapshot.hash
      version = snapshot.version
      summary = protocol.project.summarizeFileOutline(handle.outline())
    } catch {
      // Binary or unreadable files stay listed without a structural summary.
    }
    const parent = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : undefined
    nodes.push({
      tenantId: host.config.tenantId,
      rootId: host.config.rootId,
      path: file,
      type: 'file',
      name: file.slice(file.lastIndexOf('/') + 1),
      summary: summary.length > 0 ? summary : file.slice(file.lastIndexOf('/') + 1),
      hash: hash.length > 0 ? hash : 'sha256:0',
      version,
      parentPath: parent ?? '.',
    })
  }
  outline.upsertBatch({
    tenantId: host.config.tenantId,
    rootId: host.config.rootId,
    expectedVersion: outline.version,
    upsert: nodes,
  })
  byRoot.set(root, { token, outline })
  return outline
}

export function projectOutlineHandlers(host: AmpHost): HandlerMap {
  return {
    [key('project', 'outline')]: (parameters: Params) => {
      try {
        const outline = outlineOf(host)
        const root = rootOf(host)
        markProjectOutlined(host, root)
        if (typeof parameters.path === 'string') {
          return ok({ root, path: parameters.path, version: outline.version, nodes: outline.subtree(parameters.path) })
        }
        if (typeof parameters.query === 'string') {
          return ok({ root, query: parameters.query, version: outline.version, candidates: outline.candidates(parameters.query) })
        }
        return ok({ root, version: outline.version, nodes: outline.list() })
      } catch (error) {
        return failure('invalid_arguments', error instanceof Error ? error.message : String(error))
      }
    },
  }
}
