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
import { currentCopy, installLocale } from './i18n.js'
import { disposeTakeoverStyle, installTakeoverStyle } from './store.js'

const PLUGIN_ID = 'deepseek-coordination'

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
    // The takeover dialog is a sibling, not a child of the composer row: its
    // 1 s poll owns its own state, so opening or updating a dialog never
    // re-renders (and never re-styles) the composer itself.
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(ComposerControls, { sessionId: props.sessionId }),
      React.createElement(TakeoverDialog, { sessionId: props.sessionId }),
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
