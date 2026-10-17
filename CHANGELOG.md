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

## [0.7.0] — 2026-10-17

The coordination surface becomes a working host+client pipeline: the five composer
dropdowns persist through the host, a tooltip explains every control and option, and
the profession locks for the duration of a task.

### Added

- Host composition: `CoordinationService` on `ctx.coordination`, a coordination
  SQLite database, module wiring, a 60s cleanup effect, and an agent-turn lifecycle
  (`agent/pre-step` opens one locked Turn; `agent/turn-stopping` / `agent/error`
  close it).
- HTTP routes `/deepseek-coordination/{selection,presets,permission,locale,state,ping,echo}`.
  `GET/POST /selection` is the contract the composer actually uses.
- Per-scene execution policy and the v24 **写作 (writing)** scene between 对话 and
  办公: outline → draft → revision, quality score, no bash, optional web.
- All three validation levels search the web and run Bayesian prior/posterior
  updates: low 1×3 current turn, medium 2×5 current session, high 4×8 all local
  content, with high-scope global fusion.
- English/Chinese dictionaries following the DSH locale (`ctx.locale`), including
  tooltips, settings, errors and model-facing tool descriptions.
- 203 host tests (`npm test`), a shared in-memory fixture, and a `test:tsc` gate.

### Changed

- The fifth dropdown is 验证 (low / medium / high), not an ad-hoc 强度 selector.
- 情景 now has six options; the default stays 对话.
- Tooltips are on the trigger and on every option, from one shared copy source.
- The spec lives at `docs/deepseek-coordination-v24.md` (v23 + v24 revision).

## [0.6.5] — 2026-10-17

### Added

- A fourth selector after 情景: 强度, with the options low / medium / high (default medium). It
  belongs to the 工作流 group, so the switch that hides the coordination selectors hides it too.

## [0.6.4] — 2026-10-17

### Added

- A `工作流` switch in the `协调` settings page. It shows or hides the three coordination
  selectors (职能 / 交互 / 情景) in the composer tool row; off, that slot contributes nothing.
  The 权限接管 switch is independent: it still governs hiding the host's access-mode control and
  rendering the replacement dropdown. Both choices persist in `localStorage`; 工作流 defaults on.

## [0.6.3] — 2026-10-17

### Fixed

- The replacement permission dropdown offered guessed labels (只读 / 工作区可写 / 完全权限). The
  host's own menu shows 仅可查看 / 工作区内修改 / 完全权限, and the plugin now uses exactly those
  words. Only the labels are aligned: choosing an entry still dispatches nothing, because the
  `/permission` write path is exposed on `conversation.composer.bar`, not on the slot this
  plugin occupies.

## [0.6.2] — 2026-10-17

### Added

- 交互 gains a fifth option, 统筹, after 收束.

### Changed

- The replacement permission dropdown offers 只读 / 工作区可写 / 完全权限 instead of the single
  完全权限 fallback.

### Fixed

- The composer's "+" popover flashed and closed. The composer re-renders while that menu is open;
  this plugin re-rendered with it, and each render made emotion touch `<head>`, which the host
  treats as outside DOM mutation and closes the popover on. Both slot components are memoised and
  the `sx` object is hoisted so an unrelated re-render no longer regenerates a style rule.

## [0.6.1] — 2026-10-17

### Fixed

- The client half referenced `process`, so the browser threw "import failed: process is not
  defined" and the entire web boot failed ("1 entry did not activate"). MUI and emotion read
  `process.env.NODE_ENV`; the build now defines it (`define: { 'process.env.NODE_ENV':
  '"production"' }`), which also lets the bundler drop the development branches.
- Client bundle: 748.89 kB → 525.35 kB (155.85 → 113.72 kB gzip) as a side effect.

## [0.6.0] — 2026-10-17

The widgets move to Material UI: `@mui/material@9.5.0` with `@emotion/react` and
`@emotion/styled`, rendered through a local `ThemeProvider` so the plugin never reaches into the
host's own theme.

### Added

- MUI `Select`/`MenuItem` for the three selectors and MUI `Switch` for the takeover switch.

### Changed

- `@mui/material` and emotion are bundled into `lib/client.js` (`alwaysBundle`): they are not in
  the host module table. Bundle size 12.80 kB → 748.89 kB (4.56 → 155.85 kB gzip).
- MUI's generics reject this plugin's event shapes, so the two components are narrowed to the
  props actually passed; the runtime components are unchanged.

