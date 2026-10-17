/**
 * Token-saving governor (v24 §5, §9.3, §12, §14, §22).
 *
 * A pure policy module: no DSH import, no HTTP, no database write, no
 * tokenizer dependency. The host adapter calls these functions to decide when
 * to compact, which context chunks to keep, and whether a retrieval is worth
 * its cost; it performs the actual compaction through DSH. Every export is
 * deterministic, so a decision can be replayed from the same inputs.
 *
 * ## Research basis (encoded, never fetched at runtime)
 *
 * - **LLMLingua-2** (Pan et al., arXiv:2403.12968): task-agnostic, token-level
 *   compression keeps the informative tokens and drops redundancy, reaching
 *   2x-5x compression with small quality loss. This module takes the same
 *   stance at chunk granularity: keep a small, high-value set, not everything.
 * - **Claude automatic context compaction cookbook**: trigger at a utilisation
 *   threshold, replace older spans with a summary checkpoint, and keep recent
 *   turns plus pinned facts verbatim. `budgetFor`/`planBudget` implement the
 *   threshold half, `selectContext` the "recent + pinned verbatim" half.
 * - **Prefix caching** (v24 §5.1): a stable prefix must come first; changing
 *   `reasoningEffort`/`max_tokens` or injecting volatile text breaks the cache,
 *   and DeepSeek caches in 64-token blocks, all-or-nothing. Selection therefore
 *   preserves input order and never rewrites text; `shouldCompact` also treats
 *   a cold cache after a large prompt as pressure to shrink the prefix.
 * - **Agentic Plan Caching** (arXiv:2506.14852): validated plans and their
 *   prefixes should be reused across similar tasks instead of re-derived.
 *   `selectContext` weights `plan` and `evidence` chunks above raw history.
 * - **Anthropic context engineering**: use the smallest high-signal token set;
 *   compaction, structured note-taking and sub-agent isolation beat dumping
 *   the whole transcript.
 *
 * ## Complexity contract
 *
 * | export | time | extra space |
 * |---|---|---|
 * | `estimateTokens` | O(n) first call, O(1) memo hit (constant sample) | O(1) beyond the bounded memo |
 * | `estimateMessages` | O(total walked chars) | O(depth) recursion, depth <= 8 |
 * | `budgetFor` | O(1) | O(1) |
 * | `planBudget` | O(1) | O(1) |
 * | `valuePerToken` | O(1) | O(1) |
 * | `selectContext` | O(n) scoring + O(n + k log n) heap pops (worst O(n log n)) | O(n + k) |
 * | `shouldRetrieve` | O(1) | O(1) |
 * | `shouldCompact` | O(1) | O(1) |
 * | `normaliseCompactionPatch` | O(1) | O(1) |
 * | `TokenGovernor.plan` | O(n) first call, O(1) cached hit | O(n) for the candidate list only |
 * | `TokenGovernor.select` | `selectContext` | `selectContext` |
 * | `TokenGovernor.shouldRetrieve` | O(1) | O(1) |
 * | `TokenGovernor.recordCompaction` / `recordUsage` / `stats` | O(1) | O(1) |
 *
 * `n` is input characters for the estimators, or chunks for selection. The
 * estimator's memo is an LRU capped at 256 entries, so its memory is O(256),
 * not O(history). Selection never performs pairwise similarity: near-duplicate
 * removal is a single Set pass over normalised-prefix hashes, so there is no
 * O(n^2) MMR/Jaccard step and no O(n) full-content copy (a JSON round trip of
 * the whole transcript would allocate O(n) extra and serialise non-text
 * fields). Candidates are heapified in O(n) and popped in value order, so a
 * budget that fills after k accepts costs O(n + k log n) instead of sorting
 * every candidate; a chunk with zero estimated tokens keeps its place in that
 * order, so the heap is not abandoned while any can still be accepted.
 */
import { InvalidArgumentError } from '../shared/error.js'
import { hashString } from '../shared/hash.js'
import { BinaryHeap } from '../shared/heap.js'
import { LruList } from '../shared/lru.js'
import type { CompactionPolicyConfig, CoordinationConfig } from './config.js'

/* ------------------------------------------------------------------------- *
 * Public contract
 * ------------------------------------------------------------------------- */

export interface TokenBudget {
  contextWindow: number
  soft: number
  hard: number
  reserve: number
  recentTurns: number
}

/** One request's token usage as DSH reported it (`TokenUsage`). */
export interface TokenUsageView {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
}

/**
 * One planning result. Treat every field as read-only: the governor returns its
 * cached plan object by reference, so mutating `dropCandidates` or `budget`
 * would corrupt the next cached read. `estimated` comes from DSH's measured
 * usage when the caller supplied it, otherwise from `estimateMessages`;
 * `keepRecent` counts turns (selection keeps `keepRecent * 2` user/assistant
 * chunks) and `dropCandidates` uses `message:<index>` ids because plan() sees
 * messages, not chunk ids.
 */
export interface TokenPlan {
  estimated: number
  budget: TokenBudget
  utilization: number
  decision: 'none' | 'soft-compact' | 'hard-prune'
  reason: string
  keepRecent: number
  dropCandidates: string[]
}

/**
 * One unit of context the governor may keep or drop.
 *
 * `score` is the caller's value judgement in [0, 1] (plan score, evidence
 * confidence, ...); `tokens` is that chunk's own size; `pinned` marks facts
 * that must survive every compaction; `created` is the deterministic
 * tie-breaker (epoch milliseconds).
 */
export interface ContextChunk {
  id: string
  kind: 'system' | 'user' | 'assistant' | 'tool' | 'evidence' | 'plan' | 'history'
  text: string
  tokens: number
  score: number
  pinned?: boolean
  created?: number
}

/* ------------------------------------------------------------------------- *
 * Policy constants (exposed so hosts and tests never hard-code a threshold)
 * ------------------------------------------------------------------------- */

