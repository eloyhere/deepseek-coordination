# Time/space complexity audit and data-structure adoption (v24)

Status: complete. Phase-1 library untouched (`src/shared/{hash,node,tree,map,list,set,lru,redblack,heap,stack,ast,graph,trie,grid}.ts`
are frozen; only their public APIs are consumed). This document is separate from
`docs/data-structures-report.md` and `docs/domain-model-v24.md`, which were not
edited.

Verification: `npm run typecheck` (tsc, clean), `npm test` (347 tests: 346 pass,
1 skipped, 0 fail), `npm run build` (tsdown, green), plus the new
`test/complexity-adoption.test.ts` (14 tests). The suite count includes
concurrent work in the frozen library; the audit's baseline was 324 tests, so 14
of the 23 added tests are listed in §12.

## 1. Method

1. Read the phase-1 contract (`docs/data-structures-report.md`), the v24 spec
   (§0 naming, §5 cache, §12 Bayesian, §14 validation, §17 SQL, §18 service) and
   `docs/file-processing-v24.md`.
2. Walked every host and client module named in the brief and recorded each
   unbounded map/array, each per-item query and each repeated scan before
   changing anything.
3. Measured candidate hotspots with an operational benchmark (query counts for
   SQL N+1, wall-clock for CPU work) before and after; the numbers below are
   from `test/complexity-bench.test.ts` during the audit and are re-checked by
   the guards in `test/complexity-adoption.test.ts`.
4. Adopted a shared structure only where the bound is safe or the replacement is
   provably equivalent. Everything else is listed in §5 (rejected) with the
   reason, because "no change" is the correct audit outcome for a structurally
   capped collection.

Measurement environment: local Windows machine, Node 24, `node:sqlite`
in-memory database, release-mode TypeScript build (`tsdown` test bundle). Timings
are indicative (single run, ±20%); the committed tests assert only generous
absolute bounds, never ratios.

## 2. Audit table

"Before" complexity is per operation on the named collection, with `n` = the
collection's natural size unless stated.

