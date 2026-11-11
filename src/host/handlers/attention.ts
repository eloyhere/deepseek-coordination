/** AMP attention, context, budget and evidence verbs. */
import { AMP_PREFIX } from '../names.js'
import type { AmpHost } from '../amp.js'
import { entityId, failure, ok, page, sessionOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'
import { estimateTokens } from '../tokenEstimate.js'

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
      // Prefer the package the optimizer actually injected for this session: a
      // synthetic single-item compile would describe a context the model never
      // received. The fallback below stays for sessions that never assembled.
      const optimized = host.contextOptimizer?.packageFor(sessionId)
      if (optimized !== undefined) return ok(optimized)
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
          countTokens: (text: string) => estimateTokens(text),
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

    [key('budget', 'remaining')]: () => {
      const snapshot = host.kernel().snapshot() as unknown as {
        budget: Record<string, unknown>
        budgetTree?: unknown
      }
      // The aggregate alone hides where the budget went; the per-node tree is
      // the AMP ledger view, so return both without changing the flat fields.
      return ok({ ...snapshot.budget, tree: snapshot.budgetTree ?? [] })
    },

    [key('evidence', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      const ledger = host.kernel().ports.evidence
      const evidence = ledger.get(id, host.config.tenantId)
      if (evidence === undefined) return failure('not_found', `evidence ${id} was not found`)
      if (parameters.includeProvenance !== true) return ok(evidence)
      // AMP keeps a provenance event log next to the ledger; surface its tail so
      // a caller can explain how the evidence came to be.
      return ok({ ...evidence, provenance: ledger.auditEvents().slice(-20) })
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
      // AMP has no cite() on EvidenceLedger: a citation is only meaningful for
      // evidence that exists, so resolve every id against the ledger first and
      // report the ones that do not resolve instead of citing blindly.
      const ledger = host.kernel().ports.evidence
      const tenantId = host.config.tenantId
      const cited: string[] = []
      const missing: string[] = []
      for (const id of ids) {
        if (ledger.get(id, tenantId) === undefined) missing.push(id)
        else {
          host.citations.add(id)
          cited.push(id)
        }
      }
      if (cited.length === 0) return failure('not_found', `no evidence matched: ${missing.join(', ')}`)
      return ok({ cited, missing, total: host.citations.size })
    },
  }
}

