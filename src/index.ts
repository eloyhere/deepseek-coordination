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
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, resolveConfig, type CoordinationConfig } from './host/config.js'
import { CoordinationService } from './host/coordination.js'
import { resolveDatabasePath } from './host/database.js'
import { createRuntime, installTurnLifecycle } from './host/dsh.js'
import { applyConfigPatch } from './host/selection.js'
import { readOverrides, settingsPath, writeOverrides } from './host/settings-store.js'
import { PROXY_ALLOWED_PROVIDERS, createProxyAdapter, isProxyProviderAllowed } from './host/proxy-adapter.js'
import type { LlmRuntimeLike, ProxyRoute, ProxyTraceEvent } from './host/proxy-adapter.js'
import { brandProfileOf, shouldDecorate } from './host/model-brand.js'
import type { BrandCacheProfile, ModelBrand, ModelIdentity } from './host/model-brand.js'
import type { GenerateOptionsLike } from './shared/service.js'
import { registerCoordinationTools, toolRegistryOf } from './host/tools.js'
import type { TakeoverGateAnswer } from './host/takeover-gate.js'
import { CoordinationError, toErrorJson } from './shared/error.js'
import { normaliseLocale, type Locale } from './shared/i18n.js'
import type { Profession } from './shared/enum.js'
import type { ConfigPatch, ConfigScalar } from './shared/selection.js'
import { writeConfigPath } from './shared/selection.js'

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

/**
 * Nest a flat dotted override map, then merge it over the deployment config.
 *
 * Stored overrides win over the profile patch: the operator changed those paths
 * from the page, which is the most recent intent. `resolveConfig` still applies
 * every invariant afterwards (forced flags, weight normalisation, clamping).
 */
function mergeOverrides(
  input: Partial<CoordinationConfig> | undefined,
  overrides: Readonly<Record<string, ConfigScalar>>,
): Partial<CoordinationConfig> {
  const document: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overrides)) writeConfigPath(document, key, value)
  return deepMergeRecords(input ?? {}, document) as Partial<CoordinationConfig>
}

/** Recursive merge for plain records; arrays and scalars replace. */
function deepMergeRecords(base: unknown, patch: unknown): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    result[key] = key in result ? deepMergeRecords(result[key], value) : value
  }
  return result
}