| # | Hotspot (before) | Location before | Complexity before | Change | Complexity after | Risk | Test |
|---|---|---|---|---|---|---|---|
| 1 | Turn ordinal from `COUNT(*)` | `src/host/turn.ts:123` | O(n) rows scanned per turn creation; O(n²) per session | `MAX(ordinal)` seek on `UNIQUE(session, ordinal)` | O(log n) per creation | Dense-ordinal invariant (append-only `turn`); documented in `src/host/turn.ts:131` | `complexity-adoption.test.ts` "turn ordinals…"; existing `turn.test.ts` |
| 2 | Route ranking N+1 | `src/host/bayesian.ts:576`, `:643` | O(R) posterior queries per ranking pass | one grouped `MAX(identity)` query → `Map<hypothesis, probability>` | 1 query per pass | SQLite bare-column `MAX` guarantee; `identity` unique | "rankRoute reads every latest posterior in one statement" |
| 3 | `dispatch` blockedBy N+1 | `src/host/orchestration.ts:226-248` | O(k) queries for k dependencies | one `IN (…)` read per list (400 ids per statement) | 1 query per list | chunk stays under SQLite variable limits | "dispatch resolves every blockedBy entry in one read" |
| 4 | `decompose` blockedBy N+1 | `src/host/orchestration.ts:192, 829-842` | O(drafts × deps) queries | one pre-read for the union of all draft dependencies | 1 query per decompose | same map preserves error order/wording | "decompose resolves all draft dependencies in one read" |
| 5 | Provider model catalog cache | `src/host/provider.ts:139` | unbounded `Map<string, …>` | `LruList(256)` (`ProviderCatalogCacheCapacity`) | O(1) op, space O(256) | eviction only causes a re-read from DSH | "provider catalog cache is bounded…" |
| 6 | Effort detector | `src/host/cache.ts:88` | unbounded `Map<number, string>` | `LruList(4096)` (`EffortCacheCapacity`) | O(1) op, space O(4096) | an evicted session reports "first effort" once (measurement only, no safety change) | "effort detector is bounded…" |
| 7 | Compaction bookkeeping | `src/host/coordination.ts:76` | unbounded `Map<string, {lastAt,count}>` | `CompactionStateStore` (`LruList(100000)`) in new `src/host/compaction-state.ts` | O(1) op, space O(100000) | capacity is the library maximum: eviction (counter reset) is unreachable at realistic session counts | "compaction state store evicts…" |
| 8 | `evidence(turn)` read | `src/host/database.ts` (no index) | full table scan per turn join | additive `idx_evidence_turn(turn, created)` | O(log n + k) | additive index, no migration | "audit indexes exist…" + reopen test |
| 9 | `likelihood(evidence, hypothesis)` read | `src/host/database.ts` (no index) | full table scan per likelihood lookup | additive `idx_likelihood_evidence` | O(log n + k) | additive index | same |
| 10 | `takeover(session)` read | `src/host/database.ts` (no index) | full table scan per session listing | additive `idx_takeover_session(session, identity)` | O(log n + k) | additive index | same |
| 11 | Plan text rescans | `src/host/plan.ts:363-372, 467-515` | 5 tokenisations + 4 lowercase/word scans per dimension pass | per-call `PlanTextScanner` memo | 2 tokenisations + 1 scan per pass | memo is call-local, cannot go stale | "plan dimensions stay deterministic…" + existing `plan.test.ts` |
| 12 | Client state cache | `src/client/controls.ts:689` | unbounded `Map<session, SelectionState>` | `SelectionStateCache` (`LruList(32)`) in new `src/client/selection-cache.ts` | O(1) op, space O(32) | eviction costs one poll (loading line), never a choice | "client selection cache is bounded…" |
| 13 | Client width cache | `src/client/controls.ts:504` | unbounded `Map<number, sx>` | `selectStyle` memo (`LruList(64)`) | O(1) op, space O(64) | rebuilt style is value-equal | "select style cache is bounded…" |
| 14 | Poll signature serialisation | `src/client/controls.ts:601-618` | 4 × `JSON.stringify` per 2 s poll (accept + feed) | same encoding, memoised by state identity (`WeakMap`) | 1 serialisation per poll, 0 for unchanged states | identity is a valid key because states are immutable by contract (documented in the module) | "selection signature…", "cheap enough…" |

Not changed but verified in §6–§8: `dshTurns`, `TakeoverGate.pending`,
`ResourceModule.baseEdges`, evidence/URL dedupe, token-governor memo and
`selectContext`, `TakeoverGate.list` sorting, the client 1 s/2–10 s polls, and
`SelectionModule.listPreset`.

## 3. Adoptions in detail

### 3.1 Turn ordinal: `COUNT(*)` → `MAX(ordinal)`

`turn` rows are append-only: no module deletes a turn, and `ordinal` is assigned
as `previous + 1` inside the creating transaction. Therefore
`COUNT(*) == MAX(ordinal)` for every database the plugin has ever written, and
`UNIQUE(session, ordinal)` already gives `MAX` an index seek. The new code reads
`COALESCE(MAX(ordinal), 0)` and keeps the same `maxTurnPerSession` guard, the
same `InvalidStateError` message and details, and the same ordinal sequence.

Measured (2 000 turns in one session, 2 000 iterations of just the ordinal
statement): `COUNT(*)` 65.2–69.1 ms → `MAX` 11.7–14.2 ms (≈4.6–5.9×). End to
end, 300 `turn.create` calls on a session with 2 000 existing turns:
100.5 ms → 92.3–96.5 ms; the remaining time is the four rows each creation
writes, which are unchanged.

Rejected alternative: `COUNT(*)` + `MAX` in one statement. It still scans the
index range, so it keeps the O(n) term and the cap check would need both values;
`MAX` alone is equivalent under the append-only invariant.

