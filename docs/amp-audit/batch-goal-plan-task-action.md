# AMP audit — goal / plan / task / action (AMP 0.14.0)

Scope: `src/host/handlers/planning.ts` against `node_modules/attention-manifest-protocol/lib/*/service.d.ts`.

## goal

**AMP API:** `get`, `list`, `submit_evidence`. Kernel `GoalService` (`lib/goal/service.d.ts:6`) adds lifecycle transitions (`propose`, `activate`, `achieve`, `block`, `unblock`, `abandon`, `invalidate`, `attachCorrectivePlan`, `revalidate`) on top of inherited `get`/`list`; its declared class body contains no evidence/verify member.

**Plugin usage:** `goal.get` `planning.ts:29` → `ports.services.goal.get()` `:33`; `goal.list` `:39` → `ports.services.goal.list(sessionId)` `:41`; `goal.submit_evidence` `:44` → no kernel call: host note `:50`, optional `bridge.feedback` `:54`, returns `verified:false` `:62`.

**Gaps:** `submit_evidence` records nothing in AMP — no goal-service call, no `recordEvidence`/`verifyBusiness`, no acceptance update or verification; it returns `submitted:true` for any `goalId`. The shared `serviceOf` helper (`:11-16`) narrows every kernel service to `get`/`list`, so the transition methods above are unreachable from this handler set without new plumbing. `get` maps every throw to `not_found`.

**Verdict:** partial

## plan

**AMP API:** `get`, `list`, `ready_tasks`, `propose_draft`. Kernel `ports.services.plan` (`get`/`list`), `kernel.flow.readyTasks`, `kernel.flow.createPlan`, plus intent/mission/goal flows.

**Plugin usage:** `plan.get` `:65` → `ports.services.plan.get()` `:69`; `plan.list` `:75` → `.list(sessionId)` `:77`; `plan.ready_tasks` `:80` → `flow.readyTasks({planId, actor:'dsh-model'})` `:84`; `plan.propose_draft` `:90` → `flow.captureIntent`/`confirmIntent` `:106-107`, `flow.createMission` `:109`, `flow.createGoal` `:114`, `flow.createPlan` `:135`, then best-effort `bridge.planFromDraft` `:151`.

**Gaps:** state is genuinely created, but not through the plan service or a draft/approval lifecycle: a full plan — and, when `goalId` is absent, an intent, mission and goal — is created immediately with `actor:'dsh-model'`; `draft:true` is response-only metadata. Bounds are fabricated host-side (`defaultsBounds`, `:18-26`); bridge mirroring is optional and its errors are swallowed.

**Verdict:** wired

## task

**AMP API:** `get`, `list_ready`, `report_progress`. Kernel `ports.services.task` (`get`/`list`) and `flow.readyTasks`.

**Plugin usage:** `task.get` `:161` → `ports.services.task.get()` `:165`; `task.list_ready` `:171` → `flow.readyTasks` when `planId` is supplied `:175`, otherwise `ports.services.task.list(sessionId)` `:181`; `task.report_progress` `:184` → host note only `:188`, with no task-service or flow call.

**Gaps:** `report_progress` never reports to the task service and performs no task transition or progress-metric update; it accepts any `taskId` and always returns `reported:true`. `list_ready` without `planId` returns the unfiltered session task list rather than ready tasks. The `serviceOf` narrowing (`:11-16`) applies here too, so task transitions cannot be called without new plumbing.

**Verdict:** partial

## action

**AMP API:** `get`, `list` (action attempts are read-only for the model). Kernel `ports.services.action`.

**Plugin usage:** `action.get` `:194` → `ports.services.action.get()` `:198`; `action.list` `:204` → `.list(sessionId)` `:206`.

**Gaps:** both verbs are thin pass-throughs backed by the action service; no write path exists by design. `get` masks every throw (including a missing service or transport error) as `not_found`; `list` has no error handling. Same `serviceOf` narrowing.

**Verdict:** wired
