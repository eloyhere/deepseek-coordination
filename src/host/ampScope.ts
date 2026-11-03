/** Read-only AMP view. No identity/signing methods or workspace mutations. */
import type { ChainEntry, Frame, Receipt } from '../protocol/index.js'
import type { AmpScope, AmpScopeView } from '../shared/ampScope.js'
import { frameIdOf, goalIdOf, planIdOf, receiptIdOf, type AmpService } from './amp.js'
import type { CoordinationDatabase } from './database.js'

interface Workspace {
  id: string
  title: string
  path: string
  sessionIds: readonly string[]
}
interface SessionRecord {
  header: { id: string; cwd?: string; parentSession?: string; createdAt?: string }
}
/** Structural read contracts from inspected Host services; optional in minimal profiles. */
export interface AmpScopeHost {
  workspaceRegistry?: {
    list(): Workspace[]
    get(id: string): Workspace | undefined
    resolveByPath(path: string): Promise<Workspace | undefined>
  }
  storageDomain?: { get(name: string): { global: { get(): unknown } } | undefined }
  sessionQuery?: { listSessions(): Promise<SessionRecord[]> }
}
export interface AmpScopeService { amp: AmpService; db: CoordinationDatabase }

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined
const text = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined
/** Adapt unknown optional Cordis services without trusting their runtime shape. */
export function adaptAmpScopeHost(services: {
  workspaceRegistry?: unknown; storageDomain?: unknown; sessionQuery?: unknown
}): AmpScopeHost {
  const host: AmpScopeHost = {}
  const registry = record(services.workspaceRegistry)
  const list = registry?.list
  const get = registry?.get
  const resolveByPath = registry?.resolveByPath
  if (registry !== undefined && typeof list === 'function' && typeof get === 'function' && typeof resolveByPath === 'function') {
    host.workspaceRegistry = {
      list: () => {
        const values: unknown = list.call(registry)
        return Array.isArray(values) ? values.flatMap((value) => {
          const workspace = workspaceView(value)
          return workspace === undefined ? [] : [workspace]
        }) : []
      },
      get: (id) => workspaceView(get.call(registry, id)),
      resolveByPath: async (path) => workspaceView(await resolveByPath.call(registry, path)),
    }
  }
  const storage = record(services.storageDomain)
  const domainGet = storage?.get
  if (storage !== undefined && typeof domainGet === 'function') {
    host.storageDomain = { get: (name) => {
      const domain = record(domainGet.call(storage, name))
      const global = record(domain?.global)
      const globalGet = global?.get
      return global !== undefined && typeof globalGet === 'function'
        ? { global: { get: () => globalGet.call(global) } } : undefined
    } }
  }
  const query = record(services.sessionQuery)
  const listSessions = query?.listSessions
  if (query !== undefined && typeof listSessions === 'function') {
    host.sessionQuery = { listSessions: async () => {
      const values: unknown = await listSessions.call(query)
      return Array.isArray(values) ? values.flatMap((value) => {
        const header = record(record(value)?.header)
        const id = text(header?.id)
        if (id === undefined) return []
        const cwd = text(header?.cwd)
        const parentSession = text(header?.parentSession)
        return [{ header: { id, ...(cwd === undefined ? {} : { cwd }), ...(parentSession === undefined ? {} : { parentSession }) } }]
      }) : []
    } }
  }
  return host
}

function workspaceView(value: unknown): Workspace | undefined {
  const workspace = record(value)
  const id = text(workspace?.id)
  const path = text(workspace?.path)
  const title = workspace?.title
  const sessions = workspace?.sessionIds
  if (id === undefined || path === undefined || typeof title !== 'string' || !Array.isArray(sessions)
    || !sessions.every((session) => typeof session === 'string')) return undefined
  return { id, path, title, sessionIds: [...sessions] }
}

const key = (kind: string, id: string): string => `${kind}:${id}`
const linkKinds = new Set(['turn', 'frame', 'receipt', 'goal', 'plan', 'claim', 'unknown', 'comprehension', 'request', 'interrupt', 'window'])