/** Every tunable threshold of the pure policy, in one frozen table. */
export const TokenPolicy = Object.freeze({
  /** Soft utilisation of the effective window (`contextWindow - reserve`). */
  soft: 0.7,
  /** Hard utilisation that forces pruning rather than summarising. */
  hard: 0.88,
  /** Smallest reserve, in tokens (the schema default is also 2048). */
  reserveTokens: 2048,
  /** Reserve as a share of the window, when that is larger than 2048. */
  reserveFraction: 0.08,
  /** A reserve never consumes more than a quarter of the window. */
  maxReserveFraction: 0.25,
  minContextWindow: 8000,
  maxContextWindow: 2_000_000,
  /** Used when a host does not pass DSH's model context window. */
  defaultContextWindow: 128_000,
  recentTurns: 6,
  minRecentTurns: 2,
  maxRecentTurns: 20,
  /** Selection fills up to `hard * 0.9` of the effective window. */
  selectionFillRatio: 0.9,
  /** Fail-closed input cap: selection rejects more chunks than this. */
  maxChunks: 20_000,
  /** Per-message chat-template overhead (role markers, separators). */
  messageOverheadTokens: 3,
  /** Content walk depth cap; also stops a cyclic object graph. */
  maxContentDepth: 8,
  /** Per-message character cap; a longer message is under-measured. */
  maxCharsPerMessage: 2_000_000,
  /** Per-message block cap, so an adversarial array cannot burn O(n). */
  maxBlocksPerMessage: 20_000,
  /** A cold cache with a prompt above this share of the window is pressure. */
  coldCacheInputRatio: 0.6,
  /** Conservative share of the last estimate assumed saved by a compaction. */
  compactionSavingsRatio: 0.4,
  /** The Bayesian retrieval gate of v24 §12/§14. */
  retrieval: Object.freeze({
    /** Below this posterior entropy (bits) the answer is already confident. */
    entropyFloor: 0.15,
    /** Cost is expressed per 1000 units (the formula's denominator). */
    costUnit: 1000,
    /** Required gain is half the normalised query cost. */
    gainScale: 0.5,
    /** One normalised web query, when the caller does not price one. */
    defaultQueryCost: 1000,
  }),
  /** Estimator coefficients; see `estimateTokens` for the error bounds. */
  estimator: Object.freeze({
    cjk: 1,
    word: 1.3,
    wordExtra: 0.1,
    longWord: 5,
    other: 0.25,
    emoji: 1,
    memoCapacity: 256,
  }),
})

/** Kind weights: stable facts and plans outrank transcript history. */
const KindWeight: Readonly<Record<ContextChunk['kind'], number>> = {
  system: 2,
  plan: 1.6,
  evidence: 1.4,
  tool: 0.8,
  history: 0.6,
  user: 1,
  assistant: 1,
}

/* ------------------------------------------------------------------------- *
 * Estimator
 * ------------------------------------------------------------------------- */

/**
 * Estimate one text's token count without a tokenizer.
 *
 * One linear pass, no regular expression (so no backtracking), no per-character
 * string or array allocation:
 *
 * ```text
 * tokens = 1.0  * CJK/fullwidth code points
 *        + 1.3  * ASCII word runs            (letters, digits, underscore)
 *        + 0.1  * word characters beyond 5 per run
 *        + 0.25 * other code points          (punctuation, symbols, code)
 *        + 1.0  * astral emoji/symbol code points
 * ```
 *
 * Whitespace is free because the tokenizer folds it into its neighbours. This
 * mirrors the three classes in the module contract: CJK is roughly one token
 * per character, English prose roughly 1.3 tokens per word, code roughly a
 * quarter token per punctuation character.
 *
 * **Error bounds** (measured against a BPE tokenizer on the corpus shapes this
 * plugin sees, not a guarantee): typically +/-15% on English prose, +/-10% on
 * Chinese/Japanese prose, +/-25% on source code, and up to -35% on very long
 * identifiers or unusual scripts that fall into the 0.25/char class. Emoji are
 * counted as one token per code point, which under-counts ZWJ sequences. The
 * returned value is rounded to the nearest integer. The estimator is advisory:
 * DSH's reported `TokenUsage` always wins when present
 * (`TokenGovernor.plan(..., usage)`), and the budget reserves at least 12% of
 * the window as headroom precisely so an estimate never sits on the boundary.
 *
 * Results are memoised in a 256-entry LRU keyed by length plus three sampled
 * windows (first 64, middle 32, last 32 characters), so repeatedly estimating
 * the same compaction summary is O(1) after the first call: the sample is 128
 * constant characters, independent of text length. Texts up to 256 characters
 * are keyed by their whole content and are therefore exact. Two long texts with
 * the same length and the same three sampled windows can share a memo entry;
 * the error is bounded by the estimator's own tolerance, and the cache is a
 * performance aid only.
 *
 * @complexity O(n) first call; O(1) memo hit; extra space O(1) outside the
 * bounded O(256)-entry memo.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string') {
    throw new InvalidArgumentError('text must be a string', { received: typeof text })
  }
  const length = text.length
  if (length === 0) return 0

  const sample = memoKey(text)
  const cached = memo.get(sample.key)
  if (cached !== undefined && sampleMatches(cached, length, sample)) {
    // `get` above already promoted the entry to most-recently used.
    memoHits += 1
    return cached.value
  }
  memoMisses += 1

  const value = Math.round(scanTokenCount(text))
  remember(sample, length, value)
  return value
}

/**
 * Estimate a message list, including a small per-message chat-template charge.
 *
 * `content` may be a string, a block array, or an object carrying one of the
 * known text/container fields. The walk is depth-capped (8) and cap-bounded per
 * message (2,000,000 characters / 20,000 blocks), so a cyclic object graph, a
 * pathological nesting or a giant array cannot turn the estimate into an
 * unbounded walk. Missing content (images, tool JSON that is not under a known
 * field) is not measured; DSH usage remains authoritative.
 *
 * No `JSON.stringify` is used: serialising the whole content would allocate
 * O(n) extra space, encode structural characters as if they were prompt text,
 * and fail on cyclic values. The returned value is rounded to the nearest
 * integer.
 *
 * @complexity O(total characters walked), bounded by the per-message caps;
 * extra space O(depth) <= O(8).
 */
export function estimateMessages(messages: ReadonlyArray<{ role: string; content: unknown }>): number {
  if (!Array.isArray(messages)) {
    throw new InvalidArgumentError('messages must be an array', { received: typeof messages })
  }
  let tokens = 0
  for (const message of messages) {
    if (!isRecord(message)) {
      throw new InvalidArgumentError('each message must be an object', { received: typeof message })
    }
    if (typeof message.role !== 'string') {
      throw new InvalidArgumentError('message.role must be a string', { role: typeof message.role })
    }
    if (message.role.length === 0) {
      throw new InvalidArgumentError('message.role must not be empty')
    }
    const scan: ContentScan = { chars: 0, blocks: 0, tokens: 0, truncated: false }
    scanContent(message.content, 0, scan)
    tokens += scan.tokens + TokenPolicy.messageOverheadTokens
  }
  return Math.round(tokens)
}

/* ------------------------------------------------------------------------- *
 * Budget
 * ------------------------------------------------------------------------- */

