/**
 * Standalone AMP `attention_manifest_protocol_replace` tool.
 *
 * The replace contract, handler and filesystem adapter all come from AMP:
 * `createReplaceToolHandler` resolves the target on a mounted `WorkspaceFile`
 * and `NodeFileStorage` supplies the root-confined, hash-checked commit. This
 * adapter only wires the agent workspace root into that AMP stack.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Workspace } from 'attention-manifest-protocol/workspace'
import type { AmpHost } from './amp.js'
import { jsonSafe } from './json.js'

interface AmpProtocolSurface {
  readonly workspace: { Workspace: new (options: Record<string, unknown>) => Workspace }
  readonly file: { NodeFileStorage: new (options: Record<string, unknown>) => unknown }
}

export function registerReplaceTool(ctx: Context, host: AmpHost): void {
  const protocol = host.protocol as unknown as AmpProtocolSurface
  const workspaces = new Map<string, Workspace>()
  const workspaceFor = (root: string): Workspace => {
    const existing = workspaces.get(root)
    if (existing !== undefined) return existing
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
