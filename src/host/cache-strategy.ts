/**
 * Cache strategy presets — a data-only table of vendor cache behaviour for the
 * coordination proxy.
 *
 * Why this module exists
 * ----------------------
 * The proxy can see which provider route and model a request targets, but it
 * cannot emit provider-specific cache markers. The only levers it has are the
 * bytes it forwards: keep a prefix stable, strip volatile fragments, and avoid
 * compaction that rewrites the middle of a cached prefix. Those levers are worth
 * different amounts on different families, so this module names the difference
 * instead of applying one heuristic everywhere.
 *
 * What this module is
 * -------------------
 *  - `CACHE_SOURCES` — the research table. Every row is a page or paper that was
 *    actually fetched while writing this module, plus the exact claim taken from
 *    it (or an explicit `UNFETCHED` marker when the origin blocked the request).
 *  - `CACHE_PRESETS` — per-brand, per-model and per-agent rows. Each row cites at
 *    least one source id and carries actionable prefix rules.
 *  - `presetFor()` — deterministic lookup: agent+model > model > brand > unknown.
 *
 * What this module is not
 * -----------------------
 * It performs no I/O, imports nothing, and reads no configuration. The numbers
 * are policy derived from the sources below, never measurements. A vendor page
 * that could not be fetched is recorded as `UNFETCHED` and its numbers are
 * marked as assumptions in `docs/cache-strategy.md`; nothing here is filled in
 * from memory.
 *
 * Evidence rules used when filling the table:
 *  - `minPrefixTokens` is the documented minimum where a source states one, and
 *    a deliberately conservative assumption otherwise.
 *  - `ttlSeconds` is the documented default TTL, omitted when no fetched source
 *    states one.
 *  - `effortBreaksPrefix` is tri-state: `true`/`false` only when a fetched
 *    source states the behaviour, `'unknown'` otherwise. No fetched vendor page
 *    says that changing reasoning effort changes the cache key, so every row is
 *    `'unknown'` with `effortEvidence: 'assumed'`; the docs keep this as an open
 *    question rather than a finding.
 *  - `volatileStrippingHelps` is true where reuse is decided by byte-identical
 *    prefixes (automatic prefix caching). It is false for explicit-breakpoint
 *    families, where reuse is decided by markers and rewriting bytes only risks
 *    changing what the model sees.
 */

/** How a provider decides that a prefix may be reused. */
export type CacheMode = 'automatic-prefix' | 'explicit-breakpoints' | 'hybrid' | 'none' | 'unknown'

/** One brand/model/agent row of the strategy table. */
export interface CacheStrategyPreset {
  /** Stable row id, e.g. `deepseek/automatic`. */
  id: string
  /** One of the researched brands or `unknown`. */
  brand: string
  /** Optional model-id patterns; a trailing `*` is a prefix wildcard. */
  models?: readonly string[]
  /** Optional agent ids this row is tuned for. */
  agents?: readonly string[]
  /** How reuse is decided for this family. */
  mode: CacheMode
  /** Prefix size below which the provider caches nothing (documented or assumed). */
  minPrefixTokens: number
  /** Documented default cache lifetime, in seconds, when one is known. */
  ttlSeconds?: number
  /**
   * Whether a reasoning-effort change resets the cache.
   *
   * `true`/`false` only when a fetched source states it; `'unknown'` otherwise.
   * An unknown value is never a measured "false" — it is an evidence gap.
   */
  effortBreaksPrefix: boolean | 'unknown'
  /**
   * Whether {@link effortBreaksPrefix} rests on a fetched source.
   *
   * `'documented'` requires a boolean value: the evidence rules never promote an
   * assumption into a definite claim. `'assumed'` must pair with `'unknown'`.
   */
  effortEvidence: 'documented' | 'assumed'
  /** True when removing volatile fragments from the prefix can improve reuse. */
  volatileStrippingHelps: boolean
  /** Actionable rules for keeping the prefix cacheable. */
  stablePrefixRules: readonly string[]
  /** Whether compaction in the middle of the prefix is unsafe, safe, or unknown. */
  compactionPolicy: 'avoid-mid-prefix' | 'safe' | 'unknown'
  /** Ids that must resolve inside `CACHE_SOURCES`. */
  sourceIds: readonly string[]
}

