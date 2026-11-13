/** HTTP surface for the AMP panel, notification poll and dialog answers. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { AmpHost } from './amp.js'
import type { NotificationCenter } from './notify.js'
import type { DialogGate } from './dialogGate.js'
import { asRecord, jsonSafe } from './json.js'
import { listRegistryModels, registryProviderCounts, registryProviders, registryStats } from './registry.js'

export const ROUTE_PREFIX = '/deepseek-coordination'

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function ok(response: ServerResponse, value: unknown): void {
  json(response, { ok: true, value })
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  json(response, { ok: false, error: { code, message } }, status)
}

function urlOf(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://localhost')
}

/** Explicit workspace root from `?root=`, or the root of `?session=`. */
function rootOf(url: URL, host: AmpHost): string | undefined {
  const session = url.searchParams.get('session')
  if (session !== null && session.trim().length > 0) {
    const resolved = host.rootOfSession(session.trim())
    if (resolved !== undefined) return resolved
  }
  const root = url.searchParams.get('root')
  return root !== null && root.trim().length > 0 ? root.trim() : undefined
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const part = chunk as Buffer
    total += part.length
    if (total > 64 * 1024) return null
    chunks.push(part)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return null
  }
}

export interface RouteDependencies {
  readonly host: AmpHost
  readonly notifications: NotificationCenter
  readonly dialogs: DialogGate
  readonly version: string
  /** The composed web client graph, when this host has a client module registry. */
  readonly clientGraph?: () => unknown
  /** DSH→AMP projection counters and recent errors. */
  readonly sync?: () => unknown
  /** AMP attention→DSH context compiler counters. */
  readonly context?: () => unknown
  /** Called with the active client language so the registered catalog can follow it. */
  readonly onLocale?: (value: unknown) => void
  /** Current catalog language, when the composition exposes it. */
  readonly locale?: () => string
}

