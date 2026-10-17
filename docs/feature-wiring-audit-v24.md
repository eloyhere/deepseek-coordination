# Feature wiring audit v24 — what v0.7–v0.9 shipped, what an agent can reach

Status: complete. Scope: audit every feature added in releases **0.7.0**, **0.8.0** and
**0.9.x** (plus the v0.9.1/v0.9.2 follow-ups) against the runtime, then wire the
missing pieces so the model can actually use them. This document is the evidence
record for that work; it is not a design change. Line numbers are from the working
tree at audit time (2026-10-18) and can drift by a few lines after edits.

Verification after the full 0.10.0 milestone (see §7): `tsc` clean, `npm test`
**473 tests, 472 pass, 1 skipped (GC-only), 0 fail**, `tsdown` host + client
green.

## 1. Method

1. Read the release map and per-release entries in `CHANGELOG.md` (v0.7–v0.9.2).
2. Walked the source for every named feature: composer client, host modules,
   HTTP routes, takeover gate/dialog, token governor/compaction, settings page,
   tool registry, P0 parser, shared data structures.
3. Read the three v24 documents (`domain-model-v24.md`, `file-processing-v24.md`,
   `complexity-audit-v24.md`) and treated them as the *contract*, not as proof of
   implementation: several concepts are "design only" and are marked so below.
4. Built the missing runtime path tool-first (parse service → node registry →
   chain engine → tools) and wrote `test/feature-wiring.test.ts` against it.
5. Checked every negative guarantee separately: no body in parse/describe/chain,
   no AST/graph serialization, traversal/binary refusal, explicit truncation,
   bounded caches, typed errors.

## 2. Status vocabulary

| Column | Meaning |
|---|---|
| **Implemented** | The code exists and behaves as the document describes. |
| **Wired** | A host/service path actually calls it (not only an exported function). |
| **Agent** | Reachable by the model through a tool (or only through the UI/routes — marked). |
| **Tested** | Covered by a committed test at the cited file:line. |
| **Gap** | What is still missing, and where it would have to change. |

## 3. Release-surface audit (v0.7–v0.9)