### 3.2 Route ranking: one grouped posterior read

`rankRoute` (and its risk mirror `rankFailureRoute`) used one
`SELECT … FROM posterior WHERE turn = ? AND hypothesis = ? ORDER BY identity DESC
LIMIT 1` per route. The new `latestPosteriors(turn)` issues one
`SELECT hypothesis, probability, MAX(identity) … WHERE turn = ? GROUP BY
hypothesis`, which SQLite resolves through `idx_posterior_turn(turn,
hypothesis)`; `identity` is the primary key, so the maximum row is unique and
the bare columns come from exactly that row (documented SQLite behaviour). The
map holds probabilities only, which is all the ranking consumes.

Measured (12 routes, 200 passes): 2 400 posterior statements → 200 (one per
pass); wall clock 59.0 ms → 35.8–42.4 ms. Test asserts the read count is 1 for
36 routes and that a newer posterior beats an older one.

Risk: the query relies on the guarded SQLite `MAX` bare-column rule; the test
pins both the count and the latest-wins result. An index-friendly alternative
(`ROW_NUMBER() OVER`) was not needed; the grouped form keeps 3.11-compatible SQL.

### 3.3 blockedBy: one read per list

Two paths resolved dependencies one identity at a time:
`dispatch` queried `parent, status` per dependency, and `decompose` queried
`parent` per draft dependency. `dependencyRows(identities)` now performs one
`SELECT identity, parent, status … WHERE identity IN (…)` per 400 unique ids and
both call sites read a `Map`. Error wording, error order, and the "missing /
other turn / not verified" precedence are unchanged; the test asserts all three
messages and that the point-read count is 0 with 8 dependencies.

`blockedBy` remains a JSON column because the schema has no edge table; adding
one is a schema change the audit did not take. The new helper is the single
place that decodes it, which is also the note a future `chain.ts` needs (§9).

### 3.4 Additive indexes

`SCHEMA_SQL` in `src/host/database.ts` now creates three indexes with
`CREATE INDEX IF NOT EXISTS`, so an existing database gains them on the next
open (the test drops one, reopens, and asserts it is back). `PRAGMA
user_version` stays 23: no table or column changed. `EXPLAIN QUERY PLAN` is
asserted to use all three.

Write cost: three small indexes on append-only tables (`evidence`,
`likelihood`, `takeover`); each insert does a few extra B-tree writes. The
selects they accelerate are per-turn/per-session reads that were previously
full scans, so the trade is favourable for any database that outlives a turn.

### 3.5 Bounded caches

| Cache | Capacity | Eviction consequence | Correct because |
|---|---|---|---|
| Provider catalogs | 256 routes | next `models(route)` asks DSH again | a catalog is a pure cache with a TTL already |
| Effort detector | 4 096 sessions | one call reports "first effort" (no break warning) | it is a detector, not an authority; DSH `TokenUsage` remains the measurement |
| Compaction state | 100 000 sessions | a session's cooldown/count resets | capacity is the library maximum; the cap is a rate limit, and the store is cleared on policy change/dispose |
| Client selection state | 32 sessions | composer shows its loading line for one poll | choices live on the host and in the offline localStorage copy |
| Select styles | 64 widths | style object rebuilt identically | the object is a memo, not state |

All five use `LruList` from `src/shared/lru.ts` (the only public LRU facade).
The compaction store lives in its own pure module so the cap is unit-testable
without a Cordis context; the client helpers live in
`src/client/selection-cache.ts` for the same reason (no React import). Both
caches the client owns are cleared from the plugin's disposer
(`clearComposerCaches()` in `src/client/controls.ts`, called by
`src/client/index.ts`).

### 3.6 Plan tokenisation memo

`computePlanDimensions` read the same text through several lenses: term sets for
approach, goal+step, intent, the comprehension reference text and the whole
text, plus marker counts for clarity text and the whole text (vague, verb,
destructive, uncertain). `PlanTextScanner` memoises `planTokens` and the
lowercase/word scan per source string **for one call**. It cannot go stale and
cannot grow (at most five sources), and it keeps `planTokens` itself unchanged,
so the exported function and every caller outside the dimension pass behave
exactly as before.

