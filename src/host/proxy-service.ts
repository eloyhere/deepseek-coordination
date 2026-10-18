/**
 * Cache proxy service — the self-contained installation half of the proxy.
 *
 * `src/index.ts` owns only the enablement switch and the cache decorator; this
 * module owns everything the proxy installs: the status snapshot, the trace
 * writer, the `agent/request` rewrite, the adapter registration, the upstream
 * identity record, baseline usage metrics and prefix-drift detection.
 *
 * ## Why the upstream identity is explicit
 *
 * The proxy replaces `provider: 'deepseek-account'` (or another allowlisted
 * route) with `provider: 'coordination-proxy'` in the request every host
 * consumer sees. Host modules that resolve account credentials by exact
 * provider id then look at a route that is not theirs. This plugin cannot
 * change the host, but it can stop hiding the interaction: the real provider is
 * recorded here and is queryable through `upstreamProvider()` and the status
 * endpoint.
 *
 * ## Measure vs normalize
 *
 * Attaching the proxy and rewriting the request are separate decisions.
 *
 *  - `measure` (default) forwards the request with only the route swapped back
 *    to the real provider; it never calls the decorator. It records usage
 *    metrics and a prefix fingerprint so an operator can establish a baseline
 *    before changing anything.
 *  - `normalize` additionally lets the configured decorator rebuild content.
 *    It is selected by a `proxy.mode` file containing `normalize`, a
 *    `proxy.rewrite` marker file, or `DSH_COORDINATION_PROXY_REWRITE=1`.
 *
 * The existing `proxy.enable` switch still decides only whether the proxy is
 * attached at all.
 *
 * ## Strategy gate
 *
 * The researched row in `cache-strategy.ts` is resolved once per upstream route
 * and is authoritative for rewriting: `normalize` decorates only when the row
 * says byte-stable prefixes are the lever (`volatileStrippingHelps` and a mode
 * other than `none`). The resolved row is reported as `cacheStrategy` in
 * `status()`, including the tri-state `effortBreaksPrefix` and its source ids.
 *
 * ## Observability without content
 *
 * Usage is observed by stepping the returned async iterable: every chunk is
 * yielded unchanged, and only a `usage` chunk's token numbers are read. The
 * prefix fingerprint is a sha256 over a canonical projection (system text,
 * tool definitions, first eight messages); only the 16-hex digest is traced.
 * No prompt, answer or tool payload is buffered, stored or logged.
 *
 * ## Security posture
 *
 * Unchanged from the adapter: only allowlisted providers are intercepted, the
 * trace file receives structural events only (provider/model ids, counts,
 * sizes, hashes) and never prompt or answer text, and forwarding delegates to
 * `ctx.llm.stream` so the real adapter keeps authentication and egress.
 * `status()` and `compatibility()` return identities, counts and static notes;
 * neither accepts or returns request content.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { presetFor } from './cache-strategy.js'
import type { CacheMode, CacheStrategyPreset } from './cache-strategy.js'
import { brandProfileOf, classifyModelBrand } from './model-brand.js'
import type { EffortBreaksCache, ModelBrand, ModelIdentity } from './model-brand.js'
import {
  PROXY_ALLOWED_PROVIDERS,
  createProxyAdapter,
  isProxyProviderAllowed,
} from './proxy-adapter.js'
import type { LlmRuntimeLike, ProxyRoute, ProxyTraceEvent } from './proxy-adapter.js'

/** Provider route the cache proxy registers under. */
export const PROXY_PROVIDER = 'coordination-proxy'

/** Request-rewrite modes. `measure` observes only; `normalize` may decorate. */
export type ProxyMode = 'measure' | 'normalize'

/** Sliding window used by the usage metrics. */
export const PROXY_METRIC_WINDOW = 100

/** Number of messages included in the prefix fingerprint. */
const PREFIX_MESSAGE_LIMIT = 8

/** The real route identity handed to a decorator call. */
export interface ProxyDecorationIdentity {
  readonly provider: string
  readonly model: string
}

