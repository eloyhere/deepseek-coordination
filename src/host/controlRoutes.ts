/**
 * `/control/*` and `/graph/knowledge` routes.
 *
 * Kept beside `ampRoutes.ts` and for the same reason: the routes must be
 * testable without a Cordis context, a webserver or a live harness. The caller
 * resolves the workspace and session identity once per request; this module
 * never reads a file, never opens the database directly and never guesses an
 * identity.
 *
 * Surface:
 *
 *   GET  /control/registry?scope=&registry=      effective registry listing
 *   POST /control/registry                       one registry action
 *   GET  /control/settings?scope=&domain=        effective setting
 *   POST /control/settings                       get/set/reset a setting
 *   GET  /graph/knowledge                        knowledge files + indexed flag
 *   POST /graph/knowledge                        mark / update / unmark a file
 *
 * Every mutating call goes through the same service methods the agent tools
 * call, so the panel and the model cannot diverge.
 */
import type { ControlService } from "./control.js";
import type { KnowledgeService } from "./knowledge.js";
import type {
  ControlApplyTo,
  ControlDomain,
  ControlRegistry,
  ControlRegistryAction,
  ControlScope,
  ControlSettingAction,
} from "../shared/control.js";
import { CONTROL_REGISTRIES } from "../shared/control.js";

export interface ControlRouteService {
  readonly control: ControlService;
  readonly knowledge: KnowledgeService;
}

export interface ControlRouteRequest {
  path: string;
  method: string;
  url: URL;
  /** Session identity, already resolved by the caller (may be empty). */
  session: string;
  /** Workspace identity, already resolved by the caller (may be empty). */
  workspace: string;
  /** Already-parsed JSON body for POST routes. */
  body?: unknown;
  /** Optional membership check that adds `indexed` to knowledge rows. */
  isIndexed?: (path: string) => boolean;
}

