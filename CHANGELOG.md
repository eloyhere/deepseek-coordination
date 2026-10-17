# Changelog

All notable changes to this repository are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Scope note.** The repository was reshaped twice in October 2026: `87ddab9` replaced the
> dsh-os tree with a standalone Vite application, and `0.2.0` replaced that with the current
> DSH plugin bundle layout. Entries from `0.1.9` downwards describe **dsh-os**, a cross-platform
> atomic OS-interaction surface, which is no longer on the branch tip but remains reachable in
> git history and tagged `v0.1.5` … `v0.1.9`; see
> [Repository history](README.md#repository-history).

## [0.2.0] — 2026-10-17

The repository becomes a DeepSeek Harness plugin **bundle**: a dual-face Cordis plugin with a
host half (route surface) and a client half (settings page).

### Added

- Bundle manifest: `dsh.bundle.patch` pointing at `cordis.patch.yml`, `dsh.client`
  (`platform: web`, `immediately: true`, module-table `inject`), and a dual `exports` map
  (`.`, `./client`, `./package.json`) with `main`/`types` on the built host artifact.
- `cordis.patch.yml` — the layer that inserts the `deepseek-coordination` row into a profile's
  bundle roster.
- Dual-face source layout: `src/index.ts` (host half — a `webServer` prefix route at
  `/deepseek-coordination` exposing `ping` and `echo`) and `src/client/index.ts` (client half —
  `zh`/`en` locale dictionaries plus a `settings.section` page that probes the host route).
- `tsdown.config.ts` — two build targets: host as ESM (`lib/index.mjs` + `.d.mts`) and client as
  CJS (`lib/client.js`) wrapped in `window.__ModuleLoader__.load()`, with `neverBundle` rules for
  the host process and the browser module table.
- `tsconfig.json` for type checking only (`noEmit`), and the `build`, `typecheck` and
  `pack:check` scripts.

### Changed

- Version `0.2.0`. The package shape is incompatible with `0.1.9` — entry points, `files` and the
  delivered artifacts all differ, so a minor bump is the semver-correct signal for a `0.x` line.
- Toolchain moved from Vite to `tsdown`, with the DSH client packages declared as both
  `peerDependencies` and `devDependencies` so the plugin shares the host's instances.
- `.gitignore` now ignores `lib/` (build output) instead of `dist/`.

### Removed

- The standalone Vite SPA scaffold introduced in `87ddab9`: `index.html`, `src/main.ts`,
  `src/counter.ts`, `src/style.css`, `src/assets/`, `public/`, the Vite dependency and its
  lockfile.
- The `os` and `bin` fields of the previous manifest, which described the removed `dsh-os`
  launchers; the plugin is platform-agnostic.

### Known issues

- The halves are a scaffold: `ping` and `echo` are the entire host surface, and the settings page
  only reports host liveness. No functional capability is implemented yet.
- Dependency ranges mirror the DSH plugin starter template (`@deepseek-ai/cordis` `^4.0.1`, the
  `@deepseek-ai/dsh-*` client packages `^0.1.0-rc.7`). Re-check them against the DSH release being
  targeted before publishing.
- `engines.dsh` is deliberately omitted, so installation validates the `@deepseek-ai/dsh*` peer
  ranges instead of a declared DSH range.

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
