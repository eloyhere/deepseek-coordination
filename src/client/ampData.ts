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

/** One compiler exclusion projected by `/amp/context`. */
export interface AmpContextExclusion {
  readonly id?: string
  readonly reason?: string
  readonly detail?: string
}

/** Diagnostics for the last AMP context compile. */
export interface AmpContextDiagnostics {
  readonly lag?: number
  readonly pending?: boolean
  readonly lastCompileAt?: string
  readonly compilerExclusions?: number
  readonly lastExclusions?: readonly AmpContextExclusion[]
}

/** The last `agent/pre-step` capture, already bounded by the host. */
export interface AmpCaptureSummary {
  readonly sessionId?: string
  readonly turn?: number
  readonly step?: number
  readonly capturedAt?: string
  readonly promptChars?: number
  readonly messages?: number
  readonly items?: number
  readonly errors?: number
}

/** Bounded output-channel counters from the P2 trackers. */
export interface AmpContextOutputs {
  readonly spill?: {
    readonly records?: number
    readonly sessions?: number
    readonly failures?: number
    readonly bytes?: number
  }
  readonly retention?: {
    readonly records?: number
    readonly sessions?: number
    readonly failures?: number
    readonly omittedBytes?: number
    readonly omittedItems?: number
    readonly omittedUnknown?: number
  }
  readonly prune?: { readonly records?: number; readonly sessions?: number; readonly failures?: number; readonly shadowedTokens?: number }
  readonly compaction?: { readonly records?: number; readonly sessions?: number; readonly failures?: number; readonly shadowedTokens?: number }
  readonly failures?: number
}

/** The `/amp/context` read model: compile, capture, recovery and output health. */
export interface AmpContext {
  readonly enabled?: boolean
  readonly compilations?: number
  readonly failures?: number
  readonly excluded?: number
  readonly lastTokens?: number
  readonly lastItems?: number
  readonly lastCharacters?: number
  readonly budgetTokens?: number
  readonly compilerExclusions?: number
  readonly compilerExclusionsDetailed?: readonly AmpContextExclusion[]
  readonly contextDiagnostics?: AmpContextDiagnostics
  readonly hostExclusions?: readonly unknown[]
  readonly hostExclusionCount?: number
  readonly capture?: { readonly lastCapture?: AmpCaptureSummary }
  readonly lastCapture?: AmpCaptureSummary
  readonly recovery?: {
    readonly sessions?: number
    readonly agents?: number
    readonly events?: number
    readonly hydrations?: number
    readonly failures?: number
  }
  readonly outputs?: AmpContextOutputs
  readonly lag?: number
  /** Tokens injected across every compile; the value model's denominator. */
  readonly tokensInjected?: number
  /** AMP compile-cache counters; `savedTokens` never counts as prompt tokens. */
  readonly cache?: {
    readonly entries?: number
    readonly tokens?: number
    readonly bytes?: number
    readonly hits?: number
    readonly misses?: number
    readonly evictions?: number
    readonly expirations?: number
    readonly hitRate?: number
    readonly utilisation?: number
    readonly savedTokens?: number
    readonly failures?: number
  }
  /** Verified prune counters; `savedTokens` is the attention ledger's saving. */
  readonly prune?: {
    readonly reviews?: number
    readonly applied?: number
    readonly verified?: number
    readonly failed?: number
    readonly savedTokens?: number
    readonly lastPruned?: number
    readonly lastKept?: number
    readonly lastAt?: string
    readonly sessions?: number
  }
  /** Host-computed value model; absent on an older host. */
  readonly benefits?: AmpBenefits
  /** One-line host summary, preserved for compatibility. */
  readonly line?: string
}

/** One of four readable quality bands. */
export type AmpBenefitBand = 'excellent' | 'good' | 'fair' | 'poor'

/** How much evidence backs the estimate. */
export type AmpBenefitConfidence = 'none' | 'low' | 'medium' | 'high'

/** Guardrail index behind the "output quality" tile. */
export interface AmpBenefitQuality {
  readonly score: number
  readonly baseline: number
  readonly delta: number
  readonly band: AmpBenefitBand
  readonly samples: number
  readonly components: {
    readonly freshness: number
    readonly budget: number
    readonly verification: number
    readonly reliability: number
  }
}

