/** Compose the host-authored handlers for every tool on the AMP agent surface. */
import type { GatewayHandler } from 'attention-manifest-protocol/agent'
import type { AmpHost } from '../amp.js'
import { attentionHandlers } from './attention.js'
import { draftHandlers } from './draft.js'
import { elaborationHandlers } from './elaboration.js'
import { cooperationHandlers } from './cooperation.js'
import { executionHandlers } from './execution.js'
import { planningHandlers } from './planning.js'
import { projectHandlers } from './project.js'
import { projectOutlineHandlers } from '../projectOutline.js'
import { questionHandlers } from './question.js'
import { sessionHandlers } from './session.js'
import { workspaceHandlers } from './workspace.js'

export function createHandlers(host: AmpHost): Record<string, GatewayHandler> {
  const handlers: Record<string, GatewayHandler> = {
    ...sessionHandlers(host),
    ...planningHandlers(host),
    ...attentionHandlers(host),
    ...projectHandlers(host),
    ...projectOutlineHandlers(host),
    ...questionHandlers(host),
    ...workspaceHandlers(host),
    ...elaborationHandlers(host),
    ...draftHandlers(host),
    ...executionHandlers(host),
    ...cooperationHandlers(host),
  }
  // Every tool in the configured surface must have a handler, otherwise the
  // gateway answers `handler_missing`. Unimplemented verbs fail explicitly
  // instead of silently disappearing.
  for (const tool of host.catalog) {
    if (handlers[tool.name] !== undefined) continue
    handlers[tool.name] = (parameters) => ({
      ok: false,
      error: {
        code: 'not_implemented',
        message: `AMP ${tool.module}.${tool.verb} has no host handler yet`,
        parameters,
      },
    })
  }
  return handlers
}
