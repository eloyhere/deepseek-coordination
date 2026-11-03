# AMP v0.1 conformance

This plugin emits and verifies **AMP v0.1** artifacts — the Attention Manifest
Protocol implemented by
[`attention-manifest-protocol`](https://github.com/eloyhere/attention-manifest-protocol)
(v0.5.0, Apache-2.0), installed as the runtime dependency
`attention-manifest-protocol`. This document is the binding map between that
protocol and this repository: which artifacts exist here, which invariants are
enforced, where they are enforced, and what is deliberately *not* implemented.

> **Release note (0.5.0).** The wire tag stays `amp: "0.1"`; `0.5.0` is the
> reference implementation's release. This plugin adopts the 0.5.0
> **scoped-control** surface natively (`global → workspace → session` registry
> metadata, defaults and interaction/scenario settings, with CAS versions,
> `dryRun` and atomic batches — see §9) instead of importing AMP's own SQLite
> and Elasticsearch stack. The 0.5.0 *discover* change (asynchronous
> Elasticsearch-backed catalog search) is **not** adopted: this host has no
> Elasticsearch dependency, so it is listed as not implemented in §7.

It is written to be checkable. Every row names a file and a test; a claim that
cannot be traced to one is a bug in this document, not a feature.

> **Scope.** Normative runtime operations are delegated to the published
> `attention-manifest-protocol` package: canonical JSON, digest generation,
> `RefTable`/frame construction, warrant validation, manifest signing and
> verification, and checkpoint signing and verification. The plugin retains
> host-specific SQLite persistence, Ed25519 key storage adapters, and takeover
> projections. `src/protocol/` remains as a compatibility layer for host-specific
> artifact builders and test fixtures; protocol-owned runtime operations must use
> the npm package. See [`NOTICE`](../NOTICE) for attribution.

## 1. What "conformant" means here

Conformance is claimed at the **boundary**, in four levels. Every artifact is in
exactly one level, and the level is part of the contract.

| Level | Meaning |
|---|---|
| **Wired** | Produced or accepted on a real path (turn lifecycle, tool call, HTTP route) and verified by the plugin. |
| **Kernel only** | Implemented and tested in `src/protocol/`, but no runtime path calls it yet. |
| **Projected** | Derived from existing plugin state, with a stated rule for the derivation. |
| **Not implemented** | The protocol defines it; this plugin does not claim it. |

The plugin does **not** claim to be a complete AMP implementation. It claims that
every AMP object it *does* emit is byte-compatible with the reference and passes
the same checks, and that everything it does not emit is listed in §7.

## 2. The layer

| Path | Role |
|---|---|
| `attention-manifest-protocol` npm package | Normative runtime for canonical JSON, digests, frame boundary, warrant validation, manifest signatures and checkpoint verification; package subpaths are imported directly by host modules. |
| `src/protocol/types.ts` | Host compatibility types for artifact fields still owned by the DSH adapter. |
| `src/protocol/canonical.ts` | Legacy/test canonical JSON implementation; production host paths use the npm package. |
| `src/protocol/sha256.ts` | Legacy/test SHA-256 helper through `node:crypto`. |
| `src/protocol/ids.ts` | Host-specific `idFrom` mapping; production frame boundary ID validation is delegated to AMP. |
| `src/protocol/errors.ts` | Compatibility errors used by host-specific adapters. |
| `src/protocol/envelope.ts` | Sealed A-surface envelope: `sealEnvelope`, `verifyEnvelope`, `EnvelopeRuntime` (FIFO, dedupe, cancel tombstones); kernel-only. |
| `src/protocol/manifest.ts` | Host Node key serialization and compatibility types; production signing/verification uses the npm package. |
| `src/protocol/frame.ts` | Compatibility frame types and digest verifier; production frame construction uses the npm package. |
| `src/protocol/receipt.ts` | Host-specific `Receipt`/`AmpEvent` builders and validation. |
| `src/protocol/warrant.ts` | Compatibility claim types; production claim confidence and validation use the npm package. |
| `src/protocol/ledger.ts` | Compatibility append-only log and types; persistent ledger snapshot verification uses the npm package. |
| `src/host/ampStore.ts` | SQLite persistence: `amp_object` (chain), `amp_key`, `amp_manifest`, `amp_checkpoint`. |
| `src/host/amp.ts` | `AmpService`: manifest/frame/receipt/event production, verification, checkpoints, ledger projection of bus events, tool receipts. |
| `src/host/ampRoutes.ts` | The `/amp/*` route table as a pure function, so it is testable without a webserver or Cordis context. |

The current schema is **28** (`src/host/database.ts`). Additive planning projections (`amp_planning_goal`, `amp_planning_plan`, `amp_mission`) and the duty projection (`amp_duty`) join the append-only AMP ledger. Projection mutations and their artifacts or lifecycle events commit together.

## 3. Artifacts

### 3.1 Manifest — **wired** (`GET /amp/manifest`)

| Aspect | Implementation |
|---|---|
| Type | `src/protocol/manifest.ts` `Manifest` |
| Producer | `AmpService.manifest()` (`src/host/amp.ts`) |
| Persistence | `amp_manifest` (append-only), plus a 12 h in-memory cache keyed by the policy digest |
| Signature | Ed25519, `role: "self"`, over canonical JSON of **everything except `signatures`, `digest` included** |
| Verification | `AmpService.verifyManifestSignature()`, `verifyManifest()`; identity exposed by `GET /amp/identity` (public key only) |

Derivation rules, chosen so no field is self-reported:

- **Capabilities** come from the model-facing coordination tools and the native subagent roster action
  (`COORDINATION_CAPABILITIES`). `tier` is `T2` once a successful tool receipt
  exists, `T0` otherwise; `confidence` is the Laplace-smoothed success rate
  `(successes + 1) / (calls + 2)` over recorded receipts; `evidence` cites up to
  three receipt ids. M-1 is therefore satisfied by construction: delete the
  receipts and the capability falls back to `T0` / `0.5`.
- **Calibration** is computed from receipts that carry *both* `predicted_voi` and
  `realized_voi`. While there are none, `ece` is `1` — the honest upper bound
  (maximal error) — and `self.limits` says why. A `0` would claim perfect
  calibration from zero evidence.
- **`attention.policy_digest`** covers the effective policy projection
  (`profession`, `plan`, `compaction`, `scenes`, `tools`, `chain`), so a settings
  change reissues the manifest instead of leaving a stale declaration.
- **`attention.budget`** is `{ ms: defaultLease }`. The task lease is the only
  attention budget this host actually enforces; token, call, interrupt and money
  budgets would be inventions.
- **`identity.constraints`** are the three hard constraints the rest of the code
  already enforces: no persisted permission preset, read-only graph routes, no
  private key on the wire.

Not carried: `commitments` (no due dates exist), `unknowns` (the plugin's own
open questions are design notes, not agent unknowns), and non-self signatures
(no host/org countersigner exists).

### 3.2 Frame — **wired** (per turn, `GET /amp/frame?session=`)

| Aspect | Implementation |
|---|---|
| Type | `src/protocol/frame.ts` `Frame` |
| Producer | `AmpService.openTurn()` from `CoordinationService.beginTurn()` |
| Constructor | `frameFrom(draft, RefTable, { maxSlots, maxIgnored })` — accumulates every problem into one `BoundaryRejection("invalid_frame", problems)` |
| Digest | `digestOf(body)` computed in `frameFrom`; `verifyFrameDigest` recomputes |
| Persistence | `amp_object` kind `frame`, plus a `turn.opened` event carrying `{session, turn, frame}` |

Slot policy (deterministic, ≤ 9):

| Slot | Role | Present when | `why` |
|---|---|---|---|
| goal | `goal` | the turn has a current goal row | "the goal row attached to this turn is the operative objective" |
| prompt | `question` | always | "the user prompt for this turn is the request being served" |
| turn | `process` | always | "turn *n* is the task this frame allocates attention to" |
| profession | `concept` | always | "the locked profession … decides which checks this task must pass" |
| interaction | `concept` | always | "interaction … shapes how the response is delivered" |
| plan | `artifact` | a plan row exists when the frame opens | "the plan row carries the steps this turn intends to execute" |

`salience` is authored policy (1.0 / 0.95 / 0.9 / 0.8 / 0.6 / 0.7), not a
measurement, and `voi` is omitted rather than invented. `cost` is `{ tokens: 0 }`:
attending to a row already in the local database spends no model tokens.

**`ignored` is the point of the frame.** The list is derived from the resolved
scene policy and names what this host deliberately does not enforce:

| Target | Reason | `revisit_if` |
|---|---|---|
| `policy-max-iteration` | `blocked` | a loop driver consumes `scene.maxIteration` |
| `policy-allow-bash` | `out_of_scope` | the host exposes a per-turn bash permission port |
| `policy-allow-web` | `out_of_scope` | the scene or config allows web search again (only when `profile.allowWeb === false`) |

These are the same knobs `TurnPipeline` reports as deferred diagnostics. Moving
them onto the frame means a reader of the ledger sees the exclusion *before* the
turn, with the condition that would bring it back — not only inside an in-memory
report.

`mode` maps the interaction to an attention posture: `emotion → reflect`,
`think → explore`, `heuristic → explore`, `converge → exploit`,
`orchestrate → triage`.

Not carried: `parent` (turns have no explicit parent frame), `open_questions`
(no question refs exist at frame time), `impasse` (a turn that opens normally is
not stuck), `budget.spent` (starts empty; the receipt carries the realized ms).

### 3.3 Receipt — **wired** (per turn and per tool call)

| Aspect | Implementation |
|---|---|
| Type | `src/protocol/receipt.ts` `Receipt` |
| Producer | `AmpService.closeTurn()` from `finishQuietly()` / `endTurn()` / `failTurn()`; `AmpService.recordTool()` through `withAmpReceipts()` |
| Validation | `makeReceipt` throws `BoundaryRejection("invalid_tool_args", problems)` |
| Persistence | `amp_object` kind `receipt` |

Turn settlement uses `op: "reflect"` scoped to the frame
(`target: { kind: "frame", id }`), because a whole turn is not one of the seven
verbs; the verbs settle the tool calls inside it.

| Turn status | Receipt outcome |
|---|---|
| `done` | `success` |
| `failed` | `failure` |
| `cancelled` | `blocked` |
| `abandoned` | `partial` |

Measured fields: `ms` and `usage.ms` from the turn row's `created`/`finished`
timestamps. `usage.tokens` is absent because the host owns token accounting and
does not report it per turn; the manifest's `self.limits` states this. No
`predicted_voi`/`realized_voi` is written, so calibration stays unmeasured rather
than fabricated.

Tool receipts: `op` is `read` for the file and graph read tools, `attend` for the three
composer tools, `act` otherwise; `usage` is `{ calls: 1, ms }`; `target` is
`{ kind: "tool", id }`, where the id is the tool name itself (underscores are
legal AMP id characters).

### 3.4 Event — **wired**

`AmpEvent` (`kind: "event"`) is appended for `turn.opened`, `turn.closed`,
`tool.invoked`, and for a whitelist of module-bus events mirrored by
`AmpService.observe()`: `selection.changed`, `selection.permission`,
`takeover.requested`, `takeover.resolved`, `takeover.pending`,
`compaction.auto`, `pipeline.report`.

Mirrored payloads pass through `ledgerProjection`, which keeps id-shaped strings
and numbers and replaces any other string with `[text omitted]`. The ledger is a
store of pointers: prompt text, question text and tool output never enter it,
even if a future bus payload happens to carry them.

`digest` covers the event body (everything except `digest`) and is recomputed by
`verifyEventDigest`.

### 3.5 Ledger — **wired** (`GET /amp/ledger`, `GET /amp/verify`)

| Aspect | Implementation |
|---|---|
| Chain | `hash = digestOf({ seq, kind, payload, prev })`, genesis `sha256:` + 64 zeros |
| Storage | `amp_object(seq, kind, digest, prev, body, at)`; `seq` contiguous from 0; `body` is canonical JSON |
| Immutability | Triggers `trg_amp_object_immutable_update/delete` reject UPDATE and DELETE |
| Verification | `AppendLog`/`verifySnapshot` semantics; `/amp/verify` recomputes every hash from the stored body |
| Entry kinds | `event`, `frame`, `receipt`, `claim`, `unknown`, `goal`, `plan` are produced; `hypothesis` remains unproduced. Mission and duty are host projections, not new AMP entry kinds |

Verification failures that are covered by tests: a rewritten `body`, a deleted
witnessed entry, a stale `prev` link, an out-of-order `seq`, a wrong `count` or
`tip`. Deleting only the *unwitnessed* tail stays undetectable until the next
checkpoint — the same limit the reference documents ("a clean deletion of the
tail produces a shorter, internally valid prefix").

### 3.6 Checkpoint — **wired** (`POST /amp/checkpoint`)

`LedgerCheckpoint` is signed with the installation key over
`"amp:ledger-checkpoint:0.1\n" + canonical(body)`, with `prev` **absent** (not
`null`) on the first checkpoint. `AmpService.verify()` verifies the latest
checkpoint's signature and compares it against the **prefix** it witnessed, so
entries appended after sealing are legal while a chain shorter than the
declared `count` fails.

### 3.7 Envelope — **kernel only**

`sealEnvelope` / `verifyEnvelope` / `EnvelopeRuntime` are implemented and tested
to the reference's rejection vocabulary (structure, `amp`/`kind`, version
intersection, expiry with skew, nonce replay, Ed25519, FIFO per
`(from, to, thread)`, `out_of_order` queuing, sticky cancel tombstones).

They are **not wired** because this plugin has no peer to exchange A-surface
messages with. The browser client cannot verify Ed25519 without pulling the
protocol layer (and `node:crypto`) into the client bundle, and the host↔client
RPC is same-origin JSON, not a peer protocol. The takeover waterfall is the
obvious future consumer; it currently uses its own durable window model, and
pretending it is an AMP interrupt without an `InterruptRecord`/receipt pair would
be a rename, not a conformance.

### 3.8 Warrant — **wired** for claims and unknowns

`deriveConfidence`, `validateClaim`, `validateHypothesis`, `suggestTier`,
`canAuthorizeEffect`, `reviseClaim`, `pressureBlocked` are implemented with the
reference's constants (`TierBase`, `TrustCap`, the 0.6 authorization floor, the
T1/T2/T3/T4 gates) and tested against them.