Measured (5 000 passes over a ~600-character plan): 190.4 ms → 177.8 ms (≈7%).
The gain is deliberately small because `decodePlanStep` (JSON parse) dominates
this input; the change is kept because it removes repeated O(text) work without
adding state.

### 3.7 Client poll signature: memoisation, not a new encoding

The audit's checklist suggested replacing `JSON.stringify` with a cheap
field/hash signature. Measured on the real payload (6 presets + 16 config
fields, 100 000 calls):

| Encoding | Time | Note |
|---|---|---|
| `JSON.stringify` (existing) | 151–158 ms | 1.5 µs/call |
| length-prefixed field walk | 409–416 ms | 2.7× slower |
| `stableHash(payload)` | 507 ms | 3.2× slower, 32-bit collision risk |

So the encoding was **not** replaced (see §5). Instead the same string is
memoised by `SelectionState` identity in a `WeakMap`: `SelectionState` objects
are immutable in this module (the host sends a fresh object; `applyPatch` and
`applyLocalCompaction` build new ones), and the poll path signs the same
previous state, the feed state and the accepted state several times. A quiet
poll now serialises the freshly received state once and hits the memo for the
previous/feed states (4 cold serialisations before). The old
`JSON.stringify([...])` expression is preserved verbatim as the signature body,
and the test asserts equality with that expression for a matrix of states, so
the wire behaviour is unchanged.

## 4. Benchmarks

Operational benchmark run before/after (same machine, same in-memory DB):

| Measurement | Before | After |
|---|---|---|
| 2 000 × `COUNT(*)` over 2 000 turns | 63.9–69.1 ms | (removed) |
| 2 000 × `MAX(ordinal)` over 2 000 turns | 14.1 ms (query already available) | 11.7–14.2 ms |
| 300 × `turn.create` with 2 000 existing turns | 100.5 ms | 92.3–96.5 ms |
| 200 × `rankRoute` (12 routes): posterior statements | 2 400 | 200 |
| 200 × `rankRoute` (12 routes): time | 59.0 ms | 35.8–42.4 ms |
| `dispatch` with 8 `blockedBy`: per-dependency point reads | 8 | 0 (+1 batch) |
| 5 000 × `computePlanDimensions` | 190.4 ms | 177.8–181.8 ms |
| Provider cache entries after 300 routes | 300 (unbounded) | 256 (capped) |
| Effort entries after 5 000 sessions | 5 000 (unbounded) | 4 096 (capped) |
| 100 000 × legacy `stateSignature` (2 states/poll) | 150.3–158.5 ms | (encoding kept) |
| 100 000 × new signature, warm state | — | 1.0 ms (≈10 ns/call, memo hit) |
| 100 000 × cold signature (fresh state) | 150.3–158.5 ms | same cold cost, 1 cold/poll |
| 100 000 × `stableHash(payload)` (rejected) | — | 507 ms |
| 100 000 × field-segment signature (rejected) | — | 409–416 ms |

The committed tests keep only absolute guards (`< 5 s` for 20 000 signatures and
2 000 dimension passes) so a slower CI machine cannot fail them; correctness
(equality, read counts, caps) is asserted exactly.

## 5. Rejected adoptions (and why)

1. **`CoordinationService.dshTurns` → LRU.** The map maps a DSH session to its
   open turn. Eviction would have to either close a still-running turn
   (changing lock semantics: the profession would unlock mid-task) or drop the
   slot so a later `endTurn`/`failTurn` silently leaves the turn open. The map is
   already bounded by *concurrency*, not history: `beginTurn` overwrites a
   session's slot and `endTurn`/`failTurn` delete it on every terminal path, and
   `dispose()` clears it. Rejected; documented here rather than capped.
