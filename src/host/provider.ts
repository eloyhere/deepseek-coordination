/**
 * Provider view: the read-only projection of DSH's `ctx.llm` (v23 §4).
 *
 * DSH owns every brand and every model. Adapter plugins register provider
 * routes, configuration activates dormant routes, and each adapter resolves
 * its own catalog. This module therefore holds **no catalog of its own**: it
 * merges the two registries DSH already exposes (`listProviders()` and
 * `listConfigurableProviders()`), copies each live route's model metadata from
 * `listModels()` + `resolveModelInfo()`, and adds exactly one thing of its own:
 * the provider *policy* supplement of v23 §5.1 (cache behaviour). That table
 * names provider families, never models, and is a documented policy default —
 * not a catalog (v23 §4.4).
 *
 * With no `host.llm` port the view cannot be authoritative. Every read that
 * needs DSH therefore throws `NotImplementedError('DSH llm port')` instead of
 * inventing a provider; `cacheStrategy()` is the single exception because it is
 * pure policy and reads nothing from DSH.
 *
 * Two consequences of the read port's asynchronous model enumeration are worth
 * stating explicitly:
 *
 *  - `models(route)` is the only method that asks DSH for a catalog, and it
 *    caches the result for `config.cache.ttl` milliseconds. `list()` and
 *    `resolve()` are synchronous by contract (the service layer turns them into
 *    promises), so they expose whatever the cache currently holds. A caller
 *    that wants populated views calls `await models(route)` first — the service
 *    does this for `listProviderView()` / `listModelCapability()`.
 *  - A dormant configurable provider has no registered adapter, and DSH's
 *    `listModels()` resolves a route's *registration*; there is nothing to ask.
 *    `models()` returns `[]` for a dormant route instead of failing the view.
 */
import type {
  LlmConfigurableProviderInfo,
  LlmModelInfo,
  LlmReadPort,
  LlmResolvedModelInfo,
  ModuleHost,
} from './module.js'
import type { CacheStrategy, ModelCapability, ProviderView } from '../shared/entity.js'
import { NotFoundError, NotImplementedError, UpstreamError } from '../shared/error.js'
import { LruList } from '../shared/lru.js'

/**
 * The provider cache policy supplement (v23 §5.1).
 *
 * This is a table of *provider behaviour*, not of providers or models: it never
 * enumerates a brand, a route or a model id, and an unknown route simply gets
 * the conservative default. Rows are matched case-insensitively, as substrings
 * of the route id, in the documented order; the first match wins. A deployment
 * that routes an unknown family through a cache-compatible endpoint can only
 * opt in by naming that route after a family — which is why the default is the
 * conservative one (`effortCacheBreak: true`).
 *
 * | route family        | effortCacheBreak | reasoningPreserve | configUpdateParam       |
 * |---------------------|------------------|-------------------|-------------------------|
 * | `deepseek*`         | true             | false             | —                       |
 * | `anthropic*`        | true             | false             | —                       |
 * | `kimi*`/`moonshot*` | true             | true              | —                       |
 * | `openai*`/`gpt-6*`  | false            | false             | `configuration_update`  |
 * | `xai*`/`grok*`      | true             | false             | —                       |
 * | anything else       | true             | false             | —                       |
 *
 * Rationale (v23 §5.1): DeepSeek's cache key includes `reasoning_effort` and
 * `max_tokens`, so switching either invalidates the whole 64-token-block cache;
 * Anthropic renders the thinking configuration into the prompt, so changing it
 * invalidates cache breakpoints; Kimi's prefix cache is byte-aligned and needs
 * the full `reasoning_content` preserved; GPT-6 can change effort through
 * `configuration_update` without invalidating the cache; xAI keeps affinity
 * through `x-grok-conv-id`.
 */
interface ProviderPolicyRow {
  /** Case-insensitive substring match against the provider route id. */
  readonly route: RegExp
  readonly strategy: Readonly<CacheStrategy>
}

