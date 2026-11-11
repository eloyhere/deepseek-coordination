/** AMP session, turn, intent and mission verbs. */
import { AMP_PREFIX } from '../names.js'
import type { AmpHost } from '../amp.js'
import { agentOf, entityId, failure, objectArg, ok, page, sessionOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'

function key(module: string, verb: string): string {
  return `${AMP_PREFIX}_${module}.${verb}`
}

function serviceOf(host: AmpHost, name: 'session' | 'turn' | 'intent' | 'mission'): {
  find(id: string): { get(): unknown; isPresent(): boolean }
  list(sessionId?: string): unknown[]
  get(id: string): unknown
} {
  return host.kernel().ports.services[name] as never
}

export function sessionHandlers(host: AmpHost): HandlerMap {
  return {
    [key('session', 'get')]: (parameters: Params) => {
      const id = entityId(parameters, 'id') ?? sessionOf(host)
      const live = (host.ctx.agents as unknown as { get(id: string): unknown }).get(id)
      let amp: unknown
      try {
        amp = serviceOf(host, 'session').get(id)
      } catch {
        amp = undefined
      }
      return ok({
        id,
        live: live === undefined ? null : { status: (live as { status?: unknown }).status ?? null },
        amp: amp ?? null,
        statusLine: host.statusLines.get(id) ?? null,
      })
    },

    [key('session', 'list')]: (parameters: Params) => {
      const sessions = (host.ctx.sessions as unknown as { list(): readonly { id: string; header?: { cwd?: string }; seq?: number }[] }).list()
      return ok(page(sessions.map((session) => ({
        id: session.id,
        cwd: session.header?.cwd ?? null,
        events: session.seq ?? null,
        live: (host.ctx.agents as unknown as { get(id: string): unknown }).get(session.id) !== undefined,
      })), parameters))
    },

    [key('session', 'report_status')]: (parameters: Params) => {
      const id = entityId(parameters, 'sessionId') ?? sessionOf(host)
      const status = parameters.status
      if (typeof status !== 'string' || status.trim().length === 0) return failure('invalid_parameters', 'status must be a non-empty string')
      host.statusLines.set(id, status.trim())
      return ok({ sessionId: id, status: status.trim() })
    },

    [key('turn', 'current')]: () => {
      const sessionId = sessionOf(host)
      const agent = host.ctx.agents.get(sessionId as never)
      if (agent === undefined) return failure('not_found', `session ${sessionId} is not live`)
      const boundary = host.ctx.agents.turnBoundaryOf(agent.session)
      return ok({ sessionId, turn: boundary.lastTurn, boundary, status: agent.status })
    },

    [key('turn', 'respond')]: (parameters: Params) => {
      const sessionId = sessionOf(host)
      const content = parameters.content
      if (typeof content !== 'string' || content.trim().length === 0) {
        return failure('invalid_parameters', 'content must be a non-empty string')
      }
      const turn = typeof parameters.turn === 'number' ? parameters.turn : host.currentTurn(sessionId)
      const notes = host.notes.get(sessionId) ?? []
      notes.push({ kind: 'turn-response', turn, content: content.slice(0, 2000), at: new Date().toISOString() })
      host.notes.set(sessionId, notes.slice(-100))
      // A response is a Turn transition, not only a host note: advance AMP's
      // TurnService so the turn state/version reflect what the model did.
      // Fail-open: an illegal edge (e.g. already responding) must not fail the verb.
      let advanced = false
      let transition: string | undefined
      try {
        if (turn !== undefined) {
          const turnId = host.ensureTurn(sessionId, turn)
          const service = host.kernel().ports.services.turn as unknown as {
            get(id: string): { version: number }
            respond(id: string, options: { expectedVersion: number; actor: string; reason?: string }): unknown
          }
          const current = service.get(turnId)
          service.respond(turnId, { expectedVersion: current.version, actor: 'dsh-model', reason: 'model response recorded' })
          advanced = true
        }
      } catch (error) {
        transition = error instanceof Error ? error.message : String(error)
      }
      return ok({ accepted: true, sessionId, turn: turn ?? null, characters: content.length, advanced, ...(transition === undefined ? {} : { transition }) })
    },

    [key('turn', 'clarify')]: async (parameters: Params) => {
      const agent = host.ctx.agents.get(sessionOf(host) as never)
      if (agent === undefined) return failure('not_found', 'the calling session is not live')
      const questions = Array.isArray(parameters.questions)
        ? parameters.questions
        : typeof parameters.question === 'string'
          ? [{ id: 'q1', question: parameters.question, options: parameters.options }]
          : []
      if (questions.length === 0) return failure('invalid_parameters', 'questions or question is required')
      const service = host.ctx.get('userQuestions') as
        | { ask(request: Record<string, unknown>): Promise<unknown> }
        | undefined
      if (service === undefined) return failure('not_available', 'no user-question provider is mounted')
      try {
        return ok(await service.ask({
          agent,
          questions: questions.map((raw, index) => {
            const question = objectArg(raw, `questions[${index}]`)
            return {
              id: typeof question.id === 'string' ? question.id : `q${index + 1}`,
              question: String(question.question ?? ''),
              ...(typeof question.header === 'string' ? { header: question.header } : {}),
              ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
              ...(Array.isArray(question.options) ? { options: question.options } : {}),
              ...(question.multiSelect === true ? { multiSelect: true } : {}),
            }
          }),
        }))
      } catch (error) {
        return failure('handler_failed', error instanceof Error ? error.message : String(error))
      }
    },

    [key('turn', 'report')]: async (parameters: Params) => {
      const sessionId = sessionOf(host)
      const message = parameters.message
      if (typeof message !== 'string' || message.trim().length === 0) {
        return failure('invalid_parameters', 'message must be a non-empty string')
      }
      const notes = host.notes.get(sessionId) ?? []
      notes.push({ kind: 'turn-report', message: message.slice(0, 2000), at: new Date().toISOString() })
      host.notes.set(sessionId, notes.slice(-100))
      return ok({ reported: true, sessionId })
    },

    [key('intent', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      try {
        return ok(serviceOf(host, 'intent').get(id))
      } catch {
        return failure('not_found', `intent ${id} was not found`)
      }
    },

    [key('intent', 'list')]: (parameters: Params) => {
      const sessionId = entityId(parameters, 'sessionId') ?? sessionOf(host)
      return ok(page(serviceOf(host, 'intent').list(sessionId), parameters))
    },

    [key('intent', 'submit_clarification')]: (parameters: Params) => {
      const id = entityId(parameters, 'intentId') ?? entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'intentId is required')
      const text = parameters.clarification
      if (typeof text !== 'string' || text.trim().length === 0) {
        return failure('invalid_parameters', 'clarification must be a non-empty string')
      }
      const sessionId = sessionOf(host)
      const notes = host.notes.get(sessionId) ?? []
      notes.push({ kind: 'intent-clarification', intentId: id, text: text.slice(0, 2000), at: new Date().toISOString() })
      host.notes.set(sessionId, notes.slice(-100))
      try {
        const service = host.kernel().ports.services.intent as unknown as {
          get(id: string): { version: number }
          clarify(id: string, options: { expectedVersion: number; actor: string; reason?: string }): unknown
        }
        // `TransitionOptions` has no free-text payload; the clarification text is
        // carried in `reason` so the workflow event records it instead of only
        // the host note. A rejected transition is a failure, not an ok/null.
        const current = service.get(id)
        const intent = service.clarify(id, {
          expectedVersion: current.version,
          actor: 'dsh-model',
          reason: text.slice(0, 500),
        })
        return ok({ proposal: text, intent })
      } catch (error) {
        return failure('invalid_state', error instanceof Error ? error.message : String(error))
      }
    },

    [key('mission', 'get')]: (parameters: Params) => {
      const id = entityId(parameters)
      if (id === undefined) return failure('invalid_parameters', 'id is required')
      try {
        return ok(serviceOf(host, 'mission').get(id))
      } catch {
        return failure('not_found', `mission ${id} was not found`)
      }
    },
  }
}