| # | Feature (release) | Implemented | Wired | Agent | Tested | Evidence and gaps |
|---|---|---|---|---|---|---|
| 1 | **Five dropdowns** — profession / interaction / scene / validation / permission (0.7) | yes | yes | UI | yes | Client: `src/client/controls.ts:1176` (`ComposerControls`), slot at `src/client/index.ts:100`. Wire contract `SelectionState`/`SelectionPatch` in `src/shared/selection.ts:110`, project in `src/host/selection.ts:94`. `test/integration.test.ts:95`, `:537`. |
| 2 | **Profession lock** (0.7) | yes | yes | yes (tool) | yes | `src/host/profession.ts:36`, `:44` (lock check), `:79`; selection route bodies `src/host/selection.ts:619`, `:655`; tool `coordination_profession` in `src/host/tools.ts:384`; `test/integration.test.ts:466`, `:508`. |
| 3 | **Config / selection routes** (0.7, extended 0.8/0.9) | yes | yes | routes (UI + client) | yes | Routes in `src/index.ts`: `/selection` `:233`/`:243`, `/presets` `:255`, `/permission` `:260`, `/locale` `:367`, `/state` `:427`, `/config` `:394`/`:399`, `/config/compaction` `:378`, `/profession/rebuild` `:334`, `/profession/abandon` `:352`; client bridge `src/client/bridge.ts:482`, `:516`; `test/integration.test.ts:176`, `:221`. |
| 4 | **Takeover approval/question gate** (0.8) | yes | yes | routes (human decides) | yes | `src/host/takeover-gate.ts:85`, `install` `:113`, waterfall subscriptions `:130`/`:132`, pending `:150`, answer `:164`; service methods `src/host/coordination.ts:269`, `:275`; install effect `src/index.ts:190`; routes `/takeover/*` `src/index.ts:272`–`:323`; `test/takeover-gate.test.ts:134`–`:231`. |
| 5 | **Takeover dialog** (0.8) | yes | yes | UI | yes | `src/client/takeover.ts:319` (`TakeoverDialog`), approval/question forms documented `:2`–`:22`; polling/queue in `src/client/index.ts:100`; `test/takeover.test.ts`. |
| 6 | **Auto compaction + TokenGovernor** (0.8) | yes | yes | host lifecycle | yes | `src/host/token.ts:711` (`TokenGovernor`), `estimateTokens` `:237`, `selectContext` `:469`, `shouldCompact` `:626`, `normaliseCompactionPatch` `:649`; pre-step hook `src/index.ts:164`/`:173`; `maybeCompact` `src/host/coordination.ts:338`; policy patch `:323`; bounded compaction state `src/host/compaction-state.ts`; `test/token.test.ts`, `test/complexity-adoption.test.ts:465`. |
| 7 | **Settings page** (0.8 rewrite) | yes | yes | UI | yes | `src/client/settings.ts:449` (`CoordinationSettings`), groups `:705`/`:797`, catalog import `:46`; slot `src/client/index.ts:91`; copy in `src/shared/i18n.ts` (settings groups). |
| 8 | **Composer tools** — `coordination_selection`, `coordination_profession`, `coordination_professionlock` (0.8) | yes | yes | yes | yes | `src/host/tools.ts:326` (`coordinationToolDefinitions`), `:353` (`registerCoordinationTools`), definitions `:384` (`coordination_profession`), `:447` (`coordination_professionlock`), `:495` (`coordination_selection`); localized copy `src/shared/i18n.ts:401` (`ToolName`), `:722`/`:1492`; registration `src/index.ts:202`; `test/integration.test.ts:398`, `:436`. |
| 9 | **P0 parser + dependency graph** (0.9) | yes | partial → **wired now** | yes (new) | yes | Entry points `src/host/text/index.ts:53`/`:64`/`:103`; caps `src/host/text/parser.ts:39`–`:45`, `:579`; registry `:1587`; source map `:734`; body-free metadata `:1117`; JavaScript `src/host/text/javascript.ts:155`, `:248`; markup `src/host/text/markup.ts:257`/`:423`/`:621`; TeX `src/host/text/tex.ts:411`; formulas `src/host/text/formula.ts:456`; graph `src/host/text/dependency.ts:169`/`:266`/`:278`; cache `src/host/text/cache.ts:46`; `test/text-parser.test.ts`. **Gap before this change:** nothing called the parser outside tests (`src/host/text/index.ts:10` said so); now `src/host/parse-service.ts` does. |
| 10 | **Shared data structures** (0.9) | yes | yes (consumed) | n/a | yes | `src/shared/lru.ts:56`, `src/shared/graph.ts:31`, `src/shared/trie.ts:38`, `src/shared/ast.ts:268`/`:399`/`:511`, `src/shared/map.ts:30`, `src/shared/redblack.ts:37`, `src/shared/heap.ts:27`, `src/shared/grid.ts:143`, `src/shared/stack.ts:31`; `test/data-structures.test.ts`, `test/data-structures-ast.test.ts`, `test/complexity-adoption.test.ts`. New consumers: `LruList` in the parse cache/node registry/chain cache, `DirectedGraph` in the chain engine. |
| 11 | **Domain model v24** (0.9, design) | doc only | no | no | no (doc) | `docs/domain-model-v24.md:1`; the SQLite `node`/`edge`/`snapshot` schema at §2.8 (`:424`) is **not** created by `src/host/database.ts`. Everything the domain model calls persistent (Project/Module/Document/Book/Article/Chapter/Section/Paragraph/Sheet/Cell/Range/Formula/Statement/Condition/Sign/Person/Venue) has no table, no store and no query API. What exists is the in-memory parse projection + chain projection described in §5. |
| 12 | **Book / Article** (0.9) | partial | partial → **wired now (file-level)** | yes (card/kind) | yes | Explicit detection only: Markdown front matter `form:`/`type:`/`document:` → `documentFormFromMetadata` `src/host/text/markup.ts:967`; HTML `<article>`/`<main>` `src/host/text/markup.ts:481`/`:548`; LaTeX `\documentclass` `src/host/text/tex.ts:295`–`:315`; parse-service lifts the form to the file node kind (`book`/`article`) `src/host/parse-service.ts` `fileKind`. **Gap:** no `Book`/`Part`/`Chapter`/`Article`/`Section` node kinds, no `part_of` between Article and Book, no `published_in` Venue, no `authored_by` Person, no edition baseline. Headings stay generic `heading` nodes with explicit levels. |
| 13 | **Formula** (0.9) | partial (document math only) | **wired now** | yes (chain/card) | yes | Detection/extraction `src/host/text/formula.ts:174`/`:456`, metadata `:506`, caps `:128`; Markdown/TeX formula nodes carry `kind:'formula'`; new chain builds **`references`** edges from an explicit formula label/equation/symbol reference to a node with that name/label (`src/host/chain.ts` `references` loop). **Gap:** no spreadsheet dialect (xlsx/csv/Sheet/Cell/Range), so `computes`/cell `depends`, named ranges and formula AST persistence are absent; formula AST is not serialized to the agent (by contract). |
| 14 | **Statement** family (0.9) | yes (TeX) | **wired now** | yes (card/chain) | yes | `TexStatement` `src/host/text/tex.ts:64`, environment allowlist `:101`, metadata push `:365`; parse-service exposes `structure.statements` with `label`/`proofTarget`; chain builds **`proves`** edges from an explicit `\begin{proof}` + `\ref` target (`src/host/chain.ts`). **Gap:** status rules (`stated`/`proved`/`unproved`/`proofStatus`) are not persisted or evaluated; non-TeX statement sources (Markdown fenced divs, Lean/Coq/Isabelle, Word styles) are not mapped to statement kinds; statement `status` on a card is the parse status, not the proof status. |
| 15 | **Condition / Require / Meet** (0.9) | partial | **wired now (divs only)** | yes (chain `unmet`) | yes | Explicit Markdown contract divs are parsed as `div` nodes (`src/host/text/markup.ts` div handling); chain maps `::: require` to `requires` file→condition and `::: meet` to `meets` condition→file with status `unknown` (`src/host/chain.ts`). **Gap:** no `Condition` node kind, no `condition.status`, no `@requires`/`@ensures`/`@pre`/`@post`/`@invariant` extraction in the JS parser, no `entails` graph, no `equivalent` derivation, no solver/evaluator (by contract), and front-matter `requires:`/`meets:` are exposed raw but not turned into edges (target semantics are undefined). |
| 16 | **Sign** (0.9) | no | no | no | no | The tokenizer produces `Token`s (`src/shared/ast.ts:44`, `src/host/text/tokenizer.ts`) but no parser promotes a sign to metadata, and no node kind `sign` is persisted. Domain model §5 explicitly says "only promoted signs are persisted"; nothing promotes them. **Gap:** needs a per-language promote table + cap (§7: 1,000/module, 500/document) before it is worth wiring. |
| 17 | **Chain** (0.9, design only before) | **yes (new)** | **yes** | **yes** | **yes** | New `src/host/chain.ts`: `ChainEngine` `:322`, `index` `:407`, host-only `relate` `:540`, queries `:568`–`:608`, depth/links/token caps `:64`–`:68`, node/edge caps `:72`/`:74`, `LruList` projection cache keyed by `graphVersion` + action + root + relation set + depth + limit + target, `DirectedGraph` per relation, status/staleness in `statusOf`, cycle via `findCycle`. `test/feature-wiring.test.ts:216`–`:411`. |
| 18 | **NodeCard / `coordination_describe`** (0.9, design only before) | **yes (new)** | **yes** | **yes** | **yes** | New `src/host/node-registry.ts`: `NodeCard` `:130`, deterministic handles `:90`/`:98`, bounded registry `LruList` cap 10k `:82`, `register` `:235`, `describe` `:270` (card + brief + reference + six flat fields + requested fields; missing = empty + `unverifiable`), ~1 KiB card bound. `test/feature-wiring.test.ts:126`. |
| 19 | **Read blueprint** (`FileReference` + `coordination_read`) (0.9, design only before) | **yes (new)** | **yes** | **yes** | **yes** | New `ParseService.readContent` `src/host/parse-service.ts:395`: bytes (start inclusive / end exclusive) and lines (1-based inclusive), 256 KiB / 2,000 lines / 16k tokens `:90`–`:94`, BOM excluded, NUL/binary/undecodable refusal, traversal + symlink-escape rejection, `sha256` hash. `test/feature-wiring.test.ts:413`, `:488`. |
| 20 | **Write/refresh blueprint** (`coordination_write`) (0.9, design only) | no | no | no | no | Deliberately **not** implemented; rationale in §6. The contract (`docs/domain-model-v24.md:412`, §2.7) needs `expectedFingerprint` conflict detection, transactional reparse + range recompute, explicit charset/BOM change and a file watcher/rename policy. None exists, so a writer would either overwrite concurrent edits or return stale ranges. Read-side fingerprint/staleness is wired (`describe`, chain `stale`). |
| 21 | **File-layer config groups** — `parser`, `chain`, `tools` | yes (catalog) | **partial → wired now** | transparent | yes | Concurrently added to `src/host/config.ts:144` (`ParserConfig`), `:168` (`ChainConfig`), `:179` (`ToolConfig`), `:199`–`:203` (wiring), schema defaults `:374`–`:404`; the catalog comment still says "no consumer yet". This change consumes them **structurally** from `src/host/tools.ts` (`fileLayerConfig`, `configNumber`) — no `config.ts` import, no edit. `parser.enabled=false` removes the four file tools; `parser.max*`/`chain.*` can only tighten the hard caps; `tools.maxResultBytes` is still unconsumed (`renderJson` unchanged). |