`deriveConfidence` and `validateClaim` are now on the write path: every claim the
plugin stores has its `confidence` derived and is dropped if the validator
reports a problem. `validateHypothesis`, `suggestTier`, `canAuthorizeEffect`,
`reviseClaim` and `pressureBlocked` remain kernel-only (no hypothesis, effect
authorization or revision path exists yet).

### 3.9 Claims and unknowns from comprehension — **wired**

`AmpService.closeTurn` turns one comprehension row into claims and an unknown
(`buildClaim` / `buildUnknown` in `src/host/amp.ts`, fed by
`CoordinationService.ampCognitionFor`).

| Field | Artifact | Tier rule | Evidence |
|---|---|---|---|
| `intent` | `claim` | `T1` when the statement is **verbatim** in the prompt (case/whitespace-insensitive), else `T0` | one `testimony` item: `trust: asserted`, `independence: 1`, `entails: true`, `origin: prompt:<turn>`, `ref: memory:<prompt>`, `excerpt` ≤ 200 chars, `digest` of the anchor |
| `requirement` | `claim` | same | same |
| `constraint` | `claim` | same | same |
| `assumption` | `claim` | same | same |
| `ambiguity` | `unknown` | `importance = 1 − comprehension.confidence` (measured), `blocking: false`, `status: open` | none |

