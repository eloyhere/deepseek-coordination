# Changelog

All notable changes to this repository are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Scope change.** The repository was re-scaffolded in `87ddab9` (2026-10-17). Entries from
> `0.1.9` downwards describe the previous project, **dsh-os**, a cross-platform atomic
> OS-interaction surface. That tree is no longer on the branch tip but remains reachable in
> git history and tagged `v0.1.5` … `v0.1.9`; see [Repository history](README.md#repository-history).

## [Unreleased] — 2026-10-17

Branch tip `87ddab9`: the repository becomes a Vite + TypeScript web application.

### Added

- Vite `^8.3.0` and TypeScript `~6.0.2` single-page scaffold: `index.html`, `src/main.ts`,
  `src/counter.ts`, `src/style.css`, and `src/assets/{hero.png,typescript.svg,vite.svg}`.
- `tsconfig.json` for type checking only: `moduleResolution: "bundler"`, `noEmit`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`.
- `package-lock.json` pinning the local toolchain.
- `README.md`, `README.zh-CN.md` and this changelog.

### Changed

- `npm run dev`, `npm run build` and `npm run preview` are the working scripts; `build`
  type-checks with `tsc` before bundling with Vite.
- `.gitignore` replaced with the Vite template (`logs`, `*.log`, `node_modules`, `dist`,
  `dist-ssr`, `*.local`, editor directories).

### Removed

- `src/host/**`: the PowerShell 5.1, PowerShell 7.6 and POSIX verb implementations, the
  verb/charset specs, the design and permission-model docs, and the `dsh-os` launchers.
- `src/plugin/**` (`index`, `invoke`, `settings`, `takeover`, `workflow`), `src/permission/**`,
  and the `client.js` bundle.
- `tests/**` and `tools/**`, `cordis.patch.yml`, `permission.json`, `notice.txt`,
  `.gitattributes`.
- The previous `README.md` and `README.zh-CN.md` (both rewritten here).

### Known issues

- `main`, all five `exports` subpaths, `bin.dsh-os`, `dsh.bundle.patch` and 19 of the 20
  `files` entries still point at paths removed above.
- 18 npm scripts (`os`, `test`, `test:*`, `measure:cache`, `test:all`, `selfcheck`) reference
  the removed `tests/`, `tools/` and `src/host/bin/` trees and fail immediately.
- `index.html` still carries the scaffold placeholder title `replace`.
- Deleting `.gitattributes` hands line-ending policy back to `core.autocrlf`.

## [0.1.9] — 2026-10-13

### Fixed

- A string target was read as the wildcard, which disabled every scoped permission rule
  (`b7e02b0`).
- Version bumped to `0.1.9` for that fix (`3ba4a45`).

## [0.1.8] — 2026-10-13

### Added

- The approval seam, wired end to end (`8ee68dd`).

### Fixed

- Stored permission rules were never enforced; they now actually apply (`8ee68dd`).

## [0.1.7] — 2026-10-13

### Fixed

- Activation faults that shipped in `0.1.5` and `0.1.6` (`0a2c2c0`). Two Cordis behaviours every
  mock in the repository was too friendly to reproduce: a row that declares no config receives
  `null` rather than `undefined`, so a `config = {}` default never fires; and an undeclared
  service throws when read through the enforcing proxy, so a `typeof ctx.x?.y === 'function'`
  guard was itself the throwing statement. Guarded in all five entry points.

## [0.1.6] — 2026-10-13

### Fixed

- The tool description never named the tool itself, so the model could not select it
  (`42ff514`).

## [0.1.5] — 2026-10-13

### Added

- The workflow row: intent-first planning (`intake → plan → choose → run`) exposed as the
  `workflow_plan` tool, plus a system-prompt section kept constant so the provider prefix stays
  cached.
- Caching measured rather than asserted: four workflow calls at a 96.6% mean prefix-cache hit,
  with four tool calls and one human interaction on the unavoidable path (`b29c0e3`).

### Changed

- `0.1.3` and `0.1.4` were internal to the checkout and never published; `0.1.5` is the next
  published release after `0.1.2`.

## [0.1.2] — 2026-10-13

### Fixed

- `permission list`, `permission audit` and `permission query` returned
  `E_INTERNAL  The property 'empty' cannot be found on this object` whenever `permission.json`
  did not exist — the state of every installed copy, since the package ships no such file. Under
  `Set-StrictMode -Version Latest` the guard performed the throwing read inside its own test; the
  read now goes through `PSObject.Properties`, a dictionary lookup rather than a property read
  (`e4fade7`).

## [0.1.0 – 0.1.1] — 2026-10-13

Initial publication, preceded by the build-out that began on 2026-10-12 (`c2dae0c`). Releases
`0.1.0` and `0.1.1` were published in the same window, so their boundaries are recorded together.

### Added

- Cross-platform atomic OS-interaction surface: one argument-stable verb set over `file`,
  `environment`, `task`, `service`, `system`, `permission`, `execute`, `window`, `screenshot`,
  `clipboard`, `wait`, `mouse`, `keyboard`, `text` and `structure`, each verb returning a single
  JSON envelope with byte-exact charset, BOM and line-ending handling.
- Native Windows implementation through PowerShell 5.1 (`Add-Type` P/Invoke), a PowerShell 7.6
  port of all 16 modules, and a POSIX implementation — 16 mirrored module pairs, assembled into
  one self-contained artefact per platform by a deterministic build.
- DSH plugin entry points, the bundle patch, and the web client.
- Conformance, encoding, golden-case, permission, plugin, activation, takeover and workflow test
  suites, plus packaging and bundle verification tools.
- Rewritten English README, shipped inside `0.1.1` (`8b8a808`).

### Fixed

- Defects found before publication (`faaa0b7`): `dsh-os7.ps1` was missing from the packed `files`
  list although the plugin resolves that exact name for the 7.6 edition, which would have broken
  every installed copy while working in the checkout; `--encoding` on the Windows batch verbs was
  inert because the computed encoding object was never applied; `Invoke-OneShellCommand` never set
  `StandardOutputEncoding`.
- Version bumped to `0.1.1` (`69a9f61`).

## References

- Repository: <https://github.com/eloyhere/deepseek-coordination>
- Tags: `v0.1.5`, `v0.1.6`, `v0.1.7`, `v0.1.8`, `v0.1.9`
- Last commit of the dsh-os tree: `3ba4a45`
- First commit: `c2dae0c` (2026-10-12)