/**
 * Optional content rewrite applied at the adapter boundary.
 *
 * The adapter sees only the frozen request; this callback receives it together
 * with the real upstream identity the proxy recorded, so a decorator never has
 * to infer the provider from the rewritten route.
 */
export type Decorate = (
  request: Record<string, unknown>,
  identity: ProxyDecorationIdentity,
) => Record<string, unknown>

/**
 * One known exact-provider interaction with the host.
 *
 * Static data only: the proxy never probes a host module. A row says "this
 * module compares provider ids, so this is the risk while the proxy is on",
 * not "this module is broken right now".
 */
export interface ProxyCompatibility {
  /** Host module or feature that compares provider ids. */
  readonly feature: string
  /** Short name of the interaction risk. */
  readonly risk: string
  /** Honest, operator-facing note; never a guarantee. */
  readonly note: string
}

/**
 * Known host interactions, in one stable, frozen list.
 *
 * `web-search` resolves the account token by exact provider id; while the proxy
 * is active the recorded route is `coordination-proxy`, so its account fallback
 * needs to use the real provider id. The host fix shipped in the 0.2.1-rc.2
 * patch; other builds may need the same change.
 */
export const PROXY_COMPATIBILITY: ReadonlyArray<ProxyCompatibility> = Object.freeze([
  Object.freeze({
    feature: 'web-search',
    risk: 'account-fallback',
    note:
      'Host search resolves the account token by exact provider id; with the proxy active the recorded route is coordination-proxy. Fixed host-side in 0.2.1-rc.2 patch; other builds may need the same fix.',
  }),
])

/** Host-reported model identity mapped onto a built-in cache brand. */
export interface ProxyModelStatus {
  readonly brand: ModelBrand
  readonly label: string
  readonly automaticPrefixCache: boolean
  readonly explicitCacheBreakpoints: boolean
  readonly minPrefixTokens: number
  readonly effortBreaksCache: EffortBreaksCache
  readonly stripVolatileHelps: boolean
  readonly note: string
}

/**
 * The researched cache-strategy row the proxy currently follows.
 *
 * Resolved once per upstream route from `cache-strategy.ts`, which is the
 * authority for the normalize gate. `sources` is a copy of the row's source ids,
 * so a status reader cannot mutate the table and every claim stays auditable.
 */
export interface ProxyCacheStrategyStatus {
  /** Stable preset id, e.g. `deepseek/automatic`. */
  id: string
  mode: CacheMode
  minPrefixTokens: number
  /** Tri-state; `'unknown'` means no fetched source documents the behaviour. */
  effortBreaksPrefix: boolean | 'unknown'
  volatileStrippingHelps: boolean
  compactionPolicy: 'avoid-mid-prefix' | 'safe' | 'unknown'
  /** `CACHE_SOURCES` ids that support this row. */
  sources: string[]
}

/**
 * Usage baseline over the last {@link PROXY_METRIC_WINDOW} forwarded requests.
 *
 * `inputTokens` / `cachedInputTokens` are sums over the samples in the window;
 * `hitRate` is their ratio, or `0` while there is no token sample. DSH reports
 * the cached input as `cacheReadTokens`; the status field keeps the clearer
 * `cachedInputTokens` name. Numbers only — never message content.
 */
export interface ProxyMetrics {
  /** Forwarded requests currently inside the window (≤ `window`). */
  requests: number
  /** Requests in the window whose stream yielded a readable usage chunk. */
  samples: number
  inputTokens: number
  cachedInputTokens: number
  /** `cachedInputTokens / inputTokens`, or `0` without a token sample. */
  hitRate: number
  /** Maximum window size; {@link PROXY_METRIC_WINDOW}. */
  window: number
}

/**
 * Prefix drift over the outbound request projection.
 *
 * `current` is the latest 16-hex sha256 digest; `stable` says whether the last
 * observation matched its predecessor; `changes` counts transitions.
 */
export interface ProxyPrefixStatus {
  current?: string
  stable: boolean
  changes: number
}

