# deepseek-coordination

**English** · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

An Attention Manifest Protocol (AMP) host for **DeepSeek Harness 0.2.2-rc.1** on the
Windows desktop build. The plugin upgrades `attention-manifest-protocol` from the
old 0.6-era coordination layer to **AMP 0.8.0**, removes the obsolete coordination
surface, keeps the notification components, and registers the AMP module surface
with the harness host.

```
AMP 0.8.0                              DeepSeek Harness 0.2.2-rc.1
┌───────────────────────────┐          ┌──────────────────────────────────┐
│ agent surface (27 modules)│          │ ctx.tools   ← 15 module tools    │
│ 15 agent / 8 host / 4 hid │  ──────► │ ctx.systemPrompt ← AMP contract  │
│ AgentGateway (49 verbs)   │          │ ctx.skills  ← 10 AMP skills      │
│ executable kernel         │          │ ctx.commands ← /amp, /amp-modules│
│ SQLite store + entities   │          │ ctx.webServer ← read-only routes │
└───────────────────────────┘          │ session/event ← turn positions   │
                                       └──────────────────────────────────┘
```

## What changed in 0.24.0

- **Dependency:** `attention-manifest-protocol@0.8.0` (was `0.6.0`), including its
  `semantic-typescript` runtime dependency.
- **Removed:** the old coordination database, graph/text/cognition engines, the
  composer dropdowns, takeover and approval dialogs, the 400 KB panel, the old
  `src/protocol` compatibility layer, and every tool that was not AMP or a
  notification. Git history keeps them; `src/` no longer does.
- **Kept unchanged:** the notification components — `snackbar`, `alert`, `dialog`
  and `popover` (`src/host/notify.ts`, `src/client/notification.ts`,
  `src/shared/notification.ts`) and the `coordination_notification` tool. Only the
  registration glue around them is new.
- **New host:** seventeen AMP module tools, `attention_manifest_protocol_discover`,
  an executable AMP kernel in SQLite, 10 skills, 2 commands, a system-prompt
  contract and read-only HTTP routes.
- **New client:** the notification seats plus a compact AMP status strip and a
  settings page; the old MUI-heavy panel is gone (client bundle ~424 KB).

## The AMP module surface

AMP 0.8.0 defines 29 modules. All of them are registered with the harness in one
of three ways:

| Tier | Count | Registered as |
|---|---:|---|
| `agent` | 17 | One `attention_manifest_protocol_<module>` DSH tool each, exposing its verbs through `{ verb, arguments }`; 60 verbs total. `elaboration` (build diagnostics, explain, propose) and `draft` (open, write, patch, diff, check) are new in 0.8.0. |
| `host` | 8 | Host services/routes: `capability`, `manifest`, `provenance`, `receipt`, `verification`, `retrieval`, `model`, `runtime`. The host publishes `ctx.amp` (`AmpHost`) so other plugins can inject the service and reach the kernel ports, gateway journal, receipts and evidence. |
| `hidden` | 4 | Internal only: `workflow`, `policy`, `profession`, `behaviour`. They are never offered to the model. |

The agent tools are:

| Tool | Verbs |
|---|---|
| `attention_manifest_protocol_session` | `get`, `list`, `report_status` |
| `attention_manifest_protocol_turn` | `current`, `respond`, `clarify`, `report` |
| `attention_manifest_protocol_intent` | `get`, `list`, `submit_clarification` |
| `attention_manifest_protocol_mission` | `get` |
| `attention_manifest_protocol_goal` | `get`, `list`, `submit_evidence` |
| `attention_manifest_protocol_plan` | `get`, `list`, `ready_tasks`, `propose_draft` |
| `attention_manifest_protocol_task` | `get`, `list_ready`, `report_progress` |
| `attention_manifest_protocol_action` | `get`, `list` |
| `attention_manifest_protocol_attention` | `context`, `get`, `request_focus` |
| `attention_manifest_protocol_project` | `rules`, `metadata`, `environment`, `describe_environment`, `configure_environment`, `put_rule` |
| `attention_manifest_protocol_workspace` | `list`, `read`, `outline`, `document_outline`, `diff`, `write` |
| `attention_manifest_protocol_cooperation` | `inbox`, `send`, `report_result` |
| `attention_manifest_protocol_evidence` | `get`, `list`, `cite` |
| `attention_manifest_protocol_execution` | `find_tools`, `inspect_tool`, `run`, `read_handle` |
| `attention_manifest_protocol_budget` | `remaining` |

