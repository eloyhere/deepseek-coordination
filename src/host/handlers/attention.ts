/** AMP attention, context, budget and evidence verbs. */
import { AMP_PREFIX } from '../names.js'
import type { AmpHost } from '../amp.js'
import { entityId, failure, ok, page, sessionOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'

function key(module: string, verb: string): string {
  return `${AMP_PREFIX}_${module}.${verb}`
}

function compiledText(compiled: unknown): string {
  if (typeof compiled === 'string') return compiled
  if (typeof compiled === 'object' && compiled !== null) {
    const record = compiled as Record<string, unknown>
    for (const name of ['text', 'content', 'summary']) {
      if (typeof record[name] === 'string') return record[name] as string
    }
  }
  return JSON.stringify(compiled)
}

export function attentionHandlers(host: AmpHost): HandlerMap {
  return {
    [key('attention', 'context')]: (parameters: Params) => {
      const sessionId = entityId(parameters, 'sessionId') ?? sessionOf(host)
      const turn = typeof parameters.turn === 'number' ? parameters.turn : host.currentTurn(sessionId) ?? 0
      try {
        const turnId = host.ensureTurn(sessionId, turn)
        const budget = typeof parameters.budget === 'object' && parameters.budget !== null
          ? parameters.budget
          : { tokens: 2048 }
        const compiled = host.kernel().flow.compileTurnContext({
          turnId,
          sessionId,
          principalId: entityId(parameters, 'principalId') ?? sessionId,
          budget: budget as never,
          create: [{
            id: `attention:${turnId}`,
            summary: `Context for DSH turn ${turn}`,
            pointer: { kind: 'turn', id: turnId, version: '1' },
            scope: {
              tenantId: host.config.tenantId,
              principalId: sessionId,
              sessionId,
              turnId,
            },
            budget: budget as never,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            reason: 'the current turn is the operative attention target',
          }],
          countTokens: (text: string) => Math.ceil(text.length / 4),
        })
        return ok({ ...compiled, text: compiledText(compiled.compiled) })
      } catch (error) {
        return failure('invalid_state', error instanceof Error ? error.message : String(error))
      }
    },

    [key('attention', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      const entity = host.findEntity('attention', id)
      return entity === undefined ? failure('not_found', `attention object ${id} was not found`) : ok(entity)
    },

    [key('attention', 'request_focus')]: (parameters: Params) => {
      const target = parameters.target
      const sessionId = sessionOf(host)
      const notes = host.notes.get(sessionId) ?? []
      notes.push({ kind: 'attention-focus', target, reason: parameters.reason ?? null, at: new Date().toISOString() })
      host.notes.set(sessionId, notes.slice(-100))
      return ok({ requested: true, target: target ?? null, granted: false, note: 'focus residency stays with the host attention policy' })
    },

    [key('budget', 'remaining')]: () => ok(host.kernel().snapshot().budget),

    [key('evidence', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      const evidence = host.kernel().ports.evidence.get(id, host.config.tenantId)
      return evidence === undefined ? failure('not_found', `evidence ${id} was not found`) : ok(evidence)
    },

    [key('evidence', 'list')]: (parameters: Params) => {
      const rows = host.listEntities('evidence', entityId(parameters, 'sessionId') ?? sessionOf(host))
      return ok(page(rows, parameters))
    },

    [key('evidence', 'cite')]: (parameters: Params) => {
      const ids = Array.isArray(parameters.ids)
        ? parameters.ids.filter((id): id is string => typeof id === 'string')
        : typeof parameters.id === 'string'
          ? [parameters.id]
          : []
      if (ids.length === 0) return failure('invalid_parameters', 'ids is required')
      for (const id of ids) host.citations.add(id)
      return ok({ cited: ids, total: host.citations.size })
    },
  }
}

