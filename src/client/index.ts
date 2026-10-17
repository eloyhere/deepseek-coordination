/**
 * deepseek-coordination — Client half (browser side)
 *
 * Mounts two pieces of UI into the DSH Web host:
 *  1. a `协调` page in Settings, carrying the permission-takeover switch;
 *  2. the three coordination selectors inside the composer tool row
 *     (`conversation.input.left` — the free space right of the access-mode
 *     control, the green region of the mock).
 *
 * The widgets are plain React components owned by this plugin: no third-party UI
 * framework, because the one framework the host guarantees is React itself (it
 * arrives through the module table). The dropdown is drawn here rather than with
 * the browser's <select>, whose popup is painted by the OS and cannot carry a
 * hover state or a corner radius.
 *
 * When takeover is on, the host's own access-mode control (the blue region) is
 * hidden with an injected rule and the replacement dropdown renders at the left
 * edge of the same row.
 *
 * Contract notes:
 *  - `inject` lists the client services used; package.json's `dsh.client.inject`
 *    separately lists module-table packages. Both are required.
 *  - Every registration is disposed with the plugin, including the injected
 *    stylesheet and takeover rule, through ctx.effect disposers.
 */
import * as React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

const PLUGIN_ID = 'deepseek-coordination'
const STYLE_ID = 'dsh-coordination-style'
const TAKEOVER_ID = 'dsh-coordination-takeover'
const STORAGE_KEY = 'deepseek-coordination:takeover'

/** 职能 — the duty dimension of the role framework. */
const DUTY_OPTIONS = ['决策', '成果', '资源', '人员', '任职', '执行'] as const

/** 交互 — the interaction mode. */
const INTERACTION_OPTIONS = ['感情', '思维', '启发', '收束'] as const

/** 情景 — the working scenario. */
const SCENARIO_OPTIONS = ['对话', '写作', '办公', '研究', '工程', '迭代'] as const

/** Fallback options for the replacement dropdown, which the host's presets override. */
const PERMISSION_FALLBACK = ['完全权限'] as const

/**
 * The host's resident access-mode control, addressed by its accessible name so
 * the rule survives hashed CSS-module class names. Both locales are matched:
 * the label is `访问模式，当前：…` in Chinese and `Access mode, current: …` in English.
 */
const ACCESS_MODE_SELECTOR = 'button[aria-label^="访问模式"], button[aria-label^="Access mode"]'

/** Component styles, injected once and removed on unload. */
const CSS = `
.dsh-coordination-row { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-coordination-field { position: relative; display: inline-flex; min-width: 0; }
.dsh-coordination-trigger {
  display: inline-flex; align-items: center; gap: 2px;
  max-width: 120px; height: 24px; padding: 0 4px 0 8px;
  border: 1px solid var(--dsw-alias-border-secondary, #d0d0d0); border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-primary, inherit);
  font: inherit; font-size: 12px; line-height: 20px; cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.dsh-coordination-trigger:hover,
.dsh-coordination-trigger[aria-expanded="true"] {
  background: var(--dsw-alias-bg-hover, rgba(0, 0, 0, 0.06));
  border-color: var(--dsw-alias-border-primary, #b8b8b8);
}
.dsh-coordination-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f8cff); outline-offset: 1px; }
.dsh-coordination-trigger__value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-coordination-trigger__chevron { font-size: 10px; opacity: 0.6; }
.dsh-coordination-popup {
  position: fixed; z-index: 2147483000; margin: 0; padding: 4px;
  list-style: none; min-width: 96px; max-height: 240px; overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-secondary, #e0e0e0); border-radius: 10px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}
.dsh-coordination-option {
  padding: 4px 8px; border-radius: 6px; font-size: 12px; line-height: 20px;
  white-space: nowrap; cursor: pointer;
}
.dsh-coordination-option:hover { background: var(--dsw-alias-bg-hover, rgba(0, 0, 0, 0.06)); }
.dsh-coordination-option[aria-selected="true"] { color: var(--dsw-alias-brand-primary, #4f8cff); }
.dsh-coordination-settings { display: flex; flex-direction: column; gap: 10px; }
.dsh-coordination-settings__title { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 15px; }
.dsh-coordination-settings__switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.dsh-coordination-settings__switch input { width: 16px; height: 16px; cursor: pointer; }
.dsh-coordination-settings__hint { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #666); }
`

/** A chevron drawn with CSS so no icon font is required. */
function Chevron(): React.ReactElement {
  return React.createElement('span', {
    className: 'dsh-coordination-trigger__chevron',
    'aria-hidden': true,
  }, '▼')
}

/**
 * One dropdown: a styled trigger plus a popup positioned from the trigger's
 * rect. Fixed positioning keeps it out of the composer's overflow clip.
 */
