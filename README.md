# deepseek-coordination

**English** · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

A **DeepSeek Harness plugin bundle**. It is a *dual-face* Cordis plugin: a **host half** that
runs in the DSH Node process and owns an HTTP route surface, and a **client half** that runs in
the DSH Web GUI and contributes a settings section.

> **Status: scaffold.** The host half currently answers only a liveness probe and an echo; the
> client half registers a placeholder settings section that reports whether the host half
> answers. Both halves are wired end to end, so the remaining work is filling in the route
> bodies and the settings UI rather than connecting the plumbing.

## What the pieces mean

| Term | What it is |
|---|---|
| **Plugin** | A module exporting `apply(ctx)`, mounted by a row in a config layer |
| **Bundle** | An npm package whose `package.json` declares `dsh.bundle.patch` — the layer of rows it contributes |
| **Profile** | A runnable composition under `$DSH_HOME/profiles/<name>` listing the bundles to apply, in order |
| **Host half** | `lib/index.mjs`, ESM for Node, built from `src/index.ts` |
| **Client half** | `lib/client.js`, CJS for the browser, built from `src/client/index.ts` |

This repository is the **bundle**. A profile is what a user boots; nothing here is both.

## Project structure

```text
.
├─ src/
│  ├─ index.ts           Host half: routes + static serving of the Angular bundle
│  ├─ client/
│  │  └─ index.ts        Client half: `协调` settings page, composer mount, takeover rule
│  └─ elements/          Angular Elements app (custom element <dsh-coordination-controls>)
│     ├─ main.ts         Boots Angular and defines the element
│     └─ controls.component.ts
├─ lib/                  Build output (git-ignored, never edited by hand)
│  ├─ index.mjs          Host half
│  ├─ client.js          Client half (module-loader wrapper)
│  └─ elements/browser/  Angular bundle served by the host half
├─ angular.json          Angular build target (outputs into lib/elements)
├─ tsconfig.elements.json
├─ cordis.patch.yml      Bundle patch: inserts this plugin's row into a profile roster
├─ package.json          dsh.bundle + dsh.client declarations, dual exports map
├─ pnpm-lock.yaml        Pinned dev toolchain and DSH client packages
├─ pnpm-workspace.yaml   pnpm settings (build-script allowlist for the Angular toolchain)
├─ tsconfig.json         Type checking only (`noEmit`)
├─ tsdown.config.ts      Dual-target build: host ESM + client CJS with the module-loader wrapper
├─ CHANGELOG.md
└─ LICENSE
```

## What the plugin mounts

| Where | Slot | Content |
|---|---|---|
| Settings | `settings.section` | A `协调` page: the permission-takeover switch and the three selectors |
| Composer tool row | `conversation.input.left` | The same selectors, in the free space right of the access-mode control |

The selectors run left to right — **职能** (决策 / 成果 / 资源 / 人员 / 任职 / 执行), **交互**
(感情 / 思维 / 启发 / 收束), **情景** (对话 / 写作 / 办公 / 研究 / 工程 / 迭代) — and change
immediately.

**Permission takeover.** The host's access-mode control is resident chrome, not a slot, so the
plugin cannot replace it by registration. With the switch on, an injected rule hides it —

```css
button[aria-label^="访问模式"], button[aria-label^="Access mode"] { display: none !important; }
```

— and the Angular element renders the replacement dropdown at the left edge of the same row. The
selector targets the control's accessible name (its CSS-module class names are hashed), so a host
release that renames that label breaks the rule. The switch position persists in `localStorage`.


## Requirements

| | |
|---|---|
| Node.js | `>= 18` |
| Package manager | pnpm (npm works; the examples below use pnpm) |
| DSH | an installation that ships the `dsh` CLI, plus the `web` profile |

## Build

```console
$ pnpm install
$ pnpm typecheck        # tsc -p tsconfig.json --noEmit
$ pnpm build            # ng build elements && tsdown --config tsdown.config.ts
```

`build` produces three artifacts the manifest points at:

| Output | Face | Format |
|---|---|---|
| `lib/index.mjs` + `lib/index.d.mts` | Host | ESM, `platform: node` |
| `lib/client.js` | Client | CJS, `platform: browser`, wrapped in `__ModuleLoader__.load()` |
| `lib/elements/browser/main.js` + `styles.css` | Angular element | ESM, served by the host half |

