/**
 * The five composer dropdowns, their tooltips, and the composer-side display
 * preferences (v24 §15.1, `docs/ui-copy-v24.md`).
 *
 * Every control and every option carries a tooltip. No user-visible string is
 * written here: labels and hints come from the locale copy (`./i18n.ts`, backed
 * by `src/shared/i18n.ts`), the permission presets come from DSH through the
 * host, and the lock wording comes from the active turn. The five choices are
 * persisted through the host route; when the host is unreachable the same
 * controls keep working against a per-session localStorage copy and the tooltip
 * says so.
 *
 * Accessibility, honesty, and persistence rules kept deliberately explicit:
 *  - a locked profession trigger has an accessible name carrying the lock
 *    explanation; every option's MenuItem (the element that actually holds
 *    keyboard focus) carries the option label plus hint, so keyboard and screen
 *    reader users get the explanation without a mouse;
 *  - `SelectionState.tooltip === false` disables the tooltips but never the
 *    accessible names; the local "show hints" preference can only narrow that;
 *  - while the host state is still loading the selects stay disabled and a
 *    loading status line is shown instead of silently dropping changes;
 *  - a permission preset is never written locally: offline preset picks are
 *    rejected with the offline warning, and the trigger shows the real preset
 *    (or a neutral "follow DSH" state) rather than inventing one;
 *  - a rejected save reverts the optimistic choice to the last host-confirmed
 *    state before the notice is shown; `hostRef` is assigned only from a
 *    host-confirmed answer (load, flush, or replay), never from the optimistic
 *    click;
 *  - picking a full-access preset first opens a confirmation dialog: one click
 *    never grants full access;
 *  - a `PROFESSION_LOCKED` rejection opens a plugin-owned compact dialog
 *    (current vs requested profession plus rebuild/abandon/cancel) instead of a
 *    toast, because a toast cannot carry the recovery actions. This dialog does
 *    NOT intercept any DSH dialog: `conversation.takeover` is unavailable in
 *    this DSH build, so it is a form owned by this plugin, opened only after
 *    this plugin's own save was refused (v24 §16);
 *  - after reconnecting, offline edits are replayed to the host first and only
 *    then replaced by the host's confirmed state.
 *
 * This module also owns the three local display preferences (`:tooltips`,
 * `:compact`, `:refresh`) and the last host selection shared with the settings
 * page. Both live here — rather than in `store.ts` — because they are composer
 * state and this file is the only writer.
 */
import * as React from 'react'
import Select, { type SelectChangeEvent } from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import Fade from '@mui/material/Fade'
import { tooltipVisibility } from './tooltip-visibility.js'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import { ThemeProvider } from '@mui/material/styles'
import { theme } from './theme.js'
import {
  abandonProfession,
  clearLocal,
  loadSelection,
  localState,
  readLocal,
  rebuildProfession,
  saveSelection,
  usableSession,
  writeLocal,
} from './bridge.js'
import type { ProfessionOutcome, SelectionSaveOutcome } from './bridge.js'
import { useCopy } from './i18n.js'
import { takeoverStore, workflowStore } from './store.js'
import {
  InteractionValues,
  PermissionLabel,
  ProfessionValues,
  SandboxModeValues,
  SceneValues,
  ValidationValues,
  isOneOf,
  toCommandType,
  toInteraction,
  toProfession,
  toScene,
  toValidation,
} from '../shared/enum.js'
import type { ControlName, Profession, SandboxMode } from '../shared/enum.js'
import { fillTemplate } from '../shared/i18n.js'
import type { Copy } from '../shared/i18n.js'
import type {
  PermissionPresetView,
  SelectionCompactionView,
  SelectionPatch,
  SelectionState,
  SelectionStateConfig,
} from '../shared/selection.js'
import {
  SelectionStateCache,
  clearSelectStyles,
  selectStyle,
  selectionConfig,
  selectionStateSignature,
} from './selection-cache.js'

/** The host config projection, re-exported so the settings page keeps one path. */
export { selectionConfig } from './selection-cache.js'
export type { SelectionConfigView } from './selection-cache.js'

/** MUI's generics describe every overload; the plugin passes one narrow shape. */
const MuiSelect: React.ComponentType<Record<string, unknown>> =
  Select as unknown as React.ComponentType<Record<string, unknown>>
const MuiTooltip: React.ComponentType<Record<string, unknown>> =
  Tooltip as unknown as React.ComponentType<Record<string, unknown>>
const MuiFade: React.ComponentType<Record<string, unknown>> =
  Fade as unknown as React.ComponentType<Record<string, unknown>>
const MuiDialog: React.ComponentType<Record<string, unknown>> =
  Dialog as unknown as React.ComponentType<Record<string, unknown>>
const MuiDialogTitle: React.ComponentType<Record<string, unknown>> =
  DialogTitle as unknown as React.ComponentType<Record<string, unknown>>
const MuiDialogContent: React.ComponentType<Record<string, unknown>> =
  DialogContent as unknown as React.ComponentType<Record<string, unknown>>
const MuiDialogContentText: React.ComponentType<Record<string, unknown>> =
  DialogContentText as unknown as React.ComponentType<Record<string, unknown>>
const MuiDialogActions: React.ComponentType<Record<string, unknown>> =
  DialogActions as unknown as React.ComponentType<Record<string, unknown>>
const MuiButton: React.ComponentType<Record<string, unknown>> =
  Button as unknown as React.ComponentType<Record<string, unknown>>

/** Stable id linking the dialog's accessible name to its title. */
const ESCALATION_TITLE_ID = 'deepseek-coordination-escalation-title'
/** Accessible name of the full-access confirmation dialog. */
const FULL_ACCESS_TITLE_ID = 'deepseek-coordination-full-access-title'

/** Select sentinel for "no preset applied, follow the DSH default tier". */
const FOLLOW_DSH = ''

/* ------------------------------------------------------------------------- *
 * Host config projection (added to SelectionState by the host owner)
 * ------------------------------------------------------------------------- */

/**
 * The host's auto-compaction policy, re-exported for the settings page.
 *
 * The host now ships this block in `SelectionState.config`; the alias keeps the
 * settings import local while the shared type stays the single source of truth.
 */
export type CompactionConfigView = SelectionCompactionView

/**
 * Merge a host-confirmed compaction change into the shared selection feed.
 *
 * Called after `POST /config/compaction` succeeds: the settings page then shows
 * the values the host accepted even before the next selection poll arrives. The
 * composer ignores `compaction`, so this cannot change its render.
 */
