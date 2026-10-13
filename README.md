# deepseek-coordination

Cross-platform **atomic OS-interaction surface** for the DeepSeek Harness.

An agent that talks to the operating system through *strings* gets the wrong answer whenever a path
contains a space, a file carries a UTF-8 BOM, a line ending is CRLF, a document is not UTF-8, or a
command is assembled by concatenation. This project replaces string assembly with an **argument-stable
verb set** and makes encoding, byte order marks and line endings explicit and byte-exact.

The same verb surface is implemented natively on Windows and on POSIX, and can be driven either by an
agent through a single harness tool or by a person directly in a terminal.

```console
$ dsh-os selfcheck
{"ok":true,"verb":"selfcheck","result":{"script":"bin/dsh-os.ps1","capabilities":{...}},"meta":{...}}

$ dsh-os file charset "C:\path with spaces\notes.txt"
{"ok":true,"verb":"file.charset","result":{"charset":"utf-8-bom","bom":true,"eol":"crlf"},"meta":{...}}
```

* **Fully open source**, MIT licensed. No telemetry, no account, no network request.
* **Zero runtime dependencies.** On Windows it is `Add-Type` P/Invoke; on POSIX it uses system tools
  such as coreutils. Nothing is fetched at run time.
* **One self-contained file per platform**, assembled from modules by a deterministic build.

