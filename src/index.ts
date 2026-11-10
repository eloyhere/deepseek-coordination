/**
 * deepseek-coordination — Attention Manifest Protocol (AMP 0.9.0) host for DSH.
 *
 * One Cordis plugin registers:
 *  - seventeen AMP module tools plus the discovery bootstrap on `ctx.tools`;
 *  - the notification tool and its poll route;
 *  - AMP skills, human commands, a system-prompt contract and read-only routes;
 *  - a turn observer that keeps AMP turn positions aligned with the DSH log.
 *
 * The protocol kernel, gateway and SQLite store live in `AmpHost`; this module
 * is only composition.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { CooperationCoordinator } from 'attention-manifest-protocol/cooperation'
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
import { WireCapture } from './host/prestep.js'
import { recoverContext, type RecoveryStatus } from './host/recovery.js'
import { registerInputExtractors } from './host/channels/index.js'
import { SpillIndex } from './host/spill.js'
import { RetentionLedger } from './host/retention.js'
import { PruneTracker } from './host/prune.js'
import { CompactionTracker } from './host/compaction.js'
import { OutputSources } from './host/sources.js'
import { ForkTracker } from './host/fork.js'
import { SubagentTracker } from './host/subagent.js'
import { LineageSources } from './host/lineage.js'
import { asRecord } from './host/json.js'
import { HostNotificationBridge } from './host/hostNotifications.js'
import { fileWriteTakeoverGuard } from './host/writeTakeover.js'
import { DialogGate } from './host/dialogGate.js'

export const name = 'deepseek-coordination'

/** Host services this plugin composes; `webServer` is optional and read with `ctx.get`. */
export const inject = ['tools', 'systemPrompt', 'commands', 'skills', 'sessions', 'agents']

export { Config }
/** Exported for the client-integration tests; DSH reads only `name`/`inject`/`apply`. */
export { registerRoutes } from './host/routes.js'
export type { CoordinationConfig }

/** Zeroed recovery counters used when the activation-time replay failed. */
const EMPTY_RECOVERY_STATUS: RecoveryStatus = { sessions: 0, agents: 0, events: 0, hydrations: 0, failures: 0 }

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
  // The capture is created even when context optimization is disabled: it is
  // the audit input for later channels, while `register()` only injects when
  // the optimizer is enabled.
  const wire = new WireCapture()
  registerInputExtractors(wire)
  // P2 output channels: each tracker folds its own session events into bounded
  // records; `OutputSources` is what the optimizer reads at compile time.
  const spill = new SpillIndex()
  const retention = new RetentionLedger()
  const prune = new PruneTracker()
  const compaction = new CompactionTracker()
  const outputs = new OutputSources({ spill, retention, prune, compaction })
  // P3 lineage: one AMP cooperation kernel for subagent delegations, plus the
  // two host-side trackers. Ordinary forks and subagent children are distinct:
  // `ForkTracker` ignores `origin: 'subagent'` and `SubagentTracker` only reads
  // that origin. `LineageSources` keeps the optimizer's single-source contract.
  const coordinator = new CooperationCoordinator()
  const fork = new ForkTracker()
  const subagent = new SubagentTracker({ coordinator })
  const lineage = new LineageSources(outputs, fork, subagent)
  const optimizer = new AmpContextOptimizer(ctx, host, config, wire, lineage)
  host.contextOptimizer = optimizer
  optimizer.register()
  attachPreStepCapture(ctx, host, wire, optimizer)
  attachLineageObservation(ctx, fork, subagent)

  // R1: rebuild the in-process trackers from logs that predate this activation.
  // The replay is synchronous, reads no attachments and writes no store; a
  // failure only leaves AMP indexes empty and never blocks plugin activation.
  // The returned counters are exposed by `/amp/context`; a failed pass keeps
  // the zeroed default instead of dropping the field.
  let recoveryStatus: RecoveryStatus = EMPTY_RECOVERY_STATUS
  try {
    recoveryStatus = recoverContext(ctx, {
      capture: wire,
      fork,
      subagent,
      spill,
      retention,
      prune,
      compaction,
      // A reloaded plugin never saw the historical `turn/end` events. Settle
      // those existing AMP turns only; recovery does not create new facts.
      settleTurn: (sessionId, turn, reason) => sync.settleTurn(sessionId, turn, reason),
    })
  } catch (error) {
    wire.recordFailure('recovery', error)
  }

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
          version: '0.27.5',
          clientGraph,
          sync: () => sync.status(),
          // The three exclusion ledgers stay separate (wire.md §4.6): compiler
          // exclusions live in the optimizer, host-side ones in `outputs`, and
          // retention omissions in its own ledger. Read each expensive status
          // once per request instead of once per field.
          context: () => {
            const status = optimizer.status()
            // One read per request: the flat `lag`/`compilerExclusions*` fields
            // and the nested view must describe the same compile attempt.
            const contextDiagnostics = optimizer.diagnostics()
            const exclusions = outputs.exclusions()
            const retentionStatus = retention.status()
            const lineageStatus = lineage.status()
            // R4: one capture snapshot feeds both the flat `lastCapture` and
            // the nested `capture` view.
            const captureStatus = wire.status()
            return {
              ...status,
              compilerExclusions: status.excluded,
              /** First 50 compiler exclusions, projected to stable fields. */
              compilerExclusionsDetailed: contextDiagnostics.lastExclusions,
              hostExclusions: exclusions.slice(0, 50),
              hostExclusionCount: exclusions.length,
              retentionOmissions: retentionStatus,
              lineage: lineageStatus.lineage ?? lineageStatus,
              /** R1 activation-time recovery counters; zeroed when replay failed. */
              recovery: recoveryStatus,
              /** Most recent successful `agent/pre-step` capture, if any. */
              lastCapture: captureStatus.lastCapture,
              /** Full bounded capture status, preserving the legacy nested shape. */
              capture: captureStatus,
              /** Last compile-attempt diagnostics; `lag` is derived from it. */
              contextDiagnostics,
              lag: contextDiagnostics.lag,
            }
          },
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
    // Order matters for `tool/result`: spill and retention read the raw result
    // first, then prune pairs the same event as the adjacent replacement of a
    // `compaction/prune`. Compaction is independent and runs last.
    spill.observe(session.id, event)
    retention.observe(session.id, event)
    prune.observe(session.id, event)
    compaction.observe(session.id, event)
    // P3/P4: keep lineage item ids turn-qualified. The subagent tracker also
    // settles a child's delegation on `turn/end`; the fork tracker only records
    // the latest turn. Both are side records and never throw.
    fork.observeEvent(session.id, event)
    subagent.observeEvent(session.id, event)
    if (event.type === 'turn/end') {
      const data = asRecord(event.data)
      const turn = typeof data?.turn === 'number' ? data.turn : host.currentTurn(session.id)
      if (turn !== undefined) {
        wire.clearTurn(session.id, turn)
        optimizer.invalidate(session.id, turn)
      }
    }
  })
}