2. **`TakeoverGate.pending` → LRU.** Each entry owns a live promise, an abort
   listener and a timeout, and its durable `takeover` row. Evicting an entry
   would strand the waiting waterfall handler until its timer fires and leave the
   row `pending` until then. Entries are removed exactly once on answer, cancel,
   abort, timeout or unload; the live set is bounded by concurrent waterfalls ×
   `clarifyTimeout` (≤ 30 s), not by history. Rejected.
3. **`ResourceModule.baseEdges` → LRU.** This map records which version each
   version was written on top of. Eviction would make `base(version)` return
   `undefined` for a version written *by this process*, which is a different
   answer (the API documents "absent" only for versions from an earlier
   process). Bounding it correctly would need a persisted `base` column
   (migration, not additive) or an edge table; that is a schema change outside
   this audit. Bounded in practice by versions written per process (~16 bytes
   each); flagged as remaining risk.
4. **`ComprehensionModule` caches.** There are none. Verified: the only `Map` in
   the module (`latestStages`) is function-local, keyed by stage ordinal, and
   discarded at return. Nothing to cap.
5. **Evidence/URL dedupe `Array.includes` → `Set`.** The arrays are capped before
   they can grow: `comprehension.maxEvidence` (8), `maxResults` per query and
   `comprehensionQueryBudget().maxQueries` (≤ 4). At those sizes the quadratic
   term is ≤ 64 string comparisons and a `Set` would add allocation plus a
   second collection for no measurable gain. Left as is.
6. **`TakeoverGate.list()` sort.** Pending windows are bounded by the timeout
   window (see 2); sorting a handful of views is cheaper than maintaining a
   second ordered index, and the oldest-first order is the contract.
7. **`ProviderModule.entry()`/`entries()` rebuild per call.** O(R) over DSH's
   route directory (dozens at most), and caching the registry would risk serving
   a stale route set right after a provider is added. The catalog cache (which is
   expensive) is the part that needed bounding.
8. **`SelectionModule.listPreset()` caching.** It reads DSH's live preset
   catalog and resolves each preset, once per poll. Caching would make the
   settings page show a preset DSH no longer offers; the cost is bounded by the
   catalog size (~5).
9. **Token governor: memo and `selectContext`.** `token.ts`'s memo is already a
   256-entry LRU with O(1) amortised hits, and `selectContext` is one O(n)
   scoring pass + one O(n log n) sort with a Set-based near-duplicate filter (no
   pairwise O(n²) step). No change: adopting `LruList` there would be a
   mechanical rewrite of a correct bounded cache, and the brief explicitly says
   not to weaken caps.
10. **`rankRoute`/`rankFailureRoute` sorting → heap/tree.** The sort is required
   because the rank is persisted as an order; `R ≤ bayesian.maxRoutes` (12 by
   default) is structurally capped, so a heap would add code and allocation
   without changing an asymptote that matters.
11. **`stateSignature` encoding (see 3.7).** Measured alternatives are slower and
    one introduces collision risk. Identity memoisation kept the exact JSON
    encoding and removed the repeated work.
12. **Client polling intervals (1 s takeover, 2–10 s selection).** 1 s is the
    takeover dialog's liveness requirement; both polls stop while the document
    is hidden and the selection poll suspends the dialog work when the signature
    is unchanged. No interval was changed: it is product behaviour, not a leak.

## 6. SQL audit detail

- **Ordinal**: fixed (§3.1). No other `COUNT(*)`-per-row pattern exists; the
  remaining `count` calls are `metrics()` (six explicit counts per API call,
  intentional) and route/turn caps, all bounded by configuration.
- **N+1 reads**: the two ranking passes and the two blockedBy paths were the
  only per-item query loops over unbounded-ish collections. `permission.list`,
  `takeover.list`, `turn.list`, `subtask` reads and the trace readers are single
  queries. `SelectionModule.state()` issues two point reads per poll
  (`selection`, active turn) plus the DSH preset catalog; that is the wire
  contract, not a loop.
