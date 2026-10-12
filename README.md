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
| `src/host/bin/dsh-os.ps1` | Windows implementation of the whole verb surface (Windows PowerShell 5.1 compatible, no external modules) |
| `src/host/bin/dsh-os.bat` | ASCII-only `cmd.exe` shim: sets code page 65001 and forwards arguments to the `.ps1` |
| `src/host/bin/dsh-os.sh` | POSIX implementation (**not yet written**) |
| `src/host/command.txt` | The authoritative verb contract, one line per verb |
| `src/host/spec/verbs.tsv` | Machine-readable verb table: positionals, flags, permission class, error codes |
| `src/host/spec/charsets.tsv` | Charset table: IANA name to .NET code page to `iconv` name, with BOM bytes |
| `src/host/docs/os-spec.md` | Full specification: contracts, error codes, platform constraints, golden matrix |
| `src/host/docs/permission-model.md` | Authorization model: the four decisions, the file schema, the two enforcement layers |
| `tests/golden.ps1` | 32 golden cases driving the real scripts through argv |
| `tests/encoding.ps1` | Encoding-contract guard (BOM, ASCII-only, line endings, BOM-free stdout) |
| `src/client/` | Web client surface (Vite scaffold, not yet wired to the host) |

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

Current state: **32 golden cases pass**, all encoding contracts hold, 83 verbs in the table.

## Status

- Windows `file`, `file verify`, `system`, `task` (list/query), `service` (list/query),
  `environment`, `permission` (read-only) and `selfcheck` are implemented and tested.
- The POSIX implementation, the remaining Windows verb groups
  (`execute`, `mouse`, `keyboard`, `clipboard`, `window`, `wait`, `screenshot`, `text`, `structure`)
  and the consent-delegate plugin are not written yet.

## License

MIT