**Release 0.9.1/0.9.2** (tooltip visibility fixes) are UI-only and were not touched:
`src/client/tooltip-visibility.ts`, `src/client/controls.ts:651` cache clearing,
`test/support.test.ts`. They do not add agent-facing surface.

## 4. What this change added (deliverable 2)

| File | Purpose |
|---|---|
| `src/host/parse-service.ts` (new) | Workspace-bound parse service: `parse()` (path **or** text), LRU keyed `path+mtime+size+parserId` (shared `LruList`), 1 MiB read cap, 200k-token/2 s/20k-node budgets, charset/BOM detection, workspace-relative + `realpath` validation, metadata-only result (`NodeMetadata[]`, references, diagnostics, six flat fields, structure slice), **no body storage**; plus `readContent()` — the only content path. |
| `src/host/node-registry.ts` (new) | Bounded (10k `LruList`) registry of parsed nodes by deterministic public handle; `NodeCard` projection; `coordination_describe` data (card + brief + reference + flat fields + requested summary/description/usage/purpose + `unverifiable` list); no content. |
| `src/host/chain.ts` (new) | Host-only `ChainEngine`: `DirectedGraph` per relation + `OrderedMap`-style edge index, `LruList` projection cache keyed by `(graphVersion, action, root, relationSet, depth, limit, target)`, monotonic `graphVersion`, relations `depends`/`satisfies`/`baseline`/`prerequisite`/`requires`/`meets` (+ `proves`/`defines`/`references`/`contains`/`part_of`), status/staleness, depth ≤ 8, links ≤ 50, ~1,500 tokens, explicit `truncated`/`cycle`, projection only. |
| `src/host/tools.ts` (extended) | Four tools — `coordination_parse`, `coordination_describe`, `coordination_chain`, `coordination_read` — registered lazily per service, shared runtime, disposed with the tool registration; localized inline (EN/zh-CN) because `src/shared/i18n.ts` has no keys for them; host config read structurally for budgets/switch; no write tool. |
| `test/feature-wiring.test.ts` (new) | 13 tests: parser→registry→describe; text-only parse; dependency chain + depth order + cycle; parse-order independence; depth/link/token truncation; host relations + unmet; read bytes/lines equivalence + caps + traversal/BOM/binary; read token cap; tool shape/render/registration (7 vs 3, config switch); config tightening; no body in parse/describe/chain; fingerprint staleness; cache bounds. |
| `src/host/text/javascript.ts` (small fix) | `findFunctionBodyOpen` (`:422`) makes TypeScript **return type annotations** visible to the symbol scan (`export function f(): number { … }` was silently invisible; verified before/after with the bundled parser). No grammar expansion, no type interpretation; ambiguous forms stay `unverifiable`/invisible. |

