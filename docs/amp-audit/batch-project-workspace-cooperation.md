# AMP audit — project / workspace / cooperation

Target: `deepseek-coordination` (AMP 0.14.0 surface as exposed by the 17 catalog modules).
Scope: semantic wiring, not verb existence. Files inspected: `src/host/handlers/project.ts` (whole, 178 lines), `src/host/handlers/cooperation.ts` (whole, 77 lines), `src/host/handlers/workspace.ts` (lines 330-408, write/diff path), `src/host/handlers/index.ts` (outline + imports).
Note on the brief: `src/host/handlers/projectOutline.ts` does not exist; the module is `src/host/projectOutline.ts`, imported one level up at `src/host/handlers/index.ts:11`.

## project

**AMP API:** `rules`, `metadata`, `environment`, `describe_environment` (read verbs), `configure_environment` (mutating, protected patch with CAS), `put_rule` (mutating, expected version), `outline` (project outline tree). Contract implies project state owned by AMP with a project-level revision/hash as the CAS token.

**Plugin usage:**
- `metadata` — `src/host/handlers/project.ts:86-93`; backing service: plugin-local `packageMetadata()` (`project.ts:65-84`, reads `<root>/package.json` + root path) plus `takeProjectOutline()` (`src/host/readNavigation.js`, imported at `project.ts:6`) which short-circuits with `phase: 'project_outline'` on first call.
- `rules` / `environment` — `project.ts:95-98` and `100-103`; backing service: `readProject()` (`project.ts:35-55`) over `.deepseek-coordination/project.json` (`fileOf`, `project.ts:31-33`). No AMP project port is imported in this file.
- `describe_environment` — `project.ts:105-121`; same local store, plus heuristic gap reporting (`no environment variables declared`, etc.) and `packageMetadata()`.
- `configure_environment` — `project.ts:123-154`; CAS is a per-file integer `version`: `expectedVersion` mismatch returns `version_conflict` (`project.ts:125-127`), patch merges variables/paths/dependencies, `dryRun` returns the would-be state, then `writeProject()` (`project.ts:56-64`) does temp-file + `renameSync` atomic replace and registers the store dir in the repo ignore file via `ensureStoreIgnored`.
- `put_rule` — `project.ts:156-175`; per-rule `version` CAS (`existing.version` vs `expectedVersion`), then whole-file `writeProject()`.
- `outline` — not in this handler map. Registered from `src/host/projectOutline.ts` (`index.ts:11`). The outline-first gate that every other project verb reuses is plugin-local bookkeeping in `readNavigation.js`, not an AMP project port call.

**Gaps:**
1. `configure_environment` does **not** CAS-write through AMP's project API; it rewrites a plugin-private JSON file. The CAS token is a monotone integer inside that file, not AMP's project revision/baseHash, so it cannot detect conflicts against AMP-side project state and is invisible to AMP core and to other AMP surfaces.
2. No AMP project port is touched by any project verb in this file — the whole module is a local shadow store (contrast `workspace.ts:11-12`, which does import the real `attention-manifest-protocol/*` ports), so `rules`/`environment`/`metadata` are the plugin's view, not AMP's state.
3. `expectedVersion` is optional on both `configure_environment` and `put_rule`; when omitted, last-writer-wins. That is weaker than the advertised CAS-guarded mutation.
4. `src/host/projectOutline.ts` was not read (12-call budget), so whether `outline` is AMP's outline implementation or a hand-rolled walk is unconfirmed; the evidence available (separate module, plugin-local `takeProjectOutline` helper, no AMP import in the project path) points to hand-rolled, but treat that as likely rather than proven.
5. `metadata`/`describe_environment` return the absolute workspace root and raw `package.json` fields with no redaction.
6. The store lives at `.deepseek-coordination/project.json` and is git-ignored by the handler itself — durability is host-disk only, with no AMP journal entry.

**Verdict:** partial

## workspace

**AMP API:** `list`, `read`, `outline`, `document_outline`, `diff`, `write` (mutating; full write with `expectedBaseHash`/`expectedBufferVersion` CAS, mounts the file and flushes through the file port). Outline-first ordering is part of the protocol contract (`project outline → file outline → content`).