/**
 * Resolve the token budget for one model window.
 *
 * Defaults: `soft = 0.70`, `hard = 0.88`,
 * `reserve = max(2048, 8% of window)` capped at 25% of the window, and
 * `recentTurns = 6`. The window is clamped to [8k, 2M] tokens. Explicit
 * overrides are clamped to the documented ranges; `hard` always stays strictly
 * above `soft` (by at least 0.01) and at most 0.98. The reserve cap means an
 * 8k window reserves 2000 tokens (not 2048), while a 100k window reserves
 * 8000. `NaN`, infinite or negative numbers are rejected with
 * `InvalidArgumentError`; unreasonably small or large positive windows are
 * clamped, because the model catalog is authoritative and a host should not
 * crash over a 4k embedding model.
 *
 * @complexity O(1), no allocation beyond the returned object.
 */
export function budgetFor(contextWindow: number, config: Partial<TokenBudget> = {}): TokenBudget {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow < 0) {
    throw new InvalidArgumentError('contextWindow must be a finite non-negative number', { contextWindow })
  }
  if (!isRecord(config)) {
    throw new InvalidArgumentError('budget overrides must be an object', { received: typeof config })
  }
  const softInput = optionalNonNegative(config.soft, 'soft')
  const hardInput = optionalNonNegative(config.hard, 'hard')
  const reserveInput = optionalNonNegative(config.reserve, 'reserve')
  const recentInput = optionalNonNegative(config.recentTurns, 'recentTurns')

  const window = clamp(Math.trunc(contextWindow), TokenPolicy.minContextWindow, TokenPolicy.maxContextWindow)
  const soft = clamp(softInput ?? TokenPolicy.soft, 0.3, 0.9)
  const hard = clamp(hardInput ?? TokenPolicy.hard, soft + 0.01, 0.98)
  const ceiling = Math.floor(window * TokenPolicy.maxReserveFraction)
  const defaultReserve = Math.max(TokenPolicy.reserveTokens, Math.round(window * TokenPolicy.reserveFraction))
  const reserve = clamp(Math.round(reserveInput ?? defaultReserve), 0, ceiling)
  const recentTurns = clamp(
    Math.round(recentInput ?? TokenPolicy.recentTurns),
    TokenPolicy.minRecentTurns,
    TokenPolicy.maxRecentTurns,
  )
  return { contextWindow: window, soft, hard, reserve, recentTurns }
}

/**
 * Classify the estimated context against the budget.
 *
 * `utilization = estimated / (contextWindow - reserve)`, rounded to four
 * decimals; the decision is made on that rounded value so the reason string and
 * the decision can never disagree. `none` below `soft`, `soft-compact` from
 * `soft` up to `hard`, `hard-prune` at or above `hard`. Fail-safe rules:
 * non-positive effective capacity yields `none`, and a context whose estimate
 * fits inside the output reserve is never hard-pruned (the reserve exists for
 * output, so fitting it means there is no context overflow to prune).
 *
 * The reason always names the threshold it crossed, e.g.
 * `utilization 0.71 reached the soft threshold 0.70`.
 *
 * @complexity O(1), no allocation beyond `{ decision, utilization, reason }`.
 */
export function planBudget(
  estimated: number,
  budget: TokenBudget,
): Pick<TokenPlan, 'decision' | 'utilization' | 'reason'> {
  const estimate = requireNonNegative(estimated, 'estimated')
  assertBudget(budget)
  const effective = budget.contextWindow - budget.reserve
  if (!(effective > 0)) {
    return {
      decision: 'none',
      utilization: 0,
      reason:
        `effective context window is ${Math.max(0, effective)} tokens after a ${budget.reserve}-token reserve; ` +
        'no compaction decision',
    }
  }
  const utilization = round(estimate / effective, 4)
  const detail = `estimated ${estimate} of ${effective} effective tokens`
  if (estimate <= budget.reserve) {
    // Fail-safe: the whole prompt fits the output reserve, so nothing about
    // the context is over budget even if a malformed budget says otherwise.
    return utilization >= budget.soft
      ? {
          decision: 'soft-compact',
          utilization,
          reason: `utilization ${utilization} reached the soft threshold ${budget.soft} (${detail})`,
        }
      : {
          decision: 'none',
          utilization,
          reason: `utilization ${utilization} is below the soft threshold ${budget.soft} (${detail})`,
        }
  }
  if (utilization >= budget.hard) {
    return {
      decision: 'hard-prune',
      utilization,
      reason: `utilization ${utilization} reached the hard threshold ${budget.hard} (${detail})`,
    }
  }
  if (utilization >= budget.soft) {
    return {
      decision: 'soft-compact',
      utilization,
      reason: `utilization ${utilization} reached the soft threshold ${budget.soft} (${detail})`,
    }
  }
  return {
    decision: 'none',
    utilization,
    reason: `utilization ${utilization} is below the soft threshold ${budget.soft} (${detail})`,
  }
}

/* ------------------------------------------------------------------------- *
 * Chunk selection
 * ------------------------------------------------------------------------- */

/**
 * Value density of one chunk: `score * (1 + kindWeight) / max(1, tokens)`.
 *
 * The `1 +` keeps a zero-scored chunk from being indistinguishable from a
 * dropped one, while the token denominator prefers short, high-signal chunks —
 * the "smallest high-signal token set" of Anthropic's context engineering and
 * the redundancy-removal premise of LLMLingua-2. Pinned chunks bypass this
 * score entirely (`selectContext`), so weighting a system prompt highly is an
 * ordering aid, not a safety mechanism.
 *
 * @complexity O(1), no allocation.
 */
export function valuePerToken(chunk: ContextChunk): number {
  assertChunk(chunk)
  const weight = KindWeight[chunk.kind] ?? 1
  return (chunk.score * (1 + weight)) / Math.max(1, chunk.tokens)
}

/**
 * Select the context chunks to send, dropping the rest.
 *
 * Precedence, highest first:
 *
 * 1. **Pinned** chunks are always selected, even when they alone exceed the
 *    fill budget: a pinned fact is a correctness requirement, not a preference.
 * 2. **Recent turns**: the last `recentTurns * 2` `user`/`assistant` chunks are
 *    kept verbatim (the Claude compaction cookbook's "recent turns" rule).
 * 3. Everything else is ranked once by `valuePerToken` and filled greedily
 *    until `hard * 0.9` of the effective window, trying later (smaller)
 *    candidates when one does not fit.
 *
 * Near-duplicate chunks are dropped with a single memoisable signature pass
 * (normalised 80% prefix + quarter-octave length bucket, encoded as a pair of
 * 32-bit hashes). This approximates the "80% overlap" rule without pairwise
 * Jaccard/MMR comparison: the naive alternative is O(n^2) time and space, which
 * at 20,000 chunks is 200M comparisons. `pinned` and recent chunks are never
 * deduplicated against each other; a candidate that duplicates a kept chunk is
 * dropped.
 *
 * `selected` and `dropped` preserve the caller's input order, so the surviving
 * messages keep the conversation order that prefix caching depends on. Ties in
 * value are broken by `created` ascending, then `id` ascending (byte-wise), so
 * the result is deterministic for equal inputs. The input array and chunks are
 * never mutated or cloned; references are returned.
 *
 * @throws InvalidArgumentError for more than 20,000 chunks (fail-closed),
 * malformed chunks, or invalid options.
 * @complexity O(n) scoring + O(n) heapify + O(k log n) pops (worst O(n log n)); space O(n + k). No O(n^2)
 * similarity step.
 */