### 4.1 Chain relation sources

| Source (explicit parser metadata only) | Edge |
|---|---|
| file references (`import`/`require`/`export-from`/CSS/HTML/Markdown/TeX `\input`) resolved lexically | `depends` (projection of `imports`, domain §3) |
| every parsed node under its file node | `contains` file→node, `part_of` node→file |
| heading levels (Markdown/HTML) | `contains` parent→child, `part_of` child→parent |
| TeX `\begin{proof}` + explicit `\ref` target | `proves` |
| Markdown `::: require` / `::: meet` | `requires` file→condition / `meets` condition→file, status `unknown` |
| formula label/equation/symbol reference naming a node | `references` |
| host/verifier `relate()` only | `satisfies`, `baseline`, `prerequisite`, host-asserted `requires`/`meets` |

`depends_on` is accepted as an input alias of the canonical `depends` name (domain
§4 forbids underscores in relations). Extensionless imports bind only to files the
engine has already parsed (`src/b` → `src/b.ts`, `src/b/index.ts`), in a fixed
extension order; a later parse adopts the earlier stub edge, so parse order never
changes the answer. No filesystem probing and no extension guessing.

### 4.2 Status and staleness

- `depends` starts `unknown` for a not-yet-parsed target, becomes `satisfied`
  when the target is indexed, and becomes `stale` when the target node's current
  fingerprint differs from the pinned `targetVersion`.
