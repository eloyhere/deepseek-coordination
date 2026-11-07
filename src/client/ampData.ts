import * as React from 'react'

/**
 * Client-side AMP projection: the HTTP shapes the read-only surfaces render.
 *
 * The host already projects DSH into the AMP kernel; these types only describe
 * what `/amp/status`, `/amp/modules`, `/amp/journal` and `/amp/sync` serialize.
 * Keeping them in one place means the composer strip and the settings page read
 * the same snapshot instead of each inventing its own subset.
 */

export interface AmpVerb {
  readonly verb: string
  readonly mutating: boolean
  readonly authority?: readonly string[]
  readonly summary?: string
}

export interface AmpWithheldVerb {
  readonly verb: string
  readonly reason: string
}

export interface AmpModule {
  readonly module: string
  readonly tier: string
  readonly summary: string
  readonly registration?: string
  readonly registered?: boolean
  readonly verbs?: readonly AmpVerb[]
  readonly withheld?: readonly AmpWithheldVerb[]
}

export interface AmpCounts {
  readonly [kind: string]: number | undefined
}

export interface AmpBudget {
  readonly limit?: Readonly<Record<string, number>>
  readonly settled?: Readonly<Record<string, number>>
  readonly reserved?: Readonly<Record<string, number>>
}

export interface AmpStoreStats {
  readonly entities?: number
  readonly events?: number
  readonly identity?: number
  readonly schemaVersion?: number
}

export interface AmpKernel {
  readonly counts?: AmpCounts
  readonly budget?: AmpBudget
  readonly workflowEvents?: number
  readonly receiptCount?: number
  readonly evidenceCount?: number
  readonly verificationCount?: number
  readonly store?: AmpStoreStats
}

export interface AmpJournalEntry {
  readonly tool: string
  readonly sessionId?: string
  readonly mutating?: boolean
  readonly idempotencyKey?: string
  readonly ok?: boolean
  readonly error?: string
  readonly durationMs?: number
}

export interface AmpListItem {
  readonly diagnostic?: boolean
  readonly raw?: Record<string, unknown>
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly state?: string
  readonly detail?: string
  readonly at?: string
}

export interface AmpStatus {
  readonly tenantId?: string
  readonly rootId?: string
  readonly sessionId?: string
  readonly modules?: number
  readonly agentModules?: number
  readonly exposedTools?: number
  readonly kernel?: AmpKernel
  readonly journal?: readonly AmpJournalEntry[]
  readonly lists?: Readonly<Record<string, readonly AmpListItem[]>>
}

export interface AmpSync {
  readonly counters?: Readonly<Record<string, number>>
  readonly goals?: number
  readonly chains?: number
  readonly actions?: number
  readonly errors?: readonly string[]
  readonly deferred?: readonly unknown[]
}

export interface AmpSnapshot {
  readonly status: AmpStatus | null
  readonly modules: readonly AmpModule[]
  readonly journal: readonly AmpJournalEntry[]
  readonly sync: AmpSync | null
  readonly loading: boolean
  readonly error: boolean
  readonly updatedAt: number | null
  readonly refresh: () => void
}

export const STATUS_ROUTE = '/deepseek-coordination/amp/status'
export const MODULES_ROUTE = '/deepseek-coordination/amp/modules'
export const JOURNAL_ROUTE = '/deepseek-coordination/amp/journal'
export const SYNC_ROUTE = '/deepseek-coordination/amp/sync'

/** How many calls the settings page keeps on screen; the host keeps more. */
export const JOURNAL_LIMIT = 200

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const body = (await response.json()) as { ok?: boolean; value?: T }
    return body.ok === true && body.value !== undefined ? body.value : null
  } catch {
    return null
  }
}

/**
 * Poll all four read-only AMP routes as one snapshot. A transient failure keeps
 * the last successful snapshot and raises `error`, so a strip never blanks out
 * just because one poll missed.
 */
