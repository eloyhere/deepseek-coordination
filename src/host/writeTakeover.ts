/** Guard that makes the file-write takeover switch effective, not merely advisory. */
import type { AmpHost } from './amp.js'

/** Native file-mutating tool names hidden by the takeover. */
export const FILE_WRITE_TOOL_NAMES: readonly string[] = ['write', 'replace', 'edit', 'apply_patch']

export interface GuardedExecution {
  readonly name: string
  readonly agent?: unknown
}

/**
 * Deny native file mutation for a workspace whose owner enabled
 * `takeoverFileWrite`. AMP's `workspace.write` does not pass through
 * `ctx.tools`, so it remains available and is the single audited path.
 */
export function fileWriteTakeoverGuard(host: AmpHost): (execution: GuardedExecution) => string | undefined {
  return (execution) => {
    if (!FILE_WRITE_TOOL_NAMES.includes(execution.name)) return undefined
    const root = host.rootOfAgent(execution.agent)
    if (!host.preferencesFor(root).get().takeoverFileWrite) return undefined
    return 'File-write takeover is enabled. Use attention_manifest_protocol_workspace.write for full writes, or attention_manifest_protocol_replace for string, regex, line, byte or outline replacements. Read first, then pass expectedRevision for write or expectedBufferVersion/expectedBaseHash for replace. Native write/replace is disabled for this workspace.'
  }
}