/** The host value read model served under `benefits` by `/amp/context`. */
export interface AmpBenefits {
  readonly available: boolean
  readonly currency: string
  /** Provider/model DSH reports for the active route. */
  readonly model: { readonly provider: string; readonly model: string } | null
  /** Resolved tariff; `priced: false` means the model has no text-token price. */
  readonly pricing: {
    readonly priced: boolean
    readonly provider: string
    readonly model: string
    readonly name: string
    readonly method: 'deepseek-peak' | 'registry' | 'flat' | 'none'
    readonly currency: 'CNY' | 'USD'
    readonly window: 'peak' | 'off-peak' | 'flat'
    readonly inputMissPerMillion: number
    readonly inputHitPerMillion: number
    readonly outputPerMillion: number
    readonly cacheDiscount: boolean
    readonly tiers: readonly {
      readonly above: number
      readonly input: number
      readonly output: number
      readonly cacheRead: number
      readonly cacheWrite: number
    }[]
    readonly effectiveInputPerMillion: number
    readonly source: string
  } | null
  /** Actual prompt-cache usage behind the blended input price. */
  readonly cache: {
    readonly requests: number
    readonly inputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    readonly outputTokens: number
    readonly totalInputTokens: number
    readonly hitRate: number
  }
  /** Static price-registry size and provenance. */
  readonly registry: {
    readonly providers: number
    readonly models: number
    readonly priced: number
    readonly sources: readonly string[]
  } | null
  readonly quality: AmpBenefitQuality | null
  readonly errors: {
    readonly available: boolean
    readonly calls: number
    readonly failures: number
    readonly errorRate: number
    readonly errorFree: number
    readonly medianDurationMs: number
    readonly p95DurationMs: number
    readonly durationScore: number
    readonly durationTargetMs: number
  } | null
  readonly effectiveness: {
    readonly score: number
    readonly components: {
      readonly quality: number
      readonly duration: number
      readonly errorFree: number
      readonly roi: number
    }
    readonly weights: {
      readonly quality: number
      readonly duration: number
      readonly roi: number
    }
    readonly errorRate: number
    readonly p95DurationMs: number
    readonly formula: string
  } | null
  readonly history: {
    readonly persisted: boolean
    readonly updatedAt: string | null
  }
  readonly tokens: {
    readonly saved: number
    readonly spill: number
    readonly retention: number
    readonly prune: number
    readonly attentionPrune: number
    readonly contextPrune: number
    readonly compaction: number
    readonly contextPruneRecords: number
    readonly compactionRecords: number
    readonly cacheReuse: number
    readonly injected: number
    readonly net: number
    readonly roi: number
    readonly omittedItems: number
    readonly omittedUnknown: number
  }
  readonly cost: {
    readonly saved: number
    readonly injected: number
    readonly net: number
    readonly pricePerMillion: number
    readonly currency: string
    /** False when the active model has no published text-token tariff. */
    readonly priced: boolean
  }
  readonly confidence: AmpBenefitConfidence
  readonly assumptions: {
    readonly bytesPerToken: number
    readonly qualityBaseline: number
    readonly qualityWeights: readonly number[]
    readonly countedSources: readonly string[]
    readonly excludedSources: readonly string[]
  }
}

export interface AmpSnapshot {
  readonly status: AmpStatus | null
  readonly modules: readonly AmpModule[]
  readonly journal: readonly AmpJournalEntry[]
  readonly sync: AmpSync | null
  readonly context: AmpContext | null
  readonly loading: boolean
  readonly error: boolean
  readonly updatedAt: number | null
  readonly refresh: () => void
}

export const STATUS_ROUTE = '/deepseek-coordination/amp/status'
export const MODULES_ROUTE = '/deepseek-coordination/amp/modules'
export const JOURNAL_ROUTE = '/deepseek-coordination/amp/journal'
export const SYNC_ROUTE = '/deepseek-coordination/amp/sync'
export const CONTEXT_ROUTE = '/deepseek-coordination/amp/context'

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
    context: null,
    loading: true,
    error: false,
    updatedAt: null,
  })
  const [nonce, setNonce] = React.useState(0)
  const signatureRef = React.useRef('')
  const refresh = React.useCallback(() => setNonce((value) => value + 1), [])
  const commit = React.useCallback((patch: Partial<Omit<AmpSnapshot, 'refresh'>>): void => {
    setState((previous) => {
      const next = { ...previous, ...patch }
      // The host returns fresh objects on every poll. Comparing their
      // serialized projection keeps a poll from re-rendering 27 Accordions
      // (and every tab panel) while nothing actually changed.
      const signature = snapshotSignature(next.status, next.modules, next.journal, next.sync, next.context)
      if (signatureRef.current === signature && !previous.loading && previous.error === next.error) return previous
      signatureRef.current = signature
      return next
    })
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    let stopped = false
    let firstLoad: number | undefined
    let statusTimer: number | undefined
    let heavyTimer: number | undefined

    const scope = sessionId === undefined
      ? ''
      : `?session=${encodeURIComponent(sessionId)}${withLists ? '&lists=1' : ''}`
    const statusUrl = `${STATUS_ROUTE}${scope}`
    const journalUrl = `${JOURNAL_ROUTE}?limit=${JOURNAL_LIMIT}${sessionId === undefined ? '' : `&session=${encodeURIComponent(sessionId)}`}`

    // The composer strip only needs the small status payload. Fetching the
    // five-endpoint snapshot here made every conversation mount do the same
    // expensive work twice (status plus context, modules, journal and sync)
    // before the conversation could paint.
    const loadStatus = async (): Promise<void> => {
      const status = await fetchJson<AmpStatus>(statusUrl, controller.signal)
      if (stopped) return
      if (status === null) {
        commit({ loading: false, error: true })
        return
      }
      commit({ status, loading: false, error: false, updatedAt: Date.now() })
    }

    const loadHeavy = async (): Promise<void> => {
      const [modules, sync, context, journal] = await Promise.all([
        fetchJson<{ modules?: readonly AmpModule[] }>(MODULES_ROUTE, controller.signal),
        fetchJson<AmpSync>(SYNC_ROUTE, controller.signal),
        fetchJson<AmpContext>(CONTEXT_ROUTE, controller.signal),
        withLists
          ? fetchJson<{ entries?: readonly AmpJournalEntry[] }>(journalUrl, controller.signal)
          : Promise.resolve(null),
      ])
      if (stopped) return
      commit({
        ...(modules?.modules === undefined ? {} : { modules: modules.modules }),
        ...(sync === null ? {} : { sync }),
        ...(context === null ? {} : { context }),
        ...(journal?.entries === undefined ? {} : { journal: journal.entries }),
      })
    }

    void loadStatus()
    // Keep the first paint free of the aggregate context compile; the strip
    // shows its offline value for one short frame instead of delaying the
    // conversation. The heavy snapshot refreshes far less often than status.
    firstLoad = window.setTimeout(() => { void loadHeavy() }, 800)
    if (pollMs > 0) {
      statusTimer = window.setInterval(() => { void loadStatus() }, pollMs)
      heavyTimer = window.setInterval(() => { void loadHeavy() }, Math.max(pollMs * 6, 30_000))
    }
    return () => {
      stopped = true
      controller.abort()
      if (firstLoad !== undefined) window.clearTimeout(firstLoad)
      if (statusTimer !== undefined) window.clearInterval(statusTimer)
      if (heavyTimer !== undefined) window.clearInterval(heavyTimer)
    }
  }, [pollMs, nonce, sessionId, withLists, commit])

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