export function selectContext(
  chunks: ContextChunk[],
  budget: TokenBudget,
  options: { recentTurns?: number; minScore?: number } = {},
): { selected: ContextChunk[]; dropped: ContextChunk[]; estimated: number } {
  if (!Array.isArray(chunks)) {
    throw new InvalidArgumentError('chunks must be an array', { received: typeof chunks })
  }
  if (chunks.length > TokenPolicy.maxChunks) {
    throw new InvalidArgumentError(`chunks must contain at most ${TokenPolicy.maxChunks} entries`, {
      chunks: chunks.length,
    })
  }
  assertBudget(budget)
  if (!isRecord(options)) {
    throw new InvalidArgumentError('selection options must be an object', { received: typeof options })
  }
  const recentOption = options.recentTurns
  if (recentOption !== undefined && (!Number.isFinite(recentOption) || recentOption < 0)) {
    throw new InvalidArgumentError('recentTurns must be a finite non-negative number', { recentTurns: recentOption })
  }
  const minScoreOption = options.minScore
  if (minScoreOption !== undefined && !Number.isFinite(minScoreOption)) {
    throw new InvalidArgumentError('minScore must be a finite number', { minScore: minScoreOption })
  }
  const recentTurns = recentOption === undefined ? budget.recentTurns : Math.round(recentOption)
  const minScore = minScoreOption ?? 0

  // One validation + scoring pass. Every chunk is scored exactly once; the
  // heap then compares precomputed values, never calls valuePerToken again.
  const scored: ScoredChunk[] = new Array(chunks.length)
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    assertChunk(chunk)
    scored[index] = { index, chunk, value: valuePerToken(chunk) }
  }
  selectionStats.chunks = chunks.length
  selectionStats.scored = scored.length

  const capacity = selectionCapacity(budget)
  const mandatory = new Set<number>()
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index].pinned === true) mandatory.add(index)
  }
  let recentNeeded = recentTurns * 2
  for (let index = chunks.length - 1; index >= 0 && recentNeeded > 0; index -= 1) {
    const kind = chunks[index].kind
    if (kind !== 'user' && kind !== 'assistant') continue
    mandatory.add(index)
    recentNeeded -= 1
  }

  // Seed the duplicate set with the chunks that are never dropped, so a
  // candidate repeating a pinned fact cannot consume budget.
  const signatures = new Set<string>()
  let estimated = 0
  for (const index of mandatory) {
    signatures.add(dedupeSignature(chunks[index].text))
    estimated += chunks[index].tokens
  }

  /*
   * Candidates are ordered by the same total comparator the sort used:
   * value desc, created asc, id byte-asc, input index asc. The comparator is
   * total (the index tie-break is unique), so heapified pops are exactly the
   * sorted order. A zero-token candidate stays acceptable after the budget is
   * full, so it is counted here and the loop stops only when none remain.
   */
  const candidates: ScoredChunk[] = []
  let zeroTokenCandidates = 0
  for (const entry of scored) {
    if (mandatory.has(entry.index) || entry.chunk.score < minScore) continue
    candidates.push(entry)
    if (entry.chunk.tokens === 0) zeroTokenCandidates += 1
  }
  const priority = new BinaryHeap<ScoredChunk>(compareScored, candidates)

  const accepted: number[] = []
  for (;;) {
    // Every remaining candidate costs at least one token, so none can fit once
    // the budget is exhausted; zero-token candidates are the only exception.
    if (estimated >= capacity && zeroTokenCandidates === 0) break
    const entry = priority.pop()
    if (entry === undefined) break
    if (entry.chunk.tokens === 0) zeroTokenCandidates -= 1
    else if (estimated >= capacity) continue
    // A duplicate of a kept chunk adds nothing but cost (LLMLingua-2: drop
    // redundancy); a chunk that does not fit is skipped, not fatal, so a later
    // smaller chunk can still use the remaining budget.
    const signature = dedupeSignature(entry.chunk.text)
    if (signatures.has(signature)) continue
    if (estimated + entry.chunk.tokens > capacity) continue
    signatures.add(signature)
    accepted.push(entry.index)
    estimated += entry.chunk.tokens
  }
  selectionStats.dedupeKeys = signatures.size

  const kept = new Set<number>(mandatory)
  for (const index of accepted) kept.add(index)
  const selected: ContextChunk[] = []
  const dropped: ContextChunk[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    if (kept.has(index)) selected.push(chunks[index])
    else dropped.push(chunks[index])
  }
  selectionStats.selected = selected.length
  selectionStats.dropped = dropped.length
  return { selected, dropped, estimated }
}

/* ------------------------------------------------------------------------- *
 * Retrieval and compaction gates
 * ------------------------------------------------------------------------- */

/**
 * Decide whether a retrieval is worth its cost (v24 §12, §14).
 *
 * The Bayesian engine already reports the posterior entropy and `computeEIG`
 * (entropy x likelihood weight, in [0, 1] bits). Retrieval is useful only when
 * the belief is still uncertain *and* the expected gain clears the query's
 * price:
 *
 * ```text
 * retrieve  <=>  expectedInfoGain >= (costPerQuery / 1000) * 0.5
 *                 AND entropy >= 0.15
 *                 AND budgetTokens > 0
 * ```
 *
 * The 0.15-bit entropy floor is the "posterior is already confident" guard: a
 * binary belief at p>=0.9 has less than 0.47 bits, and below ~0.15 bits the
 * next observation almost never changes the decision. The cost scale says a
 * query must be expected to buy at least half of a normalised query unit; with
 * the default cost of 1000 the gate is a gain of at least 0.5 bits. Budget zero
 * skips retrieval fail-closed. All thresholds live in `TokenPolicy.retrieval`.
 *
 * @complexity O(1), no allocation.
 */
export function shouldRetrieve(input: {
  entropy: number
  expectedInfoGain: number
  budgetTokens: number
  costPerQuery?: number
}): boolean {
  if (!isRecord(input)) {
    throw new InvalidArgumentError('retrieval input must be an object', { received: typeof input })
  }
  const entropy = requireNonNegative(input.entropy, 'entropy')
  const expectedInfoGain = requireNonNegative(input.expectedInfoGain, 'expectedInfoGain')
  const budgetTokens = requireNonNegative(input.budgetTokens, 'budgetTokens')
  const costPerQuery =
    input.costPerQuery === undefined
      ? TokenPolicy.retrieval.defaultQueryCost
      : requireNonNegative(input.costPerQuery, 'costPerQuery')
  if (budgetTokens <= 0) return false
  const threshold = (costPerQuery / TokenPolicy.retrieval.costUnit) * TokenPolicy.retrieval.gainScale
  return expectedInfoGain >= threshold && entropy >= TokenPolicy.retrieval.entropyFloor
}

