/**
 * The five composer dropdowns and their tooltips (v23 §15.1).
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
 *    accessible names;
 *  - while the host state is still loading the selects stay disabled and a
 *    loading status line is shown instead of silently dropping changes;
 *  - a permission preset is never written locally: offline preset picks are
 *    rejected with the offline warning, and the trigger shows the real preset
 *    (or a neutral "follow DSH" state) rather than inventing one;
 *  - a rejected save reverts the optimistic choice to the last host-confirmed
 *    state before the notice is shown;
 *  - after reconnecting, offline edits are replayed to the host first and only
 *    then replaced by the host's confirmed state.
 */
import * as React from 'react'
import Select, { type SelectChangeEvent } from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import { ThemeProvider } from '@mui/material/styles'
import { theme } from './theme.js'
import {
  clearLocal,
  loadSelection,
  localState,
  readLocal,
  saveSelection,
  usableSession,
  writeLocal,
} from './bridge.js'
import { useCopy } from './i18n.js'
import { takeoverStore, workflowStore } from './store.js'
import {
  InteractionValues,
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
import type { ControlName, SandboxMode } from '../shared/enum.js'
import { fillTemplate } from '../shared/i18n.js'
import type { Copy } from '../shared/i18n.js'
import type { PermissionPresetView, SelectionPatch, SelectionState } from '../shared/selection.js'

/** MUI's generics describe every overload; the plugin passes one narrow shape. */
const MuiSelect: React.ComponentType<Record<string, unknown>> =
  Select as unknown as React.ComponentType<Record<string, unknown>>
const MuiTooltip: React.ComponentType<Record<string, unknown>> =
  Tooltip as unknown as React.ComponentType<Record<string, unknown>>

/** Select sentinel for "no preset applied, follow the DSH default tier". */
const FOLLOW_DSH = ''

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
    hint: copy.validations[value].tooltip,
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

/** Stable style objects: emotion must not regenerate a rule on every render. */
const ROW_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
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

const widthCache = new Map<number, Record<string, unknown>>()

function selectSx(width: number): Record<string, unknown> {
  let sx = widthCache.get(width)
  if (sx === undefined) {
    sx = { width, fontSize: 12, height: 28, backgroundColor: 'transparent' }
    widthCache.set(width, sx)
  }
  return sx
}

const MENU_ITEM_SX = { fontSize: 12, minHeight: 28 }

/** Accessible name of one select: control label plus the current option label. */
function controlAria(copy: Copy, name: ControlName, current: string): string {
  return fillTemplate(copy.composer.controlAria, {
    control: copy.controls[name].label,
    currentLabel: copy.composer.currentLabel,
    current,
  })
}

function tooltipTitle(copy: Copy, name: ControlName, current: string, extra: string[]): React.ReactNode {
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
    React.createElement('div', { key: 'hint', style: BODY_LINE_STYLE }, copy.controls[name].hint),
  ]
  for (const line of extra) {
    if (line.length > 0) {
      lines.push(React.createElement('div', { key: `extra-${line}`, style: SUBTLE_LINE_STYLE }, line))
    }
  }
  return React.createElement('span', null, ...lines)
}

