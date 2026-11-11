# session (agent, 3 verbs)

`attention-manifest-protocol@0.14.0` (`package.json:128`). Agent surface: `get`, `list`, `report_status`; the module also ships a host-only lifecycle/recovery API that no agent verb reaches.

## AMP API

- Entry points are pure re-exports: `session/index.d.ts:1-2` and `session/index.js:1-2` re-export `./types.js` + `./service.js`. Surface symbols: `SessionService`, `SessionError`, `SESSION_STATES`, `SESSION_TYPES`, `SESSION_PERSIST_KINDS`, `sessionTypeOf`, `SESSION_SNAPSHOT_SCHEMA_VERSION`.
- `SessionService extends WorkflowEntityService<"session">` (`session/service.d.ts:55`), constructed with a `WorkflowStore`, and it builds `TurnService`/`IntentService` itself (`session/service.js:140-145`). Storage is the shared single-writer workflow store; restored metadata has no mutable workflow slot and lives in a store-keyed `WeakMap` (`session/service.js:13-23`), so every service bound to one writer sees one restored view.
- Reads: `get(id)` (`session/service.d.ts:60`, `service.js:146-149`), `find(id)` (`service.d.ts:61`, `service.js:149-153`), `list(sessionId?)` (`service.d.ts:62`, `service.js:153-156`). All apply the overlay (sessionType, participants, expiresAt, persist, budgetBalance) first (`service.js:268-282`).
- Lifecycle: `transition`, `activate`, `idle`, `suspend`, `resume(id)`, `beginClose`, `close`, `archive` (`service.d.ts:63-71`; `service.js:156-173`); `resume` also accepts a snapshot (`service.d.ts:67-68`, `service.js:162-170`).
- Recovery: `snapshot(id, now?)`/`capture` (`service.d.ts:78-80`, `service.js:179-199`), `closeWithTurns` (`service.d.ts:87`, `service.js:205-247`), `expireIfDue(now, actor?)` (`service.d.ts:93`, `service.js:252-268`).
- Snapshot invariants: schema version `1` (`types.d.ts:42`); fields sessionId/version/state/sessionType/participants/expiresAt/persist/budget/budgetBalance/capturedAt (`types.d.ts:51-71`); `validateSnapshot` rejects wrong schema, empty ids, invalid state/type/budget, duplicate persist keys (`service.js:62-136`). Restore enforces `expectedSessionId`, `expectedVersion`, legal state overlays and canonical fresh-store replay paths (`service.js:55-62`, `282-382`). Expired persist references are skipped; unresolved workflow references are skipped only when the store is empty (`service.js:420-448`).
- Persist kinds: only `intent/mission/goal/plan/task/action` are scope-checked workflow entities; `attention/cooperation/file` are host-owned and kept by pointer (`types.d.ts:16-20`; `service.js:425-432`).
- Vocabulary: ten states (`types.d.ts:4`), four types with `user_interactive` default (`types.d.ts:7-9`), absolute `expiresAt` (`types.d.ts:35`), optional `persist`/`budgetBalance` (`types.d.ts:37-39`). Versioned/CAS semantics come from the workflow entity (`WorkflowEntityService`); all transitions take `TransitionOptions` with `expectedVersion`.
- Absent: any `report_status`/status-line field or method in types or service. The verb exists only in the surface table (`agent/surface.js:102-112`), declared non-mutating with `session:report` authority (`surface.js:107`), and is expected to be answered by the host.
- Tool naming: `SURFACE_PREFIX = "attention_manifest_protocol"` (`agent/surface.js:2`), per-verb name `${prefix}_${module}.${verb}` (`surface.js:413`); a missing handler raises `handler_missing` in the gateway (`agent/gateway.js:130-134`).

## Plugin usage today

Composition:
- `AmpHost` builds the agent surface, takes `surface.tools` as the catalog, and hands `createHandlers(this)` to `AgentGateway` (`src/host/amp.ts:231-236`).
- `createHandlers` spreads `sessionHandlers(host)` first (`src/host/handlers/index.ts:17`) and fills every remaining catalog tool with a `not_implemented` stub (`index.ts:31-40`).
- DSH registers one tool per module, not per verb: `attention_manifest_protocol_<module>` with a `verb` enum and `arguments` object (`src/host/tools.ts:24-43`), dispatched as `host.call(module, args.verb, ...)` (`tools.ts:43`).

