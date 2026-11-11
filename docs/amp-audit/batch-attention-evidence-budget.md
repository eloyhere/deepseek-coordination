# AMP audit — attention, evidence, budget

AMP 0.14.0 · handlers `src/host/handlers/attention.ts` · host services `src/host/amp.ts`

Cross-cutting: the host binding still advertises `policyVersion: 'dsh-amp-0.9.1'` in `AmpHost.bindingFor`, so three of these verbs are wired against 0.9.1-era semantics while 0.14.0 is installed.

## attention

AMP API: `attention.context` compiles and injects the turn's attention package; `attention.get` reads one attention object; `attention.request_focus` requests focus residency and the host decides.

Plugin usage:
- `attention.context` — `src/host/handlers/attention.ts:25`; prefers `host.contextOptimizer?.packageFor(sessionId)` (`src/host/amp.ts:201`); falls back to `host.kernel().flow.compileTurnContext(...)` at `attention.ts:37` with a synthetic one-item `create` list.
- `attention.get` — `attention.ts:65`; `host.findEntity('attention', id)` reads raw `kernel.store.list('attention')` rows (`amp.ts:563`).
- `attention.request_focus` — `attention.ts:72`; pushes an `attention-focus` record into `host.notes` (`amp.ts:506`), trims to the last 100 and answers `granted: false`. The notes map is host state, persisted by `state.flush()` after every call (`amp.ts:308`, `amp.ts:772`).

Gaps:
- context: on a `packageFor` hit the `turn`, `budget` and `principalId` parameters are ignored, so callers cannot compile for a different turn or budget. The fallback is an admitted synthetic single-item compile, not the package the model received; and the optimizer is optional (`?`), attached by the composition root, so the synthetic path is the real behavior whenever it is missing.
- get: raw-store lookup with no tenant, principal or session predicate — the binding identity is unused, so any id resolves regardless of owner; no version/CAS or residency check.
- request_focus: no AMP attention API is called and no attention entity is created. Focus is a durable host note with a hard `granted: false`; the session comes from the host, not the request.

Verdict: partial

## evidence

AMP API: `evidence.get` and `evidence.list` read evidence records; `evidence.cite` cites evidence ids.

Plugin usage:
- `evidence.get` — `attention.ts:83`; `host.kernel().ports.evidence.get(id, host.config.tenantId)` — the real evidence port, tenant-scoped.
- `evidence.list` — `attention.ts:90`; `host.listEntities('evidence', sessionId)` reads raw `kernel.store.list('evidence')` rows and applies hand-rolled filters (`amp.ts:573`), bypassing `kernel.ports.evidence`.
- `evidence.cite` — `attention.ts:95`; adds each id to the host `citations` Set (`amp.ts:526`) and returns `host.citations.size`. No `kernel.flow.recordEvidence`, no ledger write.

Gaps:
- list: not the evidence port. The filter accepts `row.sessionId`, `row.id` or `scope.sessionId` and has no tenant predicate, so rows with other scope shapes are missed and cross-tenant evidence can be returned.
- cite: ids are never verified against `kernel.ports.evidence`, never recorded with principal/turn, and the citation Set is store-wide (the getter is documented as "the current session" but is not keyed by session), so `total` mixes sessions. Citations never reach the AMP evidence ledger and are invisible to `evidence.get`/`list`.
- get is the only verb that uses the ledger; list and cite stay host-side.

Verdict: partial

## budget

AMP API: `budget.remaining` reports remaining budget for the binding.

Plugin usage:
- `budget.remaining` — `attention.ts:81`; `host.kernel().snapshot().budget` — the kernel snapshot aggregate only. No budget port/tree call and no binding, session or turn argument.

Gaps:
- No scope: the binding (`tenantId`, `principalId`, `sessionId`, `turnId`) is discarded, so every caller in the store gets the same figure.
- No ledger/tree read: no allocation nodes, reservations, grants or per-turn remainder; the snapshot aggregate cannot distinguish the caller's account.
- A kernel store fallback to the machine-wide store (`amp.ts:412`) is followed silently, so the number can describe a different store than the caller's workspace.

Verdict: partial