/** Register every plugin route; the returned disposer removes them together. */
export function registerRoutes(webServer: WebServer, dependencies: RouteDependencies): () => void {
  const disposers: Array<() => void> = []
  let clientReport: unknown = null
  // `/amp/context` aggregates journal, benefit history and optimizer state. A
  // conversation mount and the 5 s poll can ask for it several times in one
  // second, so share one short-lived snapshot instead of recompiling it each
  // time. Mutations go through their own routes and do not need this cache;
  // a two-second staleness bound is invisible to the panel.
  let contextCache: { at: number; value: unknown } | undefined
  const route = (path: string, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): void => {
    try {
      disposers.push(webServer.register({ kind: 'exact', path, handler }))
    } catch (error) {
      // A reload can leave a route owned by an earlier, aborted registration.
      // Keep registering the remaining routes, but record the collision: a
      // stale owner keeps answering with its old handler (and its old version),
      // so this must be diagnosable instead of silently swallowed.
      dependencies.host.recordRouteFailure?.(path, error)
    }
  }

  route(`${ROUTE_PREFIX}/ping`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    ok(response, { name: 'deepseek-coordination', version: dependencies.version, protocol: 'attention-manifest-protocol', amp: '0.9.1' })
  })

  route(`${ROUTE_PREFIX}/amp/status`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    const url = urlOf(request)
    const root = url.searchParams.get('root')?.trim()
    const session = url.searchParams.get('session')?.trim()
    const lists = url.searchParams.get('lists') === '1'
    try {
      ok(response, dependencies.host.snapshot(
        root === undefined || root.length === 0 ? undefined : root,
        session === undefined || session.length === 0 ? undefined : session,
        lists,
      ))
    } catch (error) {
      fail(response, 500, 'SNAPSHOT_FAILED', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
    }
  })

  route(`${ROUTE_PREFIX}/amp/modules`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    const url = urlOf(request)
    const query = (url.searchParams.get('q') ?? '').toLowerCase()
    const tier = url.searchParams.get('tier')
    try {
      const modules = dependencies.host.modules
        .filter((module) => tier === null || module.tier === tier)
        .filter((module) => query.length === 0 || `${module.module} ${module.summary}`.toLowerCase().includes(query))
        .map((module) => ({
          ...module,
          registration: module.tier === 'agent' ? 'tool' : module.tier === 'host' ? 'service' : 'internal',
          // Every exposed agent module is registered by this plugin; avoid a
          // live tool lookup here because a lookup failure must not blank the
          // entire module catalog (the settings page renders this route).
          registered: module.tier !== 'hidden',
        }))
      ok(response, { count: modules.length, modules: jsonSafe(modules) })
    } catch (error) {
      fail(response, 500, 'MODULES_FAILED', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
    }
  })

  route(`${ROUTE_PREFIX}/amp/kernel`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    try {
      const root = rootOf(urlOf(request), dependencies.host)
      ok(response, jsonSafe(dependencies.host.kernel(root).snapshot()))
    } catch (error) {
      fail(response, 500, 'DATABASE', error instanceof Error ? error.message : String(error))
    }
  })

  route(`${ROUTE_PREFIX}/amp/journal`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    const url = urlOf(request)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50') || 50, 1), 500)
    const session = url.searchParams.get('session')?.trim()
    const root = url.searchParams.get('root')?.trim()
    const entries = dependencies.host.journalEntries(
      session === undefined || session.length === 0 ? undefined : session,
      root === undefined || root.length === 0 ? undefined : root,
    )
    ok(response, { entries: jsonSafe(entries.slice(-limit)) })
  })

  route(`${ROUTE_PREFIX}/amp/preferences`, async (request, response) => {
    const preferences = dependencies.host.preferencesFor(rootOf(urlOf(request), dependencies.host))
    if (request.method === 'GET') return ok(response, preferences.get())
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET, PUT or POST only')
    }
    const body = await readJsonBody(request)
    if (body === null) return fail(response, 400, 'INVALID_ARGUMENT', 'body must be a JSON object')
    try {
      const updated = preferences.update(body)
      dependencies.dialogs.checkPreferences()
      ok(response, updated)
    } catch (error) {
      fail(response, 400, 'INVALID_ARGUMENT', error instanceof Error ? error.message : String(error))
    }
  })

  route(`${ROUTE_PREFIX}/amp/context`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    const now = Date.now()
    if (contextCache === undefined || now - contextCache.at > 2_000) {
      contextCache = {
        at: now,
        value: dependencies.context === undefined ? { enabled: false } : dependencies.context(),
      }
    }
    ok(response, contextCache.value)
  })

  // Read-only price registry: 41 DSH routes plus OpenRouter's live catalog.
  // This is a static snapshot generated at build time; no network call happens
  // while serving it.
  route(`${ROUTE_PREFIX}/amp/models`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    const url = urlOf(request)
    const provider = url.searchParams.get('provider')?.trim()
    const query = url.searchParams.get('q')?.trim()
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '100') || 100, 1), 200)
    ok(response, {
      stats: registryStats(),
      providers: registryProviderCounts(),
      providerNames: registryProviders(),
      entries: listRegistryModels({
        ...(provider === undefined || provider.length === 0 ? {} : { provider }),
        ...(query === undefined || query.length === 0 ? {} : { query }),
        limit,
      }),
    })
  })

  route(`${ROUTE_PREFIX}/amp/sync`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    ok(response, dependencies.sync === undefined ? { counters: null } : dependencies.sync())
  })

  route(`${ROUTE_PREFIX}/amp/client`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    if (dependencies.clientGraph === undefined) {
      return fail(response, 404, 'NOT_FOUND', 'this host has no web client module registry')
    }
    try {
      const graph = dependencies.clientGraph() as
        | { entries?: readonly { id: string; url: string; rev: string; inject?: readonly string[] }[] }
        | undefined
      const entry = graph?.entries?.find((item) => item.id === 'deepseek-coordination')
      ok(response, { entry: entry ?? null, entries: graph?.entries?.length ?? 0 })
    } catch (error) {
      fail(response, 500, 'INTERNAL', error instanceof Error ? error.message : String(error))
    }
  })

  route(`${ROUTE_PREFIX}/amp/locale`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    ok(response, { locale: dependencies.locale?.() ?? null })
  })

  route(`${ROUTE_PREFIX}/amp/client-report`, async (request, response) => {
    if (request.method === 'GET') {
      return ok(response, { report: clientReport, errors: dependencies.host.clientErrors.slice(-20) })
    }
    if (request.method !== 'POST') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET or POST only')
    const body = await readJsonBody(request)
    if (body === null) return fail(response, 400, 'INVALID_ARGUMENT', 'body must be a JSON object')
    const report = (typeof body === 'object' && !Array.isArray(body) ? body : { value: body }) as Record<string, unknown>
    clientReport = { ...report, receivedAt: new Date().toISOString() }
    const text = (key: string): string => typeof report[key] === 'string' ? (report[key] as string).slice(0, 8_000) : ''
    if (text('message').length > 0 || text('stack').length > 0) {
      dependencies.host.clientErrors.push({
        at: new Date().toISOString(),
        surface: text('surface') || 'unknown',
        message: text('message'),
        stack: text('stack'),
        componentStack: text('componentStack'),
      })
      if (dependencies.host.clientErrors.length > 50) {
        dependencies.host.clientErrors.splice(0, dependencies.host.clientErrors.length - 50)
      }
    }
    if (report.locale !== undefined) dependencies.onLocale?.(report.locale)
    ok(response, { accepted: true })
  })

  route(`${ROUTE_PREFIX}/dialogs/pending`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    const session = urlOf(request).searchParams.get('session')?.trim()
    if (!session) return fail(response, 400, 'INVALID_ARGUMENT', 'session is required')
    ok(response, { items: dependencies.dialogs.list(session) })
  })

  for (const action of ['answer', 'cancel'] as const) {
    route(`${ROUTE_PREFIX}/dialogs/${action}`, async (request, response) => {
      if (request.method !== 'POST') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'POST only')
      const body = asRecord(await readJsonBody(request))
      if (body === undefined || typeof body.session !== 'string' || !body.session.trim() || typeof body.id !== 'string' || !body.id.trim()) {
        return fail(response, 400, 'INVALID_ARGUMENT', 'session and id are required')
      }
      try {
        const accepted = action === 'answer'
          ? dependencies.dialogs.answer(body.session.trim(), body.id, body)
          : dependencies.dialogs.cancel(body.session.trim(), body.id)
        if (!accepted) return fail(response, 404, 'NOT_FOUND', 'pending dialog was not found for this session')
        ok(response, { accepted: true })
      } catch (error) {
        fail(response, 400, 'INVALID_ARGUMENT', error instanceof Error ? error.message : String(error))
      }
    })
  }

  route(`${ROUTE_PREFIX}/notify/pending`, (request, response) => {
    if (request.method !== 'GET') return fail(response, 405, 'METHOD_NOT_ALLOWED', 'GET only')
    const session = urlOf(request).searchParams.get('session')
    if (session === null || session.trim().length === 0) {
      return fail(response, 400, 'INVALID_ARGUMENT', 'session is required')
    }
    try {
      ok(response, { items: jsonSafe(dependencies.notifications.drain(session)) })
    } catch (error) {
      fail(response, 400, 'INVALID_ARGUMENT', error instanceof Error ? error.message : String(error))
    }
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Releasing the remaining routes matters more than one bad disposer:
        // a single throwing route must not keep every later one registered.
      }
    }
  }
}
