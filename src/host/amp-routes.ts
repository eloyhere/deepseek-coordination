/**
 * The `/amp/*` route table.
 *
 * Kept out of `src/index.ts` for one reason: the routes must be testable without
 * a Cordis context, a webserver or a live harness. `handleAmpRoute` is a pure
 * function of `(path, method, url, service)` and returns the body and status the
 * caller should write; the composition root only forwards them.
 *
 * Every value is the protocol artifact itself. The route never reshapes an
 * object whose canonical form is signed or digested, because a reshaped copy
 * would no longer verify against the digest the caller reads.
 */
import type { CoordinationService } from './coordination.js'

/** The subset of the service the routes need; keeps the test fixture small. */
export interface AmpRouteService {
  readonly amp: CoordinationService['amp']
}

export interface AmpRouteRequest {
  path: string
  method: string
  url: URL
  /** Already resolved by the caller (`?session=`, falling back to empty). */
  session: string
}

export interface AmpRouteResult {
  status: number
  body: unknown
}

const fail = (status: number, code: string, message: string): AmpRouteResult => ({
  status,
  body: { ok: false, error: { code, message } },
})

const clamp = (raw: string | null, fallback: number, min: number, max: number): number => {
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Answers one AMP route, or `undefined` when `path` is not an AMP route.
 *
 * A returned `undefined` is what lets the caller keep its single 404 envelope
 * for every unknown path; this function never writes a response itself.
 */
export async function handleAmpRoute(
  request: AmpRouteRequest,
  service: AmpRouteService,
): Promise<AmpRouteResult | undefined> {
  const { path, method, url, session } = request
  const amp = service.amp

  if (path === '/amp/identity' && method === 'GET') {
    return { status: 200, body: { ok: true, value: await amp.identity() } }
  }

  if (path === '/amp/manifest' && method === 'GET') {
    return { status: 200, body: { ok: true, value: await amp.manifest() } }
  }

  if (path === '/amp/frame' && method === 'GET') {
    if (session.length === 0) {
      return fail(400, 'INVALID_ARGUMENT', 'session is required')
    }
    const frame = await amp.latestFrameFor(session)
    if (frame === undefined) {
      return fail(404, 'NOT_FOUND', `no AMP frame for session ${session}`)
    }
    return { status: 200, body: { ok: true, value: frame } }
  }

  if (path === '/amp/story' && method === 'GET') {
    if (session.length === 0) {
      return fail(400, 'INVALID_ARGUMENT', 'session is required')
    }
    return { status: 200, body: { ok: true, value: await amp.storyFor(session) } }
  }
  if (path === '/amp/receipts' && method === 'GET') {
    const limit = clamp(url.searchParams.get('limit'), 50, 0, 500)
    return { status: 200, body: { ok: true, value: amp.receipts(limit) } }
  }

  if (path === '/amp/ledger' && method === 'GET') {
    const snapshot = amp.store.snapshot(amp.agentId)
    const full = url.searchParams.get('full') === '1'
    const limit = full ? 20_000 : clamp(url.searchParams.get('limit'), 100, 0, 2_000)
    return {
      status: 200,
      body: {
        ok: true,
        value: {
          amp: snapshot.amp,
          kind: snapshot.kind,
          agent: snapshot.agent,
          tip: snapshot.tip,
          count: snapshot.count,
          entries: limit > 0 ? snapshot.entries.slice(-limit) : [],
        },
      },
    }
  }

  if (path === '/amp/verify' && method === 'GET') {
    return { status: 200, body: { ok: true, value: await amp.verify() } }
  }

  if (path === '/amp/checkpoint' && method === 'POST') {
    return { status: 200, body: { ok: true, value: await amp.checkpoint() } }
  }

  if (path.startsWith('/amp/')) {
    return fail(404, 'NOT_FOUND', `${method} ${path} is not an AMP route`)
  }

  return undefined
}