Rules that keep this from being tier inflation:

- **No fuzzy match.** Only a literal substring (whole statement or one sentence)
  promotes a claim to T1. A paraphrase stays T0 with an empty `warrant.evidence`
  and a derived confidence of `0.35`.
- **Confidence is never read from the comprehension row.** It is always
  `deriveConfidence({tier, warrant})`; the T1 case lands on `0.7` (capped by the
  `asserted` trust ceiling), the T0 case on `0.35`.
- **Placeholders are skipped.** `none`, `n/a`, `-`, `无`, `暂无`, `不适用`, `null`,
  `undefined` produce neither a claim nor an unknown.
- **Invalid claims are dropped.** `validateClaim` runs before the append; a
  failing claim is logged at debug level and not stored.
- **Bounded text.** Statements are collapsed and capped at 1000 characters;
  excerpts at 200; the ambiguity question at 600.
- Every claim and unknown is followed by one `cognition.recorded` event naming
  the ids — not one event per object.

Hypotheses are still **not implemented**: a hypothesis needs `refutes_if` and
`prediction` (W-2), and no stage produces a prediction per claim yet. The type is
defined because `validateHypothesis` tests it.

### 3.10 Attention requests and interrupts — **wired** (takeover)

Every service-level takeover window is now an AMP attention transaction:

| Moment | Artifact | Where |
|---|---|---|
| the waterfall is intercepted and a durable window opens | `AttentionRequest` (`kind: "attention-request"`) as the payload of an `attention.requested` event | `TakeoverGate` observer → `AmpService.requestAttention` |
| a human answers, rejects, cancels, times out, or the plugin unloads | `InterruptRecord` (`kind: "interrupt"`) as the payload of an `interrupt.settled` event, plus **one** `ask` receipt | `TakeoverGate` observer → `AmpService.recordInterrupt` |

Policy that the objects carry (fixed, not measured):

| Window | `class` | `urgency` | `target` | `why_now` |
|---|---|---|---|---|
| approval | `commitment` | 4 | the tool (`Ref{kind:"tool"}`) | "the host blocked <tool> pending a human decision" |
| question | `curiosity` | 3 | the window (`Ref{kind:"question"}`) | "the agent needs a human answer before it can continue" |

`if_ignored` is the same for both: the call falls back to the host default and
cannot proceed as asked. `cost` is `{ interrupts: 1 }`; `fallback` is `escalate`;
`expires` is the gate's own `clarifyTimeout`, so the object and the timer agree.

Settlement mapping — and the rule that keeps the receipt honest:

| Human outcome | `InterruptRecord.status` | `granted` | `ask` receipt outcome | `usage.interrupts` |
|---|---|---|---|---|
| approval `allowed-once` | `granted` | true | `success` | 1 |
| question answered | `answered` | true | `success` | 1 |
| approval `rejected` | `denied` | false | `blocked` | 0 |
| approval `cancelled` | `withdrawn` | false | `partial` | 0 |
| cancel route / plugin unload | `withdrawn` | false | `partial` | 0 |
| `clarifyTimeout` elapsed | `expired` | false | `partial` | 0 |

`granted` is derived from `status` inside `buildInterruptRecord`, so the pair can
never disagree; `validateInterruptRecord` rejects a hand-built contradiction. The
`ask` receipt carries `usage.ms` as the measured window duration.

Why the documents ride inside **events**: AMP's `EntryKind` is closed to
`event | frame | receipt | claim | hypothesis | unknown | goal | plan`, and neither
`attention-request` nor `interrupt` is a chain kind. The reference keeps them in
its generic object table; this plugin keeps the chain closed and puts the
documents in `AmpEvent.payload`, with the receipt — the only settlement object
the protocol does chain — appended normally.

What is **not** implemented: interrupt policy (caps, quiet hours, debt, deferral
queues) and an enforced `interrupts` budget. The request/record objects carry the
numbers and the ledger accumulates them; nothing refuses a window because the
count is high.

### 3.11 Goal, Plan and Mission — **wired; turn projection gated on acceptance**

`AmpService.closeTurn` emits a `Goal` (`kind: "goal"`) and a `Plan`
(`kind: "plan"`) for a turn whose plan row is *monitorable*. The pair is gated,
not assumed: a missing fact defers the whole artifact and a `plan.deferred` event
names the reason.

| Gate | Passes when | Deferral reason |
|---|---|---|
| a goal row exists | the turn has a current goal | `missing-goal` |
| at least one step | `decodePlanStep` yields a step or a subtask draft | `no-steps` |
| every step has acceptance | each `PlanStepDraft.acceptance` / `PlanSubtaskDraft.acceptance` is non-empty | `missing-expect` |
| a constraint exists | the plan row's `constraint` is non-empty | `missing-abandon-if` |
| artifacts validate | `validateGoal` and `validatePlan` return no problem | `invalid-artifact` |