- **JSON parse repeats**: `mapSelection`/`mapTurn`/`mapSubtask` parse each JSON
  column once per row load; list methods map rows once. `comprehension`/`plan`
  re-parse their stored payloads per call by design (they are the stored
  artifact). In `computePlanDimensions`, `decodePlanStep` was already called once
  per pass; the repeated work was the token/marker scans, now memoised (§3.6).
- **Missing indexes added**: `evidence(turn, created)`,
  `likelihood(evidence, hypothesis)`, `takeover(session, identity)`. Existing
  indexes already covered `posterior(turn, hypothesis)`, `turn(session,
  ordinal)`, `subtask(parent, status)`, `route(turn, rank)`,
  `orchestration_trace(turn/subtask/event)`, `permission(session, status)`.
- **No migrations**: only `CREATE INDEX IF NOT EXISTS`; `PRAGMA user_version`
  remains 23 and the reopen test asserts the indexes are re-applied.

## 7. Client audit detail

- **1 s / 2–10 s polling**: the takeover poll runs only while its switch is on,
  the session id is usable and the document is visible; a quiet poll compares a
  pending signature and does not re-render. The selection poll stores a single
  interval, pauses on `refreshInterval = 0`, and refreshes on focus/visibility
  instead of polling faster. No change.
- **Recomputed option arrays**: profession/interaction/scene/validation options
  are already `useMemo`d on the locale copy; the permission option list is
  rebuilt per render from the host preset catalog (bounded, ~5 entries) because
  it depends on the preset. Left as is.
- **Repeated bridge calls**: a poll's answer is applied only while the component
  is mounted (`aliveRef`), and the optimistic write path batches patches for
  120 ms before one save. No redundant bridge call found.
- **Caches**: `stateCache` and the width memo were the only module-level caches
  in the client and are now bounded (§3.5). The takeover dialog owns no cache.
- **Signature**: see §3.7/§5.11.

## 8. Token governor verification (no change)

- `selectContext` (`src/host/token.ts:469`): validates + scores each chunk once
  (O(n)), filters/sorts O(n log n), dedupes with a hash signature Set seeded from
  the mandatory set (no pairwise comparisons), then rebuilds `selected`/`dropped`
  in input order O(n). No O(n²).
- `estimateTokens`: O(n) first call, O(1) memo hit; the memo is capped at 256
  entries with explicit delete-oldest eviction. `planBudget`/`shouldRetrieve`/
  `shouldCompact` are O(1).
- Caps were not touched: chunk cap 20 000, memo 256, compaction `soft`/`hard`
  clamps, `maxPerSession`, `cooldown`.

## 9. Parser readiness and the future `chain.ts` (report only)

No host module currently duplicates the phase-1 structures the future parser
needs. `src/host/text/` landed in the workspace while this audit was running
(parser agent, not edited here): `tokenizer.ts` imports `TokenStream` and
`parser.ts` imports `AstNode`/`AstTree`/`SourceSpan` from the frozen library, so
the tokenizer and parser are already built on the contract rather than on
ad-hoc token arrays or recursive node objects. The remaining mapping is the
guidance for the rest of that layer (`javascript.ts`, `markup.ts`,
`dependency.ts`, `cache.ts`):

| Parser need | Structure (frozen library) | Notes for that agent |
|---|---|---|
| Token stream with lookahead/rewind | `TokenStream` | copy-on-construct; O(1) `peek/next/save/restore`; do not hand-roll an index+array pair |
| AST nodes, spans, iterative walk | `AstNode`/`AstTree`/`visitAst` | `visitAst` is iterative (depth 256 cap fits without recursion) |
| Node lookup by kind / offset | `AstIndex` | snapshot O(n log n); `smallestContaining` O(log n) typical |
| Import graph, cycle, topo, levels | `DirectedGraph` | `topologicalSort` Kahn, `findCycle` returns the legal path, `dependencyLevels` |
| Path-prefix lookup / keyword table | `Trie` | child-insertion order, not lexicographic |
| Parser result cache 256 | `LruList` | key `path + mtime + size + parserId` |
| Diagnostics in encounter order | `OrderedMap` | stable insertion order |
| Explicit parser stack, backtracking | `Stack`/`Deque` | no recursion |
| Sorted symbol table (if needed) | `RedBlackTree`/`RedBlackSet` | not `BinaryTree` (degenerate) |
| Future sheet surface | `SparseGrid`/`GridRange` | no dense allocation |

