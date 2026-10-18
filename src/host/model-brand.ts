/**
 * Brand cache profiles — built-in policy for the mainstream model families.
 *
 * The harness owns the model catalog (`ctx.llm.resolveModelInfo(provider, model)`
 * returns `{ provider, id, name, description, reasoning }`), but it does not say
 * how each family caches prompts. This module turns the host's identity fields
 * into one of a small set of known cache behaviours, so the proxy can reason
 * about a model instead of guessing from the provider route alone.
 *
 * What the profile means, and what it does not:
 *
 *  - `automaticPrefixCache` — the provider caches a stable prompt prefix on its
 *    own, with no request marker. When true the only useful local lever is
 *    keeping that prefix byte-stable.
 *  - `explicitCacheBreakpoints` — the provider needs cache markers inside the
 *    request. This plugin cannot emit them (they are adapter/wire territory), so
 *    the profile says so instead of pretending an optimization exists.
 *  - `minPrefixTokens` — the documented (or conservatively assumed) prefix size
 *    below which the provider does not cache at all.
 *  - `effortBreaksCache` — whether changing `reasoningEffort` invalidates the
 *    cached prefix. Tri-state: `true`/`false` only when the researched
 *    `cache-strategy.ts` row cites a fetched source; `'unknown'` is an evidence
 *    gap and must not be read as `false`.
 *  - `stripVolatileHelps` — whether removing volatile fragments (timestamps,
 *    UUIDs, long hex) from outbound text can improve reuse. False for explicit
 *    caching, where markers, not bytes, decide reuse.
 *
 * The numbers are policy defaults, never measurements: each profile carries the
 * note the UI shows, and an unknown family gets the conservative row.
 */
import { presetFor } from './cache-strategy.js'

/** Model family the cache policy knows about. */
export type ModelBrand =
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'moonshot'
  | 'qwen'
  | 'zhipu'
  | 'mistral'
  | 'meta'
  | 'unknown'

/** Whether a reasoning-effort change resets the cache: documented, or unknown. */
export type EffortBreaksCache = boolean | 'unknown'

/** One family's cache behaviour. */
export interface BrandCacheProfile {
  readonly brand: ModelBrand
  /** Display name used by the status endpoint. */
  readonly label: string
  /** The provider caches a stable prefix without request markers. */
  readonly automaticPrefixCache: boolean
  /** The provider requires explicit cache breakpoints in the request. */
  readonly explicitCacheBreakpoints: boolean
  /** Prefix size below which the provider caches nothing. */
  readonly minPrefixTokens: number
  /**
   * Changing the reasoning effort invalidates the cached prefix.
   *
   * Reconciled with the researched preset row: a boolean means a fetched source
   * documents it, `'unknown'` means no fetched source does.
   */
  readonly effortBreaksCache: EffortBreaksCache
  /** Removing volatile fragments from outbound text can improve reuse. */
  readonly stripVolatileHelps: boolean
  /** One line the status/UI can show; never a guarantee. */
  readonly note: string
}

/**
 * The authored rows.
 *
 * Every row starts with `effortBreaksCache: 'unknown'`: no fetched vendor page
 * states that reasoning effort participates in the cache key. The exported
 * `BRAND_PROFILES` below reconciles the field with `cache-strategy.ts`, which is
 * the researched source of truth.
 */
const BASE_PROFILES: Readonly<Record<ModelBrand, BrandCacheProfile>> = {
  deepseek: {
    brand: 'deepseek',
    label: 'DeepSeek',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: false,
    minPrefixTokens: 64,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Automatic prefix cache; keep the prefix stable. Effort impact on the cache key is undocumented.',
  },
  openai: {
    brand: 'openai',
    label: 'OpenAI',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: false,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Automatic prompt cache above ~1k tokens; stable prefixes are the lever. Effort impact is undocumented.',
  },
  anthropic: {
    brand: 'anthropic',
    label: 'Anthropic',
    automaticPrefixCache: false,
    explicitCacheBreakpoints: true,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: false,
    note: 'Explicit cache_control breakpoints only; this plugin cannot emit them.',
  },
  google: {
    brand: 'google',
    label: 'Google',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: true,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Implicit prefix cache plus optional explicit contexts; the implicit mode is the safe lever.',
  },
  xai: {
    brand: 'xai',
    label: 'xAI',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: false,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Automatic prefix cache; keep the prefix stable. Effort impact is undocumented.',
  },
  moonshot: {
    brand: 'moonshot',
    label: 'Moonshot',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: false,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Automatic prefix cache; reasoning content is preserved separately.',
  },
  qwen: {
    brand: 'qwen',
    label: 'Qwen',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: false,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Automatic prefix cache; keep the system prompt and tool list stable.',
  },
  zhipu: {
    brand: 'zhipu',
    label: 'Zhipu',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: false,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Automatic prefix cache; keep parameters stable. Effort impact is undocumented.',
  },
  mistral: {
    brand: 'mistral',
    label: 'Mistral',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: false,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Prefix caching with a conservative minimum; stable prefixes are the lever.',
  },
  meta: {
    brand: 'meta',
    label: 'Meta',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: false,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Self-hosted families vary by deployment; the conservative prefix rule applies.',
  },
  unknown: {
    brand: 'unknown',
    label: 'Unknown',
    automaticPrefixCache: true,
    explicitCacheBreakpoints: false,
    minPrefixTokens: 1024,
    effortBreaksCache: 'unknown',
    stripVolatileHelps: true,
    note: 'Unknown family: assume an automatic prefix cache and keep everything stable.',
  },
}

