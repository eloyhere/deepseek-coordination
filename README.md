# deepseek-coordination

Cross-platform **atomic OS-interaction surface** for the DeepSeek Harness.

The problem this project solves is narrow and concrete: an agent that talks to the operating
system through *strings* gets the wrong answer whenever a path contains a space, a file carries a
UTF-8 BOM, a line ending is CRLF, a document is not UTF-8, or a command is assembled by
concatenation. This project replaces string assembly with an **argument-stable verb set** and makes
encoding, byte order marks and line endings explicit and byte-exact.

## What is here

| Path | What it is |
|---|---|
| `src/host/lib/powershell5.1/*.ps1` | **The source of truth** for Windows PowerShell 5.1: the 16 modules listed in `tools/build.ps1`, plus the standalone `git.ps1` |
| `src/host/lib/powershell7.6/*.ps1` | **The source of truth** for PowerShell 7.6: the same 16 modules ported to .NET, plus the standalone `git.ps1` |
| `src/host/lib/*.sh` | **The source of truth** for POSIX: the 16 shell modules, plus the standalone `git.sh` |
| `src/host/bin/dsh-os.ps1` | **Generated** Windows PowerShell 5.1 implementation (218,514 bytes) |
| `src/host/bin/dsh-os7.ps1` | **Generated** PowerShell 7.6 implementation (255,565 bytes) |
| `src/host/bin/dsh-os.sh` | **Generated** POSIX implementation (130,240 bytes) |
| `src/host/bin/dsh-os.bat` | ASCII-only `cmd.exe` shim: sets code page 65001 and forwards arguments to the `.ps1`. Hand-written, not generated |
| `src/host/command.txt` | The authoritative verb contract, one line per verb |
| `src/host/spec/verbs.tsv` | Machine-readable verb table: positionals, flags, permission class, error codes. **86 verbs** |
| `src/host/spec/charsets.tsv` | Charset table: IANA name to .NET code page to `iconv` name, with BOM bytes. **15 charsets** |
| `src/host/docs/os-spec.md` | Full specification: contracts, error codes, platform constraints, golden matrix |
| `src/host/docs/permission-model.md` | Authorization model: the four decisions, the file schema, the two enforcement layers |
| `src/host/lib/powershell.md` | PowerShell 5.1 to 7.6 API-change reference. Not referenced by code, tests or `package.json`; not published |
| `tools/build.ps1` | Assembles the generated scripts from the modules; `-Check` fails if they drift |
| `tests/golden.ps1` | Windows golden cases driving the real script through argv. **49 cases** |
| `tests/golden-sh.sh` | POSIX golden cases, including that a failing call still emits an envelope. **75 registered cases** |
| `tests/encoding.ps1` | Encoding-contract guard (BOM, ASCII-only, line endings, BOM-free stdout). **10 contract sites** |
| `tests/plugin.test.mjs` | Plugin execute path, argv handling, and bundle manifest shape. **13 cases** |
| `tests/permission.test.mjs` | Consent delegate: rule matching, deny-first, trust, audit bounds, atomic write. **18 cases** |
| `src/plugin/index.js` | Host plugin: registers the `dsh_os` tool |
| `src/permission/index.js` | Consent delegate: the only writer of `permission.json` |
| `src/client/` | Web client surface (Vite scaffold, not yet wired to the host) |

The two PowerShell runtimes are kept in separate directories because they differ in ways that are not
cosmetic: .NET Framework 4.8 has no `ProcessStartInfo.ArgumentList` and needs an ANSI-aware encoding
path, while .NET 10 has both. Neither file has to carry the other's workarounds.

## Modules

`src/host/lib/` holds one module pair per concern. `bin/dsh-os.ps1` and `bin/dsh-os.sh` are
generated from them by `tools/build.ps1`, so never edit the generated files.

| Module | Concern |
|---|---|
| `preamble` | strict mode, encoding pins, layout and repository-root discovery |
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
| `permission` | `permission.*` (three read-only verbs, three delegate-only writes) and `selfcheck` |
| `window` | `window.*` / `mouse.*` / `keyboard.*` / `clipboard.*` / `wait.*` / observe |
| `dispatch` | verb resolution and the dispatch table |
| `entry` | run, emit, exit |

A build step rather than dot-sourcing the modules at runtime, deliberately: the shipped script must
stay one self-contained file that the harness and a human can invoke directly, with no module
resolution and no relative-path assumptions. On Windows PowerShell 5.1 a sourced file without a BOM
is decoded in the ANSI code page, which is the exact encoding fault this project exists to remove.