`chain.ts` (host-only, not implemented): relations `depends_on`, `satisfies`,
`baseline`, `prerequisite`, `requires`, `meets`; queries via `DirectedGraph`
topology plus `RedBlackTree`/`OrderedMap` indexes; projection cache keyed by
`(root, relationSet, depth, graphVersion)` with `LruList`; cycle paths are legal
results. Do not make changes that block it:

- Dependency edges are still JSON in `subtask.blockedBy` (no edge table). A chain
  projection must build its graph by reading the turn's subtasks once
  (`idx_subtask_parent(parent, status)`), not by scanning `blockedBy` per model
  request. `OrchestrationModule.dependencyRows` is the one decoder today.
- Relations that already have indexes: `subtask(parent, status)`,
  `profession_record(turn)`/`(subtask)`, `orchestration_trace(turn/subtask/event)`,
  `evidence(turn, created)`, `likelihood(evidence, hypothesis)`,
  `posterior(turn, hypothesis)`, `plan(turn)`/`plan_rebuild(plan, attempt)`,
  `resource(session, path)`, `version(resource, version)`, `vision`, `request`,
  `thread`, `result(request)`.
- **Cache invalidation hook**: a chain projection cache must key on a
  `graphVersion`. The cheapest correct source is a monotonic stamp made from the
  maximum `identity` of the tables in the relation set (e.g.
  `SELECT MAX(identity) FROM subtask` + `orchestration_trace` + `evidence`), or
  `PRAGMA data_version` for "another connection wrote". `CoordinationDatabase`
  would expose one `graphVersion()` helper; no such method exists yet and the
  audit deliberately did not invent it. Every cache the audit bounded or added
  that a chain projection could reuse is listed here with its invalidation:
  - provider catalog (host): TTL + `invalidate(route)`; unrelated to chain.
  - effort detector (host): per-session write, no graph dependency.
  - compaction bookkeeping (host): cleared on policy change and dispose.
  - client selection state (browser): per-session identity, refreshed from the
    host each poll; not a chain cache.
  - A future chain cache should be a **new** `LruList` in `chain.ts`, not a reuse
    of any of the above.

## 10. Model-facing output audit (design constraint)

Constraint applied: the agent never receives internal structures or serialized
indexes; tool output must be a bounded, read-only projection with handles,
relation kinds, status and an explicit `truncated` flag.

Findings (report-only; changing a tool's wire/value shape is a public-contract
change and was out of scope for a behaviour-preserving audit):

1. **`coordination_profession` returns a full `ProfessionRecord`.** The record
   carries `input` (the prompt text) and `output` (the worker result) —
   unbounded text echoed into a model-facing tool result, plus the whole
   audit row. This is the one real violation of the bounded-summary rule. Fix
   later by projecting `{ handle, status, profession, locked }` (and a bounded
   excerpt only when asked). `src/host/tools.ts:321` (`record` in the value),
   schema `PROFESSION_RECORD_SCHEMA` at `tools.ts:208`.
2. **`coordination_selection` returns the whole UI `SelectionState`** —
   including the 15-field `config` block and the DSH `presets` catalog, which
   are UI-only. It is bounded today (~1–2 KB) but larger than the model needs;
   the summary should be the five choices + lock. `tools.ts:402`, `:419`.
3. **`renderJson`** pretty-prints with no explicit `truncated`/token bound.
   Today's three tools are small; a future chain/parse tool must not reuse it
   unchanged — it needs the ≤ 1 500-token, ≤ 50-link, depth ≤ 8 projection.