/**
 * Reconcile one family's effort field with the researched strategy table.
 *
 * The table is authoritative: a boolean there means a fetched source documents
 * the behaviour; `'unknown'` records an evidence gap. A gap stays visible — it
 * is never converted into a definite `false`.
 */
function reconcileEffort(profile: BrandCacheProfile): BrandCacheProfile {
  const preset = presetFor({ brand: profile.brand })
  const effortBreaksCache: EffortBreaksCache =
    typeof preset.effortBreaksPrefix === 'boolean' ? preset.effortBreaksPrefix : 'unknown'
  return { ...profile, effortBreaksCache }
}

/**
 * Built-in profiles, with `effortBreaksCache` derived from the strategy table.
 *
 * Where a provider documents both an automatic and an explicit mode (Google),
 * the conservative automatic reading is used: the plugin can keep a prefix
 * stable, and cannot emit markers.
 */
export const BRAND_PROFILES: Readonly<Record<ModelBrand, BrandCacheProfile>> = (() => {
  const profiles = {} as Record<ModelBrand, BrandCacheProfile>
  for (const brand of Object.keys(BASE_PROFILES) as ModelBrand[]) {
    profiles[brand] = reconcileEffort(BASE_PROFILES[brand])
  }
  return Object.freeze(profiles)
})()

/** The identity fields `classifyModelBrand` reads (all optional on the wire). */
export interface ModelIdentity {
  readonly provider?: string
  readonly model?: string
  readonly name?: string
  readonly description?: string
}

/**
 * Brand patterns, tested against provider + model + display name.
 *
 * Order matters: the first match wins, so a reseller route named after its
 * model (`acme-claude`) still lands on Anthropic before any generic rule.
 */
const BRAND_PATTERNS: ReadonlyArray<{ brand: ModelBrand; pattern: RegExp }> = [
  { brand: 'anthropic', pattern: /anthropic|claude/i },
  { brand: 'openai', pattern: /openai|chatgpt|\bgpt\b|gpt-[0-9o]|\bo[134]\b/i },
  { brand: 'google', pattern: /google|gemini|vertex/i },
  { brand: 'deepseek', pattern: /deepseek/i },
  { brand: 'xai', pattern: /\bxai\b|grok/i },
  { brand: 'moonshot', pattern: /moonshot|kimi/i },
  { brand: 'qwen', pattern: /qwen|tongyi|dashscope|alibaba/i },
  { brand: 'zhipu', pattern: /zhipu|chatglm|\bglm\b/i },
  { brand: 'mistral', pattern: /mistral|mixtral|codestral/i },
  { brand: 'meta', pattern: /\bllama\b|meta-llama/i },
]

/** Classify one host-reported model identity onto a known brand. */
export function classifyModelBrand(identity: ModelIdentity): ModelBrand {
  const haystack = [identity.provider, identity.model, identity.name, identity.description]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
  if (haystack.length === 0) return 'unknown'
  for (const row of BRAND_PATTERNS) {
    if (row.pattern.test(haystack)) return row.brand
  }
  return 'unknown'
}

/** The profile for one host-reported identity. */
export function brandProfileOf(identity: ModelIdentity): BrandCacheProfile {
  return BRAND_PROFILES[classifyModelBrand(identity)]
}

/**
 * Whether the proxy has a useful local lever for this model.
 *
 * With an explicit-breakpoint family the honest answer is "no": the plugin can
 * keep bytes stable, but reuse is decided by markers it cannot write.
 */
export function hasLocalCacheLever(profile: BrandCacheProfile): boolean {
  return profile.automaticPrefixCache && profile.stripVolatileHelps
}

/**
 * Whether outgoing content should be rewritten for this model right now.
 *
 * Two gates, both deliberate:
 *  - the operator switch (`cache.enabled`) is read live, so the settings page
 *    turns the rewrite off immediately;
 *  - a family without an automatic prefix cache is never rewritten — rewriting
 *    its bytes cannot improve reuse and only risks changing what the model sees.
 */
export function shouldDecorate(profile: BrandCacheProfile, cacheEnabled: boolean): boolean {
  return cacheEnabled && hasLocalCacheLever(profile)
}
