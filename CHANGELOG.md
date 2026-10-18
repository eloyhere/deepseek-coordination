# Changelog

[中文](CHANGELOG.zh-CN.md) · English

All notable changes to this repository are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Scope note.** The repository was reshaped twice in October 2026: `87ddab9` replaced the
> dsh-os tree with a standalone Vite application, and `0.2.0` replaced that with the current
> DSH plugin bundle layout. Entries from `0.1.9` downwards describe **dsh-os**, a cross-platform
> atomic OS-interaction surface, which is no longer on the branch tip but remains reachable in
> git history and tagged `v0.1.5` … `v0.1.9`; see
> [Repository history](README.md#repository-history-and-license). `Auto-commit: typecheck-passing snapshot`
> commits are internal checkpoints, not releases.

## Release map

| Version | Date | Commit | Summary |
|---|---|---|---|
| 0.14.2 | 2026-10-18 | `5b5fdf8` | Client bundle no longer requires Node builtins |
| 0.14.1 | 2026-10-18 | `c5f333b` | Panel error containment, lazy panel module, escape hatch |
| 0.14.0 | 2026-10-18 | `429d05e` | Read-only workspace & relationship panels, canvas graphs, preview matrix, agent roster, cache-strategy wiring |
| 0.13.0 | 2026-10-18 | `83d3601` | First-class `interface`/`type`/`enumeration`/`namespace` kinds across TS, Java, Rust and PHP |
| 0.12.0 | 2026-10-18 | `84af8b8` | Domain ecosystems: tex, book, markdown, html, languages, office, package managers; kind filter and directory layer |
| 0.11.0 | 2026-10-18 | `19bfedf` | Durable settings, DSH-owned reasoning, cache proxy and brand profiles, dialog and label fixes |
| 0.10.0 | 2026-10-18 | `8a8d0f7` | Settings catalog, durable file layer, turn pipeline, phase freeze, data structures, installable package |
| 0.9.2 | 2026-10-18 | `73a273d` | One dropdown tooltip at a time |
| 0.9.1 | 2026-10-18 | `31f64da` | Restore working dropdown tooltips |
| 0.9.0 | 2026-10-18 | `ad7d59f` | Shared algorithms, blueprint model, P0 parser, global tooltip host |
| 0.8.0 | 2026-10-18 | `bef97b1` | Auto-compaction, service-level takeover, TokenGovernor, settings rewrite |
| 0.7.0 | 2026-10-17 | `8c196ce` | Five dropdowns wired to the workflow, tooltips, i18n, v24 writing scene |
| 0.6.5 | 2026-10-17 | `81b6296` | low/medium/high selector |
| 0.6.4 | 2026-10-17 | `118d5b7` | Workflow switch |
| 0.6.3 | 2026-10-17 | `6aa9bb9` | Permission labels aligned with the host |
| 0.6.2 | 2026-10-17 | `16a38e7` | 统筹, permission options, popover flicker fix |
| 0.6.1 | 2026-10-17 | `dce5374` | Browser `process` crash fix |
| 0.6.0 | 2026-10-17 | `2a33ef0` | Material UI migration |
| 0.5.0 | 2026-10-17 | `d318be5` | MDUI out, plain React in |
| 0.4.0 | 2026-10-17 | `bf32401` | Angular out, MDUI 2 in |
| 0.3.0 | 2026-10-17 | `c118132` | Angular Elements UI and permission takeover |
| 0.2.0 | 2026-10-17 | `2b977cf` | Repository becomes a DSH plugin bundle |
| 0.1.9 | 2026-10-13 | `3ba4a45` | String target read as wildcard |
| 0.1.8 | 2026-10-13 | `8ee68dd` | Stored permission rules enforce; approval seam |
| 0.1.7 | 2026-10-13 | `0a2c2c0` | Activation faults from 0.1.5/0.1.6 |
| 0.1.6 | 2026-10-13 | `42ff514` | Tool description names the tool |
| 0.1.5 | 2026-10-13 | `b29c0e3` | `workflow_plan` and measured prefix cache |
| 0.1.2 | 2026-10-13 | `e4fade7` | Permission commands without `permission.json` |
| 0.1.0–0.1.1 | 2026-10-13 | `c2dae0c` | dsh-os initial publication and README rewrite |


## [Unreleased]

## [0.14.2] — 2026-10-18

### Fixed

- **The client bundle no longer requires Node builtins.** `vfile` (pulled in by
  `react-markdown`) imports `node:path`, `node:process` and `node:url` from its
  Node entry and does not publish browser variants through `exports`, so the
  bundler externalised them. DSH's client module table only serves registered
  package ids, so the whole web boot aborted with
  `client-modules: require("node:process") missed the module table`. Three tiny
  browser shims (`src/client/shims/node-{path,process,url}.ts`) are now aliased
  in the client build; the bundle contains no `require("node:*")` and the
  factory only asks the module table for `react`.

## [0.14.1] — 2026-10-18

### Fixed

- **A failing panel can no longer blank the harness.** Both panels, the fixed
  column and the preview subtree are wrapped in error boundaries that render
  `null`, log one `[coordination] panel failed` line with the component stack,
  and surface a small "Panel crashed" chip in the title bar. `panel.ts` is loaded
  through `React.lazy` (with `codeSplitting: false`, so the client stays a single
  file and the module body still runs lazily), which contains failures that
  happen while a dependency is being evaluated.
- **Escape hatch without a reinstall.** `localStorage['coordination.panel.disabled']
  = '1'` mounts nothing.
- **Diagnosability.** `error` and `unhandledrejection` are logged with a
  `[coordination]` prefix; the preview markdown/KaTeX/Prism/DOMPurify stack is
  lazy so it cannot break the initial panel render.

### Changed

- **Release layout note:** the client bundle must remain a single `lib/client.js`
  because the DSH client loader resolves registered ids only and the tarball ships
  one client file.

## [0.14.0] — 2026-10-18

### Added

- **Two read-only workspace panels docked to the right.** A relationship panel
  (files / agents / dependencies / imports / exports) and a workspace panel
  (files / outline / dependencies / imports / preview) share one shell: a tab
  bar with menu, search and minimize/restore, a card body routed by hash
  (`#coordination/panel/right/<view>?path=…`), and flex-based stacking where
  restoring one pushes the other. Both persist only
  `{ openLeft, openRight, width }`; minimized panels keep a 48px title bar and
  there is no floating button.
- **Canvas relationship graphs.** Native 2D canvas with deterministic circular,
  layered and star layouts, directional dash flow, cycle pulsing, hover
  highlighting with a self-drawn tooltip, edge/node hit-testing, click selection,
  wheel zoom, drag-pan, keyboard traversal, and a text alternative. Colours come
  from the MUI theme; `prefers-reduced-motion` renders statically.
- **Preview matrix.** Markdown/GFM with `remark-math` + `rehype-katex`, sanitized
  HTML and `docx` HTML through DOMPurify, Prism-highlighted code (MUI-derived
  theme), plain text, `xlsx` sheets as tables, `pptx` slides as cards. All
  previews are read-only; 64 KiB / row / slide caps surface as `truncated`.
- **Agent roster.** The relationship panel lists the main agent and its
  subagents with objective, status, and an **estimated** progress ring
  (`completed` / `turns` / `unknown`), plus an overall progress bar; clicking an
  entry opens a read-only transcript page.
- **Workspace graph routes.** `GET /graph/tree|outline|dependencies|imports|
  search|preview|intra|agents` and `GET /graph/agents/messages`, plus
  `POST /graph/rebuild`. Queries take an optional `path` scope and an optional
  `kind` filter; dependencies report SCC-based cycles without dropping edges.
  `preview` and `agents/messages` are the only body-bearing routes: bounded,
  `no-store`, never logged or cached.
- **Two-level cache and cycle detection.** L1 per request, L2 keyed by graph
  version + scope + path (capacity 512, FIFO, bodies never cached); iterative
  Kosaraju SCC keeps cycle detection stack-safe.
- **Cache strategy table.** `src/host/cache-strategy.ts` ships 18 presets over 10
  brand + 5 model + 3 agent rows with 18 cited sources; `presetFor()` is wired
  into the proxy for normalize gating and exposed as `status.cacheStrategy`.
- **Proxy service extraction and measurement.** `createProxyService()` owns
  install/status/trace/adapter; `status` now reports `mode`, `upstreamProvider`,
  `metrics { inputTokens, cachedInputTokens, hitRate, window }`, `prefix
  { current, stable, changes }` and `cacheStrategy`. New trace events `compat`,
  `prefix` and `prefix-churn` are structural only.

### Changed

- **Default proxy mode is `measure`.** Enabling the proxy no longer rewrites
  requests; `normalize` requires `proxy.mode`, `proxy.rewrite` or
  `DSH_COORDINATION_PROXY_REWRITE=1`. This makes the baseline observable first.
- **`effortBreaksCache` is tri-state.** No fetched vendor source documents that
  reasoning effort changes the cache key, so every profile reports `'unknown'`
  with `effortEvidence: 'assumed'` instead of a guessed boolean; unknown is never
  read as `false`.
- **`<article>` is a sectioning container in HTML.** HTML/Markdown never emit the
  literary `article`; only the book parser does.
- **License is Apache-2.0** (was MIT).
- **`react-rnd` was removed** after the docked-layout rework.

### Fixed

- **Web-search account fallback under a routed conversation** (host-side):
  recorded route ids no longer defeat the account token; patched in the app asar
  with backup and rollback scripts. Cache and proxy code untouched.
- **`import`/`require` references were dropped** when a declaration skipped its
  initializer, and `handleDeclaration` crashed on a raw token index.
- **Stale parser assertions** now match the new kinds; the public export
  allowlist pins every new module.

## [0.13.0] — 2026-10-18

### Added

- **First-class declaration kinds.** `interface`, `type`, `enumeration` and
  `namespace` join `NodeKind`, and the parsers stop folding them into broader
  kinds:
  - TypeScript: `interface` → `interface`, `type` alias → `type`,
    `enum`/`const enum` → `enumeration`, `namespace`/`module` → `namespace`.
  - Java: `interface` and `@interface` (label `annotation`) → `interface`,
    `enum` → `enumeration`; `record` stays `class` with `label: 'record'`.
  - Rust: `enum` → `enumeration` (label `enum`); `struct`/`trait`/`impl` keep
    `class` with their labels.
  - PHP: `interface` → `interface`, `enum` → `enumeration`; `trait` stays
    `class` with `label: 'trait'`.
- **`enum` remains in the union as a documented legacy spelling** — no parser
  emits it, so old data cannot silently collide with the precise kind.

### Changed

- Declaration locators and reference targets now derive from the mapped kind
  (for example `java:interface:Runner`, `java:enumeration:Mode`), so a handle is
  stable per declaration kind rather than per coarse group.

## [0.12.0] — 2026-10-18

### Added

- **A domain-concept layer, split by ecosystem.** `src/host/text/` ships one parser
  per system, each mapping onto body-free `NodeMetadata`:
  - **tex** — `calculation`/`computation`/`derivation` statements; an explicit
    condition scanner (`\requires`, `\meets`, `\necessary`, `\sufficient`,
    `\adequate`, `\invariant`, `\assumption`, `\hypothesis`, `\guard`,
    `\constraint`, `\goal`). `relation` is set **only** by `\requires`/`\meets`.
  - **book** — `SUMMARY.md` tables of contents (`part`/`chapter`/`section`) and
    front matter (`type: book|article`, `author`→`person`, `venue`). `article` is
    produced **only** here.
  - **markdown** — `chapter` from a level-1 heading, one `link` per link/image,
    one body-free `code` per fenced block, unconditional `document`.
  - **html** — `link` for `a`/`img`/`link`/`script`, `code` for `pre`/`code`;
    `<article>` is a sectioning container mapping to `section`/`document`, never
    to the literary `article`.
  - **javascript/typescript** — `variable` nodes (destructured bindings
    included), `binding`/`scope` (`global|local|static`), and TS `interface`,
    `type`, `enum`, `namespace`.
  - **java**, **python**, **c/c++**, **rust**, **php** — one lexical parser each,
    emitting `importation` references, types, functions/methods and file-scope
    variables; `struct`/`trait`/`implementation`/`interface` nuance lives in
    `label`, not in new kinds.
  - **maven** / **npm** — `project`, `module`, `dependency`, `parent`, `script`
    from `pom.xml` and `package.json`, matched by exact file name.
  - **office** — bounded ZIP + OOXML readers for `docx` (`document`, `chapter`,
    `section`, `link`), `xlsx` (`workbook`, `sheet`, `range`, `formula`),
    `pptx` (`document`, `slide`); `pub`/`accdb` return an explicit
    `unsupported-format` diagnostic instead of guessing.
  - **text** — `sentence` segmentation and `line` ranges (coordinates, not nodes).
- **`kind` filter on `coordination_chain`.** Every node-returning action accepts
  an optional `kind` (trimmed, case-insensitive); a filter narrows traversal and
  returns an empty list rather than an error. Copy landed in both locales.
- **Directory layer.** Indexing `pkg/src/a.ts` creates `directory` nodes for `pkg`
  and `pkg/src` with `contains`/`part_of` edges, idempotent by handle and derived
  only from unambiguous workspace paths.
- **`NodeRecord`** (`src/shared/node-record.ts`): the canonical body-free record
  `{ path, charset, byte:{start,end}, line:{start,end}, fingerprint, dirty,
  summary, brief, description, reference, purpose, children }`, with `number`
  coordinates, a wire round-trip, and a caller-supplied inline depth limit.
- **New dependencies**: `fflate` and `fast-xml-parser`, bundled into the host and
  client artifacts (no runtime `require`).

### Changed

- **Direction invariant.** `part_of` (child→parent) is written only from proven
  evidence; `contains` (parent→child) is best-effort and may be partial. Generic
  `path`/`cycle` traversals skip directory endpoints unless a relation is named.
- **`SUMMARY.md` resolves to the book parser** through the registry's
  filename-first rule; `README.md` and other Markdown stay with Markdown.
- **`TexStatementKind` is an alias of `StatementKind`**, so the parser and the
  enum cannot drift.

### Fixed

- **Dynamic imports and `require` were dropped** when a declaration skipped its
  initializer; a bounded re-scan over the skipped token range restores them.
- **A crash in `handleDeclaration`** (raw token index used as a `sig` index) broke
  files with enough leading whitespace; spans now use the correct position while
  symbols keep the raw token index.
- **`test:tsc` fixture types** (nameless permission preset, `current()` returning
  `undefined`, `Forwarded` missing `model`/`temperature`) are corrected without
  weakening assertions.
- **Stale assertions across the parser suite** now match the new semantics: HTML
  never yields `article`, Markdown `#` always yields `chapter`, and the public
  export allowlist pins the new modules (including an intentionally empty class
  list for `node-record.ts`).

## [0.11.0] — 2026-10-18

### Added

- **Durable settings.** The page persists through the host's own override document
  `<database dir>/config.overrides.json`: a flat `{ "plan.threshold": 0.7 }` map
  written atomically beside the coordination database and merged over the profile
  config on the next start. `POST /config` reports `persisted: true` only when that
  document holds the applied paths. DSH's `ctx.settings.update` is deliberately not
  used — it accepts only `.volatile()` schemas, and a volatile node turns every
  parsed value into a reference wrapper this host cannot adopt.
- **Brand-aware cache profiles.** `src/host/model-brand.ts` classifies the host's
  `resolveModelInfo` identity (provider + model + display name + description) onto
  DeepSeek, OpenAI, Anthropic, Google, xAI, Moonshot, Qwen, Zhipu, Mistral, Meta or
  a conservative unknown profile. Each profile carries `automaticPrefixCache`,
  `explicitCacheBreakpoints`, `minPrefixTokens`, `effortBreaksCache` and
  `stripVolatileHelps`; an explicit-breakpoint family reports no local lever
  instead of pretending one exists.
- **Experimental cache proxy.** An opt-in provider adapter (`coordination-proxy`),
  registered through `ctx.llm.registerAdapter`, forwards each frozen request to the
  real provider after rebuilding it — the only point where the request is still an
  input. `GET /proxy/status` exposes counts and identities only.
- **Release scripts**: `upgrade.ps1` (version bump), `deprecate.ps1` (registry
  deprecation) and `publish.ps1`.

### Changed

- **Reasoning belongs to DSH.** `beginTurn` no longer seeds `scene.reasoningEffort`;
  the turn records what the session's own `requestHeader().config.reasoningEffort`
  carries, and the pipeline no longer reports effort/thinking as deferred gaps.
- **Every numeric control is a number field.** `Slider` is gone; weights and ratios
  use a `TextField type="number"`, and display is rounded to the row's `step`
  (0.01 → two decimals) while the wire keeps exact values.
- **The full-access confirmation is a modal.** An MUI `Dialog` above the tooltip
  layer replaces the inline banner that fought with tooltips and stole pointer
  events from the trigger.
- **The package manager is npm again.** `pnpm-lock.yaml` and
  `pnpm-workspace.yaml` are replaced by `package-lock.json` (lockfile v3); the
  release workflow installs with `npm ci` and caches with `cache: npm`; the
  README commands are `npm ci`, `npm run build`, `npm test` and `npm pack`. The
  pnpm `allowBuilds` allowlist is no longer needed, because npm runs install
  scripts by default.
- **`react-dom` is declared.** Material UI peers on `react-dom`, and npm's
  strict peer resolution refused to auto-install a React 19 `react-dom`
  against the React 18 `react` the module table provides. `react-dom@^18.2.0`
  is now a dependency, so the client bundle inlines the matching React 18 line.
- **The DSH peer range tracks new releases.** `^0.1.0-rc.7 || >=0.2.1-rc.2`
  replaces `^0.1.0-rc.7 || ^0.2.0-rc.0`, which cannot match `0.2.1-rc.2`: a
  SemVer range admits a pre-release only when some comparator repeats its
  `major.minor.patch` with a pre-release of its own, so `^0.2.0-rc.0` stops at
  0.2.0. The client half now compiles against the 0.2.1-rc.2 `-locale`,
  `-ui-settings`, `-ui-slots` and `-ui-conversation` packages the desktop
  runtime ships; `-ui-slots` no longer sits on the 0.1 line and
  `-ui-conversation` is no longer pinned to 0.1.0-rc.8.
  `@deepseek-ai/dsh-client-runtime` and `@deepseek-ai/dsh-host-webserver`
  publish no 0.2.x release, so their devDependencies stay at 0.1.0-rc.8 — a
  0.2.1 `host-webserver` makes the 0.1-line `dsh-client-connection` peer range
  unresolvable, so `npm ci` fails — while their peer ranges still accept the
  0.2.1+ runtime the host provides.

### Fixed

- **Settings writes failed for every row.** `persistConfig` read `ctx.settings`
  without injecting it, tripping Cordis's proxy guard; every `POST /config`
  answered 500. The port is resolved defensively, and persistence now goes through
  the override document.
- **The takeover gate never saw a request.** Both waterfalls were subscribed
  without `{ prepend: true }`, so DSH's own approval/question UI claimed them
  first. (`approval/request` is additionally rejected before the waterfall when the
  deployment approval policy is `never`.)
- **Permission labels showed raw keys.** A catalog returning `name` equal to
  `value` short-circuited the label fallback, so the dropdown showed `read-only`
  instead of 仅可查看. A name identical to the key is now treated as "no label".
- **The proxy adapter could not register.** The plain adapter object lacked
  `providerRetryPolicy`, `imageRequestPricing` and `imageRequestTarget`, which
  `registerAdapter` calls while validating a route. All four hooks are implemented
  and covered by a regression test.
- **Decimal noise in the settings page.** Renormalised weights printed
  `0.15000000000000002`; numbers are now rounded per row step for display only.

### Security

- The cache proxy holds no transport and no credential: it forwards through
  `ctx.llm.stream`, never reads `ctx.credentials`, and the module has no `fetch`,
  `http`, `https`, `net` or `WebSocket` surface. Tracing is structural only
  (provider, model, brand, counts, sizes), refusals name the route only, and only
  `deepseek*` providers are intercepted. Static-invariant tests scan the sources
  for forbidden surfaces.

## [0.10.0] — 2026-10-18

The settings surface, the file layer, the data-structure adoption pass and the
release packaging land together. This is the first version whose built package
is installable as a tarball; the raw `github:` source install remains
unsupported because `lib/` is not committed.

### Added

- **Settings catalog** — 151 controls in 13 groups covering all 155 non-secret
  config leaves exactly once (134 writable host rows). `GET /config` returns
  `{ values, defaults }`; `POST /config` accepts a flat dotted patch, validates
  type/range against the real Schemastery schema, applies live, re-resolves
  invariants (weight normalisation, alias mirror, forced flags, compaction
  clamps), rebuilds `TokenGovernor` when compaction changes, and best-effort
  persists via `ctx.settings.update`. Unknown keys, `databasePath` and
  `database` are rejected; forced/read-only/planned keys are reported as
  `ignored`.
- **Settings page** — MUI accordions (all default-expanded), List rows, six
  scene tables, checkbox/radio/slider/number controls, chips and a retry path.
  The profile nav row gets the Material `sync` glyph because the host shell only
  accepts `{id, order, label}` for a settings section. No composer theme change.
- **File layer** — `coordination_parse`, `coordination_describe`,
  `coordination_chain` and `coordination_read`: bounded parse service, durable
  node/edge/snapshot graph (schema 24), deterministic handles that survive a
  restart, host-only chain projection and the only content-returning tool.
  Parser depth/token/time/cache and dependency-graph caps, chain budgets and
  `tools.maxResultBytes` are live and retune an existing runtime; parser.enabled
  still gates registration. The workspace root comes from the tool option,
  service, host or sandbox policy before `process.cwd()`.
- **Turn pipeline** — normal `command=none` turns drive comprehension (using the
  turn's validation/interaction/scene), organization, plan creation/scoring and
  required Predict rows; scene policy is enforced where ports exist and deferred
  knobs are recorded as diagnostics. The pre-step hook is bounded and never
  blocks `next()`.
- **Phase freeze** — turn → profession, plan → validation, goal → interaction.
  Freezes are re-derived from the host each poll, disable the matching dropdown,
  keep it focusable with an explanatory aria-label/tooltip, and are enforced by
  `POST /selection` (`INVALID_STATE`) as well as the UI.
- **Domain extraction** — Book/Article/Part/Chapter/Section/Paragraph,
  Person/Venue, Condition, Sheet/Cell/Range, CSV/TSV, TeX proof status and
  parser-level domain metadata; body-free and additive to the P0 node model.
- **Data-structure adoption** — `LruList` memo, `BinaryHeap` selection with the
  old total order, shared `hashString`, `RedBlackTree` numeric agreement,
  `OrderedSet` first-seen dedupe and a `Queue` permission-command parser.
  Randomized reference tests and measured caveats are in
  `docs/data-structure-adoption-v24.md`.
- **Packaging** — `prepack` builds before `npm pack`; `npm run pack:check`
  verifies the four runtime files in the tarball and syntax-checks the host
  entry; a tag-triggered GitHub Actions workflow attaches the packed tarball to
  the release.

### Changed

- `parser.enabled`, all parser limits including depth/graph caps, all three
  `chain.*` controls and `tools.maxResultBytes` are writable host rows now that
  the runtime consumes them. Only `parser.enabled` still needs a re-registration
  to add/remove the tools; the other limits retune live.
- The six module-test config literals gained `ui.locale`, `compaction`, `parser`,
  `chain`, `tools` and `scenes`, so `npm run test:tsc` is clean again.

### Fixed

- Installing `github:eloyhere/deepseek-coordination` produced a five-file
  package with no `lib/index.mjs`, then failed at activation with
  `ERR_MODULE_NOT_FOUND`. The repository now ships a verified release tarball;
  raw git installs are documented as unsupported instead of failing silently.
- The `selectContext` heap has an explicit zero-token path and a randomized
  equivalence test, so it cannot strand acceptable candidates or reorder ties.
- Numeric agreement uses the exact predecessor/successor argmax proof, not an
  approximate sample; randomized brute-force comparison covers negatives and
  duplicates.

### Verification

`npm run typecheck` and `npm run test:tsc` are clean; `npm test` is **473 tests,
472 pass, 1 skipped (GC-only), 0 fail**; `npm run build` and
`npm run pack:check` (492,156-byte tarball) are green.

## [0.9.2] — 2026-10-18

### Fixed

- Two dropdown tooltips could remain on screen when an open dropdown was
  dismissed by clicking another dropdown. Each control still owns its MUI
  Tooltip and anchor (no synthetic anchor, no jitter), but a tiny
  `tooltipVisibility` store grants ownership to exactly one id; requesting
  another control closes the previous tooltip immediately. Click, selection,
  menu open, mouseout and mouseleave all release ownership, and the fade-out
  popper is pointer-transparent.

## [0.9.1] — 2026-10-18

### Fixed

- Composer tooltips disappeared and the dropdown row jittered after the global
  tooltip-host refactor. Reverted to one controlled MUI Tooltip per dropdown:
  the trigger keeps its own anchor, no fixed-position synthetic anchor is
  measured, so there is no layout loop. The first click still opens the menu
  (no state change on pointerdown/mousedown); click, selection, menu open,
  mouseout and mouseleave close the tooltip; placement is left/right; the exit
  is a 160 ms Fade and the popper is pointer-transparent.

## [0.9.0] — 2026-10-18

The plugin gains a shared algorithm library, a blueprint-only document model, and a
P0 text/dependency/import parser layer. The composer tooltips also stop overlapping
the open dropdown and now dismiss with a short fade.

### Added

- Shared data-structure library under `src/shared/`: hash/LRU, nodes, binary/B+/
  red-black trees, heaps, stack/deque/queue, ordered maps/sets/skip lists,
  AST/token stream, directed graph, trie, sparse grid. Every export documents
  time/space complexity; `docs/data-structures-report.md` is the adoption contract.
- P0 parser under `src/host/text/`: JS/TS/JSX imports/exports/require/symbols,
  CSS/HTML/Markdown references, TeX theorem/proof/label/math, generic formula
  extraction, dependency graph with topological order/cycle paths, bounded parse
  cache. Blueprint only: no body/content stored; flat `path/byteStart/byteEnd/
  lineStart/lineEnd/fingerprint/charset` metadata.
- `docs/domain-model-v24.md`: 39 concepts, 38 relations, Book/Article, Sheet/
  Formula, Statement/Condition/Require/Meet, Sign, Chain projection (host-only,
  depth ≤ 8, 50 links, ~1,500 tokens), versioned sources.
- `docs/complexity-audit-v24.md`: measured adoptions (indexed ordinal, grouped
  posterior query, batched blockedBy, bounded caches, line scanner memo).
- Tooltip UX: placement left/right, close on click/selection/mouseout/mouseleave,
  no first-click swallowing, fade-out transition, pointer-transparent popper.

### Changed

- `HashLruList`/`HashWeakLruList` are no longer exported; `lru.ts` owns the single
  canonical LRU and composes its variants. Architecture tests enforce the export
  surface, acyclic imports, and no duplicate LRU core.
- Complexity: unbounded provider/effort/compaction/selection caches are bounded;
  SQL uses indexed `MAX(ordinal)` and additive indexes; route ranking avoids N+1.
- 389 tests (388 pass, 1 GC-skip); `tsc` clean; host + client bundles build.

## [0.8.0] — 2026-10-18

Token pressure and human-in-the-loop decisions become first-class: the plugin now
asks DSH to compact when the context crosses a threshold, and intercepts approval
and question waterfalls with a React + Material UI takeover dialog.

### Added

- `TokenGovernor` ([src/host/token.ts](src/host/token.ts)): CJK-aware O(n) token
  estimation (bounded 256-entry memo), budget/threshold planning, O(n log k)
  value-per-token context selection with hash dedupe (no O(n²) MMR), EIG-gated
  retrieval, and a compaction policy. Auto-compaction calls DSH
  `compactIfNeeded('pressure' | 'context-overflow')` at `agent/pre-step` with a
  cooldown, per-session cap, timeout, and fail-safe delegation.
- `compaction` config + settings group: auto switch, 60/70/80/88% soft threshold,
  read-only hard threshold and reserve; `POST /config/compaction` hot-updates the
  live policy.
- Service-level takeover ([src/host/takeover-gate.ts](src/host/takeover-gate.ts)):
  `approval/request` and `user-questions/request` answerers, pending queue,
  `GET /takeover/pending`, `POST /takeover/answer`, `POST /takeover/cancel`.
  Timeout/abort/cancel delegates to `next()`; nothing is auto-approved.
- React + Material UI takeover dialog ([src/client/takeover.ts](src/client/takeover.ts)):
  approval (仅本次允许/拒绝/取消) and question (radio/checkbox/custom) forms,
  queue badge, focus-trapped, visibility-gated polling.
- Settings page rewritten into 7 groups / 28 rows with honest chips
  (本机/主机/强制/只读) and always-visible explanations; full-access permission
  now needs a second confirmation; `PROFESSION_LOCKED` opens a rebuild/abandon
  dialog backed by `POST /profession/rebuild` and `/profession/abandon`.
- v24 file-processing spec (`docs/file-processing-v24.md`):
  JS/TS + CSS/HTML/Markdown parsers, dependency/import graph, size and time caps.
- New `coordination_profession`, `coordination_professionlock` and
  `coordination_selection` tools, localized and re-registered on locale change.

### Verified

- `tsc -p tsconfig.json --noEmit`: clean.
- `npm test`: **263 / 263** passing.
- `tsdown`: host + client artifacts built.

## [0.7.0] — 2026-10-17

The coordination surface becomes a working host+client pipeline: the five composer
dropdowns persist through the host, a tooltip explains every control and option, and
the profession locks for the duration of a task.

### Added

- Host composition: `CoordinationService` on `ctx.coordination`, a coordination
  SQLite database, module wiring, a 60s cleanup effect, and an agent-turn lifecycle
  (`agent/pre-step` opens one locked Turn; `agent/turn-stopping` / `agent/error`
  close it).
- HTTP routes `/deepseek-coordination/{selection,presets,permission,locale,state,ping,echo}`.
  `GET/POST /selection` is the contract the composer actually uses.
- Per-scene execution policy and the v24 **写作 (writing)** scene between 对话 and
  办公: outline → draft → revision, quality score, no bash, optional web.
- All three validation levels search the web and run Bayesian prior/posterior
  updates: low 1×3 current turn, medium 2×5 current session, high 4×8 all local
  content, with high-scope global fusion.
- English/Chinese dictionaries following the DSH locale (`ctx.locale`), including
  tooltips, settings, errors and model-facing tool descriptions.
- 203 host tests (`npm test`), a shared in-memory fixture, and a `test:tsc` gate.

### Changed

- The fifth dropdown is 验证 (low / medium / high), not an ad-hoc 强度 selector.
- 情景 now has six options; the default stays 对话.
- Tooltips are on the trigger and on every option, from one shared copy source.
- The spec lives at `docs/deepseek-coordination-v24.md` (v23 + v24 revision).

## [0.6.5] — 2026-10-17

### Added

- A fourth selector after 情景: 强度, with the options low / medium / high (default medium). It
  belongs to the 工作流 group, so the switch that hides the coordination selectors hides it too.

## [0.6.4] — 2026-10-17

### Added

- A `工作流` switch in the `协调` settings page. It shows or hides the three coordination
  selectors (职能 / 交互 / 情景) in the composer tool row; off, that slot contributes nothing.
  The 权限接管 switch is independent: it still governs hiding the host's access-mode control and
  rendering the replacement dropdown. Both choices persist in `localStorage`; 工作流 defaults on.

## [0.6.3] — 2026-10-17

### Fixed

- The replacement permission dropdown offered guessed labels (只读 / 工作区可写 / 完全权限). The
  host's own menu shows 仅可查看 / 工作区内修改 / 完全权限, and the plugin now uses exactly those
  words. Only the labels are aligned: choosing an entry still dispatches nothing, because the
  `/permission` write path is exposed on `conversation.composer.bar`, not on the slot this
  plugin occupies.

## [0.6.2] — 2026-10-17

### Added

- 交互 gains a fifth option, 统筹, after 收束.

### Changed

- The replacement permission dropdown offers 只读 / 工作区可写 / 完全权限 instead of the single
  完全权限 fallback.

### Fixed

- The composer's "+" popover flashed and closed. The composer re-renders while that menu is open;
  this plugin re-rendered with it, and each render made emotion touch `<head>`, which the host
  treats as outside DOM mutation and closes the popover on. Both slot components are memoised and
  the `sx` object is hoisted so an unrelated re-render no longer regenerates a style rule.

## [0.6.1] — 2026-10-17

### Fixed

- The client half referenced `process`, so the browser threw "import failed: process is not
  defined" and the entire web boot failed ("1 entry did not activate"). MUI and emotion read
  `process.env.NODE_ENV`; the build now defines it (`define: { 'process.env.NODE_ENV':
  '"production"' }`), which also lets the bundler drop the development branches.
- Client bundle: 748.89 kB → 525.35 kB (155.85 → 113.72 kB gzip) as a side effect.

## [0.6.0] — 2026-10-17

The widgets move to Material UI: `@mui/material@9.5.0` with `@emotion/react` and
`@emotion/styled`, rendered through a local `ThemeProvider` so the plugin never reaches into the
host's own theme.

### Added

- MUI `Select`/`MenuItem` for the three selectors and MUI `Switch` for the takeover switch.

### Changed

- `@mui/material` and emotion are bundled into `lib/client.js` (`alwaysBundle`): they are not in
  the host module table. Bundle size 12.80 kB → 748.89 kB (4.56 → 155.85 kB gzip).
- MUI's generics reject this plugin's event shapes, so the two components are narrowed to the
  props actually passed; the runtime components are unchanged.

## [0.5.0] — 2026-10-17

MDUI out, plain React in. The one UI framework the host guarantees is React itself (it arrives
through the module table), so the widgets no longer need a third-party kit.

### Changed

- The dropdowns and the takeover switch are React components owned by this plugin; the popup is
  drawn here (hover state on the trigger, 10px corner radius) instead of by the OS.
- Widget CSS is a string injected once through `ctx.effect`, so the plugin ships no stylesheet
  asset and the build needs no copy step.
- `pnpm build` is a single `tsdown` run again; the host half serves no static files.

### Removed

- `mdui@2.1.5`, `scripts/copy-mdui.mjs`, `lib/static/`, and the `/static/*` route.

## [0.4.0] — 2026-10-17

Angular out, MDUI 2 in. Angular needed a second toolchain (a separate `ng build`, its own
tsconfig, a static-served element bundle) and pinned the plugin to a TypeScript range; MDUI 2 is
framework-agnostic web components, so the widgets are now plain custom elements the React client
half renders directly.

### Added

- `<mdui-switch>` for the permission-takeover switch and `<mdui-select>` / `<mdui-menu-item>` for
  the three selectors, with `mdui@2.1.5`'s component JS bundled into `lib/client.js`.
- `scripts/copy-mdui.mjs`: copies MDUI's stylesheet to `lib/static/mdui.css`, served by the host
  half at `/deepseek-coordination/static/` — version-locked to the bundled JS, no CDN and no
  network requirement.

### Changed

- The `协调` settings page now holds **only** the takeover switch; the selectors live in the
  composer toolbar alone.
- The host half's static route moved from `/elements/*` to `/static/*`; `files` ships `lib/static`
  instead of `lib/elements`.
- `pnpm build` is `tsdown` plus the stylesheet copy; the `build:elements` / `typecheck:elements`
  scripts are gone.

### Removed

- `@angular/core`, `@angular/common`, `@angular/platform-browser`, `@angular/elements`, `rxjs`,
  `tslib`, and the build-side `@angular/cli`, `@angular/build`, `@angular/compiler`,
  `@angular/compiler-cli`.
- `angular.json`, `tsconfig.elements.json`, and `src/elements/**` (the custom element that
  wrapped the three selectors).

## [0.3.0] — 2026-10-17

The plugin grows its first real UI: an Angular custom element mounted into the DSH Web host,
plus the permission takeover of the composer's access-mode control.

### Added

- **Angular Elements app** (`src/elements/`, built to `lib/elements/browser/`): a zoneless,
  standalone Angular 21 component defined as `<dsh-coordination-controls>`. It renders the three
  coordination selectors left to right — 职能 (决策/成果/资源/人员/任职/执行), 交互
  (感情/思维/启发/收束), and 情景 (对话/办公/研究/工程/迭代) — and, when takeover is on, the
  replacement permission dropdown ahead of them.
- **`协调` settings section** (`settings.section`): the permission-takeover switch, the same
  selectors, and Material Symbols (Google Fonts) iconography.
- **Composer mount** (`conversation.input.left`): the element is injected into the free space of
  the composer tool row — the region marked green in the review mock.
- **Permission takeover**: with the switch on, an injected rule hides the host's access-mode
  control (`button[aria-label^="访问模式"]` / `^="Access mode"`) — the blue region — and the
  element renders the replacement dropdown in its place. The choice persists in `localStorage`.
- Host route `GET /deepseek-coordination/elements/*` serving the built bundle from package files,
  path-traversal guarded.

### Changed

- `pnpm build` now runs the Angular element build and the tsdown plugin build in one step
  (`build:elements` / `build:plugin` remain available separately).
- `files` ships `lib/elements`, so an installed copy carries the Angular bundle the host route
  serves; without it the composer mount would load a 404.
- `pnpm-workspace.yaml` allowlists the toolchain's build scripts (esbuild needs its postinstall);
  pnpm 10+ no longer reads the `pnpm` field in `package.json`.

### Known issues

- The replacement dropdown's preset list is a fallback (`完全权限`) until the host's real preset
  inventory is wired through the `permissions` attribute.
- The takeover selector keys off the host control's accessible name; a DSH release that renames
  the label breaks the hide rule until the selector is updated.
- Verified by type check, both builds, a route smoke test and a packed-tarball listing — **not**
  yet in a running DSH profile, so the visual result is unconfirmed.

## [0.2.0] — 2026-10-17

The repository becomes a DeepSeek Harness plugin **bundle**: a dual-face Cordis plugin with a
host half (route surface) and a client half (settings page).

### Added

- Bundle manifest: `dsh.bundle.patch` pointing at `cordis.patch.yml`, `dsh.client`
  (`platform: web`, `immediately: true`, module-table `inject`), and a dual `exports` map
  (`.`, `./client`, `./package.json`) with `main`/`types` on the built host artifact.
- `cordis.patch.yml` — the layer that inserts the `deepseek-coordination` row into a profile's
  bundle roster.
- Dual-face source layout: `src/index.ts` (host half — a `webServer` prefix route at
  `/deepseek-coordination` exposing `ping` and `echo`) and `src/client/index.ts` (client half —
  `zh`/`en` locale dictionaries plus a `settings.section` page that probes the host route).
- `tsdown.config.ts` — two build targets: host as ESM (`lib/index.mjs` + `.d.mts`) and client as
  CJS (`lib/client.js`) wrapped in `window.__ModuleLoader__.load()`, with `neverBundle` rules for
  the host process and the browser module table.
- `tsconfig.json` for type checking only (`noEmit`), and the `build`, `typecheck` and
  `pack:check` scripts.

### Changed

- Version `0.2.0`. The package shape is incompatible with `0.1.9` — entry points, `files` and the
  delivered artifacts all differ, so a minor bump is the semver-correct signal for a `0.x` line.
- Toolchain moved from Vite to `tsdown`, with the DSH client packages declared as both
  `peerDependencies` and `devDependencies` so the plugin shares the host's instances.
- `.gitignore` now ignores `lib/` (build output) instead of `dist/`.

### Removed

- The standalone Vite SPA scaffold introduced in `87ddab9`: `index.html`, `src/main.ts`,
  `src/counter.ts`, `src/style.css`, `src/assets/`, `public/`, the Vite dependency and its
  lockfile.
- The `os` and `bin` fields of the previous manifest, which described the removed `dsh-os`
  launchers; the plugin is platform-agnostic.

### Known issues

- The halves are a scaffold: `ping` and `echo` are the entire host surface, and the settings page
  only reports host liveness. No functional capability is implemented yet.
- Dependency ranges mirror the DSH plugin starter template (`@deepseek-ai/cordis` `^4.0.1`, the
  `@deepseek-ai/dsh-*` client packages `^0.1.0-rc.7`). Re-check them against the DSH release being
  targeted before publishing.
- `engines.dsh` is deliberately omitted, so installation validates the `@deepseek-ai/dsh*` peer
  ranges instead of a declared DSH range.

## [0.1.9] — 2026-10-13

### Fixed

- A string target was read as the wildcard, which disabled every scoped permission rule
  (`b7e02b0`).
- Version bumped to `0.1.9` for that fix (`3ba4a45`).

## [0.1.8] — 2026-10-13

### Added

- The approval seam, wired end to end (`8ee68dd`).

### Fixed

- Stored permission rules were never enforced; they now actually apply (`8ee68dd`).

## [0.1.7] — 2026-10-13

### Fixed

- Activation faults that shipped in `0.1.5` and `0.1.6` (`0a2c2c0`). Two Cordis behaviours every
  mock in the repository was too friendly to reproduce: a row that declares no config receives
  `null` rather than `undefined`, so a `config = {}` default never fires; and an undeclared
  service throws when read through the enforcing proxy, so a `typeof ctx.x?.y === 'function'`
  guard was itself the throwing statement. Guarded in all five entry points.

## [0.1.6] — 2026-10-13

### Fixed

- The tool description never named the tool itself, so the model could not select it
  (`42ff514`).

## [0.1.5] — 2026-10-13

### Added

- The workflow row: intent-first planning (`intake → plan → choose → run`) exposed as the
  `workflow_plan` tool, plus a system-prompt section kept constant so the provider prefix stays
  cached.
- Caching measured rather than asserted: four workflow calls at a 96.6% mean prefix-cache hit,
  with four tool calls and one human interaction on the unavoidable path (`b29c0e3`).

### Changed

- `0.1.3` and `0.1.4` were internal to the checkout and never published; `0.1.5` is the next
  published release after `0.1.2`.

## [0.1.2] — 2026-10-13

### Fixed

- `permission list`, `permission audit` and `permission query` returned
  `E_INTERNAL  The property 'empty' cannot be found on this object` whenever `permission.json`
  did not exist — the state of every installed copy, since the package ships no such file. Under
  `Set-StrictMode -Version Latest` the guard performed the throwing read inside its own test; the
  read now goes through `PSObject.Properties`, a dictionary lookup rather than a property read
  (`e4fade7`).

## [0.1.0 – 0.1.1] — 2026-10-13

Initial publication, preceded by the build-out that began on 2026-10-12 (`c2dae0c`). Releases
`0.1.0` and `0.1.1` were published in the same window, so their boundaries are recorded together.

### Added

- Cross-platform atomic OS-interaction surface: one argument-stable verb set over `file`,
  `environment`, `task`, `service`, `system`, `permission`, `execute`, `window`, `screenshot`,
  `clipboard`, `wait`, `mouse`, `keyboard`, `text` and `structure`, each verb returning a single
  JSON envelope with byte-exact charset, BOM and line-ending handling.
- Native Windows implementation through PowerShell 5.1 (`Add-Type` P/Invoke), a PowerShell 7.6
  port of all 16 modules, and a POSIX implementation — 16 mirrored module pairs, assembled into
  one self-contained artefact per platform by a deterministic build.
- DSH plugin entry points, the bundle patch, and the web client.
- Conformance, encoding, golden-case, permission, plugin, activation, takeover and workflow test
  suites, plus packaging and bundle verification tools.
- Rewritten English README, shipped inside `0.1.1` (`8b8a808`).

### Fixed

- Defects found before publication (`faaa0b7`): `dsh-os7.ps1` was missing from the packed `files`
  list although the plugin resolves that exact name for the 7.6 edition, which would have broken
  every installed copy while working in the checkout; `--encoding` on the Windows batch verbs was
  inert because the computed encoding object was never applied; `Invoke-OneShellCommand` never set
  `StandardOutputEncoding`.
- Version bumped to `0.1.1` (`69a9f61`).

## References

- Repository: <https://github.com/eloyhere/deepseek-coordination>
- Tags: `v0.1.5`, `v0.1.6`, `v0.1.7`, `v0.1.8`, `v0.1.9`
- Last commit of the dsh-os tree: `3ba4a45`
- First commit: `c2dae0c` (2026-10-12)