export interface ControlRouteResult {
  status: number
  body: unknown
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const fail = (status: number, code: string, message: string): ControlRouteResult => ({
  status,
  body: { ok: false, error: { code, message } },
})

/** Read a required query parameter from a fixed vocabulary. */
function queryValue<T extends string>(
  url: URL,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T | ControlRouteResult {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.length === 0) return fallback
  if (!(allowed as readonly string[]).includes(raw)) {
    return fail(400, 'INVALID_ARGUMENT', `${name} must be one of ${allowed.join(', ')}`)
  }
  return raw as T
}

function isFailure(value: unknown): value is ControlRouteResult {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value
}

/**
 * Answer one control/knowledge route, or `undefined` when the path is not one.
 *
 * A returned `undefined` keeps the caller's single 404 envelope for unknown
 * paths; this function never writes a response itself.
 */
export function handleControlRoute(
  request: ControlRouteRequest,
  service: ControlRouteService,
): ControlRouteResult | undefined {
  const { path, method, url, session, workspace } = request;
  const identity = { workspace, session };

  if (path === '/control/registry' && method === 'GET') {
    const scope = queryValue(url, 'scope', ['global', 'workspace', 'session'] as const, workspace.length > 0 ? 'workspace' : 'global')
    if (isFailure(scope)) return scope
    const registry = queryValue(url, 'registry', [
      'modules', 'environments', 'tools', 'cognition', 'capabilities', 'abilities',
      'progress', 'skills', 'knowledge', 'protocols', 'concepts',
    ] as const, 'modules')
    if (isFailure(registry)) return registry
    try {
      return {
        status: 200,
        body: {
          ok: true,
          value: {
            scope,
            registry,
            records: service.control.listRegistry(registry, scope, identity),
          },
        },
      }
    } catch (error) {
      return routeError(error)
    }
  }

  if (path === '/control/registry' && method === 'POST') {
    const body = asRecord(request.body)
    if (body === undefined) return fail(400, 'INVALID_ARGUMENT', 'body must be a JSON object')
    const scope = body.scope
    const registry = body.registry
    const action = body.action
    if (!isScope(scope) || !isRegistry(registry) || !isAction(action)) {
      return fail(400, 'INVALID_ARGUMENT', 'scope, registry and action are required and must be known values')
    }
    try {
      const value = service.control.registry(
        {
          scope,
          registry,
          action,
          ...(typeof body.id === 'string' ? { id: body.id } : {}),
          ...(typeof body.key === 'string' ? { key: body.key } : {}),
          ...(body.value === undefined ? {} : { value: body.value }),
          ...(typeof body.targetId === 'string' ? { targetId: body.targetId } : {}),
          ...(typeof body.relation === 'string' ? { relation: body.relation } : {}),
          ...(typeof body.expectedVersion === 'number' ? { expectedVersion: body.expectedVersion } : {}),
          dryRun: body.dryRun === true,
        },
        identity,
      )
      return { status: 200, body: { ok: true, value } }
    } catch (error) {
      return routeError(error)
    }
  }

  if (path === '/control/settings' && method === 'GET') {
    const scope = queryValue(url, 'scope', ['global', 'workspace', 'session'] as const, workspace.length > 0 ? 'workspace' : 'global')
    if (isFailure(scope)) return scope
    const domain = queryValue(url, 'domain', ['interaction', 'scenario'] as const, 'interaction')
    if (isFailure(domain)) return domain
    try {
      return {
        status: 200,
        body: { ok: true, value: service.control.getSetting(domain, scope, identity) },
      }
    } catch (error) {
      return routeError(error)
    }
  }

  if (path === '/control/settings' && method === 'POST') {
    const body = asRecord(request.body)
    if (body === undefined) return fail(400, 'INVALID_ARGUMENT', 'body must be a JSON object')
    if (!isScope(body.scope) || !isDomain(body.domain)) {
      return fail(400, 'INVALID_ARGUMENT', 'scope and domain are required and must be known values')
    }
    const action = body.action
    try {
      if (action === 'get') {
        return {
          status: 200,
          body: { ok: true, value: service.control.getSetting(body.domain, body.scope, identity) },
        }
      }
      if (action !== 'set' && action !== 'reset') {
        return fail(400, 'INVALID_ARGUMENT', 'action must be get, set or reset')
      }
      const applyTo: ControlApplyTo | undefined =
        body.applyTo === 'defaults' || body.applyTo === 'existing' || body.applyTo === 'all'
          ? body.applyTo
          : undefined
      const common = {
        scope: body.scope,
        domain: body.domain,
        ...(applyTo === undefined ? {} : { applyTo }),
        ...(typeof body.expectedVersion === 'number' ? { expectedVersion: body.expectedVersion } : {}),
        dryRun: body.dryRun === true,
      }
      const value = action === 'set'
        ? service.control.setSetting({
          ...common,
          action: 'set',
          ...(typeof body.selector === 'string' ? { selector: body.selector } : {}),
          ...(body.mix === undefined ? {} : { mix: body.mix }),
        }, identity)
        : service.control.resetSetting({ ...common, action: 'reset' }, identity)
      return { status: 200, body: { ok: true, value } }
    } catch (error) {
      return routeError(error)
    }
  }

  if (path === '/graph/knowledge' && method === 'GET') {
    try {
      const entries = service.knowledge.list(identity)
      return {
        status: 200,
        body: {
          ok: true,
          value: {
            workspace,
            entries: entries.map((entry) => ({
              ...entry,
              ...(request.isIndexed === undefined ? {} : { indexed: request.isIndexed(entry.path) }),
            })),
          },
        },
      }
    } catch (error) {
      return routeError(error)
    }
  }

  if (path === '/graph/knowledge' && method === 'POST') {
    const body = asRecord(request.body)
    if (body === undefined) return fail(400, 'INVALID_ARGUMENT', 'body must be a JSON object')
    if (typeof body.path !== 'string' || body.path.trim().length === 0) {
      return fail(400, 'INVALID_ARGUMENT', 'path is required')
    }
    const scope = body.scope === 'session' ? 'session' as const : 'workspace' as const
    try {
      if (body.action === 'unmark') {
        return { status: 200, body: { ok: true, value: service.knowledge.unmark(body.path, identity, scope) } }
      }
      if (body.action !== undefined && body.action !== 'mark' && body.action !== 'update') {
        return fail(400, 'INVALID_ARGUMENT', 'action must be mark, update or unmark')
      }
      return {
        status: 200,
        body: {
          ok: true,
          value: service.knowledge.mark(
            body.path,
            {
              ...(body.title === undefined ? {} : { title: body.title }),
              ...(body.note === undefined ? {} : { note: body.note }),
              ...(body.tags === undefined ? {} : { tags: body.tags }),
            },
            identity,
            scope,
          ),
        },
      }
    } catch (error) {
      return routeError(error)
    }
  }

  return undefined
}

/** Map one typed domain error onto the shared envelope. */
function routeError(error: unknown): ControlRouteResult {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : 'control call failed'
  if (code === 'INVALID_ARGUMENT') return fail(400, 'INVALID_ARGUMENT', message)
  if (code === 'NOT_FOUND') return fail(404, 'NOT_FOUND', message)
  if (code === 'INVALID_STATE') return fail(409, 'INVALID_STATE', message)
  return fail(500, 'INTERNAL', message)
}

function isScope(value: unknown): value is ControlScope {
  return value === 'global' || value === 'workspace' || value === 'session'
}

function isRegistry(value: unknown): value is ControlRegistry {
  return typeof value === 'string' && (CONTROL_REGISTRIES as readonly string[]).includes(value)
}

function isAction(value: unknown): value is ControlRegistryAction {
  return typeof value === 'string' && [
    'list', 'get', 'register', 'update', 'remove', 'enable', 'disable',
    'default_get', 'default_set', 'default_reset', 'link', 'unlink',
  ].includes(value)
}

function isDomain(value: unknown): value is ControlDomain {
  return value === 'interaction' || value === 'scenario'
}

/** Re-exported for the route tests, which pin the accepted vocabularies. */
export const CONTROL_ROUTE_ACTIONS: readonly ControlSettingAction[] = ['get', 'set', 'reset']
