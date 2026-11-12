/**
 * Static provider/model price registry.
 *
 * Two generated catalogs are merged here:
 *
 * - `modelRegistry.ts` — 41 providers and 1,614 chat models from the installed
 *   `@earendil-works/pi-ai` 1.3.0 catalog. These are the routes DSH can already
 *   select; rates are USD per million tokens.
 * - `openRouterRegistry.ts` — 467 models from OpenRouter's live `/api/v1/models`
 *   response on 2026-11-12. This adds newer models and vendors that are not in
 *   the installed catalog yet; the provider route is `openrouter`.
 *
 * The generated tuples stay compact so the host bundle does not carry a large
 * JSON object. Lookup is exact first, then a narrowly defined provider alias,
 * then a model-id fallback only when it is unambiguous.
 */

import { MODEL_REGISTRY, MODEL_REGISTRY_MODELS, MODEL_REGISTRY_PROVIDERS, MODEL_REGISTRY_SOURCE } from './modelRegistry.js'
import { OPENROUTER_REGISTRY, OPENROUTER_REGISTRY_MODELS, OPENROUTER_REGISTRY_SOURCE } from './openRouterRegistry.js'

export interface RegistryTier {
  readonly above: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface RegistryModel {
  readonly provider: string
  readonly model: string
  readonly name: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly contextWindow: number
  readonly maxTokens: number
  readonly reasoning: boolean
  readonly inputModalities: readonly string[]
  readonly tiers: readonly RegistryTier[]
  readonly source: string
}

export interface RegistryStats {
  readonly providers: number
  readonly models: number
  readonly priced: number
  readonly sources: readonly string[]
}

function parseTiers(raw: string): readonly RegistryTier[] {
  if (raw.length === 0) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const tiers: RegistryTier[] = []
    for (const item of value) {
      if (!Array.isArray(item) || item.length < 5) continue
      const [above, input, output, cacheRead, cacheWrite] = item
      if (![above, input, output, cacheRead, cacheWrite].every((n) => typeof n === 'number' && Number.isFinite(n))) continue
      tiers.push({ above, input, output, cacheRead, cacheWrite })
    }
    return tiers.sort((a, b) => a.above - b.above)
  } catch {
    return []
  }
}

function modelOfPi(tuple: (typeof MODEL_REGISTRY)[number]): RegistryModel {
  return {
    provider: tuple[0],
    model: tuple[1],
    name: tuple[2],
    input: tuple[3],
    output: tuple[4],
    cacheRead: tuple[5],
    cacheWrite: tuple[6],
    contextWindow: tuple[7],
    maxTokens: tuple[8],
    reasoning: tuple[9] === 1,
    inputModalities: tuple[10].length > 0 ? tuple[10].split('+') : ['text'],
    tiers: parseTiers(tuple[11]),
    source: MODEL_REGISTRY_SOURCE,
  }
}

function modelOfOpenRouter(tuple: (typeof OPENROUTER_REGISTRY)[number]): RegistryModel {
  return {
    provider: 'openrouter',
    model: tuple[0],
    name: tuple[1],
    input: tuple[2],
    output: tuple[3],
    cacheRead: tuple[4],
    cacheWrite: tuple[5],
    contextWindow: tuple[6],
    maxTokens: tuple[7],
    reasoning: false,
    inputModalities: tuple[8].length > 0 ? tuple[8].split('+') : ['text'],
    tiers: parseTiers(tuple[9]),
    source: OPENROUTER_REGISTRY_SOURCE,
  }
}

const BY_PROVIDER = new Map<string, Map<string, RegistryModel>>()
const BY_MODEL = new Map<string, RegistryModel[]>()
let priced = 0

function index(model: RegistryModel): void {
  let provider = BY_PROVIDER.get(model.provider)
  if (provider === undefined) {
    provider = new Map()
    BY_PROVIDER.set(model.provider, provider)
  }
  provider.set(model.model, model)
  const list = BY_MODEL.get(model.model) ?? []
  list.push(model)
  BY_MODEL.set(model.model, list)
}