/**
 * Decide whether the context should be compacted.
 *
 * Two triggers, either sufficient:
 *
 * 1. the regular utilisation plan reports `soft-compact` or `hard-prune`; or
 * 2. the prompt is larger than 60% of the window and the prompt cache is cold
 *    (`cacheReadTokens == 0`). A cold cache after a huge prefix means the next
 *    request re-sends the whole context uncached, so shrinking it now pays even
 *    before the soft threshold — the prefix-cache economics of §5.1, where
 *    DeepSeek charges in 64-token blocks and a changed prefix loses them all.
 *
 * This function is intentionally a boolean wrapper over `planBudget`; callers
 * that need to explain the decision should use `planBudget`/`TokenPlan.reason`.
 *
 * @complexity O(1), no allocation.
 */
export function shouldCompact(usage: TokenUsageView, budget: TokenBudget): boolean {
  assertUsage(usage)
  assertBudget(budget)
  const inputTokens = requireNonNegative(usage.inputTokens, 'usage.inputTokens')
  const cacheRead = usage.cacheReadTokens === undefined ? 0 : requireNonNegative(usage.cacheReadTokens, 'usage.cacheReadTokens')
  if (planBudget(inputTokens, budget).decision !== 'none') return true
  return cacheRead === 0 && inputTokens > budget.contextWindow * TokenPolicy.coldCacheInputRatio
}

/**
 * Merge and validate a settings patch for the compaction policy.
 *
 * The settings page may change only the three user-facing thresholds; the
 * structural fields (`reserve`, `recentTurns`, `cooldown`, `maxPerSession`)
 * stay with the resolved deployment config. Type errors are rejected
 * (`InvalidArgumentError` for a non-object patch, a non-boolean `auto`, or a
 * non-finite/string `soft`/`hard`); numeric range problems are clamped, matching
 * the resolver: `soft` into [0.3, 0.9] and `hard` into `(soft, 0.98]`. Unknown
 * keys are ignored rather than persisted, so a stale client cannot widen the
 * policy.
 *
 * @complexity O(1), no allocation beyond the returned object.
 */
export function normaliseCompactionPatch(
  patch: unknown,
  current: CompactionPolicyConfig,
): { auto: boolean; soft: number; hard: number } {
  if (!isRecord(patch)) {
    throw new InvalidArgumentError('compaction patch must be an object', { received: typeof patch })
  }
  if (!isRecord(current)) {
    throw new InvalidArgumentError('current compaction policy must be an object', { received: typeof current })
  }
  if (typeof current.auto !== 'boolean' || !Number.isFinite(current.soft) || !Number.isFinite(current.hard)) {
    throw new InvalidArgumentError('current compaction policy is incomplete', {
      auto: typeof current.auto,
      soft: current.soft,
      hard: current.hard,
    })
  }

  let auto = current.auto
  if (patch.auto !== undefined) {
    if (typeof patch.auto !== 'boolean') {
      throw new InvalidArgumentError('compaction patch auto must be a boolean', { auto: typeof patch.auto })
    }
    auto = patch.auto
  }

  let soft = clamp(current.soft, 0.3, 0.9)
  if (patch.soft !== undefined) {
    if (typeof patch.soft !== 'number' || !Number.isFinite(patch.soft)) {
      throw new InvalidArgumentError('compaction patch soft must be a finite number', { soft: patch.soft })
    }
    soft = clamp(patch.soft, 0.3, 0.9)
  }

  let hard = clamp(current.hard, 0.3, 0.98)
  if (patch.hard !== undefined) {
    if (typeof patch.hard !== 'number' || !Number.isFinite(patch.hard)) {
      throw new InvalidArgumentError('compaction patch hard must be a finite number', { hard: patch.hard })
    }
    hard = patch.hard
  }
  hard = clamp(hard, soft + 0.01, 0.98)
  return { auto, soft: round(soft, 4), hard: round(hard, 4) }
}

/* ------------------------------------------------------------------------- *
 * Governor
 * ------------------------------------------------------------------------- */

/**
 * Stateful facade over the pure policy, for one coordination session.
 *
 * The governor reads the resolved `config.compaction` policy, owns the budget
 * derived from one model window, and keeps only O(1) counters: compaction count,
 * estimated saved tokens, last utilisation, and a one-entry plan cache. It
 * never persists anything and never mutates a chunk; the host adapter owns the
 * actual compaction call (`ctx.compaction.compactNow`) and the database audit.
 * The cooldown is the single wall-clock reading in this module (`Date.now()` at
 * `recordCompaction`/plan time); every other decision is a pure function of its
 * arguments, which keeps replay tests deterministic when no compaction has been
 * recorded.
 */
export class TokenGovernor {
  private readonly policy: CompactionPolicyConfig
  private readonly tokenBudget: TokenBudget
  private compactions = 0
  private savedTokens = 0
  private lastEstimate = 0
  private lastUtilization = 0
  private lastCompactionAt: number | undefined
  private cachedPlan:
    | {
        messages: ReadonlyArray<{ role: string; content: unknown }> | undefined
        shape: string
        usageKey: string
        plan: TokenPlan
      }
    | undefined

  /**
   * @param input.config the resolved coordination config; only `compaction` is read
   * @param input.contextWindow the model's window from DSH; 128k when absent
   * @complexity O(1)
   */
  constructor(input: { config: CoordinationConfig; contextWindow?: number }) {
    if (!isRecord(input)) {
      throw new InvalidArgumentError('governor input must be an object', { received: typeof input })
    }
    if (!isRecord(input.config)) {
      throw new InvalidArgumentError('governor input.config must be a resolved CoordinationConfig')
    }
    const requestedWindow = input.contextWindow
    if (
      requestedWindow !== undefined &&
      (typeof requestedWindow !== 'number' || !Number.isFinite(requestedWindow) || requestedWindow < 0)
    ) {
      throw new InvalidArgumentError('contextWindow must be a finite non-negative number', {
        contextWindow: requestedWindow,
      })
    }
    this.policy = normaliseCompactionPolicy(input.config.compaction)
    // `reserve` is a floor, never a ceiling: the documented "2048 or 8% of the
    // window, whichever larger" rule still applies, so a deployment that keeps
    // the schema default (2048) still reserves 8% on a 128k model instead of
    // silently leaving almost no output headroom.
    const window = clamp(
      Math.trunc(requestedWindow ?? TokenPolicy.defaultContextWindow),
      TokenPolicy.minContextWindow,
      TokenPolicy.maxContextWindow,
    )
    this.tokenBudget = budgetFor(window, {
      soft: this.policy.soft,
      hard: this.policy.hard,
      reserve: Math.max(this.policy.reserve, Math.round(window * TokenPolicy.reserveFraction)),
      recentTurns: this.policy.recentTurns,
    })
  }