**Plugin usage:**
- Mount/lease plumbing: `workspaceOf()` (`src/host/handlers/workspace.ts:48-71`) resolves a root to an AMP workspace mount; `openFile()` (`workspace.ts:78-86`) mounts a `file` port and snapshots it; `resolveInRoot()` (`workspace.ts:29-39`) confines paths to the root.
- `list` — `workspace.ts:193-208`; backing service: `collectEntries()` (`workspace.ts:139-168`), a plugin-side `readdir`/`stat` walk with its own internal-directory filtering. Not the AMP workspace listing.
- `read` — `workspace.ts:~210-270`; backing service: AMP file mount (`opened.file`) for text/revision, plus `takeProjectOutline()`-style gating at `workspace.ts:215-218` and `232-246`; line/byte/char windowing is plugin-side slicing.
- `outline` — `workspace.ts:310-329`; backing service: the AMP file port's outline (`opened.file.outline`), with parse failures mapped to `code`.
- `document_outline` — `workspace.ts:~276-300`; not read this pass (budget). Shares the mount path with `outline`.
- `diff` — `workspace.ts:337-345`; backing service: real AMP structured diff, `opened.file.diffStructured(base)` where `base` is either the caller's hash or the literal `'disk'`. Genuine, not a stub.
- `write` — `workspace.ts:349-405`. Existing file: `openFile(host, rel, true)` → `opened.file.planWrite(content, target, editOptions(parameters))` → `opened.file.write(...)` → `opened.file.flush()`, with `version_conflict` / `buffer_conflict` / `stale` codes relayed from AMP (`workspace.ts:399-403`) and the lease released in `finally`. That path is genuinely AMP-backed and CAS-guarded.

**Gaps:**
1. The create branch of `write` (`workspace.ts:359-373`) bypasses AMP entirely: `mkdirSync` + `writeFileSync(target.absolute, ...)` then a read-only re-mount. Creation therefore gets no CAS, no AMP journal entry, no mount-time validation — the CAS/hash returned afterwards is computed post-hoc.
2. `workspace.list` is a hand-rolled FS walk (`collectEntries`, `workspace.ts:139-168`), so listing semantics (ignore rules, scoping, depth policy) diverge from the AMP workspace the other verbs talk to.
3. `write` does not enforce outline-first inside the handler: the path from `workspace.ts:349` to `flush()` contains no project/file outline gate, while `read` and the project verbs do gate. Outline-first is thus verb-inconsistent unless a higher layer enforces it (not verified — native `src/index.ts` hooks were outside the read budget).
4. Full-file `write` is the only mutation path in this handler; targeted edits rely on the separate `replace` verb, so the error text steering callers there is the only guard against blind overwrite.
5. `document_outline`'s implementation was not inspected, so its wiring is asserted only by shared mount plumbing.

**Verdict:** partial

## cooperation

**AMP API:** `inbox` (read messages addressed to this agent), `send` (mutating; message inside an existing delegation scope), `report_result` (mutating; submit a delegated result **with provenance**). Contract implies AMP-owned message/result transport with a delegation/result binding and host-side verification.

**Plugin usage:**
- `inbox` — `src/host/handlers/cooperation.ts:24-30`; backing service: `host.mailboxes.get(sessionOf(host))`, an in-memory `Map` on the host object, filtered to `to === null || to === sessionId`, then paginated by `page()`.
- `send` — `cooperation.ts:32-50`; backup service: constructs an `Envelope` (`cooperation.ts:12-21`) and pushes it into the **sender's own** mailbox, trimming to the last 200 (`mailbox.slice(-200)`). `to` is recorded in the envelope and never used for delivery.
- `report_result` — `cooperation.ts:52-72`; same mailbox, `kind: 'result'`, `to: null`, returns `{ reported: true, id, verified: false }`.
- No `attention-manifest-protocol/*` import exists in this file at all (`cooperation.ts:2-6` imports only `node:crypto`, local names, the host type and handler helpers).

**Gaps:**
1. Neither `send` nor `report_result` persists through AMP cooperation ports: state is a per-host in-memory `Map`, lost on restart, never journaled, no evidence/provenance record. This is the largest gap in the batch.
2. `send` does not deliver. The recipient's mailbox is never written, so `to` is decorative; with a single session, the only reader of a message is its sender.
3. `inbox` therefore is not an inbox: it returns the session's own mailbox, including the session's own outgoing messages and its own results. Broadcast envelopes (`to: null`) are only visible to the session that wrote them, so there is no cross-agent delivery at all.
4. `report_result` is a local note, not a submission: `verified: false` is hard-coded, there is no parent/delegation binding, no status lifecycle, and no host result handoff. It cannot be distinguished from a message except by the `kind` field.
5. `slice(-200)` silently drops the oldest entries with no cursor or eviction signal; `page()` paginates an already-truncated buffer.
6. Session scoping exists only as a `Map` key (`sessionOf(host)`); there is no delegation scope, so `send` cannot be constrained to a parent/child relationship as the AMP contract requires.

**Verdict:** missing