/**
 * Structural status of the proxy, exposed read-only to the host.
 *
 * Counts, identities and hashes only: no prompt, no answer, no tool payload, no
 * credential ever reaches this object. It is the observability half of the
 * proxy's security model — the host can see that it runs, which real route it
 * forwards to, and whether the prefix is drifting, not what it saw.
 */
export interface ProxyStatus {
  available: boolean
  enabled: boolean
  provider: string
  /** Attached mode: measurement-only or content-normalising. */
  mode: ProxyMode
  /** The real route the adapter currently forwards to. */
  upstream?: { provider: string; model?: string }
  /**
   * The real provider recorded before the route rewrite (`undefined` until a
   * default route or an intercepted request names one). Always present as a
   * key in the object returned by `status()`; JSON omits it while undefined.
   */
  upstreamProvider: string | undefined
  /** Host-reported model identity mapped onto a built-in cache brand. */
  model?: ProxyModelStatus
  /**
   * The researched strategy row for the current upstream route. Always present;
   * before a route is known it is the conservative `unknown/conservative` row.
   */
  cacheStrategy: ProxyCacheStrategyStatus
  forwards: number
  refusals: number
  lastForwardAt?: string
  /**
   * True when the wiring supplies a content decorator. `mode` decides whether
   * it is invoked: `measure` never calls it, `normalize` may.
   */
  decorate: boolean
  /** Usage baseline over the last 100 forwarded requests. */
  metrics: ProxyMetrics
  /** Latest prefix fingerprint and its drift state. */
  prefix: ProxyPrefixStatus
}

/** The public service contract; `install()` is the only side effect. */
export interface ProxyService {
  /** Register the adapter and the routing listener. Idempotent while active. */
  install(): () => void
  /** Serialisable, body-free snapshot for `GET /proxy/status`. */
  status(): ProxyStatus
  /** The real provider captured before the rewrite, if one is known. */
  upstreamProvider(): string | undefined
  /** Static list of host modules that may observe the provider-id rewrite. */
  compatibility(): ReadonlyArray<ProxyCompatibility>
}

/** Wiring options. The enablement switch itself stays with the composition root. */
export interface ProxyServiceOptions {
  context: Context
  /** Directory holding `proxy.enable`, `proxy.mode`, `proxy.rewrite` and `proxy.log`. */
  stateDir: string
  /** Optional content rewrite, applied only in `normalize` mode. */
  decorate?: Decorate
  /**
   * Synchronous model-identity override.
   *
   * When provided and it returns a value, that identity classifies the cache
   * brand directly. Returning `undefined` (or throwing) falls back to the
   * host's asynchronous `ctx.llm.resolveModelInfo`, preserving the previous
   * behaviour when no override is wired.
   */
  modelInfo?: (p: string, m: string) => ModelIdentity | undefined
}

/** One request in the usage window; mutable until its usage chunk arrives. */
interface MetricRecord {
  inputTokens: number
  cachedInputTokens: number
  sampled: boolean
}

/** Internal counters: the public snapshot adds the live upstream identity. */
type ProxyState = Omit<ProxyStatus, 'upstream' | 'upstreamProvider'>

const NOOP = (): void => {}

/**
 * Resolve a Cordis service without tripping the context proxy.
 *
 * Duplicated from the composition root on purpose: this module stays a
 * self-contained service and does not import the plugin entry point.
 */
