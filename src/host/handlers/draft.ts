/**
 * Handlers for the AMP `draft` module added in 0.8.0.
 *
 * The model may read, open, rewrite, patch, diff and check drafts; AMP keeps
 * `freeze`, `abandon` and `supersede` as host powers and never registers them.
 * Like `elaboration`, the port resolves the kernel of the current workspace at
 * call time so one plugin instance serves several workspaces.
 */
import { createDraftToolHandlers } from 'attention-manifest-protocol/agent'
import type { DraftToolPort, GatewayHandler } from 'attention-manifest-protocol/agent'
import type { AmpHost } from '../amp.js'

export function draftHandlers(host: AmpHost): Record<string, GatewayHandler> {
  const port: DraftToolPort = {
    flow: {
      draftById: (draftId) => host.kernel().flow.draftById(draftId),
      draftsOf: (intentId) => host.kernel().flow.draftsOf(intentId),
      openDraft: (input) => host.kernel().flow.openDraft(input),
      writeDraft: (input) => host.kernel().flow.writeDraft(input),
      patchDraft: (input) => host.kernel().flow.patchDraft(input),
      checkDraft: (input) => host.kernel().flow.checkDraft(input),
      diffDrafts: (input) => host.kernel().flow.diffDrafts(input),
    },
  }
  return createDraftToolHandlers(port) as Record<string, GatewayHandler>
}
