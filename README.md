# deepseek-coordination

**English** · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md) · [涓枃鏇存柊鏃ュ織](CHANGELOG.zh-CN.md)

A dual-face Cordis plugin for DeepSeek Harness: the host owns durable coordination state, model-facing tools, an AMP v0.1 protocol layer and an HTTP surface; the client provides docked panels, settings, model-triggered notifications and the service-level takeover dialog.

**Current source: v0.23.4, schema 28.** The 0.23.0 release is the tool-layer and context-architecture program: unified handles, trimmed outputs, `tookMs` on every result, structured truncation, a lean and measured catalog, cache telemetry, a durable state card and a pre-compaction snapshot. 0.23.1 fixes the release workflow's `test:tsc` over the new suites; 0.23.2 syncs the Chinese README's tool and route tables; 0.23.3 refreshes the plugin-list display metadata (`meta.title`/`meta.description`) in both bundled locales; 0.23.4 makes takeover dialogs wait without a timeout (no host-default fallback on cancel) and restyles them with MUI primitives. Durable missions, goals, plans and collaboration duties are exposed through tools and independent panel navigation. Composer coordination dropdowns are removed. Optional skills, commands and dynamic context depend on the services mounted by the runtime; source registration does not establish that this build is loaded in a running app.

| Status | Meaning in this README |
|---|---|
| **Wired** | Registered by `src/index.ts` or called by the composed service, routes or tools. |
| **Library-only** | Implemented and tested as a module, but not driven by the current turn lifecycle or exposed through a route/tool. |
| **Design/planned** | Documented or declared in config/schema, with no runtime consumer yet. |

## What it is

| Piece | Location | Role |
|---|---|---|
| Bundle | `cordis.patch.yml`, `dsh.bundle` in `package.json` | Inserts one `deepseek-coordination` row into a DSH profile roster. |
| Host half | `lib/index.mjs` (ESM, Node) | `CoordinationService`, the `coordination` SQLite database, coordination tools, HTTP routes and agent hooks. |
| Protocol layer | `src/protocol/`, `src/host/amp.ts`, `src/host/ampStore.ts` | AMP v0.1: signed manifest, frame per turn with explicit exclusions, receipts per turn and tool call, append-only ledger, signed checkpoints. |
| Client half | `lib/client.js` (CJS, browser, `__ModuleLoader__` wrapper) | React 18 + Material UI 9: docked panels, searchable settings page, notification surfaces (snackbar / alert / dialog / popover), the consent dialog and the takeover dialog. |
| Database | `%DSH_HOME%\coordination\coordination.db` by default | Plugin-owned SQLite file, schema version 28, with additive planning, duty, control and knowledge projections plus append-only AMP events. Never DSH's `harness` database. |

The plugin does not replace DSH's agent loop. It records coordination state, locks one profession per task, shows the current selection in a read-only panel, exposes file metadata, asks DSH to compact when context pressure crosses a threshold, relays approvals/questions to a human through its own dialog, and pops model-triggered notifications in the same GUI.

The composer keeps DSH's own controls: this plugin no longer contributes dropdowns. The current **职能 (profession), 交互 (interaction) and 情景 (scene)** triple is shown read-only in the docked panel; the agent assigns the values through the `coordination_selection` tool, falling back to the host config defaults, and **验证 (validation)** is no longer displayed.

## Install and build

| Requirement | Detail |
|---|---|
| Node.js | Node 24 or newer, as required by `package.json` and the host's `node:sqlite` import. Verified on Node 24.21.0. |
| npm | npm 11.19.0, declared in `packageManager`, installs from `package-lock.json` and drives the development scripts and release workflow. |
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

`npm run test:tsc` type-checks the test tree. `npm run pack:check` validates the packed runtime files and syntax-checks the host entry. Use npm for this repository's dependencies and development commands; `package-lock.json` is committed, and `npm ci` reproduces it exactly. The DSH profile's dependency manager is managed by Harness; the profile recovery commands below apply to that separate environment.

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
dsh plugin --profile <name> add .\deepseek-coordination-0.23.4.tgz
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
| `lib/index.mjs` | Host ESM, `platform: node` | 2.78 MB |
| `lib/index.d.mts` | Host declarations | 9.5 KB |
| `lib/client.js` | Browser CJS wrapped in `__ModuleLoader__.load()` | 3.44 MB |

Material UI, emotion and `react-dom` are bundled into `lib/client.js`; React itself comes from the host module table. The inlined `react-dom` is the 18.3.1 line that matches the host's React 18 — npm refuses to auto-install a React 19 `react-dom` against a React 18 `react`. The client bundle is large because MUI and `react-dom` are inlined, not because it ships a second React.

## Architecture

Host half (`src/index.ts`):

- exports `name`, `inject = ['webServer', 'tools']` and `Config`; `apply()` resolves config, creates the service, recovers interrupted turns and installs every effect through `ctx.effect`.
- `CoordinationService` (`src/host/coordination.ts`) is the Cordis `coordination` service. It owns the database, module host and the composed modules: session, selection, turn, profession, plan, comprehension, organization, predict, goal, compact, directive, permission, takeover/gate, provider, cache, command, the `TurnPipeline`, the `AmpService`, the AMP planning/collaboration projections, the AMP 0.5.0 scoped control service, the knowledge marks and the Harness goal/plan-mode synchronization (`harnessSync.ts`).
- SQLite is opened with `node:sqlite` (`DatabaseSync`), foreign keys, a 5 s busy timeout and WAL outside `:memory:`. Triggers refuse changing a locked profession and make `orchestration_trace` append-only; AMP ledger, key, manifest and checkpoint records are immutable; planning and duty projections remain mutable.
- The `/deepseek-coordination` prefix route answers JSON `{ ok, value | error }`; request bodies are capped at 1 MiB and unknown paths return 404 with the route envelope. `/amp/*` routes serve protocol artifacts and read-only coordination projections under the same envelope.
- Coordination selection, planning, collaboration, control, environment, knowledge, notification, file and graph tools are registered through `ctx.tools`; the host also registers workspace indexing. The AMP manifest declares capabilities separately from the tool registry. Calls settle as AMP receipts, and tool descriptions follow `POST /locale`.
- Hooks: `agent/pre-step` opens the coordination turn (and its AMP frame) and runs the compaction governor; `agent/turn-stopping` closes it as `done` (and writes the `reflect` receipt); `agent/error` closes it as failed; `approval/request` and `user-questions/request` feed the takeover gate. A 60 s timer deletes expired lock rows.

Client half (`src/client/index.ts`):

