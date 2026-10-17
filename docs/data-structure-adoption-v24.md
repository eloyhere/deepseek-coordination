# Shared data-structure adoption (v24)

Status: complete. This is an adoption pass, not a rewrite: every change replaces an
ad-hoc algorithm with a canonical structure from `src/shared/` where the structure
either changes an asymptote, removes duplicated storage/implementation, or supplies a
bounded capacity that did not exist before. `src/shared/*` was **not** edited; no
dependency, schema, DB row, public method signature, wire shape or error text changed.

Baseline before this pass: `tsc` clean, `test:tsc` clean, `npm test` 419 tests /
418 pass / 1 skipped. After: 451 tests / 450 pass / 1 skipped, 0 fail. This file's 14
new tests are `test/data-structure-adoption.test.ts`; the remaining 18 additions came
from concurrent agents landing in the same tree during the pass.

## 1. Method

1. Re-read the phase-1 contract (`docs/data-structures-report.md`), the domain model
   (`docs/domain-model-v24.md` §4–§6), the earlier complexity audit
   (`docs/complexity-audit-v24.md`) and test fixtures.
2. Re-audited every safe host module after the concurrent agents finished, recording
   each unbounded map, repeated sort, nested scan, `Array.shift` parser and cache
   before editing. The five edited modules and two new deliverables are the entire
   write set.
3. Adopted a structure only with one of: an equivalent public result proven by a test,
   a removed duplicate implementation, a real asymptotic improvement, or a bounded
   capacity. Everything else is in §5 with concrete evidence.
4. Measured candidates on the same machine in the test build (Node 24, in-memory DB).
   Timings are single-run indicative numbers, not targets; committed tests assert
   correctness exactly and only generous absolute bounds.