/** One research row: a fetched page or paper and the claim taken from it. */
export interface CacheSource {
  id: string
  title: string
  authors: string
  year: number
  url: string
  /** Quote (≤ 25 words) used by the presets, or an explicit `UNFETCHED` marker. */
  claim: string
}

/**
 * The research table.
 *
 * Rows marked `UNFETCHED` were attempted and blocked by the origin or the
 * network; the preset that cites one is flagged as assumed in the docs. Claims
 * are verbatim for English pages; two Chinese vendor pages carry the original
 * sentence plus a short translation, marked with `（译）`.
 */
export const CACHE_SOURCES: ReadonlyArray<CacheSource> = [
  {
    id: 'prompt-cache-paper',
    title: 'Prompt Cache: Modular Attention Reuse for Low-Latency Inference',
    authors: 'In Gim, Guojun Chen, Seung-seob Lee, Nikhil Sarda, Anurag Khandelwal, Lin Zhong',
    year: 2024,
    url: 'https://arxiv.org/abs/2311.04934',
    claim: 'by precomputing and storing the attention states of these frequently occurring text segments',
  },
  {
    id: 'pagedattention-paper',
    title: 'Efficient Memory Management for Large Language Model Serving with PagedAttention',
    authors:
      'Woosuk Kwon, Zhuohan Li, Siyuan Zhuang, Ying Sheng, Lianmin Zheng, Cody Hao Yu, Joseph E. Gonzalez, Hao Zhang, Ion Stoica',
    year: 2023,
    url: 'https://arxiv.org/abs/2309.06180',
    claim: 'flexible sharing of KV cache within and across requests to further reduce memory usage',
  },
  {
    id: 'sglang-radix-paper',
    title: 'SGLang: Efficient Execution of Structured Language Model Programs',
    authors:
      'Lianmin Zheng, Liangsheng Yin, Zhiqiang Xie, Chuyue Sun, Jeff Huang, Cody Hao Yu, Shiyi Cao, Christos Kozyrakis, Ion Stoica, Joseph E. Gonzalez, Clark Barrett, Ying Sheng',
    year: 2023,
    url: 'https://arxiv.org/abs/2312.07104',
    claim: 'novel optimizations like RadixAttention for KV cache reuse',
  },
  {
    id: 'vllm-apc-docs',
    title: 'Automatic Prefix Caching',
    authors: 'vLLM project',
    year: 2026,
    url: 'https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/',
    claim: 'a new query can directly reuse the KV cache if it shares the same prefix',
  },
  {
    id: 'deepseek-context-caching',
    title: 'Context Caching',
    authors: 'DeepSeek',
    year: 2026,
    url: 'https://api-docs.deepseek.com/guides/kv_cache',
    claim:
      'If subsequent requests have overlapping prefixes with previous requests, the overlapping part will only be fetched from the cache',
  },
  {
    id: 'azure-openai-prompt-caching',
    title: 'Prompt caching with Azure OpenAI in Microsoft Foundry Models',
    authors: 'Microsoft',
    year: 2026,
    url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/prompt-caching',
    claim:
      'set the prompt_cache_key parameter and reuse the same key for requests that share long, common prompt prefixes',
  },
  {
    id: 'aws-bedrock-prompt-caching',
    title: 'Prompt caching for faster model inference',
    authors: 'Amazon Web Services',
    year: 2026,
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html',
    claim: 'changing content in an earlier section invalidates the cache for later sections',
  },
  {
    id: 'anthropic-news-prompt-caching',
    title: 'Prompt caching with Claude',
    authors: 'Anthropic',
    year: 2025,
    url: 'https://www.anthropic.com/news/prompt-caching',
    claim: 'Writing to the cache costs 25% more than our base input token price',
  },
  {
    id: 'aider-prompt-caching',
    title: 'Prompt caching',
    authors: 'Aider',
    year: 2026,
    url: 'https://aider.chat/docs/usage/caching.html',
    claim: 'By default, Anthropic keeps your cache for 5 minutes.',
  },
  {
    id: 'moonshot-context-caching',
    title: '上下文缓存最佳实践 (Context caching best practices)',
    authors: 'Moonshot AI',
    year: 2026,
    url: 'https://platform.moonshot.cn/docs/guide/context-caching',
    claim: '缓存按请求前缀匹配。前缀中任何一处发生变化，该位置之后的内容都无法复用。（译：any prefix change invalidates what follows）',
  },
  {
    id: 'qwen-context-cache',
    title: '上下文缓存（Context Cache）',
    authors: 'Alibaba Cloud Model Studio (DashScope)',
    year: 2026,
    url: 'https://help.aliyun.com/zh/model-studio/context-cache',
    claim: '缓存块的内容最少为 1024 Token。（译：a cache block holds at least 1024 tokens）',
  },
  {
    id: 'zhipu-context-cache',
    title: '上下文缓存 (Context caching)',
    authors: 'Zhipu AI (BigModel)',
    year: 2026,
    url: 'https://docs.bigmodel.cn/cn/guide/capabilities/cache',
    claim: '重复的前缀内容必须足够长（建议 500 Token 以上）（译：the repeated prefix must be long; 500+ tokens recommended）',
  },
  {
    id: 'lost-in-the-middle',
    title: 'Lost in the Middle: How Language Models Use Long Contexts',
    authors:
      'Nelson F. Liu, Kevin Lin, John Hewitt, Ashwin Paranjape, Michele Bevilacqua, Fabio Petroni, Percy Liang',
    year: 2023,
    url: 'https://arxiv.org/abs/2307.03172',
    claim: 'performance is often highest when relevant information occurs at the beginning or end of the input context',
  },
  {
    id: 'llmlingua-paper',
    title: 'LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models',
    authors: 'Huiqiang Jiang, Qianhui Wu, Chin-Yew Lin, Yuqing Yang, Lili Qiu',
    year: 2023,
    url: 'https://arxiv.org/abs/2310.05736',
    claim: 'allows for up to 20x compression with little performance loss',
  },
  {
    id: 'openai-prompt-caching-docs',
    title: 'Prompt caching',
    authors: 'OpenAI',
    year: 2026,
    url: 'https://platform.openai.com/docs/guides/prompt-caching',
    claim: 'UNFETCHED — HTTP 403 (Cloudflare block) from this network; no claim used.',
  },
  {
    id: 'anthropic-prompt-caching-docs',
    title: 'Prompt caching',
    authors: 'Anthropic',
    year: 2026,
    url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
    claim: 'UNFETCHED — 307 redirect to app-unavailable-in-region from this network; no claim used.',
  },
  {
    id: 'gemini-context-caching-docs',
    title: 'Context caching',
    authors: 'Google',
    year: 2026,
    url: 'https://ai.google.dev/gemini-api/docs/caching',
    claim: 'UNFETCHED — connection timeout from this network; no claim used.',
  },
  {
    id: 'xai-prompt-caching-docs',
    title: 'Caching (Grok API)',
    authors: 'xAI',
    year: 2026,
    url: 'https://docs.x.ai/docs/guides/caching',
    claim: 'UNFETCHED — connection timeout from this network; no claim used.',
  },
]