const CachePolicy: readonly ProviderPolicyRow[] = [
  { route: /deepseek/, strategy: { effortCacheBreak: true, reasoningPreserve: false } },
  { route: /anthropic/, strategy: { effortCacheBreak: true, reasoningPreserve: false } },
  { route: /kimi|moonshot/, strategy: { effortCacheBreak: true, reasoningPreserve: true } },
  {
    route: /openai|gpt-6/,
    strategy: { effortCacheBreak: false, reasoningPreserve: false, configUpdateParam: 'configuration_update' },
  },
  { route: /xai|grok/, strategy: { effortCacheBreak: true, reasoningPreserve: false } },
]

/** The conservative policy for a provider family this table does not describe. */
export const DefaultCacheStrategy: Readonly<CacheStrategy> = {
  effortCacheBreak: true,
  reasoningPreserve: false,
}

/** One capability requirement a caller may ask a route to satisfy. */
export interface ProviderRequirement {
  /** Required input modality, e.g. `text`, `image`. */
  input?: string
  /** Minimum context window in tokens. */
  contextWindow?: number
  /** Reasoning effort id the model must advertise. */
  effort?: string
}

interface RouteEntry {
  route: string
  live: boolean
  /** The route is declared in DSH's configurable-provider directory. */
  declared: boolean
  name?: string
  displayName?: string
  error?: string
}

interface ModelCacheEntry {
  models: ModelCapability[]
  /** Unix milliseconds after which the catalog must be re-read from DSH. */
  expires: number
}

/**
 * Maximum model catalogs held at once.
 *
 * A catalog is a pure cache: evicting one only means the next `models(route)`
 * asks DSH again, so the bound cannot change an answer. DSH's route directory
 * is far smaller than this in every supported deployment; the cap exists so a
 * pathological route list cannot grow the plugin's heap without limit.
 */
export const ProviderCatalogCacheCapacity = 256

/**
 * Read-only provider view (v23 §4) and provider policy supplement (v23 §5.1).
 *
 * `title` is the configurable display name, then the live provider name, then
 * the route id. `source` describes where the *route registration* comes from,
 * never a guessed brand:
 *
 * | live | declared | source   |
 * |------|----------|----------|
 * | yes  | yes      | `plugin` |
 * | yes  | no       | `base`   |
 * | no   | yes      | `user`   |
 * | no   | no       | `user`   |
 *
 * `list()` lists live routes first (registration order), then the remaining
 * dormant directory entries (declaration order); a route that appears in both
 * registries is emitted once.
 */
export class ProviderModule {
  private readonly host: ModuleHost
  /**
   * Bounded catalog cache. `expires` is checked on every read, so a stale entry
   * is re-read from DSH even before the LRU would evict it; eviction itself is
   * invisible to callers (a miss re-enumerates).
   */
  private readonly cache = new LruList<string, ModelCacheEntry>(ProviderCatalogCacheCapacity)

  constructor(host: ModuleHost) {
    this.host = host
  }

  /** Merge the live and configurable registries, carrying cached catalogs. */
  list(): ProviderView[] {
    const observed = this.host.clock.now()
    return this.entries().map((entry) => this.view(entry, observed))
  }

  /** One route's view; a route DSH does not know is a `NotFoundError`. */
  resolve(route: string): ProviderView {
    return this.view(this.entry(route), this.host.clock.now())
  }

  /**
   * The route's model catalog, read from DSH and cached for `config.cache.ttl`.
   *
   * Enrichment is the only transformation: `contextWindow`, `maxTokens`,
   * `input` and `reasoningEfforts` come from `resolveModelInfo()`; `compat` is
   * not synthesised because the read port exposes no compatibility metadata.
   * A live provider with a genuinely empty catalog returns `[]`.
   */
  async models(route: string): Promise<ModelCapability[]> {
    const entry = this.entry(route)
    if (!entry.live) return []
    const cached = this.cached(route)
    if (cached !== undefined) return cloneModels(cached)
    const llm = this.port()
    const catalog = await this.enumerate(llm, route)
    const configuredLifetime = this.host.config.cache.ttl
    const lifetime = Number.isFinite(configuredLifetime) && configuredLifetime > 0 ? configuredLifetime : 0
    this.cache.set(route, { models: catalog, expires: this.host.clock.now() + lifetime })
    return cloneModels(catalog)
  }

