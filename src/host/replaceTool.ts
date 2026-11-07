/**
 * Standalone AMP `attention_manifest_protocol_replace` tool.
 *
 * AMP 0.7.9 ships the replace contract and handler; this adapter supplies the
 * host's filesystem as a `FileStoragePort` and registers the handler under the
 * protocol name. Replace remains an AMP path, so the file-write takeover guard
 * never blocks it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  FileLease,
  FileRef,
  FileStoragePort,
  StoredFile,
} from 'attention-manifest-protocol/file'
import type { Workspace } from 'attention-manifest-protocol/workspace'
import type { AmpHost } from './amp.js'
import { jsonSafe } from './json.js'

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  const comparable = process.platform === 'win32' ? rel.toLowerCase() : rel
  return comparable === '' || (comparable !== '..' && !comparable.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function hashOf(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

/** A small, CAS-guarded filesystem port for AMP Workspace. */
class LocalFileStorage implements FileStoragePort {
  private readonly root: string
  private readonly versions = new Map<string, number>()

  constructor(root: string) {
    this.root = resolve(root)
  }

  private pathOf(ref: FileRef): string {
    const absolute = resolve(this.root, ref.path)
    if (!inside(this.root, absolute)) throw new Error('replace path must stay inside the workspace root')
    return absolute
  }

  read(ref: FileRef): StoredFile | undefined {
    const absolute = this.pathOf(ref)
    if (!existsSync(absolute)) return undefined
    const stat = statSync(absolute)
    if (!stat.isFile()) return undefined
    const content = readFileSync(absolute, 'utf8')
    const version = this.versions.get(absolute) ?? 0
    return {
      ...ref,
      content,
      hash: hashOf(content),
      version,
      updatedAt: stat.mtime.toISOString(),
      size: stat.size,
    }
  }

  compareAndSwap(ref: FileRef, expectedHash: string, content: string, _fence: number): StoredFile {
    const absolute = this.pathOf(ref)
    const current = this.read(ref)
    const currentHash = current?.hash ?? ''
    if (currentHash !== expectedHash) {
      const error = new Error(`version conflict for ${ref.path}`)
      ;(error as Error & { code?: string }).code = 'version_conflict'
      throw error
    }
    mkdirSync(dirname(absolute), { recursive: true })
    const temporary = `${absolute}.amp-replace.tmp`
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, absolute)
    this.versions.set(absolute, (current?.version ?? 0) + 1)
    const next = this.read(ref)
    if (next === undefined) throw new Error(`replace did not produce ${ref.path}`)
    return next
  }

  acquireLease(ref: FileRef, owner: string): FileLease {
    return {
      ...ref,
      owner,
      fence: 1,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
  }

  releaseLease(_lease: FileLease): void {
    // The filesystem adapter has no cross-process lease; CAS is the guard.
  }
}

export function registerReplaceTool(ctx: Context, host: AmpHost): void {
  const workspaces = new Map<string, Workspace>()
  const workspaceFor = (root: string): Workspace => {
    const existing = workspaces.get(root)
    if (existing !== undefined) return existing
    const workspace = new host.protocol.workspace.Workspace({
      tenantId: host.config.tenantId,
      rootId: host.config.rootId,
      storage: new LocalFileStorage(root),
      outline: host.protocol.file.createOutlineProvider(),
    })
    workspaces.set(root, workspace)
    return workspace
  }

  ctx.tools.register(defineTool({
    name: host.protocol.agent.REPLACE_TOOL_NAME,
    description: host.protocol.agent.REPLACE_TOOL.description,
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative text file path.' },
      mode: { type: 'string', required: true, enum: ['string', 'regex', 'line', 'byte', 'outline'], description: 'How the replacement target is located.' },
      replacement: { type: 'string', required: true, description: 'Replacement text.' },
      text: { type: 'string', description: 'Literal text for mode=string.' },
      pattern: { type: 'string', description: 'Regular expression for mode=regex.' },
      flags: { type: 'string', description: 'Regular expression flags for mode=regex.' },
      occurrence: { type: 'integer', description: 'One-based match to replace when all is false.' },
      all: { type: 'boolean', description: 'Replace every match instead of one.' },
      start: { type: 'integer', description: 'Start offset for mode=line or mode=byte.' },
      end: { type: 'integer', description: 'End offset for mode=line or mode=byte.' },
      id: { type: 'string', description: 'Outline node id for mode=outline.' },
      expectedBufferVersion: { type: 'integer', description: 'Compare-and-swap buffer version.' },
      expectedBaseHash: { type: 'string', description: 'Compare-and-swap base hash.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec: ToolRunContext) {
      const root = host.rootOfAgent(exec.agent)
      if (root === undefined) {
        return jsonSafe({ ok: false, error: { code: 'invalid_binding', message: 'replace requires an agent workspace' } })
      }
      try {
        const workspace = workspaceFor(root)
        const handler = host.protocol.agent.createReplaceToolHandler(workspace)
        const value = await handler(args as never, { binding: host.bindingFor(exec.agent), tool: host.protocol.agent.REPLACE_TOOL } as never)
        return jsonSafe({ ok: true, value })
      } catch (error) {
        const record = error as { code?: unknown; message?: unknown }
        return jsonSafe({
          ok: false,
          error: {
            code: typeof record.code === 'string' ? record.code : 'replace_failed',
            message: typeof record.message === 'string' ? record.message : String(error),
          },
        })
      }
    },
  }))
}
