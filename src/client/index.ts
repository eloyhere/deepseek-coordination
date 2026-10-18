/**
 * deepseek-coordination — Client half (browser side)
 *
 * Mounts three pieces of UI into the DSH Web host:
 *  1. a `协调` page in Settings (six groups of switches, selects and read-only
 *     host values);
 *  2. the five coordination selectors inside the composer tool row
 *     (`conversation.input.left` — the free space right of the access-mode
 *     control);
 *  3. the service-level takeover dialog (approval / question windows), rendered
 *     as a sibling of the selectors in the same composer slot.
 *
 * The widgets are Material UI React components. React itself comes from the
 * host's module table; @mui/material and emotion are bundled into this file by
 * tsdown (`alwaysBundle` inlines everything that is not `react` or
 * `@deepseek-ai/dsh-client-*`).
 *
 * The selectors and their option tooltips are owned by `./controls.ts`; the
 * settings page by `./settings.ts`; the takeover dialog by `./takeover.ts`; the
 * injected access-mode rule by `./store.ts`; the host-following language store
 * by `./i18n.ts`. The host half exposes the selection and takeover routes the
 * client reads and writes, and receives the locale report.
 *
 * Contract notes:
 *  - `inject` lists the client services used; package.json's `dsh.client.inject`
 *    separately lists module-table packages. Both are required.
 *  - The locale store is installed before any slot registration, so the first
 *    render already resolves the host's language.
 *  - Every registration is disposed with the plugin, including the injected
 *    access-mode rule, through ctx.effect disposers.
 */
import * as React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ComposerControls, clearComposerCaches } from './controls.js'
import { CoordinationSettings } from './settings.js'
import { TakeoverDialog } from './takeover.js'
import { CoordinationPanels } from './panel.js'
import { currentCopy, installLocale } from './i18n.js'
import { disposeTakeoverStyle, installTakeoverStyle } from './store.js'
import { copyFor } from '../shared/i18n.js'

const PLUGIN_ID = 'deepseek-coordination'

/* ------------------------------------------------------------------------- *
 * Settings nav icon
 *
 * The settings shell paints a fixed glyph per section id and falls back to its
 * gear for plugin ids — `settings.section` options are only `{ id, order, label }`,
 * so a registrant cannot supply an icon. The host's nav button is decorated
 * instead: the gear `<svg>` is hidden and the button's `::before` paints the
 * Material "sync" glyph (two arrows head-to-tail, the same path as MUI's
 * `Sync` icon) in `currentColor`, so hover/active states keep working.
 * ------------------------------------------------------------------------- */

/** Material Icons `sync` path, as rendered by `@mui/icons-material/Sync`. */
const SYNC_ICON_PATH =
  'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z'

const NAV_ICON_ATTRIBUTE = 'data-dc-nav'
const NAV_ICON_STYLE_ID = 'deepseek-coordination-nav-icon'

/** CSS mask of the sync glyph; `encodeURIComponent` keeps the data URI valid. */
function navIconMask(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${SYNC_ICON_PATH}"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/**
 * Decorate this plugin's settings nav row with the sync icon.
 *
 * Marking the button (not rewriting its children) keeps React's tree intact:
 * the rule only hides the host's own `<svg>` and paints the glyph in front of
 * the label. A MutationObserver re-marks the row whenever the settings panel
 * re-renders (the shell mounts it on open), and the locale title is matched in
 * both shipped languages so a language switch does not lose the icon.
 */
function installNavIcon(): () => void {
  if (typeof document === 'undefined') return () => {}
  const style = document.createElement('style')
  style.id = NAV_ICON_STYLE_ID
  style.textContent = `
    button[${NAV_ICON_ATTRIBUTE}="sync"] > svg { display: none !important; }
    button[${NAV_ICON_ATTRIBUTE}="sync"]::before {
      content: "";
      width: 16px;
      height: 16px;
      flex: none;
      background-color: currentColor;
      -webkit-mask: ${navIconMask()} center / 16px 16px no-repeat;
      mask: ${navIconMask()} center / 16px 16px no-repeat;
    }
  `
  document.head.appendChild(style)

  const titles = new Set([
    copyFor('zh-CN').settings.title,
    copyFor('en-US').settings.title,
  ])
  let scheduled = false
  const decorate = (): void => {
    scheduled = false
    // The nav exists only while the settings dialog is mounted; leaving chat
    // streaming untouched keeps the observer's steady-state cost at one query.
    if (document.querySelector('[data-shortcut-modal="settings"]') === null) return
    for (const button of document.querySelectorAll('nav button')) {
      const label = (button.textContent ?? '').trim()
      if (!titles.has(label)) continue
      if (button.getAttribute(NAV_ICON_ATTRIBUTE) !== 'sync') {
        button.setAttribute(NAV_ICON_ATTRIBUTE, 'sync')
      }
    }
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(decorate)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  schedule()
  return () => {
    observer.disconnect()
    style.remove()
    for (const button of document.querySelectorAll(`button[${NAV_ICON_ATTRIBUTE}="sync"]`)) {
      button.removeAttribute(NAV_ICON_ATTRIBUTE)
    }
  }
}

interface MemoControlsProps {
  sessionId?: string
}

/**
 * Memoised on purpose: the composer re-renders while the user types or opens
 * the "+" menu, and this plugin must not participate in that churn — a
 * re-render here makes emotion touch <head>, and the host closes its popover
 * on outside DOM mutation, which shows up as a popup that flashes and vanishes.
 *
 * The comparator deliberately looks at `sessionId` only: the slot also passes
 * the composer's `input`, which changes on every keystroke, so React's default
 * shallow comparison would re-render this row on every character typed.
 */
const MemoControls = React.memo(
  function MemoControlsInner(props: MemoControlsProps): React.ReactElement {
    // The takeover dialog and the docked panel column are siblings, not
    // children of the composer row: their own state (polling, routing) never
    // re-renders the composer.
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(ComposerControls, { sessionId: props.sessionId }),
      React.createElement(TakeoverDialog, { sessionId: props.sessionId }),
      React.createElement(CoordinationPanels, { sessionId: props.sessionId }),
    )
  },
  (previous: MemoControlsProps, next: MemoControlsProps): boolean => previous.sessionId === next.sessionId,
)

const Settings = React.memo(function SettingsInner(): React.ReactElement {
  return React.createElement(CoordinationSettings, null)
})

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // Follow the host language first: settings labels and the composer copy must
  // already be correct when the first slot renders.
  ctx.effect(() => installLocale(ctx), `${PLUGIN_ID}: locale store`)

  installTakeoverStyle()
  ctx.effect(() => () => {
    disposeTakeoverStyle()
    clearComposerCaches()
  }, `${PLUGIN_ID}: takeover rule`)

  // The host has no icon option for a settings section, so decorate our nav row
  // with the sync glyph (see `installNavIcon`).
  ctx.effect(() => installNavIcon(), `${PLUGIN_ID}: settings nav icon`)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PLUGIN_ID,
    order: 50,
    // A thunk is re-read per render, so the nav row follows a language change
    // without re-registering the slot.
    label: () => currentCopy().settings.title,
  }, Settings))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: PLUGIN_ID,
    order: 40,
  }, MemoControls))
}