/** Resolve a Cordis service without tripping the context proxy. */
function serviceOrUndefined(context: Context, name: string): Record<string, unknown> | undefined {
  const getter = (context as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  try {
    const value = getter.call(context, name)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The host webserver, when the profile runs one (a headless profile does not). */
function webServerOf(context: Context): { register: (route: Record<string, unknown>) => () => void } | undefined {
  const service = serviceOrUndefined(context, 'webServer')
  return service !== undefined && typeof service.register === 'function'
    ? (service as unknown as { register: (route: Record<string, unknown>) => () => void })
    : undefined
}

/** The live `ctx.llm` runtime; the proxy adapter needs `stream`, not the port. */
function llmRuntimeOf(context: Context): LlmRuntimeLike | undefined {
  const service = serviceOrUndefined(context, 'llm')
  return service !== undefined && typeof service.stream === 'function'
    ? (service as unknown as LlmRuntimeLike)
    : undefined
}

/** Provider route the cache proxy registers under. */
const PROXY_PROVIDER = 'coordination-proxy'

/**
 * Structural status of the proxy, exposed read-only to the host.
 *
 * Counts and identities only: no prompt, no answer, no tool payload, no
 * credential ever reaches this object. It is the observability half of the
 * proxy's security model — the host can see that it runs, not what it saw.
 */
interface CacheProxyStatus {
  available: boolean
  enabled: boolean
  provider: string
  upstream?: { provider: string; model?: string }
  /** Host-reported model identity mapped onto a built-in cache brand. */
  model?: {
    brand: ModelBrand
    label: string
    automaticPrefixCache: boolean
    explicitCacheBreakpoints: boolean
    minPrefixTokens: number
    effortBreaksCache: boolean
    stripVolatileHelps: boolean
    note: string
  }
  forwards: number
  refusals: number
  lastForwardAt?: string
  /** True when the wiring supplies a content decorator (brand-gated per call). */
  decorate: boolean
}

const proxyStatus: CacheProxyStatus = {
  available: false,
  enabled: false,
  provider: PROXY_PROVIDER,
  forwards: 0,
  refusals: 0,
  decorate: false,
}

/** The status snapshot handed to `GET /proxy/status`. */
export function cacheProxyStatus(): Readonly<CacheProxyStatus> {
  return {
    ...proxyStatus,
    ...(proxyStatus.upstream === undefined ? {} : { upstream: { ...proxyStatus.upstream } }),
  }
}

/** The deployment's default model route, used when no request has named one yet. */
function defaultRouteOf(context: Context): ProxyRoute | undefined {
  const service = serviceOrUndefined(context, 'agentDefaultModel')
  const current = service?.currentSelection
  if (typeof current !== 'function') return undefined
  try {
    const selection = current.call(service)
    const record = typeof selection === 'object' && selection !== null
      ? (selection as Record<string, unknown>)
      : undefined
    const provider = typeof record?.provider === 'string' ? record.provider : ''
    const model = typeof record?.model === 'string' ? record.model : ''
    return provider.length > 0 && model.length > 0 ? { provider, model } : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the experimental cache proxy.
 *
 * `agent/request` rewrites the route to the proxy provider and remembers the
 * real one; the adapter forwards each frozen request to it after rebuilding it.
 * Every step fails open: no llm runtime, no adapter registration or no event bus
 * simply leaves the normal path untouched.
 *
 * Security posture (see `host/proxy-adapter.ts` for the full model):
 *  - only providers on `PROXY_ALLOWED_PROVIDERS` are ever intercepted, so the
 *    proxy cannot redirect traffic to an endpoint this plugin invented;
 *  - the trace file receives structural events only — provider, model, counts,
 *    sizes — never prompt or answer text;
 *  - the adapter holds no transport and no credential: forwarding delegates to
 *    `ctx.llm.stream`, so the real adapter keeps authentication and egress.
 *
 * The switch is a file (`proxy.enable`) as well as an environment variable: the
 * desktop app is launched from the shell's environment, so a file is the only
 * way to turn the experiment on without restarting with new variables.
 */
function installCacheProxy(
  context: Context,
  stateDir: string,
  decorate?: (request: Record<string, unknown>, identity: { provider: string; model: string }) => Record<string, unknown>,
): () => void {
  const flagFile = join(stateDir, 'proxy.enable')
  const logFile = join(stateDir, 'proxy.log')
  if (process.env.DSH_COORDINATION_PROXY !== '1' && !existsSync(flagFile)) return () => {}

  const llm = llmRuntimeOf(context)
  const service = serviceOrUndefined(context, 'llm')
  const register = service?.registerAdapter
  const on = (context as unknown as { on?: unknown }).on
  if (llm === undefined || typeof register !== 'function' || typeof on !== 'function') return () => {}

  /**
   * Append one structural event as a JSON line.
   *
   * JSON (not a formatted sentence) keeps the record unambiguous, and the event
   * type has no field that can carry content — a reviewer can verify the whole
   * leak surface by reading `ProxyTraceEvent`.
   */
  const trace = (event: ProxyTraceEvent): void => {
    if (event.event === 'forward') {
      proxyStatus.forwards += 1
      proxyStatus.lastForwardAt = new Date().toISOString()
    }
    if (event.event === 'refuse') proxyStatus.refusals += 1
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event })
    try {
      appendFileSync(logFile, `${line}\n`, 'utf8')
    } catch {
      // A trace that cannot be written must never break a model call.
    }
    if (process.env.DSH_COORDINATION_PROXY_DEBUG === '1') console.error(`[coordination-proxy] ${line}`)
  }

  // A restarted session may already carry the proxy route in its request
  // header, in which case `agent/request` never names the real one. Seed the
  // upstream from the deployment default so the adapter is never route-less.
  let upstream: ProxyRoute | undefined = defaultRouteOf(context)
  if (upstream !== undefined) {
    proxyStatus.upstream = { ...upstream }
    trace({ event: 'install', provider: PROXY_PROVIDER, model: upstream.model })
  } else {
    trace({ event: 'install', provider: PROXY_PROVIDER })
  }

  /**
   * Classify the host-reported model identity onto a built-in cache brand.
   *
   * `ctx.llm.resolveModelInfo(provider, model)` is the host's own answer for
   * "what model is this": it carries the display name and description that a
   * provider route id alone cannot. The call may hit the adapter, so it is
   * fired and forgotten — routing never waits on catalog I/O, and a failure
   * simply leaves the `unknown` conservative profile in place.
   */
  let describedKey = ''
  const describeModel = (provider: string, model: string): void => {
    const key = `${provider}\u0000${model}`
    if (key === describedKey) return
    describedKey = key
    const llmService = serviceOrUndefined(context, 'llm')
    const resolve = llmService?.resolveModelInfo
    const apply = (identity: ModelIdentity): void => {
      const profile = brandProfileOf(identity)
      proxyStatus.model = {
        brand: profile.brand,
        label: profile.label,
        automaticPrefixCache: profile.automaticPrefixCache,
        explicitCacheBreakpoints: profile.explicitCacheBreakpoints,
        minPrefixTokens: profile.minPrefixTokens,
        effortBreaksCache: profile.effortBreaksCache,
        stripVolatileHelps: profile.stripVolatileHelps,
        note: profile.note,
      }
      trace({ event: 'model', provider, model, brand: profile.brand })
    }
    if (typeof resolve !== 'function') {
      apply({ provider, model })
      return
    }
    try {
      const pending = resolve.call(llmService, provider, model)
      if (pending instanceof Promise) {
        pending.then((info: unknown) => {
          const record = typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : undefined
          apply({
            provider,
            model,
            ...(typeof record?.name === 'string' ? { name: record.name } : {}),
            ...(typeof record?.description === 'string' ? { description: record.description } : {}),
          })
        }).catch(() => { apply({ provider, model }) })
        return
      }
      const record = typeof pending === 'object' && pending !== null ? (pending as Record<string, unknown>) : undefined
      apply({
        provider,
        model,
        ...(typeof record?.name === 'string' ? { name: record.name } : {}),
        ...(typeof record?.description === 'string' ? { description: record.description } : {}),
      })
    } catch {
      apply({ provider, model })
    }
  }
  if (upstream !== undefined) describeModel(upstream.provider, upstream.model ?? '')

  const adapter = createProxyAdapter({
    provider: PROXY_PROVIDER,
    llm,
    routeOf: () => upstream,
    allowProviders: PROXY_ALLOWED_PROVIDERS,
    trace,
    ...(decorate === undefined
      ? {}
      : {
          // The adapter sees only the request; the route came from `upstream`.
          decorate: (request: Readonly<Record<string, unknown>>): Record<string, unknown> =>
            decorate(request as Record<string, unknown>, {
              provider: upstream?.provider ?? '',
              model: upstream?.model ?? '',
            }),
        }),
  })

  let registration: unknown
  let detach: unknown
  try {
    registration = register.call(service, [PROXY_PROVIDER], adapter)
    detach = (on as (...args: unknown[]) => unknown).call(
      context,
      'agent/request',
      async (_payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
        const seed = await next()
        const record = typeof seed === 'object' && seed !== null ? (seed as Record<string, unknown>) : undefined
        const provider = typeof record?.provider === 'string' ? record.provider : ''
        const model = typeof record?.model === 'string' ? record.model : ''
        if (record === undefined || provider.length === 0 || model.length === 0 || provider === PROXY_PROVIDER) {
          // A persisted proxy header carries no upstream; fall back to the
          // deployment default so forwarding still has a route.
          if (upstream === undefined) upstream = defaultRouteOf(context)
          return seed
        }
        // Least privilege: an unrecognised provider is never intercepted. The
        // request keeps the route the harness chose, so a third-party route
        // cannot be pulled into this proxy by accident.
        if (!isProxyProviderAllowed(provider, PROXY_ALLOWED_PROVIDERS)) {
          trace({ event: 'refuse', provider, reason: 'provider-not-allowlisted' })
          return seed
        }
        upstream = { provider, model }
        proxyStatus.upstream = { ...upstream }
        trace({ event: 'route', provider, model })
        describeModel(provider, model)
        return { ...record, provider: PROXY_PROVIDER, model }
      },
      { prepend: true },
    )
  } catch {
    trace({ event: 'refuse', provider: PROXY_PROVIDER, reason: 'registration-failed' })
    return () => {}
  }

  proxyStatus.available = true
  proxyStatus.enabled = true
  proxyStatus.decorate = decorate !== undefined

  return () => {
    proxyStatus.enabled = false
    proxyStatus.decorate = false
    if (typeof detach === 'function') {
      try {
        detach()
      } catch {
        // A disposed listener is harmless during unload.
      }
    }
    if (typeof registration === 'function') {
      try {
        registration()
      } catch {
        // A disposed adapter registration is harmless during unload.
      }
    }
  }
}

export function apply(context: Context, configInput?: Partial<CoordinationConfig>): void {
  // The override document lives beside the coordination database, so the
  // database path decides where the page's durable edits go.
  const configured = resolveConfig(configInput)
  const settingsFile = settingsPath(resolveDatabasePath(configured.databasePath, configured.database))
  const stored = readOverrides(settingsFile)
  const config = Object.keys(stored).length === 0 ? configured : resolveConfig(mergeOverrides(configInput, stored))

  const runtime = createRuntime(context)
  const service = new CoordinationService(context, config, runtime)
  service.turn.recoverInterrupted()

  /*
   * Cache proxy (experiment, off by default): `DSH_COORDINATION_PROXY=1` makes
   * every model call take the `coordination-proxy` provider route so its request
   * can be rebuilt at the adapter boundary — the one place the frozen request is
   * still only an input. See `host/proxy-adapter.ts`.
   *
   * The decorator is brand-gated: only families with an automatic prefix cache
   * get the stable-prefix rewrite. An explicit-breakpoint family keeps its bytes
   * untouched, because markers — not text normalization — decide reuse there.
   */
  if (process.env.DSH_COORDINATION_PROXY === '1' || existsSync(join(dirname(settingsFile), 'proxy.enable'))) {
    const decorate = (
      request: Record<string, unknown>,
      identity: { provider: string; model: string },
    ): Record<string, unknown> => {
      const profile = brandProfileOf(identity)
      // `config` is the live object, so a settings-page toggle applies at once.
      if (!shouldDecorate(profile, config.cache.enabled)) return request
      const strategy = service.provider.cacheStrategy(identity.provider)
      const decorated = service.cache.decorate(
        request as unknown as GenerateOptionsLike,
        strategy,
      ) as unknown as Record<string, unknown>
      // `cacheWarning` is UI advice; a provider adapter must never receive it.
      const { cacheWarning: _advice, ...outgoing } = decorated
      return outgoing
    }
    context.effect(
      () => installCacheProxy(context, dirname(settingsFile), decorate),
      `${name}: cache proxy`,
    )
  }

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
    // The HTTP surface is optional: a headless profile has no webserver, and the
    // coordination host still owns its database, tools and lifecycle there.
    // Reading `ctx.webServer` without `inject` would trip the Cordis proxy, so
    // the service is resolved defensively and its absence just skips the routes.
    const webServer = webServerOf(context)
    if (webServer === undefined) return () => {}
    const dispose = webServer.register({
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

          // Read-only observability for the cache proxy. Counts and route ids
          // only: this endpoint exists so the host can see that the proxy runs
          // and what it forwarded, never what the model was told.
          if (path === '/proxy/status' && method === 'GET') {
            json(response, { ok: true, value: cacheProxyStatus() })
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
            // Durability is this host's own override document: DSH's settings
            // service refuses non-volatile fields and a volatile schema would
            // wrap every config value, so the page persists beside the database.
            const persisted = outcome.applied.length > 0
              ? writeOverrides(settingsFile, appliedPatch as Record<string, ConfigScalar>)
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
