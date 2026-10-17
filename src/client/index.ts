/**
 * deepseek-coordination — Client half (browser side)
 *
 * Mounts two pieces of UI into the DSH Web host:
 *  1. a `协调` page in Settings, carrying the permission-takeover switch;
 *  2. the three coordination selectors inside the composer tool row
 *     (`conversation.input.left` — the free space right of the access-mode
 *     control, the green region of the mock).
 *
 * The widgets are MDUI 2 web components (`<mdui-switch>`, `<mdui-select>`), which
 * are framework-agnostic custom elements: React renders the tags and MDUI
 * upgrades them. That is why the plugin carries no second framework — only the
 * MDUI component JS (bundled here) and its stylesheet (served by the host half).
 *
 * When takeover is on, the host's own access-mode control (the blue region) is
 * hidden with an injected rule and the element renders the replacement
 * dropdown at the left edge of the same row.
 *
 * Contract notes:
 *  - `inject` lists the client services used; package.json's `dsh.client.inject`
 *    separately lists module-table packages. Both are required.
 *  - Every registration is disposed with the plugin; the injected `<style>` and
 *    `<link>` are removed through ctx.effect disposers.
 *  - Only react and @deepseek-ai/dsh-client-* come from the module table; MDUI is
 *    bundled into this file by tsdown's `alwaysBundle`.
 */
import * as React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

import 'mdui/components/switch.js'
import 'mdui/components/select.js'
import 'mdui/components/menu-item.js'
import 'mdui/components/icon.js'

const PLUGIN_ID = 'deepseek-coordination'
const STYLE_URL = '/deepseek-coordination/static/mdui.css'
const STYLE_ID = 'dsh-coordination-takeover'
const MDUI_STYLE_ID = 'dsh-coordination-mdui'
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
  style.textContent = on
    ? `${ACCESS_MODE_SELECTOR} { display: none !important; }`
    : ''
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
 * MDUI widgets
 * ------------------------------------------------------------------------- */

/** Read the `value` a change event reports, whatever element fired it. */
function eventValue(event: Event): string | undefined {
  const detail = (event as CustomEvent<{ value?: unknown }>).detail
  if (detail !== undefined && typeof detail.value === 'string') return detail.value
  const current = (event.currentTarget as HTMLElement & { value?: unknown }).value
  return typeof current === 'string' ? current : undefined
}

/** Attach a change listener to a custom element through a ref. */
function useChange(handler: (value: string) => void): React.RefCallback<HTMLElement> {
  return React.useCallback((element: HTMLElement | null) => {
    if (element === null) return
    const listener = (event: Event): void => {
      const value = eventValue(event)
      if (value !== undefined) handler(value)
    }
    element.addEventListener('change', listener)
    return () => { element.removeEventListener('change', listener) }
  }, [handler])
}

/** One MDUI select with its menu items. */
function Dropdown(props: {
  label: string
  options: readonly string[]
  value: string
  onChange: (value: string) => void
}): React.ReactElement {
  const ref = useChange(props.onChange)

  return React.createElement(
    'mdui-select',
    {
      ref,
      variant: 'outlined',
      class: 'dsh-coordination-dropdown',
      'aria-label': props.label,
      value: props.value,
      style: 'width: 96px',
    },
    props.options.map((option) =>
      React.createElement('mdui-menu-item', { key: option, value: option }, option)),
  )
}

/** The three selectors, plus the replacement permission dropdown when takeover is on. */
function CoordinationControls(props: { style: HTMLStyleElement }): React.ReactElement {
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
 * Settings section
 * ------------------------------------------------------------------------- */

function Icon(props: { name: string }): React.ReactElement {
  return React.createElement('mdui-icon', { name: props.name, slot: 'icon' })
}

/** The `协调` settings page: the takeover switch and nothing else. */
function CoordinationSettings(props: { style: HTMLStyleElement }): React.ReactElement {
  const isOn = React.useSyncExternalStore(subscribeTakeover, takeoverSnapshot, takeoverSnapshot)
  const ref = useChange(() => { setTakeover(!takeover, props.style) })

  return React.createElement(
    'section',
    { className: 'dsh-coordination-settings' },
    React.createElement('h2', { className: 'dsh-coordination-settings__title' },
      React.createElement(Icon, { name: 'hub' }),
      React.createElement('span', null, '协调')),
    React.createElement('label', { className: 'dsh-coordination-settings__switch' },
      React.createElement('mdui-switch', { ref, checked: isOn, 'aria-label': '权限接管' }),
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
  // MDUI's stylesheet: theme variables and the icon face. Served by the host
  // half so the plugin works offline and version-locked to the bundled JS.
  ctx.effect(() => {
    if (document.getElementById(MDUI_STYLE_ID) !== null) return () => { /* owned elsewhere */ }
    const link = document.createElement('link')
    link.id = MDUI_STYLE_ID
    link.rel = 'stylesheet'
    link.href = STYLE_URL
    document.head.append(link)
    return () => { link.remove() }
  }, `${PLUGIN_ID}: MDUI stylesheet`)

  const style = document.createElement('style')
  style.id = STYLE_ID
  document.head.append(style)
  applyTakeoverStyle(takeover, style)
  ctx.effect(() => () => { style.remove() }, `${PLUGIN_ID}: takeover rule`)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PLUGIN_ID,
    order: 50,
    label: '协调',
  }, () => React.createElement(CoordinationSettings, { style })))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: PLUGIN_ID,
    order: 40,
  }, () => React.createElement(CoordinationControls, { style })))
}
