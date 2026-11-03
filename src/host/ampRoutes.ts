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
import { attributeAmpEntries, buildAmpScope, type AmpScopeHost } from './ampScope.js'
import { stateCardOf } from './stateCard.js'
import type { AmpInsightsView, InsightItem } from '../shared/ampInsights.js'

export interface AmpInsightsHost extends AmpScopeHost {
  sessionSkillCatalog?: {
    list(request: { sessionId: string }, signal: AbortSignal): Promise<{ skills: readonly { name: string; description: string; path?: string; modelInvocable: boolean }[] }>
  }
  /**
   * Scoped control, so the four navigation modules are agent-manageable.
   *
   * A record registered under `cognition`, `capabilities`, `skills` or
   * `knowledge` is merged into the matching insight list; `value.enabled ===
   * false` keeps the row visible with status `disabled` instead of hiding it,
   * because "this was switched off" is information the user asked for.
   */
  control?: CoordinationService['control']
}

/** The subset of the service the routes need; keeps the test fixture small. */
export interface AmpRouteService {
  readonly amp: CoordinationService['amp']
  readonly db?: CoordinationService['db']
  readonly planning?: CoordinationService['planning']
  readonly collaboration?: CoordinationService['collaboration']
  /** Present on the composed service: the pre-compaction state-card snapshot. */
  readonly compactionCardOf?: (session: string) => unknown
}

export interface AmpRouteRequest {
  path: string
  method: string
  url: URL
  /** Already resolved by the caller (`?session=`, falling back to empty). */
  session: string
  /** Already resolved workspace identity, for scoped-control reads. */
  workspace?: string
}