export function applyLocalCompaction(patch: Partial<CompactionConfigView>): void {
  const current = feed.state
  if (current === null) return
  const config = selectionConfig(current)
  const nextConfig = {
    ...(config as SelectionStateConfig),
    compaction: { ...(config.compaction ?? {}), ...patch },
  } as SelectionStateConfig
  const next: SelectionState = { ...current, config: nextConfig }
  stateCache.set(current.session, next)
  feed = { ...feed, state: next }
  for (const listener of feedListeners) listener()
}

/** Narrow an unknown host value to a boolean; anything else is "unknown". */
export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Narrow an unknown host value to a finite number. */
export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Narrow an unknown host value to a non-empty string. */
export function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/* ------------------------------------------------------------------------- *
 * Local display preferences (v24 §3.2: tooltips / compact / refresh)
 * ------------------------------------------------------------------------- */

const TOOLTIPS_KEY = 'deepseek-coordination:tooltips'
const COMPACT_KEY = 'deepseek-coordination:compact'
const REFRESH_KEY = 'deepseek-coordination:refresh'

/** Selectable refresh intervals in seconds; 0 pauses the poll (v24 §3.6). */
export const REFRESH_OPTIONS: readonly number[] = [2, 5, 10, 0]

/** True once a localStorage read or write has failed in this page. */
let storageBlocked = false

/** True when the browser refused the local display preferences. */
export function localSettingsBlocked(): boolean {
  return storageBlocked
}

interface LocalPreference<T> {
  subscribe: (listener: () => void) => () => void
  snapshot: () => T
  /** Persist a user choice; it becomes explicit and stops following the host. */
  set: (value: T) => void
  /** Adopt a host default only while the user has never chosen. */
  adopt: (value: T) => void
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    storageBlocked = true
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    storageBlocked = true
  }
}

function createPreference<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | undefined,
  serialise: (value: T) => string,
): LocalPreference<T> {
  const raw = readStored(key)
  let explicit = raw !== null
  let value = raw === null ? fallback : parse(raw) ?? fallback
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => value,
    set: (next) => {
      explicit = true
      writeStored(key, serialise(next))
      if (value === next) return
      value = next
      notify()
    },
    adopt: (next) => {
      if (explicit || value === next) return
      value = next
      notify()
    },
  }
}

const booleanPreference = (key: string, fallback: boolean): LocalPreference<boolean> =>
  createPreference<boolean>(
    key,
    fallback,
    (raw) => (raw === '1' ? true : raw === '0' ? false : undefined),
    (value) => (value ? '1' : '0'),
  )

/** `显示提示`: on by default, host `ui.showTooltip` supplies the default. */
export const tooltipsStore = booleanPreference(TOOLTIPS_KEY, true)
/** `紧凑模式`: on by default, host `ui.compact` supplies the default. */
export const compactStore = booleanPreference(COMPACT_KEY, true)
/** `自动刷新间隔`: 5 s by default, host `ui.refreshInterval` supplies the default. */
export const refreshStore = createPreference<number>(
  REFRESH_KEY,
  5,
  (raw) => {
    const parsed = Number(raw)
    return REFRESH_OPTIONS.includes(parsed) ? parsed : undefined
  },
  String,
)

export function setTooltips(next: boolean): void {
  tooltipsStore.set(next)
}

export function setCompact(next: boolean): void {
  compactStore.set(next)
}

export function setRefreshSeconds(next: number): void {
  if (REFRESH_OPTIONS.includes(next)) refreshStore.set(next)
}

/** Map the host's millisecond interval onto the nearest selectable option. */
function refreshOption(milliseconds: number): number {
  if (milliseconds <= 2000) return 2
  if (milliseconds <= 5000) return 5
  return 10
}

/** Adopt the host defaults while the operator has never chosen locally. */
function adoptHostUiConfig(state: SelectionState): void {
  const config = selectionConfig(state)
  const showTooltip = readBoolean(config.showTooltip)
  if (showTooltip !== undefined) tooltipsStore.adopt(showTooltip)
  const refreshInterval = readNumber(config.refreshInterval)
  if (refreshInterval !== undefined) refreshStore.adopt(refreshOption(refreshInterval))
}

/* ------------------------------------------------------------------------- *
 * Last selection, shared with the settings page
 * ------------------------------------------------------------------------- */

/** The newest selection the composer has applied, for read-only settings rows. */
export interface SelectionFeed {
  readonly state: SelectionState | null
  readonly offline: boolean
  readonly session: string
}

const EMPTY_FEED: SelectionFeed = { state: null, offline: false, session: '' }

let feed: SelectionFeed = EMPTY_FEED
const feedListeners = new Set<() => void>()

/** Snapshot of the newest applied selection (stable between publishes). */
export function selectionFeed(): SelectionFeed {
  return feed
}

export function subscribeSelectionFeed(listener: () => void): () => void {
  feedListeners.add(listener)
  return () => {
    feedListeners.delete(listener)
  }
}

function publishSelectionFeed(state: SelectionState, offline: boolean, session: string): void {
  const previous = feed
  if (
    previous.state !== null &&
    previous.offline === offline &&
    previous.session === session &&
    selectionStateSignature(previous.state) === selectionStateSignature(state)
  ) {
    return
  }
  feed = { state, offline, session }
  for (const listener of feedListeners) listener()
}

/* ------------------------------------------------------------------------- *
 * Option projections
 * ------------------------------------------------------------------------- */

interface OptionView {
  value: string
  label: string
  hint: string
  disabled?: boolean
}

/** Option arrays are locale projections; they rebuild only when the locale does. */
function professionOptions(copy: Copy): OptionView[] {
  return ProfessionValues.map((value) => ({
    value,
    label: copy.professions[value].label,
    hint: copy.professions[value].hint,
  }))
}

function interactionOptions(copy: Copy): OptionView[] {
  return InteractionValues.map((value) => ({
    value,
    label: copy.interactions[value].label,
    hint: copy.interactions[value].hint,
  }))
}

function sceneOptions(copy: Copy): OptionView[] {
  return SceneValues.map((value) => ({
    value,
    label: copy.scenes[value].label,
    hint: copy.scenes[value].hint,
  }))
}

function validationOptions(copy: Copy): OptionView[] {
  return ValidationValues.map((value) => ({
    value,
    label: copy.validations[value].label,
    // The option tooltip is the doc string itself; the budget is part of it.
    hint: copy.validations[value].hint,
  }))
}

