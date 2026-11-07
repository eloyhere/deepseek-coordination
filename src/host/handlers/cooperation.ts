/** AMP cooperation verbs: a bounded per-session mailbox for delegated work. */
import { randomUUID } from 'node:crypto'
import { AMP_PREFIX } from '../names.js'
import type { AmpHost } from '../amp.js'
import { failure, ok, page, sessionOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'

function key(module: string, verb: string): string {
  return `${AMP_PREFIX}_${module}.${verb}`
}

interface Envelope {
  readonly id: string
  readonly from: string
  readonly to: string | null
  readonly kind: 'message' | 'result'
  readonly content: unknown
  readonly thread: string | null
  readonly at: string
}

export function cooperationHandlers(host: AmpHost): HandlerMap {
  return {
    [key('cooperation', 'inbox')]: (parameters: Params) => {
      const sessionId = sessionOf(host)
      const mailbox = (host.mailboxes.get(sessionId) ?? []) as Envelope[]
      const unread = mailbox.filter((item) => item.to === null || item.to === sessionId)
      return ok(page(unread, parameters))
    },

    [key('cooperation', 'send')]: (parameters: Params) => {
      const sessionId = sessionOf(host)
      const content = parameters.content ?? parameters.message
      if (content === undefined) return failure('invalid_parameters', 'content is required')
      const thread = typeof parameters.thread === 'string' ? parameters.thread : null
      const target = typeof parameters.to === 'string' ? parameters.to : null
      const envelope: Envelope = {
        id: `coop-${randomUUID()}`,
        from: sessionId,
        to: target,
        kind: 'message',
        content,
        thread,
        at: new Date().toISOString(),
      }
      const mailbox = (host.mailboxes.get(sessionId) ?? []) as Envelope[]
      mailbox.push(envelope)
      host.mailboxes.set(sessionId, mailbox.slice(-200))
      return ok({ sent: true, id: envelope.id, thread })
    },

    [key('cooperation', 'report_result')]: (parameters: Params) => {
      const sessionId = sessionOf(host)
      const summary = parameters.summary ?? parameters.content
      if (summary === undefined) return failure('invalid_parameters', 'summary is required')
      const envelope: Envelope = {
        id: `coop-${randomUUID()}`,
        from: sessionId,
        to: null,
        kind: 'result',
        content: {
          summary,
          evidence: parameters.evidence ?? null,
          status: parameters.status ?? 'submitted',
        },
        thread: typeof parameters.thread === 'string' ? parameters.thread : null,
        at: new Date().toISOString(),
      }
      const mailbox = (host.mailboxes.get(sessionId) ?? []) as Envelope[]
      mailbox.push(envelope)
      host.mailboxes.set(sessionId, mailbox.slice(-200))
      return ok({ reported: true, id: envelope.id, verified: false })
    },
  }
}