for (const tuple of MODEL_REGISTRY) index(modelOfPi(tuple))
for (const tuple of OPENROUTER_REGISTRY) index(modelOfOpenRouter(tuple))
for (const entries of BY_PROVIDER.values()) {
  for (const model of entries.values()) {
    if (model.input > 0 || model.output > 0) priced += 1
  }
}

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-official': 'deepseek',
  'deepseek-api': 'deepseek',
  'azure-openai': 'azure',
  'azure-ai': 'azure',
  'google-gemini': 'google',
  'google-ai': 'google',
  'google-vertex-ai': 'google-vertex',
  'vertex': 'google-vertex',
  'moonshot': 'moonshotai',
  'kimi': 'moonshotai',
  'zhipu': 'zai',
  'z-ai': 'zai',
  'zai-cn': 'zai-coding-cn',
  'minimax-cn': 'minimax-cn',
  'together-ai': 'together',
  'fireworks-ai': 'fireworks',
  'x-ai': 'xai',
  'open-router': 'openrouter',
}

function normalizeProvider(provider: string): string {
  const key = provider.trim().toLowerCase()
  return PROVIDER_ALIASES[key] ?? key
}

/**
 * Resolve a provider/model pair against the static registry.
 *
 * @param provider - DSH route name, possibly an alias.
 * @param model - provider-owned model id.
 * @returns the registry entry, or undefined when no unambiguous entry exists.
 */
export function lookupRegistryModel(provider: string, model: string): RegistryModel | undefined {
  const normalizedProvider = normalizeProvider(provider)
  const exactProvider = BY_PROVIDER.get(normalizedProvider)
  const exact = exactProvider?.get(model)
  if (exact !== undefined) return exact

  // OpenRouter is the fallback route for vendor-prefixed ids when the host
  // selected an unknown/aggregate provider but the model id is exact.
  const openRouter = BY_PROVIDER.get('openrouter')?.get(model)
  if (normalizedProvider === 'openrouter' && openRouter !== undefined) return openRouter

  const matches = BY_MODEL.get(model)
  if (matches !== undefined && matches.length === 1) return matches[0]

  // Case-insensitive model id is safe: provider ids are case-sensitive, but a
  // user-facing model name often differs only in casing.
  const lowered = model.toLowerCase()
  for (const entries of BY_PROVIDER.values()) {
    for (const [id, entry] of entries) {
      if (id.toLowerCase() === lowered) return entry
    }
  }

  return undefined
}

/** Registry size used by the value UI and the `/amp/models` route. */
export function registryStats(): RegistryStats {
  let models = 0
  for (const entries of BY_PROVIDER.values()) models += entries.size
  return {
    providers: BY_PROVIDER.size,
    models,
    priced,
    sources: [MODEL_REGISTRY_SOURCE, OPENROUTER_REGISTRY_SOURCE],
  }
}

/** Provider names in stable order, for the read-only registry route. */
export function registryProviders(): readonly string[] {
  return [...BY_PROVIDER.keys()].sort((a, b) => a.localeCompare(b))
}

/** One page of registry entries, optionally filtered by provider or query. */
export function listRegistryModels(options: {
  readonly provider?: string
  readonly query?: string
  readonly limit?: number
}): readonly RegistryModel[] {
  const provider = options.provider === undefined ? undefined : normalizeProvider(options.provider)
  const query = options.query?.trim().toLowerCase()
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)))
  const entries: RegistryModel[] = []
  for (const [route, models] of BY_PROVIDER) {
    if (provider !== undefined && route !== provider) continue
    for (const model of models.values()) {
      if (query !== undefined && query.length > 0
        && !model.model.toLowerCase().includes(query)
        && !model.name.toLowerCase().includes(query)) continue
      entries.push(model)
      if (entries.length >= limit) break
    }
    if (entries.length >= limit) break
  }
  return entries
}

/** Counts for one provider, used by the registry route's provider list. */
export function registryProviderCounts(): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const [provider, models] of BY_PROVIDER) counts[provider] = models.size
  return counts
}

/** Exact provider count constant for assertions and docs. */
export const REGISTRY_PROVIDER_TOTAL = BY_PROVIDER.size
