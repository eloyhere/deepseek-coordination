/**
 * Handlers for the AMP `elaboration` module added in 0.8.0.
 *
 * AMP ships the argument validation and the four model-facing verbs
 * (`get_build`, `list_diagnostics`, `explain`, `propose`); the host only
 * supplies the port. Each call must run on the kernel of the workspace the
 * current gateway call is bound to, so the port resolves `host.kernel()`
 * lazily instead of pinning one kernel at registration time.
 */
import { createElaborationToolHandlers } from 'attention-manifest-protocol/agent'
import type { ElaborationToolPort, GatewayHandler } from 'attention-manifest-protocol/agent'
import type { AmpHost } from '../amp.js'

export function elaborationHandlers(host: AmpHost): Record<string, GatewayHandler> {
  const port: ElaborationToolPort = {
    flow: {
      elaborationOf: (intentId) => host.kernel().flow.elaborationOf(intentId),
      elaborationStatus: (input) => host.kernel().flow.elaborationStatus(input),
      elaborateIntent: (input) => host.kernel().flow.elaborateIntent(input),
    },
  }
  return createElaborationToolHandlers(port) as Record<string, GatewayHandler>
}
