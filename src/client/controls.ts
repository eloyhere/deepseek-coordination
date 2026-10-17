/**
 * The five composer dropdowns and their tooltips (v23 §15.1).
 *
 * Every control and every option carries a tooltip. The copy is not written
 * here: labels and hints come from `src/shared/enum.ts`, the permission
 * presets come from DSH through the host, and the lock wording comes from the
 * active turn. The five choices are persisted through the host route; when the
 * host is unreachable the same controls keep working against a per-session
 * localStorage copy and the tooltip says so.
 */
import * as React from 'react'
import Select, { type SelectChangeEvent } from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import { ThemeProvider } from '@mui/material/styles'
import { theme } from './theme.js'
import { loadSelection, localState, saveSelection, usableSession, writeLocal } from './bridge.js'
import { takeoverStore, workflowStore } from './store.js'
import {
  ControlHint,
  ControlLabel,
  InteractionHint,
  InteractionLabel,
  InteractionValues,
  PermissionHint,
  PermissionLabel,
  ProfessionHint,
  ProfessionLabel,
  ProfessionValues,
  SandboxModeValues,
  SceneHint,
  SceneLabel,
  SceneValues,
  ValidationHint,
  ValidationLabel,
  ValidationValues,
  isOneOf,
  toSandboxMode,
} from '../shared/enum.js'
import type { ControlName, SandboxMode } from '../shared/enum.js'
import type { PermissionPresetView, SelectionPatch, SelectionState } from '../shared/selection.js'

/** MUI's generics describe every overload; the plugin passes one narrow shape. */
const MuiSelect: React.ComponentType<Record<string, unknown>> =
  Select as unknown as React.ComponentType<Record<string, unknown>>
const MuiTooltip: React.ComponentType<Record<string, unknown>> =
  Tooltip as unknown as React.ComponentType<Record<string, unknown>>

interface OptionView {
  value: string
  label: string
  hint: string
}

const PROFESSION_OPTIONS: OptionView[] = ProfessionValues.map((value) => ({
  value,
  label: ProfessionLabel[value],
  hint: ProfessionHint[value],
}))

const INTERACTION_OPTIONS: OptionView[] = InteractionValues.map((value) => ({
  value,
  label: InteractionLabel[value],
  hint: InteractionHint[value],
}))

const SCENE_OPTIONS: OptionView[] = SceneValues.map((value) => ({
  value,
  label: SceneLabel[value],
  hint: SceneHint[value],
}))

const VALIDATION_OPTIONS: OptionView[] = ValidationValues.map((value) => ({
  value,
  label: ValidationLabel[value],
  hint: `档位 ${value}：${ValidationHint[value]}`,
}))

/** Fallback only when DSH exposes no preset catalog; selecting one explains why it cannot apply. */
const FALLBACK_PERMISSION_OPTIONS: OptionView[] = SandboxModeValues.map((mode) => ({
  value: mode,
  label: PermissionLabel[mode],
  hint: PermissionHint[mode],
}))

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

function tooltipTitle(name: ControlName, current: string, extra: string[]): React.ReactNode {
  const lines = [
    React.createElement('div', { key: 'title', style: TITLE_LINE_STYLE }, `${ControlLabel[name]} · 当前：${current}`),
    React.createElement('div', { key: 'hint', style: BODY_LINE_STYLE }, ControlHint[name]),
  ]
  for (const line of extra) {
    if (line.length > 0) {
      lines.push(React.createElement('div', { key: `extra-${line}`, style: SUBTLE_LINE_STYLE }, line))
    }
  }
  return React.createElement('span', null, ...lines)
}

function permissionHint(preset: PermissionPresetView): string {
  const parts: string[] = []
  if (preset.description !== undefined && preset.description.length > 0) parts.push(preset.description)
  const mode: SandboxMode | undefined =
    preset.sandbox !== undefined && isOneOf(preset.sandbox, SandboxModeValues)
      ? preset.sandbox
      : isOneOf(preset.value, SandboxModeValues)
        ? preset.value
        : undefined
  parts.push(mode === undefined ? '权限档位由 DSH 的权限预设定义。' : PermissionHint[mode])
  if (preset.approval !== undefined && preset.approval.length > 0) {
    parts.push(`审批策略：${preset.approval}`)
  }
  return parts.join(' ')
}

