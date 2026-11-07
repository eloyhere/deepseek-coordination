/**
 * deepseek-coordination — Attention Manifest Protocol (AMP 0.7.9) host for DSH.
 *
 * One Cordis plugin registers:
 *  - fifteen AMP module tools plus the discovery bootstrap on `ctx.tools`;
 *  - the notification tool and its poll route;
 *  - AMP skills, human commands, a system-prompt contract and read-only routes;
 *  - a turn observer that keeps AMP turn positions aligned with the DSH log.
 *
 * The protocol kernel, gateway and SQLite store live in `AmpHost`; this module
 * is only composition.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { Config, type Config as CoordinationConfig } from './host/config.js'
import { AmpHost } from './host/amp.js'
import { loadAmpProtocol } from './host/protocol.js'
import { NotificationCenter } from './host/notify.js'
import { registerNotificationTool } from './host/notifyTools.js'
import { registerDiscoverTool, registerAmpModuleTools, registerHarnessTool } from './host/tools.js'
import { registerReplaceTool } from './host/replaceTool.js'
import { registerAmpPrompt } from './host/prompt.js'
import { hostLocale, openLocalizedCatalog } from './host/catalog.js'
import { registerRoutes } from './host/routes.js'
import { AmpSync } from './host/sync.js'
import { HarnessBridge } from './host/bridge.js'
import { AmpContextOptimizer } from './host/context.js'
import { HostNotificationBridge } from './host/hostNotifications.js'
import { fileWriteTakeoverGuard } from './host/writeTakeover.js'
import { DialogGate } from './host/dialogGate.js'

export const name = 'deepseek-coordination'

/** Host services this plugin composes; `webServer` is optional and read with `ctx.get`. */
export const inject = ['tools', 'systemPrompt', 'commands', 'skills', 'sessions', 'agents']

export { Config }
export type { CoordinationConfig }

export async function apply(ctx: Context, config: CoordinationConfig): Promise<void> {
  const protocol = await loadAmpProtocol()
  ;(ctx as unknown as { fiber?: { assertActive?: () => void } }).fiber?.assertActive?.()

  const notifications = new NotificationCenter()
  const host = new AmpHost(ctx, config, protocol)
  const dialogs = new DialogGate(host)
  if (config.routes || config.notifications) dialogs.attach(ctx)

  // DSH owns the interface language on the client; start from the process
  // locale and let the client report the language it actually renders.
  const catalog = openLocalizedCatalog(ctx, host, hostLocale(), { skills: config.skills, commands: config.commands })

  ctx.effect(() => ctx.provide('amp', host), 'deepseek-coordination: AMP service')
  ctx.effect(() => () => host.close(), 'deepseek-coordination: AMP kernel')
  ctx.effect(() => () => catalog.dispose(), 'deepseek-coordination: localized catalog')

  // The prompt explains the takeover; this guard makes it real. Native file
  // writes stay denied only for workspaces whose owner enabled the switch, so
  // AMP workspace.write (which does not pass through ctx.tools) remains usable.
  const toolGuard = (ctx.tools as unknown as { guard?: (guard: (execution: { name: string; agent?: unknown }) => string | undefined) => () => void }).guard
  if (typeof toolGuard === 'function') {
    ctx.effect(() => toolGuard.call(ctx.tools, fileWriteTakeoverGuard(host)), 'deepseek-coordination: file-write takeover guard')
  }

  const sync = new AmpSync(ctx, host)
  host.sync = sync
  sync.attach()
  host.bridge = new HarnessBridge(ctx)
  const optimizer = new AmpContextOptimizer(ctx, host, config)
  host.contextOptimizer = optimizer
  optimizer.register()

  registerAmpModuleTools(ctx, host)
  registerDiscoverTool(ctx, host)
  registerReplaceTool(ctx, host)
  registerHarnessTool(ctx, host)

  if (config.notifications) {
    registerNotificationTool(ctx, notifications, (session) => host.notificationTakeoverEnabled(session))
    const hostNotifications = new HostNotificationBridge(
      ctx,
      host,
      notifications,
      ( ) => host.preferences.get().takeoverNotifications,
    )
    hostNotifications.attach()
  }
  if (config.prompt) {
    registerAmpPrompt(ctx, host)
  }

  // `webServer` is mounted by the Web composition, which can be later than this
  // row in the boot order. `ctx.inject` binds the routes whenever the service
  // becomes available instead of silently skipping them on a cold start.
  if (config.routes || config.notifications) {
    const clientGraph = (): unknown => {
      const modules = ctx.get('clientModules') as { graph?: () => unknown } | undefined
      return modules?.graph?.()
    }
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.get('webServer') as WebServer | undefined
      if (server === undefined) return
      webCtx.effect(
        () => registerRoutes(server, {
          host,
          notifications,
          dialogs,
          version: '0.24.0',
          clientGraph,
          sync: () => sync.status(),
          context: () => optimizer.status(),
          locale: () => catalog.locale,
          onLocale: (value) => {
            catalog.setLocale(value)
          },
        }),
        'deepseek-coordination: HTTP routes',
      )
    })
  }

  ctx.on('session/event', (session, event) => {
    host.observeSessionEvent(session, event)
    sync.onSessionEvent(session, event)
    optimizer.onSessionEvent(session, event)
  })
}