  /**
   * Plan one turn's context.
   *
   * DSH's measured `usage.inputTokens` wins over the estimator when supplied.
   * The decision is additionally gated by the policy: `auto: false`, a spent
   * `maxPerSession` allowance, or the `cooldown` window all suppress an
   * automatic compaction (the reason says which). `dropCandidates` names
   * `message:<index>` entries outside the recent window; it is empty when no
   * compaction is proposed. Selection uses chunk ids — call `select` for those.
   *
   * The last plan is cached by message-array identity, or by the cheap
   * `(messageCount, totalChars)` shape key when a fresh array with the same
   * shape arrives. A shape hit reuses the estimate, so a host polling plan()
   * with the same conversation pays O(1) after the first call. The shape key is
   * advisory: reuse assumes callers treat messages as immutable, exactly like
   * the rest of this module.
   *
   * @complexity O(n) first call and on a shape miss; O(1) on an identity or
   * shape hit. Space O(n) only for the drop-candidate id list.
   */
  plan(messages: ReadonlyArray<{ role: string; content: unknown }>, usage?: TokenUsageView): TokenPlan {
    if (!Array.isArray(messages)) {
      throw new InvalidArgumentError('messages must be an array', { received: typeof messages })
    }
    if (usage !== undefined) assertUsage(usage)
    const usageKey =
      usage === undefined
        ? ''
        : `${usage.inputTokens}|${usage.outputTokens ?? ''}|${usage.cacheReadTokens ?? ''}`
    if (
      this.cachedPlan !== undefined &&
      this.cachedPlan.messages === messages &&
      this.cachedPlan.usageKey === usageKey
    ) {
      return this.cachedPlan.plan
    }
    const shape = messageShapeKey(messages)
    if (this.cachedPlan !== undefined && this.cachedPlan.shape === shape && this.cachedPlan.usageKey === usageKey) {
      return this.cachedPlan.plan
    }

    const estimated =
      usage === undefined ? estimateMessages(messages) : requireNonNegative(usage.inputTokens, 'usage.inputTokens')
    const base = planBudget(estimated, this.tokenBudget)
    const gate = this.gate(base.decision)
    const decision = gate.decision
    const keepRecent = this.tokenBudget.recentTurns
    const dropCandidates: string[] = []
    if (decision !== 'none') {
      const cutoff = Math.max(0, messages.length - keepRecent * 2)
      for (let index = 0; index < cutoff; index += 1) dropCandidates.push(`message:${index}`)
    }
    const plan: TokenPlan = {
      estimated,
      budget: this.tokenBudget,
      utilization: base.utilization,
      decision,
      reason: gate.reason ?? base.reason,
      keepRecent,
      dropCandidates,
    }
    this.lastEstimate = estimated
    this.lastUtilization = base.utilization
    this.cachedPlan = { messages, shape, usageKey, plan }
    return plan
  }

  /**
   * Select chunks with this governor's budget.
   *
   * @complexity identical to `selectContext`.
   */
  select(
    chunks: ContextChunk[],
    options: { recentTurns?: number; minScore?: number } = {},
  ): ReturnType<typeof selectContext> {
    return selectContext(chunks, this.tokenBudget, options)
  }

  /**
   * Retrieval gate; identical to `shouldRetrieve` with the same thresholds.
   *
   * @complexity O(1).
   */
  shouldRetrieve(input: Parameters<typeof shouldRetrieve>[0]): boolean {
    return shouldRetrieve(input)
  }

  /**
   * Record that the host performed a compaction.
   *
   * `savedTokens` grows by 40% of the last plan's estimate, a deliberately
   * conservative accounting of "old span replaced by a summary checkpoint"
   * (LLMLingua-2's 2x-5x is a compression ceiling, not a promise for a
   * summary). The cooldown is measured from this moment.
   *
   * @complexity O(1).
   */
  recordCompaction(): void {
    this.compactions += 1
    this.savedTokens += Math.round(this.lastEstimate * TokenPolicy.compactionSavingsRatio)
    this.lastCompactionAt = Date.now()
    // The cached plan was produced under the previous compaction count; drop it
    // so the next plan sees the spent allowance and the fresh cooldown.
    this.cachedPlan = undefined
  }

  /** Record DSH-reported usage and refresh the last utilisation. @complexity O(1). */
  recordUsage(usage: TokenUsageView): void {
    assertUsage(usage)
    const inputTokens = requireNonNegative(usage.inputTokens, 'usage.inputTokens')
    this.lastUtilization = planBudget(inputTokens, this.tokenBudget).utilization
    // Measured usage is the best available "last estimate" for the compaction
    // saving accounting, so record it even when the host never called plan().
    this.lastEstimate = inputTokens
  }

  /**
   * O(1) session statistics. `lastUtilization` is the last plan/usage ratio
   * against the effective window, rounded to four decimals; `savedTokens` is an
   * estimate, never a provider measurement.
   *
   * @complexity O(1), no allocation beyond the result.
   */
  stats(): { compactions: number; savedTokens: number; lastUtilization: number } {
    return {
      compactions: this.compactions,
      savedTokens: this.savedTokens,
      lastUtilization: round(this.lastUtilization, 4),
    }
  }

  /**
   * Apply the policy gates to a utilisation decision. The reason explains a
   * suppressed decision so the host never has to guess why nothing happened.
   */
  private gate(decision: TokenPlan['decision']): { decision: TokenPlan['decision']; reason?: string } {
    if (decision === 'none') return { decision }
    if (!this.policy.auto) {
      return {
        decision: 'none',
        reason: `automatic compaction is disabled by config.compaction.auto (utilisation decision was ${decision})`,
      }
    }
    if (this.compactions >= this.policy.maxPerSession) {
      return {
        decision: 'none',
        reason:
          `config.compaction.maxPerSession ${this.policy.maxPerSession} is spent ` +
          `(${this.compactions} compactions recorded; utilisation decision was ${decision})`,
      }
    }
    if (this.lastCompactionAt !== undefined && Date.now() - this.lastCompactionAt < this.policy.cooldown) {
      return {
        decision: 'none',
        reason:
          `config.compaction.cooldown ${this.policy.cooldown}ms has not elapsed since the last compaction ` +
          `(utilisation decision was ${decision})`,
      }
    }
    return { decision }
  }
}

