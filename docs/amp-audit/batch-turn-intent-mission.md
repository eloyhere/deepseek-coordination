# AMP module audit: turn, intent, mission (AMP 0.14.0)

## turn

AMP API: `TurnService` extends `WorkflowEntityService<"turn">` and exposes `get`/`find`/`list`, `transition`, `interpret`, `clarify`, `resumeClarification`, `act`, `respond`, `complete`, `interrupt`/`resume`, `abandon`/`supersede`, `interruption` and `compactHistory`, with `Turn`, `TurnState`, `TurnInterruptOptions`, `TurnResumeOptions`, `TurnInterruptionSnapshot`, `TurnCompactionPolicy` and `TurnCompactionResult` types.

Plugin usage: `turn.current` (src/host/handlers/session.ts:56-62) reads the live harness agent plus `turnBoundaryOf`, not a kernel port; `turn.respond` (session.ts:64-75) and `turn.report` (session.ts:110-120) append to the in-memory `host.notes` map; `turn.clarify` (session.ts:77-108) calls the `ctx.get('userQuestions')` host service.

Gaps: `respond`/`report` never invoke `TurnService.respond`/`complete`/`transition`, so AMP turn state and version never advance and the payload survives only in the 100-entry `host.notes` buffer; `clarify` never records the question on the Turn either, so the harness boundary read by `turn.current` can diverge from the stored AMP turn.

Verdict: partial

## intent

AMP API: `IntentService` extends `WorkflowEntityService<"intent">` and exposes `interpret`, `clarify`, `resolveClarification`, `delegate`, `fulfill`, `defer`, `resume`, `abandon`, `supersede`, `confirm`, `accept`, `reject`, `withdraw`, `beginElaboration`, `completeElaboration`, `sealElaboration` and `failElaboration`, with `Intent` and `ElaborationSummary` types.

Plugin usage: `intent.get` (src/host/handlers/session.ts:122-130) and `intent.list` (session.ts:132-135) read the kernel port `services.intent` (`get`, session-scoped `list`); `intent.submit_clarification` (session.ts:137-156) records text in `host.notes` and then calls the kernel port's `clarify`.

Gaps: the clarification text never reaches `IntentService.clarify` (only echoed back as `proposal`), so the AMP event carries no proposal content; all kernel errors are caught and returned as `ok` with `intent: null`, hiding illegal transitions.

Verdict: partial

## mission

AMP API: `MissionService` extends `CancellableWorkflowService<"mission">`, inheriting `get`/`find`/`list` and adding `propose`, `activate`, `achieve`, `partiallyAchieve`, `pause`, `resume`, `archive`, `abandon` and `fail`, typed by `Mission`.

Plugin usage: `mission.get` (src/host/handlers/session.ts:158-166) requires an id and reads the kernel port `services.mission.get(id)`, mapping failures to `not_found`.

Gaps: none; the model-facing `get` is kernel-backed and lifecycle mutations are correctly not exposed.

Verdict: wired