function serviceOrUndefined(context: Context, name: string): Record<string, unknown> | undefined {
  const getter = (context as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  try {
    const value = getter.call(context, name)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The live `ctx.llm` runtime; the proxy adapter needs `stream`, not the port. */
function llmRuntimeOf(context: Context): LlmRuntimeLike | undefined {
  const service = serviceOrUndefined(context, 'llm')
  return service !== undefined && typeof service.stream === 'function'
    ? (service as unknown as LlmRuntimeLike)
    : undefined
}

/** The deployment's default model route, used when no request has named one yet. */
function defaultRouteOf(context: Context): ProxyRoute | undefined {
  const service = serviceOrUndefined(context, 'agentDefaultModel')
  const current = service?.currentSelection
  if (typeof current !== 'function') return undefined
  try {
    const selection = current.call(service)
    const record = typeof selection === 'object' && selection !== null
      ? (selection as Record<string, unknown>)
      : undefined
    const provider = typeof record?.provider === 'string' ? record.provider : ''
    const model = typeof record?.model === 'string' ? record.model : ''
    return provider.length > 0 && model.length > 0 ? { provider, model } : undefined
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Read one file's trimmed, lower-cased text; missing/unreadable is empty. */
function readFlagText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim().toLowerCase() : ''
  } catch {
    return ''
  }
}

/**
 * Resolve the rewrite mode from the state directory.
 *
 * `measure` is the default. `normalize` is requested by a `proxy.mode` file
 * containing `normalize`, by a `proxy.rewrite` marker file, or by
 * `DSH_COORDINATION_PROXY_REWRITE=1`. `DSH_COORDINATION_PROXY_MODE=normalize`
 * is accepted as the environment equivalent of the mode file. Attaching the
 * proxy stays controlled exclusively by `proxy.enable` / `DSH_COORDINATION_PROXY`.
 */
function resolveMode(stateDir: string): ProxyMode {
  const fromEnv = (process.env.DSH_COORDINATION_PROXY_MODE ?? '').trim().toLowerCase()
  const fromFile = readFlagText(join(stateDir, 'proxy.mode'))
  if (fromEnv === 'normalize' || fromFile === 'normalize') return 'normalize'
  if (process.env.DSH_COORDINATION_PROXY_REWRITE === '1') return 'normalize'
  if (existsSync(join(stateDir, 'proxy.rewrite'))) return 'normalize'
  return 'measure'
}

/** A finite, non-negative token count, or `undefined` when unreadable. */
function tokenNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Read the token numbers out of one stream chunk.
 *
 * DSH emits `{ type: 'usage', usage: TokenUsage }` and `TokenUsage` names the
 * cached input `cacheReadTokens`; `cachedInputTokens` is accepted as an alias so
 * a normalized event shape keeps working. A chunk without a readable
 * `inputTokens` is not a sample; a missing cached field simply means zero.
 */
function usageSampleOf(chunk: unknown): { inputTokens: number; cachedInputTokens: number } | undefined {
  const record = asRecord(chunk)
  if (record?.type !== 'usage') return undefined
  const usage = asRecord(record.usage)
  if (usage === undefined) return undefined
  const inputTokens = tokenNumber(usage.inputTokens)
  if (inputTokens === undefined) return undefined
  const cachedInputTokens =
    tokenNumber(usage.cachedInputTokens) ??
    tokenNumber(usage.cacheReadTokens) ??
    tokenNumber(usage.cachedTokens) ??
    0
  return { inputTokens, cachedInputTokens }
}

/** Async iterable check that does not throw on primitives or null. */
function asAsyncIterable(value: unknown): AsyncIterable<unknown> | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined
  const iterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
  return typeof iterator === 'function' ? (value as AsyncIterable<unknown>) : undefined
}

/**
 * A transparent chunk pass-through that reads usage numbers on the way.
 *
 * The returned iterable yields every chunk exactly as the real adapter emitted
 * it, in order; it buffers nothing and changes no shape. A usage chunk updates
 * only its request's numeric slot in the sliding window.
 */
function observeUsage(
  stream: unknown,
  record: MetricRecord,
  sample: (record: MetricRecord, inputTokens: number, cachedInputTokens: number) => void,
): unknown {
  const iterable = asAsyncIterable(stream)
  if (iterable === undefined) return stream
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for await (const chunk of iterable) {
        const usage = usageSampleOf(chunk)
        if (usage !== undefined) sample(record, usage.inputTokens, usage.cachedInputTokens)
        yield chunk
      }
    },
  }
}

