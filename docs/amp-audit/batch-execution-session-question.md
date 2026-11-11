# AMP audit — execution / session / question (AMP 0.14.0)

Scope: `src/host/handlers/execution.ts`, `session.ts` (get/list/report_status), `question.ts`, one read each. Verb coverage already verified elsewhere; this pass is about semantics. No tests run, no source modified.

## execution

AMP API: `find_tools` ranks authorized tools for the binding; `inspect_tool` expands one pinned tool contract; `run` dispatches typed child calls **through policy, budget and journal** and returns handles for large output; `read_handle` pages a scoped result handle.

Plugin usage:
- `find_tools` — `execution.ts:32` reads `host.ctx.tools.definitions(agentOf(host))`, scores by local substring matcher `score()` (`:15-24`), sorts, slices to `limit`; `total` is `ranked.length` (`:43`).
- `inspect_tool` — `execution.ts:49` `host.ctx.tools.get(name, agent)`; returns name/description/parameters/timeoutMs only.
- `run` — `execution.ts:86` calls `host.ctx.tools.execute({calls, signal, agent})` directly. No AMP policy/authorization call, no budget charge, no journal or action receipt; the only guard rejects `AMP_PREFIX` names (`:71-73`). Oversize output (>16,000 chars) is stored in the in-memory `host.handles` map (`:105-106`).
- `read_handle` — `execution.ts:117-125` slices the stored string by character `offset`/`limit` with `total`; no re-render.

Gaps:
1. `run` bypasses AMP semantics: it is a direct call into the DSH tool batch executor. No policy decision, no authorization, no budget decrement, no journal entry, no action attempt/receipt — AMP `action` remains empty for runs performed this way. The header comment says "through the pipeline", but that is the DSH pipeline, not AMP's.
2. Validation throws escape the envelope: the `throw new Error(...)` at `:70` and `:72` runs outside the `try` that starts at `:84`, so an empty call name or an AMP-prefixed name surfaces as a handler exception instead of `failure('invalid_parameters')`.
3. `find_tools` is a host tool list with naive substring scoring, not AMP ranking/authorization; `total` reports the page size rather than the match count, and every visible tool is rankable. `inspect_tool` has no policy context either.
4. Lossy spill: per-result `text` is truncated to 4,000 chars (`:100`) before the size test, so even a handle-backed result omits text; the inline preview is only 500 chars.
5. Handles are unmanaged: in-memory only, no TTL/eviction, not persisted, not registered with AMP, and `read_handle` does not check the handle belongs to the calling binding (any valid id is readable). Paging exposes raw JSON characters with no `hasMore`/`nextOffset`.
6. Minor: `callId` collisions between supplied calls are not detected; only 8 calls per run.

Verdict: partial

## session

AMP API: `get` returns one session in scope; `list` returns sessions visible to the binding; `report_status` records a session-level status line.

Plugin usage:
- `get` — `session.ts:22-34`: id from params or the bound session; `live` from `host.ctx.agents.get(id)`; `amp` from `serviceOf(host,'session').get(id)` with a swallowed catch (`:26-28`); `statusLine` from `host.statusLines.get(id)`.
- `list` — `session.ts:39`: `host.ctx.sessions.list()` (DSH session registry), mapped and paged.
- `report_status` — `session.ts:52`: `host.statusLines.set(id, status.trim())`; returns `{sessionId, status}`.

Gaps:
1. `report_status` is persisted nowhere: it writes only the host in-memory `statusLines` map. No AMP session transition, no version, no store row; it is lost on restart, and `get` exposes it as a separate `statusLine` field rather than inside the session entity.
2. `get` has no not-found path — an unknown id returns `ok` with `amp: null` because the service error is swallowed, so "no such session" and "unreadable session" are indistinguishable.
3. No scoping on `get`: any id is accepted, including sessions outside the caller's binding; the AMP entity is returned raw (no `jsonSafe`).
4. `list` does not call AMP `session.list()` at all; it answers from the DSH registry with no tenant/binding filter and no AMP state joined.
5. `get` merges three sources (live agent status, AMP entity, side-channel status line) into one shape with no documented precedence.

Verdict: partial

## question

AMP API: `get` reads one question; `list` filters by session/intent/state; `open` creates and asks a question, with the host deciding when it is asked.

Plugin usage:
- `get` — `question.ts:62` `createStoreQuestionStore(host.kernel().store).get(id)`; `undefined` → `not_found`.
- `list` — `question.ts:74` store `.list({sessionId?, intentId?, state?})`, defaulting `sessionId` to the bound session, then paged.
- `open` — validates prompt/session (`:88-99`), builds with `createQuestion` (`:102`), transitions with `askQuestion` (`:117`), persists `store.put(asked)` (`:119`), returns the asked entity.

Gaps:
1. `open` never delivers the question: it transitions the entity to asked and stores it, but never calls the `userQuestions` provider (`host.ctx.get('userQuestions').ask`) that `turn.clarify` uses — nobody is actually asked and there is no answer/await path.
2. Silent coercion instead of failure: an invalid `kind` becomes `clarification` (`:91`), an unparsable `expiresAt` is dropped (`:98`), and malformed options are dropped inside `optionsOf` (`:35-46`). A caller cannot tell its payload was partly rejected.
3. No idempotency or dedupe: every call mints `dsh:question:<session>:<uuid>`, so duplicate or unlimited blocking questions can be opened for the same turn.
4. No referential integrity: `intentId`/`turnId` are stored without checking they exist, and `expiresAt` is not required to be in the future.
5. Write ordering: create → ask → put. A failure after `createQuestion` leaves an entity that was never persisted; `put` is not CAS-guarded against the transition version.
6. `get`/`list` accept arbitrary `sessionId`/`intentId` without a caller-binding check, and `list` silently ignores an invalid `state` (returns all states).

Verdict: partial