- `baseline` pins the target fingerprint in `baselineVersion`; a changed target
  makes the link `stale`.
- `requires`/`meets` from parser markers are `unknown` (unknown never
  auto-passes; they appear in `unmet`); a host `relate` may set `satisfied`/`unmet`.
- `satisfies` defaults to `satisfied` only when an `evidenceHandle` is supplied;
  otherwise `unknown`. No tool writes it.

### 4.3 Projection contract enforced in code

- `coordination_parse` returns references (≤200), diagnostics (≤100), cards
  (≤100), counts + explicit `*Truncated` flags. No body.
- `coordination_describe` returns card + brief + reference + flat fields +
  requested fields; missing fields are `''` and listed in `unverifiable`.
- `coordination_chain` returns `ChainProjection` only: links with
  handle/relation/status/depth/locator, `truncated`, `cycle`, `version`,
  `counts`. No AST, no adjacency, no graph object.
- `coordination_read` is the only value with `content`; it is capped, hashed and
  refuses NUL/undecodable content and traversal/symlink escapes.

## 5. Remaining gaps (historical audit)

> This section records the state at the time of the v0.9 wiring pass. Items 1–3
> and 5 have since been advanced by `docs/persistence-v24.md` and
> `docs/domain-extraction-v24.md`; read those for the current limits.

1. **Persistence (now schema 24).** The `node`/`edge`/`snapshot` tables exist and
   the registry/chain rehydrate by durable handle; rehydration is bounded
   (newest 10k nodes / 50k edges) and removed symbols are not pruned.
2. **Book/Article hierarchy, Person/Venue, Chapter/Section/Paragraph nodes** —
   parser-level extraction now exists; `partOf`/condition edges are not yet
   projected through `coordination_chain`, and cross-file Book composition is
   deferred.
3. **Condition nodes and contract tags** — parser-level Condition nodes and
   `@requires`/`@ensures` extraction exist; condition status is not evaluated and
   the chain still projects only explicit div edges.
4. **Sign promotion** — tokens are lexed, no sign is promoted/persisted.
5. **Spreadsheet/office parsing** — no xlsx/csv, Sheet/Cell/Range,
   `computes`/cell-`depends`; document formulas only.
6. **Statement status evaluation** — parser extracts statements/proofs; the
   `stated`/`proved`/`unproved`/`axiomatic`/`unverifiable` rules and
   `proofStatus` are not computed or stored.
7. **`coordination_write` / `coordination_refresh`** — see §6.
8. **No `outline`/`findSymbol`/`searchSummary`/`commentsOf` tools** — the query
   API is a document, not code; only the chain/describe surface is wired.
9. **Topological order is not a chain action** — dependencies are ordered by
   `depth`; a dedicated `topological` action would need a new action + schema.