Protected files (`src/shared/*`, `config.ts`, `selection.ts`, `tools.ts`, `chain.ts`,
`parse-service.ts`, client/**, READMEs) were read where needed and never written.
`token.ts` was explicitly approved for this pass.

## 2. Adoption matrix

Complexity is per operation on the named collection; `n` is its natural size.
"Before" is the code this pass replaced.

| Structure | Consumer (module/function) | Before | Adopted shape | Complexity before → after | Test |
|---|---|---|---|---|---|
| `hashString` | `src/host/token.ts` `memoKey` / `dedupeSignature` via `hashKey` | Local `hash32`: a copy of FNV-1a over UTF-16 units, base-36 | `hashString(text).toString(36)` from `shared/hash.ts` | O(len) → O(len); removes the duplicate 8-line implementation, keys byte-identical | "shared hashString reproduces the removed FNV-1a memo/dedupe key bytes" |
| `LruList` | `src/host/token.ts` `estimateTokens` memo | `Map` + manual `delete`/`set` promotion + delete-oldest at 256 | `LruList<string, MemoEntry>(256)` | O(1) amortized → O(1) amortized; memory exactly O(256), eviction policy now canonical | "estimateTokens memo is a 256-entry LRU and evicts only the oldest" |
| `OrderedSet` | `src/host/comprehension.ts` `unique()` | Array + `result.includes(value)` | `OrderedSet<string>` + `toArray()` | O(n²) → O(n) average; insertion order preserved | "comprehension deduplicates repeated constraint clauses in first-seen order" |
| `OrderedSet` | `src/host/emotion.ts` `unique()` | Array + `result.includes(value)` | `OrderedSet<string>` + `toArray()` | O(n²) → O(n) average; insertion order preserved | "emotion records a repeated crisis marker once in signal order" |
| `OrderedSet` | `src/host/permission.ts` `normaliseGrant()` | `Set` for membership + parallel `string[]` for order | One `OrderedSet<string>` + `toArray()` | O(n) average → O(n) average; one structure instead of two, same first-seen order | "permission deduplicates repeated grant names in first-seen order" |
| `Queue` | `src/host/permission.ts` `tokenize` → `execute` → `commandAllow/Deny/Revoke/Status` / `extractApproval` | `string[]` + six `Array.shift()` calls and `tokens[index + 1]` lookahead | `Queue<string>` with `dequeue`/`size`/`toArray`; directive value is the next `dequeue()` | O(t²) time (shift copies the tail per token) → O(t); space O(t) with ring-buffer slack | "permission command queue preserves lookahead, order and quoted tokens"; "permission command accepts 200 grants without losing or reordering one" |
| `RedBlackTree` | `src/host/predict.ts` `numericAgreement()` | Nested scan: every left number against every right number | `RedBlackTree<number, true>`; exact `has`, then `predecessor`/`successor` | O(L·R) time / O(1) extra → O((L+R) log R) / O(R) extra | "red-black numeric agreement matches the brute-force reference"; "red-black numeric agreement stays linear-ish on numeric-heavy text" |
| `BinaryHeap` | `src/host/token.ts` `selectContext` candidate ranking | `filter(...).sort(compareScored)` then one `for…of` scan | `new BinaryHeap(compareScored, filtered)` then repeated `pop()` in total order | O(n log n) sort → O(n) heapify + O(k log n) pops; worst O(n log n); space O(n) unchanged | "selectContext heap matches the sort reference on randomized fixtures"; "selectContext keeps pinned, recent, minScore and dedupe semantics"; "selectContext scores 20k chunks within the audit bound" |
| `SparseGrid` / `GridRange` | `test/data-structure-adoption.test.ts` (no host sheet consumer yet) | Dense matrix in a hypothetical sheet | `SparseGrid<string>` projections/range/bounds | Dense O(rows×cols) space → O(cells); cell O(1), row/column O(k log k), range O(r+R+k log k) | "SparseGrid models a sheet range without dense allocation" — readiness for P1 |
| `BPlusTree` | benchmark only (no production consumer) | — | 10k ordered posterior-shaped keys | set/get O(log n), range O(log n+k); measured 4.6–6.6 ms for 10k set + 5k range | "B+ tree indexes a 10k posterior-shaped range index within the bound" |
| `DirectedGraph` | existing `src/host/chain.ts` / `src/host/text/dependency.ts` (protected) | — | already adopted by the wiring/parser agents; no safe-host duplicate existed | O(V+E) topological sort / levels | existing chain/text tests |
| `AstNode` / `AstTree` / `TokenStream` | existing `src/host/text/**` (protected parser) | — | already adopted; plan/comprehension text has no grammar to parse | O(n) walks, O(1) stream operations | existing parser tests |

### 2.1 LRU consumers that predate this pass (verified, not rewritten)

`src/host/cache.ts` (effort detector, 4 096), `src/host/provider.ts` (catalog, 256),
`src/host/compaction-state.ts` (compaction bookkeeping, 100 000), plus the new
`chain.ts`, `parse-service.ts` and `node-registry.ts` caches. The audit's eviction
rules still hold: none of these owns live turn/takeover/waterfall state, so eviction
re-reads or re-measures rather than stranding a promise. `src/client/selection-cache.ts`
is the client's bounded cache and was not touched.

## 3. Adoptions in detail

### 3.1 Permission command parser → `Queue`

`tokenize` now returns `Queue<string>`; every command helper consumes the front with
`dequeue()`. `extractApproval` walks the queue instead of an index, and when a
directive has no inline value it dequeues exactly the next token — the same lookahead
as `tokens[index + 1]`, but O(1) and without leaving the value behind. Non-directive
tokens are re-enqueued on a second queue in encounter order, so quoted strings, grant
order and error wording are unchanged.

Measured: a 200-grant `allow` command (tokenize + parse + record + one list read)
completed in **4.2 ms**; every grant is recorded exactly once and returned in order.
Before, each `shift()` copied the remaining token array, so the parser was O(t²) in
the command length; it is now O(t). `t` is small for real commands, so this is a
correctness/clarity win first and a wall-clock win only for pathological input.

Rejected alternative: `TokenStream` from `ast.ts`. It carries `TokenKind` and source
spans for a language parser; a shell-like command needs only FIFO tokens, and the
`Queue` adapter keeps the existing tokenizer and error text.

### 3.2 Numeric agreement → `RedBlackTree` nearest neighbour

`numericAgreement` used to compare every left number with every right number. The
similarity `1 - |v-c| / max(|v|,|c|,1)` is monotone in distance from `v`:

- for `c ≤ v`, moving `c` toward `v` lowers the gap and the ratio cannot rise;
- for `c ≥ v`, `1 - (c-v)/c = v/c` rises as `c` approaches `v`;
- an exact match scores 1, the maximum;
- when every candidate clamps to 0 (all candidates far below/above zero), every
  similarity ties at 0, so returning 0 is equivalent.

The nearest predecessor and successor therefore contain the argmax. A red-black tree
of the finite right-hand numbers turns the scan into one `has` plus one
`predecessor`/`successor` per left number. `numbersOf` already filters non-finite
tokens; the tree build and loop carry defensive finite guards, and a non-finite key
can never reach the comparator.

Measured (2 000 left × 2 000 right numeric texts): tree **2.5–3.5 ms**, brute-force
reference **165.7–183.1 ms** (≈50–70×). Correctness: 300 deterministic random
fixtures (negatives, zero, duplicates, decimals) plus fixed exact/duplicate/sign/
no-number cases match the brute-force implementation at the public 4-decimal result.

No small fixed-size array was wrapped: a handful of numeric tokens still pays the
tree's O(R log R) setup, but that setup is negligible beside the O(text) tokenisation
that precedes it. This is the only safe-host use of `RedBlackTree`.

### 3.3 `selectContext` candidate ranking → `BinaryHeap`

`compareScored` is a total order: value descending, then `created` ascending, then
`id` byte-ascending, then input index ascending. Because the index tie-break is
unique, heap pops are exactly the order the previous sort produced, and the final
`selected`/`dropped` arrays are still rebuilt by input index — the wire order is
unchanged. Pinned/recent mandatory chunks, `minScore`, capacity, signature seeding and
duplicate skipping were not touched.

A zero-token candidate is still acceptable after the budget is full, so the loop
counts candidate zero-token chunks and stops only when both the budget is exhausted
and no zero-token candidate remains. Positive candidates that can no longer fit are
skipped without changing the signature set (they could not add a signature either
under the old code), which is what makes the early stop exact. Randomized fixtures
compare selected ids, dropped ids and `estimated` against a test-local reimplementation
of the old filter→sort scan.

Measured, 20 000 chunks, 22 950-token capacity (3 745 selected):

| Budget | Heap | Sort reference | Result |
|---|---|---|---|
| wide (32k window) | 17.4–21.3 ms | 16.1–23.5 ms | statistically neutral; native sort and heap trade places between runs |
| tight (8k window) | 7.2–11.1 ms | 9.9–16.0 ms | most runs are 1.4–2.2× faster with the heap, but one loaded run was 11.1 vs 9.9 ms |

Decision: keep the heap, but do not claim a universal wall-clock win. The measurements
are noise-dominated on a machine that was also running two other agents' test suites;
the one consistent fact is that the heap never reorders or loses a result, and it
performs O(n) heapify + O(k log n) pops instead of an unconditional O(n log n) sort.
The tight-budget case is why it stays: when the budget fills early, it stops popping
and never sorts the remaining candidates. A fully fitting candidate set is sort-like
work; an adaptive "sort when capacity covers every candidate" branch was rejected as
a second ranking path that would weaken the single-total-order proof.

### 3.4 Token memo → `LruList`, hash → `hashString`

The memo was already a 256-entry LRU: `Map.get`, then `delete` + `set` to promote, and
a manual `delete(oldest)` before every insert at capacity. It is now the canonical
`LruList<string, MemoEntry>(256)`: `get` promotes, `set` replaces/inserts and evicts,
`clear` resets. The policy cap is unchanged and `tokenDiagnostics.memoEntries` still
reads `memo.size`, so observability and the existing cap test are untouched.

The local `hash32` was a byte-for-byte duplicate of `hashString`: same FNV offset basis
and prime, same UTF-16 code units, same `>>> 0` before base-36. It was removed and both
call sites now use `hashString(text).toString(36)`. The parity test checks ASCII, CJK,
astral, empty, tab/newline and 4 096-character inputs against a local FNV reference.
If any byte had differed, the local helper would have been kept; it did not.

Collision caveat unchanged: memo keys still use one 32-bit hash per sampled window and
dedupe signatures use two prefixed 32-bit hashes plus the length bucket. The cache is
an optimisation, never an authority; a collision can only cause a recomputation or a
coarser dedupe, not a wrong estimate.

### 3.5 Insertion-order dedupe → `OrderedSet`

Three private `unique()`/normalise helpers used `result.includes(value)` on growing
arrays. They now use `OrderedSet<string>`:

- comprehension constraint clauses (and search queries through the same helper);
- emotion crisis markers (one repeated marker in a long prompt used to cost a
  quadratic scan);
- permission grant names (a single structure now supplies both membership and
  first-seen order; the parallel `Set` + `string[]` pair is gone).

All three preserve the old output order exactly. The comprehension and emotion
changes are O(n²)→O(n) for input sizes that a prompt can actually drive; the permission
change is complexity-neutral (`Set` was already O(1) average) and is justified by
removing the duplicated order array, not by a new asymptote.

## 4. Benchmark and verification evidence

Environment: local Windows, Node 24, `tsdown` test bundle, in-memory SQLite. Single-run
ranges across the full-suite and focused runs; tests assert only generous absolute
bounds.

| Measurement | Result |
|---|---|
| `selectContext` 20k chunks, wide budget (3 745 selected) | heap 17.4–21.3 ms vs sort reference 16.1–23.5 ms (neutral/noise) |
| `selectContext` 20k chunks, tight budget (1 511 selected) | heap 7.2–11.1 ms vs sort reference 9.9–16.0 ms (usually heap faster; one loaded run reversed) |
| `numericAgreement` 2k × 2k numbers | tree 2.5–3.5 ms vs brute force 165.7–190.2 ms |
| Permission 200-grant command (parse + record + list) | 4.1–4.2 ms |
| B+ tree 10k set + 5 001-key range | 4.6–6.6 ms |
| `estimateTokens` memo cap after 257 unique texts | exactly 256; oldest miss, newest hit |
| `hashString` parity samples | 10/10 byte-identical base-36 strings |
| Full suite | **451 tests, 450 pass, 1 skipped, 0 fail** |
| New adoption tests | **14 tests, 14 pass** |
| Baseline | 419 tests, 418 pass, 1 skipped (18 concurrent additions landed after it) |
| `npm run typecheck` | clean (exit 0) |
| `npm run test:tsc` | clean (exit 0) |
| `npm run build` (`tsdown --config tsdown.config.ts`) | green (exit 0); only pre-existing MUI `"use client"` bundling warnings |

The one skip is the phase-1 `WeakLruList` forced-GC assertion that only runs under
`node --expose-gc`; it is unrelated to this pass.

## 5. Not applicable / rejected, with evidence

A host/client import audit (excluding `src/shared`) shows no consumer for the
structures below. "No consumer" is evidence, not a guess: adding one would require
inventing a use, which the brief forbids.

| Structure | Status | Concrete reason / evidence |
|---|---|---|
| `OrderedMap` | not adopted | No host/client import. Every insertion-ordered host map (`latestPosteriors`, `latestStages`, permission grouping, provider directory, `dshTurns`, `baseEdges`) is used for point/membership access only; native `Map` already guarantees insertion order, and none needs `first/last/deleteFirst/deleteLast`. A wrapper would add a linked list without a new capability. |
| `UnorderedMap` | not applicable | No import. Native `Map` already provides the exact contract; the wrapper adds no operation, bound or ordering guarantee. |
| `UnorderedSet` | not applicable | No import. Native `Set` already provides O(1) average membership; `UnorderedSet` is documented as a thin native-`Set` facade. |
| `OrderedSkipList` | not applicable | No import. Host ordered collections are bounded arrays (9 success routes, 7 failure routes, 8 plan dimensions, ≤16 evidence, fixed marker tables); a sorted skip list would add O(n) node allocation without changing a meaningful asymptote. Ordered SQL reads already come from `ORDER BY` indexes. |
| `UnorderedSkipList` | not applicable | No import and no hash-ordered duplicate collection. |
| `OrderedSkipSet` | not applicable | No import and no sorted unique key set; permission grants need first-seen order (now `OrderedSet`), not sorted order. |
| `UnorderedSkipSet` | not applicable | No import; no hash-ordered membership index beyond native `Set`. |
| `RedBlackSet` | not applicable | No import. The one sorted-key need (numeric nearest neighbour) needs value lookup, predecessor and successor, so it uses `RedBlackTree`; no host collection needs a sorted unique set. |
| `BPlusTree` | not adopted; benchmark only | No import. The large ordered collections (posteriors, evidence, history, turns, versions) live in SQLite and are read through existing indexes; an in-memory mirror would duplicate persistence and need a graph-version invalidation hook that does not exist yet. The 10k benchmark proves readiness for the P1 chain/domain layer. |
| `IndexedHeap` | not applicable | No import. No priority item is updated after insertion: takeovers are timer-driven, routes are recomputed wholesale (≤12), and lock leases are fixed at acquisition (no heartbeat path). `BinaryHeap` is used where a static candidate set is ranked once. |
| `Stack` | not applicable | No import. There is no depth-first traversal in the safe host modules that is deeper than 4 (`collectSearchResults`); an explicit stack would be more code for the same bounded recursion. The parser's own stack work is in protected `text/**`. |
| `Deque` | not applicable | No import. `Queue` covers the FIFO command parser; nothing needs double-ended access (no backtracking parser in the safe host set). |
| `AstNode` / `AstTree` | existing consumer only | Used by protected `text/**` for JS/Markdown/TeX trees. Plan/comprehension text is prose with no grammar; wrapping regex-scored prose in an AST would add nodes without a parse tree. No AST is serialized to the model. |
| `TokenStream` | existing consumer only | Used by protected `text/tokenizer.ts`. The permission command face is FIFO tokens without kinds/spans, so `Queue` is the right abstraction and `TokenStream` would add unused token metadata. |
| `AstIndex` | not applicable | No import. Parser node lookup by kind/offset is a P1 parse-service concern; `parse-service.ts` currently imports only `SourceSpan` and is protected. |
| `DirectedGraph` (safe host) | existing consumer only | Already used by protected `chain.ts` and `text/dependency.ts` (imports, topo, levels, cycles). `orchestration.decompose` resolves `blockedBy` as one batch-read map and refuses forward references, so a host dependency graph would be acyclic by construction and would add work without changing an answer. A future chain projection is the real consumer. |
| `Trie` | not applicable / future parser | No import. Provider policy matches substrings (regex), learning patterns match containment, and permission subjects match exactly — none is a prefix lookup. `Trie` is the right structure for future import-specifier/path-prefix and symbol-prefix tables in the parser/chain layer. |
| `SparseGrid` / `GridRange` | test-only readiness | No production import. There is no sheet/cell host module yet; the test proves row/column/range/bounds and a coordinate at 1 000 000 without dense allocation. It is ready for the P1 sheet surface (`sheetGrid`, `rowAt`, `columnAt`, range expansion). |
| `WeakLruList` | not applicable | No import. Host caches are keyed by primitives (session identities, route strings, paths); `WeakLruList` requires object keys, and GC timing is unusable for any state whose loss could affect a turn. |
| `OrderedLruSet` / `UnorderedLruSet` | not applicable | No import. All bounded caches are key→value; no set-shaped cache exists. |
| `OrderedLruList` / `UnorderedLruList` | not applicable | No import. No recency-ordered list cache exists; the token/plan caches are keyed maps. |

Rejected candidate adoptions investigated during the pass:

1. **`learning.learnedCategory` → Trie/RedBlackTree.** The lookup asks whether a
   stored signature is *contained* in the candidate, then keeps the longest match.
   A Trie answers prefix membership, not arbitrary containment; sorting by length
   still leaves an O(P) containment scan. No structure change is correct, and P
   (learned patterns) is small.
2. **`resource.baseEdges` → LRU/OrderedMap.** Previously rejected by the v24 audit and
   unchanged: eviction would make `base(version)` report "absent" for a version written
   by this process, a different answer. One base edge per version, point lookup only.
3. **`TakeoverGate.pending` / `CoordinationService.dshTurns` → LRU.** Live promises,
   abort listeners, timers and open turns. Eviction would strand a waterfall handler
   or leave a turn open; both were rejected before and remain rejected.
4. **Marker regex caches in comprehension/emotion → `LruList`.** The marker tables are
   fixed and small; a module-level `Map<marker, RegExp>` would remove repeated
   `new RegExp` work, but the key space is the fixed table, so an LRU adds eviction
   policy for no memory risk. Flagged as a remaining micro-optimisation, not adopted
   here because it is outside the data-structure brief and would touch two large
   lexicons.
5. **`selectContext` heap for a fully fitting candidate set.** The wide-budget
   benchmark shows native sort is a little faster when most candidates fit. An
   adaptive "sort if capacity ≥ total candidate tokens" branch would recover that
   constant but add a second ranking path and weaken the single-total-order proof;
   kept the heap and documented the constant instead.

## 6. Future parser/chain readiness

The parser/chain work landed concurrently in protected files. It already consumes the
library correctly; this section records what is still unconsumed and how it should be
used, so a future change does not invent a second structure.

| Need | Structure | Status / constraint |
|---|---|---|
| Token stream with lookahead/rewind | `TokenStream` | in use in `text/tokenizer.ts`; copy-on-construct, O(1) peek/next/save/restore |
| AST, spans, iterative walks | `AstNode` / `AstTree` / `visitAst` | in use in `text/javascript.ts`, `markup.ts`, `parser.ts`, `tex.ts`; no recursion |
| Node lookup by kind/offset | `AstIndex` | not used yet; parse-service currently imports only `SourceSpan`. Snapshot O(n log n), `smallestContaining` O(log n) typical |
| Import graph, cycles, topo, levels | `DirectedGraph` | in use in `chain.ts` and `text/dependency.ts`; cycles are legal results, never exceptions |
| Symbol/path prefix lookup | `Trie` | not used yet. Path-prefix and import-specifier tables are the first real consumers; output is child-insertion order, not lexicographic |
| Sorted symbol/route index with predecessor/successor/range | `RedBlackTree` | first host consumer is `predict.numericAgreement`; a per-project symbol index is the next natural use. Do not use `BinaryTree` for large/deletion-heavy indexes |
| Large ordered in-memory index | `BPlusTree` | benchmarked at 10k keys; only adopt when an in-memory range scan is actually needed, otherwise keep SQLite indexes authoritative |
| Parser result cache | `LruList` | in use in `parse-service.ts` (path+mtime+size+parserId), `node-registry.ts`, `chain.ts` |
| Diagnostics/outline insertion order | `OrderedMap` | native `Map` is sufficient today; adopt only when `first/last/deleteFirst/deleteLast` is genuinely needed |
| Explicit parser stack / backtracking | `Stack` / `Deque` | not needed by the current recursive-descent text parsers; use only if a future grammar needs backtracking |
| Sheet cells/range | `SparseGrid` / `GridRange` | ready for P1 `sheetGrid`/`rowAt`/`columnAt`/range expansion; cache keyed by workbook hash per domain-model §6 |
| Chain projection cache invalidation | `LruList` + `graphVersion` | chain cache must key on a monotonic graph version (max identity of relation tables, or `PRAGMA data_version`); do not reuse the provider/effort/compaction caches |

Constraint carried forward: no AST, graph, tree, LRU, Trie or SparseGrid is serialized
into a model-facing tool result. Tool output stays a bounded read-only projection with
handles, relation kinds, status and an explicit `truncated` flag. All structures in
this pass are host-only.

## 7. Files changed

| File | Change |
|---|---|
| `src/host/token.ts` | `hashString` import + one-line `hashKey`; `LruList(256)` memo; `BinaryHeap` ranking with zero-token early-stop rule; comments/complexity table updated |
| `src/host/comprehension.ts` | `unique()` → `OrderedSet` |
| `src/host/emotion.ts` | `unique()` → `OrderedSet` |
| `src/host/permission.ts` | `Queue<string>` command tokenizer/parser; `normaliseGrant()` → `OrderedSet` |
| `src/host/predict.ts` | `numericAgreement()` → `RedBlackTree` predecessor/successor + finite guard + monotonicity rationale |
| `test/data-structure-adoption.test.ts` | new: 14 equivalence/cap/benchmark tests |
| `docs/data-structure-adoption-v24.md` | new: this report |

No DB schema, public method signature, error wording, row order or model-facing value
changed. No shared file was edited; `package.json` was not touched.

## 8. Verification commands

```
npm run typecheck    # tsc -p tsconfig.json --noEmit        -> clean
npm run test:tsc     # tsc -p tsconfig.test.json --noEmit   -> clean
npm run test:build   # focused bundle build                 -> green
node --test .tmp/test-build/data-structure-adoption.test.mjs # 14/14 pass
npm test             # full suite                            -> 451 tests, 450 pass, 1 skipped, 0 fail
npm run build        # tsdown host + client                   -> green
```

The build prints pre-existing MUI `"use client"` module-directive warnings; they are
dependency notices, not failures or changes from this pass.

## 9. Remaining opportunities and risks

- **Wide-budget `selectContext`:** the 20k measurements are noise-dominated on a
  loaded machine; there is no universal wall-clock win over V8's native sort. The heap
  stays for the budget-limited stop and the exact total order, not for a measured
  constant-factor victory (recorded in §3.3).
- **32-bit hash collisions:** unchanged in kind. The memo and dedupe signatures are
  performance heuristics and cannot change a correct answer; no security use.
- **No BPlusTree/SparseGrid production consumer yet:** both are benchmarked/tested
  and mapped in §6. Adopting them now would duplicate SQLite's indexed reads or invent
  a sheet module that does not exist.
- **Resource `baseEdges`:** still bounded only by versions written per process
  (rejected LRU). A persisted `base` column remains the correct long-term fix; that is
  a schema change, out of scope.
- **Marker regex compilation:** repeated `new RegExp` per marker per call remains in
  the large lexicons. A fixed marker→RegExp table would remove it without a new data
  structure; deferred to keep this pass focused.
- **Concurrent docs:** the settings-catalog and feature-wiring agents own
  `docs/settings-catalog-v24.md` and `docs/feature-wiring-audit-v24.md`; this report
  does not modify them or any README.