/**
 * Compact token count for KPI tiles and the composer strip.
 *
 * Small values stay exact; larger values keep three significant digits at
 * most, so a tile can never overflow because of a long grouped number.
 */
export function formatCompactCount(value: number | undefined): string {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  const absolute = Math.abs(number)
  if (absolute >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(absolute >= 10_000_000_000 ? 0 : 1)}B`
  if (absolute >= 1_000_000) return `${(number / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`
  if (absolute >= 10_000) return `${Math.round(number / 1_000)}k`
  if (absolute >= 1_000) return `${(number / 1_000).toFixed(1)}k`
  return String(Math.round(number))
}

/**
 * Money for an estimate. Sub-cent values keep enough decimals to stay
 * distinguishable from zero instead of rendering a misleading `¥0.00`.
 */
export function formatMoney(value: number | undefined, currency = 'CNY'): string {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  const absolute = Math.abs(number)
  const digits = absolute === 0 ? 2 : absolute >= 1 ? 2 : absolute >= 0.01 ? 4 : 6
  const body = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(number))
  const sign = number < 0 ? '-' : ''
  if (currency === 'CNY') return `${sign}¥${body}`
  if (currency === 'USD') return `${sign}$${body}`
  return `${sign}${currency} ${body}`
}

/** A leverage ratio like `3.4×`; an unmeasured ratio is an em dash. */
export function formatRatio(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}×`
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
  context: AmpContext | null = null,
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
    context: context === null
      ? null
      : [
        context.contextDiagnostics?.lag,
        context.contextDiagnostics?.lastCompileAt,
        context.contextDiagnostics?.compilerExclusions,
        context.lastCapture?.turn,
        context.lastCapture?.step,
        context.lastCapture?.capturedAt,
        context.recovery?.failures,
        context.hostExclusionCount,
        context.outputs?.spill?.records,
        context.outputs?.retention?.records,
        context.outputs?.prune?.records,
        context.outputs?.prune?.shadowedTokens,
        context.outputs?.compaction?.records,
        context.outputs?.compaction?.shadowedTokens,
        context.lastTokens,
        context.tokensInjected,
        context.cache?.savedTokens,
        context.prune?.savedTokens,
        context.outputs?.spill?.bytes,
        context.outputs?.retention?.omittedBytes,
        context.benefits?.available,
        context.benefits?.quality?.score,
        context.benefits?.tokens.saved,
        context.benefits?.tokens.prune,
        context.benefits?.tokens.contextPrune,
        context.benefits?.tokens.compaction,
        context.benefits?.tokens.contextPruneRecords,
        context.benefits?.tokens.compactionRecords,
        context.benefits?.tokens.injected,
        context.benefits?.effectiveness?.score,
        context.benefits?.history?.persisted,
        context.benefits?.history?.updatedAt,
        context.benefits?.errors?.calls,
        context.benefits?.errors?.failures,
        context.benefits?.errors?.p95DurationMs,
        context.benefits?.cost.saved,
        context.benefits?.model?.model,
        context.benefits?.pricing?.window,
        context.benefits?.pricing?.effectiveInputPerMillion,
        context.benefits?.cache?.hitRate,
        context.benefits?.confidence,
      ],
    lists: status?.lists === undefined
      ? undefined
      : Object.fromEntries(Object.entries(status.lists).map(([kind, items]) => [
        kind,
        items.map((item) => [item.id, item.state, item.title, item.detail, item.at, item.diagnostic, item.raw]),
      ])),
  })
}
