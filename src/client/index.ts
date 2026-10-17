/**
 * deepseek-coordination — Client half (browser side)
 *
 * Mounts two pieces of UI into the DSH Web host:
 *  1. a `协调` page in Settings, carrying the permission-takeover switch and the
 *     three coordination selectors;
 *  2. the same selectors inside the composer tool row (`conversation.input.left`
 *     — the free space right of the access-mode control, the green region of the
 *     mock), rendered by an Angular custom element.
 *
 * When takeover is on, the host's own access-mode control (the blue region) is
 * hidden with an injected rule and the element renders the replacement
 * dropdown at the left edge of the same row.
 *
 * Contract notes:
 *  - `inject` lists the client services used; package.json's `dsh.client.inject`
 *    separately lists module-table packages. Both are required.
 *  - Every registration is disposed with the plugin; the injected `<style>` and
 *    `<script>` are removed through ctx.effect disposers.
 *  - Only react and @deepseek-ai/dsh-client-* come from the module table; the
 *    Angular bundle is fetched from the host half instead of being bundled here.
 */
import * as React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

const PLUGIN_ID = 'deepseek-coordination'
const ELEMENTS_URL = '/deepseek-coordination/elements/main.js'
const ELEMENT_TAG = 'dsh-coordination-controls'
const STYLE_ID = 'dsh-coordination-takeover'
const FONT_ID = 'dsh-coordination-material-symbols'
const STORAGE_KEY = 'deepseek-coordination:takeover'

/**
 * The host's resident access-mode control, addressed by its accessible name so
 * the rule survives hashed CSS-module class names. Both locales are matched:
 * the label is `访问模式，当前：…` in Chinese and `Access mode, current: …` in English.
 */
const ACCESS_MODE_SELECTOR = 'button[aria-label^="访问模式"], button[aria-label^="Access mode"]'

/** Material Symbols — the Google font icon face. */
const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200'

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
 * Angular Elements loader
 * ------------------------------------------------------------------------- */

let elementsLoading: Promise<void> | undefined

/** Fetch and evaluate the Angular bundle once per page. */
function loadElements(): Promise<void> {
  if (window.customElements.get(ELEMENT_TAG) !== undefined) return Promise.resolve()
  elementsLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = ELEMENTS_URL
    script.addEventListener('load', () => { resolve() })
    script.addEventListener('error', () => { reject(new Error(`failed to load ${ELEMENTS_URL}`)) })
    document.head.append(script)
  })
  return elementsLoading
}

/** The custom element host: React renders the tag, Angular upgrades it. */
function CoordinationControls(): React.ReactElement {
  const isOn = React.useSyncExternalStore(subscribeTakeover, takeoverSnapshot, takeoverSnapshot)

  React.useEffect(() => {
    loadElements().catch((error: unknown) => {
      console.warn('[deepseek-coordination] Angular controls unavailable:', error)
    })
  }, [])

  return React.createElement(ELEMENT_TAG, { takeover: isOn ? 'on' : 'off' })
}

/* ------------------------------------------------------------------------- *
 * Settings section
 * ------------------------------------------------------------------------- */

function Icon(props: { name: string }): React.ReactElement {
  return React.createElement('span', { className: 'material-symbols-outlined', 'aria-hidden': true }, props.name)
}

/** The `协调` settings page. */
function CoordinationSettings(props: { style: HTMLStyleElement }): React.ReactElement {
  const isOn = React.useSyncExternalStore(subscribeTakeover, takeoverSnapshot, takeoverSnapshot)
  const toggle = (): void => { setTakeover(!isOn, props.style) }

  return React.createElement(
    'section',
    { className: 'dsh-coordination-settings' },
    React.createElement('h2', { className: 'dsh-coordination-settings__title' },
      React.createElement(Icon, { name: 'hub' }),
      React.createElement('span', null, '协调')),
    React.createElement('div', { className: 'dsh-coordination-settings__row' },
      React.createElement('label', { className: 'dsh-coordination-settings__switch' },
        React.createElement('input', {
          type: 'checkbox',
          checked: isOn,
          onChange: toggle,
          'aria-label': '权限接管',
        }),
        React.createElement('span', null, '权限接管'),
        React.createElement(Icon, { name: isOn ? 'shield' : 'shield_person' }))),
    React.createElement('p', { className: 'dsh-coordination-settings__hint' },
      isOn
        ? '已接管：输入框中的权限下拉已被隐藏，替换为协调面板的下拉。'
        : '未接管：输入框保留宿主自带的权限下拉。'),
    React.createElement('div', { className: 'dsh-coordination-settings__row' },
      React.createElement(CoordinationControls, null)),
    React.createElement('p', { className: 'dsh-coordination-settings__hint' },
      '职能 / 交互 / 情景 从左到右排列，修改会立即作用于输入框工具栏。'))
}

/* ------------------------------------------------------------------------- *
 * Plugin entry
 * ------------------------------------------------------------------------- */

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // Icon font and takeover rule outlive individual renders, so they live on one
  // effect each and disappear when the plugin unloads.
  ctx.effect(() => {
    const existing = document.getElementById(FONT_ID)
    if (existing !== null) return () => { /* owned elsewhere */ }
    const link = document.createElement('link')
    link.id = FONT_ID
    link.rel = 'stylesheet'
    link.href = FONT_HREF
    document.head.append(link)
    return () => { link.remove() }
  }, `${PLUGIN_ID}: Material Symbols`)

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
  }, () => React.createElement(CoordinationControls, null)))
}
