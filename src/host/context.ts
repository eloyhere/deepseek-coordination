/**
 * AMP attention → DSH prompt context.
 *
 * AMP's Context module compiles a bounded model payload from attention items and
 * records every exclusion. This adapter builds the items from the live harness
 * state (prompt, goal, todo plan, recent tool outcome, workspace) and injects the
 * compiled text as a dynamic runtime context, so attention selection actually
 * changes what the model sees rather than remaining a read-only panel value.
 *
 * P0 keeps the compile step-correct: `contextFor` reads the prompt captured by
 * `agent/pre-step` instead of the last committed `user/message`, the cache key
 * includes the step, and items whose content can change between steps use a
 * step-qualified wire slot. `compileTurnContext` reuses an existing attention
 * object without updating its summary, so a step-qualified id is the only way
 * to guarantee a later step does not see the previous step's summary.
 *
 * P2 adds the output-channel seam: `sources.itemsFor(agent)` (spill, prune,
 * compaction) is merged with the P1 items captured on `PendingInput`. Every
 * merged item is cloned with the live step appended to its id and with
 * `scope` replaced by this optimizer's compile scope. P1 extractors can only
 * guess the tenant and the turn, and a reused id would serve a stale summary;
 * both are fixed here rather than in each channel.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { AttentionObject } from 'attention-manifest-protocol/attention'
import type { ContextPruneCandidate } from 'attention-manifest-protocol/context'
import type { AmpHost } from './amp.js'
import type { Config } from './config.js'
import type { ContextCacheStats } from './contextCache.js'
import { ContextPruner } from './contextPrune.js'
import { MAX_SUBMITTED_ENTRIES, candidateOf, pruneRecordCandidate } from './contextPrune.js'
import type { ContextPruneOutcome, ContextPruneStats } from './contextPrune.js'
import type { PruneRecord } from './prune.js'
import { estimateTokens } from './tokenEstimate.js'
import type { WireCapture, WireCaptureStatus } from './prestep.js'
import type { OutputStatus, WireItemSource } from './sources.js'
import { diffTombstones } from './tombstones.js'
import type { TombstoneMap } from './tombstones.js'
import { asRecord } from './json.js'
import { toCreateAttention, wireId } from './wire.js'
import type { CreateAttentionInput, WireChannel, WireItem, WireScope, WireScores } from './wire.js'

const ACTOR = 'dsh-attention'

/** Maximum wire id length, matching wire.md §4.2 and `wire.ts`. */
export const MAX_WIRE_ID_LENGTH = 200

/** Hex characters appended when a step-qualified id is truncated. */
const STEP_ID_DIGEST_LENGTH = 12

interface ContextStats {
  compilations: number
  failures: number
  excluded: number
  lastTokens: number
  lastCompilerTokens: number
  lastCharacters: number
  lastItems: number
  lastPreview: string
}

/**
 * The package one step actually injected, retained for `attention.context`.
 *
 * `tokens` is AMP's accounting (measured on the serialized projection);
 * `renderedTokens` is the estimate for the text the model received. Both are
 * reported because the renderer is compact and the compiler counts envelopes.
 */
export interface ContextPackageView {
  readonly sessionId: string
  readonly compiledAt: string
  readonly items: readonly { readonly id: string; readonly summary: string; readonly tokens: number }[]
  readonly exclusions: readonly ContextExclusionView[]
  readonly tokens: number
  readonly renderedTokens: number
  readonly budgetTokens: number
  readonly text: string
}

/** The subset of AMP's `CompiledContext` this module retains. */
interface CompiledPackage {
  readonly compiledAt: string
  readonly items: readonly { readonly id: string; readonly summary: string; readonly usage: { readonly tokens: number } }[]
  readonly exclusions: readonly unknown[]
  readonly usage: { readonly tokens: number }
}

/** Per-session diagnostics retained before the oldest session is evicted. */
const MAX_DIAGNOSTIC_SESSIONS = 64

/** Exclusions projected into diagnostics; the count still reports every one. */
const MAX_DIAGNOSTIC_EXCLUSIONS = 50