  /**
   * The documented provider cache policy for one route (`undefined` never).
   *
   * Pure policy: it does not consult DSH, so it works even without the port,
   * and an unknown route gets `DefaultCacheStrategy`. It is a supplement to
   * DSH's own request building, never a request adapter (v23 §4.4, §5.4).
   */
  cacheStrategy(route: string): CacheStrategy {
    const id = route.toLowerCase()
    for (const row of CachePolicy) {
      if (row.route.test(id)) return { ...row.strategy }
    }
    return { ...DefaultCacheStrategy }
  }

  /**
   * Advisory qualification gate: is `route` live and does one of its
   * advertised models satisfy every supplied requirement?
   *
   * The answer is `false` for a dormant route, for an unmet requirement, and —
   * fail-closed — when no catalog has been read for the route yet. The gate
   * only answers a question; it never allocates a profession, a model or a
   * subtask (v23 §3.5 keeps allocation out of this module). Callers that need
   * the catalog to be present call `models(route)` first, exactly as the
   * service's qualification path does.
   */
  checkQualification(route: string, requirement?: ProviderRequirement): boolean {
    const entry = this.entry(route)
    if (!entry.live) return false
    if (requirement === undefined) return true
    const catalog = this.cached(entry.route)
    if (catalog === undefined || catalog.length === 0) {
      this.host.logger?.debug('provider qualification has no observed catalog; call models(route) first', { route })
      return false
    }
    return catalog.some((model) => qualifies(model, requirement))
  }

  /**
   * Upsert this route's observation into `provider_view`.
   *
   * The row is a snapshot: `models` is the catalog the cache currently holds
   * and `cacheStrategy` is the policy above. `route` is the conflict key, so a
   * second observation replaces the first (the schema declares `route UNIQUE`).
   * The observed view must exist; an unknown route is a `NotFoundError`.
   */
  observe(route: string): void {
    const view = this.resolve(route)
    const observed = view.observed
    this.host.db.run(
      `INSERT INTO provider_view (route, title, live, source, models, cacheStrategy, notes, observed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(route) DO UPDATE SET
         title = excluded.title,
         live = excluded.live,
         source = excluded.source,
         models = excluded.models,
         cacheStrategy = excluded.cacheStrategy,
         notes = excluded.notes,
         observed = excluded.observed`,
      view.route,
      view.title,
      view.live ? 1 : 0,
      view.source,
      JSON.stringify(view.models),
      JSON.stringify(view.cacheStrategy ?? this.cacheStrategy(view.route)),
      view.notes ?? null,
      observed,
    )
  }

