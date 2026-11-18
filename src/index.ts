/**
 * deepseek-coordination — Attention Manifest Protocol (AMP 0.9.1) host for DSH.
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
import { benefitCacheKey, createBenefitCache } from './host/benefitCache.js'
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
import { join } from 'node:path'
import { computeBenefits } from './host/benefits.js'
import { computeEffectiveness, summarizeErrors } from './host/effectiveness.js'
import {
  BENEFIT_HISTORY_FILE,
  historyChanged,
  historyFromBenefits,
  loadBenefitHistory,
  mergeBenefitInput,
  mergeErrorHistory,
  mergeHistories,
  saveBenefitHistory,
} from './host/benefitHistory.js'
import { resolvePricing } from './host/pricing.js'
import { registryStats } from './host/registry.js'
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
import { installFileTakeoverGuards, type GuardRegistrar } from './host/writeTakeover.js'
import { toolCopy } from './host/toolCopy.js'
import { DialogGate } from './host/dialogGate.js'
import { registerIntakeTool } from './host/intake.js'

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
  // DSH binds the approval and user-question waterfalls per agent scope, so a
  // session whose agent was composed before this activation does not see the
  // gate and falls back to the native dialog. Attach to every live agent and
  // every future one (the same pattern as the file takeover guards).
  {
    const gateRoot = ((ctx as unknown as { root?: unknown }).root ?? ctx) as unknown as {
      agents?: { list?: () => readonly unknown[] }
      on?: (name: string, listener: (payload: { agent?: unknown }) => void) => (() => void) | undefined
    }
    const attachGate = (agent: unknown): void => {
      const agentCtx = (agent as { ctx?: unknown } | undefined)?.ctx
      if (agentCtx === undefined || agentCtx === null) return
      try {
        dialogs.attach(agentCtx as Context)
      } catch {
        // An agent context that cannot host the listeners keeps native dialogs.
      }
    }
    for (const agent of gateRoot.agents?.list?.() ?? []) attachGate(agent)
    try {
      gateRoot.on?.('agent/created', (payload) => attachGate(payload.agent))
    } catch {
      // This composition does not dispatch `agent/created`.
    }
  }

  // DSH owns the interface language on the client; start from the process
  // locale and let the client report the language it actually renders.
  const catalog = openLocalizedCatalog(ctx, host, hostLocale(), { skills: config.skills, commands: config.commands })
  host.locale = catalog.locale

  ctx.effect(() => ctx.provide('amp', host), 'deepseek-coordination: AMP service')
  ctx.effect(() => () => host.close(), 'deepseek-coordination: AMP kernel')
  ctx.effect(() => () => catalog.dispose(), 'deepseek-coordination: localized catalog')

  // The prompt explains the takeover; this guard makes it real. Register it on
  // every live agent scope and every future agent, not just the scope that
  // happened to load this plugin: otherwise a sibling session in another
  // project keeps calling native edit/write while this chat is guarded.
  ctx.effect(
    () => installFileTakeoverGuards(ctx as unknown as GuardRegistrar, host, () => toolCopy(host.locale)),
    'deepseek-coordination: file read/write/search takeover guards',
  )

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

  // Recovery is deliberately not run at activation. Replaying session logs can
  // feed tens of thousands of events through the trackers synchronously, which
  // blocks the host event loop exactly while a conversation is opening. It is
  // available on demand through `POST /amp/recover`; the route keeps reporting
  // zeroed counters until someone asks for a pass.
  let recoveryStatus: RecoveryStatus = EMPTY_RECOVERY_STATUS

  registerAmpModuleTools(ctx, host)
  registerDiscoverTool(ctx, host)
  registerReplaceTool(ctx, host)
  registerHarnessTool(ctx, host)
  // The plan preview dialog is a notification surface; without the notification
  // centre there is no dialog to render it in, so the intake skips the preview.
  registerIntakeTool(ctx, host, config.notifications ? notifications : undefined)

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
    // AMP's entity cache is an LRU with a TTL. The value read model is normally
    // asked for twice in quick succession (the strip prefetches it, then the
    // details dialog opens), so one aggregation serves both; a changed counter
    // produces a new key and an expired entry recomputes.
    const benefitsCache = createBenefitCache()
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
          version: '0.31.2',
          clientGraph,
          sync: () => sync.status(),
          // `/amp/context` is polled by the conversation panel, so it must stay
          // cheap: counters only, no journal scan, no file I/O and no pricing.
          // The three exclusion ledgers stay separate (wire.md §4.6): compiler
          // exclusions live in the optimizer, host-side ones in `outputs`, and
          // retention omissions in its own ledger. Read each status once per
          // request instead of once per field.
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
          // On-demand value quantification. It scans the gateway journal, reads
          // and merges the durable benefit history, prices the selected model and
          // may write the history file back, so it must never run on a mount, a
          // poll or a timer: the panel asks for it only while its details dialog
          // is open (`GET /amp/benefits`).
          benefits: () => {
            const status = optimizer.status()
            const contextDiagnostics = optimizer.diagnostics()
            const selection = optimizer.modelSelection()
            const usage = optimizer.usageSnapshot()
            const journal = host.journalEntries()
            const now = new Date()
            // Cheap projection of every input the read model depends on; the
            // LRU keys on it so a repeat request reuses the aggregation while a
            // changed counter recomputes instead of showing a stale number.
            const cacheKey = benefitCacheKey({
              selection,
              compilations: status.compilations,
              failures: status.failures,
              excluded: status.excluded,
              lastItems: status.lastItems,
              tokensInjected: status.tokensInjected,
              lastCompileAt: contextDiagnostics.lastCompileAt,
              compilerExclusions: contextDiagnostics.compilerExclusions,
              usage,
              journalLength: journal.length,
            })
            const cached = benefitsCache.get<Record<string, unknown>>(cacheKey, now.toISOString())
            if (cached !== undefined) return cached
            // Value quantification is derived from the same status object the
            // rest of this route serves, so a poll can never mix snapshots.
            // The tariff follows the host-selected provider/model, and its
            // input price is blended with the observed prompt-cache hit rate.
            const pricing = resolvePricing(selection)
            // Gateway calls are the execution sample behind the error rate and
            // latency score. A journal failure degrades to an unavailable error
            // module; it must not fail the benefits route.
            let errors = summarizeErrors([])
            try {
              errors = summarizeErrors(journal)
            } catch {
              // Keep the empty summary.
            }
            // Live counters reset when DSH restarts. Merge the durable
            // high-water ledger so the panel shows the workspace's history
            // instead of an empty state after every reload.
            const storage = host.storage()
            const defaultRoot = typeof storage.defaultRoot === 'string' ? storage.defaultRoot : undefined
            const roots = Array.isArray(storage.roots)
              ? storage.roots.flatMap((entry) => {
                const row = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : undefined
                return row !== undefined && typeof row.directory === 'string' && row.directory.length > 0
                  ? [{ root: typeof row.root === 'string' ? row.root : undefined, directory: row.directory, open: row.open === true }]
                  : []
              })
              : []
            const preferredRoot = defaultRoot === undefined
              ? roots.find((entry) => entry.open) ?? roots[0]
              : roots.find((entry) => entry.root === defaultRoot)
            // `host.storage()` can answer with the machine-wide directory before
            // the first AMP call binds a workspace root. Read every candidate
            // and merge by high-water marks so the two copies cannot diverge.
            const directories = [
              ...(preferredRoot === undefined ? [] : [preferredRoot.directory]),
              ...(typeof storage.directory === 'string' ? [storage.directory] : []),
            ].filter((value, index, all) => all.indexOf(value) === index)
            const historyPaths = directories.map((value) => join(value, BENEFIT_HISTORY_FILE))
            const historyPath = historyPaths[0]
            const history = mergeHistories(historyPaths.map((value) => loadBenefitHistory(value)))
            const mergedStatus = mergeBenefitInput(status, history)
            const mergedErrors = mergeErrorHistory(errors, history)
            const baseBenefits = computeBenefits(mergedStatus, contextDiagnostics, pricing, optimizer.usageSnapshot(), registryStats(), mergedErrors, null, history)
            const benefits = {
              ...baseBenefits,
              effectiveness: computeEffectiveness(baseBenefits.quality?.score ?? null, mergedErrors, baseBenefits.tokens.roi),
            }
            if (historyPath !== undefined) {
              const failures = typeof status.failures === 'number' ? status.failures : 0
              const next = historyFromBenefits(baseBenefits, mergedErrors, failures, new Date(), mergedStatus.prune)
              if (historyChanged(history, next)) saveBenefitHistory(historyPath, next)
            }
            benefitsCache.set(cacheKey, benefits, now.toISOString())
            return benefits
          },
          // Explicit history replay. Synchronous and potentially heavy (one
          // pass can replay tens of thousands of session events), so it is
          // never scheduled automatically: `POST /amp/recover` runs it once and
          // reports the resulting counters.
          recover: () => {
            recoveryStatus = recoverContext(ctx, {
              capture: wire,
              fork,
              subagent,
              spill,
              retention,
              prune,
              compaction,
              settleTurn: (sessionId, turn, reason) => sync.settleTurn(sessionId, turn, reason),
            })
            return recoveryStatus
          },
          locale: () => catalog.locale,
          onLocale: (value) => {
            catalog.setLocale(value)
            host.locale = catalog.locale
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
    // DSH's prune facts enter AMP's planner as candidates, so the turn-end
    // decision can report `superseded` for them instead of a side ledger only.
    if (event.type === 'compaction/prune') {
      try {
        optimizer.notePruneRecords(session.id, prune.list(session.id))
      } catch {
        // Advisory bridge: a malformed record must not break the event.
      }
    }
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
        optimizer.invalidate(session.id)
        // The turn's attention entries are complete here; let AMP decide which
        // of them are still worth their tokens and record the checkpoint.
        optimizer.reviewTurn(session.id)
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
          // No cache invalidation here: a changed prompt produces a different
          // AMP cache signature, and flushing per step would defeat reuse.
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
