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
import { applyConfigPatch } from './host/selection.js'
import { registerCoordinationTools, toolRegistryOf } from './host/tools.js'
import type { TakeoverGateAnswer } from './host/takeover-gate.js'
import { CoordinationError, toErrorJson } from './shared/error.js'
import { normaliseLocale, type Locale } from './shared/i18n.js'
import type { Profession } from './shared/enum.js'
import type { ConfigPatch } from './shared/selection.js'

export const name = 'deepseek-coordination'

export const inject = ['webServer', 'tools']

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

/** The optional DSH settings port; not every host build exposes one. */
interface SettingsUpdatePort {
  update?: (namespace: string, patch: Record<string, unknown>) => unknown
}

/**
 * Best-effort persistence of an already-applied settings patch.
 *
 * DSH owns persistence; the plugin never writes a second config file. When the
 * host exposes `ctx.settings.update`, the patch is forwarded under the plugin
 * name. A missing port or a refusal leaves the live config (already applied) in
 * force and reports `persisted: false`, so the page can say "applies to this
 * process only" instead of claiming a durable save.
 */
async function persistConfig(context: Context, patch: ConfigPatch): Promise<boolean> {
  const settings = (context as unknown as { settings?: SettingsUpdatePort }).settings
  if (settings === undefined || typeof settings.update !== 'function') return false
  try {
    await settings.update(name, { ...patch })
    return true
  } catch {
    return false
  }
}

