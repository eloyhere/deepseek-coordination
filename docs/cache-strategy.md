# Cache strategy for `deepseek-coordination`

A per-brand / per-model / per-agent table of prompt-cache behaviour, plus the
research it is built on. The table lives in
[`src/host/cache-strategy.ts`](../src/host/cache-strategy.ts) as data; the lookup
function and the audit tests are in
[`test/cache-strategy.test.ts`](../test/cache-strategy.test.ts).

**Status:** wired into the proxy. `presetFor()` is resolved once per upstream
route in [`src/host/proxy-service.ts`](../src/host/proxy-service.ts), where the
row's `volatileStrippingHelps` and `mode` gate normalization and the full row is
reported as `cacheStrategy` in `GET /proxy/status`. The coarser
[`src/host/model-brand.ts`](../src/host/model-brand.ts) profile derives its one
effort field (`effortBreaksCache`) from this table instead of asserting a
boolean.

---

## 1. Method

- **Retrieval window:** 2026-10-18, from this machine, over the public network
  (`Invoke-WebRequest`, `curl.exe`), with a desktop browser user agent.
- **Only fetched text is quoted.** Every claim in the source table is copied from
  a page that was actually retrieved in that window. Where an origin blocked the
  request, the row says `UNFETCHED` and carries no claim; the preset that cites
  it is flagged as assumed in §5.
- **Papers** were read as arXiv abstract pages (the abstract carries the claim;
  no full-text paraphrase is used).
- **Vendor pages** were converted to text locally before being searched, so the
  claims are the pages' own sentences, including the two Chinese pages where the
  original sentence and a marked translation are both recorded.
- **Geoblocking is a real constraint here.** `platform.claude.com` (Anthropic
  docs), `platform.openai.com`, `openai.com`, `ai.google.dev` and `docs.x.ai`
  are unreachable from this network. `docs.aws.amazon.com`,
  `learn.microsoft.com`, `platform.moonshot.cn`, `help.aliyun.com`,
  `docs.bigmodel.cn`, `docs.vllm.ai` and `aider.chat` are reachable, and are used
  as first-party documentation of the same features where the primary page is
  blocked (marked in the table).

### Retrieval scoreboard

| Outcome | Count | Pages |
| --- | ---: | --- |
| Fetched, claim used | 14 | 5 arXiv papers, DeepSeek, Azure OpenAI, AWS Bedrock, Anthropic news, vLLM, Moonshot, Alibaba, Zhipu, Aider |
| Fetched, no caching claim used | 3 | DeepSeek thinking-mode guide, Anthropic "Claude Code best practices", Cursor blog index |
| Failed (blocked or timeout) | 5 | OpenAI docs, OpenAI blog, Anthropic docs, Gemini docs, xAI docs |

`CACHE_SOURCES` has 18 rows: 14 fetched claims + 4 explicit `UNFETCHED` rows.
`CACHE_PRESETS` has 18 rows: 10 brand rows, 5 model rows, 3 agent rows.

---

## 2. Sources

Ids are the `sourceIds` used by the presets. Status `fetched` means the claim was
taken from the page in this session; `unfetched` means the origin refused or timed
out and **no claim was used**.