/**
 * One compiler exclusion projected onto its stable, unknown-safe fields.
 *
 * `detail` is not part of the current compiler type; it is kept only when a
 * future or deployment-specific exclusion actually carries a string there.
 * Every other field (version, pointer, …) is deliberately dropped.
 */
export interface ContextExclusionView {
  id: string
  reason: string
  detail?: string
}

/**
 * Read-only compile diagnostics for `/amp/context`.
 *
 * `lag` describes input freshness, not completeness: `0` means the compile
 * read a pre-step capture for this session/turn, `1` means it fell back to
 * session-event state. It never claims that the current step contains content
 * the pre-step hook did not capture.
 */
export interface ContextDiagnostics {
  lag: 0 | 1
  pending: boolean
  lastCompileAt?: string
  compilerExclusions: number
  lastExclusions: readonly ContextExclusionView[]
}

/** Internal last-compile record; always complete, unlike {@link ContextDiagnostics}. */
interface CompileDiagnostics {
  readonly lastCompileAt: string
  readonly pending: boolean
  readonly lag: 0 | 1
  readonly compilerExclusions: number
  readonly lastExclusions: readonly ContextExclusionView[]
}

/** Clock read that must not turn a successful compile into a failed one. */
function nowIso(): string {
  try {
    return new Date().toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

/** Project one exclusion; malformed entries are dropped instead of fabricated. */
function exclusionViewOf(value: unknown): ContextExclusionView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = record.id
  const reason = record.reason
  if (typeof id !== 'string' || typeof reason !== 'string') return undefined
  const detail = record.detail
  return typeof detail === 'string' ? { id, reason, detail } : { id, reason }
}

/** Bounded projection of a compiler exclusion list; never throws. */
function exclusionViewsOf(exclusions: unknown): readonly ContextExclusionView[] {
  if (!Array.isArray(exclusions)) return []
  const list: readonly unknown[] = exclusions
  const views: ContextExclusionView[] = []
  const limit = Math.min(list.length, MAX_DIAGNOSTIC_EXCLUSIONS)
  for (let index = 0; index < limit; index += 1) {
    const view = exclusionViewOf(list[index])
    if (view !== undefined) views.push(view)
  }
  return views
}

function textOfMessage(value: unknown, limit: number): string {
  const message = asRecord(value)
  const content = Array.isArray(message?.content) ? message.content : []
  const text = content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block !== undefined && block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Append `-s<step>` to one wire id, keeping the id at most 200 characters.
 *
 * `compileTurnContext` reuses an existing attention object when it sees the
 * same id and never refreshes its summary, so every item merged from P1 or P2
 * sources must be step-qualified. A suffix that is already present is kept.
 * If appending would exceed the wire-id limit, the semantic prefix is kept and
 * a sha256 digest of the *qualified* id is appended, which keeps the result
 * unique per step; plain truncation would collide.
 *
 * @param id - the channel item's turn-scoped wire id.
 * @param step - the current step; invalid values degrade to 0.
 * @returns an id of at most {@link MAX_WIRE_ID_LENGTH} characters.
 */
export function stepScopedWireId(id: string, step: number): string {
  const base = typeof id === 'string' ? id : ''
  const value = typeof step === 'number' && Number.isInteger(step) && step >= 0 ? step : 0
  const suffix = `-s${value}`
  if (base.endsWith(suffix)) return base
  const next = `${base}${suffix}`
  if (next.length <= MAX_WIRE_ID_LENGTH) return next
  const digest = createHash('sha256').update(next, 'utf8').digest('hex').slice(0, STEP_ID_DIGEST_LENGTH)
  const keep = MAX_WIRE_ID_LENGTH - STEP_ID_DIGEST_LENGTH - 1
  return `${next.slice(0, keep)}-${digest}`
}

/**
 * Clone one captured item for the current compile.
 *
 * The id is step-qualified and the scope is replaced entirely — tenant,
 * principal, session and turn — with the optimizer's compile scope. A P1
 * extractor can only guess `tenantId`/`turnId`, and `compileTurnContext`
 * excludes an object whose scope does not match the requested one.
 *
 * @param item - a P1 capture item or an output-source item.
 * @param scope - the optimizer's compile scope.
 * @param step - the current step.
 * @returns a fresh item whose nested wire fields are not shared.
 */
export function compileScopedItem(item: WireItem, scope: WireScope, step: number): WireItem {
  return {
    ...item,
    id: stepScopedWireId(item.id, step),
    scope: { ...scope },
    pointer: { ...item.pointer },
    scores: { ...item.scores },
    budget: { ...item.budget },
  }
}

export class AmpContextOptimizer {
  private readonly ctx: Context
  private readonly host: AmpHost
  private readonly config: Config
  private readonly wire?: WireCapture
  private readonly sources?: WireItemSource
  private readonly prompts = new Map<string, string>()
  private readonly todos = new Map<string, string>()
  private readonly tools = new Map<string, string[]>()
  // Compiled payloads are cached by AMP's own `ContextCache`, wired into the
  // kernel in `amp.ts`. Keeping a second string cache here duplicated it and
  // forced a global flush on every session event.
  // Per-session base-id bookkeeping for the tombstone diff: the exact wire
  // items submitted by the last successful compile of this session.
  private readonly previousItems = new Map<string, TombstoneMap>()
  // Every attention object this session submitted, so AMP's prune planner has
  // something to decide about. Bounded: the oldest entries are forgotten first.
  private readonly submitted = new Map<string, AttentionObject[]>()
  // The ids submitted by the most recent step: they are the only entries AMP
  // may treat as `active`, because every persisted attention object is mounted.
  private readonly latestIds = new Map<string, Set<string>>()
  private readonly lastPrune = new Map<string, ContextPruneOutcome>()
  // DSH's own prune facts, projected as AMP candidates so `prune.ts` feeds the
  // same decision instead of standing beside it.
  private readonly pruneEvents = new Map<string, ContextPruneCandidate[]>()
  private readonly lastPackage = new Map<string, ContextPackageView>()
  private readonly pruner: ContextPruner
  private readonly stats: ContextStats = { compilations: 0, failures: 0, excluded: 0, lastTokens: 0, lastCompilerTokens: 0, lastCharacters: 0, lastItems: 0, lastPreview: '' }
  // Last compile attempt per session (bounded) and the most recent attempt
  // across sessions, which is what the session-less `/amp/context` view reads.
  private readonly diagnosticsBySession = new Map<string, CompileDiagnostics>()
  private lastDiagnostic: CompileDiagnostics | undefined

  constructor(ctx: Context, host: AmpHost, config: Config, wire?: WireCapture, sources?: WireItemSource) {
    this.ctx = ctx
    this.host = host
    this.config = config
    this.wire = wire
    this.sources = sources
    this.pruner = new ContextPruner({
      keepRecent: config.contextPruneKeepRecent,
      maxEntries: config.contextPruneMaxEntries,
      maxTokens: config.contextPruneMaxTokens,
      ...(typeof config.contextPruneMinScore === 'number' ? { minScore: config.contextPruneMinScore } : {}),
    })
  }

  status(root?: string): ContextStats & {
    enabled: boolean
    budgetTokens: number
    capture?: WireCaptureStatus
    outputs?: OutputStatus
    cache?: ContextCacheStats & { failures: number }
    prune?: ContextPruneStats & { sessions: number; last?: ContextPruneOutcome }
    line: string
  } {
    let outputs: OutputStatus | undefined
    try {
      outputs = this.sources?.status?.()
    } catch {
      outputs = undefined
    }
    // AMP `ContextCache` counters for the same store slot the compile writes to.
    let cache: (ContextCacheStats & { failures: number }) | undefined
    try {
      cache = this.host.contextCacheStatus(root)
    } catch {
      cache = undefined
    }
    const prune = this.pruneStatus()
    const hitRate = cache === undefined ? 0 : cache.hitRate
    const saved = cache === undefined ? 0 : cache.savedTokens
    // One human-readable line for the client status bar; the structured fields
    // above stay authoritative.
    const line = `attention ${this.stats.lastItems} items · ${this.stats.lastTokens} tok · cache ${Math.round(hitRate * 100)}% (${saved} saved) · prune ${prune.lastKept}/${prune.lastPruned} (${prune.savedTokens} saved)`
    return {
      ...this.stats,
      enabled: this.enabled(root),
      budgetTokens: this.config.contextBudgetTokens,
      ...(cache === undefined ? {} : { cache }),
      prune,
      line,
      ...(this.wire === undefined ? {} : { capture: this.wire.status() }),
      ...(outputs === undefined ? {} : { outputs }),
    }
  }

  /**
   * Last compile-attempt diagnostics.
   *
   * With no argument this is the most recent compile across sessions; with a
   * session id it is that session's last attempt. An unknown session, or a
   * process that has not compiled yet, returns the empty state (`lag: 1`).
   * The method is a pure read and never throws.
   */
  diagnostics(sessionId?: string): ContextDiagnostics {
    try {
      const record = sessionId === undefined ? this.lastDiagnostic : this.diagnosticsBySession.get(sessionId)
      if (record === undefined) return { lag: 1, pending: false, compilerExclusions: 0, lastExclusions: [] }
      return {
        lag: record.lag,
        pending: record.pending,
        lastCompileAt: record.lastCompileAt,
        compilerExclusions: record.compilerExclusions,
        // Copy the views too: the record is a durable diagnostic, and a caller
        // must not be able to mutate it through the returned array.
        lastExclusions: record.lastExclusions.map((view) => ({ ...view })),
      }
    } catch {
      return { lag: 1, pending: false, compilerExclusions: 0, lastExclusions: [] }
    }
  }

  /** Remember a successful compile; diagnostics must never affect it. */
  private rememberCompile(sessionId: string, pending: boolean, exclusions: unknown): void {
    try {
      this.rememberDiagnostics(sessionId, {
        lastCompileAt: nowIso(),
        pending,
        lag: pending ? 0 : 1,
        compilerExclusions: Array.isArray(exclusions) ? exclusions.length : 0,
        lastExclusions: exclusionViewsOf(exclusions),
      })
    } catch {
      // A diagnostics failure is not a compile failure.
    }
  }

  /** Remember a failed compile: no exclusion list exists to report. */
  private rememberFailure(sessionId: string, pending: boolean): void {
    try {
      this.rememberDiagnostics(sessionId, {
        lastCompileAt: nowIso(),
        pending,
        lag: pending ? 0 : 1,
        compilerExclusions: 0,
        lastExclusions: [],
      })
    } catch {
      // Same contract as `rememberCompile`.
    }
  }

  /** Store one record per session, evicting the oldest session past the cap. */
  private rememberDiagnostics(sessionId: string, record: CompileDiagnostics): void {
    this.lastDiagnostic = record
    this.diagnosticsBySession.delete(sessionId)
    this.diagnosticsBySession.set(sessionId, record)
    while (this.diagnosticsBySession.size > MAX_DIAGNOSTIC_SESSIONS) {
      const oldest = this.diagnosticsBySession.keys().next().value
      if (typeof oldest !== 'string') break
      this.diagnosticsBySession.delete(oldest)
    }
  }

  /** Config is the deployment ceiling; the runtime switch can only narrow it. */
  private enabled(root?: string): boolean {
    if (!this.config.contextOptimization) return false
    try {
      return this.host.preferencesFor(root).get().contextOptimization
    } catch {
      return true
    }
  }

  onSessionEvent(session: { id: string }, event: { type: string; data?: unknown }): void {
    const data = asRecord(event.data)
    if (data === undefined) return
    if (event.type === 'user/message') {
      const text = textOfMessage(data, 2000).trim()
      if (text.length > 0) {
        this.prompts.set(session.id, text)
      }
    } else if (event.type === 'todo/write') {
      const todos = Array.isArray(data.todos) ? data.todos : []
      const summary = todos
        .map((raw) => asRecord(raw))
        .filter((todo): todo is Record<string, unknown> => todo !== undefined)
        .map((todo) => `${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]'} ${String(todo.content ?? '')}`)
        .join('\n')
      this.todos.set(session.id, summary.slice(0, 2000))
    } else if (event.type === 'tool/result') {
      const text = textOfMessage(data.message, 300).trim()
      if (text.length > 0) {
        const list = this.tools.get(session.id) ?? []
        list.push(text)
        this.tools.set(session.id, list.slice(-3))
      }
    } else if (event.type === 'turn/start') {
      this.tools.delete(session.id)
      // Wire ids embed the turn, so carrying the previous turn's items into a
      // new turn would tombstone every one of them. Each turn starts empty.
      this.previousItems.delete(session.id)
    }
  }

  /** Compiled AMP context for one agent's current step, or an empty string. */
  contextFor(agent: Agent): string {
    const root = agent.session.header?.cwd
    if (!this.enabled(root)) return ''
    const sessionId = agent.id
    const turn = this.turnOf(agent)
    // `agent/pre-step` captured the current turn before the request is
    // admitted. Prefer that prompt; the event-derived map is only the fallback
    // for the initial assembly (before pre-step) and for headless paths.
    const pending = this.wire?.pendingFor(sessionId, turn)
    const step = pending === undefined ? 0 : pending.step
    const prompt = pending !== undefined && pending.prompt.length > 0
      ? pending.prompt
      : this.prompts.get(sessionId) ?? ''
    try {
      const turnId = this.host.ensureTurn(sessionId, turn, root)
      const kernel = this.host.kernel(root)
      const scope = {
        tenantId: this.config.tenantId,
        principalId: sessionId,
        sessionId,
        turnId,
      }
      // A single item may consume the whole package: the global budget below is
      // the real ceiling. Capping an item at half the budget used to look safe
      // under the old length/4 estimate, but a 600-character CJK summary costs
      // ~660 tokens, so the most important channel (the prompt) was excluded as
      // if it were oversized.
      const budgetPerItem = { tokens: Math.max(256, this.config.contextBudgetTokens) }
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      const item = (channel: WireChannel, slot: string, summary: string, scores: WireScores): WireItem | null => {
        const text = summary.trim()
        if (text.length === 0) return null
        return {
          id: wireId(channel, sessionId, turn, slot),
          channel,
          scope,
          pointer: { kind: channel, id: `${channel}:${sessionId}:${turn}:${slot}`, version: '1' },
          summary: text,
          scores,
          budget: budgetPerItem,
          expiresAt,
          reason: `${channel} is relevant to the current step`,
          trust: channel === 'prompt' ? 'user' : channel === 'workspace' ? 'workspace' : 'host',
        }
      }
      const goal = (this.ctx.get('goals') as { get(agent: Agent): { objective?: string } | undefined } | undefined)?.get(agent)
      // `compileTurnContext` reuses an existing object for a repeated id and
      // never replaces its summary. Prompt, plan (todos) and recent tools can
      // change between steps, so their slots carry `-s<step>`; this forces a
      // fresh object instead of serving step N-1's summary. Goal and workspace
      // are turn-scoped facts: they stay on stable slots for the whole turn so
      // the store does not grow by two objects per step. A goal changed in the
      // middle of a turn is therefore visible from the next turn; P2 can move
      // those two channels to `attention.update()` if mid-turn freshness is
      // required.
      const candidates = [
        item('prompt', `prompt-s${step}`, prompt.slice(0, 600), { relevance: 1, urgency: 1, confidence: 1, importance: 1 }),
        item('goal', 'goal', (goal?.objective ?? '').slice(0, 300), { relevance: 1, urgency: 0.9, confidence: 0.9, importance: 1 }),
        item('plan', `plan-s${step}`, (this.todos.get(sessionId) ?? '').slice(0, 600), { relevance: 0.9, urgency: 0.8, confidence: 0.9, importance: 0.8 }),
        item('tool', `tool-s${step}`, (this.tools.get(sessionId) ?? []).join('\n---\n').slice(0, 400), { relevance: 0.8, urgency: 0.6, confidence: 0.8, importance: 0.7 }),
        item('workspace', 'workspace', `workspace: ${agent.session.header?.cwd ?? process.cwd()}`.slice(0, 160), { relevance: 0.6, urgency: 0.4, confidence: 1, importance: 0.5 }),
      ].filter((value): value is WireItem => value !== null)

      // The exact wire batch submitted to this compile. `create` is already an
      // attention-input projection and cannot be diffed back into wire items,
      // so the tombstone layer records the original values here.
      const wireItems: WireItem[] = [...candidates]
      const create = new Map<string, CreateAttentionInput>()
      for (const candidate of candidates) create.set(candidate.id, toCreateAttention(candidate, turnId))
      // P1 extractors put their wire items on PendingInput; P2 output trackers
      // contribute through `sources.itemsFor(agent)`. Merging both here means a
      // new channel needs no change to this compiler. Every item is cloned with
      // a step-qualified id (AMP reuses an existing object for a repeated id
      // and never refreshes its summary) and with the compile scope, which
      // replaces the tenant/turn an extractor could only guess. Dedupe by id
      // because `compileTurnContext` rejects duplicate declarations.
      const merged = [...(pending?.items ?? []), ...this.sourceItems(agent)]
      for (const captured of merged) {
        try {
          if (typeof captured?.id !== 'string' || captured.id.length === 0) continue
          const scoped = compileScopedItem(captured, scope, step)
          wireItems.push(scoped)
          const mapped = toCreateAttention(scoped, turnId)
          create.set(mapped.id, mapped)
        } catch {
          // One malformed captured item must not cost the whole step its context.
        }
      }

      // R2: an item removed from this batch is submitted as an unmounted
      // tombstone, so the compiler records an `unmounted` ContextExclusion
      // instead of the item silently disappearing. `baseWireId` makes a step
      // suffix a replacement, not a removal. Fail-open: a broken diff leaves
      // `objects` empty and the step still compiles normally.
      let tombstones: AttentionObject[] = []
      try {
        const previous = this.previousItems.get(sessionId) ?? new Map<string, WireItem>()
        const diff = diffTombstones(previous, wireItems, scope, turnId)
        tombstones = diff.tombstones
        this.previousItems.set(sessionId, diff.next)
      } catch {
        tombstones = []
      }
      if (tombstones.length > 0) {
        // `compileTurnContext` rejects an id declared twice; create always wins.
        const declared = new Set(create.keys())
        tombstones = tombstones.filter((object) => !declared.has(object.id))
      }

      if (create.size === 0) return ''
      const compiled = kernel.flow.compileTurnContext({
        turnId,
        sessionId,
        principalId: sessionId,
        budget: { tokens: this.config.contextBudgetTokens },
        create: [...create.values()],
        // Removed items are not re-created: they are passed as pre-built
        // objects with `mounted: false`, which the compiler records as
        // `unmounted` exclusions while keeping the checkpoint accounting.
        objects: tombstones,
        // The attention objects are host-created in this call; accepting their
        // declared pointer version avoids the workflow-kind lookup, which only
        // knows DSH's own entity names.
        currentVersion: (pointer: { version: string }): string => pointer.version,
        countTokens: (text: string): number => estimateTokens(text),
      })
      // Render exactly what AMP counted. `compiled.text` is the concatenation of
      // the serialized projections the budget check measured, so `usage.tokens`
      // and the injected payload now agree. Re-joining a compact `- [id] summary`
      // form would read nicer but silently decouple the two numbers.
      const compiledText = (compiled.compiled as { text?: unknown }).text
      const text = typeof compiledText === 'string' && compiledText.length > 0
        ? compiledText
        : compiled.compiled.items.map((entry) => `- [${entry.id}] ${entry.summary}`).join('\n')
      this.stats.compilations += 1
      this.stats.excluded = compiled.compiled.exclusions.length
      this.stats.lastItems = compiled.compiled.items.length
      this.stats.lastCharacters = text.length
      this.stats.lastTokens = estimateTokens(text)
      // AMP always reports usage, but a fixture (or a future shape change) must
      // not turn a successful compile into a failed one.
      const usageTokens = (compiled.compiled.usage as { tokens?: unknown } | undefined)?.tokens
      this.stats.lastCompilerTokens = typeof usageTokens === 'number' ? usageTokens : 0
      this.stats.lastPreview = text.slice(0, 300)
      // Keep the exact objects AMP just persisted; the prune review at turn end
      // decides which of them are still worth their tokens.
      try {
        this.rememberSubmitted(sessionId, compiled.attention ?? [])
      } catch {
        // Bookkeeping only; it must never cost the step its context.
      }
      // Diagnostics are a read model of this attempt: the exclusion count and
      // its first 50 stable projections, plus whether pre-step input existed.
      this.rememberCompile(sessionId, pending !== undefined, compiled.compiled.exclusions)
      this.rememberPackage(sessionId, compiled.compiled, text)
      return text
    } catch (error) {
      this.stats.failures += 1
      this.rememberFailure(sessionId, pending !== undefined)
      return ''
    }
  }

  /**
   * Drop one session's compiled payloads from the AMP `ContextCache`.
   *
   * No caller needs this per step: a changed prompt, plan or tool outcome
   * produces a different cache signature and can never be served stale. Turn
   * end is the natural eviction point — memory hygiene, not correctness.
   */
  invalidate(sessionId: string): void {
    try {
      this.host.evictContextCache(sessionId)
    } catch {
      // Eviction is best effort; the cache policy still bounds growth.
    }
  }

  /** Remember the exact attention objects this step submitted (deduped, bounded). */
  private rememberSubmitted(sessionId: string, objects: readonly AttentionObject[]): void {
    if (objects.length === 0) return
    const list = this.submitted.get(sessionId) ?? []
    const index = new Map<string, number>()
    for (let position = 0; position < list.length; position += 1) index.set(list[position].id, position)
    for (const object of objects) {
      if (typeof object?.id !== 'string') continue
      const at = index.get(object.id)
      if (at === undefined) {
        index.set(object.id, list.length)
        list.push(object)
      } else {
        list[at] = object
      }
    }
    while (list.length > MAX_SUBMITTED_ENTRIES) list.shift()
    this.submitted.set(sessionId, list)
    const latest = new Set<string>()
    for (const object of objects) {
      if (typeof object?.id === 'string') latest.add(object.id)
    }
    this.latestIds.set(sessionId, latest)
  }

  /**
   * Feed DSH's own prune records into the AMP planner.
   *
   * `prune.ts` observes what DSH's pruner already did; converting those records
   * to candidates means AMP's decision reports `superseded` for them instead of
   * leaving the facts in a side ledger. Deduped by id and bounded.
   */
  notePruneRecords(sessionId: string, records: readonly PruneRecord[]): void {
    if (records.length === 0) return
    const list = this.pruneEvents.get(sessionId) ?? []
    const index = new Map<string, number>()
    for (let position = 0; position < list.length; position += 1) index.set(list[position].id, position)
    for (const record of records) {
      try {
        const candidate = pruneRecordCandidate(sessionId, record)
        const at = index.get(candidate.id)
        if (at === undefined) {
          index.set(candidate.id, list.length)
          list.push(candidate)
        } else {
          list[at] = candidate
        }
      } catch {
        // One malformed record must not drop the rest.
      }
    }
    while (list.length > MAX_SUBMITTED_ENTRIES) list.shift()
    this.pruneEvents.set(sessionId, list)
  }

  /**
   * Run AMP's prune state machine over this session's submitted attention.
   *
   * Called at turn end: the turn's entries are complete and the next turn starts
   * a fresh set. The verified checkpoint is appended to the AMP store (best
   * effort) and the outcome kept for `/amp/context`. Never throws.
   */
  reviewTurn(sessionId: string): ContextPruneOutcome | undefined {
    try {
      const list = this.submitted.get(sessionId) ?? []
      const events = this.pruneEvents.get(sessionId) ?? []
      if (list.length === 0 && events.length === 0) return undefined
      const latest = this.latestIds.get(sessionId) ?? new Set<string>()
      const outcome = this.pruner.review([
        ...list.map((object) => candidateOf(object, latest.has(object.id))),
        ...events,
      ])
      if (outcome === undefined) return undefined
      this.lastPrune.delete(sessionId)
      this.lastPrune.set(sessionId, outcome)
      while (this.lastPrune.size > MAX_DIAGNOSTIC_SESSIONS) {
        const oldest = this.lastPrune.keys().next().value
        if (typeof oldest !== 'string') break
        this.lastPrune.delete(oldest)
      }
      try {
        const kernel = this.host.kernel(this.host.rootOfSession(sessionId))
        kernel.store.appendEvent('context.prune.checkpoint', { sessionId, outcome }, outcome.checkpoint.id)
      } catch {
        // The checkpoint is already verified in memory; the durable append is
        // best effort and its failure must not lose the decision.
      }
      return outcome
    } catch {
      return undefined
    }
  }

  /** Prune counters plus the newest outcome, for `/amp/context`. */
  pruneStatus(): ContextPruneStats & { sessions: number; last?: ContextPruneOutcome } {
    const outcomes = [...this.lastPrune.values()]
    const last = outcomes.length === 0 ? undefined : outcomes[outcomes.length - 1]
    return {
      ...this.pruner.stats(),
      sessions: this.submitted.size,
      ...(last === undefined ? {} : { last }),
    }
  }

  /** Retain the package one step injected, bounded like the diagnostics map. */
  private rememberPackage(sessionId: string, compiled: CompiledPackage, text: string): void {
    try {
      const pkg: ContextPackageView = {
        sessionId,
        compiledAt: compiled.compiledAt,
        items: compiled.items.map((entry) => ({ id: entry.id, summary: entry.summary, tokens: entry.usage.tokens })),
        exclusions: exclusionViewsOf(compiled.exclusions),
        tokens: compiled.usage.tokens,
        renderedTokens: estimateTokens(text),
        budgetTokens: this.config.contextBudgetTokens,
        text,
      }
      this.lastPackage.delete(sessionId)
      this.lastPackage.set(sessionId, pkg)
      while (this.lastPackage.size > MAX_DIAGNOSTIC_SESSIONS) {
        const oldest = this.lastPackage.keys().next().value
        if (typeof oldest !== 'string') break
        this.lastPackage.delete(oldest)
      }
    } catch {
      // Diagnostics only; the step keeps its context.
    }
  }

  /** The exact package this session's last successful compile injected. */
  packageFor(sessionId: string): ContextPackageView | undefined {
    try {
      return this.lastPackage.get(sessionId)
    } catch {
      return undefined
    }
  }

  /** The DSH turn number for one agent, never throwing. */
  private turnOf(agent: Agent): number {
    const sessionId = agent.id
    const current = this.host.currentTurn(sessionId)
    if (current !== undefined) return current
    try {
      return this.ctx.agents.turnBoundaryOf(agent.session).lastTurn
    } catch {
      return 0
    }
  }

  /** Output-channel items, fail-open: a broken source never drops the step. */
  private sourceItems(agent: Agent): readonly WireItem[] {
    if (this.sources === undefined) return []
    try {
      const items = this.sources.itemsFor(agent)
      return Array.isArray(items) ? items : []
    } catch {
      return []
    }
  }

  /** Register the compiled package as a dynamic runtime context. */
  register(): void {
    if (!this.config.contextOptimization) return
    this.ctx.systemPrompt.context({
      name: 'deepseek-coordination:amp-attention',
      order: this.ctx.systemPrompt.getContextOrder('HARNESS_SOURCE') + 30,
      required: false,
      interpolate: false,
      text: (assembly) => {
        const agent = (assembly as { agent?: Agent }).agent
        if (agent === undefined) return ''
        const compiled = this.contextFor(agent)
        if (compiled.length === 0) return ''
        return [
          '<amp_attention budget="' + String(this.config.contextBudgetTokens) + ' tokens">',
          compiled,
          '</amp_attention>',
          'Items excluded by the AMP attention budget remain in the AMP ledger as exclusions; do not assume they were read.',
        ].join('\n')
      },
    })
  }
}

export { ACTOR }