/** Only domain references correlate artifacts. Tool/agent/concept IDs never link sessions. */
function links(value: unknown, depth = 0): string[] {
  if (depth > 8) return []
  if (Array.isArray(value)) return value.flatMap((item) => links(item, depth + 1))
  const obj = record(value)
  if (obj === undefined) return []
  const result: string[] = []
  const kind = text(obj.kind)
  const id = text(obj.id)
  if (id !== undefined && kind !== undefined && linkKinds.has(kind)) result.push(key(kind, id))
  if (kind === 'task' && id !== undefined) result.push(key('turn', id))
  for (const [name, item] of Object.entries(obj)) {
    if (linkKinds.has(name) && typeof item === 'string') result.push(key(name, item))
    if (name === 'claims' && Array.isArray(item)) {
      for (const claim of item) if (typeof claim === 'string') result.push(key('claim', claim))
    }
    if (typeof item === 'object' && item !== null) result.push(...links(item, depth + 1))
  }
  return result
}

export function attributeAmpEntries(entries: ChainEntry[], db: CoordinationDatabase): Array<Set<string>> {
  const owners = new Map<string, Set<string>>()
  const assign = (ref: string, sessions: Iterable<string>): boolean => {
    let set = owners.get(ref)
    if (set === undefined) { set = new Set(); owners.set(ref, set) }
    const size = set.size
    for (const session of sessions) set.add(session)
    return set.size !== size
  }
  const rows = db.all<{ session: string; turn: string; goal: string | null; plan: string | null }>(`
    SELECT s.handle AS session, t.handle AS turn, g.handle AS goal, p.handle AS plan
    FROM turn t JOIN session s ON s.identity = t.session
    LEFT JOIN goal g ON g.identity = t.goal LEFT JOIN plan p ON p.identity = t.plan`)
  for (const row of rows) {
    for (const [kind, id] of [['turn', row.turn], ['frame', frameIdOf(row.turn)], ['receipt', receiptIdOf(row.turn)],
      ['goal', row.goal], ['goal', row.goal === null ? null : goalIdOf(row.goal)],
      ['plan', row.plan], ['plan', row.plan === null ? null : planIdOf(row.plan)]] as const) {
      if (id !== null) assign(key(kind, id), [row.session])
    }
  }
  // Include plans/goals not currently selected by the latest turn pointers.
  for (const kind of ['goal', 'plan'] as const) {
    const artifacts = db.all<{ handle: string; session: string }>(`SELECT a.handle, s.handle AS session FROM ${kind} a JOIN turn t ON t.identity = a.turn JOIN session s ON s.identity = t.session`)
    for (const artifact of artifacts) {
      assign(key(kind, artifact.handle), [artifact.session])
      assign(key(kind, kind === 'goal' ? goalIdOf(artifact.handle) : planIdOf(artifact.handle)), [artifact.session])
    }
  }
  const refs = entries.map((entry) => links(entry.payload))
  const anchored = entries.map((entry) => {
    const obj = record(entry.payload)
    const payload = entry.kind === 'event' ? record(obj?.payload) : obj
    const session = text(payload?.session)
    return session === undefined ? undefined : new Set([session])
  })
  // Direct session-bearing events seed references even when their artifacts predate them.
  for (let i = 0; i < entries.length; i++) {
    const sessions = anchored[i]
    if (sessions !== undefined) for (const ref of refs[i]!) assign(ref, sessions)
  }
  const results = entries.map(() => new Set<string>())
  // Several passes resolve receipt -> frame -> turn and event -> claims/plan links.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      const obj = record(entry.payload)
      const id = text(obj?.id)
      // An artifact's own identity (or an event's turn) outranks shared goal refs.
      const own = id === undefined ? undefined : owners.get(key(entry.kind, id))
      const turnRefs = refs[i]!.filter((ref) => ref.startsWith('turn:'))
      const turnOwners = new Set(turnRefs.flatMap((ref) => [...(owners.get(ref) ?? [])]))
      const sessions = anchored[i] ?? (own !== undefined && own.size > 0 ? own
        : turnOwners.size > 0 ? turnOwners : new Set(refs[i]!.flatMap((ref) => [...(owners.get(ref) ?? [])])))
      results[i] = new Set(sessions)
      if (id !== undefined && linkKinds.has(entry.kind)) changed = assign(key(entry.kind, id), sessions) || changed
      if (entry.kind === 'event' && sessions.size === 1) {
        for (const ref of refs[i]!) changed = assign(ref, sessions) || changed
      }
    }
    if (!changed) break
  }
  return results
}