export function apply(context: Context, configInput?: Partial<CoordinationConfig>): void {
  const config = resolveConfig(configInput)
  const runtime = createRuntime(context)
  const service = new CoordinationService(context, config, runtime)
  service.turn.recoverInterrupted()

  /** Re-register the tools after `POST /locale` changed the copy language. */
  let refreshTools: ((locale: Locale) => void) | undefined

  context.effect(() => () => { service.dispose() }, `${name}: database`)

  context.effect(() => {
    const timer = setInterval(() => { service.cleanupExpired() }, 60000)
    return () => { clearInterval(timer) }
  }, `${name}: cleanup`)

  context.effect(() => installTurnLifecycle(context, {
    begin: async (observation) => {
      await service.beginTurn(observation.session, observation.turn, observation.prompt ?? '')
    },
    end: async (observation) => {
      service.endTurn(observation.session, 'done')
    },
    fail: (observation) => {
      service.failTurn(observation.session)
    },
  }), `${name}: turn lifecycle`)

  /*
   * Automatic compaction: the governor estimates the step's context, and only
   * when it crosses the configured soft/hard threshold (with a cooldown and a
   * per-session cap) does it ask DSH's `compactIfNeeded`. DSH owns the safe
   * range; a null/throw/timeout is a no-op and the step always proceeds.
   */
  context.effect(() => {
    const on = (context as unknown as {
      on?: (name: string, listener: (...args: never[]) => unknown) => (() => void) | undefined
    }).on
    if (typeof on !== 'function') return () => {}
    const dispose = on.call(context, 'agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
      try {
        const record = asRecord(payload)
        const sessionId = typeof asRecord(record?.agent)?.id === 'string' ? String(asRecord(record?.agent)?.id) : ''
        const messages = Array.isArray(record?.messages)
          ? record.messages.filter((message) => asRecord(message) !== undefined)
          : []
        const signal = record?.signal as AbortSignal | undefined
        if (sessionId.length > 0 && messages.length > 0) {
          await service.maybeCompact(sessionId, messages as ReadonlyArray<{ role: string; content: unknown }>, signal)
        }
      } catch {
        // Compaction is an optimization; it never blocks the agent step.
      }
      return await next()
    })
    return () => { dispose?.() }
  }, `${name}: auto compaction`)

  /*
   * Service-level takeover (v24 §16): the gate intercepts DSH's
   * `approval/request` and `user-questions/request` waterfalls and answers only
   * from a human decision delivered through the Client routes below. Disabled
   * via `ui.takeover` it delegates immediately; unload delegates every open
   * request instead of leaving a host dialog blocked.
   */
  context.effect(() => service.takeoverGate.install(context), `${name}: takeover gate`)

  /*
   * Tool descriptions are part of the model-facing prompt, so they are read at
   * registration time. A locale change therefore disposes the set and registers
   * it again; `ctx.effect` owns the final teardown, and the HTTP route owns the
   * in-place refresh.
   */
  context.effect(() => {
    let dispose: (() => void) | undefined
    const install = (locale: Locale): void => {
      dispose?.()
      dispose = registerCoordinationTools(toolRegistryOf(context), service, locale)
    }
    install(normaliseLocale(service.locale))
    refreshTools = install
    return () => {
      refreshTools = undefined
      dispose?.()
      dispose = undefined
    }
  }, `${name}: tools`)

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

          if (path === '/takeover/pending' && method === 'GET') {
            const session = sessionOf(url)
            if (session.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } }, 400)
              return
            }
            // The Client knows the DSH session id, so the service resolves it to
            // a coordination identity; an unknown session simply has nothing.
            json(response, { ok: true, value: service.listPendingTakeover(session) })
            return
          }

          if (path === '/takeover/answer' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const handle = typeof body?.handle === 'string' ? body.handle.trim() : ''
            const answer = asRecord(body?.answer)
            if (handle.length === 0 || answer === undefined) {
              json(
                response,
                { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'handle and answer are required' } },
                400,
              )
              return
            }
            const answered = service.answerPendingTakeover(handle, answer as TakeoverGateAnswer)
            if (!answered) {
              // The gate keeps an invalid answer's window open, while an
              // answered, cancelled or expired handle has no window left.
              const stillPending = service.takeoverGate.list().some((view) => view.handle === handle)
              if (!stillPending) {
                json(
                  response,
                  { ok: false, error: { code: 'NOT_FOUND', message: `takeover ${handle} is not pending` } },
                  404,
                )
              } else {
                json(
                  response,
                  {
                    ok: false,
                    error: { code: 'INVALID_ARGUMENT', message: 'takeover answer is invalid for the pending window' },
                  },
                  400,
                )
              }
              return
            }
            json(response, { ok: true, value: { answered: true } })
            return
          }

          if (path === '/takeover/cancel' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const handle = typeof body?.handle === 'string' ? body.handle.trim() : ''
            if (handle.length === 0) {
              json(response, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'handle is required' } }, 400)
              return
            }
            json(response, { ok: true, value: { cancelled: service.cancelPendingTakeover(handle) } })
            return
          }

          if (path === '/profession/rebuild' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            const profession = typeof body?.profession === 'string' ? body.profession : ''
            if (session.length === 0 || profession.length === 0) {
              json(
                response,
                { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session and profession are required' } },
                400,
              )
              return
            }
            // The service validates the profession and the active-turn rule;
            // a failed rebuild keeps the old task and the old selection intact.
            json(response, { ok: true, value: service.rebuildProfession(session, profession as Profession) })
            return
          }

          if (path === '/profession/abandon' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const session = sessionOf(url, body)
            if (session.length === 0) {
              json(
                response,
                { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'session is required' } },
                400,
              )
              return
            }
            json(response, { ok: true, value: service.abandonProfession(session) })
            return
          }

          if (path === '/locale' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const locale = typeof body?.locale === 'string' ? body.locale : ''
            const current = service.setLocale(locale)
            // Tool descriptions are baked at registration time (the model-facing
            // prompt is assembled from them), so re-register with the new copy.
            refreshTools?.(normaliseLocale(current))
            json(response, { ok: true, value: { locale: current } })
            return
          }

          if (path === '/config/compaction' && method === 'POST') {
            const body = asRecord(await readJsonBody(request)) ?? {}
            json(response, { ok: true, value: service.applyCompactionPolicy(body) })
            return
          }

          /*
           * Full settings surface (v24 §19):
           *   GET  /config -> ConfigView { values, defaults }
           *   POST /config { patch: { "plan.threshold": 0.6 } }
           *        -> { applied, ignored, normalised, persisted, config }
           * The patch route validates against the config schema, applies to the
           * live service config (the session projection derives from it), then
           * attempts a DSH settings write. Unknown keys and `databasePath` are
           * refused with INVALID_ARGUMENT, never silently ignored.
           */
          if (path === '/config' && method === 'GET') {
            json(response, { ok: true, value: service.selection.configView() })
            return
          }

          if (path === '/config' && method === 'POST') {
            const body = asRecord(await readJsonBody(request))
            const patch = asRecord(body?.patch) ?? body ?? {}
            const outcome = applyConfigPatch(service.config, patch as ConfigPatch)
            // The token governor snapshots the compaction policy at
            // construction; re-apply the triple so a live edit reaches it.
            if (outcome.compaction !== null) service.applyCompactionPolicy(outcome.compaction)
            // Persist only what was actually written: ignored (forced /
            // read-only / planned) paths must never leak into a DSH settings
            // write, even though they were valid request keys.
            const appliedPatch: Record<string, unknown> = {}
            for (const key of outcome.applied) appliedPatch[key] = patch[key]
            const persisted = outcome.applied.length > 0
              ? await persistConfig(context, appliedPatch as ConfigPatch)
              : false
            json(response, {
              ok: true,
              value: {
                applied: outcome.applied,
                ignored: outcome.ignored,
                normalised: outcome.normalised,
                persisted,
                config: service.selection.configView(),
              },
            })
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