> [!WARNING]
> This layer can **read your screen, capture screenshots, read and write the clipboard, synthesise
> mouse and keyboard input, start and kill processes, delete files and modify environment variables**.
> Before granting it any permission, read [Dangerous permissions](#dangerous-permissions).

---

## Why it is needed

The failure mode is always the same shape: a value becomes part of a string and is then reinterpreted
downstream.

| Fault | What goes wrong | What this project does |
|---|---|---|
| `C:\Program Files\a b.exe` | a space splits one path into two arguments | values are always **separate argv elements**, never spliced into a shell string |
| a UTF-8 BOM in the middle of text | every consumer sees `\uFEFF` | the BOM is stripped on read and **never** leaks into a result; it is restored on write |
| a CRLF file rewritten as LF | diff noise, broken scripts | reads report `eol`; writes restore the original convention |
| a GBK document read as UTF-8 | silent mojibake (or a silent fall back to `latin1`) | the encoding is declared explicitly; strict UTF-8 is tried first, then a fall back |
| a command built by concatenation | injection, quoting bugs | `execute.command` takes a real **argv array** and never goes through a shell |
| a byte offset landing inside a character | text is cut to pieces | offsets are validated against the encoding's character boundaries |

Every call returns **exactly one JSON envelope**, and a caller branches on `error.code` rather than
parsing prose — and a **failing** call emits a parseable envelope too, because a bare exit code tells
an agent nothing.

---

## Repository layout

```
deepseek-coordination/
├─ src/host/command.txt            authoritative verb contract, one verb per line
├─ src/host/spec/verbs.tsv         machine-readable verb table (single source of truth), 86 verbs
├─ src/host/spec/charsets.tsv      IANA name -> .NET code page -> iconv name -> BOM bytes, 15 charsets
├─ src/host/lib/powershell5.1/*.ps1  source: Windows PowerShell 5.1 side, the 16 modules build.ps1 lists plus the standalone git.ps1
├─ src/host/lib/powershell7.6/*.ps1  source: PowerShell 7.6 side, the same 16 modules plus the standalone git.ps1
├─ src/host/lib/*.sh               source: POSIX side, 16 shell modules plus the standalone git.sh
├─ src/host/lib/powershell.md      the 5.1 -> 7.6 API-change reference (referenced by no code, test or package.json; not published)
├─ src/host/bin/dsh-os.ps1         [generated] Windows PowerShell 5.1 implementation
├─ src/host/bin/dsh-os7.ps1        [generated] PowerShell 7.6 implementation
├─ src/host/bin/dsh-os.sh          [generated] POSIX implementation
├─ src/host/bin/dsh-os.bat         ASCII-only cmd.exe shim (hand-written, not generated)
├─ src/host/docs/os-spec.md        full specification: contracts, error codes, golden matrix
├─ src/host/docs/permission-model.md  the authorization model and its residual risk
├─ src/plugin/index.js             host plugin: registers the `dsh_os` tool
├─ src/plugin/invoke.js            shared invocation layer: artefact/edition resolution, spawn, envelope parsing
├─ src/plugin/settings.js          settings service + the panel's two HTTP routes (`/api/dsh-os/*`)
├─ src/plugin/takeover.js          `tools/execute` interception: answers the built-in read/write/edit/pwsh through dsh-os
├─ src/plugin/workflow.js          intent-first workflow: the `workflow_plan` tool, its phase gates and its prompt section
├─ client.js                       browser half: the `dsh.client` artifact that renders the settings panel
├─ src/permission/index.js         consent delegate: the only writer of permission.json, registers five `os_permission_*` tools
├─ tools/build.ps1                 assembles the three generated scripts; `-Check` fails on drift
├─ tools/parse-check.ps1           parse-checks each module under the runtime that will execute it, and reports non-ASCII bytes and a BOM
├─ tools/json-field.mjs            reads one field of an envelope by dotted path (used by the shell suites; `sed` cannot see into a nested object)
├─ tools/verify-bundle.mjs         verifies the loader's resolution contract (16 cases)
├─ tools/verify-plugin-load.mjs    runs the real `apply()` path, including the workflow state machine (30 cases)
├─ tools/verify-package.mjs        packs the package and asserts every runtime-resolved file ships (20 cases)
├─ tools/verify-editions.mjs       proves both PowerShell artefacts are reachable (14 cases)
├─ tools/probe-pipeline.mjs        drives the interception end to end against a stubbed verb layer (23 cases)
├─ tests/                          golden (Windows/POSIX/desktop injection), table conformance, encoding, plugin, permission, takeover, workflow suites
│  ├─ conformance.ps1              command.txt and spec/verbs.tsv must describe the same surface (5 cases)
│  ├─ takeover.test.mjs            byte-level format preservation, read windowing, eligibility (41 cases)
│  ├─ workflow.test.mjs            phase gates, the user's choice, and the KV-cache invariant (30 cases)
│  ├─ smoke-desktop-sh.sh          what the POSIX desktop verbs actually inject (52 cases)
│  └─ fake-xdotool, fake-wmctrl    recording stand-ins, so the desktop verbs can be verified with no X server
└─ permission.json                 authorization data (an empty file in the repository; that is the initial state)
```

The two PowerShell runtimes live in separate directories because the differences are not cosmetic:
.NET Framework 4.8 has no `ProcessStartInfo.ArgumentList` and needs an ANSI-aware encoding path, while
.NET 10 has both. Keeping them apart means neither side has to carry the other's workarounds.

`src/host/lib/` holds one module per concern, mirrored across the three targets:

| Module | Concern |
|---|---|
| `preamble` | strict mode, encoding pins, repository-root discovery |
| `json` | error model, JSON serialisation, the envelope writer |
| `command` | argument parsing (positional and `name="value"`), assertions, coercion |
| `charset` | charset table, BOM policy, byte-level text model |
| `native` | P/Invoke declarations and atomic replace (Windows only; empty on POSIX) |
| `paths` | path resolution and the protected-path boundary |
| `file` | `file.*`, `file verify.*`, `file search` |
| `system` | `system.*` queries |
| `execute` | `execute.command` / `.synchronous` / `.asynchronous` |
| `task` | `task.*` |
| `environment` | `environment.*` and `environment attribute.*` |
| `service` | `service.*` |
| `permission` | `permission.*` (three read-only verbs and three delegate-only writes) and `selfcheck` |
| `window` | `window.*`, `mouse.*`, `keyboard.*`, `clipboard.*`, `wait.*`, the observation verbs |
| `dispatch` | verb resolution and the dispatch table |
| `entry` | run, emit, exit |

The shipped script is **one self-contained file** rather than dot-sourced modules at run time. On
Windows PowerShell 5.1 a sourced file without a BOM is decoded in the ANSI code page — which is
precisely the class of encoding fault this project exists to remove.

---

## Getting started

Published on npm, so a DSH profile can install it as a bundle:

```console
dsh plugin install deepseek-coordination
```

Or work from source:
```console
git clone https://github.com/eloyhere/deepseek-coordination.git
cd deepseek-coordination
```

The scripts need no build or installation; run them directly:

```powershell
# Windows
src\host\bin\dsh-os.ps1 selfcheck
src\host\bin\dsh-os.ps1 file charset "C:\path with spaces\file.txt"
src\host\bin\dsh-os.ps1 file verify charset .\file.txt utf-8
src\host\bin\dsh-os.ps1 environment attribute get PATH --scope process
```

```sh
# POSIX
src/host/bin/dsh-os.sh selfcheck
src/host/bin/dsh-os.sh file charset "./a file.txt"
```

`dsh-os.bat` is for a person typing in `cmd.exe`. Callers that can pass an argv array — the harness,
Node's `execFile`, CI — should call the `.ps1` or `.sh` **directly** and bypass `cmd.exe` entirely,
because batch-file argument handling is itself a source of quoting bugs.

### Using it from the harness

`package.json` declares `dsh.bundle.patch`, so the package installs into a DSH profile as a bundle and
inserts five rows:

| Row | Entry | What it does |
|---|---|---|
| `dsh-os` | `.` | registers the `dsh_os` tool |
| `dsh-os-settings` | `./settings` | the settings the panel edits, plus its two HTTP routes |
| `dsh-os-takeover` | `./takeover` | answers the built-in `read`/`write`/`edit`/`pwsh` through dsh-os while enabled |
| `dsh-os-permission` | `./permission` | the consent delegate, the only writer of `permission.json` |
| `dsh-os-workflow` | `./workflow` | the intent-first workflow tool and its system-prompt section |

The rows must name **different module specifiers**: `name` is resolved as a package specifier, and giving
two rows the bare package name loads the same module twice, which throws `tool "dsh_os" is already
registered` and aborts the whole entry. That is why the subpath exports exist.

| Tool | Purpose |
|---|---|
| `dsh_os` | Run one verb of the surface and return its JSON envelope verbatim |
| `os_permission_*` | Read, grant, revoke and audit durable authorization decisions |
| `workflow_plan` | Run one phase of the intent-first workflow (see [The workflow](#the-workflow)) |

One tool rather than one per verb, for three reasons: the verb table is the contract and lives in
`src/host/spec/verbs.tsv`, so no schema needs regenerating when a verb is added; an agent discovers the
whole surface with a single `verb: "selfcheck"` call; and the envelope is already the stable result
shape, so there is no second contract to drift from the script's.

```jsonc
// call shape
{ "verb": "file charset", "arguments": ["path=\"./a.txt\""], "allow": false }
{ "verb": "environment attribute get", "arguments": ["PATH"], "flags": ["--scope", "process"] }
```

The implementation is spawned by absolute path with an argv array, never through a shell string, so a
value containing spaces stays one value.

### Taking over the built-in operations

`dsh_os` is a tool an agent has to be *told* to use, and it never is: the built-in `read`/`write`/`edit`/
`pwsh` tools are right there, they overlap almost completely, and nothing in the prompt prefers one over
the other. The guarantees this project exists for therefore stay unexercised — the plugin is installed
and imperceptible.

**Takeover** removes the choice. Enable it in **Settings → DSH OS** and the built-in calls are answered
by the same machinery, whether or not the agent cooperates. Per-tool switches let you redirect only
`write`, or only `edit`, and leave the rest alone.

It works through the `tools/execute` around-dispatch waterfall: a handler returns `{ value }` without
calling `next()`, and that value is then validated against the **built-in** tool's own `output.schema`
and rendered by the **built-in** `output.render`. The model-facing text, the diff cards and the
presentation metadata are therefore unchanged; only the byte-level source of the value is.

**What it does not take over, and why:**

* `glob` and `grep`. This surface has no content-search verb at all — `file search` matches *names* — so
  `grep`'s `lineNumber`/`line` cannot be produced, and glob's ignore rules and mtime ordering have no
  equivalent. Redirecting them would silently return a different result set.
* Background commands and sandbox escalations. A background call's result is a harness job id, which
  this surface cannot mint, and `sandbox_permissions` is the harness's own approval seam.
* Relative paths. The built-in tools resolve them against the session workspace through `ctx.fs`; this
  plugin has no equivalent resolution, and guessing the process working directory would read a different
  file than the one named.

**Two properties are deliberately given up, and you should know them before enabling it:**

1. **The filesystem sandbox does not bound a redirected call.** The built-in write path goes through
   `ctx.fs`, which is where the sandbox policy and the read-before-write observation guard live. A
   redirected write runs the verb directly, so dsh-os's own protected-path check is what remains. This
   is a real reduction in defence, not a detail.
2. **The reported text and the bytes on disk can differ.** With the default *follow the target* format, a
   CRLF file stays CRLF and a BOM stays a BOM, while `value.after` is normalised LF text — which is what
   the built-in `read` would show and what the diff card compares. Choose *same as built-in* if you would
   rather the takeover change nothing about the bytes.

Every redirected call falls back to the built-in implementation on any failure, so takeover can change
how a result is produced but never whether the caller gets one. The panel's activity feed shows what was
actually taken over and why anything fell back.

**Choosing the PowerShell edition.** The default remains the 5.1 artefact (`bin/dsh-os.ps1`),
**deliberately unchanged**: a deployment that already works should not change behaviour underneath
itself because a plugin was upgraded. To select the 7.6 artefact (`bin/dsh-os7.ps1`):

* `powershellEdition: '7.6'` — plugin configuration;
* `DSH_OS_POWERSHELL_EDITION=7.6` — for a deployment that cannot edit its profile;
* `'auto'` — uses 7.6 only when both the artefact and a working `pwsh` are present.

Configuration beats the environment variable, and an explicit `scriptPath` disables the choice
entirely. `pwsh` is looked up as an explicit `DSH_OS_POWERSHELL`, then on `PATH`, then in the standard
install locations, because `pwsh` is not always on `PATH` — it is not on this repository's own
environment, while 7.6.6 is plainly installed in the standard location.

> [!IMPORTANT]
> **The bundle now loads in a live desktop session.** The plugin is installed into the active profile as
> a published npm package, and the tools it registers — `dsh_os` plus the five `os_permission_*` tools —
> are present and callable in a running session. What is still **not** proven is the part that
> `tools/verify-bundle.mjs` cannot cover: that the *harness's own loader* composes the bundle by the
> same contract the verifier checks, rather than by a shortcut that happens to work here. The
> verifier remains the evidence; the live session is corroboration.

### The workflow

Every other row in this package makes an OS call **correct**. This one makes a *request* decided before it
is executed. The failure mode it removes is a request that was never a specification: the model starts
editing files, and the divergence is discovered at review — after the tokens have been spent.

`dsh-os-workflow` registers one tool, `workflow_plan`, and one system-prompt section.

```
intake -> plan -> choose -> run -> done
```

| Phase | Action | What it establishes |
|---|---|---|
| intake | `start` | the prompt **verbatim**, plus 1–3 questions about intent *or* the assumptions being made |
| plan | `plan` | the approach and process, **at least two** alternatives with pros and cons, the criteria, and a recommendation |
| choose | `choose` | **the user's decision**, taken through `ctx.userQuestions` inside the call |
| run | `run` | execution, its steps, and — in the same call — the outcome that closes the workflow |
| — | `note` | a remark or a decision made during execution |
| — | `checkpoint` | folds the record into one file and reports a summary |
| — | `status`, `reset` | read the state; discard it and start again |

> [!IMPORTANT]
> **The tool is named `workflow_plan`, not `workflow`, and the reason is a real collision.** A host
> composition already exposes a built-in `workflow` tool — the JavaScript multi-agent orchestrator from
> `@deepseek-ai/dsh-tool-workflow`. Two tools sharing one name in one scope collide: the second
> registration aborts, or both resolve and the model is offered two unrelated tools under one name. Since
> this row's tool lives in the host plane while `workflow` is mounted per agent preset, no test in this
> repository would have caught it; it was caught by reading the live tool catalog. `_plan` also says what
> this tool is: the planning half of a workflow.

**The gates are real.** A phase whose entry has not been recorded is refused, and the refusal names the
phase that must run first. `choose` cannot be answered by the model: the question goes to the user through
the same seam `ask_user_question` uses, and nothing else can move the workflow into `run`.

**Four calls, one question.** The unavoidable path is `start` → `plan` → `choose` → `run`. It was
originally eight calls and two questions, and the difference is three deliberate fusions — each of which
removes a round-trip without removing a decision:

* **design and options are one call**, because they are one decision. This is the QOC shape (Questions,
  Options, Criteria) and the ADR shape (Context, Decision, Consequences): a decision record holds the
  alternatives it was chosen between and the criteria it was judged against. Splitting them made the
  second call re-derive the first and made the user read the same architecture twice.
* **a clear request costs zero questions.** `start` accepts `assumptions` instead of `questions`, so an
  unambiguous prompt is not interrupted — and the assumption is on record where the user can correct it,
  which is cheaper than the question it replaced. The evidence for *minimal, relevant* questions over
  interrogation is the Ask-to-Act line of work ([arXiv:2504.00907](https://arxiv.org/abs/2504.00907)).
* **a single-step execution closes in the same call it opens.** Passing `outcome` to `run` finishes the
  workflow; only multi-step work needs a second call.

**The compression is the other half.** A plan narrated into the conversation is re-sent with every later
step, which is what makes a short task expensive. So it never enters the conversation: each phase writes a
real document and returns a line — phase, summary, file path, one next call. `tests/workflow.test.mjs`
measures it and holds every phase envelope under 2000 characters; in the current build the four calls of a
full workflow total about 1.8 kB, roughly 500 tokens, for a plan document measured in kilobytes. This shape
is measured, not stylistic: pruning plus summarisation improves completion while cutting tokens and runtime
([Less Context, Better Agents](https://export.arxiv.org/pdf/2608.16370)), and a planner/executor split
matches interleaved reasoning at a fraction of the token cost
([Plan Once, Ground Locally](https://zenodo.org/records/22904595)).

**Where the cost goes**, stated as complexity because that is what it is:

| Path | Cost |
|---|---|
| reading state | once per workflow call, cached on the file's mtime — and **never** on a model step, because the prompt section reads no state at all |
| a phase transition | one atomic state write; the first version wrote it three times per action |
| a note during execution | one `appendFileSync` append, O(1), bounded by compaction — not the read-push-rewrite that is O(n²) over a workflow |
| the prompt section | a **constant**: no read, no lookup, no formatting, identical at every phase of every workflow |

### The KV cache effect, which is why the prompt section is a constant

The section this row registers into the system prompt is a **constant string**. That is not tidiness; it is
the design. The evidence is measured, and it is brutal:

| Change to a 7,384-token request | Cache hit | Hit rate |
|---|---:|---:|
| nothing | 7,296 | **98.8%** |
| append a message at the end | 7,296 | **98.7%** |
| add one line at the **end of the system prompt** | 0 | **0.0%** |
| insert one line at the **start of the system prompt** | 0 | **0.0%** |
| append a tool schema | 1,408 | 18.3% |
| change one character of the last tool description | 1,280 | 17.3% |
| swap the order of two tools | 0 | **0.0%** |

Ten variants, measured on the live DeepSeek endpoint
([prefix-stability chapter](https://github.com/diguike/book-deepseek-harness/blob/main/book/11-prefix-stability.md)).
The rule behind them is the provider's own: a cache hit requires a request to **fully match a persisted
cache prefix unit**, and the system prompt sits before the tool catalog and the entire history
([Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)).

The harness has already paid for this lesson once. The sandbox policy used to live in the system prompt,
and a single permission switch dropped cache reads from **~14,700 tokens to 256**; the fix was to move the
changing fact out of the prompt into the message sequence
([DSH agent note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md)).

**The first version of this row made exactly that mistake.** It rendered the current phase into the section,
so a four-call workflow re-wrote the system prompt three times and paid a full-prefix miss each time. The
fix is structural, not cosmetic:

* the section is a constant, so this row's **cache effect is `prefix-stable`**: zero prompt changes per
  workflow, asserted by `tests/workflow.test.mjs` against the registered text at every phase;
* the phase and the **one next call** travel in the `workflow_plan` tool's own result instead — appended history,
  which the measurement above prices at 98.7%;
* a step taken out of order is refused, and the refusal names the phase to record first, so the model can
  recover from a stale plan without the prompt having told it anything;
* the tool **description** carries the discovery text. It lives in the tool catalog: inside the cached
  prefix, sent once, and unchanged for the life of the session.

> [!IMPORTANT]
> **The consequence a reader should draw for their own plugins.** Anything that changes per step — the
> time, the current directory, a branch, a permission, a phase — must not be written into a prompt section.
> This harness gives that content its own path: register it with `ctx.systemPrompt.context()` and it is
> delivered as an appended user message, re-projected only when it changes. A section is for text that is
> stable for the session.

**Where the state lives.** `$DSH_HOME/dsh-os/workflows/<session>/`, beside the settings document and for
the same reason: the package directory is replaced on upgrade, and the workspace belongs to the user.
`state.json` is the compact record; every other file is the detail. A finished workflow is archived rather
than overwritten, so the next one starts clean and the last one stays readable.

```
state.json          the compact record: phase, intent, decisions, steps, artifact paths
journal.jsonl       append-only: notes and steps, bounded, folded in by a checkpoint
01-intent.md        the prompt verbatim, then the questions and answers (or the assumptions)
02-plan.md          approach and process, alternatives with pros and cons, criteria, the decision
03-execution.md     chosen option, goal, steps, files in scope, constraints
04-outcome.md       what was delivered, and any step left open
05-checkpoint.md    the fold: everything decided so far, written when a compaction is wanted
```

**What is configured.** `workflowRoot` moves the directory; `autoCompact` (default `true`) controls
whether a checkpoint reports the compaction the engine may perform, and `maxCheckpoints` bounds it. The
structural half — detail to disk, one line back — is **not** configurable, because it is the reason the
feature saves anything.

> [!WARNING]
> **This row asks the user questions, so the deployment must be able to answer them.** It injects
> `userQuestions`; a host without it registers nothing rather than registering a tool that would fail on
> its second call. Two calls block on a human: `start` when questions are given, and `choose` always.

> [!NOTE]
> **What this row does not do: it does not invoke the engine's compaction service.** `ctx.compaction`
> exists, and calling it from here would mean constructing a session-shaped context whose contract is not
> published — a guess dressed up as a feature. What the plugin does instead is deterministic and
> inspectable: the detail leaves the conversation for a file, and `checkpoint` records the boundary where a
> compaction is safe. That is why the compression is measurable by `tests/workflow.test.mjs` rather than
> merely asserted.

---

## JSON contract

Every call writes **exactly one** JSON envelope to stdout, UTF-8 **without** a BOM, terminated by a
single LF.

```jsonc
// success
{ "ok": true,  "verb": "file.charset", "result": { "charset": "utf-8", "bom": false, "eol": "crlf" },
  "meta": { "durationMs": 3, "platform": "win32", "shell": "pwsh" } }

// failure — still exactly one envelope, still on stdout
{ "ok": false, "verb": "file.charset",
  "error": { "code": "E_NOT_A_FILE", "message": "…", "hint": "…" },
  "meta": { "durationMs": 2, "platform": "win32", "shell": "pwsh" } }
```

* `error.hint` appears only when there really is an actionable suggestion.
* `--pretty` indents the output; `--quiet` emits only `result` (or only `error`).
* **stderr carries human-readable diagnostics only and never takes part in parsing.** On Windows,
  setting `DSH_OS_TRACE=1` puts a failure trace on stderr.

### `error.code` is authoritative

Exit codes are a coarse class, so that a shell can branch cheaply. **Never parse `error.message`.**

| Exit code | Class | Representative codes |
|---|---|---|
| 0 | success | — |
| 1 | usage | `E_USAGE` |
| 2 | type / value | `E_TYPE`, `E_CHARSET_UNKNOWN`, `E_BOUNDARY`, `E_RANGE`, `E_WINDOW_AMBIGUOUS` |
| 3 | authorization | `E_PERMISSION`, `E_ELEVATION_REQUIRED`, `E_PERMISSION_PROTECTED_PATH`, `E_PERMISSION_DELEGATE_ONLY`, `E_PERMISSION_FILE_UNTRUSTED`, `E_PERMISSION_DENIED_BY_RULE`, `E_PERMISSION_NO_ANSWERER` |
| 4 | platform unsupported | `E_NOT_SUPPORTED`, `E_NO_DISPLAY`, `E_ACCESSIBILITY_DENIED`, `E_ACCESSIBILITY_UNAVAILABLE` |
| 5 | target / encoding / IO | `E_NOT_FOUND`, `E_NOT_A_FILE`, `E_EXISTS`, `E_BINARY_CONTENT`, `E_CHARSET_MISMATCH`, `E_TRUNCATED`, `E_PARTIAL_WRITE`, `E_WINDOW_NOT_FOUND`, `E_IO` |
| 6 | timeout | `E_TIMEOUT` |
| 7 | internal / aborted | `E_INTERNAL`, `E_ABORTED` |

The Windows implementation registers **36** error codes; the POSIX implementation groups them with
`case`. The two agree on the class of every **named** code, but not on unnamed ones: Windows returns
7, POSIX returns 5.

### Calling convention

Values are always separate argv elements and are **never** spliced into a shell string. The two
spellings below are equivalent, but the same parameter must not be given twice in different forms:

```sh
# positional form
dsh-os file create "./a.txt" "123" "utf-8-bom"

# named form — order is free; the effective order comes from the verb table's parameter list
dsh-os file create content="123" charset="utf-8-bom" path="./a.txt"
```

`E_USAGE` rejects: an unknown flag, an empty `--`, a value-taking flag with no value, a repeated named
argument, an unknown name, the same parameter given both positionally and by name, and surplus
positional arguments. Read operations are never asked for `--allow`; write operations always are.

A verb is one to three tokens deep — `selfcheck`, `file charset`, `file verify charset` — and the
parser consumes the next token only when extending the verb is genuinely known to be possible, so a
path argument that happens to begin with a word is not swallowed into the verb.

### Encoding, BOM and line endings

`src/host/spec/charsets.tsv` defines 15 canonical encoding names, each with aliases, a .NET code page,
an `iconv` name and BOM bytes:

`utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`, `utf-32le`, `utf-32be`, `gbk`, `gb18030`, `big5`,
`shift_jis`, `euc-jp`, `euc-kr`, `latin1`, `windows-1252`, `ascii`.

Detection sniffs the BOM first, then tries **strict** UTF-8, then GBK, then latin1. A read strips the
BOM and normalises `\r\n` to `\n` for output; **every write restores the file's original BOM presence
and line-ending convention.** Offsets are byte offsets in the half-open range `[start, end)` and must
fall on a character boundary, otherwise the call fails with `E_BOUNDARY` rather than cutting a
character in half.

A file is judged binary when a NUL byte appears in the first 8 KiB of the payload, which reports
`E_BINARY_CONTENT` instead of returning mojibake.

---

## The verb surface

`src/host/spec/verbs.tsv` **declares 86 verbs** and is the single source of truth. Some are declared
but not implemented; before relying on one, read
[What is actually available](#what-is-actually-available).

| Group | Verbs |
|---|---|
| `file` | `create` `charset` `encode` `length` `information` `list` `delete` `move` `copy` `mkdir` `append` `insert` `view` `search` |
| `file verify` | `charset` `encoding` `completion` |
| `execute` | `command` `synchronous` `asynchronous` `query` `kill` |
| `system` | `brand` `cpu` `gpu` `version` `info` |
| `task` | `list` `query` `show` `kill` `launch` |
| `service` | `list` `query` `start` `stop` `restart` |
| `environment` | `list` `get` `add` `set` `delete` |
| `environment attribute` | `list` `get` `add` `set` `delete` |
| `permission` | `query` `list` `audit` `grant` `revoke` `acl init` |
| `window` | `find` `list` `active` `close` `top` `bottom` `move` `resize` `minimize` `maximize` `restore` |
| `mouse` | `click` `context` `over` `wheel` `down` `up` `cursor` |
| `keyboard` | `down` `up` `press` `combination` `type` `codes` |
| `clipboard` | `read` `write` `paste` |
| `wait` | `window` `ms` |
| observation | `screenshot` `text` `structure` |
| self-check | `selfcheck` |

A few design points worth knowing before you start:

* **`file verify.*` asserts; it does not throw.** `file verify charset` returns `match: false`
  alongside the observed value, so a caller can tell "the file is wrong" from "I asked wrongly".
  `file verify completion` returns `complete: null` when no expectation was given — deliberately not
  `false`.
* **`file insert`'s `--charset` is a flag, not a positional.** Inserted between `content` and `offset`
  it would **silently displace `offset`**.
* **`file.delete` goes to the recycle bin on Windows by default.** On POSIX it needs `trash-put`,
  otherwise it reports `E_NOT_SUPPORTED` — it does **not** silently delete for real.
* **`environment` has two levels.** A variable holds one string; an **attribute** (PATH, PATHEXT, LIB,
  INCLUDE) holds an ordered list. A write returns `visibleToRunningProcesses`, because a `user` or
  `machine` level write is invisible to processes that are already running.
* **`keyboard type` is Unicode-first.** Non-ASCII text goes through a clipboard paste, because
  `KEYEVENTF_UNICODE` is unreliable when an input method is active.

---

## Dangerous permissions

This chapter is required reading before granting any permission. The layer is deliberately capable,
and the guarantees it offers are narrower than the feature list suggests.

### What a fully authorized agent can do

| Capability | Verbs involved | Authorization |
|---|---|---|
| **Read the contents of your screen** | `screenshot`, `text`, `structure` | **read-only, never prompts** |
| **Read and write your clipboard** | `clipboard.read`, `clipboard.write` | `read` never prompts; `write` needs `--allow` |
| **Synthesise input** — clicks, drags, typing, chords | `mouse.*`, `keyboard.*` | `--allow` |
| **Manipulate your windows** — move, resize, close, raise | `window.*` | `--allow` |
| **Start and kill processes** | `task.kill`, `execute.*` | `--allow` |
| **Run an arbitrary command line** | `execute.synchronous`, `execute.asynchronous` | `--allow` |
| **Delete, move and overwrite files** | `file.delete`, `file.move`, `file.copy` | `--allow` |
| **Persistently modify your environment variables** | `environment.set`, `.add`, `.delete`, `attribute.*` | `--allow` |
| **Control system services** (declared, not implemented) | `service.start`, `.stop`, `.restart` | `--allow` + elevation |
| **Read process and system inventories** | `task.*`, `system.*` | **read-only, never prompts** |

Put plainly: `mouse.*` and `keyboard.*` mean an authorized agent can operate **any** program you can
operate, with your rights. And because it can read the screen, it can also watch what it has just
done. Inside the desktop there is no sandbox.

### How authorization actually works

**Layer B — structural enforcement (always on, cross-platform).**

* Every mutating verb requires `--allow`. Without it the call returns `E_PERMISSION` and **nothing
  happens**.
* **`permission.json` has three write verbs, but they go through the delegate and not through the
  script's own authorization.** The table declares `permission grant`, `permission revoke` and
  `permission acl.init` (all class `W`), while `permission query`, `permission list` and
  `permission audit` are read-only. The flags of `grant` and `revoke` accept only `delegate` (besides
  `allow`), so they can be called **only by the consent delegate**; the script itself cannot create a
  persistent authorization with `--allow`, and reports `E_PERMISSION_DELEGATE_ONLY` when no delegate
  is present.
* A hard **protected-path boundary** rejects any modification of the files that decide what this layer
  may do: `permission.json` (and `.bak`), `src/host/command.txt`, the **four** `src/host/bin/dsh-os.*`
  entry points (`.ps1`, `dsh-os7.ps1`, `.sh`, `.bat`), `src/host/spec/verbs.tsv` and
  `src/host/spec/charsets.tsv`, plus any same-named temporary staged beside one of them. A violation
  reports `E_PERMISSION_PROTECTED_PATH` with no side effect. Reads remain allowed so that you can
  review the rules. The POSIX list has eight entries — the same list **without `dsh-os7.ps1`**.
* The check runs on the **resolved and normalised** path, compared segment by segment rather than by
  regular expression, because `..`, an 8.3 short name or a trailing dot all walk around a regex.
  `file.move` and `file.copy` check **both ends**, since moving a protected file is also a way of
  destroying it.

**Layer A — kernel ACL (Windows, explicitly enabled, requires elevation).**

`permission acl init` appends an explicit **DENY** for `Everyone` (`S-1-1-0`) to the DACL of
`permission.json`, covering `FILE_GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER`. It is idempotent,
and reports `E_ELEVATION_REQUIRED` when it cannot act rather than failing vaguely.

`selfcheck` reports `aclEnforced` by **reading the file's real security descriptor** and walking the
DACL. An earlier version read a flag from a state file, which claimed an enforcement that was not in
effect; that implementation has been deleted. `aclReason` explains a `false`, so the result can be
acted on rather than merely wondered at.

### Four limitations that must be stated honestly

These are documented in `src/host/docs/permission-model.md` and repeated here because they change what
the guarantees above mean.

1. **Persistent rules are recorded but not enforced at the verb layer.** The rules in `permission.json`
   are matched by the consent delegate and its `os_permission_query` tool; the script reads the file
   for **display only** (`permission list/query/audit`). No verb consults a rule before acting: the
   real gates are `--allow`, the protected-path check, and (if enabled) layer A. A `deny-always` rule
   does **not** currently stop a verb that arrives with `--allow`.
2. **`E_PERMISSION_DENIED_BY_RULE` is registered but never thrown.** It is in the error table and maps
   to exit code 3, but no code path produces it — consistent with point 1.
3. **The in-script rule reader is not deny-first.** The script's `permission query` takes the **first**
   matching rule regardless of whether it allows or denies. The delegate implements deny-first
   correctly and has test coverage, so the two readers can disagree, and the script side is the weaker
   one.
4. **`execute` is a way around the protected-path boundary.** That boundary guards `file.*` and
   `environment.*`. It cannot constrain a child process: `execute.synchronous` hands the command line
   to `cmd.exe /d /s /c` on Windows and to `sh -c` on POSIX, so the program it starts can write
   anything its own rights permit, `permission.json` included. Only layer A prevents that. When
   `aclEnforced: false`, layer B cannot.

The consent delegate has one more **design gap** worth stating plainly: it registers five tools
(`os_permission_query`, `os_permission_grant`, `os_permission_revoke`, `os_permission_list`,
`os_permission_audit`), but it does **not** register an `approval/request` answerer. Its own design
document says it should, and that `permission grant` **must** go through a user-confirmed prompt. As
the code stands, the enforcement is a **tool description** telling the model to call
`os_permission_grant` only after the user has chosen; the code does not verify that a prompt ever
happened. Treat the delegate as trusted infrastructure, not as a check on the agent.

Two further points about layer A: it requires the harness and the delegate to run as **different
identities** (otherwise it degrades to layer B), and its POSIX equivalent is weaker — a mode change
that the same user can undo. `permission acl init` says as much in its own result.

### Reviewing what has been granted

```sh
dsh-os permission list                 # rules, defaults, and the MEASURED aclEnforced
dsh-os permission query file.delete "R:\project\**"
dsh-os permission audit --limit 50     # the append-only tail; the delegate trims to 200 entries
```

If `permission.json`'s `updatedBy` is not `consent-delegate`, the file is treated as **untrusted**: its
rules are ignored, everything falls back to the defaults, and the reason is reported. A malicious rule
hand-edited into that file therefore does **not** take effect — it is ignored, and you are told.

To **create** a persistent decision you must use the delegate's tools. A wildcard target
(`target.value === "*"`) is refused unless `acknowledgeBroad: true` is passed explicitly, because
"agree to everything, permanently" has to be a separate decision and not the side effect of one click.

---

## What is actually available

Method: the platform dispatch tables are extracted and compared against the declared verb table, entry
by entry. An unimplemented verb **never fails silently**: it returns a named `E_NOT_SUPPORTED`
envelope.

| Platform | Declared | Implemented |
|---|---|---|
| Windows PowerShell 5.1 (`src/host/bin/dsh-os.ps1`) | 86 | **82** |
| PowerShell 7.6 (`src/host/bin/dsh-os7.ps1`) | 86 | **82** |
| POSIX (`src/host/bin/dsh-os.sh`) | 86 | **61** |

The two PowerShell runtimes have **identical** implemented sets, established by comparing the two
dispatch tables entry by entry rather than by eye.

### Windows (5.1 and 7.6 alike)

**Implemented (82):** every `file.*` (including `file.encode`); `file verify.*`; `file.search`; all
five `execute` verbs (`command`, `synchronous`, `asynchronous`, `query`, `kill`); `system.*`; all of
`task.*` (including `task.launch`); `service.list/query`; the whole `environment` surface (including
`attribute.*`); the whole `permission` surface (including `grant`, `revoke`, `acl.init`); the whole
`window` surface; `screenshot`; `clipboard.read/write`; `wait.window/ms`; the whole `mouse` and
`keyboard` surfaces; `text`; `structure`; `selfcheck`.

**Not implemented (4):** `clipboard.paste`, `service.start`, `service.stop`, `service.restart`.

### POSIX

**Implemented (61):** the whole `file` surface except `file.encode`; `file verify.*`; `file.search`;
all five `execute` verbs (including `execute.command`, which the Windows side also has); `system.*`;
`task.list`/`query`/`show`/`kill` (**not `task.launch`**); the whole `environment` variable level
(including persistent writes) and all five `attribute.*` verbs; the whole `permission` surface;
`wait.ms`; the whole `mouse` surface (7 verbs) and `keyboard` surface (6 verbs); `selfcheck`.

Of those 61, **13 need an X display** (the 7 `mouse.*` and 6 `keyboard.*`); the other 48 do not.

**Not implemented (25):** `file.encode`; all eleven `window.*`; `screenshot`, `text`, `structure`;
`clipboard.read`, `clipboard.write`, `clipboard.paste`; `wait.window`; `task.launch`; and all five
`service.*` (`list`, `query`, `start`, `stop`, `restart`). These fall through the dispatch table's
default branch to a **typed** `E_NOT_SUPPORTED`; they are not silently absent.

> [!NOTE]
> POSIX has no kernel API for persisting a variable, so `environment add/set/delete --scope user`
> edits `${HOME}/.profile` through a **managed block** delimited by
> `# >>> dsh-os managed environment >>>` and `# <<< dsh-os managed environment <<<`. Every change
> regenerates everything between the markers, so these operations are idempotent and a user can undo
> the lot by deleting the block. Writing bare assignments into the file directly would append
> duplicates on the second call and could not be undone. `--scope machine` is unavailable and reports
> `E_NOT_SUPPORTED`.
>
> `environment attribute add/set/delete` are **process scope only**; a persistent scope is refused
> with `E_NOT_SUPPORTED`. That is deliberate: POSIX has no kernel API for a list-valued variable, so
> persisting one means rewriting a shell startup file, and a wrongly reconstructed `PATH` there can
> make a machine's shells unusable.

> [!IMPORTANT]
> **On POSIX only `mouse.*` (7) and `keyboard.*` (6) need an X display.** With no `DISPLAY` they return
> a **typed** `E_NO_DISPLAY`; with a display but no `xdotool` they return `E_NOT_SUPPORTED` naming the
> missing tool.
>
> **`wait.ms` does not need one** — it is a sleep, so it can be accepted in full on this machine. The
> five `environment attribute.*` verbs do not either (they act on environment variables, not on the
> desktop).
>
> On this machine (no `DISPLAY`, no `xdotool`) the golden suite therefore asserts them as
> `E_NO_DISPLAY`: **that asserts the absence path, not that they work.** The injection path is covered
> by `tests/smoke-desktop-sh.sh` with stand-in tools; see [Tests](#tests).

> [!NOTE]
> What remains **structurally absent** on POSIX is `window.*` (11), `screenshot`, `text`, `structure`,
> `clipboard.*`, `wait.window` and all of `service.*`. `native.sh` (515 bytes) and `service.sh`
> (333 bytes) are deliberate empty stubs whose headers explain why: their POSIX counterparts are
> external programs (`wmctrl`, `import`, `xclip`, `scrot`) rather than linkable libraries.
>
> **`window.sh` is no longer a stub** (26 KB): it now implements `wait.ms`, all of `mouse.*` and all of
> `keyboard.*`, driving X11 through `xdotool` and checking for the display and the tools before
> touching anything. The remaining desktop verbs still return `E_NOT_SUPPORTED` from the dispatch
> table's default branch.

### The two implementations are not equivalent

Same verb names and the same calling convention, but behaviour differs in several places. The
important ones:

| Aspect | Windows | POSIX |
|---|---|---|
| `execute.command` | implemented | implemented (real argv, no shell) |
| `file.encode` | implemented | not implemented |
| `file.delete` default | recycle bin | fails without `trash-put` |
| `file.search` literal match | case-insensitive | case-sensitive |
| `file.view` character boundaries | enforced (`E_BOUNDARY`) | **not checked at all** |
| `file.view --max-bytes` | honoured | ignored (`truncated` is always `false`) |
| files over 32 MiB | `E_TRUNCATED` | no limit |
| `--eol crlf` on create/append | exact bytes | adds one extra trailing CRLF |
| appending to a mixed-EOL file | existing endings untouched | the whole file is renormalised |
| a character that cannot be represented | silently written as `?` | `E_ENCODING_INVALID` |
| `--pretty` / `--quiet` | honoured | accepted and ignored |
| `--` | `E_USAGE` | end-of-options marker |
| protected-path comparison | case-insensitive, normalised | case-sensitive, as given |
| unregistered error code | exit code 7 | exit code 5 |
| `meta.durationMs` on failure | the real duration | `0` |

Measured here, because prose is not evidence: on POSIX,
`file view <utf-8 file> utf-8 0 2` returns `ok` with `"text":"\ufffd"` — an offset of 2 lands inside
the first three-byte character and the character is split, where Windows fails the same call with
`E_BOUNDARY`.

`file.search`'s `--type` is a latent defect on both implementations: the code reads it, but it is not
registered as a known flag, so behaviour depends on the parser's fallback path.

---

## Installation status and known defects

Stated plainly, so that nobody is caught out.

### The bundle's load path is now covered by three verifiers

This section previously recorded that the loader's end-to-end path was **unverified**. That gap has
been closed by three verifiers, and they found one real defect:

| Verifier | What it proves | Cases |
|---|---|---|
| `tools/verify-bundle.mjs` | the loader's **resolution** contract: the manifest header, the patch file, every row resolving from a profile-style `node_modules`, every resolved module exporting the Cordis shape the loader calls (`apply`/`inject`/`name`), the two rows resolving to **different** modules (a shared specifier registers the same tool twice and aborts the whole entry), and the version gate | 10 |
| `tools/verify-plugin-load.mjs` | the real `apply()` path: the host plugin registers `dsh_os` with a parameters schema whose **root type is `object`**, the permission plugin registers its five tools, and **the registered handler really does spawn the script** and return a real envelope (`selfcheck` → ok, `verbCount` 86); a mutating verb without `allow` is refused with a typed `E_PERMISSION` rather than throwing. It also covers the workflow row, whose failure would otherwise be silent: the tool and its prompt section **are** registered, and `start → plan → choose → run` runs through the real handler with its gates intact | 30 |
| `tools/verify-editions.mjs` | edition selection: the default is still PowerShell 5.1; `powershellEdition: '7.6'` and `DSH_OS_POWERSHELL_EDITION` select the 7.6 artefact; `'auto'` uses 7.6 only when the artefact and a working `pwsh` are present **together**; configuration beats the environment; an explicit `scriptPath` disables the choice. `-ExecutionPolicy` is passed only to the 5.1 executable | 14 |

The bundle verifier links the package into a throwaway profile sandbox by junction, so resolution
happens exactly as it would in a profile, and the **active profile is never written to**.

The defect it found: `bin/dsh-os7.ps1` was previously **unreachable from the plugin** — it existed,
built and tested, but `resolveInvocation` only ever looked for `dsh-os.ps1`, so all the 7.6 work was
dead code from the plugin's point of view. It is now selectable, and **the default is unchanged**
(still 5.1), because a deployment that already works should not change behaviour merely because a
plugin was upgraded.

**Now observed live, though not through this verifier:** the package has since been installed into an
active desktop profile, and the six registered tools (`dsh_os` and the five `os_permission_*` tools)
are present and callable in a running session. That corroborates the verifier; it does not replace it,
because it does not establish that the loader composed the bundle by the same contract the verifier
checks.

### The Windows golden suite's order dependency is fixed

This was recorded as `passed: 47 failed: 1` on a clean checkout, the failing case being
`parser/one-two-three-token-verbs`, which asserted `file length` against a fixture directory created
by a **later** case.

That defect is **fixed**: the parser case in `tests/golden.ps1` now creates its own fixture
(`$fixtureDir = Join-Path $sandbox 'parser\verify'`, then `New-Item` and `Set-Content`) and asserts
against it. The current measurement is **50 passed, 0 failed**.

### Two real POSIX defects found by `tests/smoke-desktop-sh.sh`

Neither was visible after writing, and not by review either — because this machine has no `DISPLAY`,
they normally showed up only as "an `E_NO_DISPLAY` either way". Opening the injection path with
stand-in tools exposed both:

1. **Validation ran after injection.** `mouse click 10 20 --count abc` **returned an error, but the
   pointer had already been moved** — a call that reports failure had changed the state of the
   machine. The Windows side validates every argument *before* injecting; the POSIX side now matches
   it. (The same held for `mouse over abc 20`.)

2. **A `fail` inside `$(...)` did not stop the verb.** The coordinate validator called `fail`, but the
   caller wrote `x="$(window_int_arg ...)"`, so the `exit` ended only the subshell: the verb continued
   with an empty value and **injected anyway** — `mouse over abc 20` **moved the pointer and returned
   `ok`**. The three validators that reject input now **assign a variable** (`WINDOW_INT`,
   `WINDOW_BUTTON`, `WINDOW_KEY`) which is read in the **caller's own shell**.

   **This trap was already documented in this repository's `environment` module** (the comment on
   `env_resolve_scope` explains precisely why it assigns rather than prints), and it was still
   repeated here. Both defects are now pinned by three assertions each: invalid input must be
   **rejected with nothing injected**.

### Other gaps

* **`tests/conformance.ps1` did not exist**, although the header of `spec/verbs.tsv` claimed it did and
  that it checked consistency with `command.txt`. **The file now exists** (see
  [Conformance of the two tables](#conformance-of-the-two-tables)), so the header's claim is now a
  fact. A comment naming a guard that is not there is worse than no comment, because it is read as a
  guarantee.
* **The consent delegate never registers an approval answerer**, as described above.
* **The delegate reports `aclEnforced: false` unconditionally** in its `query` result instead of
  measuring the ACL as the script does, so it **under-reports** protection when layer A is on.
* **This section previously recorded that `--shell`, `--env`, `--stdin` and `--background` were
  accepted but never read, and that `--encoding` on Windows built a value that was never applied. Both
  records were out of date, and both had been real defects; they are now fixed.**
  * **Windows:** `--shell`, `--env`, `--stdin` and `--background` really are read (there are branches
    for them in `execute.ps1`). `--encoding` genuinely **was inert** — it built `$enc` and never used
    it, and `StandardOutputEncoding` appeared nowhere in the module set, so child output was always
    decoded with the runtime default. It is now wired to the output and error streams. **Measured:**
    with a child emitting the GBK bytes `D6 D0 CE C4`, the default decoding gives `����` (four
    replacement characters) and `--encoding gbk` gives `中文` (two characters).
  * **POSIX:** these flags genuinely were never read. They are now **explicitly refused** —
    `--shell`, `--env`, `--stdin`, `--background` and `--encoding` all return `E_NOT_SUPPORTED` (exit
    code 4) instead of being silently ignored. That is what this project's own contract requires: **an
    unavailable capability must be an explicit error, never an empty success**, and a caller that
    passed `--stdin`, had nothing fed in, and received a success envelope has been misled.
* **Some declared error codes really are unreachable.** A full-text search of both implementations
  confirms **zero occurrences** of `E_ENCODING_INVALID` (for `file.encode`), `E_IS_A_DIR` (for
  `file.delete`) and `E_ABORTED`. By contrast `E_CHARSET_MISMATCH` (3 sites), `E_BINARY_CONTENT` and
  `E_TRUNCATED` all have real throw sites — so the table is not uniformly unreliable, but those three
  should be read as unimplemented intentions rather than dependable return codes.
* **This section previously recorded that "`E_TIMEOUT` is never thrown by either side" — that record
  was out of date and wrong.** It is thrown in `execute.ps1` (an `execute command` timeout) and in
  `window.ps1` (a `wait window` timeout). Measured:
  `execute command cmd.exe /c ping -n 10 127.0.0.1 --timeout 300 --allow` returns
  `{"ok":false,...,"code":"E_TIMEOUT",...,"hint":"captured so far: stdout=86 bytes, stderr=0 bytes"}`
  with exit code **6**. POSIX has `E_TIMEOUT` too (`json.sh` maps it to exit code 6).
* **`src/client/` is an untouched Vite scaffold.** It is not wired to the host: `index.html` refers to
  `./src/main.ts` while the real file is `./src/client/main.ts`, and there is no `node_modules`, so
  `npm run build` and `npm run dev` are currently meaningless.
* **`git` is not a required dependency, but it is not present in every target environment either**, so
  no acceptance step depends on it. (The plugin's *installation* path does: the package manager
  resolves the repository with `git ls-remote`, so a machine where the harness cannot find `git` on
  `PATH` cannot install the bundle.)
* **PowerShell 7.6 is exercised, but not across the whole surface.** The 7.6 artefact definitely runs:
  driving the plugin's real `resolveInvocation` path with `DSH_OS_POWERSHELL_EDITION=7.6` selects
  `bin/dsh-os7.ps1` and the runtime that answers is **PowerShell 7.6.6**, while the default stays on
  5.1.19041.3031 — that is what `tools/verify-editions.mjs` asserts and what the 14 cases measured here
  confirm. What has *not* been done is a run of every verb against `dsh-os7.ps1`; its fidelity as a port
  rests on the identical 82-verb dispatch sets, a per-module function-name comparison and the window
  group's golden cases. That is a real gap in the evidence, not a claim of full parity.

### What is not proven

* That the loader composes the bundle **by the contract `tools/verify-bundle.mjs` checks**, rather than
  by a path that happens to work on this machine. The weaker claim — that `dsh_os` and the five
  `os_permission_*` tools appear and are callable in an active session — has since been observed.
* Complete verb parity between the two platforms — in neither direction.
* The enforcement effect of layer A on a machine where the harness and the delegate share one identity
  — by construction that case degrades to layer B.
* Anything about macOS or non-Linux POSIX beyond code review: the POSIX suites are written for a GNU
  userland and were not run anywhere else.

---

## Tests

```console
npm run test:all        # runs everything below, in order
```

`test:all` chains `test:conformance`, `test:encoding`, `test` (the Windows golden suite),
`test:plugin`, `test:permission`, `test:bundle` (`tools/verify-bundle.mjs`), `test:load`
(`tools/verify-plugin-load.mjs` then `tools/verify-editions.mjs`) and `test:desktop`
(`bash tests/smoke-desktop-sh.sh`).

| Suite | Command | Cases | Measured result |
|---|---|---|---|
| Table conformance | `powershell -File tests/conformance.ps1` | 5 | **5 passed, 0 failed** |
| Encoding contracts | `powershell -File tests/encoding.ps1` | 32 build modules | **all contracts hold** |
| Windows golden | `powershell -File tests/golden.ps1` | 50 | **50 passed, 0 failed** |
| POSIX golden | `bash tests/golden-sh.sh` | 116 | **116 passed, 0 failed** |
| POSIX desktop injection | `bash tests/smoke-desktop-sh.sh` | 52 | **52 passed, 0 failed** |
| Plugin | `node tests/plugin.test.mjs` | 13 | **13 passed, 0 failed** |
| Takeover interceptions | `node tests/takeover.test.mjs` | 41 | **41 passed, 0 failed** |
| Permission delegate | `node tests/permission.test.mjs` | 18 | **18 passed, 0 failed** |
| Workflow | `node tests/workflow.test.mjs` | 30 | **30 passed, 0 failed** |
| Bundle resolution | `node tools/verify-bundle.mjs` | 16 | **16 passed, 0 failed** |
| Package completeness | `node tools/verify-package.mjs` | 20 | **20 passed, 0 failed** |
| Plugin load | `node tools/verify-plugin-load.mjs` | 30 | **30 passed, 0 failed** |
| Edition selection | `node tools/verify-editions.mjs` | 14 | **14 passed, 0 failed** |
| Build drift | `powershell -File tools/build.ps1 -Check` | 3 artefacts | **no drift** |

> [!NOTE]
> **`test:desktop` needs `bash`, and this machine has none.** `npm run test:all` therefore ends with
> `'bash' is not recognized` on a Windows host without Git Bash or WSL on `PATH`. That is an environment
> gap in the runner, not a failing assertion: every suite above it ran and passed in the same invocation.
> The POSIX suites remain unverified here for the same reason they always were — they need a POSIX host.

### Conformance of the two tables

The header of `spec/verbs.tsv` had always claimed that "`tests/conformance.ps1` asserts the two
agree", while that file **did not exist** — it has now been **added**, so the claim is a fact. The
guard resolves each line of `command.txt` to a verb by the **longest word-prefix that names a known
verb** (so `file verify charset path charset` resolves to `file.verify.charset` and not to a
nonexistent `file.verify`), then checks that the two tables hold each other's verbs, that the counts
are equal, that the R/W class agrees, and that the positional names agree in order.

**Writing it found five real inconsistencies**, and all but one of them were in `command.txt` (which is
the authoritative contract):

| Verb | Was declared | What the implementation actually does |
|---|---|---|
| `file.append` | `path content charset` | charset is an **optional** third positional; the old form implied it was required |
| `file.insert` | `path content charset offset` | charset is `--charset` and **deliberately not** a positional — as a positional, omitting it would silently shift `offset` |
| `wait.ms` | no positionals | takes `ms` |
| `keyboard.combination` | two lines, `... down a b c d` / `... up a b c d` | it is **one** verb with a `phase` positional; the two-line form read as two verbs |
| `execute.command` | tsv wrote `command\|arguments` | the entire positional list is argv; there is no separate `command` |

Four were corrected in `command.txt`, and `verbs.tsv`'s `execute.command` row became `arguments...`.
**Nothing about the running surface changed** — only what the two documents say — which is exactly
what such a conformance guard is for.

`tests/encoding.ps1` guards the contracts that make everything else meaningful: the `.ps1` artefacts
carry a BOM, the `.sh` artefacts do not, line endings follow `.gitattributes`, `command.txt` and the
`.tsv` tables stay pure ASCII + LF, and **stdout never carries a BOM**.

**The "four encoding violations" recorded earlier are gone, and this is not a relaxation of the
guard.** The rule itself never moved; its **scope** did. It used to require **every** `*.ps1` under
`src/host/lib/` to be BOM-free and ASCII-only, and two of those files are the standalone `git.ps1`
scripts — never concatenated into anything, and carrying a BOM because that is what makes their
Chinese prompt literals parse under Windows PowerShell 5.1. Applying that rule to files the build
never reads was a **false positive**. The guard now checks only the **32 modules `tools/build.ps1`
actually concatenates**, and **prints which files it skipped**, so the narrowing is visible rather
than silent.

> [!NOTE]
> **Neither the "116 passed" nor the "52 passed" for the POSIX desktop verbs is evidence that they
> drive a real window manager.** The two suites cover the same verbs from two directions, and this
> machine has no X server:
> * `tests/golden-sh.sh` asserts the **absence** path — with no `DISPLAY`, every desktop verb must
>   return a typed `E_NO_DISPLAY` rather than an empty success.
> * `tests/smoke-desktop-sh.sh` asserts the **injection** path — it puts the recording
>   `tests/fake-xdotool` on `PATH` and sets `DISPLAY`, so the verbs run their real code and the
>   assertions are about the **exact argument vector** handed to the tool: whether `--button right`
>   became button `3`, whether `Enter` became the keysym `Return`, whether a name outside the table
>   (`XF86AudioMute`) is passed through unchanged, whether `--clearmodifiers` and `--repeat` land in
>   the right place, and whether an `xdotool` failure is reported as `E_IO` rather than a false
>   success.
>
> **That harness is what found the two real defects in the POSIX implementation** (see
> [What is actually available](#what-is-actually-available) and
> [Installation status](#installation-status-and-known-defects)). Neither suite proves that they
> operate a real desktop.

> [!WARNING]
> **The two golden suites must be run serially.** Both implementations stage a failure envelope in a
> **fixed-path** temporary file — `.temporary/dsh-os.err`, with no PID and no lock — so concurrent
> calls overwrite each other's pending result. Running `golden.ps1` and `golden-sh.sh` in parallel was
> measured to report 2 **false** failures, in which the exit code contradicted the envelope's own
> `error.code`; run serially, both disappear. Treat this as a defect, not as flakiness: that staging
> path is racy by construction.

---

## Contributing

`src/host/lib/powershell5.1/*`, `src/host/lib/powershell7.6/*` and `src/host/lib/*.sh` are the source.
**Never hand-edit `src/host/bin/dsh-os.ps1`, `dsh-os7.ps1` or `.sh`** — they are generated. Edit the
modules, then:

```console
powershell -File tools/build.ps1          # regenerate all three scripts
powershell -File tools/build.ps1 -Check   # fails as soon as a committed script drifts
```

There are three separate artefacts rather than "one script with a runtime branch" because the two
runtimes differ in ways a branch cannot paper over cleanly: .NET Framework has no
`ProcessStartInfo.ArgumentList`, and .NET 10 has no reason to keep carrying the hand-rolled Windows
command-line escaping this project needed in order to work around its absence.

`git.ps1` / `git.sh` are **not** in `tools/build.ps1`'s module lists, so they are never concatenated
into any artefact; they are separate, self-contained interactive tools — see
[Standalone tools](#standalone-tools).

`.gitattributes` is part of the contract rather than a preference: `command.txt` and the `.tsv` tables
must be LF so that both implementations parse byte-identical input; `dsh-os.bat` must be CRLF and
ASCII-only, or `cmd.exe` mis-parses it; and `dsh-os.ps1` must be CRLF and UTF-8 **with** a BOM, or
PowerShell 5.1 reads its non-ASCII literals in the ANSI code page.

Two lessons learned the hard way in this repository, worth inheriting:

* **A security boundary derived from a path must fail closed.** A refactor once made the repository
  root one level too high, so no protected path matched. The failure mode was not an error but
  **protection silently ceasing to apply** — the protected files really were deleted.
* **Temporary files live under `.temporary/`**, golden-test fixtures included.

Module headers still refer to a `tools/split-once.ps1` that no longer exists; the current assembler is
`tools/build.ps1`.

---

## Standalone tools

`src/host/lib/git.sh`, `src/host/lib/powershell5.1/git.ps1` and `src/host/lib/powershell7.6/git.ps1`
are interactive git runners. They are deliberately **not** part of the verb surface: they are absent
from `$modulesPs1` and `$modulesSh` in `tools/build.ps1`, so they are never concatenated into
`bin/dsh-os.ps1`, `bin/dsh-os7.ps1` or `bin/dsh-os.sh`, and they emit no JSON envelope. Each is a
single self-contained file, byte-independent of the others, kept in step by review rather than by a
generator.

They locate git in three phases: `GIT_EXE`/`GIT_HOME`/`PATH`, then the known install locations
(including the Git-for-Windows registry keys), then a **depth- and time-bounded** walk of every
mounted file system. When nothing is found they list what was searched and exit 127. Arguments reach
git as separate argv elements; no shell string is ever assembled. `git add` with an empty answer
(directly pressing Enter) is equivalent to `git add .`. Each of the three obeys its own runtime's
encoding contract — which is precisely why `git.sh` is plain ASCII (English prompts) and the two
`git.ps1` files are not.

---

## Licence

**MIT**, declared in `package.json` (`"license": "MIT"`, author Eloy Kim) and distributed with the
repository as a separate [`LICENSE`](LICENSE) file. Fully open source: the whole verb surface, the
specification documents and the test suites are all in the repository. No telemetry, no account, no
network access at run time.

```
MIT License

Copyright (c) 2026 Eloy Kim
```

The licence file is pure ASCII, LF-terminated and BOM-free, consistent with the rest of the
repository's encoding contracts. One earlier description needs correcting: it is **not** listed in
`package.json`'s `files` whitelist (which has 14 entries; it includes `src/host/bin/dsh-os7.ps1` but
neither `LICENSE` nor `README.zh-CN.md`), so the file stays in a checkout but is not distributed with
the published package.

The verb contract and the specification documents are part of the source: a behaviour change should be
reflected in `src/host/spec/verbs.tsv`, `src/host/command.txt` and `src/host/docs/os-spec.md`, not only
in code.

One further note: the specification documents (`src/host/docs/os-spec.md`,
`src/host/docs/permission-model.md`, `src/host/command.txt`) are written in **Chinese**, while this
README and the verb table are in English.