export interface AmpRouteResult {
  status: number
  body: unknown
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

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
  host: AmpInsightsHost = {},
): Promise<AmpRouteResult | undefined> {
  const { path, method, url, session } = request
  const amp = service.amp
  const insightsHost = host

  if (path === '/amp/scope' && method === 'GET') {
    const scope = url.searchParams.get('scope') ?? 'global'
    if (scope !== 'global' && scope !== 'default' && scope !== 'workspace') {
      return fail(400, 'INVALID_ARGUMENT', 'scope must be global, default or workspace')
    }
    if (scope === 'workspace' && session.length === 0) return fail(400, 'INVALID_ARGUMENT', 'session is required for workspace scope')
    if (service.db === undefined) return fail(503, 'UNAVAILABLE', 'AMP scope database is unavailable')
    const value = await buildAmpScope({ amp, db: service.db }, host, scope, session, {
      sessions: clamp(url.searchParams.get('sessionLimit'), 20, 0, 50),
      entries: clamp(url.searchParams.get('entryLimit'), 50, 0, 50),
      receipts: clamp(url.searchParams.get('receiptLimit'), 20, 0, 20),
    })
    return { status: 200, body: { ok: true, value } }
  }

  if (path === '/amp/insights' && method === 'GET') {
    if (session.length === 0) return fail(400, 'INVALID_ARGUMENT', 'session is required')
    if (service.db === undefined) return fail(503, 'UNAVAILABLE', 'AMP insights database is unavailable')
    const sessionRow = service.db.get<{ identity: number }>('SELECT identity FROM session WHERE handle = ?', session)

    const limit = clamp(url.searchParams.get('limit'), 50, 1, 100)
    const rows = sessionRow === undefined ? [] : service.db.all<{
      handle: string; stage: string; strategy: string; content: string; created: number; turn: string; ordinal: number
    }>(`SELECT c.handle, c.stage, c.strategy, c.content, c.created, t.handle AS turn, t.ordinal
      FROM cognition c JOIN turn t ON t.identity = c.turn
      WHERE t.session = ? ORDER BY c.created DESC, c.identity DESC LIMIT ?`, sessionRow.identity, limit + 1)
    const cognition = rows.slice(0, limit).map((row): InsightItem => ({
      id: row.handle, title: row.stage, summary: row.content.slice(0, 600), source: 'coordination cognition log',
      scope: 'session', updatedAt: new Date(row.created).toISOString(),
      details: { strategy: row.strategy, turn: row.turn, ordinal: row.ordinal },
    }))

    const manifestRow = amp.store.latestManifest()
    let capabilities: InsightItem[] = []
    let capabilitySourceCount = 0
    let manifestValid = false
    if (manifestRow !== undefined) {
      try {
        const manifest = JSON.parse(manifestRow.body) as { capabilities?: unknown; kind?: unknown }
        if (manifest.kind === 'manifest' && Array.isArray(manifest.capabilities)) {
          manifestValid = true
          capabilitySourceCount = manifest.capabilities.length
          capabilities = manifest.capabilities.slice(0, limit).flatMap((raw): InsightItem[] => {
            if (typeof raw !== 'object' || raw === null) return []
            const item = raw as Record<string, unknown>
            if (typeof item.id !== 'string' || typeof item.label !== 'string') return []
            return [{
              id: item.id, title: item.label, summary: typeof item.kind === 'string' ? item.kind : undefined,
              status: typeof item.tier === 'string' ? item.tier : undefined, source: 'latest stored AMP manifest',
              scope: 'installation', updatedAt: manifestRow.issued,
              details: { confidence: item.confidence, cost: item.cost, limits: item.limits, evidence: item.evidence },
            }]
          })
        }
      } catch { /* corrupted or legacy manifest is explicitly unavailable */ }
    }

    const entries = amp.store.entries({ limit: 20_000 })
    const ledgerWindowTruncated = amp.store.count() > entries.length
    const attributed = attributeAmpEntries(entries, service.db)
    const allKnowledge = entries.flatMap((entry, index): InsightItem[] => {
      if (entry.kind !== 'claim' && entry.kind !== 'unknown') return []
      if (attributed[index]?.size !== 1 || !attributed[index]?.has(session)) return []
      const payload = asRecord(entry.payload)
      if (payload === undefined || typeof payload.id !== 'string') return []
      const title = typeof payload.statement === 'string' ? payload.statement
        : typeof payload.question === 'string' ? payload.question : payload.id
      return [{
        id: payload.id, title: title.slice(0, 240),
        summary: typeof payload.status === 'string' ? payload.status : undefined,
        status: typeof payload.status === 'string' ? payload.status : undefined,
        source: `AMP ${entry.kind}`, scope: 'session',
        ...(typeof payload.created === 'string' ? { updatedAt: payload.created } : {}),
        details: { tier: payload.tier, confidence: payload.confidence, blocking: payload.blocking },
      }]
    }).reverse()
    const knowledge = allKnowledge.slice(0, limit)

    let skills: InsightItem[] = []
    let skillsAvailable = false
    let skillsTruncated = false
    if (insightsHost.sessionSkillCatalog !== undefined) {
      try {
        const catalog = await insightsHost.sessionSkillCatalog.list({ sessionId: session }, new AbortController().signal)
        skillsAvailable = true
        skillsTruncated = catalog.skills.length > limit
        skills = catalog.skills.slice(0, limit).map((skill): InsightItem => ({
          id: skill.name, title: skill.name, summary: skill.description, source: 'session skill catalog',
          scope: 'session', details: { ...(skill.path === undefined ? {} : { path: skill.path }), modelInvocable: skill.modelInvocable },
        }))
      } catch { /* optional service may not be able to inspect this session */ }
    }

    /*
     * Agent-managed entries for the four navigation modules. The control
     * registries are the write surface (`coordination_control`), so projecting
     * them here is what makes "mark / add / enable / disable" visible.
     */
    const managed: Record<'cognition' | 'capabilities' | 'skills' | 'knowledge', InsightItem[]> = {
      cognition: [], capabilities: [], skills: [], knowledge: [],
    }
    if (insightsHost.control !== undefined) {
      const identity = { workspace: request.workspace ?? '', session }
      for (const registry of ['cognition', 'capabilities', 'skills', 'knowledge'] as const) {
        try {
          for (const record of insightsHost.control.listRegistry(registry, 'session', identity)) {
            if (record.deleted === true) continue
            const title = typeof record.value.title === 'string' && record.value.title.length > 0
              ? record.value.title
              : record.id
            managed[registry].push({
              id: record.id,
              title,
              summary: typeof record.value.summary === 'string' ? record.value.summary : undefined,
              status: record.enabled ? 'active' : 'disabled',
              source: `control registry ${registry} (${record.source})`,
              scope: record.source === 'session' ? 'session' : 'workspace',
              updatedAt: new Date(record.updated).toISOString(),
              details: { ...record.value, enabled: record.enabled, version: record.version },
            })
          }
        } catch { /* a missing identity simply yields no managed rows */ }
      }
    }
    // Enabled rows first, then the disabled ones, each group keeping its order.
    const mergeManaged = (base: InsightItem[], extra: InsightItem[]): InsightItem[] =>
      [...extra.filter(item => item.status !== 'disabled'), ...base, ...extra.filter(item => item.status === 'disabled')]
        .slice(0, limit)

    /*
     * `skills` is the one navigation module with a Harness-side catalog. The
     * catalog is a read-only discovery source (its service exposes `list` only),
     * so the writable surface is this plugin's control registry: a registry row
     * with the same id overrides the catalog row, which is how "disable or
     * retitle a discovered skill" stays honest instead of pretending to write
     * back into DSH.
     */
    const managedSkills = managed.skills
    const managedSkillIds = new Set(managedSkills.map((item) => item.id))
    const catalogOnly = skills
      .filter((item) => !managedSkillIds.has(item.id))
      .map((item): InsightItem => ({
        ...item,
        status: 'read-only',
        details: { ...item.details, writable: false },
      }))
    const skillsWithOverrides: InsightItem[] = [
      ...managedSkills.map((item): InsightItem => ({
        ...item,
        details: { ...item.details, writable: true },
      })),
      ...catalogOnly,
    ].slice(0, limit)

    const scopeView = await buildAmpScope({ amp, db: service.db }, host, 'workspace', session, { sessions: 0, entries: 0, receipts: 0 })
    const value: AmpInsightsView = {
      session, workspace: scopeView.workspace,
      cognition: mergeManaged(cognition, managed.cognition),
      capabilities: mergeManaged(capabilities, managed.capabilities),
      skills: skillsWithOverrides,
      knowledge: mergeManaged(knowledge, managed.knowledge),
      sources: {
        cognition: { available: true, description: 'Persisted cognition decisions for this session, plus agent-managed cognition entries.' },
        capabilities: { available: manifestValid || managed.capabilities.length > 0, description: manifestValid ? 'Installation-wide capability declarations from the latest stored AMP manifest, plus agent-managed capabilities.' : 'No readable stored AMP manifest is available; agent-managed capabilities are listed when present.' },
        skills: { available: skillsAvailable || managed.skills.length > 0, description: 'Session skill catalog (read-only discovery) merged with the writable control registry: a registry row with the same id overrides the catalog row and can be enabled or disabled.' },
        knowledge: { available: true, description: 'AMP claims and unknowns attributed unambiguously to this session, plus agent-managed knowledge entries.' },
      },
      truncated: { cognition: rows.length > limit, capabilities: capabilitySourceCount > limit, skills: skillsTruncated || skillsWithOverrides.length < managedSkills.length + catalogOnly.length, knowledge: allKnowledge.length > limit || ledgerWindowTruncated },
      limit,
    }
    return { status: 200, body: { ok: true, value } }
  }

  if (path === '/amp/state-card' && method === 'GET') {
    if (session.length === 0) return fail(400, 'INVALID_ARGUMENT', 'session is required')
    // Rebuilt from durable AMP rows, so it is also what survives a compaction
    // of the chat history. `?compaction=1` returns the last pre-compaction
    // snapshot next to the live card, which makes the boundary auditable.
    const current = stateCardOf(service, session) ?? null
    if (url.searchParams.get('compaction') === '1') {
      return { status: 200, body: { ok: true, value: { current, compaction: service.compactionCardOf?.(session) ?? null } } }
    }
    return { status: 200, body: { ok: true, value: current } }
  }

  if (path === '/amp/collaboration' && method === 'GET') {
    if (session.length === 0) return fail(400, 'INVALID_ARGUMENT', 'session is required')
    if (service.collaboration === undefined) return fail(503, 'UNAVAILABLE', 'AMP collaboration is unavailable')
    try {
      return { status: 200, body: { ok: true, value: { duties: service.collaboration.view(session) } } }
    } catch (error) {
      return fail(404, 'NOT_FOUND', error instanceof Error ? error.message : String(error))
    }
  }

  if (['/amp/planning', '/amp/missions', '/amp/goals', '/amp/plans'].includes(path) && method === 'GET') {
    if (session.length === 0) return fail(400, 'INVALID_ARGUMENT', 'session is required')
    if (service.planning === undefined) return fail(503, 'UNAVAILABLE', 'AMP planning is unavailable')
    try {
      if (path === '/amp/planning') {
        // The panel needs both the AMP records and how they stand against the
        // Harness's own lifecycle, so the two are returned together instead of
        // letting the UI guess a phase from the local rows alone.
        return {
          status: 200,
          body: {
            ok: true,
            value: {
              ...service.planning.view(session),
              harness: service.planning.syncStatus(session),
            },
          },
        }
      }
      const value = path === '/amp/missions' ? service.planning.missions(session)
        : path === '/amp/goals' ? service.planning.goals(session)
        : service.planning.plans(session)
      return { status: 200, body: { ok: true, value } }
    } catch (error) {
      return fail(404, 'NOT_FOUND', error instanceof Error ? error.message : String(error))
    }
  }

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

