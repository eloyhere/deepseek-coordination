# deepseek-coordination

**English** · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md) · [中文更新日志](CHANGELOG.zh-CN.md)

A dual-face Cordis plugin for DeepSeek Harness: the host half owns a coordination SQLite database, eleven model-facing tools, an AMP v0.1 protocol layer and an HTTP surface; the web half mounts five composer dropdowns, a settings catalog and the service-level takeover dialog.

**Status: v0.20.0 (2026-10-29).** The composer no longer carries coordination dropdowns, and the docked panel now tells the story in plain language — what the answer used (profession/interaction/scene), what it focused on and set aside, what it did, and whether the record is intact — with a 16 px typographic floor. It builds on v0.19.0 (gated Goal/Plan artifacts) and v0.17.2 (live-verified boundary fixes).

| Status | Meaning in this README |
|---|---|
| **Wired** | Registered by `src/index.ts` or called by the composed service, routes or tools. |
| **Library-only** | Implemented and tested as a module, but not driven by the current turn lifecycle or exposed through a route/tool. |
| **Design/planned** | Documented or declared in config/schema, with no runtime consumer yet. |

## What it is

| Piece | Location | Role |
|---|---|---|
| Bundle | `cordis.patch.yml`, `dsh.bundle` in `package.json` | Inserts one `deepseek-coordination` row into a DSH profile roster. |
| Host half | `lib/index.mjs` (ESM, Node) | `CoordinationService`, the `coordination` SQLite database, 11 tools, 33 route paths / 36 method handlers and the agent hooks. |
| Protocol layer | `src/protocol/`, `src/host/amp.ts`, `src/host/amp-store.ts` | AMP v0.1: signed manifest, frame per turn with explicit exclusions, receipts per turn and tool call, append-only ledger, signed checkpoints. |
| Client half | `lib/client.js` (CJS, browser, `__ModuleLoader__` wrapper) | React 18 + Material UI 9: composer dropdowns, settings page, takeover dialog. |
| Database | `%DSH_HOME%\coordination\coordination.db` by default | Plugin-owned SQLite file; 68 tables, 15 triggers, 67 indexes, schema version 25. Never DSH's `harness` database. |

The plugin does not replace DSH's agent loop. It records coordination state, locks one profession per task, shows the current selection in a read-only panel, exposes file metadata, asks DSH to compact when context pressure crosses a threshold, and relays approvals/questions to a human through its own dialog.

The composer keeps DSH's own controls: this plugin no longer contributes dropdowns. The current **职能 (profession), 交互 (interaction) and 情景 (scene)** triple is shown read-only in the docked panel; values are set through the `coordination_selection` tool or the host config defaults, and **验证 (validation)** is no longer displayed.

## Install and build

