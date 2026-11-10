/**
 * Lazy AMP loader.
 *
 * The kernel and agent surfaces pull in the full protocol and SQLite stack, so
 * they are loaded only when the plugin applies rather than at package import.
 * `semantic-typescript@2.0.1` no longer mutates global prototypes; no freeze
 * guard is required.
 */
import type * as AgentModule from 'attention-manifest-protocol/agent'
import type * as FileModule from 'attention-manifest-protocol/file'
import type * as KernelModule from 'attention-manifest-protocol/kernel'
import type * as ProjectModule from 'attention-manifest-protocol/project'
import type * as WorkspaceModule from 'attention-manifest-protocol/workspace'

export interface AmpProtocol {
  readonly agent: typeof AgentModule
  readonly kernel: typeof KernelModule
  readonly workspace: typeof WorkspaceModule
  readonly file: typeof FileModule
  readonly project: typeof ProjectModule
}

let pending: Promise<AmpProtocol> | undefined

export function loadAmpProtocol(): Promise<AmpProtocol> {
  pending ??= (async () => {
    const [agent, kernel, workspace, file, project] = await Promise.all([
      import('attention-manifest-protocol/agent'),
      import('attention-manifest-protocol/kernel'),
      import('attention-manifest-protocol/workspace'),
      import('attention-manifest-protocol/file'),
      import('attention-manifest-protocol/project'),
    ])
    return { agent, kernel, workspace, file, project }
  })()
  return pending
}