| id | Source | Year | URL | Claim used (≤ 25 words) | Status |
| --- | --- | ---: | --- | --- | --- |
| `prompt-cache-paper` | Gim et al., *Prompt Cache: Modular Attention Reuse for Low-Latency Inference* (MLSys 2024) | 2024 | https://arxiv.org/abs/2311.04934 | "by precomputing and storing the attention states of these frequently occurring text segments" | fetched |
| `pagedattention-paper` | Kwon et al., *Efficient Memory Management for LLM Serving with PagedAttention* (SOSP 2023) | 2023 | https://arxiv.org/abs/2309.06180 | "flexible sharing of KV cache within and across requests to further reduce memory usage" | fetched |
| `sglang-radix-paper` | Zheng et al., *SGLang: Efficient Execution of Structured Language Model Programs* | 2023 | https://arxiv.org/abs/2312.07104 | "novel optimizations like RadixAttention for KV cache reuse" | fetched |
| `vllm-apc-docs` | vLLM docs, *Automatic Prefix Caching* | 2026 | https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/ | "a new query can directly reuse the KV cache if it shares the same prefix" | fetched |
| `deepseek-context-caching` | DeepSeek API docs, *Context Caching* | 2026 | https://api-docs.deepseek.com/guides/kv_cache | "If subsequent requests have overlapping prefixes with previous requests, the overlapping part will only be fetched from the cache" | fetched |
| `azure-openai-prompt-caching` | Microsoft Learn, *Prompt caching with Azure OpenAI* | 2026 | https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/prompt-caching | "set the prompt_cache_key parameter and reuse the same key for requests that share long, common prompt prefixes" | fetched |
| `aws-bedrock-prompt-caching` | AWS docs, *Prompt caching for faster model inference* | 2026 | https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html | "changing content in an earlier section invalidates the cache for later sections" | fetched |
| `anthropic-news-prompt-caching` | Anthropic, *Prompt caching with Claude* | 2025 | https://www.anthropic.com/news/prompt-caching | "Writing to the cache costs 25% more than our base input token price" | fetched |
| `aider-prompt-caching` | Aider docs, *Prompt caching* | 2026 | https://aider.chat/docs/usage/caching.html | "By default, Anthropic keeps your cache for 5 minutes." | fetched |
| `moonshot-context-caching` | Moonshot AI, *上下文缓存最佳实践* | 2026 | https://platform.moonshot.cn/docs/guide/context-caching | "缓存按请求前缀匹配。前缀中任何一处发生变化，该位置之后的内容都无法复用。（译：any prefix change invalidates what follows）" | fetched |
| `qwen-context-cache` | Alibaba Cloud Model Studio, *上下文缓存（Context Cache）* | 2026 | https://help.aliyun.com/zh/model-studio/context-cache | "缓存块的内容最少为 1024 Token。（译：a cache block holds at least 1024 tokens）" | fetched |
| `zhipu-context-cache` | Zhipu AI, *上下文缓存* | 2026 | https://docs.bigmodel.cn/cn/guide/capabilities/cache | "重复的前缀内容必须足够长（建议 500 Token 以上）（译：the repeated prefix must be long; 500+ tokens recommended）" | fetched |
| `lost-in-the-middle` | Liu et al., *Lost in the Middle: How Language Models Use Long Contexts* (TACL 2023) | 2023 | https://arxiv.org/abs/2307.03172 | "performance is often highest when relevant information occurs at the beginning or end of the input context" | fetched |
| `llmlingua-paper` | Jiang et al., *LLMLingua: Compressing Prompts for Accelerated Inference of LLMs* (EMNLP 2023) | 2023 | https://arxiv.org/abs/2310.05736 | "allows for up to 20x compression with little performance loss" | fetched |
| `openai-prompt-caching-docs` | OpenAI docs, *Prompt caching* | 2026 | https://platform.openai.com/docs/guides/prompt-caching | — | **unfetched** (HTTP 403, Cloudflare block) |
| `anthropic-prompt-caching-docs` | Anthropic docs, *Prompt caching* | 2026 | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | — | **unfetched** (307 → `app-unavailable-in-region`) |
| `gemini-context-caching-docs` | Google, *Context caching* | 2026 | https://ai.google.dev/gemini-api/docs/caching | — | **unfetched** (connection timeout) |
| `xai-prompt-caching-docs` | xAI, *Caching (Grok API)* | 2026 | https://docs.x.ai/docs/guides/caching | — | **unfetched** (connection timeout) |

Two pages were fetched but are not cited as cache evidence:

- **Anthropic, "Claude Code best practices"** (https://www.anthropic.com/engineering/claude-code-best-practices)
  — fetched; contains **no statement about prompt caching or prefix stability**,
  so no claim is attributed to it.
- **Cursor blog index** (https://cursor.com/blog) — fetched; the index contains
  no post mentioning caching, prefixes or KV reuse, so no Cursor claim is made.

### Facts taken from the fetched pages

Each of these is stated by the cited page; none of them is extrapolated.

- **DeepSeek** — caching is on by default; overlapping prefixes are served from a
  disk cache; a hit requires a full match of a persisted cache-prefix unit; hits
  are reported as `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; the
  cache is best effort and cleared after hours to days. No minimum prefix and no
  fixed TTL are documented.
- **AWS Bedrock (Anthropic models)** — cache checkpoints are processed in the
  order tools → system → messages and are cumulative; changing an earlier section
  invalidates later ones; Claude models support up to 4 checkpoints; newer models
  offer a 5-minute or 1-hour TTL, while 3.5/3.7 Sonnet list 5 minutes only; the
  per-model minimums in the fetched table are 512 (Claude Opus 5, Fable 5,
  Mythos 5), 1,024 (Sonnet 5, Sonnet 4.6/4.5, Opus 4.8, 3.7/3.5 Sonnet) and
  4,096 (Opus 4.5–4.7, Haiku 4.5); the simplified cache-management lookback is
  about 20 content blocks; cache hits are not deducted from the rate limit.
- **Anthropic (announcement)** — cache writes cost 25 % more than base input,
  cache reads 10 %; up to 90 % cost and 85 % latency reduction on long prompts.
- **Azure OpenAI** — `prompt_cache_key` groups requests that share long prefixes;
  GPT-5.6+ supports explicit breakpoints and `prompt_cache_options.mode`
  (`implicit`/`explicit`); the TTL value is `30m`, the default and only supported
  value; cache writes can be billed on GPT-5.6 and later.
- **AWS Bedrock (OpenAI models)** — GPT-5.6+ supports explicit breakpoints, GPT-5.5
  and earlier are automatic; minimum 1,024 tokens and 30-minute TTL on the fetched
  table rows.
- **vLLM** — APC reuses the KV cache of an existing query when a new query shares
  the same prefix; it only speeds up prefill, not decode; cache keys are computed
  at a configurable granularity (`--prefix-match-unit`).
- **Moonshot** — matching is by request prefix; any change invalidates everything
  after it; stable content (system prompt, tool definitions, references) belongs
  in front; a 5-minute TTL is the default and 1-hour is opt-in via
  `prompt_cache_options`; TTL is locked at first write; caches are org-isolated;
  hits are billed at ~1/10 of misses; storage is block-based, so a partial block
  is a miss.
- **Alibaba/Qwen** — two modes: explicit (`cache_control`, up to 4 markers,
  1,024-token minimum, 125 % write / 10 % read, 5-minute TTL reset on hit) and
  implicit (automatic, 1,024-token minimum, 20 % price, uncertain hit rate); the
  two modes are mutually exclusive per request.
- **Zhipu** — implicit only; the repeated prefix must be long enough, with 500+
  tokens recommended; hits reported in `prompt_tokens_details.cached_tokens`;
  stable material before the changing question.
- **Aider** — caches the system prompt, read-only files, the repository map and
  editable files in that order; keeps Anthropic's 5-minute cache warm with
  `--cache-keepalive-pings`.

---

## 3. Preset matrix

`mode` is how the provider decides reuse; `min` is `minPrefixTokens`; `ttl` is
`ttlSeconds`; `strip` is `volatileStrippingHelps`; `compact` is
`compactionPolicy`.

`effort` (`effortBreaksPrefix`) is **tri-state**:

| value | meaning | paired `effortEvidence` |
| --- | --- | --- |
| `true` / `false` | a fetched vendor source states that changing reasoning effort does or does not change the cache key | `'documented'` |
| `'unknown'` | no fetched source states it; the behaviour is an open question | `'assumed'` |

Every row in the table is `'unknown'` with `effortEvidence: 'assumed'` — see §5
for why that is an evidence gap, not a finding. `'unknown'` must never be read as
`false`: an undocumented `false` would be the same unfounded claim as an
undocumented `true`, just in the other direction. `model-brand.ts` mirrors this
tri-state and derives its field from the row, so a future fetched source only has
to change `cache-strategy.ts`.

### Brand rows

| id | mode | min | ttl | effort | strip | compact | Primary evidence |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| `deepseek/automatic` | automatic-prefix | 64 | — | 'unknown' | true | avoid-mid-prefix | DeepSeek docs + Prompt Cache |
| `openai/automatic` | hybrid | 1024 | — | 'unknown' | true | avoid-mid-prefix | Azure OpenAI + AWS Bedrock |
| `anthropic/breakpoints` | explicit-breakpoints | 1024 | 300 | 'unknown' | false | avoid-mid-prefix | Anthropic announcement + AWS + Aider |
| `google/hybrid` | hybrid | 1024 | — | 'unknown' | true | unknown | Gemini docs **unfetched**; AWS implicit-caching semantics |
| `xai/automatic` | automatic-prefix | 1024 | — | 'unknown' | true | unknown | xAI docs **unfetched** |
| `moonshot/automatic` | automatic-prefix | 1024 | 300 | 'unknown' | true | avoid-mid-prefix | Moonshot docs |
| `qwen/hybrid` | hybrid | 1024 | 300 | 'unknown' | true | avoid-mid-prefix | Alibaba docs |
| `zhipu/automatic` | automatic-prefix | 500 | — | 'unknown' | true | avoid-mid-prefix | Zhipu docs |
| `meta/self-hosted` | automatic-prefix | 1024 | — | 'unknown' | true | avoid-mid-prefix | vLLM APC + SGLang + PagedAttention |
| `unknown/conservative` | unknown | 1024 | — | 'unknown' | false | unknown | vLLM APC + Prompt Cache |

### Model rows (override the brand row)

| id | model patterns | mode | min | ttl | Why it differs |
| --- | --- | --- | ---: | ---: | --- |
| `anthropic/claude-5-family` | `claude-opus-5*`, `claude-fable-5*`, `claude-mythos-5*` | explicit-breakpoints | 512 | 300 | AWS table lists a 512-token minimum |
| `anthropic/claude-sonnet-5` | `claude-sonnet-5*` | explicit-breakpoints | 1024 | 300 | Sonnet 5 is listed at 1,024, unlike its Opus/Fable/Mythos siblings |
| `anthropic/claude-high-minimum` | `claude-opus-4-7*`, `claude-opus-4-6*`, `claude-opus-4-5*`, `claude-haiku-4-5*` | explicit-breakpoints | 4096 | 300 | AWS table lists a 4,096-token minimum |
| `anthropic/claude-4-x` | `claude-opus-4-8*`, `claude-sonnet-4-6*`, `claude-sonnet-4-5*`, `claude-3-7-sonnet*`, `claude-3-5-sonnet*` | explicit-breakpoints | 1024 | 300 | AWS table lists a 1,024-token minimum |
| `openai/gpt-5-6` | `gpt-5-6*`, `gpt-6*` | hybrid | 1024 | 1800 | GPT-5.6+ has explicit breakpoints, a 30-minute TTL and billed writes |

### Agent rows (highest precedence)

| id | agents | models | mode | min | ttl | Tuning |
| --- | --- | --- | --- | ---: | ---: | --- |
| `deepseek/dsh-agent` | `dsh`, `deepseek-harness` | `deepseek-*` | automatic-prefix | 64 | — | tool schemas fixed for the whole session |
| `anthropic/claude-code-agent` | `claude-code`, `claude` | `claude-*` | explicit-breakpoints | 1024 | 300 | append file reads, output after the last breakpoint |
| `openai/codex-agent` | `codex` | `gpt-*` | hybrid | 1024 | 1800 | repository instructions first, one `prompt_cache_key` per workspace |

### Lookup order

`presetFor({ brand, model, agent })` is deterministic and never throws:

1. **agent + model** row that matches both (rank 3);
2. **model** row that matches the model (rank 2);
3. **agent** row that matches the agent (rank 1 — supported by the shape, unused
   by the built-in rows);
4. **brand** row for the normalised brand (rank 0);
5. `unknown/conservative`.

Matching normalises case, treats `.` and `_` as `-`, accepts a trailing `*` as a
prefix wildcard, and also tries the segment after the last `/` or `:` (so
`anthropic/claude-opus-4-7` and `claude-sonnet-4.5` both resolve). Model patterns
deliberately outrank the brand: a reseller route can report a generic brand while
the model id still names the real family.

The table does not infer a brand from a bare model id. A caller that omits
`brand` and hits no model row gets `unknown/conservative` (for example
`presetFor({ model: 'glm-5.3' })`); pass the classified brand when one is known.

---

## 4. Compaction vs cache

The two goals conflict, and the fetched sources explain why:

- **Compaction changes bytes in the middle of the prefix.** Moonshot states that
  any prefix change invalidates everything after it; AWS states that changing an
  earlier section invalidates later sections. A compaction that rewrites the
  middle of a cached prefix therefore throws away the cache it was meant to save.
- **Dropping context is not free either.** *Lost in the Middle* finds performance
  peaks when relevant information is at the beginning or end and degrades in the
  middle — so "just keep the recent turns" can move the needed evidence into the
  worst position.
- **Compression is a real lever, but a separate one.** LLMLingua reports up to
  20× compression with little performance loss. That is a compression result, not
  a caching result: a compressed prefix must still be byte-stable to be reused.

Policy encoded in the table: every provider whose reuse is prefix-based gets
`compactionPolicy: 'avoid-mid-prefix'`; the two rows whose docs could not be
fetched (Google, xAI) and the unknown row get `'unknown'`. No row claims `'safe'`,
because no fetched source documents a compaction that preserves cache hits.

---

## 5. Measured vs assumed

Nothing in this table is a measurement of this machine or this account. The
column below says what each kind of value rests on.

| Value | Basis | Confidence |
| --- | --- | --- |
| Qwen 1,024 minimum, 5-min TTL | stated on the Alibaba page | documented |
| Zhipu 500 minimum | stated as a *recommendation*, not a hard floor | documented recommendation |
| Moonshot 5-min default TTL, 1-hour option, block storage | stated on the Moonshot page | documented |
| Anthropic 512 / 1,024 / 4,096 minimums, 4 checkpoints, 5-min/1-hour TTL | AWS Bedrock model table for Claude models | documented for Bedrock; first-party page unfetched |
| Anthropic 25 % write / 10 % read pricing | Anthropic announcement | documented |
| OpenAI 1,024 minimum, 30-min TTL, `prompt_cache_key`, breakpoints | 1,024 and 30 min from the AWS Bedrock table; key/breakpoints from Azure OpenAI | documented for Bedrock/Azure; OpenAI page unfetched |
| DeepSeek automatic prefix cache, hit/miss accounting | DeepSeek page | documented |
| DeepSeek 64-token minimum | **no minimum is documented**; 64 is a conservative local choice | assumed |
| Moonshot 1,024 minimum | page says block-based but gives no number | assumed |
| Google mode, 1,024 minimum, no TTL | page unreachable | assumed |
| xAI automatic prefix cache, 1,024 minimum | page unreachable | assumed |
| Meta 1,024 minimum | deployment-dependent (vLLM/SGLang block size) | assumed |
| `effortBreaksPrefix: 'unknown'` on every row (`effortEvidence: 'assumed'`) | no fetched page says effort changes the cache key | **unverified** |
| `volatileStrippingHelps` | derived from "prefix must be byte-identical", not a vendor statement | derived policy |
| `compactionPolicy: 'avoid-mid-prefix'` | derived from the prefix-invalidation statements | derived policy |

Open questions the table cannot answer yet:

1. Does changing `reasoning_effort` / thinking mode reset a cache on any family?
   No fetched page says so. The table therefore records `'unknown'` with
   `effortEvidence: 'assumed'` on every row, and `model-brand.ts` derives its
   tri-state `effortBreaksCache` from the same row instead of asserting a
   boolean. A future fetched source can replace one row with `true`/`false` and
   `effortEvidence: 'documented'`, and the profile follows automatically.
2. What is DeepSeek's real minimum prefix? Its docs describe cache-prefix units
   and fixed-interval persistence but publish no floor.
3. Does Moonshot round prefixes to fixed-size blocks, and at what size? The page
   only says a partial block cannot be cached.
4. Google's implicit-cache minimum and TTL, and whether explicit cached content
   is billed separately — unreachable.
5. xAI's mode, minimum and TTL — unreachable.

---

## 6. How to verify on this machine

The proxy exposes a **body-free** status snapshot; it reports routing and
counters, never prompt text.

```powershell
curl.exe -sS "http://127.0.0.1:61759/deepseek-coordination/proxy/status"
```

Expected shape (fields and their meaning in
[`src/host/proxy-service.ts`](../src/host/proxy-service.ts)):

```json
{
  "ok": true,
  "value": {
    "available": true,
    "enabled": true,
    "provider": "coordination-proxy",
    "mode": "measure",
    "upstream": { "provider": "<real provider>", "model": "<id>" },
    "model": {
      "brand": "deepseek",
      "label": "DeepSeek",
      "automaticPrefixCache": true,
      "explicitCacheBreakpoints": false,
      "minPrefixTokens": 64,
      "effortBreaksCache": "unknown",
      "stripVolatileHelps": true,
      "note": "..."
    },
    "cacheStrategy": {
      "id": "deepseek/automatic",
      "mode": "automatic-prefix",
      "minPrefixTokens": 64,
      "effortBreaksPrefix": "unknown",
      "volatileStrippingHelps": true,
      "compactionPolicy": "avoid-mid-prefix",
      "sources": ["deepseek-context-caching", "prompt-cache-paper"]
    },
    "forwards": 12,
    "refusals": 0,
    "lastForwardAt": "2026-10-18T05:00:00.000Z",
    "decorate": true,
    "metrics": {
      "requests": 12,
      "samples": 12,
      "inputTokens": 48000,
      "cachedInputTokens": 36000,
      "hitRate": 0.75,
      "window": 100
    },
    "prefix": { "current": "0123456789abcdef", "stable": true, "changes": 0 }
  }
}
```

What this checks today:

- `available` / `enabled` — the proxy route is installed and switched on
  (`DSH_COORDINATION_PROXY=1` or `<stateDir>/proxy.enable`).
- `mode` — `measure` forwards with only the route restored; `normalize` may also
  decorate (subject to the preset gate below).
- `upstream` — the real route the adapter forwards to; if it is missing, no
  request has named a provider yet.
- `cacheStrategy` — the researched row resolved for the current upstream route.
  It is the authority for the normalize gate: the decorator runs only when
  `cacheStrategy.volatileStrippingHelps` is true and `cacheStrategy.mode` is not
  `none` (and the operator mode is `normalize`). `sources` lists the
  `CACHE_SOURCES` ids behind the row, so every policy value is auditable from the
  status endpoint alone.
- `model` — the coarser `model-brand.ts` profile, still shown for display and
  backward compatibility. Its `effortBreaksCache` is derived from
  `cacheStrategy.effortBreaksPrefix`; the profile is no longer what gates the
  rewrite.
- `forwards` / `refusals` / `lastForwardAt` — the proxy is actually intercepting.
- `decorate` — a content decorator is wired; whether it is invoked depends on
  the mode and the preset flags above, per call.
- `metrics` — cache hit/miss token data from the last 100 forwarded requests.
- `prefix` — the latest 16-hex prefix digest and whether it is drifting.

Cache hit/miss data now has a first-class place in the snapshot:

- `inputTokens` — total input tokens across the **sampled** requests in the
  window;
- `cachedInputTokens` — the cached part of those tokens. DSH reports it as
  `cacheReadTokens`; `cachedInputTokens` and `cachedTokens` are accepted as
  aliases, and a missing cached field counts as zero;
- `hitRate` — `cachedInputTokens / inputTokens`, or `0` while there is no token
  sample;
- `requests` counts every forwarded request in the window, while `samples` counts
  only those whose stream yielded a readable usage chunk. A request without usage
  is counted in `requests` but contributes nothing to the token sums.

These are the provider's numbers summed over the window, not a local
measurement. The snapshot is still body-free: the proxy reads only the numeric
usage chunk and never stores prompt text.

The provider-specific source fields, if you read a response directly, are:

| Provider | Field to read |
| --- | --- |
| DeepSeek | `usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens` |
| OpenAI / Azure | `usage.prompt_tokens_details.cached_tokens` |
| Anthropic | `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens` |
| Moonshot | `usage.prompt_tokens_details.cached_tokens` / `cache_write_tokens` |
| Qwen | `usage.prompt_tokens_details.cached_tokens`, and `cache_creation_input_tokens` for writes |
| Zhipu | `usage.prompt_tokens_details.cached_tokens` |

The Anthropic field names are as listed in the fetched Moonshot comparison table for
the Messages API, because Anthropic's own usage page is behind the regional block;
verify them against a live response before building on them.

A useful manual check, once the proxy is enabled:

1. Send the same prefix twice with a small variable tail; the second response
   should report hit tokens ≥ the documented minimum.
2. Change one byte in the middle of the prefix; hit tokens should drop.
3. Change only the tail; hit tokens should stay flat.
4. For Anthropic-style rows, repeat 1 without a `cache_control` breakpoint: no
   hit should appear, which confirms the row's `explicit-breakpoints` mode.

If the endpoint is not up, the plugin is not registered (headless profile) or the
web server is disabled; check `GET /deepseek-coordination/ping` first.

---

## 7. Adoption notes

- The table is pure data and a pure function: no I/O, no imports. It is now the
  proxy's policy source: `proxy-service.ts` resolves it once per upstream route,
  uses it for the normalize gate, and reports the row as `cacheStrategy` in
  `status()`.
- `effortBreaksPrefix` is tri-state. `true`/`false` is reserved for a behaviour a
  fetched source documents (`effortEvidence: 'documented'`); everything else is
  `'unknown'` + `'assumed'`, and `model-brand.ts` never turns that gap into a
  boolean.
- `sourceIds` are the audit trail. A row added without a source id fails
  `test/cache-strategy.test.ts`, and so does a citation that does not resolve.
- Precedence is intentionally simple (agent+model > model > brand > unknown) and
  is pinned by tests; changing it will fail the audit rather than silently
  changing which rules an agent gets.
- When the Anthropic, OpenAI, Gemini or xAI pages become reachable, replace the
  matching `UNFETCHED` rows with real claims and re-check the numbers marked
  "assumed" in §5. Until then those rows should be treated as conservative
  defaults, not vendor facts.
