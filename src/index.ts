/**
 * deepseek-coordination — Host half (Cordis plugin running in the Node process)
 *
 * Composition root: one coordination database, one service, one HTTP surface,
 * one agent-turn lifecycle. The client half (src/client) reads and writes the
 * five composer dropdowns through `/deepseek-coordination/selection`.
 *
 * Contract notes:
 *  - Hard dependencies go in `inject`; apply() runs only once they are ready.
 *  - Everything registered through ctx is disposed on unload — the route
 *    disposer is returned from ctx.effect().
 *  - The route prefix is absolute with no trailing slash; kind 'prefix' matches
 *    every sub-path beneath it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, resolveConfig, type CoordinationConfig } from './host/config.js'
import { CoordinationService } from './host/coordination.js'
import { createRuntime, installTurnLifecycle } from './host/dsh.js'
import { CoordinationError, toErrorJson } from './shared/error.js'

export const name = 'deepseek-coordination'

export const inject = ['webServer']

export { Config }

/** Route prefix owned by this plugin. Mirrors src/client/bridge.ts. */
const ROUTE_PREFIX = '/deepseek-coordination'

/** Unified JSON response envelope: { ok: true, value } | { ok: false, error }. */
function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/** Read a POST JSON body, with a size cap that guards against oversized payloads. */
const BODY_CAP_BYTES = 1 << 20

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const part = chunk as Buffer
    total += part.length
    if (total > BODY_CAP_BYTES) {
      request.destroy()
      return null
    }
    chunks.push(part)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function statusOf(error: unknown): number {
  if (!(error instanceof CoordinationError)) return 500
  switch (error.code) {
    case 'PROFESSION_LOCKED':
    case 'PROFESSION_REQUIRED':
      return 409
    case 'INVALID_ARGUMENT':
    case 'INVALID_STATE':
      return 400
    case 'NOT_FOUND':
      return 404
    case 'NOT_IMPLEMENTED':
      return 501
    case 'PERMISSION':
      return 403
    default:
      return 500
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function sessionOf(url: URL, body?: Record<string, unknown>): string {
  const fromQuery = url.searchParams.get('session')
  const fromBody = typeof body?.session === 'string' ? body.session : undefined
  return (fromQuery ?? fromBody ?? '').trim()
}

export function apply(context: Context, configInput?: Partial<CoordinationConfig>): void {
  const config = resolveConfig(configInput)
  const runtime = createRuntime(context)
  const service = new CoordinationService(context, config, runtime)
  service.turn.recoverInterrupted()

  context.effect(() => () => { service.dispose() }, `${name}: database`)

  context.effect(() => {
    const timer = setInterval(() => { service.cleanupExpired() }, 60000)
    return () => { clearInterval(timer) }
  }, `${name}: cleanup`)

  context.effect(() => installTurnLifecycle(context, {
    begin: async (observation) => {
      await service.beginTurn(observation.session, observation.turn)
    },
    end: async (observation) => {
      service.endTurn(observation.session, 'done')
    },
    fail: (observation) => {
      service.failTurn(observation.session)
    },
  }), `${name}: turn lifecycle`)

  context.effect(() => {
    const dispose = context.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const url = new URL(request.url ?? '/', 'http://coordination.local')
        const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
        const method = request.method ?? 'GET'

        try {
          if (path === '/ping') {
            json(response, { ok: true, value: { plugin: name, pong: true, locale: service.locale } })
            return
          }

          if (path === '/echo' && method === 'POST') {
            json(response, { ok: true, value: await readJsonBody(request) })
            return
          }

          if (path === '/selection' && method === 'GET') {
            const session = sessionOf(url)
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            json(response, { ok: true, value: service.state(session) })
            return
          }

          if (path === '/selection' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            const patch = asRecord(body?.patch) ?? {}
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            json(response, { ok: true, value: service.setSelection(session, patch as never) })
            return
          }

          if (path === '/presets' && method === 'GET') {
            json(response, { ok: true, value: service.presets() })
            return
          }

          if (path === '/permission' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            const preset = typeof body?.preset === 'string' ? body.preset : ''
            if (session.length === 0 || preset.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session and preset are required' } }, 400)
              return
            }
            json(response, { ok: true, value: { preset: service.setPermission(session, preset) } })
            return
          }

          if (path === '/locale' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const locale = typeof body?.locale === 'string' ? body.locale : ''
            json(response, { ok: true, value: { locale: service.setLocale(locale) } })
            return
          }

          if (path === '/state' && method === 'GET') {
            const session = sessionOf(url)
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            json(response, {
              ok: true,
              value: {
                selection: service.state(session),
                metrics: service.metrics(),
              },
            })
            return
          }

          json(response, { ok: false, error: { code: 'NOT_FOUND', message: `${method} ${path} is not a coordination route` } }, 404)
        } catch (error) {
          json(response, { ok: false, error: toErrorJson(error) }, statusOf(error))
        }
      },
    })
    return () => { dispose() }
  }, `${name}: ${ROUTE_PREFIX} routes`)
}