Mapping when the gate passes:

| AMP field | Source |
|---|---|
| `Goal.id` / `Plan.id` | `goal-<goal handle>` / `plan-<plan handle>` (the same ids the frame slots cite) |
| `Goal.statement` | the goal row's content |
| `Goal.success` | one criterion per step, `statement`/`check` = that step's acceptance |
| `Goal.value` / `priority` | `0.5` / `1` — the plugin ranks no goals; the neutral value is stated here, not measured |
| `Plan.tasks[]` | one per step: `intent` = step text, `actor: "self"`, `pre: []`, `expect = { observation, check } = acceptance` |
| `Plan.tasks[].irreversibility` | `1` (conservative "undoable with a clear reversal" default) |
| `Plan.tasks[].status` | plugin plan status mapped (draft/scored → draft, active → executing, done → done, failed/abandoned/rebuilt → abandoned) |
| `Plan.edges` | sequential pairs between adjacent tasks |
| `Plan.abandon_if` | one criterion from the plan's constraint text |
| `Plan.commitment_window` | `1` (deliberate after every step) |
| `Plan.budget` | the task lease (`ms`) |

The session planning adapter (`src/host/ampPlanning.ts`) additionally lets
`coordination_mission`, `coordination_goal` and `coordination_plan` create and
transition explicit AMP v0.1 objects. Its durable SQLite projections restore
queued missions after a restart; the scheduling cache is rebuilt using the
published `MissionQueue`, with priority then FIFO ordering. The published AMP
goal lifecycle enforces edges; plan tasks require completed prerequisites, and
goal achievement requires all non-abandoned attached plans and their tasks to be done. Every
mutation commits the projection and a canonical AMP goal/plan artifact or
lifecycle event in the same SQLite transaction. `GET /amp/planning?session=…`
(and `/amp/missions`, `/amp/goals`, `/amp/plans`) selects session-scoped
read-only projections, including turn-derived monitorable plans. This local UI query selector is not authentication or authorization. Mission is a
host-side scheduling projection, **not** a new AMP ledger entry kind. A terminal
DSH turn does not automatically complete a session-wide mission. The AMP
panel displays these states and checks without executing them.

### 3.12 Collaboration and optional DSH integrations — **wired when supported**

`src/host/ampCollaboration.ts` stores owner/assignee-scoped duties in `amp_duty`; assignment and transitions append `duty.assigned` / `duty.transitioned` events transactionally. Mission and duty are host projections, not new AMP artifact or ledger entry kinds. Duty events can carry bounded submission summaries, evidence and reviews as recorded collaboration data; the generic bus mirror still elides prose.

`coordination_collaboration` (`src/host/ampCollaborationTools.ts`) supports `list`, `agents`, `assign`, `accept`, `start`, `submit`, `verify`, `reject`, `cancel`. Actor identity comes only from `exec.agent.id`. Assignment requires the native descendant roster (`src/host/ampSubagents.ts`) with valid parent/depth lineage; no native roster means refusal. `assigneeSession` is the native DSH session ID returned by that roster, not an opaque coordination handle. Roles are `decision`, `outcome`, `resource`, `personnel`, `qualification`, `execution`.

Only the bound assignee may accept/start/submit; only the owner may verify/reject/cancel. Submission requires summary and evidence; review requires review text. Edges are assigned → accepted → working → submitted → verified/rejected, with rejected → working for rework and cancellation from nonterminal states. `submitted` is not auto-verified; neither submission nor verification completes a linked plan/task. Acceptance and planning updates remain explicit. Coverage: `ampCollaboration.test.ts`, `ampCollaborationTools.test.ts`, `ampSubagents.test.ts`.

The client has independent `missions`, `goals`, `plans`, `collaboration` navigation (`src/client/panel.ts`). Read-only `GET /amp/planning`, `/amp/missions`, `/amp/goals`, `/amp/plans`, `/amp/collaboration` select records with `?session=<native-dsh-session-id>`. This query is **local host UI observability, not authentication or authorization**; it does not establish the tool actor or a remote security boundary.

`src/host/ampSkills.ts` registers eight bundled skills through provider `deepseek-coordination` at fallback rank **600**: `amp-planning`, `amp-missions`, `amp-goals`, `amp-plans`, `amp-collaboration`, `amp-duties`, `amp-delegation`, `amp-handoffs`. Bodies load on demand. `src/host/ampExtensions.ts` optionally registers read-only human commands `/coord-missions`, `/coord-goals`, `/coord-plans`, `/coord-duties`, plus dynamic user-role recorded context bounded to 8,000 characters (eight nonterminal duties, four missions, four goals, three plans; fields and nested lists also bounded, truncation reported). It derives the session from the agent and treats records as data. Coverage: `ampSkills.test.ts`, `ampExtensions.test.ts`.

`src/index.ts` capability-gates skills, commands, prompt context and native subagents. A global session-filtered context uses each assembled agent's `agent.id`, including child agents; an additional continuable-child setup is installed only when `registerContinuableSetup` exists and is not required for that path. These source paths and tests do not establish actual live registration, loading or invocation in a deployed runtime.