## Design rules

1. **Values are separate argv elements.** Commands are never assembled into a shell string. This is
   what removes the Windows space-in-path problem: `C:\Program Files\a b.exe` is one argument.
2. **Byte-exact text handling.** Reads strip the BOM; every write restores the file's original BOM
   presence and line-ending convention. A BOM is never allowed to leak into text a caller sees.
3. **Assertions report, they do not throw.** `file verify charset` returns `match: false` alongside
   the observed value, so a caller can tell "the file is wrong" from "I asked wrongly".
4. **Read-only verbs never prompt; mutating verbs require explicit authorization** (`--allow`).
5. **Unsupported is never silent.** An unimplemented verb or an unavailable platform capability
   returns a typed error code, rather than succeeding with an empty result.

## Usage

```powershell
# Windows
src\host\bin\dsh-os.ps1 selfcheck
src\host\bin\dsh-os.ps1 file charset "C:\path with spaces\file.txt"
src\host\bin\dsh-os.ps1 file verify charset .\file.txt utf-8
src\host\bin\dsh-os.ps1 environment attr get PATH --scope process
```

Every call writes exactly one JSON envelope to stdout, UTF-8 without a BOM:

```json
{"ok":true,"verb":"file.charset","result":{"charset":"utf-8","bom":false,"eol":"crlf"},"meta":{}}
```

`error.code` is authoritative; exit codes are a coarse class (0 ok, 1 usage, 2 type, 3 authorization,
4 unsupported, 5 target/encoding, 6 timeout, 7 internal).

## Tests

```powershell
npm run test:all     # encoding guard, Windows golden, plugin, permission, then the three verifiers
```

`test:all` chains `test:encoding`, `test` (the Windows golden suite), `test:plugin`, `test:permission`,
`test:bundle` (`tools/verify-bundle.mjs`) and `test:load` (`tools/verify-plugin-load.mjs` then
`tools/verify-editions.mjs`), in that order.

Current state, measured on this checkout:

| Suite | Command | Cases | Result |
|---|---|---|---|
| Encoding contracts | `powershell -File tests/encoding.ps1` | 10 contract sites | **4 violations** — see below |
| Windows golden | `powershell -File tests/golden.ps1` | 49 | **49 passed, 0 failed** |
| POSIX golden | `bash tests/golden-sh.sh` | 115 | **115 passed, 0 failed** |
| Plugin | `node tests/plugin.test.mjs` | 13 | **13 passed, 0 failed** |
| Permission delegate | `node tests/permission.test.mjs` | 18 | **18 passed, 0 failed** |
| Bundle resolution | `node tools/verify-bundle.mjs` | 10 | **10 passed, 0 failed** |
| Plugin load | `node tools/verify-plugin-load.mjs` | 13 | **13 passed, 0 failed** |
| Edition selection | `node tools/verify-editions.mjs` | 14 | **14 passed, 0 failed** |
| Build drift | `powershell -File tools/build.ps1 -Check` | 3 artefacts | **no drift** |

86 verbs are declared in the table; **82 are implemented on Windows PowerShell 5.1 and on PowerShell
7.6 (identical sets), and 61 on POSIX**.

The POSIX desktop verbs need an X display. The suite supplies one through the `tests/fake-xdotool` and
`tests/fake-wmctrl` fixtures rather than a real X server, so "115 passed" is evidence that the verbs
build the right commands and fail in the right typed way; it is **not** evidence that they drive a real
window manager.

The four encoding violations are all in the two standalone `git.ps1` scripts, and they are a contract
conflict rather than a defect in either file. `tests/encoding.ps1` requires every `*.ps1` under
`src/host/lib/` to be BOM-free and ASCII-only, because the modules it walks are concatenated into a
generated script. The `git.ps1` scripts are not build inputs, they are UTF-8 **with** a BOM (mandatory
for the Chinese prompt literals under Windows PowerShell 5.1) and therefore contain non-ASCII bytes.
The two rules and those two files cannot both hold; the guard has not been relaxed.

## Using it from the harness

`package.json` declares `dsh.bundle.patch`, so the package installs into a DSH profile as a bundle and
registers one model-facing tool:

| Tool | Purpose |
|---|---|
| `dsh_os` | Run one verb of the surface and return its JSON envelope verbatim |

One tool rather than one per verb: the verb table is the contract and lives in `spec/verbs.tsv`, so
the schema does not need regenerating when a verb is added or renamed; an agent discovers the whole
surface with a single `verb: "selfcheck"` call; and the envelope is already the stable result shape,
so there is no second contract to drift from the script's.