/**
 * The conservative row.
 *
 * Defined before the table so `presetFor` can return it without searching, and
 * included at the end of `CACHE_PRESETS` so "every brand has a preset" holds for
 * `unknown` too.
 */
const UNKNOWN_PRESET: CacheStrategyPreset = {
  id: 'unknown/conservative',
  brand: 'unknown',
  mode: 'unknown',
  minPrefixTokens: 1024,
  effortBreaksPrefix: 'unknown',
  effortEvidence: 'assumed',
  volatileStrippingHelps: false,
  stablePrefixRules: [
    'assume nothing about caching; keep the prefix stable anyway',
    'measure hit tokens before rewriting or compacting a prefix',
    'append turns; avoid editing earlier messages',
  ],
  compactionPolicy: 'unknown',
  sourceIds: ['vllm-apc-docs', 'prompt-cache-paper'],
}

/**
 * The strategy table.
 *
 * Order is deliberate and load-bearing for ties: agent rows first, then model
 * rows, then brand rows, then the conservative row. `presetFor` ranks by
 * specificity, so order only decides between two rows of the same specificity.
 */
export const CACHE_PRESETS: readonly CacheStrategyPreset[] = [
  // ---- agent + model rows -------------------------------------------------
  {
    id: 'deepseek/dsh-agent',
    brand: 'deepseek',
    models: ['deepseek-*'],
    agents: ['dsh', 'deepseek-harness'],
    mode: 'automatic-prefix',
    minPrefixTokens: 64,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'keep the tool schemas byte-identical for the whole session',
      'append tool results; never rewrite the tool list',
      'keep the model id fixed: a model switch is a different cache',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['deepseek-context-caching', 'prompt-cache-paper'],
  },
  {
    id: 'anthropic/claude-code-agent',
    brand: 'anthropic',
    models: ['claude-*'],
    agents: ['claude-code', 'claude'],
    mode: 'explicit-breakpoints',
    minPrefixTokens: 1024,
    ttlSeconds: 300,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: false,
    stablePrefixRules: [
      'keep the system prompt and tool definitions byte-stable',
      'append file reads; do not rewrite earlier context',
      'put command output after the last cache breakpoint',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['aws-bedrock-prompt-caching', 'anthropic-news-prompt-caching', 'aider-prompt-caching'],
  },
  {
    id: 'openai/codex-agent',
    brand: 'openai',
    models: ['gpt-*'],
    agents: ['codex'],
    mode: 'hybrid',
    minPrefixTokens: 1024,
    ttlSeconds: 1800,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'keep repository instructions byte-stable at the top of the prompt',
      'append command output; never edit earlier turns',
      'reuse one prompt_cache_key per workspace prefix',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['azure-openai-prompt-caching', 'aws-bedrock-prompt-caching'],
  },

  // ---- model rows ---------------------------------------------------------
  {
    id: 'anthropic/claude-5-family',
    brand: 'anthropic',
    models: ['claude-opus-5*', 'claude-fable-5*', 'claude-mythos-5*'],
    mode: 'explicit-breakpoints',
    minPrefixTokens: 512,
    ttlSeconds: 300,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: false,
    stablePrefixRules: [
      'a 512-token minimum applies on Bedrock; re-check it on the first-party API',
      'one breakpoint at the end of the static content is enough',
      'keep reused content within roughly 20 content blocks of the breakpoint',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['aws-bedrock-prompt-caching'],
  },
  {
    id: 'anthropic/claude-sonnet-5',
    brand: 'anthropic',
    models: ['claude-sonnet-5*'],
    mode: 'explicit-breakpoints',
    minPrefixTokens: 1024,
    ttlSeconds: 300,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: false,
    stablePrefixRules: [
      'one breakpoint at the end of the static content is enough',
      'keep reused content within roughly 20 content blocks of the breakpoint',
      'do not move the breakpoint once traffic depends on it',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['aws-bedrock-prompt-caching', 'anthropic-news-prompt-caching'],
  },
  {
    id: 'anthropic/claude-high-minimum',
    brand: 'anthropic',
    models: ['claude-opus-4-7*', 'claude-opus-4-6*', 'claude-opus-4-5*', 'claude-haiku-4-5*'],
    mode: 'explicit-breakpoints',
    minPrefixTokens: 4096,
    ttlSeconds: 300,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: false,
    stablePrefixRules: [
      'expect a 4096-token minimum before a checkpoint is worth placing',
      'place the breakpoint after tools and system, never inside messages',
      'the 1-hour TTL is available, but a 5-minute cache refreshed on use is cheaper',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['aws-bedrock-prompt-caching', 'anthropic-news-prompt-caching'],
  },
  {
    id: 'anthropic/claude-4-x',
    brand: 'anthropic',
    models: [
      'claude-opus-4-8*',
      'claude-sonnet-4-6*',
      'claude-sonnet-4-5*',
      'claude-3-7-sonnet*',
      'claude-3-5-sonnet*',
    ],
    mode: 'explicit-breakpoints',
    minPrefixTokens: 1024,
    ttlSeconds: 300,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: false,
    stablePrefixRules: [
      'put cache_control on the last block that never changes',
      'at most four breakpoints; never move an earlier one',
      'volatile content belongs after the final breakpoint',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['aws-bedrock-prompt-caching', 'anthropic-news-prompt-caching'],
  },
  {
    id: 'openai/gpt-5-6',
    brand: 'openai',
    models: ['gpt-5-6*', 'gpt-6*'],
    mode: 'hybrid',
    minPrefixTokens: 1024,
    ttlSeconds: 1800,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'mark the end of the reusable prefix with an explicit breakpoint',
      'reuse one prompt_cache_key for every request sharing that prefix',
      'cache writes are billed on this generation: favour reads over rewrites',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['azure-openai-prompt-caching', 'aws-bedrock-prompt-caching', 'openai-prompt-caching-docs'],
  },

  // ---- brand rows ---------------------------------------------------------
  {
    id: 'deepseek/automatic',
    brand: 'deepseek',
    mode: 'automatic-prefix',
    minPrefixTokens: 64,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'keep the system prompt and tool definitions byte-identical across turns',
      'append new turns; never edit or reorder earlier messages',
      'put timestamps, ids and fresh tool output after the stable prefix',
      'reuse one prefix in a burst: the disk cache is cleared after hours to days',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['deepseek-context-caching', 'prompt-cache-paper'],
  },
  {
    id: 'openai/automatic',
    brand: 'openai',
    mode: 'hybrid',
    minPrefixTokens: 1024,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'keep the first 1024+ tokens identical across requests',
      'set one prompt_cache_key per shared prefix and reuse it',
      'do not reorder tools between requests',
      'prefer appending turns over rewriting them',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['azure-openai-prompt-caching', 'aws-bedrock-prompt-caching', 'openai-prompt-caching-docs'],
  },
  {
    id: 'anthropic/breakpoints',
    brand: 'anthropic',
    mode: 'explicit-breakpoints',
    minPrefixTokens: 1024,
    ttlSeconds: 300,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: false,
    stablePrefixRules: [
      'place a cache breakpoint after the stable tools+system block',
      'keep at most four breakpoints and never move an earlier one',
      'put volatile content after the last breakpoint',
      'resend the identical prefix: one changed byte before a breakpoint misses',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: [
      'anthropic-news-prompt-caching',
      'aws-bedrock-prompt-caching',
      'aider-prompt-caching',
      'anthropic-prompt-caching-docs',
    ],
  },
  {
    id: 'google/hybrid',
    brand: 'google',
    mode: 'hybrid',
    minPrefixTokens: 1024,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'keep the prefix stable; implicit caching is best effort',
      'prefer one long stable prefix over many small ones',
      'verify the minimum and TTL on the provider page before relying on them',
    ],
    compactionPolicy: 'unknown',
    sourceIds: ['gemini-context-caching-docs', 'aws-bedrock-prompt-caching'],
  },
  {
    id: 'xai/automatic',
    brand: 'xai',
    mode: 'automatic-prefix',
    minPrefixTokens: 1024,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'keep system prompt and tools byte-stable',
      'avoid editing earlier turns; append only',
      'treat the minimum and TTL as unverified until measured',
    ],
    compactionPolicy: 'unknown',
    sourceIds: ['xai-prompt-caching-docs', 'aws-bedrock-prompt-caching'],
  },
  {
    id: 'moonshot/automatic',
    brand: 'moonshot',
    mode: 'automatic-prefix',
    minPrefixTokens: 1024,
    ttlSeconds: 300,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'keep the prefix free of timestamps, ids and task state',
      'keep call intervals inside the 5-minute TTL, or opt into the 1-hour TTL',
      'do not switch TTL mid-session: the TTL is locked at first write',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['moonshot-context-caching'],
  },
  {
    id: 'qwen/hybrid',
    brand: 'qwen',
    mode: 'hybrid',
    minPrefixTokens: 1024,
    ttlSeconds: 300,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'keep the prefix byte-stable; the implicit cache is best effort',
      'for explicit caching, put at most four cache_control markers',
      'do not mix explicit and implicit caching in one request',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['qwen-context-cache'],
  },
  {
    id: 'zhipu/automatic',
    brand: 'zhipu',
    mode: 'automatic-prefix',
    minPrefixTokens: 500,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'keep the repeated prefix above roughly 500 tokens',
      'put the stable knowledge base before the changing question',
      'allow one request for the cache to become effective',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['zhipu-context-cache'],
  },
  {
    id: 'meta/self-hosted',
    brand: 'meta',
    mode: 'automatic-prefix',
    minPrefixTokens: 1024,
    effortBreaksPrefix: 'unknown',
    effortEvidence: 'assumed',
    volatileStrippingHelps: true,
    stablePrefixRules: [
      'enable prefix caching on the server (vLLM APC or SGLang radix tree)',
      'keep the prefix longer than one KV block and never reorder it',
      'pin the deployment: block size and cache config change the minimum',
    ],
    compactionPolicy: 'avoid-mid-prefix',
    sourceIds: ['vllm-apc-docs', 'sglang-radix-paper', 'pagedattention-paper'],
  },
  UNKNOWN_PRESET,
]

/**
 * Rank one candidate preset against the lookup input.
 *
 * @returns 3 for agent+model, 2 for model, 1 for agent, 0 for brand, -1 for no match.
 */
function rankOf(
  preset: CacheStrategyPreset,
  input: { brand?: string; model?: string; agent?: string },
  models: readonly string[],
): number {
  const hasModels = preset.models !== undefined && preset.models.length > 0
  const hasAgents = preset.agents !== undefined && preset.agents.length > 0

  if (hasModels && !matchesAny(preset.models ?? [], models)) return -1
  if (hasAgents) {
    const agent = input.agent
    if (typeof agent !== 'string' || agent.length === 0) return -1
    if (!matchesAny(preset.agents ?? [], [agent])) return -1
  }

  if (hasAgents && hasModels) return 3
  if (hasModels) return 2
  if (hasAgents) return 1
  return input.brand !== undefined && preset.brand === input.brand ? 0 : -1
}

/** Lowercase, trim, and treat dots/underscores as dashes so `4.5` matches `4-5`. */
function normaliseId(value: string): string {
  return value.trim().toLowerCase().replace(/[._]/g, '-')
}

/** One model id can appear bare, provider-prefixed, or tagged after a colon. */
function modelCandidates(model: string): readonly string[] {
  const candidates: string[] = [model]
  const slash = model.lastIndexOf('/')
  if (slash >= 0 && slash < model.length - 1) candidates.push(model.slice(slash + 1))
  const colon = model.lastIndexOf(':')
  if (colon >= 0 && colon < model.length - 1) candidates.push(model.slice(colon + 1))
  return candidates.map(normaliseId)
}

/** Match one value against one pattern; only a trailing `*` is special. */
function matchesPattern(value: string, pattern: string): boolean {
  const needle = normaliseId(pattern)
  const haystack = normaliseId(value)
  if (needle === '*') return true
  if (needle.endsWith('*')) return haystack.startsWith(needle.slice(0, -1))
  return haystack === needle
}

/** True when any value matches any pattern. */
function matchesAny(patterns: readonly string[], values: readonly string[]): boolean {
  return patterns.some((pattern) => values.some((value) => matchesPattern(value, pattern)))
}

/** Normalise one optional identity field, treating blanks as absent. */
function fieldOf(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed.toLowerCase()
}

/**
 * Resolve the most specific preset for a provider identity.
 *
 * Precedence, highest first:
 *  1. a preset with both `agents` and `models` that matches the agent and model;
 *  2. a preset with `models` that matches the model;
 *  3. a preset with `agents` that matches the agent (supported by the table
 *     shape, not used by the built-in rows);
 *  4. the brand row for the given brand;
 *  5. `unknown/conservative`.
 *
 * Model patterns outrank the brand on purpose: a reseller route may report a
 * generic brand while the model id still identifies the real family. Matching
 * ignores case, treats `.`/`_` as `-`, and also tries the segment after the last
 * `/` or `:`. Never throws; a blank or malformed input resolves to the
 * conservative row.
 */
export function presetFor(input: { brand?: string; model?: string; agent?: string }): CacheStrategyPreset {
  try {
    const brand = fieldOf(input?.brand)
    const model = fieldOf(input?.model)
    const agent = fieldOf(input?.agent)
    const models = model === undefined ? [] : modelCandidates(model)
    const ranked = { brand, model, agent }

    let best: CacheStrategyPreset | undefined
    let bestRank = -1

    for (const preset of CACHE_PRESETS) {
      const rank = rankOf(preset, ranked, models)
      if (rank > bestRank) {
        best = preset
        bestRank = rank
      }
    }

    return best ?? UNKNOWN_PRESET
  } catch {
    return UNKNOWN_PRESET
  }
}
