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
| `src/host/lib/*.ps1`, `src/host/lib/*.sh` | **The source of truth.** 16 module pairs, one per concern, mirrored between the two platforms |
| `src/host/bin/dsh-os.ps1` | **Generated** Windows implementation (Windows PowerShell 5.1 compatible, no external modules) |
| `src/host/bin/dsh-os.sh` | **Generated** POSIX implementation |
| `src/host/bin/dsh-os.bat` | ASCII-only `cmd.exe` shim: sets code page 65001 and forwards arguments to the `.ps1` |
| `src/host/command.txt` | The authoritative verb contract, one line per verb |
| `src/host/spec/verbs.tsv` | Machine-readable verb table: positionals, flags, permission class, error codes |
| `src/host/spec/charsets.tsv` | Charset table: IANA name to .NET code page to `iconv` name, with BOM bytes |
| `src/host/docs/os-spec.md` | Full specification: contracts, error codes, platform constraints, golden matrix |
| `src/host/docs/permission-model.md` | Authorization model: the four decisions, the file schema, the two enforcement layers |
| `tools/build.ps1` | Assembles both generated scripts from the modules; `-Check` fails if they drift |
| `tests/golden.ps1` | Windows golden cases driving the real script through argv |
| `tests/golden-sh.sh` | POSIX golden cases, including that a failing call still emits an envelope |
| `tests/encoding.ps1` | Encoding-contract guard (BOM, ASCII-only, line endings, BOM-free stdout) |
| `src/client/` | Web client surface (Vite scaffold, not yet wired to the host) |

## Modules

`src/host/lib/` holds one module pair per concern. `bin/dsh-os.ps1` and `bin/dsh-os.sh` are
generated from them by `tools/build.ps1`, so never edit the generated files.

| Module | Concern |
|---|---|
| `00-preamble` | strict mode, encoding pins, layout and repository-root discovery |
| `01-json` | error model, JSON serialisation, the envelope writer |
| `02-command` | argument parsing (positional and `name="value"`), assertions, coercion |
| `03-charset` | charset table, BOM policy, byte-level text model |
| `04-native` | P/Invoke declarations and atomic replace (Windows only; empty on POSIX) |
| `05-paths` | path resolution and the protected-path boundary |
| `06-file` | `file.*`, `file verify.*`, `file search` |
| `07-system` | `system.*` queries |
| `08-execute` | `execute.command` / `.synchronous` / `.asynchronous` |
| `09-task` | `task.*` |
| `10-environment` | `environment.*` and `environment attribute.*` |
| `11-service` | `service.*` |
| `12-permission` | `permission.*` (read-only) and `selfcheck` |
| `13-window` | `window.*` / `mouse.*` / `keyboard.*` / `clipboard.*` / `wait.*` / observe |
| `14-dispatch` | verb resolution and the dispatch table |
| `15-entry` | run, emit, exit |

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
npm run test:all     # encoding contracts, then the golden suite
```

Current state: **38 Windows golden cases, 44 POSIX golden cases and 13 plugin cases pass**, all
encoding contracts hold, 86 verbs in the table.

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
- Implemented and tested on POSIX: the same surface except `service`, plus `file search` and
  `execute` (command / synchronous / asynchronous).
- Both goldens include the failure path, which is the point: a failing call must still deliver exactly
  one parseable envelope on stdout, because a bare exit code tells an agent nothing.
- Not written yet: `mouse`, `keyboard`, `clipboard`, `window`, `wait`, `screenshot`, `text` and
  `structure` on both platforms, and `service` on POSIX. Those verbs are declared in the table and
  return a typed `E_NOT_SUPPORTED`, never a silent success.
- The consent-delegate plugin for durable authorization is not written; read-only `permission.*`
  works, and the protected-path boundary is enforced.

### Verified or not

Proven by tests in this repository:

- the scripts on both platforms, including that a failing call still emits exactly one envelope;
- the encoding contracts and the build's determinism;
- the plugin's execute path: entry-point resolution, argv construction, a path containing spaces
  reaching the script as one argument, flag forwarding, authorization, and error propagation;
- that the package is **resolvable by its own name** through Node's real resolver, which is what the
  loader depends on (a manifest without an `exports` map would fail to import even with every file in
  place);
- that the patch row matches the documented bundle shape, compared against a working third-party
  bundle in an installed profile.

Checked against the loader's own source: the version gate compares only the `@deepseek-ai/dsh*` peer
dependencies a plugin **declares**, so a host-only bundle that declares none is admitted.

Not proven here: that the loader actually composes this bundle and the `dsh_os` tool appears in a live
session. That needs `plugin_manager` `install_bundle`, which this session cannot invoke, and it is the
one claim the repository does not yet support.

## License

MIT