`attention_manifest_protocol_discover` returns the whole catalog filtered by
`query`, `module` or `tier`, including mutating flags and authority strings.
`query` accepts a string or an array of strings; set `regex: true` to treat each
entry as a case-insensitive regular expression. The same tool accepts
`action: "search"` for project file discovery. When the **Take over search**
preference is enabled, `discover` uses AMP 0.8.0's
`createSessionFileDiscoveryProvider`, `collectDiscoveryCandidates` and
`discover` ranker; it does not implement a second ranking algorithm. Set
`scope` to `files`, `content` or `both`, and optionally pass a workspace-relative
`path`, `include`/`exclude` globs, `maxFiles`, `maxFileBytes`, `limit`,
`maxPerModule` or `minimumScore`. Search stays in the project, skips generated
and dependency directories, limits content snapshots and returns file paths and
line locations for follow-up reads through `attention_manifest_protocol_workspace.read`.

> AMP 0.8.0 ships tool **names and authority**, not argument schemas. This host
> therefore exposes one typed `verb` plus a lossless `arguments` object per module
> instead of 60 separate dotted tool names. The gateway still enforces host-bound
> identity, the mutating-idempotency rule, the authority hook and one journal
> record per call.

## Kernel and persistence

AMP data lives with the project. `src/host/amp.ts` opens one executable kernel
per workspace root (`session.header.cwd`) at:

```
<workspace>/.deepseek-coordination/
  amp.sqlite          kernel store: entities, workflow events, receipts, evidence
  host-state.json     status lines, notes, mailboxes, citations, execution handles
  preferences.json    takeover switches for this workspace
  project.json        project environment and rules (project verbs)
```

A mutating AMP call (and the host-side verbs that only update
`host-state.json`, such as `session.report_status`) is flushed before it
returns, so restarting DSH replays the same visible state instead of only the
kernel aggregates. `workspace.diff` snapshots stay in memory: they are
derivable from the workspace.

