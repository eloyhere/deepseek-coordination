/**
 * Client bridge to the host half.
 *
 * Five dropdowns, one wire contract:
 *   GET  /deepseek-coordination/selection?session=<dsh session id> -> SelectionState
 *   POST /deepseek-coordination/selection { session, patch }      -> SelectionState
 *   POST /deepseek-coordination/profession/rebuild { session, profession } -> SelectionState
 *   POST /deepseek-coordination/profession/abandon { session }            -> SelectionState
 *
 * The bridge never throws into React: an unreachable host or an old host build
 * resolves to `null`, and the caller falls back to a per-session localStorage
 * copy with an explicit "local only" tooltip. A host rejection keeps its typed
 * code, message and `details` so the caller can explain a locked profession and
 * offer rebuild/abandon without parsing prose.
 *
 * The rebuild/abandon routes are newer than the selection routes (v24 §16). An
 * old host answers them with the route handler's 404 "not a coordination route"
 * envelope, so the outcome carries `unsupported`: the composer then says the
 * host build is too old instead of pretending the action failed for another
 * reason.
 *
 * It also reports the active language:
 *   POST /deepseek-coordination/locale { locale }                   -> ignored
 *
 * Service-level takeover windows (v24 §16) use three more routes:
 *   GET  /deepseek-coordination/takeover/pending?session=<id> -> PendingTakeover[]
 *   POST /deepseek-coordination/takeover/answer { handle, answer } -> { answered }
 *   POST /deepseek-coordination/takeover/cancel { handle }         -> { cancelled }
 *
 * The settings page writes the auto-compaction switch and threshold back with:
 *   POST /deepseek-coordination/config/compaction { auto?, soft?, hard? }
 *        -> { auto, soft, hard }
 * An old host answers that path with the same 404 route envelope, which the
 * settings page reports as "change it in the configuration file".
 *
 * The pending query is polled by `./takeover.ts`; the answer builder lives here
 * so its host shape can be tested without React.
 *
 * The report is fire-and-forget with a short timeout: a missing route (older
 * host build) must not delay or break the composer. The host half rebuilds the
 * `coordination_*` tool descriptions from the last report.
 */
import type { Selection } from '../shared/entity.js'
import type { Profession } from '../shared/enum.js'
import { toCommandType, toInteraction, toProfession, toScene, toValidation } from '../shared/enum.js'
import type { ConfigPatch, ConfigView, SelectionPatch, SelectionState } from '../shared/selection.js'
import type { Locale } from '../shared/i18n.js'

const ROUTE_PREFIX = '/deepseek-coordination'
const LOCAL_PREFIX = 'deepseek-coordination:selection:'
const REQUEST_TIMEOUT = 3000
const TAKEOVER_TIMEOUT = 2000
const LOCALE_REPORT_TIMEOUT = 2000

interface WireError {
  code?: string
  message?: string
  details?: Record<string, unknown>
}

type Wire<T> = { ok: true; value: T } | { ok: false; error?: WireError }

/** One parsed HTTP answer: status plus the envelope (when it was JSON). */
interface WireResponse<T> {
  status: number | null
  wire: Wire<T> | null
}

export interface SelectionSaveOutcome {
  state: SelectionState | null
  code?: string
  message?: string
  /** Host error details (`details.current` / `details.requested` for a lock). */
  details?: Record<string, unknown>
}

/** Result of the profession rebuild/abandon routes. */
export interface ProfessionOutcome {
  state: SelectionState | null
  code?: string
  message?: string
  details?: Record<string, unknown>
  /** True when the host build has no such route (404 from the route handler). */
  unsupported: boolean
  /** False when the request never reached the host (offline / timeout). */
  reached: boolean
}

/** A locally cached choice for the next turn, used when the host is unreachable. */
export interface LocalSelection {
  profession?: string
  interaction?: string
  scene?: string
  validation?: string
  command?: string
}