The honest limit: `expect.check` is the **recorded acceptance text**, not a
machine-executable command. The protocol says a criterion's `check` must be
executable; this host has no check runner, so the plan is monitorable by a human
but not yet by the kernel. That is a named gap, not a silent claim (P3b below).

## 4. Invariants and where they are enforced

| Rule | Invariant | Enforced at | Test |
|---|---|---|---|
| S-1 | Everything signed or digested goes through canonical JSON | `canonical`, `digestOf` | `ampProtocol.test.ts` |
| B-1 | An unreferenceable id is rejected, not minted | `isId`, `RefTable.add`, `frameFrom` | `ampProtocol.test.ts` |
| A-1 | Every slot says why it is attended to | `frameFrom` (`why is empty`) | `ampProtocol.test.ts`, `ampWiring.test.ts` |
| A-2 / F-4 | Deliberate exclusions are recorded with a revisit trigger | `frameFrom` (`revisit_if`), `AmpService.ignoredFor` | `ampWiring.test.ts` |
| F-2 | At most nine slots; the ceiling can only be lowered | `frameFrom` (`maxSlots`) | `ampProtocol.test.ts` |
| F-3 | `digest` is computed, never supplied | `frameFrom`, `verifyFrameDigest` | `ampProtocol.test.ts` |
| F-6 | `spent` may not exceed `allocated`, per dimension | `frameFrom` (`checkBudget`) | `ampProtocol.test.ts` |
| F-7 | Overflow exclusions are returned as `deferred`, never dropped | `frameFrom` (`maxIgnored`) | `ampProtocol.test.ts` |
| M-1 | Manifest confidence derives from receipts | `AmpService.capabilitiesFrom` | `ampWiring.test.ts` |
| W-4 | Tier gates (T1 entails, T2 observation, T3 intervention, T4 replication) | `validateClaim`; `buildClaim` drops a claim that fails it | `ampProtocol.test.ts`, `ampWiring.test.ts` |
| W-4b | A claim rises above T0 only on a verbatim prompt anchor | `verbatimAnchor`, `buildClaim` | `ampWiring.test.ts` |
| W-2 | A hypothesis needs `refutes_if` and `prediction` | `validateHypothesis` | `ampProtocol.test.ts` |
| W-3 | Revision keeps the old claim and references it | `reviseClaim` | `ampProtocol.test.ts` |
| W-5 | Pressure without evidence cannot raise confidence | `pressureBlocked` | `ampProtocol.test.ts` |
| P-3…P-10 | Envelope defaults, tamper detection, expiry, version window, FIFO, cancel | `sealEnvelope`, `verifyEnvelope`, `EnvelopeRuntime` | `ampProtocol.test.ts` |
| R-1 | Receipts are the calibration ground truth; events are the log | `AmpService` (receipt/event split) | `ampWiring.test.ts` |
| X-1 | Nothing is updated or deleted | SQLite triggers + `AmpService` (append-only API) | `ampWiring.test.ts` |
| X-2 | One chain over all entries; a rewrite breaks every later hash | `AmpStore.verify`, `verifySnapshot` | `ampProtocol.test.ts`, `ampWiring.test.ts` |
| X-5 | Checkpoint signatures are domain-separated | `sealCheckpoint` (`CheckpointDomain`) | `ampProtocol.test.ts` |
| X-7 | `prev` links the previous checkpoint's signed body, not an entry hash | `checkpointDigest` | `ampProtocol.test.ts` |

## 5. Plugin concepts → AMP

| Plugin concept | AMP artifact | Rule |
|---|---|---|
| `selection.interaction` | `Frame.mode` | `frameModeOf` |
| `selection.profession/scene/validation` | frame slot targets (`concept`) | one slot each |
| scene policy gaps (`allowBash`, `maxIteration`, `allowWeb`) | `Frame.ignored` | `AmpService.ignoredFor` |
| turn row | `Frame` (open) + `Receipt` (`reflect`, close) | one per turn |
| tool call | `Receipt` (`read`/`attend`/`act`) | `withAmpReceipts` |
| `orchestration_trace` | **not** converted | it keeps its own hash chain (§7) |
| module event bus | `AmpEvent` | `AmpService.observe` |
| `config.defaultLease` | `Frame.budget.allocated.ms`, `Manifest.attention.budget.ms` | measured budget |
| turn `created`/`finished` | `Receipt.ms`, `Receipt.usage.ms` | measured duration |
| coordination tool capability declarations | `Manifest.capabilities` | `COORDINATION_CAPABILITIES` |
| comprehension `intent`/`requirement`/`constraint`/`assumption` | `Claim` (T1 only when verbatim) | `buildClaim` |
| comprehension `ambiguity` | `UnknownItem` (`importance = 1 − confidence`) | `buildUnknown` |
| takeover window opening | `AttentionRequest` + `attention.requested` event | `TakeoverGate` observer, `requestAttention` |
| takeover settlement | `InterruptRecord` + `interrupt.settled` event + one `ask` receipt | `TakeoverGate` observer, `recordInterrupt` |
| plan row with per-step acceptance | `Goal` + `Plan` (gated; see §3.11) | `recordPlan` |
| plan observation/unknown | `plan.deferred` event naming the missing fact | `planDeferReason` |
| `calibration` table | **not** converted | no predicted/realized VOI pairs yet (§7) |

