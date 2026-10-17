/**
 * Client bridge to the host half.
 *
 * Five dropdowns, one wire contract:
 *   GET  /deepseek-coordination/selection?session=<dsh session id> -> SelectionState
 *   POST /deepseek-coordination/selection { session, patch }      -> SelectionState
 *
 * The bridge never throws into React: an unreachable host or an old host build
 * resolves to `null`, and the caller falls back to a per-session localStorage
 * copy with an explicit "local only" tooltip. A host rejection keeps its typed
 * code so the caller can explain a locked profession.
 *
 * It also reports the active language:
 *   POST /deepseek-coordination/locale { locale }                   -> ignored
 *
 * The report is fire-and-forget with a short timeout: a missing route (older
 * host build) must not delay or break the composer. The host half rebuilds the
 * `coordination_*` tool descriptions from the last report.
 */
import type { Selection } from '../shared/entity.js'
import { toCommandType, toInteraction, toProfession, toScene, toValidation } from '../shared/enum.js'
import type { SelectionPatch, SelectionState } from '../shared/selection.js'
import type { Locale } from '../shared/i18n.js'

const ROUTE_PREFIX = '/deepseek-coordination'
const LOCAL_PREFIX = 'deepseek-coordination:selection:'
const REQUEST_TIMEOUT = 3000
const LOCALE_REPORT_TIMEOUT = 2000

interface WireError {
  code?: string
  message?: string
  details?: Record<string, unknown>
}

type Wire<T> = { ok: true; value: T } | { ok: false; error?: WireError }

export interface SelectionSaveOutcome {
  state: SelectionState | null
  code?: string
  message?: string
}

/** A locally cached choice for the next turn, used when the host is unreachable. */
export interface LocalSelection {
  profession?: string
  interaction?: string
  scene?: string
  validation?: string
  command?: string
}

async function call<T>(path: string, init?: RequestInit): Promise<Wire<T> | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(`${ROUTE_PREFIX}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const text = await response.text()
    if (text.length === 0) return null
    return JSON.parse(text) as Wire<T>
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

function localKey(sessionId: string): string {
  return `${LOCAL_PREFIX}${sessionId}`
}

export function readLocal(sessionId: string): LocalSelection | null {
  try {
    const raw = window.localStorage.getItem(localKey(sessionId))
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as LocalSelection
  } catch {
    return null
  }
}

export function writeLocal(sessionId: string, patch: LocalSelection): void {
  try {
    const merged = { ...(readLocal(sessionId) ?? {}), ...patch }
    window.localStorage.setItem(localKey(sessionId), JSON.stringify(merged))
  } catch {
    // A blocked storage only loses the offline copy; the dropdowns still work.
  }
}

/** Drop the offline copy after it has been replayed to the host. */
export function clearLocal(sessionId: string): void {
  try {
    window.localStorage.removeItem(localKey(sessionId))
  } catch {
    // A blocked storage has nothing to clear.
  }
}

/** The offline projection of the five choices; no host, no permission catalog. */
export function localState(sessionId: string): SelectionState {
  const stored = readLocal(sessionId)
  const selection: Selection = {
    session: sessionId,
    profession: toProfession(stored?.profession),
    interaction: toInteraction(stored?.interaction),
    scene: toScene(stored?.scene),
    validation: toValidation(stored?.validation),
    command: toCommandType(stored?.command),
    locked: false,
    changed: Date.now(),
  }
  return {
    session: sessionId,
    selection,
    locked: false,
    presets: [],
    tooltip: true,
  }
}

export async function loadSelection(sessionId: string): Promise<SelectionState | null> {
  const wire = await call<SelectionState>(`/selection?session=${encodeURIComponent(sessionId)}`)
  if (wire === null || !wire.ok) return null
  return wire.value
}

export async function saveSelection(
  sessionId: string,
  patch: SelectionPatch,
): Promise<SelectionSaveOutcome> {
  const wire = await call<SelectionState>('/selection', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId, patch }),
  })
  // No fabricated prose here: user-facing fallback copy belongs to the locale
  // dictionary, so the outcome carries only the host's own message (if any).
  if (wire === null) return { state: null }
  if (!wire.ok) {
    return {
      state: null,
      code: wire.error?.code,
      message: wire.error?.message,
    }
  }
  return { state: wire.value }
}

/**
 * Tell the host half which language the client is showing (v23 §22).
 *
 * Fire-and-forget: the response carries nothing the UI needs, the timeout is
 * short, and an unreachable host or a host build without the route keeps the
 * previous language. Never throws.
 *
 * @param locale - normalised locale tag (`zh-CN` | `en-US`).
 */
export async function reportLocale(locale: Locale): Promise<void> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), LOCALE_REPORT_TIMEOUT)
  try {
    await fetch(`${ROUTE_PREFIX}/locale`, {
      method: 'POST',
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale }),
    })
  } catch {
    // The host keeps its last known language; the next change reports again.
  } finally {
    window.clearTimeout(timer)
  }
}

/** True when a value is a non-empty, usable DSH session id. */
export function usableSession(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && sessionId.trim().length > 0
}