| Requirement | Detail |
|---|---|
| Node.js | `package.json` declares `>=18`, but the host imports `node:sqlite`; use a Node build that ships it. Verified on Node 24.21.0. |
| npm | npm 11 (bundled with Node 24) installs from `package-lock.json` and drives the scripts and the release workflow. |
| DSH | A DSH installation with the `dsh` CLI and a web-capable profile (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`). |
| Peer packages | See the table below; they come from the DSH installation, not from this package. |

```powershell
cd deepseek-coordination
npm ci                  # or `npm install` in a fresh checkout
npm run typecheck       # tsc -p tsconfig.json --noEmit
npm test                # tsdown test build + node --test
npm run build           # lib/index.mjs, lib/index.d.mts, lib/client.js
npm pack                # prepack builds first; produces the installable tarball
```

`npm run test:tsc` type-checks the test tree. `npm run pack:check` validates the packed runtime files and syntax-checks the host entry. `package-lock.json` is committed; `npm ci` reproduces it exactly.

| Peer package | Range | Side |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.1` | Host runtime |
| `@deepseek-ai/dsh-host-webserver` | `^0.1.0-rc.7 \|\| >=0.2.1-rc.2` | Host route registration |
| `@deepseek-ai/dsh-client-runtime`, `-locale`, `-ui-slots`, `-ui-settings` | `^0.1.0-rc.7 \|\| >=0.2.1-rc.2` | Browser module table |
| `react` | `^18.2.0` | Browser module table; never bundled |

The client half is compiled against the 0.2.1-rc.2 client packages the desktop runtime ships (`-locale`, `-ui-settings`, `-ui-slots`, `-ui-conversation`). `@deepseek-ai/dsh-client-runtime` and `@deepseek-ai/dsh-host-webserver` publish no 0.2.x release, so their devDependencies stay on 0.1.0-rc.8 while their peer ranges accept the 0.2.1+ runtime the host provides. The open-ended `>=0.2.1-rc.2` accepts every later stable release; `^0.1.0-rc.7` keeps the 0.1 line installable.

### Install into a profile

Install the packed tarball, not the GitHub source:

```powershell
npm pack
dsh plugin --profile <name> add .\deepseek-coordination-0.14.10.tgz
dsh --profile <name> --dump-config   # expect a deepseek-coordination layer
```

**Raw `github:eloyhere/deepseek-coordination` installs are unsupported.** `lib/` is gitignored, and the bundle is only built by `prepack` (or an explicit `npm run build`), which npm does not run for a git dependency; the installed package then fails at activation with `ERR_MODULE_NOT_FOUND` for `lib/index.mjs`. The tag-triggered GitHub Actions workflow (`.github/workflows/release.yml`) builds and attaches the verified tarball to the release; install that artifact.

**npm latest is still the old `0.1.9` dsh-os line.** Do not install by package name yet. A local checkout can be linked with `dsh plugin --profile <name> add .` after `npm run build`.

`dsh plugin add` writes the dependency and the bundle row. If the profile still records a different package spec, replace it rather than assuming the new code loaded; check `dsh --profile <name> --dump-config` and the installed `package.json` version.

### Uninstall or disable

If a release makes the harness unreachable, remove it in this order and restart afterwards:

1. Remove the `deepseek-coordination` bundle entry from the profile roster (`dsh plugin --profile <name> remove deepseek-coordination`, or delete the row by hand).
2. `pnpm remove deepseek-coordination` in the profile.
3. Delete `node_modules/deepseek-coordination` if it still exists; some uninstall paths leave the directory behind.
4. `pnpm install` to rewrite the lockfile and dependency tree.
5. Restart the harness. The client bundle is served at boot, so reloading the page alone does not unload the old plugin.

For a no-restart recovery path limited to the panel UI, set `localStorage['coordination.panel.disabled'] = '1'` (or `'true'`) in the Web GUI and reload: the coordination panel column mounts nothing, while the rest of the plugin stays available. Set the key back to `'0'` (or delete it) and reload to restore the panels. The flag is read once at mount, so both directions need a reload.

| Artifact | Format | Size in this build |
|---|---|---|
| `lib/index.mjs` | Host ESM, `platform: node` | 2,539,208 B |
| `lib/index.d.mts` | Host declarations | 9,095 B |
| `lib/client.js` | Browser CJS wrapped in `__ModuleLoader__.load()` | 3,441,832 B |

Material UI, emotion and `react-dom` are bundled into `lib/client.js`; React itself comes from the host module table. The inlined `react-dom` is the 18.3.1 line that matches the host's React 18 — npm refuses to auto-install a React 19 `react-dom` against a React 18 `react`. The client bundle is large because MUI and `react-dom` are inlined, not because it ships a second React.

## Architecture

Host half (`src/index.ts`):

- exports `name`, `inject = ['webServer', 'tools']` and `Config`; `apply()` resolves config, creates the service, recovers interrupted turns and installs every effect through `ctx.effect`.
- `CoordinationService` (`src/host/coordination.ts`) is the Cordis `coordination` service. It owns the database, module host and the composed modules: session, selection, turn, profession, plan, comprehension, organization, predict, goal, compact, directive, permission, takeover/gate, provider, cache, command, the `TurnPipeline` and the `AmpService`.
- SQLite is opened with `node:sqlite` (`DatabaseSync`), foreign keys, a 5 s busy timeout and WAL outside `:memory:`. Triggers refuse changing a locked profession and make `orchestration_trace` append-only; eight more make every AMP table write-once.
- The `/deepseek-coordination` prefix route answers JSON `{ ok, value | error }`; request bodies are capped at 1 MiB and unknown paths return 404 with the route envelope. Seven `/amp/*` routes serve protocol artifacts under the same envelope.
- Eleven tools are registered through `ctx.tools` (three composer, four file-layer, four read-only graph tools), each wrapped so every call settles as an AMP receipt. All eleven are re-registered after `POST /locale`, because their descriptions are part of the model-facing prompt.
- Hooks: `agent/pre-step` opens the coordination turn (and its AMP frame) and runs the compaction governor; `agent/turn-stopping` closes it as `done` (and writes the `reflect` receipt); `agent/error` closes it as failed; `approval/request` and `user-questions/request` feed the takeover gate. A 60 s timer deletes expired lock rows.

Client half (`src/client/index.ts`):

- `inject = ['slots', 'locale']`; `package.json`'s `dsh.client.inject` separately lists the four module-table packages.
- `settings.section` (order 50) mounts `CoordinationSettings`; `conversation.input.left` (order 40) mounts the composer controls and the takeover dialog as siblings.
- Language follows `ctx.locale.getLocale().active`, normalises `zh*`/`en*` onto `zh-CN`/`en-US`, and reports changes to `POST /locale`. The host rebuilds localized tool descriptions from that report.
- The client bridge uses same-origin `fetch` with a 3 s selection timeout and 2 s takeover/locale timeouts. Unreachable hosts fall back to a per-session `localStorage` copy for the five choices; a permission preset is never written offline.
- The composer components are memoised on `sessionId` only, because the slot also passes the composer input on every keystroke; re-rendering this row would make emotion touch `<head>` and close DSH's popover.

```text
deepseek-coordination/
├─ src/
│  ├─ index.ts                 # host composition root: service, routes, tools, hooks
│  ├─ protocol/                # AMP v0.1 port: types, canonical, ids, envelope,
│  │                           #   manifest, frame, receipt, warrant, ledger
│  ├─ host/
│  │  ├─ coordination.ts      # CoordinationService (Cordis service "coordination")
│  │  ├─ config.ts             # Schemastery schema + resolveConfig()
│  │  ├─ database.ts           # SQLite schema (25), 68 tables, 15 triggers
│  │  ├─ amp.ts               # AmpService: manifest/frame/receipt/event, verify
│  │  ├─ amp-store.ts         # AMP SQLite chain, key, manifest, checkpoint
│  │  ├─ dsh.ts                # narrow DSH ports + turn lifecycle
│  │  ├─ tools.ts              # 11 model-facing tools
│  │  ├─ chain.ts              # bounded Chain projection engine
│  │  ├─ node-registry.ts      # NodeCard registry and describe()
│  │  ├─ parse-service.ts      # workspace-bound parse + read service
│  │  ├─ token.ts              # TokenGovernor and pure policy
│  │  ├─ takeover-gate.ts      # approval/question waterfall gate
│  │  ├─ selection.ts turn.ts profession.ts session.ts …  # selection, lock, lifecycle
│  │  ├─ module.ts             # ModuleHost ports and the event bus
│  │  ├─ adapters/sqlite/      # execution/turn/profession/trace stores
│  │  ├─ bayesian.ts comprehension.ts organization.ts … # library engines
│  │  └─ text/                 # P0 parsers: JS/TS, CSS/HTML/MD, TeX, formulas, graph
│  ├─ client/
│  │  ├─ index.ts              # slots, locale store, nav icon, takeover CSS
│  │  ├─ controls.ts           # selection helpers shared with settings; the composer surface is gone
│  │  ├─ settings.ts           # 13-group, 139-control settings catalog
│  │  ├─ takeover.ts           # approval/question dialog
│  │  ├─ bridge.ts store.ts i18n.ts theme.ts selection-cache.ts
│  └─ shared/                  # entity/enum/selection/i18n/error + data structures
├─ test/                       # 52 *.test.ts + helpers.ts
├─ docs/amp-conformance.md     # protocol mapping, invariants, deliberate gaps
├─ lib/                        # build output; gitignored, never edited by hand
├─ cordis.patch.yml            # bundle row inserted into a profile
├─ scripts/check-pack.mjs      # tarball runtime-file verification
└─ .github/workflows/release.yml
```

## AMP v0.1 protocol layer

The host half implements the [Attention Manifest Protocol](https://github.com/eloyhere/attention-manifest-protocol) at its boundaries. The port is vendored in `src/protocol/` (see [`NOTICE`](NOTICE)) and driven by `src/host/amp.ts`; the full mapping — including what is deliberately *not* implemented — is [`docs/amp-conformance.md`](docs/amp-conformance.md).

| Artifact | Produced when | Served at | Signature |
|---|---|---|---|
| Manifest | first read, then reissued every 12 h or when the policy digest changes | `GET /amp/manifest` | Ed25519 over canonical JSON, `signatures` excluded, `digest` included |
| Frame | `beginTurn` | `GET /amp/frame?session=` | `digest` over the frame body (integrity, not authentication) |
| Receipt | turn close (`reflect`) and every tool call (`read`/`attend`/`act`) | `GET /amp/receipts` | none — integrity comes from the ledger chain |
| Claim | turn close, from the comprehension row (`intent`/`requirement`/`constraint`/`assumption`) | `GET /amp/ledger` | none — `confidence` is derived, evidence carries a digest |
| Unknown | turn close, from the comprehension ambiguity | `GET /amp/ledger` | none |
| Goal | turn close, when a goal row and per-step acceptance exist | `GET /amp/ledger` | none |
| Plan | turn close, same gate: every step has `expect` and the plan has a constraint | `GET /amp/ledger` | none |
| Event | `turn.opened`, `turn.closed`, `tool.invoked`, and a whitelisted set of module-bus events | `GET /amp/ledger` | `digest` over the event body |
| Ledger | continuously | `GET /amp/ledger`, `GET /amp/verify` | hash chain, triggers reject UPDATE/DELETE |
| Checkpoint | `POST /amp/checkpoint` | same route | Ed25519 over `amp:ledger-checkpoint:0.1\n` + canonical body |
| Identity | on first artifact | `GET /amp/identity` | public key only; the private key stays in `amp_key` |

What the protocol changed in this plugin:

- **Every turn has a frame with explicit exclusions.** The scene knobs this host does not enforce (`allowBash`, `maxIteration`, and `allowWeb` when disabled) are recorded as `ignored` entries with a `revisit_if` trigger, before the turn runs. Previously they existed only inside an in-memory pipeline report.
- **Every turn and tool call settles with a receipt.** Turn duration is measured from the turn row (`usage.ms`); token usage is not claimed because the host owns it. Turn `done`/`failed`/`cancelled`/`abandoned` map to `success`/`failure`/`blocked`/`partial`.
- **A plan is only a plan when it can be monitored.** The `Goal`/`Plan` pair is emitted only when every decoded step records acceptance and the plan records a constraint; otherwise one `plan.deferred` event names the missing fact and nothing is stored. `expect.check` is that acceptance text — monitorable by a human, not yet by a kernel (no check runner).
- **Interpretation is separated from fact.** The comprehension's four statements become claims, but only a **verbatim** prompt anchor raises one to `T1` with `entails: true` evidence; a paraphrase stays `T0` with no evidence. Confidence is always `deriveConfidence(tier, evidence)`, never the stage's own number, and the ambiguity becomes an `unknown` whose `importance` is `1 − confidence`. Claims that fail `validateClaim` are dropped, not stored.
- **Confidence is derived, never authored.** A manifest capability's tier is `T2` only after a successful tool receipt, and its confidence is the Laplace-smoothed success rate over recorded receipts.
- **The audit chain is now signed and checkable.** `GET /amp/verify` recomputes every hash from storage and checks the latest checkpoint against the prefix it witnessed; tampering with a row (even with the trigger dropped) is reported.
- **The ledger stores pointers, not prose.** Mirrored bus events pass through `ledgerProjection`, which keeps id-shaped strings and numbers and elides everything else.

The sealed A-surface envelope is implemented and tested but not wired: this deployment has no peer to exchange messages with. Everything else in the table is driven by the live turn lifecycle; §7 of the conformance document lists each remaining gap with its reason.

### Live verification (2026-10-29)

Installed into `%DSH_HOME%\profiles\desktop` with `dsh plugin --profile desktop add` and verified against the running client:

| Check | Result |
|---|---|
| Host half loads in the running app | `GET /deepseek-coordination/ping` → `{ ok: true, … }`; `GET /amp/identity` returns a real Ed25519 `kid` |
| Manifest is signed, and verifiable *outside* the plugin | `digestMatches: true`, `signatureValid: true`, `kidMatches: true` with an independent canonical-JSON + WebCrypto verifier |
| Real turns produce artifacts | 19 ledger entries: 3 frames (4 slots, 2 exclusions each), `turn.opened` mappings, tool receipts, a `reflect` receipt for a closed turn, and mirrored `pipeline.report` events with their prose elided |
| Frames are served | `GET /amp/frame?session=…` → mode, cycle, digest, slots with `why`, `ignored` with `revisit_if` |
| Checkpoints seal the live chain | `POST /amp/checkpoint` → `seq 0` over `count 19`; `GET /amp/verify` → `{ ok: true, reasons: [] }` |
| Client module is served | `plugins/??deepseek-coordination/client.js&rev=…` → 3,441,910 bytes, present in `__DSH_BOOT__.entries` |

The live run also caught a real defect: `coordination_selection` returned a value DSH rejected as "not lossless JSON". 0.17.2 omits absent projection fields and detaches every tool result through `jsonSafe` before it crosses the boundary. Two operational facts matter:

- **An update is not hot-swapped.** Adding the package hot-loaded it; replacing the installed build while the app was running left the old module in memory. `GET /ping` now reports `version`, so the running build is observable; restart the app to load a new one.
- **A headless profile does not activate the plugin**, because it declares `inject: ['webServer']` and headless mounts no webserver. Mounting `@deepseek-ai/dsh-host-webserver` (plus its startup row) or relaxing the inject is the fix; the composed service itself does not need the routes.

## Composer controls

| Control | Options | What it does |
|---|---|---|
| 权限 Permission | DSH preset catalog, or a neutral “follow DSH” state | Writes the chosen preset to DSH immediately through `ctx.permissionPresets`; never persists it in the coordination DB. Only shown while the local 权限接管 switch is on. |
| 职能 Profession | decision / outcome / resource / personnel / qualification / execution | Locked for the active turn. Selecting another value is refused with `PROFESSION_LOCKED` and opens the rebuild/abandon dialog. |
| 交互 Interaction | emotion / think / heuristic / converge / orchestrate | Stored for the next turn; frozen while the active turn has a non-cleared goal. |
| 情景 Scene | dialogue / writing / office / research / engineering / iterate | Stored for the next turn. `writing` sits between `dialogue` and `office`; the scene policy is read by the turn pipeline. |
| 验证 Validation | low / medium / high | Stored for the next turn; frozen while the active turn has a draft/scored/active plan. All three levels search. |

The dropdown UI is removed: the composer only carries DSH's own controls. The semantic rules below still hold in the service and the `coordination_selection` tool; the panel displays the resulting triple, not a way to change it.

Validation budgets are policy, not a claim that the whole pipeline runs today:

| Level | Queries × results | Evidence scope | Interaction scope |
|---|---|---|---|
| low | 1 × 3 | Current turn only | Selected interaction |
| medium | 2 × 5 | Current session | Selected interaction |
| high | 4 × 8 | All local content | All interactions |

The budgets live in `src/host/comprehension.ts` and the shared `ValidationBudgetByLevel` table. `ComprehensionModule` is library-only and is not driven by the current `CoordinationService` turn lifecycle, so the composer persists the level without executing these searches yet.

### Scenes and the writing profile

| Scene | Plan | Outline | Revision | Score | Bash | Web | Max iterations |
|---|---|---|---|---|---|---|---|
| dialogue | – | – | – | – | no | yes | 1 |
| writing | yes | yes | yes | yes | no | yes | 3 |
| office | yes | – | – | – | no | yes | 1 |
| research | yes | – | – | – | no | yes | 3 |
| engineering | yes | – | – | – | yes | yes | 3 |
| iterate | – | – | – | yes | no | yes | 3 |

`writing` requires an outline and at least one revision round, requires a quality score, disallows bash, allows web search and caps the loop at three iterations. The pass threshold is `0.6`; `plan.ts` uses that writing threshold. The turn pipeline reads the require-* flags, citation/evidence, `allowWeb` and `sandboxOnly`; reasoning (`thinking`, `reasoningEffort`) belongs to DSH — the page has no row for it, and the turn records what the session's own request header carries rather than a scene literal. `allowBash`, `maxIteration` and non-writing thresholds remain deferred diagnostics because no DSH port or consumer exists yet.

## Profession lock and turn lifecycle

- One task has exactly one profession. `turn.create` writes `profession NOT NULL`, `locked = 1` and one profession record plus one `lock` trace event.
- While a non-terminal turn exists, `SelectionModule.set` refuses a different profession with `ProfessionLockedError`; the HTTP layer answers 409 `PROFESSION_LOCKED`. The selection is not mutated.
- `POST /profession/rebuild` ends the active task as `abandoned`, creates a replacement turn with a new ordinal and profession, copies the prompt/command, and emits `rebuild` + `lock` trace events. It requires an active turn.
- `POST /profession/abandon` closes the active task without a replacement; the next task may choose again. Both reselect flags are forced true by `resolveConfig`.
- SQLite repeats the rule: `trg_turn_profession_lock`, `trg_profession_record_lock`, `trg_subtask_profession_lock` abort a profession change while locked; `trg_turn_profession_unlock` and `trg_subtask_profession_unlock` refuse clearing the flag.

| Hook | Effect |
|---|---|
| `agent/pre-step` | Ensure the coordination session, open (or reuse) one Turn for the DSH turn; also runs the token governor before `next()`. |
| `agent/turn-stopping` | Close the Turn as `done`; the profession unlocks for the next turn. |
| `agent/error` | Close the Turn as `failed`. |
| Host start | `recoverInterrupted()` marks every non-terminal Turn failed with reason `turn was interrupted by a host restart`. |
| Every 60 s | Delete ended locks older than `defaultLease`. |

Terminal turn states (`done`, `failed`, `cancelled`, `abandoned`) are irreversible. The turn hook records turn metadata and an empty prompt row; it does not mirror the DSH conversation into the coordination database.

## Domain ecosystems and parsers

The file layer is not one parser with a bag of node kinds. Each system owns a module under `src/host/text/`, and the node kinds it may emit are bounded by that system's semantics. All output is body-free `NodeMetadata`: kind, explicit name/label, span and fragment coordinates — never a body, a cell value or a paragraph.

| Ecosystem | Module | Node kinds it may emit |
|---|---|---|
| tex | `tex.ts` | `definition`, `lemma`, `theorem`, `proof`, `property`, `axiom`, `corollary`, `claim`, `example`, `remark`, `calculation`, `condition` (+ `requires`/`meets` edges) |
| book | `book.ts` | `book`, `part`, `chapter`, `article`, `section`, `person`, `venue` — the only producer of `article` |
| markdown | `markup.ts` | `document`, `chapter`, `heading`, `paragraph`, `div`, `link`, `code`, `section`, `sheet`, `cell`, `range`, `condition` |
| html | `markup.ts` | `document`, `section` (`<article>` maps here), `chapter` (`<h1>`), `link`, `code` |
| js/ts | `javascript.ts` | `class`, `function`, `method`, `variable`, `interface`, `type`, `enumeration`, `namespace`, `importation`, `exportation`, `condition` |
| java | `java.ts` | `module`, `class`, `interface`, `enumeration`, `method`, `variable`, `importation` |
| python | `python.ts` | `class`, `function`, `method`, `variable`, `importation` |
| c/c++ | `c-family.ts` | `module`, `class`, `function`, `method`, `variable`, `importation` |
| rust | `rust.ts` | `module`, `class`, `enumeration`, `function`, `method`, `variable`, `importation` |
| php | `php.ts` | `module`, `class`, `interface`, `enumeration`, `function`, `method`, `variable`, `importation` |
| maven | `maven.ts` | `project`, `module`, `dependency` (parent is a dependency with `label: 'parent'`) |
| npm | `npm.ts` | `project`, `dependency`, `script` (the command body is never stored) |
| office | `office.ts` | docx: `document`, `chapter`, `section`, `paragraph`, `link`; xlsx: `workbook`, `sheet`, `range`, `formula`; pptx: `document`, `slide`; pub/accdb: no nodes, one `unsupported-format` diagnostic |
| text | `sentence.ts` | `sentence` segmentation and `line` ranges (coordinates, not nodes) |

Rules that hold across every ecosystem:

- **Language nuance lives in `label`, not in new kinds.** Rust `impl` is `kind: 'class'` with `label: 'implementation'`; C++ `struct`/`enum` and PHP `trait` work the same way. `NodeKind` stays a small closed union.
- **Descriptive only.** No parser writes files, builds, installs, executes macros or reaches the network. A real "create project" is a shell command behind DSH's permission model, never a plugin tool.
- **Explicit evidence only.** A heading level is never inferred from text, a package version is never invented, and a missing relationship is reported rather than paired positionally. Malformed input returns a diagnostic and never throws.
- **Bounded.** ZIP entries ≤ 2000, uncompressed ≤ 64 MiB per entry / 256 MiB total, XML nesting ≤ 128, nodes ≤ `MAX_METADATA_NODES` (20 000), and the parser honors the token/time budgets.
- **`SUMMARY.md` resolves to `book`** through the registry's filename-first rule; `README.md` and other Markdown stay with the Markdown parser.

A broad request is not parked as an ambiguity condition: comprehension's `任务描述过于宽泛（A / B）` finding is split into per-fragment plan steps (`Turn the broad request into a verifiable sub-task: A`) with a concrete acceptance each, so the plan is monitorable from the first turn. `ambiguityWithoutBroadTask()` keeps whatever other ambiguity was found.

The graph answers "what is in this workspace" through `coordination_parse`, `coordination_describe` and `coordination_chain`. The chain query takes an optional `kind` (trimmed, case-insensitive) on every node-returning action, so "all lemmas" or "all chapters" is one call instead of a scan. Directory nodes are derived from unambiguous workspace paths and connected with `contains`/`part_of`; the invariant is **`part_of` (child→parent) exact, `contains` (parent→child) best-effort**.

## Coordination panel (read-only)

The right dock hosts one read-only panel written for a general reader, not for a protocol engineer. It is MUI end to end — `Card` sections, `Table`s for the plan, the ignored items, the actions and the technical rows, and one collapsed `Accordion` for the raw evidence. It answers three questions in order:

- **What it had to solve** — the turn's **actual prompt excerpt** (`/amp/story`), the turn ordinal, the 职能 / 交互 / 情景 labels with the rule each one imposes, any goal text, and a table of the plan's steps with their recorded acceptance. The composer no longer has dropdowns; this is where the values are visible.
- **What it deliberately set aside** — a table of the ignored items by name, the reason class, and the exact "reconsidered when …" condition. The raw `why` / `revisit_if` text, digests and ids live under a collapsed **technical details** accordion.
- **What it did, and whether the record can be trusted** — the five latest receipts in plain words (read / focus / review / ask / tool call) and one trust line: "the record is complete and unmodified · N entries · append-only and signed", or the verifier's failure reasons.

Panel typography is rem-based with a **1 rem (16 px) floor** (`PANEL_TYPE_SX`): no text in the dock is smaller than 16 px. Values are never reshaped — the digest and tip in the technical details are the digest and tip a verifier checks. A missing session or frame is an explicit empty state, not a fallback to file browsing. Minimized, the panel collapses to a single floating button at the top-right of the conversation; its view is the `amp` hash route (`#coordination/panel/right/amp`).

## Settings and configuration

The settings page is driven by `SETTINGS_CONTROLS` in `src/shared/selection.ts`: **139 controls in 13 groups, 122 writable host rows, covering 155 config leaves**. Twelve scene leaves (`scenes.*.thinking`, `scenes.*.reasoningEffort`) stay in the schema but have no row: DSH's model page owns reasoning, and duplicating it here would create two sources of truth. The 18 top-level config keys include `database` and `databasePath`, which are deliberately not projected or writable.

| Group | Defaults / scope | Write path |
|---|---|---|
| `session` | `maxTurnPerSession=1000`, `defaultLease=30000 ms`, `clarifyTimeout=30000 ms` | Host rows through `/config` |
| `profession` | enabled/lock/rebuild/abandon forced `true`; default mirrors `defaults.profession`; audit/errorHint `true` | Forced flags read-only; audit/errorHint host rows (audit has no consumer) |
| `plan` | threshold `0.5`, maxRebuild `3`, 8 weights summing to 1, 8 dimension thresholds | Host rows; weights re-normalise on save |
| `orchestration` | maxReject `2`, maxSubTask `32`, groundTruth `true`, timeout `5000 ms`, shell ground truth `false`, modelRouting `true` | Host rows; `groundTruthTimeout` has no consumer |
| `cache` | enabled `true`, ttl `60000 ms`, fingerprintWindow `50`, effortWarning `true` | Host rows; `enabled`/`effortWarning` gate the cache proxy decorator, `ttl` caches the model catalog, `fingerprintWindow` has no consumer |
| `bayesian` | prior `0.5`, stopEntropy `0.05`, infoGain `0.01`, maxRoutes `12`, calibrationFloor `0.1` | Host rows; `calibrationFloor` has no consumer |
| `comprehension` | stageTimeout `30000 ms`, searchEnabled `true`, maxEvidence `8`, highHistoryWindow `50` | Host rows |
| `compaction` | auto `true`, soft `0.70`, hard `0.88`, reserve `2048`, recentTurns `6`, cooldown `30000 ms`, maxPerSession `20` | auto/soft/hard host rows; structural fields read-only |
| `ui` | toolbar `true` (deprecated alias), showTooltip `true`, takeover `false`, refreshInterval `5000 ms`, compact `true`, locale `auto` | Host rows plus the two local switches; toolbar/locale read-only |
| `scenes` | six scene profiles, 9 exposed rows each (thinking/effort remain schema-only) and a writing threshold of `0.6` | Host rows; only the writing score threshold is read by `plan.ts` |
| `parser` | enabled `true`, 1 MiB, 200k tokens, depth `256`, 2 s, cache `256`, graph 20k/100k | enabled + four limits host rows; depth and graph caps planned |
| `chain` | depth `8`, links `50`, tokenBudget `1500` | Host rows |
| `tools` | maxResultBytes `0` | Planned/read-only; not consumed |
| `defaults` | profession `execution`, interaction `think`, scene `dialogue`, validation `medium`, command `none` | Host rows |

`GET /deepseek-coordination/config` returns `{ values, defaults }`; `defaults` is `resolveConfig(undefined)`, so the page never duplicates a default literal. `POST /config` accepts a flat dotted patch such as `{ "plan.threshold": 0.7 }`, validates it against the catalog and the real Schemastery schema, applies it to the live config, re-resolves invariants (weight normalisation, alias mirror, forced flags, compaction clamps), rebuilds `TokenGovernor` when compaction changes, and persists the applied paths.

Persistence is the host's own override document at `<database dir>/config.overrides.json`: a flat `{ "plan.threshold": 0.7 }` map written atomically beside the coordination database and merged over the profile config on the next start. It is not DSH's `ctx.settings.update`, which only accepts `.volatile()` schemas — and a volatile node turns every parsed value into a reference wrapper this host cannot adopt without rewriting every config reader. `persisted: true` therefore means "stored in the coordination host's own document"; a write that only touched ignored rows reports `false`. Unknown keys, `databasePath` and `database` are rejected with `INVALID_ARGUMENT`. Known but non-editable keys are reported in `ignored` and never written. `POST /config/compaction` remains as a small compatibility route for the old auto/soft/hard patch.

The page is Material UI end to end: one default-expanded `Accordion` per group, a `List` of rows, six scene tables (no scene dropdown), `Checkbox` for booleans, `RadioGroup` for enums, `TextField type="number"` for every number (weights and ratios included, rounded to the row's step for display only), and `Chip` only for the `主机 / 本机 / 强制 / 只读 / 计划中` status plus connection state. The full-access confirmation is a modal MUI `Dialog` above the tooltip layer, never an inline banner. There is no save button; controls apply on change/blur. A forced row draws a disabled control, a read-only row shows a value, and a planned row says the runtime does not read it yet. The settings nav icon is a host-shell workaround: the shell accepts only `{ id, order, label }` for a section, so the plugin decorates its nav button with a CSS mask of the Material `sync` glyph.

## Service-level takeover

- With `ui.takeover` on, `TakeoverGate` listens to DSH's `approval/request` and `user-questions/request` waterfalls. It records a durable pending row, emits `takeover/pending`, and waits for a human answer delivered through the client routes.
- The listener registers with `{ prepend: true }`. DSH's own approval and question UI listens to the same waterfalls, and a listener registered later never runs once the GUI claims the request. Note that a deployment approval policy of `never` makes DSH reject before the waterfall, so no dialog can appear regardless of this switch.
- A timeout, an aborted request signal, an explicit cancel, or plugin unload calls `next()`; the gate never turns “nobody answered” into `allowed-once` or a fabricated answer. `unavailable` is the host's fail-closed outcome and is rejected as a user decision.
- The dialog polls `/takeover/pending` every 1 s only while the local 权限接管 switch is on, the session id is real and the document is visible. The first pending request is rendered; a `1 / N` badge appears for a queue.
- Approval offers 仅本次允许 / 拒绝 / 取消; only `allowed-once` and `rejected` are submitted, while cancel/Esc/backdrop use the cancel route. Questions render radios for single-select, checkboxes for multi-select and optional free text; submit stays disabled until every question is answered.
- **Both switches are needed**: host `ui.takeover` (default `false`) opens the gate; the local 权限接管 switch makes the dialog poll. With the host switch off, the gate delegates immediately and there is nothing to show.

## Cache proxy (experimental, off by default)

DSH freezes a model request before any adapter sees it: `buildRequest()` deep-freezes the messages and `Object.freeze`s the request, and the `llm/stream` waterfall's fallback closes over that object. The one supported place where outgoing content can still be rebuilt is the adapter boundary, so the plugin registers an extra provider route (`coordination-proxy`) and forwards each request to the real provider after rebuilding it.

Wiring (`src/index.ts`, `src/host/proxy-service.ts`, `src/host/proxy-adapter.ts`, `src/host/model-brand.ts`):

- `agent/request` rewrites the route to `coordination-proxy` and remembers the real one. Only allowlisted providers (`deepseek`, `deepseek-account`, `deepseek-official`) are intercepted; anything else keeps the route the harness chose.
- The adapter forwards through `ctx.llm.stream` with the real provider, so transport, retries, attribution headers and usage reporting stay with the real adapter.
- `ctx.llm.resolveModelInfo(provider, model)` supplies the host's model identity; it is classified onto a built-in cache brand (DeepSeek, OpenAI, Anthropic, Google, xAI, Moonshot, Qwen, Zhipu, Mistral, Meta, unknown) with `automaticPrefixCache`, `explicitCacheBreakpoints`, `minPrefixTokens`, `effortBreaksCache` and `stripVolatileHelps`.
- In `normalize` mode, outgoing content is decorated only when the family has an automatic prefix cache **and** `cache.enabled` is on: `CacheModule.decorate` moves fixed content first and replaces volatile fragments (ISO timestamps, UUIDs, long hex, current-time phrases) with stable placeholders. Explicit-breakpoint families (Anthropic) are never rewritten, because markers — not bytes — decide reuse there. The advisory `cacheWarning` field is stripped before forwarding.

Security model — the proxy sees every prompt, so it is built to be unable to leak:

1. no credential access (no `ctx.credentials`, no token, no `Authorization`, no API key);
2. no egress (the adapter module has no imports and no `fetch`/`http`/`net`; forwarding is an in-process call);
3. no content persistence — `proxy.log` receives structural events only (`{event, provider, model, brand, messages, chars, tools, reason, upstreamProvider, prefix, stable, from, to}`), never prompt or answer text;
4. provider allowlist enforced in both the routing listener and the adapter;
5. refusal and failure messages name the route only;
6. opt-in and reversible.

Enable it by creating `%DSH_HOME%\coordination\proxy.enable` (or `DSH_COORDINATION_PROXY=1`) and restarting. The proxy then defaults to `measure` mode: it records baseline metrics and prefix hashes without rewriting content. `GET /deepseek-coordination/proxy/status` reports counts, ids and hashes only: `available`, `enabled`, `mode`, `decorate`, `upstream`, `upstreamProvider`, `model` (brand and policy), `forwards`, `refusals`, `metrics` and `prefix`. Delete the flag file and restart to return to the normal path.

### Measure vs normalize

Attaching the proxy and rewriting the request are independent switches. With the proxy enabled, the default `measure` mode forwards each request with only the real provider route restored; it never calls the cache decorator. To let the decorator run, create a `proxy.mode` file containing `normalize`, create a `proxy.rewrite` marker file, or set `DSH_COORDINATION_PROXY_REWRITE=1`, then restart. In both modes `proxy.log` gains a `prefix` line per forward (`{ prefix: '<16 hex>', stable }`) and a `prefix-churn` line (`{ from, to }`) when the fingerprint changes; `metrics` aggregates the last 100 requests (`requests`, `samples`, `inputTokens`, `cachedInputTokens`, `hitRate`, with DSH's `cacheReadTokens` surfaced as `cachedInputTokens`). Read a real session's baseline with `curl http://127.0.0.1:<port>/deepseek-coordination/proxy/status`, using the port that serves the Web GUI.

### Interaction with exact-provider host modules

The rewrite is visible to every `agent/request` consumer: while the proxy is attached, the route recorded in the request is `coordination-proxy`, not the real provider. `/proxy/status` therefore exposes `upstreamProvider` (the real provider captured before the rewrite) beside `upstream`. Host modules that resolve credentials or account state by exact provider id can misbehave under that rewrite; the known case is the host's web-search account fallback, which needed a host-side fix (shipped in the 0.2.1-rc.2 patch). `ProxyService.compatibility()` carries the same list as static data, and the proxy does not probe the host.

## Auto-compaction and the token governor

`TokenGovernor` estimates context (CJK-aware O(n) estimator with a bounded 256-entry memo), plans a budget against `contextWindow - reserve`, and asks DSH's `compactIfNeeded` at `agent/pre-step` when utilisation crosses a threshold. Defaults: soft `0.70`, hard `0.88`, reserve `max(2048, 8% of window)` capped at 25%, recentTurns `6`, cooldown `30 s`, `maxPerSession 20`.

The soft threshold is editable as a 0.30–0.90 ratio; the hard threshold as 0.30–0.98 and strictly above soft. The old 60/70/80/88% values remain valid choices (`0.60`, `0.70`, `0.80`, `0.88`) even though the catalog now edits it as a number field with 0.01 precision. Auto compaction is disabled by `compaction.auto=false`, but an explicit compact command is not governed by that switch.

Fail-safe rules are deliberate: the hook never blocks the step; a missing compaction port, `null`/`undefined` result, timeout, throw, spent per-session allowance or unelapsed cooldown all become a no-op, and the agent proceeds to `next()`. The governor snaps the policy at construction, so a live settings change also rebuilds it. DSH owns the actual safe range and replacement; this plugin only decides when it is worth asking.

## File tools, parser and Chain

The file layer is wired as four model-facing tools, alongside the three composer
tools and the four read-only graph tools (eleven in total; see
[Tools and routes](#tools-and-routes)):

| Tool | Purpose |
|---|---|
| `coordination_parse` | Parse a workspace file or supplied text. Exactly one of `path`/`text`; returns references, diagnostics, charset, truncation and node cards, never the file body. |
| `coordination_describe` | Read one `NodeCard` and optionally `summary`/`description`/`usage`/`purpose` by handle; never the body. |
| `coordination_chain` | Query one bounded relation chain: dependencies, dependents, satisfies, satisfied_by, baseline, prerequisites, unmet, path or cycle. Depth ≤ 8, links ≤ 50, ~1,500 tokens; never an AST or graph object. |
| `coordination_read` | The only tool that returns file content. Reads a byte range (end exclusive) or a line range (1-based inclusive), capped at 256 KiB / 2,000 lines / 16k tokens per call. |

P0 parsers are lexical and deterministic: JS/TS/JSX (imports, exports, `require`, dynamic import, symbols, comments), CSS/HTML/Markdown (`@import`/`url()`, script/link/img, links/images/headings/front matter/fenced divs/formulas), TeX (theorem-like environments, proofs, labels/refs, math, `\input`/`\include`), generic formulas (Markdown/TeX/spreadsheet/MathML/OMML/unknown; no evaluation), and a lexical dependency graph (external filtering, topological order, cycles, levels, isolated vertices). Malformed input produces diagnostics and `truncated`, not a crash.

Every parsed node is **blueprint-only**: `path`, UTF-8 `byteStart`/`byteEnd`, 1-based `lineStart`/`lineEnd`, `sha256:<hex>` fingerprint and `charset`; no `text`, `body`, `content` or AST. The same holds for `NodeCard` and `ChainLink`. `coordination_read` is the single content path; it rejects absolute paths, UNC paths, traversal and symlink escapes, refuses NUL/binary/undecodable content, and hashes what it returns.

| Limit | Value |
|---|---|
| Source text per parse | 1 MiB; prefix parsed and marked `truncated` |
| Tokens per parse | 200,000 |
| AST depth | 256 |
| Parse wall clock | 2,000 ms |
| Diagnostics retained | 100 |
| Node metadata per parse | 20,000 |
| Dependency graph | 20,000 vertices / 100,000 edges, fail-closed |
| Formulas | 5,000 per scan / 512 references |
| Parse cache | 256 files, LRU keyed `path+mtime+size+parserId` |
| Read range | 256 KiB / 2,000 lines / 16,000 estimated tokens |
| Chain projection | depth ≤ 8 / links ≤ 50 / ~1,500 tokens; 50k nodes / 200k edges fail-closed |

`parser.enabled` is read when the file tools are registered; parser limits and `chain.depth`/`links`/`tokenBudget` are captured when the lazy tool runtime creates its `ParseService`/`ChainEngine`. A live change through `/config` therefore does not retune an already-created runtime; it takes effect on the next registration (today a locale change or restart). The workspace root falls back to `process.cwd()` because the plugin entry does not receive DSH's workspace root; a host whose cwd is not the workspace must pass a root through tool options.

**No write or refresh tool exists.** The v24 write contract needs `expectedFingerprint` conflict detection, transactional reparse and range recomputation, explicit charset/BOM changes and a watcher/rename policy; none is implemented, so a writer would risk overwriting concurrent edits or returning stale ranges. `coordination_write` and `coordination_refresh` are design/planned.

## Data structures

The shared library in `src/shared/` is pure ES2022: hash/LRU, nodes, binary/B+ and red-black trees, heaps, stack/deque/queue, ordered maps/sets/skip lists, AST/token stream, directed graph, trie and sparse grid. The current runtime uses:

- `LruList` for the token-estimator memo, parse cache, node registry and chain projection cache.
- `BinaryHeap` for `selectContext`, preserving the old total order (value desc → created asc → id byte-asc → input index).
- `RedBlackTree` predecessor/successor for numeric agreement; the exact argmax proof is in the adoption document.
- `OrderedSet` for first-seen dedupe in comprehension/emotion/permission; `Queue` for the permission-command token stream.
- `DirectedGraph` for the dependency graph and one graph per chain relation.

The second adoption pass is measured and randomized-tested. Its honest caveat: on the 20k-chunk **wide** synthetic case the heap is not faster than V8 sort (17.7 ms vs 15.9 ms); it wins when the budget fills early and is never worse in result. `SparseGrid` and `BPlusTree` are regression-tested in the shared library but **not wired into a runtime path**; do not infer they are used.

## Tools and routes

| Tool | What it returns |
|---|---|
| `coordination_selection` | Read or patch the five selections for a session (including `command` and DSH `preset`); returns `SelectionState` with lock, presets and config projection. |
| `coordination_profession` | Read the current profession record; set a profession only before/without an active task. A locked task returns `PROFESSION_LOCKED` and leaves the selection unchanged. |
| `coordination_profession_lock` | Read the lock state/profession of the active turn, or of a given turn ordinal. |
| `coordination_parse` | Body-free parse projection (references, diagnostics, charset, truncation, cards). |
| `coordination_describe` | Body-free `NodeCard` and requested metadata fields. |
| `coordination_chain` | Bounded `ChainProjection` only. |
| `coordination_read` | The only content-returning tool; capped byte/line range. |
| `coordination_file` | Bounded workspace tree of indexed paths. |
| `coordination_outline` | Structure outline of one file or the workspace. |
| `coordination_importation` | Import rows of one file or the workspace. |
| `coordination_exportation` | Export rows of one file or the workspace. |

All routes live under `/deepseek-coordination`; there are **33 paths / 36 method handlers**:

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | Liveness; returns plugin name, `pong`, current locale. |
| GET | `/proxy/status` | Cache-proxy status: counts, ids and hashes only (body-free). |
| POST | `/echo` | Echo a JSON body (diagnostic). |
| GET, POST | `/selection` | Read `SelectionState`; patch the five choices. |
| GET | `/presets` | DSH permission-preset catalog projected for the dropdown. |
| POST | `/permission` | Apply one DSH preset immediately. |
| GET, POST | `/config` | Read `{ values, defaults }`; apply a flat config patch. |
| POST | `/config/compaction` | Compatibility patch for `auto`/`soft`/`hard`. |
| GET | `/takeover/pending` | Pending approval/question windows for a session. |
| POST | `/takeover/answer` | Deliver a validated human answer; invalid answers keep the window open. |
| POST | `/takeover/cancel` | Cancel a window and delegate to the host default. |
| POST | `/profession/rebuild` | End the active task and create a replacement with a new profession. |
| POST | `/profession/abandon` | End the active task without a replacement. |
| POST | `/locale` | Report the client language; re-registers localized tool descriptions. |
| GET | `/state` | Selection plus coordination metrics (`session`, `turn`, `plan`, `subtask`, `trace`, `takeover`, `schema`). |
| GET | `/amp/identity` | Public Ed25519 identity `{ kid, alg, publicKey }`. |
| GET | `/amp/manifest` | Signed AMP manifest. |
| GET | `/amp/frame` | Latest AMP frame for `?session=`. |
| GET | `/amp/receipts` | Newest receipts (`?limit=`). |
| GET | `/amp/ledger` | Chain head plus entries (`?limit=`, `?full=1`). |
| GET | `/amp/verify` | Recomputed chain verdict, latest checkpoint. |
| POST | `/amp/checkpoint` | Seal a signed checkpoint over the current tip. |
| GET | `/graph/tree` | Bounded workspace tree (`?root=` override). |
| GET | `/graph/outline` | File or workspace structure outline. |
| GET | `/graph/intra` | In-file symbols and edges. |
| GET | `/graph/dependencies` | File/workspace dependency links and cycles (`?level=file\|intra`). |
| GET | `/graph/imports` | File/workspace import rows. |
| GET | `/graph/search` | Search the persisted graph. |
| GET | `/graph/agents` | Read-only agent roster with estimated progress. |
| GET | `/graph/agents/messages` | Bounded, no-store agent transcript. |
| GET | `/graph/preview` | The only body-bearing file route; bounded, no-store. |
| POST | `/graph/index` | Index a fresh workspace (`409 BUSY` while running). |
| POST | `/graph/rebuild` | Re-parse the already-known paths (`409 BUSY` while running). |

There is no `coordination_write` or `coordination_refresh` tool. The four file tools and the four graph tools carry inline EN/zh-CN copy because the shared `ToolName` table has no keys for them yet; the three composer tools use the shared copy table.

## Data, privacy and safety

- The plugin owns an independent SQLite database. It never opens DSH's `harness` database. The default path is `%DSH_HOME%\coordination\coordination.db`; `database`/`databasePath` are deployment-only and are neither projected nor writable from `/config`.
- Parser nodes, `NodeCard`s, `ChainLink`s and their tool results never carry file bodies, attachments or ASTs. Only `coordination_read` returns text, and only for the requested range.
- Preview is the only body-bearing route: workspace-relative only, 64 KiB text cap, user-initiated, never cached or logged; every other graph route stays body-free. Office previews are converted server-side and size-capped; no file is written.
- The workspace panel is read-only: no edit/rename/delete/create/build; the only non-GET graph routes are POST `/graph/rebuild` (re-parse known paths) and POST `/graph/index` (scan and index a fresh workspace).
- File paths are workspace-relative; absolute paths, drive-rooted paths, UNC paths, `..` escapes and symlink escapes are rejected before a read. Binary/NUL/undecodable content is refused rather than guessed.
- The turn hook records turn metadata and an empty prompt row; it does not mirror the DSH transcript. No file content is copied into the coordination database.
- Permission presets are written to DSH immediately (full access needs a second confirmation) and are never stored in the offline localStorage copy. Offline replay covers only the five stored selection fields.
- The optional cache proxy adds no transport and no credential surface: it forwards through DSH's own `ctx.llm.stream`, traces structural counts only, and refuses providers outside its allowlist.
- Takeover never auto-approves. Timeout, abort, cancel and unload delegate with `next()`; only a human decision delivered through the answer route settles a window.
- Fail-closed behaviour is explicit: invalid takeover answers leave the window open; `PROFESSION_LOCKED` leaves the selection intact; parser uncertainty is `unverifiable`; graph/parse overflow is `truncated`; compaction failure is a no-op; chain `unknown` never auto-passes.
- The coordination DB stores task/audit rows (including `prompt` and trace rows), not credentials or provider secrets. The config projection contains no DSH credential, token or provider key.

## Testing, quality and limitations

| Check | Result |
|---|---|
| `npm test` | **872 tests, 871 pass, 1 skipped (GC-only), 0 fail**, ~9 s on Node 24.21.0 |
| `npm run typecheck` / `npm run test:tsc` | Clean |
| `npm run build` | Host + client bundles green; MUI `"use client"` directive warnings are non-fatal |
| `npm run pack:check` | OK: the runtime tarball carries the four shipped files |
| Release CI | `.github/workflows/release.yml` runs typecheck, test:tsc, tests, pack:check and attaches the tarball to a `v*` GitHub Release |

Parser and structure numbers are guards, not promises: a 100k-character parse test stays under 3 s; the data-structure report records B+ tree 10k inserts at 8.3/9.8 ms, skip-list 10k inserts at 6.4 ms, red-black 10k random set/delete at 13.5 ms, sparse grid 10k cells at 5.1 ms, and `hashString` 100k calls at 4.3 ms on the audit machine. The complexity audit records the ordinal `COUNT(*)` → `MAX(ordinal)` change (≈65–69 ms → ≈12–14 ms for 2,000 statements) and route ranking (2,400 → 200 posterior statements for 200 × 12 routes).

Known limitations, stated rather than hidden:

1. **Durable graph is bounded.** `node`/`edge`/`snapshot` are schema 25 and survive a new runtime; rehydration is bounded to the newest 10k nodes / 50k edges, removed symbols are not pruned, and a handle older than the rehydration window is `NOT_FOUND`.
2. **Domain extraction is parser-level; some projections are still partial.** Book/Article/Part/Chapter/Section/Paragraph, Person/Venue, Condition, Sheet/Cell/Range and TeX proof status are emitted and projected onto node cards; docx/xlsx/pptx now parse through a bounded ZIP+OOXML reader, while Publisher/Access stay explicitly unsupported. `partOf`/`condition` edges are queryable through `coordination_chain`; cross-file Book composition and Sign promotion remain deferred.
3. **The core turn pipeline is wired, the wider engines are not.** Comprehension → Organization → Plan/score and required Predict rows now run for `command=none` turns, with the scene policy applied where ports exist. Standalone Emotion/Bayesian/Cognition/Orchestration/Learning/Resource/Score, plan rebuild loops and decompose/dispatch/verify/synthesize remain library-only. Reasoning is DSH-owned and no longer reported as a plugin gap; `allowBash`, `maxIteration` and non-writing score thresholds are still recorded as deferred diagnostics, not faked.
4. **Configured caps are live.** `parser.maxAstDepth`, both dependency-graph caps and `tools.maxResultBytes` are consumed; parser/chain limits retune an existing runtime, and a config change no longer leaves a stale tool runtime.
5. **Workspace root is resolved, not hard-coded.** Tool option → service root → host root → sandbox-policy root → `process.cwd()` only as the last fallback.
6. **`parser.enabled` still needs registration.** The other file-layer limits retune live; turning the parser off fails closed immediately, but adding/removing the four tools requires the next registration (restart).
7. **No browser E2E test.** The UI is covered by types, build, the settings-catalog tests and the takeover/bridge/integration tests; visual verification remains manual/screenshot-based.
8. **Node engine is `>=22.13.0`.** `node:sqlite` is unflagged from 22.13.0/23.4.0; CI and this verification use 24.21.0.
9. **A profile can still record an older package spec.** Verify the installed version (`dsh --profile <name> --dump-config` or the profile's `package.json`); install the 0.15.0 tarball or link the built checkout rather than assuming a previous install was upgraded.
10. **The cache proxy is experimental and off by default.** Its brand profiles are policy defaults, not measurements, and it only rewrites content for families with an automatic prefix cache; the observable gain on a stable session may be near zero, which is why it ships behind a flag and a status endpoint rather than enabled.
11. **AMP conformance is boundary-deep, not complete.** Manifests, frames, receipts, events, claims/unknowns, goal/plan pairs (gated on recorded acceptance), the ledger and checkpoints are wired and verified; the sealed envelope and the warrant's hypothesis/revision/authorization functions are implemented and tested but not driven by any path, and hypotheses, governance manifests, credentials, federation and interrupt budgets are not implemented. [`docs/amp-conformance.md`](docs/amp-conformance.md) §7 lists each gap with its reason, and the manifest's `self.limits` states the two unmeasured fields (calibration, token usage).

## Repository history and license

`0.1.x` is **dsh-os**, a different OS-interaction project, no longer on the branch tip; `0.2.0` became the DSH plugin bundle; `0.3`–`0.6` moved the UI from Angular to MDUI to plain React to Material UI; `0.7`–`0.9` added the five dropdowns, i18n, profession lock, takeover, compaction, the P0 parser, the domain model and the shared data structures; `0.10.0` added the settings catalog, the four file tools, the second data-structure pass and the verified tarball; `0.11.0` added durable settings, DSH-owned reasoning and the experimental cache proxy with brand profiles; `0.12.0` added the per-ecosystem domain layer, the chain `kind` filter, the directory layer and `NodeRecord`; `0.15.0` added the AMP v0.1 protocol layer and its conformance document. Earlier states remain in git history and tags.

Apache-2.0 © 2026 Eloy Kim. See [LICENSE](LICENSE). Source: [github.com/eloyhere/deepseek-coordination](https://github.com/eloyhere/deepseek-coordination).




























