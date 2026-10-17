/**
 * deepseek-coordination — Client half (browser side)
 *
 * Mounts two pieces of UI into the DSH Web host:
 *  1. a `协调` page in Settings, carrying the permission-takeover switch;
 *  2. the three coordination selectors inside the composer tool row
 *     (`conversation.input.left` — the free space right of the access-mode
 *     control, the green region of the mock).
 *
 * The widgets are Material UI (MUI) React components: React itself comes from
 * the host's module table, while @mui/material and emotion are bundled into this
 * file by tsdown (`alwaysBundle` inlines everything that is not `react` or
 * `@deepseek-ai/dsh-client-*`).
 *
 * When takeover is on, the host's own access-mode control (the blue region) is
 * hidden with an injected rule and the replacement dropdown renders at the left
 * edge of the same row.
 *
 * Contract notes:
 *  - `inject` lists the client services used; package.json's `dsh.client.inject`
 *    separately lists module-table packages. Both are required.
 *  - Every registration is disposed with the plugin, including the injected
 *    takeover rule, through ctx.effect disposers.
 */
import * as React from 'react'
import Select, { type SelectChangeEvent } from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Switch from '@mui/material/Switch'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

const PLUGIN_ID = 'deepseek-coordination'
const TAKEOVER_ID = 'dsh-coordination-takeover'
const STORAGE_KEY = 'deepseek-coordination:takeover'
const WORKFLOW_KEY = 'deepseek-coordination:workflow'

/** 职能 — the duty dimension of the role framework. */
const DUTY_OPTIONS = ['决策', '成果', '资源', '人员', '任职', '执行'] as const

/** 交互 — the interaction mode. */
const INTERACTION_OPTIONS = ['感情', '思维', '启发', '收束', '统筹'] as const

/** 情景 — the working scenario. */
const SCENARIO_OPTIONS = ['对话', '写作', '办公', '研究', '工程', '迭代'] as const

/** 强度 — the effort level of the workflow. */
const EFFORT_OPTIONS = ['low', 'medium', 'high'] as const

/**
 * The host's three permission presets, labels taken from its own menu:
 * 仅可查看 / 工作区内修改 / 完全权限. The plugin mirrors the wording rather than
 * inventing one, because the same words appear side by side in the composer.
 * Note: only the labels are aligned today — choosing one does not yet dispatch
 * a /permission command, since the command face is not on this slot.
 */
const PERMISSION_FALLBACK = ['仅可查看', '工作区内修改', '完全权限'] as const

/**
 * The host's resident access-mode control, addressed by its accessible name so
 * the rule survives hashed CSS-module class names. Both locales are matched:
 * the label is `访问模式，当前：…` in Chinese and `Access mode, current: …` in English.
 */
const ACCESS_MODE_SELECTOR = 'button[aria-label^="访问模式"], button[aria-label^="Access mode"]'

/**
 * A local theme, built once. The plugin must not reach into the host's own
 * theme; a compact palette keeps the controls legible in either host theme.
 */
const theme = createTheme({
  typography: { fontSize: 12 },
  components: {
    MuiSelect: { defaultProps: { size: 'small' } },
    MuiMenuItem: { styleOverrides: { root: { fontSize: 12, minHeight: 28 } } },
  },
})

/**
 * MUI's generics describe every overload of onChange; the plugin only ever
 * passes one shape, so the components are narrowed to the props used here.
 */
const MuiSelect: React.ComponentType<Record<string, unknown>> = Select as unknown as React.ComponentType<Record<string, unknown>>
const MuiSwitch: React.ComponentType<Record<string, unknown>> = Switch as unknown as React.ComponentType<Record<string, unknown>>

/** Hoisted so emotion does not regenerate the rule on every render. */
const SELECT_SX = { width: 104, fontSize: 12, height: 28, backgroundColor: 'transparent' }

/**
 * Memoised on purpose: the composer re-renders while the user types or opens the
 * "+" menu, and this plugin must not participate in that churn — a re-render here
 * makes emotion touch <head>, and the host closes its popover on outside DOM
 * mutation, which shows up as a popup that flashes and vanishes.
 */
const MemoControls = React.memo(function MemoControlsInner(): React.ReactElement {
  return React.createElement(CoordinationControls, null)
})

/** One MUI select wired to a controlled value. */
function Dropdown(props: {
  label: string
  options: readonly string[]
  value: string
  onChange: (value: string) => void
}): React.ReactElement {
  return React.createElement(
    MuiSelect,
    {
      value: props.value,
      onChange: (event: SelectChangeEvent<unknown>) => { props.onChange(String(event.target.value)) },
      inputProps: { 'aria-label': props.label },
      sx: SELECT_SX,
    },
    props.options.map((option) => React.createElement(MenuItem, { key: option, value: option }, option)),
  )
}

