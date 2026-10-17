/**
 * deepseek-coordination — Client half (browser side)
 *
 * Mounts two pieces of UI into the DSH Web host:
 *  1. a `协调` page in Settings (switches + the forced profession-lock group);
 *  2. the five coordination selectors inside the composer tool row
 *     (`conversation.input.left` — the free space right of the access-mode
 *     control).
 *
 * The widgets are Material UI React components. React itself comes from the
 * host's module table; @mui/material and emotion are bundled into this file by
 * tsdown (`alwaysBundle` inlines everything that is not `react` or
 * `@deepseek-ai/dsh-client-*`).
 *
 * The selectors and their option tooltips are owned by `./controls.ts`; the
 * settings page by `./settings.ts`; the injected takeover rule by `./store.ts`.
 * The host half exposes the selection route the controls read and write.
 *
 * Contract notes:
 *  - `inject` lists the client services used; package.json's `dsh.client.inject`
 *    separately lists module-table packages. Both are required.
 *  - Every registration is disposed with the plugin, including the injected
 *    takeover rule, through ctx.effect disposers.
 */
import * as React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ComposerControls } from './controls.js'
import { CoordinationSettings } from './settings.js'
import { disposeTakeoverStyle, installTakeoverStyle } from './store.js'

const PLUGIN_ID = 'deepseek-coordination'

/**
 * Memoised on purpose: the composer re-renders while the user types or opens
 * the "+" menu, and this plugin must not participate in that churn — a
 * re-render here makes emotion touch <head>, and the host closes its popover
 * on outside DOM mutation, which shows up as a popup that flashes and vanishes.
 */
const MemoControls = React.memo(function MemoControlsInner(props: { sessionId?: string }): React.ReactElement {
  return React.createElement(ComposerControls, { sessionId: props.sessionId })
})

const Settings = React.memo(function SettingsInner(): React.ReactElement {
  return React.createElement(CoordinationSettings, null)
})

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  installTakeoverStyle()
  ctx.effect(() => () => { disposeTakeoverStyle() }, `${PLUGIN_ID}: takeover rule`)

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