/** Fallback only when DSH exposes no preset catalog; selecting one explains why it cannot apply. */
function fallbackPermissionOptions(copy: Copy): OptionView[] {
  return SandboxModeValues.map((mode) => ({
    value: mode,
    label: copy.permissions[mode].label,
    hint: copy.permissions[mode].hint,
  }))
}

/** Offline placeholder; the host copy replaces it after the first load. */
const EMPTY_SELECTION = {
  session: '',
  profession: 'execution',
  interaction: 'think',
  scene: 'dialogue',
  validation: 'medium',
  command: 'none',
  locked: false,
  changed: 0,
} as const

/* ------------------------------------------------------------------------- *
 * Styles
 * ------------------------------------------------------------------------- */

/** Stable style objects: emotion must not regenerate a rule on every render. */
const ROW_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  flexWrap: 'wrap',
}
const STACK_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 4,
  minWidth: 0,
}
const WRAPPER_STYLE: React.CSSProperties = { display: 'inline-flex', lineHeight: 0 }
const OPTION_LABEL_STYLE: React.CSSProperties = { display: 'block', width: '100%' }
const NOTICE_STYLE: React.CSSProperties = {
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11,
  color: '#a15c00',
}
const LOADING_STYLE: React.CSSProperties = {
  ...NOTICE_STYLE,
  color: 'var(--dsw-alias-label-secondary, #666)',
}
const TITLE_LINE_STYLE: React.CSSProperties = { fontWeight: 600, marginBottom: 2 }
const BODY_LINE_STYLE: React.CSSProperties = { opacity: 0.85 }
const SUBTLE_LINE_STYLE: React.CSSProperties = { opacity: 0.7, marginTop: 4 }
const DIALOG_TITLE_SX = { fontSize: 14, fontWeight: 600, color: '#a15c00', paddingBottom: 0.5 }
const DIALOG_CONTENT_SX = { paddingTop: 0.5 }
const DIALOG_TEXT_SX = { fontSize: 12, marginBottom: 0.5 }
const DIALOG_ERROR_SX = { fontSize: 12, color: '#a15c00' }
const MENU_ITEM_COMPACT_SX = { fontSize: 12, minHeight: 28 }
const MENU_ITEM_ROOMY_SX = { fontSize: 13, minHeight: 34 }

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

/** Accessible name of one select: control label plus the current option label. */
function controlAria(copy: Copy, name: ControlName, current: string): string {
  return fillTemplate(copy.composer.controlAria, {
    control: copy.controls[name].label,
    currentLabel: copy.composer.currentLabel,
    current,
  })
}

function tooltipTitle(
  copy: Copy,
  name: ControlName,
  current: string,
  extra: string[],
  /** Replaces the normal control hint while the control is frozen. */
  hintOverride?: string,
): React.ReactNode {
  const lines = [
    React.createElement(
      'div',
      { key: 'title', style: TITLE_LINE_STYLE },
      fillTemplate(copy.composer.controlTitle, {
        control: copy.controls[name].label,
        currentLabel: copy.composer.currentLabel,
        current,
      }),
    ),
    React.createElement(
      'div',
      { key: 'hint', style: BODY_LINE_STYLE },
      hintOverride ?? copy.controls[name].hint,
    ),
  ]
  for (const line of extra) {
    if (line.length > 0) {
      lines.push(React.createElement('div', { key: `extra-${line}`, style: SUBTLE_LINE_STYLE }, line))
    }
  }
  return React.createElement('span', null, ...lines)
}

/**
 * The sandbox mode behind a preset, from `preset.sandbox`, the preset key
 * itself (fallback catalog), or the DSH label mapping. Never guessed: an
 * unknown preset returns `undefined` and gets no confirmation banner.
 */
export function presetSandbox(preset: PermissionPresetView): SandboxMode | undefined {
  if (isOneOf(preset.sandbox, SandboxModeValues)) return preset.sandbox
  if (isOneOf(preset.value, SandboxModeValues)) return preset.value
  for (const mode of SandboxModeValues) {
    if (preset.sandbox === PermissionLabel[mode]) return mode
    if (preset.value === PermissionLabel[mode]) return mode
  }
  return undefined
}

function permissionHint(copy: Copy, preset: PermissionPresetView): string {
  const parts: string[] = []
  if (preset.description !== undefined && preset.description.length > 0) parts.push(preset.description)
  const mode = presetSandbox(preset)
  parts.push(mode === undefined ? copy.composer.permissionPresetDefault : copy.permissions[mode].hint)
  if (preset.approval !== undefined && preset.approval.length > 0) {
    parts.push(fillTemplate(copy.composer.approvalPolicy, { approval: preset.approval }))
  }
  return parts.join(' ')
}

function permissionOptions(copy: Copy, presets: PermissionPresetView[], preset: string | undefined): OptionView[] {
  const options: OptionView[] = presets.length === 0
    ? fallbackPermissionOptions(copy)
    : presets.map((entry) => ({
      value: entry.value,
      label: entry.name,
      hint: permissionHint(copy, entry),
    }))
  // Keep the Select value inside its option list even for a preset the catalog
  // does not contain (custom preset, or no catalog at all).
  if (preset !== undefined && preset.length > 0 && !options.some((option) => option.value === preset)) {
    options.push({
      value: preset,
      label: preset,
      hint: copy.composer.customPreset,
    })
  }
  return options
}

function applyPatch(state: SelectionState, patch: SelectionPatch): SelectionState {
  const selection = { ...state.selection }
  if (patch.profession !== undefined) selection.profession = patch.profession
  if (patch.interaction !== undefined) selection.interaction = patch.interaction
  if (patch.scene !== undefined) selection.scene = patch.scene
  if (patch.validation !== undefined) selection.validation = patch.validation
  if (patch.command !== undefined) selection.command = patch.command
  return {
    ...state,
    selection,
    ...(patch.preset === undefined ? {} : { preset: patch.preset }),
  }
}

/** The offline edits that are safe to replay: only the five stored selection fields. */
function localPatch(sessionId: string): SelectionPatch {
  const stored = readLocal(sessionId)
  if (stored === null) return {}
  const patch: SelectionPatch = {}
  if (stored.profession !== undefined) patch.profession = toProfession(stored.profession)
  if (stored.interaction !== undefined) patch.interaction = toInteraction(stored.interaction)
  if (stored.scene !== undefined) patch.scene = toScene(stored.scene)
  if (stored.validation !== undefined) patch.validation = toValidation(stored.validation)
  if (stored.command !== undefined) patch.command = toCommandType(stored.command)
  return patch
}

function professionOf(value: unknown): Profession | undefined {
  return isOneOf(value, ProfessionValues) ? value : undefined
}