/** Canonical value for hashing: sorted keys, stable scalars, no cycles. */
function canonical(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return null
  if (depth >= 20) return '[depth]'
  if (seen.has(value)) return '[cycle]'
  seen.add(value)
  let result: unknown
  if (Array.isArray(value)) {
    result = value.map((entry) => canonical(entry, depth + 1, seen))
  } else {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = canonical(record[key], depth + 1, seen)
    result = out
  }
  seen.delete(value)
  return result
}

/**
 * Fingerprint the outbound prompt prefix.
 *
 * Projection: the `system` text, every `system`-role message, the tool
 * definitions and the first {@link PREFIX_MESSAGE_LIMIT} messages. It is
 * canonicalised (sorted object keys) and sha256-hashed; only the first 16 hex
 * characters leave this function, so the trace and status never carry content.
 */
function prefixFingerprint(request: unknown): string {
  const record = asRecord(request) ?? {}
  const messages = Array.isArray(record.messages) ? record.messages : []
  const material = {
    system: record.system ?? null,
    systemMessages: messages.filter((message) => asRecord(message)?.role === 'system'),
    tools: Array.isArray(record.tools) ? record.tools : [],
    messages: messages.slice(0, PREFIX_MESSAGE_LIMIT),
  }
  return createHash('sha256').update(JSON.stringify(canonical(material)), 'utf8').digest('hex').slice(0, 16)
}

/** Project one researched preset onto the body-free status shape. */
function cacheStrategyStatusOf(preset: CacheStrategyPreset): ProxyCacheStrategyStatus {
  return {
    id: preset.id,
    mode: preset.mode,
    minPrefixTokens: preset.minPrefixTokens,
    effortBreaksPrefix: preset.effortBreaksPrefix,
    volatileStrippingHelps: preset.volatileStrippingHelps,
    compactionPolicy: preset.compactionPolicy,
    sources: [...preset.sourceIds],
  }
}

/**
 * Build the proxy service.
 *
 * All methods are safe on an uninstalled service: `status()` reports the
 * defaults, `upstreamProvider()` is undefined and `compatibility()` is the
 * static list. `install()` fails open: no llm runtime, no adapter registration
 * or no event bus simply leaves the normal path untouched.
 */