```jsonc
// call shape
{ "verb": "file charset", "arguments": ["path=\"./a.txt\""], "allow": false }
{ "verb": "environment attribute get", "arguments": ["PATH"], "flags": ["--scope", "process"] }
```

The implementation is spawned by absolute path with an argv array, never through a shell string, so a
value containing spaces stays one value. On Windows the `.ps1` is launched through `powershell.exe -File`
rather than the `.bat`: `cmd.exe` interprets a batch file, and spawning one with `shell: false` fails
with `EINVAL`. On POSIX the `.sh` is launched through `/bin/bash` so it need not be marked executable.

## Status

- Implemented and tested on Windows: `file`, `file verify`, `file search`, `system`, `task`
  (list/query), `service` (list/query), `environment` including `environment attribute`,
  `permission` (read-only) and `selfcheck`.
- Implemented and tested on POSIX: the same surface except `service`, `window`, `screenshot`,
  `clipboard`, `wait`, `mouse` and `keyboard`, plus `file search`, `execute` (command / synchronous /
  asynchronous), the process verbs `execute.query`, `execute.kill`, `task.query`, `task.show` and
  `task.kill`, and the whole `permission.*` group including `permission acl init`.
- POSIX layer A is a mode change rather than a Windows deny ACE, and the equivalence is weaker: the
  same user can restore write access. `permission acl init` says so in its own result, and its
  `restore` field names the command that undoes it.
- `selfcheck` reports on the two platforms differently, and the difference is worth knowing before
  reading its output as a parity check. On POSIX it derives the implemented list from its own dispatch
  table and emits an `implementedCount`. On **Windows it does not**: `Invoke-Selfcheck` walks every row
  of `spec/verbs.tsv` and emits only `verbCount`, with no implemented/unimplemented distinction at all.
  So a Windows `selfcheck` naming a verb does not mean that verb is implemented — the dispatch tables
  above are the authority.
- Implemented and tested on Windows for `window`, `screenshot`, `clipboard` and `wait`: enumeration,
  matching, move, resize, minimize, maximize, restore, z-order, close, screen capture to png/jpeg/bmp,
  clipboard text round-trip including non-ASCII, an explicit sleep, and waiting for a window to appear
  or to go away.
- Both goldens include the failure path, which is the point: a failing call must still deliver exactly
  one parseable envelope on stdout, because a bare exit code tells an agent nothing.
- Implemented and tested on Windows for `mouse` and `keyboard`: cursor read-back, move, click,
  right-click, wheel, button down/up, key down/up, a self-releasing press, chords in both phases, and
  text entry by Unicode key events (so it is layout-independent and accepts non-ASCII).
- Implemented and tested on Windows for `text` and `structure` through UI Automation: the element at a
  point, its text via ValuePattern / TextPattern / LegacyIAccessiblePattern / Name in that order, and
  the control tree around it. Both are honest about the environment - a missing UIA stack or a refusal
  is a typed E_ACCESSIBILITY_UNAVAILABLE / E_ACCESSIBILITY_DENIED, never an empty result.
- Missing on Windows: `clipboard.paste` and the `service` lifecycle verbs (`start`, `stop`, `restart`)
  — four verbs. Everything else in the table is dispatched on both PowerShell runtimes, with identical
  verb sets. Every listed verb is declared in the table and returns a typed `E_NOT_SUPPORTED` rather
  than a silent success.
- Missing on POSIX: 25 verbs — `file.encode`; all of `window.*`; `screenshot`, `text`, `structure`;
  `clipboard.read`, `clipboard.write`, `clipboard.paste`; `wait.window`; `task.launch`; and all of
  `service.*`. `mouse.*`, `keyboard.*`, `wait.ms` and the five `environment attribute` verbs **are**
  implemented, but every one of them requires an X display: with no `DISPLAY` they return a typed
  `E_NO_DISPLAY` rather than an empty success.
- Windows and PowerShell 7.6 are at exact parity: both dispatch the same 82 verbs, checked by
  comparing the two dispatch tables rather than by eye.
- The four `execute` verbs that the README previously listed as unwritten are in fact implemented on
  Windows — `execute.command`, `execute.query`, `execute.kill` and `task.launch` are dispatched to real
  bodies. So are `permission.grant`, `permission.revoke` and `permission.acl.init` on **both**
  platforms. `permission.json` therefore does have writing verbs; see the authorization section.