- `inject = ['slots', 'locale']`; `package.json`'s `dsh.client.inject` separately lists the four module-table packages.
- `settings.section` mounts `CoordinationSettings`; the client mounts docked panels, the takeover dialog, the consent dialog and the notification surfaces. The composer has no coordination dropdowns.
- Language follows `ctx.locale.getLocale().active`, normalises `zh*`/`en*` onto `zh-CN`/`en-US`, and reports changes to `POST /locale`. The host rebuilds localized tool descriptions from that report.
- The client bridge uses same-origin `fetch` with a 3 s selection timeout and 2 s takeover/locale timeouts. Unreachable hosts fall back to a per-session `localStorage` copy for the five choices; a permission preset is never written offline.
- The dock provides read-only coordination navigation; selection changes use host defaults or `coordination_selection`.

```text
deepseek-coordination/
├─ src/
│ ├─ index.ts                 # host composition root: service, routes, tools, hooks
│ ├─ protocol/                # AMP v0.1 port: types, canonical, ids, envelope,
│ │                          #   manifest, frame, receipt, warrant, plan, ledger
│ ├─ host/
│ │ ├─ coordination.ts      # CoordinationService (Cordis service "coordination")
│ │ ├─ config.ts             # Schemastery schema + resolveConfig()
│ │ ├─ database.ts           # SQLite schema 28; planning, duty, control and knowledge tables
│ │ ├─ amp.ts               # AmpService: manifest/frame/receipt/event, verify
│ │ ├─ ampStore.ts         # AMP SQLite chain, key, manifest, checkpoint
│ │ ├─ ampRoutes.ts        # /amp/* route table (planning, scope, insights, story, ledger)
│ │ ├─ dsh.ts                # narrow DSH ports + turn lifecycle
│ │ ├─ ampPlanning.ts      # durable missions, goals and plans
│ │ ├─ ampCollaboration.ts # owner/assignee duties and handoffs
│ │ ├─ control.ts           # AMP scoped control (registry + settings domains)
│ │ ├─ controlRoutes.ts    # /control/* and /graph/knowledge route table
│ │ ├─ knowledge.ts         # explicit knowledge marks over the registry
│ │ ├─ notify.ts            # bounded per-session notification queues
│ │ ├─ notifyTools.ts      # coordination_notification definition
│ │ ├─ tools.ts              # selection, planning, collaboration, control and file tools
│ │ ├─ graphView.ts        # body-free graph projections + preview builders
│ │ ├─ graphIndex.ts       # workspace index/rebuild jobs
│ │ ├─ chain.ts              # bounded Chain projection engine
│ │ ├─ nodeRegistry.ts      # NodeCard registry and describe()
│ │ ├─ parseService.ts      # workspace-bound parse + read service
│ │ ├─ token.ts              # TokenGovernor and pure policy
│ │ ├─ takeoverGate.ts      # approval/question waterfall gate
│ │ ├─ selection.ts turn.ts profession.ts session.ts — # selection, lock, lifecycle
│ │ ├─ module.ts             # ModuleHost ports and the event bus
│ │ ├─ adapters/sqlite/      # execution/turn/profession/trace stores
│ │ ├─ bayesian.ts comprehension.ts organization.ts —# library engines
│ │ └─ text/                 # P0 parsers: JS/TS, CSS/HTML/MD, TeX, formulas, graph
│ ├─ client/
│ │ ├─ index.ts              # slots, locale store, nav icon, takeover CSS
│ │ ├─ controls.ts           # selection helpers shared with settings; the composer surface is gone
│ │ ├─ settings.ts           # progressive settings page over the 13-group catalog (4 quick switches + accordions)
│ │ ├─ takeover.ts           # approval/question dialog
│ │ ├─ notification.ts       # snackbar / alert / dialog / popover surface host
│ │ ├─ panel.ts              # docked panels: files, amp, planning, collaboration, knowledge
│ │ ├─ ampPlanning.ts ampCollaboration.ts previewHighlight.ts
│ │ ├─ bridge.ts store.ts i18n.ts theme.ts selectionCache.ts
│ └─ shared/                  # entity/enum/selection/i18n/control/notification + data structures
├─ test/                       # 72 *.test.ts + helpers.ts
├─ docs/ampConformance.md     # protocol mapping, invariants, deliberate gaps
├─ docs/cacheStrategy.md      # prefix-cache analysis and brand profiles
├─ lib/                        # build output; gitignored, never edited by hand
├─ cordis.patch.yml            # bundle row inserted into a profile
├─ scripts/checkPack.mjs      # tarball runtime-file verification
└─ .github/workflows/release.yml
```

## AMP v0.1 protocol layer