  /** Drop the cached catalog of one route, or of every route when omitted. */
  invalidate(route?: string): void {
    if (route === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(route)
  }

  private port(): LlmReadPort {
    const llm = this.host.llm
    if (llm === undefined) throw new NotImplementedError('DSH llm port')
    return llm
  }

  private entries(): RouteEntry[] {
    const llm = this.port()
    const directory = new Map<string, LlmConfigurableProviderInfo>()
    for (const info of llm.listConfigurableProviders()) {
      if (info.provider.length === 0 || directory.has(info.provider)) continue
      directory.set(info.provider, info)
    }

    const entries: RouteEntry[] = []
    const seen = new Set<string>()
    for (const provider of llm.listProviders()) {
      if (provider.id.length === 0 || seen.has(provider.id)) continue
      seen.add(provider.id)
      const info = directory.get(provider.id)
      entries.push({
        route: provider.id,
        live: true,
        declared: info?.declared === true,
        name: provider.name,
        displayName: info?.displayName,
        error: info?.error,
      })
    }
    for (const info of directory.values()) {
      if (seen.has(info.provider)) continue
      seen.add(info.provider)
      entries.push({
        route: info.provider,
        live: false,
        declared: info.declared === true,
        displayName: info.displayName,
        error: info.error,
      })
    }
    return entries
  }

  private entry(route: string): RouteEntry {
    const entry = this.entries().find((candidate) => candidate.route === route)
    if (entry === undefined) throw new NotFoundError('provider route', route)
    return entry
  }

  /** The cached catalog while it is fresh; `undefined` once it has expired. */
  private cached(route: string): ModelCapability[] | undefined {
    const entry = this.cache.get(route)
    if (entry === undefined) return undefined
    return entry.expires > this.host.clock.now() ? entry.models : undefined
  }

  private view(entry: RouteEntry, observed: number): ProviderView {
    const models = this.cached(entry.route)
    const notes = describe(entry)
    return {
      route: entry.route,
      title: titleOf(entry),
      live: entry.live,
      source: sourceOf(entry),
      models: cloneModels(models ?? []),
      cacheStrategy: this.cacheStrategy(entry.route),
      ...(notes === undefined ? {} : { notes }),
      observed,
    }
  }

  private async enumerate(llm: LlmReadPort, route: string): Promise<ModelCapability[]> {
    let catalog: LlmModelInfo[]
    try {
      catalog = await llm.listModels(route)
    } catch (error) {
      throw new UpstreamError(`DSH could not list models for provider "${route}"`, {
        route,
        cause: messageOf(error),
      })
    }
    return Promise.all(catalog.map((info) => this.capability(llm, route, info)))
  }

  private async capability(llm: LlmReadPort, route: string, info: LlmModelInfo): Promise<ModelCapability> {
    let resolved: LlmResolvedModelInfo
    try {
      resolved = await llm.resolveModelInfo(route, info.id)
    } catch (error) {
      throw new UpstreamError(`DSH could not resolve model "${info.id}" for provider "${route}"`, {
        route,
        model: info.id,
        cause: messageOf(error),
      })
    }
    const modalities = resolved.inputModalities ?? info.inputModalities ?? []
    const efforts = (resolved.reasoning?.efforts ?? [])
      .map((effort) => effort.id)
      .filter((effort) => effort.length > 0)
    return {
      id: resolved.id.length > 0 ? resolved.id : info.id,
      name: resolved.name.length > 0 ? resolved.name : info.name,
      // Zero means "DSH did not report it"; qualification then treats the
      // requirement as unmet rather than guessing a capability.
      contextWindow: positive(resolved.context?.contextWindow),
      maxTokens: positive(resolved.defaultMaxTokens),
      input: modalities.filter((modality) => modality.length > 0),
      ...(efforts.length === 0 ? {} : { reasoningEfforts: efforts }),
    }
  }
}

/**
 * Where a route registration comes from. `declared` means the route appears in
 * DSH's configurable-provider directory (a settings-level declaration); it does
 * not mean the route is live. A dormant route is the user layer in both cases,
 * live-but-undeclared is a base composition route, and live-and-declared came
 * from a plugin's declared directory entry.
 */
function sourceOf(entry: RouteEntry): ProviderView['source'] {
  if (!entry.live) return 'user'
  return entry.declared ? 'plugin' : 'base'
}

function titleOf(entry: RouteEntry): string {
  const display = entry.displayName?.trim() ?? ''
  if (display.length > 0) return display
  const name = entry.name?.trim() ?? ''
  return name.length > 0 ? name : entry.route
}

function describe(entry: RouteEntry): string | undefined {
  if (!entry.live) {
    return entry.error === undefined || entry.error.length === 0
      ? 'dormant in DSH: configurable route without a registered adapter'
      : `dormant in DSH: ${entry.error}`
  }
  if (entry.error !== undefined && entry.error.length > 0) return `configuration diagnostic from DSH: ${entry.error}`
  return undefined
}

/** Every supplied requirement must hold for one advertised model. */
function qualifies(model: ModelCapability, requirement: ProviderRequirement): boolean {
  if (requirement.contextWindow !== undefined) {
    if (!Number.isFinite(requirement.contextWindow)) return false
    if (model.contextWindow < requirement.contextWindow) return false
  }
  if (requirement.input !== undefined && requirement.input.length > 0) {
    const wanted = requirement.input.toLowerCase()
    if (!model.input.some((modality) => modality.toLowerCase() === wanted)) return false
  }
  if (requirement.effort !== undefined && requirement.effort.length > 0) {
    if (model.reasoningEfforts === undefined) return false
    if (!model.reasoningEfforts.includes(requirement.effort)) return false
  }
  return true
}

function positive(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function cloneModels(models: readonly ModelCapability[]): ModelCapability[] {
  return models.map((model) => ({
    ...model,
    input: [...model.input],
    ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: [...model.reasoningEfforts] }),
    ...(model.compat === undefined ? {} : { compat: { ...model.compat } }),
  }))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
