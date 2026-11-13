/**
 * Client half: notifications, blocking native-dialog takeovers and AMP panels.
 * The host consumes approval/question waterfalls; the shared Modal adapter
 * replaces host presentation while preserving its callbacks.
 */
import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NotificationHost } from './notification.js'
import { DialogHost } from './dialogs.js'
import { AmpPanel } from './panel.js'
import { AmpSettings } from './settingsPanel.js'
import { AMP_COPY } from './ampCopy.js'
import { setLocale, currentLocale } from './i18n.js'

export const name = 'deepseek-coordination'

/** Client services used at runtime. */
export const inject = ['slots', 'locale']

const NS = 'coordination'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    coordination: string
  }
}

const dictionaries = AMP_COPY

function NotificationSeat(props: PropsRuntime<'conversation.input.dock'>): React.ReactElement {
  const seat = props as unknown as { sessionId?: string; session?: { id?: string } }
  const sessionId = seat.sessionId ?? seat.session?.id
  return React.createElement(React.Fragment, null,
    React.createElement(NotificationHost, { sessionId }),
    React.createElement(DialogHost, { sessionId }),
  )
}

function reportClient(payload: Record<string, unknown>): void {
  try {
    if (typeof fetch !== 'function' || typeof location === 'undefined') return
    void fetch('/deepseek-coordination/amp/client-report', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, locale: currentLocale(), version: '0.30.2', href: location.href }),
    }).catch(() => undefined)
  } catch {
    // Diagnostics must never break the plugin.
  }
}

export function apply(ctx: Context): void {
  const locale = ctx.locale as unknown as {
    getLocale(): { active?: unknown }
    subscribe(listener: () => void): () => void
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string) => string
  }

  // The host registers the AMP catalog in the language this client renders, so
  // report every switch of the active locale, not just the first one.
  const adopt = (): void => {
    const before = currentLocale()
    setLocale(locale.getLocale().active)
    if (currentLocale() !== before) reportClient({ phase: 'locale' })
  }
  adopt()
  ctx.effect(() => locale.subscribe(adopt), 'deepseek-coordination: locale subscription')
  ctx.effect(() => locale.register(NS, dictionaries as never), 'deepseek-coordination: dictionaries')

  reportClient({ phase: 'start' })

  const registered: string[] = []
  const errors: string[] = []
  const register = (key: string, options: Record<string, unknown>, component: unknown): (() => void) => {
    try {
      const dispose = ctx.slots.register(options as never, component as never)
      registered.push(key)
      return dispose
    } catch (error) {
      errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  ctx.slots.inject('conversation.input.dock', () => {
    const disposers: Array<() => void> = []
    try {
      disposers.push(register('conversation.input.dock:notifications', {
        name: 'conversation.input.dock',
        id: 'deepseek-coordination.notifications',
        order: 80,
      }, NotificationSeat))
      disposers.push(register('conversation.input.dock:amp', {
        name: 'conversation.input.dock',
        id: 'deepseek-coordination.amp',
        order: 90,
        locale: NS,
      }, AmpPanel))
    } catch (error) {
      for (const dispose of disposers) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  })

  ctx.slots.inject('settings.section', () => {
    const dispose = register('settings.section', {
      name: 'settings.section',
      id: 'deepseek-coordination',
      order: 100,
      label: () => locale.bind(NS)('ampTitle'),
      locale: NS,
    }, AmpSettings)
    return dispose
  })


  const report = (): void => {
    reportClient({
      phase: 'registered',
      registered,
      errors,
      slots: (ctx.slots as unknown as { keys?: () => string[] }).keys?.() ?? null,
    })
  }
  report()
  window.setTimeout(report, 1200)
}