## 6. Compatibility and data

- **No DSH core API change.** Planning and collaboration use tools and independent read-only panel pages, with no AMP kernel import in the browser. Skills, commands, dynamic context and continuable-child setup are capability-gated.
- **Additive schema 28.** Planning and duty projections join the existing AMP ledger. Mutations append artifacts or lifecycle events transactionally; mission and duty add no AMP kinds.
- **Explicit recorded content.** `amp_object.body` holds AMP artifacts: frame rationale, goal criteria, plan checks, claims/unknowns and bounded duty submissions/reviews may contain prose. Generic mirrored bus events elide arbitrary prose; file bodies and transcript mirroring are not added by these projections.
- **Key material.** The Ed25519 private key is stored once in `amp_key` in the
  plugin's own database and never returned by a route. `GET /amp/identity`
  returns `{ kid, alg, publicKey }`.
- **Failure is non-blocking.** Artifact production runs behind the turn: a key
  load failure or a locked database logs at debug level and the turn proceeds.
  The ledger then has one entry fewer — it never reports a fabricated one.

## 7. Deliberately not implemented

Each row is a gap with a reason, not an accident.

| Protocol surface | Why not |
|---|---|
| A-surface messages / federation / A2A | no peer in this deployment; the client is same-origin, not an agent. |
| `AttentionRequest` / `InterruptRecord` | **wired** (P2); see §3.10 |
| interrupt policy (caps, quiet hours, debt, deferral) and an enforced `interrupts` budget | the objects record the cost and the ledger accumulates it, but nothing refuses a window because the count is high. |
| headless activation | the plugin declares inject: [webServer], so a profile that mounts no webserver leaves the entry pending; the composed service does not need the routes. Mounting @deepseek-ai/dsh-host-webserver plus its startup row, or relaxing the inject, is the fix. |
| Governance layer (attention manifests, switch credentials, approval matrix, plans/workflows, legal) | org-scale governance; this plugin has one principal (the local user) and no org directory. |
| Hypotheses in the ledger | a hypothesis needs `refutes_if` and `prediction` (W-2); no stage predicts per claim, so emitting one would be a position dressed as a hypothesis. |
| Tool observations as `EvidenceItem`s | a tool receipt records that a call happened, not a proposition; evidence is attached where a claim cites it. |
| executable `expect.check` | the plan's acceptance text is recorded as the check; this host has no check runner, so the criterion is monitorable by a human, not by the kernel (P3b). |
| automatic goal ranking | Turn-derived `Goal.value` / `priority` stay neutral (0.5 / 1); explicit mission goals use the caller's validated integer priority to schedule via AMP `MissionQueue`. No inference-based goal ranking exists. |
| Process objects | no process authoring surface exists. |
| Token/call/money budgets | the host owns token accounting; only `ms` is measured here. |
| MCP tool execution / sandbox policy | DSH owns tools and permissions; the plugin registers read-only tools and never executes. |
| `orchestration_trace` → `AmpEvent` | the trace has its own hash chain and triggers, and it is queried per turn. Converting it would double-write the same governance facts; the trace stays the relational projection, while AMP events record the lifecycle moments. |
| `calibration` table → manifest calibration | the table stores `(model, dimension, predicted, actual)` for the Bayesian engines, not per-receipt VOI pairs, so it cannot feed `predicted_voi`/`realized_voi`. |

## 8. Verifying

```powershell
npm run typecheck      # src
npm run test:tsc       # test tree
npm test               # kernel, wiring, lifecycle, routes and existing suites
npm run build          # lib/index.mjs, lib/index.d.ts, lib/client.js
npm run pack:check     # tarball carries the runtime files
```

Live checks, against the Web GUI's port:

```powershell
curl http://127.0.0.1:<port>/deepseek-coordination/amp/identity
curl http://127.0.0.1:<port>/deepseek-coordination/amp/manifest
curl "http://127.0.0.1:<port>/deepseek-coordination/amp/frame?session=<dsh-session-id>"
curl "http://127.0.0.1:<port>/deepseek-coordination/amp/ledger?limit=20"
curl http://127.0.0.1:<port>/deepseek-coordination/amp/verify
curl -X POST http://127.0.0.1:<port>/deepseek-coordination/amp/checkpoint
```

`/amp/verify` returns `{ ok, reasons, tip, count, checkpoint? }`; a non-empty
`reasons` is the finding, not a warning.

### Historical live verification (2026-10-29, desktop client)

The package was installed with `dsh plugin --profile desktop add` into
`%DSH_HOME%\profiles\desktop` and verified against the running harness, not a
fixture. These counts describe that historical build, not the current source or a current live installation:

| Check | Observed |
|---|---|
| plugin loads in the running app | `/deepseek-coordination/ping` answered; `/amp/identity` returned `ed25519-943704d04e1d94a3` |
| manifest signature | independent canonical-JSON + WebCrypto verifier: digest match, signature valid, kid match; 11 capabilities, `ece: 1` with the two stated limits |
| ledger contents | 19 entries: 3 frames (4 slots, 2 exclusions each), `turn.opened` mappings, `attend`/`read` tool receipts, one `reflect` receipt for a closed turn, mirrored `pipeline.report` with `[text omitted]` prose |
| frame route | `GET /amp/frame?session=…` returned mode `explore`, `cycle 1`, a `sha256:` digest, four slots with `why`, two exclusions with `revisit_if` |
| checkpoint + verify | `POST /amp/checkpoint` sealed `seq 0` over `count 19`, tip `sha256:c9c3a69…`; `GET /amp/verify` → `{ ok: true, reasons: [] }` with the checkpoint cross-checked |
| client module | `plugins/??deepseek-coordination/client.js&rev=…` served 3,441,910 bytes and is listed in `__DSH_BOOT__.entries` |

Two findings from that run are captured as gaps:

- **A tool result crossed the boundary lossily.** `coordination_selection`
  returned a value DSH refused with "value is not lossless JSON"; the projection
  carried absent optional keys as `undefined`. The fix is twofold: omit absent
  fields (`presets[].description`, `defaultMode`) and detach every tool value
  through `jsonSafe` (`src/shared/jsonSafe.ts`) in `withAmpReceipts`. The
  boundary now guarantees a lossless value, and a coercion is logged at debug
  level instead of failing the call.
- **An installed update is not hot-swapped**, so the running process keeps the
  module it booted with. `/ping` reports `version` to make the live build
  observable; a restart is required to load a new one.

### Historical plan gate, observed live (0.19.0)

The 0.19.0 package was hot-loaded into the same desktop client (`/ping` →
`0.19.0`) and a fresh turn closed through the new path. The ledger recorded

```
kind: event  type: plan.deferred
payload: { plan: "coordination-plan-…", reason: "missing-goal", steps: 6 }
```

That turn had a six-step plan but no goal row, so the `Goal`/`Plan` pair was
**not** fabricated; the deferral reason is the same string the unit tests assert.
`plan.recorded` (the positive branch) is covered by the lifecycle test
(`ampLifecycle.test.ts`) and the emitter tests, but has **not** yet been
observed against the live client — a live turn needs both a goal row and
per-step acceptance. `/amp/verify` still returned `{ ok: true, reasons: [] }`
after the deferral event.

## 9. Roadmap

| Phase | State | Work | Unblocks |
|---|---|---|---|
| P1 | **done (0.16.0)** | Comprehension fields become warrant-validated `claim`s and an `unknown`; T1 only on a verbatim anchor; confidence always derived | W-4 on the write path |
| P1b | open | Wire self-observations into claims (tool outcomes as evidence items) once a claim actually cites a tool result | richer evidence graphs |
| P2 | **done (0.17.0)** | Takeover windows become `AttentionRequest` + `InterruptRecord` + one `ask` receipt, with `usage.interrupts` counted | interrupt accounting |
| P3 | **done (0.19.0)** | `Goal` + `Plan` emitted when every step records acceptance and the plan records a constraint; otherwise `plan.deferred` names the gap | plan monitoring |
| P3b | open | Turn `expect.check` into a runnable command and add goal ranking | §7 rows 1–2 |
| P4 | open | Use `EnvelopeRuntime` for the host↔host path if a second plugin ever peers with this one | A-surface |
| P5 | open | Split `src/protocol/` into a published package if a second consumer appears | removes the vendored port |

## 9. Scoped control (AMP 0.5.0 surface)

AMP 0.5.0 defines eight canonical control tools over three scopes. This host
implements the same contract natively against its own SQLite database:

| Concern | Where |
|---|---|
| Shared vocabulary + pure validation | `src/shared/control.ts` |
| Persistence, inheritance, CAS, `dryRun`, batches | `src/host/control.ts` (`ControlService`) |
| HTTP surface | `src/host/controlRoutes.ts` (`/control/registry`, `/control/settings`) |
| Agent surface | `src/host/controlTools.ts` (`coordination_control`) |
| UI surface | `KnowledgPanel` in `src/client/panel.ts` (effective settings + reset) |
| Tests | `test/control.test.ts` |

Rules enforced (each pinned by `test/control.test.ts`):

1. **Inheritance** `global �� workspace �� session`; the most specific row wins.
2. **Deletion markers**: removing an inherited entry writes a tombstone in the
   narrower scope, so a wider row cannot resurrect it.
3. **CAS**: `expectedVersion` mismatch is `INVALID_STATE` (HTTP 409); a first
   local write starts at version 0.
4. **Dry run**: validates and reports the version it would produce, writes nothing.
5. **Selector XOR mix**, with finite non-negative weights, at least one positive,
   and keys restricted to the domain's vocabulary.
6. **Metadata only**: registry values are JSON objects; no tool schema, policy or
   executable value is stored.

## 10. Knowledge files

`src/host/knowledge.ts` records explicit "this file is knowledge" marks
(`knowledge_file`), scoped `workspace`/`session`, metadata only (title, note,
tags �� never the body). `coordination_knowledge` and `/graph/knowledge` share
that service, and a mark publishes the matching `knowledge` registry record so
the AMP control surface and the panel cannot disagree.