export function useAmpData(pollMs = 5_000, sessionId?: string, withLists = false): AmpSnapshot {
  const [state, setState] = React.useState<Omit<AmpSnapshot, 'refresh'>>({
    status: null,
    modules: [],
    journal: [],
    sync: null,
    loading: true,
    error: false,
    updatedAt: null,
  })
  const [nonce, setNonce] = React.useState(0)
  const signatureRef = React.useRef('')
  const refresh = React.useCallback(() => setNonce((value) => value + 1), [])

  React.useEffect(() => {
    const controller = new AbortController()
    let stopped = false

    const load = async (): Promise<void> => {
      const scope = sessionId === undefined
        ? ''
        : `?session=${encodeURIComponent(sessionId)}${withLists ? '&lists=1' : ''}`
      const [status, modules, journal, sync] = await Promise.all([
        fetchJson<AmpStatus>(`${STATUS_ROUTE}${scope}`, controller.signal),
        fetchJson<{ modules?: readonly AmpModule[] }>(MODULES_ROUTE, controller.signal),
        fetchJson<{ entries?: readonly AmpJournalEntry[] }>(
          `${JOURNAL_ROUTE}?limit=${JOURNAL_LIMIT}${sessionId === undefined ? '' : `&session=${encodeURIComponent(sessionId)}`}`,
          controller.signal,
        ),
        fetchJson<AmpSync>(SYNC_ROUTE, controller.signal),
      ])
      if (stopped) return
      setState((previous) => {
        const next = {
          status: status ?? previous.status,
          modules: modules?.modules ?? previous.modules,
          journal: journal?.entries ?? previous.journal,
          sync: sync ?? previous.sync,
          loading: false,
          error: status === null,
          updatedAt: status === null ? previous.updatedAt : Date.now(),
        }
        // The host returns fresh objects on every poll. Comparing their
        // serialized projection keeps the 5 s poll from re-rendering 27
        // Accordions (and every tab panel) while nothing actually changed.
        const signature = snapshotSignature(next.status, next.modules, next.journal, next.sync)
        if (signatureRef.current === signature && !previous.loading && previous.error === next.error) return previous
        signatureRef.current = signature
        return next
      })
    }

    void load()
    const timer = pollMs > 0 ? window.setInterval(() => { void load() }, pollMs) : undefined
    return () => {
      stopped = true
      controller.abort()
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [pollMs, nonce, sessionId, withLists])

  return { ...state, refresh }
}

/** `attention_manifest_protocol_session.get` → `session.get`. */
export function shortToolName(tool: string): string {
  return tool.startsWith('attention_manifest_protocol_')
    ? tool.slice('attention_manifest_protocol_'.length)
    : tool
}

/** Locale-independent integer formatting with grouping separators. */
export function formatCount(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value ?? 0)
}

/** HH:mm:ss in the page's locale, for the "updated at" line. */
export function formatClock(timestamp: number | null, locale: string): string {
  if (timestamp === null) return '—'
  try {
    return new Date(timestamp).toLocaleTimeString(locale, { hour12: false })
  } catch {
    return new Date(timestamp).toISOString().slice(11, 19)
  }
}

export const COUNT_ORDER = ['session', 'turn', 'intent', 'mission', 'goal', 'plan', 'task', 'action'] as const

export function totalVerbs(modules: readonly AmpModule[]): number {
  return modules.reduce((total, module) => total + (module.verbs?.length ?? 0), 0)
}

export function mutatingVerbs(modules: readonly AmpModule[]): number {
  return modules.reduce(
    (total, module) => total + (module.verbs ?? []).filter((verb) => verb.mutating).length,
    0,
  )
}

export function tierCounts(modules: readonly AmpModule[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const module of modules) counts[module.tier] = (counts[module.tier] ?? 0) + 1
  return counts
}

/** Cheap projection of everything the two surfaces actually render. */
export function snapshotSignature(
  status: AmpStatus | null,
  modules: readonly AmpModule[],
  journal: readonly AmpJournalEntry[],
  sync: AmpSync | null,
): string {
  return JSON.stringify({
    counts: status?.kernel?.counts,
    store: status?.kernel?.store,
    budget: status?.kernel?.budget,
    kernel: status?.kernel == null
      ? null
      : [
        status.kernel.workflowEvents,
        status.kernel.receiptCount,
        status.kernel.evidenceCount,
        status.kernel.verificationCount,
      ],
    modules: modules.map((module) => [
      module.module,
      module.registered,
      module.verbs?.length ?? 0,
      module.withheld?.length ?? 0,
    ]),
    journal: journal.map((entry) => [entry.tool, entry.ok, entry.mutating, entry.error, entry.durationMs]),
    sync: sync?.counters,
    lists: status?.lists === undefined
      ? undefined
      : Object.fromEntries(Object.entries(status.lists).map(([kind, items]) => [
        kind,
        items.map((item) => [item.id, item.state, item.title, item.detail, item.at, item.diagnostic, item.raw]),
      ])),
  })
}