export function createProxyService(options: ProxyServiceOptions): ProxyService {
  const { context, stateDir } = options
  const flagFile = join(stateDir, 'proxy.enable')
  const logFile = join(stateDir, 'proxy.log')

  const state: ProxyState = {
    available: false,
    enabled: false,
    provider: PROXY_PROVIDER,
    mode: resolveMode(stateDir),
    forwards: 0,
    refusals: 0,
    decorate: false,
    metrics: {
      requests: 0,
      samples: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      hitRate: 0,
      window: PROXY_METRIC_WINDOW,
    },
    prefix: { stable: true, changes: 0 },
    // No route yet: status still names the conservative row, so the shape is
    // stable and a reader never has to special-case "installed but unclassified".
    cacheStrategy: cacheStrategyStatusOf(presetFor({})),
  }

  /** The real route captured from the default selection or the last request. */
  let route: ProxyRoute | undefined
  /** Dedupe key for `describeModel`; reset by each successful installation. */
  let describedKey = ''
  /** The active installation's disposer, while installed. */
  let installed: (() => void) | undefined

  /** Requests currently inside the sliding window, oldest first. */
  const metricWindow: MetricRecord[] = []

  /** Recompute the public metrics from the window. Numbers only. */
  const refreshMetrics = (): void => {
    let samples = 0
    let inputTokens = 0
    let cachedInputTokens = 0
    for (const record of metricWindow) {
      if (!record.sampled) continue
      samples += 1
      inputTokens += record.inputTokens
      cachedInputTokens += record.cachedInputTokens
    }
    state.metrics = {
      requests: metricWindow.length,
      samples,
      inputTokens,
      cachedInputTokens,
      hitRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
      window: PROXY_METRIC_WINDOW,
    }
  }

  /** Start one request's metric slot; evict the oldest beyond the window. */
  const beginMetric = (): MetricRecord => {
    const record: MetricRecord = { inputTokens: 0, cachedInputTokens: 0, sampled: false }
    metricWindow.push(record)
    while (metricWindow.length > PROXY_METRIC_WINDOW) metricWindow.shift()
    refreshMetrics()
    return record
  }

  /** Attach one usage sample to its request, unless it has already left the window. */
  const recordUsage = (record: MetricRecord, inputTokens: number, cachedInputTokens: number): void => {
    if (record.sampled || !metricWindow.includes(record)) return
    record.inputTokens = inputTokens
    record.cachedInputTokens = cachedInputTokens
    record.sampled = true
    refreshMetrics()
  }

  /**
   * Append one structural event as a JSON line.
   *
   * JSON (not a formatted sentence) keeps the record unambiguous, and the event
   * type has no field that can carry content — a reviewer can verify the whole
   * leak surface by reading `ProxyTraceEvent`.
   */
  const trace = (event: ProxyTraceEvent): void => {
    if (event.event === 'forward') {
      state.forwards += 1
      state.lastForwardAt = new Date().toISOString()
    }
    if (event.event === 'refuse') state.refusals += 1
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event })
    try {
      appendFileSync(logFile, `${line}\n`, 'utf8')
    } catch {
      // A trace that cannot be written must never break a model call.
    }
    if (process.env.DSH_COORDINATION_PROXY_DEBUG === '1') console.error(`[coordination-proxy] ${line}`)
  }

  /**
   * Record one outgoing request's prefix and emit drift events.
   *
   * A first observation is stable by definition. A repeat keeps `stable: true`;
   * a different digest emits `prefix` with `stable: false` plus exactly one
   * `prefix-churn` line carrying the previous and current hash.
   */
  const observePrefix = (request: unknown): void => {
    const next = prefixFingerprint(request)
    const previous = state.prefix.current
    if (previous === undefined) {
      state.prefix = { current: next, stable: true, changes: 0 }
      trace({ event: 'prefix', prefix: next, stable: true })
      return
    }
    if (previous === next) {
      state.prefix = { ...state.prefix, stable: true }
      trace({ event: 'prefix', prefix: next, stable: true })
      return
    }
    state.prefix = { current: next, stable: false, changes: state.prefix.changes + 1 }
    trace({ event: 'prefix', prefix: next, stable: false })
    trace({ event: 'prefix-churn', from: previous, to: next })
  }

  /**
   * Wrap `ctx.llm` for the adapter only: observe the exact outgoing request,
   * start a metric slot, and pass the returned stream through untouched apart
   * from reading its usage chunks. Every other llm method delegates with the
   * original receiver.
   */
  const observationLlm = (llm: LlmRuntimeLike): LlmRuntimeLike => {
    const forwarding = llm.stream
    if (typeof forwarding !== 'function') return llm
    const resolveInfo = llm.resolveModelInfo
    const list = llm.listModels
    return {
      stream: (request: unknown) => {
        observePrefix(request)
        const record = beginMetric()
        const stream = forwarding.call(llm, request)
        return observeUsage(stream, record, recordUsage)
      },
      ...(typeof resolveInfo === 'function'
        ? {
            resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) =>
              resolveInfo.call(llm, provider, model, signal),
          }
        : {}),
      ...(typeof list === 'function'
        ? { listModels: (provider: string) => list.call(llm, provider) }
        : {}),
    }
  }

  /**
   * Classify one host-reported identity onto a built-in cache brand and resolve
   * the researched strategy row for the route.
   *
   * `applyIdentity` is the single writer of `state.model` and
   * `state.cacheStrategy`; it also traces the brand, so the log, the status
   * endpoint and the normalize gate can never disagree about a route.
   */
  const applyIdentity = (provider: string, model: string, identity: ModelIdentity): void => {
    const profile = brandProfileOf(identity)
    // One lookup per upstream route. The host identity carries no agent id
    // today, so the agent-specific rows stay out of reach here (the lookup still
    // accepts the field for callers that can supply one).
    const preset = presetFor({ brand: classifyModelBrand(identity), model, agent: undefined })
    state.cacheStrategy = cacheStrategyStatusOf(preset)
    state.model = {
      brand: profile.brand,
      label: profile.label,
      automaticPrefixCache: profile.automaticPrefixCache,
      explicitCacheBreakpoints: profile.explicitCacheBreakpoints,
      minPrefixTokens: profile.minPrefixTokens,
      effortBreaksCache: profile.effortBreaksCache,
      stripVolatileHelps: profile.stripVolatileHelps,
      note: profile.note,
    }
    trace({ event: 'model', provider, model, brand: profile.brand })
  }

  /** A synchronous identity override, with the host resolver as the fallback. */
  const suppliedIdentity = (provider: string, model: string): ModelIdentity | undefined => {
    if (options.modelInfo === undefined) return undefined
    try {
      return options.modelInfo(provider, model)
    } catch {
      return undefined
    }
  }

  /**
   * Classify the host-reported model identity onto a built-in cache brand.
   *
   * `ctx.llm.resolveModelInfo(provider, model)` is the host's own answer for
   * "what model is this": it carries the display name and description that a
   * provider route id alone cannot. The call may hit the adapter, so it is
   * fired and forgotten — routing never waits on catalog I/O, and a failure
   * simply leaves the `unknown` conservative profile in place.
   */
  const describeModel = (provider: string, model: string): void => {
    const key = `${provider}\u0000${model}`
    if (key === describedKey) return
    describedKey = key

    const supplied = suppliedIdentity(provider, model)
    if (supplied !== undefined) {
      applyIdentity(provider, model, { provider, model, ...supplied })
      return
    }

    const llmService = serviceOrUndefined(context, 'llm')
    const resolve = llmService?.resolveModelInfo
    if (typeof resolve !== 'function') {
      applyIdentity(provider, model, { provider, model })
      return
    }
    try {
      const pending = resolve.call(llmService, provider, model)
      if (pending instanceof Promise) {
        pending.then((info: unknown) => {
          const record = typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : undefined
          applyIdentity(provider, model, {
            provider,
            model,
            ...(typeof record?.name === 'string' ? { name: record.name } : {}),
            ...(typeof record?.description === 'string' ? { description: record.description } : {}),
          })
        }).catch(() => { applyIdentity(provider, model, { provider, model }) })
        return
      }
      const record = typeof pending === 'object' && pending !== null ? (pending as Record<string, unknown>) : undefined
      applyIdentity(provider, model, {
        provider,
        model,
        ...(typeof record?.name === 'string' ? { name: record.name } : {}),
        ...(typeof record?.description === 'string' ? { description: record.description } : {}),
      })
    } catch {
      applyIdentity(provider, model, { provider, model })
    }
  }

  const install = (): (() => void) => {
    if (installed !== undefined) return installed

    // The composition root already owns the attach switch; repeating it here
    // keeps the service safe to construct and install from anywhere else. A
    // plain no-op leaves every default in place.
    if (process.env.DSH_COORDINATION_PROXY !== '1' && !existsSync(flagFile)) return NOOP

    const llm = llmRuntimeOf(context)
    const service = serviceOrUndefined(context, 'llm')
    const register = service?.registerAdapter
    const on = (context as unknown as { on?: unknown }).on
    if (llm === undefined || typeof register !== 'function' || typeof on !== 'function') return NOOP

    // A restarted session may already carry the proxy route in its request
    // header, in which case `agent/request` never names the real one. Seed the
    // upstream from the deployment default so the adapter is never route-less.
    route = defaultRouteOf(context)
    // Rewriting is a separate switch: re-read it at install so a mode file
    // written before startup is honoured without changing the enable switch.
    state.mode = resolveMode(stateDir)
    if (route !== undefined) {
      trace({ event: 'install', provider: PROXY_PROVIDER, model: route.model })
    } else {
      trace({ event: 'install', provider: PROXY_PROVIDER })
    }
    if (route !== undefined) describeModel(route.provider, route.model ?? '')

    // Only `normalize` gives the adapter a decorator. `measure` forwards the
    // request with the route restored and nothing else changed.
    //
    // Inside normalize the researched preset is the second gate: rewriting bytes
    // can only help where reuse is decided by byte-identical prefixes, so an
    // explicit-breakpoint row (or a `none` row) is forwarded untouched. The gate
    // runs per call because the route may be named after install.
    const decorator = options.decorate
    const decorate = state.mode === 'normalize' && decorator !== undefined
      ? (request: Readonly<Record<string, unknown>>): Record<string, unknown> => {
          const strategy = state.cacheStrategy
          if (!strategy.volatileStrippingHelps || strategy.mode === 'none') return { ...request }
          // The adapter sees only the request; the real route is recorded here.
          return decorator(request as Record<string, unknown>, {
            provider: route?.provider ?? '',
            model: route?.model ?? '',
          })
        }
      : undefined
    const adapter = createProxyAdapter({
      provider: PROXY_PROVIDER,
      llm: observationLlm(llm),
      routeOf: () => route,
      allowProviders: PROXY_ALLOWED_PROVIDERS,
      trace,
      ...(decorate === undefined ? {} : { decorate }),
    })

    let registration: unknown
    let detach: unknown
    try {
      registration = register.call(service, [PROXY_PROVIDER], adapter)
      detach = (on as (...args: unknown[]) => unknown).call(
        context,
        'agent/request',
        async (_payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
          const seed = await next()
          const record = typeof seed === 'object' && seed !== null ? (seed as Record<string, unknown>) : undefined
          const provider = typeof record?.provider === 'string' ? record.provider : ''
          const model = typeof record?.model === 'string' ? record.model : ''
          if (record === undefined || provider.length === 0 || model.length === 0 || provider === PROXY_PROVIDER) {
            // A persisted proxy header carries no upstream; fall back to the
            // deployment default so forwarding still has a route.
            if (route === undefined) route = defaultRouteOf(context)
            return seed
          }
          // Least privilege: an unrecognised provider is never intercepted. The
          // request keeps the route the harness chose, so a third-party route
          // cannot be pulled into this proxy by accident.
          if (!isProxyProviderAllowed(provider, PROXY_ALLOWED_PROVIDERS)) {
            trace({ event: 'refuse', provider, reason: 'provider-not-allowlisted' })
            return seed
          }
          route = { provider, model }
          trace({ event: 'route', provider, model })
          describeModel(provider, model)
          return { ...record, provider: PROXY_PROVIDER, model }
        },
        { prepend: true },
      )
    } catch {
      trace({ event: 'refuse', provider: PROXY_PROVIDER, reason: 'registration-failed' })
      return NOOP
    }

    state.available = true
    state.enabled = true
    state.decorate = options.decorate !== undefined

    // One line per successful installation. It records that the rewrite is
    // active and which real provider was captured at that moment; it carries no
    // request content and does not touch the forward/refusal counters.
    trace({
      event: 'compat',
      reason: 'provider-id-rewrite',
      upstreamProvider: route?.provider,
    })

    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      state.enabled = false
      state.decorate = false
      if (installed === dispose) installed = undefined
      if (typeof detach === 'function') {
        try {
          detach()
        } catch {
          // A disposed listener is harmless during unload.
        }
      }
      if (typeof registration === 'function') {
        try {
          registration()
        } catch {
          // A disposed adapter registration is harmless during unload.
        }
      }
    }

    installed = dispose
    return dispose
  }

  const status = (): ProxyStatus => {
    const upstream = route === undefined ? undefined : { ...route }
    return {
      ...state,
      ...(state.model === undefined ? {} : { model: { ...state.model } }),
      cacheStrategy: { ...state.cacheStrategy, sources: [...state.cacheStrategy.sources] },
      upstreamProvider: route?.provider,
      ...(upstream === undefined ? {} : { upstream }),
      metrics: { ...state.metrics },
      prefix: { ...state.prefix },
    }
  }

  return {
    install,
    status,
    upstreamProvider: () => route?.provider,
    compatibility: () => PROXY_COMPATIBILITY,
  }
}