## [0.5.0] — 2026-10-17

MDUI out, plain React in. The one UI framework the host guarantees is React itself (it arrives
through the module table), so the widgets no longer need a third-party kit.

### Changed

- The dropdowns and the takeover switch are React components owned by this plugin; the popup is
  drawn here (hover state on the trigger, 10px corner radius) instead of by the OS.
- Widget CSS is a string injected once through `ctx.effect`, so the plugin ships no stylesheet
  asset and the build needs no copy step.
- `pnpm build` is a single `tsdown` run again; the host half serves no static files.

### Removed

- `mdui@2.1.5`, `scripts/copy-mdui.mjs`, `lib/static/`, and the `/static/*` route.

## [0.4.0] — 2026-10-17

Angular out, MDUI 2 in. Angular needed a second toolchain (a separate `ng build`, its own
tsconfig, a static-served element bundle) and pinned the plugin to a TypeScript range; MDUI 2 is
framework-agnostic web components, so the widgets are now plain custom elements the React client
half renders directly.

### Added

- `<mdui-switch>` for the permission-takeover switch and `<mdui-select>` / `<mdui-menu-item>` for
  the three selectors, with `mdui@2.1.5`'s component JS bundled into `lib/client.js`.
- `scripts/copy-mdui.mjs`: copies MDUI's stylesheet to `lib/static/mdui.css`, served by the host
  half at `/deepseek-coordination/static/` — version-locked to the bundled JS, no CDN and no
  network requirement.

### Changed

- The `协调` settings page now holds **only** the takeover switch; the selectors live in the
  composer toolbar alone.
- The host half's static route moved from `/elements/*` to `/static/*`; `files` ships `lib/static`
  instead of `lib/elements`.
- `pnpm build` is `tsdown` plus the stylesheet copy; the `build:elements` / `typecheck:elements`
  scripts are gone.

### Removed

- `@angular/core`, `@angular/common`, `@angular/platform-browser`, `@angular/elements`, `rxjs`,
  `tslib`, and the build-side `@angular/cli`, `@angular/build`, `@angular/compiler`,
  `@angular/compiler-cli`.
- `angular.json`, `tsconfig.elements.json`, and `src/elements/**` (the custom element that
  wrapped the three selectors).

## [0.3.0] — 2026-10-17

The plugin grows its first real UI: an Angular custom element mounted into the DSH Web host,
plus the permission takeover of the composer's access-mode control.

### Added

- **Angular Elements app** (`src/elements/`, built to `lib/elements/browser/`): a zoneless,
  standalone Angular 21 component defined as `<dsh-coordination-controls>`. It renders the three
  coordination selectors left to right — 职能 (决策/成果/资源/人员/任职/执行), 交互
  (感情/思维/启发/收束), 情景 (对话/写作/办公/研究/工程/迭代) — and, when takeover is on, the
  replacement permission dropdown ahead of them.
- **`协调` settings section** (`settings.section`): the permission-takeover switch, the same
  selectors, and Material Symbols (Google Fonts) iconography.
- **Composer mount** (`conversation.input.left`): the element is injected into the free space of
  the composer tool row — the region marked green in the review mock.
- **Permission takeover**: with the switch on, an injected rule hides the host's access-mode
  control (`button[aria-label^="访问模式"]` / `^="Access mode"`) — the blue region — and the
  element renders the replacement dropdown in its place. The choice persists in `localStorage`.
- Host route `GET /deepseek-coordination/elements/*` serving the built bundle from package files,
  path-traversal guarded.

### Changed

- `pnpm build` now runs the Angular element build and the tsdown plugin build in one step
  (`build:elements` / `build:plugin` remain available separately).
- `files` ships `lib/elements`, so an installed copy carries the Angular bundle the host route
  serves; without it the composer mount would load a 404.
- `pnpm-workspace.yaml` allowlists the toolchain's build scripts (esbuild needs its postinstall);
  pnpm 10+ no longer reads the `pnpm` field in `package.json`.

### Known issues

- The replacement dropdown's preset list is a fallback (`完全权限`) until the host's real preset
  inventory is wired through the `permissions` attribute.
- The takeover selector keys off the host control's accessible name; a DSH release that renames
  the label breaks the hide rule until the selector is updated.
- Verified by type check, both builds, a route smoke test and a packed-tarball listing — **not**
  yet in a running DSH profile, so the visual result is unconfirmed.

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