interface PreStepPayload {
  readonly agent: Agent
  readonly messages: readonly UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

type PreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: readonly UserMessage[]; readonly startsRequestSeries?: true }

/**
 * Capture the final `agent/pre-step` batch.
 *
 * The listener is registered as a waterfall wrapper: it calls `next()` first so
 * it observes the batch after DSH's own instruction/time/session-reference
 * listeners (and any later plugin listener) ran, then returns that decision
 * unchanged. Only `enter` decisions carry a step worth capturing; `reject` is
 * returned untouched. The registration itself and every capture path are
 * fail-open so a missing event or a malformed batch cannot break the step.
 */
function attachPreStepCapture(ctx: Context, host: AmpHost, wire: WireCapture, optimizer: AmpContextOptimizer): void {
  try {
    const on = ctx.on.bind(ctx) as unknown as (
      name: string,
      handler: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
    ) => () => void
    ctx.effect(
      () => on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        try {
          const agent = asRecord(payload.agent)
          const sessionId = typeof agent?.id === 'string' ? agent.id : undefined
          if (sessionId === undefined) return decision
          const turn = typeof payload.turn === 'number' ? payload.turn : host.currentTurn(sessionId)
          if (turn === undefined) return decision
          const step = typeof payload.step === 'number' ? payload.step : 0
          wire.capture(payload.agent, decision.messages, { turn, step })
          optimizer.invalidate(sessionId, turn)
        } catch (error) {
          // AMP is a side path: a capture or wiring failure must never reject
          // the step or replace DSH's own decision.
          wire.recordFailure('agent/pre-step', error)
        }
        return decision
      }),
      'deepseek-coordination: agent/pre-step capture',
    )
  } catch {
    // This composition does not declare the `agent/pre-step` waterfall (or the
    // context cannot bind it). Context optimization degrades to the existing
    // session-event prompt instead of failing plugin activation.
  }
}

interface AgentCreatedPayload {
  readonly agent?: unknown
}

/**
 * Observe `agent/created` to record ordinary fork and subagent lineage.
 *
 * Both trackers classify from the durable session header: `ForkTracker` takes
 * seeded non-subagent sessions and `SubagentTracker` takes `origin ===
 * 'subagent'` children, so neither can claim the other's session. The listener
 * and every observation are fail-open; a missing `agent/created` event just
 * leaves both indexes empty.
 */
function attachLineageObservation(ctx: Context, fork: ForkTracker, subagent: SubagentTracker): void {
  try {
    const on = ctx.on.bind(ctx) as unknown as (
      name: string,
      handler: (payload: AgentCreatedPayload) => void,
    ) => () => void
    ctx.effect(
      () => on('agent/created', (payload) => {
        try {
          fork.observeAgent(payload.agent)
          subagent.observeAgent(payload.agent)
        } catch {
          // AMP is a side path: an observation failure must not fail agent
          // creation or change the agent DSH sees.
        }
      }),
      'deepseek-coordination: lineage observation',
    )
  } catch {
    // This composition does not dispatch `agent/created` (or cannot bind it).
    // Fork and subagent items stay absent rather than blocking activation.
  }
}