/** The three selectors, plus the replacement permission dropdown when takeover is on. */
function CoordinationControls(): React.ReactElement {
  const isOn = React.useSyncExternalStore(subscribeTakeover, takeoverSnapshot, takeoverSnapshot)
  const workflowOn = React.useSyncExternalStore(subscribeWorkflow, workflowSnapshot, workflowSnapshot)
  const [duty, setDuty] = React.useState<string>(DUTY_OPTIONS[0])
  const [interaction, setInteraction] = React.useState<string>(INTERACTION_OPTIONS[0])
  const [scenario, setScenario] = React.useState<string>(SCENARIO_OPTIONS[0])
  const [effort, setEffort] = React.useState<string>('medium')
  const [permission, setPermission] = React.useState<string>(PERMISSION_FALLBACK[0])

  const children: React.ReactNode[] = []
  if (isOn) {
    children.push(React.createElement(Dropdown, {
      key: 'permission',
      label: '权限接管',
      options: PERMISSION_FALLBACK,
      value: permission,
      onChange: setPermission,
    }))
  }
  if (workflowOn) {
    children.push(
      React.createElement(Dropdown, { key: 'duty', label: '职能', options: DUTY_OPTIONS, value: duty, onChange: setDuty }),
      React.createElement(Dropdown, {
        key: 'interaction',
        label: '交互',
        options: INTERACTION_OPTIONS,
        value: interaction,
        onChange: setInteraction,
      }),
      React.createElement(Dropdown, {
        key: 'scenario',
        label: '情景',
        options: SCENARIO_OPTIONS,
        value: scenario,
        onChange: setScenario,
      }),
      React.createElement(Dropdown, {
        key: 'effort',
        label: '强度',
        options: EFFORT_OPTIONS,
        value: effort,
        onChange: setEffort,
      }),
    )
  }
  if (children.length === 0) return React.createElement(React.Fragment, null)

  return React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(
      'div',
      { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
      ...children,
    ),
  )
}

/* ------------------------------------------------------------------------- *
 * Takeover state
 * ------------------------------------------------------------------------- */

function readTakeover(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

let takeover = readTakeover()
const listeners = new Set<() => void>()

function subscribeTakeover(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function takeoverSnapshot(): boolean {
  return takeover
}

/** Hide or restore the host control by rewriting the injected rule. */
function applyTakeoverStyle(on: boolean, style: HTMLStyleElement): void {
  style.textContent = on ? `${ACCESS_MODE_SELECTOR} { display: none !important; }` : ''
}

function setTakeover(next: boolean, style: HTMLStyleElement): void {
  takeover = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    // A blocked storage must not break the switch; the choice stays in memory.
  }
  applyTakeoverStyle(next, style)
  for (const listener of listeners) listener()
}

/** Whether the coordination selectors are shown in the composer (default on). */
function readWorkflow(): boolean {
  try {
    return window.localStorage.getItem(WORKFLOW_KEY) !== '0'
  } catch {
    return true
  }
}

let workflow = readWorkflow()
const workflowListeners = new Set<() => void>()

function subscribeWorkflow(listener: () => void): () => void {
  workflowListeners.add(listener)
  return () => { workflowListeners.delete(listener) }
}

function workflowSnapshot(): boolean {
  return workflow
}

function setWorkflow(next: boolean): void {
  workflow = next
  try {
    window.localStorage.setItem(WORKFLOW_KEY, next ? '1' : '0')
  } catch {
    // A blocked storage must not break the switch; the choice stays in memory.
  }
  for (const listener of workflowListeners) listener()
}

/* ------------------------------------------------------------------------- *
 * Settings section
 * ------------------------------------------------------------------------- */

/** The `协调` settings page: the takeover switch and nothing else. */
function CoordinationSettings(props: { style: HTMLStyleElement }): React.ReactElement {
  const isOn = React.useSyncExternalStore(subscribeTakeover, takeoverSnapshot, takeoverSnapshot)
  const workflowOn = React.useSyncExternalStore(subscribeWorkflow, workflowSnapshot, workflowSnapshot)

  const hint = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)' }
  const row = (label: string, checked: boolean, onChange: (value: boolean) => void): React.ReactElement =>
    React.createElement(
      'label',
      { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' } },
      React.createElement(MuiSwitch, {
        size: 'small',
        checked,
        inputProps: { 'aria-label': label },
        onChange: (event: { target: { checked: boolean } }) => { onChange(event.target.checked) },
      }),
      React.createElement('span', null, label),
    )

  return React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(
      'section',
      { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      React.createElement('h2', { style: { margin: 0, fontSize: 15 } }, '协调'),
      row('权限接管', isOn, (value) => { setTakeover(value, props.style) }),
      React.createElement('p', { style: hint },
        isOn
          ? '已接管：输入框中的权限下拉已被隐藏，替换为协调面板的下拉。'
          : '未接管：输入框保留宿主自带的权限下拉。'),
      row('工作流', workflowOn, setWorkflow),
      React.createElement('p', { style: hint },
        workflowOn
          ? '工作流开启：输入框显示职能 / 交互 / 情景三个下拉框。'
          : '工作流关闭：输入框隐藏职能 / 交互 / 情景三个下拉框。'),
    ),
  )
}

/* ------------------------------------------------------------------------- *
 * Plugin entry
 * ------------------------------------------------------------------------- */

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const takeoverStyle = document.createElement('style')
  takeoverStyle.id = TAKEOVER_ID
  document.head.append(takeoverStyle)
  applyTakeoverStyle(takeover, takeoverStyle)
  ctx.effect(() => () => { takeoverStyle.remove() }, `${PLUGIN_ID}: takeover rule`)

  const Settings = React.memo(function SettingsInner(): React.ReactElement {
    return React.createElement(CoordinationSettings, { style: takeoverStyle })
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PLUGIN_ID,
    order: 50,
    label: '协调',
  }, Settings))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: PLUGIN_ID,
    order: 40,
  }, MemoControls))
}