- The consent delegate (`src/permission/index.js`, row id `dsh-os-permission`) is written and tested:
  it is the only component that writes `permission.json`, matching is deny-first regardless of rule
  order, a file whose `updatedBy` is not the delegate is untrusted and falls back to defaults, a
  wildcard target needs explicit acknowledgement, and writes go through a temp file plus rename so a
  crash cannot leave a half-written file.
- The A layer (kernel ACL enforcement) is implemented on Windows: `permission acl init` appends an
  explicit deny for Everyone to the authorization file DACL, is idempotent, requires elevation
  (reporting `E_ELEVATION_REQUIRED` rather than failing silently), and `selfcheck` reports the strength
  it MEASURED from the file security descriptor plus a reason, never a stored flag.

### Verified or not

Proven by tests and verifiers in this repository:

- the scripts on both platforms, including that a failing call still emits exactly one envelope;
- the build's determinism: `tools/build.ps1 -Check` reports the three generated artefacts matching
  their modules byte for byte (218,514 + 255,565 + 142,744 bytes);
- the plugin's execute path: entry-point resolution, argv construction, a path containing spaces
  reaching the script as one argument, flag forwarding, authorization, and error propagation;
- the loader's **resolution** contract, by `tools/verify-bundle.mjs`: the manifest header, the patch
  file, each row resolving from a profile-style `node_modules`, each resolved module exporting the
  Cordis shape the loader calls, the two rows resolving to **distinct** modules, and the version gate.
  The package is linked into a throwaway profile sandbox by junction, so resolution happens as it
  would in a profile and the live profile is never written to;
- the real `apply()` path, by `tools/verify-plugin-load.mjs`: the host plugin registers `dsh_os` with a
  parameters schema whose root type is `object`, the permission plugin registers its five tools, the
  **registered handler actually spawns the script** and returns a real envelope (`selfcheck` → ok,
  `verbCount` 86), and a mutating verb without `allow` is refused with a typed `E_PERMISSION` rather
  than throwing;
- edition selection, by `tools/verify-editions.mjs`: the default stays on PowerShell 5.1,
  `powershellEdition: '7.6'` and `DSH_OS_POWERSHELL_EDITION` select the 7.6 artefact, `'auto'` uses
  7.6 only when both the artefact and a working `pwsh` are present, config beats environment, and an
  explicit `scriptPath` disables the choice. `-ExecutionPolicy` is passed only to the 5.1 executable,
  being a Windows PowerShell option.

Measured on this checkout, stated exactly as observed:

| Suite | Cases | Result |
|---|---|---|
| Windows golden | 49 | **49 passed, 0 failed** |
| POSIX golden | 115 | **115 passed, 0 failed** |
| Plugin | 13 | **13 passed, 0 failed** |
| Permission delegate | 18 | **18 passed, 0 failed** |
| Bundle resolution | 10 | **10 passed, 0 failed** |
| Plugin load | 13 | **13 passed, 0 failed** |
| Edition selection | 14 | **14 passed, 0 failed** |
| Encoding contracts | 10 sites | **4 violations** — see below |

- The 4 encoding violations are all in the two standalone `git.ps1` scripts, for the contract conflict
  described under Tests. Every other contract holds, including that stdout never carries a BOM.
- The PowerShell 7.6 artefact builds and is now reachable, but the version of PowerShell 7 on the
  machine that ran the edition verifier is **7.6.6**, and the argument-stability and encoding
  behaviour of `bin/dsh-os7.ps1` is otherwise established by comparing the two dispatch tables and by a
  comment-aware scan for cross-version constructs, not by a per-verb run on 7.6.

Not proven, and not claimed: that the **harness's own loader** composes these bundles in a live
profile. That would mean installing this package into the user's active desktop profile and restarting
the harness, which has not been done.

## Authorization

Read-only verbs never prompt. Every mutating verb requires an explicit `--allow`; without it the call
returns `E_PERMISSION` and nothing happens.

`permission.json` is written by the consent delegate (`src/permission/index.js`, row id
`dsh-os-permission`) and by nothing else. The table declares three write verbs —
`permission.grant`, `permission.revoke` and `permission.acl.init`, all `W` — and three read-only ones
(`query`, `list`, `audit`). `grant` and `revoke` accept only the `delegate` flag besides `allow`, so
the script itself cannot create a persistent authorization: with no delegate present they return
`E_PERMISSION_DELEGATE_ONLY`.

Two enforcement layers protect "the files that decide what this layer may do":