The directory is a cache, so the host also keeps it out of version control. When
the first workspace store is created it appends a `.deepseek-coordination/` rule
to the repository's own ignore file — `.gitignore` for Git and jj, `.hgignore`
for Mercurial (matching the file's regexp/glob syntax), `.fossil-settings/ignore-glob`
for Fossil, `.bzrignore` for Bazaar, and `.ignore` for Pijul. The repository root
is found by walking up from the workspace, so a nested workspace is ignored
relative to it. An existing rule is never duplicated, and a plain folder that is
not inside a repository is left untouched.

Two other layouts remain available: `storage: 'user'` keeps everything under
`$DSH_HOME/storages/deepseek-coordination/`, and an explicit `storePath` pins
one shared store for every workspace (the pre-0.24 behaviour). Existing
machine-wide stores are not moved automatically: keep `storage: 'user'` to
continue reading one, or run

```powershell
node scripts/migrateStore.mjs --to <workspace>
```

while DSH is stopped. The helper copies the legacy store with SQLite's
`VACUUM INTO`, so its WAL sidecars are never copied by hand. On first use a
workspace also inherits the machine-wide `preferences.json`, so the takeover
switches survive the layout change.

**Take over file reads** and **Take over file writes** share one outline-first
discipline, because a transcript should carry the relevant range rather than a
whole file:

1. **Outline first.** A file is outlined before any of it is read. The first
   `workspace.read` answers with `phase: "outline"`, and `workspace.outline`
   requests the outline directly.
2. **Read by outline node.** Once the outline is known, content is read with the
   node's `startLine`/`endLine` (or byte range) instead of the whole document.
   Short files with no outline nodes and binary documents are the documented
   exceptions.
3. **Write by outline node.** While the write switch is on, native
   `write`/`replace`/`edit` calls are denied and point to
   `attention_manifest_protocol_workspace.write`. `replace` accepts an outline
   node id (`mode: "outline"`) as well as a line or byte range inside one, and
   the revision returned by the preceding read guards the change with
   compare-and-swap; a full `content` write is reserved for new files and
   documents without an outline.
4. **Re-read after writing.** A write changes the revision, so the next edit
   starts from a fresh outline instead of a stale revision.

The kernel creates the AMP entity tables (32) and indexes, the workflow writer,
budget ledger, attention/context compiler, receipts, verification and evidence
chain. `session`, `turn`, `intent`, `mission`, `goal`, `plan`, `task` and `action`
rows are created lazily by the handlers, so an idle session writes nothing.

Tool calls resolve the store from the calling agent's workspace root; HTTP
routes accept `?root=` or `?session=` to address one store, and
`GET /deepseek-coordination/amp/status` reports the layout under `storage`
(planned path plus every open store and any fallback) next to the active kernel
snapshot.

The host object is published as the Cordis service `ctx.amp`:

```ts
export const inject = ['amp']
export function apply(ctx: Context) {
  const kernel = ctx.amp.kernel(root)        // per-workspace kernel
  const modules = ctx.amp.modules            // all 29 AMP modules
  const journal = ctx.amp.journalEntries()   // one record per gateway call
}
```

`src/host/handlers/` implements the verbs:

| File | Responsibility |
|---|---|
| `session.ts` | DSH session/turn projection, clarification through `ctx.userQuestions`, intent/mission reads. |
| `planning.ts` | Draft plans through `kernel.flow` (capture → confirm → mission → goal → plan), ready tasks, progress notes, action reads. |
| `attention.ts` | Turn context compilation, focus requests, budget snapshot, evidence reads and citations. |
| `workspace.ts` | Root-confined list/read/outline/diff/write with `sha256` revisions and compare-and-swap. |
| `project.ts` | `package.json` metadata, `.deepseek-coordination/project.json` rules and CAS environment. |
| `execution.ts` | DSH tool discovery/inspection and child execution through `ctx.tools.execute`; large results become paged handles. |
| `cooperation.ts` | Bounded per-session mailbox and delegated result submission. |

## Context optimization (attention)

AMP attention is wired into the actual model request, not only the panel:

1. `src/host/context.ts` collects per-turn attention items from the harness:
   the current user prompt, the DSH goal, the todo plan, recent tool outcomes,
   and the workspace root.
2. It calls `kernel.flow.compileTurnContext` with
   `contextBudgetTokens` (default 1200) and an explicit per-item budget.
3. The compiled items are injected as the `<amp_attention>` runtime context;
   items that do not fit are recorded as AMP `exclusions` and never presented as
   read.
4. `GET /deepseek-coordination/amp/context` reports compilations, item count,
   exclusions and the last package size.

> See [wire.md](wire.md) for the per-channel wiring contract, exclusion ledgers
> and status matrix.

Configuration:

```yaml
- id: deepseek-coordination
  name: 'deepseek-coordination'
  config:
    contextOptimization: true
    contextBudgetTokens: 1200
```

The overall flow is also projected continuously: session → turn → goal →
todo plan/tasks → tool action, with `plan.propose_draft` and the `/amp` bridge
writing back into the harness. DSH still owns the final context window and
compaction policy; AMP decides what deserves attention inside the configured
budget and records what it deliberately excluded.

## Harness ↔ AMP binding

The two directions are wired together:

| Direction | Path |
|---|---|
| DSH → AMP | `src/host/sync.ts` mirrors `agent/created`, `turn/start`, `turn/end`, `tool/call`, `tool/result`, `goal/changed` and `todo/write` into AMP sessions, turns, goals, plans/tasks and action attempts. |
| AMP → DSH | `attention_manifest_protocol_harness` plus `/amp goal|mission|plan|todos|feedback` write through the harness's own commands (`/goal`, `/plan`) and `todo_write`; `plan.propose_draft` mirrors the draft into the harness todo list and enters plan mode. |
| Feedback | AMP `turn.report` and `goal.submit_evidence` call `ctx.sessionFeedback.record` (category `task-result`); the bridge's `feedback` operation does the same explicitly. |

AMP refuses to settle a Goal/Task without independent verification and evidence. When DSH
reports a completed goal or todo, the projection records a **deferred settlement** in
`/deepseek-coordination/amp/sync` rather than fabricating that evidence; the state remains
visible and honest.

Inspect the live direction with `GET /deepseek-coordination/amp/sync`; the AMP status bar is
capped at `--dsh-composer-card-max-width`, so it aligns with the composer input card.

## Notifications (kept)

`coordination_notification` accepts `snackbar`, `alert`, `dialog` or `popover`,
one to four dismiss-only actions, a severity, an anchor and an auto-close delay.
The host keeps a bounded per-session queue, the client polls
`GET /deepseek-coordination/notify/pending?session=` once per 1.2 s and renders one
surface at a time. A dialog never auto-closes; a delivery is one-way and cannot
block the agent loop.

Enable **Take over host dialogs and notifications** to consume approval and question
waterfalls before Harness's native answerers. Shared host Modals are adapted through
their `role="dialog"` / `aria-modal` presentation contract: the original layer is
hidden while its action callbacks remain authoritative. Information, confirmation,
single choice, multiple choice and text input use MUI and native `<dialog>.showModal()`.
The background is blocked, and neither outside clicks nor Escape dismiss the dialog.
Explicit dialog actions settle requests. Disabling takeover restores new native requests.

## Client half

| Slot | Entry | Role |
|---|---|---|
| `conversation.input.dock` | `deepseek-coordination.notifications` | The unchanged notification surfaces. |
| `conversation.composer.dock` | `deepseek-coordination.amp` | Compact `AMP 17/60` status button and module dialog. |
| `settings.section` | `deepseek-coordination` | Full 29-module catalog with tiers, verbs, authority and withheld reasons. |

The client bundle is emitted in DSH's lazy-CJS envelope
(`window.__ModuleLoader__.load({ id, factory })`) and requires only `react` from
the page table; MUI and emotion are inlined.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/deepseek-coordination/ping` | Name, version and protocol. |
| GET | `/deepseek-coordination/amp/status?root=&session=` | Module counts, storage layout, kernel snapshot, recent journal. |
| GET | `/deepseek-coordination/amp/modules?q=&tier=` | Module catalog. |
| GET | `/deepseek-coordination/amp/kernel` | Kernel snapshot of the active workspace. |
| GET | `/deepseek-coordination/amp/journal?limit=&session=&root=` | Gateway call journal. |
| GET | `/deepseek-coordination/amp/preferences` | Takeover switches of the active workspace (PUT/POST to update). |
| GET | `/deepseek-coordination/amp/client` | Composed web-client entry for this plugin. |
| GET | `/deepseek-coordination/notify/pending?session=` | Drain one session's notifications. |
| GET | `/deepseek-coordination/dialogs/pending?session=` | Pending approvals and questions for a session. |
| POST | `/deepseek-coordination/dialogs/answer` | Submit `{session,id,outcome}` or `{session,id,answers}`. |
| POST | `/deepseek-coordination/dialogs/cancel` | Cancel `{session,id}` without native fall-through. |

## Install

```powershell
npm run build
dsh plugin --profile desktop add R:\project\deepseek-coordination
```

The bundle patch inserts one row:

```yaml
- insert:
    - id: deepseek-coordination
      name: 'deepseek-coordination'
```

Configuration (all optional):

```yaml
- id: deepseek-coordination
  name: 'deepseek-coordination'
  config:
    tenantId: dsh-desktop
    rootId: desktop
    storage: workspace
    storeDirectory: .deepseek-coordination
    storePath: C:\Users\you\.dsh\storages\deepseek-coordination\amp.sqlite
    modules: [session, turn, workspace, execution]
    notifications: true
    prompt: true
    skills: true
    commands: true
    routes: true
    maxJournal: 500
    maxReadChars: 200000
    maxWriteChars: 1000000
```

## Development

```powershell
npm install
npm run typecheck
npm test
npm run build
```

The host bundle externalises every `@deepseek-ai/*` package, Cordis and AMP; the
client bundle inlines MUI/emotion and externalises React. `tsdown.config.ts`
contains both presets.

Tests cover registration (21 tools), the 29/17/60 surface counts, kernel creation,
module dispatch, workspace CAS and root confinement, project environment CAS,
`plan.propose_draft` through the kernel, notifications, and the client bundle's
factory and three slot registrations. `test/persistence.test.mjs` additionally
restarts a host against a temporary workspace and asserts that the kernel store,
the draft plan, host-side status lines and the per-workspace isolation survive,
and that `storage: 'user'` and an explicit `storePath` keep their layouts.

### The `semantic-typescript` freeze guard

AMP 0.8.0 depends on `semantic-typescript@2`, whose `Optional` class executes
`Object.freeze(Object.getPrototypeOf(Optional))` — freezing `Function.prototype`.
That breaks schemastery, which DSH uses for every plugin config. `src/host/freezeGuard.ts`
runs before any AMP import, refuses to freeze `Function.prototype`/`Object.prototype`/
`Array.prototype`, and every AMP import is dynamic (`src/host/protocol.ts`). This is
why the host bundle can safely load alongside the rest of the harness.

## Known limits

- AMP 0.8.0 does not ship argument schemas; the module-tool `arguments` object is
  validated by each handler, not by the protocol.
- `workspace.document_outline` answers `supported: false` and points at DSH's
  Office tools; no binary outline parser is bundled.
- `execution.run` does not dispatch AMP protocol tools (it refuses names with the
  AMP prefix) to avoid recursion.
- `turn.respond` records the model's response intent in AMP; DSH remains the
  owner of the actual conversation transcript.
- The kernel executor port is not wired: `workflow` actions are host-only, and
  model effects run through `execution.run` or ordinary DSH tools.
- AMP 0.8.0 is not wire-compatible with 0.6.0 artifacts; an existing 0.6-era AMP
  database is not migrated.