function permissionOptions(presets: PermissionPresetView[], preset: string | undefined): OptionView[] {
  if (presets.length === 0) return FALLBACK_PERMISSION_OPTIONS
  const options: OptionView[] = presets.map((entry) => ({
    value: entry.value,
    label: entry.name,
    hint: permissionHint(entry),
  }))
  if (preset !== undefined && preset.length > 0 && !options.some((option) => option.value === preset)) {
    options.push({
      value: preset,
      label: preset,
      hint: '当前会话的权限预设不在目录中（自定义预设）。',
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

interface SelectionHook {
  state: SelectionState | null
  offline: boolean
  notice: string | null
  setValue: (patch: SelectionPatch, immediate?: boolean) => void
  warn: (message: string) => void
}

const stateCache = new Map<string, SelectionState>()

function useSelection(sessionId: string): SelectionHook {
  const [state, setState] = React.useState<SelectionState | null>(() => stateCache.get(sessionId) ?? null)
  const [offline, setOffline] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const stateRef = React.useRef<SelectionState | null>(stateCache.get(sessionId) ?? null)
  const offlineRef = React.useRef(false)
  const pendingRef = React.useRef<SelectionPatch>({})
  const timerRef = React.useRef<number | null>(null)
  const noticeTimerRef = React.useRef<number | null>(null)
  const aliveRef = React.useRef(true)

  const accept = React.useCallback((next: SelectionState | null, local: boolean): void => {
    if (!aliveRef.current || next === null) return
    offlineRef.current = local
    setOffline(local)
    const previous = stateRef.current
    if (previous !== null && stateSignature(previous) === stateSignature(next)) return
    stateRef.current = next
    stateCache.set(sessionId, next)
    setState(next)
  }, [sessionId])

  const refresh = React.useCallback(async (): Promise<void> => {
    const next = await loadSelection(sessionId)
    if (!aliveRef.current) return
    if (next !== null) {
      accept(next, false)
      return
    }
    const cached = stateCache.get(sessionId)
    if (cached !== null && cached !== undefined && offlineRef.current) return
    const local = localState(sessionId)
    accept(local, true)
  }, [accept, sessionId])

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

  const flashNotice = React.useCallback((message: string): void => {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      if (aliveRef.current) setNotice(null)
    }, 4000)
  }, [])

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
    if (fresh !== null) accept(fresh, false)
    if (outcome.code === 'PROFESSION_LOCKED') {
      flashNotice('职能已锁定：本 Turn 内不能切换。重建或丢弃任务后可重新选择。')
    } else if (outcome.code === 'INVALID_ARGUMENT') {
      flashNotice(`选择无效：${outcome.message ?? ''}`)
    } else {
      flashNotice(outcome.message ?? '主机拒绝了这次修改')
    }
  }, [accept, flashNotice, sessionId])

  const setValue = React.useCallback((patch: SelectionPatch, immediate = false): void => {
    const current = stateRef.current
    if (current === null) return
    if (current.locked && patch.profession !== undefined && patch.profession !== current.turn?.profession) {
      flashNotice('职能已锁定：本 Turn 内不能切换。')
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
      return
    }
    pendingRef.current = { ...pendingRef.current, ...patch }
    if (immediate) {
      void flush()
      return
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => { void flush() }, 120)
  }, [accept, flashNotice, flush, sessionId])

  return { state, offline, notice, setValue, warn: flashNotice }
}