The host half implements the [Attention Manifest Protocol](https://github.com/eloyhere/attention-manifest-protocol) at its boundaries using the `attention-manifest-protocol` npm runtime dependency (0.6.0). `src/host/amp.ts` and `src/host/ampStore.ts` adapt the official canonicalisation, frame, warrant, signature and checkpoint APIs to DSH lifecycle and SQLite persistence; `src/host/tools.ts` uses its `outlineAddress` bridge to turn persisted node ranges into BOM-correct read offsets. `src/protocol/` retains host-specific artifact builders and compatibility tests. See [`NOTICE`](NOTICE) and the full [`conformance map`](docs/ampConformance.md). The official package requires Node 24 or newer.

| Artifact | Produced when | Served at | Signature |
|---|---|---|---|
| Manifest | first read, then reissued every 12 h or when the policy digest changes | `GET /amp/manifest` | Ed25519 over canonical JSON, `signatures` excluded, `digest` included |
| Frame | `beginTurn` | `GET /amp/frame?session=` | `digest` over the frame body (integrity, not authentication) |
| Receipt | turn close (`reflect`) and every tool call (`read`/`attend`/`act`) | `GET /amp/receipts` | none — integrity comes from the ledger chain |
| Claim | turn close, from the comprehension row (`intent`/`requirement`/`constraint`/`assumption`) | `GET /amp/ledger` | none — `confidence` is derived, evidence carries a digest |
| Unknown | turn close, from the comprehension ambiguity | `GET /amp/ledger` | none |
| Goal | explicit planning creation, or turn close when a goal row and per-step acceptance exist | `GET /amp/ledger` | none |
| Plan | explicit planning creation/update, or turn projection with per-step `expect` and a constraint | `GET /amp/ledger` | none |
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
- **Generic mirrored bus events elide prose.** `ledgerProjection` keeps id-shaped strings and numbers. Explicit AMP goal criteria, plan checks and bounded duty submissions/reviews retain their recorded text.

The sealed A-surface envelope is implemented and tested but not wired: this deployment has no peer to exchange messages with. The other artifacts are wired through turn, planning, tool or HTTP paths; §7 of the conformance document lists each remaining gap with its reason.

### Historical live verification (2026-10-29)

The historical build was installed into `%DSH_HOME%\profiles\desktop` with `dsh plugin --profile desktop add` and verified against the running client:

| Check | Result |
|---|---|
| Host half loads in the running app | `GET /deepseek-coordination/ping` → `{ ok: true, —}`; `GET /amp/identity` returns a real Ed25519 `kid` |
| Manifest is signed, and verifiable *outside* the plugin | `digestMatches: true`, `signatureValid: true`, `kidMatches: true` with an independent canonical-JSON + WebCrypto verifier |
| Real turns produce artifacts | 19 ledger entries: 3 frames (4 slots, 2 exclusions each), `turn.opened` mappings, tool receipts, a `reflect` receipt for a closed turn, and mirrored `pipeline.report` events with their prose elided |
| Frames are served | `GET /amp/frame?session=… → mode, cycle, digest, slots with `why`, `ignored` with `revisit_if` |
| Checkpoints seal the live chain | `POST /amp/checkpoint` → `seq 0` over `count 19`; `GET /amp/verify` → `{ ok: true, reasons: [] }` |
| Client module is served | `plugins/??deepseek-coordination/client.js&rev=… →3,441,910 bytes, present in `__DSH_BOOT__.entries` |

The live run also caught a real defect: `coordination_selection` returned a value DSH rejected as "not lossless JSON". 0.17.2 omits absent projection fields and detaches every tool result through `jsonSafe` before it crosses the boundary. Two operational facts matter:

- **An update is not hot-swapped.** Adding the package hot-loaded it; replacing the installed build while the app was running left the old module in memory. `GET /ping` now reports `version`, so the running build is observable; restart the app to load a new one.
- **A headless profile does not activate the plugin**, because it declares `inject: ['webServer']` and headless mounts no webserver. Mounting `@deepseek-ai/dsh-host-webserver` (plus its startup row) or relaxing the inject is the fix; the composed service itself does not need the routes.

## Selection semantics (agent-assigned, no plugin UI)

The five dimensions are session state, not controls. This plugin ships **no dropdown, no permission selector and no rebuild/abandon dialog**; the composer keeps only DSH's own controls and the dock only displays the resulting values. The agent allocates them dynamically: it reads and writes them with `coordination_selection` (defaults come from host config), and for the `interaction` and `scenario` domains it may record a weighted mix through `coordination_control` instead of pinning a single value. What remains is service-side enforcement:

| Dimension | Values | What the service enforces |
|---|---|---|
| 权限 Permission | DSH preset catalog, or a neutral “follow DSH” state | Written to DSH immediately through `ctx.permissionPresets` (or `POST /permission`) and never persisted in the coordination DB. There is no plugin permission control; the local 权限接管 switch only hides DSH's own access-mode button. |
| 职能 Profession | decision / outcome / resource / personnel / qualification / execution | Locked for the active task. A different value is refused with `PROFESSION_LOCKED`; changing it means `POST /profession/rebuild` or `/profession/abandon` through the tool/route surface — there is no plugin dialog. |
| 交互 Interaction | emotion / think / heuristic / converge / orchestrate | Stored for the next turn; frozen while the active turn has a non-cleared goal. |
| 情景 Scene | dialogue / writing / office / research / engineering / iterate | Stored for the next turn. `writing` sits between `dialogue` and `office`; the scene policy is read by the turn pipeline. |
| 验证 Validation | low / medium / high | Stored for the next turn; frozen while the active turn has a draft/scored/active plan. All three levels search. |

The scoped-control layer is separate: `coordination_control` stores a selector or a weighted `mix` for the `interaction` and `scenario` domains at `global → workspace → session` scope and reports the effective selector and mix. Those vocabularies are `affect`/`think`/`inspire`/`converge`/`orchestrate` and `chat`/`writing`/`office`/`collaboration`/`investigation`/`research`/`engineering`/`iteration`; the mix is configuration the agent can weigh, not a runtime that picks a value for it.

The turn pipeline reads the validation budgets:

| Level | Queries × results | Evidence scope | Interaction scope |
|---|---|---|---|
| low | 1 × 3 | Current turn only | Selected interaction |
| medium | 2 × 5 | Current session | Selected interaction |
| high | 4 × 8 | All local content | All interactions |

The budgets live in `src/host/comprehension.ts` and the shared `ValidationBudgetByLevel` table. The turn pipeline runs comprehension → organization → plan/score for `command=none` turns and hands the selected validation level to the comprehension stage; when the host mounts no search or sandbox port the stage records a deferred diagnostic instead of failing the turn.

### Scenes and the writing profile

| Scene | Plan | Outline | Revision | Score | Bash | Web | Max iterations |
|---|---|---|---|---|---|---|---|
| dialogue | —| —| —| —| no | yes | 1 |
| writing | yes | yes | yes | yes | no | yes | 3 |
| office | yes | —| —| —| no | yes | 1 |
| research | yes | —| —| —| no | yes | 3 |
| engineering | yes | —| —| —| yes | yes | 3 |
| iterate | —| —| —| yes | no | yes | 3 |

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
| c/c++ | `cFamily.ts` | `module`, `class`, `function`, `method`, `variable`, `importation` |
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
- **Bounded.** ZIP entries ≤ 2000, uncompressed ≤ 64 MiB per entry / 256 MiB total, XML nesting ≤ 128, nodes ≈`MAX_METADATA_NODES` (20 000), and the parser honors the token/time budgets.
- **`SUMMARY.md` resolves to `book`** through the registry's filename-first rule; `README.md` and other Markdown stay with the Markdown parser.

A broad request is not parked as an ambiguity condition: comprehension's `任务描述过于宽泛（A / B）` finding is split into per-fragment plan steps (`Turn the broad request into a verifiable sub-task: A`) with a concrete acceptance each, so the plan is monitorable from the first turn. `ambiguityWithoutBroadTask()` keeps whatever other ambiguity was found.

The graph answers "what is in this workspace" through `coordination_parse`, `coordination_describe` and `coordination_chain`. The chain query takes an optional `kind` (trimmed, case-insensitive) on every node-returning action, so "all lemmas" or "all chapters" is one call instead of a scan. Directory nodes are derived from unambiguous workspace paths and connected with `contains`/`part_of`; the invariant is **`part_of` (child → parent) exact, `contains` (parent → child) best-effort**.

## Harness integration

The navigation tabs are not a second planning system: they are the recording side
of the Harness's own lifecycle services. The full one-to-one table lives in
[`docs/harnessMapping.md`](docs/harnessMapping.md); the rules that matter when
reading the code are:

- **Goals and missions** push into `ctx.goals` on `active` (create, or resume the
  live goal when the objective matches), `achieved` (complete) and `abandoned`
  (clear). A queued mission is *not* mirrored, because the Harness keeps one
  current goal per agent. Reads also **import** a Harness goal that has no AMP row
  yet: its objective becomes an AMP goal (deterministic id, one `host-completion`
  success criterion), the local lifecycle is aligned through legal edges, and
  repeated reads are idempotent — no duplicate row, no extra ledger entry. A
  phase changed elsewhere is reported as divergence, never silently rewritten.
- **Plans** map onto `ctx.planMode`: the switch follows "is any plan executing",
  since the Harness owns a boolean plan mode, not a plan document.
- **Skills** are discovered read-only through `ctx.sessionSkillCatalog`, and made
  writable through this plugin's `skills` control registry: a registry row with
  the same id overrides the catalog row, can be enabled or disabled, and is
  projected back into the live catalog through the plugin's `ctx.skills` provider.
- **File access** is the fourth quick switch (`ui.takeoverFiles`). When it is on,
  a `tools/pre-execute` listener records `read` in the AMP ledger and denies
  `write`/`edit` whose target resolves outside the workspace root; anything the
  gate cannot prove is allowed. When it is off, no listener is registered at all.
- **Registries without a Harness service** (`modules`, `environments`, `tools`,
  `cognition`, `capabilities`, `abilities`, `progress`, `protocols`, `concepts`)
  are plugin-owned; nothing is invented on the Harness side for them.
- Every push is best effort: a refused call is recorded in `harness_link.note`
  and shown as `harness.goals = diverged`, never thrown into the AMP transaction.
## Durable missions, goals, plans and collaboration

`coordination_mission` queues AMP Goals, activates one mission per session by priority then FIFO, and explicitly completes or abandons it. Selection and planning tools use native DSH session IDs for `session` (defaulting to the calling agent). `coordination_goal` manages proposed → committed → active → achieved/abandoned lifecycles. `coordination_plan` manages plans and tasks: prerequisites must be done before a task starts, every task must be done before its plan completes, and attached non-abandoned plans must finish before goal achievement. Records survive restart; ending a DSH turn does not complete a session mission.

`coordination_collaboration` supports `list`, `agents`, `assign`, `accept`, `start`, `submit`, `verify`, `reject`, `cancel`. Its actor comes only from `exec.agent.id`. Assignment requires the native descendant roster with valid parent/depth lineage; without that capability it refuses assignment. Use native DSH session IDs returned by the roster for `assigneeSession`, not opaque coordination handles or invented IDs. Roles are `decision`, `outcome`, `resource`, `personnel`, `qualification`, `execution`.

The bound assignee accepts, starts and submits with a nonempty summary and evidence. The owner verifies or rejects with a review, or cancels. States are assigned → accepted → working → submitted → verified/rejected; rejected work may return to working. Submitted work awaits owner review. Submission or verification does not automatically complete a linked plan or task; update those explicitly after checking acceptance. Duties may reference the owner's goal, plan and task. Schema 28 stores planning and duty projections with transactional AMP artifacts/events; mission and duty add no AMP artifact or ledger entry kinds.

When DSH mounts its skill registry, provider `deepseek-coordination` registers eight bundled skills at fallback rank **600**: `amp-planning`, `amp-missions`, `amp-goals`, `amp-plans`, `amp-collaboration`, `amp-duties`, `amp-delegation`, `amp-handoffs`. Bodies load on demand, and **descriptions are served in the host's current language** — each skill carries one English and one Chinese sentence, and `POST /locale` invalidates the catalog instead of shipping both languages in one string. Optional read-only human commands `/coordination-missions`, `/coordination-goals`, `/coordination-plans`, `/coordination-duties` show the calling session's records without scheduling a model turn; their descriptions and refusal text are localized the same way and re-register on `POST /locale`.

Optional dynamic **user-role recorded context** is capped at 4,000 characters: up to six nonterminal duties, three missions, three goals and two plans, with bounded fields and explicit truncation counts. The block ends with a durable `stateCard` — the objective, open duties, the executing plan with its next task, one imperative next action and the effective interaction/scenario constraints. The card is rebuilt from the plugin's durable rows on every step, so compacting the chat history cannot drop it; `GET /amp/state-card` exposes the same object. It derives the session from the current agent, including child agents assembled with that agent context. A separate continuable-child setup hook is registered only on runtimes exposing `registerContinuableSetup`; it is not required for session-filtered global context. These capability-gated source integrations do not establish actual live loading or invocation.

## Coordination panel (read-only)

The dock is one panel with fifteen tabs: `files`, `amp`, `missions`, `goals`, `plans`, `collaboration`, `outline`, `imports`, `exports`, `dependencies`, `project`, `cognition`, `capabilities`, `skills` and `knowledge`; `preview`, `insight-detail`, `agents` and `agent` are routed pages behind rows, not tabs. Planning pages link related records; collaboration displays responsibilities, acceptance, submissions, evidence and reviews. For example, `#coordination/panel/right/missions` opens missions. Planning, collaboration, cognition and knowledge data do not require a current frame. The knowledge tab has three compact blocks — knowledge files, the control-registry browser (with an enable/disable switch per row) and the effective scoped settings — and adds no tab of its own.

The AMP story view is written for a general reader. It is MUI end to end — `Card` sections, `Table`s for the plan, the ignored items, the actions and the technical rows, and one collapsed `Accordion` for the raw evidence. It answers three questions in order:

- **What it had to solve** — the turn's **actual prompt excerpt** (`/amp/story`), the turn ordinal, the 职能 / 交互 / 情景 labels with the rule each one imposes, any goal text, and a table of the plan's steps with their recorded acceptance. The composer no longer has dropdowns; this is where the values are visible.
- **What it deliberately set aside** — a table of the ignored items by name, the reason class, and the exact "reconsidered when — condition. The raw `why` / `revisit_if` text, digests and ids live under a collapsed **technical details** accordion.
- **What it did, and whether the record can be trusted** — the five latest receipts in plain words (read / focus / review / ask / tool call) and one trust line: "the record is complete and unmodified · N entries · append-only and signed", or the verifier's failure reasons.

Panel typography is rem-based with a **1 rem (16 px) floor** (`PANEL_TYPE_SX`): no text in the dock is smaller than 16 px. Values are never reshaped — the digest and tip in the technical details are the digest and tip a verifier checks. A missing session or frame is an explicit empty state, not a fallback to file browsing. Minimized, the panel collapses to a single floating button at the top-right of the conversation; its view is the `amp` hash route (`#coordination/panel/right/amp`).

## Settings and configuration

The settings page is a **progressive** view over `SETTINGS_CONTROLS` in `src/shared/selection.ts`. The catalog still carries every row in 13 groups, but the page opens on **four common switches** — permission takeover, composer selectors, host-dialog takeover, and the host-executed **file read/write takeover** (`ui.takeoverFiles`) — and everything else lives in collapsed accordions whose bodies are not mounted until opened (new-task defaults, display, and 13 advanced groups). The first paint is four rows instead of the whole catalog. There is **no save button**: a host row writes through `/config` on change (optimistic, with a single-row rollback on failure), a local switch writes the browser store immediately, and single/all reset apply at once after one confirmation.

`ui.takeoverFiles` is not a stored flag with no effect: when it is on, a `tools/pre-execute` listener decides file access — `read` is recorded in the AMP ledger, `write`/`edit` are refused when the target resolves outside the workspace root, and anything the gate cannot prove (unknown path, unknown root) is allowed. When it is off, no listener is registered at all; `POST /config` calls `fileGate.sync()` so toggling takes effect without reloading the plugin. Twelve scene leaves (`scenes.*.thinking`, `scenes.*.reasoningEffort`) stay in the schema but have no row: DSH's model page owns reasoning, and duplicating it here would create two sources of truth. The 18 top-level config keys include `database` and `databasePath`, which are deliberately not projected or writable.

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
| `ui` | toolbar `true` (deprecated alias), showTooltip `true`, takeover `false`, takeoverFiles `false`, refreshInterval `5000 ms`, compact `true`, locale `auto` | Host rows plus the local switches; `takeoverFiles` installs the file gate, toolbar/locale read-only |
| `scenes` | six scene profiles, 9 exposed rows each (thinking/effort remain schema-only) and a writing threshold of `0.6` | Host rows; only the writing score threshold is read by `plan.ts` |
| `parser` | enabled `true`, 1 MiB, 200k tokens, depth `256`, 2 s, cache `256`, graph 20k/100k | enabled + four limits host rows; depth and graph caps planned |
| `chain` | depth `8`, links `50`, tokenBudget `1500` | Host rows |
| `tools` | maxResultBytes `0` | Planned/read-only; not consumed |
| `defaults` | profession `execution`, interaction `think`, scene `dialogue`, validation `medium`, command `none` | Host rows |

`GET /deepseek-coordination/config` returns `{ values, defaults }`; `defaults` is `resolveConfig(undefined)`, so the page never duplicates a default literal. `POST /config` accepts a flat dotted patch such as `{ "plan.threshold": 0.7 }`, validates it against the catalog and the real Schemastery schema, applies it to the live config, re-resolves invariants (weight normalisation, alias mirror, forced flags, compaction clamps), rebuilds `TokenGovernor` when compaction changes, and persists the applied paths.

Persistence is the host's own override document at `<database dir>/config.overrides.json`: a flat `{ "plan.threshold": 0.7 }` map written atomically beside the coordination database and merged over the profile config on the next start. It is not DSH's `ctx.settings.update`, which only accepts `.volatile()` schemas — and a volatile node turns every parsed value into a reference wrapper this host cannot adopt without rewriting every config reader. `persisted: true` therefore means "stored in the coordination host's own document"; a write that only touched ignored rows reports `false`. Unknown keys, `databasePath` and `database` are rejected with `INVALID_ARGUMENT`. Known but non-editable keys are reported in `ignored` and never written. `POST /config/compaction` remains as a small compatibility route for the old auto/soft/hard patch.

The page is Material UI end to end: a sticky command bar (search over labels, hints and config keys; a `只看已修改` filter; expand/collapse all) above a chip rail that lists the visible groups with their row counts, then one collapsible section per group. Common groups start open; the technical tail (`orchestration` — `tools`) starts collapsed behind an `高级` tag, and a search expands whatever it matches. Rows are two-column (label and hint on the left, control on the right); a row that differs from the schema default gets a dot, an inline default line and `恢复默认`, and every accepted save flashes `已保存` on the row plus a bottom-right Snackbar. `Checkbox` for booleans, `RadioGroup` for enums, `TextField type="number"` for every number (weights and ratios included, rounded to the row's step for display only), and `Chip` only for the exceptional `本机 / 强制 / 只读 / 计划中` states — the `主机` chip is gone because it was the common case. Six scene cards hold the six tables (no scene dropdown). The full-access confirmation is a modal MUI `Dialog` above the tooltip layer, never an inline banner. There is no save button; controls apply on change/blur. A forced row draws a disabled control, a read-only row shows a value, and a planned row says the runtime does not read it yet. The settings nav icon is a host-shell workaround: the shell accepts only `{ id, order, label }` for a section, so the plugin decorates its nav button with a CSS mask of the Material `sync` glyph.

### Internal Elasticsearch (`coordination_search`)

Search is configured by environment, not by the settings catalog: `COORDINATION_ES_URL` (default `http://127.0.0.1:9200`), `COORDINATION_ES_INDEX` (default `coordination`), optional `COORDINATION_ES_API_KEY` or `COORDINATION_ES_USERNAME`/`COORDINATION_ES_PASSWORD`, and `COORDINATION_ES_TIMEOUT_MS` (default 5000, clamped to 500–10000). The connection is never a tool argument, so a prompt cannot point the tool at another host or smuggle credentials into a query. The client is `@elastic/elasticsearch` 9, which this host already carries through `attention-manifest-protocol`; it is imported lazily, so a host without the package still boots. A call with no reachable cluster returns an `UPSTREAM` error naming the URL, and a missing index returns `NOT_FOUND` — the tool never fabricates hits.

## Service-level takeover

- With `ui.takeover` on, `TakeoverGate` listens to DSH's `approval/request` and `user-questions/request` waterfalls. It records a durable pending row, emits `takeover/pending`, and waits for a human answer delivered through the client routes.
- The listener registers with `{ prepend: true }`. DSH's own approval and question UI listens to the same waterfalls, and a listener registered later never runs once the GUI claims the request. Note that a deployment approval policy of `never` makes DSH reject before the waterfall, so no dialog can appear regardless of this switch.
- A pending window has **no timeout**: it waits for the operator until answered or cancelled. Cancel is fail-closed and never delegates: an approval settles `cancelled`, a question settles with no selections, so DSH's default dialog never appears after the custom one closes. Only an aborted request signal or plugin unload calls `next()`, and the gate never turns “nobody answered” into `allowed-once` or a fabricated answer. `unavailable` is the host's fail-closed outcome and is rejected as a user decision.
- The dialog polls `/takeover/pending` every 1 s only while the local 权限接管 switch is on, the session id is real and the document is visible. The first pending request is rendered; a `1 / N` badge appears for a queue.
- Approval offers 仅本次允许 / 拒绝 / 取消; only `allowed-once` and `rejected` are submitted, while cancel/Esc/backdrop use the cancel route (fail-closed, with no host dialog afterwards). Questions render radios for single-select, checkboxes for multi-select and optional free text; submit stays disabled until every question is answered.
- **Both switches are needed**: host `ui.takeover` (default `false`) opens the gate; the local 权限接管 switch makes the dialog poll. With the host switch off, the gate delegates immediately and there is nothing to show.

## Cache proxy (experimental, off by default)

DSH freezes a model request before any adapter sees it: `buildRequest()` deep-freezes the messages and `Object.freeze`s the request, and the `llm/stream` waterfall's fallback closes over that object. The one supported place where outgoing content can still be rebuilt is the adapter boundary, so the plugin registers an extra provider route (`coordination-proxy`) and forwards each request to the real provider after rebuilding it.

Wiring (`src/index.ts`, `src/host/proxyService.ts`, `src/host/proxyAdapter.ts`, `src/host/modelBrand.ts`):

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

The soft threshold is editable as a 0.30—.90 ratio; the hard threshold as 0.30—.98 and strictly above soft. The old 60/70/80/88% values remain valid choices (`0.60`, `0.70`, `0.80`, `0.88`) even though the catalog now edits it as a number field with 0.01 precision. Auto compaction is disabled by `compaction.auto=false`, but an explicit compact command is not governed by that switch.

Fail-safe rules are deliberate: the hook never blocks the step; a missing compaction port, `null`/`undefined` result, timeout, throw, spent per-session allowance or unelapsed cooldown all become a no-op, and the agent proceeds to `next()`. The governor snaps the policy at construction, so a live settings change also rebuilds it. DSH owns the actual safe range and replacement; this plugin only decides when it is worth asking.

## File tools, parser and Chain

The file layer exposes the following model-facing tools alongside selection, planning, collaboration, indexing and read-only graph tools (see [Tools and routes](#tools-and-routes)):

| Tool | Purpose |
|---|---|
| `coordination_parse` | Parse a workspace file or supplied text. Exactly one of `path`/`text`; returns references, diagnostics, charset, truncation and node cards, never the file body. `verbosity:"compact"` (default) keeps `identity/kind/name/line range` per card and drops the per-node `reference` copy; `verbosity:"full"` returns complete `NodeCard`s. |
| `coordination_describe` | Read one `NodeCard` and optionally `summary`/`description`/`usage`/`purpose` by handle; never the body. A handle from `coordination_outline` is accepted even when the bounded node registry no longer holds it: the tool falls back to the persisted graph and re-registers that node. |
| `coordination_chain` | Query one bounded relation chain: dependencies, dependents, satisfies, satisfied_by, baseline, prerequisites, unmet, path or cycle. Depth ≤ 8, links ≤ 50, ~1,500 tokens; never an AST or graph object. When nodes are indexed but the requested relation has no edges, the value carries `diagnostic: { code: "no_links", hint }` instead of a silently empty list. |
| `coordination_read` | The only tool that returns file content. Reads a byte range (end exclusive) or a line range (1-based inclusive), capped at 256 KiB / 2,000 lines / 16k tokens per call. Pass `path`, or a node `handle` from parse/outline: with a handle, `mode`/`start`/`end` default to that node's range, byte offsets go through AMP's `outlineAddress` (BOM-correct) and out-of-range spans fail with `INVALID_ARGUMENT`. |

P0 parsers are lexical and deterministic: JS/TS/JSX (imports, exports, `require`, dynamic import, symbols, comments), CSS/HTML/Markdown (`@import`/`url()`, script/link/img, links/images/headings/front matter/fenced divs/formulas), TeX (theorem-like environments, proofs, labels/refs, math, `\input`/`\include`), generic formulas (Markdown/TeX/spreadsheet/MathML/OMML/unknown; no evaluation), and a lexical dependency graph (external filtering, topological order, cycles, levels, isolated vertices). Malformed input produces diagnostics and `truncated`, not a crash.

**Handle contract.** A handle is deterministic (`sha256` over path + kind + locator) and stable across reparses, so `coordination_parse` and `coordination_outline` mint the same handle for the same node. `coordination_describe`, `coordination_chain` and `coordination_read` all accept it; `path` remains the universal fallback. Resolution does not depend on the bounded in-memory registry: describe re-reads the persisted row and re-registers it, and read derives its default range from that row. Handles never encode text and are never reseeded by an index rebuild.

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

`parser.enabled` is read when the file tools are registered; parser limits and `chain.depth`/`links`/`tokenBudget` are captured when the lazy tool runtime creates its `ParseService`/`ChainEngine`. A live change through `/config` therefore does not retune an already-created runtime; it takes effect on the next registration (today a locale change or restart). The workspace root resolves per request, best source first: tool option → service root → `host.workspaceRoot` → DSH's sandbox policy for the calling session → `process.cwd()` only when none of those yields a root.

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

Every model-facing tool result carries `tookMs` (integer milliseconds) in addition to its own fields; the field is optional in the declared output schemas, so older consumers are unaffected.

AMP `Goal`/`Plan`/`Duty` arguments are declared to the model as a one-line artifact schema, while `execute` validates the complete local schema — the rejection messages are unchanged, but the catalog no longer re-sends the nested JSON on every request. `GET /context/metrics` reports the resulting size and a deterministic catalog hash.

Declarations ship **lean by default**: per-property `description` text is omitted from the wire schema, while types, enums, `required`, bounds, patterns and defaults stay. Validation is unaffected because every tool validates against its own schema object; set `COORDINATION_SCHEMA_DETAIL=full` to restore the documented properties. Measured by `GET /context/metrics`, this took the catalog from 18,866 to 12,283 characters (≈4,717 → ≈3,071 tokens); per-property descriptions alone were 4,198 characters.

Two profiles choose the surface: `full` (default, 23 tools) and **`core`** (`COORDINATION_TOOL_PROFILE=core`), which registers the read/planning surface only and skips control, environment, knowledge, notification, approval and the two workspace mutation tools — 5,989 characters ≈ **1,497 tokens** from the same per-tool metrics. Notification and approval stay in the default surface because they are features, not administration.

| Tool | What it returns |
|---|---|
| `coordination_selection` | Read or patch the five selections for a session (including `command` and DSH `preset`). A read defaults to `view:"summary"` (six dimensions, lock, preset id/name — roughly a third of the old payload); `view:"full"` returns the complete `SelectionState` with the preset catalog and config projection. |
| `coordination_profession` | Read the current profession record; set a profession only before/without an active task. A locked task returns `PROFESSION_LOCKED` and leaves the selection unchanged. |
| `coordination_profession_lock` | Read the lock state/profession of the active turn, or of a given turn ordinal. |
| `coordination_mission` | List, create, activate, complete or abandon durable session missions using AMP priority/FIFO admission. |
| `coordination_goal` | Create goals with success criteria and transition their AMP lifecycle. |
| `coordination_plan` | Create and transition plans; update tasks with dependency and completion checks. |
| `coordination_collaboration` | List native descendants and duties, assign duties, submit evidence and record owner review. |
| `coordination_control` | AMP scoped control: registry metadata and interaction/scenario settings over `global → workspace → session`, with inheritance, tombstones, CAS `expectedVersion`, `dryRun` and `applyTo`. |
| `coordination_knowledge` | Mark a workspace file as knowledge, or retitle, retag and unmark it; the mark is mirrored into the `knowledge` registry. |
| `coordination_workspace` | One tool for the workspace itself: `structure` (the `coordination_file` projection), `build`/`test` (the `package.json` script of that name; the command cannot be overridden) and `run` (an explicit command through `ctx.shell`, so the operator's sandbox still applies). |
| `coordination_workspace_adjust` | Adjust this workspace's registries: `register`/`update`/`remove`/`enable`/`disable`/`link`, with the scope pinned to the workspace. |
| `coordination_environment` | Manage the environment registry (list/get/set/refresh/remove/enable/disable) with CAS and dryRun; values are name, description, variables and an enabled flag. A fresh database is seeded once with `env.local`: project root, resolved `git`/`node`/`npm`/`pnpm`/`python`/`java`/`pwsh` paths and curated host variables (never API keys or tokens). `refresh` re-discovers and merges without overwriting edited values. |
| `coordination_notification` | Pop one notification in the Web GUI for a session: `snackbar`, `alert`, `dialog` or `popover`, with severity, title, auto-close `duration`, anchor and up to four dismiss-only actions. One-way: it never returns an answer. |
| `coordination_approve` | Ask the human one explicit approve/reject question in a modal dialog and wait for the click. Returns `approved` / `rejected` / `cancelled` / `expired`; a timeout, an aborted turn or an unloaded plugin is never consent. |
| `coordination_search` | Query the operator-internal Elasticsearch (`simple_query_string` over all fields by default). Returns bounded hit ids, scores and truncated `_source`; the endpoint and default index come from `COORDINATION_ES_*` environment variables, never from the model. Registered only when `COORDINATION_ES_URL` is set (or `COORDINATION_ES_SEARCH=1` opts into the localhost default), so an absent backend costs neither catalog tokens nor failed calls. |
| `coordination_index` | Index changed workspace files or rebuild known paths within configured bounds. |
| `coordination_parse` | Body-free parse projection (references, diagnostics, charset, truncation, cards); compact cards by default, `verbosity:"full"` for complete cards. |
| `coordination_describe` | Body-free `NodeCard` and requested metadata fields; graph fallback for handles the registry dropped. |
| `coordination_chain` | Bounded `ChainProjection` plus a `diagnostic` when an indexed workspace has no edges for the requested relation. |
| `coordination_read` | The only content-returning tool; capped byte/line range; accepts `path` or a node `handle` (node range defaults, BOM-correct offsets). |
| `coordination_file` | Bounded workspace tree of indexed paths. `mode:"paths"` returns a flat path list (directories end with `/`) at roughly one line per entry; `mode:"tree"` (default) keeps the nested objects. |
| `coordination_outline` | Structure outline of one file or the workspace. A capped result carries `truncation: { returned, total, truncated, next }`, where `next` names the follow-up call (`limit=…` or `path=…). |
| `coordination_importation` | Import rows of one file or the workspace, with the same `truncation` envelope. |
| `coordination_exportation` | Export rows of one file or the workspace. |

Routes live under `/deepseek-coordination`; the following table summarizes the main surfaces. The HTTP `?session=` selector is local host UI observability, not authentication or authorization; it does not establish the actor for model-facing collaboration actions.

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | Liveness; returns plugin name, `pong`, current locale. |
| GET | `/proxy/status` | Cache-proxy status: counts, ids and hashes only (body-free). |
| GET | `/context/metrics` | Static context budget and cache telemetry: per-tool characters/tokens, catalog and skill **section hashes** (a changed hash predicts a prefix miss), the localized skill-catalog size, the AMP block cap, and the proxy's `cache_read_ratio` (`hitRate`, inputs, samples, window, prefix drift). DSH's own prompt is not counted. |
| POST | `/echo` | Echo a JSON body (diagnostic). |
| GET | `/notify/pending` | Drain the queued notifications for `?session=` (each item is delivered at most once). |
| POST | `/notify` | Queue one notification `{ session, surface, message, —}` with the same validation as the tool. |
| GET | `/approve/pending` | Waiting consent windows for `?session=`; never drains, the dialog keeps showing the same request. |
| POST | `/approve/answer` | Deliver one decision `{ session, id, approved }`; only `approved: true` approves. |
| POST | `/approve/cancel` | Withdraw one window `{ session, id }` (Esc, backdrop and 取消 use it). |
| GET, POST | `/selection` | Read `SelectionState`; patch the five choices. |
| GET | `/presets` | DSH permission-preset catalog. |
| POST | `/permission` | Apply one DSH preset immediately. |
| GET, POST | `/config` | Read `{ values, defaults }`; apply a flat config patch. |
| POST | `/config/compaction` | Compatibility patch for `auto`/`soft`/`hard`. |
| GET, POST | `/control/registry` | Read the effective scoped registry; run one `register` / `update` / `remove` / `default_*` / `link` / `unlink` action. |
| GET, POST | `/control/settings` | Read an effective interaction/scenario setting; `set` or `reset` it. |
| GET, POST | `/graph/knowledge` | List knowledge files with their indexed flag; mark, update or unmark one. |
| GET | `/takeover/pending` | Pending approval/question windows for a session. |
| POST | `/takeover/answer` | Deliver a validated human answer; invalid answers keep the window open. |
| POST | `/takeover/cancel` | Cancel a window and delegate to the host default. |
| POST | `/profession/rebuild` | End the active task and create a replacement with a new profession. |
| POST | `/profession/abandon` | End the active task without a replacement. |
| POST | `/locale` | Report the client language; re-registers localized tool descriptions. |
| GET | `/state` | Selection plus coordination metrics (`session`, `turn`, `plan`, `subtask`, `trace`, `takeover`, `schema`). |
| GET | `/amp/planning`, `/amp/missions`, `/amp/goals`, `/amp/plans` | Durable planning projections (`?session=<native-dsh-session-id>`). |
| GET | `/amp/collaboration` | Duties owned by or assigned to the selected native DSH session. |
| GET | `/amp/state-card` | The compact state card: `objective` (active goal statement), open `duties`, the executing `plan` with `done/total` and its next task, one imperative `next`, `constraints` and `durable: true`. Rebuilt from durable rows on every step, so chat compaction cannot drop it. `?compaction=1` returns `{ current, compaction }`, where `compaction` is the snapshot captured immediately before this session's last automatic compaction (or `null`). |
| GET | `/amp/identity` | Public Ed25519 identity `{ kid, alg, publicKey }`. |
| GET | `/amp/manifest` | Signed AMP manifest. |
| GET | `/amp/frame` | Latest AMP frame for `?session=`. |
| GET | `/amp/receipts` | Newest receipts (`?limit=`). |
| GET | `/amp/ledger` | Chain head plus entries (`?limit=`, `?full=1`). |
| GET | `/amp/verify` | Recomputed chain verdict, latest checkpoint. |
| POST | `/amp/checkpoint` | Seal a signed checkpoint over the current tip. |
| GET | `/amp/scope` | Bounded scope snapshot (`?scope=global\|default\|workspace`, `sessionLimit`, `entryLimit`, `receiptLimit`). |
| GET | `/amp/insights` | Session cognition log, manifest capabilities, skills and knowledge; every source reports available/unavailable. |
| GET | `/graph/tree` | Bounded workspace tree (`?root=` override). |
| GET | `/graph/outline` | File or workspace structure outline. |
| GET | `/graph/intra` | In-file symbols and edges. |
| GET | `/graph/dependencies` | File/workspace dependency links and cycles (`?level=file\|intra`). |
| GET | `/graph/imports` | File/workspace import rows. |
| GET | `/graph/search` | Search the persisted graph. |
| GET | `/graph/agents` | Read-only agent roster with estimated progress. |
| GET | `/graph/agents/messages` | Bounded, no-store agent transcript. |
| GET | `/graph/preview` | The only body-bearing file route; bounded, no-store. |
| GET | `/graph/preview/pdf` | Compiled PDF bytes for a TeX preview (`?path=&session=`), no-store; the source must still be readable. |
| GET | `/graph/revision` | No-store graph revision hash for the resolved workspace; the panel uses it to invalidate cached views. |
| POST | `/graph/index` | Index a fresh workspace (`409 BUSY` while running). |
| POST | `/graph/rebuild` | Re-parse the already-known paths (`409 BUSY` while running). |

There is no `coordination_write` or `coordination_refresh` tool. The file, graph, control, knowledge, notification, planning and collaboration tools carry inline EN/zh-CN copy because the shared `ToolName` table has no keys for them yet; the selection tools use the shared copy table.

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

The counts and timings below are the 2026-11-03 audit of this source on Node 24.21.0; re-run the commands before quoting them for another build.

| Check | Result |
|---|---|
| `npm test` | **1,159 tests, 1,158 pass, 1 skipped (GC-only), 0 fail**, ~9 s on Node 24.21.0 |
| `npm run typecheck` / `npm run test:tsc` | Clean |
| `npm run build` | Host + client bundles green; MUI `"use client"` directive warnings are non-fatal |
| `npm run pack:check` | OK: the tarball carries the three `lib/` artifacts, `cordis.patch.yml`, both locale files, `icon.svg` and the eight skill files |
| Release CI | `.github/workflows/release.yml` runs typecheck, test:tsc, tests, pack:check and attaches the tarball to a `v*` GitHub Release |

Parser and structure numbers are guards, not promises: a 100k-character parse test stays under 3 s; the data-structure report records B+ tree 10k inserts at 8.3/9.8 ms, skip-list 10k inserts at 6.4 ms, red-black 10k random set/delete at 13.5 ms, sparse grid 10k cells at 5.1 ms, and `hashString` 100k calls at 4.3 ms on the audit machine. The complexity audit records the ordinal `COUNT(*)` → `MAX(ordinal)` change (≈5–9 ms → ≈2–4 ms for 2,000 statements) and route ranking (2,400 → 200 posterior statements for 200 × 12 routes).

Known limitations, stated rather than hidden:

1. **Durable graph is bounded.** `node`/`edge`/`snapshot` are persisted in the current schema and survive a new runtime; rehydration is bounded to the newest 50k nodes / 50k edges, removed symbols are not pruned, and a handle older than the rehydration window is `NOT_FOUND`.
2. **Domain extraction is parser-level; some projections are still partial.** Book/Article/Part/Chapter/Section/Paragraph, Person/Venue, Condition, Sheet/Cell/Range and TeX proof status are emitted and projected onto node cards; docx/xlsx/pptx now parse through a bounded ZIP+OOXML reader, while Publisher/Access stay explicitly unsupported. `partOf`/`condition` edges are queryable through `coordination_chain`; cross-file Book composition and Sign promotion remain deferred.
3. **The core turn pipeline is wired, the wider engines are not.** Comprehension → Organization → Plan/score and required Predict rows now run for `command=none` turns, with the scene policy applied where ports exist. Standalone Emotion/Bayesian/Cognition/Orchestration/Learning/Resource/Score, plan rebuild loops and decompose/dispatch/verify/synthesize remain library-only. Reasoning is DSH-owned and no longer reported as a plugin gap; `allowBash`, `maxIteration` and non-writing score thresholds are still recorded as deferred diagnostics, not faked.
4. **Configured caps are live.** `parser.maxAstDepth`, both dependency-graph caps and `tools.maxResultBytes` are consumed; parser/chain limits retune an existing runtime, and a config change no longer leaves a stale tool runtime.
5. **Workspace root is resolved, not hard-coded.** Tool option → service root → host root → sandbox-policy root → `process.cwd()` only as the last fallback.
6. **`parser.enabled` still needs registration.** The other file-layer limits retune live; turning the parser off fails closed immediately, but adding/removing the four tools requires the next registration (restart).
7. **No browser E2E test.** The UI is covered by types, build, the settings-catalog and settings-render tests, the panel render tests and the takeover/bridge/notification/integration tests; visual verification remains manual/screenshot-based.
8. **Node engine is `>=24.0.0`.** The `attention-manifest-protocol` runtime dependency requires Node 24; CI and this verification use 24.21.0.
9. **A profile can still record an older package spec.** Verify the installed version (`dsh --profile <name> --dump-config` or the profile's `package.json`); install the 0.23.4 tarball or link the built checkout rather than assuming a previous install was upgraded.
10. **The cache proxy is experimental and off by default.** Its brand profiles are policy defaults, not measurements, and it only rewrites content for families with an automatic prefix cache; the observable gain on a stable session may be near zero, which is why it ships behind a flag and a status endpoint rather than enabled.
11. **AMP conformance is boundary-deep, not complete.** Manifests, frames, receipts, events, claims/unknowns, goal/plan pairs (gated on recorded acceptance), the ledger and checkpoints are wired and verified; the sealed envelope and the warrant's hypothesis/revision/authorization functions are implemented and tested but not driven by any path, and hypotheses, governance manifests, credentials, federation and interrupt budgets are not implemented. [`docs/ampConformance.md`](docs/ampConformance.md) §7 lists each gap with its reason, and the manifest's `self.limits` states the two unmeasured fields (calibration, token usage).

## Repository history and license

`0.1.x` is **dsh-os**, a different OS-interaction project, no longer on the branch tip; `0.2.0` became the DSH plugin bundle; `0.3`–`0.6` moved the UI from Angular to MDUI to plain React to Material UI; `0.7`–`0.9` added the five dropdowns, i18n, profession lock, takeover, compaction, the P0 parser, the domain model and the shared data structures; `0.10.0` added the settings catalog, the four file tools, the second data-structure pass and the verified tarball; `0.11.0` added durable settings, DSH-owned reasoning and the experimental cache proxy with brand profiles; `0.12.0` added the per-ecosystem domain layer, the chain `kind` filter, the directory layer and `NodeRecord`; `0.15.0` added AMP v0.1 conformance, now backed by the official npm runtime; `0.16`–`0.22` added warrant-validated claims, takeover windows as AMP attention requests, the plain-language panel and its story view, durable planning artifacts and the single-panel layout; `0.23.0` added the tool-layer and context-architecture program. Earlier states remain in git history and tags.

Apache-2.0 © 2026 Eloy Kim. See [LICENSE](LICENSE). Source: [github.com/eloyhere/deepseek-coordination](https://github.com/eloyhere/deepseek-coordination).