export async function buildAmpScope(
  service: AmpScopeService, host: AmpScopeHost, scope: AmpScope, session: string,
  limits: AmpScopeView['limits'],
): Promise<AmpScopeView> {
  const { amp, db } = service
  const entries = amp.store.entries()
  const attribution = attributeAmpEntries(entries, db)
  const registry = host.workspaceRegistry
  const workspaces = registry?.list() ?? []
  const records = await host.sessionQuery?.listSessions() ?? []
  const byId = new Map(records.map((item) => [item.header.id, item.header]))
  const local = db.all<{ id: string; cwd: string; created: number }>('SELECT handle AS id, sandbox AS cwd, created FROM session')
  const workspaceOf = new Map<string, Workspace>()
  for (const workspace of workspaces) for (const id of workspace.sessionIds) workspaceOf.set(id, workspace)
  async function resolve(id: string, seen = new Set<string>()): Promise<Workspace | undefined> {
    const existing = workspaceOf.get(id)
    if (seen.has(id)) return existing
    seen.add(id)
    const header = byId.get(id)
    // Child sessions inherit the parent's project even when a worktree cwd differs.
    const parent = header?.parentSession
    let workspace = (parent === undefined ? undefined : await resolve(parent, seen)) ?? existing
    const cwd = header?.cwd ?? local.find((item) => item.id === id)?.cwd
    if (workspace === undefined && cwd && registry !== undefined) {
      try { workspace = await registry.resolveByPath(cwd) } catch { /* deleted/unresolvable directory */ }
    }
    if (workspace !== undefined) workspaceOf.set(id, workspace)
    return workspace
  }
  const knownIds = new Set([...local.map((item) => item.id), ...byId.keys()])
  for (const owners of attribution) for (const id of owners) knownIds.add(id)
  for (const workspace of workspaces) for (const id of workspace.sessionIds) knownIds.add(id)
  let workspace: Workspace | undefined
  if (scope === 'default') {
    const state = record(host.storageDomain?.get('workspace')?.global.get())
    const id = text(state?.defaultWorkspaceId)
    if (id !== undefined) workspace = registry?.get(id)
  } else if (scope === 'workspace') workspace = await resolve(session)
  const ids: string[] = []
  for (const id of knownIds) {
    if (scope === 'global' || (workspace !== undefined && (await resolve(id))?.id === workspace.id)) ids.push(id)
  }
  const latest = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) {
    for (const id of attribution[i]!) latest.set(id, i + 1)
  }
  const created = new Map(local.map((item) => [item.id, item.created]))
  ids.sort((a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0) || (created.get(b) ?? 0) - (created.get(a) ?? 0) || a.localeCompare(b))
  const selected = new Set(ids)
  const visible = entries.filter((_, i) => scope === 'global' || (attribution[i]!.size === 1 && selected.has([...attribution[i]!][0]!)))
  const receipts = visible.filter((entry) => entry.kind === 'receipt').map((entry) => entry.payload as Receipt).reverse()
  const sessions = await Promise.all(ids.slice(0, limits.sessions).map(async (id) => ({
    id, frame: latestFrame(entries, attribution, id), story: await amp.storyFor(id),
  })))
  return {
    scope, workspace: workspace === undefined ? null : { id: workspace.id, title: workspace.title, path: workspace.path },
    sessions, entries: limits.entries === 0 ? [] : visible.slice(-limits.entries), receipts: receipts.slice(0, limits.receipts),
    totalSessions: ids.length, totalEntries: visible.length, totalReceipts: receipts.length,
    unassignedEntries: scope === 'global' ? attribution.filter((owners) => owners.size !== 1).length : 0,
    truncated: { sessions: ids.length > limits.sessions, entries: visible.length > limits.entries, receipts: receipts.length > limits.receipts },
    limits, verificationScope: 'global',
  }
}

function latestFrame(entries: ChainEntry[], owners: Array<Set<string>>, session: string): Frame | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.kind === 'frame' && owners[i]!.size === 1 && owners[i]!.has(session)) return entries[i]!.payload as Frame
  }
  return null
}