- **Layer B, structural** — a hard protected-path boundary rejects any modification of
  `permission.json` (and `.bak`), `src/host/command.txt`, the four `src/host/bin/dsh-os.*` entry
  points, `src/host/spec/verbs.tsv` and `src/host/spec/charsets.tsv`, plus any same-named temporary
  staged beside one of them. Violations report `E_PERMISSION_PROTECTED_PATH` with no side effect;
  reads are still allowed so you can review the rules. The check runs on the **resolved, normalised**
  path, compared segment by segment rather than by regex, because `..`, 8.3 short names or a trailing
  dot all walk around a regex. `file.move` and `file.copy` check **both ends**, since moving a
  protected file is a way of destroying it. The POSIX list has eight entries: the same list without
  `dsh-os7.ps1`.
- **Layer A, kernel ACL** — Windows only, opt-in and requiring elevation. `permission acl init`
  appends an explicit `DENY` for `Everyone` (`S-1-1-0`) to the DACL of `permission.json`, covering
  `FILE_GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER`. It is idempotent and reports
  `E_ELEVATION_REQUIRED` rather than failing opaquely. `selfcheck` reports `aclEnforced` by reading
  the file's real security descriptor and walking the DACL, never from a stored flag, and `aclReason`
  explains a `false`. The POSIX equivalent is weaker by construction: it is a mode change, and the
  same user can restore write access. `permission acl init` says so in its own result and its
  `restore` field names the command that undoes it.

Four limitations, stated because they change what the guarantees above mean:

1. **Persistent rules are recorded but not enforced at the verb layer.** The rules in
   `permission.json` are matched by the consent delegate and its `os_permission_query` tool. The
   script reads the file for **display only** (`permission list/query/audit`); no verb consults a rule
   before acting. The real gates are `--allow`, the protected-path check and (if enabled) layer A. A
   `deny-always` rule does **not** currently stop a verb that arrives with `--allow`.
2. **`E_PERMISSION_DENIED_BY_RULE` is declared but never thrown.** It is in the error table and maps
   to exit class 3, but no code path produces it — consistent with point 1.
3. **The in-script rule reader is not deny-first.** `permission query` takes the **first** matching
   rule without regard to whether it allows or denies. The delegate implements deny-first correctly
   and has test coverage; the two readers can therefore disagree, and the script side is the weaker
   one.
4. **`execute` is a way around the protected-path boundary.** That boundary guards `file.*` and
   `environment.*`. It cannot constrain a child process: `execute.synchronous` hands the command line
   to `cmd.exe /d /s /c` on Windows and to `sh -c` on POSIX, so the program it starts can write
   anything its own rights permit, `permission.json` included. Only layer A prevents that, and layer B
   cannot when `aclEnforced` is false.

The consent delegate has a **design gap** worth stating plainly: it registers five tools
(`os_permission_query`, `os_permission_grant`, `os_permission_revoke`, `os_permission_list`,
`os_permission_audit`) but does **not** register an `approval/request` answerer, although its own
header explains that reaching the user is why it is a plugin rather than a script subcommand. As the
code stands, the enforcement is a **tool description** telling the model to call `os_permission_grant`
only after the user chooses; the code does not verify that a prompt ever happened. Treat the delegate
as trusted infrastructure rather than as a check on the agent. It also reports
`aclEnforced: false` unconditionally in its `query` result instead of measuring the ACL as the script
does, so it **under-reports** protection when layer A is on.

## Standalone tools

`src/host/lib/git.sh`, `src/host/lib/powershell5.1/git.ps1` and `src/host/lib/powershell7.6/git.ps1`
are interactive git runners. They are deliberately **not** part of the verb surface: they are absent
from `$modulesPs1` and `$modulesSh` in `tools/build.ps1`, so they are never concatenated into
`bin/dsh-os.ps1`, `bin/dsh-os7.ps1` or `bin/dsh-os.sh`, and they emit no JSON envelope. Each one is a
single self-contained file, byte-independent of the others, kept in step by review rather than by a
generator.

They locate git in three phases — `GIT_EXE`/`GIT_HOME`/`PATH`, then the known install locations
(including the Git-for-Windows registry keys), then a depth- and time-bounded walk of every mounted
file system — and exit 127 with the searched locations when nothing is found. Arguments reach git as
separate argv elements; no shell string is ever assembled. `git add` with an empty answer becomes
`git add .`. All three are ASCII-or-BOM per their own runtime's encoding contract, which is why the
shell module is English-only and the PowerShell ones are not.

## License

MIT