10. **`tools.maxResultBytes`** — still unconsumed: `renderJson` emits the whole
    projection. The four new values are bounded by construction, but a generic
    byte cap needs a renderer change (and a decision on truncation format).
11. **Shared i18n keys** — the four new tools carry inline EN/zh-CN copy because
    `src/shared/i18n.ts` (`ToolName` `:401`, `ZH_TOOLS` `:722`, `EN_TOOLS`
    `:1492`) has no entries. Adding them requires editing that file (owned by the
    settings-catalog workstream during this change).
12. **Workspace root** — the runtime uses `process.cwd()` when the service does
    not expose `workspaceRoot`; DSH's actual workspace root is not plumbed into
    `registerCoordinationTools` by `src/index.ts`. This is the documented
    limitation: a host whose cwd is not the workspace must pass a root through
    the tool options.
13. **`parser.enabled` is read at registration time** — toggling it through
    `POST /config` changes the resolved config but not the already-registered
    tool set until the next re-registration (today only `/locale` triggers that).

## 6. Why there is no write tool

The v24 write contract (`docs/domain-model-v24.md:412`, §2.7) is optimistic and
transactional: the caller supplies `expectedFingerprint`; a mismatch (or an
implicit charset/BOM change) returns `CONFLICT` and writes nothing; after a write
the host re-reads/reparses and recomputes every affected fragment's
byte/line ranges and fingerprint; inserts/deletes before a fragment shift ranges
while the fingerprint stays stable; a cached handle whose fingerprint no longer
matches is `stale` and must be refreshed. Implementing that safely needs:

1. a **file watcher or an exclusive read-modify-write** (open, verify fingerprint,
   write temp file in the same directory, fsync, rename) so two agents cannot
   interleave;
2. a **transactional reparse window** that recomputes the registry cards and
   invalidates the chain cache only after the new content is durable;
3. an explicit **charset/BOM policy** (changing either invalidates every
   fragment);
4. routes/tools for `coordination_refresh` and a conflict error surfaced as
   `CONFLICT`.

None of the three exists, so shipping a writer would risk silent data loss. The
read/fingerprint half is wired: every card/describe/read returns host-computed
`fingerprint` and ranges, chain links expose `stale`, and the registry updates a
handle's fingerprint on reparse. The missing half is recorded here rather than
approximated.

## 7. Verification

```
npm run typecheck   # tsc -p tsconfig.json --noEmit        -> clean (exit 0)
npm run test:tsc    # tsc -p tsconfig.test.json --noEmit   -> clean (exit 0)
npm test            # tsdown test build + node --test      -> 473 tests, 472 pass,
                    #                                        1 skipped (--expose-gc), 0 fail
npm run build       # tsdown host + client bundles          -> green (exit 0)
```

Baseline before this change was 389 tests / 388 pass / 1 skip. This workstream
adds 13 tests in `test/feature-wiring.test.ts`; the 0.10.0 run also includes
17 settings-catalog/integration tests and 14 data-structure adoption tests
from the other workstreams (433 total).

Cross-workstream follow-up (resolved after the wiring change): the six module
tests with hand-written config literals (`command`, `comprehension`,
`orchestration`, `plan`, `provider`, `resource`) now carry the required
`ui.locale` field and the `compaction`/`parser`/`chain`/`tools` groups, plus
`scenes: SceneProfiles` where the literal omitted it. `npm run test:tsc` is
clean again; `npm test` was unaffected throughout.

## 8. Files owned by this change

- `src/host/parse-service.ts` (new)
- `src/host/node-registry.ts` (new)
- `src/host/chain.ts` (new)
- `src/host/tools.ts` (extended: four tools + lazy runtime; three existing tools unchanged)
- `src/host/text/javascript.ts` (one small fix: TS return-type annotations in the
  function symbol scan; no parser rewrite)
- `test/feature-wiring.test.ts` (new)
- `docs/feature-wiring-audit-v24.md` (this document)

Not edited (owned by the concurrent settings-catalog workstream): `src/index.ts`,
`src/host/config.ts`, `src/host/selection.ts`, `src/shared/selection.ts`,
`src/shared/i18n.ts`, `src/client/**`, other docs.
