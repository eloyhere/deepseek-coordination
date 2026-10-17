/**
 * deepseek-coordination — Client half (browser side)
 *
 * Current scope is a scaffold: it registers the plugin's locale dictionaries and
 * injects a settings section that probes the host half's liveness route. The
 * host half is src/index.ts; this file must not be hand-wrapped for the module
 * loader — tsdown emits the window.__ModuleLoader__.load() wrapper.
 *
 * Before extending, keep these rules from the DSH plugin contract:
 *   - react and @deepseek-ai/dsh-client-* resolve through the module table's
 *     require(); they are never bundled here.
 *   - `inject` declares the client services used; package.json's dsh.client.inject
 *     separately declares module-table dependencies. Both are required.
 *   - Use the --dsw-alias-* theme tokens for colors, never hard-coded values, or
 *     the page breaks in one of the themes.
 */
import * as React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

const PLUGIN_ID = 'deepseek-coordination'
const ROUTE_PREFIX = '/deepseek-coordination'

/** Uniform wrapper for calling host routes: POST + JSON + { ok, value | error }. */
async function post(path: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })
  } catch {
    return { ok: false, error: 'route unavailable' }
  }
  try {
    const envelope: unknown = await response.json()
    if (typeof envelope !== 'object' || envelope === null) return { ok: false, error: 'bad response' }
    const record = envelope as { ok?: boolean; value?: unknown; error?: string }
    if (record.ok === true) return { ok: true, value: record.value ?? record }
    return { ok: false, error: record.error ?? 'route error' }
  } catch {
    return { ok: false, error: 'bad response' }
  }
}

/** Settings section: reports whether the host half answers on its liveness route. */
function SettingsPage(): React.ReactElement {
  const [status, setStatus] = React.useState('checking…')

  React.useEffect(() => {
    let active = true
    void post(`${ROUTE_PREFIX}/ping`, {}).then((r) => {
      if (active) setStatus(r.ok ? 'Host ready' : (r.error ?? 'unavailable'))
    })
    return () => { active = false }
  }, [])

  return React.createElement(
    'div',
    null,
    React.createElement('p', null, 'deepseek-coordination'),
    React.createElement('p', { style: { color: 'var(--dsw-alias-label-secondary)' } }, status),
  )
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(PLUGIN_ID, 'zh', { title: 'deepseek-coordination' }), `${PLUGIN_ID}: zh dict`)
  ctx.effect(() => ctx.locale.register(PLUGIN_ID, 'en', { title: 'deepseek-coordination' }), `${PLUGIN_ID}: en dict`)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PLUGIN_ID,
    order: 50,
    label: () => ctx.locale.bind(PLUGIN_ID)('title'),
  }, SettingsPage))
}
