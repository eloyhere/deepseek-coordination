/**
 * Takeover preferences shared by the settings page and the client surfaces.
 *
 * The host owns the durable copy (`/amp/preferences`); localStorage is only the
 * instant-paint cache. A preference change is optimistic: the switch flips,
 * then the host write either confirms `synced` or leaves the value local.
 */
import * as React from 'react'

export interface AmpPreferences {
  readonly takeoverFileRead: boolean
  readonly takeoverFileWrite: boolean
  readonly takeoverSearch: boolean
  readonly takeoverNotifications: boolean
  readonly contextOptimization: boolean
  readonly autoRefresh: boolean
  readonly compactCatalog: boolean
}

export const DEFAULT_PREFERENCES: AmpPreferences = {
  takeoverFileRead: false,
  takeoverFileWrite: false,
  takeoverSearch: false,
  takeoverNotifications: true,
  contextOptimization: true,
  autoRefresh: true,
  compactCatalog: false,
}

const STORAGE_KEY = 'deepseek-coordination:amp-preferences'
const ROUTE = '/deepseek-coordination/amp/preferences'

type Mutable = { -readonly [K in keyof AmpPreferences]: AmpPreferences[K] }

function normalise(value: unknown, fallback: AmpPreferences): AmpPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback
  const record = value as Record<string, unknown>
  return {
    takeoverFileRead: typeof record.takeoverFileRead === 'boolean' ? record.takeoverFileRead : fallback.takeoverFileRead,
    takeoverFileWrite: typeof record.takeoverFileWrite === 'boolean' ? record.takeoverFileWrite : fallback.takeoverFileWrite,
    takeoverSearch: typeof record.takeoverSearch === 'boolean' ? record.takeoverSearch : fallback.takeoverSearch,
    takeoverNotifications: typeof record.takeoverNotifications === 'boolean' ? record.takeoverNotifications : fallback.takeoverNotifications,
    contextOptimization: typeof record.contextOptimization === 'boolean' ? record.contextOptimization : fallback.contextOptimization,
    autoRefresh: typeof record.autoRefresh === 'boolean' ? record.autoRefresh : fallback.autoRefresh,
    compactCatalog: typeof record.compactCatalog === 'boolean' ? record.compactCatalog : fallback.compactCatalog,
  }
}

function readLocal(): AmpPreferences {
  try {
    if (typeof window === 'undefined') return DEFAULT_PREFERENCES
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === null ? DEFAULT_PREFERENCES : normalise(JSON.parse(raw), DEFAULT_PREFERENCES)
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function writeLocal(value: AmpPreferences): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Private browsing or a blocked storage area: keep the in-memory value.
  }
}

let state: AmpPreferences = readLocal()
let synced = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeAmpPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function replace(next: AmpPreferences, isSynced: boolean): void {
  state = next
  synced = isSynced
  writeLocal(next)
  emit()
}

async function readHost(): Promise<void> {
  try {
    const response = await fetch(ROUTE, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return
    const body = (await response.json()) as { ok?: boolean; value?: unknown }
    if (body.ok !== true) return
    replace(normalise(body.value, state), true)
  } catch {
    // An older host has no preferences route; local values remain usable.
  }
}

async function writeHost(next: AmpPreferences): Promise<void> {
  try {
    const response = await fetch(ROUTE, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(next),
    })
    const body = (await response.json()) as { ok?: boolean; value?: unknown }
    if (!response.ok || body.ok !== true) return
    replace(normalise(body.value, next), true)
  } catch {
    // Keep the optimistic local value.
  }
}

let hostReadStarted = false

function ensureHostRead(): void {
  if (hostReadStarted) return
  hostReadStarted = true
  void readHost()
}

export interface AmpPreferencesState {
  readonly preferences: AmpPreferences
  readonly synced: boolean
  readonly set: <K extends keyof AmpPreferences>(key: K, value: AmpPreferences[K]) => void
}

/** Read the latest preference snapshot from non-React client adapters. */
export function ampPreferencesSnapshot(): AmpPreferences {
  return state
}

export function useAmpPreferences(): AmpPreferencesState {
  const preferences = React.useSyncExternalStore(subscribeAmpPreferences, () => state, () => state)
  React.useEffect(() => { ensureHostRead() }, [])
  const set = React.useCallback(<K extends keyof AmpPreferences>(key: K, value: AmpPreferences[K]): void => {
    const next: Mutable = { ...state, [key]: value }
    replace(next, false)
    void writeHost(next)
  }, [])
  return { preferences, synced, set }
}