4. **Command results** (`plan` handler returns `JSON.stringify(plan)` including
   `plan.step`) are stored in `command.result` and read by the HTTP/client
   surface, *not* injected into the model context; they are not a model-facing
   leak, but they are an unbounded blob in one column and the same bounded-
   summary rule should apply if a tool ever exposes them.
5. **No AST/graph/tree/LRU/Trie/SparseGrid is serialized to the model.** Verified
   by imports: `src/host/tools.ts` imports no `src/shared/{ast,graph,tree,trie,
   grid,lru,redblack}.js`, and the only model-facing renderer is `renderJson`
   over the three small values above. DB row dumps are the only category found.

## 11. Remaining risks

- `CompactionStateStore` capacity is 100 000 sessions; a host that compacts for
  more distinct sessions in one process would reset the oldest counters. This is
  a rate limit, not a safety gate; documented in the module.
- `EffortCacheCapacity` eviction under-reports one effort change for a session
  idle for 4 096 other sessions. Measurement only; DSH usage numbers remain the
  source of truth.
- `baseEdges` (resource versions) is still bounded only by versions written per
  process (rejected in §5.3). A persisted `base` column is the correct long-term
  fix and is a schema change, not an index.
- Proxy caches (provider, client selection) accept a re-read on eviction; the
  tests pin correctness, not latency.
- The audit's wall-clock guards are intentionally loose and are regression
  tripwires, not performance targets.
- `MAX(ordinal)` assumes dense, append-only ordinals. A future migration that
  deletes turn rows would keep monotonicity but change the `maxTurnPerSession`
  check from "row count" to "highest ordinal"; the invariant is documented at
  the call site.
- Three new indexes add a small write cost to append-only tables; they were
  chosen because each read they fix was a full scan per turn/session.
- **Concurrent workspace change (not this audit):** during this work another
  agent refactored `src/shared/hash.ts`/`lru.ts` and updated
  `docs/data-structures-report.md`; a parser agent created `src/host/text/`. The
  audit consumes only the public `LruList`/`WeakLruList` API, so the adoption is
  unaffected; the frozen files and the two protected docs were not edited here.

## 12. Tests and verification

New file: `test/complexity-adoption.test.ts` (equivalence, cap, index and
signature regressions). No existing test was deleted or weakened.

Coverage added:

- turn ordinal equivalence (`COUNT == MAX`), index-backed plan, next ordinal,
  unchanged `maxTurnPerSession` error, `create` after 2 000 turns;
- route ranking: exactly one posterior statement, latest-posterior wins, rank
  persisted, failure-route mirror;
- blockedBy: one batch read for 8 dependencies, 0 point reads, all three error
  messages, `decompose` batch read and missing-dependency error;
- provider cache cap 256, warm hit, cold re-enumeration, `invalidate`;
- effort cap 4 096, break detection, documented eviction behaviour;
- compaction store LRU/clear; client selection cache LRU/clear; select-style
  memo identity/eviction;
- signature sensitivity for every rendered field, equality with the legacy JSON
  expression, and generous timing guards;
- dimension determinism and range;
- index presence, plan usage and additive re-creation on an existing database.

Commands and results (final state):

```
npm run typecheck   # tsc -p tsconfig.json --noEmit          -> clean (exit 0)
npm test            # tsdown test build + node --test        -> 347 tests, 346 pass,
                    #                                            1 skipped (--expose-gc), 0 fail
npm run build       # tsdown host + client bundles           -> green (exit 0)
```

Baseline before the audit was 324 tests / 0 failures. The final run reports 347
tests (346 pass, 1 skipped, 0 fail): this audit added 14 tests in
`test/complexity-adoption.test.ts`, the remaining 9 come from concurrent work in
the shared library that landed in the same workspace. The one skip is the
phase-1 GC assertion that only runs under `node --expose-gc`.