The Angular bundle is **not** bundled into the client half: the client half loads it at run time
from `GET /deepseek-coordination/elements/main.js`, which keeps the module-table contract intact
(only `react` and `@deepseek-ai/dsh-client-*` may come from the host). `build:elements` and
`build:plugin` build either half alone.

Never edit `lib/` directly and never hand-write the `__ModuleLoader__` wrapper — `tsdown.config.ts`
emits it (`banner` / `intro` / `footer`). Always change `src/` and rebuild.

## Install into a profile

```console
# from this checkout
$ dsh plugin --profile web add ./

# or from a packed tarball
$ pnpm pack
$ dsh plugin --profile web add ./deepseek-coordination-0.2.0.tgz
```

`dsh plugin add` writes the package into the profile's `package.json` (as a dependency *and* into
`dsh.profile.bundles`) because this package declares `dsh.bundle`. Verify the layer without booting:

```console
$ dsh --profile web --dump-config     # expect a "# == deepseek-coordination" layer
$ dsh --profile web
```

## How the halves connect

The two faces never import each other. They communicate over HTTP:

| Route (`POST`) | Body | Response |
|---|---|---|
| `/deepseek-coordination/ping` | `{}` | `{"ok":true,"value":{"plugin":"deepseek-coordination","pong":true}}` |
| `/deepseek-coordination/echo` | any JSON | `{"ok":true,"value":<the same JSON>}` |

Every response uses one envelope: `{ ok: true, value }` or `{ ok: false, error }`. The client half
posts JSON with `fetch()` and reads that envelope; there is no shared module instance to keep in
sync.

## Plugin contract rules

These are the ones that fail silently rather than loudly:

- **Hard dependencies belong in `inject`.** `apply()` runs only after every injected service is
  ready. `ctx.get('x')` is an *optional* read and returns `undefined` before the service exists;
  do not use it as a substitute for `inject`.
- **Registrations are disposed automatically.** `ctx.on`, `ctx.tools.register`, `ctx.slots.inject`
  and friends are owned by the plugin's fiber. For anything else, return a disposer from
  `ctx.effect(() => cleanup)` — that is how the route surface unregisters on unload.
- **`inject` and `dsh.client.inject` are different declarations.** The first lists client
  *services* (`slots`, `locale`); the second lists module-table *packages* (`react`,
  `@deepseek-ai/dsh-client-*`). Both are required.
- **Only `react` and `@deepseek-ai/dsh-client-*` come from the module table.** Everything else in
  the client half must be bundled — `tsdown.config.ts` encodes that with `neverBundle` /
  `alwaysBundle`, and a missing table row throws at load time.
- **`__ModuleLoader__`'s `id` must equal the package name.** It is the resolution key.
- **Use the theme tokens.** Colors come from `var(--dsw-alias-*)`; hard-coded colors break in one
  of the two themes.
- **`files` is a whitelist.** Only what it lists ships — if the manifest points at a path the
  tarball lacks, the plugin installs cleanly and then fails to load.

## Publishing

- **npm registry or tarball** — build `lib/` before publishing (`pnpm publish` / `pnpm pack`) so
  consumers receive compiled code and need no install-time build permission.
- **Straight from git** — `dsh plugin add github:you/deepseek-coordination` fetches *sources*, not
  artifacts. That only works if the package declares a self-contained `prepare` script, and the
  user must first allowlist the build in the profile's `pnpm-workspace.yaml` (`allowBuilds`). This
  repository has no `prepare` script, so publish compiled artifacts instead.

## Repository history

- `0.1.0`–`0.1.9` — the repository hosted **dsh-os**, a cross-platform atomic OS-interaction
  surface (PowerShell 5.1 / 7.6 and POSIX verb implementations, plugin rows, 50 golden cases).
  Last commit `3ba4a45`, tagged `v0.1.5` … `v0.1.9`.
- `87ddab9` — that tree was replaced by a standalone Vite single-page scaffold.
- `0.2.0` — this plugin bundle layout, which supersedes both.

Nothing is lost: every earlier state is reachable from git history.

```console
# Inspect the dsh-os project without touching this checkout
$ git worktree add ../dsh-os v0.1.9

# Or restore selected directories into this checkout
$ git checkout 3ba4a45 -- src/host src/plugin src/permission tests tools
```

## References

- DSH plugin tutorials: <https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop>
- [Package and install a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [Plugins and lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md)

## License

MIT © 2026 Eloy Kim. See [LICENSE](LICENSE).