async function call<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT,
): Promise<WireResponse<T>> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${ROUTE_PREFIX}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const text = await response.text()
    if (text.length === 0) return { status: response.status, wire: null }
    try {
      return { status: response.status, wire: JSON.parse(text) as Wire<T> }
    } catch {
      return { status: response.status, wire: null }
    }
  } catch {
    return { status: null, wire: null }
  } finally {
    window.clearTimeout(timer)
  }
}

/** True for the route handler's "this path is not ours" answer. */
function isMissingRoute(status: number | null, wire: Wire<unknown> | null): boolean {
  if (status !== 404) return false
  if (wire === null) return true
  const message = wire.ok ? '' : wire.error?.message ?? ''
  return /not a coordination route/i.test(message)
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
  const { wire } = await call<SelectionState>(`/selection?session=${encodeURIComponent(sessionId)}`)
  if (wire === null || !wire.ok) return null
  return wire.value
}

export async function saveSelection(
  sessionId: string,
  patch: SelectionPatch,
): Promise<SelectionSaveOutcome> {
  const { wire } = await call<SelectionState>('/selection', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId, patch }),
  })
  // No fabricated prose here: user-facing fallback copy belongs to the locale
  // dictionary, so the outcome carries only the host's own fields.
  if (wire === null) return { state: null }
  if (!wire.ok) {
    return {
      state: null,
      code: wire.error?.code,
      message: wire.error?.message,
      ...(wire.error?.details === undefined ? {} : { details: wire.error.details }),
    }
  }
  return { state: wire.value }
}

/**
 * Rebuild the session's task with the requested profession (v24 §16).
 *
 * The host route is newer than the selection routes: on an old build the route
 * handler answers 404, which the caller must report as "upgrade the plugin"
 * rather than as a generic refusal.
 */
export async function rebuildProfession(
  sessionId: string,
  profession: Profession,
): Promise<ProfessionOutcome> {
  const { status, wire } = await call<SelectionState>('/profession/rebuild', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId, profession }),
  })
  return outcomeOf(status, wire)
}

/** Abandon the session's task; the next task may choose a new profession. */
export async function abandonProfession(sessionId: string): Promise<ProfessionOutcome> {
  const { status, wire } = await call<SelectionState>('/profession/abandon', {
    method: 'POST',
    body: JSON.stringify({ session: sessionId }),
  })
  return outcomeOf(status, wire)
}

function outcomeOf(status: number | null, wire: Wire<SelectionState> | null): ProfessionOutcome {
  const reached = status !== null
  if (wire === null) return { state: null, unsupported: isMissingRoute(status, wire), reached }
  if (!wire.ok) {
    return {
      state: null,
      code: wire.error?.code,
      message: wire.error?.message,
      ...(wire.error?.details === undefined ? {} : { details: wire.error.details }),
      unsupported: isMissingRoute(status, wire),
      reached,
    }
  }
  return { state: wire.value, unsupported: false, reached }
}

/* ------------------------------------------------------------------------- *
 * Service-level takeover: approvals and questions (v24 §16)
 * ------------------------------------------------------------------------- */

/** The two takeover request kinds the composer can answer. */
export type TakeoverType = 'approval' | 'question'

/** One selectable option of a question; DSH's option labels are the values. */
export interface TakeoverOptionView {
  label: string
  description?: string
}

/** One question of a `question` takeover, narrowed to what the UI renders. */
export interface TakeoverQuestionView {
  id: string
  question: string
  detail?: string
  header?: string
  options: TakeoverOptionView[]
  multiSelect: boolean
}

/** The `approval` payload, narrowed to the displayed fields. */
export interface TakeoverApprovalView {
  toolName: string
  reason: string
  /** Localised reasons from DSH, e.g. `{ en: '…', zh: '…' }`. */
  displayReason?: Record<string, unknown>
  callId?: string
}

/** One pending takeover request, as listed by the host. */
export interface TakeoverPendingView {
  handle: string
  type: TakeoverType
  /** The coordination session identity (a number), not the DSH session id. */
  session?: number
  payload: unknown
  created: number
}

/** The operator's local draft for one question. */
export interface QuestionSelection {
  selected: string[]
  custom: string
}

/** One answer in the exact host shape. */
export interface TakeoverQuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