function permissionHint(copy: Copy, preset: PermissionPresetView): string {
  const parts: string[] = []
  if (preset.description !== undefined && preset.description.length > 0) parts.push(preset.description)
  const mode: SandboxMode | undefined =
    preset.sandbox !== undefined && isOneOf(preset.sandbox, SandboxModeValues)
      ? preset.sandbox
      : isOneOf(preset.value, SandboxModeValues)
        ? preset.value
        : undefined
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

function stateSignature(state: SelectionState): string {
  return JSON.stringify([
    state.locked,
    state.preset ?? '',
    state.selection.profession,
    state.selection.interaction,
    state.selection.scene,
    state.selection.validation,
    state.selection.command,
    state.turn?.identity ?? 0,
    state.turn?.profession ?? '',
    state.presets.map((preset) => [preset.value, preset.name, preset.description ?? '', preset.sandbox ?? '']),
    state.tooltip,
  ])
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

interface SelectionHook {
  state: SelectionState | null
  offline: boolean
  notice: string | null
  setValue: (patch: SelectionPatch, immediate?: boolean) => void
  warn: (message: string) => void
}

const stateCache = new Map<string, SelectionState>()

function useSelection(sessionId: string, copy: Copy): SelectionHook {
  const [state, setState] = React.useState<SelectionState | null>(() => stateCache.get(sessionId) ?? null)
  const [offline, setOffline] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
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

  const accept = React.useCallback((next: SelectionState | null, local: boolean): void => {
    if (!aliveRef.current || next === null) return
    offlineRef.current = local
    setOffline(local)
    // The last host-confirmed state is the revert target of a rejected save.
    if (!local) hostRef.current = next
    const previous = stateRef.current
    if (previous !== null && stateSignature(previous) === stateSignature(next)) return
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
            accept(outcome.state, false)
            return
          }
          const copyNow = copyRef.current
          if (outcome.code !== undefined || outcome.message !== undefined) {
            // The host answered and refused the replay: say so, then show truth.
            clearLocal(sessionId)
            dirtyRef.current = false
            if (outcome.code === 'PROFESSION_LOCKED') {
              flashNotice(copyNow.composer.professionLockedRebuild)
            } else if (outcome.code === 'INVALID_ARGUMENT') {
              flashNotice(fillTemplate(copyNow.composer.invalidSelection, {
                message: outcome.message ?? copyNow.composer.requestFailed,
              }))
            } else {
              flashNotice(outcome.message ?? copyNow.composer.requestFailed)
            }
            accept(next, false)
            return
          }
          // Still unreachable: keep the offline choice; the next poll retries.
          return
        }
        dirtyRef.current = false
      }
      accept(next, false)
      return
    }
    const cached = stateCache.get(sessionId)
    if (cached !== null && cached !== undefined && offlineRef.current) return
    const local = localState(sessionId)
    accept(local, true)
  }, [accept, flashNotice, sessionId])

  React.useEffect(() => {
    aliveRef.current = true
    void refresh()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 5000)
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      aliveRef.current = false
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
      timerRef.current = null
      noticeTimerRef.current = null
    }
  }, [refresh])

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
      accept(outcome.state, false)
      return
    }
    const fresh = await loadSelection(sessionId)
    if (!aliveRef.current) return
    if (fresh !== null) {
      accept(fresh, false)
    } else if (hostRef.current !== null) {
      // The host answered and then lost the route, or rejected the write: show
      // its last confirmed state, never the optimistic value. Mark offline when
      // the save itself never reached the host.
      const hostAnswered = outcome.code !== undefined || outcome.message !== undefined
      accept(hostRef.current, !hostAnswered)
    } else {
      // No host state at all: fall back to the local copy, which never held the
      // optimistic patch because it was only written on an already-offline path.
      accept(localState(sessionId), true)
    }
    if (outcome.code === 'PROFESSION_LOCKED') {
      flashNotice(copy.composer.professionLockedRebuild)
    } else if (outcome.code === 'INVALID_ARGUMENT') {
      flashNotice(fillTemplate(copy.composer.invalidSelection, {
        message: outcome.message ?? copy.composer.requestFailed,
      }))
    } else {
      flashNotice(outcome.message ?? copy.composer.requestFailed)
    }
  }, [accept, copy, flashNotice, sessionId])

  const setValue = React.useCallback((patch: SelectionPatch, immediate = false): void => {
    const current = stateRef.current
    if (current === null) return
    // DSH owns the preset catalog; a permission preset must never be written to
    // the offline copy and then silently replayed as if it had been applied.
    if (patch.preset !== undefined && offlineRef.current) {
      flashNotice(copy.composer.permissionOffline)
      return
    }
    if (current.locked && patch.profession !== undefined && patch.profession !== current.turn?.profession) {
      flashNotice(copy.composer.professionLocked)
      return
    }
    const optimistic = applyPatch(current, patch)
    accept(optimistic, offlineRef.current)
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
  }, [accept, copy, flashNotice, flush, sessionId])

  return { state, offline, notice, setValue, warn: flashNotice }
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
  onChange: (value: string) => void
}): React.ReactElement {
  const current = props.options.find((option) => option.value === props.value)
  const label = current?.label ?? props.value
  const ariaLabel = controlAria(props.copy, props.control, label)
  const optionAria = (option: OptionView): string => fillTemplate(props.copy.composer.optionAria, {
    label: option.label,
    hint: option.hint,
  })
  const select = React.createElement(
    MuiSelect,
    {
      value: props.value,
      onChange: (event: SelectChangeEvent<unknown>) => { props.onChange(String(event.target.value)) },
      disabled: props.disabled === true,
      renderValue: () => label,
      // MUI only calls renderValue for a filled value unless displayEmpty is
      // set; the permission trigger uses the empty sentinel for "follow DSH".
      displayEmpty: true,
      inputProps: { 'aria-label': ariaLabel },
      sx: selectSx(props.width),
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
          sx: MENU_ITEM_SX,
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
    },
    select,
  )
  if (!props.tooltips) return trigger
  return React.createElement(
    MuiTooltip,
    { title: props.title, placement: 'top', describeChild: true },
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
  const sessionId = usableSession(props.sessionId) ? props.sessionId : 'default'
  const { state, offline, notice, setValue, warn } = useSelection(sessionId, copy)

  // Locale projections only: `copy` is the frozen per-locale object, so these
  // arrays are rebuilt on a language change and never on a composer keystroke.
  const options = React.useMemo(() => ({
    profession: professionOptions(copy),
    interaction: interactionOptions(copy),
    scene: sceneOptions(copy),
    validation: validationOptions(copy),
  }), [copy])

  if (!takeoverOn && !workflowOn) return React.createElement(React.Fragment, null)

  const ready = state !== null
  const tooltipsOn = state === null ? true : state.tooltip !== false
  const selection = state?.selection ?? EMPTY_SELECTION
  const locked = state?.locked === true
  const turnProfession = state?.turn?.profession
  const profession = locked && turnProfession !== undefined ? turnProfession : selection.profession
  // Host values are normalised, but a stale/unknown value must degrade to its
  // canonical id rather than crash the composer.
  const professionLabel = copy.professions[profession]?.label ?? profession
  const interactionLabel = copy.interactions[selection.interaction]?.label ?? selection.interaction
  const sceneLabel = copy.scenes[selection.scene]?.label ?? selection.scene
  const validationLabel = copy.validations[selection.validation]?.label ?? selection.validation
  const lockLine = locked
    ? fillTemplate(copy.composer.lockedLine, { profession: professionLabel })
    : copy.composer.unlockedLine
  const offlineLine = offline
    ? fillTemplate(copy.composer.offlineLine, { localOnly: copy.composer.localOnly })
    : ''
  const statusLine = notice !== null ? notice : offlineLine
  const loadingLine = ready ? null : copy.composer.loadingSelection

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
    const catalogLine = (state?.presets.length ?? 0) === 0 ? copy.composer.permissionCatalogMissing : ''
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
      width: 124,
      onChange: (next: string) => {
        if (next === FOLLOW_DSH) return
        if (!ready) return
        if (offline || (state?.presets.length ?? 0) === 0) {
          warn(offline ? copy.composer.permissionOffline : copy.composer.permissionApplyFailed)
          return
        }
        setValue({ preset: next }, true)
      },
    }))
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
        width: 96,
        onChange: (next: string) => { setValue({ profession: next as typeof selection.profession }) },
      }),
      React.createElement(Dropdown, {
        key: 'interaction',
        control: 'interaction',
        copy,
        value: selection.interaction,
        options: options.interaction,
        disabled: !ready,
        title: tooltipTitle(copy, 'interaction', interactionLabel, [
          ...(statusLine.length > 0 ? [statusLine] : []),
        ]),
        tooltips: tooltipsOn,
        width: 96,
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
        width: 92,
        onChange: (next: string) => { setValue({ scene: next as typeof selection.scene }) },
      }),
      React.createElement(Dropdown, {
        key: 'validation',
        control: 'validation',
        copy,
        value: selection.validation,
        options: options.validation,
        disabled: !ready,
        title: tooltipTitle(copy, 'validation', validationLabel, [
          // v24 §6.3: every level searches; only the budget and scope differ.
          copy.composer.validationNote,
          ...(statusLine.length > 0 ? [statusLine] : []),
        ]),
        tooltips: tooltipsOn,
        width: 88,
        onChange: (next: string) => { setValue({ validation: next as typeof selection.validation }) },
      }),
    )
  }

  if (children.length === 0) return React.createElement(React.Fragment, null)

  const rowStatus = notice !== null ? notice : loadingLine
  return React.createElement(
    ThemeProvider,
    { theme },
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
  )
})

export { EMPTY_SELECTION }