/* ------------------------------------------------------------------------- *
 * Diagnostics (observability, never policy)
 * ------------------------------------------------------------------------- */

/**
 * Read-only counters for tests and observability. Nothing in this object
 * changes a decision; production code should not depend on the values.
 */
export interface TokenDiagnostics {
  readonly memoEntries: number
  readonly memoHits: number
  readonly memoMisses: number
  readonly lastSelect: {
    readonly chunks: number
    readonly scored: number
    readonly dedupeKeys: number
    readonly selected: number
    readonly dropped: number
  }
  reset(): void
}

const selectionStats = { chunks: 0, scored: 0, dedupeKeys: 0, selected: 0, dropped: 0 }

/** Live diagnostics for the pure functions above. @complexity O(1) per read. */
export const tokenDiagnostics: TokenDiagnostics = {
  get memoEntries(): number {
    return memo.size
  },
  get memoHits(): number {
    return memoHits
  },
  get memoMisses(): number {
    return memoMisses
  },
  get lastSelect(): TokenDiagnostics['lastSelect'] {
    return { ...selectionStats }
  },
  reset(): void {
    memo.clear()
    memoHits = 0
    memoMisses = 0
    selectionStats.chunks = 0
    selectionStats.scored = 0
    selectionStats.dedupeKeys = 0
    selectionStats.selected = 0
    selectionStats.dropped = 0
  },
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

interface ScoredChunk {
  index: number
  chunk: ContextChunk
  value: number
}

interface ContentScan {
  chars: number
  blocks: number
  tokens: number
  truncated: boolean
}

interface MemoEntry {
  length: number
  head: string
  middle: string
  tail: string
  value: number
}

interface MemoSample {
  key: string
  head: string
  middle: string
  tail: string
}

const ShortTextLimit = 256
/*
 * The canonical array-backed LRU, not a second Map+eviction implementation.
 * `get` promotes on a hit and `set` evicts the least-recently used entry at
 * 256, which is exactly the policy this memo documented before.
 */
const memo = new LruList<string, MemoEntry>(TokenPolicy.estimator.memoCapacity)
let memoHits = 0
let memoMisses = 0

const TextFields = ['text', 'reasoning', 'reasoning_content', 'thinking'] as const
const ContainerFields = ['content', 'input', 'arguments', 'parts', 'tool_calls'] as const

/** Fractional tokens of one string; `estimateTokens` rounds the public result. */
function scanTokenCount(text: string): number {
  const length = text.length
  let cjk = 0
  let words = 0
  let wordLength = 0
  let longWordExtra = 0
  let other = 0
  let emoji = 0

  const flushWord = (): void => {
    if (wordLength === 0) return
    words += 1
    if (wordLength > TokenPolicy.estimator.longWord) {
      longWordExtra += wordLength - TokenPolicy.estimator.longWord
    }
    wordLength = 0
  }

  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      if (isAsciiWord(code)) {
        wordLength += 1
        continue
      }
      flushWord()
      if (isAsciiSpace(code)) continue
      other += 1
      continue
    }
    flushWord()
    let codePoint = code
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000
        index += 1
      }
    }
    if (isCjk(codePoint)) cjk += 1
    else if (codePoint >= 0x1f000 && codePoint <= 0x1faff) emoji += 1
    else other += 1
  }
  flushWord()

  return (
    cjk * TokenPolicy.estimator.cjk +
    words * TokenPolicy.estimator.word +
    longWordExtra * TokenPolicy.estimator.wordExtra +
    other * TokenPolicy.estimator.other +
    emoji * TokenPolicy.estimator.emoji
  )
}

function scanContent(content: unknown, depth: number, scan: ContentScan): void {
  if (scan.truncated) return
  if (typeof content === 'string') {
    addText(content, scan)
    return
  }
  if (content === null || content === undefined) return
  if (typeof content !== 'object') return
  if (depth >= TokenPolicy.maxContentDepth) return
  if (Array.isArray(content)) {
    for (let index = 0; index < content.length; index += 1) {
      scan.blocks += 1
      if (scan.blocks >= TokenPolicy.maxBlocksPerMessage) {
        scan.truncated = true
        return
      }
      scanContent(content[index], depth + 1, scan)
      if (scan.truncated) return
    }
    return
  }
  const record = content as Record<string, unknown>
  for (const field of TextFields) {
    const value = record[field]
    if (typeof value === 'string') addText(value, scan)
  }
  for (const field of ContainerFields) {
    if (!(field in record)) continue
    scan.blocks += 1
    if (scan.blocks >= TokenPolicy.maxBlocksPerMessage) {
      scan.truncated = true
      return
    }
    scanContent(record[field], depth + 1, scan)
    if (scan.truncated) return
  }
}

function addText(text: string, scan: ContentScan): void {
  if (text.length === 0) return
  const remaining = TokenPolicy.maxCharsPerMessage - scan.chars
  if (remaining <= 0) {
    scan.truncated = true
    return
  }
  if (text.length > remaining) {
    scan.tokens += scanTokenCount(text.slice(0, remaining))
    scan.chars = TokenPolicy.maxCharsPerMessage
    scan.truncated = true
    return
  }
  scan.chars += text.length
  scan.tokens += scanTokenCount(text)
}

function memoKey(text: string): MemoSample {
  const length = text.length
  if (length <= ShortTextLimit) {
    return { key: `s${length}:${text}`, head: text, middle: '', tail: '' }
  }
  const head = text.slice(0, 64)
  const middleStart = (length >>> 1) - 16
  const middle = text.slice(middleStart, middleStart + 32)
  const tail = text.slice(length - 32)
  const key = `l${length}:${hashKey(head)}:${hashKey(middle)}:${hashKey(tail)}`
  return { key, head, middle, tail }
}

function sampleMatches(entry: MemoEntry, length: number, sample: MemoSample): boolean {
  return (
    entry.length === length && entry.head === sample.head && entry.middle === sample.middle && entry.tail === sample.tail
  )
}

function remember(sample: MemoSample, length: number, value: number): void {
  // `set` replaces a collided key in place and evicts the least-recently used
  // entry when the 256-entry capacity is exceeded.
  memo.set(sample.key, { length, head: sample.head, middle: sample.middle, tail: sample.tail, value })
}

/** FNV-1a, 32-bit, rendered base 36. The shared hash is the same function. */
function hashKey(text: string): string {
  return hashString(text).toString(36)
}

/**
 * Near-duplicate signature: normalise (lowercase, non-alphanumeric -> space,
 * collapse), take the 80% prefix capped at 512 characters, hash it twice
 * (FNV-1a with two offset bases) and append a quarter-octave length bucket.
 * Equal signatures mean "same normalised opening, comparable length" — the
 * O(n) approximation of an 80% overlap test. No pairwise comparison.
 */