/** Localised reason shown in the escalation dialog after a failed action. */
function escalationFailureCopy(copy: Copy, outcome: ProfessionOutcome): string {
  if (outcome.unsupported) return copy.composer.escalationUnsupported
  if (!outcome.reached) return copy.composer.offlineLine
  if (outcome.code === 'INVALID_STATE') return copy.errors.INVALID_STATE
  if (outcome.code === 'INVALID_ARGUMENT') return copy.errors.INVALID_ARGUMENT
  return copy.composer.requestFailed
}

/** How a state reached the composer: confirmed by the host, local, or optimistic. */
type AcceptKind = 'host' | 'local' | 'optimistic'

/** The profession-lock escalation dialog's state (v24 §16). */
export interface EscalationState {
  /** The profession the locked task holds. */
  current: Profession
  /** The profession the operator tried to select. */
  requested: Profession
  /** Already-localised failure of the last rebuild/abandon attempt. */
  error: string | null
  busy: boolean
}

/* ------------------------------------------------------------------------- *
 * Selection hook
 * ------------------------------------------------------------------------- */

interface SelectionHook {
  state: SelectionState | null
  offline: boolean
  notice: string | null
  escalation: EscalationState | null
  setValue: (patch: SelectionPatch, immediate?: boolean) => void
  resolveEscalation: (action: 'rebuild' | 'abandon') => void
  dismissEscalation: () => void
  warn: (message: string) => void
}

/** Last known host selection per session, bounded so session history cannot grow the page. */
const stateCache = new SelectionStateCache()

/** Drop the composer's bounded caches; called when the plugin unmounts. */
export function clearComposerCaches(): void {
  stateCache.clear()
  clearSelectStyles()
}