/** Approval outcomes the answer route accepts. */
export type TakeoverApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/** The answer body posted to `/takeover/answer`. */
export type TakeoverAnswer =
  | { kind: 'approval'; outcome: TakeoverApprovalOutcome }
  | { kind: 'question'; answers: TakeoverQuestionAnswer[] }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Keep only well-formed pending entries; an unknown kind is not rendered. */
function normalisePending(value: unknown): TakeoverPendingView[] {
  if (!Array.isArray(value)) return []
  const result: TakeoverPendingView[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const handle = typeof record.handle === 'string' ? record.handle : ''
    const type = record.type
    if (handle.length === 0 || (type !== 'approval' && type !== 'question')) continue
    const session = typeof record.session === 'number' && Number.isFinite(record.session)
      ? record.session
      : undefined
    result.push({
      handle,
      type,
      // The host's `session` is the numeric coordination identity; anything
      // else is dropped (the DSH session id travels only in the query).
      ...(session === undefined ? {} : { session }),
      payload: record.payload,
      created: typeof record.created === 'number' ? record.created : 0,
    })
  }
  return result
}

/**
 * List the pending takeover requests of one session.
 *
 * A 2 s timeout keeps the poll from stacking requests behind a slow host. Any
 * failure resolves to `null`: the caller keeps the previous dialog and simply
 * polls again, so a transient network error never throws into render.
 */
export async function listPendingTakeover(sessionId: string): Promise<TakeoverPendingView[] | null> {
  const { wire } = await call<unknown>(
    `/takeover/pending?session=${encodeURIComponent(sessionId)}`,
    undefined,
    TAKEOVER_TIMEOUT,
  )
  if (wire === null || !wire.ok) return null
  return normalisePending(wire.value)
}

/** Result of `POST /takeover/answer`. */
export interface TakeoverAnswerOutcome {
  answered: boolean
  /** The host says the window is no longer pending (resolved elsewhere/expired). */
  expired: boolean
}

/**
 * Answer one takeover request.
 *
 * @returns `{ answered, expired }`, or `null` when the host was unreachable or
 * an old build has no route. A 404 that is not the route-missing envelope means
 * the window is gone, which the dialog shows as "this request is no longer
 * valid" rather than a generic failure. Never throws.
 */
export async function answerTakeover(
  handle: string,
  answer: TakeoverAnswer,
): Promise<TakeoverAnswerOutcome | null> {
  const { status, wire } = await call<unknown>(
    '/takeover/answer',
    { method: 'POST', body: JSON.stringify({ handle, answer }) },
    TAKEOVER_TIMEOUT,
  )
  if (wire === null) return null
  if (!wire.ok) {
    if (isMissingRoute(status, wire)) return null
    return { answered: false, expired: status === 404 }
  }
  const record = asRecord(wire.value)
  return { answered: record !== undefined && record.answered === true, expired: false }
}

/**
 * Cancel one takeover request (the dialog's 取消, `Esc` and backdrop click).
 *
 * @returns `{ cancelled }`, or `null` when the host was unreachable / refused.
 */
export async function cancelTakeover(handle: string): Promise<{ cancelled: boolean } | null> {
  const { wire } = await call<unknown>(
    '/takeover/cancel',
    { method: 'POST', body: JSON.stringify({ handle }) },
    TAKEOVER_TIMEOUT,
  )
  if (wire === null || !wire.ok) return null
  const record = asRecord(wire.value)
  return { cancelled: record !== undefined && record.cancelled === true }
}

/**
 * Build the exact `answers` array `/takeover/answer` expects.
 *
 * Pure and strict: an unanswered question, an option label that is not in the
 * request, or more than one selection for a single-select question throws
 * instead of sending a half answer. `selected` is always present (possibly empty
 * for a custom-only answer).
 *
 * The host rejects an answer that carries both a selected option and custom
 * text for a question that offers options, so `custom` is included only when no
 * option is selected (or the question has no options at all). The dialog also
 * disables the free-text field once an option is chosen, but the builder must
 * be correct on its own.
 */