Session-specific:
- `session.get`: `src/host/handlers/session.ts:21-35` — id from `id` or the bound session (`:22`), live status from `ctx.agents.get(id)` (`:23`), then AMP `SessionService.get(id)` (`:26`) inside a swallow-all `try/catch` (`:25-29`); returns `{ id, live, amp, statusLine }`.
- `session.list`: `session.ts:38-46` — reads only `ctx.sessions.list()` (`:39`) and emits id/cwd/events/live; no AMP call.
- `session.report_status`: `session.ts:48-55` — validates a non-empty string, writes `host.statusLines.set(id, ...)` (`:52`), returns `{ sessionId, status }`; no AMP call and no AMP session existence check. `statusLines` is per-workspace-root slot state (`src/host/amp.ts:511-512`).
- Core API independent of verbs: `AmpHost.ensureSession` takes `kernel.ports.services.session` (`src/host/amp.ts:382-384`), probes `session.find(sessionId).get()` (`:386`), and creates through `kernel.flow.startSession({ sessionId, actor: 'dsh-host' })` (`:391`). Callers: `src/host/sync.ts:144`, `:160`, `:480`; `src/host/planning.ts:97`; `ensureTurn` calls it at `amp.ts:397`.
- The kernel constructs the service: `lib/kernel/kernel.js:16` (import), `:223` and `:525` (`session: new SessionService(workflow)`), `startSession` at `:1120-1139` (create + activate).
- `host.call` flushes host state after every AMP call and explicitly names `session.report_status` as an AMP read-only verb answered by host mutation (`amp.ts:300-308`).
- `src/host/catalog.ts` is the localized skill/command catalog (`:2`, `:34-42`) fed from `host.modules`; it contains no session logic.
- `src/index.ts` composes `new AmpHost(...)` (`:65`), provides the service (`:73`) and registers module tools (`:138`); no session-specific wiring.

## Verb-by-verb status

| Verb | AMP declaration | Host handler | Calls AMP? | Status |
|---|---|---|---|---|
| get | `surface.js:105`, read-only, `session:read` | `handlers/session.ts:21-35` | yes — `services.session.get(id)` (`session.ts:26`) | handled |
| list | `surface.js:106`, read-only, `session:read` | `handlers/session.ts:38-46` | no — `ctx.sessions.list()` (`session.ts:39`) | handled, host-backed |
| report_status | `surface.js:107`, non-mutating, `session:report` | `handlers/session.ts:48-55` | no — `host.statusLines` (`session.ts:52`) | handled, host-backed |

None of the three reaches the `not_implemented` stub (`index.ts:33-39`): all three keys are registered by the first spread and no other handler file redeclares them.

## Minimal wiring proposal

1. `src/host/handlers/session.ts:38` (`session.list`) — add `host.kernel().ports.services.session.list(sessionId)` and map rows to `{ id, state, sessionType, participants, budgetBalance }`, merging DSH `cwd/events/live` from `ctx.sessions.list()` (`session.ts:39`). Failure mode: `kernel()` can fall back to the machine-wide store when the workspace store cannot open (`amp.ts:412-427`), producing empty/foreign rows; on that path return DSH rows with `amp: null` instead of failing the list.
2. `src/host/handlers/session.ts:48` (`report_status`) — call `host.kernel().ports.services.session.get(id)` (or `find(id)`) before `statusLines.set` to assert the session exists and is in scope; map `SessionError` `not_found` to `failure('not_found', ...)`. AMP has no status field (absent), so persistence stays in the host slot; DSH service is the existing `host.statusLines`. Failure mode: a session not yet created by `ensureSession` returns `not_found` rather than recording an orphan status; store failure surfaces as `handler_failed`.
3. `src/host/handlers/session.ts:25-29` (`get`) — replace the blanket catch with `find()` Optional handling plus `SessionError.code` mapping, so a read-only/corrupt store is distinguishable from a missing session. No new DSH service; live status still comes from `ctx.agents.get(id)`.

Not proposed: `snapshot`/`resume`/`closeWithTurns`/`expireIfDue` are host lifecycle powers withheld from the agent surface; if added, the natural home is `src/index.ts` `session/event` handling (`:221-224`) or a maintenance route, with `active_turns`/`version_conflict` as failure modes.

## Risks

- Name coupling: handler keys are built from a literal prefix and verb (`handlers/session.ts:7-9`) while authoritative names come from AMP (`surface.js:2,413`); a renamed verb/prefix silently degrades to the `not_implemented` stub (`index.ts:31-40`).
- Mutation semantics: `report_status` is declared non-mutating (`surface.js:107`), so the gateway neither requires an idempotency key nor journals it as mutation (`gateway.js:123-125`), yet the handler durably changes state; retries are last-write-wins.
- Scope/authority: `session.list` returns DSH sessions rather than AMP's binding-scoped `list`; the handler enforces no `session:read` check and `authorize` is `() => true` (`amp.ts:236`), so scope is implicit.
- Status locality: `statusLines` is keyed by workspace-root slot (`amp.ts:511-512`), so a status reported under one root is invisible under another root or after a fallback-store switch.
- Error opacity: `session.get` catches every error (`session.ts:25-29`), collapsing store failure into `amp: null`; corruption and absence look identical.
- Unused recovery surface: `snapshot`/`resume`/`closeWithTurns`/`expireIfDue` have no call sites under `src/`; `expiresAt` is never enforced, and restored `persist`/`budgetBalance` state is never captured, leaving `service.js:282-382` unreachable for this host.
- Type drift: `serviceOf` casts to `as never` (`session.ts:16`), so AMP API changes are not type-checked at the plugin boundary.