function useSelection(sessionId: string, copy: Copy): SelectionHook {
  const [state, setState] = React.useState<SelectionState | null>(() => stateCache.get(sessionId) ?? null)
  const [offline, setOffline] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [escalation, setEscalation] = React.useState<EscalationState | null>(null)
  const refreshSeconds = React.useSyncExternalStore(refreshStore.subscribe, refreshStore.snapshot, refreshStore.snapshot)
  const stateRef = React.useRef<SelectionState | null>(stateCache.get(sessionId) ?? null)
  const hostRef = React.useRef<SelectionState | null>(null)
  const offlineRef = React.useRef(false)
  /**
   * True once offline edits exist that the host has not confirmed. It starts
   * from the persisted local copy, so edits made before a remount are replayed
   * too instead of being dropped when the host comes back.
   */
  const dirtyRef = React.useRef<boolean | null>(null)
  if (dirtyRef.current === null) dirtyRef.current = readLocal(sessionId) !== null
  const copyRef = React.useRef(copy)
  copyRef.current = copy
  const pendingRef = React.useRef<SelectionPatch>({})
  const timerRef = React.useRef<number | null>(null)
  const noticeTimerRef = React.useRef<number | null>(null)
  const aliveRef = React.useRef(true)
  /** Guards a double click on rebuild/abandon from sending two requests. */
  const escalationBusyRef = React.useRef(false)

  const accept = React.useCallback((next: SelectionState | null, kind: AcceptKind): void => {
    if (!aliveRef.current || next === null) return
    const local = kind === 'local'
    offlineRef.current = local
    setOffline(local)
    // The last host-confirmed state is the revert target of a rejected save. It
    // is assigned here only for a host answer — never for the optimistic click.
    if (kind === 'host') {
      hostRef.current = next
      adoptHostUiConfig(next)
    }
    publishSelectionFeed(next, local, sessionId)
    const previous = stateRef.current
    // The pinned poll signature covers the five choices and the legacy fields;
    // the phase-freeze map is compared alongside it so a plan/goal that ends
    // (or a new one that starts) re-renders the composer even when no choice
    // changed. Both checks are cheap and the encoding stays exactly the one the
    // complexity audit pinned.
    const sameSignature = previous !== null
      && selectionStateSignature(previous) === selectionStateSignature(next)
    const sameFrozen = previous !== null
      && JSON.stringify(previous.frozen ?? null) === JSON.stringify(next.frozen ?? null)
    if (sameSignature && sameFrozen) return
    stateRef.current = next
    stateCache.set(sessionId, next)
    setState(next)
  }, [sessionId])

  const flashNotice = React.useCallback((message: string): void => {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      if (aliveRef.current) setNotice(null)
    }, 4000)
  }, [])

  /** Open (or refresh) the escalation dialog for a locked profession. */
  const raiseEscalation = React.useCallback((outcome: Pick<SelectionSaveOutcome, 'details'>, attempted: SelectionPatch): void => {
    const details = outcome.details ?? {}
    const currentState = stateRef.current
    const current =
      professionOf(details.current) ??
      professionOf(currentState?.turn?.profession) ??
      professionOf(currentState?.selection.profession) ??
      'execution'
    const requested = professionOf(details.requested) ?? professionOf(attempted.profession) ?? current
    setEscalation({ current, requested, error: null, busy: false })
  }, [])

  const reject = React.useCallback((outcome: SelectionSaveOutcome, attempted: SelectionPatch): void => {
    const copyNow = copyRef.current
    if (outcome.code === 'PROFESSION_LOCKED') {
      raiseEscalation(outcome, attempted)
      return
    }
    if (outcome.code === 'INVALID_ARGUMENT') {
      flashNotice(copyNow.composer.invalidSelection)
      return
    }
    // The server names the frozen phase in `details`; say when it lifts instead
    // of a generic failure. Any other INVALID_STATE keeps the generic line.
    if (outcome.code === 'INVALID_STATE' && outcome.details?.phase === 'plan') {
      flashNotice(copyNow.composer.frozenPlanRejected)
      return
    }
    if (outcome.code === 'INVALID_STATE' && outcome.details?.phase === 'goal') {
      flashNotice(copyNow.composer.frozenGoalRejected)
      return
    }
    flashNotice(copyNow.composer.requestFailed)
  }, [flashNotice, raiseEscalation])

  /**
   * Poll the host. If the user changed something while offline, the local edits
   * are replayed first: a confirmed host state replaces them, a host refusal is
   * surfaced before the host's state wins, and an unreachable host keeps the
   * offline choice for the next poll. Host state is never silently discarded.
   */
  const refresh = React.useCallback(async (): Promise<void> => {
    const next = await loadSelection(sessionId)
    if (!aliveRef.current) return
    if (next !== null) {
      if (dirtyRef.current) {
        const replay = localPatch(sessionId)
        if (Object.keys(replay).length > 0) {
          const outcome = await saveSelection(sessionId, replay)
          if (!aliveRef.current) return
          if (outcome.state !== null) {
            clearLocal(sessionId)
            dirtyRef.current = false
            accept(outcome.state, 'host')
            return
          }
          if (outcome.code !== undefined || outcome.message !== undefined) {
            // The host answered and refused the replay: say so, then show truth.
            clearLocal(sessionId)
            dirtyRef.current = false
            accept(next, 'host')
            reject(outcome, replay)
            return
          }
          // Still unreachable: keep the offline choice; the next poll retries.
          return
        }
        dirtyRef.current = false
      }
      accept(next, 'host')
      return
    }
    const cached = stateCache.get(sessionId)
    if (cached !== null && cached !== undefined && offlineRef.current) return
    const local = localState(sessionId)
    accept(local, 'local')
  }, [accept, reject, sessionId])

  React.useEffect(() => {
    aliveRef.current = true
    void refresh()
    const interval = refreshSeconds > 0
      ? window.setInterval(() => {
        if (document.visibilityState === 'visible') void refresh()
      }, refreshSeconds * 1000)
      : null
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      aliveRef.current = false
      if (interval !== null) window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
      timerRef.current = null
      noticeTimerRef.current = null
    }
  }, [refresh, refreshSeconds])

  const flush = React.useCallback(async (): Promise<void> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const patch = pendingRef.current
    pendingRef.current = {}
    if (Object.keys(patch).length === 0) return
    const outcome = await saveSelection(sessionId, patch)
    if (!aliveRef.current) return
    if (outcome.state !== null) {
      accept(outcome.state, 'host')
      return
    }
    const hostAnswered = outcome.code !== undefined || outcome.message !== undefined
    const fresh = await loadSelection(sessionId)
    if (!aliveRef.current) return
    if (fresh !== null) {
      accept(fresh, 'host')
    } else if (hostRef.current !== null) {
      // Revert to the last host-confirmed state, never the optimistic value.
      // Mark offline only when the save itself never reached the host.
      accept(hostRef.current, hostAnswered ? 'optimistic' : 'local')
    } else {
      // No host state at all: fall back to the local copy, which never held the
      // optimistic patch because it was only written on an already-offline path.
      accept(localState(sessionId), 'local')
    }
    if (hostAnswered) reject(outcome, patch)
  }, [accept, reject, sessionId])

  const setValue = React.useCallback((patch: SelectionPatch, immediate = false): void => {
    const current = stateRef.current
    if (current === null) return
    // Phase freezes are enforced by the host too; this guard only keeps a stale
    // render from flashing an optimistic value the server will refuse anyway.
    if (
      patch.interaction !== undefined
      && patch.interaction !== current.selection.interaction
      && current.frozen?.interaction !== undefined
    ) {
      flashNotice(copyRef.current.composer.frozenByGoal)
      return
    }
    if (
      patch.validation !== undefined
      && patch.validation !== current.selection.validation
      && current.frozen?.validation !== undefined
    ) {
      flashNotice(copyRef.current.composer.frozenByPlan)
      return
    }
    // DSH owns the preset catalog; a permission preset must never be written to
    // the offline copy and then silently replayed as if it had been applied.
    if (patch.preset !== undefined && offlineRef.current) {
      flashNotice(copyRef.current.composer.permissionOffline)
      return
    }
    if (current.locked && patch.profession !== undefined && patch.profession !== current.turn?.profession) {
      // Defensive: the trigger is disabled while locked, but a stale render must
      // still land on the escalation dialog with both recovery actions.
      raiseEscalation({}, patch)
      return
    }
    const optimistic = applyPatch(current, patch)
    accept(optimistic, offlineRef.current ? 'local' : 'optimistic')
    if (offlineRef.current) {
      writeLocal(sessionId, {
        ...(patch.profession === undefined ? {} : { profession: patch.profession }),
        ...(patch.interaction === undefined ? {} : { interaction: patch.interaction }),
        ...(patch.scene === undefined ? {} : { scene: patch.scene }),
        ...(patch.validation === undefined ? {} : { validation: patch.validation }),
        ...(patch.command === undefined ? {} : { command: patch.command }),
      })
      dirtyRef.current = true
      return
    }
    pendingRef.current = { ...pendingRef.current, ...patch }
    if (immediate) {
      void flush()
      return
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => { void flush() }, 120)
  }, [accept, flashNotice, flush, raiseEscalation, sessionId])

  /** Run the selected recovery action from the escalation dialog. */
  const resolveEscalation = React.useCallback((action: 'rebuild' | 'abandon'): void => {
    if (escalation === null || escalation.busy || escalationBusyRef.current) return
    escalationBusyRef.current = true
    const active = escalation
    setEscalation({ ...active, busy: true, error: null })
    void (async () => {
      const outcome = action === 'rebuild'
        ? await rebuildProfession(sessionId, active.requested)
        : await abandonProfession(sessionId)
      escalationBusyRef.current = false
      if (!aliveRef.current) return
      if (outcome.state !== null) {
        setEscalation(null)
        accept(outcome.state, 'host')
        return
      }
      setEscalation({
        ...active,
        busy: false,
        error: escalationFailureCopy(copyRef.current, outcome),
      })
    })()
  }, [accept, escalation, sessionId])

  /** Close the escalation dialog without a recovery action (the 取消 button). */
  const dismissEscalation = React.useCallback((): void => {
    setEscalation((current) => (current !== null && current.busy ? current : null))
  }, [])

  return {
    state,
    offline,
    notice,
    escalation,
    setValue,
    resolveEscalation,
    dismissEscalation,
    warn: flashNotice,
  }
}

/* ------------------------------------------------------------------------- *
 * Presentational pieces
 * ------------------------------------------------------------------------- */

/**
 * Confirmation dialog before a full-access preset is written (v24 §16 policy).
 *
 * A modal, not an inline banner: the previous inline form sat inside the
 * composer's control row, where it overlapped the tooltip layer and stole
 * pointer events from the trigger. A dialog renders in a portal above every
 * tooltip, traps focus, and answers `Esc`/backdrop through `onClose`.
 */