function Dropdown(props: {
  label: string
  options: readonly string[]
  value: string
  onChange: (value: string) => void
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [position, setPosition] = React.useState({ top: 0, left: 0 })
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const fieldRef = React.useRef<HTMLSpanElement>(null)

  React.useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && fieldRef.current?.contains(target) !== true) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect !== undefined) setPosition({ top: Math.round(rect.bottom + 6), left: Math.round(rect.left) })
    setOpen(true)
  }

  return React.createElement(
    'span',
    { className: 'dsh-coordination-field', ref: fieldRef },
    React.createElement('button', {
      type: 'button',
      className: 'dsh-coordination-trigger',
      ref: triggerRef,
      'aria-label': props.label,
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      onClick: toggle,
    },
      React.createElement('span', { className: 'dsh-coordination-trigger__value' }, props.value),
      React.createElement(Chevron, null)),
    open
      ? React.createElement('ul', {
          className: 'dsh-coordination-popup',
          role: 'listbox',
          style: { top: position.top, left: position.left },
        }, props.options.map((option) =>
          React.createElement('li', {
            key: option,
            className: 'dsh-coordination-option',
            role: 'option',
            'aria-selected': option === props.value,
            onClick: () => {
              props.onChange(option)
              setOpen(false)
            },
          }, option)))
      : null,
  )
}

/** The three selectors, plus the replacement permission dropdown when takeover is on. */
function CoordinationControls(): React.ReactElement {
  const isOn = React.useSyncExternalStore(subscribeTakeover, takeoverSnapshot, takeoverSnapshot)
  const [duty, setDuty] = React.useState<string>(DUTY_OPTIONS[0])
  const [interaction, setInteraction] = React.useState<string>(INTERACTION_OPTIONS[0])
  const [scenario, setScenario] = React.useState<string>(SCENARIO_OPTIONS[0])
  const [permission, setPermission] = React.useState<string>(PERMISSION_FALLBACK[0])

  return React.createElement(
    'div',
    { className: 'dsh-coordination-row' },
    isOn
      ? React.createElement(Dropdown, {
          label: '权限接管',
          options: PERMISSION_FALLBACK,
          value: permission,
          onChange: setPermission,
        })
      : null,
    React.createElement(Dropdown, { label: '职能', options: DUTY_OPTIONS, value: duty, onChange: setDuty }),
    React.createElement(Dropdown, {
      label: '交互',
      options: INTERACTION_OPTIONS,
      value: interaction,
      onChange: setInteraction,
    }),
    React.createElement(Dropdown, {
      label: '情景',
      options: SCENARIO_OPTIONS,
      value: scenario,
      onChange: setScenario,
    }),
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

/* ------------------------------------------------------------------------- *
 * Settings section
 * ------------------------------------------------------------------------- */

/** The `协调` settings page: the takeover switch and nothing else. */
function CoordinationSettings(props: { style: HTMLStyleElement }): React.ReactElement {
  const isOn = React.useSyncExternalStore(subscribeTakeover, takeoverSnapshot, takeoverSnapshot)

  return React.createElement(
    'section',
    { className: 'dsh-coordination-settings' },
    React.createElement('h2', { className: 'dsh-coordination-settings__title' }, '协调'),
    React.createElement('label', { className: 'dsh-coordination-settings__switch' },
      React.createElement('input', {
        type: 'checkbox',
        checked: isOn,
        'aria-label': '权限接管',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          setTakeover(event.target.checked, props.style)
        },
      }),
      React.createElement('span', null, '权限接管')),
    React.createElement('p', { className: 'dsh-coordination-settings__hint' },
      isOn
        ? '已接管：输入框中的权限下拉已被隐藏，替换为协调面板的下拉。'
        : '未接管：输入框保留宿主自带的权限下拉。'),
  )
}

/* ------------------------------------------------------------------------- *
 * Plugin entry
 * ------------------------------------------------------------------------- */

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    if (document.getElementById(STYLE_ID) !== null) return () => { /* owned elsewhere */ }
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
    return () => { style.remove() }
  }, `${PLUGIN_ID}: component styles`)

  const takeoverStyle = document.createElement('style')
  takeoverStyle.id = TAKEOVER_ID
  document.head.append(takeoverStyle)
  applyTakeoverStyle(takeover, takeoverStyle)
  ctx.effect(() => () => { takeoverStyle.remove() }, `${PLUGIN_ID}: takeover rule`)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PLUGIN_ID,
    order: 50,
    label: '协调',
  }, () => React.createElement(CoordinationSettings, { style: takeoverStyle })))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: PLUGIN_ID,
    order: 40,
  }, () => React.createElement(CoordinationControls, null)))
}