function Dropdown(props: {
  control: ControlName
  value: string
  options: OptionView[]
  disabled?: boolean
  title: React.ReactNode
  width: number
  onChange: (value: string) => void
}): React.ReactElement {
  const current = props.options.find((option) => option.value === props.value)
  const label = current?.label ?? props.value
  const select = React.createElement(
    MuiSelect,
    {
      value: props.value,
      onChange: (event: SelectChangeEvent<unknown>) => { props.onChange(String(event.target.value)) },
      disabled: props.disabled === true,
      renderValue: () => label,
      inputProps: { 'aria-label': `${ControlLabel[props.control]}，当前：${label}` },
      sx: selectSx(props.width),
    },
    props.options.map((option) => React.createElement(
      MenuItem,
      { key: option.value, value: option.value, sx: MENU_ITEM_SX },
      React.createElement(
        MuiTooltip,
        { title: option.hint, placement: 'right', describeChild: true, enterDelay: 250 },
        React.createElement('span', { style: OPTION_LABEL_STYLE, tabIndex: -1 }, option.label),
      ),
    )),
  )
  return React.createElement(
    MuiTooltip,
    { title: props.title, placement: 'top', describeChild: true },
    React.createElement('span', { style: WRAPPER_STYLE, tabIndex: props.disabled === true ? 0 : -1 }, select),
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
  const takeoverOn = React.useSyncExternalStore(takeoverStore.subscribe, takeoverStore.snapshot, takeoverStore.snapshot)
  const workflowOn = React.useSyncExternalStore(workflowStore.subscribe, workflowStore.snapshot, workflowStore.snapshot)
  const sessionId = usableSession(props.sessionId) ? props.sessionId : 'default'
  const { state, offline, notice, setValue, warn } = useSelection(sessionId)

  if (!takeoverOn && !workflowOn) return React.createElement(React.Fragment, null)

  const selection = state?.selection ?? EMPTY_SELECTION
  const locked = state?.locked === true
  const turnProfession = state?.turn?.profession
  const profession = locked && turnProfession !== undefined ? turnProfession : selection.profession
  const professionLabel = ProfessionLabel[profession] ?? profession
  const lockLine = locked
    ? `本 Turn 的职能已锁定为「${professionLabel}」。重建（rebuild）或丢弃（abandon）任务后才能重新选择。`
    : '选择后会在本 Turn 开始时锁定，Turn 结束前不可切换。'
  const offlineLine = offline ? '未连接主机：选择仅保存在本地。' : ''
  const statusLine = notice !== null ? notice : offlineLine

  const children: React.ReactNode[] = []

  if (takeoverOn) {
    const options = permissionOptions(state?.presets ?? [], state?.preset)
    const value = state?.preset ?? options[0]?.value ?? 'workspace-write'
    const label = options.find((option) => option.value === value)?.label ?? value
    const catalogLine = (state?.presets.length ?? 0) === 0 ? 'DSH 未提供权限预设目录，当前仅显示只读说明。' : ''
    const permissionTitle = tooltipTitle('permission', label, [
      ...(catalogLine.length > 0 ? [catalogLine] : []),
      '切换后会立即写入本会话的 DSH 权限预设。',
      ...(statusLine.length > 0 ? [statusLine] : []),
    ])
    children.push(React.createElement(Dropdown, {
      key: 'permission',
      control: 'permission',
      value,
      options,
      title: permissionTitle,
      width: 124,
      onChange: (next: string) => {
        if ((state?.presets.length ?? 0) === 0) {
          warn(offline ? '未连接主机，无法切换权限预设。' : 'DSH 未提供权限预设目录，无法切换权限。')
          return
        }
        setValue({ preset: next }, true)
      },
    }))
  }

  if (workflowOn) {
    children.push(
      React.createElement(Dropdown, {
        key: 'profession',
        control: 'profession',
        value: profession,
        options: PROFESSION_OPTIONS,
        disabled: locked,
        title: tooltipTitle('profession', professionLabel, [lockLine, ...(statusLine.length > 0 ? [statusLine] : [])]),
        width: 96,
        onChange: (next: string) => { setValue({ profession: next as typeof selection.profession }) },
      }),
      React.createElement(Dropdown, {
        key: 'interaction',
        control: 'interaction',
        value: selection.interaction,
        options: INTERACTION_OPTIONS,
        title: tooltipTitle('interaction', InteractionLabel[selection.interaction], [
          ...(statusLine.length > 0 ? [statusLine] : []),
        ]),
        width: 96,
        onChange: (next: string) => { setValue({ interaction: next as typeof selection.interaction }) },
      }),
      React.createElement(Dropdown, {
        key: 'scene',
        control: 'scene',
        value: selection.scene,
        options: SCENE_OPTIONS,
        title: tooltipTitle('scene', SceneLabel[selection.scene], [
          ...(statusLine.length > 0 ? [statusLine] : []),
        ]),
        width: 92,
        onChange: (next: string) => { setValue({ scene: next as typeof selection.scene }) },
      }),
      React.createElement(Dropdown, {
        key: 'validation',
        control: 'validation',
        value: selection.validation,
        options: VALIDATION_OPTIONS,
        title: tooltipTitle('validation', ValidationLabel[selection.validation], [
          'medium 与 high 允许联网搜索；low 不做贝叶斯推断。',
          ...(statusLine.length > 0 ? [statusLine] : []),
        ]),
        width: 88,
        onChange: (next: string) => { setValue({ validation: next as typeof selection.validation }) },
      }),
    )
  }

  if (children.length === 0) return React.createElement(React.Fragment, null)

  return React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(
      'div',
      { style: ROW_STYLE },
      ...children,
      notice === null
        ? React.createElement(React.Fragment, null)
        : React.createElement('span', { style: NOTICE_STYLE, role: 'status' }, notice),
    ),
  )
})

export { EMPTY_SELECTION }