function FullAccessConfirmDialog(props: {
  copy: Copy
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement {
  const { copy } = props
  const dismiss = (): void => {
    if (!props.busy) props.onCancel()
  }
  return React.createElement(
    MuiDialog,
    {
      open: true,
      onClose: dismiss,
      maxWidth: 'xs',
      'aria-labelledby': FULL_ACCESS_TITLE_ID,
      // Tooltips sit at z-index 1500; a confirmation modal must stay above them.
      sx: { zIndex: (theme: { zIndex: { tooltip: number } }) => theme.zIndex.tooltip + 1 },
    },
    React.createElement(
      MuiDialogTitle,
      { id: FULL_ACCESS_TITLE_ID, sx: DIALOG_TITLE_SX },
      copy.composer.permissionConfirmTitle,
    ),
    React.createElement(
      MuiDialogContent,
      { sx: DIALOG_CONTENT_SX },
      React.createElement(MuiDialogContentText, { sx: DIALOG_TEXT_SX }, copy.composer.permissionConfirmBody),
    ),
    React.createElement(
      MuiDialogActions,
      null,
      React.createElement(
        MuiButton,
        { onClick: dismiss, disabled: props.busy, size: 'small' },
        copy.composer.permissionConfirmCancel,
      ),
      React.createElement(
        MuiButton,
        { onClick: props.onConfirm, disabled: props.busy, size: 'small', variant: 'contained', color: 'warning' },
        copy.composer.permissionConfirmAccept,
      ),
    ),
  )
}

/**
 * The profession-lock escalation form (v24 §16).
 *
 * A plugin-owned compact MUI Dialog — not a takeover of a DSH dialog. DSH's
 * `conversation.takeover` slot is unavailable in this build, so this form opens
 * only after one of this plugin's own saves was refused with
 * `PROFESSION_LOCKED`. MUI supplies `role="dialog"`, the focus trap, initial
 * focus and `Esc` handling; a busy rebuild/abandon cannot be dismissed.
 *
 * The cancel button reuses `composer.permissionConfirmCancel` (“取消”/“Cancel”):
 * one word, one key, no second copy.
 */
function EscalationDialog(props: {
  copy: Copy
  escalation: EscalationState
  onResolve: (action: 'rebuild' | 'abandon') => void
  onCancel: () => void
}): React.ReactElement {
  const { copy, escalation } = props
  const current = copy.professions[escalation.current]?.label ?? escalation.current
  const requested = copy.professions[escalation.requested]?.label ?? escalation.requested
  const close = (): void => {
    if (escalation.busy) return
    props.onCancel()
  }
  const action = (label: string, onClick: () => void): React.ReactElement =>
    React.createElement(MuiButton, { onClick, disabled: escalation.busy, size: 'small' }, label)
  return React.createElement(
    MuiDialog,
    {
      open: true,
      onClose: close,
      maxWidth: 'xs',
      'aria-labelledby': ESCALATION_TITLE_ID,
    },
    React.createElement(
      MuiDialogTitle,
      { id: ESCALATION_TITLE_ID, sx: DIALOG_TITLE_SX },
      copy.composer.professionLockedRebuild,
    ),
    React.createElement(
      MuiDialogContent,
      { sx: DIALOG_CONTENT_SX },
      React.createElement(
        MuiDialogContentText,
        { sx: DIALOG_TEXT_SX },
        fillTemplate(copy.composer.escalationCurrent, { profession: current }),
      ),
      React.createElement(
        MuiDialogContentText,
        { sx: DIALOG_TEXT_SX },
        fillTemplate(copy.composer.escalationRequested, { profession: requested }),
      ),
      escalation.error === null
        ? null
        : React.createElement(
          MuiDialogContentText,
          { sx: DIALOG_ERROR_SX, role: 'status' },
          escalation.error,
        ),
    ),
    React.createElement(
      MuiDialogActions,
      null,
      action(copy.composer.escalationRebuild, () => props.onResolve('rebuild')),
      action(copy.composer.escalationAbandon, () => props.onResolve('abandon')),
      action(copy.composer.permissionConfirmCancel, close),
    ),
  )
}

function Dropdown(props: {
  control: ControlName
  copy: Copy
  value: string
  options: OptionView[]
  disabled?: boolean
  title: React.ReactNode
  /** Overrides the trigger's accessible name (locked profession). */
  triggerLabel?: string
  /** False when the host disables tooltips; accessible names stay. */
  tooltips: boolean
  width: number
  compact: boolean
  onChange: (value: string) => void
}): React.ReactElement {
  const current = props.options.find((option) => option.value === props.value)
  const label = current?.label ?? props.value
  const ariaLabel = controlAria(props.copy, props.control, label)
  // One local tooltip per control, but every path that can leave it visible is
  // explicit: click, selection, menu open, mouseout and mouseleave all close it.
  // No state is changed on pointerdown/mousedown, so the first click still opens
  // the menu (closing on mousedown would swallow the Select's click).
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [hoverOpen, setHoverOpen] = React.useState(false)
  const [focusOpen, setFocusOpen] = React.useState(false)
  const tooltipId = React.useId()
  const activeTooltip = React.useSyncExternalStore(
    tooltipVisibility.subscribe,
    tooltipVisibility.getSnapshot,
    tooltipVisibility.getSnapshot,
  )
  // Only one composer tooltip may be visible. Each control keeps its own MUI
  // Tooltip/anchor (stable layout), but `open` additionally requires ownership.
  const triggerTooltipOpen =
    props.tooltips && !menuOpen && activeTooltip === tooltipId && (hoverOpen || focusOpen)
  const closeTooltip = (): void => {
    setHoverOpen(false)
    setFocusOpen(false)
    tooltipVisibility.release(tooltipId)
  }
  const openTooltip = (): void => {
    if (menuOpen) return
    setHoverOpen(true)
    tooltipVisibility.request(tooltipId)
  }
  const optionAria = (option: OptionView): string => fillTemplate(props.copy.composer.optionAria, {
    label: option.label,
    hint: option.hint,
  })
  const select = React.createElement(
    MuiSelect,
    {
      value: props.value,
      onChange: (event: SelectChangeEvent<unknown>) => {
        setMenuOpen(false)
        closeTooltip()
        props.onChange(String(event.target.value))
      },
      disabled: props.disabled === true,
      renderValue: () => label,
      // MUI only calls renderValue for a filled value unless displayEmpty is
      // set; the permission trigger uses the empty sentinel for "follow DSH".
      displayEmpty: true,
      inputProps: { 'aria-label': ariaLabel },
      onOpen: () => {
        setMenuOpen(true)
        closeTooltip()
      },
      onClose: () => { setMenuOpen(false) },
      sx: selectStyle(props.width, props.compact),
    },
    props.options.map((option) => {
      const labelSpan = React.createElement(
        'span',
        { style: OPTION_LABEL_STYLE, tabIndex: -1 },
        option.label,
      )
      // MUI Select requires the MenuItem to be its DIRECT child: it reads
      // child.props.value/onClick to select. The Tooltip therefore lives inside
      // the item, around the label span, never around the MenuItem itself.
      const body = props.tooltips
        ? React.createElement(
            MuiTooltip,
            { title: option.hint, placement: 'right', describeChild: true, enterDelay: 250, disableInteractive: true },
            labelSpan,
          )
        : labelSpan
      return React.createElement(
        MenuItem,
        {
          key: option.value,
          value: option.value,
          disabled: option.disabled === true,
          sx: props.compact ? MENU_ITEM_COMPACT_SX : MENU_ITEM_ROOMY_SX,
          // Accessible names never depend on the visual tooltip setting.
          'aria-label': optionAria(option),
        },
        body,
      )
    }),
  )
  const trigger = React.createElement(
    'span',
    {
      style: WRAPPER_STYLE,
      tabIndex: props.disabled === true ? 0 : -1,
      ...(props.triggerLabel === undefined ? {} : { 'aria-label': props.triggerLabel }),
      onMouseEnter: () => { openTooltip() },
      onMouseLeave: () => { closeTooltip() },
      onMouseOut: (event: React.MouseEvent<HTMLSpanElement>) => {
        const related = event.relatedTarget as Node | null
        if (related === null || !event.currentTarget.contains(related)) closeTooltip()
      },
      onClick: () => { closeTooltip() },
      onFocus: () => { openTooltip() },
      onBlur: () => { closeTooltip() },
    },
    select,
  )
  if (!props.tooltips) return trigger
  return React.createElement(
    MuiTooltip,
    {
      title: props.title,
      placement: 'right',
      describeChild: true,
      disableInteractive: true,
      leaveDelay: 0,
      open: triggerTooltipOpen,
      // Fade-out only. The popper is pointer-transparent, so the 160 ms exit
      // cannot block the Select menu underneath it.
      TransitionComponent: MuiFade,
      slotProps: {
        transition: {
          timeout: { enter: 90, exit: 160 },
          easing: {
            enter: 'cubic-bezier(0.2, 0, 0, 1)',
            exit: 'cubic-bezier(0.4, 0, 1, 1)',
          },
        },
        popper: { style: { pointerEvents: 'none' } },
      },
      onOpen: () => { openTooltip() },
      onClose: () => { closeTooltip() },
    },
    trigger,
  )
}

export interface ComposerControlsProps {
  sessionId?: string
}

/**
 * The composer row. `sessionId` is the framework-injected session seat; without
 * it the controls still work against a `default` local copy.
 */
export const ComposerControls = React.memo(function ComposerControlsInner(
  props: ComposerControlsProps,
): React.ReactElement {
  const copy = useCopy()
  const takeoverOn = React.useSyncExternalStore(takeoverStore.subscribe, takeoverStore.snapshot, takeoverStore.snapshot)
  const workflowOn = React.useSyncExternalStore(workflowStore.subscribe, workflowStore.snapshot, workflowStore.snapshot)
  const compact = React.useSyncExternalStore(compactStore.subscribe, compactStore.snapshot, compactStore.snapshot)
  const tooltipsPreference = React.useSyncExternalStore(
    tooltipsStore.subscribe,
    tooltipsStore.snapshot,
    tooltipsStore.snapshot,
  )
  const sessionId = usableSession(props.sessionId) ? props.sessionId : 'default'
  const {
    state,
    offline,
    notice,
    escalation,
    setValue,
    resolveEscalation,
    dismissEscalation,
    warn,
  } = useSelection(sessionId, copy)
  /** A full-access preset waiting for the second, explicit confirmation. */
  const [pendingFullAccess, setPendingFullAccess] = React.useState<{ value: string } | null>(null)

  // Locale projections only: `copy` is the frozen per-locale object, so these
  // arrays are rebuilt on a language change and never on a composer keystroke.
  const options = React.useMemo(() => ({
    profession: professionOptions(copy),
    interaction: interactionOptions(copy),
    scene: sceneOptions(copy),
    validation: validationOptions(copy),
  }), [copy])

  const ready = state !== null
  // The host's `showTooltip` is the outer gate; the local preference can only
  // narrow it, never resurrect tooltips the deployment disabled.
  const tooltipsOn = (state === null ? true : state.tooltip !== false) && tooltipsPreference
  const selection = state?.selection ?? EMPTY_SELECTION
  const locked = state?.locked === true
  // Phase freezes arrive from the host on every poll: the client never stores a
  // latch, so a plan that finishes or a goal that is cleared unfreezes the
  // dropdown on the next answer (and a newly created plan/goal freezes again).
  const frozen = state?.frozen
  const frozenInteraction = frozen?.interaction
  const frozenValidation = frozen?.validation
  const turnProfession = state?.turn?.profession
  const profession = locked && turnProfession !== undefined ? turnProfession : selection.profession
  // Host values are normalised, but a stale/unknown value must degrade to its
  // canonical id rather than crash the composer.
  const professionLabel = copy.professions[profession]?.label ?? profession
  const interactionLabel = copy.interactions[selection.interaction]?.label ?? selection.interaction
  const sceneLabel = copy.scenes[selection.scene]?.label ?? selection.scene
  const validationLabel = copy.validations[selection.validation]?.label ?? selection.validation
  const lockLine = locked ? copy.composer.lockedLine : copy.composer.unlockedLine
  const offlineLine = offline ? copy.composer.offlineLine : ''
  const statusLine = notice !== null ? notice : offlineLine
  const loadingLine = ready ? null : copy.composer.loadingSelection
  const presetCount = state?.presets.length ?? 0

  const children: React.ReactNode[] = []

  if (takeoverOn) {
    const permissionList = permissionOptions(copy, state?.presets ?? [], state?.preset)
    // Never fabricate a preset: no applied preset means "follow DSH", optionally
    // naming the deployment default mode the host reports.
    const appliedPreset = state?.preset !== undefined && state.preset.length > 0 ? state.preset : undefined
    const defaultMode =
      state?.defaultMode !== undefined && isOneOf(state.defaultMode, SandboxModeValues)
        ? state.defaultMode
        : undefined
    const followLabel = defaultMode === undefined
      ? copy.composer.followDsh
      : fillTemplate(copy.composer.followDshMode, { mode: copy.permissions[defaultMode].label })
    const value = appliedPreset ?? FOLLOW_DSH
    const label = appliedPreset === undefined
      ? followLabel
      : permissionList.find((option) => option.value === appliedPreset)?.label ?? appliedPreset
    const choices: OptionView[] = appliedPreset === undefined
      ? [{ value: FOLLOW_DSH, label: followLabel, hint: copy.composer.permissionFollowHint, disabled: true }, ...permissionList]
      : permissionList
    const catalogLine = presetCount === 0 ? copy.composer.permissionCatalogMissing : ''
    const permissionTitle = tooltipTitle(copy, 'permission', label, [
      ...(appliedPreset === undefined ? [copy.composer.permissionFollowHint] : []),
      ...(catalogLine.length > 0 ? [catalogLine] : []),
      copy.composer.permissionWriteNow,
      ...(statusLine.length > 0 ? [statusLine] : []),
    ])
    children.push(React.createElement(Dropdown, {
      key: 'permission',
      control: 'permission',
      copy,
      value,
      options: choices,
      disabled: !ready,
      title: permissionTitle,
      tooltips: tooltipsOn,
      width: compact ? 124 : 140,
      compact,
      onChange: (next: string) => {
        if (next === FOLLOW_DSH) return
        if (!ready) return
        if (next === appliedPreset) return
        if (offline || presetCount === 0) {
          warn(offline ? copy.composer.permissionOffline : copy.composer.permissionApplyFailed)
          return
        }
        // Full access needs a second, explicit confirmation: selecting the preset
        // alone must never grant it. The catalog entry is authoritative; a custom
        // preset is matched by its own value/label through `presetSandbox`.
        const chosen = state?.presets.find((entry) => entry.value === next) ?? { value: next, name: next }
        if (presetSandbox(chosen) === 'danger-full-access') {
          setPendingFullAccess({ value: next })
          return
        }
        setPendingFullAccess(null)
        setValue({ preset: next }, true)
      },
    }))
    if (pendingFullAccess !== null) {
      children.push(React.createElement(FullAccessConfirmDialog, {
        key: 'permission-confirm',
        copy,
        busy: false,
        onConfirm: () => {
          const pending = pendingFullAccess
          setPendingFullAccess(null)
          setValue({ preset: pending.value }, true)
        },
        onCancel: () => { setPendingFullAccess(null) },
      }))
    }
  }

  if (workflowOn) {
    const professionTitle = tooltipTitle(copy, 'profession', professionLabel, [
      lockLine,
      ...(statusLine.length > 0 ? [statusLine] : []),
    ])
    children.push(
      React.createElement(Dropdown, {
        key: 'profession',
        control: 'profession',
        copy,
        value: profession,
        options: options.profession,
        disabled: locked || !ready,
        title: professionTitle,
        triggerLabel: locked
          ? fillTemplate(copy.composer.lockedAria, {
            control: copy.controls.profession.label,
            currentLabel: copy.composer.currentLabel,
            current: professionLabel,
            explanation: lockLine,
          })
          : undefined,
        tooltips: tooltipsOn,
        width: compact ? 96 : 110,
        compact,
        onChange: (next: string) => { setValue({ profession: next as typeof selection.profession }) },
      }),
      React.createElement(Dropdown, {
        key: 'interaction',
        control: 'interaction',
        copy,
        value: selection.interaction,
        options: options.interaction,
        disabled: !ready || frozenInteraction !== undefined,
        title: tooltipTitle(
          copy,
          'interaction',
          interactionLabel,
          [...(statusLine.length > 0 ? [statusLine] : [])],
          // The normal hint is replaced while frozen, so the tooltip itself
          // explains the freeze and when it lifts.
          frozenInteraction === undefined ? undefined : copy.composer.frozenByGoal,
        ),
        triggerLabel: frozenInteraction === undefined
          ? undefined
          : fillTemplate(copy.composer.lockedAria, {
            control: copy.controls.interaction.label,
            currentLabel: copy.composer.currentLabel,
            current: interactionLabel,
            explanation: copy.composer.frozenByGoal,
          }),
        tooltips: tooltipsOn,
        width: compact ? 96 : 110,
        compact,
        onChange: (next: string) => { setValue({ interaction: next as typeof selection.interaction }) },
      }),
      React.createElement(Dropdown, {
        key: 'scene',
        control: 'scene',
        copy,
        value: selection.scene,
        options: options.scene,
        disabled: !ready,
        title: tooltipTitle(copy, 'scene', sceneLabel, [
          ...(statusLine.length > 0 ? [statusLine] : []),
        ]),
        tooltips: tooltipsOn,
        width: compact ? 92 : 106,
        compact,
        onChange: (next: string) => { setValue({ scene: next as typeof selection.scene }) },
      }),
      React.createElement(Dropdown, {
        key: 'validation',
        control: 'validation',
        copy,
        value: selection.validation,
        options: options.validation,
        disabled: !ready || frozenValidation !== undefined,
        title: tooltipTitle(
          copy,
          'validation',
          validationLabel,
          [
            // v24 §6.3: every level searches; only the budget and scope differ.
            ...(frozenValidation === undefined ? [copy.composer.validationNote] : []),
            ...(statusLine.length > 0 ? [statusLine] : []),
          ],
          frozenValidation === undefined ? undefined : copy.composer.frozenByPlan,
        ),
        triggerLabel: frozenValidation === undefined
          ? undefined
          : fillTemplate(copy.composer.lockedAria, {
            control: copy.controls.validation.label,
            currentLabel: copy.composer.currentLabel,
            current: validationLabel,
            explanation: copy.composer.frozenByPlan,
          }),
        tooltips: tooltipsOn,
        width: compact ? 88 : 100,
        compact,
        onChange: (next: string) => { setValue({ validation: next as typeof selection.validation }) },
      }),
    )
  }

  const escalationDialog = escalation === null
    ? null
    : React.createElement(EscalationDialog, {
      copy,
      escalation,
      onResolve: resolveEscalation,
      onCancel: dismissEscalation,
    })

  if (children.length === 0) {
    // Both composer switches are off, but a refusal raised before they were
    // switched off still owns a dialog; do not strand it.
    return escalationDialog === null
      ? React.createElement(React.Fragment, null)
      : React.createElement(ThemeProvider, { theme }, escalationDialog)
  }

  const rowStatus = notice !== null ? notice : loadingLine
  return React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(
      'div',
      { style: STACK_STYLE },
      React.createElement(
        'div',
        { style: ROW_STYLE },
        ...children,
        rowStatus === null
          ? React.createElement(React.Fragment, null)
          : React.createElement(
            'span',
            { style: notice !== null ? NOTICE_STYLE : LOADING_STYLE, role: 'status' },
            rowStatus,
          ),
      ),
      escalationDialog,
    ),
  )
})

export { EMPTY_SELECTION }