export function buildQuestionAnswers(
  questions: readonly TakeoverQuestionView[],
  selection: Readonly<Record<string, QuestionSelection | undefined>>,
): TakeoverQuestionAnswer[] {
  return questions.map((question) => {
    const draft = selection[question.id]
    const selected = [...new Set(draft?.selected ?? [])]
    const custom = draft?.custom.trim() ?? ''
    if (selected.length === 0 && custom.length === 0) {
      throw new Error(`question ${question.id} has no answer`)
    }
    const labelLookup = new Set(question.options.map((option) => option.label))
    for (const label of selected) {
      if (!labelLookup.has(label)) {
        throw new Error(`question ${question.id} selected an option that is not offered: ${label}`)
      }
    }
    if (question.multiSelect !== true && selected.length > 1) {
      throw new Error(`question ${question.id} accepts only one option`)
    }
    const includeCustom = custom.length > 0 && (question.options.length === 0 || selected.length === 0)
    return {
      id: question.id,
      selected,
      ...(includeCustom ? { custom } : {}),
    }
  })
}

/** True when every question has a selection or custom text (submit enabled). */
export function isQuestionAnswerComplete(
  questions: readonly TakeoverQuestionView[],
  selection: Readonly<Record<string, QuestionSelection | undefined>>,
): boolean {
  try {
    buildQuestionAnswers(questions, selection)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------------- *
 * Full settings surface: GET /config and POST /config (v24 §19)
 * ------------------------------------------------------------------------- */

/** Outcome of `POST /deepseek-coordination/config`. */
export interface ConfigSaveOutcome {
  /** The host's post-write view, or `null` when the write was refused. */
  config: ConfigView | null
  applied: string[]
  ignored: string[]
  /** `plan.weights.*` paths the host re-normalised. */
  normalised: string[]
  /** True when DSH accepted the durable settings write. */
  persisted: boolean
  /** True when an old host build has no such route (404 route envelope). */
  unsupported: boolean
  /** False when the request never reached the host (offline / timeout). */
  reached: boolean
  code?: string
  message?: string
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** Narrow the wire answer without inventing any value. */
function asConfigView(value: unknown): ConfigView | null {
  const record = asRecord(value)
  const values = asRecord(record?.values)
  const defaults = asRecord(record?.defaults)
  if (values === undefined || defaults === undefined) return null
  return {
    values: values as unknown as ConfigView['values'],
    defaults: defaults as unknown as ConfigView['defaults'],
  }
}

/** Result of `GET /deepseek-coordination/config`. */
export interface ConfigLoadOutcome {
  config: ConfigView | null
  /** False when the request never reached the host (offline / timeout). */
  reached: boolean
  /** True when an old host build has no `/config` route. */
  unsupported: boolean
}

/**
 * Read the full redacted config the settings page renders.
 *
 * `config: null` means "unknown" (offline or an old host build); the page then
 * shows its blocked/offline state instead of fabricating values. The two flags
 * let it say which of the two happened.
 */
export async function loadConfig(): Promise<ConfigLoadOutcome> {
  const { status, wire } = await call<unknown>('/config')
  // A 404/501 means the host build has no config route at all (the running
  // plugin host predates it), not that it answered with a broken payload.
  const unsupported = isMissingRoute(status, wire) || status === 404 || status === 501
  const reached = status !== null
  if (wire === null || !wire.ok) return { config: null, reached, unsupported }
  return { config: asConfigView(wire.value), reached, unsupported }
}

/**
 * Apply one flat config patch on the host.
 *
 * The host validates the whitelist and the schema, applies the value live and
 * attempts a DSH settings write. A rejection keeps its typed code and message;
 * the settings page reverts its optimistic value and shows the reason.
 */
export async function saveConfig(patch: ConfigPatch): Promise<ConfigSaveOutcome> {
  const { status, wire } = await call<unknown>('/config', {
    method: 'POST',
    body: JSON.stringify({ patch }),
  })
  const unsupported = isMissingRoute(status, wire) || status === 404 || status === 501
  const reached = status !== null
  if (wire === null || !wire.ok) {
    return {
      config: null,
      applied: [],
      ignored: [],
      normalised: [],
      persisted: false,
      unsupported,
      reached,
      ...(wire !== null && !wire.ok && wire.error?.code !== undefined ? { code: wire.error.code } : {}),
      ...(wire !== null && !wire.ok && wire.error?.message !== undefined ? { message: wire.error.message } : {}),
    }
  }
  const record = asRecord(wire.value)
  return {
    config: asConfigView(record?.config),
    applied: stringArray(record?.applied),
    ignored: stringArray(record?.ignored),
    normalised: stringArray(record?.normalised),
    persisted: record?.persisted === true,
    unsupported: false,
    reached,
  }
}

/* ------------------------------------------------------------------------- *
 * Auto-compaction settings (host config)
 * ------------------------------------------------------------------------- */

/** The trigger thresholds the settings page offers, in percent. */
export const COMPACTION_THRESHOLD_OPTIONS: readonly number[] = [60, 70, 80, 88]

/** Accepted trigger range in percent; the host stores it as a 0.3–0.9 ratio. */
export const COMPACTION_THRESHOLD_MIN = 30
export const COMPACTION_THRESHOLD_MAX = 90

/** True when a value is a whole percentage in the accepted trigger range. */
export function isValidCompactionThreshold(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= COMPACTION_THRESHOLD_MIN
    && value <= COMPACTION_THRESHOLD_MAX
    && Math.round(value) === value
}

/**
 * The host stores `soft`/`hard` as utilisation ratios (0.3–0.9 / up to 0.98),
 * while the settings select speaks percent. These two helpers are the only
 * conversion point; the wire always carries the ratio.
 */
export function compactionPercent(ratio: unknown): number | undefined {
  return typeof ratio === 'number' && Number.isFinite(ratio)
    ? Math.round(ratio * 100)
    : undefined
}

/** Convert a percent choice to the host's 0–1 ratio. */
export function compactionRatio(percent: number): number {
  return Math.round(percent) / 100
}

/** The writable slice of the compaction config (soft/hard are 0–1 ratios). */
export interface CompactionPatch {
  auto?: boolean
  soft?: number
  hard?: number
}

/** Result of `POST /config/compaction`. */
export interface CompactionSaveOutcome {
  /** The values the host reports after the write, or `null` on failure. */
  values: CompactionPatch | null
  /** True when the host build has no such route (404 from the route handler). */
  unsupported: boolean
  /** False when the request never reached the host (offline / timeout). */
  reached: boolean
  code?: string
}

function finiteNumberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Persist the auto-compaction switch / trigger threshold on the host.
 *
 * `soft` and `hard` must be the host's 0–1 utilisation ratios (the settings
 * select converts its percent option with {@link compactionRatio}). The
 * settings page applies the patch optimistically and reverts it when this
 * resolves to `values: null`; a missing route is reported separately so the
 * page can say "set it in the configuration file" instead of blaming the input.
 */
export async function saveCompaction(patch: CompactionPatch): Promise<CompactionSaveOutcome> {
  const { status, wire } = await call<unknown>(
    '/config/compaction',
    { method: 'POST', body: JSON.stringify(patch) },
  )
  const unsupported = isMissingRoute(status, wire)
  const reached = status !== null
  if (wire === null || !wire.ok) {
    return {
      values: null,
      unsupported,
      reached,
      ...(wire !== null && !wire.ok && wire.error?.code !== undefined ? { code: wire.error.code } : {}),
    }
  }
  const record = asRecord(wire.value)
  const auto = typeof record?.auto === 'boolean' ? record.auto : undefined
  const soft = finiteNumberOf(record?.soft)
  const hard = finiteNumberOf(record?.hard)
  return {
    values: {
      ...(auto === undefined ? {} : { auto }),
      ...(soft === undefined ? {} : { soft }),
      ...(hard === undefined ? {} : { hard }),
    },
    unsupported: false,
    reached,
  }
}

/**
 * Tell the host half which language the client is showing (v24 §22).
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