function dedupeSignature(text: string): string {
  const normalised = normaliseForDedupe(text)
  const length = normalised.length
  if (length === 0) return '0:0:0:0'
  const prefixLength = Math.min(length, Math.max(8, Math.ceil(length * 0.8)), 512)
  const prefix = normalised.slice(0, prefixLength)
  return `${Math.floor(Math.log2(length) * 4)}:${hashKey(prefix)}:${hashKey(`2:${prefix}`)}`
}

/** Lowercase alphanumerics and CJK, everything else folded to one space. */
function normaliseForDedupe(text: string): string {
  let result = ''
  let pendingSpace = false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      const lower = code >= 65 && code <= 90 ? code + 32 : code
      if ((lower >= 48 && lower <= 57) || (lower >= 97 && lower <= 122)) {
        if (pendingSpace && result.length > 0) result += ' '
        pendingSpace = false
        result += String.fromCharCode(lower)
      } else {
        pendingSpace = true
      }
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        if (pendingSpace && result.length > 0) result += ' '
        pendingSpace = false
        result += text.slice(index, index + 2)
        index += 1
        continue
      }
    }
    if (isCjk(code)) {
      if (pendingSpace && result.length > 0) result += ' '
      pendingSpace = false
      result += String.fromCharCode(code)
    } else {
      pendingSpace = true
    }
  }
  return result
}

function selectionCapacity(budget: TokenBudget): number {
  const effective = budget.contextWindow - budget.reserve
  if (!(effective > 0)) return 0
  return Math.max(0, Math.floor(effective * budget.hard * TokenPolicy.selectionFillRatio))
}

function compareScored(left: ScoredChunk, right: ScoredChunk): number {
  if (left.value !== right.value) return right.value - left.value
  const leftCreated = left.chunk.created ?? 0
  const rightCreated = right.chunk.created ?? 0
  if (leftCreated !== rightCreated) return leftCreated - rightCreated
  if (left.chunk.id === right.chunk.id) return left.index - right.index
  return left.chunk.id < right.chunk.id ? -1 : 1
}

/** Shape key for the governor's one-entry plan cache: (messageCount, totalChars). */
function messageShapeKey(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  let chars = 0
  for (const message of messages) {
    const content = message.content
    if (typeof content === 'string') chars += content.length
    else if (Array.isArray(content)) {
      chars += content.length
      for (const block of content) {
        if (typeof block === 'string') chars += block.length
        else if (isRecord(block) && typeof block.text === 'string') chars += block.text.length
      }
    } else if (isRecord(content) && typeof content.text === 'string') {
      chars += content.text.length
    }
  }
  return `${messages.length}:${chars}`
}

/**
 * Resolve a possibly absent/partial compaction group into the full policy.
 * The schema always materialises it; this keeps fixtures and older hosts
 * working without weakening the public `CoordinationConfig` type. Values are
 * clamped exactly like `resolveCompaction` in `config.ts`, which this module
 * cannot import at runtime without pulling in Schemastery.
 */
function normaliseCompactionPolicy(input: Partial<CompactionPolicyConfig> | undefined): CompactionPolicyConfig {
  const source: Partial<CompactionPolicyConfig> = isRecord(input) ? input : {}
  const soft = clamp(finiteOr(source.soft, TokenPolicy.soft), 0.3, 0.9)
  return {
    auto: source.auto !== false,
    soft,
    hard: clamp(finiteOr(source.hard, TokenPolicy.hard), soft + 0.01, 0.98),
    reserve: Math.max(512, Math.round(finiteOr(source.reserve, TokenPolicy.reserveTokens))),
    recentTurns: clamp(
      Math.round(finiteOr(source.recentTurns, TokenPolicy.recentTurns)),
      TokenPolicy.minRecentTurns,
      TokenPolicy.maxRecentTurns,
    ),
    cooldown: Math.max(5000, Math.round(finiteOr(source.cooldown, 30000))),
    maxPerSession: Math.max(1, Math.floor(finiteOr(source.maxPerSession, 20))),
  }
}

function assertBudget(budget: TokenBudget): void {
  if (!isRecord(budget)) {
    throw new InvalidArgumentError('budget must be an object', { received: typeof budget })
  }
  requireNonNegative(budget.contextWindow, 'budget.contextWindow')
  requireNonNegative(budget.reserve, 'budget.reserve')
  requireNonNegative(budget.soft, 'budget.soft')
  requireNonNegative(budget.hard, 'budget.hard')
  requireNonNegative(budget.recentTurns, 'budget.recentTurns')
}

function assertChunk(chunk: ContextChunk): void {
  if (!isRecord(chunk)) {
    throw new InvalidArgumentError('chunk must be an object', { received: typeof chunk })
  }
  if (typeof chunk.id !== 'string' || chunk.id.length === 0) {
    throw new InvalidArgumentError('chunk.id must be a non-empty string', { id: chunk.id })
  }
  if (typeof chunk.text !== 'string') {
    throw new InvalidArgumentError(`chunk ${chunk.id} text must be a string`, { id: chunk.id })
  }
  if (!Object.prototype.hasOwnProperty.call(KindWeight, chunk.kind)) {
    throw new InvalidArgumentError(`chunk ${chunk.id} has an unknown kind`, { id: chunk.id, kind: chunk.kind })
  }
  requireNonNegative(chunk.tokens, `chunk ${chunk.id} tokens`)
  requireNonNegative(chunk.score, `chunk ${chunk.id} score`)
  if (chunk.pinned !== undefined && typeof chunk.pinned !== 'boolean') {
    throw new InvalidArgumentError(`chunk ${chunk.id} pinned must be a boolean`, { id: chunk.id })
  }
  if (chunk.created !== undefined && !Number.isFinite(chunk.created)) {
    throw new InvalidArgumentError(`chunk ${chunk.id} created must be a finite number`, { id: chunk.id })
  }
}

function assertUsage(usage: TokenUsageView): void {
  if (!isRecord(usage)) {
    throw new InvalidArgumentError('usage must be an object', { received: typeof usage })
  }
  requireNonNegative(usage.inputTokens, 'usage.inputTokens')
  if (usage.outputTokens !== undefined) requireNonNegative(usage.outputTokens, 'usage.outputTokens')
  if (usage.cacheReadTokens !== undefined) requireNonNegative(usage.cacheReadTokens, 'usage.cacheReadTokens')
}

function optionalNonNegative(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InvalidArgumentError(`${field} must be a finite non-negative number`, { [field]: value })
  }
  return value
}

function requireNonNegative(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InvalidArgumentError(`${field} must be a finite non-negative number`, { [field]: value })
  }
  return value
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAsciiWord(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

function isAsciiSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ffff)
  )
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
